"""encore app server: the web app, drive/title helpers, and the breakdown analysis queue.

the same frontend also deploys to vercel without this server; there /api/health is missing,
so breakdown shows the "download the app" page instead.

job flow: queued -> downloading -> waiting -> running -> done
downloads run in parallel; the heavy analysis runs one song at a time.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import statistics
import sys
import threading
import time
import traceback
import urllib.error
import urllib.parse
import urllib.request
import uuid
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi import Request
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.middleware.cors import CORSMiddleware

import ai
from version import APP_VERSION, UI_API
from pipeline import (DRIVE_PRIVATE_MSG, DRUM_VERSION, PIPELINE_VERSION, analyze, drive_title, drum_hits, fetch_audio,
                      open_drive, safe_name, shutdown_pool, source_key, stem_layers, write_drum_midi)

FROZEN = getattr(sys, "frozen", False)
# the web app files: inside the executable, or the repo when run from source
ROOT = Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parent.parent))


def data_dir() -> Path:
    """songs live in the user's app data folder (the repo's data/ when run from source)."""
    if os.environ.get("ENCORE_DATA"):
        return Path(os.environ["ENCORE_DATA"])
    if not FROZEN:
        return ROOT / "data"
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Application Support" / "Encore"
    if sys.platform == "win32":
        return Path(os.environ.get("APPDATA") or Path.home()) / "Encore"
    return Path(os.environ.get("XDG_DATA_HOME") or Path.home() / ".local" / "share") / "encore"


DATA = data_dir() / "jobs"
DATA.mkdir(parents=True, exist_ok=True)
ai.setup(data_dir())
CACHE = data_dir() / "cache"  # original downloads, keyed by video / file id
# files a finished job may serve (older jobs have bass + rest, newer ones all stems)
PUBLIC_JOB_FILES = ({f"{n}.mp3" for n in ("bass", "rest", "drums", "vocals", "guitar", "piano", "other")}
                    | {f"{n}.mid" for n in ("bass", "vocals", "piano", "guitar", "drums")})
# only these root files are public; never serve the repo folder itself
PUBLIC_FILES = ("index.html", "sw.js", "manifest.webmanifest", "icon-180.png", "icon-192.png", "icon-512.png")


@asynccontextmanager
async def lifespan(_app):
    yield
    # stop pyin worker processes so they don't outlive the server
    shutdown_pool()


app = FastAPI(title="Encore", lifespan=lifespan)


@app.middleware("http")
async def no_cache_frontend(request, call_next):
    # always revalidate html/js/css so updates show up without a hard refresh
    response = await call_next(request)
    if not request.url.path.startswith("/api/"):
        response.headers["Cache-Control"] = "no-cache"
    return response


# the online site may reach this app to share its playlist (sync below); chrome asks the user once
# for "local network" access, which needs the private network header on the preflight
ONLINE = "https://encore-player.vercel.app"
app.add_middleware(CORSMiddleware, allow_origins=[ONLINE], allow_methods=["GET", "POST", "PUT"],
                   allow_headers=["content-type"], allow_private_network=True)

download_pool = ThreadPoolExecutor(max_workers=2)
analysis_pool = ThreadPoolExecutor(max_workers=1)  # demucs is heavy, one song at a time
lock = threading.Lock()
cancelled: set[str] = set()

ACTIVE = ("queued", "downloading", "waiting", "running")


class Cancelled(Exception):
    pass


# ---------------------------------------------------------------- meta helpers

def meta_path(job_id: str) -> Path:
    return DATA / job_id / "meta.json"


# meta.json is read and written from several threads: always under the lock, and written to a
# temp file first, so a reader never sees a half-written file
def read_meta(job_id: str) -> dict:
    with lock:
        p = meta_path(job_id)
        if not p.exists():
            raise HTTPException(404, "job tidak ditemukan")
        return json.loads(p.read_text())


def write_meta(job_id: str, **updates) -> dict | None:
    with lock:
        p = meta_path(job_id)
        if not p.parent.exists():
            return None  # deleted meanwhile
        meta = json.loads(p.read_text()) if p.exists() else {}
        meta.update(updates)
        tmp = p.with_suffix(".tmp")
        tmp.write_text(json.dumps(meta))
        os.replace(tmp, p)
        return meta


def all_meta() -> list[dict]:
    out = []
    with lock:
        for p in DATA.glob("*/meta.json"):
            try:
                out.append(json.loads(p.read_text()))
            except Exception:
                pass
    return out


def upload_path(job_id: str, source: dict) -> Path:
    """uploads live in the job folder; older jobs stored an absolute path."""
    return DATA / job_id / Path(source["path"]).name


def resolved_source(job_id: str, source: dict) -> dict:
    if source.get("type") == "file":
        return {**source, "path": str(upload_path(job_id, source))}
    return source


def check_cancel(job_id: str) -> None:
    if job_id in cancelled or not (DATA / job_id).exists():
        raise Cancelled()


# ---------------------------------------------------------------- workers

def download_stage(job_id: str) -> None:
    try:
        check_cancel(job_id)
        meta = read_meta(job_id)
        write_meta(job_id, status="downloading", stage="Mengunduh audio", progress=0.0, error=None)
        info = fetch_audio(
            DATA / job_id, resolved_source(job_id, meta["source"]),
            lambda p: write_meta(job_id, progress=round(p, 3)),
            cache_dir=CACHE,
        )
        check_cancel(job_id)
        write_meta(job_id, status="waiting", stage="Menunggu giliran diproses", progress=0.0,
                   title=info["title"], duration=info["duration"], downloaded=time.time(),
                   from_cache=info["from_cache"])
        analysis_pool.submit(analysis_stage, job_id)
    except Cancelled:
        finish_cancel(job_id)
    except Exception as e:
        traceback.print_exc()
        fail(job_id, "Gagal mengunduh", e, "download")


def analysis_stage(job_id: str) -> None:
    try:
        check_cancel(job_id)
        meta = read_meta(job_id)
        started = time.time()
        write_meta(job_id, status="running", stage="Memulai", progress=0.0, started=started, error=None)

        def progress(stage: str, pct: float) -> None:
            check_cancel(job_id)
            write_meta(job_id, stage=stage, progress=round(pct, 3))

        # classic runs here; the detailed ai analysis runs in the separately installed engine
        mode = meta.get("mode") or "classic"
        run = ai.analyze if mode == "ai" else lambda d, t, p: analyze(d, t, p, mode="classic")
        result = run(DATA / job_id, meta.get("title") or "audio", progress)
        write_meta(job_id, status="done", stage="Selesai", progress=1.0, title=result["title"],
                   duration=result["duration"], key=result["key"], bpm=result["bpm"],
                   compute_sec=round(time.time() - started, 1), finished=time.time(),
                   reanalyze_error=None,
                   version=result.get("version"), result_mode=result.get("mode", mode))
    except Cancelled:
        finish_cancel(job_id)
    except Exception as e:
        traceback.print_exc()
        fail(job_id, "Gagal diproses", e, "analysis")


def finish_cancel(job_id: str) -> None:
    cancelled.discard(job_id)
    shutil.rmtree(DATA / job_id, ignore_errors=True)


def fail(job_id: str, stage: str, err: Exception, failed: str) -> None:
    """mark a failure; a song that already has results stays usable in the library."""
    if (DATA / job_id / "analysis.json").exists():
        write_meta(job_id, status="done", stage="Selesai", progress=1.0,
                   reanalyze_error=f"{stage}: {err}", reanalyze_failed_at=time.time())
    else:
        write_meta(job_id, status="error", stage=stage, error=str(err), failed=failed)


def enqueue(job_id: str, meta: dict) -> None:
    src_ready = (DATA / job_id / "tmp" / "source.wav").exists()
    if src_ready and meta.get("title"):
        write_meta(job_id, status="waiting", stage="Menunggu giliran diproses", progress=0.0, error=None)
        analysis_pool.submit(analysis_stage, job_id)
    else:
        write_meta(job_id, status="queued", stage="Menunggu unduhan", progress=0.0, error=None)
        download_pool.submit(download_stage, job_id)


# ---------------------------------------------------------------- queue info

def seconds_per_audio_second(jobs: list[dict]) -> float:
    ratios = [j["compute_sec"] / j["duration"] for j in jobs
              if j.get("status") == "done" and j.get("compute_sec") and j.get("duration")]
    return statistics.median(ratios[-10:]) if ratios else 0.6


def with_queue_info(jobs: list[dict]) -> list[dict]:
    """adds position (1 = next in line) and eta_sec for active jobs."""
    rate = seconds_per_audio_second(jobs)
    fallback = 240.0  # unknown duration (still downloading)
    running = [j for j in jobs if j.get("status") == "running"]
    # analysis order: downloaded jobs first (in the order they finished downloading), then the rest
    line = sorted((j for j in jobs if j.get("status") in ("queued", "downloading", "waiting")),
                  key=lambda j: (j["status"] != "waiting", j.get("downloaded") or j.get("created", 0)))
    ahead = 0.0
    for j in running:
        total = rate * j["duration"] if j.get("duration") else fallback
        elapsed = time.time() - j.get("started", time.time())
        p = j.get("progress") or 0.0
        # once under way, trust the job's own speed more than history
        remaining = elapsed * (1 - p) / p if p >= 0.15 else total - elapsed
        j["eta_sec"] = round(max(5.0, remaining))
        ahead += j["eta_sec"]
    for pos, j in enumerate(line, 1):
        own = rate * j["duration"] if j.get("duration") else fallback
        j["position"] = pos
        j["eta_sec"] = round(ahead + own)
        ahead += own
    return jobs


# ---------------------------------------------------------------- api

def new_job_id() -> str:
    job_id = uuid.uuid4().hex[:10]
    (DATA / job_id).mkdir()
    return job_id


def existing_job(source: dict) -> dict | None:
    """a job for the same video / drive file that is done or still in the queue."""
    key = source_key(source)
    if not key:
        return None
    for m in all_meta():
        src = m.get("source") or {}
        if src.get("type") == source["type"] and source_key(src) == key and m.get("status") != "error":
            return m
    return None


@app.post("/api/jobs")
async def create_job(
    kind: str = Form(...),
    mode: str = Form("classic"),
    url: str | None = Form(None),
    file: UploadFile | None = File(None),
):
    check_mode(mode)
    if kind in ("youtube", "gdrive"):
        if not url or not url.strip().startswith("http"):
            raise HTTPException(400, "link tidak valid")
        source = {"type": kind, "url": url.strip()}
        same = existing_job(source)
        if same:
            return {**public(same), "existing": True}
        job_id = new_job_id()
        title = None
    elif kind == "file":
        if not file:
            raise HTTPException(400, "file wajib diupload")
        job_id = new_job_id()
        name = safe_name(file.filename or "audio")
        dst = DATA / job_id / f"upload_{name}"
        with dst.open("wb") as f:
            shutil.copyfileobj(file.file, f)
        title = Path(file.filename or name).stem
        source = {"type": "file", "path": dst.name, "title": title}  # relative to the job folder
    else:
        raise HTTPException(400, "kind tidak dikenal")

    meta = write_meta(job_id, id=job_id, title=title, source=source, source_type=source["type"], mode=mode,
                      status="queued", stage="Menunggu unduhan", progress=0.0, created=time.time())
    download_pool.submit(download_stage, job_id)
    return public(meta)


def check_mode(mode: str) -> None:
    """classic is built in; ai needs the engine installed first."""
    if mode not in ("classic", "ai"):
        raise HTTPException(400, "mode tidak dikenal")
    if mode == "ai" and ai.command() is None:
        raise HTTPException(409, "Mesin AI belum terpasang. Download dulu dari tombol Analisis detail (AI).")


def analysis_info(job_id: str, meta: dict) -> dict:
    """when the current result was produced, with which mode, and whether it predates the latest pipeline."""
    p = DATA / job_id / "analysis.json"
    if not p.exists():
        return {}
    at = meta.get("finished") or p.stat().st_mtime  # older jobs: fall back to file time
    # results from before the classic mode existed were all made with ai
    return {"analyzed_at": at, "outdated": (meta.get("version") or 0) < PIPELINE_VERSION,
            "result_mode": meta.get("result_mode", "ai")}


def public(meta: dict) -> dict:
    """drop the source (may hold local file paths), keep only the url."""
    out = dict(meta)
    out["url"] = (out.pop("source", None) or {}).get("url")
    if out.get("id"):
        out.update(analysis_info(out["id"], meta))
    return out


@app.get("/api/jobs")
def list_jobs():
    jobs = [public(j) for j in with_queue_info(all_meta())]
    return sorted(jobs, key=lambda m: m.get("created", 0), reverse=True)


@app.get("/api/jobs/{job_id}")
def get_job(job_id: str):
    return public(read_meta(job_id))


@app.post("/api/jobs/{job_id}/retry")
def retry_job(job_id: str):
    meta = read_meta(job_id)
    if meta.get("status") != "error":
        raise HTTPException(400, "hanya job yang gagal yang bisa dicoba lagi")
    if "source" not in meta:
        raise HTTPException(400, "job lama tanpa info sumber, silakan tambahkan ulang")
    enqueue(job_id, meta)
    return public(read_meta(job_id))


@app.post("/api/jobs/{job_id}/reanalyze")
def reanalyze_job(job_id: str, mode: str | None = None):
    """run the latest pipeline again on a finished song (re-downloads links); ?mode=ai upgrades it."""
    meta = read_meta(job_id)
    mode = mode or meta.get("mode") or "classic"
    check_mode(mode)
    if meta.get("status") in ACTIVE:
        raise HTTPException(400, "lagu ini masih di antrian")
    src = meta.get("source")
    if not src:
        raise HTTPException(400, "info sumber tidak ada, silakan tambahkan ulang")
    if src["type"] == "file" and not upload_path(job_id, src).exists():
        raise HTTPException(400, "file asli sudah tidak tersimpan, silakan upload ulang")
    meta = write_meta(job_id, created=time.time(), mode=mode)
    enqueue(job_id, meta)
    return public(read_meta(job_id))


layers_lock = threading.Lock()


def add_layers(job_id: str, path: Path, data: dict) -> dict:
    """older results lack the multitrack layers; build them once from the saved stem mp3s."""
    with layers_lock:
        fresh = json.loads(path.read_text())
        layers = fresh.get("layers")
        if layers and layers.get("drums") is not None and layers.get("drums_v", 1) < DRUM_VERSION:
            # only the drum hits changed: rebuild them (and the drum midi) from the saved stem
            drums_mp3 = DATA / job_id / "drums.mp3"
            if drums_mp3.exists():
                try:
                    layers["drums"] = drum_hits(drums_mp3)
                    layers["drums_v"] = DRUM_VERSION
                    if (DATA / job_id / "drums.mid").exists():
                        write_drum_midi(layers["drums"], fresh.get("bpm") or 120, DATA / job_id / "drums.mid")
                    path.write_text(json.dumps(fresh))
                except Exception:
                    traceback.print_exc()
            return fresh
        if layers:
            return fresh
        stems = {name: DATA / job_id / f for name, f in (fresh.get("audio") or {}).items()}
        if not stems or not all(p.exists() for p in stems.values()):
            return data
        try:
            fresh["layers"] = stem_layers(stems)
        except Exception:
            traceback.print_exc()
            return data
        path.write_text(json.dumps(fresh))
        return fresh


@app.get("/api/jobs/{job_id}/analysis")
def get_analysis(job_id: str):
    p = DATA / job_id / "analysis.json"
    if not p.exists():
        raise HTTPException(404, "analisis belum siap")
    data = json.loads(p.read_text())
    if "layers" not in data or (data["layers"].get("drums") is not None and data["layers"].get("drums_v", 1) < DRUM_VERSION):
        data = add_layers(job_id, p, data)
    meta = read_meta(job_id)
    data.update(analysis_info(job_id, meta))
    data["url"] = (meta.get("source") or {}).get("url")
    data["source_type"] = meta.get("source_type")
    return data


@app.get("/api/jobs/{job_id}/files/{name}")
def get_file(job_id: str, name: str):
    if name not in PUBLIC_JOB_FILES:
        raise HTTPException(404)
    p = DATA / job_id / name
    if not p.exists():
        raise HTTPException(404)
    meta = read_meta(job_id)
    if name.endswith(".mid"):
        part = {"vocals": "vokal", "guitar": "gitar", "piano": "piano", "drums": "drum"}.get(name[:-4], "bass")
        return FileResponse(p, filename=f"{safe_name(meta.get('title') or part)} - {part}.mid")
    return FileResponse(p)


@app.delete("/api/jobs/{job_id}")
def delete_job(job_id: str):
    meta = read_meta(job_id)
    if meta.get("status") in ("downloading", "running"):
        # worker stops at its next checkpoint and removes the folder
        cancelled.add(job_id)
        write_meta(job_id, stage="Membatalkan…")
    else:
        shutil.rmtree(DATA / job_id, ignore_errors=True)
    return {"ok": True}


@app.get("/api/health")
def health():
    # the web app looks for this route to know it runs inside the encore app
    return {"ok": True, "app": True, "frozen": FROZEN, "platform": sys.platform, "version": PIPELINE_VERSION,
            "ai": ai.status()}


# ---------------------------------------------------------------- sync (online site <-> this app)
# the online site and this app's own page live at different addresses, so the browser keeps their
# saved settings apart. both sync them here: {key: {"v": value, "t": ms}}, the newest write wins.

SYNC = data_dir() / "sync.json"
sync_lock = threading.Lock()


@app.get("/api/sync")
def get_sync():
    with sync_lock:
        return json.loads(SYNC.read_text()) if SYNC.exists() else {}


@app.post("/api/sync")
async def post_sync(request: Request):
    incoming = await request.json()
    if not isinstance(incoming, dict):
        raise HTTPException(400, "format sync tidak valid")
    with sync_lock:
        stored = json.loads(SYNC.read_text()) if SYNC.exists() else {}
        changed = False
        for k, item in incoming.items():
            if not (isinstance(k, str) and isinstance(item, dict) and isinstance(item.get("t"), (int, float))):
                continue
            if item["t"] > (stored.get(k) or {}).get("t", 0):
                stored[k] = {"v": item.get("v"), "t": item["t"]}
                changed = True
        if changed:
            tmp = SYNC.with_suffix(".tmp")
            tmp.write_text(json.dumps(stored))
            os.replace(tmp, SYNC)
        return stored


# ---------------------------------------------------------------- shared audio (online site <-> this app)
# offline copies of drive songs live on disk here, so a song downloaded on one page is not
# downloaded again on the other. pages check here first and hand over what they fetched themselves.

AUDIO = data_dir() / "audio"
# old shares carry their resource key after a dot: "<id>.<key>"
DRIVE_ID = re.compile(r"^[A-Za-z0-9_-]{10,200}(\.[A-Za-z0-9_-]{1,100})?$")


def audio_file(drive_id: str) -> Path:
    # drive ids only: nothing else may become a path
    if not DRIVE_ID.match(drive_id) or drive_id.endswith(".type"):
        raise HTTPException(400, "id drive tidak valid")
    return AUDIO / drive_id


def type_file(f: Path) -> Path:
    # media type of a stored song sits next to it
    return f.with_name(f.name + ".type")


@app.get("/api/audio")
def audio_list():
    # ids of the songs stored here (without the type sidecars and half-written uploads)
    if not AUDIO.exists():
        return []
    return sorted(f.name for f in AUDIO.iterdir() if DRIVE_ID.match(f.name) and not f.name.endswith(".type"))


@app.get("/api/audio/{drive_id}")
def audio_get(drive_id: str):
    f = audio_file(drive_id)
    if not f.exists():
        raise HTTPException(404, "belum tersimpan")
    kind = type_file(f)
    media = kind.read_text().strip() if kind.exists() else "application/octet-stream"
    return FileResponse(f, media_type=media)


@app.put("/api/audio/{drive_id}")
async def audio_put(drive_id: str, request: Request):
    f = audio_file(drive_id)
    media = request.headers.get("content-type", "")
    if not re.match(r"^(audio|video)/|application/octet-stream", media):
        raise HTTPException(400, "bukan file audio")
    # write to a temp file first so a broken upload never looks like a stored song
    AUDIO.mkdir(parents=True, exist_ok=True)
    tmp = AUDIO / f".{drive_id}.{uuid.uuid4().hex}.part"
    try:
        with tmp.open("wb") as out:
            async for chunk in request.stream():
                out.write(chunk)
        if tmp.stat().st_size < 1024:
            raise HTTPException(400, "file audio kosong")
        type_file(f).write_text(media)
        os.replace(tmp, f)
    finally:
        tmp.unlink(missing_ok=True)
    return {"ok": True}


@app.post("/api/ai/install")
def ai_install():
    return ai.install()


@app.delete("/api/ai")
def ai_remove():
    return ai.remove()


@app.post("/api/quit")
def quit_app():
    """the app has no window of its own: the page's "Tutup Encore" button stops it."""
    threading.Timer(0.3, lambda: os._exit(0)).start()
    return {"ok": True}


