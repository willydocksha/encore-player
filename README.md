# Encore

Teman latihan musikmu. Encore punya empat bagian:

- **Playlist**: media player latihan dari link YouTube dan Google Drive, dengan loop A–B dan kecepatan. Jalan di mana saja, termasuk Vercel dan HP.
- **Breakdown**: memisahkan instrumen (drum, bass, vokal, gitar, piano, lainnya), menampilkan not bass, melodi vokal, dan chord-nya. Prosesnya berat, jadi Breakdown hanya jalan di **Encore App** (Mac, Windows, Linux) di komputer pengguna. Di versi web, menu Breakdown berisi halaman download app-nya.
- **Perfect Pitch**: latihan mengenali nada tanpa acuan, level demi level.
- **Tuner**: stem gitar, bass, ukulele, atau biola lewat mikrofon atau audio interface, sekaligus cek nada apa yang sedang masuk dan frekuensi mana yang terlalu kencang saat slap.

Playlist, Perfect Pitch, dan Tuner jalan langsung di browser (web maupun Encore App).

## Playlist

- Playlist dari daftar link (YouTube & Google Drive bisa dicampur), auto next
- Bisa langsung tempel chat daftar lagu (mis. dari WhatsApp). Judul `1) Nama Lagu`, catatan seperti *Chorus saja*, dan nama ibadah ikut terbaca, dengan preview sebelum ditambahkan
- Geser lagu untuk mengubah urutan
- Prev / Play / Pause / Stop / Next, lompat ±5s dan ±10s
- Ulang: tanpa ulang, ulang 1 lagu, ulang semua · acak
- Kecepatan 0.25×–2×, loop A–B (penanda A/B bisa digeser di progress bar)
- Equalizer 5-band (80 Hz–12 kHz, ±12 dB) dengan preset Flat, Bass +, Tanpa bass, dan Vokal. Khusus lagu Google Drive; audio YouTube tidak bisa diolah browser
- Bisa dipasang di layar HP (Add to Home Screen), dengan kontrol di layar kunci untuk audio Drive
- Audio Drive otomatis disimpan di perangkat: hemat kuota saat diputar ulang dan bisa offline
- Playlist versi online dan Encore App bisa disamakan (di browser yang sama): klik **Sambungkan playlist** di halaman Breakdown versi online. App di komputer menyimpan salinan bersama (`/api/sync`), perubahan terbaru yang menang. Chrome/Edge meminta izin akses jaringan lokal sekali; Safari belum dites
- Di Encore App: tombol **Breakdown** di setiap lagu

File Google Drive harus dibagikan sebagai **"Siapa saja yang memiliki link"**.

## Breakdown

- Tarik file audio atau tempel link YouTube / Google Drive. Lagu masuk antrian dan dianalisis satu per satu oleh Encore App; tab browser boleh ditutup, asal app-nya tetap jalan
- Dua mode:
  - **Cepat** (default, bawaan app, tanpa AI): pemisahan dengan masker spektral. Drum dari HPSS; vokal dari bunyi harmonik yang di tengah stereo dan tidak berulang (REPET-SIM); bass dari sisa harmonik di bawah ±180 Hz; sisanya "lainnya". Sekitar 1 menit per lagu di CPU. Gitar dan piano belum dipisah, dan stem masih bocor
  - **Detail (AI)**: mesin AI terpisah yang diunduh dari dalam app saat pertama dipilih. Isinya Demucs `htdemucs` + spesialis bass `htdemucs_ft` + gitar/piano dari `htdemucs_6s`, beat_this, dan Basic Pitch (PyTorch, GPU Apple/NVIDIA kalau ada). Lagu hasil mode cepat bisa di-"upgrade" lewat tombol **Detail pakai AI**
- Transkripsi bass: pYIN + deteksi petikan ulang. Bagian slap/pop memakai Basic Pitch, dan not sangat rendah diisi pYIN
- Tempo, beat & downbeat (beat_this; mode cepat: librosa + tebakan awal bar 4/4), chord & kunci, slash chord dari bass
- **Mixer 6 stem**: Drum, Bass, Vokal, Gitar, Piano, Lainnya (pad/synth). Masing-masing bisa mute, solo, dan diatur volumenya; semuanya kalau dijumlah persis lagu aslinya
- Satu pilihan tampilan: **Multitrack · Drum · Bass · Vokal · Piano · Gitar · Chord · Not** (bagian yang tidak ada disembunyikan)
  - **Multitrack**: semua instrumen bertumpuk di satu timeline, dengan penanda **filler** (gitar/piano/pad mengisi saat vokal diam) dan **fill drum**. Klik nama lajur untuk mute
  - **Drum**: grid 16 langkah per bar (hi-hat, snare, tom, kick), bar fill ditandai otomatis. Deteksinya memakai ciri spektrum, jadi di rekaman live snare masih bisa tertukar dengan klik kick atau simbal
  - **Bass**: grafik atau tab (4/5 senar, otomatis)
  - **Vokal**: kontur nada (vibrato, slide) plus not-notnya
  - **Piano / Gitar**: piano roll dari not polifonik (Basic Pitch, nada harmonik disaring). Gitar juga punya **tab 6 senar** (tebakan terbaik: jangkauan tangan maks. 4 fret, perpindahan minimal)
  - **Chord**: lembar chord per bar (4 bar per baris) seperti chord sheet, tanpa lirik. Transpose ke kunci mana pun, ukuran huruf A−/A+, cetak atau simpan PDF. Bar yang sedang bunyi menyala dan halaman ikut bergulir; klik bar atau chord untuk lompat ke situ
  - **Not**: melodi vokal atau bass sebagai **not balok**, **not angka**, atau **huruf** (C D E), dengan nama chord di atasnya. Not yang sedang bunyi menyala dan halaman ikut bergulir; klik not untuk lompat. Not dibulatkan ke grid 1/16 (1/8 untuk lagu ≥110 BPM) mengikuti beat yang terdeteksi, jadi tempo live yang naik turun tidak merusak birama. Bisa transpose, cetak/PDF, dan export **MusicXML** untuk dibuka di MuseScore, Sibelius, Finale, dll. Hasilnya draf dari transkripsi otomatis: vokal masih bisa penuh not hiasan
