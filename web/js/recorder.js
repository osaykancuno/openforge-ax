// Clip recording for content and the hero video (docs/10-GROWTH-TOOLS.md §3). Nothing is uploaded: the video is
// composed in the page and offered as a download. It only READS canvases and the camera: it never calls the robot.

const MIMES = [
  ["video/webm;codecs=vp9", "webm"],
  ["video/webm;codecs=vp8", "webm"],
  ["video/webm", "webm"],
  ["video/mp4", "mp4"], // Safari
];

export function recordingSupported() {
  return typeof MediaRecorder !== "undefined" && typeof HTMLCanvasElement.prototype.captureStream === "function" && MIMES.some(([m]) => MediaRecorder.isTypeSupported(m));
}

/** Camera stream for film mode (asked only after an explicit click). */
export async function openCamera() {
  return navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment", width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
}

export const stopStream = (stream) => stream?.getTracks().forEach((t) => t.stop());

/**
 * left: a canvas (the twin or the arena, rendered with preserveDrawingBuffer); right: optional <video> (camera).
 * Burns a title, a subtitle and a timer into the frame. Stops by itself after maxSeconds or when the tab is hidden.
 */
export function createRecorder({ left, right = null, title, subtitle = "", labels = ["DIGITAL TWIN", "REAL SO-101"], width = 1280, height = 720, maxSeconds = 180 }) {
  const [mime, ext] = MIMES.find(([m]) => MediaRecorder.isTypeSupported(m));
  const out = Object.assign(document.createElement("canvas"), { width, height });
  const g = out.getContext("2d");
  let rec = null, chunks = [], timer = null, raf = 0, t0 = 0, done = null;

  const cover = (src, x, y, w, h) => {
    const sw = src.videoWidth || src.width, sh = src.videoHeight || src.height;
    if (!sw || !sh) return;
    const s = Math.max(w / sw, h / sh);
    const cw = w / s, ch = h / s;
    g.drawImage(src, (sw - cw) / 2, (sh - ch) / 2, cw, ch, x, y, w, h);
  };

  function frame() {
    try {
      g.fillStyle = "#f4efe6"; // paper
      g.fillRect(0, 0, width, height);
      if (right) {
        cover(left, 0, 0, width / 2 - 2, height);
        cover(right, width / 2 + 2, 0, width / 2 - 2, height);
        g.fillStyle = "#23211e"; // ink divider
        g.fillRect(width / 2 - 2, 0, 4, height);
        label(labels[0], 24, 44);
        label(labels[1], width / 2 + 24, 44);
      } else cover(left, 0, 0, width, height);
      // lower third
      g.fillStyle = "rgba(251,248,242,0.92)"; // card
      g.fillRect(0, height - 92, width, 92);
      g.fillStyle = "#b4472f"; // terracotta rule
      g.fillRect(0, height - 92, width, 3);
      g.fillStyle = "#23211e"; // ink
      g.font = "700 34px 'JetBrains Mono', Consolas, monospace";
      g.fillText(title, 28, height - 50);
      g.fillStyle = "#6b655c"; // muted
      g.font = "20px 'JetBrains Mono', Consolas, monospace";
      g.fillText(subtitle, 28, height - 20);
      const secs = ((performance.now() - t0) / 1000).toFixed(1);
      g.textAlign = "right";
      g.fillStyle = "#9e3d28"; // terracotta ink
      g.font = "700 28px 'JetBrains Mono', Consolas, monospace";
      g.fillText(`${secs}s`, width - 28, height - 36);
      g.textAlign = "left";
    } catch {} // a drawing error must never break the page
    raf = requestAnimationFrame(frame);
  }
  function label(text, x, y) {
    g.font = "700 22px 'JetBrains Mono', Consolas, monospace";
    g.fillStyle = "rgba(251,248,242,0.9)";
    g.fillRect(x - 10, y - 26, g.measureText(text).width + 20, 36);
    g.fillStyle = "#23211e"; // ink
    g.fillText(text, x, y);
  }
  const onHidden = () => document.hidden && stop();

  function start() {
    if (rec) return;
    chunks = [];
    t0 = performance.now();
    rec = new MediaRecorder(out.captureStream(30), { mimeType: mime, videoBitsPerSecond: 6_000_000 }); // may throw: before the draw loop starts
    frame();
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    done = new Promise((resolve) => (rec.onstop = () => resolve(new Blob(chunks, { type: mime.split(";")[0] }))));
    rec.start(1000); // 1 s slices keep memory steady on long takes
    timer = setTimeout(stop, maxSeconds * 1000);
    document.addEventListener("visibilitychange", onHidden);
  }

  /** Resolves with the video Blob (or null if it never started). */
  function stop() {
    if (!rec) return Promise.resolve(null);
    clearTimeout(timer);
    cancelAnimationFrame(raf);
    document.removeEventListener("visibilitychange", onHidden);
    const r = rec;
    rec = null;
    if (r.state !== "inactive") r.stop();
    return done;
  }

  return { start, stop, ext, get active() { return Boolean(rec); } };
}

export function saveVideo(blob, name) {
  if (!blob) return;
  const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}
