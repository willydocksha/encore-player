// score view: a transcribed melody (vocals or bass) as not balok, not angka, or letter names.
// notes are snapped to a 1/16 grid relative to the detected beats, so live tempo drift keeps bars intact.

const SHARP = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const FLAT = ["C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B"];
const MAJOR_FLAT = [5, 10, 3, 8, 1];
const MINOR_FLAT = [2, 7, 0, 5, 10];
const FIFTHS = { 0: 0, 7: 1, 2: 2, 9: 3, 4: 4, 11: 5, 6: 6, 1: -5, 8: -4, 3: -3, 10: -2, 5: -1 };
const mod12 = (x) => ((x % 12) + 12) % 12;
const pcOf = (n) => { const i = SHARP.indexOf(n); return i >= 0 ? i : FLAT.indexOf(n); };
const pretty = (s) => s.replace(/#/g, "♯").replace(/(?<=[A-G])b/g, "♭");

// key after transposing, with the spelling it implies
export function keyInfo(key, transpose) {
  const [root, mode] = (key || "C major").split(" ");
  const minor = mode === "minor";
  const r = mod12((pcOf(root) < 0 ? 0 : pcOf(root)) + transpose);
  const major = minor ? mod12(r + 3) : r; // do of not angka is the relative major tonic
  const flat = (minor ? MINOR_FLAT : MAJOR_FLAT).includes(r);
  const names = flat ? FLAT : SHARP;
  return { root: r, minor, major, flat, names, fifths: FIFTHS[major], vfKey: names[r] + (minor ? "m" : ""), label: names[r] + (minor ? "m" : "") };
}

// key sounding at time t: songs with a modulation carry key sections [{t, key}]
export function keyAt(song, t) {
  let k = song.key;
  for (const s of song.keys || []) if (s.t <= t + 0.05) k = s.key;
  return k;
}

// key label for chips: "G major → A major" on a modulation
export function keysLabel(song) {
  const ks = (song.keys || []).map((s) => s.key);
  return ks.length > 1 ? ks.join(" → ") : song.key;
}

// first index with key(arr[i]) >= x
function lowerBound(arr, x, key) {
  let lo = 0, hi = arr.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (key(arr[m]) < x) lo = m + 1; else hi = m; }
  return lo;
}

// ---------------------------------------------------------------- model

// bars from the downbeats, each with its own beat times; U0 = first 1/16 unit of the bar
function barGrid(song) {
  const beats = song.beats;
  let starts = song.downbeats?.length > 1 ? [...song.downbeats] : beats.filter((_, i) => i % 4 === 0);
  if (!starts.length) starts = [0];
  if (beats[0] < starts[0] - 0.1) starts.unshift(beats[0]); // pickup bar
  const bars = [];
  let U = 0;
  starts.forEach((s, i) => {
    const e = starts[i + 1] ?? song.duration;
    const bt = beats.filter((b) => b >= s - 0.02 && b < e - 0.02);
    if (!bt.length) bt.push(s);
    bt[0] = s;
    bars.push({ n: i + 1, s, e, bt: [...bt, e], nb: bt.length, units: bt.length * 4, U0: U });
    U += bt.length * 4;
  });
  return bars;
}

// time -> fractional 1/16 unit and back
function toUnit(bars, t) {
  const bar = bars[Math.max(0, lowerBound(bars, t + 1e-9, (b) => b.s) - 1)];
  const k = Math.max(0, Math.min(bar.nb - 1, lowerBound(bar.bt, t + 1e-9, (x) => x) - 1));
  const span = bar.bt[k + 1] - bar.bt[k] || 1;
  return bar.U0 + k * 4 + Math.max(0, Math.min(1, (t - bar.bt[k]) / span)) * 4;
}
function unitTime(bars, g) {
  const bar = bars[Math.max(0, lowerBound(bars, g + 1e-9, (b) => b.U0) - 1)];
  const u = Math.min(g - bar.U0, bar.units);
  const k = Math.min(bar.nb - 1, Math.floor(u / 4));
  return bar.bt[k] + ((u - k * 4) / 4) * (bar.bt[k + 1] - bar.bt[k]);
}

