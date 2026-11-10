// metronome: web audio lookahead scheduler (sample accurate clicks), beat dots, tap tempo.
// clicks are scheduled ~120 ms ahead on the audio clock; the screen follows with requestAnimationFrame.

import { $, $$, el, store, media, onKeys, router } from "./core.js";

const MIN_BPM = 30, MAX_BPM = 300;
const LOOKAHEAD = 0.12; // seconds of audio scheduled ahead
const LOOKAHEAD_HIDDEN = 1.5; // background tabs wake timers about once a second
const TICK_MS = 25; // how often the scheduler wakes up

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
let playing = false, raf = 0, worker = null;
let nextTime = 0, step = 0; // step counts subdivisions inside the bar
let queue = []; // { time, beat, sub } waiting to be shown
let taps = [];

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

// ------------------------------------------------------------------ scheduler

// ticks come from a worker: page timers get throttled hard when the tab is in the background
function ticker() {
  if (worker) return worker;
  try {
    const src = `let t=0;onmessage=(e)=>{clearInterval(t);if(e.data>0)t=setInterval(()=>postMessage(0),e.data)}`;
    worker = new Worker(URL.createObjectURL(new Blob([src], { type: "text/javascript" })));
    worker.onmessage = () => playing && schedule();
  } catch {
    // no workers: fall back to a plain interval
    let t = 0;
    worker = { postMessage: (ms) => { clearInterval(t); if (ms > 0) t = setInterval(() => playing && schedule(), ms); } };
  }
  return worker;
}

function schedule() {
  const ahead = document.hidden ? LOOKAHEAD_HIDDEN : LOOKAHEAD;
  // woke up too late (tab was throttled): skip the missed clicks instead of playing them all at once
  const late = ctx.currentTime - nextTime;
  if (late > 0.05) {
    const per = 60 / bpm / sub, skip = Math.ceil(late / per);
    nextTime += skip * per;
    step = (step + skip) % (sig.beats * sub);
  }
  while (nextTime < ctx.currentTime + ahead) {
    const beat = Math.floor(step / sub), part = step % sub;
    const lvl = accents[beat] ?? 1;
    // a silent beat also silences its subdivisions
    if (lvl > 0) click(nextTime, part === 0 ? lvl : 0.5);
    queue.push({ time: nextTime, beat, part });
    nextTime += 60 / bpm / sub;
    step = (step + 1) % (sig.beats * sub);
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
  $("#metroCount").textContent = cur.part === 0 ? String(cur.beat + 1) : SYLLABLES[sub][cur.part];
  if (cur.part === 0) {
    const flash = $("#metroFlash");
    flash.classList.toggle("accent", (accents[cur.beat] ?? 1) === 2);
    flash.classList.remove("hit"); void flash.offsetWidth; flash.classList.add("hit");
  }
}

function start() {
  ensureAudio();
  ctx.resume();
  media.claim("metro");
  playing = true;
  step = 0;
  queue = [];
  nextTime = ctx.currentTime + 0.06;
  schedule();
  ticker().postMessage(TICK_MS);
  cancelAnimationFrame(raf);
  frame();
  render();
}

function stop() {
  if (!playing) return;
  playing = false;
  worker?.postMessage(0);
  cancelAnimationFrame(raf);
  queue = [];
  render();
}

// restart the bar from beat 1 (after the signature or subdivision changed)
function restartBar() {
  if (!playing) return;
  step = 0;
  queue = [];
  nextTime = ctx.currentTime + 0.06;
}

// ------------------------------------------------------------------ settings

function setBpm(v) {
  bpm = clampBpm(v);
  store.set("metro-bpm", bpm);
  $("#metroBpm").textContent = bpm;
  $("#metroTerm").textContent = term(bpm);
  $("#metroSlider").value = bpm;
}

function setSig(s) {
  sig = s;
  store.set("metro-sig", s.id);
  accents = loadAccents();
  restartBar();
  render();
}

function setSub(n) {
  sub = n;
  store.set("metro-sub", n);
  restartBar();
  render();
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
  setBpm(60000 / (gaps.reduce((a, b) => a + b, 0) / gaps.length));
}

// ------------------------------------------------------------------ render

function render() {
  setBpm(bpm);

  // beat dots, click cycles accent > normal > silent
  $("#metroBeats").replaceChildren(...accents.map((lvl, i) => {
    const b = el("button", `metro-dot lvl${lvl}`);
    b.type = "button";
    b.title = `Ketukan ${i + 1}: ${lvl === 2 ? "aksen" : lvl === 1 ? "biasa" : "diam"} (klik untuk ganti)`;
    b.append(el("span", null, String(i + 1)));
    b.onclick = () => {
      accents[i] = lvl === 2 ? 1 : lvl === 1 ? 0 : 2;
      saveAccents();
      render();
    };
    return b;
  }));

  $("#metroSig").replaceChildren(...SIGS.map((s) => {
    const b = el("button", `tuner-chip${s === sig ? " on" : ""}`, s.label);
    b.type = "button";
    b.title = s.beats === 1 ? "Tanpa birama: semua ketukan sama" : `Birama ${s.label}`;
    b.onclick = () => setSig(s);
    return b;
  }));

  $("#metroSub").replaceChildren(...SUBS.map((s) => {
    const b = el("button", s.n === sub ? "active" : "", s.label);
    b.type = "button";
    b.title = s.title;
    b.onclick = () => setSub(s.n);
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
      if (!playing) { ensureAudio(); ctx.resume(); click(ctx.currentTime + 0.01, 2); }
    };
    return b;
  }));

  $("#metroVol").value = vol;

  const btn = $("#metroToggle");
  btn.querySelector("use").setAttribute("href", playing ? "#i-stop" : "#i-play");
  btn.lastChild.textContent = playing ? "Stop" : "Mulai";
  btn.classList.toggle("on", playing);
  $("#metroCard").classList.toggle("playing", playing);
  if (!playing) {
    $("#metroCount").textContent = "";
    $$("#metroBeats .metro-dot").forEach((d) => d.classList.remove("now", "hit"));
  }
}

export function enterMetronome() { render(); }

export function initMetronome() {
  media.register("metro", stop);
  $("#metroToggle").onclick = () => (playing ? stop() : start());
  $("#metroMinus").onclick = () => setBpm(bpm - 1);
  $("#metroPlus").onclick = () => setBpm(bpm + 1);
  $("#metroSlider").oninput = (e) => setBpm(+e.target.value);
  $("#metroTap").onclick = tap;
  $("#metroVol").oninput = (e) => {
    vol = +e.target.value;
    store.set("metro-vol", vol);
    if (master) master.gain.value = vol;
  };
  // the click stops outside this page
  window.addEventListener("hashchange", () => { if (router.current !== "metro") stop(); });
  onKeys("metro", (e) => {
    if (e.code === "Space") { e.preventDefault(); playing ? stop() : start(); return; }
    if (e.key === "ArrowUp" || e.key === "ArrowRight") { e.preventDefault(); setBpm(bpm + (e.shiftKey ? 5 : 1)); return; }
    if (e.key === "ArrowDown" || e.key === "ArrowLeft") { e.preventDefault(); setBpm(bpm - (e.shiftKey ? 5 : 1)); return; }
    if (e.key === "t" || e.key === "T") { tap(); return; }
    const n = +e.key;
    if (n >= 1 && n <= 4) setSub(n);
  });
}
