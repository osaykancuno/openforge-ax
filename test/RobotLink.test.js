const { expect } = require("chai");

// Robot Link (web/js/robot): STS bus protocol, virtual SO-101, guided calibration and the safety-first player.
describe("Robot Link (web/js/robot)", () => {
  let bus, va, cal, pl, sim, ep, auto;
  before(async () => {
    bus = await import("../web/js/robot/sts-bus.js");
    va = await import("../web/js/robot/virtual-arm.js");
    cal = await import("../web/js/robot/calibration.js");
    pl = await import("../web/js/robot/player.js");
    sim = await import("../web/js/sim/arm-sim.js");
    ep = await import("../web/js/sim/episode.js");
    auto = await import("../web/js/sim/autopilot.js");
  });

  const SEED = "0x" + "1234abcd".repeat(8);
  // The "real" arm the tests calibrate: raw = zero + sign * deg * k; gripper closed at 1500, opens upward.
  const TRUE_ZERO = [2048, 2100, 1990, 2010, 2048];
  const TRUE_SIGN = [1, -1, 1, -1, 1];
  const SWEEP = [[-115, 115], [-105, 105], [-105, 105], [-105, 105], [-30, 30]];
  const GRIP = (pct) => 1500 + 11 * pct;
  const trueRaw = (i, d) => (i === 5 ? GRIP(d) : Math.round(TRUE_ZERO[i] + TRUE_SIGN[i] * d * cal.STEPS_PER_DEG));

  function fakeClock() {
    let t = 0;
    return {
      now: () => t,
      sleep: async (ms) => {
        t += Math.max(0, ms);
        await new Promise((r) => setImmediate(r));
      },
      jump: (ms) => (t += ms),
    };
  }

  function rig() {
    const clock = fakeClock();
    const arm = va.createVirtualArm({ now: clock.now, start: sim.REST.map((d, i) => trueRaw(i, d)) });
    const b = bus.createBus(arm.transport);
    return { clock, arm, b };
  }

  /** What the wizard does with the user's hands: pose, then each joint the way the twin shows and to both ends. */
  function handCalibration(arm) {
    const poseRaw = cal.POSE.map((d, i) => trueRaw(i, d));
    poseRaw.forEach((r, i) => arm.hand(i + 1, r));
    const trackers = poseRaw.map((r) => cal.createRangeTracker(r));
    for (let i = 0; i < 6; i++) {
      const path = i === 5 ? [10, 50, 105, 0] : [cal.POSE[i] + 15, SWEEP[i][1], SWEEP[i][0], cal.POSE[i]];
      let at = cal.POSE[i];
      for (const d of path) // a hand moves continuously: sample every 5 deg, as the wizard's 20 Hz polling would
        for (; Math.abs(d - at) > 0; at += Math.sign(d - at) * Math.min(5, Math.abs(d - at))) trackers[i].update(trueRaw(i, at));
      trackers[i].update(trueRaw(i, at));
    }
    return cal.buildCalibration({ poseRaw, trackers });
  }

  const run = () => ep.buildEpisode({ tokenId: 7, challengeId: "0x" + "0".repeat(64), seed: SEED, actions: auto.autopilot(SEED) });

  describe("STS protocol", () => {
    it("builds packets with the Feetech checksum (PING id 1 = FF FF 01 02 01 FB)", () => {
      expect(Array.from(bus.packet(1, bus.INST.PING))).to.deep.equal([0xff, 0xff, 0x01, 0x02, 0x01, 0xfb]);
    });

    it("parses fragmented streams, skips noise and corrupt packets", () => {
      const got = [];
      const push = bus.createParser((p) => got.push(p));
      const good = [0xff, 0xff, 0x02, 0x04, 0x00, 0x34, 0x12];
      good.push(bus.checksum(good.slice(2)));
      const bad = good.slice();
      bad[5] ^= 0xff;
      const stream = [0x00, 0xff, 0x13, ...bad, ...good, 0xff];
      for (const b of stream) push([b]);
      expect(got).to.have.length(1);
      expect(got[0].id).to.equal(2);
      expect(bus.readU16(got[0].params)).to.equal(0x1234);
    });

    it("encodes positions as sign-magnitude (LeRobot-calibrated arms read below zero)", () => {
      expect(bus.decodePos(bus.readU16(bus.encodePos(-300)))).to.equal(-300);
      expect(bus.decodePos(bus.readU16(bus.encodePos(4000)))).to.equal(4000);
    });

    it("ignores echoed TX bytes from half-duplex adapters", async () => {
      const arm = va.createVirtualArm();
      const echo = {
        write: (bytes) => (listener(bytes), arm.transport.write(bytes)),
        onData: (cb) => ((listener = cb), arm.transport.onData(cb)),
      };
      let listener;
      const b = bus.createBus(echo);
      expect(bus.readU16(await b.read(3, bus.REG.MODEL, 2))).to.equal(bus.STS3215_MODEL);
    });
  });

  describe("connect", () => {
    it("finds six STS3215 servos in position mode", async () => {
      const { b } = rig();
      const s = await pl.scan(b);
      expect(s.found).to.deep.equal([1, 2, 3, 4, 5, 6]);
      expect(s.problems).to.deep.equal([]);
      expect(s.volts).to.equal(12);
    });

    it("refuses servos not in position mode and flags missing ones and low voltage", async () => {
      const arm = va.createVirtualArm({ ids: [1, 2, 3, 4, 5], mode: 1, volts: 4.6 });
      const s = await pl.scan(bus.createBus(arm.transport, { retries: 0, timeoutMs: 5 }));
      expect(s.missing).to.deep.equal([6]);
      expect(s.problems.join(" ")).to.match(/not in position mode/).and.match(/power supply/);
      expect(s.hint).to.match(/gripper/);
    });

    it("explains factory IDs when only ID 1 answers", async () => {
      const s = await pl.scan(bus.createBus(va.createVirtualArm({ ids: [1] }).transport, { retries: 0, timeoutMs: 5 }));
      expect(s.hint).to.match(/ship as ID 1/);
    });
  });

  describe("guided calibration", () => {
    it("recovers each joint's zero and direction from a hands-on session", () => {
      const c = handCalibration(va.createVirtualArm());
      expect(cal.validCalibration(c)).to.equal(true);
      for (const pose of [sim.REST, cal.POSE, [30, 20, 60, 40, 15, 50]]) {
        const raw = cal.simToRaw(c, pose);
        pose.forEach((d, i) => expect(Math.abs(raw[i] - trueRaw(i, d))).to.be.lte(i === 5 ? 60 : 1));
      }
      expect(c.safe[4]).to.deep.equal([-100, 100]); // wrist roll: fixed window, no sweep needed
      expect(c.safe[0]).to.deep.equal([-110, 110]); // measured range minus margin, clipped to the sim
    });

    it("explains what to redo: no direction, too little travel, a servo that is not centred", () => {
      const poseRaw = cal.POSE.map((d, i) => trueRaw(i, d));
      const fresh = () => poseRaw.map((r) => cal.createRangeTracker(r));
      const sweep = (t) => t.forEach((tr, i) => [cal.POSE[i] + 20, cal.POSE[i] + 80, cal.POSE[i] - 40].forEach((d) => tr.update(trueRaw(i, i === 5 ? Math.max(0, d) : d))));
      let t = fresh();
      expect(() => cal.buildCalibration({ poseRaw, trackers: t })).to.throw(/did not see the shoulder pan/);
      t = fresh();
      sweep(t);
      t[1] = cal.createRangeTracker(poseRaw[1]);
      t[1].update(poseRaw[1] + 200);
      expect(() => cal.buildCalibration({ poseRaw, trackers: t })).to.throw(/only moved/);
      t = fresh();
      sweep(t);
      t[2].update(poseRaw[2] + 3000); // wrapped reading
      expect(() => cal.buildCalibration({ poseRaw, trackers: t })).to.throw(/not centred/);
    });

    it("the wizard only moves on once a joint's travel also covers the rest pose", () => {
      const r0 = trueRaw(1, cal.POSE[1]);
      const t = cal.createRangeTracker(r0);
      expect(cal.jointStatus(t, 1, r0)).to.equal("dir");
      for (let d = 0; d <= 100; d += 5) t.update(trueRaw(1, d)); // forward only: rest (-30) not reached
      expect(cal.jointStatus(t, 1, r0)).to.equal("other");
      for (let d = 100; d >= -60; d -= 5) t.update(trueRaw(1, d));
      expect(cal.jointStatus(t, 1, r0)).to.equal("ok");
    });

    it("a wrong direction found by the nudge test is fixed by flipping that joint", () => {
      const c = handCalibration(va.createVirtualArm());
      const wrong = cal.flipJoint(c, 1);
      expect(wrong.sign[1]).to.equal(-c.sign[1]);
      const back = cal.flipJoint(wrong, 1);
      expect(cal.simToRaw(back, sim.REST)).to.deep.equal(cal.simToRaw(c, sim.REST));
      expect(() => cal.flipJoint(c, 5)).to.throw(/fully closed/);
    });

    it("notices on reconnect when a different arm (or a swapped servo) is plugged in", () => {
      const c = handCalibration(va.createVirtualArm());
      const rest = sim.REST.map((d, i) => trueRaw(i, d));
      expect(cal.matchesArm(c, rest)).to.equal(-1);
      expect(cal.matchesArm(c, rest.map((r, i) => (i === 2 ? r + 3000 : r)))).to.equal(2);
    });
  });

  describe("run checks and routes", () => {
    it("accepts a clean run and refuses broken, unsafe or out-of-reach ones in plain English", () => {
      const c = handCalibration(va.createVirtualArm());
      expect(pl.checkRun(run(), c).problems).to.deep.equal([]);
      expect(pl.checkRun({ hello: 1 }).problems[0]).to.match(/not an OpenForge/);
      const jumpy = run();
      jumpy.actions[5] = jumpy.actions[5].map((v, i) => (i === 0 ? v + 30 : v));
      expect(pl.checkRun(jumpy).problems[0]).to.match(/movement rules/);
      const narrow = { ...c, safe: c.safe.map((r, i) => (i === 0 ? [-5, 5] : r)) };
      expect(pl.checkRun(run(), narrow).problems.join()).to.match(/shoulder pan would go past/);
    });

    it("routes moves around the table: direct when clear, raised when the straight line would dip", () => {
      const c = handCalibration(va.createVirtualArm());
      expect(pl.safeRoute(c, sim.REST, cal.POSE)).to.have.length(1);
      // the hand swings through "pointing straight down": both ends ~15 mm up, the middle scrapes the table
      const low = [0, 20, 100, 30, 0, 100];
      const other = [0, 20, 100, 90, 0, 100];
      expect(pl.minHeight(low, other)).to.be.lt(0.005);
      expect(pl.clearMove(low, other)).to.equal(false);
      const r = pl.safeRoute(c, low, other);
      expect(r.length).to.be.gte(2);
      let a = low;
      for (const w of r) (expect(pl.clearMove(a, w)).to.equal(true), (a = w));
      expect(pl.clearMove(sim.REST, [0, 60, 90, 60, 0, 100])).to.equal(false); // a target below the table is never clear
    });

    it("the in-the-air rehearsal stays above the table and obeys the sim's command limits", () => {
      const air = pl.inTheAir(run().actions);
      expect(sim.validateActions(air)).to.equal(null);
      expect(Math.min(...air.map((a) => sim.fk(a).tip.z))).to.be.gte(0.05);
    });
  });

  describe("security review regressions", () => {
    const calOf = () => handCalibration(va.createVirtualArm());

    it("[C1] a NaN or zero speed can never reach the servo as 0 (= unlimited)", async () => {
      const vel = (b) => bus.readU16(b, 5);
      expect(vel(pl.motionBlock(2048, NaN, 0))).to.equal(1);
      expect(vel(pl.motionBlock(2048, 0, 0))).to.equal(1);
      expect(vel(pl.motionBlock(2048, 1e9, 0))).to.be.lte(Math.ceil(pl.HW_MAX_DEG_S * 1.2 * cal.STEPS_PER_DEG));
      expect(() => pl.motionBlock(NaN, 100, 0)).to.throw(/invalid target/);
      const { b } = rig();
      const c = calOf();
      expect(() => pl.createPlayer({ bus: b, cal: c, actions: run().actions, speed: NaN })).to.throw(/speed/);
      let err;
      await pl.moveSafely(b, c, sim.REST, { speed: 0 }).catch((e) => (err = e));
      expect(err.message).to.match(/invalid speed/);
    });

    it("[C2] frames after the sim mission ends are still checked: a run cannot dive into the table after docking", () => {
      const hostile = run();
      let last = hostile.actions[hostile.actions.length - 1];
      for (let k = 0; k < 40; k++) {
        last = sim.limitStep(last, [last[0], 100, 100, 100, last[4], last[5]]);
        hostile.actions.push(last);
      }
      expect(sim.replay(hostile.seed, hostile.actions).reason).to.equal("docked"); // the sim alone would accept it
      expect(pl.checkRun(hostile).problems.join()).to.match(/touch the table/);
    });

    it("[H4] a stored calibration cannot be widened, moved to another arm, or reused without a physical check", () => {
      const c = calOf();
      expect(cal.validCalibration(c, c.eeprom)).to.equal(true);
      expect(cal.validCalibration({ ...c, safe: c.safe.map(() => [-1e9, 1e9]) })).to.equal(false);
      expect(cal.validCalibration({ ...c, safe: c.safe.map((r, i) => (i === 1 ? [r[0] - 20, r[1]] : r)) })).to.equal(false);
      expect(cal.validCalibration({ ...c, zero: c.zero.map((z) => z + 1e6) })).to.equal(false);
      expect(cal.validCalibration(c, c.eeprom.map((r, i) => (i === 2 ? [r[0] + 1, r[1]] : r)))).to.equal(false);
      const rest = sim.REST.map((d, i) => trueRaw(i, d));
      expect(cal.nearRest(c, rest)).to.equal(-1);
      expect(cal.nearRest(c, rest.map((r, i) => (i === 1 ? r + 30 * cal.STEPS_PER_DEG : r)))).to.equal(1); // other arm / offsets
    });

    it("[H5] hostile speed and jitter: shaking runs are refused, fast runs are slowed to the hardware ceiling", () => {
      const shaky = run();
      const base = shaky.actions[shaky.actions.length - 1];
      for (let k = 0; k < 30; k++) shaky.actions.push(base.map((v, i) => (i === 0 ? Math.round((v + (k % 2 ? 0 : 6)) * 10) / 10 : v)));
      expect(pl.checkRun(shaky).problems.join()).to.match(/shakes back and forth/);
      const fast = run().actions; // the autopilot moves up to 6 deg per tick = 180 deg/s at 1x
      expect(pl.effectiveSpeed(fast, 1) * 6 * sim.FPS).to.be.lte(pl.HW_MAX_DEG_S + 1e-6);
      const caps = pl.velocityCaps(fast, 1, calOf());
      expect(Math.max(...caps)).to.be.lte(Math.ceil(pl.HW_MAX_DEG_S * 1.2 * cal.STEPS_PER_DEG));
    });

    it("[M7] a bus glitch mid-run freezes the arm (torque stays on); UI callback errors cannot break the loop", async () => {
      const r = rig();
      const c = handCalibration(r.arm);
      sim.REST.forEach((d, i) => r.arm.hand(i + 1, trueRaw(i, d)));
      let reads = 0;
      const flaky = { ...r.b, syncRead: (...a) => (++reads === 40 ? Promise.reject(new Error("USB hiccup")) : r.b.syncRead(...a)) };
      const p = pl.createPlayer({ bus: flaky, cal: c, actions: run().actions, clock: r.clock, onFrame: () => { throw new Error("UI bug"); } });
      await p.start();
      expect(p.state).to.equal("error");
      expect(r.arm.torque(2)).to.equal(true);
    });

    it("[M8] moves from wherever the arm is are slow: route frames never exceed MOVE_SPEED", () => {
      const from = [60, 40, 20, 30, 90, 0];
      for (const speed of [0.25, 0.5, 1]) {
        const f = pl.routeFrames(from, [sim.REST], speed);
        let peak = 0;
        let a = from;
        for (const x of f) (peak = Math.max(peak, ...x.slice(0, 5).map((v, i) => Math.abs(v - a[i])))), (a = x);
        expect(peak * sim.FPS * speed).to.be.lte(pl.MOVE_SPEED + 1e-6);
      }
    });

    it("[M13] goals are always clamped into the safe range at the write layer", () => {
      const c = calOf();
      const wild = [500, -500, 500, -500, 500, 500];
      expect(pl.goalsFor(c, wild)).to.deep.equal(cal.simToRaw(c, cal.clampSafe(c, wild)));
    });

    it("[L14] relax reads torque back from every servo", async () => {
      const { b, arm, clock } = rig();
      await pl.holdHere(b, clock);
      expect(arm.torque(3)).to.equal(true);
      expect(await pl.relax(b)).to.equal(true);
      expect([1, 2, 3, 4, 5, 6].some((id) => arm.torque(id))).to.equal(false);
    });
  });

  describe("code review regressions", () => {
    const seedN = (i) => "0x" + i.toString(16).padStart(8, "0").repeat(8);

    it("[R1] the in-the-air rehearsal is smooth: every run that passes the checks also passes as a rehearsal (30 missions)", () => {
      let tried = 0;
      for (let i = 1; i <= 30; i++) {
        const actions = auto.autopilot(seedN(i));
        if (pl.motionProblems(actions).length) continue;
        tried++;
        const air = pl.inTheAir(actions);
        expect(pl.motionProblems(air), `seed ${i}`).to.deep.equal([]);
        expect(Math.min(...air.map((a) => sim.fk(a).tip.z)), `seed ${i}`).to.be.gte(0.045);
      }
      expect(tried).to.be.gte(20);
    });

    it("[R1] liftPose keeps pan, hand pitch, roll and gripper, and raises the tip by exactly dz", () => {
      const a = sim.quantize(sim.ik({ x: 0.18, y: 0.05, z: 0.03 }, 20, 40)); // runs carry 0.1 deg precision
      const b = pl.liftPose(a, 0.05);
      expect(b[0]).to.equal(a[0]);
      expect(b[4]).to.equal(a[4]);
      expect(b[5]).to.equal(a[5]);
      expect(Math.abs(sim.fk(b).pitch - sim.fk(a).pitch)).to.be.lt(0.2);
      expect(Math.abs(sim.fk(b).tip.z - sim.fk(a).tip.z - 0.05)).to.be.lt(0.002);
    });

    it("[R5] a guided move (return to rest) stops quickly when something blocks the arm", async () => {
      const r = rig();
      const c = handCalibration(r.arm);
      const low = sim.ik({ x: 0.2, y: 0.12, z: 0.06 }, 0, 100);
      low.forEach((d, i) => r.arm.hand(i + 1, trueRaw(i, d)));
      await pl.holdHere(r.b, r.clock);
      const at = r.arm.position(1);
      r.arm.block(1, at - 2 * cal.STEPS_PER_DEG, at + 2 * cal.STEPS_PER_DEG);
      const t0 = r.clock.now();
      let err;
      await pl.moveSafely(r.b, c, sim.REST, { clock: r.clock }).catch((e) => (err = e));
      expect(err.message).to.match(/blocking the shoulder pan/);
      expect(r.clock.now() - t0).to.be.lt(2500);
      expect(r.arm.torque(2)).to.equal(true);
    });

    it("[R7] a gripper whose EEPROM end is short of the hand-measured opening still calibrates, with 'open' reachable", () => {
      const poseRaw = cal.POSE.map((d, i) => trueRaw(i, d));
      const trackers = poseRaw.map((r) => cal.createRangeTracker(r));
      const sweep = [[-115, 115], [-105, 105], [-105, 105], [-105, 105], [-30, 30], [0, 105]];
      trackers.forEach((t, i) => {
        let at = cal.POSE[i];
        for (const d of [cal.POSE[i] + 15, sweep[i][1], sweep[i][0], cal.POSE[i]])
          for (; at !== d; at += Math.sign(d - at) * Math.min(5, Math.abs(d - at))) t.update(trueRaw(i, at));
      });
      const eeprom = sim.JOINTS.map((_, i) => (i === 5 ? [0, trueRaw(5, 95)] : [0, 4095]));
      const c = cal.buildCalibration({ poseRaw, trackers, eeprom });
      expect(c.safe[5][1]).to.equal(100);
      expect(cal.degToRaw(c, 5, 100)).to.be.lte(eeprom[5][1]);
      expect(cal.validCalibration(c, eeprom)).to.equal(true);
    });

    it("[R8] an error raised after torque is on (even a SafetyError) halts the arm", async () => {
      const r = rig();
      const c = handCalibration(r.arm);
      sim.REST.forEach((d, i) => r.arm.hand(i + 1, trueRaw(i, d)));
      let writes = 0;
      const bad = { ...r.b, syncWrite: (...a) => (++writes === 30 ? Promise.reject(new pl.SafetyError("simulated")) : r.b.syncWrite(...a)) };
      const p = pl.createPlayer({ bus: bad, cal: c, actions: run().actions, clock: r.clock });
      await p.start();
      expect(p.state).to.equal("error");
      const here = [1, 2, 3, 4, 5, 6].map((id) => r.arm.position(id));
      await r.clock.sleep(2000);
      [1, 2, 3, 4, 5, 6].forEach((id, i) => expect(Math.abs(r.arm.position(id) - here[i])).to.be.lte(2));
      expect(r.arm.torque(2)).to.equal(true);
    });
  });

  describe("playing on the (virtual) arm", () => {
    async function calibrated() {
      const r = rig();
      const c = handCalibration(r.arm);
      sim.REST.forEach((d, i) => r.arm.hand(i + 1, trueRaw(i, d)));
      return { ...r, c };
    }

    it("torque comes on with goal = present: nothing jumps", async () => {
      const { b, arm, clock } = await calibrated();
      const before = [1, 2, 3, 4, 5, 6].map((id) => arm.position(id));
      await pl.holdHere(b, clock);
      await clock.sleep(500);
      [1, 2, 3, 4, 5, 6].forEach((id, i) => expect(Math.abs(arm.position(id) - before[i])).to.be.lte(1));
      const firstTorque = arm.log.findIndex((w) => w.addr === bus.REG.TORQUE && w.data[0] === 1);
      expect(arm.log.slice(0, firstTorque).filter((w) => w.addr === bus.REG.ACCEL)).to.have.length(6);
    });

    it("plays a run to the end at 0.5x, never with an unlimited speed or acceleration, and ends at rest", async () => {
      const { b, arm, clock, c } = await calibrated();
      const states = [];
      const p = pl.createPlayer({ bus: b, cal: c, actions: run().actions, clock, onState: (s) => states.push(s) });
      await p.start();
      expect(states).to.deep.equal(["starting", "playing", "done"]);
      sim.REST.forEach((d, i) => expect(Math.abs(arm.position(i + 1) - trueRaw(i, d))).to.be.lte(i === 5 ? 60 : 12));
      const blocks = arm.log.filter((w) => w.addr === bus.REG.ACCEL);
      expect(blocks.every((w) => w.data[0] > 0 && bus.readU16(w.data, 5) > 0 && bus.readU16(w.data, 7) <= 800)).to.equal(true);
      expect(arm.log.every((w) => w.addr !== bus.REG.TORQUE || w.data[0] <= 1)).to.equal(true);
    });

    it("STOP freezes the arm where it is; nothing moves afterwards", async () => {
      const { b, arm, clock, c } = await calibrated();
      let p;
      let frames = 0;
      p = pl.createPlayer({ bus: b, cal: c, actions: run().actions, clock, onFrame: () => ++frames === 120 && p.stop() });
      await p.start();
      expect(p.state).to.equal("stopped");
      const here = [1, 2, 3, 4, 5, 6].map((id) => arm.position(id));
      await clock.sleep(3000);
      [1, 2, 3, 4, 5, 6].forEach((id, i) => expect(Math.abs(arm.position(id) - here[i])).to.be.lte(2));
      expect(arm.torque(2)).to.equal(true);
    });

    it("a blocked joint makes the arm hold still", async () => {
      const { b, arm, clock, c } = await calibrated();
      const now = arm.position(1);
      arm.block(1, now - 3 * cal.STEPS_PER_DEG, now + 3 * cal.STEPS_PER_DEG);
      const msgs = [];
      const p = pl.createPlayer({ bus: b, cal: c, actions: run().actions, clock, onState: (s, m) => msgs.push(m) });
      await p.start();
      expect(p.state).to.equal("blocked");
      expect(msgs.pop()).to.match(/blocking the shoulder pan/);
      expect(Math.abs(arm.goal(1) - arm.position(1))).to.be.lte(2);
    });

    it("a servo fault (overload, heat, power) freezes the arm", async () => {
      const { b, arm, clock, c } = await calibrated();
      let n = 0;
      const p = pl.createPlayer({ bus: b, cal: c, actions: run().actions, clock, onFrame: () => ++n === 30 && arm.setError(3, bus.ERR.OVERLOAD) });
      await p.start();
      expect(p.state).to.equal("blocked");
    });

    it("a stalled tab (timer paused) freezes the arm instead of catching up", async () => {
      const { b, clock, c } = await calibrated();
      let n = 0;
      const msgs = [];
      const p = pl.createPlayer({ bus: b, cal: c, actions: run().actions, clock, onFrame: () => ++n === 40 && clock.jump(600), onState: (s, m) => msgs.push(m) });
      await p.start();
      expect(p.state).to.equal("stopped");
      expect(msgs.pop()).to.match(/browser paused/);
    });

    it("a browser that is merely a bit slow plays on (slower), without a false stall", async () => {
      const { b, clock, c } = await calibrated();
      const p = pl.createPlayer({ bus: b, cal: c, actions: run().actions, clock, onFrame: () => clock.jump(12) }); // every tick 12 ms late
      await p.start();
      expect(p.state).to.equal("done");
    });

    it("refuses to turn torque on while the arm is still being moved by hand", async () => {
      const { b, arm, clock } = await calibrated();
      let wobble = 0;
      const sleep = clock.sleep;
      clock.sleep = async (ms) => (arm.hand(2, arm.position(2) + (wobble++ % 2 ? 30 : -30)), sleep(ms));
      let err;
      await pl.holdHere(b, clock).catch((e) => (err = e));
      expect(err.message).to.match(/kept moving/);
      expect(arm.torque(2)).to.equal(false);
    });

    it("moves still work when the measured pose sits just past the safety margin (gripper fully open)", async () => {
      const { b, arm, clock, c } = await calibrated();
      arm.hand(6, trueRaw(5, 102)); // a hand opened the gripper past the calibrated "open"
      await pl.holdHere(b, clock);
      const cur = cal.clampSafe(c, cal.rawToSim(c, (await pl.readState(b)).raw));
      const there = cur.slice();
      there[0] += 8;
      expect(await pl.moveSafely(b, c, there, { clock })).to.equal(true);
      expect(await pl.moveSafely(b, c, cur, { clock })).to.equal(true);
    });

    it("return to rest is driven by the servos, along a clear route", async () => {
      const { b, arm, clock, c } = await calibrated();
      const low = sim.ik({ x: 0.2, y: 0.12, z: 0.03 }, 0, 100);
      low.forEach((d, i) => arm.hand(i + 1, trueRaw(i, d)));
      await pl.holdHere(b, clock);
      expect(await pl.moveSafely(b, c, sim.REST, { clock })).to.equal(true);
      sim.REST.slice(0, 5).forEach((d, i) => expect(Math.abs(arm.position(i + 1) - trueRaw(i, d))).to.be.lte(3 * cal.STEPS_PER_DEG));
    });
  });
});
