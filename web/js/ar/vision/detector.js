// AR Rover, "Look around": the object detector. MediaPipe Tasks Vision (EfficientDet-Lite0, COCO-80), vendored under
// vendor/mediapipe/ and loaded only when the user turns "Look around" on. Same origin only: nothing is ever fetched
// from elsewhere, and camera frames never leave the phone.
//
// Where it runs. The drive loop latches the twin when the main thread stalls for more than 283 ms, and one detection
// costs 120-190 ms on a desktop (2-4x that on a phone). So the detector lives in a dedicated classic Web Worker
// (detect-worker.js: importScripts of vendor/mediapipe/vision_bundle.js, the IIFE build; the ES-module build cannot load
// its wasm glue inside a worker). The page only:
//   * camera view: createImageBitmap(video) shrunk to 320 px (off the main thread) and transferred;
//   * XR: the 320 px ImageData buffer from xr-camera.js, transferred;
//   * one detection at a time: a frame that arrives while one is in flight is dropped, never queued.
// Only if the worker cannot start does it fall back to the main thread, and then it looks only when mayRunOnMain()
// says it is safe (the glue passes "no plan is running", better "not armed"), and says so with a notice. The CPU
// delegate is used everywhere (the GPU one would open a second WebGL context next to the AR renderer).
//
// MediaPipe 1.1.1 always creates a usage logger that posts to a Google logging endpoint with fetch and cannot be turned
// off. We never even attempt it: every fetch / XMLHttpRequest to another origin is rejected locally before it leaves the
// page (installOffsiteGuard here for the fallback, the same code in detect-worker.js for the worker). The wasm and the
// model are same-origin and pass.
//
// The model's labels are untrusted text: only the COCO-80 names survive (world-objects.canonicalLabel).
import { canonicalLabel } from "./world-objects.js";

const DEFAULTS = { delegate: "CPU", scoreThreshold: 0.5, maxResults: 5, inputWidth: 320, slowMs: 250, maxFailures: 3, initTimeoutMs: 90000, detectTimeoutMs: 5000 };
const MSG_FAILED = "Object finding stopped working on this device, so I turned it off.";
const MSG_NO_START = "Object finding could not start on this device.";
const MSG_SLOW = "This phone is too slow for object finding, so I turned it off to keep driving safe.";
const MSG_STUCK = "Object finding stopped answering, so I turned it off.";
const MSG_NO_MAIN_NOW = "Object finding cannot run in the background on this browser. Press STOP, then turn Look around on again.";
const MSG_MAIN = "Object finding cannot run in the background on this browser, so it only looks while the Rover is not driving.";

const isNum = (n) => typeof n === "number" && Number.isFinite(n);
const clamp01 = (n) => Math.min(1, Math.max(0, n));
const isVideo = (s) => !!s && typeof s === "object" && isNum(s.videoWidth) && isNum(s.videoHeight) && s.videoWidth > 0 && s.videoHeight > 0 && (s.readyState === undefined || s.readyState >= 2);
const isImage = (s) => !!s && typeof s === "object" && isNum(s.width) && isNum(s.height) && s.width > 0 && s.height > 0 && !!s.data;

// ---------------------------------------------------------------- no off-site requests

/**
 * Makes `target.fetch` and `target.XMLHttpRequest.prototype.open` refuse any URL whose origin is not `origin`, without a
 * network attempt. Returns a function that puts the originals back. target: window / globalThis.
 */
export function installOffsiteGuard(target, origin) {
  const undo = [];
  const same = (url) => {
    try {
      return new URL(typeof url === "string" ? url : url && url.url ? url.url : String(url), origin).origin === origin;
    } catch {
      return false;
    }
  };
  if (typeof target.fetch === "function") {
    const real = target.fetch;
    target.fetch = function guardedFetch(input, init) {
      if (!same(input)) return Promise.reject(new TypeError("off-site request blocked"));
      return real.call(this === target || this === undefined ? target : this, input, init);
    };
    const mine = target.fetch;
    undo.push(() => {
      if (target.fetch === mine) target.fetch = real; // someone wrapped it after us: leave their wrap alone
    });
  }
  const X = target.XMLHttpRequest;
  if (X && X.prototype && typeof X.prototype.open === "function") {
    const open = X.prototype.open;
    X.prototype.open = function guardedOpen(method, url, ...rest) {
      if (!same(url)) throw new TypeError("off-site request blocked");
      return open.call(this, method, url, ...rest);
    };
    const mineOpen = X.prototype.open;
    undo.push(() => {
      if (X.prototype.open === mineOpen) X.prototype.open = open;
    });
  }
  return () => {
    for (const u of undo.reverse()) u();
    undo.length = 0;
  };
}

