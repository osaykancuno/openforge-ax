// Maps the sim's joint degrees to one physical arm's raw servo positions. Pure ES module.
// Built from a guided, hands-on session: the user holds the arm in POSE, then moves each joint the way the
// 3D twin shows (gives the direction) and to both ends (gives the range). Nothing is written to the servos.
import { JOINTS, LIMITS, REST } from "../sim/arm-sim.js";

export const POSE = [0, 0, 90, 90, 0, 0]; // upper arm up, forearm forward, gripper pointing down, closed
export const STEPS_PER_DEG = 4096 / 360;
export const MARGIN_DEG = 5;
export const DIRECTION_DEG = 12; // first move larger than this sets the direction
export const MIN_RANGE_DEG = [60, 60, 60, 60, 0, 25]; // wrist roll has no hard ends: it only needs a direction
export const ROLL_WINDOW = 100; // deg either side of the roll zero
export const SEAM_JUMP = 2048; // a jump this large between two samples means the reading wrapped round
export const CAL_VERSION = 1;

export class CalibrationError extends Error {
  constructor(message, joint = -1) {
    super(message);
    this.joint = joint; // the wizard step to repeat (-1: the whole calibration)
  }
}

/** Follows one joint while the user moves it by hand (sampled ~20 Hz). A wrapped reading flags `seam`. */
export function createRangeTracker(startRaw) {
  let last = startRaw;
  let pos = startRaw;
  const t = { start: startRaw, min: startRaw, max: startRaw, dir: 0, seam: false };
  t.update = (raw) => {
    let d = raw - last;
    if (Math.abs(d) > SEAM_JUMP) {
      t.seam = true;
      d -= Math.sign(d) * 4096;
    }
    last = raw;
    pos += d;
    t.min = Math.min(t.min, pos);
    t.max = Math.max(t.max, pos);
    if (!t.dir && Math.abs(pos - startRaw) > DIRECTION_DEG * STEPS_PER_DEG) t.dir = Math.sign(pos - startRaw);
    return t;
  };
  t.rangeDeg = () => (t.max - t.min) / STEPS_PER_DEG;
  return t;
}

/**
 * Wizard progress for one joint step: "dir" (direction missing), "range" (move further), "other" (the rest pose is
 * not covered yet: go further the other way) or "ok".
 */
export function jointStatus(t, i, poseRawI) {
  if (!t.dir) return "dir";
  if (i === 4 || i === 5) return t.rangeDeg() >= MIN_RANGE_DEG[i] ? "ok" : "range";
  if (t.rangeDeg() < MIN_RANGE_DEG[i]) return "range";
  const deg = (raw) => POSE[i] + (t.dir * (raw - poseRawI)) / STEPS_PER_DEG;
  const [lo, hi] = [deg(t.min), deg(t.max)].sort((a, b) => a - b);
  return REST[i] >= lo + MARGIN_DEG + 1 && REST[i] <= hi - MARGIN_DEG - 1 ? "ok" : "other";
}

/**
 * poseRaw: raw positions in POSE. trackers: one createRangeTracker per joint (dir = the sim's positive direction;
 * for the gripper, the opening direction). eeprom: [[min,max]] servo position limits.
 */
export function buildCalibration({ poseRaw, trackers, eeprom = JOINTS.map(() => [0, 4095]) }) {
  const sign = trackers.map((t) => t.dir);
  JOINTS.forEach((j, i) => {
    const name = label(j);
    if (!sign[i]) throw new CalibrationError(`We did not see the ${name} move in the direction shown. Repeat that step.`, i);
    if (trackers[i].seam && i !== 4) throw new CalibrationError(`The ${name} servo is not centred (its range crosses the servo's zero). Run the LeRobot calibration once, then retry.`, i);
    if (trackers[i].rangeDeg() < MIN_RANGE_DEG[i]) throw new CalibrationError(`The ${name} only moved ${Math.round(trackers[i].rangeDeg())}°. Move it gently all the way to both ends.`, i);
  });

  const zero = poseRaw.map((r, i) => (i === 5 ? r : r - sign[i] * POSE[i] * STEPS_PER_DEG));
  const g = trackers[5];
  const openEnd = sign[5] > 0 ? Math.min(g.max, eeprom[5][1]) : Math.max(g.min, eeprom[5][0]); // the servo cannot go past its EEPROM end
  const gripper = { closed: poseRaw[5], open: openEnd - sign[5] * MARGIN_DEG * STEPS_PER_DEG };
  const range = trackers.map((t, i) => (i === 4 ? [...eeprom[4]] : [t.min, t.max]));
  const cal = { version: CAL_VERSION, zero, sign, gripper, range, eeprom, safe: [] };

  for (let i = 0; i < 5; i++) {
    const roll = i === 4 ? [degToRaw(cal, 4, -ROLL_WINDOW - MARGIN_DEG), degToRaw(cal, 4, ROLL_WINDOW + MARGIN_DEG)] : null;
    const lo = Math.max(roll ? Math.min(...roll) : trackers[i].min, eeprom[i][0]);
    const hi = Math.min(roll ? Math.max(...roll) : trackers[i].max, eeprom[i][1]);
    const a = rawToDeg(cal, i, lo);
    const b = rawToDeg(cal, i, hi);
    const safeLo = Math.max(LIMITS[i][0], Math.min(a, b) + MARGIN_DEG);
    const safeHi = Math.min(LIMITS[i][1], Math.max(a, b) - MARGIN_DEG);
    if (safeHi - safeLo < 30) throw new CalibrationError(`The ${label(JOINTS[i])} has too little safe travel. Repeat its step.`, i);
    cal.safe.push([round1(safeLo), round1(safeHi)]);
  }
  const gEe = [eeprom[5][0], eeprom[5][1]].map((r) => rawToDeg(cal, 5, r));
  cal.safe.push([round1(Math.max(0, Math.min(...gEe))), round1(Math.min(100, Math.max(...gEe)))]);

  const bad = outside(cal, REST);
  if (bad >= 0) throw new CalibrationError(`The rest pose is outside the measured range of the ${label(JOINTS[bad])}. Repeat its step and move it further.`, bad);
  return cal;
}

