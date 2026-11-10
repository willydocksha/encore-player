// overlay tutorial: dims the page, spotlights one real control at a time and explains it.
// every page has its own short tour: it opens the first time that page is visited,
// and "Cara pakai" in the menu replays only the tour of the page that is open.

import { $, el, store, router, server } from "./core.js";

const SEEN_KEY = "tour-seen";
const OLD_KEY = "tour-done"; // before per-page tours: one tour on the playlist page

// pages already toured; the old single tour counts as the playlist one
function seen() {
  const list = store.get(SEEN_KEY, null);
  if (Array.isArray(list)) return list;
  return store.get(OLD_KEY, false) ? ["playlist"] : [];
}
function markSeen(page) {
  const list = seen();
  if (!list.includes(page)) store.set(SEEN_KEY, [...list, page]);
}

// target: css selector of what to spotlight; a list ("a, b") spotlights them together.
// null = centered card.
// steps whose target is hidden on this screen are skipped.
const tours = {
  // playlist (home)
  playlist: () => [
    {
      target: null,
      title: "Selamat datang di Encore 👋",
      text: "Teman latihan musikmu: putar dan loop lagu sampai hafal, bedah instrumennya, latih telinga, dan stem alatmu. Kita mulai dari Playlist dulu, cuma sebentar.",
    },
    {
      target: "#openEditor",
      title: "Tambah lagu",
      text: "Tempel link YouTube atau Google Drive. Bisa juga langsung tempel satu chat daftar lagu dari WhatsApp, judul dan catatannya ikut terbaca.",
    },
    {
      target: ".queue-card",
      title: "Antrian lagu",
      text: "Klik lagu untuk memutarnya. Tahan ⋮⋮ lalu geser untuk ubah urutan. Tombol ⋯ untuk buka link asli, ganti link, atau hapus lagu.",
    },
    {
      target: "#player .transport, #player .transport-sub",
      title: "Kontrol putar",
      text: "Play/pause, lagu sebelum/berikutnya, mundur/maju 5 detik, mode ulang, dan acak. Nyalakan Auto next supaya lanjut otomatis ke lagu berikutnya.",
    },
    {
      target: "#bar",
      title: "Progress bar",
      text: "Klik atau geser untuk lompat ke bagian mana pun. Penanda loop A dan B juga muncul di sini dan bisa digeser.",
    },
    {
      target: ".tools .tool:nth-child(1)",
      title: "Kecepatan",
      text: "Pelankan lagu sampai 0.5× untuk latihan bagian yang cepat. Nadanya tidak berubah.",
    },
    {
      target: ".tools .tool:nth-child(2)",
      title: "Loop A–B",
      text: "Klik Set A di awal bagian yang mau dilatih, lalu Set B di akhirnya. Bagian itu akan diputar terus sampai loop dihapus.",
    },
    {
      target: ".tools .tool:nth-child(3)",
      title: "Volume",
      text: "Atur volume, atau klik ikon speaker untuk mute dan unmute.",
    },
    {
      target: '.nav-item[data-nav="bass"], .nav-item[data-nav="ear"], .nav-item[data-nav="tuner"], .nav-item[data-nav="metro"]',
      title: "Menu lainnya",
      text: "Breakdown, Perfect Pitch, Tuner, dan Metronome. Tiap menu punya tur singkatnya sendiri yang muncul waktu pertama kali kamu buka.",
    },
    {
      target: "#shortcutsBtn",
      title: "Shortcut keyboard",
      text: "Di laptop, semuanya bisa lewat keyboard: Spasi untuk play/pause, ← → untuk mundur/maju, A dan B untuk loop, M untuk mute. Daftar lengkapnya ada di sini.",
    },
    {
      target: "#tourBtn",
      title: "Selesai! 🎉",
      text: "Tombol Cara pakai membuka lagi tur untuk halaman yang sedang kamu buka.",
    },
  ],

  // breakdown home: add songs + library (or the get-the-app page on the web)
  bass: () => server.bass ? [
    {
      target: null,
      title: "Breakdown 🎛️",
      text: "Di sini lagu dibongkar: vokal, drum, bass, dan instrumen lain dipisah, lalu not dan chord-nya dibaca.",
    },
    {
      target: "#jobForm",
      title: "Tambah lagu",
      text: "Tempel link YouTube atau Google Drive, atau pilih file audio, lalu klik Analisis. File juga bisa langsung ditarik ke mana saja di halaman ini.",
    },
    {
      target: "#modeRow",
      title: "Mode cepat atau detail",
      text: "Mode cepat selesai sekitar 1 menit. Mode detail pakai mesin AI, lebih lama tapi hasilnya lebih rapi. Dipilih per lagu.",
    },
    {
      target: "#queueSection",
      title: "Antrian",
      text: "Lagu yang sedang diproses ada di sini. Biarkan Encore App tetap jalan sampai selesai.",
    },
    {
      target: "#libSearch",
      title: "Library",
      text: "Semua lagu yang sudah di-breakdown tersimpan di komputermu. Cari lewat kolom ini, lalu klik lagunya untuk mulai latihan per instrumen.",
    },
  ] : [
    {
      target: null,
      title: "Breakdown 🎛️",
      text: "Pisahkan vokal, drum, bass, dan instrumen lain, lengkap dengan not dan chord-nya.",
    },
    {
      target: "#getMain",
      title: "Pakai Encore App",
      text: "Prosesnya terlalu berat untuk server web, jadi Breakdown jalan di Encore App (gratis) untuk Mac, Windows, dan Linux. Download sekali, pakai selamanya.",
    },
    {
      target: ".get-steps",
      title: "Tiga langkah",
      text: "Download, buka Encore, lalu tempel link lagu. Playlist tetap bisa dipakai di sini seperti biasa.",
    },
  ],

  // one song from the library
  song: () => [
    {
      target: ".now-strip .now-box",
      title: "Chord dan not sekarang",
      text: "Chord dan not yang sedang berbunyi, plus chord berikutnya. Ikut bergerak waktu lagu diputar.",
    },
    {
      target: ".part-switch",
      title: "Pilih instrumen",
      text: "Lihat bass, vokal, piano, gitar, atau drum satu per satu. Multitrack menumpuk semuanya, Chord menampilkan lembar chord per bar, dan Not untuk not balok, not angka, atau huruf.",
    },
    {
      target: ".sub-switch",
      title: "Grafik atau Tab",
      text: "Grafik menampilkan not seperti piano roll, Tab menampilkan posisi senar dan fret.",
    },
    {
      target: ".stage",
      title: "Tampilan not",
      text: "Not berjalan mengikuti lagu. Klik di mana saja untuk lompat ke bagian itu, atau tahan Shift sambil geser untuk pilih bagian yang mau di-loop.",
    },
    {
      target: "#sections:not([hidden])",
      title: "Bagian lagu",
      text: "Intro, verse, chorus, bridge, dan lainnya, dideteksi otomatis. Klik untuk lompat ke bagian itu, klik dua kali untuk loop bagian itu. Tebakannya bisa meleset, terutama verse dan chorus.",
    },
    {
      target: "#overview",
      title: "Seluruh lagu",
      text: "Ringkasan satu lagu penuh dengan chord-nya. Klik untuk pindah ke bagian lain dengan cepat.",
    },
    {
      target: ".dock",
      title: "Kontrol latihan",
      text: "Play/pause, kecepatan, loop A–B, mixer per instrumen (mute, solo, export), zoom, dan jumlah senar. Di layar kecil, tombol slider membuka sisanya.",
    },
  ],

  // perfect pitch
  ear: () => [
    {
      target: null,
      title: "Perfect Pitch 👂",
      text: "Latih telinga mengenali nada tanpa acuan, level demi level dari 7 not natural sampai akor.",
    },
    {
      target: ".ear-days-card",
      title: "Pilih level",
      text: "Mulai dari level 1. Level yang sudah lulus berwarna hijau, dan ada ujian tahap di beberapa titik. Panah ← → juga bisa dipakai untuk ganti level.",
    },
    {
      target: "#earLesson",
      title: "Materi level",
      text: "Isi level yang dipilih: nada yang dilatih dan tombol untuk mulai sesi latihan.",
    },
    {
      target: "#earSession",
      title: "Sesi latihan",
      text: "Dengarkan nadanya, lalu tebak. Lulus satu level untuk lanjut ke level berikutnya.",
    },
    {
      target: ".ear-days-card > .ear-small",
      title: "Progres tersimpan di browser",
      text: "Tidak perlu akun. Kalau pindah perangkat atau cache terhapus, pilih saja level terakhirmu.",
    },
  ],

  // tuner + frequency check
  tuner: () => [
    {
      target: "#tunerMode",
      title: "Tuner atau cek frekuensi",
      text: "Tuner untuk stem alat. Cek frekuensi menampilkan spektrum tiap pukulan, berguna untuk cek senar yang terlalu kencang atau mati.",
    },
    {
      target: ".tuner-input",
      title: "Pilih input",
      text: "Pilih mikrofon atau audio interface (misalnya Ampero lewat USB), lalu klik Mulai tuner. Bar level harus bergerak waktu senar dipetik.",
    },
    {
      target: "#tunerInst",
      title: "Pilih alat",
      text: "Gitar (standar atau Drop D), bass 4/5 senar, ukulele, biola, atau Kromatik untuk cek nada apa pun yang kamu nyanyikan atau mainkan.",
    },
    {
      target: ".tuner-meter",
      title: "Jarum tuner",
      text: "Jarum di tengah dan hijau berarti nadanya pas. Di kiri berarti terlalu rendah, di kanan terlalu tinggi.",
    },
    {
      target: ".tuner-foot",
      title: "Nada acuan",
      text: "Standarnya A4 = 440 Hz. Ubah kalau bandmu pakai acuan lain, klik angkanya untuk kembali ke 440.",
    },
  ],

  // metronome
  metro: () => [
    {
      target: ".metro-tempo",
      title: "Atur tempo",
      text: "Geser slider atau klik panah untuk ubah BPM. Di keyboard: ↑ ↓ (tahan Shift untuk lompat 5). Nama tempo (Andante, Allegro, ...) ikut berubah.",
    },
    {
      target: "#metroTap",
      title: "Tap tempo",
      text: "Belum tahu tempo lagunya? Ketuk tombol ini (atau tekan T) beberapa kali mengikuti ketukan lagu, BPM langsung menyesuaikan.",
    },
    {
      target: "#metroBeats",
      title: "Titik ketukan",
      text: "Titik menyala mengikuti ketukan. Klik satu titik untuk ganti bunyinya: aksen (lebih tinggi), biasa, atau diam. Diam berguna untuk latihan tanpa klik di ketukan tertentu.",
    },
    {
      target: ".metro-opts",
      title: "Birama, ketukan, suara",
      text: "Pilih birama (4/4, 3/4, 6/8, ...), pecahan ketukan (♫ seperdelapan, triol, ♬ seperenambelas), jenis suara, dan volume. Semua pilihan diingat.",
    },
    {
      target: "#metroToggle",
      title: "Mulai",
      text: "Klik Mulai atau tekan Spasi. Metronome otomatis berhenti saat pindah halaman atau saat lagu di Playlist diputar.",
    },
  ],
};

