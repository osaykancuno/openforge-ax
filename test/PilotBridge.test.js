const { expect } = require("chai");

// Phone Brain: the bridge state machine (web/js/pilot/bridge-sim.js, reference for the ESP32 firmware), the
// phone drive loop, the twin transport and the camera motion tracker.
describe("Phone Brain bridge + drive loop (web/js/pilot)", () => {
  let P, B, D, T, S;
  before(async () => {
    P = await import("../web/js/pilot/ax-proto.js");
    B = await import("../web/js/pilot/bridge-sim.js");
    D = await import("../web/js/pilot/drive-loop.js");
    T = await import("../web/js/pilot/twin-transport.js");
    S = await import("../web/js/pilot/sensors.js");
  });

  /** Fake timers: advance(ms) fires due timers in order and lets promises settle between them. */
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

  // ------------------------------------------------------------ bridge state machine

  function bridge(body, opts = {}) {
    const b = B.createBridge({ body, now: 0, ...opts });
    b.pressBoot(2000);
    expect(b.connect({ id: "phone" }).ok).to.equal(true);
    return b;
  }
  const arm = (b, nonce = 1, seqBase = 100) => b.writeArm(P.encodeArm({ nonce, seqBase }));
  const drive = (b, seq, left, right = left, extra = {}) => b.writeCmd(P.encodeDrive({ seq, mask: 1, left, right, ...extra }));

  it("boots latched with torque off and drops commands until ARM", () => {
    const b = bridge(P.BODY.ROVER);
    expect(b.snapshot.state).to.equal(P.STATE.LATCHED);
    expect(b.snapshot.latch).to.equal(P.LATCH.BOOT);
    expect(b.snapshot.torque).to.equal(false);
    expect(drive(b, 1, 500)).to.equal(P.ERR.STATE);
    expect(arm(b)).to.equal(P.ERR.OK);
    expect(b.snapshot.state).to.equal(P.STATE.ARMED);
    expect(drive(b, 101, 500)).to.equal(P.ERR.OK);
  });

  it("watchdog: no valid CMD for 250 ms -> hold + latch; it never resumes on its own", () => {
    const b = bridge(P.BODY.ROVER);
    arm(b);
    drive(b, 101, 1000);
    b.tick(200);
    expect(b.snapshot.drive[0]).to.be.greaterThan(0);
    b.tick(260);
    expect(b.snapshot.state).to.equal(P.STATE.LATCHED);
    expect(b.snapshot.latch).to.equal(P.LATCH.WATCHDOG);
    expect(b.snapshot.drive).to.deep.equal([0, 0]);
    expect(b.snapshot.brake).to.equal(true);
    expect(drive(b, 102, 1000)).to.equal(P.ERR.STATE); // fresh commands do not re-arm
    b.tick(10000);
    expect(b.snapshot.state).to.equal(P.STATE.LATCHED);
    expect(b.snapshot.torque).to.equal(true); // no fault, no request: it keeps holding
    expect(arm(b, 2, 200)).to.equal(P.ERR.OK);
  });

  it("torque off after WD_RELAX_MS only on a fault or a user RELAX request", () => {
    const b = bridge(P.BODY.DESK);
    arm(b);
    b.writeStop(P.encodeStop(P.STOP_REASON.RELAX));
    b.tick(2900);
    expect(b.snapshot.torque).to.equal(true);
    expect(P.decodeState(b.stateBytes()).flags & P.FLAG.RELAX_PENDING).to.not.equal(0);
    b.tick(3000);
    expect(b.snapshot.torque).to.equal(false);

    const c = bridge(P.BODY.DESK);
    arm(c);
    c.writeCmd(P.encodeJoints({ seq: 101, mask: 1, targets: [100] }));
    c.setServoFault(2);
    c.tick(20);
    expect(c.snapshot.latch).to.equal(P.LATCH.SERVO_FAULT); // fatal servo error -> hold
    expect(c.snapshot.fault & P.FAULT.SERVO_FATAL).to.not.equal(0);
    c.tick(3000);
    expect(c.snapshot.torque).to.equal(true);
    c.tick(3020);
    expect(c.snapshot.torque).to.equal(false);
    expect(arm(c, 2)).to.equal(P.ERR.FAULT); // still faulty
    c.setServoFault(2, false);
    expect(arm(c, 3)).to.equal(P.ERR.OK);
  });

  it("STOP holds the goal at the present position (bus servos) and needs a new ARM", () => {
    const b = bridge(P.BODY.DESK);
    arm(b);
    for (let k = 0; k < 10; k++) {
      b.writeCmd(P.encodeJoints({ seq: 101 + k, mask: 1, targets: [900] }));
      b.tick(20 * (k + 1));
    }
    expect(b.writeStop([])).to.equal(P.ERR.OK); // empty STOP still stops
    const s = b.snapshot;
    expect(s.state).to.equal(P.STATE.LATCHED);
    expect(s.latch).to.equal(P.LATCH.USER_STOP);
    expect(s.commanded).to.deep.equal(s.present);
    expect(s.target).to.deep.equal(s.present);
  });

  it("replay protection: seq must be newer than the last accepted (16-bit wrap, window)", () => {
    const b = bridge(P.BODY.ROVER);
    arm(b, 7, 65530);
    expect(drive(b, 65531, 100)).to.equal(P.ERR.OK);
    expect(drive(b, 65531, 100)).to.equal(P.ERR.SEQ); // replay
    expect(drive(b, 65000, 100)).to.equal(P.ERR.SEQ); // old
    expect(drive(b, 3, 100)).to.equal(P.ERR.OK); // wrapped
    expect(drive(b, 3 + P.SEQ_WINDOW + 1, 100)).to.equal(P.ERR.SEQ); // too far ahead
    expect(b.snapshot.lastSeq).to.equal(3);
    b.writeStop([1, 0]);
    expect(arm(b, 7, 10)).to.equal(P.ERR.NONCE); // ARM nonce reuse refused
    expect(arm(b, 0, 10)).to.equal(P.ERR.NONCE);
    expect(arm(b, 8, 10)).to.equal(P.ERR.OK);
  });

  it("rate limiter 90 deg/s and firmware joint limits apply whatever the phone sends", () => {
    const b = bridge(P.BODY.DESK);
    arm(b);
    let seq = 100;
    const lim = P.BODIES[P.BODY.DESK].joints[0];
    for (let t = 20; t <= 200; t += 20) {
      b.writeCmd(P.encodeJoints({ seq: ++seq, mask: 1, targets: [32767], speed: 100 }));
      b.tick(t);
    }
    expect(b.snapshot.target[0]).to.equal(lim.max); // clamped
    expect(b.snapshot.commanded[0]).to.equal(10 * 18); // 10 ticks x 1.8 deg
    // half speed halves the rate
    const c = bridge(P.BODY.DESK);
    arm(c);
    c.writeCmd(P.encodeJoints({ seq: 101, mask: 1, targets: [-500], speed: 50 }));
    c.tick(100);
    expect(c.snapshot.commanded[0]).to.equal(-5 * 9);
    // masks beyond the body are refused, a DRIVE frame is refused by a body without wheels
    expect(c.writeCmd(P.encodeJoints({ seq: 102, mask: 1 << 9, targets: [0] }))).to.equal(P.ERR.MASK);
    expect(c.writeCmd(P.encodeDrive({ seq: 103, left: 1 }))).to.equal(P.ERR.TYPE);
  });

  it("every control tick resends ACCEL / GOAL / VELOCITY cap / TORQUE_LIMIT in one SYNC_WRITE", () => {
    const b = bridge(P.BODY.DESK);
    expect(B.STS.VEL_CAP).to.equal(1229);
    arm(b);
    b.writeCmd(P.encodeJoints({ seq: 101, mask: 1, targets: [900] }));
    b.tick(20);
    const pkt = Array.from(b.snapshot.lastBus);
    expect(pkt.slice(0, 7)).to.deep.equal([0xff, 0xff, 0xfe, 4 + 7 * 10, 0x83, 41, 9]);
    const goal0 = pkt[8 + 1] | (pkt[8 + 2] << 8);
    expect(goal0).to.equal(P.deciToSteps(18));
    expect(pkt[7]).to.equal(1);
    expect(pkt.slice(8, 17)).to.deep.equal(Array.from(B.motionBlock(P.deciToSteps(18))));
  });

  it("low battery: hold + latch, ARM refused until it recovers with hysteresis", () => {
    const b = bridge(P.BODY.ROVER, { battMv: 7600 });
    arm(b);
    drive(b, 101, 500);
    b.setBattery(6300);
    b.tick(20);
    expect(b.snapshot.latch).to.equal(P.LATCH.LOW_BATT);
    b.setBattery(6500);
    expect(arm(b, 2)).to.equal(P.ERR.FAULT); // inside the hysteresis band
    b.setBattery(7000);
    expect(arm(b, 3)).to.equal(P.ERR.OK);
  });

  it("boot check refuses non-STS3215 servos or a servo not in position mode, forever", () => {
    const b = bridge(P.BODY.DESK, { servoModel: 1234 });
    expect(b.snapshot.state).to.equal(P.STATE.FAULT);
    expect(b.snapshot.fault & P.FAULT.BAD_MODEL).to.not.equal(0);
    expect(arm(b)).to.equal(P.ERR.STATE);
    const c = bridge(P.BODY.WALKER, { servoMode: 3 });
    expect(c.snapshot.fault & P.FAULT.BAD_MODE).to.not.equal(0);
  });

  it("torque-on verify: if a servo jumps when torque comes on, torque goes off again", () => {
    const b = bridge(P.BODY.DESK);
    b.setTorqueJump(true);
    expect(arm(b)).to.equal(P.ERR.FAULT);
    expect(b.snapshot.torque).to.equal(false);
    expect(b.snapshot.fault & P.FAULT.TORQUE_VERIFY).to.not.equal(0);
  });

  it("link security: one connection, bonding only in the pairing window, writes need an authenticated link, MTU >= 64", () => {
    const b = B.createBridge({ body: P.BODY.ROVER });
    expect(b.connect({ id: "stranger" }).ok).to.equal(false); // no window open
    b.pressBoot(2000);
    expect(b.snapshot.pairing).to.equal(true);
    expect(b.connect({ id: "phone" }).ok).to.equal(true);
    expect(b.snapshot.advertising).to.equal(false);
    expect(b.connect({ id: "phone2" }).ok).to.equal(false); // max 1 connection
    b.disconnect();
    b.tick(P.PAIR_WINDOW_MS + 10);
    expect(b.connect({ id: "phone2" }).ok).to.equal(false); // window closed
    expect(b.connect({ id: "phone" }).ok).to.equal(true); // bonded phone is fine
    b.disconnect();
    b.pressBoot(10000); // clears bonds
    expect(b.connect({ id: "phone" }).ok).to.equal(false);

    const c = B.createBridge({ body: P.BODY.ROVER });
    c.pressBoot(2000);
    c.connect({ id: "p", encrypted: false, authenticated: false });
    expect(arm(c)).to.equal(P.ERR.AUTH);
    expect(c.writeStop([1, 0])).to.equal(P.ERR.AUTH);
    c.disconnect();
    c.connect({ id: "p", mtu: 23 });
    expect(c.snapshot.fault & P.FAULT.MTU_LOW).to.not.equal(0);
    expect(arm(c)).to.equal(P.ERR.FAULT);
  });

  it("link loss while armed -> hold + LINK_LOST latch; reconnect stays latched", () => {
    const b = bridge(P.BODY.ROVER);
    arm(b);
    drive(b, 101, 800);
    b.tick(60);
    b.disconnect();
    expect(b.snapshot.latch).to.equal(P.LATCH.LINK_LOST);
    expect(b.snapshot.drive).to.deep.equal([0, 0]);
    expect(b.connect({ id: "phone" }).ok).to.equal(true);
    expect(b.snapshot.state).to.equal(P.STATE.LATCHED);
  });

  it("config mode: limits can only narrow, motion is impossible, the limits hash follows", () => {
    const b = bridge(P.BODY.DESK, { configMode: true });
    expect(arm(b)).to.equal(P.ERR.STATE);
    const h0 = P.decodeInfo(b.infoBytes()).limitsHash;
    expect(b.writeConfig(P.encodeConfig({ op: 1, joint: 0, min: -2000, max: 0 }))).to.equal(P.ERR.OP); // wider than hard limit
    expect(b.writeConfig(P.encodeConfig({ op: 1, joint: 0, min: -600, max: 600 }))).to.equal(P.ERR.OK);
    expect(P.decodeInfo(b.infoBytes()).limitsHash).to.not.equal(h0);
    expect(b.writeConfig(P.encodeConfig({ op: 2 }))).to.equal(P.ERR.OK);
    expect(b.snapshot.saved).to.equal(true);
    expect(b.writeConfig(P.encodeConfig({ op: 3 }))).to.equal(P.ERR.OK);
    expect(P.decodeInfo(b.infoBytes()).limitsHash).to.equal(h0);
    const n = bridge(P.BODY.DESK);
    expect(n.writeConfig(P.encodeConfig({ op: 2 }))).to.equal(P.ERR.STATE);
  });

  it("narrowed limits clamp the open-loop commanded angle, so the next ARM never drives a servo outside them", () => {
    const b = bridge(P.BODY.ROVER);
    arm(b);
    b.writeCmd(P.encodeDrive({ seq: 101, mask: P.DRIVE_MASK.PAN, pan: 800 }));
    for (let t = 20, seq = 101; t <= 1000; t += 20) b.writeCmd(P.encodeDrive({ seq: ++seq, mask: P.DRIVE_MASK.PAN, pan: 800 })), b.tick(t);
    expect(b.snapshot.commanded[0]).to.equal(800);
    b.writeStop(P.encodeStop(P.STOP_REASON.RELAX));
    b.tick(1000 + P.WD_RELAX_MS + 20);
    expect(b.snapshot.torque).to.equal(false);
    b.tripleTapBoot();
    expect(b.writeConfig(P.encodeConfig({ op: 1, joint: 0, min: -300, max: 300 }))).to.equal(P.ERR.OK);
    expect(b.snapshot.commanded[0]).to.equal(300);
    expect(b.snapshot.target[0]).to.equal(300);
    b.tripleTapBoot();
    expect(arm(b, 2)).to.equal(P.ERR.OK);
    expect(b.snapshot.commanded[0]).to.equal(300);
  });

  it("a DRIVE frame without the wheels bit stops the wheels", () => {
    const b = bridge(P.BODY.ROVER);
    arm(b);
    let seq = 100;
    for (let t = 20; t <= 400; t += 20) drive(b, ++seq, 600), b.tick(t);
    expect(b.snapshot.drive[0]).to.equal(600);
    b.writeCmd(P.encodeDrive({ seq: ++seq, mask: P.DRIVE_MASK.PAN, pan: 100 }));
    b.tick(420);
    expect(b.snapshot.drive).to.deep.equal([0, 0]);
  });

  it("AX_STATE notifies at 10 Hz with state channels (rover: pan, tilt, wheel outputs)", () => {
    const got = [];
    const b = B.createBridge({ body: P.BODY.ROVER, onNotify: (x) => got.push(P.decodeState(x)) });
    b.pressBoot(2000);
    b.connect();
    b.tick(1000);
    expect(got.length).to.be.within(10, 11);
    expect(got[0].positions).to.have.length(P.stateChannels(P.BODY.ROVER).length);
    expect(P.stateChannels(P.BODY.ROVER)).to.deep.equal(["head_pan", "head_tilt", "drive_l", "drive_r"]);
  });

  // ------------------------------------------------------------ phone drive loop over the twin transport

  async function setup(body = P.BODY.ROVER, latencyMs = 0) {
    const clock = fakeClock();
    const tr = T.createTwinTransport({ body, clock, latencyMs });
    let n = 0;
    const loop = D.createDriveLoop({ transport: tr, clock, nonce: () => ++n });
    await loop.connect();
    return { clock, tr, loop };
  }

  it("a link that drops during the first connect (failed pairing) is reported, never retried", async () => {
    const clock = fakeClock();
    const tr = T.createTwinTransport({ body: P.BODY.ROVER, clock, latencyMs: 0 });
    let tries = 0;
    tr.reconnect = async () => void tries++;
    tr.readInfo = async () => {
      tr.dropLink(); // the bridge closes the link: wrong passkey
      throw new Error("GATT operation failed");
    };
    const loop = D.createDriveLoop({ transport: tr, clock });
    await loop.connect();
    await clock.advance(10000);
    expect(loop.link).to.equal(D.LINK.DISCONNECTED);
    expect(loop.snapshot.reconnecting).to.not.equal(true);
    expect(tries).to.equal(0);
  });

  it("STOP pressed while an ARM is in flight wins: the app stays latched", async () => {
    const { clock, loop } = await setup(P.BODY.ROVER, 40);
    const armed = loop.arm();
    const stopped = loop.stop();
    await clock.advance(1000); // the fake clock delivers both writes
    await stopped;
    expect(await armed).to.equal(false);
    expect(loop.link).to.equal(D.LINK.LATCHED);
  });

  it("connect -> CONNECTED_LATCHED; ARM -> ARMED; hold-to-drive; release zeroes at once", async () => {
    const { clock, tr, loop } = await setup(P.BODY.ROVER, 15);
    expect(loop.link).to.equal(D.LINK.LATCHED);
    loop.setHeld(true); // no effect before ARM
    expect(loop.link).to.equal(D.LINK.LATCHED);
    const armed = loop.arm(); // the write travels through the simulated 15 ms radio hop
    await clock.advance(40);
    expect(await armed).to.equal(true);
    expect(loop.link).to.equal(D.LINK.ARMED);
    loop.setSpeed(100);
    loop.setHeld(true);
    loop.setStick(0, 1);
    expect(loop.link).to.equal(D.LINK.DRIVING);
    await clock.advance(1000);
    expect(tr.bridge.snapshot.state).to.equal(P.STATE.ARMED); // 33 ms sender keeps the 250 ms watchdog fed
    expect(tr.bridge.snapshot.drive).to.deep.equal([1000, 1000]);
    loop.setHeld(false);
    expect(loop.link).to.equal(D.LINK.ARMED);
    await clock.advance(100);
    expect(tr.bridge.snapshot.drive).to.deep.equal([0, 0]);
    expect(tr.bridge.snapshot.state).to.equal(P.STATE.ARMED);
  });

  it("STOP latches both sides; the app never re-arms by itself", async () => {
    const { clock, tr, loop } = await setup();
    await loop.arm();
    loop.setHeld(true);
    loop.setStick(0.5, 0.5);
    await clock.advance(200);
    await loop.stop("test");
    await clock.advance(1000);
    expect(loop.link).to.equal(D.LINK.LATCHED);
    expect(tr.bridge.snapshot.latch).to.equal(P.LATCH.USER_STOP);
    expect(tr.bridge.snapshot.drive).to.deep.equal([0, 0]);
  });

  it("a stalled sender (tab throttled) sends STOP; a bridge-side latch reaches the app", async () => {
    const { clock, tr, loop } = await setup();
    await loop.arm();
    // the JS thread freezes for 400 ms: timers fire late
    const t0 = clock.now();
    clock.now = ((orig) => () => orig() + (orig() - t0 > 100 ? 400 : 0))(clock.now);
    await clock.advance(200);
    expect(loop.link).to.equal(D.LINK.LATCHED);
    expect(tr.bridge.snapshot.state).to.equal(P.STATE.LATCHED);

    const s2 = await setup();
    await s2.loop.arm();
    await s2.clock.advance(150); // ARM confirmed by a notify
    s2.tr.bridge.setBattery(5000);
    await s2.clock.advance(300);
    expect(s2.loop.link).to.equal(D.LINK.LATCHED);
    expect(s2.loop.snapshot.message).to.match(/Battery low/);
  });

  it("ARM is refused while the bridge reports a fault, and starts from the present pose", async () => {
    const { clock, tr, loop } = await setup(P.BODY.DESK);
    tr.bridge.setServoFault(1);
    expect(await loop.arm()).to.equal(false);
    expect(loop.link).to.equal(D.LINK.LATCHED);
    tr.bridge.setServoFault(1, false);
    expect(await loop.arm()).to.equal(true);
    expect(loop.snapshot.targets).to.deep.equal(tr.bridge.snapshot.present);
    loop.setJoint("r_shoulder", -90);
    await clock.advance(2000);
    expect(tr.bridge.snapshot.present[5]).to.equal(-900);
  });

  it("an ARM the bridge silently ignores (real firmware: no GATT error) is reported as refused", async () => {
    const { clock, tr, loop } = await setup();
    tr.writeArm = async () => {}; // write acknowledged, state never becomes ARMED
    expect(await loop.arm()).to.equal(true);
    await clock.advance(D.ARM_CONFIRM_MS + 100);
    expect(loop.link).to.equal(D.LINK.LATCHED);
    expect(loop.snapshot.message).to.match(/ARM refused/);
  });

  it("link loss -> reconnect with backoff 0.5/1/2/4 s, then CONNECTED_LATCHED until ARM", async () => {
    const { clock, tr, loop } = await setup();
    await loop.arm();
    loop.setHeld(true);
    loop.setStick(0, 1);
    await clock.advance(100);
    const realReconnect = tr.reconnect;
    let tries = 0;
    tr.reconnect = async () => {
      tries++;
      if (tries < 3) throw new Error("out of range");
      return realReconnect();
    };
    tr.dropLink();
    expect(loop.link).to.equal(D.LINK.DISCONNECTED);
    expect(tr.bridge.snapshot.latch).to.equal(P.LATCH.LINK_LOST);
    await clock.advance(499);
    expect(tries).to.equal(0);
    await clock.advance(1); // 0.5 s
    expect(tries).to.equal(1);
    await clock.advance(1000); // +1 s
    expect(tries).to.equal(2);
    await clock.advance(2000); // +2 s: succeeds
    expect(tries).to.equal(3);
    expect(loop.link).to.equal(D.LINK.LATCHED);
    expect(loop.snapshot.message).to.match(/until you press ARM/);
    await clock.advance(1000);
    expect(tr.bridge.snapshot.state).to.equal(P.STATE.LATCHED);
  });

  it("gives up after 5 reconnect attempts", async () => {
    const { clock, tr, loop } = await setup();
    let tries = 0;
    tr.reconnect = async () => {
      tries++;
      throw new Error("gone");
    };
    tr.dropLink();
    await clock.advance(20000);
    expect(tries).to.equal(D.RECONNECT_DELAYS.length);
    expect(loop.link).to.equal(D.LINK.DISCONNECTED);
    expect(loop.snapshot.message).to.match(/Could not reconnect/);
  });

  it("refuses to drive on a protocol major mismatch", async () => {
    const clock = fakeClock();
    const tr = T.createTwinTransport({ body: P.BODY.ROVER, clock });
    const realInfo = tr.readInfo;
    tr.readInfo = async () => {
      const b = await realInfo();
      b[0] = P.PROTO_MAJOR + 1;
      return b;
    };
    const loop = D.createDriveLoop({ transport: tr, clock });
    await loop.connect();
    expect(loop.snapshot.compatible).to.equal(false);
    expect(await loop.arm()).to.equal(false);
    expect(tr.bridge.snapshot.state).to.equal(P.STATE.LATCHED);
  });

  // ------------------------------------------------------------ camera tracker

  it("motionCentroid finds where the picture changed", () => {
    const w = 64;
    const h = 48;
    const a = new Uint8Array(w * h).fill(100);
    const b = a.slice();
    for (let y = 10; y < 20; y++) for (let x = 48; x < 60; x++) b[y * w + x] = 220;
    const m = S.motionCentroid(a, b, w, h);
    expect(m.x).to.be.closeTo(((53.5 + 0.5) / w) * 2 - 1, 1e-9);
    expect(m.y).to.be.lessThan(0); // upper half
    expect(S.motionCentroid(a, a, w, h)).to.equal(null);
    expect(S.toGray(Uint8Array.from([255, 255, 255, 255, 0, 0, 0, 255]), new Uint8Array(2))).to.deep.equal(Uint8Array.from([255, 0]));
  });

  it("codec: a NaN or missing motion value throws instead of going out as 0; the loop holds instead of sending a guess", async () => {
    expect(() => P.encodeJoints({ seq: 1, mask: 0b11, targets: [100, NaN] })).to.throw(RangeError);
    expect(() => P.encodeJoints({ seq: 1, mask: 0b11, targets: [100] })).to.throw(RangeError);
    expect(() => P.encodeDrive({ seq: 1, mask: 7, left: NaN })).to.throw(RangeError);
    expect(() => P.encodeDrive({ seq: 1, mask: 7, pan: undefined, tilt: Infinity })).to.throw(RangeError);
    expect(() => P.encodeDrive({ seq: 1, mask: 1, left: 5 })).to.not.throw(); // defaults stay valid
    const { clock, loop } = await setup(P.BODY.DESK);
    expect(await loop.arm()).to.equal(true);
    await clock.advance(150);
    const before = loop.snapshot.targets;
    loop.setJoint("torso_yaw", NaN);
    loop.setPose({ head_pan: undefined, head_tilt: "10" });
    expect(loop.snapshot.targets).to.deep.equal(before);
  });

  it("wake lock: off() during a pending request releases the late lock; concurrent on() asks once", async () => {
    const navDesc = Object.getOwnPropertyDescriptor(globalThis, "navigator");
    const hadDoc = Object.hasOwn(globalThis, "document");
    let requests = 0;
    let released = 0;
    let resolveReq;
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: { wakeLock: { request: () => (requests++, new Promise((r) => (resolveReq = () => r({ release: async () => void released++, addEventListener() {} })))) } },
    });
    globalThis.document = { hidden: false, addEventListener() {} };
    try {
      const w = S.createWakeLock();
      const a = w.on();
      const b = w.on();
      expect(requests).to.equal(1);
      await w.off();
      resolveReq();
      await a;
      await b;
      expect(released).to.equal(1);
      expect(w.active).to.equal(false);
      const c = w.on();
      resolveReq();
      await c;
      expect(w.active).to.equal(true);
    } finally {
      if (navDesc) Object.defineProperty(globalThis, "navigator", navDesc);
      else delete globalThis.navigator;
      if (!hadDoc) delete globalThis.document;
    }
  });
});
