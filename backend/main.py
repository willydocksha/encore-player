"""encore app: starts the local server and opens encore in the default browser.

run from source:  .venv/bin/python backend/main.py
packaged:         pyinstaller backend/encore.spec (see README "Encore App")
"""

from __future__ import annotations

import json
import multiprocessing
import os
import socket
import sys
import threading
import time
import urllib.request
import webbrowser
from pathlib import Path

PORT = int(os.environ.get("PORT") or 8765)


def use_bundled_certificates() -> None:
    """the packaged python can't read the system certificate store: use certifi's for https
    (drive, youtube, ai engine and model downloads; the engine inherits it)."""
    try:
        import certifi

        os.environ.setdefault("SSL_CERT_FILE", certifi.where())
    except ImportError:
        pass


def running_app(port: int) -> bool:
    """true when an encore app already answers on this port."""
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/health", timeout=1) as r:
            return bool(json.load(r).get("app"))
    except Exception:
        return False


def port_free(port: int) -> bool:
    with socket.socket() as s:
        # like uvicorn: a port the last run just closed is still free (posix keeps it in time_wait for a while).
        # staying on 8765 matters: the playlist is saved per address, and the online site syncs with 8765
        if sys.platform != "win32":
            s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            s.bind(("127.0.0.1", port))
            return True
        except OSError:
            return False


def pick_port() -> int:
    for port in range(PORT, PORT + 20):
        if port_free(port):
            return port
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


ONLINE = "https://encore-player.vercel.app"
# browsers that let the online page talk to this app (chromium's local network access); safari does not
CHROMIUM_IDS = ("com.google.chrome", "com.microsoft.edgemac", "com.brave.browser", "company.thebrowser", "com.vivaldi",
                "com.operasoftware", "org.chromium", "chromehtml", "msedgehtm", "bravehtml", "operastable", "vivaldi",
                "google-chrome", "chromium", "microsoft-edge", "brave-browser", "opera", "vivaldi")


def default_browser_id() -> str:
    """identifier of the user's default browser, lowercase ('' when it can't be found)."""
    try:
        if sys.platform == "darwin":
            from AppKit import NSWorkspace
            from Foundation import NSBundle, NSURL

            app_url = NSWorkspace.sharedWorkspace().URLForApplicationToOpenURL_(NSURL.URLWithString_("https://example.com"))
            return str(NSBundle.bundleWithURL_(app_url).bundleIdentifier() or "").lower()
        if sys.platform == "win32":
            import winreg

            key = r"Software\Microsoft\Windows\Shell\Associations\UrlAssociations\https\UserChoice"
            with winreg.OpenKey(winreg.HKEY_CURRENT_USER, key) as k:
                return str(winreg.QueryValueEx(k, "ProgId")[0]).lower()
        import subprocess

        return subprocess.run(["xdg-settings", "get", "default-web-browser"], capture_output=True, text=True, timeout=3).stdout.strip().lower()
    except Exception:
        return ""


def online_reachable() -> bool:
    """true when the online site answers (so there is internet)."""
    try:
        req = urllib.request.Request(ONLINE + "/", method="HEAD", headers={"User-Agent": "Encore"})
        urllib.request.urlopen(req, timeout=2).close()
        return True
    except Exception:
        return False


def open_encore(local_url: str) -> None:
    """open encore in the browser: the online page when it can drive this app (chromium browser, internet,
    the default port the online site looks at), else the app's own page on localhost, which works offline.
    ENCORE_OPEN=local|online forces one."""
    force = os.environ.get("ENCORE_OPEN")
    online = force == "online"
    if force is None and local_url.rstrip("/").endswith(f":{PORT}"):
        bid = default_browser_id()
        online = any(bid.startswith(c) or c in bid for c in CHROMIUM_IDS) and online_reachable()
    # ?app=1 lets the online page connect to the app right away instead of waiting for a click
    webbrowser.open(f"{ONLINE}/?app=1#/breakdown" if online else local_url + "#/breakdown")


def open_when_ready(url: str, skip_open: bool = False) -> None:
    for _ in range(600):
        try:
            urllib.request.urlopen(url + "api/health", timeout=1).close()
            break
        except Exception:
            time.sleep(0.2)
    if not skip_open:
        open_encore(url)


def run_mac_app(url: str, serve) -> None:
    """packaged mac app: a dock icon that reopens encore when clicked and quits from the dock menu."""
    from AppKit import NSApplication, NSApplicationActivationPolicyRegular
    from Foundation import NSObject

    class Delegate(NSObject):
        def applicationShouldHandleReopen_hasVisibleWindows_(self, _app, _flag):
            open_encore(url)
            return True

    app = NSApplication.sharedApplication()
    delegate = Delegate.alloc().init()
    app.setDelegate_(delegate)
    app.setActivationPolicy_(NSApplicationActivationPolicyRegular)
    threading.Thread(target=serve, daemon=True).start()
    app.run()


def main() -> None:
    use_bundled_certificates()
    # a second launch just opens the window of the one already running
    if running_app(PORT):
        open_encore(f"http://localhost:{PORT}/")
        return

    # the windowed mac app has no terminal: keep the log in the app data folder
    if sys.stdout is None or sys.stderr is None:
        from app import data_dir

        log = open(Path(data_dir()) / "encore.log", "a", buffering=1, encoding="utf-8")
        sys.stdout = sys.stdout or log
        sys.stderr = sys.stderr or log

    print("Menyiapkan Encore… (pertama kali bisa agak lama)")
    import uvicorn

    from app import RESTART_FLAG, app

    port = pick_port()
    url = f"http://localhost:{port}/"
    # restarted by the in-app update: the page that asked for it reloads itself, so no new tab
    skip_open = RESTART_FLAG.exists() and time.time() - RESTART_FLAG.stat().st_mtime < 120
    RESTART_FLAG.unlink(missing_ok=True)
    threading.Thread(target=open_when_ready, args=(url, skip_open), daemon=True).start()
    print(f"Encore jalan di {url}")

    def serve():
        uvicorn.run(app, host="127.0.0.1", port=port, log_level="warning", log_config=None)

    if getattr(sys, "frozen", False) and sys.platform == "darwin":
        run_mac_app(url, serve)
        return
    print("Biarkan jendela ini terbuka selama memakai Encore. Tutup jendela ini (atau tombol Tutup Encore App) untuk berhenti.")
    serve()


if __name__ == "__main__":
    # pyin runs in worker processes; the packaged app must let them start
    multiprocessing.freeze_support()
    main()
