// breakdown modes: "classic" (built into the app, no ai) and "ai" (the separately downloaded engine)

import { $, store, server } from "./core.js";

export const MODES = {
  classic: "Mode cepat: tanpa AI, sekitar 1 menit per lagu. Drum, bass, vokal, dan lainnya (gitar & piano belum dipisah).",
  ai: "Mode detail: AI memisahkan 6 instrumen dan membaca not lebih akurat. Beberapa menit per lagu.",
};

export const getMode = () => (store.get("bd-mode", "classic") === "ai" && server.ai?.installed ? "ai" : "classic");
export const setMode = (m) => store.set("bd-mode", m);

async function aiStatus() {
  try {
    const r = await fetch("/api/health", { cache: "no-store" });
    server.ai = (await r.json()).ai;
  } catch { /* app closed */ }
  return server.ai || {};
}

const mb = (n) => `${Math.round(n / 1e6)} MB`;

function paint(st) {
  const busy = st.state === "installing" || st.state === "unpacking";
  $("#aiProgress").hidden = !busy;
  $("#aiInstall").disabled = busy;
  // short label so both buttons fit; the hint lives in the progress text
  $("#aiLater").textContent = busy ? "Tutup" : "Nanti saja";
  $("#aiError").hidden = !st.error;
  $("#aiError").textContent = st.error || "";
  if (st.state === "unpacking") {
    $("#aiBar").style.width = "100%";
    $("#aiProgressText").textContent = "Memasang mesin AI…";
  } else if (busy) {
    const p = st.total ? st.got / st.total : 0;
    $("#aiBar").style.width = `${Math.round(p * 100)}%`;
    $("#aiProgressText").textContent = st.total ? `Mengunduh ${mb(st.got)} dari ${mb(st.total)}. Boleh ditutup, download tetap jalan.` : "Menghubungi server…";
  }
}

// resolves true once the engine is installed, false if the dialog is closed first
export async function ensureAi() {
  if ((await aiStatus()).installed) return true;
  const d = $("#aiDialog");
  let timer = null;
  const watch = async () => {
    const st = await aiStatus();
    paint(st);
    if (st.installed) { d.close("ok"); return; }
    if (st.state === "installing" || st.state === "unpacking") timer = setTimeout(watch, 700);
  };
  $("#aiInstall").onclick = async () => {
    $("#aiError").hidden = true;
    try { await fetch("/api/ai/install", { method: "POST" }); } catch { /* shown by watch */ }
    watch();
  };
  d.returnValue = "";
  paint(server.ai || {});
  d.showModal();
  watch();
  return new Promise((resolve) => d.addEventListener("close", () => { clearTimeout(timer); resolve(d.returnValue === "ok"); }, { once: true }));
}
