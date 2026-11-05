// encore app only: on every page load, pull newer ui files from the online site, then reload.
// the web version (and the dev server) has no /api/ui/check, so nothing happens there.

const FLAG = "ui-updated-at";

// full-screen "updating" cover while the new files download
function showCover() {
  const el = document.createElement("div");
  el.className = "ui-update";
  el.setAttribute("role", "status");
  el.innerHTML = '<div class="ui-update-box"><span class="ui-update-spin"></span><b>Memperbarui tampilan…</b><small>Sebentar, Encore App sedang mengambil versi terbaru</small></div>';
  document.body.append(el);
  return el;
}

export async function checkUiUpdate() {
  // skip right after an update so a mismatch can never reload in a loop
  try { if (Date.now() - Number(sessionStorage.getItem(FLAG) || 0) < 60000) return; } catch {}
  let check;
  try {
    const r = await fetch("/api/ui/check", { cache: "no-store", signal: AbortSignal.timeout(8000) });
    if (!r.ok) return;
    check = await r.json();
  } catch { return; }
  if (!check.available) return;
  const cover = showCover();
  try {
    const r = await fetch("/api/ui/update", { method: "POST", signal: AbortSignal.timeout(60000) });
    if (!r.ok) throw new Error(await r.text());
    try { sessionStorage.setItem(FLAG, String(Date.now())); } catch {}
    location.reload();
  } catch (err) {
    // keep using the current ui; the next load tries again
    console.warn("ui update failed", err);
    cover.remove();
  }
}
