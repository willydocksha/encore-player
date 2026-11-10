// boot: routes, cross-section wiring, shortcuts, service worker

import { $, router, server, store } from "./core.js";
import { initPlaylist, onSendToBass } from "./playlist.js";
import { initBass, enterBassHome, enterSong, leaveSong, submitLink } from "./bass.js";
import { startTour, maybeStartTour } from "./tour.js";
import { initEar, enterEar } from "./ear.js";
import { initTuner, enterTuner } from "./tuner.js";
import { initMetronome, enterMetronome } from "./metronome.js";
import { checkUiUpdate } from "./uiupdate.js";
import { checkAppUpdate } from "./appupdate.js";

router.add(/^#\/?$/, "playlist", () => { leaveSong(); document.title = "Encore"; });
router.add(/^#\/perfect-pitch\/?$/, "ear", () => { leaveSong(); enterEar(); document.title = "Perfect Pitch · Encore"; });
router.add(/^#\/tuner\/?$/, "tuner", () => { leaveSong(); enterTuner(); document.title = "Tuner · Encore"; });
router.add(/^#\/metronome\/?$/, "metro", () => { leaveSong(); enterMetronome(); document.title = "Metronome · Encore"; });
router.add(/^#\/breakdown\/?$/, "bass", () => enterBassHome());
router.add(/^#\/breakdown\/(\w+)$/, "song", (id) => enterSong(id));
// older links (ngulik, bass section, delve)
router.add(/^#\/(?:bass|ngulik)\/?$/, "bass", () => router.go("#/breakdown"));
router.add(/^#\/(?:ngulik|bass\/song|song)\/(\w+)$/, "song", (id) => router.go(`#/breakdown/${id}`));

onSendToBass((url, title) => submitLink(url, title));
$("#shortcutsBtn").onclick = () => $("#shortcuts").showModal();
$("#tourBtn").onclick = () => startTour();

// fold the sidebar down to icons (desktop), remembered per device
function setFolded(on) {
  document.querySelector(".shell").classList.toggle("nav-folded", on);
  const label = on ? "Buka menu" : "Lipat menu";
  $("#navFold").title = label;
  $("#navFold").setAttribute("aria-label", label);
  $("#navFold").setAttribute("aria-expanded", String(!on));
  store.set("nav-folded", on);
  // canvases size themselves on resize: once now, once after the width animation
  dispatchEvent(new Event("resize"));
  setTimeout(() => dispatchEvent(new Event("resize")), 250);
}
setFolded(store.get("nav-folded", false));
$("#navFold").onclick = () => setFolded(!document.querySelector(".shell").classList.contains("nav-folded"));

initBass();
initPlaylist();
initEar();
initTuner();
initMetronome();
// its first, synchronous part only saved the defaults; from here on saved changes count as the newest (sync.js)
store.booting = false;
// the bass pages depend on the local server, so learn whether it is there before routing
server.check().then(() => { router.resolve(); maybeStartTour(); if (server.mode === "app") checkAppUpdate(); });
// each page shows its own tour the first time it is opened
addEventListener("hashchange", () => maybeStartTour());

// encore app: newer ui from the online site, applied with a reload
checkUiUpdate();

if ("serviceWorker" in navigator && location.protocol === "https:") navigator.serviceWorker.register("/sw.js").catch(() => {});
