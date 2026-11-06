// web version of breakdown: point visitors to the encore app build for their computer

import { $, el, toast, store } from "./core.js";
import { APP_RELEASES, APP_FILES } from "./config.js";
import { connect, isConnected } from "./sync.js";

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
  renderSync();
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

// online site: share the playlist with the encore app in this browser (sync.js)
function renderSync() {
  const line = $("#syncLine");
  line.hidden = location.origin !== "https://encore-player.vercel.app";
  if (line.hidden) return;
  if (isConnected()) {
    line.replaceChildren("✓ Playlist di sini tersinkron dengan Encore App di komputer ini.");
    return;
  }
  const b = el("button", "link-btn", store.get("sync-app", false) ? "Sambungkan lagi" : "Sambungkan playlist");
  b.type = "button";
  b.onclick = async () => {
    b.disabled = true;
    b.textContent = "Menyambungkan…";
    const ok = await connect();
    toast(ok ? "Tersambung! Playlist di sini dan di Encore App sekarang sama."
      : "Encore App belum terdeteksi. Pastikan app-nya jalan, lalu klik Izinkan kalau browser bertanya soal jaringan lokal.", { error: !ok, ms: 8000 });
    renderSync();
  };
  line.replaceChildren("Sudah pasang Encore App? ", b, " supaya playlist di sini dan di app selalu sama (di browser ini).");
}
