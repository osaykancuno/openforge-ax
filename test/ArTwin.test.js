const { expect } = require("chai");
const assert = require("node:assert/strict"); // hot loops use plain asserts: chai matchers are slow in a 180-step comparison
const fs = require("node:fs");
const path = require("node:path");

// AX-1 in your room (AR Rover twin): the pure logic behind web/ar.html. Odometry shared with the Pilot page
// (web/js/pilot/twin-pose.js), capability probe, chips, the AR parser, depth obstacle sensing, orientation maths and the
// controller (state machine, STOP, guarded drive loop). No DOM, no three: the same fake clock and real twin bridge as the
// AI Pilot tests, so every motion still goes drive loop -> twin transport -> bridge-sim.
describe("AR Rover twin: odometry, caps, chips, parser, obstacles, orientation, controller", () => {
  let P, D, TT, AP, TL, GR, EX, TP, CAPS, CH, ARP, OB, OR, AC;
  before(async () => {
    P = await import("../web/js/pilot/ax-proto.js");
    D = await import("../web/js/pilot/drive-loop.js");
    TT = await import("../web/js/pilot/twin-transport.js");
    AP = await import("../web/js/pilot/ai/ai-pilot.js");
    TL = await import("../web/js/pilot/ai/tools.js");
    GR = await import("../web/js/pilot/ai/grammar.js");
    EX = await import("../web/js/pilot/ai/executor.js");
    TP = await import("../web/js/pilot/twin-pose.js");
    CAPS = await import("../web/js/ar/ar-caps.js");
    CH = await import("../web/js/ar/chips.js");
    ARP = await import("../web/js/ar/ar-parse.js");
    OB = await import("../web/js/ar/obstacle.js");
    OR = await import("../web/js/ar/orientation.js");
    AC = await import("../web/js/ar/ar-controller.js");
  });

  const RLO = String.fromCharCode(0x202e); // right-to-left override: a bidi spoofing character
  const ZW = String.fromCharCode(0x200b); // zero-width space
  const NUL = String.fromCharCode(0);
  const root = path.join(__dirname, "..");
  const read = (p) => fs.readFileSync(path.join(root, p), "utf8");
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
  const near = (a, b, tol, msg) => expect(Math.abs(a - b), `${msg || ""} ${a} vs ${b}`).to.be.at.most(tol);

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

  // ================================================================ odometry (twin-pose.js)
  describe("twin-pose: odometry shared by the Pilot page and the AR page", () => {
    const run = (l, r, secs, opts = {}, pose = { x: 0, z: 0, yaw: 0 }) => {
      let clamped = false;
      for (let i = 0; i < Math.round(secs * 60); i++) clamped = TP.stepPose(pose, l, r, 1 / 60, opts) || clamped;
      return { pose, clamped };
    };

    it("constants match the twin", () => {
      expect(TP.VMAX).to.equal(0.35);
      expect(TP.TRACK).to.equal(0.2);
      expect(TP.FRONT).to.equal(0.08);
    });

    it("1 s at full speed moves 0.35 m straight ahead", () => {
      const { pose, clamped } = run(1000, 1000, 1);
      near(pose.z, 0.35, 1e-9);
      near(pose.x, 0, 1e-9);
      near(pose.yaw, 0, 1e-12);
      expect(clamped).to.equal(false);
    });

    it("1 s of full counter-rotation spins 3.5 rad and does not translate", () => {
      const { pose } = run(-1000, 1000, 1);
      near(pose.yaw, 3.5, 1e-9);
      near(Math.hypot(pose.x, pose.z), 0, 1e-9);
      const left = run(1000, -1000, 1).pose;
      near(left.yaw, -3.5, 1e-9); // l > r turns clockwise (yaw down), as the Pilot twin always did
    });

    it("backwards moves back; a 5 s run reaches the radius, is clamped to it and says so", () => {
      near(run(-1000, -1000, 1).pose.z, -0.35, 1e-9);
      const { pose, clamped } = run(1000, 1000, 10, { radius: 1.6 });
      expect(clamped).to.equal(true);
      near(Math.hypot(pose.x, pose.z), 1.6, 1e-9);
    });

    it("at the edge a pure turn is not 'clamped'; moving back in is not either", () => {
      const pose = { x: 0, z: 1.6, yaw: 0.3 };
      TP.stepPose(pose, 1000, 1000, 0.5, { radius: 1.6 });
      expect(Math.hypot(pose.x, pose.z)).to.be.at.most(1.6 + 1e-12);
      for (let i = 0; i < 120; i++) expect(TP.stepPose(pose, -1000, 1000, 1 / 60, { radius: 1.6 })).to.equal(false);
      const back = { x: 0, z: 1.6, yaw: Math.PI };
      expect(TP.stepPose(back, 1000, 1000, 0.1, { radius: 1.6 })).to.equal(false); // heading inward
    });

    it("no radius: never clamps; mutates and returns a boolean (no allocation)", () => {
      const pose = { x: 0, z: 0, yaw: 0 };
      const same = pose;
      const r = TP.stepPose(pose, 1000, 1000, 100); // absurd dt
      expect(r).to.equal(false);
      expect(pose).to.equal(same);
      expect(pose.z).to.be.greaterThan(30);
    });

    it("composePose puts local odometry under a placement; faceToward gives the yaw", () => {
      const c = TP.composePose({ x: 1, y: 0.5, z: 2, yaw: Math.PI / 2 }, { x: 0, z: 1, yaw: 0.25 });
      near(c.x, 2, 1e-12);
      near(c.z, 2, 1e-12);
      expect(c.y).to.equal(0.5);
      near(c.yaw, Math.PI / 2 + 0.25, 1e-12);
      const id = TP.composePose({ x: 3, y: 0, z: 4, yaw: 0 }, { x: 1, z: 2, yaw: 0 });
      expect([id.x, id.z]).to.deep.equal([4, 6]);
      near(TP.faceToward({ x: 0, z: 0 }, { x: 0, z: 1 }), 0, 1e-12);
      near(TP.faceToward({ x: 0, z: 0 }, { x: 1, z: 0 }), Math.PI / 2, 1e-12);
      near(TP.faceToward({ x: 1, z: 1 }, { x: 0, z: 2 }), -Math.PI / 4, 1e-12);
    });

    it("wheelsFromState reads a real twin snapshot; other bodies and no state give zeros", async () => {
      const clock = fakeClock();
      const tr = TT.createTwinTransport({ body: P.bodyByKey("rover"), clock, latencyMs: 0 });
      let n = 0;
      const loop = D.createDriveLoop({ transport: tr, clock, nonce: () => ++n });
      await loop.connect();
      expect(await loop.arm()).to.equal(true);
      await clock.advance(150);
      expect(TP.wheelsFromState(loop.snapshot.state, P.bodyByKey("rover"))).to.deep.equal([0, 0]);
      loop.setSpeed(100);
      expect(loop.holdFor(1000, 0, 1)).to.equal(true);
      await clock.advance(500);
      const [l, r] = TP.wheelsFromState(loop.snapshot.state, P.bodyByKey("rover"));
      expect(l).to.be.greaterThan(0);
      expect(r).to.equal(l);
      loop.setHeld(false);
      expect(TP.wheelsFromState(null, P.bodyByKey("rover"))).to.deep.equal([0, 0]);
      expect(TP.wheelsFromState({ positions: [1, 2] }, P.bodyByKey("desk"))).to.deep.equal([0, 0]);
      expect(TP.wheelsFromState({ positions: [] }, P.bodyByKey("rover"))).to.deep.equal([0, 0]);
    });

    function fakeRig() {
      const rig = { set: [], spin: [], group: { position: { x: 0, y: 0, z: 0, set(x, y, z) { this.x = x; this.y = y; this.z = z; } }, rotation: { y: 0 } } };
      rig.setSpin = (n, v) => rig.spin.push([n, v]);
      rig.setJoint = null;
      rig.set = (n, v) => (rig._sets.push([n, v]), undefined);
      rig._sets = [];
      return rig;
    }

    it("applyTwinState sets joints (deci -> deg), wheel spins and the pose, exactly as the Pilot page did", () => {
      const body = P.bodyByKey("rover");
      const names = P.stateChannels(body); // head_pan, head_tilt, drive_l, drive_r
      const states = [
        { positions: [300, -100, 800, 800] },
        { positions: [0, 0, -600, 600] },
        { positions: [0, 0, 1000, 1000] },
        { positions: [-900, 300, 1000, 400] },
      ];
      const rig = fakeRig();
      const pose = { x: 0, z: 0, yaw: 0 };
      const ref = { x: 0, z: 0, yaw: 0 };
      let edge = 0;
      for (let i = 0; i < 180; i++) {
        const st = i < 60 ? states[2] : states[(i >> 3) % states.length]; // 6 s of full speed first: the mat's edge
        const dt = 0.1;
        rig._sets.length = 0;
        rig.spin.length = 0;
        TP.applyTwinState(rig, { body, state: st }, body, pose, dt, { radius: 1.6 });
        // reference: the code that lived in pilot.js applyState
        const l = st.positions[names.indexOf("drive_l")] || 0;
        const r = st.positions[names.indexOf("drive_r")] || 0;
        const v = ((l + r) / 2000) * 0.35;
        const w = ((r - l) / 1000) * (0.35 / 0.2);
        ref.yaw += w * dt;
        ref.x += Math.sin(ref.yaw) * v * dt;
        ref.z += Math.cos(ref.yaw) * v * dt;
        const d = Math.hypot(ref.x, ref.z);
        if (d > 1.6) (ref.x *= 1.6 / d), (ref.z *= 1.6 / d), edge++;
        assert.deepEqual([pose.x, pose.z, pose.yaw], [ref.x, ref.z, ref.yaw]);
        assert.deepEqual([rig.group.position.x, rig.group.position.z, rig.group.rotation.y], [ref.x, ref.z, ref.yaw]);
        assert.deepEqual(rig._sets, [["head_pan", st.positions[0] / 10], ["head_tilt", st.positions[1] / 10]]);
        assert.deepEqual(rig.spin, [["wheel-l", (l / 1000) * 1.1], ["wheel-r", (r / 1000) * 1.1]]);
      }
      expect(edge, "the run reached the edge of the mat").to.be.greaterThan(0);
    });

    it("applyTwinState with dt 0 only writes the pose; a snapshot of another body stops the wheels; no state does nothing", () => {
      const body = P.bodyByKey("rover");
      const rig = fakeRig();
      const pose = { x: 0.5, z: -0.2, yaw: 1 };
      TP.applyTwinState(rig, { body, state: { positions: [0, 0, 1000, 1000] } }, body, pose, 0, { radius: 3 });
      expect(pose).to.deep.equal({ x: 0.5, z: -0.2, yaw: 1 });
      expect(rig.group.position.x).to.equal(0.5);
      expect(rig.group.rotation.y).to.equal(1);
      rig.spin.length = 0;
      TP.applyTwinState(rig, { body: P.bodyByKey("desk"), state: { positions: [] } }, body, pose, 0.1, { radius: 3 });
      expect(rig.spin).to.deep.equal([["wheel", 0]]);
      rig.spin.length = 0;
      expect(TP.applyTwinState(rig, null, body, pose, 0.1, { radius: 3 })).to.equal(false);
      expect(TP.applyTwinState(null, { body, state: { positions: [0, 0, 0, 0] } }, body, pose, 0.1, {})).to.equal(false);
    });

    it("pilot.js uses the shared odometry and keeps its 1.6 m mat; the AI hook is the only ai-pilot change", () => {
      const src = read("web/js/pilot/pilot.js");
      expect(src).to.match(/from "\.\/twin-pose\.js"/);
      expect(src).to.match(/applyTwinState\(/);
      expect(src).to.not.match(/const VMAX/);
      expect(src).to.not.match(/const TRACK/);
      expect(src).to.match(/const ARENA = 1\.6/);
      const ai = strip(read("web/js/pilot/ai/ai-pilot.js"));
      expect(ai).to.match(/parse = parseCommand/);
      expect(ai).to.match(/parse\(clean, bodyKey, \{ userSpeed \}\)/);
    });

    it("twin-pose.js is pure: no DOM, no three, no network", () => {
      const src = strip(read("web/js/pilot/twin-pose.js"));
      expect(src).to.not.match(/\bimport\b[^;]*\bthree\b|document\.|window\.|fetch|innerHTML/);
    });
  });

  // ================================================================ caps
  describe("ar-caps: what this phone can do", () => {
    const android = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/126.0 Mobile Safari/537.36";
    const iphone = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 Version/17.5 Mobile/15E148 Safari/604.1";
    const win = (extra = {}) => ({ isSecureContext: true, webkitSpeechRecognition: function () {}, matchMedia: () => ({ matches: true }), ...extra });
    const nav = (ua, extra = {}) => ({ userAgent: ua, platform: "", maxTouchPoints: 5, mediaDevices: { getUserMedia: () => {} }, ...extra });

    it("Android with immersive-ar: xr", async () => {
      const c = await CAPS.probeAr({ nav: nav(android, { xr: { isSessionSupported: async (m) => m === "immersive-ar" } }), win: win() });
      expect(c).to.include({ mode: "xr", secure: true, ios: false, voice: true, orientationNeedsPermission: false });
      expect(c.why).to.be.a("string").and.not.equal("");
    });

    it("iPhone (no immersive-ar): camera view, needs the orientation permission, no voice without the API", async () => {
      const DeviceOrientationEvent = { requestPermission: async () => "granted" };
      const c = await CAPS.probeAr({ nav: nav(iphone), win: win({ DeviceOrientationEvent, webkitSpeechRecognition: undefined }) });
      expect(c).to.include({ mode: "camera", ios: true, voice: false, orientationNeedsPermission: true });
    });

    it("an iPad that says Macintosh counts as iOS and as a phone", async () => {
      const c = await CAPS.probeAr({ nav: nav("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", { platform: "MacIntel" }), win: win({ matchMedia: () => ({ matches: false }) }) });
      expect(c.ios).to.equal(true);
      expect(c.mode).to.equal("camera");
    });

    it("isSessionSupported false, rejecting or throwing: falls back to the camera view", async () => {
      for (const isSessionSupported of [async () => false, async () => { throw new Error("nope"); }, () => { throw new Error("sync"); }, () => new Promise((_, rej) => rej(new Error("late")))]) {
        const c = await CAPS.probeAr({ nav: nav(android, { xr: { isSessionSupported } }), win: win() });
        expect(c.mode).to.equal("camera");
      }
    });

    it("a desktop browser is 'desktop' even when WebXR AR is there", async () => {
      const c = await CAPS.probeAr({
        nav: { userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/126", platform: "Win32", maxTouchPoints: 0, xr: { isSessionSupported: async () => true }, mediaDevices: { getUserMedia: () => {} } },
        win: { isSecureContext: true, matchMedia: () => ({ matches: false }) },
      });
      expect(c.mode).to.equal("desktop");
      expect(c.why).to.match(/phone/i);
    });

    it("a phone on an insecure page gets 'none' and the reason names HTTPS", async () => {
      const c = await CAPS.probeAr({ nav: nav(android, { xr: { isSessionSupported: async () => true } }), win: win({ isSecureContext: false }) });
      expect(c.mode).to.equal("none");
      expect(c.secure).to.equal(false);
      expect(c.why).to.match(/HTTPS/);
    });

    it("a phone with no camera API and no WebXR: none", async () => {
      const c = await CAPS.probeAr({ nav: nav(android, { mediaDevices: undefined }), win: win() });
      expect(c.mode).to.equal("none");
    });

    it("never throws on missing or empty objects", async () => {
      expect((await CAPS.probeAr({ nav: {}, win: {} })).mode).to.be.oneOf(["desktop", "none"]);
      expect((await CAPS.probeAr({ nav: null, win: null })).mode).to.be.oneOf(["desktop", "none"]);
      expect((await CAPS.probeAr()).mode).to.be.a("string"); // Node: no navigator at all
    });
  });

  // ================================================================ chips
  describe("chips: seven tap-to-say buttons", () => {
    it("ids, labels and phrases are unique plain strings; STOP is not a chip", () => {
      expect(CH.CHIPS.map((c) => c.id)).to.deep.equal(["forward", "back", "left", "right", "spin", "curious", "wiggle"]);
      expect(new Set(CH.CHIPS.map((c) => c.id)).size).to.equal(CH.CHIPS.length);
      for (const c of CH.CHIPS) {
        expect(c.label).to.be.a("string").and.not.equal("");
        expect(c.say).to.be.a("string").and.not.equal("");
        expect(c.say).to.not.match(/\bstop\b/i);
        expect(CH.chipText(c.id)).to.equal(c.say);
      }
      expect(CH.chipText("stop")).to.equal(null);
      expect(CH.chipText("__proto__")).to.equal(null);
      expect(CH.chipText(undefined)).to.equal(null);
      expect(CH.CHIPS.find((c) => c.id === "left").say).to.equal("turn left 45");
    });

    it("every phrase parses fully for the Rover: steps, no unknown words, within 30 s", () => {
      for (const c of CH.CHIPS) {
        const g = GR.parseCommand(c.say, "rover", { userSpeed: 60 });
        expect(g.steps.length, c.id).to.be.greaterThan(0);
        expect(g.unknown, c.id).to.deep.equal([]);
        expect(g.say, c.id).to.equal("");
        expect(g.rejected, c.id).to.deep.equal([]);
        const secs = g.steps.reduce((t, s) => t + TL.stepSeconds(s, 60), 0);
        expect(secs, c.id).to.be.at.most(30);
        expect(g.steps.every((s) => ["drive", "turn", "look", "wait"].includes(s.tool)), c.id).to.equal(true);
      }
    });

    it("the spin chip is two 180 turns; the curious chip looks left, right, up, centre", () => {
      const spin = GR.parseCommand(CH.chipText("spin"), "rover").steps;
      expect(spin.map((s) => [s.tool, s.degrees])).to.deep.equal([["turn", 180], ["turn", 180]]);
      const cur = GR.parseCommand(CH.chipText("curious"), "rover").steps;
      expect(cur.map((s) => s.tool)).to.deep.equal(["look", "look", "look", "look"]);
    });
  });

  // ================================================================ ar-parse
  describe("ar-parse: parser with obstacle filter and extensions", () => {
    const corpus = [
      "forward", "forward 2 s", "go forward slowly", "back 1 s then turn right", "turn left 45", "turn left 180 then turn left 180",
      "look left then look right then look up then look center", "turn left 30 then turn right 60 then turn left 30", "spin", "wave", "hello",
      "nod", "sing me a song", "stop", "", "   ", "forward 5 meters", "turn around", "drive forward 3 s then wait 2 then back 3 s", "go left",
      "forward 99 s", "speed 30 then forward 2", "forward, back, forward, back, forward, back, forward, back, forward, back, forward, back, forward, back",
      "look 90 degrees left", "reverse", "AX-1 please move forward", "forward and left", "turn left and wait", "freeze",
    ];

    it("with no obstacle and no extension the output deep-equals parseCommand over a corpus (any userSpeed)", () => {
      const parse = ARP.createArParser({ getBlocked: () => null, getMode: () => "xr" });
      for (const text of corpus) {
        for (const userSpeed of [undefined, 60, 100, 20]) {
          expect(parse(text, "rover", { userSpeed }), `${JSON.stringify(text)} @${userSpeed}`).to.deep.equal(GR.parseCommand(text, "rover", { userSpeed }));
        }
      }
      expect(parse("forward", "rover")).to.deep.equal(GR.parseCommand("forward", "rover", {}));
      expect(parse("forward", "nonsense", {})).to.deep.equal(GR.parseCommand("forward", "nonsense", {}));
    });

    const blocked = { distanceM: 0.3, message: "Something is in my way (about 30 cm ahead)." };

    it("blocked: forward drives are dropped with the honest note; turns, back and looks stay", () => {
      const parse = ARP.createArParser({ getBlocked: () => blocked, getMode: () => "xr" });
      const r = parse("forward 2 s then turn left 45 then back 1 s then look up", "rover", { userSpeed: 60 });
      expect(r.steps.map((s) => s.tool + (s.direction ? `:${s.direction}` : ""))).to.deep.equal(["turn", "drive:back", "look"]);
      expect(r.say).to.contain("Something is in my way (about 30 cm ahead). I can turn or back up.");
      const fl = parse("go forward and left", "rover", {});
      expect(fl.steps.some((s) => s.direction && s.direction.startsWith("forward"))).to.equal(false);
      const only = parse("forward 1", "rover", {});
      expect(only.steps).to.deep.equal([]);
      expect(only.say).to.contain("about 30 cm ahead");
    });

    it("blocked but nothing forward in the request: identical to parseCommand, no note", () => {
      const parse = ARP.createArParser({ getBlocked: () => blocked, getMode: () => "xr" });
      for (const t of ["back 1 s", "turn left 45", "look left", "wait 2", "wave"]) expect(parse(t, "rover", { userSpeed: 60 })).to.deep.equal(GR.parseCommand(t, "rover", { userSpeed: 60 }));
    });

    it("filterBlocked: exported helper", () => {
      expect(ARP.filterBlocked([{ tool: "drive", direction: "forward", seconds: 1 }], null)).to.deep.equal({ steps: [{ tool: "drive", direction: "forward", seconds: 1 }], note: "" });
      const f = ARP.filterBlocked([{ tool: "drive", direction: "forward_left", seconds: 1 }, { tool: "drive", direction: "back", seconds: 1 }, { tool: "say", text: "hi" }], { distanceM: 0.5 });
      expect(f.steps.map((s) => s.tool)).to.deep.equal(["drive", "say"]);
      expect(f.note).to.equal("Something is in my way (about 50 cm ahead). I can turn or back up.");
    });

    it("extensions run first, the first non-null wins, and the result is validated again", () => {
      const calls = [];
      const ctxs = [];
      const e1 = (t, b, ctx) => (calls.push("e1"), ctxs.push(ctx), t.includes("zap") ? { steps: [{ tool: "drive", direction: "forward", seconds: 99 }, { tool: "bogus" }, { tool: "say", text: `pew${RLO}` }], say: "zapped", unknown: [], rejected: [] } : null);
      const e2 = () => (calls.push("e2"), { steps: [{ tool: "stop" }], say: "second", unknown: [], rejected: [] });
      const parse = ARP.createArParser({ getBlocked: () => null, getMode: () => "camera", extensions: [e1, e2] });
      const r = parse("zap it", "rover", { userSpeed: 60 });
      expect(calls).to.deep.equal(["e1"]);
      expect(r.say).to.equal("zapped");
      expect(r.steps[0]).to.deep.include({ tool: "drive", direction: "forward", seconds: 3 });
      expect(r.steps.map((s) => s.tool)).to.not.include("bogus");
      expect(r.steps[1].text).to.equal("pew");
      expect(r.rejected.length).to.be.greaterThan(0);
      expect(ctxs[0].opts).to.deep.equal({ userSpeed: 60 });
      expect(ctxs[0].getMode()).to.equal("camera");
      expect(ctxs[0].getBlocked()).to.equal(null);
      // e1 passes, e2 answers
      calls.length = 0;
      expect(parse("hello there", "rover", {}).say).to.equal("second");
      expect(calls).to.deep.equal(["e1", "e2"]);
    });

    it("an extension result is filtered by the obstacle too, and a bad or throwing extension is skipped", () => {
      const ext = () => ({ steps: [{ tool: "turn", degrees: 30 }, { tool: "drive", direction: "forward", seconds: 2 }], say: "", unknown: [], rejected: [] });
      const parse = ARP.createArParser({ getBlocked: () => blocked, getMode: () => "xr", extensions: [ext] });
      expect(parse("go to the cup", "rover", {}).steps.map((s) => s.tool)).to.deep.equal(["turn"]);
      for (const bad of [() => { throw new Error("boom"); }, () => "string", () => 42, () => ({ steps: "no" }), () => undefined]) {
        const p = ARP.createArParser({ getBlocked: () => null, getMode: () => "xr", extensions: [bad] });
        expect(p("turn left 45", "rover", { userSpeed: 60 })).to.deep.equal(GR.parseCommand("turn left 45", "rover", { userSpeed: 60 }));
      }
    });

    it("invisible and bidi characters are stripped before any parser sees the text; non-strings do not throw", () => {
      let seen = null;
      const parse = ARP.createArParser({ getBlocked: () => null, getMode: () => "xr", extensions: [(t) => ((seen = t), null)] });
      const r = parse(`for${ZW}ward${RLO} 1 s${NUL}`, "rover", { userSpeed: 60 });
      expect(seen).to.equal("forward 1 s");
      expect(r).to.deep.equal(GR.parseCommand("forward 1 s", "rover", { userSpeed: 60 }));
      for (const x of [null, undefined, 5, {}, [] ]) expect(() => parse(x, "rover", {})).to.not.throw();
    });
  });

  // ================================================================ orientation
  describe("orientation: DeviceOrientation to a camera quaternion", () => {
    const q = (a, b, g, s = 0) => OR.orientationQuat(a, b, g, s);
    it("phone upright facing the horizon (beta 90) is the identity", () => {
      const r = q(0, 90, 0);
      near(r[0], 0, 1e-9); near(r[1], 0, 1e-9); near(r[2], 0, 1e-9); near(r[3], 1, 1e-9);
    });
    it("alpha 90 turns the camera 90 degrees to the left (about +Y)", () => {
      const r = q(90, 90, 0);
      near(r[0], 0, 1e-9); near(r[1], Math.SQRT1_2, 1e-9); near(r[2], 0, 1e-9); near(r[3], Math.SQRT1_2, 1e-9);
    });
    it("lying flat face up (beta 0) looks straight down (-90 about X)", () => {
      const r = q(0, 0, 0);
      near(r[0], -Math.SQRT1_2, 1e-9); near(r[3], Math.SQRT1_2, 1e-9);
    });
    it("the screen angle counter-rotates about Z", () => {
      const r = q(0, 90, 0, 90);
      near(r[2], -Math.SQRT1_2, 1e-9); near(r[3], Math.SQRT1_2, 1e-9);
    });
    it("results are unit quaternions; null and NaN angles read as 0", () => {
      for (const a of [[12, 70, -20, 0], [300, 95, 10, 270], [null, undefined, NaN, undefined]]) {
        const r = q(...a);
        near(Math.hypot(...r), 1, 1e-9);
        expect(r.every(Number.isFinite)).to.equal(true);
      }
      expect(q(null, null, null, null)).to.deep.equal(q(0, 0, 0, 0));
    });
    it("relativeQuat(q0, q) is the turn since q0: q0 gives the identity, a later q gives the difference", () => {
      const q0 = q(40, 90, 0);
      const same = OR.relativeQuat(q0, q0);
      near(same[3], 1, 1e-9); near(Math.hypot(same[0], same[1], same[2]), 0, 1e-9);
      const rel = OR.relativeQuat(q0, q(130, 90, 0));
      near(rel[1], Math.SQRT1_2, 1e-9); near(rel[3], Math.SQRT1_2, 1e-9);
    });
  });

  // ================================================================ obstacle
  // matrices (column-major Float32Array(16), as WebXR hands them out) built here, independent of obstacle.js
  const M = {
    perspective(fovy, aspect, near_, far) {
      const f = 1 / Math.tan(fovy / 2);
      const m = new Float32Array(16);
      m[0] = f / aspect; m[5] = f; m[10] = (far + near_) / (near_ - far); m[11] = -1; m[14] = (2 * far * near_) / (near_ - far);
      return m;
    },
    lookAt(eye, target) {
      const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
      const nrm = (a) => { const l = Math.hypot(...a); return a.map((x) => x / l); };
      const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
      const z = nrm(sub(eye, target));
      const x = nrm(cross([0, 1, 0], z));
      const y = cross(z, x);
      return Float32Array.from([...x, 0, ...y, 0, ...z, 0, ...eye, 1]);
    },
    invert(m) {
      const a = Array.from({ length: 4 }, (_, r) => [...Array.from({ length: 4 }, (_, c) => m[c * 4 + r]), ...[0, 0, 0, 0].map((_, c) => (c === r ? 1 : 0))]);
      for (let i = 0; i < 4; i++) {
        let p = i;
        for (let r = i + 1; r < 4; r++) if (Math.abs(a[r][i]) > Math.abs(a[p][i])) p = r;
        [a[i], a[p]] = [a[p], a[i]];
        const d = a[i][i];
        for (let c = 0; c < 8; c++) a[i][c] /= d;
        for (let r = 0; r < 4; r++) if (r !== i) { const f = a[r][i]; for (let c = 0; c < 8; c++) a[r][c] -= f * a[i][c]; }
      }
      const out = new Float32Array(16);
      for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) out[c * 4 + r] = a[r][4 + c];
      return out;
    },
    mulVec(m, v) {
      return [0, 1, 2, 3].map((r) => m[r] * v[0] + m[4 + r] * v[1] + m[8 + r] * v[2] + m[12 + r] * v[3]);
    },
  };

  /** The camera: 60 degree portrait phone 1.2 m up, 1.5 m in front of the rover (+z), looking at the corridor. */
  function camera(eye = [0, 1.2, 1.5], target = [0, 0, 0.3]) {
    const proj = M.perspective((60 * Math.PI) / 180, 0.5, 0.05, 20);
    const viewToWorld = M.lookAt(eye, target);
    return { eye, proj, invProj: M.invert(proj), viewToWorld, worldToView: M.invert(viewToWorld) };
  }

  /** Ray-cast depth of a floor (y=0) plus an optional wall facing the camera, with deterministic noise. */
  function sceneDepth(cam, { wall = null, noise = 0, constant = null } = {}) {
    let seed = 12345;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296) * 2 - 1;
    return (u, v) => {
      if (constant !== null) return constant;
      const c = M.mulVec(cam.invProj, [2 * u - 1, 1 - 2 * v, -1, 1]);
      const p = [c[0] / c[3], c[1] / c[3], c[2] / c[3]];
      const k = 1 / -p[2];
      const d1 = [p[0] * k, p[1] * k, -1];
      const m = cam.viewToWorld;
      const dir = [0, 1, 2].map((r) => m[r] * d1[0] + m[4 + r] * d1[1] + m[8 + r] * d1[2]);
      let t = dir[1] < 0 ? -cam.eye[1] / dir[1] : Infinity;
      if (wall && dir[2] !== 0) {
        const tw = (wall.z - cam.eye[2]) / dir[2];
        if (tw > 0 && tw < t) {
          const x = cam.eye[0] + tw * dir[0];
          const y = cam.eye[1] + tw * dir[1];
          if (Math.abs(x) < 0.6 && y >= 0 && y <= (wall.h ?? 0.4)) t = tw;
        }
      }
      return t + (noise ? rnd() * noise : 0);
    };
  }

  const pose0 = { x: 0, y: 0, z: 0, yaw: 0 };
  const evalScene = (cam, depthOpts, pose = pose0) => {
    const samples = OB.corridorSamples(pose);
    return OB.evaluateDepth({ samples, getDepth: sceneDepth(cam, depthOpts), worldToView: cam.worldToView, viewToWorld: cam.viewToWorld, proj: cam.proj, invProj: cam.invProj, worldPose: pose, floorY: pose.y });
  };

  describe("obstacle: depth geometry, rays, tracker", () => {
    it("constants as designed", () => {
      expect(OB.OBST).to.deep.include({ LOOKAHEAD: 0.6, HALF_W: 0.14, MIN_H: 0.05, MAX_H: 0.26, STEPS: 8, LANES: 3, MIN_HITS: 3, ENTER: 3, CLEAR: 8, CLEAR_EXTRA: 0.08, BLIND_FRAC: 0.3 });
      expect(OB.OBST.HEIGHTS).to.deep.equal([0.07, 0.15, 0.23]);
    });

    it("corridorSamples: a box in front of the rover, along its heading, between the floor and the max height", () => {
      const s = OB.corridorSamples({ x: 1, y: 0.5, z: 2, yaw: Math.PI / 2 }); // heading +x
      expect(s.length).to.equal(OB.OBST.STEPS * OB.OBST.LANES * OB.OBST.HEIGHTS.length);
      for (const p of s) {
        expect(p.x).to.be.greaterThan(1 + TP.FRONT - 1e-9);
        expect(p.x).to.be.at.most(1 + TP.FRONT + OB.OBST.LOOKAHEAD + 1e-9);
        expect(Math.abs(p.z - 2)).to.be.at.most(OB.OBST.HALF_W + 1e-9);
        expect(p.y - 0.5).to.be.within(OB.OBST.MIN_H, OB.OBST.MAX_H);
      }
    });

    it("project and unproject round-trip (and clip behind the camera / outside the view)", () => {
      const cam = camera();
      for (const pt of [[0, 0.1, 0.3], [0.05, 0.2, 0.5], [-0.1, 0.05, 0.1], [0.08, 0.15, 0.6]]) {
        const pr = OB.project(pt, cam.worldToView, cam.proj);
        expect(pr, String(pt)).to.not.equal(null);
        expect(pr.u).to.be.within(0, 1);
        expect(pr.v).to.be.within(0, 1);
        expect(pr.zView).to.be.greaterThan(0);
        const back = OB.unproject(pr.u, pr.v, pr.zView, cam.invProj, cam.viewToWorld);
        for (let i = 0; i < 3; i++) near(back[i] ?? [back.x, back.y, back.z][i], pt[i], 2e-4, `axis ${i}`);
      }
      expect(OB.project([0, 1.2, 5], cam.worldToView, cam.proj)).to.equal(null); // behind the camera
      expect(OB.project([5, 0.1, 0.3], cam.worldToView, cam.proj)).to.equal(null); // far out of view
    });

    it("a wall 0.4 m ahead is a hit about 30 cm from the front; the tracker blocks after 3 frames", () => {
      const cam = camera();
      const e = evalScene(cam, { wall: { z: 0.4 } });
      expect(e.hits).to.be.at.least(OB.OBST.MIN_HITS);
      expect(e.nearestM).to.be.within(0.25, 0.37);
      expect(e.visibleFrac).to.be.greaterThan(0.5);
      const t = OB.createObstacleTracker();
      let r;
      for (let i = 0; i < 3; i++) r = t.update({ ...e, source: "depth" });
      expect(r.state).to.equal("blocked");
      expect(r.distanceM).to.equal(0.3);
      expect(r.message).to.equal("Something is in my way (about 30 cm ahead).");
    });

    it("a wall off to the side, or beyond the look-ahead, is not a hit", () => {
      const cam = camera();
      expect(evalScene(cam, { wall: { z: -0.5 } }).hits).to.equal(0); // behind the rover
      const far = evalScene(camera([0, 1.2, 2.6], [0, 0, 0.9]), { wall: { z: 1.2 } });
      expect(far.hits).to.equal(0);
    });

    it("a floor with +-3 cm depth noise stays clear", () => {
      const cam = camera();
      const e = evalScene(cam, { noise: 0.03 });
      expect(e.hits).to.equal(0);
      expect(e.visibleFrac).to.be.greaterThan(0.8);
      const t = OB.createObstacleTracker();
      for (let i = 0; i < 20; i++) expect(t.update({ ...e, source: "depth" }).state).to.equal("clear");
    });

    it("something low on the floor (below 5 cm) does not stop the rover; something 12 cm tall does", () => {
      const cam = camera();
      expect(evalScene(cam, { wall: { z: 0.4, h: 0.03 } }).hits).to.equal(0);
      expect(evalScene(cam, { wall: { z: 0.4, h: 0.12 } }).hits).to.be.at.least(OB.OBST.MIN_HITS);
    });

    it("a hand in front of the lens (near-camera occluder) is no hit, and the corridor reads as not visible: blind", () => {
      const cam = camera();
      const e = evalScene(cam, { constant: 0.3 });
      expect(e.hits).to.equal(0);
      expect(e.visibleFrac).to.be.below(OB.OBST.BLIND_FRAC);
      const t = OB.createObstacleTracker();
      const r = t.update({ ...e, source: "depth" });
      expect(r.state).to.equal("blind");
      expect(r.message).to.equal("Obstacle sensing: point the phone at the Rover");
    });

    it("looking away (corridor out of view) is blind, not blocked, and invalid depth reads count as not visible", () => {
      const cam = camera([0, 1.2, 1.5], [0, 0, 3]); // pointing away
      const e = evalScene(cam, {});
      expect(e.visibleFrac).to.equal(0);
      expect(e.hits).to.equal(0);
      const cam2 = camera();
      const e2 = OB.evaluateDepth({ samples: OB.corridorSamples(pose0), getDepth: () => null, worldToView: cam2.worldToView, viewToWorld: cam2.viewToWorld, proj: cam2.proj, invProj: cam2.invProj, worldPose: pose0, floorY: 0 });
      expect(e2.visibleFrac).to.equal(0);
      const e3 = OB.evaluateDepth({ samples: OB.corridorSamples(pose0), getDepth: () => NaN, worldToView: cam2.worldToView, viewToWorld: cam2.viewToWorld, proj: cam2.proj, invProj: cam2.invProj, worldPose: pose0, floorY: 0 });
      expect(e3.hits).to.equal(0);
    });

    it("rays (hit-test fallback): a plane inside the look-ahead is enough; far, invalid or empty results are not", () => {
      const r = OB.evaluateRays([0.5]);
      expect(r.hits).to.be.at.least(OB.OBST.MIN_HITS);
      near(r.nearestM, 0.5 - TP.FRONT, 1e-9);
      expect(r.visibleFrac).to.equal(1);
      expect(OB.evaluateRays([]).hits).to.equal(0);
      expect(OB.evaluateRays([0.9]).hits).to.equal(0);
      expect(OB.evaluateRays([NaN, -1, "x", null, undefined, Infinity]).hits).to.equal(0);
      expect(OB.evaluateRays(null).hits).to.equal(0);
      near(OB.evaluateRays([0.9, 0.35, 0.5]).nearestM, 0.35 - TP.FRONT, 1e-9);
    });

    const hit = (d = 0.32, extra = {}) => ({ hits: 20, nearestM: d, visibleFrac: 0.9, source: "depth", ...extra });
    const none = (extra = {}) => ({ hits: 0, nearestM: Infinity, visibleFrac: 0.9, source: "depth", ...extra });

    it("hysteresis: blocked after 3 consecutive hit frames, clear after 8 clear frames", () => {
      const t = OB.createObstacleTracker();
      expect(t.update(hit()).state).to.equal("clear");
      expect(t.update(hit()).state).to.equal("clear");
      expect(t.update(none()).state).to.equal("clear"); // the run is broken
      expect(t.update(hit()).state).to.equal("clear");
      expect(t.update(hit()).state).to.equal("clear");
      expect(t.update(hit()).state).to.equal("blocked");
      for (let i = 0; i < 7; i++) expect(t.update(none()).state, `clear frame ${i + 1}`).to.equal("blocked");
      expect(t.update(none()).state).to.equal("clear");
      t.reset();
      expect(t.update(none()).state).to.equal("clear");
    });

    it("a broken streak forgets its distances: the next block measures its own", () => {
      const t = OB.createObstacleTracker();
      t.update(hit(0.2));
      t.update(hit(0.2));
      t.update(none({ visibleFrac: 0.1 })); // blind: the streak is broken
      for (let i = 0; i < 2; i++) expect(t.update(hit(0.6)).state).to.equal("clear");
      const r = t.update(hit(0.6));
      expect(r.state).to.equal("blocked");
      expect(r.distanceM).to.be.at.least(0.5);
    });

    it("a single hit frame in the middle of a clear run restarts the 8-frame count", () => {
      const t = OB.createObstacleTracker();
      for (let i = 0; i < 3; i++) t.update(hit());
      for (let i = 0; i < 6; i++) t.update(none());
      t.update(hit());
      for (let i = 0; i < 7; i++) expect(t.update(none()).state).to.equal("blocked");
      expect(t.update(none()).state).to.equal("clear");
    });

    it("partial returns closer than the entry distance + 8 cm do not count as clear frames", () => {
      const t = OB.createObstacleTracker();
      for (let i = 0; i < 3; i++) t.update(hit(0.3));
      for (let i = 0; i < 20; i++) expect(t.update({ hits: 1, nearestM: 0.33, visibleFrac: 0.9, source: "depth" }).state).to.equal("blocked");
      for (let i = 0; i < 7; i++) t.update({ hits: 1, nearestM: 0.5, visibleFrac: 0.9, source: "depth" });
      expect(t.update({ hits: 1, nearestM: 0.5, visibleFrac: 0.9, source: "depth" }).state).to.equal("clear");
    });

    it("distance: the minimum of the last five frames, rounded to 10 cm; the message says it", () => {
      const t = OB.createObstacleTracker();
      t.update(hit(0.42));
      t.update(hit(0.41));
      let r = t.update(hit(0.44));
      expect(r.state).to.equal("blocked");
      expect(r.distanceM).to.equal(0.4);
      expect(r.message).to.equal("Something is in my way (about 40 cm ahead).");
      r = t.update(hit(0.12));
      expect(r.distanceM).to.equal(0.1);
      expect(r.message).to.match(/about 10 cm ahead/);
      for (let i = 0; i < 5; i++) r = t.update(hit(0.5));
      expect(r.distanceM).to.equal(0.5);
    });

    it("blind: a clear tracker reports blind without blocking; a blocked tracker stays blocked until it can see clear again", () => {
      const t = OB.createObstacleTracker();
      expect(t.update(none({ visibleFrac: 0.1 })).state).to.equal("blind");
      for (let i = 0; i < 5; i++) expect(t.update(none({ visibleFrac: 0.1 })).state).to.equal("blind");
      for (let i = 0; i < 3; i++) t.update(hit());
      expect(t.update(none({ visibleFrac: 0.1 })).state).to.equal("blocked");
      for (let i = 0; i < 30; i++) t.update(none({ visibleFrac: 0.1 }));
      expect(t.update(none({ visibleFrac: 0.1 })).state).to.equal("blocked");
      for (let i = 0; i < 7; i++) t.update(none());
      expect(t.update(none()).state).to.equal("clear");
    });

    it("an obstacle that IS seen counts even when most of the corridor is out of view", () => {
      const t = OB.createObstacleTracker();
      let r;
      for (let i = 0; i < 3; i++) r = t.update(hit(0.2, { visibleFrac: 0.1 }));
      expect(r.state).to.equal("blocked");
    });

    it("off: no sensing source gives 'off' and never blocks; garbage input is safe", () => {
      const t = OB.createObstacleTracker();
      expect(t.update({ source: "off" })).to.deep.include({ state: "off", distanceM: null, message: "" });
      expect(t.update(null).state).to.equal("off");
      expect(t.update(undefined).state).to.equal("off");
      expect(t.update({ hits: "x", nearestM: "y", visibleFrac: NaN }).state).to.not.equal("blocked");
    });

    it("rays feed the same tracker", () => {
      const t = OB.createObstacleTracker();
      let r;
      for (let i = 0; i < 3; i++) r = t.update({ ...OB.evaluateRays([0.5]), source: "rays" });
      expect(r.state).to.equal("blocked");
      expect(r.distanceM).to.equal(0.4);
    });

    it("edgeAhead: distance to the circle boundary along the heading, from the front bumper", () => {
      near(OB.edgeAhead({ x: 0, z: 0, yaw: 0 }, 3), 3 - TP.FRONT, 1e-9);
      near(OB.edgeAhead({ x: 0, z: 0, yaw: Math.PI }, 3), 3 - TP.FRONT, 1e-9);
      near(OB.edgeAhead({ x: 0, z: 2, yaw: 0 }, 3), 1 - TP.FRONT, 1e-9);
      near(OB.edgeAhead({ x: 0, z: 2, yaw: Math.PI }, 3), 5 - TP.FRONT, 1e-9);
      expect(OB.edgeAhead({ x: 0, z: 2.99, yaw: 0 }, 3)).to.equal(0); // never negative
      near(OB.edgeAhead({ x: 3, z: 0, yaw: Math.PI / 2 }, 3), 0, 1e-9);
    });

    it("isForwardWheels and isForwardStep", () => {
      expect(OB.isForwardWheels([500, 500])).to.equal(true);
      expect(OB.isForwardWheels([300, 900])).to.equal(true);
      expect(OB.isForwardWheels([-500, -500])).to.equal(false);
      expect(OB.isForwardWheels([-600, 600])).to.equal(false);
      expect(OB.isForwardWheels([0, 0])).to.equal(false);
      expect(OB.isForwardWheels(null)).to.equal(false);
      for (const d of ["forward", "forward_left", "forward_right"]) expect(OB.isForwardStep({ tool: "drive", direction: d, seconds: 1 })).to.equal(true);
      for (const s of [{ tool: "drive", direction: "back" }, { tool: "drive", direction: "left" }, { tool: "turn", degrees: 90 }, { tool: "look", pan: 1 }, null, undefined]) expect(OB.isForwardStep(s)).to.equal(false);
    });
  });

  // ================================================================ controller
  describe("ar-controller: state machine, STOP, guarded drive loop", () => {
    let rigs = [];
    afterEach(() => {
      for (const r of rigs) expect(r.spies.arm - r.spies.human, "transport.writeArm calls not made by the human's own place()/arm()").to.equal(0);
      rigs = [];
    });

    const stick = (w) => w[0] !== 0 || w[1] !== 0;

    /** A controller on the real twin and a fake clock. `started` = start("xr") done. */
    async function rig({ started = true, mode = "xr", voice, parse, radius, noEdge, order = [] } = {}) {
      const clock = fakeClock();
      const spies = { arm: 0, human: 0, stop: 0 };
      let tr = null;
      const trs = [];
      const ais = [];
      const ctl = AC.createArController({
        clock,
        radius,
        voice,
        parse,
        makeTransport: () => {
          tr = TT.createTwinTransport({ body: P.bodyByKey("rover"), clock, latencyMs: 0 });
          trs.push(tr);
          const wa = tr.writeArm;
          tr.writeArm = (b) => (spies.arm++, wa(b));
          const ws = tr.writeStop;
          tr.writeStop = (b) => (order.push("loop.stop"), spies.stop++, ws(b));
          return tr;
        },
        createAi: (o) => {
          const ai = AP.createAiPilot(o);
          const c = ai.cancel;
          ai.cancel = (r) => (order.push(`ai.cancel:${r}`), c(r));
          ais.push(ai);
          return ai;
        },
      });
      const r = { clock, ctl, spies, order, get tr() { return tr; }, trs, ais };
      r.place = async () => {
        spies.human++;
        const ok = await ctl.place({ gesture: true });
        await clock.advance(150);
        return ok;
      };
      r.armButton = async () => {
        spies.human++;
        const ok = await ctl.arm();
        await clock.advance(150);
        return ok;
      };
      /** Runs `ms` of frames (33 ms each) like the render loop would. */
      r.frames = async (ms) => {
        for (let t = 0; t < ms; t += 33) {
          await clock.advance(33);
          ctl.frame(0.033);
        }
      };
      if (started) await ctl.start(mode);
      rigs.push(r);
      return r;
    }
    const blockedUpdate = { state: "blocked", distanceM: 0.3, message: "Something is in my way (about 30 cm ahead)." };
    const clearUpdate = { state: "clear", distanceM: null, message: "" };
    const msgs = (ctl, role) => ctl.view.ai.messages.filter((m) => m.role === role).map((m) => m.text);
    const wheels = (r) => r.ctl.snapshot.wheels;

    it("start(): twin connects LATCHED, state PLACING; nothing is armed", async () => {
      const r = await rig({ started: false });
      expect(r.ctl.state).to.equal("ready");
      expect(await r.ctl.start("xr")).to.equal(true);
      expect(r.ctl.state).to.equal("placing");
      expect(r.ctl.snapshot.link).to.equal(D.LINK.LATCHED);
      expect(r.spies.arm).to.equal(0);
      expect(r.ctl.view).to.include({ state: "placing", mode: "xr", armed: false, canPlace: true, canArm: false });
      expect(r.ctl.view.hint).to.be.a("string").and.not.equal("");
      expect(await r.ctl.start("xr")).to.equal(false); // already started
    });

    it("place() needs a gesture token; with it the twin arms (the human's tap) and the pose resets", async () => {
      const r = await rig();
      expect(await r.ctl.place()).to.equal(false);
      expect(await r.ctl.place({})).to.equal(false);
      expect(await r.ctl.place({ gesture: "yes" })).to.equal(false);
      expect(r.spies.arm).to.equal(0);
      expect(r.ctl.state).to.equal("placing");
      expect(await r.place()).to.equal(true);
      expect(r.ctl.state).to.equal("armed");
      expect(r.ctl.snapshot.link).to.be.oneOf([D.LINK.ARMED, D.LINK.DRIVING]);
      expect(r.spies.arm).to.equal(1);
      expect(r.ctl.pose).to.deep.equal({ x: 0, z: 0, yaw: 0 });
    });

    it("a refused ARM at placement: LATCHED with the reason, never armed behind the user's back", async () => {
      const r = await rig();
      const wa = r.tr.writeArm;
      r.tr.writeArm = (b) => (wa(b), Promise.reject(new Error("no")));
      expect(await r.place()).to.equal(false);
      expect(r.ctl.state).to.equal("latched");
      expect(r.ctl.view.message).to.match(/ARM refused/);
      expect(r.ctl.view.canArm).to.equal(true);
    });

    it("voice and chips while LATCHED: a plan card with 'Press ARM', no motion, no ARM, ever", async () => {
      const r = await rig();
      await r.ctl.say("forward 1 second", { source: "voice" });
      expect(r.ctl.view.ai.state).to.equal("ready");
      expect(r.ctl.view.ai.plan.blocked).to.equal("arm");
      expect(r.ctl.view.ai.plan.note).to.equal(EX.ARM_FIRST);
      for (const c of CH.CHIPS) {
        await r.ctl.chip(c.id);
        expect(r.ctl.view.ai.plan.blocked, c.id).to.equal("arm");
      }
      await r.clock.advance(60000);
      expect(stick(wheels(r))).to.equal(false);
      expect(r.spies.arm).to.equal(0);
      expect(r.ctl.snapshot.link).to.equal(D.LINK.LATCHED);
      expect(r.ctl.pose).to.deep.equal({ x: 0, z: 0, yaw: 0 });
    });

    it("place() arms and the waiting plan does not start by itself; the next request runs", async () => {
      const r = await rig();
      await r.ctl.say("forward 1", { source: "voice" });
      await r.place();
      await r.clock.advance(2000);
      expect(stick(wheels(r))).to.equal(false); // the old card was blocked, it stays a card
      await r.ctl.say("forward 1 s", { source: "voice" });
      await r.frames(500);
      expect(stick(wheels(r))).to.equal(true);
      expect(r.ctl.view.ai.state).to.equal("running");
      await r.frames(1500);
      expect(r.ctl.view.ai.state).to.equal("done");
      expect(r.ctl.pose.z).to.be.within(0.1, 0.4);
      near(r.ctl.pose.x, 0, 1e-6);
    });

    it("say(): untrusted text is cleaned and capped, shown as 'I heard', and an empty request does nothing", async () => {
      const r = await rig();
      await r.place();
      expect(await r.ctl.say(`${RLO}${ZW}  \n `)).to.equal(null);
      expect(await r.ctl.say(null)).to.equal(null);
      expect(await r.ctl.say({ toString: () => "forward" })).to.equal(null);
      await r.ctl.say(`turn${RLO} left${ZW} 45${NUL}`, { source: "voice" });
      expect(r.ctl.view.heard).to.equal("I heard: turn left 45");
      expect(r.ctl.view.ai.plan.steps[0]).to.deep.include({ tool: "turn", degrees: 45 });
      await r.ctl.say("x".repeat(5000), { source: "voice" });
      expect(r.ctl.view.heard.length).to.be.at.most("I heard: ".length + 500);
      await r.ctl.chip("left");
      expect(r.ctl.view.heard).to.equal("");
      expect(await r.ctl.chip("nope")).to.equal(null);
    });

    it("STOP: ai.cancel first, then seek.cancel, then loop.stop; latched, wheels 0, nothing resumes", async () => {
      const r = await rig();
      await r.place();
      r.ctl.seek = { cancel: () => r.order.push("seek.cancel") };
      await r.ctl.say("forward 3 s then turn left 90", { source: "voice" });
      await r.frames(400);
      expect(stick(wheels(r))).to.equal(true);
      r.order.length = 0;
      const p = r.ctl.stop("Stopped by you.");
      expect(r.order).to.deep.equal(["ai.cancel:stop", "seek.cancel", "loop.stop"]);
      expect(stick(wheels(r))).to.equal(false); // the same call
      expect(r.ctl.state).to.equal("latched");
      await p;
      await r.frames(60000);
      expect(r.ctl.state).to.equal("latched");
      expect(r.ctl.snapshot.link).to.equal(D.LINK.LATCHED);
      expect(stick(wheels(r))).to.equal(false);
      expect(r.ctl.view.ai.state).to.equal("stopped");
      expect(r.spies.arm).to.equal(1);
    });

    it("voice 'stop' is STOP; other sentences are requests; listen() toggles the mic and ignores late text after the session ended", async () => {
      let onText = null;
      let onState = null;
      let stopped = 0;
      const voice = { supported: true, listening: false, start(t, s) { onText = t; onState = s; this.listening = true; s("listening"); return true; }, stop() { stopped++; this.listening = false; onState("idle"); } };
      const say = (text) => ((voice.listening = false), onText(text)); // the real recogniser has ended when it hands over its sentence
      const r = await rig({ voice });
      await r.place();
      await r.ctl.say("forward 3 s", { source: "voice" });
      await r.frames(300);
      expect(stick(wheels(r))).to.equal(true);
      expect(r.ctl.listen()).to.equal(true);
      expect(r.ctl.view.listening).to.equal(true);
      expect(r.ctl.listen()).to.equal(true); // second tap: stop listening
      expect(stopped).to.equal(1);
      r.ctl.listen();
      r.order.length = 0;
      say("Stop");
      expect(r.order[0]).to.equal("ai.cancel:stop");
      expect(r.ctl.state).to.equal("latched");
      expect(stick(wheels(r))).to.equal(false);
      await r.armButton();
      r.ctl.listen();
      say("halt now please");
      expect(r.ctl.state).to.equal("latched");
      await r.armButton();
      r.ctl.listen();
      say("turn left 45");
      await r.frames(100);
      expect(r.ctl.view.ai.plan.steps[0].tool).to.equal("turn");
      onState("error:not-allowed");
      expect(r.ctl.view.voiceNote).to.match(/microphone|allowed|permission/i);
      const n = r.spies.human;
      expect(r.spies.arm).to.equal(n); // only the human's place() and ARM clicks
    });

    it("listen() without voice support says no and does nothing", async () => {
      const r = await rig({ voice: { supported: false, start: () => false, stop() {} } });
      expect(r.ctl.listen()).to.equal(false);
      expect(r.ctl.view.voiceSupported).to.equal(false);
      const r2 = await rig();
      expect(r2.ctl.listen()).to.equal(false);
    });

    it("hidden page, pagehide, XR visibility 'hidden': latched, and still latched with wheels 0 after 60 s", async () => {
      for (const how of ["hidden", "pagehide", "xr-hidden"]) {
        const r = await rig();
        await r.place();
        await r.ctl.say("forward 3 s then back 3 s then forward 3 s", { source: "voice" });
        await r.frames(400);
        expect(stick(wheels(r)), how).to.equal(true);
        if (how === "xr-hidden") r.ctl.visibility("hidden");
        else r.ctl.stop(how === "hidden" ? "The page was hidden, so I stopped." : "The page was closed.");
        expect(stick(wheels(r)), how).to.equal(false);
        await r.frames(60000);
        expect(r.ctl.state, how).to.equal("latched");
        expect(r.ctl.snapshot.link, how).to.equal(D.LINK.LATCHED);
        expect(stick(wheels(r)), how).to.equal(false);
        expect(r.ctl.view.ai.running, how).to.equal(false);
        expect(r.spies.arm, how).to.equal(1);
      }
    });

    it("XR end: stop, disconnect, READY; the bridge connection is closed and a fresh start() works", async () => {
      const r = await rig();
      await r.place();
      await r.ctl.say("forward 3 s", { source: "voice" });
      await r.frames(300);
      const first = r.tr;
      await r.ctl.ended("AR closed");
      expect(r.ctl.state).to.equal("ready");
      expect(first.connected).to.equal(false);
      expect(r.order).to.include("loop.stop");
      expect(r.ctl.view.message).to.equal("AR closed");
      expect(await r.ctl.say("forward 1")).to.equal(null); // no session: nothing to plan
      expect(await r.ctl.start("xr")).to.equal(true);
      expect(r.tr).to.not.equal(first);
      expect(r.ctl.state).to.equal("placing");
      expect(r.ctl.snapshot.link).to.equal(D.LINK.LATCHED);
    });

    it("an arm that answers after the session ended changes nothing: READY stays READY and a new start works", async () => {
      const r = await rig();
      r.spies.human++;
      const p = r.ctl.place({ gesture: true }); // the arm is in flight
      await r.ctl.ended("AR closed");
      await r.clock.advance(150);
      expect(await p).to.equal(false);
      expect(r.ctl.state).to.equal("ready");
      expect(await r.ctl.start("xr")).to.equal(true);
      expect(r.ctl.state).to.equal("placing");
    });

    it("ARM button: LATCHED -> ARMED, and it is the only way back after a STOP", async () => {
      const r = await rig();
      await r.place();
      await r.ctl.stop("Stopped by you.");
      expect(r.ctl.state).to.equal("latched");
      expect(await r.armButton()).to.equal(true);
      expect(r.ctl.state).to.equal("armed");
      expect(r.spies.arm).to.equal(2);
      // not latched: arm() does nothing and writes nothing
      expect(await r.ctl.arm()).to.equal(false);
      expect(r.spies.arm).to.equal(2);
    });

    it("tapping the floor after a STOP only re-places the Rover; it stays latched until ARM", async () => {
      const r = await rig();
      await r.place();
      await r.ctl.say("forward 1 s", { source: "voice" });
      await r.frames(800);
      await r.ctl.stop("Stopped by you.");
      expect(r.ctl.pose.z).to.be.greaterThan(0.05);
      const ok = await r.ctl.place({ gesture: true });
      await r.clock.advance(150);
      expect(ok).to.equal(true);
      expect(r.ctl.pose).to.deep.equal({ x: 0, z: 0, yaw: 0 });
      expect(r.ctl.state).to.equal("latched");
      expect(r.spies.arm).to.equal(1);
    });

    it("tapping the floor while armed and idle re-places (pose 0); while a plan runs it is ignored", async () => {
      const r = await rig();
      await r.place();
      await r.ctl.say("forward 1 s", { source: "voice" });
      await r.frames(500);
      const z = r.ctl.pose.z;
      expect(z).to.be.greaterThan(0.02);
      expect(await r.ctl.place({ gesture: true })).to.equal(false);
      expect(r.ctl.view.ai.running).to.equal(true);
      expect(r.ctl.pose.z).to.equal(z);
      await r.frames(1500);
      expect(r.ctl.view.ai.state).to.equal("done");
      expect(await r.ctl.place({ gesture: true })).to.equal(true);
      expect(r.ctl.pose).to.deep.equal({ x: 0, z: 0, yaw: 0 });
      expect(r.ctl.state).to.equal("armed");
      expect(r.spies.arm).to.equal(1); // re-place does not re-arm an armed twin
    });

    it("hold (XR 'visible-blurred', obstacle, edge) interrupts the plan, zeroes the wheels within one tick and STAYS ARMED", async () => {
      // visible-blurred
      let r = await rig();
      await r.place();
      await r.ctl.say("forward 3 s", { source: "voice" });
      await r.frames(300);
      expect(stick(wheels(r))).to.equal(true);
      r.ctl.visibility("visible-blurred");
      await r.clock.advance(40);
      expect(stick(wheels(r))).to.equal(false);
      expect(r.ctl.snapshot.link).to.equal(D.LINK.ARMED);
      expect(r.ctl.state).to.equal("armed");
      expect(r.ctl.view.ai.state).to.equal("interrupted");
      expect(msgs(r.ctl, "notice").join(" ")).to.match(/paused|blurred|system|AR/i);
      await r.frames(60000);
      expect(stick(wheels(r))).to.equal(false); // nothing resumes
      expect(r.ctl.state).to.equal("armed");
      r.ctl.visibility("visible"); // coming back changes nothing by itself
      await r.frames(2000);
      expect(stick(wheels(r))).to.equal(false);
      // obstacle while moving forward
      r = await rig();
      await r.place();
      await r.ctl.say("forward 3 s", { source: "voice" });
      await r.frames(300);
      r.ctl.obstacle(blockedUpdate);
      await r.clock.advance(40);
      expect(stick(wheels(r))).to.equal(false);
      expect(r.ctl.snapshot.link).to.equal(D.LINK.ARMED);
      expect(r.ctl.view.ai.state).to.equal("interrupted");
      expect(msgs(r.ctl, "notice")).to.include(blockedUpdate.message);
      await r.frames(60000);
      expect(stick(wheels(r))).to.equal(false);
      // edge (play area 0.2 m)
      r = await rig({ radius: 0.2 });
      await r.place();
      await r.ctl.say("forward 3 s", { source: "voice" });
      await r.frames(1500);
      expect(r.ctl.state).to.equal("armed");
      expect(r.ctl.view.ai.state).to.equal("interrupted");
      expect(msgs(r.ctl, "notice")).to.include("I'm at the edge of my 0.2 m play area.");
      expect(stick(wheels(r))).to.equal(false);
      expect(Math.hypot(r.ctl.pose.x, r.ctl.pose.z)).to.be.at.most(0.2 + 1e-9);
      expect(r.ctl.snapshot.link).to.equal(D.LINK.ARMED);
    });

    it("the default play area is 3 m and says so", async () => {
      const r = await rig();
      expect(r.ctl.view.radius).to.equal(3);
      const c = await rig({ mode: "camera" });
      expect(c.ctl.view.radius).to.equal(1.5);
    });

    it("an obstacle update while the Rover drives BACK or turns changes nothing; blocked while idle only informs", async () => {
      const r = await rig();
      await r.place();
      await r.ctl.say("back 3 s", { source: "voice" });
      await r.frames(300);
      r.ctl.obstacle(blockedUpdate);
      await r.frames(300);
      expect(r.ctl.view.ai.state).to.equal("running");
      expect(stick(wheels(r))).to.equal(true);
      await r.ctl.chip("left"); // a turn is fine while blocked
      await r.frames(300);
      expect(r.ctl.view.ai.state).to.equal("running");
      expect(r.ctl.view.sensing.level).to.equal("blocked");
      r.ctl.obstacle(clearUpdate);
      expect(r.ctl.view.sensing.level).to.equal("clear");
    });

    it("the parser drops 'forward' while blocked; with a plain parser the guarded holdFor refuses it (back and turns pass)", async () => {
      // 1. built-in AR parser
      let r = await rig();
      await r.place();
      r.ctl.obstacle(blockedUpdate);
      await r.ctl.say("forward 2 s", { source: "voice" });
      expect(r.ctl.view.ai.plan).to.equal(null);
      expect(msgs(r.ctl, "pilot").join(" ")).to.contain("about 30 cm ahead");
      await r.ctl.say("turn left 45 then back 1 s", { source: "voice" });
      await r.frames(500);
      expect(stick(wheels(r))).to.equal(true);
      // 2. a parser that does not filter: the guard is the second line
      const plain = (t, b, o) => GR.parseCommand(t, b, o);
      r = await rig({ parse: plain });
      await r.place();
      r.ctl.obstacle(blockedUpdate);
      await r.ctl.say("forward 2 s", { source: "voice" });
      expect(r.ctl.view.ai.plan.steps[0].direction).to.equal("forward");
      await r.frames(2500);
      expect(stick(wheels(r))).to.equal(false);
      expect(r.ctl.view.ai.state).to.equal("interrupted");
      expect(msgs(r.ctl, "notice")).to.include(blockedUpdate.message);
      expect(r.ctl.snapshot.link).to.equal(D.LINK.ARMED);
      expect(r.ctl.pose.z).to.equal(0);
      await r.ctl.say("back 1 s", { source: "voice" });
      await r.frames(400);
      expect(r.ctl.snapshot.wheels[0]).to.be.lessThan(0);
      await r.frames(1500);
      await r.ctl.say("turn left 180", { source: "voice" });
      await r.frames(400);
      expect(stick(wheels(r))).to.equal(true);
      // forward + left curve is forward as well
      r = await rig({ parse: plain });
      await r.place();
      r.ctl.obstacle(blockedUpdate);
      await r.ctl.say("go forward and left 2 s", { source: "voice" });
      await r.frames(1000);
      expect(stick(wheels(r))).to.equal(false);
    });

    it("the AI's loop handle cannot arm, connect, disconnect or change the speed cap", async () => {
      let handle = null;
      // reach the loop handle the AI got through its getLoop
      const clk = fakeClock();
      const spy = AC.createArController({
        clock: clk,
        makeTransport: () => TT.createTwinTransport({ body: P.bodyByKey("rover"), clock: clk, latencyMs: 0 }),
        createAi: (o) => ((handle = o), AP.createAiPilot(o)),
      });
      await spy.start("xr");
      const loop = handle.getLoop();
      expect(await loop.arm()).to.equal(false);
      expect(await loop.connect()).to.equal(undefined);
      expect(loop.link).to.equal(D.LINK.LATCHED);
      const speed0 = loop.snapshot.speed;
      loop.setSpeed(5);
      expect(loop.snapshot.speed).to.equal(speed0);
      // a stick would skip the obstacle and edge checks that guard holdFor: even armed, it moves nothing
      await spy.place({ gesture: true });
      await clk.advance(150);
      expect(spy.state).to.equal("armed");
      loop.setStick(0, 1);
      await clk.advance(300);
      expect(loop.snapshot.wheels.some((w) => w !== 0)).to.equal(false);
      expect(handle.getBodyKey()).to.equal("rover");
      expect(handle.getMode()).to.equal("twin");
      expect(handle.getModel()).to.equal(null);
      await spy.ended("done");
    });

    it("every lease the plan asks the drive loop for is at most 3 s", async () => {
      const r = await rig();
      await r.place();
      const real = r.ctl._loop;
      const leases = [];
      const hf = real.holdFor;
      real.holdFor = (ms, x, y) => (leases.push(ms), hf(ms, x, y));
      await r.ctl.say("forward 3 s then back 3 s then turn left 180 then turn right 180 then forward 3 s", { source: "voice" });
      await r.frames(16000);
      expect(leases.length).to.be.greaterThan(4);
      for (const l of leases) expect(l).to.be.at.most(3000);
      expect(r.ctl.view.ai.state).to.equal("done");
    });

    it("a chip interrupts the running plan; the Rover stays armed and runs the new plan", async () => {
      const r = await rig();
      await r.place();
      await r.ctl.chip("spin");
      await r.frames(400);
      expect(r.ctl.view.ai.running).to.equal(true);
      const first = r.ctl.view.ai.plan;
      await r.ctl.chip("forward");
      expect(first.status).to.equal("interrupted");
      expect(r.ctl.view.ai.plan).to.not.equal(first);
      expect(r.ctl.view.ai.plan.steps[0]).to.deep.include({ tool: "drive", direction: "forward" });
      await r.frames(500);
      expect(stick(wheels(r))).to.equal(true);
      expect(r.ctl.state).to.equal("armed");
      expect(r.spies.arm).to.equal(1);
    });

    it("a plan that runs 45 s ends by its deadline, the Rover stays armed, wheels 0", async () => {
      const r = await rig();
      await r.place();
      await r.ctl.say("forward 3 s then wait 5 then wait 5 then wait 5 then wait 5 then wait 5 then wait 5", { source: "voice" });
      await r.frames(40000);
      expect(r.ctl.view.ai.state).to.equal("done");
      expect(stick(wheels(r))).to.equal(false);
      expect(r.ctl.state).to.equal("armed");
    });

    it("the bridge latching (a plan's own stop step, or a watchdog) latches the controller and nothing resumes", async () => {
      const r = await rig();
      await r.place();
      await r.ctl.say("forward 1 s then stop then forward 1 s", { source: "voice" });
      await r.frames(3000);
      expect(r.ctl.state).to.equal("latched");
      expect(r.ctl.snapshot.link).to.equal(D.LINK.LATCHED);
      expect(stick(wheels(r))).to.equal(false);
      await r.frames(60000);
      expect(r.ctl.state).to.equal("latched");
    });

    it("onChange fires with a view on state changes; a throwing callback never breaks the controller", async () => {
      const seen = [];
      const clock = fakeClock();
      const ctl = AC.createArController({
        clock,
        makeTransport: () => TT.createTwinTransport({ body: P.bodyByKey("rover"), clock, latencyMs: 0 }),
        onChange: (v) => { seen.push(v.state); throw new Error("ui broke"); },
      });
      await ctl.start("xr");
      await ctl.stop("x");
      expect(seen).to.include.members(["placing"]);
      expect(ctl.state).to.equal("placing");
    });

    it("view model: sensing text per mode, chips, heard", async () => {
      const x = await rig();
      expect(x.ctl.view.chips).to.equal(CH.CHIPS);
      expect(x.ctl.view.sensing.level).to.equal("off");
      x.ctl.obstacle({ state: "blind", distanceM: null, message: "Obstacle sensing: point the phone at the Rover" });
      expect(x.ctl.view.sensing).to.deep.include({ level: "blind", text: "Obstacle sensing: point the phone at the Rover" });
      const c = await rig({ mode: "camera" });
      expect(c.ctl.view.sensing.text).to.equal("Obstacle sensing needs Android Chrome AR");
      c.ctl.obstacle(blockedUpdate); // camera view has no sensing: ignored
      expect(c.ctl.view.sensing.level).to.equal("off");
    });
  });

  // ================================================================ source checks
  describe("wiring rules (source checks)", () => {
    const arFiles = (dir = "web/js/ar") => {
      const out = [];
      const walk = (d) => {
        for (const e of fs.readdirSync(path.join(root, d), { withFileTypes: true })) {
          if (e.isDirectory()) walk(`${d}/${e.name}`);
          else if (e.name.endsWith(".js")) out.push(`${d}/${e.name}`);
        }
      };
      walk(dir);
      return out;
    };

    it("web/js/ar never writes HTML, evals, uses storage or the network (fetch only in the detector)", () => {
      const files = arFiles();
      expect(files).to.include.members(["web/js/ar/ar-caps.js", "web/js/ar/chips.js", "web/js/ar/ar-parse.js", "web/js/ar/obstacle.js", "web/js/ar/orientation.js", "web/js/ar/ar-controller.js"]);
      for (const f of files) {
        const src = strip(read(f));
        expect(src, f).to.not.match(/innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
        expect(src, f).to.not.match(/\beval\(|new Function|\bFunction\(/);
        expect(src, f).to.not.match(/localStorage|sessionStorage|indexedDB/);
        // the detector and its worker name the transports only to wrap or remove them (the off-site guard): they never
        // open a request of their own
        if (/vision\/(detector|detect-worker)\.js$/.test(f)) expect(src, f).to.not.match(/new XMLHttpRequest|new WebSocket|new EventSource|sendBeacon\(|\bfetch\(/);
        else expect(src, f).to.not.match(/\bfetch\b|XMLHttpRequest|sendBeacon|WebSocket|EventSource/);
      }
    });

    it("the pure modules (caps, chips, parse, obstacle, orientation, controller) touch no DOM and no three", () => {
      for (const f of ["ar-caps", "chips", "ar-parse", "obstacle", "orientation", "ar-controller"]) {
        const src = strip(read(`web/js/ar/${f}.js`));
        expect(src, f).to.not.match(/from "three|document\.|\bwindow\.|localStorage|getUserMedia\(/);
      }
    });

    it("ARM is written in exactly two places of the controller: place() and arm()", () => {
      const raw = read("web/js/ar/ar-controller.js");
      const src = strip(raw);
      const hits = [...src.matchAll(/\.arm\(/g)].map((m) => m.index);
      expect(hits.length, "`.arm(` call sites").to.equal(2);
      const where = (name) => {
        const start = src.search(new RegExp(`\\n {4}(?:async )?${name}\\(`));
        expect(start, `${name}() exists`).to.be.greaterThan(-1);
        // the method body ends at the next top-level method (a line starting with 4 spaces + word + "(")
        const rest = src.slice(start + 10);
        const m = rest.search(/\n {4}(async )?[a-zA-Z_]+\([^)]*\) \{/);
        return [start, start + 10 + (m < 0 ? rest.length : m)];
      };
      const [ps, pe] = where("place");
      const [as, ae] = where("arm");
      const inP = hits.filter((h) => h >= ps && h < pe).length;
      const inA = hits.filter((h) => h >= as && h < ae).length;
      expect(inP, "in place()").to.equal(1);
      expect(inA, "in arm()").to.equal(1);
      expect(src).to.not.match(/writeArm/);
      // no code path of the AI, the voice or a chip reaches them
      for (const name of ["start", "say", "chip", "listen", "stop", "hold", "obstacle", "frame", "visibility", "ended"]) {
        const [from, to] = where(name);
        expect(hits.some((h) => h >= from && h < to), `${name}() reaches .arm(`).to.equal(false);
      }
    });

    it("the guarded loop wraps holdFor only; every motion still goes through the drive loop", () => {
      const src = strip(read("web/js/ar/ar-controller.js"));
      expect(src).to.match(/createDriveLoop\(/);
      expect(src).to.match(/holdFor/);
      expect(src).to.match(/new Proxy\(/);
      expect(src).to.not.match(/transport\.sendCmd|sendCmd\(/); // no side door around the loop
      expect(src).to.not.match(/bridge\.|writeCmd/);
    });

    it("STOP in the controller: ai.cancel then seek then loop.stop, in that order", () => {
      const src = strip(read("web/js/ar/ar-controller.js"));
      const i = src.search(/\n {4}(async )?stop\(/);
      expect(i).to.be.greaterThan(-1);
      const body = src.slice(i, i + 1200);
      const a = body.indexOf('ai.cancel("stop")');
      const s = body.search(/seek[^;]*cancel\(/);
      const l = body.indexOf("loop.stop(");
      expect(a, "ai.cancel").to.be.greaterThan(-1);
      expect(s, "seek.cancel").to.be.greaterThan(a);
      expect(l, "loop.stop").to.be.greaterThan(s);
    });
  });
});
