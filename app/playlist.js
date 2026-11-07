// playlist section (encore): youtube + google drive practice player with playlist, a-b loop, speed, pitch, offline drive audio

import { $, $$, el, icon, setIcon, store, fmtTime, textOverflows, parseLink, toast, confirmDialog, showMenu, server, media, onKeys } from "./core.js";
// waits for the first sync, so the state below already includes what the other page saved
import { onRemote, appBase } from "./sync.js";
import { pitchNode, fmtSemis, clampSemis } from "./pitch.js";

const audio = $("#audio");
let list = store.get("lp-playlist", []); // [{url,type,id,start,title,note,bad}]
let idx = store.get("lp-index", -1);
let repeat = store.get("lp-repeat", "off"); // off | all | one
let shuffle = store.get("lp-shuffle", false);
let autonext = store.get("lp-autonext", true);
let rate = store.get("lp-rate", 1);
let cur = null;
let yt = null, ytReady = false, ytApi = null, pendingYT = null;
let A = null, B = null, history = [], loadTok = 0;

function save() { store.set("lp-playlist", list); store.set("lp-index", idx); }

// ------------------------------------------------------------------ chat / link parsing
// reads pasted text (e.g. a whatsapp song list): every link becomes a song; the numbered line above it
// ("1) Judul lagu") becomes its title, lines between that and the link become notes ("Chorus saja"),
// and the lines before the first song become the playlist name.
const URL_RE = /https?:\/\/[^\s<>"']+/g;
const clean = (l) => l.replace(/[*_~`]+/g, "").replace(/\s+/g, " ").trim();

export function extract(text) {
  const ok = [], bad = [];
  let block = [], name = null;
  for (const raw of text.split(/\r?\n/)) {
    const urls = raw.match(URL_RE);
    if (!urls) { const l = clean(raw); if (l) block.push(l); continue; }
    const before = clean(raw.slice(0, raw.indexOf(urls[0])));
    if (before) block.push(before);
    const numbered = block.findLastIndex((l) => /^\d{1,3}\s*[).:-]\s*\S/.test(l));
    let title = null, note = null;
    if (numbered >= 0) {
      title = block[numbered].replace(/^\d{1,3}\s*[).:-]\s*/, "");
      note = block.slice(numbered + 1).join(" · ") || null;
    } else if (block.length === 1 && block[0].length <= 120) title = block[0];
    if (title) title = title.replace(/[\s:\-–—>|]+$/, "") || null;
    if (name === null && !ok.length && !bad.length) name = block.slice(0, numbered >= 0 ? numbered : block.length).join(" · ") || "";
    for (const u of urls) {
      const url = u.replace(/[)*_.,;!]+$/, "");
      const p = parseLink(url);
      p ? ok.push({ url, ...p, title: urls.length === 1 ? title : null, note: urls.length === 1 ? note : null }) : bad.push(url);
    }
    block = [];
  }
  return { ok, bad, name: name || null };
}

// ------------------------------------------------------------------ titles
async function fetchTitle(item) {
  if (item.title) return;
  try {
    const r = await fetch(`/title?type=${item.type}&id=${encodeURIComponent(item.id)}`);
    if (!r.ok) return;
    const j = await r.json();
    if (!j.title) return;
    item.title = j.title;
    save(); renderQueue();
    if (item === cur) { $("#title").textContent = j.title; updateMediaSession(); }
  } catch {}
}

// ------------------------------------------------------------------ editor sheet with live preview
const editor = $("#editor");
function openEditor() {
  $("#links").value = "";
  renderPreview();
  editor.showModal();
  setTimeout(() => $("#links").focus(), 30);
}
$("#openEditor").onclick = openEditor;
$$("[data-open-editor]").forEach((b) => (b.onclick = openEditor));
$("#links").addEventListener("input", renderPreview);

function renderPreview() {
  const box = $("#preview");
  const { ok, bad, name } = extract($("#links").value);
  box.replaceChildren();
  $("#add").disabled = $("#replace").disabled = !ok.length;
  if (!ok.length && !bad.length) return;
  box.append(el("div", "preview-head", `${ok.length} lagu terbaca${name ? ` · “${name}”` : ""}${bad.length ? ` · ${bad.length} link dilewati` : ""}`));
  for (const it of ok) {
    const row = el("div", "preview-item");
    row.append(el("span", "chip", it.type === "yt" ? "YT" : "Drive"), el("span", "t", it.title || it.url));
    if (it.note) row.append(el("span", "n", it.note));
    box.append(row);
  }
  for (const u of bad) {
    const row = el("div", "preview-item bad");
    row.append(el("span", "t", `Bukan YouTube/Drive: ${u}`));
    box.append(row);
  }
}

$("#add").onclick = () => addLinks(false);
$("#replace").onclick = async () => {
  if (list.length && !(await confirmDialog("Ganti seluruh playlist?", `${list.length} lagu sekarang akan diganti dengan yang baru.`, { ok: "Ganti", danger: true }))) return;
  addLinks(true);
};

function addLinks(replace) {
  const text = $("#links").value;
  const { ok, bad, name } = extract(text);
  if (!ok.length) return;
  if (replace) { stop(); list = []; idx = -1; cur = null; history = []; played = new Set(); }
  const wasEmpty = !list.length;
  if (wasEmpty) setName(name);
  list.push(...ok);
  save(); renderQueue();
  ok.forEach(fetchTitle);
  editor.close();
  const fromChat = ok.filter((x) => x.title).length;
  toast(`${ok.length} lagu ditambahkan` + (fromChat ? ` · ${fromChat} judul dari chat` : "") + (bad.length ? ` · ${bad.length} link dilewati` : ""));
  if (wasEmpty) playIndex(0, false);
  pruneCache(); prefetchAll();
}

// add from another section (bass -> playlist)
export function addToPlaylist(url, title) {
  const p = parseLink(url);
  if (!p) return false;
  const exists = list.findIndex((x) => x.type === p.type && x.id === p.id);
  if (exists >= 0) { toast("Lagu ini sudah ada di playlist", { action: "Putar", onAction: () => { location.hash = "#/"; playIndex(exists, true); } }); return true; }
  const item = { url, ...p, title: title || null, note: null };
  list.push(item);
  save(); renderQueue(); fetchTitle(item);
  toast("Ditambahkan ke Playlist", { action: "Putar", onAction: () => { location.hash = "#/"; playIndex(list.length - 1, true); } });
  if (list.length === 1) playIndex(0, false);
  prefetchAll();
  return true;
}

function setName(n) {
  store.set("lp-name", n);
  $("#plName").textContent = n || "Playlist";
}

async function removeAt(i) {
  const playing = i === idx;
  list.splice(i, 1);
  if (i < idx) idx--;
  if (playing) {
    if (list.length) playIndex(Math.min(idx, list.length - 1), isPlaying());
    else { stop(); idx = -1; cur = null; showEmptyPlayer(); }
  }
  if (!list.length) setName(null);
  save(); renderQueue(); pruneCache();
}

// swap a song's link in place: keeps its spot and note, looks the title up again
const relinkBox = $("#relink");
function relinkDetect() {
  const v = $("#relinkUrl").value.trim();
  const p = v ? parseLink(v) : null;
  const d = $("#relinkDetect");
  d.hidden = !v;
  d.textContent = p ? (p.type === "yt" ? "YouTube" : "Drive") : "link tidak dikenali";
  d.classList.toggle("bad", !p);
  $("#relinkOk").disabled = !p;
}
$("#relinkUrl").addEventListener("input", relinkDetect);
// enter saves (the first button in the form is the close x)
for (const f of ["#relinkUrl", "#relinkName"]) {
  $(f).addEventListener("keydown", (e) => {
    if (e.key !== "Enter" || e.isComposing) return;
    e.preventDefault();
    if (!$("#relinkOk").disabled) relinkBox.close("ok");
  });
}

function relink(i) {
  const it = list[i];
  if (!it) return;
  $("#relinkTitle").textContent = `Ganti link lagu #${i + 1}`;
  $("#relinkUrl").value = it.url;
  $("#relinkName").value = "";
  $("#relinkName").placeholder = it.title ? `Kosongkan untuk ambil dari link (sekarang: ${it.title})` : "Kosongkan untuk ambil judul dari link";
  relinkDetect();
  relinkBox.returnValue = "";
  relinkBox.showModal();
  $("#relinkUrl").select();
  relinkBox.addEventListener("close", () => {
    if (relinkBox.returnValue !== "ok" || list[i] !== it) return;
    const url = $("#relinkUrl").value.trim();
    const p = parseLink(url);
    if (!p) return;
    const name = $("#relinkName").value.trim();
    const sameLink = p.type === it.type && p.id === it.id;
    if (sameLink && !name) return;
    const item = { url, ...p, title: name || (sameLink ? it.title : null), note: it.note };
    list[i] = item;
    if (i === idx) playIndex(i, isPlaying());
    save(); renderQueue();
    if (!item.title) fetchTitle(item);
    toast(`Link lagu #${i + 1} diganti`);
    pruneCache(); prefetchAll();
  }, { once: true });
}

function moveItem(from, to) {
  if (from === to || to < 0 || to >= list.length) return;
  const [it] = list.splice(from, 1);
  list.splice(to, 0, it);
  if (idx === from) idx = to;
  else if (from < idx && to >= idx) idx--;
  else if (from > idx && to <= idx) idx++;
  save(); renderQueue();
}

// ------------------------------------------------------------------ queue rendering + drag to reorder
function renderQueue() {
  const ol = $("#queue");
  $("#qEmpty").hidden = list.length > 0;
  ol.hidden = !list.length;
  $("#offlineHint").hidden = !hasCache || !list.some((x) => x.type === "drive" && cached.has(x.id));
  $("#count").textContent = list.length ? `${list.length} lagu` : "";
  const playing = isPlaying();
  const rows = list.map((it, i) => {
    const li = el("li", "q-item" + (i === idx ? " cur" : "") + (it.bad ? " bad" : ""));
    li.dataset.i = i;
    li.title = it.url;
    const grip = el("span", "q-grip");
    grip.append(icon("grip"));
    grip.title = "Geser untuk pindah urutan";
    grip.addEventListener("pointerdown", (e) => startDrag(e, i, li));
    const num = el("span", "q-num");
    if (i === idx && playing) num.append(eqIcon()); else num.textContent = i + 1;
    const body = el("div", "q-body");
    body.append(el("span", "q-title", it.title || it.url));
    const sub = el("span", "q-sub");
    sub.append(el("span", null, it.type === "yt" ? "YouTube" : "Drive"));
    if (it.type === "drive" && hasCache) { const d = el("span", "q-dl"); d.dataset.dl = it.id; paintDl(d, it.id); sub.append(d); }
    if (it.note) sub.append(el("span", "q-note", it.note));
    body.append(sub);
    const acts = el("span", "q-acts");
    if (canBreakdown(it)) {
      const b = el("button", "icon-btn bass");
      b.type = "button"; b.title = "Breakdown lagu ini"; b.append(icon("bass"));
      b.onclick = (e) => { e.stopPropagation(); sendToBass(it); };
      acts.append(b);
    }
    const open = el("a", "icon-btn");
    open.href = it.url; open.target = "_blank"; open.rel = "noopener noreferrer";
    open.title = it.type === "yt" ? "Buka di YouTube" : "Buka di Google Drive";
    open.append(icon("link"));
    open.onclick = (e) => e.stopPropagation();
    acts.append(open);
    const more = el("button", "icon-btn");
    more.type = "button"; more.title = "Lainnya"; more.append(icon("more"));
    more.onclick = (e) => {
      e.stopPropagation();
      showMenu(more, [
        { label: it.type === "yt" ? "Buka di YouTube" : "Buka di Google Drive", icon: "link", href: it.url },
        { label: "Ganti link", icon: "refresh", onClick: () => relink(i) },
        i > 0 && { label: "Pindah ke atas", icon: "up", onClick: () => moveItem(i, i - 1) },
        i < list.length - 1 && { label: "Pindah ke bawah", icon: "down", onClick: () => moveItem(i, i + 1) },
        canBreakdown(it) && { label: "Breakdown lagu ini", icon: "bass", onClick: () => sendToBass(it) },
        { label: "Hapus dari playlist", icon: "trash", danger: true, onClick: () => removeAt(i) },
      ]);
    };
    acts.append(more);
    li.append(grip, num, body, acts);
    li.onclick = () => playIndex(i, true);
    return li;
  });
  ol.replaceChildren(...rows);
  $("#pos").textContent = idx >= 0 && list.length ? `${idx + 1} / ${list.length}` : "";
  $("#prev").disabled = $("#next").disabled = !list.length;
  // on the web this button points to the encore app download
  $("#toBass").hidden = !(cur && (server.bass ? canBreakdown(cur) : server.checked));
}

function eqIcon() {
  const s = el("span", "nav-eq");
  s.append(el("i"), el("i"), el("i"));
  return s;
}

let drag = null;
function startDrag(e, i, li) {
  e.preventDefault();
  e.stopPropagation();
  drag = { from: i, to: i, li };
  li.classList.add("dragging");
  li.setPointerCapture(e.pointerId);
  const move = (ev) => {
    const target = document.elementFromPoint(ev.clientX, ev.clientY)?.closest(".q-item");
    $$(".q-item").forEach((x) => x.classList.remove("drop-before", "drop-after"));
    if (!target || target === li) { drag.to = drag.from; return; }
    const j = +target.dataset.i;
    const r = target.getBoundingClientRect();
    const after = ev.clientY > r.top + r.height / 2;
    target.classList.add(after ? "drop-after" : "drop-before");
    let to = after ? j + 1 : j;
    if (to > drag.from) to--;
    drag.to = to;
  };
  const up = () => {
    li.removeEventListener("pointermove", move);
    li.removeEventListener("pointerup", up);
    li.removeEventListener("pointercancel", up);
    li.classList.remove("dragging");
    $$(".q-item").forEach((x) => x.classList.remove("drop-before", "drop-after"));
    const { from, to } = drag;
    drag = null;
    if (from !== to) moveItem(from, to);
  };
  li.addEventListener("pointermove", move);
  li.addEventListener("pointerup", up);
  li.addEventListener("pointercancel", up);
}

// a server without youtube can still take google drive songs
const canBreakdown = (it) => server.bass && (server.youtube || it.type === "drive");

// hand a song to the breakdown section (needs the encore server)
let bassSend = null;
export function onSendToBass(fn) { bassSend = fn; }
function sendToBass(it) { bassSend?.(it.url, it.title); }
$("#toBass").onclick = () => cur && sendToBass(cur);

// ------------------------------------------------------------------ engine
const P = {
  play() {
    if (!cur) { if (list.length) playIndex(Math.max(idx, 0), true); return; }
    media.claim("playlist");
    if (cur.type !== "yt") eqWake();
    cur.type === "yt" ? ytReady && yt.playVideo() : audio.play().catch(() => {});
  },
  pause() { cur?.type === "yt" ? ytReady && yt.pauseVideo() : audio.pause(); },
  time() { return cur?.type === "yt" ? (ytReady ? yt.getCurrentTime() || 0 : 0) : audio.currentTime; },
  dur() { return cur?.type === "yt" ? (ytReady ? yt.getDuration() || 0 : 0) : isFinite(audio.duration) ? audio.duration : 0; },
  seek(t) {
    const d = P.dur();
    t = Math.max(0, d ? Math.min(t, d - 0.05) : t);
    cur?.type === "yt" ? ytReady && yt.seekTo(t, true) : (audio.currentTime = t);
  },
  setRate(r) { if (ytReady) yt.setPlaybackRate(r); audio.playbackRate = r; audio.defaultPlaybackRate = r; },
  setVol(v) { if (ytReady) yt.setVolume(v); audio.volume = v / 100; },
};
export const pausePlaylist = () => P.pause();
media.register("playlist", () => P.pause());

function isPlaying() {
  return cur?.type === "yt" ? ytReady && [1, 3].includes(yt.getPlayerState()) : cur && !audio.paused;
}
function showMsg(t) { const m = $("#msg"); m.textContent = t; m.hidden = !t; }

function showEmptyPlayer() {
  $("#title").textContent = "Belum ada lagu";
  $("#srcBadge").textContent = "—";
  $("#pos").textContent = "";
  $("#media").className = "media is-audio";
  $("#note").textContent = "Tambahkan lagu untuk mulai latihan";
  $("#nowNote").hidden = true;
  render();
}

export function playIndex(i, autoplay = true) {
  if (i < 0 || i >= list.length) return;
  if (idx >= 0 && idx !== i) history.push(idx);
  idx = i; save();
  const it = list[i];
  cur = it;
  showMsg("");
  A = B = null; updateAB();
  $("#srcBadge").textContent = it.type === "yt" ? "YouTube" : "Drive";
  $("#title").textContent = it.title || "Memuat…";
  $("#nowNote").textContent = it.note || "";
  $("#nowNote").hidden = !it.note;
  fetchTitle(it);
  loadSections(it);
  if (autoplay) media.claim("playlist");
  const tok = ++loadTok;
  if (it.type === "yt") {
    audio.pause(); audio.removeAttribute("src"); audio.load();
    $("#media").className = "media";
    loadYT(it, autoplay);
  } else {
    if (ytReady) { try { yt.stopVideo(); } catch {} }
    $("#media").className = "media is-audio";
    const setSrc = (src, offline) => {
      if (tok !== loadTok) return;
      $("#note").textContent = offline ? "Audio Google Drive · tersimpan offline" : "Audio Google Drive";
      audio.src = src;
      audio.preservesPitch = true;
      audio.playbackRate = rate; audio.defaultPlaybackRate = rate;
      audio.volume = vol() / 100;
      if (autoplay) { eqWake(); audio.play().catch(() => {}); }
    };
    const net = driveKey(it.id), ready = blobURLs.get(it.id);
    if (ready) setSrc(ready, true);
    else if (cached.has(it.id)) cachedURL(it.id).then((u) => { if (u) blobURLs.set(it.id, u); setSrc(u || net, !!u); });
    // the encore app has it: copy it over first (local, quick) instead of streaming from drive
    else if (onApp.has(it.id)) cacheDrive(it.id).then(async (ok) => { const u = ok ? await cachedURL(it.id) : null; if (u) blobURLs.set(it.id, u); setSrc(u || net, !!u); });
    else setSrc(net, false);
  }
  prepareAround(); paintEq(); normTrack(); paintPitch(); applyPitch();
  renderQueue(); render(); updateMediaSession();
  $("#queue .q-item.cur")?.scrollIntoView({ block: "nearest" });
}

function loadYT(it, autoplay) {
  if (!window.YT || !YT.Player) {
    pendingYT = [it, autoplay];
    if (!ytApi) { ytApi = document.createElement("script"); ytApi.src = "https://www.youtube.com/iframe_api"; document.head.append(ytApi); }
    window.onYouTubeIframeAPIReady = () => { const [a, b] = pendingYT; pendingYT = null; loadYT(a, b); };
    return;
  }
  if (!yt) {
    yt = new YT.Player("yt", {
      videoId: it.id,
      playerVars: { start: it.start || 0, rel: 0, playsinline: 1, autoplay: autoplay ? 1 : 0, disablekb: 1 },
      events: {
        onReady: () => { ytReady = true; P.setRate(rate); P.setVol(vol()); if (autoplay) yt.playVideo(); },
        onStateChange: (e) => {
          if (e.data === 0) onEnded();
          if (e.data === 1) { media.claim("playlist"); P.setRate(rate); ytTitle(); }
          renderQueue();
        },
        onError: (e) => {
          markBad({
            100: "Video tidak ditemukan atau privat.",
            101: "Pemilik video tidak mengizinkan diputar di luar YouTube.",
            150: "Pemilik video tidak mengizinkan diputar di luar YouTube.",
            153: "YouTube menolak memutar video ini di sini.",
          }[e.data] || "YouTube error " + e.data);
        },
      },
    });
    return;
  }
  const opts = { videoId: it.id, startSeconds: it.start || 0 };
  autoplay ? yt.loadVideoById(opts) : yt.cueVideoById(opts);
}
function ytTitle() {
  try {
    const t = yt.getVideoData().title;
    if (t && cur && !cur.title) { cur.title = t; save(); renderQueue(); $("#title").textContent = t; }
  } catch {}
}

function markBad(text) {
  if (!cur) return;
  cur.bad = true; save(); renderQueue();
  showMsg(text + ((autonext || repeat === "all") && list.length > 1 && list.some((x) => !x.bad) ? " Lanjut ke lagu berikutnya…" : ""));
  // skip only while some other song can still play, otherwise repeat all would loop forever
  if ((autonext || repeat === "all") && list.length > 1 && list.some((x) => !x.bad)) setTimeout(() => nextTrack(true), 2500);
}
audio.onerror = () => { if (audio.getAttribute("src")) markBad('Audio Drive tidak bisa diputar. Pastikan file dibagikan "Siapa saja yang memiliki link" dan berupa audio, lalu salin ulang link-nya dari tombol Bagikan.'); };
audio.onplaying = () => { eqWake(); if (cur) cur.bad = false; media.claim("playlist"); renderQueue(); };
audio.onpause = renderQueue;
audio.onended = onEnded;

function onEnded() {
  if (repeat === "one") { P.seek(0); P.play(); return; }
  // repeat all keeps the playlist going even when auto next is off
  if (autonext || repeat === "all") nextTrack(true);
}
// songs already played in this shuffle round, so shuffle plays each song once before repeating
let played = new Set();
function pickNext() {
  if (!list.length) return -1;
  if (shuffle && list.length > 1) {
    played.add(idx);
    let left = list.map((_, i) => i).filter((i) => !played.has(i));
    if (!left.length) {
      if (repeat !== "all") return -1;
      // new round: everything except the current song is available again
      played = new Set([idx]);
      left = list.map((_, i) => i).filter((i) => i !== idx);
    }
    return left[Math.floor(Math.random() * left.length)];
  }
  if (idx + 1 < list.length) return idx + 1;
  return repeat === "all" ? 0 : -1;
}
function nextTrack(auto = false) {
  const j = pickNext();
  if (j < 0) { played = new Set(); if (auto) { stop(); showMsg("Playlist selesai."); } else if (list.length) playIndex(0, true); return; }
  playIndex(j, true);
}
function prevTrack() {
  if (!list.length) return;
  if (P.time() > 3) { P.seek(0); return; } // first press restarts the song
  const j = shuffle && history.length ? history.pop() : idx > 0 ? idx - 1 : repeat === "all" ? list.length - 1 : 0;
  const h = history.length;
  playIndex(j, true);
  if (shuffle) history.length = h;
}
function stop() {
  P.pause();
  if (cur) P.seek(0);
  if (cur?.type === "yt" && ytReady) yt.stopVideo();
  A = B = null; updateAB(); renderQueue(); render();
}

// ------------------------------------------------------------------ controls
const togglePlay = () => (isPlaying() ? P.pause() : P.play());
$("#play").onclick = togglePlay;
$("#stop").onclick = stop;
$("#next").onclick = () => nextTrack(false);
$("#prev").onclick = prevTrack;
$$("[data-skip]").forEach((b) => (b.onclick = () => P.seek(P.time() + +b.dataset.skip)));

function paintModes() {
  const r = $("#repeat");
  r.classList.toggle("on", repeat !== "off");
  r.title = { off: "Tanpa ulang", one: "Ulang 1 lagu", all: "Ulang semua" }[repeat] + " (R)";
  $("#repeatOne").hidden = repeat !== "one";
  $("#shuffle").classList.toggle("on", shuffle);
  $("#shuffle").title = "Acak: " + (shuffle ? "nyala" : "mati");
  $("#autonext").classList.toggle("on", autonext);
  store.set("lp-repeat", repeat); store.set("lp-shuffle", shuffle); store.set("lp-autonext", autonext);
}
const cycleRepeat = () => {
  repeat = { off: "one", one: "all", all: "off" }[repeat];
  paintModes();
  toast({ off: "Tanpa ulang", one: "Ulang 1 lagu", all: "Ulang semua" }[repeat], { ms: 1500 });
};
$("#repeat").onclick = cycleRepeat;
$("#shuffle").onclick = () => { shuffle = !shuffle; history = []; played = new Set(); paintModes(); };
$("#autonext").onclick = () => { autonext = !autonext; paintModes(); };

function applyRate(r) {
  rate = Math.round(Math.min(2, Math.max(0.25, r)) * 100) / 100;
  P.setRate(rate);
  $("#rate").textContent = rate.toFixed(2) + "×";
  $$("#ratePresets [data-rate]").forEach((b) => b.classList.toggle("active", +b.dataset.rate === rate));
  store.set("lp-rate", rate);
}
$("#slower").onclick = () => applyRate(rate - 0.05);
$("#faster").onclick = () => applyRate(rate + 0.05);
$$("[data-rate]").forEach((b) => (b.onclick = () => applyRate(+b.dataset.rate)));
$("#vol").value = store.get("lp-vol", 100);
$("#volVal").textContent = $("#vol").value;
// mute keeps the slider where it is; moving the slider unmutes
let muted = false;
const vol = () => (muted ? 0 : +$("#vol").value);
function setMuted(m) {
  muted = m;
  P.setVol(vol());
  setIcon($("#volBtn"), muted ? "mute" : "volume");
  $("#volBtn").title = muted ? "Unmute (M)" : "Mute (M)";
  $("#volBtn").setAttribute("aria-pressed", String(muted));
  $("#volBtn").classList.toggle("on", muted);
  $("#volVal").textContent = muted ? "mute" : $("#vol").value;
}
$("#volBtn").onclick = () => setMuted(!muted);
$("#vol").oninput = (e) => { store.set("lp-vol", +e.target.value); setMuted(false); };
function nudgeVol(d) {
  const v = Math.min(100, Math.max(0, +$("#vol").value + d));
  $("#vol").value = v;
  store.set("lp-vol", v);
  setMuted(false);
}

// ------------------------------------------------------------------ equalizer (drive audio only)
// the <audio> element is routed through web audio filters. youtube plays inside its own iframe, so it can't be touched.
// the graph is only built once the eq leaves flat: a routed element goes silent while its context is suspended.
const EQ_BANDS = [
  { f: 80, type: "lowshelf", label: "80" },
  { f: 250, type: "peaking", label: "250" },
  { f: 1000, type: "peaking", label: "1k" },
  { f: 4000, type: "peaking", label: "4k" },
  { f: 12000, type: "highshelf", label: "12k" },
];
const EQ_PRESETS = {
  flat: { name: "Flat", g: [0, 0, 0, 0, 0] },
  bassUp: { name: "Bass +", g: [6, 3, 0, 0, 0] },
  bassCut: { name: "Tanpa bass", g: [-12, -8, 0, 0, 0] },
  vocal: { name: "Vokal", g: [-3, -1, 3, 4, 1] },
};
let eqGains = store.get("lp-eq", EQ_PRESETS.flat.g);
let eqCtx = null, eqNodes = null, eqPre = null, normGain = null, limiter = null, meter = null, shifter = null;
const eqFlat = () => eqGains.every((g) => !g);

// build the filter chain on first use
function eqGraph() {
  if (eqCtx) return true;
  try {
    eqCtx = new (window.AudioContext || window.webkitAudioContext)();
    const src = eqCtx.createMediaElementSource(audio);
    eqPre = eqCtx.createGain();
    eqNodes = EQ_BANDS.map((b) => {
      const n = eqCtx.createBiquadFilter();
      n.type = b.type; n.frequency.value = b.f; n.Q.value = 1;
      return n;
    });
    // auto volume: per-song gain, then a limiter so boosted songs don't clip
    normGain = eqCtx.createGain();
    limiter = eqCtx.createDynamicsCompressor();
    limiter.knee.value = 0; limiter.attack.value = 0.003; limiter.release.value = 0.25;
    [src, eqPre, ...eqNodes, normGain, limiter].reduce((a, b) => (a.connect(b), b)).connect(eqCtx.destination);
    // side branch that measures the raw level for the live estimate
    meter = eqCtx.createAnalyser(); meter.fftSize = 8192;
    src.connect(meter);
    applyGains(); applyNorm(true); applyPitch();
    return true;
  } catch { eqCtx = null; return false; }
}
// push the current gains into the filters
function applyGains() {
  const t = eqCtx.currentTime;
  eqNodes.forEach((n, i) => n.gain.setTargetAtTime(eqGains[i], t, 0.03));
  // pull the level down on boosts so they don't clip
  const boost = Math.max(0, ...eqGains);
  eqPre.gain.setTargetAtTime(Math.pow(10, -boost / 2 / 20), t, 0.03);
}
// make sure the context runs before (or while) audio plays
function eqWake() {
  if (!eqCtx && (!eqFlat() || norm || songPitch())) eqGraph();
  if (eqCtx?.state === "suspended") eqCtx.resume().catch(() => {});
}
function setEq(g) {
  eqGains = g.map((x) => Math.max(-12, Math.min(12, Math.round(x))));
  store.set("lp-eq", eqGains);
  if (eqCtx) applyGains();
  eqWake(); paintEq();
}
// band sliders
const eqInputs = EQ_BANDS.map((b, i) => {
  const wrap = el("label", "eq-band");
  const val = el("b");
  const inp = el("input");
  inp.type = "range"; inp.min = -12; inp.max = 12; inp.step = 1;
  inp.setAttribute("aria-label", `EQ ${b.label} Hz`);
  inp.oninput = () => { const g = [...eqGains]; g[i] = +inp.value; setEq(g); };
  // double click resets one band
  inp.ondblclick = () => { const g = [...eqGains]; g[i] = 0; setEq(g); };
  wrap.append(val, inp, el("span", null, b.label));
  $("#eqBands").append(wrap);
  return { inp, val };
});
$$("[data-eq]").forEach((b) => (b.onclick = () => setEq(EQ_PRESETS[b.dataset.eq].g)));
function paintEq() {
  eqInputs.forEach(({ inp, val }, i) => { inp.value = eqGains[i]; val.textContent = (eqGains[i] > 0 ? "+" : "") + eqGains[i]; });
  const key = Object.keys(EQ_PRESETS).find((k) => EQ_PRESETS[k].g.every((x, i) => x === eqGains[i]));
  $("#eqName").textContent = key ? EQ_PRESETS[key].name : "Custom";
  $$("[data-eq]").forEach((b) => b.classList.toggle("active", b.dataset.eq === key));
  const isYT = cur?.type === "yt";
  $("#eqHint").hidden = !isYT;
  $(".tool.eq").classList.toggle("off", isYT);
}
paintEq();

// ------------------------------------------------------------------ pitch (drive audio only)
// semitones up/down without changing speed, saved per song (a song tuned to eb stays shifted).
// a worklet before the limiter does it; at 0 it passes audio through untouched.
const pitches = store.get("lp-pitch", {}); // song id -> semitones
const songPitch = () => (cur && cur.type !== "yt" ? pitches[cur.id] || 0 : 0);
let shifterLoading = false;
// make sure the shifter is in the graph when needed, then send it the current value
async function applyPitch() {
  const s = songPitch();
  if (shifter) { shifter.setSemitones(s); return; }
  if (!s || !eqCtx || shifterLoading) return;
  shifterLoading = true;
  const node = await pitchNode(eqCtx);
  shifterLoading = false;
  if (!node) { toast("Browser ini belum bisa mengubah nada", { ms: 2500 }); return; }
  // before the limiter, so a shifted song can't clip
  normGain.disconnect();
  normGain.connect(node).connect(limiter);
  shifter = node;
  shifter.setSemitones(songPitch());
}
function setPitch(v) {
  if (!cur || cur.type === "yt") return;
  const s = clampSemis(v);
  if (s) pitches[cur.id] = s; else delete pitches[cur.id];
  store.set("lp-pitch", pitches);
  eqWake(); applyPitch(); paintPitch();
}
function paintPitch() {
  const s = songPitch(), isYT = cur?.type === "yt";
  $("#pitchVal").textContent = fmtSemis(s);
  $("#pitchReset").disabled = !s;
  $("#pitchHint").hidden = !isYT;
  $(".pitch-note").hidden = isYT;
  $(".tool.pitch").classList.toggle("off", isYT);
}
$("#pitchDown").onclick = () => setPitch(songPitch() - 1);
$("#pitchUp").onclick = () => setPitch(songPitch() + 1);
$("#pitchReset").onclick = () => setPitch(0);
paintPitch();

// ------------------------------------------------------------------ auto volume (drive audio only, off by default)
// evens out loud and quiet songs. each song is measured once from its offline copy and gets its own gain;
// until then a live meter estimates the level while it plays.
const NORM_TARGET = -16; // average level (dB rms) every song is moved to
const NORM_MIN = -12, NORM_MAX = 9;
let norm = store.get("lp-norm", false);
const loud = store.get("lp-loud", {}); // drive id -> measured level in dB
const measuring = new Set();
let live = [];
const mbuf = new Float32Array(8192);

// loudness of a list of mean-square blocks, gated like lufs (no k-weighting)
function gatedDb(ms) {
  let g = ms.filter((x) => x > 1e-7);
  if (!g.length) return null;
  const rel = g.reduce((a, b) => a + b) / g.length / 10;
  g = g.filter((x) => x > rel);
  return 10 * Math.log10(g.reduce((a, b) => a + b) / g.length);
}
// 400 ms blocks over the whole decoded song
function levelOf(b) {
  const block = Math.round(b.sampleRate * 0.4), ch = Array.from({ length: b.numberOfChannels }, (_, i) => b.getChannelData(i));
  const ms = [];
  for (let s = 0; s + block <= b.length; s += block) {
    let sum = 0;
    for (const c of ch) for (let i = s; i < s + block; i++) sum += c[i] * c[i];
    ms.push(sum / (block * ch.length));
  }
  return gatedDb(ms);
}
// decode the offline copy at a low sample rate (enough for level, light on memory) and store its level
async function measure(id) {
  if (id in loud || measuring.has(id) || !hasCache) return;
  measuring.add(id);
  try {
    const r = await (await caches.open(AUDIO_CACHE)).match(driveKey(id));
    if (!r) return;
    const data = await new OfflineAudioContext(1, 1, 11025).decodeAudioData(await r.arrayBuffer());
    const db = levelOf(data);
    if (db == null) return;
    loud[id] = Math.round(db * 10) / 10;
    store.set("lp-loud", loud);
    if (cur?.id === id) applyNorm(true);
  } catch {} finally { measuring.delete(id); }
}
// gain for the current song: measured level first, live estimate otherwise
function normDb() {
  if (!norm || !cur || cur.type === "yt") return null;
  const L = cur.id in loud ? loud[cur.id] : live.length >= 12 ? gatedDb(live) : null;
  return L == null ? null : Math.max(NORM_MIN, Math.min(NORM_MAX, NORM_TARGET - L));
}
// push the gain and limiter settings into the graph; jumps fast on a new song, glides on live updates
function applyNorm(fast) {
  const d = normDb();
  if (normGain) {
    const t = eqCtx.currentTime;
    normGain.gain.setTargetAtTime(Math.pow(10, (d || 0) / 20), t, fast ? 0.05 : 1.5);
    limiter.threshold.value = norm ? -1 : 0;
    limiter.ratio.value = norm ? 20 : 1;
  }
  paintNorm(d);
}
// sample the raw level a few times a second while an unmeasured song plays
setInterval(() => {
  if (!norm || !meter || !cur || cur.type === "yt" || cur.id in loud || audio.paused) return;
  meter.getFloatTimeDomainData(mbuf);
  let sum = 0;
  for (const x of mbuf) sum += x * x;
  // the element volume is applied before the meter, undo it
  const v = audio.volume;
  if (v > 0.01) live.push(sum / mbuf.length / (v * v));
  if (live.length >= 12) applyNorm(false);
}, 250);
// called on every song change
function normTrack() {
  live = [];
  if (norm && cur?.type === "drive" && cached.has(cur.id)) measure(cur.id);
  applyNorm(true);
}
function paintNorm(d = normDb()) {
  const b = $("#normBtn");
  b.classList.toggle("on", norm);
  b.setAttribute("aria-pressed", String(norm));
  $("#normVal").textContent = !norm ? "" : cur?.type === "yt" ? "tidak untuk YouTube"
    : d == null ? "mengukur…" : (d > 0 ? "+" : d < 0 ? "−" : "") + Math.abs(d).toFixed(1) + " dB";
}
$("#normBtn").onclick = () => {
  norm = !norm;
  store.set("lp-norm", norm);
  if (norm) { eqWake(); prepareAround(); }
  normTrack();
  toast(norm ? "Ratakan volume aktif" : "Ratakan volume mati", { ms: 1500 });
};
paintNorm();

// ------------------------------------------------------------------ a-b loop (buttons + draggable handles on the seek bar)
function updateAB() {
  const z = $("#loopzone"), d = P.dur();
  $("#abText").textContent = A == null && B == null ? "Belum ada" : `${A != null ? fmtTime(A) : "—"} → ${B != null ? fmtTime(B) : "—"}`;
  $("#setA").classList.toggle("on", A != null);
  $("#setB").classList.toggle("on", B != null);
  if (A != null && B != null && d) {
    z.style.display = "block";
    z.style.left = (A / d) * 100 + "%";
    z.style.width = ((B - A) / d) * 100 + "%";
  } else z.style.display = "none";
}
function setA() { if (!cur) return; A = P.time(); if (B != null && B <= A) B = null; updateAB(); }
function setB() { if (!cur) return; const t = P.time(); if (A == null) A = 0; if (t > A) B = t; updateAB(); if (B != null) P.seek(A); }
function clearAB() { A = B = null; updateAB(); }
$("#setA").onclick = setA;
$("#setB").onclick = setB;
$("#clearAB").onclick = clearAB;

// ------------------------------------------------------------------ song parts (from a breakdown in the encore app)
const secBox = $("#lpSections");
const secCache = new Map(); // song key -> {duration, sections}
let secSong = null, secIdx = -1;
const secKey = (it) => (it.type === "yt" ? "yt_" : "gd_") + it.id;
const secParts = () => secSong?.sections || [];
const secEnd = (i) => secParts()[i + 1]?.t ?? secSong.duration;
const secAt = (t) => { let i = -1; secParts().forEach((p, j) => { if (p.t <= t + 1e-6) i = j; }); return i; };
// ask the encore app for the parts of the current song; quietly hides when it has none
async function loadSections(it) {
  secSong = null; paintSections();
  if (!it || appBase() == null) return;
  const key = secKey(it);
  if (!secCache.has(key)) {
    try {
      const r = await fetch(appBase() + "/api/sections/" + encodeURIComponent(key), { signal: AbortSignal.timeout(60000) });
      // only remember found parts; a song may be broken down later
      const s = r.ok ? await r.json() : null;
      if (s?.sections?.length) secCache.set(key, s);
    } catch {}
  }
  if (cur !== it) return;
  const s = secCache.get(key);
  secSong = s?.sections?.length && s.duration ? s : null;
  paintSections();
}
function paintSections() {
  secIdx = -1;
  secBox.replaceChildren();
  secBox.hidden = !secParts().length;
  const D = secSong?.duration || 1;
  secParts().forEach((p, i) => {
    const b = el("button", `sec sec-${p.kind}`, p.label);
    b.type = "button";
    b.title = `${p.label} · ${fmtTime(p.t)}–${fmtTime(secEnd(i))} (klik dua kali untuk loop A–B)`;
    b.style.left = `${(p.t / D) * 100}%`;
    b.style.width = `${((secEnd(i) - p.t) / D) * 100}%`;
    b.dataset.full = p.label;
    // click jumps to the part, double click turns it into the a-b loop
    b.onclick = () => { P.seek(p.t); render(); };
    b.ondblclick = () => { A = p.t; B = secEnd(i); updateAB(); P.seek(A); };
    secBox.append(b);
  });
  fitSections();
}
// narrow parts get a short label (chorus 2 -> c2)
const SEC_SHORT = { intro: "In", verse: "V", prechorus: "PC", chorus: "C", bridge: "Br", interlude: "Int", outro: "Out" };
function fitSections() {
  secParts().forEach((p, i) => {
    const b = secBox.children[i];
    if (!b) return;
    b.textContent = b.dataset.full;
    if (textOverflows(b)) b.textContent = SEC_SHORT[p.kind] + (p.label.match(/\d+$/)?.[0] || "");
  });
}
// refit when the strip changes width (window resize, or the playlist page becoming visible)
new ResizeObserver(fitSections).observe(secBox);
// highlight the part that is playing
function updateSections(t) {
  if (!secParts().length) return;
  const i = secAt(t);
  if (i === secIdx) return;
  secBox.children[secIdx]?.classList.remove("playing");
  secBox.children[i]?.classList.add("playing");
  secIdx = i;
}

// ------------------------------------------------------------------ seek bar
const bar = $("#bar");
let dragging = false, abDrag = null;
const posAt = (e) => { const r = bar.getBoundingClientRect(); return Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)); };
function seekFromEvent(e) { const p = posAt(e); P.seek(p * P.dur()); render(p); }
bar.addEventListener("pointerdown", (e) => {
  if (!cur) return;
  const h = e.target.closest(".ab-handle");
  bar.setPointerCapture(e.pointerId);
  if (h) { abDrag = h.dataset.h; return; }
  dragging = true;
  bar.classList.add("drag");
  seekFromEvent(e);
});
bar.addEventListener("pointermove", (e) => {
  const d = P.dur();
  const tip = $("#seekTip");
  if (d) { const p = posAt(e); tip.hidden = false; tip.style.left = p * 100 + "%"; tip.textContent = fmtTime(p * d); }
  if (abDrag && d) {
    const t = posAt(e) * d;
    if (abDrag === "A") A = Math.min(t, B - 0.2);
    else B = Math.max(t, A + 0.2);
    updateAB();
  } else if (dragging) seekFromEvent(e);
});
bar.addEventListener("pointerleave", () => { if (!dragging && !abDrag) $("#seekTip").hidden = true; });
bar.addEventListener("pointerup", () => {
  if (abDrag) P.seek(A);
  dragging = false; abDrag = null;
  bar.classList.remove("drag");
  $("#seekTip").hidden = true;
});
bar.addEventListener("keydown", (e) => {
  if (e.key === "ArrowLeft") { e.preventDefault(); e.stopPropagation(); P.seek(P.time() - 5); }
  if (e.key === "ArrowRight") { e.preventDefault(); e.stopPropagation(); P.seek(P.time() + 5); }
});

