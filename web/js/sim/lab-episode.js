// Lab trials in the Proving Grounds: every Workbench robot, verified like the Synth Arm run. Shared by the arena
// (browser) and the verifier (Node). Pure: the missions replay bit-exact from { robot, level, seed, actions }.
import { MISSIONS } from "../bench/missions/index.js";
import { canonicalize } from "./episode.js";

export const LAB_SIM_ID = "openforge-lab-sim@1";
export const LAB_FORMAT = "openforge.lab-episode.v1";
export const LAB_ROBOTS = Object.keys(MISSIONS);

/** On-chain class index (AgentRenderer order) → the robot whose missions that class flies. */
export const CLASS_ROBOT = ["so101", "rover", "hound", "hand", "spider", "drone", "fab", "replicant", "ax1-rover", "ax1-desk", "ax1-walker"];
/** AX-1 is the lab's own robot (and classes 8-10): every agent may fly its three bodies. */
export const OPEN_ROBOTS = ["ax1-rover", "ax1-desk", "ax1-walker"];

/** Robots an agent of class `classIndex` can fly in recorded lab trials: its own robot first, then AX-1, no repeats. */
export const robotsForClass = (classIndex) => [...new Set([CLASS_ROBOT[classIndex], ...OPEN_ROBOTS].filter(Boolean))];

export const labMission = (robot, level) => `lab/${robot}/${level}`;

/** The mission's level, or null when robot or level is unknown. */
export function labLevel(robot, level) {
  const m = Object.hasOwn(MISSIONS, robot) ? MISSIONS[robot] : null;
  const lv = m && m.levels.find((l) => l.id === level);
  return lv ? { m, lv } : null;
}

/**
 * The fields each robot's missions read from an action, and their types: n number, b boolean, s short string or null,
 * a5 up to 5 numbers; "vector6" = the arm's 6 joint angles. Anything else is refused, so padding a trace with
 * ignored fields cannot make the same moves look new (the duplicate check hashes exactly these fields).
 */
const N = "n", B = "b", S = "s";
const BIPED = { ankle: N, knee: N, lean: N, shift: N, lift: N };
export const ACTION_SCHEMA = {
  so101: "vector6",
  rover: { l: N, r: N },
  "ax1-rover": { l: N, r: N },
  hound: { thigh: N, bend: N, gait: S, stride: N, freq: N, turn: N },
  hand: { f: "a5" },
  spider: { liftA: B, liftB: B, swing: N },
  drone: { thr: N, yaw: N, pitch: N, roll: N },
  fab: { jx: N, jy: N, jz: N, ext: B, home: S, gotoZ: B, baby: N },
  replicant: { ...BIPED, arms: N },
  "ax1-desk": { torso: N, pan: N, tilt: N, rsh: N, rel: N, lsh: N, lel: N },
  "ax1-walker": BIPED,
};
const finite = (v) => typeof v === "number" && Number.isFinite(v) && Math.abs(v) <= 1e6;
const fits = (type, v) =>
  type === N ? finite(v) : type === B ? typeof v === "boolean" : type === S ? v === null || (typeof v === "string" && v.length <= 12) : type === "a5" ? Array.isArray(v) && v.length <= 5 && v.every(finite) : false;

/** Returns an error string, or null when `actions` is a well-formed trace for this level (shape only, not the score). */
export function validateLabActions(robot, level, actions) {
  const found = labLevel(robot, level);
  if (!found) return "unknown robot or level";
  if (!Array.isArray(actions) || actions.length === 0) return "no actions";
  if (actions.length > found.lv.maxSteps) return "longer than the level allows";
  const schema = ACTION_SCHEMA[robot];
  for (const a of actions) {
    if (schema === "vector6") {
      if (!Array.isArray(a) || a.length !== 6 || !a.every(finite)) return "bad joint vector";
      continue;
    }
    if (!a || typeof a !== "object" || Array.isArray(a)) return "an action is not an object";
    for (const k of Object.keys(a)) if (!Object.hasOwn(schema, k) || !fits(schema[k], a[k])) return `bad field ${String(k).slice(0, 16)}`;
  }
  return null;
}

/** Steps the mission actually consumed (it stops at done): a longer trace carries padding and is refused. */
export function stepsUsed(robot, level, seed, actions) {
  const { m, lv } = labLevel(robot, level);
  const s = m.init(level, seed);
  let i = 0;
  for (const n = Math.min(actions.length, lv.maxSteps); i < n && !s.done; i++) m.step(s, actions[i], m.dt);
  return i;
}

/** True when doing nothing passes this layout (a seed the verifier must not hand out). */
export function idlePasses(robot, level, seed) {
  const { m, lv } = labLevel(robot, level);
  const idle = m.idle(m.init(level, seed));
  return !!m.score({ level, seed, actions: Array.from({ length: lv.maxSteps }, () => idle) }).pass;
}

/** Client episode. Only `actions` come from the pilot; the verifier rebuilds the rest from its own challenge. */
export function buildLabEpisode({ tokenId, challengeId, robot, level, seed, actions }) {
  const { m, lv } = labLevel(robot, level) || {};
  if (!m) throw new Error(`unknown lab mission ${robot}/${level}`);
  return {
    format: LAB_FORMAT,
    sim: LAB_SIM_ID,
    mission: labMission(robot, level),
    task: lv.goal,
    robot,
    level,
    fps: Math.round(1 / m.dt),
    tokenId: Number(tokenId),
    challengeId,
    seed,
    actions,
  };
}

/**
 * Replays a trace and scores it. Never throws: a trace that crashes a mission is a failed run.
 * Returns { outcome: { success, score, seconds, reason }, quality } with quality in basis points (0-10000).
 */
export function scoreLabRun(robot, level, seed, actions) {
  const found = labLevel(robot, level);
  if (!found) return { outcome: { success: false, score: 0, seconds: 0, reason: "unknown mission" }, quality: 0 };
  try {
    const r = found.m.score({ level, seed, actions });
    const score = Math.max(0, Math.min(100, Math.round(r.score)));
    return { outcome: { success: !!r.pass, score, seconds: r.seconds, reason: String(r.reason || "") }, quality: score * 100 };
  } catch {
    return { outcome: { success: false, score: 0, seconds: 0, reason: "invalid run" }, quality: 0 };
  }
}

/** Coarse trajectory key (numbers to 1 decimal): catches the same moves resubmitted with tiny noise. */
export function labTrajectoryKey(tokenId, robot, level, actions) {
  const r10 = (x) => Math.round(x * 10);
  const coarse = actions.map((a) => (Array.isArray(a) ? a.map(r10) : Object.keys(a).sort().map((k) => [k, typeof a[k] === "number" ? r10(a[k]) : Array.isArray(a[k]) ? a[k].map(r10) : a[k]])));
  return `${tokenId}|${robot}|${level}|${canonicalize(coarse)}`;
}