let list = [], at = 0, box = null, spot = null, tip = null, raf = 0;

// bounding box around every element the selector matches
function rectOf(sel) {
  const rs = [...document.querySelectorAll(sel)].map((e) => e.getBoundingClientRect()).filter((r) => r.width && r.height);
  if (!rs.length) return null;
  const top = Math.min(...rs.map((r) => r.top)), left = Math.min(...rs.map((r) => r.left));
  const bottom = Math.max(...rs.map((r) => r.bottom)), right = Math.max(...rs.map((r) => r.right));
  return { top, left, bottom, right, width: right - left, height: bottom - top };
}

const visible = (sel) => {
  if (!sel) return true;
  return !!rectOf(sel);
};

let page = null; // page whose tour is open

// open the tour of the page that is showing now
export function startTour() {
  if (box) return;
  const p = router.current;
  // wait a frame so the view is laid out
  requestAnimationFrame(() => {
    list = (tours[p]?.() || []).filter((s) => visible(s.target));
    if (!list.length) return;
    page = p;
    at = 0;
    build();
    show();
  });
}

function build() {
  document.body.classList.add("touring");
  box = el("div", "tour");
  box.setAttribute("role", "dialog");
  box.setAttribute("aria-modal", "true");
  spot = el("div", "tour-spot");
  tip = el("div", "tour-tip");
  box.append(spot, tip);
  // clicks on the dim area do nothing, so a stray tap doesn't end the tour
  box.addEventListener("click", (e) => e.stopPropagation());
  document.body.append(box);
  addEventListener("resize", queue);
  addEventListener("scroll", queue, true);
  document.addEventListener("keydown", onKey, true);
}