let lastPlaying = null;
function render(pOverride) {
  const t = P.time(), d = P.dur(), p = pOverride ?? (d ? t / d : 0);
  $("#fill").style.width = p * 100 + "%";
  $("#knob").style.left = p * 100 + "%";
  $("#cur").textContent = fmtTime(pOverride != null ? pOverride * d : t);
  $("#dur").textContent = fmtTime(d);
  updateSections(pOverride != null ? pOverride * d : t);
  const pl = !!isPlaying();
  if (pl !== lastPlaying) {
    lastPlaying = pl;
    setIcon($("#play"), pl ? "pause" : "play");
    $("#player").classList.toggle("playing", pl);
    $("#navEq").hidden = !pl;
    if (list.length) renderQueue();
    updateMediaSession();
  }
}
setInterval(() => {
  if (!cur) return;
  if (A != null && B != null && P.time() >= B) P.seek(A);
  if (!dragging) render();
}, 150);
audio.onloadedmetadata = () => { updateAB(); render(); };

// ------------------------------------------------------------------ keyboard
// clicking the youtube video moves focus into its iframe, where youtube's own shortcuts would take over.
// hand focus straight back so encore's shortcuts keep working.
window.addEventListener("blur", () => setTimeout(() => {
  if (document.activeElement?.tagName === "IFRAME") { document.activeElement.blur(); window.focus(); }
}, 0));
onKeys("playlist", (e) => {
  const act = {
    " ": togglePlay, k: togglePlay,
    n: () => nextTrack(false), r: cycleRepeat, p: prevTrack, s: stop,
    arrowleft: () => P.seek(P.time() - 5), arrowright: () => P.seek(P.time() + 5),
    j: () => P.seek(P.time() - 10), l: () => P.seek(P.time() + 10),
    "[": () => applyRate(rate - 0.05), "]": () => applyRate(rate + 0.05),
    "-": () => setPitch(songPitch() - 1), "=": () => setPitch(songPitch() + 1), "+": () => setPitch(songPitch() + 1),
    a: setA, b: setB, c: clearAB, m: () => setMuted(!muted),
    arrowup: () => nudgeVol(5), arrowdown: () => nudgeVol(-5),
  }[e.key.toLowerCase()];
  // a focused range slider already handles its own arrows
  if (e.target.type === "range" && e.key.startsWith("Arrow")) return;
  if (act) { e.preventDefault(); act(); }
});

