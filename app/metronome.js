// metronome: web audio lookahead scheduler (sample accurate clicks), beat dots, tap tempo, sync.
// timing is a timeline: step n sounds at anchor + n * step length, in the leader's clock (ms).
// clicks are scheduled ~120 ms ahead on the audio clock; the screen follows with requestAnimationFrame.

import { $, $$, el, icon, store, media, onKeys, router, toast, showMenu } from "./core.js";
import { startScan, codeFrom } from "./qrscan.js";
import { sync, clock, initSync, lead, follow, leave, broadcast, request, joinUrl, qrSvg, cleanCode, setLatency } from "./metrosync.js";

const MIN_BPM = 30, MAX_BPM = 300;
const LOOKAHEAD = 0.12; // seconds of audio scheduled ahead
const LOOKAHEAD_HIDDEN = 1.5; // background tabs wake timers about once a second
const TICK_MS = 25; // how often the scheduler wakes up
const SYNC_LEAD = 350; // ms: changes from the leader take effect this late, so followers get them in time

// time signatures: beats per bar, and the note value that gets the beat
const SIGS = [
  { id: "1", beats: 1, label: "1" },
  { id: "2/4", beats: 2, label: "2/4" },
  { id: "3/4", beats: 3, label: "3/4" },
  { id: "4/4", beats: 4, label: "4/4" },
  { id: "5/4", beats: 5, label: "5/4" },
  { id: "6/8", beats: 6, label: "6/8" },
  { id: "7/8", beats: 7, label: "7/8" },
];

// clicks per beat
const SUBS = [
  { n: 1, label: "♩", title: "Ketukan saja" },
  { n: 2, label: "♫", title: "Seperdelapan (2 per ketukan)" },
  { n: 3, label: "3", title: "Triol (3 per ketukan)" },
  { n: 4, label: "♬", title: "Seperenambelas (4 per ketukan)" },
];

// counting syllables between the beats ("1 e & a")
const SYLLABLES = { 1: [""], 2: ["", "&"], 3: ["", "&", "a"], 4: ["", "e", "&", "a"] };

const SOUNDS = [
  { id: "click", label: "Klik" },
  { id: "wood", label: "Kayu" },
  { id: "beep", label: "Beep" },
];

// tempo names, shown under the number
const TERMS = [[40, "Grave"], [60, "Largo"], [66, "Larghetto"], [76, "Adagio"], [108, "Andante"], [120, "Moderato"], [156, "Allegro"], [176, "Vivace"], [200, "Presto"], [Infinity, "Prestissimo"]];
const term = (bpm) => TERMS.find(([max]) => bpm < max)[1];

// beat levels: 2 accent, 1 normal, 0 silent
const defaultAccents = (beats) => Array.from({ length: beats }, (_, i) => (i === 0 && beats > 1 ? 2 : 1));

let bpm = clampBpm(store.get("metro-bpm", 100));
let sig = SIGS.find((s) => s.id === store.get("metro-sig", "4/4")) || SIGS[3];
let sub = store.get("metro-sub", 1);
let sound = store.get("metro-sound", "click");
let vol = store.get("metro-vol", 0.8);
let accents = loadAccents();

let ctx = null, master = null, noise = null;
let playing = false; // shared: the beat is running (on every synced device)
let held = false; // synced only: this device went quiet (left the page, other audio) without stopping the others
let raf = 0, worker = null, running = false; // running: the scheduler is ticking
let anchor = 0, n = 0, lastSched = -Infinity; // timeline, see top
let mapD = null; // audio clock minus performance clock (s), smoothed
let queue = []; // { time, beat, part } waiting to be shown
let taps = [];
let blink = store.get("metro-blink", false); // per device: flash the beat across the whole screen
let wakeLock = null; // keeps the screen on while the beat runs

function clampBpm(v) { return Math.max(MIN_BPM, Math.min(MAX_BPM, Math.round(v) || 100)); }

// accent pattern is remembered per time signature
function loadAccents() {
  const a = store.get("metro-accents", {})[sig.id];
  return Array.isArray(a) && a.length === sig.beats ? a : defaultAccents(sig.beats);
}
function saveAccents() {
  const all = store.get("metro-accents", {});
  all[sig.id] = accents;
  store.set("metro-accents", all);
}

// ------------------------------------------------------------------ sound

function ensureAudio() {
  if (ctx) return;
  ctx = new (window.AudioContext || window.webkitAudioContext)();
  master = ctx.createGain();
  master.gain.value = vol;
  master.connect(ctx.destination);
  // short white noise for the wood block
  noise = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 0.05), ctx.sampleRate);
  const d = noise.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
}

