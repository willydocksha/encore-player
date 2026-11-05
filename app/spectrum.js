// spectrum: live fft of the tuner input, plus a capture of every hit (slap / pop / pluck),
// so you can see per note which band (2-5 khz attack, 8-16 khz click, ...) sticks out.

import { $, el } from "./core.js";

const F_MIN = 30, F_MAX = 16000;
const DB_MIN = -110, DB_MAX = -10;
// body is the reference (0 db), every other band is shown relative to it
const BANDS = [
  { id: "body", name: "Body", lo: 30, hi: 300 },
  { id: "lowmid", name: "Low-mid", lo: 300, hi: 800 },
  { id: "mid", name: "Mid", lo: 800, hi: 2000 },
  { id: "slap", name: "Slap / attack", lo: 2000, hi: 5000 },
  { id: "pres", name: "Presence", lo: 5000, hi: 8000 },
  { id: "click", name: "Click / air", lo: 8000, hi: 16000 },
];
const GRID = [50, 100, 200, 500, 1000, 2000, 5000, 10000];
const ONSET_RMS = 0.015; // quietest hit we react to
const ONSET_JUMP = 2.2; // hit = level jumps this many times above the recent average
const CAPTURE_MS = 450; // how long one hit is held (max per bin)
const PITCH_WAIT_MS = 1000; // keep listening for the note name this long after the hit
const STICK_OUT = 3; // db above the other notes' average before a cell turns red
const MAX_HITS = 80;

let noteOf = () => null; // hz -> { name, midi }, set by the tuner (it owns a4)
let freq = null, lastHit = null; // float32 db per bin
let env = 0, capture = null, cooldown = 0;
let hits = []; // { name, midi, bands: [db rel body], peakHz, hz }
let colors = null, colorsAt = 0;
let hover = null; // x in css px over the canvas
let rate = 48000, bins = 4096;

// ------------------------------------------------------------------ math

const fx = (f, w) => (Math.log(f / F_MIN) / Math.log(F_MAX / F_MIN)) * w;
const xf = (x, w) => F_MIN * (F_MAX / F_MIN) ** (x / w);
const dy = (db, h) => h - ((Math.max(DB_MIN, Math.min(DB_MAX, db)) - DB_MIN) / (DB_MAX - DB_MIN)) * h;
const fmtHz = (f) => (f >= 1000 ? `${(f / 1000).toFixed(f >= 10000 ? 1 : 2)} kHz` : `${Math.round(f)} Hz`);
const fmtShort = (f) => (f >= 1000 ? `${f / 1000}k` : String(f)); // band edges: "2k"
const fmtDb = (d) => `${d > 0 ? "+" : ""}${d.toFixed(1)}`;

// summed power of a band in db (bins are db values)
function bandDb(spec, lo, hi) {
  const hz = rate / 2 / bins;
  let p = 0;
  // [lo, hi) so neighbouring bands never share a bin
  for (let i = Math.max(1, Math.ceil(lo / hz)); i < Math.min(bins, Math.ceil(hi / hz)); i++) p += 10 ** (spec[i] / 10);
  return 10 * Math.log10(p || 1e-12);
}

// loudest bin inside a range
function peak(spec, lo, hi) {
  const hz = rate / 2 / bins;
  let best = Math.floor(lo / hz);
  for (let i = best; i <= Math.min(bins - 1, Math.ceil(hi / hz)); i++) if (spec[i] > spec[best]) best = i;
  return { hz: best * hz, db: spec[best] };
}

// ------------------------------------------------------------------ capture

// one frame from the tuner loop: analyser + this frame's rms and detected pitch (0 = none)
export function specFrame(analyser, sampleRate, rms, hz, now) {
  rate = sampleRate;
  bins = analyser.frequencyBinCount;
  if (!freq || freq.length !== bins) { freq = new Float32Array(bins); lastHit = null; }
  analyser.getFloatFrequencyData(freq);

  // onset: level jumps well above its slow average (a new hit closes a capture still waiting for its pitch)
  const holding = capture && now < capture.holdUntil;
  if (!holding && now > cooldown && rms > ONSET_RMS && rms > env * ONSET_JUMP) {
    if (capture) finish(capture);
    capture = { at: now, holdUntil: now + CAPTURE_MS, spec: Float32Array.from(freq), pitches: [] };
  }
  env = env * 0.9 + rms * 0.1;

  if (capture) {
    // spectrum is held only during the attack window, the pitch may keep coming in after it
    if (now < capture.holdUntil) for (let i = 0; i < bins; i++) if (freq[i] > capture.spec[i]) capture.spec[i] = freq[i];
    if (hz) capture.pitches.push(hz);
    if ((now >= capture.holdUntil && capture.pitches.length >= 3) || now >= capture.at + PITCH_WAIT_MS) {
      finish(capture);
      capture = null;
      cooldown = now + 120;
    }
  }
  draw();
}