// ------------------------------------------------------------------ offline copies of drive audio
// each drive song is downloaded once into cache storage, then played from the device: no data on replay,
// works offline, instant seeking. songs are fetched one by one in playlist order, from the current one.
const AUDIO_CACHE = "encore-audio-v1";
const hasCache = "caches" in window;
const driveKey = (id) => "/drive?id=" + encodeURIComponent(id);
const cached = new Set(), failed = new Set(), progress = new Map(), blobURLs = new Map();
let prefetching = false;

function paintDl(e, id) {
  e.className = "q-dl" + (cached.has(id) ? " ok" : "");
  e.textContent = cached.has(id) ? "✓ offline" : progress.has(id) ? `${progress.get(id)}%` : "";
}
const repaintDl = (id) => $$(`[data-dl="${id}"]`).forEach((e) => paintDl(e, id));

async function loadCachedIds() {
  if (!hasCache) return;
  try { (await (await caches.open(AUDIO_CACHE)).keys()).forEach((r) => { const id = new URL(r.url).searchParams.get("id"); if (id) cached.add(id); }); } catch {}
}
async function cachedURL(id) {
  try { const r = await (await caches.open(AUDIO_CACHE)).match(driveKey(id)); if (r) return URL.createObjectURL(await r.blob()); } catch {}
  return null;
}
// songs the encore app on this computer already holds: taken from there instead of drive
const onApp = new Set();
const appURL = (id) => appBase() + "/api/audio/" + encodeURIComponent(id);
async function loadAppIds(timeout = 3000) {
  if (appBase() == null) return;
  try {
    const r = await fetch(appBase() + "/api/audio", { signal: AbortSignal.timeout(timeout) });
    if (r.ok) (await r.json()).forEach((id) => onApp.add(id));
  } catch {}
}
// hand a copy to the app so the other page doesn't download it again
async function giveToApp(id, blob) {
  if (appBase() == null || onApp.has(id)) return;
  try {
    const r = await fetch(appURL(id), { method: "PUT", headers: { "content-type": blob.type || "application/octet-stream" }, body: blob });
    if (r.ok) onApp.add(id);
  } catch {}
}
// songs cached here before the app had them: pass them over one by one in the background
async function shareCached() {
  if (appBase() == null || !hasCache) return;
  for (const id of [...cached]) {
    if (onApp.has(id)) continue;
    try { const r = await (await caches.open(AUDIO_CACHE)).match(driveKey(id)); if (r) await giveToApp(id, await r.blob()); } catch {}
  }
}
// one download per song, even when the player and the background fetch ask at the same time
const inFlight = new Map();
function cacheDrive(id) {
  if (cached.has(id)) return Promise.resolve(true);
  if (!inFlight.has(id)) inFlight.set(id, downloadDrive(id).finally(() => inFlight.delete(id)));
  return inFlight.get(id);
}
async function downloadDrive(id) {
  const fromApp = onApp.has(id);
  try {
    let r = fromApp ? await fetch(appURL(id)).catch(() => null) : null;
    if (!r?.ok) r = await fetch(driveKey(id));
    const type = r.headers.get("content-type") || "";
    if (!r.ok || !/^(audio|video)\/|octet-stream/.test(type)) return false;
    const total = +r.headers.get("content-length") || 0, reader = r.body.getReader(), chunks = [];
    let got = 0, shown = -1;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value); got += value.length;
      const pct = total ? Math.floor((got / total) * 100) : 0;
      if (pct !== shown) { shown = pct; progress.set(id, pct); repaintDl(id); }
    }
    const blob = new Blob(chunks, { type });
    await (await caches.open(AUDIO_CACHE)).put(driveKey(id), new Response(blob, { headers: { "Content-Type": type, "Content-Length": String(blob.size) } }));
    cached.add(id);
    giveToApp(id, blob);
    return true;
  } catch { return false; }
  finally { progress.delete(id); repaintDl(id); }
}
async function prefetchAll() {
  if (!hasCache || prefetching || navigator.connection?.saveData) return;
  prefetching = true;
  try {
    await loadAppIds(); // see what the app already holds before asking drive
    for (;;) {
      const start = Math.max(idx, 0), order = [...list.slice(start), ...list.slice(0, start)];
      const it = order.find((x) => x.type === "drive" && !cached.has(x.id) && !failed.has(x.id));
      if (!it) break;
      if (await cacheDrive(it.id)) { prepareAround(); renderQueue(); } else failed.add(it.id);
    }
    await shareCached();
  } finally { prefetching = false; }
}
async function pruneCache() {
  if (!hasCache) return;
  const keep = new Set(list.filter((x) => x.type === "drive").map((x) => x.id));
  // forget levels of songs that left the playlist
  Object.keys(loud).forEach((id) => { if (!keep.has(id)) delete loud[id]; });
  store.set("lp-loud", loud);
  try {
    const c = await caches.open(AUDIO_CACHE);
    for (const r of await c.keys()) {
      const id = new URL(r.url).searchParams.get("id");
      if (!keep.has(id)) { await c.delete(r); cached.delete(id); }
    }
  } catch {}
}
// keep ready-to-play copies of the current, next and previous songs so playback starts instantly,
// even from the lock screen.
async function prepareAround() {
  if (!hasCache || idx < 0 || !list.length) return;
  const n = list.length;
  const want = new Set([idx, (idx + 1) % n, (idx - 1 + n) % n].map((i) => list[i]).filter((x) => x?.type === "drive").map((x) => x.id));
  for (const [id, u] of blobURLs) if (!want.has(id) && audio.src !== u) { URL.revokeObjectURL(u); blobURLs.delete(id); }
  for (const id of want) if (cached.has(id) && !blobURLs.has(id)) { const u = await cachedURL(id); if (u) blobURLs.set(id, u); }
  // measure the current and neighbouring songs so their gain is ready when they start
  if (norm) for (const id of want) if (cached.has(id)) await measure(id);
}

