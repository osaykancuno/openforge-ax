// OpenForge AX-1 BLE protocol: pure codec, shared by the Phone Brain app, the twin, the Node loopback bridge and
// the tests. Mirror in firmware/ax-bridge/ax_proto.h; both are checked against firmware/ax-bridge/test/*.json.
// All multi-byte fields are little-endian. Angles are signed 16-bit tenths of a degree ("deci").
// Spec: docs/13-PHONE-BRAIN.md. Bump PROTO_MAJOR on any incompatible change; the app refuses to drive on mismatch.

export const PROTO_MAJOR = 1;
export const PROTO_MINOR = 0;
// Reserved, not built: minor 1 will add an "autonomous source" capability flag to INFO, for a future learned policy that
// the holder taught (docs/13 §12). Such a policy is one more untrusted plan source: it still goes through validatePlan and
// the executor, needs a human ARM gesture, and the watchdog and the STOP latch stay exactly as they are.

// Custom 128-bit UUIDs (random base, not a Bluetooth SIG UUID). Characteristic n = base with 000n.
const uuid = (n) => `7a3e000${n}-4f1b-4c2a-9d0e-5b6c7d8e9fa1`;
export const UUID = {
  SERVICE: uuid(0),
  INFO: uuid(1), // read, open (so the app can check versions before pairing)
  CMD: uuid(2), // write without response, encrypted + MITM
  STOP: uuid(3), // write with response, encrypted + MITM
  ARM: uuid(4), // write with response, encrypted + MITM
  STATE: uuid(5), // notify 10 Hz + read, encrypted + MITM
  CONFIG: uuid(6), // write with response, encrypted + MITM, config mode only
};

export const BODY = { ROVER: 1, DESK: 2, WALKER: 3 };

// Joint tables. Order = servo ID order on the bus (ID = index + 1) for Desk (7 servos) and Walker (13 servos:
// 12 legs + torso yaw; the twin's walker head tilt is not a bus servo and stays still).
// min/max/home in deci (0.1 deg). They match the twin (web/js/models/robots.js) and firmware/ax-bridge/config.h.
const J = (name, min, max, home = 0) => ({ name, min, max, home });
export const BODIES = {
  [BODY.ROVER]: {
    key: "rover",
    name: "AX-1 Rover",
    rig: "ax1-rover",
    drive: true,
    joints: [J("head_pan", -900, 900), J("head_tilt", -300, 300)], // hobby servos (PWM), open loop
    lowBattMv: 6400, // 2S Li-ion: 3.2 V per cell under load
  },
  [BODY.DESK]: {
    key: "desk",
    name: "AX-1 Desk",
    rig: "ax1-desk",
    drive: false,
    joints: [
      J("torso_yaw", -1200, 1200),
      J("head_pan", -1000, 1000),
      J("head_tilt", -250, 350),
      J("l_shoulder", -1700, 400),
      J("l_elbow", -1200, 0, -200),
      J("r_shoulder", -1700, 400),
      J("r_elbow", -1200, 0, -200),
    ],
    lowBattMv: 6400,
  },
  [BODY.WALKER]: {
    key: "walker",
    name: "AX-1 Walker (experimental, poses only)",
    rig: "ax1-walker",
    drive: false,
    joints: [
      ...["l", "r"].flatMap((s) => [
        J(`${s}_hip_yaw`, -300, 300),
        J(`${s}_hip_roll`, -250, 250),
        J(`${s}_hip_pitch`, -900, 600),
        J(`${s}_knee`, 0, 1300),
        J(`${s}_ankle_pitch`, -600, 600),
        J(`${s}_ankle_roll`, -250, 250),
      ]),
      J("torso_yaw", -600, 600),
    ],
    lowBattMv: 9600, // 3S
  },
};
export const bodyByKey = (key) => Number(Object.keys(BODIES).find((b) => BODIES[b].key === key)) || 0;

/** Channels reported in AX_STATE: the joints, plus the two wheel outputs (-1000..1000) for a driving body. */
export const stateChannels = (body) => [...BODIES[body].joints.map((j) => j.name), ...(BODIES[body].drive ? ["drive_l", "drive_r"] : [])];