// ---------------------------------------------------------------- engines

/** The main-thread engine (fallback): MediaPipe ObjectDetector behind three small functions, so tests never need MediaPipe. */
export async function mediapipeLoader({ runningMode, delegate, scoreThreshold, maxResults }) {
  const mod = await import("../../../vendor/mediapipe/vision_bundle.mjs");
  const fileset = await mod.FilesetResolver.forVisionTasks(new URL("../../../vendor/mediapipe/wasm", import.meta.url).href);
  const od = await mod.ObjectDetector.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: new URL("../../../vendor/mediapipe/efficientdet_lite0.tflite", import.meta.url).href, delegate },
    runningMode,
    scoreThreshold,
    maxResults,
  });
  return {
    detectVideo: (video, tMs) => od.detectForVideo(video, tMs),
    detectImage: (image) => od.detect(image),
    close: () => od.close(),
  };
}

/** The dedicated worker: a CLASSIC worker (it importScripts the IIFE build of MediaPipe). */
export function defaultCreateWorker() {
  return new Worker(new URL("./detect-worker.js", import.meta.url));
}

/** Draws a video frame into a small canvas (one allocation, reused). Without a canvas it passes the video through. */
function makePrepare(inputWidth, createCanvas) {
  let canvas = null;
  let ctx = null;
  const make =
    createCanvas ||
    ((w, h) => {
      if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(w, h);
      if (typeof document !== "undefined") {
        const c = document.createElement("canvas");
        c.width = w;
        c.height = h;
        return c;
      }
      return null;
    });
  return function prepare(src) {
    if (isImage(src) && !isVideo(src)) return { input: src, width: src.width, height: src.height };
    const vw = src.videoWidth;
    const vh = src.videoHeight;
    if (vw <= inputWidth) return { input: src, width: vw, height: vh };
    const w = inputWidth;
    const h = Math.max(1, Math.round((vh * inputWidth) / vw));
    if (!canvas || canvas.width !== w || canvas.height !== h) {
      canvas = make(w, h);
      ctx = canvas && canvas.getContext ? canvas.getContext("2d", { willReadFrequently: true }) : null;
    }
    if (!canvas || !ctx) return { input: src, width: vw, height: vh };
    ctx.drawImage(src, 0, 0, w, h);
    return { input: canvas, width: w, height: h };
  };
}

/** A video frame as a small ImageBitmap, resized off the main thread. */
async function defaultMakeBitmap(video, inputWidth) {
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  if (vw <= inputWidth) return createImageBitmap(video);
  const h = Math.max(1, Math.round((vh * inputWidth) / vw));
  try {
    return await createImageBitmap(video, { resizeWidth: inputWidth, resizeHeight: h, resizeQuality: "low" });
  } catch {
    return createImageBitmap(video); // an engine without the resize options: full size, the worker shrinks nothing, still off-thread
  }
}

/** MediaPipe result -> [{label, score, box:{x,y,w,h}}] with 0..1 boxes (origin top-left), COCO labels only. */
function normalise(result, width, height, { scoreThreshold, maxResults }) {
  const out = [];
  const list = result && Array.isArray(result.detections) ? result.detections : [];
  for (const d of list) {
    if (out.length >= maxResults) break;
    const cat = d && Array.isArray(d.categories) ? d.categories[0] : null;
    const bb = d && d.boundingBox;
    if (!cat || !bb) continue;
    const label = canonicalLabel(cat.categoryName);
    const score = cat.score;
    if (!label || !isNum(score) || score < scoreThreshold || score > 1.0001) continue;
    if (!isNum(bb.originX) || !isNum(bb.originY) || !isNum(bb.width) || !isNum(bb.height) || !(width > 0) || !(height > 0)) continue;
    const x = clamp01(bb.originX / width);
    const y = clamp01(bb.originY / height);
    const w = Math.min(bb.width / width, 1 - x);
    const h = Math.min(bb.height / height, 1 - y);
    if (!(w > 0) || !(h > 0)) continue;
    out.push({ label, score: Math.min(1, score), box: { x, y, w, h } });
  }
  return out;
}

