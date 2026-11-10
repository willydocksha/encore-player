// pitch shift for <audio> played through web audio: loads the worklet and makes the node.
// shared by the playlist (drive audio) and breakdown (stems).

export const PITCH_MIN = -12, PITCH_MAX = 12;
export const PITCH_LATENCY = 4096 - 4096 / 8; // samples, matches pitch-worklet.js while shifting

const loaded = new WeakMap(); // context -> addModule promise

// fetch the worklet and add it from a blob url: loading it by url can hang in some webviews
async function loadModule(ctx) {
  const url = new URL("./pitch-worklet.js", import.meta.url);
  const code = await fetch(url).then((r) => { if (!r.ok) throw new Error(r.status); return r.text(); });
  const blob = URL.createObjectURL(new Blob([code], { type: "text/javascript" }));
  try { await ctx.audioWorklet.addModule(blob); } finally { URL.revokeObjectURL(blob); }
}

// a pitch-shift node for this context, or null when the browser has no audio worklets
// semitones: starting shift, already active on the first render quantum
export async function pitchNode(ctx, semitones = 0) {
  if (!ctx.audioWorklet) return null;
  if (!loaded.has(ctx)) loaded.set(ctx, loadModule(ctx));
  try { await loaded.get(ctx); } catch { loaded.delete(ctx); return null; }
  const node = new AudioWorkletNode(ctx, "pitch-shift", {
    numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2],
    channelCount: 2, channelCountMode: "explicit", channelInterpretation: "speakers",
    processorOptions: { semitones },
  });
  // set semitones on the node
  node.setSemitones = (s) => node.port.postMessage({ semitones: s });
  return node;
}

// "+2", "−1", "0" for labels
export const fmtSemis = (s) => (s > 0 ? "+" + s : s < 0 ? "−" + -s : "0");

// clamp a step result into range
export const clampSemis = (s) => Math.max(PITCH_MIN, Math.min(PITCH_MAX, Math.round(s)));