// split a note or rest into durations that can be written, breaking at beats when off the beat
function pieces(pos, len, rest, barUnits) {
  const out = [];
  while (len > 0) {
    let d;
    if (rest && pos === 0 && len === barUnits) d = barUnits; // whole-bar rest
    else if (pos % 4 === 0) {
      const opts = rest ? [16, 8, 4, 2, 1] : [16, 12, 8, 6, 4, 3, 2, 1];
      d = opts.find((x) => x <= len && pos + x <= barUnits && (x !== 16 || (pos === 0 && barUnits === 16)) && (!rest || x < 8 || pos % 8 === 0));
    } else {
      const room = Math.min(len, 4 - (pos % 4));
      d = pos % 2 === 1 ? 1 : room >= 2 ? 2 : 1;
    }
    out.push([pos, d]);
    pos += d;
    len -= d;
  }
  return out;
}
const DUR = { 16: ["w", 0], 12: ["h", 1], 8: ["h", 0], 6: ["q", 1], 4: ["q", 0], 3: ["8", 1], 2: ["8", 0], 1: ["16", 0] };

// the whole score of one part: bars with written pieces, chords, key and clef
export function buildScore(song, part, transpose, chordLabel) {
  const bars = barGrid(song);
  for (const bar of bars) bar.key = keyInfo(keyAt(song, bar.s), transpose);
  let raw = (part === "vocals" ? song.vocals?.notes : song.notes) || [];
  if (part === "vocals") raw = raw.filter((n) => (n.v ?? 1) >= 0.2); // quiet notes are mostly bleed
  // snap to the grid, one note at a time (later notes cut earlier ones)
  // fast songs snap to eighths: sixteenths there are mostly ornaments
  const q = (song.bpm || 100) >= 110 ? 2 : 1;
  const snap = (t) => Math.round(toUnit(bars, t) / q) * q;
  const ev = [];
  for (const n of [...raw].sort((a, b) => a.t - b.t)) {
    const g0 = snap(n.t);
    let g1 = snap(n.t + n.d);
    if (g1 <= g0) { if (n.d < (15 / (song.bpm || 100)) * q * 0.6) continue; g1 = g0 + q; }
    const last = ev.at(-1);
    if (last && last.g0 === g0) { if (n.d * (n.v ?? 1) > last.w) Object.assign(last, { g1, midi: n.midi + transpose, w: n.d * (n.v ?? 1) }); continue; }
    if (last && last.g1 > g0) last.g1 = g0;
    ev.push({ g0, g1, midi: n.midi + transpose, w: n.d * (n.v ?? 1) });
  }
  // octave shown: bass and low voices are written an octave up (8vb clef)
  const ms = ev.map((e) => e.midi).sort((a, b) => a - b);
  const med = ms.length ? ms[ms.length >> 1] : 60;
  const clef = part === "bass" ? "bass" : "treble";
  const shift = part === "bass" || med < 62 ? 12 : 0; // male voices read better on a tenor (8vb) clef
  // per bar: notes and rests split into written pieces
  let ei = 0;
  for (const bar of bars) {
    const end = bar.U0 + bar.units, items = [];
    let pos = bar.U0;
    const push = (g0, g1, midi, tieIn, tieOut) => {
      const ps = pieces(g0 - bar.U0, g1 - g0, midi == null, bar.units);
      ps.forEach(([u, d], i) => {
        const [dur, dots] = DUR[d] || ["w", 0];
        items.push({ u, len: d, dur, dots, midi, full: midi == null && d === bar.units,
          tieIn: i > 0 || tieIn, tieOut: i < ps.length - 1 || tieOut,
          t0: unitTime(bars, bar.U0 + u), t1: unitTime(bars, bar.U0 + u + d) });
      });
    };
    while (ei < ev.length && ev[ei].g1 <= bar.U0) ei++;
    for (let j = ei; j < ev.length && ev[j].g0 < end; j++) {
      const e = ev[j];
      const a = Math.max(e.g0, bar.U0), b = Math.min(e.g1, end);
      if (a > pos) push(pos, a, null, false, false);
      push(a, b, e.midi, e.g0 < bar.U0, e.g1 > end);
      pos = b;
    }
    if (pos < end) push(pos, end, null, false, false);
    bar.items = items;
    bar.chords = [];
  }
  // chord changes at their grid position
  let prev = "N";
  for (const c of song.chords || []) {
    if (c.label === prev) continue;
    prev = c.label;
    if (c.label === "N") continue;
    const g = Math.round(toUnit(bars, c.t));
    const bar = bars[Math.max(0, lowerBound(bars, g + 1e-9, (b) => b.U0) - 1)];
    if (g - bar.U0 < bar.units) bar.chords.push({ u: g - bar.U0, label: chordLabel(c.label, c.t) });
  }
  // drop empty bars at the start and end
  const empty = (b) => b.items.every((x) => x.midi == null) && !b.chords.length;
  let a = 0, z = bars.length;
  while (a < z && empty(bars[a])) a++;
  while (z > a && empty(bars[z - 1])) z--;
  const counts = {};
  bars.forEach((b) => { counts[b.nb] = (counts[b.nb] || 0) + 1; });
  const beats = +Object.entries(counts).sort((x, y) => y[1] - x[1])[0]?.[0] || 4;
  const shown = bars.slice(a, z);
  const key = shown[0]?.key || keyInfo(song.key, transpose);
  return { bars: shown, key, clef, shift, beats, bpm: song.bpm, part, notes: ev.length };
}

