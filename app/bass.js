// bass section (delve): separate the stems, transcribe notes, detect chords. runs in the encore app (backend/).

import { $, $$, el, icon, setIcon, store, fmtTime, textOverflows, fmtDate, fmtAgo, parseLink, toast, confirmDialog, showMenu, server, media, router, onKeys, api } from "./core.js";
import { pitchNode, fmtSemis, clampSemis, PITCH_LATENCY } from "./pitch.js";
import { renderGetApp } from "./getapp.js";
import { MODE_LABEL, pickMode, ensureAi } from "./aimode.js";
import { addToPlaylist } from "./playlist.js";
import { buildScore, keyAt, keysLabel, loadVex, renderStaff, renderNumbers, toMusicXml } from "./score.js";

const SHARP = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const FLAT = ["C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B"];
const TUNINGS = {
  4: { names: ["E", "A", "D", "G"], open: [28, 33, 38, 43] },
  5: { names: ["B", "E", "A", "D", "G"], open: [23, 28, 33, 38, 43] },
};
const STRING_COLORS = ["#ff8f6b", "#f5b83d", "#5cc97b", "#3fb9d6", "#a67cf5"];
const MAX_FRET = 20;
const ACTIVE = ["queued", "downloading", "waiting", "running"];
const SRC = { file: "File", youtube: "YouTube", gdrive: "Google Drive" };
const fmtEta = (s) => {
  if (s < 60) return "<1 mnt";
  const m = Math.round(s / 60);
  if (m < 60) return `~${m} mnt`;
  // above an hour, show hours + minutes
  const h = Math.floor(m / 60), r = m % 60;
  return r ? `~${h} jam ${r} mnt` : `~${h} jam`;
};

// ------------------------------------------------------------------ theme colors for canvas drawing
let theme = {};
function readTheme() {
  const cs = getComputedStyle(document.documentElement);
  const v = (n) => cs.getPropertyValue(n).trim();
  theme = { bass: v("--bass"), ink: v("--ink"), muted: v("--muted"), surface: v("--surface"), line: v("--line"), loop: v("--loop") };
}
const alpha = (hex, a) => {
  const h = hex.replace("#", "");
  const n = parseInt(h.length === 3 ? h.split("").map((c) => c + c).join("") : h, 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
};
readTheme();
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => { readTheme(); player.redrawBase(); sparkCache.clear(); renderLibrary(); });

// ------------------------------------------------------------------ add: smart link input, file picker, drag & drop
const urlInput = $("#urlInput");
urlInput.addEventListener("input", () => {
  const v = urlInput.value.trim();
  const d = $("#detect");
  if (!v) { d.hidden = true; return; }
  const p = parseLink(v);
  const blocked = p?.type === "yt" && !server.youtube;
  d.hidden = false;
  d.classList.toggle("bad", !p || blocked);
  d.textContent = !p ? "Link tidak dikenali" : blocked ? "YouTube: upload file audionya" : p.type === "yt" ? "YouTube" : "Google Drive";
});

$("#jobForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const v = urlInput.value.trim();
  if (!v) { urlInput.focus(); return; }
  const p = parseLink(v);
  if (!p) { toast(server.youtube ? "Link tidak dikenali. Pakai link YouTube atau Google Drive." : "Link tidak dikenali. Pakai link Google Drive atau upload file.", { error: true }); return; }
  if (await submitLink(v)) { urlInput.value = ""; $("#detect").hidden = true; }
});

$("#fileInput").addEventListener("change", (e) => {
  const f = e.target.files[0];
  if (f) uploadFile(f);
  e.target.value = "";
});

// drag a file anywhere on the bass page
let dragDepth = 0;
const isBassHome = () => router.current === "bass" && server.bass && server.analysis;
window.addEventListener("dragenter", (e) => {
  if (!isBassHome() || !e.dataTransfer?.types.includes("Files")) return;
  dragDepth++;
  $("#dropzone").hidden = false;
});
window.addEventListener("dragleave", () => { if (--dragDepth <= 0) { dragDepth = 0; $("#dropzone").hidden = true; } });
window.addEventListener("dragover", (e) => { if (isBassHome()) e.preventDefault(); });
window.addEventListener("drop", (e) => {
  if (!isBassHome()) return;
  e.preventDefault();
  dragDepth = 0;
  $("#dropzone").hidden = true;
  const f = e.dataTransfer.files[0];
  if (f) uploadFile(f);
});

// stem / midi file of a finished song, served by the app
const fileUrl = (id, name) => `/api/jobs/${id}/files/${encodeURIComponent(name)}`;

// create a job for a link; the app returns the existing one for a known file
export async function submitLink(url, title) {
  if (!server.bass) {
    toast("Breakdown jalan di Encore App, gratis untuk Mac, Windows, dan Linux.", { action: "Download", onAction: () => router.go("#/breakdown") });
    return false;
  }
  const p = parseLink(url);
  if (!p) return false;
  if (p.type === "yt" && !server.youtube) {
    toast("Link YouTube belum bisa diproses. Upload file audionya atau pakai link Google Drive.", { error: true, ms: 7000 });
    return false;
  }
  // ask the mode for this song only
  const mode = await pickMode(title || url);
  if (!mode) return false;
  const fd = new FormData();
  fd.append("kind", p.type === "yt" ? "youtube" : "gdrive");
  fd.append("url", url);
  fd.append("mode", mode);
  try {
    const job = await api("/api/jobs", { method: "POST", body: fd });
    if (job.existing && job.status === "done") {
      toast(`“${job.title}” sudah pernah dianalisis`, { action: "Buka", onAction: () => router.go(`#/breakdown/${job.id}`) });
    } else if (job.existing && job.status === "pending") {
      toast("Lagu ini sudah ada di antrian, tinggal klik Mulai", { action: "Lihat", onAction: () => router.go("#/breakdown") });
    } else if (job.existing) {
      toast("Lagu ini sudah ada di antrian", { action: "Lihat", onAction: () => router.go("#/breakdown") });
    } else {
      toast(`Masuk antrian Breakdown${title ? `: ${title}` : ""}${job.status === "pending" ? ". Klik Mulai untuk memproses" : ""}`, { action: "Lihat", onAction: () => router.go("#/breakdown") });
    }
    poll();
    return true;
  } catch (ex) {
    toast(ex.message, { error: true });
    return false;
  }
}

async function uploadFile(file) {
  if (!/^(audio|video)\//.test(file.type) && !/\.(mp3|wav|flac|m4a|ogg|oga|aac|opus|webm|mp4)$/i.test(file.name)) {
    toast("Itu bukan file audio", { error: true });
    return;
  }
  // ask the mode for this song only
  const mode = await pickMode(file.name);
  if (!mode) return;
  const fd = new FormData();
  fd.append("kind", "file");
  fd.append("file", file);
  fd.append("mode", mode);
  try {
    const job = await api("/api/jobs", { method: "POST", body: fd });
    toast(`Masuk antrian: ${file.name}${job.status === "pending" ? ". Klik Mulai untuk memproses" : ""}`);
    poll();
  } catch (ex) {
    toast(ex.message, { error: true });
  }
}

// ------------------------------------------------------------------ queue + library
let jobs = [];
let pollTimer = null;
const known = new Map(); // id -> last status, to notice finished jobs

export async function poll() {
  clearTimeout(pollTimer);
  if (!server.bass) return;
  try { jobs = await api("/api/jobs"); } catch { pollTimer = setTimeout(poll, 5000); return; }
  for (const j of jobs) {
    const prev = known.get(j.id);
    if (prev && ACTIVE.includes(prev) && j.status === "done") {
      toast(`Selesai dianalisis: ${j.title}`, { action: "Buka", onAction: () => router.go(`#/breakdown/${j.id}`), ms: 10000 });
      sparkCache.delete(j.id);
    }
    known.set(j.id, j.status);
  }
  const active = jobs.filter((j) => ACTIVE.includes(j.status) || j.status === "pending").length;
  $("#navBadge").hidden = !active;
  $("#navBadge").textContent = active;
  if (router.current === "bass") { renderQueue(); renderLibrary(); }
  pollTimer = setTimeout(poll, active ? 1500 : 15000);
}

function renderQueue() {
  const rows = jobs.filter((j) => ACTIVE.includes(j.status) || j.status === "pending" || j.status === "error");
  const order = (j) => (j.status === "running" ? 0 : j.status === "error" ? 1e6 : j.status === "pending" ? 2e5 + j.created : j.position || 1e5);
  $("#queueSection").hidden = !rows.length;
  const pending = rows.filter((j) => j.status === "pending");
  $("#startAll").hidden = pending.length < 2;
  $("#startAll").onclick = () => startJobs(pending);
  $("#busyWarn").hidden = !rows.some((j) => ACTIVE.includes(j.status));
  $("#queueList").replaceChildren(...rows.sort((a, b) => order(a) - order(b)).map(queueRow));
}

async function startJobs(list) {
  // oldest first so the queue keeps the order they were added
  for (const j of [...list].sort((a, b) => a.created - b.created)) {
    try { await api(`/api/jobs/${j.id}/start`, { method: "POST" }); } catch (ex) { toast(ex.message, { error: true }); }
  }
  poll();
}

function ring(j) {
  const ns = "http://www.w3.org/2000/svg";
  const pct = Math.round((j.progress || 0) * 100);
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 42 42");
  svg.classList.add("job-ring", j.status);
  const c = 2 * Math.PI * 17;
  for (const cls of ["bg", "fg"]) {
    const circle = document.createElementNS(ns, "circle");
    circle.setAttribute("cx", 21); circle.setAttribute("cy", 21); circle.setAttribute("r", 17);
    circle.classList.add(cls);
    if (cls === "fg") { circle.style.strokeDasharray = c; circle.style.strokeDashoffset = c * (1 - (j.status === "error" ? 0 : pct / 100)); }
    svg.append(circle);
  }
  const t = document.createElementNS(ns, "text");
  t.setAttribute("x", 21); t.setAttribute("y", 24.5); t.setAttribute("text-anchor", "middle");
  t.textContent = j.status === "error" ? "!" : j.status === "pending" ? "–" : j.status === "running" || j.status === "downloading" ? `${pct}` : `#${j.position || "?"}`;
  svg.append(t);
  return svg;
}

function queueRow(j) {
  const li = el("li", `card job ${j.status}`);
  const main = el("div", "job-main");
  main.append(el("div", "job-title", j.title || j.url || "(tanpa judul)"));
  const sub = el("div", "job-sub");
  const pct = Math.round((j.progress || 0) * 100);
  sub.append(el("span", null, SRC[j.source_type] || ""));
  // which mode this song runs with
  const m = j.mode === "ai" ? "ai" : "classic";
  const mc = el("span", `job-mode ${m}`);
  mc.append(icon(m === "ai" ? "sparkle" : "bolt"), MODE_LABEL[m]);
  sub.append(mc);
  if (j.status === "running") sub.append(el("span", null, `${j.stage} · ${pct}%`), el("span", null, `selesai ${fmtEta(j.eta_sec || 0)}`));
  else if (j.status === "downloading") sub.append(el("span", null, `Mengunduh ${pct}%`));
  else if (j.status === "error") sub.append(el("span", "err", j.error || "gagal"));
  else if (j.status === "pending") sub.append(el("span", null, "Belum dimulai"));
  else sub.append(el("span", null, `Antrian #${j.position || "?"}`), el("span", null, `mulai ±${fmtEta(j.eta_sec || 0)}`));
  main.append(sub);
  const acts = el("div", "job-acts");
  if (j.status === "pending") {
    const go = el("button", "btn sm primary");
    go.type = "button"; go.append(icon("play"), "Mulai");
    go.onclick = () => startJobs([j]);
    acts.append(go);
  }
  if (j.status === "error") {
    const retry = el("button", "btn sm");
    retry.type = "button"; retry.append(icon("refresh"), "Coba lagi");
    retry.onclick = async () => { try { await api(`/api/jobs/${j.id}/retry`, { method: "POST" }); } catch (ex) { toast(ex.message, { error: true }); } poll(); };
    acts.append(retry);
  }
  const x = el("button", "icon-btn");
  x.type = "button"; x.title = j.status === "error" || j.status === "pending" ? "Hapus" : "Batalkan"; x.append(icon(j.status === "error" || j.status === "pending" ? "trash" : "x"));
  x.onclick = async () => {
    const ok = await confirmDialog(j.status === "error" || j.status === "pending" ? "Hapus dari antrian?" : "Batalkan proses ini?", j.title || j.url, { ok: j.status === "error" || j.status === "pending" ? "Hapus" : "Batalkan", danger: true });
    if (!ok) return;
    await api(`/api/jobs/${j.id}`, { method: "DELETE" });
    poll();
  };
  acts.append(x);
  li.append(ring(j), main, acts);
  return li;
}

$("#libSearch").addEventListener("input", () => renderLibrary());

