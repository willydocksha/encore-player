// shared helpers: dom, storage, api, toasts, dialogs, menus, routing, server status, media bus

export const $ = (s, root = document) => root.querySelector(s);
export const $$ = (s, root = document) => [...root.querySelectorAll(s)];

export function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

export function icon(name) {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  const use = document.createElementNS(ns, "use");
  use.setAttribute("href", `#i-${name}`);
  svg.append(use);
  return svg;
}

export function setIcon(button, name) {
  button.querySelector("use")?.setAttribute("href", `#i-${name}`);
}

// settings shared between the online site and the encore app (sync.js); the rest stays per page
export const SYNC_KEYS = ["lp-playlist", "lp-index", "lp-name", "lp-repeat", "lp-shuffle", "lp-autonext", "lp-rate",
  "bass-mixer", "bass-part", "bd-mode", "nav-folded", "tour-done", "tour-seen", "pitch-progress", "pitch-level"];

export const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set(k, v) {
    try {
      const json = JSON.stringify(v);
      if (localStorage.getItem(k) === json) return; // unchanged: nothing to sync
      localStorage.setItem(k, json);
      if (SYNC_KEYS.includes(k)) {
        // when it changed, so the newest write wins across pages. writes while the page boots are
        // just defaults being saved, they must not beat what the other page saved
        const times = JSON.parse(localStorage.getItem("sync-times") || "{}");
        times[k] = store.booting ? times[k] || 1 : Date.now();
        localStorage.setItem("sync-times", JSON.stringify(times));
        store.onSync?.();
      }
    } catch {}
  },
  onSync: null,
  booting: true, // main.js clears it once the page is ready
};

export const fmtTime = (t) => {
  t = Math.max(0, Math.floor(t || 0));
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
  return (h ? `${h}:${String(m).padStart(2, "0")}` : m) + ":" + String(s).padStart(2, "0");
};

export const fmtDate = (sec) => new Intl.DateTimeFormat("id-ID", {
  day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit",
}).format(new Date(sec * 1000));

export const fmtAgo = (sec) => {
  const m = Math.round((Date.now() / 1000 - sec) / 60);
  if (m < 1) return "baru saja";
  if (m < 60) return `${m} mnt lalu`;
  if (m < 60 * 24) return `${Math.round(m / 60)} jam lalu`;
  return `${Math.round(m / 1440)} hari lalu`;
};

export async function api(path, opts) {
  const r = await fetch(path, opts);
  if (!r.ok) {
    let msg = r.statusText;
    try { msg = (await r.json()).detail || msg; } catch {}
    throw new Error(msg);
  }
  return r.json();
}

// ------------------------------------------------------------------ link parsing (shared by both sections)