export const MSG = { JOINTS: 1, DRIVE: 2 };
export const DRIVE_MASK = { WHEELS: 1, PAN: 2, TILT: 4 };
export const STOP_REASON = { HOLD: 0, RELAX: 1 }; // RELAX: hold now, torque off WD_RELAX_MS later
export const STATE = { BOOT: 0, LATCHED: 1, ARMED: 2, FAULT: 3, CONFIG: 4 };
export const STATE_NAME = ["boot", "latched", "armed", "fault", "config"];
export const LATCH = { NONE: 0, BOOT: 1, USER_STOP: 2, WATCHDOG: 3, LINK_LOST: 4, LOW_BATT: 5, SERVO_FAULT: 6, BOOT_CHECK: 7, CONFIG: 8 };
export const LATCH_TEXT = [
  "Ready",
  "Just powered on",
  "Stopped by you",
  "Commands stopped arriving (watchdog)",
  "The link dropped",
  "Battery low",
  "A servo reported a fault",
  "Start-up check failed",
  "Config mode",
];
export const FLAG = { TORQUE: 1, PAIRING: 2, RELAX_PENDING: 4 };
export const FAULT = { LOW_BATT: 1, SERVO_FATAL: 2, SERVO_MISSING: 4, BAD_MODEL: 8, BAD_MODE: 16, MTU_LOW: 32, TORQUE_VERIFY: 64 };
export const ERR = { OK: 0, LEN: 1, VER: 2, TYPE: 3, MASK: 4, SEQ: 5, STATE: 6, NONCE: 7, FAULT: 8, AUTH: 9, OP: 10 };
export const CONFIG_OP = { SET_LIMIT: 1, SAVE: 2, RESET: 3 };

// Bridge timing and limits (firmware owns them; the app only mirrors them for UX).
export const WD_HOLD_MS = 250;
export const WD_RELAX_MS = 3000;
export const MAX_DEG_S = 90;
export const CONTROL_MS = 20; // firmware control loop (50 Hz)
export const STATE_MS = 100; // AX_STATE notify (10 Hz)
export const PAIR_WINDOW_MS = 60000;
export const MIN_MTU = 64;
export const SEQ_WINDOW = 1024; // a CMD is fresh if 1 <= (seq - last) mod 65536 <= SEQ_WINDOW
export const DRIVE_MAX = 1000;
export const DRIVE_SLEW = 40; // wheel output change per control tick (2000 per second)

export class ProtoError extends Error {
  constructor(code, msg) {
    super(msg);
    this.code = code;
  }
}

// ---------------------------------------------------------------- integer helpers (identical in C++)

const clampInt = (v, lo, hi) => Math.min(hi, Math.max(lo, Math.trunc(Number.isFinite(v) ? v : 0)));
export const clampI16 = (v) => clampInt(v, -32768, 32767);
const putU16 = (a, v) => a.push(v & 0xff, (v >>> 8) & 0xff);
const putI16 = (a, v) => putU16(a, clampI16(v) & 0xffff);
/** A motion value must be a finite number: a NaN or a missing target would otherwise go out as 0 (a real move). */
const finite = (v, name) => {
  if (typeof v !== "number" || !Number.isFinite(v)) throw new RangeError(`AX_CMD: ${name} is not a finite number`);
  return v;
};
const putU32 = (a, v) => a.push(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff);
const getU16 = (b, o) => b[o] | (b[o + 1] << 8);
const getI16 = (b, o) => (getU16(b, o) << 16) >> 16;
const getU32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
const popcount = (m) => {
  let n = 0;
  for (; m; m &= m - 1) n++;
  return n;
};
const bytes = (b) => (b instanceof Uint8Array ? b : Uint8Array.from(b));

/** C-style division rounding half away from zero (b > 0). */
export function roundDiv(a, b) {
  return a >= 0 ? Math.trunc((a + Math.trunc(b / 2)) / b) : 0 - Math.trunc((-a + Math.trunc(b / 2)) / b); // 0 - x: never -0
}

/** True if `seq` is newer than `last` within SEQ_WINDOW, across the 16-bit wrap. Equal or older = replay. */
export function seqNewer(seq, last, window = SEQ_WINDOW) {
  const d = (seq - last) & 0xffff;
  return d !== 0 && d <= window;
}

/** STS3215: 4096 steps per turn. Joint deci -> raw steps around `center`, `dir` = +1 or -1, clamped to 0..4095. */
export function deciToSteps(deci, center = 2048, dir = 1) {
  return clampInt(center + dir * roundDiv(deci * 4096, 3600), 0, 4095);
}
export function stepsToDeci(steps, center = 2048, dir = 1) {
  return roundDiv((steps - center) * dir * 3600, 4096);
}

/** Largest move (deci) per control tick: MAX_DEG_S scaled by speed %, at least 1 while speed > 0. */
export function maxStepDeci(dtMs, speedPct, maxDegS = MAX_DEG_S) {
  if (speedPct <= 0) return 0;
  return Math.max(1, Math.trunc((maxDegS * 10 * dtMs * Math.min(100, speedPct)) / 100000));
}