// level: 2 accent, 1 beat, 0.5 subdivision
function click(time, level) {
  const g = ctx.createGain();
  g.connect(master);
  const peak = level === 2 ? 1 : level === 1 ? 0.7 : 0.35;

  if (sound === "wood") {
    // band passed noise burst, sounds like a wood block
    const src = ctx.createBufferSource();
    src.buffer = noise;
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = level === 2 ? 2600 : level === 1 ? 1900 : 1500;
    bp.Q.value = 6;
    src.connect(bp).connect(g);
    g.gain.setValueAtTime(peak * 2.2, time);
    g.gain.exponentialRampToValueAtTime(0.001, time + 0.045);
    src.start(time);
    src.stop(time + 0.05);
    return;
  }

  // click: short square blip; beep: longer sine
  const o = ctx.createOscillator();
  const beep = sound === "beep";
  o.type = beep ? "sine" : "square";
  o.frequency.value = beep ? (level === 2 ? 1320 : level === 1 ? 880 : 660) : (level === 2 ? 1800 : level === 1 ? 1200 : 900);
  const len = beep ? 0.08 : 0.03;
  o.connect(g);
  g.gain.setValueAtTime(0.0001, time);
  g.gain.exponentialRampToValueAtTime(peak * (beep ? 0.6 : 0.3), time + 0.002);
  g.gain.exponentialRampToValueAtTime(0.0001, time + len);
  o.start(time);
  o.stop(time + len + 0.01);
}

// ------------------------------------------------------------------ timeline

const stepMs = () => 60000 / bpm / sub;
const hostNow = () => clock() + sync.offset;
const barLen = () => sig.beats * sub;

// keep the audio clock <-> performance clock mapping fresh; output timestamps include the speaker delay
function updateMap() {
  let d;
  const ts = ctx.getOutputTimestamp?.();
  if (ts && ts.performanceTime > 0 && ts.contextTime > 0) d = ts.contextTime - ts.performanceTime / 1000;
  else d = ctx.currentTime - performance.now() / 1000 - (ctx.outputLatency || ctx.baseLatency || 0);
  mapD = mapD == null || Math.abs(d - mapD) > 0.03 ? d : mapD + (d - mapD) * 0.05;
}

// audio clock time at which a leader-clock moment should come out of this device's speaker
function ctxAt(hostMs) {
  const perfMs = hostMs - sync.offset - performance.timeOrigin - sync.latency;
  return perfMs / 1000 + mapD;
}

// next step to schedule: after what is already queued, and not in the past
function reindex() {
  const base = Math.max(lastSched + stepMs() / 2, hostNow());
  n = Math.max(0, Math.ceil((base - anchor) / stepMs()));
}

// first step at least `lead` ms from now (and after what is queued): changes take effect there
function pivot(lead) {
  const p = stepMs();
  const base = Math.max(lastSched + p / 2, hostNow() + lead);
  const i = Math.max(0, Math.ceil((base - anchor) / p));
  return { i, t: anchor + i * p };
}

const changeLead = () => (sync.role === "host" && sync.peers ? SYNC_LEAD : 0);

// ------------------------------------------------------------------ scheduler

// ticks come from a worker: page timers get throttled hard when the tab is in the background
function ticker() {
  if (worker) return worker;
  try {
    const src = `let t=0;onmessage=(e)=>{clearInterval(t);if(e.data>0)t=setInterval(()=>postMessage(0),e.data)}`;
    worker = new Worker(URL.createObjectURL(new Blob([src], { type: "text/javascript" })));
    worker.onmessage = () => audible() && schedule();
  } catch {
    // no workers: fall back to a plain interval
    let t = 0;
    worker = { postMessage: (ms) => { clearInterval(t); if (ms > 0) t = setInterval(() => audible() && schedule(), ms); } };
  }
  return worker;
}

// a follower waits for its first clock measurement, otherwise it would start out of phase
const audible = () => playing && !held && !!ctx && (sync.role !== "follower" || sync.rtt != null);

function schedule() {
  updateMap();
  const ahead = document.hidden ? LOOKAHEAD_HIDDEN : LOOKAHEAD;
  const now = ctx.currentTime, p = stepMs(), L = barLen();
  // woke up too late (tab was throttled, or joined mid-song): skip the missed clicks instead of playing them all at once
  const behind = now - ctxAt(anchor + n * p);
  if (behind > 0.05) n += Math.ceil(behind / (p / 1000));
  for (;;) {
    const host = anchor + n * p, t = ctxAt(host);
    if (t > now + ahead) break;
    if (t >= now - 0.01) {
      const k = n % L, beat = Math.floor(k / sub), part = k % sub;
      const lvl = accents[beat] ?? 1;
      // a silent beat also silences its subdivisions
      if (lvl > 0) click(t, part === 0 ? lvl : 0.5);
      queue.push({ time: t, beat, part });
    }
    lastSched = host;
    n++;
  }
}