function parseT(t) {
  if (/^\d+$/.test(t)) return +t;
  const m = t.match(/(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?/);
  return m ? (+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (+m[3] || 0) : 0;
}

// youtube / google drive link -> {type: "yt"|"drive", id, start}
export function parseLink(raw) {
  let u;
  try { u = new URL(raw.trim()); } catch { return null; }
  const h = u.hostname.replace(/^(www|m|music)\./, "");
  const t = u.searchParams.get("t") || u.searchParams.get("start");
  const start = t ? parseT(t) : 0;
  if (h === "youtu.be") { const id = u.pathname.slice(1).split("/")[0]; return id ? { type: "yt", id, start } : null; }
  if (h.endsWith("youtube.com")) {
    let id = u.searchParams.get("v");
    const m = u.pathname.match(/\/(shorts|embed|live|v)\/([\w-]{6,})/);
    if (!id && m) id = m[2];
    return id ? { type: "yt", id, start } : null;
  }
  if (/(^|\.)(drive|docs)\.google\.com$/.test(h) || h === "drive.usercontent.google.com") {
    const m = u.pathname.match(/\/d\/([\w-]{10,})/);
    let id = m ? m[1] : u.searchParams.get("id");
    // old files (shared before 2021) only open with their resource key: carry it inside the id
    const rk = u.searchParams.get("resourcekey");
    if (id && rk && /^[\w-]+$/.test(rk)) id = `${id}.${rk}`;
    return id ? { type: "drive", id, start: 0 } : null;
  }
  return null;
}

// ------------------------------------------------------------------ toasts

export function toast(text, { action, onAction, error = false, ms = 5000 } = {}) {
  const t = el("div", "toast" + (error ? " error" : ""));
  t.append(el("span", "toast-text", text));
  if (action) {
    const b = el("button", "btn", action);
    b.type = "button";
    b.onclick = () => { onAction?.(); close(); };
    t.append(b);
  }
  $("#toasts").append(t);
  const timer = setTimeout(close, ms);
  function close() {
    clearTimeout(timer);
    t.classList.add("out");
    setTimeout(() => t.remove(), 200);
  }
  return close;
}

// ------------------------------------------------------------------ confirm dialog

export function confirmDialog(title, text, { ok = "OK", danger = false } = {}) {
  const d = $("#confirm");
  $("#confirmTitle").textContent = title;
  $("#confirmText").textContent = text || "";
  $("#confirmText").hidden = !text;
  const okBtn = $("#confirmOk");
  okBtn.textContent = ok;
  okBtn.classList.toggle("danger", danger);
  d.returnValue = "";
  d.showModal();
  return new Promise((resolve) => d.addEventListener("close", () => resolve(d.returnValue === "ok"), { once: true }));
}

// close dialogs when clicking the backdrop
document.addEventListener("click", (e) => {
  if (e.target instanceof HTMLDialogElement && e.target.open) {
    const r = e.target.getBoundingClientRect();
    const inside = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
    if (!inside) e.target.close("cancel");
  }
});

// ------------------------------------------------------------------ popup menu

let openMenu = null;
export function showMenu(anchor, items) {
  closeMenu();
  const m = el("div", "menu");
  m.setAttribute("role", "menu");
  for (const it of items) {
    if (!it) continue;
    const b = it.href ? el("a") : el("button");
    if (it.href) { b.href = it.href; b.target = "_blank"; b.rel = "noopener noreferrer"; }
    else b.type = "button";
    if (it.danger) b.className = "danger";
    if (it.icon) b.append(icon(it.icon));
    b.append(it.label);
    b.addEventListener("click", (e) => { e.stopPropagation(); closeMenu(); it.onClick?.(); });
    m.append(b);
  }
  document.body.append(m);
  const r = anchor.getBoundingClientRect();
  const w = m.offsetWidth, h = m.offsetHeight;
  m.style.left = `${Math.max(8, Math.min(window.innerWidth - w - 8, r.right - w))}px`;
  m.style.top = `${r.bottom + h + 8 > window.innerHeight ? r.top - h - 6 : r.bottom + 6}px`;
  openMenu = m;
}
export function closeMenu() { openMenu?.remove(); openMenu = null; }
document.addEventListener("click", closeMenu);
window.addEventListener("resize", closeMenu);
document.addEventListener("scroll", closeMenu, true);

// ------------------------------------------------------------------ breakdown availability
// breakdown runs in the encore app (python server on this computer, see backend/). the web version
// has no /api/health, so there it shows the download page instead.

export const server = {
  bass: false,
  youtube: false,
  analysis: false,
  mode: "web", // "app" inside the encore app
  ai: null,
  checked: false,
  listeners: new Set(),
  async check() {
    let ok = false;
    try {
      const r = await fetch("/api/health", { cache: "no-store", signal: AbortSignal.timeout(3000) });
      const d = r.ok ? await r.json() : {};
      ok = !!d.app;
      this.ai = d.ai || null; // the optional ai engine (aimode.js)
    } catch { /* web version, or the app was closed */ }
    this.bass = ok;
    this.analysis = ok;
    this.youtube = ok; // the app downloads youtube audio itself
    this.mode = ok ? "app" : "web";
    this.checked = true;
    const s = $("#serverStatus");
    s.classList.toggle("on", ok);
    s.classList.toggle("off", !ok);
    s.classList.toggle("soon", !ok);
    s.querySelector(".server-text").textContent = ok ? "Encore App tersambung" : "Breakdown ada di Encore App";
    $("#navSoon").hidden = ok;
    $("#quitApp").hidden = !ok;
    document.body.classList.toggle("in-app", ok);
    this.listeners.forEach((fn) => fn(this.bass));
    return this.bass;
  },
  onChange(fn) { this.listeners.add(fn); },
};

// ------------------------------------------------------------------ media bus: only one section plays at a time

const players = new Map();
export const media = {
  register(name, pause) { players.set(name, pause); },
  claim(name) { for (const [n, pause] of players) if (n !== name) pause(); },
};

// ------------------------------------------------------------------ router

const routes = [];
export const router = {
  current: null,
  add(pattern, view, enter) { routes.push({ pattern, view, enter }); },
  go(hash) { location.hash = hash; },
  resolve() {
    const h = location.hash || "#/";
    for (const r of routes) {
      const m = h.match(r.pattern);
      if (!m) continue;
      $$(".view").forEach((v) => { v.hidden = v.dataset.view !== r.view; });
      const section = r.view === "song" ? "bass" : r.view;
      $$(".nav-item[data-nav]").forEach((a) => a.classList.toggle("active", a.dataset.nav === section));
      this.current = r.view;
      r.enter?.(...m.slice(1));
      window.scrollTo({ top: 0 });
      return;
    }
    location.hash = "#/";
  },
};
window.addEventListener("hashchange", () => router.resolve());

// ------------------------------------------------------------------ keyboard: one handler per view

const keyHandlers = new Map();
export function onKeys(view, fn) { keyHandlers.set(view, fn); }
document.addEventListener("keydown", (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (document.querySelector("dialog[open]") || document.body.classList.contains("touring")) return;
  const t = e.target;
  if (t.matches?.("textarea, input:not([type=range]), select")) return;
  keyHandlers.get(router.current)?.(e);
});

// space is play/pause everywhere: stop it from also pressing whatever button still has focus
// (safari fires the button's click on keyup, so a focused "shortcut" button kept reopening its dialog)
document.addEventListener("keyup", (e) => {
  if (e.key !== " " || document.querySelector("dialog[open]")) return;
  if (e.target.closest?.("button, summary, [role=button]")) e.preventDefault();
});

// a closed dialog hands focus back to the button that opened it; drop it so later keys don't re-press it
document.addEventListener("close", (e) => {
  if (e.target.tagName === "DIALOG") setTimeout(() => document.activeElement?.closest?.("button")?.blur(), 0);
}, true);