// turn a held capture into a hit row
function finish(cap) {
  const body = bandDb(cap.spec, BANDS[0].lo, BANDS[0].hi);
  const bands = BANDS.map((b) => bandDb(cap.spec, b.lo, b.hi) - body);
  // median of the later readings, the attack frames are often noisy
  const p = cap.pitches.slice(cap.pitches.length >> 2).sort((a, b) => a - b);
  const hz = p.length ? p[p.length >> 1] : 0;
  const n = hz ? noteOf(hz) : null;
  lastHit = cap.spec;
  hits.push({ name: n?.name || "?", midi: n?.midi ?? -1, bands, peakHz: peak(cap.spec, 1000, F_MAX).hz, hz });
  if (hits.length > MAX_HITS) hits.shift();
  renderHits();
}

// ------------------------------------------------------------------ drawing

function readColors() {
  const cs = getComputedStyle(document.documentElement);
  const v = (n) => cs.getPropertyValue(n).trim();
  colors = { line: v("--line"), muted: v("--muted"), ink: v("--ink-2"), live: v("--tune"), hit: v("--loop"), soft: v("--surface-2"), danger: v("--danger") };
}

export function draw() {
  const cv = $("#specCanvas");
  if (!cv || cv.closest("[hidden]")) return;
  const now = performance.now();
  if (!colors || now - colorsAt > 2000) { readColors(); colorsAt = now; }
  const dpr = window.devicePixelRatio || 1;
  const w = cv.clientWidth, h = cv.clientHeight;
  if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
  const g = cv.getContext("2d");
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  const plotH = h - 18;

  // bands as alternating shades with their names on top
  g.font = "10px 'IBM Plex Mono', monospace";
  g.textBaseline = "top";
  BANDS.forEach((b, i) => {
    const x0 = fx(b.lo, w), x1 = fx(b.hi, w);
    if (i % 2) { g.fillStyle = colors.soft; g.fillRect(x0, 0, x1 - x0, plotH); }
    g.fillStyle = colors.muted;
    g.textAlign = "center";
    if (x1 - x0 > 40) g.fillText(b.name, (x0 + x1) / 2, 4);
  });

  // frequency grid + labels
  g.strokeStyle = colors.line;
  g.lineWidth = 1;
  g.textBaseline = "bottom";
  for (const f of GRID) {
    const x = Math.round(fx(f, w)) + 0.5;
    g.beginPath(); g.moveTo(x, 16); g.lineTo(x, plotH); g.stroke();
    g.fillStyle = colors.muted;
    g.fillText(f >= 1000 ? `${f / 1000}k` : String(f), x, h);
  }

  // curves: last hit (held max) behind, live in front
  if (lastHit) curve(g, lastHit, w, plotH, colors.hit, 1.5, true);
  if (freq) curve(g, freq, w, plotH, colors.live, 1.5, false);

  // fundamental of the last hit
  const last = hits[hits.length - 1];
  if (last?.hz) {
    const x = fx(last.hz, w);
    g.strokeStyle = colors.hit;
    g.setLineDash([3, 3]);
    g.beginPath(); g.moveTo(x, 16); g.lineTo(x, plotH); g.stroke();
    g.setLineDash([]);
  }

  // hover crosshair + readout
  const out = $("#specHover");
  if (hover != null && hover >= 0 && hover <= w) {
    g.strokeStyle = colors.ink;
    g.globalAlpha = 0.5;
    g.beginPath(); g.moveTo(hover + 0.5, 16); g.lineTo(hover + 0.5, plotH); g.stroke();
    g.globalAlpha = 1;
    const f = xf(hover, w), i = Math.round(f / (rate / 2 / bins));
    const parts = [fmtHz(f)];
    const n = noteOf(f);
    if (n) parts.push(n.name);
    if (freq) parts.push(`live ${freq[i]?.toFixed(0)} dB`);
    if (lastHit) parts.push(`pukulan ${lastHit[i]?.toFixed(0)} dB`);
    out.textContent = parts.join(" · ");
  } else if (out) out.textContent = "arahkan kursor ke grafik untuk lihat frekuensi";
}

