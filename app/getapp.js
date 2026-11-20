// web version of breakdown: point visitors to the encore app build for their computer

import { $, el, toast, store, server, onlineSite, APP } from "./core.js";
import { APP_RELEASES, APP_FILES } from "./config.js";
import { connect } from "./sync.js";

const fileUrl = (os) => `${APP_RELEASES}/download/${APP_FILES[os].file}`;

// mac / windows / linux, or null on phones and tablets (ipads report "mac" but have touch)
function guessOs() {
  const ua = navigator.userAgent;
  if (/android|iphone|ipad|ipod/i.test(ua)) return null;
  const p = (navigator.userAgentData?.platform || navigator.platform || ua).toLowerCase();
  if (p.includes("mac")) return navigator.maxTouchPoints > 1 ? null : "mac";
  if (p.includes("win")) return "windows";
  if (p.includes("linux")) return "linux";
  return null;
}

// what to do the first time, since the app is not signed by apple / microsoft
const OPEN_TIP = {
  mac: "Buka file .dmg, seret Encore ke Applications, lalu buka. Kalau muncul peringatan, buka System Settings → Privacy & Security → Open Anyway (sekali saja).",
  windows: "Extract zip-nya, lalu buka Encore.exe. Kalau muncul SmartScreen, klik More info → Run anyway (sekali saja).",
  linux: "Extract, lalu jalankan ./Encore di folder Encore. Encore terbuka sendiri di browser.",
};

// the steps shown right after a download click: what to expect the first time it opens
const FIRST_OPEN = {
  mac: {
    lead: "Encore belum bisa langsung diklik dua kali. Karena app ini gratis dan tidak terdaftar di Apple, macOS minta konfirmasi dulu:",
    steps: [
      "Buka <b>Encore-macOS.dmg</b> dari folder Downloads, lalu seret <b>Encore</b> ke folder <b>Applications</b>.",
      "Buka Encore dari Applications. Muncul peringatan <i>\"Encore\" Not Opened</i>? Klik <b>Done</b>, jangan Move to Trash.",
      "Buka <b>System Settings → Privacy &amp; Security</b>, gulir ke bawah, klik <b>Open Anyway</b> di samping Encore, lalu masukkan password Mac-mu.",
    ],
    note: "Cukup sekali. Setelah itu Encore terbuka seperti app biasa. Saat ganti ke versi baru, langkah 2–3 bisa muncul lagi.",
  },
  windows: {
    lead: "Karena app ini gratis dan tidak terdaftar di Microsoft, Windows minta konfirmasi dulu saat pertama dibuka:",
    steps: [
      "Klik kanan <b>Encore-Windows.zip</b> di folder Downloads → <b>Extract All</b>.",
      "Buka folder hasil extract, lalu klik dua kali <b>Encore.exe</b>.",
      "Muncul layar biru <i>Windows protected your PC</i>? Klik <b>More info → Run anyway</b>.",
    ],
    note: "Cukup sekali. Setelah itu Encore terbuka seperti app biasa.",
  },
  linux: {
    lead: "Setelah download selesai:",
    steps: [
      "Extract <b>Encore-Linux.tar.gz</b>.",
      "Buka terminal di folder <b>Encore</b>, lalu jalankan <b>./Encore</b>.",
      "Encore terbuka sendiri di browser. Biarkan terminalnya jalan selama dipakai.",
    ],
    note: "",
  },
};

// show the first-open steps for this build (the download itself keeps going)
function showFirstOpen(os) {
  const info = FIRST_OPEN[os];
  $("#getDialogLead").textContent = info.lead;
  $("#getDialogSteps").replaceChildren(...info.steps.map((html, i) => {
    const li = el("li");
    const p = el("span");
    p.innerHTML = html;
    li.append(el("span", "get-num", String(i + 1)), p);
    return li;
  }));
  const note = $("#getDialogNote");
  note.textContent = info.note;
  note.hidden = !info.note;
  $("#getDialog").showModal();
}

export function renderGetApp() {
  renderConnect();
  const os = guessOs();
  const main = $("#getMain");
  const others = Object.keys(APP_FILES).filter((k) => k !== os);
  if (os) {
    main.hidden = false;
    main.href = fileUrl(os);
    main.onclick = () => showFirstOpen(os);
    main.querySelector("span").textContent = `Download untuk ${APP_FILES[os].label}`;
    $("#getNeed").textContent = APP_FILES[os].need;
    $("#getOpenTip").textContent = OPEN_TIP[os];
  } else {
    // phone: the app needs a laptop or pc, still list every build
    main.hidden = true;
    $("#getNeed").textContent = "Encore App jalan di laptop/PC. Buka halaman ini dari komputermu, atau download dari sini:";
  }
  const links = others.map((k) => {
    const a = el("a", null, APP_FILES[k].label);
    a.href = fileUrl(k);
    a.title = APP_FILES[k].need;
    a.onclick = () => showFirstOpen(k);
    return a;
  });
  const out = [os ? "Pakai komputer lain? " : ""];
  links.forEach((a, i) => out.push(...(i ? [" · ", a] : [a])));
  const all = el("a", null, "semua versi");
  all.href = APP_RELEASES;
  all.target = "_blank";
  all.rel = "noopener noreferrer";
  out.push(" · ", all);
  $("#getOther").replaceChildren(...out);
}

