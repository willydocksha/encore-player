// qr scanner on the device camera: the browser's own BarcodeDetector when it has one (chrome on android),
// otherwise jsQR (vendored) on downscaled video frames (safari, firefox).

let jsqrLoad = null;

// classic script, loaded on first scan only
function loadJsQR() {
  jsqrLoad ||= new Promise((ok, fail) => {
    const s = document.createElement("script");
    s.src = "/app/vendor/jsqr.min.js";
    s.onload = ok;
    s.onerror = () => { jsqrLoad = null; fail(new Error("gagal memuat pembaca QR")); };
    document.head.append(s);
  });
  return jsqrLoad;
}

// native detector, if this browser supports qr codes
async function nativeDetector() {
  try {
    if (!("BarcodeDetector" in window)) return null;
    const formats = await window.BarcodeDetector.getSupportedFormats();
    return formats.includes("qr_code") ? new window.BarcodeDetector({ formats: ["qr_code"] }) : null;
  } catch { return null; }
}

// start the back camera in `video` and call onCode(text) once a qr is read. returns stop()
export async function startScan(video, onCode) {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error("Browser ini tidak bisa membuka kamera");
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } },
    audio: false,
  });
  let stopped = false, timer = 0;
  const stop = () => {
    stopped = true;
    clearTimeout(timer);
    stream.getTracks().forEach((t) => t.stop());
    if (video.srcObject === stream) video.srcObject = null; // a newer scan may own the video by now
  };

  try {
    video.srcObject = stream;
    video.setAttribute("playsinline", ""); // ios: play inline, not fullscreen
    video.muted = true;
    await video.play();
    const native = await nativeDetector();
    if (!native) await loadJsQR();
    if (stopped) return stop;

    // frames go through a small canvas: fast enough for jsQR on a phone
    const canvas = document.createElement("canvas");
    const g = canvas.getContext("2d", { willReadFrequently: true });

    const look = async () => {
      if (stopped) return;
      let text = null;
      try {
        if (video.readyState >= 2 && video.videoWidth) {
          if (native) {
            const found = await native.detect(video);
            text = found[0]?.rawValue || null;
          } else {
            const scale = Math.min(1, 640 / Math.max(video.videoWidth, video.videoHeight));
            canvas.width = Math.round(video.videoWidth * scale);
            canvas.height = Math.round(video.videoHeight * scale);
            g.drawImage(video, 0, 0, canvas.width, canvas.height);
            const img = g.getImageData(0, 0, canvas.width, canvas.height);
            text = window.jsQR(img.data, img.width, img.height, { inversionAttempts: "dontInvert" })?.data || null;
          }
        }
      } catch {}
      if (stopped) return;
      if (text) { stop(); onCode(text); return; }
      timer = setTimeout(look, 120);
    };
    look();
  } catch (e) {
    stop();
    throw e;
  }
  return stop;
}

// sync code out of a scanned text: the join link (…?sync=CODE) or a bare code
export function codeFrom(text) {
  const m = String(text).match(/[?&]sync=([A-Za-z0-9]+)/);
  if (m) return m[1];
  return /^[A-Za-z0-9]{4,8}$/.test(String(text).trim()) ? String(text).trim() : "";
}