// ---------------------------------------------------------------- not balok (vexflow)

let vexLoad = null;
export function loadVex() {
  if (window.Vex) return Promise.resolve();
  vexLoad ||= new Promise((ok, fail) => {
    const s = document.createElement("script");
    s.src = "/app/vendor/vexflow-bravura.js";
    s.onload = ok;
    s.onerror = () => { vexLoad = null; fail(new Error("vexflow gagal dimuat")); };
    document.head.append(s);
  });
  return vexLoad;
}

const vfKeyOf = (key, midi) => `${key.names[mod12(midi)].toLowerCase()}/${Math.floor(midi / 12) - 1}`;

// draws the staff into box; returns timed items for the playback cursor
export function renderStaff(box, model, { scale = 1, ink = "#000", chordInk = "#555" } = {}) {
  const VF = window.Vex.Flow;
  box.replaceChildren();
  const W = box.clientWidth / scale;
  const keyW = 18 + Math.abs(model.key.fifths) * 10;
  const perLine = Math.max(1, Math.min(6, Math.floor((W - 20) / 210)));
  const lineH = 110;
  const lines = Math.ceil(model.bars.length / perLine);
  const renderer = new VF.Renderer(box, VF.Renderer.Backends.SVG);
  renderer.resize(box.clientWidth, (lines * lineH + 30) * scale);
  const ctx = renderer.getContext();
  ctx.scale(scale, scale);
  ctx.setFillStyle(ink);
  ctx.setStrokeStyle(ink);
  const items = [];
  const clefAnno = model.shift ? "8vb" : undefined;
  let prevBeats = 0, lastNote = null, prevKey = null;
  const ties = [];
  model.bars.forEach((bar, bi) => {
    const li = Math.floor(bi / perLine), col = bi % perLine;
    // first bar of a line also holds clef and key
    const head = col === 0 ? 34 + keyW + (bi === 0 ? 24 : 0) : 0;
    const unit = (W - 12 - 34 - keyW - 24) / perLine;
    const lineHead = 34 + keyW + (bi - col === 0 ? 24 : 0);
    const x = 6 + (col === 0 ? 0 : lineHead + col * unit);
    const w = unit + head;
    const y = 10 + li * lineH;
    const stave = new VF.Stave(x, y + 18, w);
    stave.setMeasure(bar.n);
    if (col === 0) stave.addClef(model.clef, "default", clefAnno).addKeySignature(bar.key.vfKey);
    else if (prevKey && bar.key.vfKey !== prevKey) stave.addKeySignature(bar.key.vfKey, prevKey); // modulation
    prevKey = bar.key.vfKey;
    if (bar.nb !== prevBeats) stave.addTimeSignature(`${bar.nb}/4`);
    prevBeats = bar.nb;
    stave.setContext(ctx).draw();
    // notes and rests
    const restKey = model.clef === "bass" ? "d/3" : "b/4";
    const notes = bar.items.map((it) => {
      const n = new VF.StaveNote({ clef: model.clef, keys: [it.midi == null ? restKey : vfKeyOf(bar.key, it.midi + model.shift)],
        duration: it.dur + (it.midi == null ? "r" : ""), align_center: it.full, auto_stem: true });
      if (it.dots) VF.Dot.buildAndAttach([n], { all: true });
      return n;
    });
    const voice = new VF.Voice({ num_beats: bar.nb, beat_value: 4 }).setMode(VF.Voice.Mode.SOFT).addTickables(notes);
    VF.Accidental.applyAccidentals([voice], bar.key.vfKey);
    const beams = VF.Beam.generateBeams(notes, { groups: [new VF.Fraction(1, 4)] });
    new VF.Formatter().joinVoices([voice]).format([voice], Math.max(40, stave.getNoteEndX() - stave.getNoteStartX() - 12));
    voice.draw(ctx, stave);
    beams.forEach((b) => b.setContext(ctx).draw());
    // ties, also across bars on the same line
    bar.items.forEach((it, i) => {
      if (it.midi != null && it.tieIn && lastNote?.it.tieOut && lastNote.li === li) ties.push([lastNote.n, notes[i]]);
      if (it.midi != null) lastNote = { n: notes[i], it, li };
    });
    // chord names above the staff
    const xs = notes.map((n) => n.getAbsoluteX());
    ctx.save();
    ctx.setFont("IBM Plex Mono, Menlo, monospace", 13, "bold");
    ctx.setFillStyle(chordInk);
    for (const c of bar.chords) {
      const i = Math.max(0, bar.items.findIndex((it) => c.u >= it.u && c.u < it.u + it.len));
      const it = bar.items[i];
      const nx = xs[i + 1] ?? stave.getNoteEndX();
      ctx.fillText(pretty(c.label), xs[i] + ((c.u - it.u) / it.len) * (nx - xs[i]) - 4, stave.getYForLine(0) - 16);
    }
    ctx.restore();
    const top = stave.getYForLine(0) - 6, bottom = stave.getYForLine(4) + 6;
    notes.forEach((n, i) => items.push({ t0: bar.items[i].t0, t1: bar.items[i].t1, x0: xs[i], x1: xs[i + 1] ?? stave.getNoteEndX(), top, bottom, note: n, bar: bi }));
  });
  for (const [a, b] of ties) new VF.StaveTie({ first_note: a, last_note: b, first_indices: [0], last_indices: [0] }).setContext(ctx).draw();
  for (const it of items) it.el = it.note.getSVGElement?.() || null;
  return items.map((it) => ({ ...it, x0: it.x0 * scale, x1: it.x1 * scale, top: it.top * scale, bottom: it.bottom * scale }));
}