# ---------------------------------------------------------------- drive audio + titles (playlist)

@app.get("/drive")
def drive(id: str, request: Request):
    if not re.fullmatch(r"[\w-]{10,}(\.[\w-]+)?", id):
        raise HTTPException(400, "Bad id")
    try:
        resp = open_drive(id, request.headers.get("range"))
    except urllib.error.HTTPError as e:
        raise HTTPException(e.code, "Drive error")
    except Exception:
        raise HTTPException(403, DRIVE_PRIVATE_MSG)
    headers = {h: resp.headers[h] for h in DRIVE_HEADERS if resp.headers.get(h)}
    headers.setdefault("Accept-Ranges", "bytes")

    def body():
        try:
            while chunk := resp.read(64 * 1024):
                yield chunk
        finally:
            resp.close()

    return StreamingResponse(body(), status_code=resp.status, headers=headers)


DRIVE_HEADERS = ("Content-Type", "Content-Length", "Content-Range", "Accept-Ranges")
TITLES: dict[tuple[str, str], str | None] = {}


def lookup_title(kind: str, file_id: str) -> str | None:
    if kind == "drive":
        return drive_title(file_id)
    try:
        url = "https://www.youtube.com/oembed?format=json&url=" + urllib.parse.quote("https://www.youtube.com/watch?v=" + file_id)
        with urllib.request.urlopen(url, timeout=10) as r:
            return json.load(r).get("title")
    except Exception:
        return None