// light the dot whose click is sounding now
function frame() {
  raf = requestAnimationFrame(frame);
  const now = ctx.currentTime;
  let cur = null;
  while (queue.length && queue[0].time <= now) cur = queue.shift();
  if (!cur) return;
  const dots = $$("#metroBeats .metro-dot");
  dots.forEach((d, i) => {
    d.classList.toggle("now", i === cur.beat);
    if (i === cur.beat && cur.part === 0) { d.classList.remove("hit"); void d.offsetWidth; d.classList.add("hit"); }
  });
  $("#metroCount").textContent = cur.part === 0 ? String(cur.beat + 1) : SYLLABLES[sub][cur.part] || "";
  if (cur.part === 0 && blink) blinkBeat(cur.beat);
  if (cur.part === 0) {
    const flash = $("#metroFlash");
    flash.classList.toggle("accent", (accents[cur.beat] ?? 1) === 2);
    flash.classList.remove("hit"); void flash.offsetWidth; flash.classList.add("hit");
  }
}

// screen stays on while the beat runs (phones dim and lock otherwise, which also drops a sync link)
async function keepAwake(on) {
  if (!on) { const l = wakeLock; wakeLock = null; l?.release().catch(() => {}); return false; }
  if (wakeLock || !navigator.wakeLock || document.hidden) return false;
  try {
    const l = await navigator.wakeLock.request("screen");
    if (!running) { l.release().catch(() => {}); return false; } // stopped while asking
    wakeLock = l;
    l.addEventListener("release", () => { if (wakeLock === l) wakeLock = null; });
    return true;
  } catch { return false; }
}

// start or stop the local sound to match playing / held
function runAudio() {
  const was = running;
  running = audible();
  // tell once per start that the screen will stay on
  if (running && !was) keepAwake(true).then((ok) => ok && toast("Layar tidak akan mati selama metronome jalan", { ms: 3000 }));
  else if (!running) keepAwake(false);
  if (running) {
    if (ctx.state !== "running") ctx.resume();
    reindex();
    schedule();
    ticker().postMessage(TICK_MS);
    cancelAnimationFrame(raf);
    frame();
  } else {
    worker?.postMessage(0);
    cancelAnimationFrame(raf);
    queue = [];
    lastSched = -Infinity;
  }
  render();
}

// ------------------------------------------------------------------ changes

// every change goes through here: followers ask the leader, the leader (or a solo device) applies and shares
function act(p) {
  if (sync.role === "follower") { request(p); return; }
  applyChange(p);
  broadcast();
}

function applyChange(p) {
  const was = audible();
  // relative steps (+/-, arrows) stay correct when several arrive before the echo
  if (typeof p.bpmBy === "number") p = { ...p, bpm: bpm + p.bpmBy };
  if ("bpm" in p) {
    const b = clampBpm(p.bpm);
    if (playing && b !== bpm) {
      // keep the beat position: the pivot step stays where it is, later steps use the new tempo
      const pv = pivot(changeLead());
      anchor = pv.t - pv.i * (60000 / b / sub);
    }
    bpm = b;
  }
  if ("sig" in p || "sub" in p) {
    const s = SIGS.find((x) => x.id === p.sig) || sig;
    const u = [1, 2, 3, 4].includes(p.sub) ? p.sub : sub;
    if (s !== sig || u !== sub) {
      // a new bar starts at the pivot
      if (playing) anchor = pivot(changeLead()).t;
      if (s !== sig) { sig = s; accents = loadAccents(); }
      sub = u;
    }
  }
  if (Array.isArray(p.accents) && p.accents.length === sig.beats) accents = p.accents.map((v) => (v === 2 || v === 0 ? v : 1));
  // song list and the song in use are shared too (a follower edits the leader's list)
  if (Array.isArray(p.songs)) store.set("metro-songs", cleanSongs(p.songs));
  if ("song" in p) { curSong = typeof p.song === "string" ? p.song : null; store.set("metro-song", curSong); }
  if ("playing" in p && p.playing !== playing) {
    playing = !!p.playing;
    if (playing) {
      // start a little ahead: covers the speaker delay, and the network when others follow
      ensureAudio();
      anchor = hostNow() + Math.max(sync.role === "host" && sync.peers ? SYNC_LEAD : 80, (ctx.outputLatency || 0) * 1000 + 60);
      lastSched = -Infinity;
      n = 0;
      media.claim("metro");
    }
  }
  persist();
  if (audible() !== was || "playing" in p) runAudio();
  else { if (audible()) reindex(); render(); }
}