// ---------------------------------------------------------------- not angka / letter names

const DEG_SHARP = [["1"], ["1", "♯"], ["2"], ["2", "♯"], ["3"], ["4"], ["4", "♯"], ["5"], ["5", "♯"], ["6"], ["6", "♯"], ["7"]];
const DEG_FLAT = [["1"], ["2", "♭"], ["2"], ["3", "♭"], ["3"], ["4"], ["5", "♭"], ["5"], ["6", "♭"], ["6"], ["7", "♭"], ["7"]];

// builds the number (or letter) notation as html; returns timed items for highlighting
export function renderNumbers(box, model, letters, el) {
  box.replaceChildren();
  const { key } = model;
  const pitched = model.bars.flatMap((b) => b.items.filter((x) => x.midi != null).map((x) => x.midi)).sort((a, b) => a - b);
  const med = pitched.length ? pitched[pitched.length >> 1] : 60;
  const baseOf = (k) => med - mod12(med - k.major); // the octave of do just below the middle note has no dots
  const head = el("div", "nb-head");
  head.append(el("b", "", letters ? `Kunci ${pretty(key.label)}` : `do = ${pretty(key.names[key.major])}`), el("span", "", `${model.beats}/4`), el("span", "", `${Math.round(model.bpm)} BPM`));
  const wrap = el("div", "nb-lines");
  const items = [];
  let prevKey = key;
  model.bars.forEach((bar, bi) => {
    const barEl = el("div", "nb-bar");
    const num = el("span", "nb-num", String(bar.n));
    barEl.append(num);
    const bk = bar.key, base = baseOf(bk);
    // modulation: the new key above its first bar
    if (bk.label !== prevKey.label) barEl.append(el("span", "nb-key", letters ? `Kunci ${pretty(bk.label)}` : `do = ${pretty(bk.names[bk.major])}`));
    prevKey = bk;
    // slice every piece at the beats; the first slice of a note shows it, the rest are dots
    const beats = Array.from({ length: bar.nb }, () => []);
    for (const it of bar.items) {
      let u = it.u;
      const end = it.u + it.len;
      let first = true;
      while (u < end) {
        const k = Math.floor(u / 4), stop = Math.min(end, (k + 1) * 4);
        beats[Math.min(k, bar.nb - 1)].push({ it, u, len: stop - u, show: it.midi == null || (first && !it.tieIn) });
        first = false;
        u = stop;
      }
    }
    beats.forEach((slices) => {
      const beatEl = el("span", "nb-beat");
      for (const s of slices) {
        const lv = s.len >= 4 ? 0 : s.len >= 2 ? 1 : 2;
        const node = el("span", "nb-it");
        node.dataset.l = lv;
        let txt = ".", acc = "", oct = 0;
        if (s.it.midi == null) txt = "0";
        else if (s.show) {
          const off = mod12(s.it.midi - bk.major);
          if (letters) {
            const nm = bk.names[mod12(s.it.midi)];
            txt = nm[0];
            acc = nm.length > 1 ? (nm[1] === "#" ? "♯" : "♭") : "";
          } else [txt, acc = ""] = (bk.flat ? DEG_FLAT : DEG_SHARP)[off];
          oct = Math.floor((s.it.midi - base) / 12);
        }
        const n = el("span", "nb-n", txt);
        if (acc) n.append(el("sup", "", acc));
        if (oct > 0) node.append(el("span", "nb-up", "•".repeat(Math.min(oct, 3))));
        node.append(n);
        if (oct < 0) node.append(el("span", "nb-dn", "•".repeat(Math.min(-oct, 3))));
        if (s.len === 3) n.append(el("span", "nb-dot", "."));
        // chord name over the slice where it changes
        const ch = bar.chords.find((c) => c.u >= s.u && c.u < s.u + s.len);
        if (ch) node.append(el("span", "nb-chord", pretty(ch.label)));
        beatEl.append(node);
        // each slice gets its own share of the note's time
        const f = (v) => s.it.t0 + ((v - s.it.u) / s.it.len) * (s.it.t1 - s.it.t0);
        items.push({ t0: f(s.u), t1: f(s.u + s.len), el: node, bar: bi, barEl });
      }
      barEl.append(beatEl);
    });
    wrap.append(barEl);
  });
  box.append(head, wrap);
  return items;
}

