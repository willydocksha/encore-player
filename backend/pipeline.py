"""audio pipeline: fetch -> separate -> transcribe bass -> detect chords/beats/key."""

from __future__ import annotations

import html
import http.cookiejar
import json
import os
import re
import shutil
import subprocess
import time
import traceback
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Callable

import librosa
import numpy as np
import scipy.ndimage
import soundfile as sf

SR = 44100
# bump when the analysis changes enough that old results are worth redoing
PIPELINE_VERSION = 10
# stems saved for the player mixer, in display order
STEMS = ("drums", "bass", "vocals", "guitar", "piano", "other")
NOTE_NAMES_SHARP = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]
NOTE_NAMES_FLAT = ["C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B"]

Progress = Callable[[str, float], None]


# ---------------------------------------------------------------- fetch

def ffmpeg() -> str:
    """the ffmpeg bundled with the app (imageio-ffmpeg), else the one on PATH."""
    try:
        import imageio_ffmpeg

        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:
        return shutil.which("ffmpeg") or "ffmpeg"


def device() -> str:
    """fastest torch device here: apple gpu, nvidia gpu, else cpu."""
    import torch

    if torch.backends.mps.is_available():
        return "mps"
    return "cuda" if torch.cuda.is_available() else "cpu"


def ffmpeg_to_wav(src: Path, dst: Path) -> None:
    subprocess.run(
        [ffmpeg(), "-y", "-loglevel", "error", "-i", str(src), "-ac", "2", "-ar", str(SR), str(dst)],
        check=True,
    )


def ffmpeg_to_mp3(src: Path, dst: Path) -> None:
    subprocess.run(
        [ffmpeg(), "-y", "-loglevel", "error", "-i", str(src), "-b:a", "192k", str(dst)],
        check=True,
    )


def fetch_youtube(url: str, workdir: Path, on_progress: Callable[[float], None] | None = None) -> tuple[Path, str]:
    import time

    import yt_dlp

    def hook(d: dict) -> None:
        if on_progress and d.get("status") == "downloading":
            total = d.get("total_bytes") or d.get("total_bytes_estimate")
            if total:
                on_progress(min(1.0, d.get("downloaded_bytes", 0) / total))

    opts = {
        "format": "bestaudio/best",
        "outtmpl": str(workdir / "download.%(ext)s"),
        "noplaylist": True,
        "quiet": True,
        "no_warnings": True,
        "retries": 5,
        "progress_hooks": [hook],
    }
    # youtube needs a js runtime: use deno or node when this computer has one
    runtimes = {name: {"path": shutil.which(name)} for name in ("deno", "node") if shutil.which(name)}
    if runtimes:
        opts["js_runtimes"] = runtimes
    # opt-in: reuse the youtube login of a local browser when youtube asks to sign in
    browser = os.environ.get("DELVE_YT_COOKIES_BROWSER", "").strip()
    if browser:
        opts["cookiesfrombrowser"] = (browser,)

    # youtube randomly answers 403 on the first try; a fresh attempt usually works
    last: Exception | None = None
    for attempt in range(4):
        try:
            with yt_dlp.YoutubeDL(opts) as ydl:
                info = ydl.extract_info(url, download=True)
                path = Path(ydl.prepare_filename(info))
            return path, info.get("title") or "YouTube audio"
        except yt_dlp.utils.DownloadError as e:
            msg = str(e).lower()
            # login walls do not go away on retry
            if "sign in" in msg or "login" in msg or "members-only" in msg or "private video" in msg:
                raise RuntimeError(
                    "video ini butuh login YouTube (private, members-only, age-restricted, "
                    "atau YouTube sedang curiga bot). Coba video lain atau upload file audionya."
                ) from e
            if "unavailable" in msg and "country" in msg:
                raise RuntimeError("video ini tidak tersedia di negaramu") from e
            last = e
            time.sleep(2 * (attempt + 1))
    raise RuntimeError(f"gagal download dari YouTube: {last}")


DRIVE_PRIVATE_MSG = ("File Google Drive tidak publik. Bagikan sebagai “Siapa saja yang memiliki link”, "
                     "lalu salin ulang link-nya dari tombol Bagikan.")


def drive_id(url: str) -> str | None:
    """drive link -> "<file id>" or "<file id>.<resource key>" (old files shared before 2021)."""
    q = urllib.parse.urlparse(url)
    m = re.search(r"/d/([\w-]{10,})", q.path)
    params = urllib.parse.parse_qs(q.query)
    fid = m.group(1) if m else (params.get("id") or [None])[0]
    rk = (params.get("resourcekey") or [None])[0]
    if fid and rk and re.fullmatch(r"[\w-]+", rk):
        return f"{fid}.{rk}"
    return fid


def open_drive(raw_id: str, rng: str | None = None):
    """open a public drive file (same flow as api/drive.js), following the virus-scan page of big files."""
    fid, _, rk = raw_id.partition(".")
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))

    def req(params: dict):
        r = urllib.request.Request("https://drive.usercontent.google.com/download?" + urllib.parse.urlencode(params),
                                   headers={"User-Agent": "Mozilla/5.0", **({"Range": rng} if rng else {})})
        return opener.open(r, timeout=30)

    resp = req({"id": fid, "export": "download", **({"resourcekey": rk} if rk else {})})
    if resp.headers.get_content_type() == "text/html":
        page = resp.read().decode("utf-8", "ignore")
        fields = dict(re.findall(r'name="([^"]+)" value="([^"]*)"', page))
        if rk:
            fields.setdefault("resourcekey", rk)
        if "confirm" not in fields:
            raise PermissionError(DRIVE_PRIVATE_MSG)
        resp = req(fields)
    return resp


def drive_title(raw_id: str) -> str | None:
    fid, _, rk = raw_id.partition(".")
    try:
        url = f"https://drive.google.com/file/d/{fid}/view" + (f"?resourcekey={rk}" if rk else "")
        with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"}), timeout=10) as r:
            m = re.search(r"<title>(.*?)</title>", r.read(200000).decode("utf-8", "ignore"), re.S)
    except Exception:
        return None
    if not m:
        return None
    title = html.unescape(m.group(1)).removesuffix(" - Google Drive").strip()
    if not title or title.startswith("Google Drive"):
        return None
    return title.rsplit(".", 1)[0] if "." in title else title


def fetch_gdrive(url: str, workdir: Path, on_progress: Callable[[float], None] | None = None) -> tuple[Path, str]:
    raw_id = drive_id(url)
    if not raw_id:
        raise RuntimeError("link Google Drive tidak dikenali")
    try:
        resp = open_drive(raw_id)
    except urllib.error.HTTPError as e:
        raise RuntimeError(DRIVE_PRIVATE_MSG if e.code in (401, 403, 404) else f"gagal mengunduh dari Google Drive ({e.code})") from e
    total = int(resp.headers.get("Content-Length") or 0)
    path = workdir / "download"
    got = 0
    with resp, path.open("wb") as f:
        while chunk := resp.read(256 * 1024):
            f.write(chunk)
            got += len(chunk)
            if on_progress and total:
                on_progress(min(1.0, got / total))
    return path, drive_title(raw_id) or "Lagu dari Google Drive"


# ---------------------------------------------------------------- separation

def separate(src_wav: Path, outdir: Path, on_progress: Callable[[float], None] | None = None) -> dict[str, Path]:
    """htdemucs for all stems, then the htdemucs_ft bass specialist for a cleaner, more complete bass."""
    import torch
    from demucs.apply import apply_model
    from demucs.pretrained import get_model

    audio, _ = sf.read(src_wav, dtype="float32", always_2d=True)
    wav = torch.from_numpy(audio.T.copy())
    ref = wav.mean(0)
    mean, std = ref.mean(), ref.std() + 1e-8
    wav = (wav - mean) / std
    n_samples = wav.shape[-1]

    def run(model, lo: float, hi: float):
        def callback(info: dict) -> None:
            if on_progress and info.get("state") == "end":
                on_progress(lo + (hi - lo) * min(1.0, info.get("segment_offset", 0) / max(1, n_samples)))

        def go(device: str):
            with torch.no_grad():
                return apply_model(model, wav[None], device=device, shifts=1, split=True, overlap=0.25,
                                   progress=False, callback=callback)[0]

        # try the gpu first, fall back to cpu
        try:
            out = go(device())
        except Exception:
            out = go("cpu")
        return (out * std + mean).cpu().numpy()

    model = get_model("htdemucs")
    model.eval()
    sources = run(model, 0.0, 0.5)
    stems = {name: sources[i].T for i, name in enumerate(model.sources)}

    # the fine-tuned bag has one specialist per source; only the bass one is needed.
    # it keeps short bass accents that htdemucs tends to hand to "other".
    try:
        bag = get_model("htdemucs_ft")
        bi = bag.sources.index("bass")
        k = next(i for i, w in enumerate(bag.weights) if w[bi] > 0 and sum(w) == w[bi])
        spec = bag.models[k]
        spec.eval()
        stems["bass"] = run(spec, 0.5, 0.7)[spec.sources.index("bass")].T
    except Exception:
        traceback.print_exc()

    # guitar and piano come from the 6-source model; the rest of "other" stays as pads/synths
    try:
        six = get_model("htdemucs_6s")
        six.eval()
        out6 = run(six, 0.7, 1.0)
        for name in ("guitar", "piano"):
            stems[name] = out6[six.sources.index(name)].T
    except Exception:
        traceback.print_exc()

    # chords read all harmony instruments together (same as the old "other" stem)
    harmony = audio - stems["bass"] - stems["drums"] - stems["vocals"]
    # "other" is whatever is left, so all stems always add up to the original mix
    stems["other"] = harmony - stems.get("guitar", 0) - stems.get("piano", 0)

    paths: dict[str, Path] = {}
    for name, data in stems.items():
        p = outdir / f"stem_{name}.wav"
        sf.write(p, data, SR)
        paths[name] = p
    paths["harmony"] = outdir / "stem_harmony.wav"
    sf.write(paths["harmony"], harmony, SR)

    return paths