// ------------------------------------------------------------------ online site: connect to the app

// the browser's own settings page for this site, which a web page cannot open itself
function settingsAddress() {
  const scheme = navigator.brave ? "brave" : /Edg\//.test(navigator.userAgent) ? "edge" : "chrome";
  return `${scheme}://settings/content/siteDetails?site=${encodeURIComponent(location.origin)}`;
}

// small picture of the address bar: the icon to click is highlighted
function addressBarPicture() {
  const wrap = el("div", "get-bar");
  wrap.setAttribute("role", "img");
  wrap.setAttribute("aria-label", "Ikon di sebelah kiri alamat situs di address bar");
  const icon = el("span", "get-bar-icon");
  icon.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 8h10M18 8h2M4 16h2M10 16h10"/><circle cx="16" cy="8" r="2"/><circle cx="8" cy="16" r="2"/></svg>';
  wrap.append(icon, el("span", "get-bar-url", location.host), el("span", "get-bar-hint", "← klik ini"));
  return wrap;
}

const mkBtn = (label, onClick, primary) => {
  const b = el("button", "btn" + (primary ? " primary" : ""), label);
  b.type = "button";
  b.onclick = () => onClick(b);
  return b;
};

// ask the app again; the page repaints itself when the answer comes (server.onChange)
async function tryConnect(b) {
  b.disabled = true;
  b.textContent = "Menyambungkan…";
  const ok = await server.check({ prompt: true });
  if (ok) {
    connect().catch(() => {}); // the playlist follows the app too
    toast("Tersambung! Breakdown sekarang bisa dipakai di sini.");
  }
}

// what the connect card says for each reason breakdown is off here (see server.state)
function renderConnect() {
  const box = $("#getConnect");
  box.hidden = !onlineSite;
  if (!onlineSite) return;
  const st = server.state;
  const attempted = server.tried || store.get("sync-app", false);
  const text = el("div", "get-connect-text");
  const acts = el("div", "get-connect-actions");
  const title = (t) => text.append(el("b", null, t));
  const para = (t) => text.append(el("p", null, t));
  if (st === "blocked") {
    title("Browser ini menolak sambungan ke Encore App");
    para("Encore App-nya mungkin sudah jalan, tapi izin jaringan lokal untuk situs ini sedang ditolak. Biar bisa, ubah izinnya sekali saja:");
    const ol = el("ol", "get-connect-steps");
    ["Klik ikon di kiri alamat situs (lihat gambar), lalu pilih <b>Setelan situs</b>.",
      "Cari <b>Perangkat di jaringan lokal</b> (atau <i>Local network access</i>), ubah jadi <b>Izinkan</b>.",
      "Kembali ke sini, lalu klik <b>Coba lagi</b>."].forEach((h) => { const li = el("li"); li.innerHTML = h; ol.append(li); });
    text.append(addressBarPicture(), ol);
    para("Ikonnya tidak ketemu? Salin alamat pengaturan di bawah, tempel di address bar, lalu tekan Enter.");
    acts.append(mkBtn("Coba lagi", tryConnect, true), mkBtn("Salin alamat pengaturan", async () => {
      try { await navigator.clipboard.writeText(settingsAddress()); toast("Alamat disalin. Tempel di address bar, lalu tekan Enter."); }
      catch { toast(settingsAddress(), { ms: 12000 }); }
    }));
  } else if (st === "unreachable") {
    title("Susah membuka Breakdown di browser ini?");
    para("Kalau Encore App sudah dibuka tapi tetap tidak tersambung, browser ini kemungkinan tidak mengizinkan halaman web bicara dengan app di komputermu (biasanya Safari). Ada dua cara gampang:");
    const ol = el("ol", "get-connect-steps");
    ["Buka halaman ini lewat <b>Chrome</b> atau <b>Edge</b>.",
      `Atau buka langsung <a href="${APP}/#/breakdown"><b>localhost:8765</b></a>. Tampilannya sama persis dan tidak butuh internet.`].forEach((h) => { const li = el("li"); li.innerHTML = h; ol.append(li); });
    text.append(ol);
    acts.append(mkBtn("Coba lagi", tryConnect, true));
  } else if (st === "outdated") {
    title("Encore App di komputermu versi lama");
    para(`Versi di komputermu: ${server.version || "lama"}. Halaman ini sudah lebih baru dari app-nya. Download versi terbaru di bawah, pasang ulang, lalu buka lagi.`);
    acts.append(mkBtn("Cek lagi", tryConnect, true));
  } else if (st === "missing" && attempted) {
    title("Encore App belum terdeteksi");
    para("Pastikan Encore App sudah dibuka dan jendelanya tidak ditutup. Kalau baru dibuka, tunggu beberapa detik.");
    acts.append(mkBtn("Coba lagi", tryConnect, true));
  } else {
    title("Sudah pasang Encore App?");
    para("Buka app-nya, lalu klik Hubungkan. Breakdown langsung jalan di halaman ini, tanpa pindah ke localhost. Browser mungkin bertanya soal jaringan lokal, pilih Izinkan.");
    acts.append(mkBtn("Hubungkan", tryConnect, true));
  }
  box.className = "card get-connect" + (st === "blocked" || st === "unreachable" || st === "outdated" ? " warn" : "");
  box.replaceChildren(text, acts);
}