// follower: take the leader's state as is
function applyShared(s) {
  const was = audible();
  bpm = clampBpm(s.bpm);
  sig = SIGS.find((x) => x.id === s.sig) || sig;
  sub = [1, 2, 3, 4].includes(s.sub) ? s.sub : 1;
  accents = Array.isArray(s.accents) && s.accents.length === sig.beats ? s.accents : loadAccents();
  anchor = +s.anchor || 0;
  if (Array.isArray(s.songs)) sharedSongs = cleanSongs(s.songs);
  sharedCur = typeof s.song === "string" ? s.song : null;
  const startNow = !!s.playing && !playing;
  playing = !!s.playing;
  persist();
  if (startNow) {
    ensureAudio();
    lastSched = -Infinity;
    if (ctx.state !== "running") ctx.resume().catch(() => {});
    if (router.current === "metro") media.claim("metro");
  }
  if (audible() !== was || startNow) runAudio();
  else { if (audible()) reindex(); render(); }
}

function sharedState() {
  return { bpm, sig: sig.id, sub, accents, playing, anchor, songs: localSongs(), song: curSong };
}

function persist() {
  store.set("metro-bpm", bpm);
  store.set("metro-sig", sig.id);
  store.set("metro-sub", sub);
  saveAccents();
}

function toggle() {
  // the play button also wakes a held device back up
  if (playing && held) { held = false; ensureAudio(); runAudio(); return; }
  ensureAudio();
  if (ctx.state !== "running") ctx.resume();
  act({ playing: !playing });
}

// tap tempo: average of the last few gaps, a long pause starts over
function tap() {
  const now = performance.now();
  if (taps.length && now - taps[taps.length - 1] > 2000) taps = [];
  taps.push(now);
  if (taps.length > 5) taps.shift();
  const btn = $("#metroTap");
  btn.classList.remove("hit"); void btn.offsetWidth; btn.classList.add("hit");
  if (taps.length < 2) return;
  const gaps = taps.slice(1).map((t, i) => t - taps[i]);
  act({ bpm: 60000 / (gaps.reduce((a, b) => a + b, 0) / gaps.length) });
}

// slider: show the number right away, send at most every 80 ms while dragging
let slideTimer = 0, slideVal = 0;
function slide(v) {
  slideVal = v;
  showBpm(v);
  if (slideTimer) return;
  act({ bpm: v });
  slideTimer = setTimeout(() => { slideTimer = 0; if (slideVal !== bpm) act({ bpm: slideVal }); }, 80);
}

// ------------------------------------------------------------------ render

function showBpm(v) {
  $("#metroBpm").textContent = v;
  $("#metroTerm").textContent = term(v);
  if (document.activeElement !== $("#metroSlider")) $("#metroSlider").value = v;
}

function render() {
  showBpm(bpm);

  // beat dots, click cycles accent > normal > silent
  $("#metroBeats").replaceChildren(...accents.map((lvl, i) => {
    const b = el("button", `metro-dot lvl${lvl}`);
    b.type = "button";
    b.title = `Ketukan ${i + 1}: ${lvl === 2 ? "aksen" : lvl === 1 ? "biasa" : "diam"} (klik untuk ganti)`;
    b.append(el("span", null, String(i + 1)));
    b.onclick = () => {
      const next = accents.slice();
      next[i] = lvl === 2 ? 1 : lvl === 1 ? 0 : 2;
      act({ accents: next });
    };
    return b;
  }));

  $("#metroSig").replaceChildren(...SIGS.map((s) => {
    const b = el("button", `tuner-chip${s === sig ? " on" : ""}`, s.label);
    b.type = "button";
    b.title = s.beats === 1 ? "Tanpa birama: semua ketukan sama" : `Birama ${s.label}`;
    b.onclick = () => act({ sig: s.id });
    return b;
  }));

  $("#metroSub").replaceChildren(...SUBS.map((s) => {
    const b = el("button", s.n === sub ? "active" : "", s.label);
    b.type = "button";
    b.title = s.title;
    b.onclick = () => act({ sub: s.n });
    return b;
  }));

  $("#metroSound").replaceChildren(...SOUNDS.map((s) => {
    const b = el("button", s.id === sound ? "active" : "", s.label);
    b.type = "button";
    b.onclick = () => {
      sound = s.id;
      store.set("metro-sound", sound);
      render();
      // preview the new sound when stopped
      if (!audible()) { ensureAudio(); ctx.resume(); click(ctx.currentTime + 0.01, 2); }
    };
    return b;
  }));

  $("#metroVol").value = vol;

  $("#metroBlink").replaceChildren(...[[false, "Mati"], [true, "Layar"]].map(([v, label]) => {
    const b = el("button", v === blink ? "active" : "", label);
    b.type = "button";
    b.title = v ? "Layar berkedip di tiap ketukan, dibagi per ketukan" : "Tanpa kedip layar";
    b.onclick = () => { blink = v; store.set("metro-blink", blink); render(); };
    return b;
  }));

  const on = audible();
  const btn = $("#metroToggle");
  btn.querySelector("use").setAttribute("href", on ? "#i-stop" : "#i-play");
  btn.lastChild.textContent = on ? "Stop" : playing && held ? "Ikut lagi" : "Mulai";
  btn.classList.toggle("on", on);
  $("#metroCard").classList.toggle("playing", on);
  renderStage();
  if (!on) {
    $("#metroCount").textContent = "";
    $$("#metroBeats .metro-dot").forEach((d) => d.classList.remove("now", "hit"));
  }
  renderSongs();
  renderSync();
}