def _band(freqs: np.ndarray, lo: float, hi: float, soft: float = 0.5) -> np.ndarray:
    """weight 1 inside lo..hi hz, fading out over `soft` octaves on each side."""
    f = np.maximum(freqs, 1.0)
    below = np.clip(1 + np.log2(f / lo) / soft, 0, 1)
    above = np.clip(1 - np.log2(f / hi) / soft, 0, 1)
    return np.minimum(below, above)[:, None]


def separate_classic(src_wav: Path, outdir: Path, on_progress: Callable[[float], None] | None = None) -> dict[str, Path]:
    """fast separation without ai: soft spectral masks, so the stems still add up to the mix.

    drums: percussive part (hpss). vocals: harmonic, centre-panned, non-repeating sound in the
    voice band (repet-sim). bass: low harmonic rest. other: everything left.
    """
    audio, _ = sf.read(src_wav, dtype="float32", always_2d=True)
    n_fft, hop = 4096, 1024
    tick = on_progress or (lambda p: None)
    spec = [librosa.stft(audio[:, ch], n_fft=n_fft, hop_length=hop) for ch in range(2)]
    L, R = spec
    freqs = librosa.fft_frequencies(sr=SR, n_fft=n_fft)
    mag = (np.abs(L) + np.abs(R)) / 2
    tick(0.1)

    harm, perc = librosa.decompose.hpss(mag, kernel_size=31, mask=True, margin=1.0)
    tick(0.35)

    # how alike left and right are per bin: 1 = centre (lead vocal), 0 = panned to a side
    centre = 2 * np.abs(L * np.conj(R)) / (np.abs(L) ** 2 + np.abs(R) ** 2 + 1e-10)
    # repet-sim: the backing repeats across the song, the voice does not. chunks keep memory small
    sh = mag * harm
    fg = np.zeros_like(sh)
    chunk = int(60 * SR / hop)
    width = int(2 * SR / hop)
    for i, a in enumerate(range(0, sh.shape[1], chunk)):
        part = sh[:, a:a + chunk]
        if part.shape[1] <= 2 * width + 1:
            fg[:, a:a + chunk] = 0.5
            continue
        bg = np.minimum(part, librosa.decompose.nn_filter(part, aggregate=np.median, metric="cosine", width=width))
        fg[:, a:a + chunk] = librosa.util.softmask(part - bg, 2 * bg, power=2)
        tick(0.35 + 0.4 * min(1.0, (a + chunk) / sh.shape[1]))

    m_drums = perc * _band(freqs, 30, 16000, soft=1.0)
    m_vocals = harm * fg * centre ** 2 * _band(freqs, 180, 6000, soft=1.0)
    m_bass = (harm - m_vocals) * _band(freqs, 30, 180, soft=0.6)
    tick(0.8)

    n = audio.shape[0]
    istft = lambda m: np.stack([librosa.istft(S * m, hop_length=hop, length=n) for S in spec], 1)
    stems = {"drums": istft(m_drums), "vocals": istft(m_vocals), "bass": istft(m_bass)}
    # same split as the ai path: harmony for chords, "other" is the exact rest of the mix
    harmony = audio - stems["bass"] - stems["drums"] - stems["vocals"]
    stems["other"] = harmony

    paths: dict[str, Path] = {}
    for name, data in stems.items():
        paths[name] = outdir / f"stem_{name}.wav"
        sf.write(paths[name], data, SR)
    paths["harmony"] = outdir / "stem_harmony.wav"
    sf.write(paths["harmony"], harmony, SR)
    tick(1.0)
    return paths


# ---------------------------------------------------------------- bass transcription

PYIN_SR, PYIN_HOP, PYIN_FRAME = 11025, 64, 1024
_pool = None


def _exit_with_parent(parent_pid: int) -> None:
    # worker initializer: quit when the server dies, even on kill -9 or a closed terminal
    import threading

    def watch():
        while os.getppid() == parent_pid:
            time.sleep(2)
        os._exit(0)

    threading.Thread(target=watch, daemon=True).start()


def shutdown_pool() -> None:
    """stop the pyin worker processes (called on app shutdown)."""
    global _pool
    if _pool is not None:
        _pool.shutdown(wait=False, cancel_futures=True)
        _pool = None


BASS_RANGE = ("B0", "G4")
VOCAL_RANGE = ("C2", "C6")


def _pyin_chunk(y: np.ndarray, rng: tuple[str, str] = BASS_RANGE) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    f0, voiced, vprob = librosa.pyin(
        y,
        fmin=librosa.note_to_hz(rng[0]),
        fmax=librosa.note_to_hz(rng[1]),
        sr=PYIN_SR,
        frame_length=PYIN_FRAME,
        hop_length=PYIN_HOP,
    )
    return f0, voiced, vprob