@app.get("/title")
def title(type: str, id: str):
    if type not in ("yt", "drive") or not re.fullmatch(r"[\w-]{6,}(\.[\w-]+)?", id):
        raise HTTPException(400, "Bad request")
    if (type, id) not in TITLES:
        TITLES[(type, id)] = lookup_title(type, id)
    return JSONResponse({"title": TITLES[(type, id)]})


# ---------------------------------------------------------------- ui updates (no new release needed)
# the installed app bundles the ui as it was at build time. on every page load the page asks
# /api/ui/check; when the online site has newer ui files, /api/ui/update downloads just those into
# the data folder, and they are served instead of the bundled ones. backend changes still need a release.

UI_DIR = data_dir() / "ui"
UI_META = UI_DIR / "meta.json"
# run from source the repo files are the ui; ENCORE_UI_SOURCE (e.g. the dev server) turns updates on for testing
UI_SOURCE = os.environ.get("ENCORE_UI_SOURCE") or (ONLINE if FROZEN else "")
UI_PATH = re.compile(r"(index\.html|sw\.js|manifest\.webmanifest|app/[\w./-]+)")
ui_lock = threading.Lock()


def ui_reset_if_stale() -> None:
    # a new release bundles a newer ui, so files pulled for an older version are dropped
    try:
        if UI_DIR.exists() and json.loads(UI_META.read_text()).get("app") != APP_VERSION:
            shutil.rmtree(UI_DIR, ignore_errors=True)
    except (OSError, ValueError):
        shutil.rmtree(UI_DIR, ignore_errors=True)