function end() {
  if (page) markSeen(page);
  page = null;
  cancelAnimationFrame(raf);
  removeEventListener("resize", queue);
  removeEventListener("scroll", queue, true);
  document.removeEventListener("keydown", onKey, true);
  box?.remove();
  box = spot = tip = null;
  document.body.classList.remove("touring");
}

function onKey(e) {
  if (!box) return;
  if (e.key === "Escape") end();
  else if (e.key === "ArrowRight" || e.key === "Enter") go(1);
  else if (e.key === "ArrowLeft") go(-1);
  else return;
  e.preventDefault();
  e.stopPropagation();
}

function go(d) {
  const n = at + d;
  if (n < 0) return;
  if (n >= list.length) { end(); return; }
  at = n;
  show();
}

function show() {
  const s = list[at];
  const last = at === list.length - 1;
  const head = el("div", "tour-head");
  head.append(el("span", "tour-count", `${at + 1} / ${list.length}`));
  const skip = el("button", "tour-skip", last ? "" : "Lewati");
  skip.type = "button";
  skip.hidden = last;
  skip.onclick = end;
  head.append(skip);
  const foot = el("div", "tour-foot");
  const dots = el("div", "tour-dots");
  list.forEach((_, i) => dots.append(el("i", i === at ? "on" : "")));
  const nav = el("div", "tour-nav");
  if (at > 0) {
    const back = el("button", "btn sm ghost", "Kembali");
    back.type = "button"; back.onclick = () => go(-1);
    nav.append(back);
  }
  const next = el("button", "btn sm primary", at === 0 ? "Mulai tur" : last ? "Selesai" : "Lanjut");
  next.type = "button"; next.onclick = () => go(1);
  nav.append(next);
  foot.append(dots, nav);
  tip.replaceChildren(head, el("h3", "tour-title", s.title), el("p", "tour-text", s.text), foot);
  tip.classList.remove("in");
  if (s.target) document.querySelector(s.target).scrollIntoView({ block: "center", behavior: "smooth" });
  // place once now and again after the smooth scroll settles
  place();
  setTimeout(place, 380);
  requestAnimationFrame(() => tip?.classList.add("in"));
  next.focus({ preventScroll: true });
}