const RAW_BOUND = 8192; // any sane raw value (sign-magnitude positions are 15-bit, real ones within one turn)

/** Rebuilds a calibration from its own measurements (optionally with one joint's direction reversed). */
function rebuild(c, flip = -1) {
  const poseRaw = c.zero.map((z, j) => (j === 5 ? c.gripper.closed : z + c.sign[j] * POSE[j] * STEPS_PER_DEG));
  const trackers = c.range.map((r, j) => ({ dir: j === flip ? -c.sign[j] : c.sign[j], min: r[0], max: r[1], seam: false, rangeDeg: () => (r[1] - r[0]) / STEPS_PER_DEG }));
  return buildCalibration({ poseRaw, trackers, eeprom: c.eeprom });
}

/**
 * A stored calibration is untrusted (any script on this origin can write localStorage). It must be well formed,
 * within sane bounds, consistent with its own measurements (so `safe` cannot be widened by editing it), and,
 * when given, recorded on servos with the same EEPROM limits as the arm now connected.
 */
export function validCalibration(c, liveEeprom) {
  const nums = (a, n) => Array.isArray(a) && a.length === n && a.every((v) => Number.isFinite(v) && Math.abs(v) <= RAW_BOUND);
  const pairs = (a) => Array.isArray(a) && a.length === 6 && a.every((r) => nums(r, 2) && r[0] <= r[1]);
  const shape = !!c && typeof c === "object" && c.version === CAL_VERSION && nums(c.zero, 6) && Array.isArray(c.sign) && c.sign.length === 6
    && c.sign.every((s) => s === 1 || s === -1) && nums([c.gripper?.closed, c.gripper?.open], 2)
    && Math.abs(c.gripper.open - c.gripper.closed) >= 10 * STEPS_PER_DEG && pairs(c.range) && pairs(c.eeprom)
    && Array.isArray(c.safe) && c.safe.length === 6 && c.safe.every((r) => Array.isArray(r) && r.length === 2 && r.every(Number.isFinite));
  if (!shape) return false;
  if (liveEeprom && !c.eeprom.every((r, i) => r[0] === liveEeprom[i][0] && r[1] === liveEeprom[i][1])) return false;
  try {
    const again = rebuild(c);
    const close = (a, b) => Math.abs(a - b) < 0.11;
    return again.safe.every((r, i) => close(r[0], c.safe[i][0]) && close(r[1], c.safe[i][1]))
      && again.zero.every((z, i) => close(z, c.zero[i])) && close(again.gripper.open, c.gripper.open);
  } catch {
    return false;
  }
}

/** The nudge test said a joint moves the wrong way: rebuild with that joint's direction reversed. */
export function flipJoint(c, i) {
  // the gripper's closed end is fixed by the pose, so a wrong gripper means the pose was not fully closed
  if (i === 5) throw new CalibrationError("The gripper moved the wrong way. Recalibrate with the gripper fully closed in the first pose.");
  return rebuild(c, i);
}

/**
 * Physical check before reusing a saved calibration: with the arm folded to rest by hand, the four main joints
 * must read within `tolDeg` of the rest pose. A different arm or a re-mounted servo is off by far more.
 */
export function nearRest(cal, raw, tolDeg = 15) {
  const sim = rawToSim(cal, raw);
  return [0, 1, 2, 3].find((i) => Math.abs(sim[i] - REST[i]) > tolDeg) ?? -1;
}

/** On reconnect: is this still the arm that was calibrated? Every joint must read inside its measured range. */
export function matchesArm(cal, raw, slackDeg = 10) {
  const slack = slackDeg * STEPS_PER_DEG;
  return raw.findIndex((r, i) => r < cal.range[i][0] - slack || r > cal.range[i][1] + slack);
}

export function degToRaw(cal, i, deg) {
  if (i === 5) return Math.round(cal.gripper.closed + (cal.gripper.open - cal.gripper.closed) * (deg / 100));
  return Math.round(cal.zero[i] + cal.sign[i] * deg * STEPS_PER_DEG);
}

export function rawToDeg(cal, i, raw) {
  if (i === 5) return ((raw - cal.gripper.closed) / (cal.gripper.open - cal.gripper.closed)) * 100;
  return (raw - cal.zero[i]) / (cal.sign[i] * STEPS_PER_DEG);
}

export const simToRaw = (cal, joints) => joints.map((d, i) => degToRaw(cal, i, d));
export const rawToSim = (cal, raws) => raws.map((r, i) => rawToDeg(cal, i, r));

/** The same pose with every joint brought inside its safe range (measured poses can sit just past the margin). */
export const clampSafe = (cal, joints) => joints.map((d, i) => Math.min(cal.safe[i][1], Math.max(cal.safe[i][0], d)));

/** Index of the first joint outside the safe range, or -1. */
export function outside(cal, joints) {
  return joints.findIndex((d, i) => d < cal.safe[i][0] - 1e-6 || d > cal.safe[i][1] + 1e-6);
}

export const label = (j) => j.replace("_", " ");
const round1 = (v) => Math.round(v * 10) / 10;