// ------------------------------------------------------------------ saved songs
// each song keeps the shared settings (tempo, signature, subdivision, accents); sound and volume stay per device.
// loading one goes through act(), so synced devices follow it too. while synced everyone sees the leader's list.

let curSong = store.get("metro-song", null); // id of the song loaded last (this device's list)
let sharedSongs = null, sharedCur = null; // follower: the leader's list and its current song
let renaming = null; // id of the song whose name is being edited

const following = () => sync.role === "follower";
const localSongs = () => { const l = store.get("metro-songs", []); return Array.isArray(l) ? l : []; };
const getSongs = () => (following() ? sharedSongs || [] : localSongs());
const getCur = () => (following() ? sharedCur : curSong);

// a follower's edits go to the leader (shown right away, the echo confirms); the leader shares its own.
// cur (optional) also makes that song the one in use, in the same message so both land together
function setSongs(list, cur) {
  const p = cur === undefined ? { songs: list } : { songs: list, song: cur };
  if (following()) {
    sharedSongs = list;
    if (cur !== undefined) sharedCur = cur;
    request(p);
    return;
  }
  applyChange(p);
  broadcast();
}

// songs arriving over sync or from storage: keep only known fields and sane values
function cleanSongs(list) {
  return list.filter((x) => x && typeof x === "object").slice(0, 300).map((x) => ({
    id: String(x.id || Math.random().toString(36).slice(2)).slice(0, 24),
    name: String(x.name || "Lagu").slice(0, 60),
    bpm: clampBpm(x.bpm),
    sig: SIGS.some((g) => g.id === x.sig) ? x.sig : "4/4",
    sub: [1, 2, 3, 4].includes(x.sub) ? x.sub : 1,
    accents: Array.isArray(x.accents) ? x.accents.slice(0, 7).map((v) => (v === 2 || v === 0 ? v : 1)) : [],
  }));
}

// follower: keep a copy of the leader's songs in this device's own list (skips ones already there)
function copySongs() {
  const mine = localSongs(), have = new Set(mine.map((x) => x.id));
  const add = (sharedSongs || []).filter((x) => !have.has(x.id));
  store.set("metro-songs", mine.concat(add));
  toast(add.length ? `${add.length} lagu disalin ke daftarmu` : "Semua lagu sudah ada di daftarmu", { ms: 2500 });
}

const nowSettings = () => ({ bpm, sig: sig.id, sub, accents: accents.slice() });
const sameAsNow = (s) => s.bpm === bpm && s.sig === sig.id && s.sub === sub && String(s.accents) === String(accents);
const subLabel = (n) => SUBS.find((x) => x.n === n)?.label || "♩";

function loadSong(s) {
  if (!s) return;
  if (following()) sharedCur = s.id; // shown right away, the leader echoes it
  act({ bpm: s.bpm, sig: s.sig, sub: s.sub, accents: s.accents, song: s.id });
  renderSongs();
}

// previous / next song in the list (a page turner pedal sends page up / down)
function stepSong(d) {
  const list = getSongs();
  if (!list.length) { toast("Belum ada lagu tersimpan"); return; }
  const i = list.findIndex((x) => x.id === getCur());
  const j = i < 0 ? (d > 0 ? 0 : list.length - 1) : i + d;
  if (j < 0 || j >= list.length) return;
  loadSong(list[j]);
  toast(`${j + 1}. ${list[j].name}`, { ms: 1500 });
}

function addSong(name) {
  const list = getSongs();
  name = name.trim() || `Lagu ${list.length + 1}`;
  const s = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 5), name, ...nowSettings() };
  list.push(s);
  setSongs(list, s.id);
  renderSongs();
  toast(`"${name}" disimpan`, { ms: 2000 });
}

function updateSong(id, patch) {
  setSongs(getSongs().map((x) => (x.id === id ? { ...x, ...patch } : x)));
  renderSongs();
}

function moveSong(id, d) {
  const list = getSongs(), i = list.findIndex((x) => x.id === id), j = i + d;
  if (i < 0 || j < 0 || j >= list.length) return;
  [list[i], list[j]] = [list[j], list[i]];
  setSongs(list);
  renderSongs();
}

// delete with an undo toast instead of a confirm dialog
function removeSong(id) {
  const list = getSongs(), i = list.findIndex((x) => x.id === id);
  if (i < 0) return;
  const [gone] = list.splice(i, 1);
  setSongs(list);
  renderSongs();
  toast(`"${gone.name}" dihapus`, {
    action: "Urungkan",
    onAction: () => { const l = getSongs(); l.splice(i, 0, gone); setSongs(l); renderSongs(); },
  });
}

