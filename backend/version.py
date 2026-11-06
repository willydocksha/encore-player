# encore app version: the release tag is app-v<APP_VERSION> (the release workflow checks the tag)
APP_VERSION = "1.1.8"
# the ai engine is only the ai runtime (torch, demucs, ...); the analysis code (pipeline.py) comes
# from the app, so an app update keeps the installed engine. bump ENGINE_VERSION when the runtime
# changes; the release workflow checks ENGINE_FINGERPRINT (python backend/engine_fingerprint.py)
ENGINE_VERSION = 1
ENGINE_FINGERPRINT = "2546294557df29cd"
RELEASES = "https://github.com/willy-docksha/encore-player/releases"
# which encore app endpoints the ui may use; the online site's /api/ui says what its ui needs (api/ui.js API).
# a newer ui is only pulled in when it needs no more than this app offers
UI_API = 1
