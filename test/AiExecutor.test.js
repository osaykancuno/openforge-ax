const { expect } = require("chai");

// AI Pilot executor (web/js/pilot/ai/executor.js) on the REAL drive loop, the twin transport and the bridge state
// machine, with a fake clock. The AI goes through the same path as the UI; it never arms and STOP always wins.
describe("AI Pilot executor + drive-loop lease (web/js/pilot/ai/executor.js)", () => {
  let P, D, TT, X, M;
  before(async () => {
    P = await import("../web/js/pilot/ax-proto.js");
    D = await import("../web/js/pilot/drive-loop.js");
    TT = await import("../web/js/pilot/twin-transport.js");
    X = await import("../web/js/pilot/ai/executor.js");
    M = await import("../web/js/pilot/motions.js");
  });

  /** Fake timers (same as test/PilotBridge.test.js): advance(ms) fires due timers in order, promises settle between. */
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
      get pending() {
        return timers.size;
      },
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

  let rigs = [];
  afterEach(() => {
    // in EVERY test: nothing the AI did ever wrote an ARM
    for (const r of rigs) expect(r.spies.arm, "transport.writeArm calls made after the human ARM").to.equal(0);
    rigs = [];
  });

  /** A connected twin of `bodyKey`, ARMED by the "human" (the test) unless arm:false. Spies are installed after that ARM. */
  async function rig(bodyKey = "rover", { arm = true, speed } = {}) {
    const clock = fakeClock();
    const tr = TT.createTwinTransport({ body: P.bodyByKey(bodyKey), clock, latencyMs: 0 });
    let n = 0;
    const loop = D.createDriveLoop({ transport: tr, clock, nonce: () => ++n });
    await loop.connect();
    if (arm) {
      expect(await loop.arm()).to.equal(true);
      await clock.advance(150); // the bridge confirms ARMED by a notify
      expect(loop.link).to.equal(D.LINK.ARMED);
    }
    if (speed) loop.setSpeed(speed);
    const spies = { arm: 0, setPose: [], setSpeed: 0, frames: [] };
    const wa = tr.writeArm;
    tr.writeArm = (b) => (spies.arm++, wa(b));
    const sp = loop.setPose;
    loop.setPose = (m) => (spies.setPose.push({ t: clock.now(), pose: { ...m } }), sp(m));
    const ss = loop.setSpeed;
    loop.setSpeed = (v) => (spies.setSpeed++, ss(v));
    const sc = tr.sendCmd;
    tr.sendCmd = (b) => {
      try {
        spies.frames.push({ t: clock.now(), ...P.decodeCmd(b) });
      } catch {}
      return sc(b);
    };
    const events = [];
    const ex = X.createPlanExecutor({ loop, clock, onEvent: (e) => events.push(e) });
    const r = { clock, tr, loop, ex, spies, events, bridge: tr.bridge };
    rigs.push(r);
    return r;
  }
  const drive = (direction = "forward", seconds = 1, speed = 100) => ({ tool: "drive", direction, seconds, speed });
  const nonzero = (w) => w[0] !== 0 || w[1] !== 0;

  describe("drive-loop holdFor lease", () => {
    it("holdFor(ms): wheels live until the lease ends, then zero IN THE SAME FRAME (no executor involved)", async () => {
      const r = await rig("rover", { speed: 100 });
      const t0 = r.clock.now();
      expect(r.loop.holdFor(1500, 0, 1)).to.equal(true);
      expect(r.loop.link).to.equal(D.LINK.DRIVING);
      await r.clock.advance(1700);
      const live = r.spies.frames.filter((f) => f.left !== 0 || f.right !== 0);
      expect(live.length).to.be.above(30);
      expect(live[0].t).to.be.at.least(t0);
      const lastLive = live[live.length - 1].t;
      expect(lastLive).to.be.lessThan(t0 + 1500); // no live frame at or after the lease end
      const firstZeroAfter = r.spies.frames.find((f) => f.t >= t0 + 1500);
      expect(firstZeroAfter.left).to.equal(0);
      expect(firstZeroAfter.right).to.equal(0);
      expect(firstZeroAfter.t).to.be.at.most(t0 + 1500 + D.TICK_MS);
      expect(r.loop.link).to.equal(D.LINK.ARMED);
      expect(r.bridge.snapshot.state).to.equal(P.STATE.ARMED); // a lease running out is not a latch
    });

    it("a lease never lasts longer than 3000 ms, whatever is asked", async () => {
      const r = await rig("rover", { speed: 100 });
      const t0 = r.clock.now();
      expect(D.MAX_LEASE_MS).to.equal(3000);
      r.loop.holdFor(99999, 0, 1);
      await r.clock.advance(3200);
      const lastLive = r.spies.frames.filter((f) => f.left !== 0 || f.right !== 0).pop();
      expect(lastLive.t).to.be.lessThan(t0 + 3000);
      expect(r.spies.frames.find((f) => f.t >= t0 + 3000).left).to.equal(0);
      r.loop.holdFor(-5, 0, 1);
      expect(nonzero(r.loop.snapshot.wheels)).to.equal(false); // a non-positive lease does nothing
    });

    it("refused unless ARMED or DRIVING (a latched robot is never driven)", async () => {
      const r = await rig("rover", { arm: false });
      expect(r.loop.holdFor(500, 0, 1)).to.equal(false);
      expect(r.loop.link).to.equal(D.LINK.LATCHED);
      expect(nonzero(r.loop.snapshot.wheels)).to.equal(false);
      const d = await rig("desk");
      expect(d.loop.holdFor(500, 0, 1), "a body without wheels").to.equal(false);
    });

    it("setHeld(false) and STOP end the lease at once", async () => {
      const r = await rig("rover", { speed: 100 });
      r.loop.holdFor(2000, 0, 1);
      await r.clock.advance(200);
      expect(nonzero(r.loop.snapshot.wheels)).to.equal(true);
      r.loop.setHeld(false);
      expect(r.loop.snapshot.wheels).to.deep.equal([0, 0]);
      expect(r.loop.link).to.equal(D.LINK.ARMED);
      await r.clock.advance(100);
      expect(r.bridge.snapshot.drive).to.deep.equal([0, 0]);

      r.loop.holdFor(2000, 0, 1);
      await r.clock.advance(100);
      const p = r.loop.stop("test");
      expect(r.loop.snapshot.wheels).to.deep.equal([0, 0]);
      await p;
      expect(r.loop.link).to.equal(D.LINK.LATCHED);
    });

    it("a human taking the stick during a lease keeps the stick: the old lease must not cut the human's drive", async () => {
      const r = await rig("rover", { speed: 100 });
      r.loop.holdFor(300, 0, 1);
      await r.clock.advance(100);
      r.loop.setHeld(false); // the human lets go / presses...
      r.loop.setHeld(true); // ...and presses again
      r.loop.setStick(0, 1);
      await r.clock.advance(1500);
      expect(nonzero(r.loop.snapshot.wheels)).to.equal(true);
      expect(r.loop.link).to.equal(D.LINK.DRIVING);
      r.loop.setHeld(true); // pressing while a lease runs: the human now owns the drive
      r.loop.holdFor(200, 0, 1);
      r.loop.setHeld(true);
      r.loop.setStick(0, 1);
      await r.clock.advance(1500);
      expect(nonzero(r.loop.snapshot.wheels)).to.equal(true);
    });

    it("the stall check stays: a frozen JS thread latches even during a lease", async () => {
      const r = await rig("rover", { speed: 100 });
      r.loop.holdFor(2000, 0, 1);
      const t0 = r.clock.now();
      r.clock.now = ((orig) => () => orig() + (orig() - t0 > 100 ? 400 : 0))(r.clock.now);
      await r.clock.advance(200);
      expect(r.loop.link).to.equal(D.LINK.LATCHED);
      expect(nonzero(r.loop.snapshot.wheels)).to.equal(false);
    });
  });

  describe("drive and turn", () => {
    it("drive(forward, 1.5): non-zero wheels only in [t0, t0 + 1500 + 33]; the bridge is at zero right after", async () => {
      const r = await rig("rover", { speed: 100 });
      const t0 = r.clock.now();
      const done = r.ex.run([drive("forward", 1.5)], new AbortController().signal);
      const nz = [];
      let bridgeNz = 0;
      let doneAt = null;
      done.then(() => (doneAt = r.clock.now()));
      for (let i = 0; i < 1800; i++) {
        await r.clock.advance(1);
        if (nonzero(r.loop.snapshot.wheels)) nz.push(r.clock.now());
        if (nonzero(r.bridge.snapshot.drive)) bridgeNz = r.clock.now();
      }
      expect(nz.length).to.be.above(1000);
      expect(nz[0]).to.be.at.least(t0);
      expect(nz[nz.length - 1]).to.be.at.most(t0 + 1500 + D.TICK_MS);
      expect(bridgeNz).to.be.at.most(t0 + 1500 + D.TICK_MS + 20); // the next 20 ms control tick sees the zero frame
      expect(r.bridge.snapshot.drive).to.deep.equal([0, 0]);
      const live = r.spies.frames.filter((f) => f.t >= t0 + 1500 + D.TICK_MS && (f.left || f.right));
      expect(live).to.deep.equal([]);
      const res = await done;
      expect(res).to.include({ status: "done", completed: 1, total: 1 });
      expect(doneAt).to.be.within(t0 + 1500, t0 + 1560);
      expect(r.loop.link).to.equal(D.LINK.ARMED);
      expect(r.bridge.snapshot.state).to.equal(P.STATE.ARMED);
    });

    it("directions move the right wheels; back is negative; left/right spin", async () => {
      const seen = {};
      for (const dir of ["forward", "back", "left", "right", "forward_left", "forward_right"]) {
        const r = await rig("rover", { speed: 100 });
        const done = r.ex.run([drive(dir, 0.3)], new AbortController().signal);
        await r.clock.advance(100);
        seen[dir] = r.loop.snapshot.wheels;
        await r.clock.advance(400);
        await done;
      }
      expect(seen.forward[0]).to.be.above(0);
      expect(seen.forward[1]).to.equal(seen.forward[0]);
      expect(seen.back[0]).to.be.below(0);
      expect(seen.left[0]).to.be.below(0); // left wheel back, right wheel forward: the robot spins left
      expect(seen.left[1]).to.be.above(0);
      expect(seen.right[0]).to.be.above(0);
      expect(seen.right[1]).to.be.below(0);
      expect(seen.forward_left[0]).to.be.below(seen.forward_left[1]);
      expect(seen.forward_left[0]).to.be.above(0);
      expect(seen.forward_right[0]).to.be.above(seen.forward_right[1]);
    });

    it("turn: open loop, converted to time (200 deg/s x user speed x step speed); positive = left", async () => {
      const r = await rig("rover", { speed: 100 });
      const t0 = r.clock.now();
      let doneAt = null;
      const done = r.ex.run([{ tool: "turn", degrees: 90, speed: 100 }], new AbortController().signal);
      done.then(() => (doneAt = r.clock.now()));
      await r.clock.advance(100);
      expect(r.loop.snapshot.wheels[0]).to.be.below(0);
      expect(r.loop.snapshot.wheels[1]).to.be.above(0);
      await r.clock.advance(600);
      await done;
      expect(doneAt - t0).to.be.within(440, 520); // 90 / 200 = 0.45 s
      expect(nonzero(r.loop.snapshot.wheels)).to.equal(false);

      const q = await rig("rover", { speed: 50 });
      const q0 = q.clock.now();
      let qAt = null;
      const qd = q.ex.run([{ tool: "turn", degrees: -90, speed: 100 }], new AbortController().signal);
      qd.then(() => (qAt = q.clock.now()));
      await q.clock.advance(100);
      expect(q.loop.snapshot.wheels[0]).to.be.above(0); // right turn
      await q.clock.advance(1500);
      await qd;
      expect(qAt - q0).to.be.within(890, 1000); // half the user speed, twice the time
    });

    it("a long turn at a low speed is chunked into leases of 3 s at most", async () => {
      const r = await rig("rover", { speed: 20 });
      const t0 = r.clock.now();
      const done = r.ex.run([{ tool: "turn", degrees: 180, speed: 100 }], new AbortController().signal); // 180 / (200 x 0.2) = 4.5 s
      await r.clock.advance(5000);
      const res = await done;
      expect(res.status).to.equal("done");
      const live = r.spies.frames.filter((f) => f.left || f.right);
      expect(live[live.length - 1].t - t0).to.be.within(4400, 4600);
    });

    it("the user's speed cap is a ceiling: the AI scales within it and never calls setSpeed", async () => {
      const r = await rig("rover", { speed: 40 });
      let max = 0;
      const done = r.ex.run([drive("forward", 1, 100), drive("forward", 1, 50), drive("left", 0.5, 100)], new AbortController().signal);
      for (let i = 0; i < 2700; i++) {
        await r.clock.advance(1);
        max = Math.max(max, Math.abs(r.bridge.snapshot.drive[0]), Math.abs(r.bridge.snapshot.drive[1]));
        expect(Math.abs(r.bridge.snapshot.drive[0]), "wheel output vs the 40 % cap").to.be.at.most(400);
      }
      await done;
      expect(max).to.equal(400);
      expect(r.spies.setSpeed).to.equal(0);
      expect(r.loop.snapshot.speed).to.equal(40);
      expect(r.spies.frames.every((f) => f.speed === 40)).to.equal(true);
      // half speed is half the output
      const h = await rig("rover", { speed: 40 });
      const hd = h.ex.run([drive("forward", 1, 50)], new AbortController().signal);
      let hmax = 0;
      for (let i = 0; i < 1100; i++) (await h.clock.advance(1)), (hmax = Math.max(hmax, h.bridge.snapshot.drive[0]));
      await hd;
      expect(hmax).to.equal(200);
    });
  });

  describe("joints, looks, gestures, poses", () => {
    it("set_joints waits max|delta| / (90 deg/s x speed) + 150 ms, then the next step", async () => {
      const r = await rig("desk", { speed: 100 });
      const t0 = r.clock.now();
      let at = null;
      const done = r.ex.run([{ tool: "set_joints", joints: { r_shoulder: -90 } }], new AbortController().signal);
      done.then(() => (at = r.clock.now()));
      await r.clock.advance(1300);
      expect((await done).status).to.equal("done");
      expect(at - t0).to.be.within(1140, 1200); // 90 / 90 = 1 s + 150 ms
      expect(r.bridge.snapshot.present[5]).to.be.closeTo(-900, 30);
      expect(r.spies.setPose).to.have.length(1);

      const h = await rig("desk", { speed: 50 });
      const h0 = h.clock.now();
      let hat = null;
      const hd = h.ex.run([{ tool: "set_joints", joints: { r_shoulder: -90 } }], new AbortController().signal);
      hd.then(() => (hat = h.clock.now()));
      await h.clock.advance(2500);
      await hd;
      expect(hat - h0).to.be.within(2140, 2200); // half speed: twice as long

      const z = await rig("desk", { speed: 100 });
      const z0 = z.clock.now();
      let zat = null;
      const zd = z.ex.run([{ tool: "set_joints", joints: { torso_yaw: 0 } }], new AbortController().signal);
      zd.then(() => (zat = z.clock.now()));
      await z.clock.advance(400);
      await zd;
      expect(zat - z0).to.be.within(150, 200); // already there: just the settle time
    });

    it("look moves only the axes it names, in degrees as the joint table has them (positive pan = left, tilt = up)", async () => {
      const r = await rig("rover", { speed: 100 });
      const a = r.ex.run([{ tool: "look", pan: 30 }], new AbortController().signal);
      await r.clock.advance(800);
      await a;
      expect(r.loop.snapshot.targets).to.deep.equal([300, 0]);
      const b = r.ex.run([{ tool: "look", tilt: -10 }], new AbortController().signal);
      await r.clock.advance(800);
      await b;
      expect(r.loop.snapshot.targets).to.deep.equal([300, -100]);
      expect(r.bridge.snapshot.commanded).to.deep.equal([300, -100]);
      expect(r.spies.setPose[0].pose).to.deep.equal({ head_pan: 30 });
    });

    it("the Desk wave replays its keyframes in order and takes as long as the keyframes", async () => {
      const r = await rig("desk", { speed: 100 });
      const t0 = r.clock.now();
      let at = null;
      const done = r.ex.run([{ tool: "gesture", name: "wave" }], new AbortController().signal);
      done.then(() => (at = r.clock.now()));
      await r.clock.advance(8000);
      expect((await done).status).to.equal("done");
      const frames = M.GESTURES.wave;
      expect(r.spies.setPose).to.have.length(frames.length);
      frames.forEach(([ms, pose], i) => {
        expect(r.spies.setPose[i].t - t0, `frame ${i}`).to.be.within(ms, ms + 45);
        expect(r.spies.setPose[i].pose).to.deep.equal(pose);
      });
      expect(at - t0).to.be.above(4500);
      expect(at - t0).to.be.below(7000); // the last keyframe plus the time to reach it
    });

    it("walker: pose and torso", async () => {
      const r = await rig("walker", { speed: 100 });
      const idx = (n) => P.BODIES[P.BODY.WALKER].joints.findIndex((j) => j.name === n);
      const a = r.ex.run([{ tool: "pose", name: "crouch" }], new AbortController().signal);
      await r.clock.advance(3000);
      expect((await a).status).to.equal("done");
      expect(r.loop.snapshot.targets[idx("l_knee")]).to.equal(800);
      const b = r.ex.run([{ tool: "torso", yaw: 20 }], new AbortController().signal);
      await r.clock.advance(3000);
      await b;
      expect(r.loop.snapshot.targets[idx("torso_yaw")]).to.equal(200);
      expect(r.loop.snapshot.targets[idx("l_knee")]).to.equal(800); // torso moves only the torso
    });
  });

  describe("STOP, interrupts, latches, refusals", () => {
    it("STOP mid-step: abort the plan first, then loop.stop(): wheels 0 in the same tick, LATCHED, no later setPose", async () => {
      const r = await rig("rover", { speed: 100 });
      const ctl = new AbortController();
      const done = r.ex.run([drive("forward", 3), { tool: "look", pan: 30 }, drive("back", 1)], ctl.signal);
      await r.clock.advance(500);
      expect(nonzero(r.loop.snapshot.wheels)).to.equal(true);
      const posesBefore = r.spies.setPose.length;
      ctl.abort("stop"); // 1. the plan
      const stopped = r.loop.stop("Stopped by you."); // 2. the loop (pilot.js also cancels its own gesture timers in between)
      expect(r.loop.snapshot.wheels).to.deep.equal([0, 0]); // same tick
      expect(r.loop.link).to.equal(D.LINK.LATCHED);
      await stopped;
      await r.clock.advance(4000);
      const res = await done;
      expect(res).to.include({ status: "aborted", reason: "stop", completed: 0 });
      expect(r.spies.setPose.length).to.equal(posesBefore);
      expect(r.bridge.snapshot.latch).to.equal(P.LATCH.USER_STOP);
      expect(r.bridge.snapshot.drive).to.deep.equal([0, 0]);
      expect(r.loop.link).to.equal(D.LINK.LATCHED); // never resumes
      expect(r.spies.frames.filter((f) => f.t > r.clock.now() - 3000 && (f.left || f.right))).to.deep.equal([]);
      expect(r.ex.running).to.equal(false);
    });

    it("STOP in the middle of a gesture: no keyframe is applied afterwards", async () => {
      const r = await rig("desk", { speed: 100 });
      const ctl = new AbortController();
      const done = r.ex.run([{ tool: "gesture", name: "wave" }, { tool: "gesture", name: "nod" }], ctl.signal);
      await r.clock.advance(2000);
      const n = r.spies.setPose.length;
      expect(n).to.be.within(2, 3);
      ctl.abort("stop");
      await r.loop.stop("x");
      await r.clock.advance(10000);
      expect((await done).status).to.equal("aborted");
      expect(r.spies.setPose).to.have.length(n);
      expect(r.clock.pending, "no timer of the plan is left behind except the transport's").to.be.at.most(2);
    });

    it("an interrupt (new message) ends the move, zeroes the wheels and leaves the robot ARMED", async () => {
      const r = await rig("rover", { speed: 100 });
      const ctl = new AbortController();
      const done = r.ex.run([drive("forward", 3), { tool: "look", pan: 40 }], ctl.signal);
      await r.clock.advance(500);
      ctl.abort("interrupt");
      expect(r.loop.snapshot.wheels).to.deep.equal([0, 0]);
      expect(r.loop.link).to.equal(D.LINK.ARMED);
      await r.clock.advance(300);
      const res = await done;
      expect(res).to.include({ status: "aborted", reason: "interrupt" });
      expect(r.bridge.snapshot.drive).to.deep.equal([0, 0]);
      expect(r.bridge.snapshot.state).to.equal(P.STATE.ARMED);
      expect(r.spies.setPose).to.have.length(0);
      // and the next plan simply runs
      const next = r.ex.run([{ tool: "look", pan: 20 }], new AbortController().signal);
      await r.clock.advance(800);
      expect((await next).status).to.equal("done");
      expect(r.bridge.snapshot.commanded[0]).to.equal(200);
    });

    it("a watchdog latch aborts the plan and reports the bridge's reason", async () => {
      const r = await rig("rover", { speed: 100 });
      const done = r.ex.run([drive("forward", 3), { tool: "look", pan: 40 }], new AbortController().signal);
      await r.clock.advance(300);
      r.tr.sendCmd = () => Promise.resolve(); // the phone's commands stop arriving
      await r.clock.advance(700);
      const res = await done;
      expect(res.status).to.equal("aborted");
      expect(res.reason).to.match(/watchdog/i);
      expect(r.loop.link).to.equal(D.LINK.LATCHED);
      expect(r.spies.setPose).to.have.length(0);
      expect(r.ex.running).to.equal(false);
    });

    it("a low battery latch aborts a plan between steps and mid-gesture", async () => {
      const r = await rig("desk", { speed: 100 });
      const done = r.ex.run([{ tool: "gesture", name: "wave" }, { tool: "gesture", name: "nod" }], new AbortController().signal);
      await r.clock.advance(1000);
      r.bridge.setBattery(5000);
      await r.clock.advance(400);
      const res = await done;
      expect(res.status).to.equal("aborted");
      expect(res.reason).to.match(/Battery low/i);
      const n = r.spies.setPose.length;
      await r.clock.advance(8000);
      expect(r.spies.setPose).to.have.length(n);
    });

    it("a plan that needs to move is refused while the robot is LATCHED, and nothing is sent", async () => {
      const r = await rig("rover", { arm: false });
      expect(r.loop.link).to.equal(D.LINK.LATCHED);
      const res = await r.ex.run([drive("forward", 1), { tool: "look", pan: 10 }], new AbortController().signal);
      expect(res.status).to.equal("refused");
      expect(res.reason).to.equal("Press ARM to let me move. I can't arm the robot.");
      await r.clock.advance(1000);
      expect(r.spies.setPose).to.have.length(0);
      expect(r.spies.frames).to.have.length(0);
      expect(r.loop.link).to.equal(D.LINK.LATCHED);
      expect(r.bridge.snapshot.state).to.equal(P.STATE.LATCHED);
    });

    it("talking and stopping need no ARM: say and stop run while latched; stop latches an armed robot", async () => {
      const r = await rig("rover", { arm: false });
      const res = await r.ex.run([{ tool: "say", text: "hello" }, { tool: "stop" }], new AbortController().signal);
      expect(res.status).to.equal("stopped");
      expect(r.events.some((e) => e.type === "say" && e.text === "hello")).to.equal(true);
      const s = await r.ex.run([{ tool: "say", text: "just talking" }], new AbortController().signal);
      expect(s.status).to.equal("done");

      const a = await rig("rover", { speed: 100 });
      const done = a.ex.run([drive("forward", 3), { tool: "stop" }, drive("back", 1)], new AbortController().signal);
      await a.clock.advance(3200);
      expect((await done).status).to.equal("stopped");
      expect(a.loop.link).to.equal(D.LINK.LATCHED);
      expect(a.bridge.snapshot.latch).to.equal(P.LATCH.USER_STOP);
    });

    it("an already aborted signal runs nothing; a second run while running is refused", async () => {
      const r = await rig("rover", { speed: 100 });
      const ctl = new AbortController();
      ctl.abort("stop");
      expect((await r.ex.run([drive("forward", 1)], ctl.signal)).status).to.equal("aborted");
      expect(r.spies.frames.filter((f) => f.left || f.right)).to.deep.equal([]);
      const first = r.ex.run([drive("forward", 1)], new AbortController().signal);
      expect(r.ex.running).to.equal(true);
      expect((await r.ex.run([drive("back", 1)], new AbortController().signal)).status).to.equal("refused");
      await r.clock.advance(1500);
      expect((await first).status).to.equal("done");
      expect(r.ex.running).to.equal(false);
    });

    it("emits step events in order", async () => {
      const r = await rig("rover", { speed: 100 });
      const p = r.ex.run([{ tool: "say", text: "go" }, { tool: "wait", seconds: 0.5 }, drive("forward", 0.2)], new AbortController().signal);
      await r.clock.advance(1000);
      await p;
      const kinds = r.events.map((e) => (e.type === "step-start" || e.type === "step-end" ? `${e.type}:${e.index}` : e.type));
      expect(kinds).to.deep.equal(["plan-start", "step-start:0", "say", "step-end:0", "step-start:1", "step-end:1", "step-start:2", "step-end:2", "done"]);
    });

    it("garbage steps cannot reach the loop: an unvalidated plan is skipped, not executed", async () => {
      const r = await rig("rover", { speed: 100 });
      const res = await r.ex.run([{ tool: "arm" }, { tool: "connect" }, { tool: "drive", direction: "sideways", seconds: 1 }, null, 7], new AbortController().signal);
      await r.clock.advance(500);
      expect(res.status).to.equal("done");
      expect(r.spies.frames.filter((f) => f.left || f.right)).to.deep.equal([]);
      expect(r.spies.arm).to.equal(0);
    });
  });

  describe("security review fixes", () => {
    it("holdFor is refused while a human holds the controls: the AI never takes over a human's stick", async () => {
      const r = await rig("rover", { speed: 100 });
      r.loop.setHeld(true);
      r.loop.setStick(0, 1);
      expect(r.loop.holdFor(1000, 1, 0)).to.equal(false);
      expect(r.loop.snapshot.wheels).to.deep.equal([P.DRIVE_MAX, P.DRIVE_MAX]); // the human's forward drive, untouched
      r.loop.setHeld(false);
      expect(r.loop.holdFor(500, 0, 1)).to.equal(true);
      expect(r.loop.holdFor(500, 0, 1), "a lease may renew its own lease").to.equal(true);
    });

    it("a hard 45 s wall-clock deadline ends any plan, whatever its estimates said; the robot stays armed", async () => {
      const r = await rig("desk", { speed: 5 });
      const steps = Array.from({ length: 12 }, (_, i) => ({ tool: "set_joints", joints: { torso_yaw: i % 2 ? -120 : 120 } })); // 8 s each at 5 %
      expect(X.PLAN_DEADLINE_MS).to.equal(45000);
      const t0 = r.clock.now();
      const done = r.ex.run(steps, new AbortController().signal);
      await r.clock.advance(50000);
      const res = await done;
      expect(res.status).to.equal("aborted");
      expect(res.reason).to.equal(X.PLAN_TIMEOUT);
      expect(res.latched).to.equal(false);
      expect(res.completed).to.be.lessThan(12);
      expect(r.spies.setPose.filter((s) => s.t >= t0 + X.PLAN_DEADLINE_MS), "no move after the deadline").to.deep.equal([]);
      expect(r.loop.link).to.equal(D.LINK.ARMED);
      expect(r.ex.running).to.equal(false);
    });

    it("the plan budget uses the live speed: at 10 % only the turns that fit in 30 s run", async () => {
      const r = await rig("rover", { speed: 10 });
      const done = r.ex.run(Array.from({ length: 12 }, () => ({ tool: "turn", degrees: 180 })), new AbortController().signal); // 9 s each
      await r.clock.advance(40000);
      const res = await done;
      expect(res.status).to.equal("done");
      expect(res.total).to.equal(3);
      expect(nonzero(r.loop.snapshot.wheels)).to.equal(false);
    });
  });
});
