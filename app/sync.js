// keeps the playlist and settings the same on the online site and in the encore app, in one browser.
// the browser keeps the two addresses apart, so the app on this computer holds the shared copy
// (/api/sync) and both pages sync with it. the online site only does this after "Sambungkan".

import { store, SYNC_KEYS, toast } from "./core.js";

const ONLINE = "http://localhost:8781";
const APP = "http://localhost:8765";
const onlineSite = location.origin === ONLINE;
const listeners = new Set();
let connected = false;

// online: only once the visitor connected it (chrome asks for local network access then)
const enabled = () => !onlineSite || store.get("sync-app", false);
const endpoint = () => (onlineSite ? APP : "") + "/api/sync";
const times = () => { try { return JSON.parse(localStorage.getItem("sync-times") || "{}"); } catch { return {}; } };

// local values that are newer than what the app has
function outgoing() {
  const t = times();
  const out = {};
  for (const k of SYNC_KEYS) {
    const raw = localStorage.getItem(k);
    if (raw == null) continue;
    // saved before sync existed: oldest possible, so the shared copy wins if it has one
    out[k] = { v: JSON.parse(raw), t: t[k] || 1 };
  }
  return out;
}

async function syncNow(timeout = 4000) {
  if (!enabled()) return [];
  let shared;
  try {
    const r = await fetch(endpoint(), {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(outgoing()),
      signal: AbortSignal.timeout(timeout), keepalive: true, // still delivered when the tab closes
    });
    if (!r.ok) throw new Error(r.status);
    shared = await r.json();
  } catch {
    connected = false;
    paintChip();
    return [];
  }
  connected = true;
  paintChip();
  const t = times();
  const changed = [];
  for (const [k, item] of Object.entries(shared)) {
    if (!SYNC_KEYS.includes(k) || item.t <= (t[k] || 0)) continue;
    localStorage.setItem(k, JSON.stringify(item.v));
    t[k] = item.t;
    changed.push(k);
  }
  localStorage.setItem("sync-times", JSON.stringify(t));
  if (changed.length) listeners.forEach((fn) => fn(changed));
  return changed;
}

export const onRemote = (fn) => listeners.add(fn);
// base url of the encore app for shared data, or null when this page doesn't share with it
export const appBase = () => (enabled() ? (onlineSite ? APP : "") : null);
export const isConnected = () => connected;

// online site: turn sync on (button on the breakdown page); resolves whether the app answered
export async function connect() {
  store.set("sync-app", true);
  await syncNow(30000); // the first call waits for chrome's permission prompt
  if (connected) dispatchEvent(new Event("encore-connected")); // e.g. playlist shares its audio now
  return connected;
}

// online playlist page: shows whether it shares with the encore app, and connects on click.
// phones and tablets have no encore app, so they don't get it
function paintChip() {
  const b = document.getElementById("syncChip");
  if (!b) return;
  b.hidden = !onlineSite || matchMedia("(pointer: coarse)").matches;
  if (b.hidden || b.dataset.busy) return;
  b.classList.toggle("ghost", connected);
  b.textContent = connected ? "✓ Sama dengan Encore App" : "Sambungkan ke Encore App";
  b.title = connected ? "Playlist dan audio di sini dibagi dengan Encore App di komputer ini"
    : "Samakan playlist dan audio dengan Encore App di komputer ini (app harus sedang jalan)";
  b.onclick = connected ? null : async () => {
    b.dataset.busy = "1";
    b.disabled = true;
    b.textContent = "Menyambungkan…";
    const ok = await connect();
    delete b.dataset.busy;
    b.disabled = false;
    paintChip();
    toast(ok ? "Tersambung! Playlist dan audio di sini sekarang sama dengan Encore App."
      : "Encore App belum terdeteksi. Pastikan app-nya jalan, lalu klik Izinkan kalau browser bertanya soal jaringan lokal.", { error: !ok, ms: 8000 });
  };
}
paintChip();

// push local changes soon after they happen, pull the other page's changes now and then
let pushTimer = null;
store.onSync = () => { clearTimeout(pushTimer); pushTimer = setTimeout(syncNow, 400); };
// polling only while the page is in front; leaving it sends what changed right away
setInterval(() => { if (!document.hidden) syncNow(); }, 4000);
document.addEventListener("visibilitychange", () => { clearTimeout(pushTimer); syncNow(); });
addEventListener("focus", () => syncNow());

// before the playlist reads its saved state: take over what the other page saved (short wait)
await syncNow(1500);