function queue() { cancelAnimationFrame(raf); raf = requestAnimationFrame(place); }

function place() {
  if (!box) return;
  const s = list[at];
  const vw = innerWidth, vh = innerHeight, G = 16, PAD = 6;
  const w = Math.min(340, vw - G * 2);
  tip.style.width = `${w}px`;
  const th = tip.offsetHeight;
  if (!s.target) {
    spot.classList.add("none");
    tip.style.left = `${(vw - w) / 2}px`;
    tip.style.top = `${Math.max(G, (vh - th) / 2)}px`;
    return;
  }
  spot.classList.remove("none");
  const r = rectOf(s.target);
  if (!r) return;
  const top = Math.max(4, r.top - PAD), left = Math.max(4, r.left - PAD);
  const bottom = Math.min(vh - 4, r.bottom + PAD), right = Math.min(vw - 4, r.right + PAD);
  Object.assign(spot.style, { top: `${top}px`, left: `${left}px`, width: `${right - left}px`, height: `${bottom - top}px` });
  // below the target if it fits, else above, else pinned to the bottom of the screen
  let y;
  if (bottom + 12 + th <= vh - G) y = bottom + 12;
  else if (top - 12 - th >= G) y = top - 12 - th;
  else y = vh - th - G;
  // beside a tall sidebar item on desktop: put the bubble to its right
  let x = Math.min(Math.max(G, r.left), vw - w - G);
  if (r.right < vw * 0.3 && right + 12 + w <= vw - G) { x = right + 12; y = Math.min(Math.max(G, r.top), vh - th - G); }
  tip.style.left = `${x}px`;
  tip.style.top = `${y}px`;
}

// first visit of a page: open its tour once the page has settled
export function maybeStartTour() {
  const p = router.current;
  if (!tours[p] || seen().includes(p)) return;
  // the song page draws after its data loads, so give it a bit longer
  setTimeout(() => {
    if (router.current !== p || box || document.querySelector("dialog[open]")) return;
    startTour();
  }, p === "song" ? 1200 : 700);
}