- **Chord lengkap**: mayor/minor plus 7, maj7, m7, sus2, sus4, add9, dim, dan slash chord. Not bass ikut membantu (misalnya C dengan bass A dibaca Am7). Ambang batasnya sengaja konservatif
- **MIDI** per bagian: bass, vokal, piano, gitar, drum
- Loop dan speed tanpa ubah nada
- Library (hasil analisis, stem, MIDI, audio asli) disimpan di komputer: `~/Library/Application Support/Encore` (Mac), `%APPDATA%\Encore` (Windows), `~/.local/share/encore` (Linux)
- Lagu yang dianalisis dengan algoritma lama ditandai **versi lama**

**Batasan:**

- Mode cepat kadang membaca tempo setengah atau dua kali lipat, dan stem-nya tidak sebersih mode AI
- Mode AI: mesin AI ±300–450 MB, lalu model AI ±500 MB saat lagu pertama (sekali saja)
- Butuh laptop/PC, RAM 8 GB+. Di Mac chip Apple lagu 4 menit selesai dalam beberapa menit; di Windows/Linux tanpa GPU NVIDIA (build-nya CPU) bisa jauh lebih lama
- Link YouTube butuh `deno` atau `node` terpasang di komputer itu supaya selalu bisa diunduh; tanpa itu sebagian video bisa gagal. Upload file atau link Drive selalu bisa
- App belum ditandatangani Apple/Microsoft, jadi pertama kali dibuka muncul peringatan (lihat halaman Breakdown di web atau catatan rilis)

## Perfect Pitch

- 60 level dalam 5 tahap: **Pemula** (7 not natural) → **Dasar** (lengkap 12 not) → **Menengah** (2–3 oktaf, suara organ) → **Mahir** (semua warna suara, bunyi lebih singkat, akor mayor) → **Master** (4 oktaf, akor mayor & minor)
- Tiap level: pemanasan (putar not-notnya sesuka hati), lalu kuis. Lulus kalau benar minimal 80%; tiap tahap ditutup ujian
- Jawab lewat keyboard piano di layar atau tombol `C`–`B` (Shift untuk ♯)
- Tanpa akun: progres disimpan di browser, dan ikut tersinkron antara versi online dan Encore App di browser yang sama. Level mana pun bisa langsung dipilih

## Tuner

- Mendeteksi nada dari mikrofon (algoritma YIN): nama not + oktaf, solfa, frekuensi (Hz), dan selisihnya dalam sen. Jarum hijau kalau selisihnya ±5 sen
- Pilihan alat: **Kromatik**, **Gitar**, **Gitar Drop D**, **Bass 4 senar**, **Bass 5 senar** (sampai B rendah ±31 Hz), **Ukulele**, **Biola**
- Senar terdekat dipilih otomatis, dengan petunjuk kencangkan/kendorkan. Klik senar untuk mendengar nada acuannya dan mengunci tuner ke senar itu
- Nada acuan A4 bisa diubah (415–466 Hz, standar 440)
- **Pilih input**: mikrofon bawaan, Ampero / audio interface USB, dll. Pilihan diingat. Bar level di sebelahnya menunjukkan apakah suara benar-benar masuk
- **Cek frekuensi** (tombol `T`): spektrum live 30 Hz–16 kHz. Tiap slap / pop / petikan direkam otomatis, lalu tiap band (Low-mid, Mid, Slap/attack 2–5 kHz, Presence, Click/air 8–16 kHz) dibandingkan ke Body (30–300 Hz). Tabel per nada memberi tanda merah kalau satu nada 3 dB lebih kencang dari rata-rata nada lain di band itu
- Butuh izin mikrofon dan HTTPS (atau localhost). Mikrofon otomatis mati saat pindah halaman

## Encore App