/** One rate-limited step from `cur` toward `target`. */
export function rateStep(cur, target, maxStep) {
  return target > cur ? Math.min(target, cur + maxStep) : Math.max(target, cur - maxStep);
}

/** Wheel output step: speeding up is slew-limited (DRIVE_SLEW per tick); slowing down and stopping are immediate. */
export function driveStep(cur, want) {
  if (want === 0 || (cur !== 0 && Math.sign(want) !== Math.sign(cur))) return 0;
  if (Math.abs(want) <= Math.abs(cur)) return want;
  return rateStep(cur, want, DRIVE_SLEW);
}

/** FNV-1a 32 over: body u8, n u8, then per joint min i16, max i16, home i16 (LE). Identifies a limits table. */
export function limitsHash(body, joints = BODIES[body].joints) {
  const b = [body & 0xff, joints.length & 0xff];
  for (const j of joints) putI16(b, j.min), putI16(b, j.max), putI16(b, j.home);
  let h = 0x811c9dc5;
  for (const x of b) h = Math.imul(h ^ x, 0x01000193) >>> 0;
  return h >>> 0;
}

// ---------------------------------------------------------------- AX_INFO (10 bytes)

export function encodeInfo({ protoMajor = PROTO_MAJOR, protoMinor = PROTO_MINOR, fwVer, body, nJoints, limitsHash: hash }) {
  const a = [protoMajor, protoMinor];
  putU16(a, fwVer);
  a.push(body, nJoints);
  putU32(a, hash);
  return Uint8Array.from(a);
}
export function decodeInfo(raw) {
  const b = bytes(raw);
  if (b.length < 10) throw new ProtoError(ERR.LEN, "AX_INFO too short");
  return { protoMajor: b[0], protoMinor: b[1], fwVer: getU16(b, 2), body: b[4], nJoints: b[5], limitsHash: getU32(b, 6) };
}
export const fwVersionText = (v) => `${v >> 8}.${v & 0xff}`;

// ---------------------------------------------------------------- AX_CMD

/** JOINTS: ver | 1 | seq u16 | mask u16 | popcount(mask) x i16 deci (ascending bit order) | speed_pct u8. */
export function encodeJoints({ seq, mask, targets, speed = 100 }) {
  const a = [PROTO_MAJOR, MSG.JOINTS];
  putU16(a, seq & 0xffff);
  putU16(a, mask & 0xffff);
  let k = 0;
  for (let i = 0; i < 16; i++) if (mask & (1 << i)) putI16(a, finite(targets[k++], `target ${i}`));
  a.push(clampInt(speed, 0, 100));
  return Uint8Array.from(a);
}

/** DRIVE: ver | 2 | seq u16 | mask u16 | left i16 | right i16 | pan i16 | tilt i16 | speed_pct u8 (15 bytes). */
export function encodeDrive({ seq, mask = DRIVE_MASK.WHEELS, left = 0, right = 0, pan = 0, tilt = 0, speed = 100 }) {
  const a = [PROTO_MAJOR, MSG.DRIVE];
  putU16(a, seq & 0xffff);
  putU16(a, mask & 0xffff);
  for (const v of [clampInt(finite(left, "left"), -DRIVE_MAX, DRIVE_MAX), clampInt(finite(right, "right"), -DRIVE_MAX, DRIVE_MAX), finite(pan, "pan"), finite(tilt, "tilt")]) putI16(a, v);
  a.push(clampInt(speed, 0, 100));
  return Uint8Array.from(a);
}

/** Decodes any AX_CMD frame. Throws ProtoError. Values are returned raw: limits are the bridge's job. */
export function decodeCmd(raw) {
  const b = bytes(raw);
  if (b.length < 7) throw new ProtoError(ERR.LEN, "AX_CMD too short");
  if (b[0] !== PROTO_MAJOR) throw new ProtoError(ERR.VER, "AX_CMD version");
  const type = b[1];
  const seq = getU16(b, 2);
  const mask = getU16(b, 4);
  if (type === MSG.JOINTS) {
    const n = popcount(mask);
    if (!n) throw new ProtoError(ERR.MASK, "empty mask");
    if (b.length !== 7 + 2 * n) throw new ProtoError(ERR.LEN, "AX_CMD length");
    const targets = [];
    for (let k = 0; k < n; k++) targets.push(getI16(b, 6 + 2 * k));
    return { type, seq, mask, targets, speed: b[6 + 2 * n] };
  }
  if (type === MSG.DRIVE) {
    if (b.length !== 15) throw new ProtoError(ERR.LEN, "AX_CMD drive length");
    if (!mask || mask & ~7) throw new ProtoError(ERR.MASK, "drive mask");
    return { type, seq, mask, left: getI16(b, 6), right: getI16(b, 8), pan: getI16(b, 10), tilt: getI16(b, 12), speed: b[14] };
  }
  throw new ProtoError(ERR.TYPE, "AX_CMD type");
}