// ---------------------------------------------------------------- musicxml export

const TYPE = { w: "whole", h: "half", q: "quarter", 8: "eighth", 16: "16th" };
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function harmonyXml(label, offset) {
  const m = /^([A-G])([#b]?)(.*?)(?:\/([A-G])([#b]?))?$/.exec(label);
  if (!m) return "";
  const alter = (a) => (a === "#" ? "<root-alter>1</root-alter>" : a === "b" ? "<root-alter>-1</root-alter>" : "");
  const suf = m[3];
  const kind = { "": "major", m: "minor", 7: "dominant", maj7: "major-seventh", m7: "minor-seventh", sus2: "suspended-second", sus4: "suspended-fourth", dim: "diminished" }[suf]
    || (suf.startsWith("m") && !suf.startsWith("maj") ? "minor" : "major");
  const bass = m[4] ? `<bass><bass-step>${m[4]}</bass-step>${m[5] === "#" ? "<bass-alter>1</bass-alter>" : m[5] === "b" ? "<bass-alter>-1</bass-alter>" : ""}</bass>` : "";
  return `<harmony><root><root-step>${m[1]}</root-step>${alter(m[2])}</root><kind text="${esc(suf)}">${kind}</kind>${bass}${offset ? `<offset>${offset}</offset>` : ""}</harmony>`;
}

export function toMusicXml(model, title, partName) {
  const { key } = model;
  const clef = model.clef === "bass" ? "<sign>F</sign><line>4</line>" : "<sign>G</sign><line>2</line>";
  const clefOct = model.shift ? "<clef-octave-change>-1</clef-octave-change>" : "";
  let prevBeats = 0, prevKey = null;
  const measures = model.bars.map((bar, i) => {
    let x = `<measure number="${i + 1}">`;
    const bk = bar.key || key;
    const newKey = bk.label !== prevKey;
    prevKey = bk.label;
    if (i === 0 || bar.nb !== prevBeats || newKey) {
      x += "<attributes>";
      if (i === 0) x += "<divisions>4</divisions>";
      if (newKey) x += `<key><fifths>${bk.fifths}</fifths><mode>${bk.minor ? "minor" : "major"}</mode></key>`;
      x += `<time><beats>${bar.nb}</beats><beat-type>4</beat-type></time>`;
      if (i === 0) x += `<clef>${clef}${clefOct}</clef>`;
      x += "</attributes>";
      if (i === 0) x += `<direction placement="above"><direction-type><metronome><beat-unit>quarter</beat-unit><per-minute>${Math.round(model.bpm)}</per-minute></metronome></direction-type><sound tempo="${Math.round(model.bpm)}"/></direction>`;
    }
    prevBeats = bar.nb;
    const chords = [...bar.chords];
    for (const it of bar.items) {
      // chord symbols that start inside this note go right before it
      while (chords.length && chords[0].u < it.u + it.len) {
        const c = chords.shift();
        x += harmonyXml(c.label, Math.max(0, c.u - it.u));
      }
      x += "<note>";
      if (it.midi == null) x += it.full ? '<rest measure="yes"/>' : "<rest/>";
      else {
        const nm = bk.names[mod12(it.midi)];
        x += `<pitch><step>${nm[0]}</step>${nm.length > 1 ? `<alter>${nm[1] === "#" ? 1 : -1}</alter>` : ""}<octave>${Math.floor(it.midi / 12) - 1}</octave></pitch>`;
      }
      x += `<duration>${it.len}</duration>`;
      if (it.midi != null && it.tieIn) x += '<tie type="stop"/>';
      if (it.midi != null && it.tieOut) x += '<tie type="start"/>';
      x += "<voice>1</voice>";
      if (!it.full) x += `<type>${TYPE[it.dur]}</type>${"<dot/>".repeat(it.dots)}`;
      if (it.midi != null && (it.tieIn || it.tieOut)) x += `<notations>${it.tieIn ? '<tied type="stop"/>' : ""}${it.tieOut ? '<tied type="start"/>' : ""}</notations>`;
      x += "</note>";
    }
    return x + "</measure>";
  });
  return `<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 4.0 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">
<score-partwise version="4.0"><work><work-title>${esc(title)}</work-title></work><identification><encoding><software>Encore</software></encoding></identification>
<part-list><score-part id="P1"><part-name>${esc(partName)}</part-name></score-part></part-list>
<part id="P1">${measures.join("\n")}</part></score-partwise>
`;
}