function songRow(s, i) {
  const li = el("li", "metro-song");
  const on = s.id === getCur(), changed = on && !sameAsNow(s);
  li.classList.toggle("on", on);

  // name being edited: a text field in place of the row
  if (renaming === s.id) {
    const inp = el("input", "metro-song-rename");
    inp.value = s.name;
    inp.maxLength = 60;
    inp.setAttribute("aria-label", "Nama lagu");
    let done = false;
    const finish = (save) => {
      if (done) return;
      done = true;
      renaming = null;
      if (save && inp.value.trim()) updateSong(s.id, { name: inp.value.trim() });
      else renderSongs();
    };
    inp.onkeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); finish(true); } else if (e.key === "Escape") { e.preventDefault(); finish(false); } };
    inp.onblur = () => finish(true);
    li.append(el("span", "metro-song-n", String(i + 1)), inp);
    setTimeout(() => { inp.focus(); inp.select(); }, 0);
    return li;
  }

  // the row itself loads the song
  const main = el("button", "metro-song-main");
  main.type = "button";
  main.title = `Pakai setelan "${s.name}"`;
  const sigLabel = SIGS.find((x) => x.id === s.sig)?.label || s.sig;
  // name and settings sit side by side, stacked on narrow screens
  const text = el("span", "metro-song-text");
  text.append(el("span", "metro-song-name", s.name), el("span", "metro-song-meta", `${s.bpm} BPM · ${sigLabel} · ${subLabel(s.sub)}`));
  main.append(el("span", "metro-song-n", String(i + 1)), text);
  main.onclick = () => loadSong(s);
  li.append(main);

  // loaded, then tweaked: offer to save the tweak into it
  if (changed) {
    const up = el("button", "btn sm metro-song-save", "Simpan");
    up.type = "button";
    up.title = `Simpan setelan sekarang ke "${s.name}"`;
    up.onclick = () => { updateSong(s.id, nowSettings()); toast(`"${s.name}" diperbarui`, { ms: 2000 }); };
    li.append(up);
  }

  // more: rename, overwrite, move, delete
  const more = el("button", "icon-btn");
  more.type = "button";
  more.title = "Lainnya";
  more.append(icon("more"));
  more.onclick = (e) => {
    e.stopPropagation();
    const n = getSongs().length;
    showMenu(more, [
      { label: "Ganti nama", onClick: () => { renaming = s.id; renderSongs(); } },
      { label: "Timpa dengan setelan sekarang", icon: "check", onClick: () => { updateSong(s.id, nowSettings()); toast(`"${s.name}" diperbarui`, { ms: 2000 }); } },
      i > 0 && { label: "Naikkan", icon: "up", onClick: () => moveSong(s.id, -1) },
      i < n - 1 && { label: "Turunkan", icon: "down", onClick: () => moveSong(s.id, 1) },
      { label: "Hapus", icon: "trash", danger: true, onClick: () => removeSong(s.id) },
    ]);
  };
  li.append(more);
  return li;
}

function renderSongs() {
  const list = getSongs(), fol = following();
  if (!fol && curSong && !list.some((x) => x.id === curSong)) curSong = null;
  $("#metroSongs").replaceChildren(...list.map(songRow));
  $("#metroSongsEmpty").hidden = list.length > 0;
  $("#metroSongsEmpty").textContent = fol ? "Perangkat patokan belum punya daftar lagu. Lagu yang kamu simpan di sini masuk ke daftarnya." : "Belum ada. Atur tempo, birama, ketukan, dan aksen untuk satu lagu, lalu simpan di bawah. Nanti tinggal klik untuk memakainya lagi.";
  // synced: say whose list this is
  $("#metroSongsNote").hidden = !sync.role;
  $("#metroSongsNoteText").textContent = fol ? "Daftar dari perangkat patokan. Ubahan di sini ikut ke semua." : `Daftar ini dipakai semua perangkat yang mengikuti.`;
  $("#metroSongsCopy").hidden = !fol || !list.length;
  const i = list.findIndex((x) => x.id === getCur());
  $("#metroSongPrev").disabled = !list.length || i === 0;
  $("#metroSongNext").disabled = !list.length || i === list.length - 1;
}

// ------------------------------------------------------------------ screen flash

// one column per beat across the whole screen; the column of the sounding beat lights up
function renderStage() {
  const st = $("#metroStage");
  st.hidden = !(blink && running);
  if (st.childElementCount !== sig.beats) {
    st.replaceChildren(...accents.map((_, i) => el("span", null, String(i + 1))));
  }
  st.style.setProperty("--n", sig.beats);
  // fade within the beat, so fast tempos still blink apart
  st.style.setProperty("--blink-ms", `${Math.round(Math.min(380, (60000 / bpm) * 0.85))}ms`);
}