/**
 * createDetector({ mode: "VIDEO" | "IMAGE", createWorker, loader, mayRunOnMain, onNotice, ... })
 *   VIDEO: detect(<video>, tMs) for the camera view. IMAGE: detect(ImageData, tMs) for the XR camera image; the
 *   ImageData buffer is handed to the worker (transferred), do not reuse it afterwards.
 *   load() -> Promise<boolean>: lazy, once. First the worker; if it cannot start, the main thread (see mayRunOnMain).
 *   detect(src, tMs) -> Promise<detections | null>: [] = nothing seen or nothing to look at; null = frame dropped (one is
 *   already in flight, or the main-thread fallback may not run right now). Never rejects.
 *   close(), ready, disabled, reason, where ("worker" | "main" | null), stats { calls, lastMs, maxMs }.
 * createWorker() -> Worker-like { postMessage, terminate, onmessage, onerror }; default: the real worker where Worker exists, else none.
 * loader({ runningMode, delegate, scoreThreshold, maxResults }) -> { detectVideo, detectImage, close } for the fallback.
 * mayRunOnMain() -> boolean: whether the fallback may run now. NOTE: while the Rover is armed the drive loop's watchdog
 * also watches an idle Rover, so "armed" is the strict condition, not just "a plan is running".
 */
