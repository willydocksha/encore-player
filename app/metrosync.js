// metronome sync: one device leads, the others follow its beat over webrtc.
// peerjs' free cloud server only does the handshake, beats and settings then go device to device.
// followers measure how far their clock is from the leader's (ping/pong, best of the fastest replies),
// so every device can put the same beat on the same moment.

import { store, toast } from "./core.js";

const PREFIX = "encore-metro-";
const ALPHA = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O or 1/I
const ONLINE = "https://encore-player.vercel.app";

// shared with metronome.js: role "host" | "follower" | null, offset = leader clock minus ours (ms)
export const sync = {
  role: null, code: "", offset: 0, rtt: null, peers: 0, linked: false, status: "",
  latency: store.get("metro-latency", 0), // ms this device's sound is moved earlier (bluetooth speakers lag)
};

let hooks = null; // { state(), apply(s), act(p), onStatus() } from metronome.js
let peer = null, conns = [], hostConn = null;
let pingTimer = 0, retryTimer = 0, samples = [], pings = 0, idTries = 0;
const libs = new Map();

export const clock = () => performance.timeOrigin + performance.now();

export function initSync(h) {
  hooks = h;
  // the leader reloaded: lead again with the same code
  if (sessionStorage.getItem("metro-sync-host")) lead();
}

// ------------------------------------------------------------------ helpers

// classic scripts in app/vendor, loaded once on first use
function loadScript(src) {
  if (!libs.has(src)) {
    libs.set(src, new Promise((ok, fail) => {
      const s = document.createElement("script");
      s.src = src;
      s.onload = ok;
      s.onerror = () => { libs.delete(src); fail(new Error("gagal memuat " + src)); };
      document.head.append(s);
    }));
  }
  return libs.get(src);
}

export async function newPeer(id) {
  await loadScript("/app/vendor/peerjs.min.js");
  return id ? new window.Peer(id, { debug: 0 }) : new window.Peer({ debug: 0 });
}

export const randomCode = () => Array.from(crypto.getRandomValues(new Uint8Array(5)), (b) => ALPHA[b % ALPHA.length]).join("");
export const cleanCode = (s) => String(s || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);

// link a phone camera opens: always the online site, a laptop's localhost is out of reach for a phone
export function joinUrl() {
  const local = /^(localhost|127\.|\[::1\])/.test(location.hostname);
  return `${local ? ONLINE : location.origin}/#/metronome?sync=${sync.code}`;
}

export async function qrSvg(text) {
  await loadScript("/app/vendor/qrcode.js");
  const qr = window.qrcode(0, "M");
  qr.addData(text);
  qr.make();
  return qr.createSvgTag({ cellSize: 5, margin: 3, scalable: true });
}

function setStatus(s, linked = sync.linked) {
  sync.status = s;
  sync.linked = linked;
  hooks?.onStatus();
}

// ------------------------------------------------------------------ leader

export async function lead() {
  leave(true);
  sync.role = "host";
  sync.offset = 0;
  sync.rtt = null;
  // a reload keeps the same code, so followers reconnect by themselves
  sync.code = sessionStorage.getItem("metro-sync-code") || randomCode();
  sessionStorage.setItem("metro-sync-code", sync.code);
  sessionStorage.setItem("metro-sync-host", "1");
  idTries = 0;
  setStatus("Menyiapkan…", false);
  await openHost();
}

async function openHost() {
  let p;
  try { p = await newPeer(PREFIX + sync.code); } catch { setStatus("Gagal memuat modul sync. Cek koneksi internet.", false); return; }
  if (sync.role !== "host") { p.destroy(); return; }
  peer = p;
  p.on("open", () => setStatus("Siap. Scan QR atau masukkan kode di perangkat lain.", true));
  p.on("connection", (c) => {
    c.on("open", () => {
      conns.push(c);
      c.send({ t: "state", s: hooks.state() });
      sendPeers();
    });
    c.on("data", (d) => onHostData(c, d));
    c.on("close", () => { conns = conns.filter((x) => x !== c); sendPeers(); });
    c.on("error", () => {});
  });
  // lost the handshake server only: open links keep working, just reconnect for new followers
  p.on("disconnected", () => { if (sync.role === "host" && !p.destroyed) setTimeout(() => !p.destroyed && p.reconnect(), 1500); });
  p.on("error", (e) => {
    if (sync.role !== "host") return;
    if (e.type === "unavailable-id") {
      // the code is still held from a previous visit (or taken): wait a bit, then pick a new one
      p.destroy();
      if (++idTries > 3) { sync.code = randomCode(); sessionStorage.setItem("metro-sync-code", sync.code); idTries = 0; }
      setTimeout(() => sync.role === "host" && openHost(), 2500);
      setStatus("Menyiapkan kode…", false);
    } else if (["network", "server-error", "socket-error", "socket-closed"].includes(e.type)) {
      setStatus("Tidak bisa terhubung ke server sync. Mencoba lagi…", conns.length > 0);
    }
  });
}

