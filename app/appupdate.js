// encore app only: a small banner when a newer app release is out on github (/api/app/check).
// the ui updates itself (uiupdate.js), but the app itself needs a new download.

import { $, router, server, toast } from "./core.js";
import { APP_RELEASES, APP_FILES } from "./config.js";

const DISMISSED = "app-update-dismissed";
const POPPED = "app-update-popped";

// direct file link for this computer: the backend's answer when it has one, else built here (older apps)
function downloadUrl(info) {
  if (info.download) return info.download;
  const p = (navigator.userAgentData?.platform || navigator.platform || "").toLowerCase();
  const os = p.includes("win") ? "windows" : p.includes("mac") ? "mac" : "linux";
  return `${APP_RELEASES.replace(/\/latest$/, "")}/download/app-v${info.latest}/${APP_FILES[os].file}`;
}

// the dismissed version stays on this device only (not synced to the online site)
function dismissed() {
  try { return localStorage.getItem(DISMISSED); } catch { return null; }
}
function dismiss(v) {
  try { localStorage.setItem(DISMISSED, v); } catch {}
}
// ------------------------------------------------------------------ in-app install (packaged mac app)
// the app downloads its own new version and restarts; no "Open Anyway" prompt like a browser download

// full-screen progress cover (same look as the ui update)
function installCover() {
  const cover = document.createElement("div");
  cover.className = "ui-update";
  cover.setAttribute("role", "status");
  cover.innerHTML = '<div class="ui-update-box"><span class="ui-update-spin"></span><b>Memperbarui Encore App…</b><small></small></div>';
  document.body.append(cover);
  return { cover, say: (t) => { cover.querySelector("small").textContent = t; } };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// start the update, follow its progress, then reload once the new app answers
async function installNow(info) {
  const { cover, say } = installCover();
  const fail = (msg) => {
    cover.remove();
    toast(`Update otomatis gagal: ${msg}. Download manual dari banner atau halaman rilis.`, { error: true, ms: 10000 });
  };
  try {
    say("Menyiapkan…");
    const r = await fetch(server.url("/api/app/update"), { method: "POST" });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || r.statusText);
  } catch (ex) { fail(ex.message); return; }
  // progress until the app restarts (then it stops answering for a moment)
  const until = Date.now() + 10 * 60 * 1000;
  let restarting = false;
  while (Date.now() < until) {
    await sleep(800);
    let st = null;
    try { st = await (await fetch(server.url("/api/app/update/status"), { cache: "no-store" })).json(); } catch { /* app is restarting */ }
    if (st) {
      if (st.state === "error") { fail(st.error || "tidak diketahui"); return; }
      if (st.state === "downloading") say(st.total ? `Mengunduh… ${Math.round((st.got / st.total) * 100)}%` : "Mengunduh…");
      if (st.state === "installing") say("Memasang versi baru…");
      if (st.state === "restarting") { restarting = true; say("Memulai ulang Encore…"); }
      // the new version answers: this page can reload into it
      try {
        const h = await (await fetch(server.url("/api/health"), { cache: "no-store" })).json();
        if (h.app_version === info.latest) { location.reload(); return; }
      } catch { /* not up yet */ }
    } else if (restarting) {
      say("Menunggu Encore menyala lagi…");
      try {
        const h = await (await fetch(server.url("/api/health"), { cache: "no-store" })).json();
        if (h.app_version === info.latest) { location.reload(); return; }
      } catch { /* not up yet */ }
    }
  }
  fail("Encore tidak menyala lagi setelah update; buka Encore dari Applications");
}

// the install button when the app can replace itself, else the plain download link
function installButton(info, onStart) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "btn primary";
  b.textContent = "Update sekarang";
  b.onclick = () => { onStart?.(); installNow(info); };
  return b;
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
  dl.href = downloadUrl(info);
  dl.onclick = () => dlg.close();
  if (info.can_install) {
    dl.replaceWith(installButton(info, () => dlg.close()));
    dlg.querySelector(".app-update-sub").textContent = `Kamu masih pakai versi ${info.current}. Klik Update sekarang: Encore mengunduh dan memasang sendiri, lalu menyala lagi.`;
  }
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
    const r = await fetch(server.url("/api/app/check"), { cache: "no-store", signal: AbortSignal.timeout(10000) });
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
  const dlBtn = bar.querySelector("[data-dl]");
  dlBtn.href = downloadUrl(info);
  if (info.can_install) {
    dlBtn.replaceWith(installButton(info));
    bar.querySelector("small").textContent = `Kamu masih pakai versi ${info.current}. Encore memasang sendiri, tanpa peringatan macOS.`;
  }
  bar.querySelector("button").onclick = () => { dismiss(info.latest); bar.remove(); };
  $(".main").prepend(bar);
  popupWhenBreakdown(info);
}