def parallel_pyin(y: np.ndarray, on_progress: Callable[[float], None] | None = None,
                  rng: tuple[str, str] = BASS_RANGE) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """pyin on overlapping 20 s chunks across cpu cores, stitched back on the global frame grid."""
    import os
    from concurrent.futures import ProcessPoolExecutor

    global _pool
    hop = PYIN_HOP
    chunk = (20 * PYIN_SR // hop) * hop
    ctx = (PYIN_SR // hop) * hop  # ~1 s of context each side
    n_frames = 1 + len(y) // hop
    if _pool is None:
        _pool = ProcessPoolExecutor(max_workers=max(1, min(6, (os.cpu_count() or 2) - 2)),
                                    initializer=_exit_with_parent, initargs=(os.getpid(),))

    jobs = []
    for s0 in range(0, len(y), chunk):
        a = max(0, s0 - ctx)
        jobs.append((s0, a, _pool.submit(_pyin_chunk, y[a:s0 + chunk + ctx], rng)))

    f0 = np.full(n_frames, np.nan)
    voiced = np.zeros(n_frames, dtype=bool)
    vprob = np.zeros(n_frames)
    for k, (s0, a, fut) in enumerate(jobs):
        cf0, cv, cp = fut.result()
        skip = (s0 - a) // hop
        dst0 = s0 // hop
        take = min(chunk // hop, n_frames - dst0, len(cf0) - skip)
        f0[dst0:dst0 + take] = cf0[skip:skip + take]
        voiced[dst0:dst0 + take] = cv[skip:skip + take]
        vprob[dst0:dst0 + take] = cp[skip:skip + take]
        if on_progress:
            on_progress((k + 1) / len(jobs))
    return f0, voiced, vprob


def transcribe_bass(bass_wav: Path, on_progress: Callable[[float], None] | None = None, ai: bool = True) -> list[dict]:
    sr, hop, frame = PYIN_SR, PYIN_HOP, PYIN_FRAME
    y, _ = librosa.load(bass_wav, sr=sr, mono=True)
    if not np.any(y):
        return []

    f0, voiced, vprob = parallel_pyin(y, on_progress)
    rms = librosa.feature.rms(y=y, frame_length=frame, hop_length=hop)[0]
    n = min(len(f0), len(rms))
    f0, voiced, vprob, rms = f0[:n], voiced[:n], vprob[:n], rms[:n]
    rms_db = librosa.amplitude_to_db(rms, ref=np.max)
    frame_t = hop / sr

    active = voiced & (rms_db > -38) & np.isfinite(f0)
    midi = librosa.hz_to_midi(np.nan_to_num(f0, nan=1.0))
    q = np.where(active, np.round(midi), -1).astype(int)

    # attacks: onset detector + starts of voiced regions + re-plucks of a ringing string
    onsets = librosa.onset.onset_detect(
        y=y, sr=sr, hop_length=hop, backtrack=False, units="frames", delta=0.08, wait=int(0.06 / frame_t)
    )
    starts = np.flatnonzero(active & ~np.r_[False, active[:-1]])
    is_reattack, reattacks = reattack_evidence(y, hop, n, active, frame_t)
    bounds = sorted(set(onsets.tolist()) | set(starts.tolist()) | set(reattacks.tolist()) | {n})

    min_frames = max(1, int(0.05 / frame_t))
    stable = max(1, int(0.03 / frame_t))
    notes: list[dict] = []
    for s, e in zip(bounds, bounds[1:]):
        seg = q[s:e]
        # pitch runs inside this attack segment; split on legato pitch changes
        runs: list[list[int]] = []
        for i, p in enumerate(seg):
            if runs and runs[-1][0] == p:
                runs[-1][2] = i + 1
            else:
                runs.append([p, i, i + 1])
        runs = [r for r in runs if r[0] >= 0 and r[2] - r[1] >= stable]
        # merge adjacent runs of the same pitch separated by glitches
        merged_runs: list[list[int]] = []
        for r in runs:
            if merged_runs and merged_runs[-1][0] == r[0]:
                merged_runs[-1][2] = r[2]
            else:
                merged_runs.append(r)
        for k, (p, rs, re_) in enumerate(merged_runs):
            # first run of an attack starts at the attack itself
            start = s if k == 0 and rs * frame_t < 0.12 else s + rs
            end = s + re_
            if end - start < min_frames:
                continue
            notes.append({
                "t": round(start * frame_t, 3),
                "d": round((end - start) * frame_t, 3),
                "midi": int(p),
                "v": round(float(np.clip(np.max(rms[start:end]) / (np.max(rms) + 1e-9), 0, 1)), 3),
                "c": round(float(np.mean(vprob[start:end])), 3),
                "_f": int(start),
            })

    # same pitch back to back: keep the split only if there is real re-pluck evidence
    start_set = set(starts.tolist())
    kept: list[dict] = []
    for nt in notes:
        if kept:
            last = kept[-1]
            gap = nt["t"] - (last["t"] + last["d"])
            f = nt["_f"]
            if last["midi"] == nt["midi"] and gap < 0.03 and f not in start_set and not is_reattack(f):
                last["d"] = round(nt["t"] + nt["d"] - last["t"], 3)
                last["v"] = max(last["v"], nt["v"])
                continue
        kept.append(nt)
    for nt in kept:
        nt.pop("_f", None)
    notes = absorb_blips(kept)

    # sections where pyin is unsure (slap, pops, dead notes): use basic pitch there instead
    weak = weak_sections(vprob, rms_db, frame_t)
    if ai and weak.any():
        try:
            alt = basic_pitch_notes(bass_wav)
            in_weak = lambda t: weak[min(len(weak) - 1, int(t / SECTION_SEC))]
            alt_weak = [nt for nt in alt if in_weak(nt["t"])]
            # basic pitch is deaf below ~E1; keep pyin notes where it left a gap
            gap_fill = [nt for nt in notes if in_weak(nt["t"]) and nt["d"] >= 0.1
                        and all(overlap(nt, b) < 0.3 * nt["d"] and abs(nt["t"] - b["t"]) > 0.08 for b in alt_weak)]
            notes = sorted([nt for nt in notes if not in_weak(nt["t"])] + alt_weak + gap_fill,
                           key=lambda nt: nt["t"])
        except Exception:
            traceback.print_exc()
    for nt in notes:
        nt.pop("c", None)
    return notes


VOCAL_GATE_SEC = 2.0
VOCAL_GATE_DB = -20.0  # on a test song: drops half the intro / interlude bleed, keeps 97% of sung notes


def transcribe_vocals(vocals_wav: Path, on_progress: Callable[[float], None] | None = None) -> dict:
    """sung melody: notes plus the continuous pitch contour (vibrato, slides) for display."""
    sr, hop, frame = PYIN_SR, PYIN_HOP, PYIN_FRAME
    y, _ = librosa.load(vocals_wav, sr=sr, mono=True)
    frame_t = hop / sr
    if not np.any(y):
        return {"notes": [], "contour": {"t0": 0.0, "step": frame_t, "midi": []}}

    f0, voiced, vprob = parallel_pyin(y, on_progress, VOCAL_RANGE)
    rms = librosa.feature.rms(y=y, frame_length=frame, hop_length=hop)[0]
    n = min(len(f0), len(rms))
    f0, voiced, vprob, rms = f0[:n], voiced[:n], vprob[:n], rms[:n]
    rms_db = librosa.amplitude_to_db(rms, ref=np.max)
    active = voiced & (rms_db > -35) & np.isfinite(f0)
    # stretches far below the sung level (2 s average) are other instruments leaking into the
    # vocal stem, e.g. an instrumental intro: no notes there
    local = scipy.ndimage.uniform_filter1d(rms_db, max(1, int(VOCAL_GATE_SEC / frame_t)))
    active &= local > np.percentile(rms_db, 95) + VOCAL_GATE_DB
    midi = np.where(active, librosa.hz_to_midi(np.nan_to_num(f0, nan=1.0)), np.nan)

    # contour for drawing: light smoothing, ~23 ms resolution
    step = 4
    smooth = scipy.ndimage.median_filter(np.nan_to_num(midi, nan=0.0), size=5)
    contour = [round(float(v), 2) if a else None for v, a in zip(smooth[::step], active[::step])]

    # a new syllable on the same pitch shows up as a dip in loudness: treat deep dips as breaks.
    # a short 23 ms window is needed, the pitch window smooths the dip away.
    env = librosa.amplitude_to_db(librosa.feature.rms(y=y, frame_length=256, hop_length=hop)[0], ref=np.max)
    env = np.pad(env[:n], (0, max(0, n - len(env))), constant_values=-80.0)
    w = max(1, int(0.1 / frame_t))
    lmax = scipy.ndimage.maximum_filter1d(env, size=w)
    left = np.r_[np.full(w, -80.0), lmax[:-w]] if n > w else lmax
    right = np.r_[lmax[w:], np.full(w, -80.0)] if n > w else lmax
    is_min = env <= scipy.ndimage.minimum_filter1d(env, size=2 * w + 1)
    dip = is_min & (left - env >= 6) & (right - env >= 6)
    active = active & ~dip

    # notes: a new note starts when the pitch settles more than ~0.6 semitone away for 50 ms
    settle = max(1, int(0.05 / frame_t))
    notes: list[dict] = []
    i = 0
    while i < n:
        if not active[i]:
            i += 1
            continue
        start, ref, j, away = i, smooth[i], i, 0
        vals = []
        while j < n and active[j]:
            if abs(smooth[j] - ref) > 0.6:
                away += 1
                if away >= settle:
                    j -= away - 1
                    break
            else:
                away = 0
                vals.append(smooth[j])
                ref = float(np.median(vals[-20:]))
            j += 1
        end = j
        if (end - start) * frame_t >= 0.08 and vals:
            notes.append({
                "t": round(start * frame_t, 3),
                "d": round((end - start) * frame_t, 3),
                "midi": int(round(float(np.median(vals)))),
                "v": round(float(np.clip(np.max(rms[start:end]) / (np.max(rms) + 1e-9), 0, 1)), 3),
            })
        i = max(end, start + 1)

    # join same-pitch notes split by a breath shorter than 60 ms
    merged: list[dict] = []
    for nt in notes:
        gap = nt["t"] - (merged[-1]["t"] + merged[-1]["d"]) if merged else 1.0
        gap_frames = range(int(round((nt["t"] - gap) / frame_t)), int(round(nt["t"] / frame_t)))
        if merged and merged[-1]["midi"] == nt["midi"] and gap < 0.06 and not any(dip[k] for k in gap_frames if k < n):
            merged[-1]["d"] = round(nt["t"] + nt["d"] - merged[-1]["t"], 3)
        else:
            merged.append(nt)
    return {"notes": merged, "contour": {"t0": 0.0, "step": round(frame_t * step, 5), "midi": contour}}


def overlap(a: dict, b: dict) -> float:
    return max(0.0, min(a["t"] + a["d"], b["t"] + b["d"]) - max(a["t"], b["t"]))


SECTION_SEC = 2.0
WEAK_CONFIDENCE = 0.2  # median pyin confidence on loud frames; slap sections sit around 0.1-0.15


def weak_sections(vprob: np.ndarray, rms_db: np.ndarray, frame_t: float) -> np.ndarray:
    per = int(SECTION_SEC / frame_t)
    n_sec = int(np.ceil(len(vprob) / per))
    weak = np.zeros(n_sec, dtype=bool)
    for k in range(n_sec):
        sl = slice(k * per, (k + 1) * per)
        loud = rms_db[sl] > -30
        if loud.sum() > 10:
            weak[k] = float(np.mean(vprob[sl][loud])) < WEAK_CONFIDENCE
    return weak


def basic_pitch_notes(bass_wav: Path) -> list[dict]:
    """note-level transcription with spotify basic pitch, reduced to a single line."""
    import contextlib
    import io

    from basic_pitch import FilenameSuffix, build_icassp_2022_model_path
    from basic_pitch.inference import predict

    # always the onnx model: no tensorflow / coreml needed (and none exist for python 3.14)
    model_path = build_icassp_2022_model_path(FilenameSuffix.onnx)

    with contextlib.redirect_stdout(io.StringIO()):
        _, _, events = predict(
            str(bass_wav), model_path,
            onset_threshold=0.5, frame_threshold=0.3, minimum_note_length=50,
            minimum_frequency=29, maximum_frequency=400, melodia_trick=True,
        )
    events = sorted(events, key=lambda e: (e[0], -e[3]))
    peak = max((e[3] for e in events), default=1.0) or 1.0
    out: list[dict] = []
    for start, end, pitch, amp, _ in events:
        nt = {"t": round(float(start), 3), "d": round(float(end - start), 3), "midi": int(pitch),
              "v": round(float(min(1.0, amp / peak)), 3)}
        if out and nt["t"] < out[-1]["t"] + out[-1]["d"] - 0.03:
            prev = out[-1]
            louder = amp / peak > prev["v"] * 1.2
            if not louder:
                continue  # overlapping weaker note (harmonic / octave ghost)
            prev["d"] = round(nt["t"] - prev["t"], 3)
            if prev["d"] < 0.05:
                out.pop()
        out.append(nt)
    return out  # no blip folding: short slap notes are real


REATTACK_RISE_DB = 2.5      # level jump within ~50 ms of the attack
REATTACK_SUSTAIN_DB = 1.5   # level still higher ~100 ms later (kick bleed decays, a pluck does not)


def reattack_evidence(y: np.ndarray, hop: int, n: int, active: np.ndarray, frame_t: float):
    """detect re-plucks of the same note from the short-time level of the bass stem."""
    env = librosa.amplitude_to_db(librosa.feature.rms(y=y, frame_length=256, hop_length=hop)[0], ref=np.max)
    env = np.pad(env[:n], (0, max(0, n - len(env))), constant_values=-80.0)
    pad = 32
    e = np.pad(env, (pad, pad), mode="edge")
    win = np.lib.stride_tricks.sliding_window_view
    idx = np.arange(n) + pad
    pre = win(e, 6)[idx - 7].mean(axis=1)    # ~-40..-6 ms
    peak = win(e, 9)[idx].max(axis=1)        # 0..50 ms
    post = win(e, 11)[idx + 15].mean(axis=1)  # ~90..150 ms
    # decay trend over ~-80..-6 ms, extrapolated: a fast re-pluck of a still-ringing
    # note barely raises the level, but it does stop the decay
    trend_w = win(e, 13)[idx - 14]
    xs = np.arange(13) - 6.0
    slope = (trend_w - trend_w.mean(axis=1, keepdims=True)) @ xs / (xs @ xs)
    expected = pre + slope * 24
    rise = peak - pre
    sust = np.maximum(post - pre, post - expected)
    ok = (rise >= REATTACK_RISE_DB) & (sust >= REATTACK_SUSTAIN_DB) & active

    # one peak per attack: local max of rise, at least 90 ms apart
    spacing = max(1, int(0.09 / frame_t))
    local_max = rise == scipy.ndimage.maximum_filter1d(rise, size=2 * 7 + 1)
    cand = np.flatnonzero(ok & local_max)
    picks: list[int] = []
    for c in cand:
        if not picks or c - picks[-1] >= spacing:
            picks.append(int(c))

    def is_reattack(f: int) -> bool:
        lo, hi = max(0, f - 4), min(n, f + 5)
        return bool(np.any(ok[lo:hi]))

    return is_reattack, np.array(picks, dtype=int)


def absorb_blips(notes: list[dict], max_len: float = 0.08, max_gap: float = 0.03) -> list[dict]:
    """fold short pitch blips (attack scoops, slides, octave glitches) into the neighbouring note."""
    out = [dict(n) for n in notes]
    changed = True
    while changed:
        changed = False
        for i, n in enumerate(out):
            if n["d"] >= max_len:
                continue
            nxt = out[i + 1] if i + 1 < len(out) else None
            prv = out[i - 1] if i > 0 else None
            close = lambda a, b: abs(a["midi"] - b["midi"]) <= 2 or abs(a["midi"] - b["midi"]) == 12
            # scoop into the next note: next note takes over the attack time
            if nxt and nxt["t"] - (n["t"] + n["d"]) < max_gap and close(n, nxt) and nxt["d"] > n["d"]:
                end = nxt["t"] + nxt["d"]
                nxt["t"] = n["t"]
                nxt["d"] = round(end - n["t"], 3)
                nxt["v"] = max(nxt["v"], n["v"])
            # tail wobble of the previous note
            elif prv and n["t"] - (prv["t"] + prv["d"]) < max_gap and close(n, prv):
                prv["d"] = round(n["t"] + n["d"] - prv["t"], 3)
            else:
                continue
            out.pop(i)
            changed = True
            break
    return out


# ---------------------------------------------------------------- beats / key / chords

def guess_downbeats(y: np.ndarray, sr: int, beats: np.ndarray) -> np.ndarray:
    """4/4 guess without ai: the beat phase where low (kick / bass) onsets hit hardest starts the bar."""
    if len(beats) < 8:
        return np.array([])
    onset = librosa.onset.onset_strength(y=y, sr=sr, hop_length=512, fmax=200, n_mels=32)
    idx = np.clip(librosa.time_to_frames(beats, sr=sr, hop_length=512), 0, len(onset) - 1)
    phase = max(range(4), key=lambda k: onset[idx[k::4]].mean())
    return beats[phase::4]


# beat_this checkpoint: the official jku host first, then encore's own copy of the same file
# (same name, so torch hub caches it once). jku was down (503) on 2026-10-22.
BEAT_THIS_CHECKPOINTS = ("final0", "https://huggingface.co/willydocksha/encore-models/resolve/main/beat_this-final0.ckpt")


def beat_this_model():
    from beat_this.inference import Audio2Beats

    last = None
    for ckpt in BEAT_THIS_CHECKPOINTS:
        try:
            return Audio2Beats(checkpoint_path=ckpt, device=device(), dbn=False)
        except Exception as e:
            last = e
    raise RuntimeError(f"checkpoint beat_this tidak bisa diunduh: {last}")


def detect_beats(mix_wav: Path, ai: bool = True) -> tuple[float, list[float], list[float]]:
    """returns (bpm, beats, downbeats). uses beat_this, librosa without ai (downbeats guessed)."""
    y, sr = librosa.load(mix_wav, sr=22050, mono=True)
    try:
        if not ai:
            raise ImportError("classic mode")
        beats, downs = beat_this_model()(y, sr)
        beats, downs = np.asarray(beats), np.asarray(downs)
    except Exception:
        if ai:
            traceback.print_exc()
        _, frames = librosa.beat.beat_track(y=y, sr=sr, hop_length=512)
        beats = librosa.frames_to_time(frames, sr=sr, hop_length=512)
        downs = guess_downbeats(y, sr, beats)
    else:
        # beat_this without its dbn misses and doubles beats, and its downbeats jump around
        beats = regular_beats(beats)
        downs = bar_grid(beats, downs)
    r = lambda a: [round(float(t), 3) for t in a]
    return round(bpm_of(beats), 1), r(beats), r(downs)


def bpm_of(beats: np.ndarray) -> float:
    """tempo from the mean of the regular beat gaps.

    the median alone is stuck on beat_this's 20 ms frames (0.36 / 0.38 s = 166.7 / 157.9 bpm).
    """
    if len(beats) < 2:
        return 0.0
    gaps = np.diff(beats)
    med = float(np.median(gaps))
    ok = gaps[(gaps > 0.75 * med) & (gaps < 1.33 * med)]
    return 60.0 / float(ok.mean() if len(ok) else med)


def regular_beats(beats: np.ndarray) -> np.ndarray:
    """drop doubled beats (much closer than one beat) and fill single missed beats inside a steady pulse."""
    if len(beats) < 4:
        return beats
    med = float(np.median(np.diff(beats)))
    # doubled beats: keep the first of a too-close pair
    kept = [float(beats[0])]
    for b in beats[1:]:
        if b - kept[-1] >= 0.6 * med:
            kept.append(float(b))
    # missed beats: a gap of about 2 or 3 beats gets the beats in between
    out = [kept[0]]
    for b in kept[1:]:
        gap = b - out[-1]
        k = int(round(gap / med))
        if 2 <= k <= 3 and abs(gap / k - med) < 0.15 * med:
            out.extend(out[-1] + gap * i / k for i in range(1, k))
        out.append(b)
    return np.array(out)


def bar_grid(beats: np.ndarray, downs: np.ndarray) -> np.ndarray:
    """steady bars from noisy downbeat guesses: viterbi over the position of each beat in its bar.

    the meter is the most common bar length; a bar may end early (a real 2/4 bar) only when
    several downbeats in a row agree, so single wrong guesses don't break the grid.
    """
    if len(beats) < 8 or len(downs) < 2:
        return downs
    # downbeat evidence per beat
    hit = np.zeros(len(beats), dtype=bool)
    for d in downs:
        j = int(np.argmin(np.abs(beats - d)))
        if abs(beats[j] - d) < 0.1:
            hit[j] = True
    idx = np.flatnonzero(hit)
    lens = np.diff(idx)
    lens = lens[(lens >= 2) & (lens <= 7)]
    if not len(lens):
        return downs
    meter = int(np.bincount(lens).argmax())
    # 2-beat bars are mostly half bars: read them as 4
    if meter == 2:
        meter = 4
    # emissions: a downbeat guess is likely on beat 1, rare elsewhere
    p_on = np.where(hit, np.log(0.7), np.log(0.3))
    p_off = np.where(hit, np.log(0.05), np.log(0.95))
    stay, cut = np.log(0.997), np.log(0.003)
    n = len(beats)
    score = np.full(meter, -np.inf)
    score[0] = p_on[0]
    score[1:] = p_off[0] + np.log(1.0 / meter)
    back = np.zeros((n, meter), dtype=np.int16)
    for i in range(1, n):
        new = np.full(meter, -np.inf)
        for pos in range(meter):
            nxt = (pos + 1) % meter
            # normal step to the next beat of the bar
            if score[pos] + stay > new[nxt]:
                new[nxt] = score[pos] + stay
                back[i, nxt] = pos
            # early bar end: jump to beat 1
            if nxt != 0 and score[pos] + cut > new[0]:
                new[0] = score[pos] + cut
                back[i, 0] = pos
        new += np.where(np.arange(meter) == 0, p_on[i], p_off[i])
        score = new
    pos = int(np.argmax(score))
    path = np.zeros(n, dtype=int)
    for i in range(n - 1, -1, -1):
        path[i] = pos
        pos = back[i, pos]
    return beats[path == 0]


# krumhansl-kessler key profiles
KK_MAJOR = np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88])
KK_MINOR = np.array([6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17])
FLAT_KEYS = {(5, "maj"), (10, "maj"), (3, "maj"), (8, "maj"), (1, "maj"), (6, "maj"),
             (2, "min"), (7, "min"), (0, "min"), (5, "min"), (10, "min"), (3, "min")}


def detect_key(chroma_mean: np.ndarray) -> tuple[int, str]:
    best = (-np.inf, 0, "maj")
    for tonic in range(12):
        for mode, prof in (("maj", KK_MAJOR), ("min", KK_MINOR)):
            r = np.corrcoef(chroma_mean, np.roll(prof, tonic))[0, 1]
            if r > best[0]:
                best = (r, tonic, mode)
    return best[1], best[2]


def chord_templates() -> tuple[np.ndarray, list[tuple[int, str]]]:
    temps, labels = [], []
    for root in range(12):
        for qual, ivs in (("maj", (0, 4, 7)), ("min", (0, 3, 7))):
            t = np.zeros(12)
            t[[(root + i) % 12 for i in ivs]] = 1
            t[root] += 0.3  # root a bit stronger
            temps.append(t / np.linalg.norm(t))
            labels.append((root, qual))
    return np.array(temps), labels


# thresholds relative to the chord core (mean of root and fifth), tuned on a synthetic chord set
# chosen as the most conservative values that still read the synthetic set right (95% exact, no false
# extensions on plain triads); on a real worship song this marks ~1/4 of the time with 7/9/sus.
EXT = {"third_max": 0.45, "sus": 0.8, "seventh": 0.75, "add9": 0.8, "dim": 0.6}


def chord_extension(c: np.ndarray, root: int, qual: str) -> str:
    """suffix from the averaged chroma of the harmony stem: '', 'm', '7', 'maj7', 'm7', 'sus4', 'sus2', 'add9', 'dim'."""
    c = c / (c.max() + 1e-9)
    at = lambda iv: c[(root + iv) % 12]
    core = (at(0) + at(7)) / 2 + 1e-9
    if qual == "min":
        if at(6) >= EXT["dim"] * core and at(6) > at(7) * 1.1:
            return "dim"
        return "m7" if at(10) >= EXT["seventh"] * core else "m"
    if at(4) < EXT["third_max"] * core and max(at(5), at(2)) >= EXT["sus"] * core:
        return "sus4" if at(5) >= at(2) else "sus2"
    if at(11) >= EXT["seventh"] * core and at(11) > at(10):
        return "maj7"
    if at(10) >= EXT["seventh"] * core:
        return "7"
    if at(2) >= EXT["add9"] * core:
        return "add9"
    return ""


def bass_reading(c: np.ndarray, root: int, qual: str, bass_pc: int | None) -> tuple[int, str] | None:
    """re-read a triad over a foreign bass note as the seventh / sus chord of that bass note."""
    if bass_pc is None or bass_pc == root:
        return None
    iv = (root - bass_pc) % 12
    if qual == "maj" and iv == 3:
        return bass_pc, "min"  # c over a = am7
    if qual == "min" and iv == 4:
        return bass_pc, "maj"  # em over c = cmaj7
    c = c / (c.max() + 1e-9)
    at = lambda k: c[(bass_pc + k) % 12]
    core = (at(0) + at(7)) / 2 + 1e-9
    if at(7) > 0.5 and at(4) < EXT["third_max"] * core and at(3) < EXT["third_max"] * core and max(at(5), at(2)) >= EXT["sus"] * core:
        return bass_pc, "maj"  # sus chord on the bass note (e.g. g over d = dsus4)
    return None


def chord_viterbi(chroma_n: np.ndarray, silent: np.ndarray, bias: np.ndarray | None = None) -> np.ndarray:
    """best chord state per frame (24 triads + no chord); bias adds per-frame, per-chord score."""
    temps, _ = chord_templates()
    scores = temps @ chroma_n  # (24, frames)
    if bias is not None:
        scores = scores + bias
    # "no chord" state for silent / noisy frames
    n_score = np.where(silent, 1.0, 0.55)
    scores = np.vstack([scores, n_score])
    probs = np.exp(scores * 12)
    probs /= probs.sum(axis=0, keepdims=True)
    trans = librosa.sequence.transition_loop(probs.shape[0], 0.97)
    return librosa.sequence.viterbi_discriminative(probs, trans)


# chords of a major key as (interval from tonic, quality); index 0 is the tonic chord
DIATONIC = ((0, "maj"), (2, "min"), (4, "min"), (5, "maj"), (7, "maj"), (9, "min"))
KEY_BIAS = 0.05  # score bonus for chords that belong to the local key (scores are ~0.6-0.95)
KEY_SWITCH = 25.0  # cost of a key change, in seconds of evidence against the old key
KEY_MIN_SEC = 16.0  # shorter key sections are merged into their neighbours


def key_fit(root: int, qual: str) -> np.ndarray:
    """how well one chord fits each of the 24 keys (0-11 major, 12-23 minor)."""
    fit = np.full(24, -0.5)
    for tonic in range(12):
        for k, (iv, q) in enumerate(DIATONIC):
            if (tonic + iv) % 12 == root and q == qual:
                fit[tonic] = 1.0 + (0.5 if k == 0 else 0.2 if k == 4 else 0.0)
                # the relative minor shares the chords, its own tonic (vi) gets the bonus; its bVII
                # (the major key's V) says little, a major-key song leaning on vi must stay major
                rel = 12 + (tonic + 9) % 12
                fit[rel] = 1.0 + (0.5 if k == 5 else -0.2 if k == 4 else 0.0)
    # the major V of a minor key (harmonic minor) is strong minor evidence
    if qual == "maj":
        fit[12 + (root + 5) % 12] = max(fit[12 + (root + 5) % 12], 1.2)
    return fit


def key_sections(path: np.ndarray, labels: list[tuple[int, str]], frame_t: float) -> list[tuple[int, int]]:
    """local key per frame from the chord path: viterbi over 24 keys with a cost per change.

    returns [(first frame, key index)] per section; key index 0-11 major, 12-23 minor.
    """
    n_state = len(labels)
    fits = np.array([key_fit(*lab) for lab in labels] + [np.zeros(24)])
    ev = fits[path] * frame_t  # (frames, 24) evidence in chord-seconds
    n = len(path)
    score = ev[0].copy()
    back = np.zeros((n, 24), dtype=np.int8)
    for i in range(1, n):
        best = int(np.argmax(score))
        switch = score[best] - KEY_SWITCH
        keep = score >= switch
        back[i] = np.where(keep, np.arange(24), best)
        score = np.where(keep, score, switch) + ev[i]
    k = int(np.argmax(score))
    keys = np.zeros(n, dtype=int)
    for i in range(n - 1, -1, -1):
        keys[i] = k
        k = back[i, k]
    # sections, short ones merged into the previous (or next) section
    secs = [[0, int(keys[0]), 0]]
    for i in range(1, n):
        if keys[i] != secs[-1][1]:
            secs[-1][2] = i
            secs.append([i, int(keys[i]), 0])
    secs[-1][2] = n
    min_frames = KEY_MIN_SEC / frame_t
    out: list[list[int]] = []
    for sec in secs:
        if out and (sec[2] - sec[0] < min_frames or sec[1] == out[-1][1]):
            out[-1][2] = sec[2]
        else:
            out.append(sec)
    if len(out) > 1 and out[0][2] - out[0][0] < min_frames:
        out[1][0] = 0
        out.pop(0)
    return [(a, k) for a, k, _ in out]


def key_name(k: int) -> str:
    tonic, minor = k % 12, k >= 12
    names = NOTE_NAMES_FLAT if (tonic, "min" if minor else "maj") in FLAT_KEYS else NOTE_NAMES_SHARP
    return f"{names[tonic]} {'minor' if minor else 'major'}"


def detect_chords(other_wav: Path, bass_wav: Path, beats: list[float],
                  bass_notes: list[dict]) -> tuple[list[dict], str, list[dict]]:
    """chords per segment, the song's key, and the key sections [{t, key}] (more than one on a modulation)."""
    sr, hop = 22050, 2048
    y_o, _ = librosa.load(other_wav, sr=sr, mono=True)
    y_b, _ = librosa.load(bass_wav, sr=sr, mono=True)
    n = min(len(y_o), len(y_b))
    y = y_o[:n] + 0.6 * y_b[:n]

    chroma = librosa.feature.chroma_cqt(y=y, sr=sr, hop_length=hop, norm=None)
    # harmony-only chroma (no bass) to judge 7ths, 9ths and sus notes
    chroma_h = librosa.feature.chroma_cqt(y=y_o[:n], sr=sr, hop_length=hop, norm=None)
    energy = chroma.sum(axis=0)
    chroma_n = chroma / (np.linalg.norm(chroma, axis=0, keepdims=True) + 1e-9)
    silent = energy < (0.05 * np.percentile(energy, 95) + 1e-9)
    frame_t = hop / sr

    # pass 1: chords alone, read the local key from them
    _, labels = chord_templates()
    n_state = len(labels)
    path = chord_viterbi(chroma_n, silent)
    sections = key_sections(path, labels, frame_t)
    if not np.any(path != n_state):
        # no chords at all: fall back to the chroma key profile
        tonic, mode = detect_key(chroma.mean(axis=1))
        sections = [(0, tonic + (12 if mode == "min" else 0))]

    # pass 2: chords that belong to the local key get a small bonus, so a borrowed chord
    # still wins when the audio clearly says so but noise no longer picks one
    bias = np.zeros((n_state, chroma.shape[1]))
    bounds = [a for a, _ in sections[1:]] + [chroma.shape[1]]
    for (a, k), b in zip(sections, bounds):
        major_tonic = k % 12 if k < 12 else (k + 3) % 12
        for iv, q in DIATONIC:
            bias[labels.index(((major_tonic + iv) % 12, q)), a:b] = KEY_BIAS
    path = chord_viterbi(chroma_n, silent, bias)

    times = librosa.frames_to_time(np.arange(len(path) + 1), sr=sr, hop_length=hop)
    segs: list[dict] = []
    for i, st in enumerate(path):
        if segs and segs[-1]["state"] == st:
            segs[-1]["e"] = times[i + 1]
        else:
            segs.append({"state": int(st), "s": times[i], "e": times[i + 1]})

    # snap boundaries to nearby beats
    beat_arr = np.array(beats) if beats else None
    if beat_arr is not None and len(beat_arr):
        for sg in segs[1:]:
            j = np.argmin(np.abs(beat_arr - sg["s"]))
            if abs(beat_arr[j] - sg["s"]) < 0.2:
                sg["s"] = float(beat_arr[j])
        for a, b in zip(segs, segs[1:]):
            a["e"] = b["s"]

    # merge short segments into the previous one: under 1.5 beats is a passing note, not a chord
    # (capped so slow songs keep real one-beat chords)
    beat = float(np.median(np.diff(beat_arr))) if beat_arr is not None and len(beat_arr) > 1 else 0.5
    min_len = max(0.35, min(1.5 * beat, 0.6))
    cleaned: list[dict] = []
    for sg in segs:
        if cleaned and (sg["e"] - sg["s"] < min_len or cleaned[-1]["state"] == sg["state"]):
            cleaned[-1]["e"] = sg["e"]
        else:
            cleaned.append(dict(sg))
    # a short first segment joins the next one
    if len(cleaned) > 1 and cleaned[0]["e"] - cleaned[0]["s"] < min_len:
        cleaned[1]["s"] = cleaned[0]["s"]
        cleaned.pop(0)

    # key sections in seconds; chord spelling follows the local key
    key_list = [{"t": round(float(times[a]), 3), "key": key_name(k)} for a, k in sections]
    starts = [kl["t"] for kl in key_list]

    def names_at(t: float) -> list[str]:
        k = sections[max(0, int(np.searchsorted(starts, t + 1e-6)) - 1)][1]
        tonic, mode = k % 12, ("min" if k >= 12 else "maj")
        return NOTE_NAMES_FLAT if (tonic, mode) in FLAT_KEYS else NOTE_NAMES_SHARP

    out: list[dict] = []
    for sg in cleaned:
        names = names_at(sg["s"])
        if sg["state"] == n_state:
            label = "N"
        else:
            root, qual = labels[sg["state"]]
            f0 = int(np.searchsorted(times, sg["s"]))
            f1 = max(f0 + 1, int(np.searchsorted(times, sg["e"])))
            c = chroma_h[:, f0:f1].mean(axis=1)
            bass_pc = dominant_bass_pc(bass_notes, sg["s"], sg["e"])
            alt = bass_reading(c, root, qual, bass_pc)
            if alt:
                root, qual = alt
            suffix = chord_extension(c, root, qual)
            label = names[root] + suffix
            third = (root + (3 if qual == "min" else 4)) % 12
            fifth = (root + 7) % 12
            if bass_pc is not None and bass_pc in (third, fifth) and not suffix.startswith("sus"):
                label += "/" + names[bass_pc]
        if out and out[-1]["label"] == label:
            out[-1]["d"] = round(sg["e"] - out[-1]["t"], 3)
            continue
        out.append({"t": round(float(sg["s"]), 3), "d": round(float(sg["e"] - sg["s"]), 3), "label": label})
    return out, key_list[0]["key"], key_list


def dominant_bass_pc(notes: list[dict], s: float, e: float) -> int | None:
    weights = np.zeros(12)
    for nt in notes:
        ov = min(e, nt["t"] + nt["d"]) - max(s, nt["t"])
        if ov > 0:
            weights[nt["midi"] % 12] += ov
    if weights.sum() < 0.25 * (e - s):
        return None
    return int(np.argmax(weights))


# ---------------------------------------------------------------- piano / guitar (polyphonic)

POLY_RANGE = {"piano": (27.5, 4200.0), "guitar": (80.0, 1400.0)}


def transcribe_poly(stem_path: Path, part: str) -> list[dict]:
    """all notes of a chordal part with basic pitch; quiet bleed from other instruments is dropped."""
    import contextlib
    import io

    from basic_pitch import FilenameSuffix, build_icassp_2022_model_path
    from basic_pitch.inference import predict

    lo, hi = POLY_RANGE[part]
    with contextlib.redirect_stdout(io.StringIO()):
        _, _, events = predict(
            str(stem_path), build_icassp_2022_model_path(FilenameSuffix.onnx),
            onset_threshold=0.5, frame_threshold=0.3, minimum_note_length=70,
            minimum_frequency=lo, maximum_frequency=hi, melodia_trick=True,
        )
    if not events:
        return []
    # loudness of the stem itself: a note only counts where this part is actually playing
    sr, hop = 11025, 110
    y, _ = librosa.load(stem_path, sr=sr, mono=True)
    db = librosa.amplitude_to_db(librosa.feature.rms(y=y, frame_length=hop * 2, hop_length=hop)[0], ref=np.max)
    peak = max(e[3] for e in events) or 1.0
    out = []
    for start, end, pitch, amp, _ in sorted(events, key=lambda e: (e[0], e[2])):
        f0, f1 = int(start * sr / hop), max(int(start * sr / hop) + 1, int(end * sr / hop))
        if amp / peak < 0.2 or float(np.max(db[f0:f1], initial=-80.0)) < -32:
            continue
        out.append({"t": round(float(start), 3), "d": round(float(end - start), 3), "midi": int(pitch),
                    "v": round(float(min(1.0, amp / peak)), 3)})
    return drop_harmonics(out, HARMONIC_RATIO)


HARMONIC_STEPS = (12, 19, 24, 28)  # octave, octave+fifth, two octaves, two octaves+third
HARMONIC_RATIO = 0.65  # overtones quieter than this vs their fundamental are dropped (keeps 99% of real chord tones on the test set)


def drop_harmonics(notes: list[dict], ratio: float = HARMONIC_RATIO) -> list[dict]:
    """an overtone of a sounding note shows up as a quieter note 12/19/24/28 semitones higher: remove it."""
    keep = []
    by_start = sorted(range(len(notes)), key=lambda i: notes[i]["t"])
    for i in by_start:
        n = notes[i]
        end = n["t"] + n["d"]
        ghost = False
        for j in by_start:
            m = notes[j]
            if m["t"] > end:
                break
            if j == i or (n["midi"] - m["midi"]) not in HARMONIC_STEPS:
                continue
            if overlap(n, m) >= 0.5 * n["d"] and n["v"] <= ratio * m["v"]:
                ghost = True
                break
        if not ghost:
            keep.append(n)
    return keep


# ---------------------------------------------------------------- multitrack layers

# bands (hz) used to tell drum voices apart
DRUM_BANDS = {"sub": (35, 90), "low": (90, 350), "crack": (1500, 6000), "air": (7000, 11000)}
# thresholds on band energy relative to this song's strong hits (90th percentile), plus shape ratios
DRUM_TH = {"kick": 0.2, "snare": 0.2, "hat": 0.12, "tom": 0.25,
           "kick_sub_vs_low": 0.6,   # after the attack a kick lives below 90 hz
           "tom_low_vs_sub": 1.5,    # a tom keeps ringing at its pitch, 90-350 hz
           "tom_max_crack": 0.15,    # ...without snare wires
           "snare_crack_vs_air": 0.6,  # snare wires sit lower than hi-hats
           "snare_max_decay": 0.15,    # wire energy 120-250 ms after the hit, relative to its peak
           "snare_vs_click": 2.6,      # with a kick: crack vs the song's typical kick click
           "snare_body": 0.15,         # without a kick: some drum body at 150-350 hz
           "hat_air_vs_crack": 1.2}
DRUM_VOICES = ("kick", "snare", "hat", "tom")
DRUM_VERSION = 3  # bump to rebuild drum hits of saved songs from their drum stem


def drum_hits(drums_path: Path) -> dict[str, list[float]]:
    """find every drum hit on the drum stem, then label it (kick, snare, hi-hat, tom) from its spectral shape."""
    sr, hop = 22050, 128
    y, _ = librosa.load(drums_path, sr=sr, mono=True)
    empty = {k: [] for k in DRUM_VOICES}
    if not np.any(y):
        return empty
    S = np.abs(librosa.stft(y, n_fft=1024, hop_length=hop)) ** 2
    freqs = librosa.fft_frequencies(sr=sr, n_fft=1024)
    fr = lambda sec: max(1, int(round(sec * sr / hop)))
    onsets = librosa.onset.onset_detect(y=y, sr=sr, hop_length=hop, units="frames", backtrack=False,
                                        delta=0.04, wait=fr(0.045))
    level = librosa.power_to_db(S.sum(axis=0), ref=np.max)
    onsets = onsets[level[np.minimum(onsets, len(level) - 1)] > -45]
    if not len(onsets):
        return empty
    band = {k: S[(freqs >= lo) & (freqs < hi)].sum(axis=0) for k, (lo, hi) in {**DRUM_BANDS, "body": (150, 350)}.items()}
    n = S.shape[1]
    # the onset peak lags the hit a little; a hi-hat is almost gone by then, so start slightly earlier
    lead, post = fr(0.012), fr(0.05)

    # summed frame-to-frame increases: a ringing crash only decays, so it cannot hide a new hit
    flux = {k: np.maximum(0.0, np.diff(b, prepend=b[0])) for k, b in band.items()}

    def rise(b, f):
        a = max(0, f - lead)
        return float(b[a:min(n, f + post + 1)].sum())

    def tail(b, f, t0, t1):
        return b[min(n - 1, f + fr(t0)):min(n, f + fr(t1))].mean() if f + fr(t0) < n else 0.0

    R = {k: np.array([rise(flux[k], f) for f in onsets]) for k in band}
    N = {k: v / (np.percentile(v, 90) + 1e-12) for k, v in R.items()}
    # body 30-120 ms after the hit: where does the low end ring?
    sub_t = np.array([tail(band["sub"], f, 0.03, 0.12) for f in onsets])
    low_t = np.array([tail(band["low"], f, 0.03, 0.12) for f in onsets])

    th = DRUM_TH
    kick = (N["sub"] > th["kick"]) & (sub_t > th["kick_sub_vs_low"] * low_t)
    # snare wires sit lower than hi-hats, die out fast (cymbals keep ringing) and come with a drum body.
    # a live kick's beater click looks like wires too, so with a kick the crack must clearly beat the
    # usual click level of this song's kicks
    crack_peak = np.array([band["crack"][f:min(n, f + fr(0.05))].max() + 1e-12 for f in onsets])
    crack_decay = np.array([tail(band["crack"], f, 0.12, 0.25) for f in onsets]) / crack_peak
    body = np.array([rise(flux["body"], f) for f in onsets])
    body_n = body / (np.percentile(body, 90) + 1e-12)
    with_kick = N["sub"] > 0.4
    clicky = with_kick & (N["crack"] > 0.05)  # kicks that have an audible beater click
    # the kick sound can change between sections (e.g. a clicky intro kick), so judge each hit
    # against the kicks around it: in a kick-only passage every kick clicks about the same
    times = librosa.frames_to_time(onsets, sr=sr, hop_length=hop)
    song_click = np.percentile(R["crack"][clicky], 25) if clicky.sum() >= 8 else 0.0
    click = np.full(len(onsets), song_click)
    for i, t0 in enumerate(times):
        near = clicky & (np.abs(times - t0) <= 6.0)
        if near.sum() >= 6:
            click[i] = max(song_click, np.percentile(R["crack"][near], 25))
    snare_shape = (N["crack"] > th["snare"]) & (R["crack"] > th["snare_crack_vs_air"] * R["air"]) & (crack_decay < th["snare_max_decay"])
    snare = snare_shape & np.where(with_kick, R["crack"] > th["snare_vs_click"] * click, body_n > th["snare_body"])
    # hi-hats are quiet next to snares and crashes: size them against other hi-hat-shaped hits
    hat_shape = (R["air"] > th["hat_air_vs_crack"] * R["crack"]) & ~snare
    hat = np.zeros(len(onsets), dtype=bool)
    if hat_shape.any():
        ref = np.percentile(R["air"][hat_shape], 90) + 1e-12
        hat = hat_shape & (R["air"] / ref > th["hat"])
        # a hi-hat played with a kick picks up the kick's click in the snare band: use the clear ones as yardstick
        if hat.sum() >= 4:
            typical = float(np.median(R["air"][hat]))
            hat |= ~snare & (R["air"] >= 0.4 * typical) & (R["air"] > 0.3 * R["crack"])
    tom = (N["low"] > th["tom"]) & (low_t > th["tom_low_vs_sub"] * sub_t) & (N["crack"] < th["tom_max_crack"]) & ~snare
    to_t = lambda mask: [round(float(t), 3) for t in librosa.frames_to_time(onsets[mask], sr=sr, hop_length=hop)]
    return {"kick": to_t(kick), "snare": to_t(snare), "hat": to_t(hat), "tom": to_t(tom)}


LAYER_STEP = 0.1


def stem_layers(stem_paths: dict[str, Path]) -> dict:
    """per-stem loudness (0-100, every 100 ms) to show when each part plays, plus drum hits."""
    sr = 11025
    hop = int(sr * LAYER_STEP)
    activity = {}
    for name, p in stem_paths.items():
        if not Path(p).exists():
            continue
        y, _ = librosa.load(p, sr=sr, mono=True)
        rms = librosa.feature.rms(y=y, frame_length=hop * 2, hop_length=hop)[0]
        db = librosa.amplitude_to_db(rms, ref=np.max(rms) + 1e-9)
        activity[name] = [int(np.clip(100 + d * 100 / 50, 0, 100)) for d in db]  # -50..0 db -> 0..100
    layers = {"step": LAYER_STEP, "activity": activity}
    if "drums" in stem_paths and Path(stem_paths["drums"]).exists():
        layers["drums"] = drum_hits(stem_paths["drums"])
        layers["drums_v"] = DRUM_VERSION
    return layers


# ---------------------------------------------------------------- midi export

def write_midi(notes: list[dict], bpm: float, path: Path, program: int = 33, channel: int = 0) -> None:
    """program is 0-based: 33 = electric bass (finger), 53 = voice oohs, 0 = piano, 25 = steel guitar."""
    ppq = 480
    bpm = bpm or 120.0
    tick = lambda sec: int(round(sec * bpm / 60.0 * ppq))

    events = []
    for nt in notes:
        vel = int(40 + 87 * nt.get("v", 0.8))
        events.append((tick(nt["t"]), 1, nt["midi"], vel))
        events.append((tick(nt["t"] + nt["d"]), 0, nt["midi"], 0))
    events.sort(key=lambda e: (e[0], e[1]))

    def vlq(v: int) -> bytes:
        buf = [v & 0x7F]
        v >>= 7
        while v:
            buf.append((v & 0x7F) | 0x80)
            v >>= 7
        return bytes(reversed(buf))

    track = bytearray()
    us_per_beat = int(60_000_000 / bpm)
    track += b"\x00\xff\x51\x03" + us_per_beat.to_bytes(3, "big")
    track += bytes([0x00, 0xC0 | channel, program])
    last = 0
    for t, on, pitch, vel in events:
        track += vlq(t - last) + bytes([(0x90 if on else 0x80) | channel, pitch, vel])
        last = t
    track += b"\x00\xff\x2f\x00"

    data = b"MThd" + (6).to_bytes(4, "big") + (0).to_bytes(2, "big") + (1).to_bytes(2, "big") + ppq.to_bytes(2, "big")
    data += b"MTrk" + len(track).to_bytes(4, "big") + bytes(track)
    path.write_bytes(data)


def write_drum_midi(drums: dict[str, list[float]], bpm: float, path: Path) -> None:
    """general midi drums on channel 10: kick 36, snare 38, closed hi-hat 42, mid tom 47."""
    keys = {"kick": 36, "snare": 38, "hat": 42, "tom": 47}
    notes = [{"t": t, "d": 0.1, "midi": keys[k], "v": 0.85 if k != "hat" else 0.6}
             for k, ts in (drums or {}).items() if k in keys for t in ts]
    notes.sort(key=lambda n: n["t"])
    write_midi(notes, bpm, path, program=0, channel=9)


# ---------------------------------------------------------------- orchestration

def safe_name(s: str) -> str:
    return re.sub(r"[^\w\-. ]+", "_", s).strip()[:80] or "audio"


def source_key(source: dict) -> str | None:
    """stable cache key for a link: the youtube video id or the drive file id."""
    url = source.get("url") or ""
    if source["type"] == "youtube":
        m = re.search(r"(?:v=|youtu\.be/|/shorts/|/live/|/embed/)([A-Za-z0-9_-]{11})", url)
        return f"yt_{m.group(1)}" if m else None
    if source["type"] == "gdrive":
        m = re.search(r"(?:/d/|[?&]id=)([A-Za-z0-9_-]{10,})", url)
        return f"gd_{m.group(1)}" if m else None
    return None


def cached_download(key: str, cache_dir: Path) -> tuple[Path, str] | None:
    meta = cache_dir / f"{key}.json"
    if not meta.exists():
        return None
    info = json.loads(meta.read_text())
    path = cache_dir / info["file"]
    return (path, info["title"]) if path.exists() else None


def store_download(key: str, cache_dir: Path, raw: Path, title: str) -> Path:
    """keep the original downloaded file untouched (no re-encode) for later re-analysis."""
    cache_dir.mkdir(parents=True, exist_ok=True)
    dst = cache_dir / f"{key}{raw.suffix}"
    shutil.move(str(raw), dst)
    (cache_dir / f"{key}.json").write_text(json.dumps({"title": title, "file": dst.name, "saved": time.time()}))
    return dst


def fetch_audio(job_dir: Path, source: dict, on_progress: Callable[[float], None] | None = None,
                cache_dir: Path | None = None) -> dict:
    """download (or reuse the cached download) and convert to tmp/source.wav."""
    tmp = job_dir / "tmp"
    tmp.mkdir(exist_ok=True)
    key = source_key(source) if cache_dir else None
    hit = cached_download(key, cache_dir) if key else None
    from_cache = hit is not None
    if hit:
        raw, title = hit
    elif source["type"] == "youtube":
        raw, title = fetch_youtube(source["url"], tmp, on_progress)
    elif source["type"] == "gdrive":
        raw, title = fetch_gdrive(source["url"], tmp, on_progress)
    else:
        raw, title = Path(source["path"]), source.get("title") or Path(source["path"]).stem
    if key and not from_cache:
        raw = store_download(key, cache_dir, raw, title)
    src_wav = tmp / "source.wav"
    ffmpeg_to_wav(raw, src_wav)
    if raw.parent == tmp:
        raw.unlink(missing_ok=True)
    return {"title": title, "duration": round(float(sf.info(src_wav).duration), 3), "from_cache": from_cache}


def analyze(job_dir: Path, title: str, progress: Progress, mode: str = "ai") -> dict:
    """heavy part: expects tmp/source.wav from fetch_audio.

    mode "ai": demucs, beat_this, basic pitch (the ai engine). "classic": no ai models at all.
    """
    ai = mode == "ai"
    tmp = job_dir / "tmp"
    src_wav = tmp / "source.wav"
    duration = float(sf.info(src_wav).duration)

    sep_stage = "Memisahkan instrumen (Demucs)" if ai else "Memisahkan instrumen (mode cepat)"
    progress(sep_stage, 0.0)
    stems = (separate if ai else separate_classic)(src_wav, tmp, lambda p: progress(sep_stage, 0.45 * p))

    progress("Transkripsi bass", 0.45)
    notes = transcribe_bass(stems["bass"], lambda p: progress("Transkripsi bass", 0.45 + 0.13 * p), ai=ai)

    progress("Transkripsi melodi vokal", 0.58)
    vocals = transcribe_vocals(stems["vocals"], lambda p: progress("Transkripsi melodi vokal", 0.58 + 0.12 * p))

    if ai:
        progress("Transkripsi piano & gitar", 0.7)
    poly = {part: transcribe_poly(stems[part], part) for part in ("piano", "guitar") if part in stems}

    progress("Deteksi tempo & beat", 0.78)
    bpm, beats, downbeats = detect_beats(src_wav, ai=ai)

    progress("Deteksi chord & kunci", 0.85)
    chords, key, keys = detect_chords(stems["harmony"], stems["bass"], beats, notes)

    progress("Menyiapkan audio player", 0.9)
    for name in STEMS:
        if name in stems:
            ffmpeg_to_mp3(stems[name], job_dir / f"{name}.mp3")
    (job_dir / "rest.mp3").unlink(missing_ok=True)  # replaced by the separate stems
    progress("Menyiapkan tampilan multitrack", 0.97)
    layers = stem_layers({name: stems[name] for name in STEMS if name in stems})
    write_midi(notes, bpm, job_dir / "bass.mid")
    write_midi(vocals["notes"], bpm, job_dir / "vocals.mid", program=53)
    for part, program in (("piano", 0), ("guitar", 25)):
        if part in poly:
            write_midi(poly[part], bpm, job_dir / f"{part}.mid", program=program)
    write_drum_midi(layers.get("drums"), bpm, job_dir / "drums.mid")

    result = {
        "title": title,
        "duration": round(duration, 3),
        "bpm": bpm,
        "key": key,
        "keys": keys,
        "beats": beats,
        "downbeats": downbeats,
        "notes": notes,
        "vocals": vocals,
        **{part: {"notes": ns} for part, ns in poly.items()},
        "chords": chords,
        "layers": layers,
        "audio": {name: f"{name}.mp3" for name in STEMS if name in stems},
        "version": PIPELINE_VERSION,
        "mode": mode,
    }
    (job_dir / "analysis.json").write_text(json.dumps(result))
    shutil.rmtree(tmp, ignore_errors=True)
    return result