function renderLibrary() {
  const q = $("#libSearch").value.trim().toLowerCase();
  const done = jobs.filter((j) => j.status === "done");
  const shown = done.filter((j) => !q || (j.title || "").toLowerCase().includes(q));
  $("#libCount").textContent = done.length ? `${done.length}` : "";
  $("#emptyLib").hidden = done.length > 0;
  $("#jobList").replaceChildren(...shown.map(songCard));
  if (done.length && !shown.length) $("#jobList").append(el("p", "tool-hint", `Tidak ada lagu yang cocok dengan “${q}”.`));
}

function songCard(j) {
  const card = el("article", "card song-card");
  card.tabIndex = 0;
  card.setAttribute("role", "link");
  const spark = el("canvas", "spark");
  drawSpark(spark, j.id);
  const meta = el("div", "meta");
  const key = el("span", "chip key", j.key_label || j.key || "?");
  key.title = key.textContent;
  meta.append(key, el("span", "chip", `${Math.round(j.bpm || 0)} BPM`), el("span", "chip", fmtTime(j.duration)));
  if (j.result_mode === "classic") { const c = el("span", "chip", "cepat"); c.title = "Dianalisis dengan mode cepat (tanpa AI)"; meta.append(c); }
  if (j.outdated) { const c = el("span", "chip warn", "versi lama"); c.title = "Dianalisis dengan algoritma lama. Analisis ulang untuk hasil terbaru."; meta.append(c); }
  card.append(spark, el("div", "t", j.title || "(tanpa judul)"), meta);
  if (j.analyzed_at) card.append(el("div", "when", `${SRC[j.source_type] || ""} · dianalisis ${fmtAgo(j.analyzed_at)}`));
  if (j.reanalyze_error) card.append(el("div", "warn-line", "Analisis ulang terakhir gagal, hasil lama dipakai"));
  const more = el("button", "icon-btn card-menu");
  more.type = "button"; more.title = "Lainnya"; more.append(icon("more"));
  more.onclick = (e) => { e.stopPropagation(); showMenu(more, songMenu(j)); };
  card.append(more);
  const open = () => router.go(`#/breakdown/${j.id}`);
  card.onclick = open;
  card.onkeydown = (e) => { if (e.key === "Enter") open(); };
  return card;
}

function songMenu(j) {
  return [
    j.url && { label: j.source_type === "gdrive" ? "Buka di Google Drive" : "Buka di YouTube", icon: "link", href: j.url },
    j.url && { label: "Putar di Playlist", icon: "list", onClick: () => addToPlaylist(j.url, j.title) },
    server.analysis && j.result_mode === "classic" && { label: "Analisis detail (AI)", icon: "sparkle", onClick: () => upgradeAi(j) },
    server.analysis && { label: "Analisis ulang", icon: "refresh", onClick: () => reanalyze(j) },
    server.analysis && { label: "Hapus dari Library", icon: "trash", danger: true, onClick: () => removeSong(j) },
  ];
}

async function reanalyze(j) {
  if (!(await confirmDialog("Analisis ulang?", `“${j.title}” akan diproses lagi dengan algoritma terbaru. Hasil lama tetap ada sampai yang baru selesai.`, { ok: "Analisis ulang" }))) return;
  try { await api(`/api/jobs/${j.id}/reanalyze`, { method: "POST" }); toast("Masuk antrian"); } catch (ex) { toast(ex.message, { error: true }); }
  poll();
}

// redo a classic result with the ai engine (installs it first if needed)
async function upgradeAi(j) {
  if (!(await ensureAi())) return;
  try {
    await api(`/api/jobs/${j.id}/reanalyze?mode=ai`, { method: "POST" });
    toast("Masuk antrian mode detail (AI). Hasil cepat tetap bisa dipakai sampai selesai.", { action: "Lihat", onAction: () => router.go("#/breakdown") });
  } catch (ex) { toast(ex.message, { error: true }); }
  poll();
}

async function removeSong(j) {
  if (!(await confirmDialog("Hapus dari Library?", `“${j.title}” dan hasil analisisnya akan dihapus.`, { ok: "Hapus", danger: true }))) return;
  await api(`/api/jobs/${j.id}`, { method: "DELETE" });
  if (router.current === "song") router.go("#/breakdown");
  poll();
}

// tiny bass contour per card, loaded lazily
const sparkCache = new Map();
const sparkObserver = new IntersectionObserver((entries) => {
  for (const e of entries) if (e.isIntersecting) { sparkObserver.unobserve(e.target); paintSpark(e.target); }
});
function drawSpark(canvas, id) { canvas.dataset.id = id; sparkObserver.observe(canvas); }
async function paintSpark(canvas) {
  const id = canvas.dataset.id;
  let notes = sparkCache.get(id);
  if (!notes) {
    try { notes = (await api(`/api/jobs/${id}/analysis`)).notes; } catch { return; }
    sparkCache.set(id, notes);
  }
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  canvas.width = w * dpr; canvas.height = h * dpr;
  const c = canvas.getContext("2d");
  c.scale(dpr, dpr);
  if (!notes.length) return;
  const end = notes.at(-1).t + notes.at(-1).d;
  const ms = notes.map((n) => n.midi);
  const lo = Math.min(...ms), hi = Math.max(...ms) + 1;
  c.fillStyle = alpha(theme.bass, 0.85);
  for (const n of notes) {
    const y = h - 5 - ((n.midi - lo) / (hi - lo)) * (h - 10);
    c.fillRect((n.t / end) * w, y, Math.max(1, (n.d / end) * w), 2);
  }
}

// ------------------------------------------------------------------ analysis helpers
function noteNamer(key) {
  const root = (key || "").split(" ")[0];
  const flatKeys = ["F major", "D minor", "G minor", "C minor", "F minor"];
  const names = root.includes("b") || flatKeys.includes(key) ? FLAT : SHARP;
  return (m) => names[((m % 12) + 12) % 12] + (Math.floor(m / 12) - 1);
}

// pick string/fret per note with a small viterbi minimizing hand movement
function assignFrets(notes, tuning) {
  const open = tuning.open;
  const cands = notes.map((n) => {
    let m = n.midi, shifted = 0;
    while (m < open[0]) { m += 12; shifted++; }
    while (m > open[open.length - 1] + MAX_FRET) { m -= 12; shifted--; }
    const out = [];
    open.forEach((o, s) => { const f = m - o; if (f >= 0 && f <= MAX_FRET) out.push({ s, f, shifted }); });
    return out;
  });
  if (!notes.length) return [];
  const local = (c) => 0.04 * c.f + (c.f > 12 ? 0.8 : 0);
  const move = (a, b, gap) => {
    if (a.f === 0 || b.f === 0) return 0.2 * Math.abs(a.s - b.s);
    const d = Math.abs(a.f - b.f);
    const k = gap > 1 ? 0.3 : 1;
    return k * (0.25 * d + Math.max(0, d - 3)) + 0.15 * Math.abs(a.s - b.s);
  };
  let cost = cands[0].map(local);
  const back = [cands[0].map(() => -1)];
  for (let i = 1; i < notes.length; i++) {
    const gap = notes[i].t - (notes[i - 1].t + notes[i - 1].d);
    const next = [], bp = [];
    for (const c of cands[i]) {
      let best = Infinity, arg = 0;
      cands[i - 1].forEach((p, j) => { const v = cost[j] + move(p, c, gap); if (v < best) { best = v; arg = j; } });
      next.push(best + local(c));
      bp.push(arg);
    }
    cost = next;
    back.push(bp);
  }
  const out = new Array(notes.length);
  let k = cost.indexOf(Math.min(...cost));
  for (let i = notes.length - 1; i >= 0; i--) { out[i] = cands[i][k]; k = back[i][k]; }
  return out;
}