function onHostData(c, d) {
  if (!d || typeof d !== "object") return;
  if (d.t === "ping") c.send({ t: "pong", a: d.a, b: clock() });
  else if (d.t === "set" && d.p) hooks.act(d.p);
}

function sendPeers() {
  sync.peers = conns.length;
  for (const c of conns) if (c.open) c.send({ t: "peers", n: conns.length });
  hooks?.onStatus();
}

// leader: push the shared state to every follower
export function broadcast() {
  if (sync.role !== "host") return;
  const s = hooks.state();
  for (const c of conns) if (c.open) c.send({ t: "state", s });
}

// ------------------------------------------------------------------ follower

export async function follow(code) {
  code = cleanCode(code);
  if (code.length < 4) { toast("Kode sync tidak valid", { error: true }); return; }
  if (sync.role === "follower" && sync.code === code && peer && !peer.destroyed) return;
  leave(true);
  sessionStorage.removeItem("metro-sync-host");
  sync.role = "follower";
  sync.code = code;
  sync.offset = 0;
  sync.rtt = null;
  setStatus("Menghubungkan…", false);
  try { peer = await newPeer(); } catch { setStatus("Gagal memuat modul sync. Cek koneksi internet.", false); return; }
  if (sync.role !== "follower") { peer.destroy(); return; }
  peer.on("open", connect);
  peer.on("disconnected", () => { if (sync.role === "follower" && !peer.destroyed) setTimeout(() => !peer.destroyed && peer.reconnect(), 1500); });
  peer.on("error", (e) => {
    if (sync.role !== "follower") return;
    if (e.type === "peer-unavailable") setStatus(`Kode ${sync.code} belum aktif. Pastikan perangkat pemimpin membuka Sync. Mencoba lagi…`, false);
    else setStatus("Koneksi bermasalah. Mencoba lagi…", false);
    retry();
  });
  hooks.onStatus();
}

function connect() {
  if (sync.role !== "follower" || !peer || peer.destroyed) return;
  hostConn?.close();
  const c = peer.connect(PREFIX + sync.code, { reliable: true });
  hostConn = c;
  c.on("open", () => {
    clearTimeout(retryTimer);
    setStatus("Terhubung", true);
    samples = [];
    pings = 0;
    ping();
  });
  c.on("data", onFollowerData);
  c.on("close", () => {
    if (hostConn !== c || sync.role !== "follower") return;
    clearTimeout(pingTimer);
    // keep the beat going on the last known timing while reconnecting
    setStatus("Pemimpin terputus. Ketukan tetap jalan, mencoba menyambung lagi…", false);
    retry();
  });
  c.on("error", () => {});
}

function retry() {
  clearTimeout(retryTimer);
  retryTimer = setTimeout(() => {
    if (sync.role !== "follower") return;
    if (!peer || peer.destroyed) follow(sync.code);
    else if (peer.disconnected) peer.reconnect();
    else connect();
  }, 3000);
}

// ping fast at first to settle the clock offset, then now and then to follow drift
function ping() {
  clearTimeout(pingTimer);
  if (sync.role !== "follower" || !hostConn?.open) return;
  hostConn.send({ t: "ping", a: clock() });
  pings++;
  pingTimer = setTimeout(ping, pings < 12 ? 300 : 3000);
}

function onFollowerData(d) {
  if (!d || typeof d !== "object") return;
  if (d.t === "state" && d.s) hooks.apply(d.s);
  else if (d.t === "peers") { sync.peers = d.n; hooks.onStatus(); }
  else if (d.t === "pong") {
    const c = clock(), rtt = c - d.a;
    // leader clock minus ours, assuming the reply took half the round trip
    samples.push({ rtt, off: d.b - (d.a + c) / 2 });
    if (samples.length > 16) samples.shift();
    const best = samples.reduce((a, b) => (b.rtt < a.rtt ? b : a));
    sync.offset = best.off;
    sync.rtt = best.rtt;
    hooks.onStatus();
  }
}

// follower: ask the leader to change something (it echoes the new state back to everyone)
export function request(p) {
  if (hostConn?.open) { hostConn.send({ t: "set", p }); return true; }
  toast("Belum terhubung ke perangkat pemimpin");
  return false;
}

// ------------------------------------------------------------------ end

export function leave(quiet = false) {
  clearTimeout(pingTimer);
  clearTimeout(retryTimer);
  for (const c of conns) c.close();
  conns = [];
  hostConn?.close();
  hostConn = null;
  peer?.destroy();
  peer = null;
  // ended on purpose: forget the code (a reload keeps it, so followers can reconnect)
  if (!quiet) { sessionStorage.removeItem("metro-sync-code"); sessionStorage.removeItem("metro-sync-host"); }
  sync.role = null;
  sync.code = "";
  sync.offset = 0;
  sync.rtt = null;
  sync.peers = 0;
  sync.linked = false;
  sync.status = "";
  if (!quiet) hooks?.onStatus();
}

export function setLatency(ms) {
  sync.latency = Math.max(-300, Math.min(300, Math.round(ms)));
  store.set("metro-latency", sync.latency);
}

