# encore app version: the release tag is app-v<APP_VERSION>, and the app downloads the ai engine
# from that same release so both always match (the release workflow checks the tag)
APP_VERSION = "1.1.5"
RELEASES = "https://github.com/willy-docksha/encore-player/releases"
# which encore app endpoints the ui may use; the online site's /api/ui says what its ui needs (api/ui.js API).
# a newer ui is only pulled in when it needs no more than this app offers
UI_API = 1