// ---------------------------------------------------------------- AX_STOP, AX_ARM, AX_CONFIG

export const encodeStop = (reason = STOP_REASON.HOLD) => Uint8Array.from([PROTO_MAJOR, reason & 0xff]);
/** STOP never fails on content: anything short or odd is a plain HOLD. */
export function decodeStop(raw) {
  const b = bytes(raw);
  return { reason: b.length >= 2 && b[1] === STOP_REASON.RELAX ? STOP_REASON.RELAX : STOP_REASON.HOLD };
}

/** ARM: ver | nonce u32 | seq_base u16 (7 bytes). The next CMD must be newer than seq_base. */
export function encodeArm({ nonce, seqBase }) {
  const a = [PROTO_MAJOR];
  putU32(a, nonce >>> 0);
  putU16(a, seqBase & 0xffff);
  return Uint8Array.from(a);
}
export function decodeArm(raw) {
  const b = bytes(raw);
  if (b.length !== 7) throw new ProtoError(ERR.LEN, "AX_ARM length");
  if (b[0] !== PROTO_MAJOR) throw new ProtoError(ERR.VER, "AX_ARM version");
  return { nonce: getU32(b, 1), seqBase: getU16(b, 5) };
}

/** CONFIG: ver | op u8 | joint u8 | min i16 | max i16 (7 bytes). */
export function encodeConfig({ op, joint = 0, min = 0, max = 0 }) {
  const a = [PROTO_MAJOR, op, joint];
  putI16(a, min);
  putI16(a, max);
  return Uint8Array.from(a);
}
export function decodeConfig(raw) {
  const b = bytes(raw);
  if (b.length !== 7) throw new ProtoError(ERR.LEN, "AX_CONFIG length");
  if (b[0] !== PROTO_MAJOR) throw new ProtoError(ERR.VER, "AX_CONFIG version");
  return { op: b[1], joint: b[2], min: getI16(b, 3), max: getI16(b, 5) };
}

// ---------------------------------------------------------------- AX_STATE

/** ver | state | latch | flags | fault u16 | batt_mV u16 | last_seq u16 | n u8 | n x i16 (11 + 2n bytes). */
export function encodeState({ state, latch, flags = 0, fault = 0, battMv = 0, lastSeq = 0, positions = [] }) {
  const a = [PROTO_MAJOR, state, latch, flags];
  putU16(a, fault);
  putU16(a, clampInt(battMv, 0, 0xffff));
  putU16(a, lastSeq & 0xffff);
  a.push(positions.length);
  for (const p of positions) putI16(a, p);
  return Uint8Array.from(a);
}
export function decodeState(raw) {
  const b = bytes(raw);
  if (b.length < 11) throw new ProtoError(ERR.LEN, "AX_STATE too short");
  if (b[0] !== PROTO_MAJOR) throw new ProtoError(ERR.VER, "AX_STATE version");
  const n = b[10];
  if (b.length < 11 + 2 * n) throw new ProtoError(ERR.LEN, "AX_STATE truncated (MTU too small?)");
  const positions = [];
  for (let k = 0; k < n; k++) positions.push(getI16(b, 11 + 2 * k));
  return { state: b[1], latch: b[2], flags: b[3], fault: getU16(b, 4), battMv: getU16(b, 6), lastSeq: getU16(b, 8), positions };
}

/** Plain-English list of fault bits. */
export function faultText(fault) {
  const out = [];
  if (fault & FAULT.LOW_BATT) out.push("battery low");
  if (fault & FAULT.SERVO_FATAL) out.push("servo overload, heat or voltage error");
  if (fault & FAULT.SERVO_MISSING) out.push("a servo stopped answering");
  if (fault & FAULT.BAD_MODEL) out.push("a servo is not an STS3215");
  if (fault & FAULT.BAD_MODE) out.push("a servo is not in position mode");
  if (fault & FAULT.MTU_LOW) out.push("Bluetooth packet size too small (MTU < 64)");
  if (fault & FAULT.TORQUE_VERIFY) out.push("a servo moved when torque came on");
  return out;
}

/** Joint mask with every joint of a body. */
export const fullMask = (body) => (1 << BODIES[body].joints.length) - 1;
