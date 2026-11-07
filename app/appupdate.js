// encore app only: a small banner when a newer app release is out on github (/api/app/check).
// the ui updates itself (uiupdate.js), but the app itself needs a new download.

import { $ } from "./core.js";

const DISMISSED = "app-update-dismissed";

// the dismissed version stays on this device only (not synced to the online site)
function dismissed() {
  try { return localStorage.getItem(DISMISSED); } catch { return null; }
}
function dismiss(v) {
  try { localStorage.setItem(DISMISSED, v); } catch {}
}

export async function checkAppUpdate() {
  // ask the app; the web version has no such route, offline just answers "not available"
  let info;
  try {
    const r = await fetch("/api/app/check", { cache: "no-store", signal: AbortSignal.timeout(10000) });
    if (!r.ok) return;
    info = await r.json();
  } catch { return; }
  if (!info.available || !info.latest || dismissed() === info.latest) return;
  // build the banner: text, release link, close button
  const bar = document.createElement("div");
  bar.className = "app-update";
  bar.setAttribute("role", "status");
  bar.innerHTML = '<svg class="app-update-icon"><use href="#i-download"/></svg>'
    + '<span class="app-update-text"><b></b><small></small></span>'
    + '<a class="btn primary" target="_blank" rel="noopener">Lihat rilis</a>'
    + '<button class="icon-btn" type="button" aria-label="Tutup"><svg><use href="#i-x"/></svg></button>';
  bar.querySelector("b").textContent = `Encore App ${info.latest} tersedia`;
  bar.querySelector("small").textContent = `Kamu masih pakai versi ${info.current}. Download versi baru lalu pasang ulang app-nya.`;
  bar.querySelector("a").href = info.url;
  bar.querySelector("button").onclick = () => { dismiss(info.latest); bar.remove(); };
  $(".main").prepend(bar);
}