`backend/` berisi server Python (FastAPI) yang menyajikan tampilan yang sama plus pipeline analisisnya. `backend/main.py` menyalakan server di http://localhost:8765 lalu membuka browser.

App-nya dibangun dua bagian supaya download pertama kecil:

- **Encore** (`backend/encore.spec`): server + mode cepat, tanpa PyTorch
- **EncoreAI** (`backend/engine.spec`, `backend/engine.py`): mesin AI. App mengunduhnya dari GitHub Release versi yang sama (`backend/version.py`) ke folder data, lalu menjalankannya sebagai proses terpisah per lagu (`backend/ai.py`). Dari source, mesin AI langsung pakai Python yang sama kalau torch & demucs terpasang

Jalankan dari source (klik dua kali `start.command`, atau):

```bash
uv venv --python 3.12 .venv
uv pip install --python .venv/bin/python -r backend/requirements.txt
uv pip install --python .venv/bin/python --no-deps basic-pitch
.venv/bin/python backend/main.py
```

Build executable di komputer sendiri (hasilnya di `dist/`, hanya untuk OS yang sedang dipakai):

```bash
uv pip install --python .venv/bin/python pyinstaller pillow
.venv/bin/pyinstaller --noconfirm backend/encore.spec
.venv/bin/pyinstaller --noconfirm backend/engine.spec
# mode cepat, lalu mode AI dengan mesin hasil build (Windows/Linux: dist/Encore/Encore)
.venv/bin/python backend/smoke_test.py dist/Encore.app/Contents/MacOS/Encore dist/EncoreAI/EncoreAI
```

**Rilis untuk Mac, Windows, dan Linux sekaligus:** naikkan `APP_VERSION` di `backend/version.py`, lalu push tag yang sama. GitHub Actions (`.github/workflows/release.yml`) membangun app dan mesin AI untuk ketiga OS, menjalankan smoke test (klip pendek di mode cepat lalu mode AI) di tiap OS, lalu menerbitkan GitHub Release. Halaman download di web selalu menunjuk ke rilis terbaru.

```bash
git tag app-v1.1.0 && git push origin app-v1.1.0
```

## Jalankan versi web

```bash
node dev.mjs
```

Lalu buka http://localhost:8765. `dev.mjs` menyajikan versi web plus fungsi `api/` (Drive & judul) sama seperti di Vercel. Breakdown di sini menampilkan halaman download app (jalankan Encore App di port lain kalau perlu keduanya: `PORT=8766 .venv/bin/python backend/main.py`).

## Deploy ke Vercel

Import repo ini di Vercel, pilih Framework Preset **Other**, lalu Deploy. Yang ter-deploy hanya `index.html`, `app/`, dan `api/` (lihat `.vercelignore`). `api/drive.js` meneruskan audio Drive dan `api/title.js` mengambil judul lagu.

## Struktur

| Path | Isi |
|---|---|
| `index.html`, `app/` | Tampilan: `core.js`, `playlist.js`, `bass.js` (Breakdown), `ear.js` (Perfect Pitch), `tuner.js` (Tuner), `spectrum.js` (Cek frekuensi), `aimode.js` (mode cepat/AI), `getapp.js` (halaman download), `sync.js`, `tour.js` (tur Cara pakai), `main.js`, `styles.css` |
| `app/config.js` | Alamat rilis Encore App |
| `api/` | Fungsi Vercel untuk Drive & judul |
| `backend/app.py` | Server Encore App: antrian, library, file stem/MIDI, Drive & judul |
| `backend/pipeline.py` | Analisis: Demucs, pYIN, Basic Pitch, beat_this, chord, drum, MIDI |
| `backend/main.py` | Pembuka app (server + browser, ikon Dock di Mac) |
| `backend/ai.py`, `backend/engine.py` | Mesin AI: unduh/pasang, dan program yang menjalankan analisis AI |
| `backend/version.py` | Versi app (= tag rilis) |
| `backend/encore.spec`, `backend/engine.spec`, `backend/smoke_test.py` | Build PyInstaller dan tes hasil build |
| `dev.mjs` | Server lokal untuk versi web |

## Shortcut keyboard

**Playlist:** `Space` play/pause · `N`/`P` next/prev · `S` stop · `R` mode ulang · `←`/`→` 5 detik · `J`/`L` 10 detik · `[`/`]` kecepatan · `A`/`B`/`C` loop A–B

**Breakdown:** `Space` play/pause · `←`/`→` 2 detik · `A`/`B` titik loop · `L` loop on/off · `Esc` hapus loop · `M` multitrack · `V` bagian berikutnya · `T` grafik ↔ tab (bass, gitar) · `1`–`6` mute kanal mixer

**Perfect Pitch:** `Space` putar soal lagi · `C`–`B` jawab not (Shift untuk ♯) · `Enter` mulai / lihat jawaban / soal berikutnya · `←`/`→` level sebelumnya / berikutnya · `Esc` keluar dari latihan

**Tuner:** `Space` nyalakan/matikan mikrofon · `T` ganti Tuner / Cek frekuensi · `1`–`6` bunyikan & kunci senar
