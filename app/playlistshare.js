// copy the playlist to a phone: scan a qr once, the phone keeps that list from then on.
// no live link afterwards - this is a single handoff, not the running sync metronome.js does.
// reuses the same peerjs handshake as metrosync.js (its free cloud server only does the handshake).

import { newPeer, randomCode, cleanCode } from "./metrosync.js";

const PREFIX = "encore-plshare-";
const ONLINE = "https://encore-player.vercel.app";

export const share = { code: "", status: "", takers: 0 };
let peer = null, onStatus = null;

// link a phone camera opens: always the online site, a laptop's localhost is out of reach for a phone
export function shareUrl() {
  const local = /^(localhost|127\.|\[::1\])/.test(location.hostname);
  return `${local ? ONLINE : location.origin}/#/?copy=${share.code}`;
}

export async function qrSvg(text) {
  await loadScript("/app/vendor/qrcode.js");
  const qr = window.qrcode(0, "M");
  qr.addData(text);
  qr.make();
  return qr.createSvgTag({ cellSize: 5, margin: 3, scalable: true });
}

const libs = new Map();
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

function setStatus(s) { share.status = s; onStatus?.(); }

// web: offer `snapshot` ({list, name}) to whichever phone scans the qr for this code
export async function startShare(snapshot, hook) {
  stopShare();
  onStatus = hook;
  share.code = randomCode();
  share.takers = 0;
  setStatus("Menyiapkan…");
  await openHost(snapshot);
}

async function openHost(snapshot) {
  let p;
  try { p = await newPeer(PREFIX + share.code); } catch { setStatus("Gagal memuat modul sync. Cek koneksi internet."); return; }
  if (!onStatus) { p.destroy(); return; } // stopped while the module was loading
  peer = p;
  p.on("open", () => setStatus("Siap. Scan QR di HP."));
  p.on("connection", (c) => {
    c.on("open", () => {
      c.send({ t: "playlist", list: snapshot.list, name: snapshot.name });
      share.takers++;
      setStatus(`Tersalin ke ${share.takers} perangkat`);
      setTimeout(() => c.close(), 1000); // one-shot: nothing more to send
    });
    c.on("error", () => {});
  });
  p.on("error", (e) => {
    if (!onStatus) return;
    if (e.type === "unavailable-id") {
      // the code is still held from a previous visit: pick a new one and retry
      p.destroy();
      share.code = randomCode();
      openHost(snapshot);
    } else {
      setStatus("Tidak bisa terhubung ke server sync. Coba lagi.");
    }
  });
}

export function stopShare() {
  peer?.destroy();
  peer = null;
  onStatus = null;
  share.code = "";
  share.status = "";
  share.takers = 0;
}

// phone (opened from the qr link): fetch the list once, then disconnect
export function receiveShare(code) {
  return new Promise((resolve, reject) => {
    code = cleanCode(code);
    if (code.length < 4) { reject(new Error("kode tidak valid")); return; }
    let timer;
    const fail = (p, msg) => { clearTimeout(timer); p.destroy(); reject(new Error(msg)); };
    newPeer().then((p) => {
      timer = setTimeout(() => fail(p, "waktu habis, coba scan lagi"), 15000);
      p.on("open", () => {
        const c = p.connect(PREFIX + code, { reliable: true });
        c.on("data", (d) => {
          clearTimeout(timer);
          if (d?.t === "playlist" && Array.isArray(d.list)) resolve({ list: d.list, name: d.name || null });
          else reject(new Error("data tidak valid"));
          setTimeout(() => { c.close(); p.destroy(); }, 300);
        });
        c.on("error", () => fail(p, "koneksi gagal"));
      });
      p.on("error", (e) => fail(p, e.type === "peer-unavailable" ? "kode sudah tidak aktif" : "koneksi gagal"));
    }).catch(reject);
  });
}
