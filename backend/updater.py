"""in-app update for the packaged mac app.

a browser download gets macOS's quarantine mark, so every new version asks for "Open Anyway" again
(the app is not signed by apple). a file this program downloads itself carries no such mark, so the app
fetches its own release, swaps its bundle and restarts: no prompt, same as the first install never happened.
"""

from __future__ import annotations

import hashlib
import json
import os
import shlex
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request
from pathlib import Path

# what the page polls: idle | downloading | installing | restarting | error
status: dict = {"state": "idle", "got": 0, "total": 0, "error": None, "version": None}
_lock = threading.Lock()


def bundle_path() -> Path | None:
    """the installed Encore.app this process runs from (None when run from source or off mac)."""
    if sys.platform != "darwin" or not getattr(sys, "frozen", False):
        return None
    for parent in Path(sys.executable).resolve().parents:
        if parent.suffix == ".app":
            return parent
    return None


def can_install() -> bool:
    """true when this app can replace itself: a packaged mac app in a folder we may write to."""
    b = bundle_path()
    return bool(b) and os.access(b.parent, os.W_OK)


def _set(**kw) -> None:
    status.update(kw)


def _download(url: str, dest: Path, digest: str | None) -> None:
    req = urllib.request.Request(url, headers={"User-Agent": "Encore"})
    h = hashlib.sha256()
    with urllib.request.urlopen(req, timeout=30) as r, open(dest, "wb") as f:
        _set(total=int(r.headers.get("Content-Length") or 0), got=0)
        while chunk := r.read(1 << 20):
            f.write(chunk)
            h.update(chunk)
            _set(got=status["got"] + len(chunk))
    # github publishes a sha256 for each asset: a damaged or swapped file is never installed
    if digest and digest.startswith("sha256:") and h.hexdigest() != digest[len("sha256:"):]:
        raise ValueError("file unduhan tidak cocok (checksum)")


def _swap_script(pid: int, app: Path, new: Path, tmp: Path) -> str:
    """shell script that waits for this process to quit, swaps the bundle and opens the new app.
    when the swap fails the old app is put back and opened, so a failed update never loses the app."""
    old = app.with_name(app.name + ".old")
    q = shlex.quote
    return f"""#!/bin/sh
PID={pid}
APP={q(str(app))}
NEW={q(str(new))}
OLD={q(str(old))}
TMP={q(str(tmp))}
i=0
while kill -0 "$PID" 2>/dev/null && [ $i -lt 100 ]; do sleep 0.3; i=$((i+1)); done
rm -rf "$OLD"
if mv "$APP" "$OLD" && mv "$NEW" "$APP"; then
  xattr -cr "$APP" 2>/dev/null
  rm -rf "$OLD"
else
  [ -d "$OLD" ] && [ ! -d "$APP" ] && mv "$OLD" "$APP"
  rm -rf "$NEW"
fi
rm -rf "$TMP"
open "$APP"
"""


def _run(url: str, digest: str | None, version: str, restart_flag: Path) -> None:
    tmp = Path(tempfile.mkdtemp(prefix="encore-update-"))
    mount = tmp / "mnt"
    mounted = False
    app = bundle_path()
    try:
        assert app is not None
        dmg = tmp / "Encore.dmg"
        _set(state="downloading", got=0, total=0, error=None, version=version)
        _download(url, dmg, digest)

        _set(state="installing")
        mount.mkdir()
        subprocess.run(["hdiutil", "attach", "-nobrowse", "-readonly", "-noverify", "-mountpoint", str(mount), str(dmg)],
                       check=True, capture_output=True, timeout=120)
        mounted = True
        src = mount / "Encore.app"
        if not (src / "Contents" / "MacOS").is_dir():
            raise ValueError("isi file update tidak dikenali")
        # staged next to the installed app so the final swap is a rename on the same disk
        new = app.with_name(app.name + ".new")
        shutil.rmtree(new, ignore_errors=True)
        subprocess.run(["ditto", str(src), str(new)], check=True, capture_output=True, timeout=300)
        subprocess.run(["hdiutil", "detach", "-force", str(mount)], capture_output=True, timeout=60)
        mounted = False
        if not any((new / "Contents" / "MacOS").iterdir()):
            raise ValueError("app hasil update kosong")

        script = tmp / "swap.sh"
        script.write_text(_swap_script(os.getpid(), app, new, tmp))
        # the page reloads itself when the new app answers, so the new app must not open another tab
        restart_flag.write_text(str(time.time()))
        subprocess.Popen(["/bin/sh", str(script)], start_new_session=True,
                         stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        _set(state="restarting")
        # let the page read "restarting", then stop: the script takes over
        threading.Timer(1.5, lambda: os._exit(0)).start()
    except Exception as err:  # noqa: BLE001 - any failure is shown to the user and leaves the app untouched
        if mounted:
            subprocess.run(["hdiutil", "detach", "-force", str(mount)], capture_output=True)
        shutil.rmtree(tmp, ignore_errors=True)
        if app is not None:
            shutil.rmtree(app.with_name(app.name + ".new"), ignore_errors=True)
        restart_flag.unlink(missing_ok=True)
        _set(state="error", error=str(err) or err.__class__.__name__)


def start(url: str, digest: str | None, version: str, restart_flag: Path) -> bool:
    """begin the update in the background; false when one is already running."""
    with _lock:
        if status["state"] in ("downloading", "installing", "restarting"):
            return False
        _set(state="downloading", got=0, total=0, error=None, version=version)
    threading.Thread(target=_run, args=(url, digest, version, restart_flag), daemon=True).start()
    return True


def release_asset(api: str, version: str, name: str) -> tuple[str, str | None]:
    """download url and sha256 digest (when github has it) of a release's file."""
    req = urllib.request.Request(f"{api}/tags/app-v{version}",
                                 headers={"User-Agent": "Encore", "Accept": "application/vnd.github+json"})
    with urllib.request.urlopen(req, timeout=10) as r:
        rel = json.loads(r.read())
    for a in rel.get("assets", []):
        if a.get("name") == name:
            return a["browser_download_url"], a.get("digest")
    raise ValueError(f"{name} tidak ada di rilis {version}")
