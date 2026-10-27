const { expect } = require("chai");
const fs = require("fs");
const path = require("path");

// OpenForge AX-1 protocol (web/js/pilot/ax-proto.js) and the shared test vectors that the firmware mirror
// (firmware/ax-bridge/ax_proto.h) must reproduce byte for byte. Regenerate after an intended change with:
//   AX_WRITE_VECTORS=1 npx hardhat test test/AxProto.test.js
const VEC_DIR = path.join(__dirname, "..", "firmware", "ax-bridge", "test");

describe("AX-1 protocol (web/js/pilot/ax-proto.js)", () => {
  let P, sts, sim;
  before(async () => {
    P = await import("../web/js/pilot/ax-proto.js");
    sts = await import("../web/js/robot/sts-bus.js");
    sim = await import("../web/js/pilot/bridge-sim.js");
  });

  const hex = (b) => Buffer.from(b).toString("hex");

  // ------------------------------------------------------------ vector builders (the single source of truth)

  function axVectors() {
    const v = { proto: { major: P.PROTO_MAJOR, minor: P.PROTO_MINOR }, uuid: P.UUID, consts: {} };
    for (const k of ["WD_HOLD_MS", "WD_RELAX_MS", "MAX_DEG_S", "CONTROL_MS", "STATE_MS", "PAIR_WINDOW_MS", "MIN_MTU", "SEQ_WINDOW", "DRIVE_MAX", "DRIVE_SLEW"]) v.consts[k] = P[k];
    v.limits = Object.keys(P.BODIES).map((b) => ({ body: Number(b), joints: P.BODIES[b].joints, hash: P.limitsHash(Number(b)) }));
    v.info = [{ in: { fwVer: 0x0001, body: 2, nJoints: 7, limitsHash: P.limitsHash(2) } }, { in: { fwVer: 0x0203, body: 3, nJoints: 13, limitsHash: 0xdeadbeef } }].map((c) => ({ ...c, hex: hex(P.encodeInfo(c.in)) }));
    v.joints = [
      { seq: 1, mask: 0b11, targets: [450, -300], speed: 100 },
      { seq: 65535, mask: 0b1000101, targets: [-1700, 0, 32767], speed: 37 },
      { seq: 0x1234, mask: 0x1fff, targets: Array.from({ length: 13 }, (_, i) => (i - 6) * 111), speed: 5 },
      { seq: 9, mask: 1, targets: [-32768], speed: 250 }, // speed clamps to 100 on encode
    ].map((c) => ({ in: c, hex: hex(P.encodeJoints(c)) }));
    v.drive = [
      { seq: 2, mask: 7, left: 1000, right: -1000, pan: 300, tilt: -150, speed: 60 },
      { seq: 40000, mask: 1, left: 2500, right: -7, pan: 0, tilt: 0, speed: 100 }, // left clamps to 1000
    ].map((c) => ({ in: c, hex: hex(P.encodeDrive(c)) }));
    v.stop = [0, 1].map((r) => ({ reason: r, hex: hex(P.encodeStop(r)) }));
    v.arm = [{ nonce: 0xa1b2c3d4, seqBase: 65530 }, { nonce: 1, seqBase: 0 }].map((c) => ({ in: c, hex: hex(P.encodeArm(c)) }));
    v.config = [{ op: 1, joint: 3, min: -900, max: 300 }, { op: 2 }].map((c) => ({ in: c, hex: hex(P.encodeConfig(c)) }));
    v.state = [
      { state: 2, latch: 0, flags: 1, fault: 0, battMv: 7810, lastSeq: 513, positions: [100, -250, 600, 600] },
      { state: 1, latch: 3, flags: 5, fault: 3, battMv: 6300, lastSeq: 65535, positions: Array.from({ length: 13 }, (_, i) => i * -10) },
    ].map((c) => ({ in: c, hex: hex(P.encodeState(c)) }));
    const bad = (bytes) => {
      try {
        P.decodeCmd(Uint8Array.from(bytes));
        return 0;
      } catch (e) {
        return e.code;
      }
    };
    v.cmdErrors = [
      [1, 1, 0, 0, 1],
      [2, 1, 1, 0, 1, 0, 0, 0, 100],
      [1, 9, 1, 0, 1, 0, 0, 0, 100],
      [1, 1, 1, 0, 0, 0, 100],
      [1, 1, 1, 0, 3, 0, 0, 0, 100],
      [1, 2, 1, 0, 8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 100],
      [1, 2, 1, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    ].map((b) => ({ hex: hex(b), err: bad(b) }));
    v.seqNewer = [
      [1, 0], [0, 0], [0, 1], [5, 65530], [65530, 5], [1024, 0], [1025, 0], [0, 65535], [32768, 0],
    ].map(([seq, last]) => ({ seq, last, newer: P.seqNewer(seq, last) }));
    v.deciToSteps = [
      [0, 2048, 1], [10, 2048, 1], [-10, 2048, 1], [900, 2048, 1], [-900, 2048, -1], [1800, 2048, 1], [-1800, 2048, 1], [3, 2048, 1], [-3, 2048, 1], [4, 2048, 1], [-1200, 1900, -1], [32767, 2048, 1],
    ].map(([deci, center, dir]) => ({ deci, center, dir, steps: P.deciToSteps(deci, center, dir) }));
    v.stepsToDeci = [[2048, 2048, 1], [2059, 2048, 1], [2037, 2048, 1], [3072, 2048, -1], [0, 2048, 1], [2050, 2048, 1]].map(([steps, center, dir]) => ({ steps, center, dir, deci: P.stepsToDeci(steps, center, dir) }));
    v.maxStepDeci = [[20, 100], [20, 50], [20, 1], [20, 0], [20, 150], [33, 60]].map(([dt, speed]) => ({ dt, speed, step: P.maxStepDeci(dt, speed) }));
    v.driveStep = [[0, 600], [600, 0], [600, 300], [300, 600], [580, 600], [600, -600], [-200, -600], [0, -30]].map(([cur, want]) => ({ cur, want, out: P.driveStep(cur, want) }));
    return v;
  }

  function stsVectors() {
    const desk = [1, 2, 3, 4, 5, 6, 7];
    const goals = [2048, 2100, 1990, 0, 4095, 3000, 1024];
    const replyBody = [0x02, 0x04, 0x00, 0x34, 0x12];
    const reply = [0xff, 0xff, ...replyBody, sts.checksum(replyBody)];
    const errBody = [0x05, 0x04, 0x20, 0x00, 0x08];
    const errReply = [0xff, 0xff, ...errBody, sts.checksum(errBody)];
    const parse = (stream) => {
      const out = [];
      const push = sts.createParser((p) => out.push({ id: p.id, error: p.error, params: hex(p.params) }));
      push(stream);
      return out;
    };
    return {
      consts: { ACCEL: sim.STS.ACCEL, TORQUE_LIMIT: sim.STS.TORQUE_LIMIT, VEL_CAP: sim.STS.VEL_CAP, MODEL: sts.STS3215_MODEL, FATAL_ERRORS: sts.FATAL_ERRORS, REG: sts.REG },
      ping: [1, 7, 13].map((id) => ({ id, hex: hex(sim.stsPingPacket(id)) })),
      read: [[1, sts.REG.MODEL, 2], [2, sts.REG.MODE, 1], [3, sts.REG.VOLTAGE, 1], [13, sts.REG.PRESENT, 2], [4, sts.REG.TORQUE, 1]].map(([id, addr, len]) => ({ id, addr, len, hex: hex(sim.stsReadPacket(id, addr, len)) })),
      torque: [true, false].map((on) => ({ ids: desk, on, hex: hex(sim.stsTorquePacket(desk, on)) })),
      motion: [
        { ids: desk, goals },
        { ids: Array.from({ length: 13 }, (_, i) => i + 1), goals: Array.from({ length: 13 }, (_, i) => 2048 + (i - 6) * 37) },
      ].map((c) => ({ ...c, hex: hex(sim.stsMotionPacket(c.ids, c.goals)) })),
      motionBlock: [2048, 0, 4095].map((g) => ({ goal: g, hex: hex(sim.motionBlock(g)) })),
      replies: [
        { stream: hex(reply), packets: parse(reply) },
        { stream: hex([0x00, 0xff, 0x13, ...errReply, 0xff]), packets: parse([0x00, 0xff, 0x13, ...errReply, 0xff]) },
        { stream: hex([...reply.slice(0, -1), reply[reply.length - 1] ^ 1, ...errReply]), packets: parse([...reply.slice(0, -1), reply[reply.length - 1] ^ 1, ...errReply]) },
      ],
    };
  }

  function check(name, data) {
    const file = path.join(VEC_DIR, name);
    const text = JSON.stringify(data, null, 1) + "\n";
    if (process.env.AX_WRITE_VECTORS) {
      fs.mkdirSync(VEC_DIR, { recursive: true });
      fs.writeFileSync(file, text);
    }
    expect(fs.existsSync(file), `${name} missing: run with AX_WRITE_VECTORS=1`).to.equal(true);
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).to.deep.equal(JSON.parse(text), `${name} is stale: the codec changed. Regenerate and update ax_proto.h.`);
  }

  // ------------------------------------------------------------ tests

  it("committed test vectors match the JS codec (ax-vectors.json, sts-vectors.json)", () => {
    check("ax-vectors.json", axVectors());
    check("sts-vectors.json", stsVectors());
  });

  it("encodes the exact AX_CMD layouts (little-endian, deci, speed byte last)", () => {
    expect(hex(P.encodeJoints({ seq: 0x0102, mask: 0b11, targets: [450, -300], speed: 100 }))).to.equal("0101020103 00c201d4fe64".replace(/ /g, ""));
    const d = P.encodeDrive({ seq: 2, mask: 7, left: 1000, right: -1000, pan: 300, tilt: -150, speed: 60 });
    expect(d.length).to.equal(15);
    expect(hex(d)).to.equal("010202000700e80318fc2c016aff3c");
    expect(P.encodeStop(1)).to.deep.equal(Uint8Array.from([1, 1]));
    expect(hex(P.encodeArm({ nonce: 0xa1b2c3d4, seqBase: 0xfffa }))).to.equal("01d4c3b2a1faff");
  });

  it("round-trips every frame type", () => {
    const j = { seq: 777, mask: 0b1010101, targets: [1, -2, 3, -4], speed: 42 };
    expect(P.decodeCmd(P.encodeJoints(j))).to.deep.equal({ type: P.MSG.JOINTS, ...j });
    const dr = { seq: 5, mask: 3, left: -512, right: 999, pan: -900, tilt: 0, speed: 100 };
    expect(P.decodeCmd(P.encodeDrive(dr))).to.deep.equal({ type: P.MSG.DRIVE, ...dr });
    expect(P.decodeArm(P.encodeArm({ nonce: 0xffffffff, seqBase: 0 }))).to.deep.equal({ nonce: 0xffffffff, seqBase: 0 });
    const st = { state: 1, latch: 4, flags: 3, fault: 0x21, battMv: 7400, lastSeq: 65000, positions: [-1, 2, -32768, 32767] };
    expect(P.decodeState(P.encodeState(st))).to.deep.equal(st);
    const info = { protoMajor: 1, protoMinor: 0, fwVer: 0x0102, body: 3, nJoints: 13, limitsHash: 0x89abcdef };
    expect(P.decodeInfo(P.encodeInfo(info))).to.deep.equal(info);
    expect(P.decodeConfig(P.encodeConfig({ op: 1, joint: 2, min: -10, max: 20 }))).to.deep.equal({ op: 1, joint: 2, min: -10, max: 20 });
  });

  it("rejects malformed commands with a reason; STOP never fails on content", () => {
    const err = (b) => {
      try {
        P.decodeCmd(Uint8Array.from(b));
      } catch (e) {
        return e.code;
      }
      return 0;
    };
    expect(err([1, 1, 0, 0])).to.equal(P.ERR.LEN);
    expect(err([2, 1, 1, 0, 1, 0, 0, 0, 100])).to.equal(P.ERR.VER);
    expect(err([1, 9, 1, 0, 1, 0, 0, 0, 100])).to.equal(P.ERR.TYPE);
    expect(err([1, 1, 1, 0, 0, 0, 100])).to.equal(P.ERR.MASK);
    expect(err([1, 1, 1, 0, 3, 0, 0, 0, 100])).to.equal(P.ERR.LEN); // 2 joints in the mask, 1 value
    expect(P.decodeStop([])).to.deep.equal({ reason: P.STOP_REASON.HOLD });
    expect(P.decodeStop([9, 9, 9])).to.deep.equal({ reason: P.STOP_REASON.HOLD });
    expect(() => P.decodeState(P.encodeState({ state: 1, latch: 0, positions: [1, 2, 3] }).slice(0, 15))).to.throw(/truncated/);
  });

  it("seq replay window handles the 16-bit wrap", () => {
    expect(P.seqNewer(1, 0)).to.equal(true);
    expect(P.seqNewer(0, 0)).to.equal(false); // replay
    expect(P.seqNewer(0, 1)).to.equal(false); // older
    expect(P.seqNewer(5, 65530)).to.equal(true); // across the wrap
    expect(P.seqNewer(65530, 5)).to.equal(false);
    expect(P.seqNewer(1024, 0)).to.equal(true);
    expect(P.seqNewer(1025, 0)).to.equal(false); // too far ahead: not a frame from this session
  });

  it("deci <-> STS steps conversion rounds like C and never yields -0", () => {
    expect(P.deciToSteps(0)).to.equal(2048);
    expect(P.deciToSteps(900)).to.equal(3072);
    expect(P.deciToSteps(-900, 2048, -1)).to.equal(3072);
    expect(P.deciToSteps(1800)).to.equal(4095); // clamped
    expect(P.deciToSteps(-1800)).to.equal(0);
    for (let d = -1700; d <= 1700; d += 7) expect(Math.abs(P.stepsToDeci(P.deciToSteps(d)) - d)).to.be.at.most(1);
    expect(Object.is(P.stepsToDeci(2048), 0)).to.equal(true);
    expect(Object.is(P.roundDiv(-1, 3600), 0)).to.equal(true);
  });

  it("rate limiter: 90 deg/s at 100 %, at least 1 deci per tick while moving", () => {
    expect(P.maxStepDeci(20, 100)).to.equal(18); // 18 deci per 20 ms = 90 deg/s
    expect(P.maxStepDeci(20, 1)).to.equal(1);
    expect(P.maxStepDeci(20, 0)).to.equal(0);
    expect(P.maxStepDeci(20, 250)).to.equal(18);
    expect(P.rateStep(0, 100, 18)).to.equal(18);
    expect(P.rateStep(0, -5, 18)).to.equal(-5);
    expect(P.driveStep(600, 0)).to.equal(0); // stopping is immediate
    expect(P.driveStep(600, -600)).to.equal(0); // reversing goes through zero
    expect(P.driveStep(0, 600)).to.equal(P.DRIVE_SLEW);
  });

  it("joint tables agree with the twin model (names exist, ranges inside the rig's)", async () => {
    // robots.js needs three (a browser module); check names against its source text instead
    const src = fs.readFileSync(path.join(__dirname, "..", "web", "js", "models", "robots.js"), "utf8");
    for (const b of Object.values(P.BODIES)) for (const j of b.joints) expect(src.includes(j.name.replace(/^[lr]_/, "")), `${b.key}: ${j.name}`).to.equal(true);
    expect(P.BODIES[P.BODY.WALKER].joints).to.have.length(13);
    expect(P.BODIES[P.BODY.DESK].joints).to.have.length(7);
    expect(new Set(Object.keys(P.BODIES).map((b) => P.limitsHash(Number(b)))).size).to.equal(3);
  });

  it("firmware header mirrors the JS tables and constants (ax_proto.h, text check: no C++ compiler in CI)", () => {
    const h = fs.readFileSync(path.join(__dirname, "..", "firmware", "ax-bridge", "ax_proto.h"), "utf8");
    const table = (name) => {
      const start = h.indexOf(`constexpr Joint ${name}[] = {`);
      const body = h.slice(start, h.indexOf("};", start));
      return [...body.matchAll(/\{"(\w+)", (-?\d+), (-?\d+), (-?\d+)\}/g)].map((x) => ({ name: x[1], min: +x[2], max: +x[3], home: +x[4] }));
    };
    expect(table("ROVER_JOINTS")).to.deep.equal(P.BODIES[P.BODY.ROVER].joints);
    expect(table("DESK_JOINTS")).to.deep.equal(P.BODIES[P.BODY.DESK].joints);
    expect(table("WALKER_JOINTS")).to.deep.equal(P.BODIES[P.BODY.WALKER].joints);
    for (const k of ["WD_HOLD_MS", "WD_RELAX_MS", "MAX_DEG_S", "CONTROL_MS", "STATE_MS", "PAIR_WINDOW_MS", "MIN_MTU", "SEQ_WINDOW", "DRIVE_MAX", "DRIVE_SLEW"]) {
      const m = h.match(new RegExp(`constexpr \\w+ ${k} = (\\d+);`));
      expect(m, k).to.not.equal(null);
      expect(Number(m[1]), k).to.equal(P[k]);
    }
    for (const [k, v] of Object.entries(P.UUID)) expect(h.includes(`"${v}"`), k).to.equal(true);
    expect(h).to.include(`VEL_CAP = ${sim.STS.VEL_CAP}`);
    expect(h).to.include(`TORQUE_LIMIT_VALUE = ${sim.STS.TORQUE_LIMIT}`);
    expect(h).to.include(`ACCEL_VALUE = ${sim.STS.ACCEL}`);
    for (const b of Object.keys(P.BODIES)) expect(h).to.match(new RegExp(`, ${P.BODIES[b].drive}, ${P.BODIES[b].lowBattMv}\\}`));
  });
});
