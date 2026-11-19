// encore app only: a small banner when a newer app release is out on github (/api/app/check).
// the ui updates itself (uiupdate.js), but the app itself needs a new download.

import { $, router } from "./core.js";

const DISMISSED = "app-update-dismissed";
const POPPED = "app-update-popped";

// the dismissed version stays on this device only (not synced to the online site)
function dismissed() {
  try { return localStorage.getItem(DISMISSED); } catch { return null; }
}
function dismiss(v) {
  try { localStorage.setItem(DISMISSED, v); } catch {}
}
// the breakdown popup shows once per version
function popped() {
  try { return localStorage.getItem(POPPED); } catch { return null; }
}

// popup on the breakdown pages: new version, release notes (when the release has them), download
function showPopup(info) {
  const dlg = document.createElement("dialog");
  dlg.className = "sheet small app-update-dialog";
  dlg.innerHTML = '<form method="dialog" class="sheet-inner">'
    + '<header class="sheet-head"><h2><svg class="title-icon"><use href="#i-download"/></svg><span></span></h2>'
    + '<button class="icon-btn" value="cancel" aria-label="Tutup"><svg><use href="#i-x"/></svg></button></header>'
    + '<p class="app-update-sub"></p><div class="app-update-notes" hidden></div>'
    + '<footer class="sheet-foot"><a class="btn" data-rel target="_blank" rel="noopener">Lihat rilis</a>'
    + '<a class="btn primary" data-dl rel="noopener">Download</a></footer></form>';
  dlg.querySelector("h2 span").textContent = `Encore App ${info.latest} tersedia`;
  dlg.querySelector(".app-update-sub").textContent = `Kamu masih pakai versi ${info.current}. Download versi baru lalu pasang ulang app-nya.`;
  // release notes as a plain list, one line per entry
  const notes = dlg.querySelector(".app-update-notes");
  const lines = (info.notes || "").split("\n").map((l) => l.replace(/^\s*(?:[-*]|\d+\.)\s*/, "").trim()).filter(Boolean);
  if (lines.length) {
    notes.hidden = false;
    const ul = document.createElement("ul");
    for (const l of lines) { const li = document.createElement("li"); li.textContent = l; ul.append(li); }
    notes.append(ul);
  }
  dlg.querySelector("[data-rel]").href = info.url;
  const dl = dlg.querySelector("[data-dl]");
  dl.href = info.download || info.url;
  dl.onclick = () => dlg.close();
  dlg.addEventListener("close", () => dlg.remove());
  document.body.append(dlg);
  dlg.showModal();
  try { localStorage.setItem(POPPED, info.latest); } catch {}
}

// open the popup the first time a breakdown page is visible (not over another dialog)
function popupWhenBreakdown(info) {
  const tryShow = () => {
    if (popped() === info.latest || document.querySelector("dialog[open]")) return;
    if (router.current !== "bass" && router.current !== "song") return;
    removeEventListener("hashchange", tryShow);
    showPopup(info);
  };
  addEventListener("hashchange", tryShow);
  tryShow();
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
    + '<a class="btn" data-rel target="_blank" rel="noopener">Lihat rilis</a>'
    + '<a class="btn primary" data-dl rel="noopener">Download</a>'
    + '<button class="icon-btn" type="button" aria-label="Tutup"><svg><use href="#i-x"/></svg></button>';
  bar.querySelector("b").textContent = `Encore App ${info.latest} tersedia`;
  bar.querySelector("small").textContent = `Kamu masih pakai versi ${info.current}. Download versi baru lalu pasang ulang app-nya.`;
  bar.querySelector("[data-rel]").href = info.url;
  bar.querySelector("[data-dl]").href = info.download || info.url;
  bar.querySelector("button").onclick = () => { dismiss(info.latest); bar.remove(); };
  $(".main").prepend(bar);
  popupWhenBreakdown(info);
}