function blinkBeat(beat) {
  const lvl = accents[beat] ?? 1;
  if (lvl === 0) return; // silent beat stays dark
  const c = $("#metroStage").children[beat];
  if (!c) return;
  c.classList.toggle("acc", lvl === 2);
  c.classList.remove("hit"); void c.offsetWidth; c.classList.add("hit");
}

// ------------------------------------------------------------------ sync ui

function renderSync() {
  const role = sync.role;
  const pill = $("#metroSyncBtn");
  pill.classList.toggle("on", !!role);
  pill.classList.toggle("linked", sync.linked);
  pill.lastChild.textContent = role === "host" ? `Sync · ${sync.peers} ikut` : role === "follower" ? `Ikut ${sync.code}` : "Sync";

  const d = $("#metroSync");
  d.dataset.role = role || "none";
  $("#syncPick").hidden = !!role || scanning;
  $("#syncScan").hidden = !scanning;
  $("#syncHost").hidden = role !== "host";
  $("#syncFollow").hidden = role !== "follower";
  $("#syncShared").hidden = !role;
  $("#syncEnd").hidden = !role;
  $("#metroSyncEnd").hidden = !role;
  if (role === "host") {
    $("#syncCode").textContent = sync.code;
    $("#syncPeers").textContent = sync.peers ? `${sync.peers} perangkat mengikuti` : "Belum ada yang mengikuti";
    $("#syncHostStatus").textContent = sync.status;
  }
  if (role === "follower") {
    $("#syncFollowCode").textContent = sync.code;
    const ok = sync.linked;
    $("#syncFollowStatus").textContent = sync.status + (ok && sync.rtt != null ? ` · ping ${Math.round(sync.rtt)} ms` : "");
    $("#syncFollowStatus").classList.toggle("ok", ok);
    // phones only make sound after a tap on the page
    $("#syncWake").hidden = !(playing && (!ctx || ctx.state !== "running"));
  }
  $("#syncLatency").value = sync.latency;
  $("#syncLatencyVal").textContent = `${sync.latency > 0 ? "+" : ""}${sync.latency} ms`;
}

// ------------------------------------------------------------------ qr scan (follow by camera)

let scanning = false, stopScan = null, scanId = 0; // scanId: a camera that starts late for an old scan gets stopped

async function openScan() {
  if (scanning) return;
  const id = ++scanId;
  scanning = true;
  $("#syncScanMsg").textContent = "Membuka kamera…";
  renderSync();
  // the audio unlock rides on this tap too (phones need a touch before sound)
  ensureAudio(); ctx.resume().catch(() => {});
  try {
    const stop = await startScan($("#syncScanVideo"), (text) => {
      if (id !== scanId) return;
      stopScan = null;
      const code = cleanCode(codeFrom(text));
      if (code.length < 4) { toast("QR ini bukan QR sync metronome", { error: true }); closeScan(); return; }
      closeScan();
      follow(code);
    });
    if (id !== scanId || !scanning) { stop(); return; } // closed while the camera was starting
    stopScan = stop;
    $("#syncScanMsg").textContent = "Arahkan kamera ke QR di perangkat patokan";
  } catch (e) {
    if (id !== scanId) return;
    closeScan();
    const denied = e?.name === "NotAllowedError" || e?.name === "SecurityError";
    toast(denied ? "Izin kamera ditolak. Izinkan kamera untuk situs ini di pengaturan browser, atau ketik kodenya." : e?.name === "NotFoundError" ? "Kamera tidak ditemukan. Ketik kodenya saja." : (e?.message || "Kamera tidak bisa dibuka"), { error: true, ms: 7000 });
  }
}

function closeScan() {
  scanId++;
  scanning = false;
  stopScan?.();
  stopScan = null;
  renderSync();
}