ui_reset_if_stale()


def ui_file(rel: str) -> Path | None:
    """the pulled copy of a ui file when there is one, else the bundled file."""
    if not UI_PATH.fullmatch(rel) or ".." in rel.split("/"):
        return None
    for base in (UI_DIR, ROOT):
        p = base / rel
        if p.is_file():
            return p
    return None


def ui_hash(rel: str) -> str | None:
    p = ui_file(rel)
    return hashlib.sha1(p.read_bytes()).hexdigest() if p else None


def ui_manifest() -> dict:
    with urllib.request.urlopen(f"{UI_SOURCE}/api/ui", timeout=5) as r:
        return json.loads(r.read())


def ui_changes(manifest: dict) -> list[str]:
    # only files this app knows how to serve, whose content differs from what it serves now
    return [rel for rel, sha in (manifest.get("files") or {}).items()
            if UI_PATH.fullmatch(rel) and ".." not in rel.split("/") and ui_hash(rel) != sha]


@app.get("/api/ui/check")
def ui_check():
    if not UI_SOURCE:
        return {"available": False, "reason": "source"}
    try:
        manifest = ui_manifest()
    except (OSError, ValueError):
        return {"available": False, "reason": "offline"}
    if (manifest.get("api") or 0) > UI_API:
        # the newer ui needs a newer app; keep the current one
        return {"available": False, "reason": "needs-app"}
    changed = ui_changes(manifest)
    return {"available": bool(changed), "files": len(changed)}


