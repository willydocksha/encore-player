"""the optional ai engine: download, install, and run it for one song.

the app itself only has the classic analysis. the engine (engine.py, built as EncoreAI) is a
separate download from the github release of this app version, unpacked into the data folder and
kept across app updates until ENGINE_VERSION changes. the engine runs the app's own pipeline.py.
"""

from __future__ import annotations

import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tarfile
import threading
import urllib.request
import zipfile
from collections import deque
from pathlib import Path
from typing import Callable

from version import APP_VERSION, ENGINE_VERSION, RELEASES

FROZEN = getattr(sys, "frozen", False)
WIN = sys.platform == "win32"
PLATFORM = {"darwin": "macOS", "win32": "Windows"}.get(sys.platform, "Linux")
ARCHIVE = f"Encore-AI-{PLATFORM}.{'zip' if WIN else 'tar.gz'}"
EXE_NAME = "EncoreAI.exe" if WIN else "EncoreAI"
# the packaged app ships pipeline.py as a file for the engine (encore.spec)
PIPELINE = Path(getattr(sys, "_MEIPASS", "")) / "engine" / "pipeline.py"
INSTALLED = f"v{ENGINE_VERSION}"

_root: Path | None = None
_lock = threading.Lock()
state = {"state": "idle", "got": 0, "total": 0, "error": None}


def setup(data_dir: Path) -> None:
    global _root
    _root = data_dir / "ai-engine"


def engine_dir() -> Path:
    return _root / INSTALLED / "EncoreAI"


def command() -> list[str] | None:
    """how to start the engine here, or None when it is not installed."""
    if os.environ.get("ENCORE_ENGINE"):
        return [os.environ["ENCORE_ENGINE"]]
    if not FROZEN:
        # from source: the engine runs with this python when torch and demucs are installed
        ok = all(importlib.util.find_spec(m) for m in ("torch", "demucs"))
        return [sys.executable, str(Path(__file__).with_name("engine.py"))] if ok else None
    exe = engine_dir() / EXE_NAME
    return [str(exe)] if exe.exists() else None


def outdated() -> bool:
    """an engine for an older ENGINE_VERSION is on disk, so the app update needs a new download."""
    if _root is None or not _root.is_dir() or (_root / INSTALLED).is_dir():
        return False
    return any(d.is_dir() and d.name[:1] == "v" and d.name[1:].isdigit() for d in _root.iterdir())


def status() -> dict:
    ready = command() is not None
    return {**state, "state": "ready" if ready and state["state"] != "installing" else state["state"],
            "installed": ready, "update": not ready and outdated(), "url": os.environ.get("ENCORE_ENGINE_URL") or f"{RELEASES}/download/app-v{APP_VERSION}/{ARCHIVE}"}


def install() -> dict:
    """start downloading the engine in the background (no-op when installed or already going)."""
    with _lock:
        if command() is not None or state["state"] == "installing":
            return status()
        state.update(state="installing", got=0, total=0, error=None)
    threading.Thread(target=_install, daemon=True).start()
    return status()


def _install() -> None:
    part = _root / f"{INSTALLED}.partial"
    try:
        shutil.rmtree(part, ignore_errors=True)
        part.mkdir(parents=True)
        archive = part / ARCHIVE
        req = urllib.request.Request(status()["url"], headers={"User-Agent": "Encore"})
        with urllib.request.urlopen(req, timeout=60) as r, archive.open("wb") as f:
            state["total"] = int(r.headers.get("Content-Length") or 0)
            while chunk := r.read(1 << 20):
                f.write(chunk)
                state["got"] += len(chunk)
        state["state"] = "unpacking"
        if WIN:
            with zipfile.ZipFile(archive) as z:
                z.extractall(part)
        else:
            with tarfile.open(archive) as t:
                t.extractall(part, filter="data")  # keeps the exec bits and the inner symlinks
        archive.unlink()
        out = subprocess.run([str(part / "EncoreAI" / EXE_NAME), "check"], capture_output=True, text=True, timeout=600,
                             **_no_window())
        if out.returncode != 0:
            lines = (out.stderr or out.stdout).strip().splitlines()
            raise RuntimeError(lines[-1] if lines else "mesin AI tidak bisa dijalankan")
        # swap in the new version, drop older ones
        for old in _root.iterdir():
            if old != part:
                shutil.rmtree(old, ignore_errors=True)
        part.rename(_root / INSTALLED)
        state.update(state="ready", error=None)
    except Exception as e:
        shutil.rmtree(part, ignore_errors=True)
        state.update(state="error", error=f"Gagal memasang mesin AI: {e}")


def remove() -> dict:
    if state["state"] == "installing":
        return status()
    shutil.rmtree(_root, ignore_errors=True)
    state.update(state="idle", got=0, total=0, error=None)
    return status()


def _no_window() -> dict:
    # windows: no extra console window for the engine
    return {"creationflags": subprocess.CREATE_NO_WINDOW} if WIN else {}


def analyze(job_dir: Path, title: str, progress: Callable[[str, float], None]) -> dict:
    """run the ai analysis in the engine; progress() may raise to cancel (the engine is stopped)."""
    cmd = command()
    if cmd is None:
        raise RuntimeError("Mesin AI belum terpasang. Download dulu dari tombol Analisis detail (AI).")
    # outside tmp/: the engine removes tmp/ when it finishes, and windows can't delete an open file
    log_path = job_dir / "engine.log"
    log = log_path.open("w", encoding="utf-8", errors="replace")
    # the engine runs this app's analysis code, so app updates need no new engine
    env = {**os.environ, "ENCORE_PIPELINE": str(PIPELINE)} if FROZEN and PIPELINE.exists() else None
    proc = subprocess.Popen([*cmd, "analyze", str(job_dir), title], stdout=subprocess.PIPE, stderr=log, env=env,
                            text=True, encoding="utf-8", errors="replace", **_no_window())
    result = None
    tail: deque[str] = deque(maxlen=5)
    try:
        for line in proc.stdout:
            line = line.strip()
            if not line.startswith("{"):
                tail.append(line)
                continue
            msg = json.loads(line)
            if "stage" in msg:
                progress(msg["stage"], msg["p"])
            elif "result" in msg:
                result = msg["result"]
        proc.wait()
    except BaseException:
        proc.kill()
        raise
    finally:
        log.close()
    if proc.returncode != 0 or result is None:
        err = log_path.read_text(errors="replace").strip().splitlines()
        raise RuntimeError(f"mesin AI berhenti ({proc.returncode}): {(err or list(tail) or ['?'])[-1]}")
    log_path.unlink(missing_ok=True)
    return result