let qrFor = "";
async function showQr() {
  const url = joinUrl();
  $("#syncLink").textContent = url.replace(/^https?:\/\//, "");
  if (qrFor === url) return;
  qrFor = url;
  try { $("#syncQr").innerHTML = await qrSvg(url); } catch { qrFor = ""; $("#syncQr").textContent = "QR gagal dimuat"; }
}

function onStatus() {
  if (sync.role === "host" && sync.code) showQr();
  if (!following()) { sharedSongs = null; sharedCur = null; }
  renderSongs();
  // clock measured / sync ended: start or stop the local sound to match
  if (audible() !== running) runAudio();
  else renderSync();
}

export function enterMetronome(code) {
  // back on the page: a held device joins the beat again
  if (held) { held = false; if (playing) { ensureAudio(); runAudio(); } }
  render();
  if (code) {
    // opened from a qr / link: follow that leader, then tidy the address
    history.replaceState(null, "", "#/metronome");
    if (sync.role !== "follower" || sync.code !== cleanCode(code)) follow(code);
  }
}

// leaving the page / other audio: solo stops, a synced device only goes quiet here
function quiet() {
  if (!playing) return;
  if (sync.role) { held = true; runAudio(); }
  else act({ playing: false });
}

export function initMetronome() {
  media.register("metro", quiet);
  initSync({ state: sharedState, apply: applyShared, act: (p) => { applyChange(p); broadcast(); }, onStatus });
  $("#metroToggle").onclick = toggle;
  $("#metroMinus").onclick = () => act({ bpmBy: -1 });
  $("#metroPlus").onclick = () => act({ bpmBy: 1 });
  $("#metroSlider").oninput = (e) => slide(+e.target.value);
  $("#metroSlider").onchange = (e) => { clearTimeout(slideTimer); slideTimer = 0; act({ bpm: +e.target.value }); };
  $("#metroTap").onclick = tap;
  $("#metroVol").oninput = (e) => {
    vol = +e.target.value;
    store.set("metro-vol", vol);
    if (master) master.gain.value = vol;
  };

  // saved songs
  $("#metroSongAdd").onsubmit = (e) => {
    e.preventDefault();
    addSong($("#metroSongName").value);
    $("#metroSongName").value = "";
    $("#metroSongName").blur();
  };
  $("#metroSongPrev").onclick = () => stepSong(-1);
  $("#metroSongNext").onclick = () => stepSong(1);
  // the list may change on the other page (online site <-> encore app)
  window.addEventListener("storage", (e) => {
    if (e.key !== "metro-songs") return;
    broadcast(); // leader: followers get the new list too
    if (router.current === "metro") renderSongs();
  });
  $("#metroSongsCopy").onclick = copySongs;
  // the screen lock is dropped when the tab hides; take it again on return
  document.addEventListener("visibilitychange", () => { if (!document.hidden && running) keepAwake(true); });

  // sync dialog
  $("#metroSyncBtn").onclick = () => { renderSync(); if (sync.role === "host") showQr(); $("#metroSync").showModal(); };
  $("#syncLead").onclick = () => { lead(); renderSync(); };
  $("#syncJoin").onclick = () => {
    const c = cleanCode($("#syncCodeIn").value);
    if (c.length < 4) { toast("Masukkan kode dari perangkat pemimpin", { error: true }); return; }
    ensureAudio(); ctx.resume();
    follow(c);
  };
  $("#syncScanBtn").onclick = openScan;
  $("#syncScanStop").onclick = closeScan;
  // camera off whenever the dialog closes (watch the open attribute: some webviews skip the close event)
  new MutationObserver(() => { if (!$("#metroSync").open && scanning) closeScan(); })
    .observe($("#metroSync"), { attributes: true, attributeFilter: ["open"] });
  $("#syncCodeIn").onkeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); $("#syncJoin").click(); } };
  $("#syncEnd").onclick = () => { leave(); held = false; renderSync(); };
  // same end action straight from the page header, no need to open the dialog
  $("#metroSyncEnd").onclick = () => $("#syncEnd").click();
  $("#syncCopy").onclick = async () => {
    try { await navigator.clipboard.writeText(joinUrl()); toast("Link sync disalin"); } catch { toast(joinUrl()); }
  };
  $("#syncWake").onclick = () => { ensureAudio(); ctx.resume().then(() => runAudio()); };
  $("#syncLatency").oninput = (e) => { setLatency(+e.target.value); renderSync(); };
  $("#syncLatencyReset").onclick = () => { setLatency(0); renderSync(); };
  // any tap wakes up the audio (phones block sound until the page is touched)
  document.addEventListener("pointerdown", () => { if (ctx && ctx.state !== "running" && playing) ctx.resume().then(() => { if (audible()) runAudio(); }); }, true);

  // the click stops (or goes quiet when synced) outside this page
  window.addEventListener("hashchange", () => { if (router.current !== "metro") quiet(); });
  onKeys("metro", (e) => {
    if (e.code === "Space") { e.preventDefault(); toggle(); return; }
    if (e.key === "ArrowUp" || e.key === "ArrowRight") { e.preventDefault(); act({ bpmBy: e.shiftKey ? 5 : 1 }); return; }
    if (e.key === "ArrowDown" || e.key === "ArrowLeft") { e.preventDefault(); act({ bpmBy: e.shiftKey ? -5 : -1 }); return; }
    if (e.key === "t" || e.key === "T") { tap(); return; }
    if (e.key === "s" || e.key === "S") { $("#metroSyncBtn").click(); return; }
    if (e.key === "[" || e.key === "PageUp") { e.preventDefault(); stepSong(-1); return; }
    if (e.key === "]" || e.key === "PageDown") { e.preventDefault(); stepSong(1); return; }
    const k = +e.key;
    if (k >= 1 && k <= 4) act({ sub: k });
  });
}
