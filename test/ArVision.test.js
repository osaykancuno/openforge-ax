const { expect } = require("chai");
const fs = require("node:fs");
const path = require("node:path");

// AR Rover, phase 2 "Look around": object detection (detector.js, xr-camera.js), the world model (world-objects.js),
// the voice intents (vision-intents.js) and the bounded re-planning (seek.js). All pure or injectable: no MediaPipe, no
// browser, no WebGL here. What needs a real phone is listed in the report of the builder, not tested here.
describe("AR vision: objects, intents, seek", () => {
  let W, DET, XRC, VI, SK, G, T, P, D, TT, AP;
  before(async () => {
    W = await import("../web/js/ar/vision/world-objects.js");
    DET = await import("../web/js/ar/vision/detector.js");
    XRC = await import("../web/js/ar/vision/xr-camera.js");
    VI = await import("../web/js/ar/vision/vision-intents.js");
    SK = await import("../web/js/ar/seek.js");
    G = await import("../web/js/pilot/ai/grammar.js");
    T = await import("../web/js/pilot/ai/tools.js");
    P = await import("../web/js/pilot/ax-proto.js");
    D = await import("../web/js/pilot/drive-loop.js");
    TT = await import("../web/js/pilot/twin-transport.js");
    AP = await import("../web/js/pilot/ai/ai-pilot.js");
  });

  // ---------------------------------------------------------------- helpers
  /** Fake depth camera: u = 0.5 is straight ahead, u < 0.5 is to the right of the picture's centre... x is LEFT positive. */
  const unproject = (u, v, d) => ({ x: (0.5 - u) * d * 1.2, y: 0.1, z: d });
  const depthCtx = (d) => ({ getDepth: () => d, unproject });
  const det = (label, u = 0.5, score = 0.9) => ({ label, score, box: { x: u - 0.1, y: 0.4, w: 0.2, h: 0.2 } });
  const ORIGIN = { x: 0, z: 0, yaw: 0 };

  // ---------------------------------------------------------------- labels
  describe("COCO labels (untrusted input)", () => {
    it("the list has the 80 COCO classes, unique, lower case", () => {
      expect(W.COCO80).to.have.length(80);
      expect(new Set(W.COCO80).size).to.equal(80);
      for (const l of W.COCO80) expect(l).to.match(/^[a-z]+( [a-z]+)*$/);
      expect(W.COCO80).to.include.members(["person", "cup", "cell phone", "couch", "tv", "dining table", "potted plant", "teddy bear"]);
    });

    it("accepts a COCO label, its aliases, case and one plural; nothing else", () => {
      const ok = { cup: "cup", Cup: "cup", " CUP ": "cup", mug: "cup", phone: "cell phone", "cell phone": "cell phone", sofa: "couch", tv: "tv", television: "tv", chairs: "chair", person: "person", "Dining Table": "dining table" };
      for (const [raw, want] of Object.entries(ok)) expect(W.canonicalLabel(raw), raw).to.equal(want);
      const bad = ["", "unicorn", "<img src=x>", "cup<script>", "cup;drop", "constructor", "__proto__", "toString", "hasOwnProperty", "cup‮gnp", "c​up", "a".repeat(500), null, undefined, 5, {}, [], ["cup"], "cup cup", "the cup"];
      for (const raw of bad) expect(W.canonicalLabel(raw), String(raw).slice(0, 20)).to.equal(null);
    });

    it("display names read well", () => {
      expect(W.displayName("tv")).to.equal("TV");
      expect(W.withArticle("cup")).to.equal("a cup");
      expect(W.withArticle("umbrella")).to.equal("an umbrella");
      expect(W.withArticle("tv")).to.equal("a TV");
      expect(W.withArticle("person")).to.equal("a person");
    });
  });

  // ---------------------------------------------------------------- geometry
  describe("rover frame", () => {
    it("direction words from the bearing (positive = left)", () => {
      const cases = [[0, "ahead"], [20, "ahead"], [45, "ahead-left"], [-45, "ahead-right"], [90, "left"], [-90, "right"], [135, "behind-left"], [-135, "behind-right"], [180, "behind"], [-180, "behind"], [200, "behind-right"]];
      for (const [b, w] of cases) expect(W.directionWord(b), String(b)).to.equal(w);
    });

    it("distances are rounded the way a person says them", () => {
      expect(W.distanceText(1.23)).to.equal("about 1.2 m");
      expect(W.distanceText(2.0)).to.equal("about 2 m");
      expect(W.distanceText(0.34)).to.equal("about 30 cm");
      expect(W.distanceText(0.36)).to.equal("about 40 cm");
      expect(W.distanceText(0.96)).to.equal("about 1 m");
      expect(W.whereText({ bearingDeg: 45, distanceM: 1.23 })).to.equal("about 1.2 m ahead-left");
      expect(W.whereText({ bearingDeg: 0, distanceM: null })).to.equal("ahead");
    });

    it("toRoverFrame: left is +X and +yaw, bearing and distance follow the rover heading", () => {
      const a = W.toRoverFrame({ x: 0, z: 2 }, ORIGIN);
      expect(a.bearingDeg).to.be.closeTo(0, 1e-9);
      expect(a.distanceM).to.be.closeTo(2, 1e-9);
      expect(W.toRoverFrame({ x: 1, z: 1 }, ORIGIN).bearingDeg).to.be.closeTo(45, 1e-9);
      expect(W.toRoverFrame({ x: -1, z: 0 }, ORIGIN).bearingDeg).to.be.closeTo(-90, 1e-9);
      expect(Math.abs(W.toRoverFrame({ x: 0, z: -1 }, ORIGIN).bearingDeg)).to.be.closeTo(180, 1e-9);
      // the rover faces +X (yaw 90 degrees, left of +Z): a thing on +X is straight ahead
      const b = W.toRoverFrame({ x: 2, z: 0 }, { x: 0, z: 0, yaw: Math.PI / 2 });
      expect(b.bearingDeg).to.be.closeTo(0, 1e-9);
      // a moved rover
      const c = W.toRoverFrame({ x: 1, z: 3 }, { x: 1, z: 1, yaw: 0 });
      expect(c.distanceM).to.be.closeTo(2, 1e-9);
      expect(c.bearingDeg).to.be.closeTo(0, 1e-9);
      // bad input never throws
      expect(W.toRoverFrame(null, ORIGIN)).to.equal(null);
      expect(W.toRoverFrame({ x: NaN, z: 1 }, ORIGIN)).to.equal(null);
    });

    it("camera bearing from the box centre: left of the picture is left", () => {
      expect(W.cameraBearingDeg({ x: 0.4, y: 0, w: 0.2, h: 1 }, 60)).to.be.closeTo(0, 1e-9);
      expect(W.cameraBearingDeg({ x: 0, y: 0, w: 0.2, h: 1 }, 60)).to.be.greaterThan(15);
      expect(W.cameraBearingDeg({ x: 0.8, y: 0, w: 0.2, h: 1 }, 60)).to.be.lessThan(-15);
      expect(W.cameraBearingDeg({ x: 0, y: 0, w: 1, h: 1 }, 60)).to.be.closeTo(0, 1e-9);
    });

    it("boxToPoint: median of valid depths, unprojected; holes and far readings are ignored", () => {
      const p = W.boxToPoint({ x: 0.4, y: 0.4, w: 0.2, h: 0.2 }, depthCtx(1.5));
      expect(p.x).to.be.closeTo(0, 1e-9);
      expect(p.z).to.be.closeTo(1.5, 1e-9);
      let n = 0;
      const noisy = { getDepth: () => [0, NaN, 1.0, 9.0, 1.2][n++ % 5], unproject };
      const q = W.boxToPoint({ x: 0.4, y: 0.4, w: 0.2, h: 0.2 }, noisy);
      expect(q.z).to.be.closeTo(1.1, 1e-9); // median of the two valid readings
      expect(W.boxToPoint({ x: 0.4, y: 0.4, w: 0.2, h: 0.2 }, { getDepth: () => 0, unproject })).to.equal(null);
      expect(W.boxToPoint({ x: 0.4, y: 0.4, w: 0.2, h: 0.2 }, { getDepth: () => null, unproject })).to.equal(null);
      expect(W.boxToPoint({ x: 0.4, y: 0.4, w: 0.2, h: 0.2 }, {})).to.equal(null);
      expect(W.boxToPoint({ x: NaN, y: 0, w: 1, h: 1 }, depthCtx(1))).to.equal(null);
      // an unproject that returns an array is accepted too
      const r = W.boxToPoint({ x: 0.4, y: 0.4, w: 0.2, h: 0.2 }, { getDepth: () => 2, unproject: (u, v, d) => [1, 0.2, d] });
      expect(r).to.include({ x: 1, z: 2 });
    });

    it("keep-out zones: a corridor that crosses a disc reports the distance from the front", () => {
      const zones = [{ x: 0, z: 0.5, r: 0.3, label: "chair" }];
      const hit = W.zoneHit(zones, ORIGIN);
      expect(hit.hit).to.equal(true);
      expect(hit.distanceM).to.be.within(0.1, 0.45);
      expect(hit.label).to.equal("chair");
      expect(W.zoneHit(zones, { x: 0, z: 0, yaw: Math.PI / 2 }).hit).to.equal(false); // facing away
      expect(W.zoneHit([{ x: 1, z: 0.5, r: 0.3 }], ORIGIN).hit).to.equal(false); // beside the corridor
      expect(W.zoneHit([{ x: 0, z: 3, r: 0.3 }], ORIGIN).hit).to.equal(false); // beyond the look-ahead
      expect(W.zoneHit([], ORIGIN).hit).to.equal(false);
      expect(W.KEEP_OUT_M).to.equal(0.3);
    });
  });

  // ---------------------------------------------------------------- world model
  describe("world objects", () => {
    it("keeps only COCO detections and caps what it reads per frame", () => {
      const w = W.createWorldObjects();
      w.update([det("cup"), det("<b>x</b>"), det("unicorn"), { label: "chair", score: "high", box: {} }, null, 5], 0, depthCtx(1));
      expect(w.list(0).map((o) => o.label)).to.deep.equal(["cup"]);
      const many = Array.from({ length: 200 }, (_, i) => det("cup", (i % 9) / 10 + 0.05));
      w.update(many, 10, depthCtx(1));
      expect(w.list(10).length).to.be.at.most(16);
    });

    it("locates a detection in the world with depth; without depth it keeps only a camera bearing", () => {
      const w = W.createWorldObjects();
      w.update([det("cup", 0.5)], 0, depthCtx(1.5));
      const o = w.find("cup", 0);
      expect(o.located).to.equal(true);
      expect(o.x).to.be.closeTo(0, 1e-9);
      expect(o.z).to.be.closeTo(1.5, 1e-9);
      const n = W.createWorldObjects();
      n.update([det("chair", 0.1)], 0, { hfovDeg: 60 });
      const c = n.find("chair", 0);
      expect(c.located).to.equal(false);
      expect(c.bearingCam).to.be.greaterThan(10);
    });

    it("smooths a repeated detection and keeps one object per thing", () => {
      const w = W.createWorldObjects({ alpha: 0.5 });
      w.update([det("cup", 0.5)], 0, depthCtx(1.0));
      w.update([det("cup", 0.5)], 500, depthCtx(1.2));
      const list = w.list(500);
      expect(list).to.have.length(1);
      expect(list[0].z).to.be.closeTo(1.1, 1e-9);
      // a second cup far away is another object
      w.update([det("cup", 0.5)], 900, depthCtx(3.0));
      expect(w.list(900)).to.have.length(2);
    });

    it("objects expire after 2 s without a sighting, and a sighting renews them", () => {
      const w = W.createWorldObjects();
      w.update([det("cup")], 1000, depthCtx(1));
      expect(w.find("cup", 2999)).to.not.equal(null);
      expect(w.find("cup", 3001)).to.equal(null);
      expect(w.list(3001)).to.deep.equal([]);
      w.update([det("cup")], 1000, depthCtx(1));
      w.update([det("cup")], 2500, depthCtx(1));
      expect(w.find("cup", 4400)).to.not.equal(null);
    });

    it("find() takes the label as the user said it, picks the nearest to the rover, and refuses garbage", () => {
      const w = W.createWorldObjects();
      w.update([det("cup", 0.5)], 0, depthCtx(3));
      w.update([det("cup", 0.5)], 1, depthCtx(1));
      expect(w.find("mug", 1, ORIGIN).z).to.be.closeTo(1, 1e-9);
      expect(w.find("<img>", 1)).to.equal(null);
      expect(w.find("chair", 1)).to.equal(null);
      w.clear();
      expect(w.list(1)).to.deep.equal([]);
    });

    it("describeObject: rover frame when located, camera bearing when not", () => {
      const w = W.createWorldObjects();
      w.update([det("cup", 0.5)], 0, depthCtx(2));
      w.update([det("chair", 0.1)], 0, { hfovDeg: 60 });
      const cup = W.describeObject(w.find("cup", 0), ORIGIN);
      expect(cup.distanceM).to.be.closeTo(2, 1e-9);
      const chair = W.describeObject(w.find("chair", 0), ORIGIN);
      expect(chair.distanceM).to.equal(null);
      expect(chair.bearingDeg).to.be.greaterThan(10);
    });

    it("view labels are plain text of canonical names at the object", () => {
      const w = W.createWorldObjects();
      w.update([det("cup", 0.5), det("chair", 0.1)], 0, depthCtx(1));
      w.update([det("tv", 0.9)], 0, { hfovDeg: 60 });
      const labels = W.toViewLabels(w.list(0));
      expect(labels.map((l) => l.text).sort()).to.deep.equal(["chair", "cup"]); // the unlocated one has no place in the room
      for (const l of labels) {
        expect(l).to.have.all.keys("id", "text", "x", "y", "z");
        expect(l.text).to.match(/^[a-z ]+$/);
        for (const k of ["x", "y", "z"]) expect(Number.isFinite(l[k])).to.equal(true);
      }
    });
  });

  // ---------------------------------------------------------------- detector
  describe("detector (main-thread fallback engine, injected loader)", () => {
    const mp = (name, score, ox, oy, w, h) => ({ categories: [{ categoryName: name, score }], boundingBox: { originX: ox, originY: oy, width: w, height: h } });
    const video = { videoWidth: 640, videoHeight: 480, readyState: 4 };
    const imageData = { width: 320, height: 240, data: new Uint8ClampedArray(4) };
    const vprep = (s) => ({ input: s, width: s.videoWidth || 640, height: s.videoHeight || 480 });
    function engine(results) {
      const e = { calls: [], closed: 0 };
      e.detectVideo = (src, t) => (e.calls.push(["video", t]), typeof results === "function" ? results() : results);
      e.detectImage = (src) => (e.calls.push(["image"]), typeof results === "function" ? results() : results);
      e.close = () => e.closed++;
      return e;
    }
    const loaderFor = (e, seen = []) => async (opts) => (seen.push(opts), e);
    const main = (extra = {}) => DET.createDetector({ createWorker: null, prepare: vprep, ...extra });

    it("detect() is empty until load(); load() runs the loader once with CPU and the mode", async () => {
      const e = engine({ detections: [mp("cup", 0.8, 64, 48, 128, 96)] });
      const seen = [];
      const d = main({ mode: "VIDEO", loader: loaderFor(e, seen) });
      expect(d.ready).to.equal(false);
      expect(await d.detect(video, 0)).to.deep.equal([]);
      expect(e.calls).to.have.length(0);
      expect(await d.load()).to.equal(true);
      expect(await d.load()).to.equal(true);
      expect(seen).to.have.length(1);
      expect(seen[0]).to.include({ delegate: "CPU", runningMode: "VIDEO", maxResults: 5 });
      expect(seen[0].scoreThreshold).to.be.within(0.4, 0.6);
      expect(d.ready).to.equal(true);
      expect(d.where).to.equal("main");
    });

    it("normalises boxes to 0..1, keeps COCO labels above the threshold, at most 5", async () => {
      const e = engine({
        detections: [
          mp("cup", 0.8, 64, 48, 128, 96),
          mp("Cell Phone", 0.7, 0, 0, 640, 480),
          mp("unicorn", 0.99, 0, 0, 10, 10),
          mp("<img src=x>", 0.99, 0, 0, 10, 10),
          mp("chair", 0.2, 0, 0, 10, 10),
          mp("person", 0.9, NaN, 0, 10, 10),
          { categories: [], boundingBox: { originX: 0, originY: 0, width: 1, height: 1 } },
          { categories: [{ categoryName: "bed", score: 0.9 }] },
          mp("tv", 0.6, -50, -50, 100, 100),
          mp("book", 0.6, 600, 400, 200, 200),
        ],
      });
      const d = main({ mode: "VIDEO", loader: loaderFor(e) });
      await d.load();
      const out = await d.detect(video, 100);
      expect(out.map((x) => x.label)).to.deep.equal(["cup", "cell phone", "tv", "book"]);
      expect(out[0].box).to.deep.equal({ x: 0.1, y: 0.1, w: 0.2, h: 0.2 });
      expect(out[0].score).to.equal(0.8);
      for (const x of out) {
        expect(x.box.x).to.be.within(0, 1);
        expect(x.box.y).to.be.within(0, 1);
        expect(x.box.x + x.box.w).to.be.at.most(1 + 1e-9);
        expect(x.box.y + x.box.h).to.be.at.most(1 + 1e-9);
      }
      const many = engine({ detections: Array.from({ length: 12 }, (_, i) => mp("cup", 0.9, i * 10, 0, 5, 5)) });
      const d2 = main({ mode: "VIDEO", loader: loaderFor(many) });
      await d2.load();
      expect(await d2.detect(video, 0)).to.have.length(5);
    });

    it("video timestamps strictly increase even when the caller repeats one", async () => {
      const e = engine({ detections: [] });
      const d = main({ mode: "VIDEO", loader: loaderFor(e) });
      await d.load();
      await d.detect(video, 100);
      await d.detect(video, 100);
      await d.detect(video, 50);
      const ts = e.calls.map((c) => c[1]);
      expect(ts[1]).to.be.greaterThan(ts[0]);
      expect(ts[2]).to.be.greaterThan(ts[1]);
    });

    it("IMAGE mode reads ImageData; a source of the wrong kind gives nothing", async () => {
      const e = engine({ detections: [mp("cup", 0.8, 32, 24, 64, 48)] });
      const d = DET.createDetector({ mode: "IMAGE", createWorker: null, loader: loaderFor(e) });
      await d.load();
      const out = await d.detect(imageData, 0);
      expect(out[0].box).to.deep.equal({ x: 0.1, y: 0.1, w: 0.2, h: 0.2 });
      expect(await d.detect(video, 0)).to.deep.equal([]);
      expect(await d.detect(null, 0)).to.deep.equal([]);
      expect(await d.detect({}, 0)).to.deep.equal([]);
      const v = main({ mode: "VIDEO", loader: loaderFor(engine({ detections: [] })) });
      await v.load();
      expect(await v.detect(imageData, 0)).to.deep.equal([]);
    });

    it("an engine that throws never rejects; three failures turn it off with one notice", async () => {
      const e = engine(() => {
        throw new Error("boom");
      });
      const notices = [];
      const d = main({ mode: "VIDEO", loader: loaderFor(e), onNotice: (m) => notices.push(m) });
      await d.load();
      for (let i = 0; i < 5; i++) expect(await d.detect(video, i * 500)).to.deep.equal([]);
      expect(d.disabled).to.equal(true);
      expect(e.calls).to.have.length(3);
      expect(notices).to.have.length(1);
      expect(notices[0]).to.match(/object finding/i);
    });

    it("a loader that fails leaves a disabled detector and one notice, never an exception", async () => {
      const notices = [];
      const d = main({ mode: "VIDEO", loader: async () => { throw new Error("no wasm"); }, onNotice: (m) => notices.push(m) });
      expect(await d.load()).to.equal(false);
      expect(d.disabled).to.equal(true);
      expect(await d.detect(video, 0)).to.deep.equal([]);
      expect(notices).to.have.length(1);
      expect(notices[0]).to.not.match(/no wasm/); // internals are not shown
    });

    it("two calls over 250 ms (the drive loop stalls at 283 ms) turn Look around off to keep driving safe", async () => {
      let t = 0;
      const e = engine({ detections: [] });
      const notices = [];
      e.detectVideo = () => ((t += 300), { detections: [] });
      const d = main({ mode: "VIDEO", loader: loaderFor(e), now: () => t, onNotice: (m) => notices.push(m) });
      await d.load();
      await d.detect(video, 0);
      expect(d.disabled).to.equal(false);
      await d.detect(video, 600);
      expect(d.disabled).to.equal(true);
      expect(notices[0]).to.match(/too slow/i);
      expect(d.stats.maxMs).to.be.at.least(300);
      // a single slow call followed by a fast one is forgiven
      t = 0;
      let slow = true;
      e.detectVideo = () => ((t += slow ? 300 : 40), { detections: [] });
      const d2 = main({ mode: "VIDEO", loader: loaderFor(e), now: () => t });
      await d2.load();
      await d2.detect(video, 0);
      slow = false;
      await d2.detect(video, 600);
      slow = true;
      await d2.detect(video, 1200);
      expect(d2.disabled).to.equal(false);
    });

    it("close() releases the engine once and detect() then returns nothing", async () => {
      const e = engine({ detections: [mp("cup", 0.9, 0, 0, 10, 10)] });
      const d = main({ mode: "VIDEO", loader: loaderFor(e) });
      await d.load();
      d.close();
      d.close();
      expect(e.closed).to.equal(1);
      expect(await d.detect(video, 0)).to.deep.equal([]);
      expect(await d.load()).to.equal(false);
    });

    it("close() while the loader is still running closes the engine as soon as it arrives", async () => {
      const e = engine({ detections: [] });
      let release;
      const d = main({ mode: "VIDEO", loader: () => new Promise((r) => (release = () => r(e))) });
      const p = d.load();
      d.close();
      release();
      expect(await p).to.equal(false);
      expect(e.closed).to.equal(1);
    });
  });

  describe("detector in a Web Worker (fake Worker)", () => {
    const mp = (name, score, ox, oy, w, h) => ({ categories: [{ categoryName: name, score }], boundingBox: { originX: ox, originY: oy, width: w, height: h } });
    const video = { videoWidth: 640, videoHeight: 480, readyState: 4 };
    const pixels = () => ({ width: 320, height: 240, data: new Uint8ClampedArray(320 * 240 * 4) });
    const flush = () => new Promise((r) => setImmediate(r));

    /** A fake Worker. reply: "auto" answers every detect, "manual" waits for w.emit(...), init: "ready" | "error" | "silent". */
    function fakeWorkers({ init = "ready", reply = "auto", ms = 40, dets = [mp("cup", 0.8, 32, 24, 64, 48)] } = {}) {
      const log = { created: 0, posts: [], terminated: 0, worker: null };
      const create = () => {
        log.created++;
        const w = {
          onmessage: null,
          onerror: null,
          postMessage(msg, transfer) {
            log.posts.push({ msg, transfer });
            if (msg.type === "init" && init !== "silent") queueMicrotask(() => w.emit(init === "ready" ? { type: "ready" } : { type: "error", stage: "init" }));
            if (msg.type === "detect" && reply === "auto") queueMicrotask(() => w.emit({ type: "result", seq: msg.seq, ms, width: 320, height: 240, detections: dets }));
          },
          terminate() {
            log.terminated++;
          },
          emit(data) {
            if (w.onmessage) w.onmessage({ data });
          },
        };
        log.worker = w;
        return w;
      };
      return { create, log };
    }
    /** Timers the test fires by hand. */
    function fakeTimers() {
      const t = { list: [], setTimeout: (fn, ms) => (t.list.push({ fn, ms, live: true }), t.list[t.list.length - 1]), clearTimeout: (h) => h && (h.live = false) };
      t.fire = (ms) => t.list.filter((h) => h.live && h.ms === ms).forEach((h) => ((h.live = false), h.fn()));
      return t;
    }
    const bitmapFor = () => {
      const b = { id: "bmp", closed: 0, close() { b.closed++; } };
      return b;
    };
    const mk = (fw, extra = {}) => DET.createDetector({ createWorker: fw.create, ...extra });

    it("starts the worker with the options, never touches the main-thread loader, reports where", async () => {
      const fw = fakeWorkers();
      let loaded = 0;
      const d = mk(fw, { mode: "VIDEO", loader: async () => (loaded++, {}) });
      expect(await d.load()).to.equal(true);
      expect(await d.load()).to.equal(true);
      expect(fw.log.created).to.equal(1);
      expect(loaded).to.equal(0);
      expect(fw.log.posts[0].msg).to.include({ type: "init", mode: "VIDEO", maxResults: 5 });
      expect(fw.log.posts[0].msg.scoreThreshold).to.be.within(0.4, 0.6);
      expect(d.where).to.equal("worker");
      expect(d.ready).to.equal(true);
    });

    it("camera view: an ImageBitmap is transferred, the answer is normalised and COCO-filtered", async () => {
      const bmp = bitmapFor();
      const fw = fakeWorkers({ dets: [mp("cup", 0.8, 32, 24, 64, 48), mp("unicorn", 0.9, 0, 0, 5, 5), mp("<img>", 0.9, 0, 0, 5, 5), mp("chair", 0.1, 0, 0, 5, 5)] });
      const d = mk(fw, { mode: "VIDEO", makeBitmap: async (v) => (expect(v).to.equal(video), bmp) });
      await d.load();
      const out = await d.detect(video, 1000);
      expect(out.map((x) => x.label)).to.deep.equal(["cup"]);
      expect(out[0].box).to.deep.equal({ x: 0.1, y: 0.1, w: 0.2, h: 0.2 });
      const sent = fw.log.posts[1];
      expect(sent.msg).to.include({ type: "detect", ts: 1000 });
      expect(sent.msg.bitmap).to.equal(bmp);
      expect(sent.transfer).to.deep.equal([bmp]);
      expect(d.stats.lastMs).to.equal(40);
      expect(d.stats.calls).to.equal(1);
      await d.detect(video, 1000);
      expect(fw.log.posts[2].msg.ts).to.be.greaterThan(1000); // strictly increasing
    });

    it("XR: the pixel buffer is transferred with its size", async () => {
      const fw = fakeWorkers();
      const d = mk(fw, { mode: "IMAGE" });
      await d.load();
      const img = pixels();
      const out = await d.detect(img, 0);
      expect(out).to.have.length(1);
      const sent = fw.log.posts[1];
      expect(sent.msg).to.include({ type: "detect", width: 320, height: 240 });
      expect(sent.msg.buffer).to.equal(img.data.buffer);
      expect(sent.transfer).to.deep.equal([img.data.buffer]);
    });

    it("one frame at a time: a frame that arrives while one is in flight is dropped, not queued", async () => {
      const fw = fakeWorkers({ reply: "manual" });
      const d = mk(fw, { mode: "IMAGE" });
      await d.load();
      const first = d.detect(pixels(), 0);
      expect(d.busy).to.equal(true);
      expect(await d.detect(pixels(), 10)).to.equal(null);
      expect(await d.detect(pixels(), 20)).to.equal(null);
      expect(fw.log.posts.filter((p) => p.msg.type === "detect")).to.have.length(1);
      fw.log.worker.emit({ type: "result", seq: fw.log.posts[1].msg.seq, ms: 5, width: 320, height: 240, detections: [mp("cup", 0.9, 0, 0, 32, 24)] });
      expect(await first).to.have.length(1);
      expect(d.busy).to.equal(false);
      const next = d.detect(pixels(), 30);
      expect(fw.log.posts.filter((p) => p.msg.type === "detect")).to.have.length(2);
      fw.log.worker.emit({ type: "result", seq: fw.log.posts[2].msg.seq, dropped: true });
      expect(await next).to.equal(null); // the worker was busy: its drop is a drop here too
    });

    it("in a dark frame the bar drops to NIGHT_SCORE; in a normal one it stays (a 0.45 cup counts only at night)", async () => {
      expect(DET.NIGHT_SCORE).to.equal(0.4);
      const fw = fakeWorkers({ reply: "manual" });
      const d = mk(fw, { mode: "IMAGE" });
      await d.load();
      expect(fw.log.posts[0].msg.scoreThreshold).to.equal(0.4); // the worker uses the lower bar, the page applies the real one
      const ask = async (light) => {
        const p = d.detect(pixels(), 0);
        await flush();
        const seq = fw.log.posts[fw.log.posts.length - 1].msg.seq;
        fw.log.worker.emit({ type: "result", seq, ms: 30, width: 320, height: 240, light, detections: [mp("cup", 0.45, 32, 24, 64, 48)] });
        return (await p).map((x) => x.label);
      };
      expect(await ask(0.1)).to.deep.equal(["cup"]);
      expect(d.stats.light).to.equal(0.1);
      expect(await ask(0.5)).to.deep.equal([]);
      expect(await ask(-1)).to.deep.equal([]); // unknown light: the normal bar
    });

    it("an answer for a frame we gave up on is ignored", async () => {
      const fw = fakeWorkers({ reply: "manual" });
      const timers = fakeTimers();
      const d = mk(fw, { mode: "IMAGE", timers });
      await d.load();
      const p = d.detect(pixels(), 0);
      fw.log.worker.emit({ type: "result", seq: 9999, ms: 1, width: 1, height: 1, detections: [mp("cup", 0.9, 0, 0, 1, 1)] });
      expect(d.busy).to.equal(true);
      fw.log.worker.emit({ type: "result", seq: fw.log.posts[1].msg.seq, ms: 1, width: 320, height: 240, detections: [] });
      expect(await p).to.deep.equal([]);
    });

    it("a worker that stops answering turns detection off, terminates it and says so once", async () => {
      const fw = fakeWorkers({ reply: "manual" });
      const timers = fakeTimers();
      const notices = [];
      const d = mk(fw, { mode: "IMAGE", timers, onNotice: (m) => notices.push(m) });
      await d.load();
      const p = d.detect(pixels(), 0);
      timers.fire(5000);
      expect(await p).to.deep.equal([]);
      expect(d.disabled).to.equal(true);
      expect(fw.log.terminated).to.be.at.least(1);
      expect(notices).to.have.length(1);
      expect(notices[0]).to.match(/stopped answering/);
      expect(await d.detect(pixels(), 1)).to.deep.equal([]);
    });

    it("detect errors from the worker: [] each time, off after three, one notice", async () => {
      const fw = fakeWorkers({ reply: "manual" });
      const notices = [];
      const d = mk(fw, { mode: "IMAGE", onNotice: (m) => notices.push(m) });
      await d.load();
      for (let i = 0; i < 3; i++) {
        const p = d.detect(pixels(), i);
        fw.log.worker.emit({ type: "error", stage: "detect", seq: fw.log.posts[fw.log.posts.length - 1].msg.seq });
        expect(await p).to.deep.equal([]);
      }
      expect(d.disabled).to.equal(true);
      expect(notices).to.have.length(1);
      expect(fw.log.terminated).to.be.at.least(1);
    });

    it("a runtime error event after start turns it off", async () => {
      const fw = fakeWorkers();
      const notices = [];
      const d = mk(fw, { mode: "IMAGE", onNotice: (m) => notices.push(m) });
      await d.load();
      fw.log.worker.onerror({ message: "x" });
      expect(d.disabled).to.equal(true);
      expect(notices).to.have.length(1);
    });

    it("close() tells the worker to close, terminates it, and settles a frame in flight", async () => {
      const fw = fakeWorkers({ reply: "manual" });
      const d = mk(fw, { mode: "IMAGE" });
      await d.load();
      const p = d.detect(pixels(), 0);
      d.close();
      d.close();
      expect(await p).to.deep.equal([]);
      expect(fw.log.posts.some((x) => x.msg.type === "close")).to.equal(true);
      expect(fw.log.terminated).to.equal(1);
      expect(await d.detect(pixels(), 1)).to.deep.equal([]);
      expect(await d.load()).to.equal(false);
    });

    it("close() during the bitmap wait drops the frame and closes the bitmap", async () => {
      const fw = fakeWorkers({ reply: "manual" });
      const bmp = bitmapFor();
      let release;
      const d = mk(fw, { mode: "VIDEO", makeBitmap: () => new Promise((r) => (release = () => r(bmp))) });
      await d.load();
      const p = d.detect(video, 0);
      d.close();
      release();
      expect(await p).to.deep.equal([]);
      expect(bmp.closed).to.equal(1);
      expect(fw.log.posts.filter((x) => x.msg.type === "detect")).to.have.length(0);
    });

    it("worker cannot start (error, silence, or the constructor throws): falls back to the main thread, with a notice, only when allowed", async () => {
      const e = { calls: 0, closed: 0, detectVideo: () => (e.calls++, { detections: [mp("cup", 0.9, 64, 48, 128, 96)] }), detectImage: () => (e.calls++, { detections: [mp("cup", 0.9, 64, 48, 128, 96)] }), close: () => e.closed++ };
      const videoPrep = (s) => ({ input: s, width: 640, height: 480 });
      for (const how of ["error", "silent", "throws"]) {
        e.calls = 0;
        const fw = fakeWorkers({ init: how === "throws" ? "ready" : how });
        const timers = fakeTimers();
        const notices = [];
        let allowed = true; // loading on the main thread is allowed only while the Rover cannot drive
        const d = DET.createDetector({
          mode: "VIDEO",
          createWorker: how === "throws" ? () => { throw new Error("no worker"); } : fw.create,
          loader: async () => e,
          prepare: videoPrep,
          mayRunOnMain: () => allowed,
          timers,
          onNotice: (m) => notices.push(m),
          guardTarget: null,
        });
        const p = d.load();
        if (how === "silent") {
          await flush();
          timers.fire(90000);
        }
        expect(await p, how).to.equal(true);
        expect(d.where, how).to.equal("main");
        if (how !== "throws") expect(fw.log.terminated, how).to.equal(1);
        expect(notices, how).to.have.length(1);
        expect(notices[0], how).to.match(/not driving|only looks/);
        allowed = false;
        expect(await d.detect(video, 0), how).to.equal(null); // not allowed right now: the frame is dropped, the engine untouched
        expect(e.calls, how).to.equal(0);
        allowed = true;
        expect((await d.detect(video, 600)).map((x) => x.label), how).to.deep.equal(["cup"]);
        d.close();
      }
    });

    it("the main-thread fallback never even loads while the Rover may drive (the load would stall the drive loop)", async () => {
      const fw = fakeWorkers({ init: "error" });
      const notices = [];
      let loaded = 0;
      const d = mk(fw, { mode: "VIDEO", loader: async () => (loaded++, {}), mayRunOnMain: () => false, onNotice: (m) => notices.push(m), guardTarget: null });
      expect(await d.load()).to.equal(false);
      expect(loaded).to.equal(0);
      expect(d.disabled).to.equal(true);
      expect(notices).to.have.length(1);
      expect(notices[0]).to.match(/Press STOP/);
    });

    it("a postMessage that throws: [] for that frame, no orphan timer, the bitmap closed, the detector still works", async () => {
      const fw = fakeWorkers();
      const timers = fakeTimers();
      const bmps = [];
      const d = mk(fw, { mode: "VIDEO", timers, makeBitmap: async () => (bmps.push(bitmapFor()), bmps[bmps.length - 1]) });
      await d.load();
      const real = fw.log.worker.postMessage;
      fw.log.worker.postMessage = () => {
        throw new Error("DataCloneError");
      };
      expect(await d.detect(video, 0)).to.deep.equal([]);
      expect(bmps[0].closed).to.equal(1);
      timers.fire(5000); // the stuck-worker timer of the failed frame must not exist any more
      expect(d.disabled).to.equal(false);
      fw.log.worker.postMessage = real;
      expect((await d.detect(video, 600)).map((x) => x.label)).to.deep.equal(["cup"]);
    });

    it("close() while the worker starts: load() answers false at once, not after the init timeout", async () => {
      const fw = fakeWorkers({ init: "silent" });
      const timers = fakeTimers();
      const d = mk(fw, { mode: "VIDEO", timers, loader: async () => ({}), guardTarget: null });
      const p = d.load();
      await flush();
      d.close();
      expect(await p).to.equal(false);
      expect(fw.log.terminated).to.equal(1);
      expect(d.where).to.equal(null);
    });

    it("no worker and no main-thread engine: off with one notice", async () => {
      const fw = fakeWorkers({ init: "error" });
      const notices = [];
      const d = mk(fw, { mode: "IMAGE", loader: async () => { throw new Error("x"); }, onNotice: (m) => notices.push(m), guardTarget: null });
      expect(await d.load()).to.equal(false);
      expect(d.disabled).to.equal(true);
      expect(notices).to.have.length(1);
    });

    it("the off-site guard is installed only while the main-thread fallback exists", async () => {
      const fw = fakeWorkers({ init: "error" });
      const realFetch = () => Promise.resolve("real");
      const target = { fetch: realFetch };
      const d = DET.createDetector({ mode: "IMAGE", createWorker: fw.create, loader: async () => ({ detectImage: () => ({ detections: [] }), close() {} }), guardTarget: target, guardOrigin: "https://site.test" });
      expect(target.fetch).to.equal(realFetch);
      await d.load();
      expect(target.fetch).to.not.equal(realFetch);
      d.close();
      expect(target.fetch).to.equal(realFetch);
      // with a working worker the page's fetch is never touched
      const target2 = { fetch: realFetch };
      const ok = DET.createDetector({ mode: "IMAGE", createWorker: fakeWorkers().create, guardTarget: target2, guardOrigin: "https://site.test" });
      await ok.load();
      expect(target2.fetch).to.equal(realFetch);
    });
  });

  describe("off-site request guard", () => {
    const ORIGIN = "https://site.test";
    function fakeTarget() {
      const calls = [];
      const opens = [];
      class XHR {
        open(method, url) {
          opens.push(url);
        }
      }
      return { calls, opens, fetch: function (input) { calls.push(typeof input === "string" ? input : input.url); return Promise.resolve("real"); }, XMLHttpRequest: XHR };
    }

    it("same-origin requests pass, anything else is rejected locally and never reaches the real fetch", async () => {
      const t = fakeTarget();
      const undo = DET.installOffsiteGuard(t, ORIGIN);
      expect(await t.fetch("/vendor/mediapipe/wasm/vision_wasm_internal.wasm")).to.equal("real");
      expect(await t.fetch("https://site.test/vendor/mediapipe/efficientdet_lite0.tflite")).to.equal("real");
      expect(await t.fetch({ url: "https://site.test/a" })).to.equal("real");
      const bad = ["https://odml.pa.googleapis.com/v1/log", "//odml.pa.googleapis.com/v1/log", "https://site.test.evil.com/x", "http://site.test/x", "data:text/plain,hi", { url: "https://evil.example/x" }, "https://site.test:8443/x"];
      for (const u of bad) {
        let err = null;
        try {
          await t.fetch(u);
        } catch (e) {
          err = e;
        }
        expect(err, JSON.stringify(u)).to.be.instanceOf(TypeError);
        expect(err.message).to.equal("off-site request blocked");
      }
      expect(t.calls).to.deep.equal(["/vendor/mediapipe/wasm/vision_wasm_internal.wasm", "https://site.test/vendor/mediapipe/efficientdet_lite0.tflite", "https://site.test/a"]);
      undo();
    });

    it("XMLHttpRequest.open is guarded the same way", () => {
      const t = fakeTarget();
      const undo = DET.installOffsiteGuard(t, ORIGIN);
      const x = new t.XMLHttpRequest();
      x.open("GET", "/model.tflite");
      expect(() => x.open("POST", "https://odml.pa.googleapis.com/v1/log")).to.throw(TypeError, "off-site request blocked");
      expect(t.opens).to.deep.equal(["/model.tflite"]);
      undo();
    });

    it("the undo puts the originals back", () => {
      const t = fakeTarget();
      const f = t.fetch;
      const open = t.XMLHttpRequest.prototype.open;
      const undo = DET.installOffsiteGuard(t, ORIGIN);
      expect(t.fetch).to.not.equal(f);
      undo();
      expect(t.fetch).to.equal(f);
      expect(t.XMLHttpRequest.prototype.open).to.equal(open);
      undo();
      expect(t.fetch).to.equal(f);
    });

    it("a target without fetch or XHR is fine", () => {
      expect(() => DET.installOffsiteGuard({}, ORIGIN)()).to.not.throw();
    });
  });

  describe("detect-worker.js (run in a Node vm with a fake worker scope)", () => {
    const vm = require("node:vm");
    const src = fs.readFileSync(path.join(__dirname, "..", "web", "js", "ar", "vision", "detect-worker.js"), "utf8");
    const flush = () => new Promise((r) => setImmediate(r));

    function scope({ importThrows = false } = {}) {
      const s = { posts: [], imported: [], fileset: [], created: [], fetched: [], opened: [], closed: 0, detectorClosed: 0, bitmapClosed: 0, ts: [], inputs: [] };
      const detection = { categories: [{ categoryName: "cup", score: 0.9, index: 41, displayName: "" }], boundingBox: { originX: 1, originY: 2, width: 3, height: 4, angle: 0 }, keypoints: [{ x: 1 }] };
      const Vision = {
        FilesetResolver: { forVisionTasks: async (base) => (s.fileset.push(base), { base }) },
        ObjectDetector: {
          createFromOptions: async (fileset, opts) => {
            s.created.push(opts);
            return {
              detect: (img) => (s.inputs.push(img), { detections: [detection, detection, detection, detection, detection, detection, detection, detection, detection, detection, detection, detection] }),
              detectForVideo: (img, ts) => (s.ts.push(ts), { detections: [detection] }),
              close: () => s.detectorClosed++,
            };
          },
        },
      };
      class XHR {
        open(m, u) {
          s.opened.push(u);
        }
      }
      const sb = {
        URL,
        console,
        performance: { now: () => Date.now() },
        ImageData: class {
          constructor(data, w, h) {
            if (!data || data.length !== w * h * 4) throw new RangeError("bad ImageData");
            this.data = data;
            this.width = w;
            this.height = h;
          }
        },
        fetch: (u) => (s.fetched.push(String(u)), Promise.resolve("real")),
        XMLHttpRequest: XHR,
        location: { origin: "https://site.test", href: "https://site.test/js/ar/vision/detect-worker.js" },
        postMessage: (m) => s.posts.push(m),
        close: () => s.closed++,
        importScripts: (u) => {
          s.imported.push(u);
          if (importThrows) throw new Error("blocked");
          sb.Vision = Vision;
        },
      };
      sb.self = sb;
      vm.createContext(sb);
      vm.runInContext(src, sb);
      s.sb = sb;
      s.send = (data) => sb.onmessage({ data });
      return s;
    }

    it("day and night: a dark frame is brightened before detection and its light is reported; a well exposed one is left alone", async () => {
      const s = scope();
      s.send({ type: "init", mode: "IMAGE" });
      await flush();
      const W = 64;
      const H = 48;
      const dark = new Uint8ClampedArray(W * H * 4);
      for (let i = 0; i < dark.length; i += 4) dark.set([10 + (i % 23), 12 + (i % 19), 8 + (i % 17), 255], i); // a dim room
      s.send({ type: "detect", seq: 1, ts: 0, buffer: dark.buffer, width: W, height: H });
      const r1 = s.posts.find((m) => m.type === "result" && m.seq === 1);
      expect(r1.light).to.be.within(0.02, 0.15);
      const seen = s.inputs[s.inputs.length - 1].data;
      let mean = 0;
      for (let i = 0; i < seen.length; i += 4) mean += seen[i] + seen[i + 1] + seen[i + 2];
      expect(mean / (seen.length * 0.75)).to.be.greaterThan(90); // stretched to a usable range
      // a well exposed frame (full range, mid mean) is passed through unchanged
      const good = new Uint8ClampedArray(W * H * 4);
      for (let i = 0; i < good.length; i += 4) {
        const v = Math.round(((i / 4) % W) * (255 / (W - 1)));
        good.set([v, v, v, 255], i);
      }
      const copy = good.slice();
      s.send({ type: "detect", seq: 2, ts: 0, buffer: good.buffer, width: W, height: H });
      expect(Array.from(s.inputs[s.inputs.length - 1].data)).to.deep.equal(Array.from(copy));
      expect(s.posts.find((m) => m.type === "result" && m.seq === 2).light).to.be.within(0.4, 0.6);
    });

    it("init: loads the same-origin IIFE bundle, wasm folder and model, CPU delegate, then says ready", async () => {
      const s = scope();
      s.send({ type: "init", mode: "VIDEO", scoreThreshold: 0.6, maxResults: 3 });
      await flush();
      expect(s.imported).to.deep.equal(["https://site.test/vendor/mediapipe/vision_bundle.js"]);
      expect(s.fileset).to.deep.equal(["https://site.test/vendor/mediapipe/wasm"]);
      expect(s.created[0].baseOptions.modelAssetPath).to.equal("https://site.test/vendor/mediapipe/efficientdet_lite0.tflite");
      expect(s.created[0].baseOptions.delegate).to.equal("CPU");
      expect(s.created[0].runningMode).to.equal("VIDEO");
      expect(s.created[0].scoreThreshold).to.equal(0.6);
      expect(s.created[0].maxResults).to.equal(3);
      expect(s.posts).to.deep.equal([{ type: "ready" }]);
    });

    it("a failing import or init is reported as an init error, without internals", async () => {
      const s = scope({ importThrows: true });
      s.send({ type: "init", mode: "IMAGE" });
      await flush();
      expect(s.posts).to.deep.equal([{ type: "error", stage: "init" }]);
    });

    it("IMAGE: pixels in, plain detections out (no keypoints, at most 10), size and time reported", async () => {
      const s = scope();
      s.send({ type: "init", mode: "IMAGE" });
      await flush();
      s.posts.length = 0;
      s.send({ type: "detect", seq: 7, ts: 5, buffer: new ArrayBuffer(2 * 2 * 4), width: 2, height: 2 });
      expect(s.posts).to.have.length(1);
      const r = s.posts[0];
      expect(r).to.include({ type: "result", seq: 7, width: 2, height: 2 });
      expect(r.ms).to.be.a("number");
      expect(r.detections).to.have.length(10);
      expect(JSON.parse(JSON.stringify(r.detections[0]))).to.deep.equal({ categories: [{ categoryName: "cup", score: 0.9 }], boundingBox: { originX: 1, originY: 2, width: 3, height: 4 } });
    });

    it("VIDEO: the bitmap is read and closed, timestamps strictly increase", async () => {
      const s = scope();
      s.send({ type: "init", mode: "VIDEO" });
      await flush();
      const bm = () => ({ width: 320, height: 240, closed: 0, close() { this.closed++; } });
      const a = bm();
      const b = bm();
      s.send({ type: "detect", seq: 1, ts: 100, bitmap: a });
      s.send({ type: "detect", seq: 2, ts: 100, bitmap: b });
      expect(s.ts[1]).to.be.greaterThan(s.ts[0]);
      expect(a.closed).to.equal(1);
      expect(b.closed).to.equal(1);
      expect(s.posts.filter((p) => p.type === "result")).to.have.length(2);
    });

    it("a frame before the detector is ready is dropped (and its bitmap closed); a throwing detector gives a detect error", async () => {
      const s = scope();
      const a = { width: 1, height: 1, closed: 0, close() { this.closed++; } };
      s.send({ type: "detect", seq: 3, ts: 1, bitmap: a });
      expect(s.posts).to.deep.equal([{ type: "result", seq: 3, dropped: true }]);
      expect(a.closed).to.equal(1);
      s.posts.length = 0;
      s.send({ type: "init", mode: "IMAGE" });
      await flush();
      s.posts.length = 0;
      s.send({ type: "detect", seq: 4, ts: 1, buffer: null, width: 2, height: 2 }); // not a buffer: the detector call fails
      expect(s.posts).to.deep.equal([{ type: "error", stage: "detect", seq: 4 }]);
    });

    it("close: the detector is closed and the worker closes itself; junk messages are ignored", async () => {
      const s = scope();
      s.send({ type: "init", mode: "IMAGE" });
      await flush();
      s.posts.length = 0;
      for (const junk of [null, undefined, 5, "x", {}, { type: "nope" }, { type: "eval", code: "1" }]) s.send(junk);
      expect(s.posts).to.deep.equal([]);
      s.send({ type: "close" });
      expect(s.detectorClosed).to.equal(1);
      expect(s.closed).to.equal(1);
    });

    it("fetch and XMLHttpRequest to another origin (MediaPipe's usage logger) are rejected locally; same-origin passes", async () => {
      const s = scope();
      const f = s.sb.fetch;
      await f("https://site.test/vendor/mediapipe/wasm/vision_wasm_internal.wasm");
      await f("/vendor/mediapipe/efficientdet_lite0.tflite");
      let err = null;
      try {
        await f("https://odml.pa.googleapis.com/v1/log", { method: "POST", body: "x" });
      } catch (e) {
        err = e;
      }
      expect(err).to.not.equal(null);
      expect(err.name).to.equal("TypeError");
      expect(err.message).to.equal("off-site request blocked");
      expect(s.fetched).to.deep.equal(["https://site.test/vendor/mediapipe/wasm/vision_wasm_internal.wasm", "/vendor/mediapipe/efficientdet_lite0.tflite"]);
      const x = new s.sb.XMLHttpRequest();
      x.open("GET", "/vendor/mediapipe/efficientdet_lite0.tflite");
      expect(() => x.open("POST", "https://odml.pa.googleapis.com/v1/log")).to.throw("off-site request blocked");
      expect(s.opened).to.deep.equal(["/vendor/mediapipe/efficientdet_lite0.tflite"]);
    });

    it("importScripts off-site throws; WebSocket and EventSource are gone; sendBeacon sends nothing", () => {
      const s = scope();
      expect(() => s.sb.importScripts("https://evil.example/x.js")).to.throw("off-site request blocked");
      expect(() => s.sb.importScripts("//evil.example/x.js")).to.throw("off-site request blocked");
      s.sb.importScripts("/vendor/mediapipe/wasm/vision_wasm_internal.js");
      expect(s.imported).to.deep.equal(["/vendor/mediapipe/wasm/vision_wasm_internal.js"]);
      // a scope that has them: they are replaced before MediaPipe runs
      const vm2 = require("node:vm");
      const beacons = [];
      const sb = { URL, location: { origin: "https://site.test", href: "https://site.test/w.js" }, WebSocket: function () {}, EventSource: function () {}, navigator: { sendBeacon: (u) => (beacons.push(u), true) } };
      sb.self = sb;
      vm2.createContext(sb);
      vm2.runInContext(src, sb);
      expect(() => new sb.WebSocket("wss://evil.example")).to.throw("off-site request blocked");
      expect(() => new sb.EventSource("https://evil.example")).to.throw("off-site request blocked");
      expect(sb.navigator.sendBeacon("https://odml.pa.googleapis.com/v1/log", "x")).to.equal(false);
      expect(beacons).to.deep.equal([]);
    });

    it("source: a classic script, one importScripts of the vendored bundle, no markup, no network of its own", () => {
      const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
      expect(code).to.not.match(/^\s*(import|export)\s/m);
      expect(code.match(/importScripts\s*\(/g)).to.have.length(1);
      expect(code).to.match(/importScripts\(\s*new URL\("\.\.\/\.\.\/\.\.\/vendor\/mediapipe\/vision_bundle\.js"/);
      expect(code).to.match(/delegate:\s*"CPU"/);
      expect(code).to.not.match(/innerHTML|outerHTML|document\.|\beval\s*\(|new Function|new WebSocket|new EventSource|sendBeacon\(|new XMLHttpRequest|\.send\s*\(|\bfetch\s*\(/);
      expect(code).to.not.match(/https?:\/\//);
      expect(code).to.not.match(/event\.data\.(url|path|src)|msg\.(url|path|src|bundle|model)/); // no URL comes from a message
      expect(code).to.include("off-site request blocked");
    });
  });

  describe("look around loop", () => {
    const video = { videoWidth: 640, videoHeight: 480, readyState: 4 };
    const imageData = { width: 320, height: 240, data: new Uint8ClampedArray(4) };

    it("2 Hz, one at a time, backs off when a call is slow, skips a dropped frame", async () => {
      const results = [];
      const fake = { disabled: false, ready: true, stats: { lastMs: 20 }, detect: async (src, t) => (results.push([src, t]), [det("cup")]) };
      const got = [];
      const la = DET.createLookAround({ detector: fake, onDetections: (d, t) => got.push(t) });
      const first = la.tick({ tMs: 0, video });
      expect(first).to.be.instanceOf(Promise);
      expect(await first).to.have.length(1);
      expect(la.tick({ tMs: 100, video })).to.equal(null);
      expect(la.tick({ tMs: 499, video })).to.equal(null);
      expect(await la.tick({ tMs: 500, video })).to.have.length(1);
      expect(got).to.deep.equal([0, 500]);
      fake.stats.lastMs = 200; // slow phone: wait four times as long
      await la.tick({ tMs: 1000, video });
      expect(la.tick({ tMs: 1700, video })).to.equal(null);
      expect(await la.tick({ tMs: 1800, video })).to.have.length(1);
      // a dropped frame (null) is not a detection and does not move the interval
      fake.detect = async () => null;
      const before = la.interval;
      expect(await la.tick({ tMs: 9000, video })).to.equal(null);
      expect(la.interval).to.equal(before);
      expect(got).to.have.length(4);
      // never twice at once
      let release;
      fake.detect = () => new Promise((r) => (release = () => r([])));
      const slow = la.tick({ tMs: 20000, video });
      expect(la.busy).to.equal(true);
      expect(la.tick({ tMs: 30000, video })).to.equal(null);
      release();
      await slow;
      expect(la.busy).to.equal(false);
      // a rejecting detector never breaks the loop
      fake.detect = async () => { throw new Error("x"); };
      expect(await la.tick({ tMs: 40000, video })).to.equal(null);
      expect(la.busy).to.equal(false);
    });

    it("XR: the reader supplies the image; the capture hook runs inside the tick and its result reaches onDetections", async () => {
      let img = imageData;
      const reader = { read: (frame, view) => (frame === "F" && view === "V" ? img : null) };
      const seen = [];
      const captured = [];
      const xr = DET.createLookAround({
        detector: { disabled: false, ready: true, stats: { lastMs: 1 }, detect: async (s) => (seen.push(s), [det("cup")]) },
        reader,
        capture: (info) => ({ depthOf: info.frame }),
        onDetections: (d, t, info, cap) => captured.push(cap),
      });
      await xr.tick({ tMs: 0, frame: "F", view: "V" });
      expect(seen).to.deep.equal([imageData]);
      expect(captured).to.deep.equal([{ depthOf: "F" }]);
      img = null;
      expect(xr.tick({ tMs: 600, frame: "F", view: "V" })).to.equal(null);
      expect(xr.tick({ tMs: 1200, frame: "other", view: "V" })).to.equal(null);
      // the XRView comes from the viewer pose when there is one (what ar-view.js passes)
      img = imageData;
      const viaPose = DET.createLookAround({ detector: { disabled: false, ready: true, stats: {}, detect: async () => [] }, reader: { read: (f, v) => (v === "V0" ? imageData : null) } });
      expect(await viaPose.tick({ t: 0, frame: "F", pose: { views: ["V0"] } })).to.deep.equal([]);
      // a capture that throws is just "no capture"
      const c2 = [];
      const thrower = DET.createLookAround({ detector: { disabled: false, ready: true, stats: {}, detect: async () => [] }, capture: () => { throw new Error("x"); }, onDetections: (d, t, i, cap) => c2.push(cap) });
      await thrower.tick({ tMs: 0, video });
      expect(c2).to.deep.equal([null]);
    });

    it("a disabled or not ready detector, or a disabled reader, is skipped", () => {
      const fake = { disabled: true, ready: true, stats: {}, detect: async () => [] };
      const la = DET.createLookAround({ detector: fake });
      expect(la.tick({ tMs: 0, video })).to.equal(null);
      fake.disabled = false;
      fake.ready = false;
      expect(la.tick({ tMs: 0, video })).to.equal(null);
      fake.ready = true;
      const r = DET.createLookAround({ detector: fake, reader: { disabled: true, read: () => imageData } });
      expect(r.tick({ tMs: 0, frame: "F", view: "V" })).to.equal(null);
      expect(la.tick({ video })).to.equal(null); // no time
    });
  });

  describe("detector source", () => {
    it("lazy same-origin MediaPipe: worker first, one literal vendored import for the fallback, CPU, no network of its own", () => {
      const src = fs.readFileSync(path.join(__dirname, "..", "web", "js", "ar", "vision", "detector.js"), "utf8");
      expect(src).to.match(/import\(\s*["']\.\.\/\.\.\/\.\.\/vendor\/mediapipe\/vision_bundle\.mjs["']\s*\)/);
      expect(src).to.not.match(/^\s*import\s[^;]*mediapipe/m); // never a static import: it loads only on demand
      expect(src).to.include("vendor/mediapipe/wasm");
      expect(src).to.include("efficientdet_lite0.tflite");
      expect(src).to.match(/delegate:\s*["']CPU["']/);
      expect(src).to.include("forVisionTasks");
      expect(src).to.match(/new Worker\(new URL\("\.\/detect-worker\.js", import\.meta\.url\)\)/); // a same-origin file, classic (no { type: "module" })
      expect(src).to.not.match(/new Worker\([^)]*type:\s*["']module/);
      expect(src).to.not.match(/URL\.createObjectURL|new Blob/);
    });
  });


  // ---------------------------------------------------------------- XR camera reader
  describe("XR camera reader", () => {
    const GL = { FRAMEBUFFER: 1, READ_FRAMEBUFFER: 2, DRAW_FRAMEBUFFER: 3, RENDERBUFFER: 4, RGBA8: 5, RGBA: 6, UNSIGNED_BYTE: 7, COLOR_ATTACHMENT0: 8, COLOR_BUFFER_BIT: 9, LINEAR: 10, READ_FRAMEBUFFER_BINDING: 11, DRAW_FRAMEBUFFER_BINDING: 12, RENDERBUFFER_BINDING: 13, TEXTURE_2D: 14, FRAMEBUFFER_COMPLETE: 15, NO_ERROR: 0 };
    function fakeGl({ error = 0, throwOn = null, noBlit = false } = {}) {
      const log = [];
      const gl = {
        ...GL,
        log,
        getParameter: (p) => ({ [GL.READ_FRAMEBUFFER_BINDING]: "readFbo", [GL.DRAW_FRAMEBUFFER_BINDING]: "drawFbo", [GL.RENDERBUFFER_BINDING]: "rbo" })[p] ?? null,
        createFramebuffer: () => ({ id: "fb" }),
        createRenderbuffer: () => ({ id: "rb" }),
        bindFramebuffer: (t, f) => log.push(["bindFramebuffer", t, f && f.id ? f.id : f]),
        bindRenderbuffer: (t, r) => log.push(["bindRenderbuffer", t, r && r.id ? r.id : r]),
        renderbufferStorage: (t, f, w, h) => log.push(["renderbufferStorage", w, h]),
        framebufferTexture2D: () => log.push(["framebufferTexture2D"]),
        framebufferRenderbuffer: () => log.push(["framebufferRenderbuffer"]),
        checkFramebufferStatus: () => GL.FRAMEBUFFER_COMPLETE,
        blitFramebuffer: (...a) => log.push(["blit", ...a]),
        readPixels: (x, y, w, h, f, t, out) => {
          if (throwOn === "read") throw new Error("lost");
          log.push(["readPixels", w, h]);
          for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) out.set([r, c, 0, 255], (r * w + c) * 4); // GL rows go bottom-up: row index in R
        },
        getError: () => error,
        deleteFramebuffer: () => log.push(["deleteFramebuffer"]),
        deleteRenderbuffer: () => log.push(["deleteRenderbuffer"]),
      };
      if (noBlit) delete gl.blitFramebuffer;
      return gl;
    }
    const Binding = class {
      constructor(session, gl) {
        this.session = session;
      }
      getCameraImage(cam) {
        return cam.fail ? null : { tex: 1 };
      }
    };
    const mk = (gl, extra = {}) => XRC.createXrCameraReader(gl, {}, { Binding, width: 4, makeImageData: (data, w, h) => ({ data, width: w, height: h }), ...extra });
    const view = { camera: { width: 8, height: 4 } };

    it("without XRWebGLBinding it is simply unsupported", () => {
      const r = XRC.createXrCameraReader(fakeGl(), {}, { Binding: undefined });
      expect(r.supported).to.equal(false);
      expect(r.read({}, view)).to.equal(null);
    });

    it("returns null for a view without a camera image or a texture", () => {
      const r = mk(fakeGl());
      expect(r.supported).to.equal(true);
      expect(r.read({}, {})).to.equal(null);
      expect(r.read({}, null)).to.equal(null);
      expect(r.read({}, { camera: { width: 8, height: 4, fail: true } })).to.equal(null);
    });

    it("blits to the small size on the GPU, reads that, flips rows to top-down and restores the GL bindings", () => {
      const gl = fakeGl();
      const r = mk(gl);
      const img = r.read({}, view);
      expect(img.width).to.equal(4);
      expect(img.height).to.equal(2);
      expect(img.data).to.have.length(4 * 2 * 4);
      expect(gl.log.some((l) => l[0] === "blit")).to.equal(true);
      expect(gl.log.some((l) => l[0] === "readPixels" && l[1] === 4 && l[2] === 2)).to.equal(true);
      // top row of the picture is the last GL row (index 1)
      expect(img.data[0]).to.equal(1);
      expect(img.data[4 * 4]).to.equal(0);
      // the caller's bindings are put back, in the end
      const binds = gl.log.filter((l) => l[0] === "bindFramebuffer");
      const lastRead = binds.filter((b) => b[1] === GL.READ_FRAMEBUFFER).pop();
      const lastDraw = binds.filter((b) => b[1] === GL.DRAW_FRAMEBUFFER).pop();
      expect(lastRead[2]).to.equal("readFbo");
      expect(lastDraw[2]).to.equal("drawFbo");
      expect(gl.log.filter((l) => l[0] === "bindRenderbuffer").pop()[2]).to.equal("rbo");
    });

    it("keeps the aspect ratio and never upsizes", () => {
      const gl = fakeGl();
      const r = mk(gl, { width: 320 });
      const img = r.read({}, { camera: { width: 100, height: 50 } });
      expect(img.width).to.equal(100);
      expect(img.height).to.equal(50);
      const big = mk(fakeGl(), { width: 320 }).read({}, { camera: { width: 1280, height: 720 } });
      expect(big.width).to.equal(320);
      expect(big.height).to.equal(180);
    });

    it("a GL error or an exception gives null, restores state, and three in a row disable the reader", () => {
      const gl = fakeGl({ throwOn: "read" });
      const r = mk(gl);
      for (let i = 0; i < 3; i++) expect(r.read({}, view)).to.equal(null);
      const binds = gl.log.filter((l) => l[0] === "bindFramebuffer" && l[1] === GL.READ_FRAMEBUFFER);
      expect(binds.pop()[2]).to.equal("readFbo");
      expect(r.disabled).to.equal(true);
      const before = gl.log.length;
      expect(r.read({}, view)).to.equal(null);
      expect(gl.log.length).to.equal(before); // disabled: it does not touch GL any more
      const e = mk(fakeGl({ error: 1282 }));
      expect(e.read({}, view)).to.equal(null);
    });

    it("close() frees the GL objects", () => {
      const gl = fakeGl();
      const r = mk(gl);
      r.read({}, view);
      r.close();
      expect(gl.log.some((l) => l[0] === "deleteFramebuffer")).to.equal(true);
      expect(gl.log.some((l) => l[0] === "deleteRenderbuffer")).to.equal(true);
      expect(r.read({}, view)).to.equal(null);
    });

    it("works without blitFramebuffer by reading the camera size and shrinking in JS", () => {
      const gl = fakeGl({ noBlit: true });
      const r = mk(gl);
      const img = r.read({}, view);
      expect(img.width).to.equal(4);
      expect(img.height).to.equal(2);
      expect(gl.log.some((l) => l[0] === "readPixels" && l[1] === 8 && l[2] === 4)).to.equal(true);
    });
  });

  describe("XR depth context", () => {
    const I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    // a real perspective projection (60 degrees vertical, 9:16 portrait) and a view translated to (1, 2, 3)
    const f = 1 / Math.tan(Math.PI / 6);
    const proj = [f * (9 / 16), 0, 0, 0, 0, f, 0, 0, 0, 0, -1.002, -1, 0, 0, -0.2002, 0];
    const mul = (a, b) => {
      const o = new Array(16).fill(0);
      for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) o[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k];
      return o;
    };

    it("invert4 inverts a projection and refuses a singular matrix", () => {
      const inv = XRC.invert4(proj);
      const id = mul(proj, inv);
      for (let i = 0; i < 16; i++) expect(id[i]).to.be.closeTo(I[i], 1e-9);
      expect(XRC.invert4(new Array(16).fill(0))).to.equal(null);
      expect(XRC.invert4(null)).to.equal(null);
      expect(XRC.invert4([1, 2])).to.equal(null);
    });

    it("getDepth clamps the coordinates and maps invalid readings to 0; unproject lands on the view axis", () => {
      const di = { getDepthInMeters: (u, v) => (u > 0.9 ? NaN : 2) };
      const view = { projectionMatrix: proj, transform: { matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 1, 2, 3, 1] } };
      const ctx = XRC.createXrDepthContext({ getDepthInformation: (v) => (v === view ? di : null) }, view);
      expect(ctx.getDepth(-1, 2)).to.equal(2);
      expect(ctx.getDepth(0.95, 0.5)).to.equal(0);
      const p = ctx.unproject(0.5, 0.5, 2); // the middle of the picture, 2 m along the view axis (-Z), view at (1, 2, 3)
      expect(p[0]).to.be.closeTo(1, 1e-6);
      expect(p[1]).to.be.closeTo(2, 1e-6);
      expect(p[2]).to.be.closeTo(1, 1e-6);
    });

    it("it is a snapshot: the answers survive the end of the XRFrame (the detection comes back later)", () => {
      let alive = true;
      const di = { getDepthInMeters: () => { if (!alive) throw new Error("InvalidStateError"); return 1.5; } };
      const view = { projectionMatrix: proj, transform: { matrix: I.slice() } };
      const ctx = XRC.createXrDepthContext({ getDepthInformation: () => di }, view);
      alive = false;
      expect(ctx.getDepth(0.5, 0.5)).to.equal(1.5);
      view.transform.matrix[12] = 99; // the live view moves on; the snapshot keeps the pose it was taken at
      expect(ctx.unproject(0.5, 0.5, 2)[0]).to.be.closeTo(0, 1e-6);
    });

    it("no depth information, no context", () => {
      const view = { projectionMatrix: proj, transform: { matrix: I } };
      expect(XRC.createXrDepthContext({ getDepthInformation: () => null }, view)).to.equal(null);
      expect(XRC.createXrDepthContext({ getDepthInformation: () => { throw new Error("x"); } }, view)).to.equal(null);
      expect(XRC.createXrDepthContext({}, view)).to.equal(null);
      expect(XRC.createXrDepthContext(null, view)).to.equal(null);
      expect(XRC.createXrDepthContext({ getDepthInformation: () => ({ getDepthInMeters: () => 1 }) }, null)).to.equal(null);
      expect(XRC.createXrDepthContext({ getDepthInformation: () => ({ getDepthInMeters: () => 1 }) }, { projectionMatrix: proj })).to.equal(null);
    });

    it("feeds the world model: a cup 2 m straight ahead of the phone is 2 m from a rover standing at the phone's feet", () => {
      const view = { projectionMatrix: proj, transform: { matrix: I } };
      const ctx = XRC.createXrDepthContext({ getDepthInformation: () => ({ getDepthInMeters: () => 2 }) }, view);
      const w = W.createWorldObjects();
      w.update([det("cup", 0.5)], 0, ctx);
      const o = w.find("cup", 0);
      expect(o.located).to.equal(true);
      expect(o.z).to.be.closeTo(-2, 1e-6); // the phone looks down -Z
      expect(DET.xrViewOf({ pose: { views: [view] } })).to.equal(view);
      expect(DET.xrViewOf({ view })).to.equal(view);
      expect(DET.xrViewOf(null)).to.equal(null);
    });
  });

  // ---------------------------------------------------------------- intents
  describe("voice intents", () => {
    const CAM_ONLY = "The twin is not in your room here; I can only tell you what the camera sees.";
    function setup({ view = "xr", seeds = [], rover = ORIGIN, looking = true, seek = null } = {}) {
      const world = W.createWorldObjects();
      for (const [label, u, depth] of seeds) world.update([det(label, u)], 0, depth === undefined ? { hfovDeg: 60 } : depthCtx(depth));
      const vi = VI.createVisionIntents({ world, getRover: () => rover, getViewMode: () => view, isLooking: () => looking, seek, now: () => 0 });
      const ask = (text, opts = { userSpeed: 60 }, body = "rover") => vi.extension(text, body, { opts });
      return { world, vi, ask };
    }
    const says = (r) => r.steps.filter((s) => s.tool === "say").map((s) => s.text);
    const tools = (r) => r.steps.map((s) => s.tool);

    it("what do you see: a say-only plan (it needs no ARM) with up to 3 items, direction and distance", () => {
      const { ask } = setup({ seeds: [["cup", 0.5, 1.5], ["chair", 0.1, 2.0], ["person", 0.5, 3.0], ["tv", 0.9, 4.0], ["book", 0.5, 5.0]] });
      for (const q of ["what do you see", "What can you see?", "what are you seeing", "what's around you", "tell me what you see", "hey robot, what do you see please"]) {
        const r = ask(q);
        expect(r, q).to.not.equal(null);
        expect(tools(r), q).to.deep.equal(["say"]);
        expect(r.steps.every((s) => !T.MOTION_TOOLS.has(s.tool))).to.equal(true);
      }
      const r = ask("what do you see");
      const text = says(r)[0];
      expect(text).to.match(/^I see a cup \(about 1\.5 m ahead\), a chair \(about 2\.2 m ahead-left\), a person \(about 3 m ahead\)/);
      expect(text).to.match(/2 more/);
      expect(text).to.not.match(/TV|book/);
      expect(r.unknown).to.deep.equal([]);
      expect(r.rejected).to.deep.equal([]);
    });

    it("in camera view: direction only, no distance", () => {
      const { ask } = setup({ view: "camera", seeds: [["cup", 0.1], ["person", 0.5]] });
      const text = says(ask("what do you see"))[0];
      expect(text).to.match(/a cup \(ahead-left\)/);
      expect(text).to.match(/a person \(ahead\)/);
      expect(text).to.not.match(/\d/);
    });

    it("sees nothing, or Look around is off: says so honestly", () => {
      expect(says(setup().ask("what do you see"))[0]).to.match(/don't see anything I know/i);
      const off = setup({ looking: false, seeds: [["cup", 0.5, 1]] });
      expect(says(off.ask("what do you see"))[0]).to.match(/Look around/);
      expect(says(off.ask("what do you see"))[0]).to.not.match(/cup/);
    });

    it("do you see / is there a <label>", () => {
      const { ask } = setup({ seeds: [["cup", 0.5, 1.5]] });
      expect(says(ask("do you see a cup"))[0]).to.match(/^Yes.*cup.*about 1\.5 m ahead/);
      expect(says(ask("is there a mug?"))[0]).to.match(/^Yes.*cup/);
      expect(says(ask("do you see the chair"))[0]).to.match(/^No.*chair/);
    });

    it("go to the <label>: say, turn, drive from the rover frame, validated", () => {
      const a = setup({ seeds: [["cup", 0.5, 1.5]] }).ask("go to the cup");
      expect(tools(a)).to.deep.equal(["say", "drive"]);
      expect(says(a)[0]).to.equal("Going to the cup (about 1.5 m ahead).");
      expect(a.steps[1]).to.include({ direction: "forward", seconds: 3, speed: 100 }); // 1.2 m at 0.21 m/s = 5.7 s, 3 s per step

      const b = setup({ seeds: [["cup", 0.2, 1.0]] }).ask("go to the cup");
      expect(tools(b)).to.deep.equal(["say", "turn", "drive"]);
      expect(b.steps[1].degrees).to.be.closeTo(19.8, 0.15);
      expect(b.steps[1].degrees).to.be.greaterThan(0); // left is positive

      const c = setup({ seeds: [["cup", 0.5, 0.8]] }).ask("go to the cup");
      expect(c.steps[1].seconds).to.be.closeTo(2.38, 0.02); // (0.8 - 0.3) / (0.35 x 0.6)
      const fast = setup({ seeds: [["cup", 0.5, 0.8]] }).ask("go to the cup", { userSpeed: 100 });
      expect(fast.steps[1].seconds).to.be.closeTo(1.43, 0.02);

      const behind = setup({ seeds: [["cup", 0.5, -1.5]] }).ask("go to the cup"); // a negative depth is no reading: seen, but not located
      expect(tools(behind)).to.deep.equal(["say"]);
      expect(says(behind)[0]).to.match(/how far|depth/i);

      const right = setup({ seeds: [["cup", 0.9, 1.0]] }).ask("go to the cup");
      expect(right.steps[1].degrees).to.be.lessThan(0);

      const yawed = setup({ seeds: [["cup", 0.5, 2.0]], rover: { x: 0, z: 0, yaw: Math.PI / 2 } }).ask("go to the cup");
      expect(yawed.steps[1].tool).to.equal("turn");
      expect(yawed.steps[1].degrees).to.be.closeTo(-90, 0.1); // the cup is straight ahead of the world, to the right of the rover
    });

    it("other ways to say it, with articles, aliases and manners", () => {
      const { ask } = setup({ seeds: [["cup", 0.5, 1.5], ["couch", 0.5, 2]] });
      for (const q of ["go to the cup", "Go to a cup.", "please drive to the mug", "move towards the cup", "head to my cup", "navigate to the cup!", "go over to the cup", "can you go to the cup please"]) {
        const r = ask(q);
        expect(r, q).to.not.equal(null);
        expect(tools(r), q).to.include("drive");
        expect(says(r)[0], q).to.match(/cup/);
      }
      expect(says(ask("go to the sofa"))[0]).to.match(/couch/);
    });

    it("arrived, unseen, unlocated", () => {
      const near = setup({ seeds: [["cup", 0.5, 0.3]] }).ask("go to the cup");
      expect(tools(near)).to.deep.equal(["say"]);
      expect(says(near)[0]).to.equal("I'm next to the cup.");
      const none = setup().ask("go to the cup");
      expect(tools(none)).to.deep.equal(["say"]);
      expect(says(none)[0]).to.match(/don't see a cup/);
      const noDepth = setup({ seeds: [["cup", 0.5]] }).ask("go to the cup");
      expect(tools(noDepth)).to.deep.equal(["say"]);
      expect(says(noDepth)[0]).to.match(/cup/);
      expect(says(noDepth)[0]).to.match(/how far|depth/i);
      expect(setup({ looking: false }).ask("go to the cup").steps[0].text).to.match(/Look around/);
    });

    it("camera view: go to / find / avoid answer honestly and never move", () => {
      const { ask } = setup({ view: "camera", seeds: [["cup", 0.1]] });
      for (const q of ["go to the cup", "find the cup", "avoid the cup", "go to the chair", "look for the chair"]) {
        const r = ask(q);
        expect(tools(r), q).to.deep.equal(["say"]);
        expect(says(r)[0], q).to.include(CAM_ONLY);
      }
      expect(says(ask("find the cup"))[0]).to.match(/camera sees a cup/i);
      expect(says(ask("find the chair"))[0]).to.match(/don't see a chair/i);
      // an unknown view mode is treated like the camera view: never claim the twin is in the room
      const odd = setup({ view: null, seeds: [["cup", 0.5, 1.5]] }).ask("go to the cup");
      expect(says(odd)[0]).to.include(CAM_ONLY);
    });

    it("find the <label>: already seen, or a scan within the plan limits", () => {
      const seen = setup({ seeds: [["cup", 0.5, 1.5]] }).ask("find the cup");
      expect(tools(seen)).to.deep.equal(["say"]);
      expect(says(seen)[0]).to.equal("I found the cup (about 1.5 m ahead).");

      const seeks = [];
      const { ask } = setup({ seek: { internal: false, begin: (i) => seeks.push(i), cancel() {} } });
      const r = ask("find the cup");
      expect(r.steps).to.have.length(12);
      expect(r.steps[0].tool).to.equal("say");
      expect(says(r)[0]).to.match(/Looking for the cup.*phone/);
      const turns = r.steps.filter((s) => s.tool === "turn");
      const waits = r.steps.filter((s) => s.tool === "wait");
      expect(turns).to.have.length(6);
      expect(waits).to.have.length(5);
      for (const t of turns) expect(t).to.include({ degrees: 60, speed: 100 });
      for (const w of waits) expect(w.seconds).to.equal(1);
      const total = r.steps.reduce((s, x) => s + T.stepSeconds(x, 60), 0);
      expect(total).to.be.at.most(30);
      expect(r.rejected).to.deep.equal([]);
      expect(seeks).to.deep.equal([{ kind: "find", label: "cup" }]);
      for (const q of ["look for the cup", "search for a mug", "locate the cup", "where is the cup", "find my cup"]) expect(tools(ask(q)), q).to.include("turn");
    });

    it("avoid the <label>: a say-only plan; a 0.3 m keep-out disc follows the live object; it can be cleared", () => {
      const s = setup({ seeds: [["chair", 0.5, 1.0]] });
      const r = s.ask("avoid the chair");
      expect(tools(r)).to.deep.equal(["say"]);
      expect(says(r)[0]).to.match(/clear of the chair/);
      expect(s.vi.avoidLabels()).to.deep.equal(["chair"]);
      const z = s.vi.avoidZones(0);
      expect(z).to.have.length(1);
      expect(z[0]).to.include({ label: "chair", r: 0.3 });
      expect(z[0].z).to.be.closeTo(1.0, 1e-9);
      expect(s.vi.avoidZones(5000)).to.deep.equal([]); // not seen for a while: no disc
      expect(says(s.ask("stop avoiding the chair"))[0]).to.match(/no longer/);
      expect(s.vi.avoidLabels()).to.deep.equal([]);
      for (const l of ["cup", "person", "dog", "bottle", "couch", "tv"]) s.ask(`stay away from the ${l}`);
      expect(s.vi.avoidLabels().length).to.be.at.most(5);
      s.vi.clearAvoid();
      expect(s.vi.avoidLabels()).to.deep.equal([]);
    });

    it("refuses anything that is not a COCO label, without echoing it", () => {
      const { ask, vi } = setup({ seeds: [["cup", 0.5, 1]] });
      const evil = [
        "go to the <img src=x>",
        "go to the <img src=x onerror=alert(1)>",
        "find the <script>alert(1)</script>",
        'avoid the "><svg onload=x>',
        "go to the unicorn",
        "go to the constructor",
        "find the __proto__",
        "go to the сup", // a Cyrillic es inside "cup"
        "go to the " + "x".repeat(400),
        "find the cup; rm -rf /",
        "go to the ${process.env}",
        "avoid the toString",
        "go to the kitchen",
      ];
      for (const q of evil) {
        const r = ask(q);
        expect(r, q.slice(0, 30)).to.not.equal(null);
        expect(r.steps, q.slice(0, 30)).to.deep.equal([]);
        expect(r.say, q.slice(0, 30)).to.be.a("string").and.not.equal("");
        expect(r.say).to.not.match(/[<>"$;]|unicorn|constructor|kitchen|proto|xxxx|script|img/i);
        expect(r.say).to.match(/cup|chair|person/); // tells what it does understand
      }
      expect(vi.avoidLabels()).to.deep.equal([]);
    });

    it("one object at a time", () => {
      const { ask } = setup({ seeds: [["cup", 0.5, 1]] });
      for (const q of ["go to the cup then turn left", "find the cup and the chair", "go to the cup, then the chair"]) {
        const r = ask(q);
        expect(r.steps, q).to.deep.equal([]);
        expect(r.say, q).to.match(/one/i);
      }
    });

    it("leaves ordinary commands to the built-in parser", () => {
      const { ask } = setup({ seeds: [["cup", 0.5, 1]] });
      const pass = ["turn left 45", "forward 2 s", "back 1 s", "look left then look right", "stop", "slow down", "wait 2", "go to the left", "go to the right", "go left", "go back", "go forward 2 seconds", "go to sleep", "turn around", "find", "avoid", "what", "", "   ", "hello", "drive to", "spin", "go to"];
      for (const q of pass) expect(ask(q), JSON.stringify(q)).to.equal(null);
      expect(ask(undefined)).to.equal(null);
      expect(ask(42)).to.equal(null);
      expect(ask({})).to.equal(null);
      // other bodies are not ours
      expect(ask("go to the cup", { userSpeed: 60 }, "desk")).to.equal(null);
      expect(ask("what do you see", { userSpeed: 60 }, "walker")).to.equal(null);
      expect(ask("what do you see", { userSpeed: 60 }, "nope")).to.equal(null);
    });

    it("every result has the shape of parseCommand and survives validatePlan unchanged", () => {
      const { ask } = setup({ seeds: [["cup", 0.2, 1.0], ["chair", 0.8, 2.0]] });
      for (const q of ["what do you see", "go to the cup", "find the chair", "find the person", "avoid the cup", "go to the <img>"]) {
        const r = ask(q);
        expect(r).to.have.all.keys("steps", "say", "unknown", "rejected");
        expect(r.unknown).to.be.an("array");
        expect(r.rejected).to.be.an("array");
        const v = T.validatePlan(r.steps, "rover", { userSpeed: 60 });
        expect(v.steps, q).to.deep.equal(r.steps);
        expect(v.rejected, q).to.deep.equal([]);
        for (const s of r.steps) expect(["say", "turn", "drive", "wait"]).to.include(s.tool);
        const base = G.parseCommand("turn left 10", "rover", { userSpeed: 60 });
        expect(Object.keys(r).sort()).to.deep.equal(Object.keys(base).sort());
      }
    });

    it("seek.begin() is called only for plans that move, and a continuation does not repeat the announcement", () => {
      const begun = [];
      const seek = { internal: false, begin: (i) => begun.push(i), cancel() {} };
      const { ask } = setup({ seeds: [["cup", 0.5, 1.5], ["chair", 0.5, 0.3]], seek });
      ask("what do you see");
      ask("go to the chair"); // already next to it
      ask("avoid the cup");
      ask("go to the person"); // not seen
      expect(begun).to.deep.equal([]);
      ask("go to the cup");
      expect(begun).to.deep.equal([{ kind: "goto", label: "cup" }]);
      seek.internal = true;
      const again = ask("go to the cup");
      expect(tools(again)).to.deep.equal(["drive"]); // no "Going to the cup" the second time
    });
  });

  // ---------------------------------------------------------------- seek
  describe("seek: bounded re-planning", () => {
    function rig({ rover = { ...ORIGIN }, target = { z: 1.5 }, obstacle = null } = {}) {
      const r = { t: 0, rover, target: target && { label: "cup", located: true, x: target.x ?? 0, z: target.z }, obstacle, submits: [], cancels: [], notices: [], begins: 0, internalDuringSubmit: [] };
      const world = { find: (label) => (label === "cup" || label === "mug" ? r.target : null) };
      r.seek = SK.createSeek({
        now: () => r.t,
        world,
        getRover: () => r.rover,
        getObstacle: () => r.obstacle,
        submit: (text) => {
          r.submits.push(text);
          r.internalDuringSubmit.push(r.seek.internal);
          r.seek.begin({ kind: "goto", label: "cup" }); // the intent extension does this at parse time
          r.onSubmit && r.onSubmit();
        },
        cancelPlan: (msg) => r.cancels.push(msg),
        notice: (msg) => r.notices.push(msg),
      });
      let n = 0;
      r.plan = () => ({ id: ++n });
      r.ai = (state, plan) => r.seek.onAiChange({ state, plan });
      /** The ai pilot's states for one submitted plan up to running. */
      r.start = (plan) => {
        r.ai("thinking", null);
        r.ai("ready", plan);
        r.ai("running", plan);
      };
      return r;
    }

    it("pending until the plan really runs: ARM first means no clock yet", () => {
      const r = rig();
      r.seek.begin({ kind: "goto", label: "cup" });
      expect(r.seek.state).to.equal("pending");
      const p = r.plan();
      r.ai("thinking", null);
      r.ai("ready", p);
      r.t = 60000;
      r.seek.tick();
      expect(r.seek.state).to.equal("pending"); // the 45 s count starts when it runs
      r.ai("running", p);
      expect(r.seek.state).to.equal("active");
      expect(r.seek.rounds).to.equal(1);
    });

    it("a pending intent is dropped when the plan is stopped, replaced or discarded", () => {
      for (const [state] of [["stopped"], ["idle"], ["interrupted"]]) {
        const r = rig();
        r.seek.begin({ kind: "goto", label: "cup" });
        const p = r.plan();
        r.ai("ready", p);
        r.ai(state, p);
        expect(r.seek.state, state).to.equal("idle");
      }
      const r = rig();
      r.seek.begin({ kind: "goto", label: "cup" });
      r.ai("ready", r.plan());
      r.ai("thinking", null);
      r.ai("ready", r.plan()); // another message produced another plan
      expect(r.seek.state).to.equal("idle");
    });

    it("arrives: within 0.35 m the plan is cancelled with 'I'm next to the cup.' and nothing is re-submitted", () => {
      const r = rig();
      r.seek.begin({ kind: "goto", label: "cup" });
      r.start(r.plan());
      r.rover.z = 1.0;
      r.seek.tick();
      expect(r.seek.state).to.equal("active");
      r.rover.z = 1.2; // 0.3 m left
      r.seek.tick();
      expect(r.seek.state).to.equal("idle");
      expect(r.cancels).to.deep.equal(["I'm next to the cup."]);
      expect(r.submits).to.deep.equal([]);
      expect(r.seek.result).to.include({ kind: "arrived", label: "cup" });
    });

    it("re-plans after each plan is done: 'go to the cup' again, at most 5 plans, then gives up honestly", () => {
      const r = rig({ target: { z: 5 } });
      r.seek.begin({ kind: "goto", label: "cup" });
      let p = r.plan();
      r.start(p);
      for (let round = 1; round <= 4; round++) {
        r.rover.z += 0.5;
        r.ai("done", p);
        expect(r.submits).to.have.length(round);
        expect(r.submits[round - 1]).to.equal("go to the cup");
        expect(r.internalDuringSubmit[round - 1]).to.equal(true);
        expect(r.seek.internal).to.equal(false);
        expect(r.seek.rounds).to.equal(round + 1); // the begin() the intent made during the submit did not reset it
        expect(r.seek.state).to.equal("active");
        p = r.plan();
        r.ai("thinking", null);
        r.ai("ready", p);
        r.ai("running", p);
        expect(r.seek.state).to.equal("active");
      }
      r.ai("done", p); // the 5th plan is done
      expect(r.submits).to.have.length(4);
      expect(r.seek.state).to.equal("idle");
      expect(r.notices.join(" ")).to.match(/5 tries|5 times|five/);
      expect(r.seek.result.kind).to.equal("rounds");
    });

    it("45 s overall, counted from when the first plan runs", () => {
      const r = rig({ target: { z: 5 } });
      r.t = 1000;
      r.seek.begin({ kind: "goto", label: "cup" });
      r.start(r.plan());
      r.t = 1000 + 44999;
      r.seek.tick();
      expect(r.seek.state).to.equal("active");
      r.t = 1000 + 45000;
      r.seek.tick();
      expect(r.seek.state).to.equal("idle");
      expect(r.cancels[0]).to.match(/45 s/);
      expect(r.seek.result.kind).to.equal("timeout");
      // the wait for a re-plan counts too
      const q = rig({ target: { z: 5 } });
      q.seek.begin({ kind: "goto", label: "cup" });
      const p = q.plan();
      q.start(p);
      q.t = 40000;
      q.ai("done", p);
      q.ai("thinking", null);
      q.ai("ready", q.plan());
      q.ai("running", q.plan());
      q.t = 45001;
      q.seek.tick();
      expect(q.seek.state).to.equal("idle");
    });

    it("target lost for 2 s ends it; seen again within 2 s carries on", () => {
      const r = rig({ target: { z: 3 } });
      r.seek.begin({ kind: "goto", label: "cup" });
      r.start(r.plan());
      const t0 = r.target;
      r.target = null;
      r.t = 100;
      r.seek.tick();
      r.t = 2099;
      r.seek.tick();
      expect(r.seek.state).to.equal("active");
      r.target = t0; // back
      r.t = 2200;
      r.seek.tick();
      r.target = null;
      r.t = 3000;
      r.seek.tick();
      r.t = 4999;
      r.seek.tick();
      expect(r.seek.state).to.equal("active");
      r.t = 5000;
      r.seek.tick();
      expect(r.seek.state).to.equal("idle");
      expect(r.cancels[0]).to.match(/lost sight of the cup/);
      expect(r.seek.result.kind).to.equal("lost");
    });

    it("a plan that ends while the target is out of sight waits up to 2 s, then ends (it does not burn rounds)", () => {
      const r = rig({ target: { z: 3 } });
      r.seek.begin({ kind: "goto", label: "cup" });
      const p = r.plan();
      r.start(p);
      r.target = null;
      r.t = 500;
      r.ai("done", p);
      expect(r.submits).to.have.length(0);
      expect(r.seek.state).to.equal("active");
      r.t = 2600;
      r.seek.tick();
      expect(r.seek.state).to.equal("idle");
      expect(r.notices.join(" ")).to.match(/lost sight/);
      expect(r.submits).to.have.length(0);
      // seen again in time: it carries on
      const q = rig({ target: { z: 3 } });
      q.seek.begin({ kind: "goto", label: "cup" });
      const p2 = q.plan();
      q.start(p2);
      const t0 = q.target;
      q.target = null;
      q.t = 500;
      q.ai("done", p2);
      q.target = t0;
      q.t = 900;
      q.seek.tick();
      expect(q.submits).to.deep.equal(["go to the cup"]);
    });

    it("STOP, takeover and a chip all end it for good, and nothing is submitted afterwards", () => {
      const stop = rig();
      stop.seek.begin({ kind: "goto", label: "cup" });
      const p = stop.plan();
      stop.start(p);
      stop.seek.cancel("stop");
      expect(stop.seek.state).to.equal("idle");
      stop.ai("done", p);
      stop.seek.tick();
      expect(stop.submits).to.deep.equal([]);
      expect(stop.cancels).to.deep.equal([]); // STOP already did the cancelling
      expect(stop.seek.result.kind).to.equal("cancelled");

      const take = rig();
      take.seek.begin({ kind: "goto", label: "cup" });
      const q = take.plan();
      take.start(q);
      take.ai("interrupted", q); // "You took the controls."
      expect(take.seek.state).to.equal("idle");
      take.ai("done", q);
      expect(take.submits).to.deep.equal([]);

      const chip = rig();
      chip.seek.begin({ kind: "goto", label: "cup" });
      const c1 = chip.plan();
      chip.start(c1);
      chip.ai("thinking", c1); // a chip or a message: the ai pilot starts thinking at once
      expect(chip.seek.state).to.equal("idle");
      chip.ai("ready", chip.plan());
      chip.ai("done", c1);
      expect(chip.submits).to.deep.equal([]);

      const swap = rig();
      swap.seek.begin({ kind: "goto", label: "cup" });
      swap.start(swap.plan());
      swap.ai("running", swap.plan()); // a different plan is running and it is not ours
      expect(swap.seek.state).to.equal("idle");
    });

    it("an obstacle at the target's distance is the target: 'I'm next to the cup.'", () => {
      const r = rig({ target: { z: 1.0 } });
      r.seek.begin({ kind: "goto", label: "cup" });
      const p = r.plan();
      r.start(p);
      r.obstacle = { state: "blocked", distanceM: 0.9 }; // 0.9 m from the front, 0.08 m in front of the centre
      r.seek.tick();
      expect(r.seek.state).to.equal("idle");
      expect(r.cancels).to.deep.equal(["I'm next to the cup."]);
      // the controller may have held the plan first: then the ai says interrupted and we still report the arrival
      const h = rig({ target: { z: 1.0 } });
      h.seek.begin({ kind: "goto", label: "cup" });
      const hp = h.plan();
      h.start(hp);
      h.obstacle = { state: "blocked", distanceM: 0.9 };
      h.ai("interrupted", hp);
      expect(h.notices).to.deep.equal(["I'm next to the cup."]);
      // an obstacle that is something else just ends the seek, the controller already told the user
      const o = rig({ target: { z: 2.0 } });
      o.seek.begin({ kind: "goto", label: "cup" });
      const op = o.plan();
      o.start(op);
      o.obstacle = { state: "blocked", distanceM: 0.3 };
      o.seek.tick();
      expect(o.seek.state).to.equal("active");
      o.ai("interrupted", op);
      expect(o.seek.state).to.equal("idle");
      expect(o.notices).to.deep.equal([]);
      expect(o.cancels).to.deep.equal([]);
    });

    it("find: cancels the scan the moment the thing is seen, with where it is", () => {
      const r = rig({ target: null });
      r.seek.begin({ kind: "find", label: "cup" });
      const p = r.plan();
      r.start(p);
      r.t = 3000;
      r.seek.tick();
      expect(r.seek.state).to.equal("active");
      r.target = { label: "cup", located: true, x: 0.7, z: 0.7 };
      r.seek.tick();
      expect(r.seek.state).to.equal("idle");
      expect(r.cancels).to.have.length(1);
      expect(r.cancels[0]).to.match(/^I found the cup \(about 1 m ahead-left\)\.$/);
      expect(r.seek.result.kind).to.equal("found");
    });

    it("find: seen before the plan even starts (waiting for ARM) is answered at once; a full scan without it says so", () => {
      const r = rig({ target: null });
      r.seek.begin({ kind: "find", label: "cup" });
      r.ai("ready", r.plan());
      r.target = { label: "cup", located: true, x: 0, z: 2 };
      r.seek.tick();
      expect(r.seek.state).to.equal("idle");
      expect(r.cancels[0]).to.match(/I found the cup/);

      const q = rig({ target: null });
      q.seek.begin({ kind: "find", label: "cup" });
      const p = q.plan();
      q.start(p);
      q.ai("done", p);
      expect(q.seek.state).to.equal("idle");
      expect(q.notices.join(" ")).to.match(/could not find the cup/);
      expect(q.submits).to.deep.equal([]);
    });

    it("find: when seen but not located it still says where, by bearing from the camera", () => {
      const r = rig({ target: null });
      r.seek.begin({ kind: "find", label: "cup" });
      r.start(r.plan());
      r.target = { label: "cup", located: false, bearingCam: 25 };
      r.seek.tick();
      expect(r.cancels[0]).to.match(/I found the cup \(ahead-left\)/);
    });

    it("a new begin() from the user replaces the old seek quietly; begin() during a continuation does not", () => {
      const r = rig();
      r.seek.begin({ kind: "goto", label: "cup" });
      r.start(r.plan());
      r.seek.begin({ kind: "find", label: "cup" });
      expect(r.seek.state).to.equal("pending");
      expect(r.seek.intent).to.deep.equal({ kind: "find", label: "cup" });
      expect(r.cancels).to.deep.equal([]);
      expect(r.notices).to.deep.equal([]);
    });

    it("a continuation that does not start (not armed any more, nothing to run) ends with a note", () => {
      const r = rig({ target: { z: 4 } });
      r.seek.begin({ kind: "goto", label: "cup" });
      const p = r.plan();
      r.start(p);
      r.ai("done", p);
      expect(r.submits).to.have.length(1);
      r.ai("thinking", null);
      r.ai("ready", { id: 99, blocked: "arm" }); // ARM first: the plan waits for a human
      expect(r.seek.state).to.equal("idle");
      expect(r.notices.join(" ")).to.match(/couldn't|could not|did not/i);
      // a plan that stays "ready" for no stated reason is given 1.5 s
      const w = rig({ target: { z: 4 } });
      w.seek.begin({ kind: "goto", label: "cup" });
      const wp = w.plan();
      w.start(wp);
      w.ai("done", wp);
      w.ai("thinking", null);
      w.ai("ready", w.plan());
      w.t = 1400;
      w.seek.tick();
      expect(w.seek.state).to.equal("active");
      w.t = 1600;
      w.seek.tick();
      expect(w.seek.state).to.equal("idle");
      const q = rig({ target: { z: 4 } });
      q.seek.begin({ kind: "goto", label: "cup" });
      const p2 = q.plan();
      q.start(p2);
      q.ai("done", p2);
      q.ai("thinking", null);
      q.ai("idle", null);
      expect(q.seek.state).to.equal("idle");
    });

    it("runs its own check every 250 ms while it is waiting or active, and not otherwise", () => {
      const timers = new Set();
      const clock = { now: () => 0, setInterval: (fn, ms) => (timers.add({ fn, ms }), [...timers].pop()), clearInterval: (h) => timers.delete(h) };
      const seek = SK.createSeek({ now: () => 0, clock, world: { find: () => null }, getRover: () => ORIGIN, submit() {}, cancelPlan() {}, notice() {} });
      expect(timers.size).to.equal(0);
      seek.begin({ kind: "find", label: "cup" });
      expect(timers.size).to.equal(1);
      expect([...timers][0].ms).to.equal(250);
      seek.cancel("stop");
      expect(timers.size).to.equal(0);
    });

    it("hostile intents are refused: unknown kind, non-COCO label", () => {
      const r = rig();
      r.seek.begin({ kind: "goto", label: "<img>" });
      expect(r.seek.state).to.equal("idle");
      r.seek.begin({ kind: "format-disk", label: "cup" });
      expect(r.seek.state).to.equal("idle");
      r.seek.begin(null);
      expect(r.seek.state).to.equal("idle");
    });

    it("limits are the documented ones", () => {
      expect(SK.LIMITS).to.include({ ROUNDS: 5, DEADLINE_MS: 45000, LOST_MS: 2000 });
      expect(SK.LIMITS.ARRIVE_M).to.be.within(0.3, 0.4);
    });
  });

  // ---------------------------------------------------------------- end to end with the real ai pilot
  describe("with the real ai pilot, executor, drive loop and twin", () => {
    const aiSrc = fs.readFileSync(path.join(__dirname, "..", "web", "js", "pilot", "ai", "ai-pilot.js"), "utf8");
    it("ai-pilot.js has the parse hook these tests rely on", () => expect(aiSrc).to.match(/parse\s*=\s*parseCommand/));
    function fakeClock() {
      let t = 0;
      let id = 0;
      const timers = new Set();
      const add = (fn, ms, rep) => {
        const h = { fn, ms: Math.max(1, ms), next: t + Math.max(1, ms), rep, id: ++id };
        timers.add(h);
        return h;
      };
      const flush = () => new Promise((r) => setImmediate(r));
      return {
        now: () => t,
        setInterval: (fn, ms) => add(fn, ms, true),
        setTimeout: (fn, ms) => add(fn, ms, false),
        clearInterval: (h) => timers.delete(h),
        clearTimeout: (h) => timers.delete(h),
        async advance(ms) {
          const end = t + ms;
          for (;;) {
            let due = null;
            for (const h of timers) if (h.next <= end && (!due || h.next < due.next || (h.next === due.next && h.id < due.id))) due = h;
            if (!due) break;
            t = due.next;
            if (due.rep) due.next += due.ms;
            else timers.delete(due);
            due.fn();
            await flush();
          }
          t = end;
          await flush();
        },
      };
    }

    async function build({ arm = true } = {}) {
      const clock = fakeClock();
      const tr = TT.createTwinTransport({ body: P.bodyByKey("rover"), clock, latencyMs: 0 });
      let n = 0;
      let ai = null;
      const loop = D.createDriveLoop({ transport: tr, clock, nonce: () => ++n, onChange: (s) => ai && ai.onLoopChange(s) });
      await loop.connect();
      if (arm) {
        expect(await loop.arm()).to.equal(true);
        await clock.advance(150);
      }
      loop.setSpeed(60);
      const world = W.createWorldObjects();
      const rover = { x: 0, z: 0, yaw: 0 };
      const notices = [];
      let seek = null;
      const vi = VI.createVisionIntents({ world, getRover: () => rover, getViewMode: () => "xr", seek: { get internal() { return seek.internal; }, begin: (i) => seek.begin(i), cancel: (r) => seek.cancel(r) }, now: () => clock.now() });
      const parse = (text, bodyKey, opts) => vi.extension(text, bodyKey, { opts }) ?? G.parseCommand(text, bodyKey, opts);
      ai = AP.createAiPilot({ getLoop: () => loop, getBodyKey: () => "rover", getMode: () => "twin", clock, parse, onChange: (v) => seek && seek.onAiChange(v) });
      seek = SK.createSeek({
        now: () => clock.now(),
        clock,
        world,
        getRover: () => rover,
        submit: (text) => ai.submit(text),
        cancelPlan: (m) => ai.cancel(m),
        notice: (m) => notices.push(m),
      });
      return { clock, loop, ai, seek, world, rover, notices, vi };
    }

    it("go to the cup: plan, run, re-plan, arrive; every wheel lease is 3 s or less; STOP wins", async () => {
      const r = await build();
      const leases = [];
      const hold = r.loop.holdFor;
      r.loop.holdFor = (ms, x, y) => (leases.push(ms), hold(ms, x, y));
      const keep = () => r.world.update([det("cup", 0.5)], r.clock.now(), depthCtx(2.0));
      keep();
      await r.ai.submit("go to the cup");
      expect(r.ai.state).to.equal("running");
      expect(r.ai.view.plan.steps.map((s) => s.tool)).to.deep.equal(["say", "drive"]);
      expect(r.seek.state).to.equal("active");
      // the twin's odometry is the controller's job: here the rover advances 5 cm per 250 ms while the wheels turn forward
      for (let i = 0; i < 120 && r.seek.state !== "idle"; i++) {
        keep();
        await r.clock.advance(250);
        const w = r.loop.snapshot.wheels;
        if (w[0] + w[1] > 0) r.rover.z += 0.05;
      }
      expect(r.seek.state).to.equal("idle");
      expect(r.seek.result.kind).to.equal("arrived");
      expect(r.seek.result.rounds).to.be.within(2, 5); // 1.7 m to go at 3 s per plan: it had to look again
      expect(leases.length).to.be.greaterThan(1);
      for (const ms of leases) expect(ms).to.be.at.most(3000);
      await r.clock.advance(500);
      expect(r.ai.view.messages.map((m) => m.text || "").join("|")).to.match(/next to the cup/);
      expect(r.loop.snapshot.wheels).to.deep.equal([0, 0]);
      expect(r.loop.link).to.equal(D.LINK.ARMED); // it never latched, and it never armed anything by itself
    });

    it("find: the scan stops when the thing appears, and STOP ends a seek", async () => {
      const r = await build();
      await r.ai.submit("find the cup");
      expect(r.ai.state).to.equal("running");
      expect(r.seek.state).to.equal("active");
      await r.clock.advance(2500);
      r.world.update([det("cup", 0.5)], r.clock.now(), depthCtx(1.5));
      await r.clock.advance(300);
      expect(r.seek.state).to.equal("idle");
      expect(r.seek.result.kind).to.equal("found");
      expect(r.ai.state).to.equal("interrupted");
      expect(r.loop.snapshot.wheels).to.deep.equal([0, 0]);
      expect(r.ai.view.messages.map((m) => m.text || "").join("|")).to.match(/I found the cup/);

      const s = await build();
      await s.ai.submit("find the chair");
      await s.clock.advance(1000);
      s.ai.cancel("stop");
      s.seek.cancel("stop");
      await s.clock.advance(60000);
      expect(s.seek.state).to.equal("idle");
      expect(s.loop.snapshot.wheels).to.deep.equal([0, 0]);
    });

    it("not armed: go to the cup waits for ARM, the seek has not started, and nothing moves", async () => {
      const r = await build({ arm: false });
      r.world.update([det("cup", 0.5)], r.clock.now(), depthCtx(2));
      await r.ai.submit("go to the cup");
      expect(r.ai.state).to.equal("ready");
      expect(r.ai.view.plan.blocked).to.equal("arm");
      expect(r.seek.state).to.equal("pending");
      await r.clock.advance(60000);
      expect(r.seek.state).to.equal("pending");
      expect(r.loop.snapshot.wheels).to.deep.equal([0, 0]);
      await r.ai.submit("what do you see"); // another message: the pending seek is dropped
      expect(r.seek.state).to.equal("idle");
    });

    it("what do you see runs without ARM (a say-only plan)", async () => {
      const r = await build({ arm: false });
      r.world.update([det("cup", 0.5)], r.clock.now(), depthCtx(1.5));
      await r.ai.submit("what do you see");
      await r.clock.advance(100);
      expect(r.ai.view.plan.status).to.equal("done");
      expect(r.ai.view.messages.map((m) => m.text || "").join("|")).to.match(/I see a cup/);
    });
  });

  // ---------------------------------------------------------------- source rules
  describe("source rules", () => {
    const files = ["vision/detector.js", "vision/xr-camera.js", "vision/world-objects.js", "vision/vision-intents.js", "seek.js"];
    const GUARDED = new Set(["vision/detector.js"]); // names XMLHttpRequest only to block it
    const read = (f) => fs.readFileSync(path.join(__dirname, "..", "web", "js", "ar", f), "utf8");
    const code = (f) => read(f).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

    it("no markup sinks, no network, no eval, no camera or arming in any phase 2 file", () => {
      for (const f of files) {
        const c = code(f);
        expect(c, f).to.not.match(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|createContextualFragment|\beval\s*\(|new Function|importScripts/);
        expect(c, f).to.not.match(/\bfetch\s*\(|WebSocket|sendBeacon|EventSource|new XMLHttpRequest|\.send\s*\(/);
        if (!GUARDED.has(f)) expect(c, f).to.not.match(/XMLHttpRequest/);
        expect(c, f).to.not.match(/getUserMedia/);
        expect(c, f).to.not.match(/\.arm\s*\(/);
        expect(c, f).to.not.match(/https?:\/\//);
        expect(c, f).to.not.match(/localStorage|sessionStorage|document\.cookie/);
      }
    });

    it("the pure files import nothing from three, the DOM or the vendored bundle", () => {
      for (const f of ["vision/world-objects.js", "vision/vision-intents.js", "seek.js"]) {
        const c = code(f);
        expect(c, f).to.not.match(/from\s+["']three/);
        expect(c, f).to.not.match(/\b(window|document|navigator|HTMLElement)\b/);
        expect(c, f).to.not.match(/vendor\/mediapipe/);
      }
    });

    it("plans are built only from say, turn, drive and wait", () => {
      const c = code("vision/vision-intents.js");
      for (const bad of ["set_joints", "gesture", "pose", "torso", "look", "stop"]) expect(c, bad).to.not.match(new RegExp(`["']${bad}["']`));
      expect(c).to.include("validatePlan");
    });

    it("the speed constant matches the twin's", async () => {
      let TP = null;
      try {
        TP = await import("../web/js/pilot/twin-pose.js");
      } catch {
        return; // builder A's file is not there yet
      }
      expect(VI.VMAX).to.equal(TP.VMAX);
    });
  });
});