// one spectrum as a line (optionally filled), max of the bins under each pixel
function curve(g, spec, w, h, color, width, fill) {
  const hz = rate / 2 / bins;
  g.beginPath();
  for (let x = 0; x <= w; x++) {
    const a = Math.max(1, Math.floor(xf(x, w) / hz)), b = Math.max(a, Math.floor(xf(x + 1, w) / hz));
    let m = -Infinity;
    for (let i = a; i <= Math.min(bins - 1, b); i++) if (spec[i] > m) m = spec[i];
    const y = dy(m, h);
    x ? g.lineTo(x, y) : g.moveTo(x, y);
  }
  g.strokeStyle = color;
  g.lineWidth = width;
  g.stroke();
  if (fill) {
    g.lineTo(w, h); g.lineTo(0, h); g.closePath();
    g.globalAlpha = 0.12; g.fillStyle = color; g.fill(); g.globalAlpha = 1;
  }
}

// ------------------------------------------------------------------ hit summary + per-note table

function renderHits() {
  const box = $("#specHit"), table = $("#specTable");
  if (!box) return;
  const last = hits[hits.length - 1];
  if (!last) {
    box.replaceChildren(el("p", "ear-small center", "Nyalakan mic lalu slap / petik satu nada. Tiap pukulan muncul di sini."));
    table.replaceChildren();
    return;
  }

  // per-note averages, then the average across notes per band
  const notes = new Map();
  for (const h of hits) {
    const k = h.name;
    if (!notes.has(k)) notes.set(k, { name: k, midi: h.midi, n: 0, sum: BANDS.map(() => 0) });
    const r = notes.get(k);
    r.n++;
    h.bands.forEach((d, i) => (r.sum[i] += d));
  }
  const rows = [...notes.values()].map((r) => ({ ...r, avg: r.sum.map((s) => s / r.n) })).sort((a, b) => a.midi - b.midi);
  const mean = BANDS.map((_, i) => rows.reduce((s, r) => s + r.avg[i], 0) / rows.length);
  const loud = (r, i) => rows.length > 1 && i > 0 && r.avg[i] - mean[i] >= STICK_OUT;

  // last hit: one bar per band, relative to body
  const head = el("div", "spec-hit-head");
  head.append(
    el("b", null, last.name === "?" ? "Nada tidak terbaca" : last.name),
    el("span", null, last.hz ? `${last.hz.toFixed(1)} Hz` : ""),
    el("span", null, `puncak di atas 1 kHz: ${fmtHz(last.peakHz)}`),
  );
  const row = rows.find((r) => r.name === last.name);
  const bars = el("div", "spec-bars");
  BANDS.forEach((b, i) => {
    if (!i) return;
    const d = last.bands[i];
    const item = el("div", `spec-bar${row && loud(row, i) ? " loud" : ""}`);
    const track = el("div", "spec-bar-track");
    const fillEl = el("i");
    // -40 db .. +10 db mapped onto the track
    fillEl.style.width = `${Math.max(2, Math.min(100, ((d + 40) / 50) * 100))}%`;
    track.append(fillEl);
    item.append(el("span", null, b.name), el("small", null, `${fmtShort(b.lo)}–${fmtShort(b.hi)} Hz`), track, el("b", null, `${fmtDb(d)} dB`));
    bars.append(item);
  });
  box.replaceChildren(head, bars);

  // table: one row per note, red cells stick out vs the other notes
  const thead = el("tr");
  thead.append(el("th", null, "Nada"), el("th", null, "×"));
  BANDS.slice(1).forEach((b) => { const th = el("th", null, b.name); th.title = `${fmtShort(b.lo)}–${fmtShort(b.hi)} Hz, dB dibanding body`; thead.append(th); });
  const body = rows.map((r) => {
    const tr = el("tr", r.name === last.name ? "cur" : "");
    tr.append(el("td", null, r.name), el("td", null, String(r.n)));
    r.avg.slice(1).forEach((d, j) => {
      const td = el("td", loud(r, j + 1) ? "loud" : "", fmtDb(d));
      if (rows.length > 1) td.title = `${fmtDb(d - mean[j + 1])} dB dibanding rata-rata nada lain`;
      tr.append(td);
    });
    return tr;
  });
  table.replaceChildren(el("thead"), el("tbody"));
  table.tHead.append(thead);
  table.tBodies[0].append(...body);
}

export function clearSpec() {
  hits = [];
  lastHit = null;
  renderHits();
  draw();
}

export function initSpectrum(noteFn) {
  noteOf = noteFn;
  const cv = $("#specCanvas");
  cv.addEventListener("pointermove", (e) => { hover = e.offsetX; draw(); });
  cv.addEventListener("pointerleave", () => { hover = null; draw(); });
  $("#specClear").onclick = clearSpec;
  window.addEventListener("resize", () => draw());
  renderHits();
}
