const { expect } = require("chai");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

// Demonstration envelope "openforge.demo.v1" (web/js/sim/demo-episode.js) and its opt-in tap in the phone drive loop
// (web/js/pilot/drive-loop.js setRecorder). Groundwork only: nothing here is wired to a page.
describe("Demonstration envelope openforge.demo.v1 (web/js/sim/demo-episode.js)", () => {
  let D, E, L, P, DL, TT, AS;
  before(async () => {
    D = await import("../web/js/sim/demo-episode.js");
    E = await import("../web/js/sim/episode.js");
    L = await import("../web/js/sim/lab-episode.js");
    AS = await import("../web/js/sim/arm-sim.js");
    P = await import("../web/js/pilot/ax-proto.js");
    DL = await import("../web/js/pilot/drive-loop.js");
    TT = await import("../web/js/pilot/twin-transport.js");
  });

  const ADDR = "0x" + "ab".repeat(20);
  const HOLDER = "0x" + "cd".repeat(20);
  function fakeClock(start = 0) {
    let t = start;
    return { now: () => t, wall: () => Date.UTC(2026, 9, 28, 12, 0, 0), advance: (ms) => (t += ms) };
  }
  const roverMeta = (extra = {}) => ({ chainId: 8453, agents: ADDR, tokenId: 7, holder: HOLDER, robot: "ax1-rover", source: "phone-brain", fps: 30, ...extra });
  function record(meta = roverMeta(), n = 5) {
    const clock = fakeClock(1000);
    const rec = D.createDemoRecorder({ meta, clock });
    const width = (D.layoutOf(meta.robot) || { names: meta.features.action }).names.length;
    const drive = (D.layoutOf(meta.robot) || { names: meta.features.action }).names.some((x) => x.startsWith("drive"));
    for (let i = 0; i < n; i++) {
      const lim = (D.layoutOf(meta.robot) || { limits: Array(width).fill([-1000, 1000]) }).limits;
      const joints = Array.from({ length: drive ? width - 2 : width }, (_, k) => Math.max(lim[k][0], Math.min(lim[k][1], i)));
      expect(rec.push({ joints, drive: drive ? [100 * i, -100 * i] : undefined })).to.equal(true);
      clock.advance(33);
    }
    return rec.stop();
  }
  /** Rebuilds a valid seal after a test edited the content on purpose. */
  const reseal = (env) => ({ ...env, integrity: { alg: D.INTEGRITY_ALG, head: D.chainHead(headerOf(env), env.frames) } });
  const headerOf = (env) => {
    const { frames, integrity, ...h } = env;
    return h;
  };
  const clone = (x) => JSON.parse(JSON.stringify(x));

  // ------------------------------------------------------------ hash

  it("sha256Hex matches node:crypto, including multi-block and unicode input", () => {
    for (const s of ["", "abc", "x".repeat(55), "x".repeat(56), "x".repeat(64), "x".repeat(1000), "gripper ✋ 日本語 🤖"]) {
      expect(D.sha256Hex(s), s.slice(0, 12)).to.equal(crypto.createHash("sha256").update(s, "utf8").digest("hex"));
    }
  });

  it("the robot ids are the ROBOTS keys and the lab's class order", () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "web/js/models/robots.js"), "utf8");
    const block = src.slice(src.indexOf("export const ROBOTS = {"));
    const keys = [...block.slice(0, block.indexOf("\n};")).matchAll(/^ {2}("?)([\w-]+)\1: \{ name:/gm)].map((m) => m[2]);
    expect(D.ROBOT_IDS).to.deep.equal(keys);
    expect(D.ROBOT_IDS).to.deep.equal(L.CLASS_ROBOT);
  });

  // ------------------------------------------------------------ recorder + validator

  it("records a rover demonstration into a valid, sealed envelope", () => {
    const env = record();
    expect(env).to.include({ format: "openforge.demo.v1", chainId: 8453, agents: ADDR, tokenId: 7, holder: HOLDER, robot: "ax1-rover", body: "rover", proto: `${P.PROTO_MAJOR}.${P.PROTO_MINOR}`, source: "phone-brain", actor: "human", fps: 30 });
    expect(env.units).to.deep.equal({ joints: "deg", drive: "permille" });
    expect(env.features.action).to.deep.equal(["head_pan.pos", "head_tilt.pos", "drive_l.cmd", "drive_r.cmd"]);
    expect(env.consent).to.deep.equal({ recorded: true, at: "2026-10-28T12:00:00.000Z", scope: "local" });
    expect(env.frames.map((f) => f.t)).to.deep.equal([0, 33, 66, 99, 132]);
    expect(env.frames[2].a).to.deep.equal([2, 2, 200, -200]);
    expect(env.integrity.alg).to.equal("sha256-chain");
    expect(D.validateDemo(env)).to.deep.equal({ ok: true, errors: [] });
    expect(D.validateDemo(JSON.parse(JSON.stringify(env))).ok).to.equal(true); // survives a file round trip
  });

  it("covers every AX-1 body and the SO-101 arm; guests have no token", () => {
    for (const robot of ["ax1-desk", "ax1-walker", "ax1-rover", "so101"]) {
      const env = record(roverMeta({ robot, tokenId: null, agents: null, chainId: null, holder: null, source: "workbench" }));
      expect(D.validateDemo(env), robot).to.deep.equal({ ok: true, errors: [] });
    }
    expect(record(roverMeta({ robot: "so101" })).body).to.equal(null);
    expect(D.layoutOf("so101").names).to.deep.equal(AS.JOINTS.map((j) => `${j}.pos`));
  });

  it("a robot without a known layout brings its own feature names", () => {
    const env = record(roverMeta({ robot: "drone", features: { action: ["thr.cmd", "yaw.cmd"] } }), 3);
    expect(D.validateDemo(env).ok).to.equal(true);
    expect(() => D.createDemoRecorder({ meta: roverMeta({ robot: "drone" }), clock: fakeClock() })).to.throw(/features/);
  });

  it("an AI-run demo is a separate actor and the two never mix", () => {
    const ai = record(roverMeta({ source: "ai-pilot" }));
    expect(ai.actor).to.equal("ai");
    expect(D.validateDemo(ai).ok).to.equal(true);
    expect(() => D.createDemoRecorder({ meta: roverMeta({ source: "ai-pilot", actor: "human" }), clock: fakeClock() })).to.throw(/never mixed/);
    expect(() => D.createDemoRecorder({ meta: roverMeta({ source: "ar-twin", actor: "ai" }), clock: fakeClock() })).to.throw(/never mixed/);
    expect(D.validateDemo({ ...ai, actor: "human" }).ok).to.equal(false);
  });

  it("rejects bad creation meta instead of recording something unusable", () => {
    const bad = (extra, re) => expect(() => D.createDemoRecorder({ meta: roverMeta(extra), clock: fakeClock() }), JSON.stringify(extra)).to.throw(re);
    bad({ robot: "toaster" }, /unknown robot/);
    bad({ source: "telepathy" }, /unknown source/);
    bad({ fps: 0 }, /fps/);
    bad({ fps: 1000 }, /fps/);
    bad({ agents: "0x123" }, /agents/);
    bad({ agents: null }, /token demo/);
    bad({ tokenId: -1 }, /tokenId/);
    bad({ chainId: 0 }, /chainId/);
    bad({ task: "" }, /task/);
    bad({ source: "robot-link", robot: "so101" }, /AX-1/);
    expect(() => D.createDemoRecorder({ meta: roverMeta() })).to.throw(TypeError);
  });

  it("push drops bad, late or duplicate samples and never throws", () => {
    const clock = fakeClock();
    const rec = D.createDemoRecorder({ meta: roverMeta(), clock });
    expect(rec.push({ joints: [1, 2], drive: [3, 4] })).to.equal(true);
    expect(rec.push({ joints: [1, 2], drive: [3, 4] })).to.equal(false); // same instant
    clock.advance(33);
    for (const junk of [null, undefined, 5, "x", {}, { joints: null }, { joints: [1] }, { joints: [1, 2] }, { joints: [NaN, 0], drive: [0, 0] }, { joints: [0, 0], drive: [Infinity, 0] }, { joints: ["1", 0], drive: [0, 0] }, { joints: [1, 2, 3], drive: [0, 0] }]) {
      expect(() => rec.push(junk)).to.not.throw();
      expect(rec.push(junk), JSON.stringify(junk)).to.equal(false);
    }
    expect(rec.push({ joints: [1, 2], drive: [3, 4] })).to.equal(true);
    expect(rec.count).to.equal(2);
  });

  it("the recorder keeps at most about twice the declared rate and values to 3 decimals", () => {
    const clock = fakeClock();
    const rec = D.createDemoRecorder({ meta: roverMeta({ fps: 30 }), clock });
    let kept = 0;
    for (let i = 0; i < 1000; i++, clock.advance(1)) kept += rec.push({ joints: [0.123456, 0], drive: [0, 0] }) ? 1 : 0;
    expect(kept).to.be.within(55, 70); // one per 16 ms over 1000 ms
    expect(rec.stop().frames[0].a[0]).to.equal(0.123);
  });

  it("stop is idempotent and ends the recording", () => {
    const clock = fakeClock();
    const rec = D.createDemoRecorder({ meta: roverMeta(), clock });
    rec.push({ joints: [0, 0], drive: [0, 0] });
    const env = rec.stop();
    expect(rec.stop()).to.equal(env);
    clock.advance(100);
    expect(rec.push({ joints: [1, 1], drive: [0, 0] })).to.equal(false);
    expect(env.frames).to.have.length(1);
  });

  it("an empty recording seals but does not validate", () => {
    const env = D.createDemoRecorder({ meta: roverMeta(), clock: fakeClock() }).stop();
    expect(D.validateDemo(env)).to.deep.equal({ ok: false, errors: ["no frames"] });
  });

  it("validateDemo never throws and rejects what is not an envelope", () => {
    for (const junk of [null, undefined, 0, "demo", [], [1], () => {}, {}, { format: "openforge.demo.v1" }]) {
      let r;
      expect(() => (r = D.validateDemo(junk))).to.not.throw();
      expect(r.ok).to.equal(false);
      expect(r.errors.length).to.be.greaterThan(0);
    }
  });

  it("is strict about version, fields and enums", () => {
    const env = record();
    const bad = (mut, re) => {
      const e = clone(env);
      mut(e);
      const r = D.validateDemo(reseal(e));
      expect(r.ok, re.toString()).to.equal(false);
      expect(r.errors.join("|")).to.match(re);
    };
    expect(D.validateDemo({ ...clone(env), format: "openforge.demo.v2" }).errors[0]).to.match(/unknown format/);
    expect(D.validateDemo({ ...clone(env), format: undefined }).errors[0]).to.match(/unknown format/);
    bad((e) => (e.extra = 1), /unknown field "extra"/);
    bad((e) => (e.source = "mind-meld"), /unknown source/);
    bad((e) => (e.actor = "robot"), /unknown actor/);
    bad((e) => (e.proto = `${P.PROTO_MAJOR + 1}.0`), /unsupported proto/);
    bad((e) => (e.proto = `${P.PROTO_MAJOR}.${P.PROTO_MINOR + 1}`), /unsupported proto/);
    bad((e) => (e.proto = "one"), /proto/);
    bad((e) => (e.body = "desk"), /body must be "rover"/);
    bad((e) => (e.robot = "so101"), /body must be null|features do not match/);
    bad((e) => (e.units = { joints: "rad", drive: "permille" }), /units/);
    bad((e) => (e.units.extra = "x"), /units/);
    bad((e) => (e.features.action = ["head_pan.pos"]), /features do not match/);
    bad((e) => (e.features.action = ["Head Pan"]), /features must be/);
    bad((e) => (e.consent.scope = "cloud"), /consent/);
    bad((e) => (e.consent.recorded = false), /consent/);
    bad((e) => delete e.consent, /consent/);
    bad((e) => (e.consent.at = "yesterday"), /consent/);
    bad((e) => (e.holder = "alice"), /holder/);
    bad((e) => (e.tokenId = 1.5), /tokenId/);
    bad((e) => (e.task = "x".repeat(D.MAX_TASK + 1)), /task/);
  });

  it("checks frames: monotonic t, finite numbers, width, limits, caps", () => {
    const env = record();
    const bad = (mut, re) => {
      const e = clone(env);
      mut(e);
      const r = D.validateDemo(reseal(e));
      expect(r.ok, re.toString()).to.equal(false);
      expect(r.errors.join("|")).to.match(re);
    };
    bad((e) => (e.frames[2].t = e.frames[1].t), /t must increase/);
    bad((e) => (e.frames[2].t = 1), /t must increase/);
    bad((e) => (e.frames[0].t = 0.5), /must be \{ t, a \}/);
    bad((e) => (e.frames[1].a[0] = null), /not a finite number/); // JSON turns NaN into null
    bad((e) => (e.frames[1].a[0] = "3"), /not a finite number/);
    bad((e) => (e.frames[1].a[0] = D.MAX_ABS + 1), /not a finite number|outside/);
    bad((e) => e.frames[1].a.pop(), /values for 4 features/);
    bad((e) => (e.frames[1].extra = 1), /must be \{ t, a \}/);
    bad((e) => (e.frames[1].a[2] = 1001), /outside its limits/); // wheels are clamped to +-1000
    bad((e) => (e.frames[1].a[0] = 91), /outside its limits/); // rover head_pan is +-90
    bad((e) => (e.frames[4].t = D.MAX_DURATION_MS + 1), /longer than/);
    const f = clone(env);
    f.frames[1].a[0] = NaN;
    expect(D.validateDemo(reseal(f)).errors.join()).to.match(/not a finite number/);
    f.frames[1].a[0] = Infinity;
    expect(D.validateDemo(reseal(f)).ok).to.equal(false);

    const huge = clone(env);
    huge.frames = Array.from({ length: D.MAX_FRAMES + 1 }, (_, i) => ({ t: i, a: [0, 0, 0, 0] }));
    expect(D.validateDemo(reseal(huge)).errors.join()).to.match(/more than/);
    const wide = clone(env);
    wide.features.action = Array.from({ length: D.MAX_FEATURES + 1 }, (_, i) => `f${i}.pos`);
    expect(D.validateDemo(reseal(wide)).ok).to.equal(false);
  });

  it("the hash chain catches any edit, reorder, drop or splice", () => {
    const env = record(roverMeta(), 6);
    expect(D.validateDemo(env).ok).to.equal(true);
    const edits = {
      value: (e) => (e.frames[3].a[0] = 9),
      header: (e) => (e.tokenId = 8),
      holder: (e) => (e.holder = "0x" + "ee".repeat(20)),
      dropped: (e) => e.frames.splice(2, 1),
      truncated: (e) => e.frames.pop(),
      reordered: (e) => e.frames.reverse(),
      head: (e) => (e.integrity.head = "0".repeat(64)),
      badHead: (e) => (e.integrity.head = "XYZ"),
      noIntegrity: (e) => delete e.integrity,
      alg: (e) => (e.integrity.alg = "md5"),
    };
    for (const [name, mut] of Object.entries(edits)) {
      const e = clone(env);
      mut(e);
      expect(D.validateDemo(e).ok, name).to.equal(false);
    }
    const a = record(roverMeta(), 6);
    expect(a.integrity.head).to.equal(env.integrity.head); // deterministic for the same input
    expect(record(roverMeta({ tokenId: 8 }), 6).integrity.head).to.not.equal(env.integrity.head);
  });

  it("a full 30-minute demonstration records and validates quickly", function () {
    this.timeout(30000);
    const clock = fakeClock();
    const rec = D.createDemoRecorder({ meta: roverMeta({ fps: 30 }), clock });
    for (let i = 0; i < D.MAX_FRAMES + 100; i++, clock.advance(33)) rec.push({ joints: [i % 90, 0], drive: [i % 1000, 0] });
    const env = rec.stop();
    expect(env.frames.length).to.equal(D.MAX_FRAMES); // the cap, not the clock, ends it
    expect(D.validateDemo(env)).to.deep.equal({ ok: true, errors: [] });
  });

  // ------------------------------------------------------------ LeRobot

  it("toLeRobotRows gives the step-1 line format of scripts/lerobot-prep.mjs, with the SO-101 mapping reused", () => {
    const env = record(roverMeta({ robot: "so101", source: "workbench" }), 4);
    const row = D.toLeRobotRows(env);
    expect(row).to.include({ robot_type: AS.ROBOT.robot_type, fps: 30, units: "deg", source: "demo:workbench", actor: "human", tokenId: 7, dataHash: env.integrity.head });
    expect(row.joints).to.deep.equal(AS.JOINTS);
    expect(row.actions).to.have.length(4);
    expect(row.states).to.have.length(4);
    expect(row.states[0]).to.deep.equal(row.actions[0]);
    expect(row.states[2]).to.deep.equal(row.actions[1]); // the state is the previous command
    expect(row.seconds).to.equal(0.099);
    // every key export_lerobot.py reads from an episode line is there
    const py = fs.readFileSync(path.join(__dirname, "..", "scripts/real/export_lerobot.py"), "utf8");
    const wanted = new Set([...py.matchAll(/\be\["(\w+)"\]/g)].map((m) => m[1]));
    expect(wanted.size).to.be.greaterThan(8);
    for (const k of wanted) expect(row, k).to.have.property(k);
    // and the prep script's own keys
    const prep = fs.readFileSync(path.join(__dirname, "..", "scripts/lerobot-prep.mjs"), "utf8");
    for (const k of ["dataHash", "source", "tokenId", "seed", "fps", "robot_type", "joints", "units", "task", "success", "seconds", "quality", "events", "actions", "states"]) {
      expect(prep, k).to.include(k);
      expect(row, k).to.have.property(k);
    }
  });

  it("toLeRobotRows names AX-1 channels and refuses invalid or AI-run demos by default", () => {
    const row = D.toLeRobotRows(record());
    expect(row.robot_type).to.equal("ax1_rover");
    expect(row.joints).to.deep.equal(["head_pan", "head_tilt", "drive_l", "drive_r"]);
    const ai = record(roverMeta({ source: "ai-pilot" }));
    expect(() => D.toLeRobotRows(ai)).to.throw(/AI-run/);
    expect(D.toLeRobotRows(ai, { allowAi: true }).actor).to.equal("ai");
    const e = record();
    e.frames[1].a[0] = 3;
    expect(() => D.toLeRobotRows(e)).to.throw(/not a valid demonstration/);
    expect(() => D.toLeRobotRows(null)).to.throw();
  });

  it("is pure: no DOM, no network, no storage in the module", () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "web/js/sim/demo-episode.js"), "utf8").replace(/^\s*\/\/.*$/gm, "");
    for (const bad of [/\bfetch\s*\(/, /XMLHttpRequest/, /\bdocument\./, /\bwindow\./, /localStorage|indexedDB|sessionStorage/, /WebSocket|sendBeacon/]) expect(src, String(bad)).to.not.match(bad);
    void E;
  });

  // ------------------------------------------------------------ drive-loop hook

  function loopClock() {
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
  async function armedLoop(body, setup) {
    const clock = loopClock();
    const tr = TT.createTwinTransport({ body, clock });
    let n = 0;
    const loop = DL.createDriveLoop({ transport: tr, clock, nonce: () => ++n });
    if (setup) setup(loop, clock);
    await loop.connect();
    expect(await loop.arm()).to.equal(true);
    return { clock, tr, loop };
  }
  /** One fixed drive script; returns what the bridge saw, so runs with and without a recorder can be compared. */
  async function script({ clock, tr, loop }) {
    const seen = [];
    loop.setSpeed(100);
    loop.setHeld(true);
    loop.setStick(0, 1);
    loop.setJoint("head_pan", 200); // out of range: clamped to 90
    await clock.advance(300);
    seen.push([...tr.bridge.snapshot.drive, tr.bridge.snapshot.state]);
    loop.setStick(1, 0);
    await clock.advance(300);
    seen.push([...tr.bridge.snapshot.drive, tr.bridge.snapshot.state]);
    loop.setHeld(false);
    await clock.advance(300);
    seen.push([...tr.bridge.snapshot.drive, tr.bridge.snapshot.state]);
    await loop.stop("done");
    await clock.advance(300);
    seen.push([tr.bridge.snapshot.latch, loop.link, loop.snapshot.sent]);
    return seen;
  }

  it("setRecorder taps the clamped values of every frame sent, in degrees and permille", async () => {
    const env = await armedLoop(P.BODY.ROVER);
    const rec = D.createDemoRecorder({ meta: roverMeta(), clock: env.clock });
    env.loop.setRecorder(rec);
    await script(env);
    const demo = rec.stop();
    expect(D.validateDemo(demo)).to.deep.equal({ ok: true, errors: [] });
    expect(demo.frames.length).to.be.within(25, 40);
    expect(demo.frames.every((f) => f.a[0] === 90)).to.equal(true); // head_pan 200 degrees was clamped to 90 first
    expect(demo.frames.some((f) => f.a[2] === 1000 && f.a[3] === 1000)).to.equal(true);
    expect(demo.frames.some((f) => f.a[2] === 1000 && f.a[3] === -1000)).to.equal(true); // the pivot
    expect(demo.frames[demo.frames.length - 1].a.slice(2)).to.deep.equal([0, 0]); // released: zero wheels are recorded too
  });

  it("a joint body records its joints in degrees", async () => {
    const env = await armedLoop(P.BODY.DESK);
    const rec = D.createDemoRecorder({ meta: roverMeta({ robot: "ax1-desk" }), clock: env.clock });
    env.loop.setRecorder(rec);
    env.loop.setJoint("head_pan", 12.34);
    await env.clock.advance(200);
    const demo = rec.stop();
    expect(D.validateDemo(demo).ok).to.equal(true);
    expect(demo.frames[demo.frames.length - 1].a[1]).to.equal(12.3);
    expect(demo.frames[0].a).to.have.length(7);
  });

  it("with no recorder (the default) or with a recorder that throws, the loop behaves identically", async () => {
    const plain = await script(await armedLoop(P.BODY.ROVER));
    const nulled = await armedLoop(P.BODY.ROVER);
    nulled.loop.setRecorder(null);
    expect(await script(nulled)).to.deep.equal(plain);
    let calls = 0;
    const angry = await armedLoop(P.BODY.ROVER);
    angry.loop.setRecorder({ push: () => (calls++, (() => { throw new Error("disk full"); })()) });
    expect(await script(angry)).to.deep.equal(plain);
    expect(calls).to.be.greaterThan(20);
    expect(angry.loop.link).to.equal(DL.LINK.LATCHED);
  });

  it("a recorder can be swapped or removed mid-drive, and cannot mutate what is sent", async () => {
    const env = await armedLoop(P.BODY.ROVER);
    const seenSamples = [];
    env.loop.setRecorder({
      push(s) {
        seenSamples.push(s);
        s.joints.fill(9999); // tamper with the sample: the loop's own targets must not change
        s.drive && s.drive.fill(9999);
      },
    });
    env.loop.setSpeed(100);
    env.loop.setHeld(true);
    env.loop.setStick(0, 1);
    await env.clock.advance(700); // the bridge slews the wheels up to 1000
    expect(env.tr.bridge.snapshot.drive).to.deep.equal([1000, 1000]);
    expect(env.loop.snapshot.targets).to.deep.equal([0, 0]);
    const n = seenSamples.length;
    env.loop.setRecorder(null);
    await env.clock.advance(200);
    expect(seenSamples.length).to.equal(n);
  });

  it("setRecorder refuses anything that is not a recorder or null; STOP and the watchdog stay in charge", async () => {
    const env = await armedLoop(P.BODY.ROVER);
    for (const junk of [undefined, 5, {}, "rec", { push: 1 }]) expect(() => env.loop.setRecorder(junk)).to.throw(TypeError);
    const rec = D.createDemoRecorder({ meta: roverMeta(), clock: env.clock });
    env.loop.setRecorder(rec);
    env.loop.setHeld(true);
    env.loop.setStick(0, 1);
    await env.clock.advance(150);
    const before = rec.count;
    await env.loop.stop();
    await env.clock.advance(300);
    expect(env.loop.link).to.equal(DL.LINK.LATCHED);
    expect(env.tr.bridge.snapshot.drive).to.deep.equal([0, 0]);
    expect(rec.count).to.equal(before); // nothing is sent after STOP, so nothing is recorded
  });
});