export function createDetector({
  mode = "VIDEO",
  createWorker = typeof Worker !== "undefined" ? defaultCreateWorker : null,
  loader = mediapipeLoader,
  mayRunOnMain = () => true,
  prepare = null,
  makeBitmap = null,
  onNotice = () => {},
  now = () => (typeof performance !== "undefined" ? performance.now() : Date.now()),
  timers = { setTimeout: (f, ms) => setTimeout(f, ms), clearTimeout: (h) => clearTimeout(h) },
  guardTarget = typeof globalThis !== "undefined" ? globalThis : null,
  guardOrigin = typeof location !== "undefined" ? location.origin : null,
  ...opts
} = {}) {
  const o = { ...DEFAULTS, ...opts };
  const prep = prepare || makePrepare(o.inputWidth, o.createCanvas);
  const bitmap = makeBitmap || ((v) => defaultMakeBitmap(v, o.inputWidth));
  const stats = { calls: 0, lastMs: 0, maxMs: 0 };
  let where = null;
  let worker = null;
  let engine = null; // main-thread engine
  let unguard = null;
  let pending = null; // { seq, resolve, timer }
  let seq = 0;
  let loading = null;
  let abortInit = null;
  let closed = false;
  let disabled = false;
  let reason = "";
  let failures = 0;
  let slowRun = 0;
  let lastTs = -1;

  const notify = (m) => {
    try {
      onNotice(m);
    } catch {} // a UI callback never breaks the detector
  };
  const closeEngine = (e) => {
    try {
      if (e && typeof e.close === "function") e.close();
    } catch {} // a failing close must not break the page
  };
  function release() {
    if (abortInit) abortInit();
    const w = worker;
    worker = null;
    if (w) {
      w.onmessage = null;
      w.onerror = null;
      try {
        w.postMessage({ type: "close" });
      } catch {}
      try {
        w.terminate();
      } catch {}
    }
    const e = engine;
    engine = null;
    closeEngine(e);
    if (unguard) {
      unguard();
      unguard = null;
    }
    if (pending) settle(null, []);
  }
  function settle(p, value) {
    const cur = p || pending;
    if (!cur) return;
    if (cur.timer !== null) timers.clearTimeout(cur.timer);
    if (pending === cur) pending = null;
    if (cur.resolve) cur.resolve(value);
  }
  function disable(message) {
    if (disabled) return;
    disabled = true;
    reason = message;
    release();
    notify(message);
  }

  // ---- the worker
  function startWorker() {
    let w;
    try {
      w = createWorker();
    } catch {
      return Promise.resolve(false);
    }
    if (!w) return Promise.resolve(false);
    worker = w;
    return new Promise((resolve) => {
      let done = false;
      abortInit = () => finish(false); // close() while it starts: load() answers now, not after initTimeoutMs
      const finish = (ok) => {
        if (done) return;
        done = true;
        abortInit = null;
        timers.clearTimeout(timer);
        if (!ok) {
          const dead = worker;
          worker = null;
          if (dead) {
            dead.onmessage = null;
            dead.onerror = null;
            try {
              dead.terminate();
            } catch {}
          }
        }
        resolve(ok);
      };
      const timer = timers.setTimeout(() => finish(false), o.initTimeoutMs);
      w.onmessage = (e) => {
        const m = e && e.data;
        if (!m || typeof m !== "object") return;
        if (!done) {
          if (m.type === "ready") finish(true);
          else if (m.type === "error") finish(false);
          return;
        }
        onWorkerMessage(m);
      };
      w.onerror = () => {
        if (!done) finish(false);
        else if (!disabled && !closed) disable(MSG_FAILED);
      };
      try {
        w.postMessage({ type: "init", mode, scoreThreshold: o.scoreThreshold, maxResults: o.maxResults });
      } catch {
        finish(false);
      }
    });
  }

  function onWorkerMessage(m) {
    if (!pending || m.seq !== pending.seq) return; // a late answer to a frame we gave up on
    if (m.type === "result") {
      failures = 0;
      if (m.dropped) return settle(null, null);
      const ms = isNum(m.ms) ? m.ms : 0;
      stats.calls++;
      stats.lastMs = ms;
      stats.maxMs = Math.max(stats.maxMs, ms);
      return settle(null, normalise(m, m.width, m.height, o));
    }
    if (m.type === "error") {
      if (++failures >= o.maxFailures) disable(MSG_FAILED);
      return settle(null, []);
    }
    return undefined;
  }

  async function detectInWorker(src, tMs) {
    if (pending) return null; // one at a time: never queue
    const mine = { seq: ++seq, resolve: null, timer: null };
    pending = mine;
    let msg;
    let transfer;
    try {
      const ts = isNum(tMs) ? Math.round(tMs) : 0;
      if (mode === "VIDEO") {
        const bmp = await bitmap(src);
        msg = { type: "detect", seq: mine.seq, ts: Math.max(ts, lastTs + 1), bitmap: bmp };
        lastTs = msg.ts;
        transfer = [bmp];
      } else {
        msg = { type: "detect", seq: mine.seq, ts, buffer: src.data.buffer, width: src.width, height: src.height };
        transfer = [src.data.buffer];
      }
      if (closed || disabled || !worker || pending !== mine) {
        if (msg.bitmap && typeof msg.bitmap.close === "function") msg.bitmap.close();
        if (pending === mine) pending = null;
        return [];
      }
      return await new Promise((resolve) => {
        mine.resolve = resolve;
        mine.timer = timers.setTimeout(() => {
          mine.timer = null;
          disable(MSG_STUCK);
        }, o.detectTimeoutMs);
        worker.postMessage(msg, transfer);
      });
    } catch {
      // postMessage threw (a detached bitmap or buffer): no timer may outlive this frame, and the bitmap is ours to close
      if (mine.timer !== null) timers.clearTimeout(mine.timer);
      mine.timer = null;
      if (msg && msg.bitmap && typeof msg.bitmap.close === "function") msg.bitmap.close();
      if (pending === mine) pending = null;
      if (++failures >= o.maxFailures) disable(MSG_FAILED);
      return [];
    }
  }

  // ---- the main-thread fallback
  async function startMain(workerFailed) {
    // loading MediaPipe on the main thread takes longer than the drive loop's stall limit: never while the Rover may drive
    if (!mayRunOnMain()) {
      if (!closed) disable(MSG_NO_MAIN_NOW);
      return false;
    }
    try {
      if (guardTarget && guardOrigin) unguard = installOffsiteGuard(guardTarget, guardOrigin);
      const e = await loader({ runningMode: mode, delegate: o.delegate, scoreThreshold: o.scoreThreshold, maxResults: o.maxResults });
      if (closed || disabled) {
        closeEngine(e);
        return false;
      }
      engine = e;
      where = "main";
      if (workerFailed) notify(MSG_MAIN);
      return true;
    } catch {
      if (unguard) {
        unguard();
        unguard = null;
      }
      if (!closed) disable(MSG_NO_START); // no internals in the message
      return false;
    }
  }

  function detectOnMain(src, tMs) {
    if (!mayRunOnMain()) return null;
    const t0 = now();
    let result;
    let size;
    try {
      size = prep(src);
      if (mode === "VIDEO") {
        lastTs = Math.max(isNum(tMs) ? Math.round(tMs) : 0, lastTs + 1); // MediaPipe wants strictly increasing times
        result = engine.detectVideo(size.input, lastTs);
      } else result = engine.detectImage(size.input);
    } catch {
      if (++failures >= o.maxFailures) disable(MSG_FAILED);
      return [];
    }
    failures = 0;
    const ms = now() - t0;
    stats.calls++;
    stats.lastMs = ms;
    stats.maxMs = Math.max(stats.maxMs, ms);
    const found = normalise(result, size.width, size.height, o);
    if (ms >= o.slowMs) {
      if (++slowRun >= 2) disable(MSG_SLOW);
    } else slowRun = 0;
    return found;
  }

  // ---- public
  function load() {
    if (closed) return Promise.resolve(false);
    if (!loading) {
      loading = (async () => {
        if (createWorker && (await startWorker())) {
          if (closed || disabled) {
            release();
            return false;
          }
          where = "worker";
          return true;
        }
        if (closed) return false;
        return startMain(!!createWorker);
      })();
    }
    return loading;
  }

  function detect(src, tMs) {
    if (!where || closed || disabled) return Promise.resolve([]);
    if (mode === "VIDEO" ? !isVideo(src) : !isImage(src)) return Promise.resolve([]);
    if (where === "worker") return detectInWorker(src, tMs);
    return Promise.resolve(detectOnMain(src, tMs));
  }

  function close() {
    if (closed) return;
    closed = true;
    release();
  }

  return {
    load,
    detect,
    close,
    stats,
    get ready() {
      return !!where && !closed && !disabled;
    },
    get disabled() {
      return disabled;
    },
    get reason() {
      return reason;
    },
    get mode() {
      return mode;
    },
    get where() {
      return where;
    },
    get busy() {
      return !!pending;
    },
  };
}

