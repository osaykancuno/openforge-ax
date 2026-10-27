// AR Rover, "Look around": the detection worker. A CLASSIC dedicated worker (no import/export): it pulls MediaPipe in
// with importScripts. Why not a module worker: vision_bundle.mjs loads its wasm glue with importScripts (a TypeError in
// module workers) and then falls back to import(), but the glue is a plain script that sets a global ModuleFactory, so
// the fallback fails. vision_bundle.js (the IIFE build, global `Vision`) works.
//
// Files it needs from vendor/mediapipe/ (same origin): vision_bundle.js, wasm/vision_wasm_internal.{js,wasm} (the SIMD
// build only, see scripts/build-web.mjs: without SIMD init fails and the page says object finding is unavailable),
// efficientdet_lite0.tflite.
// Every URL is derived from this file's own location, never from a message.
//
// Protocol (page -> worker)
//   { type: "init", mode: "VIDEO" | "IMAGE", scoreThreshold, maxResults }
//   { type: "detect", seq, ts, bitmap }                       camera view: an ImageBitmap (transferred), mode VIDEO
//   { type: "detect", seq, ts, buffer, width, height }        XR: RGBA pixels (transferred ArrayBuffer), mode IMAGE
//   { type: "close" }
// Protocol (worker -> page)
//   { type: "ready" } | { type: "error", stage: "init" }
//   { type: "result", seq, ms, width, height, detections: [{ categories: [{ categoryName, score }], boundingBox }] }
//   { type: "result", seq, dropped: true }                    a frame arrived while one was running (never queued)
//   { type: "error", stage: "detect", seq }
// The page filters labels again (COCO-80 only); nothing from here is trusted there.
//
// MediaPipe 1.1.1 always starts a usage logger that POSTs to a Google logging endpoint with fetch and has no off switch.
// We never even try: fetch, XMLHttpRequest and importScripts to any other origin are rejected here, locally, before the
// network, and WebSocket, EventSource and sendBeacon are removed (a later MediaPipe could pick another transport).
// Same-origin requests (the wasm, the model) pass. The worker's own CSP header (web/_headers, serve.mjs) is the second layer.
"use strict";

(function () {
  var origin = self.location.origin;
  function sameOrigin(url) {
    try {
      return new URL(typeof url === "string" ? url : url && url.url ? url.url : String(url), self.location.href).origin === origin;
    } catch (e) {
      return false;
    }
  }
  if (typeof self.fetch === "function") {
    var realFetch = self.fetch;
    self.fetch = function (input, init) {
      if (!sameOrigin(input)) return Promise.reject(new TypeError("off-site request blocked"));
      return realFetch.call(self, input, init);
    };
  }
  if (typeof self.importScripts === "function") {
    var realImport = self.importScripts;
    self.importScripts = function () {
      for (var i = 0; i < arguments.length; i++) if (!sameOrigin(arguments[i])) throw new TypeError("off-site request blocked");
      return realImport.apply(self, arguments);
    };
  }
  ["WebSocket", "EventSource"].forEach(function (name) {
    if (name in self) self[name] = function () {
      throw new TypeError("off-site request blocked");
    };
  });
  if (self.navigator && typeof self.navigator.sendBeacon === "function") {
    try {
      Object.defineProperty(self.navigator, "sendBeacon", { value: function () { return false; } });
    } catch (e) {
      /* a read-only navigator: the CSP header still blocks it */
    }
  }
  if (typeof self.XMLHttpRequest === "function" && self.XMLHttpRequest.prototype && self.XMLHttpRequest.prototype.open) {
    var realOpen = self.XMLHttpRequest.prototype.open;
    self.XMLHttpRequest.prototype.open = function (method, url) {
      if (!sameOrigin(url)) throw new TypeError("off-site request blocked");
      return realOpen.apply(this, arguments);
    };
  }

  var detector = null;
  var mode = "IMAGE";
  var busy = false;
  var lastTs = -1;
  var MAX_DETECTIONS = 10;

  function post(message) {
    self.postMessage(message);
  }

  function plain(result) {
    var out = [];
    var list = result && Array.isArray(result.detections) ? result.detections : [];
    for (var i = 0; i < list.length && out.length < MAX_DETECTIONS; i++) {
      var d = list[i];
      var c = d && d.categories && d.categories[0];
      var b = d && d.boundingBox;
      if (!c || !b) continue;
      out.push({
        categories: [{ categoryName: String(c.categoryName), score: Number(c.score) }],
        boundingBox: { originX: b.originX, originY: b.originY, width: b.width, height: b.height },
      });
    }
    return out;
  }

  async function init(msg) {
    try {
      mode = msg.mode === "VIDEO" ? "VIDEO" : "IMAGE";
      importScripts(new URL("../../../vendor/mediapipe/vision_bundle.js", self.location.href).href);
      var V = self.Vision;
      var fileset = await V.FilesetResolver.forVisionTasks(new URL("../../../vendor/mediapipe/wasm", self.location.href).href);
      detector = await V.ObjectDetector.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: new URL("../../../vendor/mediapipe/efficientdet_lite0.tflite", self.location.href).href, delegate: "CPU" },
        runningMode: mode,
        scoreThreshold: Number.isFinite(msg.scoreThreshold) ? msg.scoreThreshold : 0.5,
        maxResults: Number.isFinite(msg.maxResults) ? msg.maxResults : 5,
      });
      post({ type: "ready" });
    } catch (e) {
      post({ type: "error", stage: "init" });
    }
  }

  function detect(msg) {
    var bitmap = msg.bitmap || null;
    try {
      if (!detector || busy) return post({ type: "result", seq: msg.seq, dropped: true });
      busy = true;
      var t0 = self.performance.now();
      var input;
      var w;
      var h;
      if (bitmap) {
        input = bitmap;
        w = bitmap.width;
        h = bitmap.height;
      } else {
        w = msg.width;
        h = msg.height;
        input = new ImageData(new Uint8ClampedArray(msg.buffer), w, h);
      }
      var result;
      if (mode === "VIDEO") {
        lastTs = Math.max(Math.round(Number(msg.ts) || 0), lastTs + 1); // strictly increasing, as MediaPipe wants
        result = detector.detectForVideo(input, lastTs);
      } else result = detector.detect(input);
      post({ type: "result", seq: msg.seq, ms: self.performance.now() - t0, width: w, height: h, detections: plain(result) });
    } catch (e) {
      post({ type: "error", stage: "detect", seq: msg.seq });
    } finally {
      busy = false;
      if (bitmap && typeof bitmap.close === "function") bitmap.close();
    }
  }

  self.onmessage = function (event) {
    var msg = event && event.data;
    if (!msg || typeof msg !== "object") return;
    if (msg.type === "init") init(msg);
    else if (msg.type === "detect") detect(msg);
    else if (msg.type === "close") {
      try {
        if (detector) detector.close();
      } catch (e) {
        /* closing twice or a half-made detector: nothing to do */
      }
      detector = null;
      self.close();
    }
  };
})();