// ------------------------------------------------------------------ lock-screen & headphone controls
function updateMediaSession() {
  if (!("mediaSession" in navigator) || !cur) return;
  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: cur.title || "Encore", artist: cur.type === "yt" ? "YouTube" : "Google Drive",
      album: `Playlist · ${idx + 1}/${list.length}`, artwork: [{ src: "/icon-512.png", sizes: "512x512", type: "image/png" }],
    });
    navigator.mediaSession.playbackState = isPlaying() ? "playing" : "paused";
  } catch {}
}
if ("mediaSession" in navigator) {
  const h = {
    play: () => P.play(), pause: () => P.pause(), stop, nexttrack: () => nextTrack(false), previoustrack: prevTrack,
    seekbackward: (d) => P.seek(P.time() - (d.seekOffset || 10)), seekforward: (d) => P.seek(P.time() + (d.seekOffset || 10)),
    seekto: (d) => P.seek(d.seekTime),
  };
  for (const [k, fn] of Object.entries(h)) { try { navigator.mediaSession.setActionHandler(k, fn); } catch {} }
}

// the online site or the app changed the playlist: take it over, the song that is playing keeps playing
onRemote((keys) => {
  if (!keys.some((k) => k.startsWith("lp-"))) return;
  const playing = cur && `${cur.type}:${cur.id}`;
  list = store.get("lp-playlist", []);
  repeat = store.get("lp-repeat", "off");
  shuffle = store.get("lp-shuffle", false);
  autonext = store.get("lp-autonext", true);
  paintModes();
  setName(store.get("lp-name", null));
  const same = list.findIndex((x) => `${x.type}:${x.id}` === playing);
  if (same >= 0) idx = same;
  else {
    idx = Math.min(Math.max(store.get("lp-index", 0), 0), list.length - 1);
    if (!list.length) showEmptyPlayer();
    else if (!isPlaying()) playIndex(idx, false);
  }
  list.forEach(fetchTitle);
  renderQueue();
});

// ------------------------------------------------------------------ boot
export async function initPlaylist() {
  paintModes(); applyRate(rate); setName(store.get("lp-name", null)); renderQueue();
  list.forEach(fetchTitle);
  await loadCachedIds();
  await loadAppIds(1500); // so the first song can come from the app
  if (list.length) { idx = Math.min(Math.max(idx, 0), list.length - 1); await prepareAround(); playIndex(idx, false); }
  else showEmptyPlayer();
  renderQueue(); pruneCache(); prefetchAll();
  try { navigator.storage?.persist?.(); } catch {}
  server.onChange(() => renderQueue());
  // just connected to the encore app: take its songs and give it the ones cached here
  addEventListener("encore-connected", () => { prefetchAll(); loadSections(cur); });
}