/** The XRView of a camera-callback info (ar-view.js passes the viewer pose as `pose`); tests may pass `view` directly. */
export const xrViewOf = (info) => (info && ((info.pose && info.pose.views && info.pose.views[0]) || info.xrView || info.view)) || null;

/**
 * The 2 Hz driver. tick(info) -> Promise<detections | null> | null (null: not due, busy, nothing to look at, disabled).
 * info is what view.onCameraFrame(cb) hands over: { t, video, frame, pose, ... } (tMs is accepted for t). The camera
 * view uses `video`; XR uses a `reader` (xr-camera.js) that turns frame + XRView into 320 px ImageData.
 * The answer comes later (the worker), but an XRFrame is only valid inside its callback, so `capture(info)` runs
 * synchronously in tick and its result (e.g. createXrDepthContext(frame, view), a snapshot) is handed to
 * onDetections(detections, tMs, info, captured). After each answer the next run waits 4x its time (500 ms to 2 s).
 */
export function createLookAround({ detector, reader = null, capture = null, onDetections = null, intervalMs = 500, maxIntervalMs = 2000 } = {}) {
  let last = -Infinity;
  let interval = intervalMs;
  let busy = false;
  return {
    tick(info = {}) {
      const tMs = info.tMs ?? info.t;
      if (busy || !detector || detector.disabled || !detector.ready || !isNum(tMs)) return null;
      if (tMs - last < interval) return null;
      if (reader && reader.disabled) return null;
      const src = reader ? reader.read(info.frame ?? null, xrViewOf(info)) : info.video ?? null;
      if (!src) return null;
      let captured = null;
      if (capture) {
        try {
          captured = capture(info);
        } catch {
          captured = null;
        }
      }
      last = tMs;
      busy = true;
      return Promise.resolve(detector.detect(src, tMs)).then(
        (dets) => {
          busy = false;
          if (dets === null || dets === undefined) return null; // dropped
          const took = detector.stats && isNum(detector.stats.lastMs) ? detector.stats.lastMs : 0;
          interval = Math.min(maxIntervalMs, Math.max(intervalMs, took * 4));
          if (onDetections) {
            try {
              onDetections(dets, tMs, info, captured);
            } catch {} // a UI callback never breaks the look-around loop
          }
          return dets;
        },
        () => {
          busy = false;
          return null;
        },
      );
    },
    get interval() {
      return interval;
    },
    get busy() {
      return busy;
    },
  };
}