function chordRoot(label) {
  const m = /^([A-G][#b]?)/.exec(label || "");
  if (!m) return null;
  const i = SHARP.indexOf(m[1]);
  return i >= 0 ? i : FLAT.indexOf(m[1]);
}
const chordColor = (label, a) => {
  const r = chordRoot(label);
  return r == null ? alpha(theme.muted, a) : `hsla(${(r * 30 + 190) % 360},62%,52%,${a})`;
};

// first index with t >= x (items sorted by .t)
function lowerBound(arr, x, key = (o) => o.t) {
  let lo = 0, hi = arr.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (key(arr[mid]) < x) lo = mid + 1; else hi = mid; }
  return lo;
}

// ------------------------------------------------------------------ song player
const player = (() => {
  const roll = $("#roll"), ov = $("#overview");
  // one <audio> per stem; the first one is the clock the others follow
  let tracks = []; // [{name, el, vol, muted, solo, src}]
  const master = () => tracks[0]?.el;
  const ctx = roll.getContext("2d"), octx = ov.getContext("2d");

  let song = null, jobId = null;
  let frets = [], nameOf = (m) => String(m);
  let tuning = TUNINGS[4];
  let part = "bass"; // stack | drums | bass | vocals | piano | guitar
  let sub = "graph"; // graph | tab (bass and guitar)
  let windowSec = 7;
  let speed = 1;
  let pitch = 0; // semitones, saved per song
  let actx = null, shifter = null, shifterLoading = false;
  let loop = { a: null, b: null, on: false };
  let raf = 0;
  let dragSel = null;
  let pitchLo = 28, pitchHi = 55;
  let barOf = [];
  const notesOf = (p = part) =>
    p === "score" ? notesOf(scorePart) : p === "vocals" || p === "piano" || p === "guitar" ? song[p]?.notes || [] : p === "bass" || p === "stack" ? song.notes : [];
  let guitarFrets = [], drumGrid = null, fillers = {};

  // smooth clock: interpolate between coarse currentTime updates
  let clock = { audio: 0, perf: 0 };
  const now = () => {
    const m = master();
    if (!m) return 0;
    if (m.paused) return m.currentTime;
    const t = m.currentTime, p = performance.now();
    if (t !== clock.audio) clock = { audio: t, perf: p };
    // while shifting, what you hear runs a little behind the element
    const lag = shifter && pitch ? (PITCH_LATENCY / actx.sampleRate) * m.playbackRate : 0;
    return Math.max(0, clock.audio + ((p - clock.perf) / 1000) * m.playbackRate - lag);
  };

  function load(id, data) {
    stop();
    jobId = id;
    song = data;
    nameOf = noteNamer(data.key);
    // notes below low e need a 5-string; a manual choice per song wins
    const low = data.notes.filter((n) => n.midi < TUNINGS[4].open[0]).length;
    const auto = low >= 3 && low >= data.notes.length * 0.01 ? 5 : 4;
    let saved = null;
    try { saved = localStorage.getItem(`delve.strings.${id}`); } catch {}
    const strings = saved === "4" || saved === "5" ? Number(saved) : auto;
    tuning = TUNINGS[strings];
    $("#tuningSel").value = String(strings);
    $("#tuningHint").textContent = !saved && auto === 5 ? `otomatis (${low} not di bawah E)` : "";
    frets = assignFrets(data.notes, tuning);
    guitarFrets = assignGuitarFrets(data.guitar?.notes || []);
    // bar number per beat index: from detected downbeats, else assume 4/4 from the first beat
    barOf = data.beats.map((_, i) => (i % 4 === 0 ? i / 4 + 1 : 0));
    if (data.downbeats?.length) {
      barOf = data.beats.map(() => 0);
      data.downbeats.forEach((d, k) => {
        const i = lowerBound(data.beats, d - 0.05, (b) => b);
        if (i < data.beats.length && Math.abs(data.beats[i] - d) < 0.05) barOf[i] = k + 1;
      });
    }
    drumGrid = buildDrumGrid(data);
    transpose = 0;
    try { transpose = Number(localStorage.getItem(`delve.transpose.${id}`)) || 0; } catch {}
    pitch = 0;
    try { pitch = clampSemis(Number(localStorage.getItem(`delve.pitch.${id}`)) || 0); } catch {}
    sheet = null;
    score = null;
    if (!(data.vocals?.notes?.length) && scorePart === "vocals") scorePart = "bass";
    fillers = findFillers(data.layers);
    loop = { a: null, b: null, on: false };
    syncLoopUi();
    buildTracks(id, data.audio || { bass: "bass.mp3", rest: "rest.mp3" });
    applyPitch();
    setPart(hasPart(store.get("bass-part", "bass")) ? store.get("bass-part", "bass") : "bass", true);
    lastNowKey = "";
    requestAnimationFrame(() => { resize(); raf = requestAnimationFrame(tick); });
  }

  // ---------------- stems + mixer
  const STEM_INFO = {
    drums: { label: "Drum", color: "#f5b83d" },
    bass: { label: "Bass", color: "var(--bass)" },
    vocals: { label: "Vokal", color: "#e86fa8" },
    guitar: { label: "Gitar", color: "#5cc97b" },
    piano: { label: "Piano", color: "#a67cf5" },
    other: { label: "Lainnya", color: "#8c95a5" },
    rest: { label: "Band", color: "#8c8cf5" },
  };
  const ORDER = ["drums", "bass", "vocals", "guitar", "piano", "other", "rest"];

  function buildTracks(id, audioMap) {
    const box = $("#stemAudio");
    tracks.forEach((t) => t.src?.disconnect());
    box.replaceChildren();
    const prefs = store.get("bass-mixer", {});
    tracks = ORDER.filter((n) => audioMap[n]).map((name) => {
      const a = new Audio(song.audioUrls[name]);
      a.preload = "auto";
      a.preservesPitch = true;
      a.playbackRate = speed;
      box.append(a);
      return { name, el: a, vol: prefs[name] ?? (name === "bass" ? 1 : 0.85), muted: false, solo: false };
    });
    routeTracks();
    applyMix();
    renderMixer();
  }

  // ---------------- pitch: every stem goes through one shifter once it's first used
  // element volume and mute still apply before the shifter, so the mixer keeps working
  function routeTracks() {
    if (!shifter) return;
    for (const t of tracks) if (!t.src) { t.src = actx.createMediaElementSource(t.el); t.src.connect(shifter); }
  }
  async function applyPitch() {
    paintPitch();
    if (shifter) { shifter.setSemitones(pitch); return; }
    if (!pitch || shifterLoading) return;
    shifterLoading = true;
    try {
      actx ||= new (window.AudioContext || window.webkitAudioContext)();
      const node = await pitchNode(actx);
      if (!node) { toast("Browser ini belum bisa mengubah nada", { ms: 2500 }); return; }
      node.connect(actx.destination);
      shifter = node;
      shifter.setSemitones(pitch);
      // routed elements go silent while the context is suspended: wake it if already playing
      if (master() && !master().paused) actx.resume().catch(() => {});
      routeTracks();
    } finally { shifterLoading = false; }
  }
  function setPitch(v) {
    pitch = clampSemis(v);
    try { localStorage.setItem(`delve.pitch.${jobId}`, String(pitch)); } catch {}
    if (actx?.state === "suspended") actx.resume().catch(() => {});
    applyPitch();
  }
  function paintPitch() {
    $("#bPitchVal").textContent = fmtSemis(pitch);
    $("#bPitchVal").classList.toggle("active", !!pitch);
  }

  function applyMix() {
    const soloing = tracks.some((t) => t.solo);
    for (const t of tracks) {
      t.el.volume = t.vol;
      t.el.muted = soloing ? !t.solo : t.muted;
    }
  }

  function renderMixer() {
    const strips = tracks.map((t, i) => {
      const info = STEM_INFO[t.name];
      const strip = el("div", "strip" + (audible(t.name) ? "" : " silent"));
      const name = el("button", "chan" + (t.muted ? " muted" : ""));
      name.type = "button";
      name.title = t.muted ? `${info.label} di-mute. Klik untuk menyalakan lagi (${i + 1})` : `Klik untuk mute ${info.label} (${i + 1})`;
      name.setAttribute("aria-pressed", String(t.muted));
      const dot = el("span", "dot");
      dot.style.background = info.color;
      name.append(dot, info.label);
      name.onclick = () => { t.muted = !t.muted; applyMix(); renderMixer(); };
      const solo = el("button", "solo" + (t.solo ? " on" : ""), "Solo");
      solo.type = "button";
      solo.title = t.solo ? `Matikan solo ${info.label}` : `Solo: dengar ${info.label} saja`;
      solo.setAttribute("aria-pressed", String(t.solo));
      solo.onclick = () => { t.solo = !t.solo; applyMix(); renderMixer(); };
      const vol = el("input");
      vol.type = "range"; vol.min = 0; vol.max = 1; vol.step = 0.01; vol.value = t.vol;
      vol.setAttribute("aria-label", `Volume ${info.label}`);
      vol.oninput = () => {
        t.vol = +vol.value;
        applyMix();
        store.set("bass-mixer", { ...store.get("bass-mixer", {}), [t.name]: t.vol });
      };
      strip.append(name, solo, vol);
      return strip;
    });
    $("#mixer").replaceChildren(...strips);
  }

  // ---------------- export: render the chosen stems to one mp3
  let exporting = false;
  function exportOptions() {
    if (!tracks.length) return [];
    const heard = tracks.filter((t) => audible(t.name));
    const label = (list) => list.map((t) => STEM_INFO[t.name].label).join(", ");
    const opts = [];
    if (heard.length && heard.length < tracks.length) {
      const off = tracks.filter((t) => !audible(t.name));
      opts.push({ label: `Sesuai mixer (tanpa ${label(off)})`, list: heard, suffix: `tanpa ${label(off).toLowerCase()}` });
    }
    for (const t of tracks) {
      const rest = tracks.filter((x) => x !== t);
      opts.push({ label: `Tanpa ${STEM_INFO[t.name].label}`, list: rest, suffix: `tanpa ${STEM_INFO[t.name].label.toLowerCase()}` });
    }
    for (const t of tracks) opts.push({ label: `${STEM_INFO[t.name].label} saja`, list: [t], suffix: STEM_INFO[t.name].label.toLowerCase() });
    return opts;
  }

  async function exportMix(list, suffix) {
    if (exporting) return toast("Export sebelumnya masih jalan");
    exporting = true;
    const done = toast("Menyiapkan file audio…", { ms: 600000 });
    try {
      const SR = 44100;
      const decoder = new OfflineAudioContext(2, SR, SR);
      const bufs = await Promise.all(list.map(async (t) => {
        const bytes = await (await fetch(song.audioUrls[t.name])).arrayBuffer();
        return { buf: await decoder.decodeAudioData(bytes), vol: t.vol };
      }));
      const len = Math.max(...bufs.map((b) => b.buf.length));
      const ctx = new OfflineAudioContext(2, len, SR);
      for (const { buf, vol } of bufs) {
        const src = ctx.createBufferSource(), g = ctx.createGain();
        src.buffer = buf; g.gain.value = vol;
        src.connect(g).connect(ctx.destination);
        src.start();
      }
      const out = await ctx.startRendering();
      const bytes = await new Promise((resolve, reject) => {
        const w = new Worker(new URL("./export-worker.js", import.meta.url), { type: "module" });
        w.onmessage = ({ data }) => { w.terminate(); data.error ? reject(new Error(data.error)) : resolve(data.bytes); };
        w.onerror = (e) => { w.terminate(); reject(new Error(e.message || "encoder gagal dimuat")); };
        const left = out.getChannelData(0).slice(), right = out.getChannelData(1).slice();
        w.postMessage({ left, right, sampleRate: SR }, [left.buffer, right.buffer]);
      });
      const a = el("a");
      a.href = URL.createObjectURL(new Blob([bytes], { type: "audio/mpeg" }));
      a.download = `${(song.title || "lagu").replace(/[^\w\-. ]+/g, "_").trim().slice(0, 80) || "lagu"} - ${suffix}.mp3`;
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 60000);
      done();
      toast("File audio siap");
    } catch (ex) {
      done();
      toast(`Gagal export: ${ex.message}`, { error: true });
    } finally {
      exporting = false;
    }
  }

  function toggleMuteAt(i) {
    const t = tracks[i];
    if (!t) return;
    t.muted = !t.muted;
    applyMix();
    renderMixer();
    toast(`${STEM_INFO[t.name].label} ${t.muted ? "di-mute" : "aktif"}`, { ms: 1200 });
  }

  // ---------------- which part is shown
  const PART_LABEL = { stack: "Multitrack", drums: "Drum", bass: "Bass", vocals: "Vokal", piano: "Piano", guitar: "Gitar", chords: "Chord", score: "Not" };
  function hasPart(p) {
    if (!song) return false;
    if (p === "stack" || p === "bass") return true;
    if (p === "drums") return !!song.layers?.drums;
    if (p === "chords") return song.chords?.some((c) => c.label !== "N");
    if (p === "score") return !!(song.vocals?.notes?.length || song.notes?.length);
    return !!song[p]?.notes?.length;
  }

  function setPart(next, silent = false) {
    if (!hasPart(next)) {
      if (!silent) toast(`Lagu ini belum punya analisis ${PART_LABEL[next].toLowerCase()}. Klik Analisis ulang untuk menambahkannya.`, { ms: 4000 });
      return;
    }
    part = next;
    store.set("bass-part", part);
    $$(".part-switch button").forEach((b) => {
      b.classList.toggle("active", b.dataset.part === part);
      b.hidden = !hasPart(b.dataset.part);
    });
    const tabbable = part === "bass" || part === "guitar";
    $(".sub-switch").hidden = !tabbable;
    if (!tabbable) sub = "graph";
    $$(".sub-switch button").forEach((b) => b.classList.toggle("active", b.dataset.sub === sub));
    GUTTER = part === "stack" ? 84 : part === "drums" ? 56 : 46;
    $("#nowNoteLabel").textContent = { stack: "Not bass", drums: "Drum", bass: "Not bass", vocals: "Not vokal", piano: "Not piano", guitar: "Not gitar", chords: "", score: scorePart === "vocals" ? "Not vokal" : "Not bass" }[part];
    // chord sheet replaces the canvas; the note box has nothing to say there
    const isSheet = part === "chords", isScore = part === "score";
    $(".stage").hidden = isSheet || isScore;
    $("#chordSheet").hidden = !isSheet;
    $("#scoreSheet").hidden = !isScore;
    $("#bdNote").closest(".now-box").hidden = isSheet;
    if (isSheet) buildSheet();
    if (isScore) buildScoreView();
    $$(".dock .extra").forEach((g) => { if (g.querySelector("#tuningSel")) g.hidden = part !== "bass"; });
    // pitch range of a melodic part, at least 20 semitones
    const ms = notesOf().map((n) => n.midi);
    pitchLo = ms.length ? Math.min(...ms) - 2 : 26;
    pitchHi = ms.length ? Math.max(...ms) + 2 : 50;
    if (pitchHi - pitchLo < 20) {
      const pad = (20 - (pitchHi - pitchLo)) / 2;
      pitchLo = Math.floor(pitchLo - pad);
      pitchHi = Math.ceil(pitchHi + pad);
    }
    lastNowKey = "";
    drawOverviewBase();
    renderSections();
  }

  // ---------------- song parts (intro, verse, chorus, ...): a strip above the overview
  const secBox = $("#sections");
  let secIdx = -1;
  const parts = () => song?.sections || [];
  const partEnd = (i) => parts()[i + 1]?.t ?? song.duration;
  const partAt = (t) => lowerBound(parts(), t + 1e-6) - 1;
  function renderSections() {
    secIdx = -1;
    secBox.replaceChildren();
    secBox.hidden = !parts().length;
    const D = song.duration || 1;
    parts().forEach((p, i) => {
      const b = el("button", `sec sec-${p.kind}`, p.label);
      b.type = "button";
      b.title = `${p.label} · ${fmtTime(p.t)}–${fmtTime(partEnd(i))} (klik dua kali untuk loop)`;
      b.style.left = `${(p.t / D) * 100}%`;
      b.style.width = `${((partEnd(i) - p.t) / D) * 100}%`;
      // click jumps to the part, double click loops it
      b.onclick = () => seek(p.t);
      b.ondblclick = () => loopPart(i);
      b.dataset.full = p.label;
      secBox.append(b);
    });
    fitSections();
  }
  // narrow parts get a short label (chorus 2 -> c2, pre-chorus 1 -> pc1)
  const SHORT = { intro: "In", verse: "V", prechorus: "PC", chorus: "C", bridge: "Br", interlude: "Int", outro: "Out" };
  function fitSections() {
    parts().forEach((p, i) => {
      const b = secBox.children[i];
      if (!b) return;
      b.textContent = b.dataset.full;
      if (textOverflows(b)) b.textContent = SHORT[p.kind] + (p.label.match(/\d+$/)?.[0] || "");
    });
  }
  function loopPart(i) {
    if (i < 0 || !parts()[i]) return;
    loop = { a: parts()[i].t, b: partEnd(i), on: true };
    syncLoopUi();
    seek(loop.a);
  }
  // highlight the part that is playing
  function updateSections(t) {
    if (!parts().length) return;
    const i = partAt(t);
    if (i === secIdx) return;
    secBox.children[secIdx]?.classList.remove("playing");
    secBox.children[i]?.classList.add("playing");
    secIdx = i;
  }
  // previous / next part; "previous" restarts the current part when it is a few seconds in
  function jumpPart(dir) {
    if (!parts().length) return;
    const t = now(), i = partAt(t);
    const to = dir > 0 ? i + 1 : (i >= 0 && t - parts()[i].t > 2 ? i : i - 1);
    seek(to < 0 ? 0 : parts()[Math.min(to, parts().length - 1)].t);
  }

  function setSub(next) {
    if (next === "tab" && part !== "bass" && part !== "guitar") return;
    sub = next;
    $$(".sub-switch button").forEach((b) => b.classList.toggle("active", b.dataset.sub === sub));
    lastNowKey = "";
  }

  function stop() {
    cancelAnimationFrame(raf);
    tracks.forEach((t) => t.el.pause());
    setPlayIcon(false);
  }
  const pause = () => { tracks.forEach((t) => t.el.pause()); setPlayIcon(false); };
  media.register("bass", pause);

  function setPlayIcon(playing) { setIcon($("#bPlay"), playing ? "pause" : "play"); }

  async function toggle() {
    if (!song || !tracks.length) return;
    if (master().paused) {
      media.claim("bass");
      if (actx?.state === "suspended") actx.resume().catch(() => {});
      const t0 = master().currentTime;
      tracks.forEach((t) => { t.el.currentTime = t0; });
      try { await Promise.all(tracks.map((t) => t.el.play())); } catch {}
      setPlayIcon(true);
    } else pause();
  }

  function seek(t) {
    if (!song) return;
    t = Math.max(0, Math.min(song.duration - 0.05, t));
    tracks.forEach((x) => { x.el.currentTime = t; });
    clock = { audio: t, perf: performance.now() };
  }

  function tick() {
    raf = requestAnimationFrame(tick);
    if (!song) return;
    let t = now();
    const m = master();
    if (m && !m.paused) {
      // keep every stem locked to the first one
      for (const x of tracks.slice(1)) if (Math.abs(x.el.currentTime - m.currentTime) > 0.06) x.el.currentTime = m.currentTime;
      if (loop.on && loop.a != null && loop.b != null && t >= loop.b) { seek(loop.a); t = loop.a; }
    }
    if (m?.ended) setPlayIcon(false);
    // pixel ratio changes (window moved to another display) do not trigger the resize observer
    const dpr = window.devicePixelRatio || 1;
    if (Math.abs(roll.width - Math.round(roll.clientWidth * dpr)) > 1 || Math.abs(roll.height - Math.round(roll.clientHeight * dpr)) > 1) resize();
    if (part === "chords") updateSheet(t, m && !m.paused);
    else if (part === "score") updateScore(t, m && !m.paused);
    else draw(t);
    drawOverview(t);
    updateSections(t);
    updateNow(t);
  }

  // ---------------- drawing
  function resize() {
    const dpr = window.devicePixelRatio || 1;
    for (const c of [roll, ov]) {
      const r = c.getBoundingClientRect();
      c.width = Math.max(1, Math.round(r.width * dpr));
      c.height = Math.max(1, Math.round(r.height * dpr));
    }
    drawOverviewBase();
    fitSections();
  }
  new ResizeObserver(() => { if (song && router.current === "song") resize(); }).observe(roll);

  const CHORD_H = 36;
  let GUTTER = 46; // wider in multitrack for the lane names
  const view = (t) => {
    const W = roll.width / (window.devicePixelRatio || 1);
    const H = roll.height / (window.devicePixelRatio || 1);
    const t0 = t - windowSec * 0.25;
    const pps = (W - GUTTER) / windowSec;
    return { W, H, t0, t1: t0 + windowSec, pps, x: (s) => GUTTER + (s - t0) * pps };
  };
  const FONT = '"IBM Plex Sans", -apple-system, sans-serif';

  function draw(t) {
    const dpr = window.devicePixelRatio || 1;
    const v = view(t);
    const { W, H, x } = v;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const top = CHORD_H + 10, bottom = H - 12;

    if (loop.a != null && loop.b != null) {
      ctx.fillStyle = loop.on ? alpha(theme.loop, 0.12) : alpha(theme.muted, 0.07);
      ctx.fillRect(x(loop.a), 0, x(loop.b) - x(loop.a), H);
    }
    if (dragSel) {
      ctx.fillStyle = alpha(theme.loop, 0.18);
      ctx.fillRect(x(Math.min(dragSel.a, dragSel.b)), 0, Math.abs(x(dragSel.b) - x(dragSel.a)), H);
    }

    // beat grid with bar numbers
    const beats = song.beats;
    let bi = Math.max(0, lowerBound(beats, v.t0, (b) => b) - 1);
    ctx.font = `10px ${FONT}`;
    for (; bi < beats.length && beats[bi] <= v.t1; bi++) {
      const bx = x(beats[bi]);
      if (bx < GUTTER) continue;
      const bar = barOf[bi] > 0;
      ctx.strokeStyle = alpha(theme.muted, bar ? 0.3 : 0.1);
      ctx.beginPath(); ctx.moveTo(bx, CHORD_H); ctx.lineTo(bx, H); ctx.stroke();
      if (bar) { ctx.fillStyle = alpha(theme.muted, 0.75); ctx.fillText(String(barOf[bi]), bx + 3, CHORD_H + 12); }
    }

    drawChords(v, t);
    if (part === "stack") drawStack(v, t, top, bottom);
    else if (part === "drums") drawDrumGrid(v, t, top, bottom);
    else if (part === "bass" && sub === "tab") drawTab(v, t, top, bottom);
    else if (part === "guitar" && sub === "tab") drawGuitarTab(v, t, top, bottom);
    else if (part === "piano" || part === "guitar") drawRoll(v, t, top, bottom);
    else drawGraph(v, t, top, bottom);
    ctx.restore();

    const px = x(t);
    ctx.strokeStyle = alpha(theme.ink, 0.5);
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(px, 0); ctx.lineTo(px, H); ctx.stroke();
    ctx.lineWidth = 1;
  }

  function drawChords(v, t) {
    const { x, W } = v;
    const ch = song.chords;
    let i = Math.max(0, lowerBound(ch, v.t0) - 1);
    ctx.font = `600 13px ${FONT}`;
    ctx.textBaseline = "middle";
    for (; i < ch.length && ch[i].t <= v.t1; i++) {
      const c = ch[i];
      const x0 = Math.max(GUTTER, x(c.t)), x1 = Math.min(W, x(c.t + c.d));
      if (x1 <= x0) continue;
      const active = t >= c.t && t < c.t + c.d;
      ctx.fillStyle = chordColor(c.label, active ? 0.4 : 0.16);
      roundRect(x0 + 1, 5, x1 - x0 - 2, CHORD_H - 10, 7);
      ctx.fill();
      if (c.label !== "N" && x1 - x0 > 22) {
        ctx.fillStyle = active ? theme.ink : alpha(theme.ink, 0.7);
        ctx.fillText(c.label, x0 + 8, CHORD_H / 2);
      }
    }
    ctx.textBaseline = "alphabetic";
  }

  // sung pitch as a continuous line (vibrato, scoops), drawn under the notes
  function drawContour(v, y) {
    const c = song.vocals?.contour;
    if (!c?.midi?.length) return;
    const i0 = Math.max(0, Math.floor((v.t0 - c.t0) / c.step));
    const i1 = Math.min(c.midi.length - 1, Math.ceil((v.t1 - c.t0) / c.step));
    ctx.strokeStyle = alpha(theme.bass, 0.75);
    ctx.lineWidth = 2;
    ctx.lineJoin = "round";
    ctx.beginPath();
    let pen = false;
    for (let i = i0; i <= i1; i++) {
      const m = c.midi[i];
      if (m == null) { pen = false; continue; }
      const px = v.x(c.t0 + i * c.step), py = y(m);
      if (pen) ctx.lineTo(px, py); else ctx.moveTo(px, py);
      pen = true;
    }
    ctx.stroke();
    ctx.lineWidth = 1;
  }

  function visibleNotes(v) {
    const notes = notesOf();
    let i = lowerBound(notes, v.t0 - 4);
    const out = [];
    for (; i < notes.length && notes[i].t <= v.t1; i++) if (notes[i].t + notes[i].d >= v.t0) out.push(i);
    return out;
  }

  function drawGraph(v, t, top, bottom) {
    const { x, W } = v;
    const y = (m) => bottom - ((m - pitchLo) / (pitchHi - pitchLo)) * (bottom - top);
    const rowH = (bottom - top) / (pitchHi - pitchLo);
    ctx.font = `10px ${FONT}`;
    for (let m = Math.ceil(pitchLo); m <= pitchHi; m++) {
      const yy = y(m);
      const isOpen = part === "bass" && tuning.open.includes(m), isC = m % 12 === 0;
      ctx.strokeStyle = isOpen ? alpha(theme.bass, 0.22) : alpha(theme.muted, isC ? 0.18 : 0.06);
      ctx.beginPath(); ctx.moveTo(GUTTER, yy); ctx.lineTo(W, yy); ctx.stroke();
      if (isOpen || isC || rowH > 11) {
        ctx.fillStyle = isOpen ? theme.bass : alpha(theme.muted, 0.8);
        ctx.fillText(nameOf(m), 8, yy + 3);
      }
    }
    clipNotes(v);
    const idx = visibleNotes(v);
    const notes = notesOf();
    if (part === "vocals") drawContour(v, y);
    ctx.strokeStyle = alpha(theme.ink, part === "vocals" ? 0.12 : 0.35);
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    idx.forEach((i, k) => {
      const n = notes[i];
      const xs = x(n.t), xe = x(n.t + n.d), yy = y(n.midi);
      if (k === 0) ctx.moveTo(xs, yy); else ctx.lineTo(xs, yy);
      ctx.lineTo(xe, yy);
    });
    ctx.stroke();
    const showLabels = idx.length && v.pps * 0.12 > 14;
    ctx.font = `600 11px ${FONT}`;
    ctx.textAlign = "center";
    for (const i of idx) {
      const n = notes[i];
      const xs = x(n.t), yy = y(n.midi);
      const active = t >= n.t && t < n.t + n.d;
      const past = n.t + n.d < t;
      const r = active ? 11 : 4.5 + 3 * (n.v ?? 0.7);
      if (active) { ctx.fillStyle = alpha(theme.bass, 0.25); ctx.beginPath(); ctx.arc(xs, yy, r + 7, 0, Math.PI * 2); ctx.fill(); }
      ctx.fillStyle = past ? alpha(theme.bass, 0.5) : theme.bass;
      ctx.beginPath(); ctx.arc(xs, yy, r, 0, Math.PI * 2); ctx.fill();
      if (showLabels || active) {
        ctx.fillStyle = active ? theme.ink : alpha(theme.ink, 0.65);
        ctx.fillText(nameOf(n.midi), xs, yy - r - 5);
      }
    }
    ctx.textAlign = "left";
    ctx.lineWidth = 1;
  }

  function drawTab(v, t, top, bottom) {
    const { x, W } = v;
    const nStr = tuning.open.length;
    const gap = (bottom - top) / nStr;
    const sy = (s) => bottom - gap * (s + 0.5); // low string at the bottom
    ctx.font = `600 12px ${FONT}`;
    for (let s = 0; s < nStr; s++) {
      ctx.strokeStyle = alpha(theme.muted, 0.4);
      ctx.lineWidth = 1 + (nStr - s) * 0.35;
      ctx.beginPath(); ctx.moveTo(GUTTER, sy(s)); ctx.lineTo(W, sy(s)); ctx.stroke();
      ctx.fillStyle = STRING_COLORS[s + (5 - nStr)];
      ctx.fillText(tuning.names[s], 18, sy(s) + 4);
    }
    ctx.lineWidth = 1;
    clipNotes(v);
    const notes = song.notes;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    for (const i of visibleNotes(v)) {
      const n = notes[i], fp = frets[i];
      if (!fp) continue;
      const xs = x(n.t), xe = Math.max(xs + 2, x(n.t + n.d)), yy = sy(fp.s);
      const active = t >= n.t && t < n.t + n.d;
      const col = STRING_COLORS[fp.s + (5 - nStr)];
      ctx.fillStyle = col + (active ? "55" : "26");
      ctx.fillRect(xs, yy - 3, xe - xs, 6);
      const label = String(fp.f) + (fp.shifted ? "*" : "");
      const w = Math.max(22, ctx.measureText(label).width + 12);
      ctx.fillStyle = active ? col : theme.surface;
      ctx.strokeStyle = col;
      ctx.lineWidth = 1.5;
      roundRect(xs - w / 2, yy - 11, w, 22, 7);
      ctx.fill(); ctx.stroke();
      ctx.fillStyle = active ? "#0b0f14" : theme.ink;
      ctx.fillText(label, xs, yy + 0.5);
    }
    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";
    ctx.lineWidth = 1;
  }

  // ---------------- multitrack: one lane per stem, sharing the timeline
  const LANE_ORDER = ["vocals", "guitar", "piano", "other", "rest", "bass", "drums"];
  const LANE_COLOR = () => ({ vocals: "#e86fa8", guitar: "#5cc97b", piano: "#a67cf5", other: "#8c95a5", rest: "#8c8cf5", bass: theme.bass, drums: "#f5b83d" });
  const laneNames = () => LANE_ORDER.filter((n) => tracks.some((t) => t.name === n));
  const audible = (name) => {
    const t = tracks.find((x) => x.name === name);
    if (!t) return true;
    return tracks.some((x) => x.solo) ? t.solo : !t.muted;
  };
  let laneBox = { top: 0, h: 0, names: [] };

  function drawStack(v, t, top, bottom) {
    const { x, W } = v;
    const names = laneNames();
    const n = names.length || 1;
    const laneH = (bottom - top) / n;
    laneBox = { top, h: laneH, names };
    const colors = LANE_COLOR();
    const layers = song.layers || {};
    names.forEach((name, i) => {
      const y0 = top + i * laneH, y1 = y0 + laneH;
      const col = colors[name];
      const on = audible(name);
      ctx.globalAlpha = on ? 1 : 0.32;
      if (i % 2 === 0) { ctx.fillStyle = alpha(theme.muted, 0.05); ctx.fillRect(GUTTER, y0, W - GUTTER, laneH); }
      ctx.strokeStyle = alpha(theme.muted, 0.15);
      ctx.beginPath(); ctx.moveTo(0, y1); ctx.lineTo(W, y1); ctx.stroke();
      // lane name (click toggles mute)
      ctx.fillStyle = col;
      ctx.beginPath(); ctx.arc(12, y0 + laneH / 2, 4, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = theme.ink;
      ctx.font = `600 12px ${FONT}`;
      const label = { vocals: "Vokal", guitar: "Gitar", piano: "Piano", other: "Lainnya", rest: "Band", bass: "Bass", drums: "Drum" }[name];
      ctx.fillText(label, 22, y0 + laneH / 2 + 4);
      if (!on) { ctx.strokeStyle = theme.ink; ctx.beginPath(); ctx.moveTo(22, y0 + laneH / 2); ctx.lineTo(22 + ctx.measureText(label).width, y0 + laneH / 2); ctx.stroke(); }
      ctx.font = `10px ${FONT}`;

      ctx.save();
      ctx.beginPath(); ctx.rect(GUTTER, y0, W - GUTTER, laneH); ctx.clip();
      drawActivity(v, layers, name, col, y0, laneH);
      drawFillerMarks(v, fillers[name], col, y0, laneH);
      if (name === "vocals") drawLaneMelody(v, t, song.vocals?.notes || [], song.vocals?.contour, col, y0, laneH);
      else if (name === "bass") drawLaneMelody(v, t, song.notes, null, col, y0, laneH);
      else if (name === "piano" || name === "guitar") drawLaneMelody(v, t, song[name]?.notes || [], null, col, y0, laneH);
      else if (name === "drums") { drawLaneDrums(v, t, layers.drums, col, y0, laneH); drawFillTags(v, y0, laneH); }
      ctx.restore();
      if (name === "drums" && layers.drums) drumRowLabels(y0, laneH);
      ctx.globalAlpha = 1;
    });
    ctx.save(); // balanced by the restore at the end of draw()
  }

  // loudness of the stem as a soft area: shows when the part plays (fills, breaks)
  function drawActivity(v, layers, name, col, y0, laneH) {
    const act = layers.activity?.[name];
    if (!act?.length) return;
    const step = layers.step || 0.1;
    const i0 = Math.max(0, Math.floor(v.t0 / step)), i1 = Math.min(act.length - 1, Math.ceil(v.t1 / step));
    const base = y0 + laneH - 3, h = laneH - 8;
    ctx.beginPath();
    ctx.moveTo(v.x(i0 * step), base);
    for (let i = i0; i <= i1; i++) ctx.lineTo(v.x(i * step), base - (act[i] / 100) * h);
    ctx.lineTo(v.x(i1 * step), base);
    ctx.closePath();
    ctx.fillStyle = col.startsWith("#") ? alpha(col, 0.14) : alpha(theme.bass, 0.14);
    ctx.fill();
  }

  // notes (and an optional pitch contour) squeezed into one lane
  function drawLaneMelody(v, t, notes, contour, col, y0, laneH) {
    if (!notes.length) return;
    const ms = notes.map((n) => n.midi);
    const lo = Math.min(...ms) - 1, hi = Math.max(...ms) + 1;
    const y = (m) => y0 + laneH - 6 - ((m - lo) / (hi - lo)) * (laneH - 12);
    const c = col.startsWith("#") ? col : theme.bass;
    if (contour?.midi?.length) {
      const i0 = Math.max(0, Math.floor((v.t0 - contour.t0) / contour.step));
      const i1 = Math.min(contour.midi.length - 1, Math.ceil((v.t1 - contour.t0) / contour.step));
      ctx.strokeStyle = alpha(c, 0.9); ctx.lineWidth = 1.6; ctx.beginPath();
      let pen = false;
      for (let i = i0; i <= i1; i++) {
        const m = contour.midi[i];
        if (m == null) { pen = false; continue; }
        const px = v.x(contour.t0 + i * contour.step), py = y(m);
        pen ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
        pen = true;
      }
      ctx.stroke();
      ctx.lineWidth = 1;
    } else {
      let i = lowerBound(notes, v.t0 - 4);
      for (; i < notes.length && notes[i].t <= v.t1; i++) {
        const nt = notes[i];
        if (nt.t + nt.d < v.t0) continue;
        const active = t >= nt.t && t < nt.t + nt.d;
        ctx.fillStyle = active ? c : alpha(c, 0.75);
        roundRect(v.x(nt.t), y(nt.midi) - (active ? 4 : 3), Math.max(3, nt.d * v.pps - 1), active ? 8 : 6, 3);
        ctx.fill();
      }
    }
  }

  // hh / sn / kk at the right edge of the name column
  function drumRowLabels(y0, laneH) {
    const rh = laneH / 4;
    ctx.font = `600 9px ${FONT}`;
    ctx.textAlign = "right";
    ctx.fillStyle = alpha(theme.muted, 0.85);
    ["HH", "SN", "TM", "KK"].forEach((lab, r) => ctx.fillText(lab, GUTTER - 6, y0 + rh * (r + 0.5) + 3));
    ctx.textAlign = "left";
  }

  function drawLaneDrums(v, t, drums, col, y0, laneH) {
    if (!drums) return;
    const rows = [["hat", "HH"], ["snare", "SN"], ["tom", "TM"], ["kick", "KK"]];
    const rh = laneH / rows.length;
    ctx.font = `600 9px ${FONT}`;
    rows.forEach(([k, short], r) => {
      const cy = y0 + rh * (r + 0.5);

      const hits = drums[k] || [];
      let i = lowerBound(hits, v.t0, (h) => h);
      const size = k === "kick" ? 4.5 : k === "hat" ? 3 : 4;
      for (; i < hits.length && hits[i] <= v.t1; i++) {
        const near = Math.abs(hits[i] - t) < 0.08;
        ctx.fillStyle = near ? theme.ink : alpha(col, k === "hat" ? 0.7 : 0.95);
        ctx.beginPath();
        if (k === "hat") { ctx.moveTo(v.x(hits[i]), cy - size); ctx.lineTo(v.x(hits[i]) + size, cy); ctx.lineTo(v.x(hits[i]), cy + size); ctx.lineTo(v.x(hits[i]) - size, cy); }
        else ctx.arc(v.x(hits[i]), cy, near ? size + 2 : size, 0, Math.PI * 2);
        ctx.fill();
      }
    });
  }

  // ---------------- drum grid: 16 steps per 4/4 bar, fills marked
  const DRUM_ROWS = [["hat", "Hi-hat"], ["snare", "Snare"], ["tom", "Tom"], ["kick", "Kick"]];

  function buildDrumGrid(data) {
    const drums = data.layers?.drums;
    const beats = data.beats || [];
    if (!drums || beats.length < 2) return null;
    const ibi = (beats.at(-1) - beats[0]) / (beats.length - 1);
    const starts = barOf.map((b, i) => (b > 0 ? i : -1)).filter((i) => i >= 0);
    if (!starts.length) return null;
    const bars = starts.map((b0, k) => {
      const b1 = starts[k + 1] ?? Math.min(beats.length, b0 + 4);
      const cells = [];
      for (let j = b0; j < b1; j++) {
        const ta = beats[j], tb = beats[j + 1] ?? ta + ibi;
        for (let q = 0; q < 4; q++) cells.push({ t: ta + ((tb - ta) * q) / 4, w: (tb - ta) / 4 });
      }
      return { n: k + 1, t0: beats[b0], t1: beats[b1] ?? beats[b0] + (b1 - b0) * ibi, cells, hits: { hat: new Set(), snare: new Set(), tom: new Set(), kick: new Set() } };
    });
    const barStarts = bars.map((b) => b.t0);
    for (const [k] of DRUM_ROWS) {
      for (const h of drums[k] || []) {
        const bi = lowerBound(barStarts, h + 0.03, (x) => x) - 1;
        const bar = bars[bi];
        if (!bar) continue;
        let best = -1, bd = Infinity;
        bar.cells.forEach((c, ci) => { const d = Math.abs(c.t - h); if (d < bd) { bd = d; best = ci; } });
        if (best >= 0 && bd < bar.cells[best].w * 0.5) bar.hits[k].add(best);
      }
    }
    // a fill is a bar whose pattern breaks from what the surrounding bars usually play
    const key = (b) => DRUM_ROWS.map(([k]) => [...b.hits[k]].sort((x, y) => x - y).join(",")).join("|");
    const dist = (a, b) => DRUM_ROWS.reduce((n, [k]) => {
      let d = 0;
      for (const c of a.hits[k]) if (!b.hits[k].has(c)) d++;
      for (const c of b.hits[k]) if (!a.hits[k].has(c)) d++;
      return n + d;
    }, 0);
    bars.forEach((b, i) => {
      const around = bars.slice(Math.max(0, i - 4), i + 5).filter((x) => x !== b);
      const counts = new Map();
      around.forEach((x) => counts.set(key(x), (counts.get(key(x)) || 0) + 1));
      const typicalKey = [...counts.entries()].sort((x, y) => y[1] - x[1])[0]?.[0];
      const typical = around.find((x) => key(x) === typicalKey);
      const hits = DRUM_ROWS.reduce((n, [k]) => n + b.hits[k].size, 0);
      const prev = bars[i - 1];
      b.fill = !!typical && hits >= 3 && dist(b, typical) >= 4 && (!prev || dist(prev, typical) < 4);
    });
    return { bars, starts: barStarts };
  }

  function drawDrumGrid(v, t, top, bottom) {
    const { x, W } = v;
    if (!drumGrid) return;
    const rowH = (bottom - top) / DRUM_ROWS.length;
    const col = "#f5b83d";
    ctx.font = `600 11px ${FONT}`;
    DRUM_ROWS.forEach(([, label], r) => {
      ctx.fillStyle = alpha(theme.muted, 0.9);
      ctx.fillText(label, 6, top + rowH * (r + 0.5) + 4);
    });
    clipNotes(v);
    const { bars, starts } = drumGrid;
    let i = Math.max(0, lowerBound(starts, v.t0, (s0) => s0) - 1);
    for (; i < bars.length && bars[i].t0 <= v.t1; i++) {
      const bar = bars[i];
      if (bar.fill) {
        ctx.fillStyle = alpha(theme.loop, 0.12);
        ctx.fillRect(x(bar.t0), top - 6, x(bar.t1) - x(bar.t0), bottom - top + 6);
        ctx.fillStyle = theme.loop;
        ctx.font = `700 10px ${FONT}`;
        ctx.fillText("FILL", x(bar.t0) + 4, top + 4);
      }
      bar.cells.forEach((c, ci) => {
        const cx0 = x(c.t) + 1.5, cw = Math.max(2, c.w * v.pps - 3);
        const now = t >= c.t && t < c.t + c.w;
        DRUM_ROWS.forEach(([k], r) => {
          const cy = top + rowH * r + rowH * 0.18, chh = rowH * 0.64;
          const hit = bar.hits[k].has(ci);
          ctx.fillStyle = hit ? (now ? theme.ink : alpha(col, k === "hat" ? 0.7 : 0.95)) : alpha(theme.muted, ci % 4 === 0 ? 0.13 : 0.07);
          roundRect(cx0, cy, cw, chh, 4);
          ctx.fill();
        });
      });
    }
  }

  // hits per bar inside the multitrack drum lane
  function drawFillTags(v, y0, laneH) {
    if (!drumGrid) return;
    const { bars, starts } = drumGrid;
    let i = Math.max(0, lowerBound(starts, v.t0, (s0) => s0) - 1);
    ctx.font = `700 9px ${FONT}`;
    for (; i < bars.length && bars[i].t0 <= v.t1; i++) {
      if (!bars[i].fill) continue;
      ctx.fillStyle = alpha(theme.loop, 0.16);
      ctx.fillRect(v.x(bars[i].t0), y0, v.x(bars[i].t1) - v.x(bars[i].t0), laneH);
      ctx.fillStyle = theme.loop;
      ctx.fillText("FILL", v.x(bars[i].t0) + 4, y0 + 11);
    }
  }

  // ---------------- fillers: keys / guitar / pads stepping in while the singer rests
  function findFillers(layers) {
    const act = layers?.activity || {};
    const voc = act.vocals;
    const step = layers?.step || 0.1;
    const out = {};
    if (!voc) return out;
    for (const name of ["guitar", "piano", "other"]) {
      const a = act[name];
      if (!a) continue;
      const sorted = [...a].sort((x, y) => x - y);
      const median = sorted[Math.floor(sorted.length / 2)] || 0;
      const on = a.map((val, i) => (voc[i] ?? 0) < 20 && val > Math.max(30, median + 12));
      const regions = [];
      let i = 0;
      while (i < on.length) {
        if (!on[i]) { i++; continue; }
        let j = i;
        while (j < on.length && (on[j] || (on[j + 1] && on[j + 2]))) j++;
        const dur = (j - i) * step;
        if (dur >= 0.8 && dur <= 8) regions.push({ t0: i * step, t1: j * step });
        i = j + 1;
      }
      out[name] = regions;
    }
    return out;
  }

  function drawFillerMarks(v, regions, col, y0, laneH) {
    if (!regions?.length) return;
    const c = col.startsWith("#") ? col : theme.bass;
    ctx.font = `600 9px ${FONT}`;
    for (const r of regions) {
      if (r.t1 < v.t0 || r.t0 > v.t1) continue;
      const x0 = v.x(r.t0), x1 = v.x(r.t1);
      ctx.fillStyle = alpha(c, 0.2);
      roundRect(x0, y0 + 3, x1 - x0, laneH - 6, 6);
      ctx.fill();
      if (x1 - x0 > 38) { ctx.fillStyle = c; ctx.fillText("filler", x0 + 5, y0 + 13); }
    }
  }

  // ---------------- piano roll (piano, guitar)
  function drawRoll(v, t, top, bottom) {
    const { x, W } = v;
    const col = part === "piano" ? "#a67cf5" : "#5cc97b";
    const y = (m) => bottom - ((m - pitchLo) / (pitchHi - pitchLo)) * (bottom - top);
    const rowH = (bottom - top) / (pitchHi - pitchLo);
    ctx.font = `10px ${FONT}`;
    for (let m = Math.ceil(pitchLo); m <= pitchHi; m++) {
      const yy = y(m);
      const black = [1, 3, 6, 8, 10].includes(m % 12);
      if (black) { ctx.fillStyle = alpha(theme.muted, 0.05); ctx.fillRect(GUTTER, yy - rowH / 2, W - GUTTER, rowH); }
      if (m % 12 === 0) {
        ctx.strokeStyle = alpha(theme.muted, 0.22);
        ctx.beginPath(); ctx.moveTo(GUTTER, yy + rowH / 2); ctx.lineTo(W, yy + rowH / 2); ctx.stroke();
        ctx.fillStyle = alpha(theme.muted, 0.85);
        ctx.fillText(nameOf(m), 6, yy + 3);
      }
    }
    clipNotes(v);
    const notes = notesOf();
    let i = lowerBound(notes, v.t0 - 8);
    const h = Math.max(3, Math.min(12, rowH - 1));
    ctx.font = `600 9px ${FONT}`;
    for (; i < notes.length && notes[i].t <= v.t1; i++) {
      const n = notes[i];
      if (n.t + n.d < v.t0) continue;
      const active = t >= n.t && t < n.t + n.d;
      const xs = x(n.t), w = Math.max(3, n.d * v.pps - 1);
      ctx.fillStyle = active ? col : alpha(col, 0.35 + 0.5 * (n.v ?? 0.7));
      roundRect(xs, y(n.midi) - h / 2, w, h, 3);
      ctx.fill();
      if (active) { ctx.strokeStyle = theme.ink; ctx.lineWidth = 1.5; ctx.stroke(); ctx.lineWidth = 1; }
      if (w > 26 && h >= 9) { ctx.fillStyle = active ? "#0b0f14" : alpha(theme.ink, 0.8); ctx.fillText(nameOf(n.midi), xs + 3, y(n.midi) + 3); }
    }
  }

  // ---------------- guitar tab (6 strings, standard tuning)
  const GUITAR = { names: ["E", "A", "D", "G", "B", "e"], open: [40, 45, 50, 55, 59, 64] };

  // chords are grouped by onset; each group gets distinct strings within a 4-fret hand span,
  // picked with a small beam search that keeps the hand from jumping around
  function assignGuitarFrets(notes) {
    const out = new Array(notes.length).fill(null);
    const groups = [];
    notes.forEach((n, i) => {
      const g = groups.at(-1);
      if (g && n.t - g.t < 0.04) g.idx.push(i); else groups.push({ t: n.t, idx: [i] });
    });
    let beam = [{ hand: 0, cost: 0, picks: [] }];
    for (const g of groups) {
      const idx = g.idx.sort((a, b) => notes[a].midi - notes[b].midi).slice(-6);
      const opts = idx.map((i) => GUITAR.open.map((o, s) => ({ i, s, f: notes[i].midi - o })).filter((c) => c.f >= 0 && c.f <= 17));
      const combos = [];
      const walk = (k, used, chosen) => {
        if (combos.length > 400) return;
        if (k === opts.length) { combos.push(chosen.slice()); return; }
        if (!opts[k].length) { walk(k + 1, used, chosen); return; }
        for (const c of opts[k]) {
          if (used & (1 << c.s)) continue;
          const fretted = [...chosen, c].filter((x) => x.f > 0).map((x) => x.f);
          if (fretted.length && Math.max(...fretted) - Math.min(...fretted) > 4) continue;
          chosen.push(c); walk(k + 1, used | (1 << c.s), chosen); chosen.pop();
        }
      };
      walk(0, 0, []);
      if (!combos.length) continue;
      const next = [];
      for (const st of beam) {
        for (const combo of combos) {
          const fretted = combo.filter((c) => c.f > 0).map((c) => c.f);
          const hand = fretted.length ? Math.min(...fretted) : st.hand;
          const span = fretted.length ? Math.max(...fretted) - hand : 0;
          const cost = st.cost + 0.4 * span + 0.05 * fretted.reduce((a, b) => a + b, 0) + 0.3 * Math.abs(hand - st.hand) + 2 * (idx.length - combo.length);
          next.push({ hand, cost, picks: st.picks.concat([combo]) });
        }
      }
      beam = next.sort((a, b) => a.cost - b.cost).slice(0, 8);
    }
    for (const combo of beam[0]?.picks || []) for (const c of combo) out[c.i] = { s: c.s, f: c.f };
    return out;
  }

  function drawGuitarTab(v, t, top, bottom) {
    const { x, W } = v;
    const gap = (bottom - top) / 6;
    const sy = (s) => bottom - gap * (s + 0.5); // low e at the bottom
    ctx.font = `600 12px ${FONT}`;
    for (let s = 0; s < 6; s++) {
      ctx.strokeStyle = alpha(theme.muted, 0.4);
      ctx.lineWidth = 0.8 + (6 - s) * 0.2;
      ctx.beginPath(); ctx.moveTo(GUTTER, sy(s)); ctx.lineTo(W, sy(s)); ctx.stroke();
      ctx.fillStyle = "#5cc97b";
      ctx.fillText(GUITAR.names[s], 18, sy(s) + 4);
    }
    ctx.lineWidth = 1;
    clipNotes(v);
    const notes = notesOf();
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = `600 11px ${FONT}`;
    let i = lowerBound(notes, v.t0 - 8);
    for (; i < notes.length && notes[i].t <= v.t1; i++) {
      const n = notes[i], fp = guitarFrets[i];
      if (!fp || n.t + n.d < v.t0) continue;
      const xs = x(n.t), yy = sy(fp.s);
      const active = t >= n.t && t < n.t + n.d;
      ctx.fillStyle = alpha("#5cc97b", active ? 0.4 : 0.18);
      ctx.fillRect(xs, yy - 2, Math.max(2, n.d * v.pps), 4);
      const w = Math.max(18, ctx.measureText(String(fp.f)).width + 10);
      ctx.fillStyle = active ? "#5cc97b" : theme.surface;
      ctx.strokeStyle = "#5cc97b";
      roundRect(xs - w / 2, yy - 9, w, 18, 6);
      ctx.fill(); ctx.stroke();
      ctx.fillStyle = active ? "#0b0f14" : theme.ink;
      ctx.fillText(String(fp.f), xs, yy + 0.5);
    }
    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";
  }

  // keep notes out of the label gutter (restored at the end of draw)
  function clipNotes(v) { ctx.save(); ctx.beginPath(); ctx.rect(GUTTER - 12, 0, v.W, v.H); ctx.clip(); }
  function roundRect(x, y, w, h, r) { ctx.beginPath(); ctx.roundRect ? ctx.roundRect(x, y, w, h, r) : ctx.rect(x, y, w, h); }

  // overview strip: whole song, chords + note contour
  let ovBase = null;
  function drawOverviewBase() {
    if (!song) return;
    const off = document.createElement("canvas");
    off.width = ov.width; off.height = ov.height;
    const c = off.getContext("2d");
    const W = off.width, H = off.height, D = song.duration || 1;
    for (const ch of song.chords) {
      if (ch.label === "N") continue;
      c.fillStyle = chordColor(ch.label, 0.22);
      c.fillRect((ch.t / D) * W, 0, (ch.d / D) * W, H);
    }
    c.fillStyle = alpha(theme.bass, 0.85);
    // parts without notes (drums, multitrack) show the bass line in the overview
    const ovNotes = notesOf().length ? notesOf() : song.notes;
    for (const n of ovNotes) {
      const yy = H - 5 - ((n.midi - pitchLo) / (pitchHi - pitchLo)) * (H - 10);
      c.fillRect((n.t / D) * W, yy, Math.max(1, (n.d / D) * W), 2 * (window.devicePixelRatio || 1));
    }
    ovBase = off;
  }
  function drawOverview(t) {
    const W = ov.width, H = ov.height, D = song.duration || 1;
    octx.clearRect(0, 0, W, H);
    if (ovBase) octx.drawImage(ovBase, 0, 0);
    if (loop.a != null && loop.b != null) {
      octx.fillStyle = alpha(theme.loop, 0.25);
      octx.fillRect((loop.a / D) * W, 0, ((loop.b - loop.a) / D) * W, H);
    }
    octx.fillStyle = alpha(theme.ink, 0.07);
    octx.fillRect(((t - windowSec * 0.25) / D) * W, 0, (windowSec / D) * W, H);
    octx.fillStyle = theme.ink;
    octx.fillRect((t / D) * W - 1, 0, 2 * (window.devicePixelRatio || 1), H);
  }

  // ---------------- chord sheet: chords per bar, like a printed chord chart
  let transpose = 0, sheet = null, sheetFont = store.get("chord-font", 1);
  const MINOR_FLAT = [2, 7, 0, 5, 10]; // d g c f bb minor are written with flats
  const MAJOR_FLAT = [5, 10, 3, 8, 1];

  // key of the song after transposing: [root pitch class, minor?]
  function sheetKey() {
    const [root, mode] = (song.key || "C major").split(" ");
    const r = chordRoot(root) ?? 0;
    return [(((r + transpose) % 12) + 12) % 12, mode === "minor"];
  }
  const namesFor = (root, minor) => ((minor ? MINOR_FLAT : MAJOR_FLAT).includes(root) ? FLAT : SHARP);

  // spelling for the key sounding at time t (it changes on a modulation), after transposing
  function namesAt(t) {
    const [root, mode] = (keyAt(song, t) || "C major").split(" ");
    return namesFor((((chordRoot(root) ?? 0) + transpose) % 12 + 12) % 12, mode === "minor");
  }

  // shift a chord label (root, quality, optional slash bass) by the current transpose
  function shiftChord(label, names) {
    const m = /^([A-G][#b]?)(.*?)(?:\/([A-G][#b]?))?$/.exec(label);
    if (!m) return label;
    const mv = (n) => names[(((chordRoot(n) + transpose) % 12) + 12) % 12];
    return mv(m[1]) + m[2] + (m[3] ? "/" + mv(m[3]) : "");
  }

  // chord sounding at time t (or "N")
  function chordAt(t) {
    const ch = song.chords;
    const c = ch[lowerBound(ch, t + 1e-6) - 1];
    return c && t < c.t + c.d ? c.label : "N";
  }

  // bars from the downbeats (else every 4 beats), each split into its beats
  function sheetBars() {
    const beats = song.beats;
    let starts = song.downbeats?.length > 1 ? [...song.downbeats] : beats.filter((_, i) => i % 4 === 0);
    if (!starts.length) starts = [0];
    if (beats[0] < starts[0] - 0.1) starts.unshift(beats[0]); // pickup bar before the first downbeat
    const bars = starts.map((s, i) => {
      const e = starts[i + 1] ?? song.duration;
      const slots = beats.filter((b) => b >= s - 0.02 && b < e - 0.02);
      if (!slots.length) slots.push(s);
      return { s, e, slots: slots.map((t) => ({ t, label: chordAt(t + 0.08) })) };
    });
    // drop silent bars at the start and end
    const silent = (b) => b.slots.every((x) => x.label === "N");
    while (bars.length && silent(bars[0])) bars.shift();
    while (bars.length && silent(bars.at(-1))) bars.pop();
    return bars;
  }

  function buildSheet() {
    if (!song) return;
    const [root, minor] = sheetKey();
    const names = namesFor(root, minor);
    // transpose buttons: every key, the original one marked
    const keys = $("#sheetKeys");
    keys.replaceChildren(...SHARP.map((_, i) => {
      const b = el("button", "key-btn" + (i === root ? " active" : ""), namesFor(i, minor)[i] + (minor ? "m" : ""));
      b.type = "button";
      if (((i - root + transpose) % 12 + 12) % 12 === 0) b.classList.add("orig");
      b.title = b.classList.contains("orig") ? "Kunci asli" : `Transpose ke ${b.textContent}`;
      b.onclick = () => {
        let d = (((i - root) % 12) + 12) % 12;
        if (d > 6) d -= 12;
        transpose += d;
        transpose = ((transpose % 12) + 18) % 12 - 6; // keep within -6..+5
        setTranspose(transpose);
        buildSheet();
      };
      return b;
    }));
    // bars, 4 per row; a chord is written where it changes
    const bars = sheetBars();
    const body = $("#sheetBody");
    body.style.setProperty("--sheet-scale", sheetFont);
    const head = el("div", "sheet-print-head");
    head.append(el("h2", "", song.title || ""), el("p", "", `Kunci ${names[root]}${minor ? "m" : ""} · ${Math.round(song.bpm)} BPM`));
    const grid = el("div", "sheet-grid");
    let prev = "N";
    const cells = [], marks = [];
    bars.forEach((bar, bi) => {
      const cell = el("div", "bar");
      cell.dataset.i = bi;
      cell.onclick = () => seek(bar.s);
      // one column per beat; a chord name spans the beats until the next change
      cell.style.gridTemplateColumns = `repeat(${bar.slots.length}, minmax(0, 1fr))`;
      const toks = [];
      bar.slots.forEach((slot, si) => {
        const changed = slot.label !== prev;
        prev = slot.label;
        if (!changed && si > 0) { if (toks.length) toks.at(-1).span++; return; }
        const tok = el("span", "tok");
        tok.textContent = slot.label === "N" ? (changed ? "N.C." : "") : shiftChord(slot.label, namesAt(slot.t));
        tok.title = tok.textContent;
        if (!changed) tok.classList.add("held");
        if (slot.label !== "N") tok.style.color = chordColor(slot.label, 1);
        tok.onclick = (e) => { e.stopPropagation(); seek(slot.t); };
        toks.push({ tok, si, span: 1 });
        marks.push({ t: slot.t, tok });
      });
      for (const x of toks) x.tok.style.gridColumn = `${x.si + 1} / span ${x.span}`;
      cell.append(...toks.map((x) => x.tok));
      cells.push(cell);
      grid.append(cell);
    });
    if (!bars.length) grid.append(el("p", "sheet-empty", "Belum ada chord yang terdeteksi."));
    body.replaceChildren(head, grid);
    sheet = { bars, cells, marks, names, cur: -1, curTok: null };
  }

  // highlight the current bar and chord; follow along while playing
  function updateSheet(t, playing) {
    if (!sheet) return;
    const bi = lowerBound(sheet.bars, t + 1e-6, (b) => b.s) - 1;
    const mi = lowerBound(sheet.marks, t + 1e-6) - 1;
    // the token showing the chord that is sounding now
    const tok = mi >= 0 && t < (sheet.bars.at(-1)?.e ?? 0) && sheet.marks[mi].tok.textContent ? sheet.marks[mi].tok : null;
    if (tok !== sheet.curTok) {
      sheet.curTok?.classList.remove("now");
      tok?.classList.add("now");
      sheet.curTok = tok;
    }
    if (bi === sheet.cur) return;
    sheet.cells[sheet.cur]?.classList.remove("now");
    const cell = sheet.cells[bi];
    cell?.classList.add("now");
    sheet.cur = bi;
    if (!playing || !cell) return;
    follow($("#sheetBody"), cell.getBoundingClientRect());
  }

  function setTranspose(v) {
    transpose = v;
    try { localStorage.setItem(`delve.transpose.${jobId}`, String(transpose)); } catch {}
    score = null;
    lastNowKey = "";
  }

  // scroll the sheet box, or the page when the sheet is not a scroll box (phones), to keep rect in view
  function follow(boxEl, r) {
    // nearest ancestor that actually scrolls, else the page
    let sc = boxEl;
    while (sc && !(sc.scrollHeight > sc.clientHeight + 1 && /auto|scroll/.test(getComputedStyle(sc).overflowY))) sc = sc.parentElement;
    const view = sc ? sc.getBoundingClientRect() : { top: 0, height: innerHeight };
    const y = r.top - view.top;
    if (y > 20 && y + r.height < view.height * 0.6) return;
    (sc || window).scrollBy({ top: y - view.height * 0.3, behavior: "smooth" });
  }

  // ---------------- score: transcribed melody as not balok / not angka / letters
  let score = null, scorePart = store.get("score-part", "vocals"), scoreMode = store.get("score-mode", "staff");
  let scoreScale = store.get("score-scale", 1), scoreToken = 0;

  async function buildScoreView() {
    if (!song) return;
    const token = ++scoreToken;
    if (scorePart === "vocals" && !song.vocals?.notes?.length) scorePart = "bass";
    $$("#scorePart button").forEach((b) => {
      b.classList.toggle("active", b.dataset.scorePart === scorePart);
      b.hidden = b.dataset.scorePart === "vocals" ? !song.vocals?.notes?.length : !song.notes?.length;
    });
    $$("#scoreMode button").forEach((b) => b.classList.toggle("active", b.dataset.mode === scoreMode));
    const [root, minor] = sheetKey();
    const names = namesFor(root, minor);
    // key picker shares the transpose with the chord sheet
    const sel = $("#scoreKey");
    sel.replaceChildren(...SHARP.map((_, i) => {
      const d = ((i - root) % 12 + 12) % 12;
      const o = el("option", "", namesFor(i, minor)[i] + (minor ? "m" : "") + (((i - root + transpose) % 12 + 12) % 12 === 0 ? " (asli)" : ""));
      o.value = String(d > 6 ? d - 12 : d);
      o.selected = i === root;
      return o;
    }));
    $("#nowNoteLabel").textContent = scorePart === "vocals" ? "Not vokal" : "Not bass";
    const model = buildScore(song, scorePart, transpose, (l, t) => shiftChord(l, namesAt(t)));
    const inner = $("#scoreInner");
    $("#scoreCursor").hidden = true;
    let items;
    if (scoreMode === "staff") {
      try { await loadVex(); } catch { inner.replaceChildren(el("p", "sheet-empty", "Not balok gagal dimuat.")); return; }
      if (token !== scoreToken) return;
      const cs = getComputedStyle(document.body);
      items = renderStaff(inner, model, { scale: scoreScale, ink: cs.getPropertyValue("--ink").trim() || "#000", chordInk: cs.getPropertyValue("--bass").trim() || "#555" });
    } else {
      inner.style.setProperty("--sheet-scale", scoreScale);
      items = renderNumbers(inner, model, scoreMode === "letters", el);
    }
    items.forEach((it) => { if (it.el) it.el.onclick = (e) => { e.stopPropagation(); seek(it.t0); }; });
    score = { model, items, cur: null, mode: scoreMode, width: inner.clientWidth };
    lastNowKey = "";
    updateScore(now(), false);
  }

  // highlight the sounding note and move the cursor through the staff
  function updateScore(t, playing) {
    if (!score) return;
    const items = score.items;
    const i = lowerBound(items, t + 1e-6, (x) => x.t0) - 1;
    const it = i >= 0 && t < items[i].t1 + 0.05 ? items[i] : null;
    const cur = $("#scoreCursor");
    if (score.mode === "staff" && i >= 0 && i < items.length) {
      const x = items[i];
      const f = Math.max(0, Math.min(1, (t - x.t0) / (x.t1 - x.t0 || 1)));
      cur.hidden = t > items.at(-1).t1;
      const inner = $("#scoreInner");
      cur.style.transform = `translate(${inner.offsetLeft + x.x0 + f * (x.x1 - x.x0) - 4}px, ${inner.offsetTop + x.top}px)`;
      cur.style.height = `${x.bottom - x.top}px`;
    } else cur.hidden = true;
    if (it === score.cur) return;
    score.cur?.el?.classList.remove("now");
    score.cur?.barEl?.classList.remove("now");
    it?.el?.classList.add("now");
    it?.barEl?.classList.add("now");
    score.cur = it;
    if (!playing || !it) return;
    const box = $("#scoreBody"), br = box.getBoundingClientRect();
    const r = score.mode === "staff"
      ? { top: br.top - box.scrollTop + it.top + $("#scoreInner").offsetTop, height: it.bottom - it.top }
      : it.el.getBoundingClientRect();
    follow(box, r);
  }

  $$("#scorePart button").forEach((b) => b.addEventListener("click", () => {
    scorePart = b.dataset.scorePart;
    store.set("score-part", scorePart);
    buildScoreView();
  }));
  $$("#scoreMode button").forEach((b) => b.addEventListener("click", () => {
    scoreMode = b.dataset.mode;
    store.set("score-mode", scoreMode);
    buildScoreView();
  }));
  $("#scoreKey").addEventListener("change", (e) => {
    let v = transpose + Number(e.target.value);
    v = ((v % 12) + 18) % 12 - 6;
    setTranspose(v);
    buildScoreView();
  });
  const setScoreScale = (f) => {
    scoreScale = Math.max(0.6, Math.min(1.8, Math.round(f * 10) / 10));
    store.set("score-scale", scoreScale);
    buildScoreView();
  };
  $("#scoreSmaller").addEventListener("click", () => setScoreScale(scoreScale - 0.1));
  $("#scoreBigger").addEventListener("click", () => setScoreScale(scoreScale + 0.1));
  $("#scoreXml").addEventListener("click", () => {
    if (!score) return;
    const label = scorePart === "vocals" ? "Vokal" : "Bass";
    const xml = toMusicXml(score.model, song.title || "Encore", label);
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([xml], { type: "application/vnd.recordare.musicxml+xml" }));
    a.download = `${(song.title || "Encore").replace(/[\\/:*?"<>|]/g, "")} - ${label}.musicxml`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  });
  $("#scorePrint").addEventListener("click", () => {
    document.body.classList.add("print-score");
    window.print();
  });
  window.addEventListener("afterprint", () => document.body.classList.remove("print-score"));
  // the staff layout depends on the width
  let scoreResize = 0;
  new ResizeObserver(() => {
    if (!score || part !== "score" || Math.abs($("#scoreInner").clientWidth - score.width) < 8) return;
    clearTimeout(scoreResize);
    scoreResize = setTimeout(buildScoreView, 200);
  }).observe($("#scoreBody"));

  const setSheetFont = (f) => {
    sheetFont = Math.max(0.7, Math.min(1.8, Math.round(f * 10) / 10));
    store.set("chord-font", sheetFont);
    $("#sheetBody").style.setProperty("--sheet-scale", sheetFont);
  };
  $("#sheetSmaller").addEventListener("click", () => setSheetFont(sheetFont - 0.1));
  $("#sheetBigger").addEventListener("click", () => setSheetFont(sheetFont + 0.1));
  $("#sheetPrint").addEventListener("click", () => {
    document.body.classList.add("print-sheet");
    window.print();
  });
  window.addEventListener("afterprint", () => document.body.classList.remove("print-sheet"));

  // ---------------- now panel
  let lastNowKey = "";
  function updateNow(t) {
    const ch = song.chords;
    const ci = lowerBound(ch, t + 1e-6) - 1;
    const cur = ch[ci];
    const nxt = ch.slice(ci + 1).find((c) => c.label !== "N");
    $("#timeLabel").textContent = `${fmtTime(t)} / ${fmtTime(song.duration)}`;
    const [big, small, key] = nowText(t);
    const k = `${ci}|${key}|${part}|${transpose}`;
    if (k === lastNowKey) return;
    lastNowKey = k;
    // the chord sheet shows chords in the transposed key
    const fmt = (c) => (part === "chords" && sheet ? shiftChord(c.label, namesAt(c.t)) : c.label);
    $("#nowChord").textContent = cur && cur.label !== "N" ? fmt(cur) : "–";
    $("#nextChord").textContent = nxt ? `berikutnya ${fmt(nxt)}` : "";
    $("#bdNote").textContent = big;
    $("#nowFret").textContent = small;
  }

  // what the second box says for the current part: [big text, small text, change key]
  function nowText(t) {
    if (part === "drums") {
      const bars = drumGrid?.bars || [];
      const bi = lowerBound(drumGrid?.starts || [], t + 1e-6, (x) => x) - 1;
      const bar = bars[bi];
      return bar ? [`Bar ${bar.n}`, bar.fill ? "fill" : "pola utama", `d${bi}`] : ["–", "", "d-"];
    }
    const notes = notesOf();
    if (part === "piano" || part === "guitar") {
      let i = lowerBound(notes, t - 8);
      const sounding = [];
      for (; i < notes.length && notes[i].t <= t; i++) if (t < notes[i].t + notes[i].d) sounding.push(i);
      sounding.sort((a, b) => notes[a].midi - notes[b].midi);
      const names = sounding.slice(0, 5).map((i) => nameOf(notes[i].midi)).join(" ");
      let detail = "";
      if (part === "guitar" && sounding.length) {
        detail = sounding.map((i) => guitarFrets[i]).filter(Boolean).sort((a, b) => a.s - b.s)
          .map((fp) => `${GUITAR.names[fp.s]}${fp.f}`).join(" · ");
      }
      return [names || "–", detail, sounding.join(",")];
    }
    const ni = lowerBound(notes, t + 1e-6) - 1;
    const n = notes[ni] && t < notes[ni].t + notes[ni].d + 0.05 ? notes[ni] : null;
    const fp = n && (part === "bass" || part === "stack") ? frets[ni] : null;
    return [n ? nameOf(n.midi) : "–", fp ? `senar ${tuning.names[fp.s]} · fret ${fp.f}${fp.shifted ? " (oktaf digeser)" : ""}` : "", n ? ni : -1];
  }

  // ---------------- loop
  function syncLoopUi() {
    $("#loopA").classList.toggle("on", loop.a != null);
    $("#loopB").classList.toggle("on", loop.b != null);
    $("#loopA").textContent = loop.a != null ? `A ${fmtTime(loop.a)}` : "A";
    $("#loopB").textContent = loop.b != null ? `B ${fmtTime(loop.b)}` : "B";
    $("#loopToggle").textContent = loop.on ? "On" : "Off";
    $("#loopToggle").classList.toggle("on", loop.on);
  }
  function setA() { loop.a = now(); if (loop.b != null && loop.b <= loop.a) loop.b = null; syncLoopUi(); }
  function setB() { const t = now(); if (loop.a == null || t <= loop.a) return; loop.b = t; loop.on = true; syncLoopUi(); }
  function toggleLoop() { if (loop.a != null && loop.b != null) { loop.on = !loop.on; syncLoopUi(); } }
  function clearLoop() { loop = { a: null, b: null, on: false }; syncLoopUi(); }

  // ---------------- input
  const timeAtX = (clientX) => {
    const r = roll.getBoundingClientRect();
    const v = view(now());
    return v.t0 + (clientX - r.left - GUTTER) / v.pps;
  };
  roll.addEventListener("pointerdown", (e) => {
    if (!song) return;
    if (part === "stack") {
      const r = roll.getBoundingClientRect();
      const px = e.clientX - r.left, py = e.clientY - r.top;
      if (px < GUTTER && py >= laneBox.top && laneBox.h) {
        const name = laneBox.names[Math.floor((py - laneBox.top) / laneBox.h)];
        const i = tracks.findIndex((x) => x.name === name);
        if (i >= 0) toggleMuteAt(i);
        return;
      }
    }
    if (e.shiftKey) { const t = timeAtX(e.clientX); dragSel = { a: t, b: t }; roll.setPointerCapture(e.pointerId); }
    else seek(timeAtX(e.clientX));
  });
  roll.addEventListener("pointermove", (e) => { if (dragSel) dragSel.b = timeAtX(e.clientX); });
  roll.addEventListener("pointerup", () => {
    if (!dragSel) return;
    const a = Math.min(dragSel.a, dragSel.b), b = Math.max(dragSel.a, dragSel.b);
    dragSel = null;
    if (b - a > 0.2) { loop = { a, b, on: true }; syncLoopUi(); seek(a); }
  });
  roll.addEventListener("wheel", (e) => {
    if (!song) return;
    e.preventDefault();
    seek(now() + (e.deltaX + e.deltaY) / view(now()).pps);
  }, { passive: false });
  ov.addEventListener("pointerdown", (e) => {
    if (!song) return;
    const r = ov.getBoundingClientRect();
    seek(((e.clientX - r.left) / r.width) * song.duration);
  });

  $("#bPlay").addEventListener("click", toggle);
  $("#dockMore").addEventListener("click", (e) => {
    const open = $(".dock").classList.toggle("open");
    e.currentTarget.setAttribute("aria-expanded", open);
  });
  $$("#bSpeed [data-speed]").forEach((b) => b.addEventListener("click", () => {
    speed = +b.dataset.speed;
    tracks.forEach((x) => { x.el.playbackRate = speed; });
    $$("#bSpeed button").forEach((x) => x.classList.toggle("active", x === b));
  }));
  $("#bPitchDown").addEventListener("click", () => setPitch(pitch - 1));
  $("#bPitchUp").addEventListener("click", () => setPitch(pitch + 1));
  $("#bPitchVal").addEventListener("click", () => setPitch(0));
  $("#loopA").addEventListener("click", setA);
  $("#loopB").addEventListener("click", setB);
  $("#loopToggle").addEventListener("click", toggleLoop);
  $("#loopClear").addEventListener("click", clearLoop);
  $("#zoom").addEventListener("input", (e) => { windowSec = +e.target.value; });
  $("#tuningSel").addEventListener("change", (e) => {
    tuning = TUNINGS[e.target.value];
    try { localStorage.setItem(`delve.strings.${jobId}`, e.target.value); } catch {}
    $("#tuningHint").textContent = "";
    if (song) frets = assignFrets(song.notes, tuning);
    lastNowKey = "";
  });
  $$(".part-switch button").forEach((b) => b.addEventListener("click", () => setPart(b.dataset.part)));
  $$(".sub-switch button").forEach((b) => b.addEventListener("click", () => setSub(b.dataset.sub)));
  const PART_CYCLE = ["drums", "bass", "vocals", "piano", "guitar"];

  onKeys("song", (e) => {
    const k = e.key.toLowerCase();
    if (e.code === "Space") { e.preventDefault(); toggle(); }
    else if (k === "arrowleft") { e.preventDefault(); seek(now() - 2); }
    else if (k === "arrowright") { e.preventDefault(); seek(now() + 2); }
    else if (k === "a") setA();
    else if (k === "b") setB();
    else if (k === "l") toggleLoop();
    else if (k === "-") setPitch(pitch - 1);
    else if (k === "=" || k === "+") setPitch(pitch + 1);
    else if (k === "escape") clearLoop();
    else if (k === "[" || k === "]") jumpPart(k === "]" ? 1 : -1);
    else if (k === "s") loopPart(partAt(now()));
    else if (k === "t") setSub(sub === "graph" ? "tab" : "graph");
    else if (k === "m") setPart(part === "stack" ? "bass" : "stack");
    else if (k === "v") {
      const avail = PART_CYCLE.filter(hasPart);
      setPart(avail[(avail.indexOf(part) + 1) % avail.length] || "bass");
    }
    else if (/^[1-7]$/.test(k)) toggleMuteAt(+k - 1);
  });

  return { load, stop, redrawBase: drawOverviewBase, exportOptions, exportMix };
})();

// ------------------------------------------------------------------ routes
let openId = null;

export function enterBassHome() {
  player.stop();
  openId = null;
  document.title = "Breakdown · Encore";
  $("#urlInput").placeholder = "Tempel link YouTube atau Google Drive…";
  $("#jobForm").hidden = !server.analysis;
  $("#modeRow").hidden = !server.analysis;
  // web version: show where to get the app
  $("#bassGetApp").hidden = server.bass || !server.checked;
  if (!server.bass && server.checked) renderGetApp();
  $("#bassOnline").hidden = !server.bass;
  if (server.bass) { renderQueue(); renderLibrary(); poll(); }
}

export async function enterSong(id) {
  if (!server.checked) await server.check();
  if (!server.bass) { router.go("#/breakdown"); return; }
  if (openId === id) return;
  openId = id;
  $("#songTitle").textContent = "Memuat…";
  $("#songChips").replaceChildren();
  $("#songActions").replaceChildren();
  try {
    const data = await api(`/api/jobs/${id}/analysis`);
    if (openId !== id) return;
    $("#songTitle").textContent = data.title;
    document.title = `${data.title} · Encore`;
    const chips = [el("span", "chip", keysLabel(data)), el("span", "chip", `${Math.round(data.bpm)} BPM`)];
    if (data.analyzed_at) {
      const c = el("span", "chip" + (data.outdated ? " warn" : ""), `Dianalisis ${fmtDate(data.analyzed_at)}${data.outdated ? " · versi lama" : ""}`);
      c.title = data.outdated ? "Algoritma sudah diperbarui sejak analisis ini. Analisis ulang untuk hasil terbaru." : fmtAgo(data.analyzed_at);
      chips.push(c);
    }
    if (data.result_mode === "classic") {
      const c = el("span", "chip", "Mode cepat");
      c.title = "Dianalisis tanpa AI. Pakai Detail (AI) untuk 6 instrumen dan hasil yang lebih bersih.";
      chips.push(c);
    }
    if (data.url) {
      const a = el("a", "chip");
      a.href = data.url; a.target = "_blank"; a.rel = "noopener noreferrer";
      a.append(data.source_type === "gdrive" ? "Google Drive" : "YouTube", icon("link"));
      chips.push(a);
    }
    $("#songChips").replaceChildren(...chips);
    const job = { id, title: data.title, url: data.url, source_type: data.source_type };
    const acts = [];
    if (data.url) {
      const b = el("button", "btn sm");
      b.type = "button"; b.append(icon("list"), "Putar di Playlist");
      b.onclick = () => { player.stop(); addToPlaylist(data.url, data.title); };
      acts.push(b);
    }
    // one midi file per transcribed part
    const parts = [["bass", "Bass", true], ["vocals", "Vokal", !!data.vocals], ["piano", "Piano", !!data.piano?.notes?.length],
      ["guitar", "Gitar", !!data.guitar?.notes?.length], ["drums", "Drum", !!data.layers?.drums && data.version >= 9]];
    const midi = el("button", "btn sm");
    midi.type = "button"; midi.append(icon("download"), "MIDI");
    midi.onclick = (e) => {
      e.stopPropagation();
      showMenu(midi, parts.filter(([, , ok]) => ok).map(([name, label]) => ({
        label: `MIDI ${label}`, icon: "download", onClick: () => downloadMidi(id, name, data.title, label),
      })));
    };
    const more = el("button", "icon-btn");
    more.type = "button"; more.title = "Lainnya"; more.append(icon("more"));
    more.onclick = (e) => { e.stopPropagation(); showMenu(more, songMenu(job).filter((x) => x && !/MIDI|Playlist|Buka di/.test(x.label))); };
    const exp = el("button", "btn sm");
    exp.type = "button"; exp.title = "Gabungkan instrumen jadi satu file MP3"; exp.append(icon("download"), "Export audio");
    exp.onclick = (e) => {
      e.stopPropagation();
      showMenu(exp, player.exportOptions().map((o) => ({ label: o.label, icon: "download", onClick: () => player.exportMix(o.list, o.suffix) })));
    };
    acts.push(exp, midi);
    if (data.result_mode === "classic" && server.analysis) {
      const up = el("button", "btn sm ai-up");
      up.type = "button"; up.title = "Analisis ulang pakai AI: 6 instrumen, hasil lebih bersih";
      up.append(icon("sparkle"), "Detail pakai AI");
      up.onclick = () => upgradeAi(job);
      acts.unshift(up);
    }
    if (server.analysis) acts.push(more);  // view-only server: nothing left in this menu
    $("#songActions").replaceChildren(...acts);
    const audioMap = data.audio || { bass: "bass.mp3", rest: "rest.mp3" };
    data.audioUrls = Object.fromEntries(Object.entries(audioMap).map(([n, f]) => [n, fileUrl(id, f)]));
    if (openId !== id) return;
    player.load(id, data);
  } catch (ex) {
    toast(`Gagal membuka lagu: ${ex.message}`, { error: true });
    router.go("#/breakdown");
  }
}

export function leaveSong() { player.stop(); openId = null; }

async function downloadMidi(id, name, title, label) {
  try {
    const a = el("a");
    a.href = fileUrl(id, `${name}.mid`);
    a.download = `${(title || label).replace(/[^\w\-. ]+/g, "_").trim().slice(0, 80) || "lagu"} - ${label.toLowerCase()}.mid`;
    document.body.append(a);
    a.click();
    a.remove();
  } catch (ex) {
    toast(`MIDI tidak tersedia: ${ex.message}`, { error: true });
  }
}

export function initBass() {
  $("#recheckServer").onclick = async () => {
    await server.check();
    enterBassHome();
    if (!server.bass) toast("Encore App belum terdeteksi di halaman ini. Kalau app-nya sudah jalan, buka localhost:8765.");
  };
  $("#quitApp").onclick = async () => {
    if (!(await confirmDialog("Tutup Encore App?", "Lagu yang sedang diproses akan dilanjutkan saat Encore dibuka lagi.", { ok: "Tutup" }))) return;
    try { await fetch("/api/quit", { method: "POST" }); } catch { /* already gone */ }
    document.body.replaceChildren(el("p", "app-closed", "Encore App sudah ditutup. Tab ini boleh ditutup juga."));
  };
  server.onChange((on) => {
    if (router.current === "bass") enterBassHome();
    if (on) poll();
  });
}