@app.post("/api/ui/update")
def ui_update():
    if not UI_SOURCE:
        raise HTTPException(400, "updates are off when running from source")
    with ui_lock:
        try:
            manifest = ui_manifest()
            if (manifest.get("api") or 0) > UI_API:
                return {"updated": 0, "reason": "needs-app"}
            changed = ui_changes(manifest)
            # download everything first and check each hash, so a failed update changes nothing
            got: dict[str, bytes] = {}
            for rel in changed:
                with urllib.request.urlopen(f"{UI_SOURCE}/{urllib.parse.quote(rel)}", timeout=20) as r:
                    body = r.read()
                if hashlib.sha1(body).hexdigest() != manifest["files"][rel]:
                    raise ValueError(f"{rel} changed while downloading")
                got[rel] = body
        except (OSError, ValueError, KeyError) as err:
            raise HTTPException(502, f"ui update failed: {err}")
        # write each file next to its target, then swap it in
        for rel, body in got.items():
            dest = UI_DIR / rel
            dest.parent.mkdir(parents=True, exist_ok=True)
            tmp = dest.with_name(dest.name + ".part")
            tmp.write_bytes(body)
            os.replace(tmp, dest)
        UI_META.write_text(json.dumps({"app": APP_VERSION, "updated": time.time()}))
    return {"updated": len(got)}


# ---------------------------------------------------------------- web app
# js gets an explicit type: windows may map .js to text/plain, which browsers refuse for modules
UI_TYPES = {".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".html": "text/html",
            ".webmanifest": "application/manifest+json", ".json": "application/json"}


def serve_ui(rel: str) -> FileResponse:
    p = ui_file(rel)
    if not p:
        raise HTTPException(404)
    return FileResponse(p, media_type=UI_TYPES.get(p.suffix))


@app.get("/")
def index():
    return serve_ui("index.html")


@app.get("/{name}")
def root_file(name: str):
    if name not in PUBLIC_FILES:
        raise HTTPException(404)
    # icons only ever come from the bundle
    return serve_ui(name) if UI_PATH.fullmatch(name) else FileResponse(ROOT / name)


@app.get("/app/{rel:path}")
def app_file(rel: str):
    return serve_ui(f"app/{rel}")


# resume unfinished jobs after a restart, oldest first
for _m in sorted(all_meta(), key=lambda m: m.get("created", 0)):
    if _m.get("status") in ACTIVE:
        if "source" not in _m:
            write_meta(_m["id"], status="error", stage="Gagal", error="job lama tanpa info sumber, tambahkan ulang")
        else:
            enqueue(_m["id"], _m)

