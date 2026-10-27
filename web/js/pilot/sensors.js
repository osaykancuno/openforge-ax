// Phone sensors for the Phone Brain: tilt (DeviceOrientation), camera "look at movement" (frame differencing on a
// tiny canvas, no ML library, nothing leaves the device) and the screen Wake Lock. Every permission is asked only
// from a user gesture, and the app works without any of them. motionCentroid() is pure (tested in Node).

/** What this device and browser can do. */
export function capabilities() {
  const w = typeof window !== "undefined" ? window : {};
  const n = typeof navigator !== "undefined" ? navigator : {};
  const ua = n.userAgent || "";
  const ios = /iPad|iPhone|iPod/.test(ua) || (ua.includes("Macintosh") && n.maxTouchPoints > 1);
  return {
    secure: !!w.isSecureContext,
    bluetooth: !!(n.bluetooth && n.bluetooth.requestDevice),
    motion: typeof w.DeviceOrientationEvent !== "undefined",
    motionNeedsPermission: typeof w.DeviceOrientationEvent !== "undefined" && typeof w.DeviceOrientationEvent.requestPermission === "function",
    camera: !!(n.mediaDevices && n.mediaDevices.getUserMedia),
    wakeLock: !!(n.wakeLock && n.wakeLock.request),
    touch: (n.maxTouchPoints || 0) > 0,
    ios,
    mobile: ios || /Android|Mobi/i.test(ua),
  };
}

// ---------------------------------------------------------------- tilt

/**
 * Starts tilt tracking. Call from a click handler (iOS asks for permission there).
 * cb({ x, y }) with x = left/right tilt and y = forward/back tilt, both -1..1 relative to the pose at start.
 * Returns { stop(), recenter() } or throws if denied/unsupported.
 */
export async function startTilt(cb, { rangeDeg = 30 } = {}) {
  const DOE = window.DeviceOrientationEvent;
  if (!DOE) throw new Error("This device has no motion sensors.");
  if (typeof DOE.requestPermission === "function") {
    const r = await DOE.requestPermission();
    if (r !== "granted") throw new Error("Motion access was not allowed.");
  }
  let zero = null;
  let got = false;
  const portrait = () => !(screen.orientation && /landscape/.test(screen.orientation.type));
  const onOri = (e) => {
    if (e.beta === null || e.gamma === null) return;
    got = true;
    // in landscape the phone's axes swap
    const fwd = portrait() ? e.beta : e.gamma;
    const side = portrait() ? e.gamma : -e.beta;
    if (!zero) zero = { fwd, side };
    const k = (v) => Math.max(-1, Math.min(1, v / rangeDeg));
    cb({ x: k(side - zero.side), y: k(zero.fwd - fwd) });
  };
  window.addEventListener("deviceorientation", onOri);
  return {
    stop: () => window.removeEventListener("deviceorientation", onOri),
    recenter: () => (zero = null),
    get receiving() {
      return got;
    },
  };
}

// ---------------------------------------------------------------- camera: look at movement

/**
 * Centroid of the pixels that changed between two grayscale frames (Uint8 arrays of w*h).
 * Returns { x, y, amount, brightness }: x, y in -1..1 (image space, y down), amount = changed fraction.
 * Null when less than `minFraction` of the image moved.
 */
export function motionCentroid(prev, cur, w, h, { threshold = 28, minFraction = 0.004 } = {}) {
  let sx = 0;
  let sy = 0;
  let count = 0;
  let sum = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      sum += cur[i];
      if (Math.abs(cur[i] - prev[i]) > threshold) {
        sx += x;
        sy += y;
        count++;
      }
    }
  }
  const brightness = sum / (w * h * 255);
  if (count < Math.max(1, minFraction * w * h)) return null;
  return { x: ((sx / count + 0.5) / w) * 2 - 1, y: ((sy / count + 0.5) / h) * 2 - 1, amount: count / (w * h), brightness };
}

/** RGBA ImageData bytes -> grayscale (luma) into `out`. */
export function toGray(rgba, out) {
  for (let i = 0, j = 0; j < out.length; i += 4, j++) out[j] = (rgba[i] * 77 + rgba[i + 1] * 150 + rgba[i + 2] * 29) >> 8;
  return out;
}

/**
 * Front camera + motion tracker. Call from a click handler.
 * onLook({ x, y, amount, brightness }) about 12 times a second; x, y are smoothed and mirrored (selfie view), so
 * x > 0 means "movement on the user's right as they see it". Returns { stop(), video }.
 */
export async function startCamera(video, onLook, { w = 64, h = 48, fps = 12 } = {}) {
  const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "user", width: { ideal: 320 }, height: { ideal: 240 } }, audio: false });
  video.srcObject = stream;
  video.muted = true;
  video.playsInline = true;
  await video.play().catch(() => {});
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  let prev = new Uint8Array(w * h);
  let cur = new Uint8Array(w * h);
  let primed = false;
  let look = { x: 0, y: 0 };
  let idleFrames = 0;
  const timer = setInterval(() => {
    if (document.hidden || video.readyState < 2) return;
    ctx.drawImage(video, 0, 0, w, h);
    toGray(ctx.getImageData(0, 0, w, h).data, cur);
    if (primed) {
      const m = motionCentroid(prev, cur, w, h);
      if (m) {
        idleFrames = 0;
        look = { x: look.x + (-m.x - look.x) * 0.35, y: look.y + (m.y - look.y) * 0.35 };
        onLook({ ...look, amount: m.amount, brightness: m.brightness });
      } else if (++idleFrames > fps * 2) {
        look = { x: look.x * 0.9, y: look.y * 0.9 }; // drift back to centre when nothing moves
        onLook({ ...look, amount: 0, brightness: null });
      }
    }
    [prev, cur] = [cur, prev];
    primed = true;
  }, 1000 / fps);
  return {
    video,
    stop() {
      clearInterval(timer);
      for (const t of stream.getTracks()) t.stop();
      video.srcObject = null;
    },
  };
}

// ---------------------------------------------------------------- wake lock

/** Keeps the screen on while armed. Re-acquires after the page becomes visible again. */
export function createWakeLock() {
  let sentinel = null;
  let pending = null; // one request at a time: on() and visibilitychange can race
  let wanted = false;
  const acquire = () => {
    if (pending) return pending;
    if (!wanted || sentinel || !navigator.wakeLock || document.hidden) return Promise.resolve();
    pending = (async () => {
      try {
        const s = await navigator.wakeLock.request("screen");
        if (!wanted) return void (await s.release().catch(() => {})); // off() came while the request was in flight
        sentinel = s;
        s.addEventListener("release", () => {
          if (sentinel === s) sentinel = null;
        });
      } catch {
        sentinel = null;
      } finally {
        pending = null;
      }
    })();
    return pending;
  };
  if (typeof document !== "undefined") document.addEventListener("visibilitychange", acquire);
  return {
    async on() {
      wanted = true;
      await acquire();
    },
    async off() {
      wanted = false;
      const s = sentinel;
      sentinel = null;
      if (s) await s.release().catch(() => {});
    },
    get active() {
      return !!sentinel;
    },
  };
}
