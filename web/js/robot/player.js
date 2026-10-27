// Drives a physical (or virtual) SO-101 through the STS bus for Robot Link. Pure ES module.
// Safety model (docs/05-ROBOT-LINK.md §5):
// - connect refuses anything but STS3215 servos in position mode;
// - torque comes on only once the arm is still, with goal = present, and is verified before any motion;
// - every command resends acceleration, speed cap and torque limit (RAM values reset to "unlimited" on brown-out);
// - moves the run does not define (start, finish, return to rest, hover) follow a route checked with forward
//   kinematics for table clearance, and the servos drive them at a low hardware speed;
// - a run, even a hostile file, is checked frame by frame (table, range, jitter) and played no faster than
//   HW_MAX_DEG_S, whatever its own speed;
// - STOP, a stalled tab, a fault, a blocked joint or any error freeze the arm where it is (torque off only if
//   freezing fails). Nothing moves on its own after that.
import { FPS, JOINTS, LIMITS, LINKS, REST, SIM_ID, fk, ik, limitStep, replay, validateActions } from "../sim/arm-sim.js";
import { FORMAT } from "../sim/episode.js";
import { FATAL_ERRORS, REG, STS3215_MODEL, decodeLoad, decodePos, encodePos, readU16, u16 } from "./sts-bus.js";
import { STEPS_PER_DEG, clampSafe, label, outside, rawToSim, simToRaw } from "./calibration.js";

export const IDS = [1, 2, 3, 4, 5, 6];
export const SPEEDS = [0.25, 0.5, 0.75, 1];
export const DEFAULT_SPEED = 0.5;
export const BLOCK_DEG = 12;
export const BLOCK_MS = 300;
export const LOAD_LIMIT = 950; // of 1000
export const STALL_MS = 250;
export const CLEARANCE = 0.02; // m above the table for every move the run itself does not define
export const MOVE_SPEED = 30; // deg/s for hardware-driven moves
export const AIR_OFFSET = 0.05; // m: rehearsal runs happen this far above the table
export const HW_MAX_DEG_S = 90; // ceiling for any joint on the real arm, whatever the run or the speed setting
export const MIN_HEIGHT = 0.008; // m: tip, wrist and elbow stay above this in every frame of a run (sim table: 5 mm)
const MAX_REVERSALS = 4; // direction changes > 1 deg per joint within any 1 s window (anti-jitter)
const STILL_DEG = 1;
const STILL_MS = 500;
const ACCEL = 100; // x100 steps/s^2 (~880 deg/s^2): at the 90 deg/s ceiling a STOP settles within ~5 deg
const TORQUE_ARM = 800; // 80 %: still holds the arm, pinches less
const TORQUE_GRIPPER = 500;
const READ_EVERY = 3;
const HISTORY = 6; // commanded poses kept for the blocked-arm check (~200 ms)

export class SafetyError extends Error {}

export const realClock = {
  now: () => performance.now(),
  sleep: (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms))),
};

// ================================================================ connect

/** Finds the six servos and checks they are safe to drive. */
export async function scan(bus) {
  const found = [];
  for (const id of IDS) if (await bus.ping(id)) found.push(id);
  const problems = [];
  const missing = IDS.filter((id) => !found.includes(id));
  let volts = null;
  for (const id of found) {
    const name = label(JOINTS[id - 1]);
    if (readU16(await bus.read(id, REG.MODEL, 2)) !== STS3215_MODEL) problems.push(`The ${name} servo (ID ${id}) is not an STS3215.`);
    if ((await bus.read(id, REG.MODE, 1))[0] !== 0) problems.push(`The ${name} servo (ID ${id}) is not in position mode. It would spin, so Robot Link refuses it.`);
    const [maxV, minV] = await bus.read(id, REG.MAX_VOLT, 2);
    const v = (await bus.read(id, REG.VOLTAGE, 1))[0];
    volts = volts === null ? v / 10 : Math.min(volts, v / 10);
    if (v < minV + 3 || v > maxV) problems.push(`The ${name} servo sees ${(v / 10).toFixed(1)} V, outside its ${(minV / 10).toFixed(1)}–${(maxV / 10).toFixed(1)} V range. Check the power supply.`);
  }
  const hint = found.length === 1 && found[0] === 1
    ? "Only one servo answers as ID 1: new servos all ship as ID 1. Set the IDs once with LeRobot's motor setup."
    : missing.length ? `No answer from: ${missing.map((id) => `${label(JOINTS[id - 1])} (ID ${id})`).join(", ")}. Check that cable.` : "";
  return { found, missing, problems, volts, hint };
}

export async function readEeprom(bus) {
  const out = [];
  for (const id of IDS) {
    const b = await bus.read(id, REG.MIN_LIMIT, 4);
    out.push([decodePos(readU16(b, 0)), decodePos(readU16(b, 2))]);
  }
  return out;
}

// ================================================================ low level

/** Raw positions and loads of all servos in one sync read (registers 56..61). */
export async function readState(bus) {
  const m = await bus.syncRead(REG.PRESENT, 6, IDS);
  return {
    raw: IDS.map((id) => decodePos(readU16(m.get(id), 0))),
    load: IDS.map((id) => decodeLoad(readU16(m.get(id), 4))),
    fault: IDS.find((id) => (bus.servoErrors.get(id) || 0) & FATAL_ERRORS) || 0,
  };
}

const HW_MAX_STEPS = Math.ceil(HW_MAX_DEG_S * 1.2 * STEPS_PER_DEG);

/**
 * Registers 41..49 for one servo: acceleration, goal, goal time 0, speed cap, torque limit.
 * The speed cap is always 1..HW_MAX_STEPS: 0 (or a NaN that would encode as 0) means unlimited on STS servos.
 */
export function motionBlock(goalRaw, vel, servoIndex) {
  if (!Number.isFinite(goalRaw)) throw new SafetyError("Internal error: invalid target. The arm was not moved.");
  const v = Number.isFinite(vel) ? Math.max(1, Math.min(HW_MAX_STEPS, Math.round(vel))) : 1;
  return [ACCEL, ...encodePos(Math.round(goalRaw)), 0, 0, ...u16(v), ...u16(servoIndex === 5 ? TORQUE_GRIPPER : TORQUE_ARM)];
}

async function sendGoals(bus, goalsRaw, vels) {
  const blocks = IDS.map((id, i) => [id, motionBlock(goalsRaw[i], vels[i], i)]); // validate all before sending any
  await bus.syncWrite(REG.ACCEL, blocks);
}

/** Raw goals for a sim pose, always inside the calibrated safe range. */
export const goalsFor = (cal, pose) => simToRaw(cal, clampSafe(cal, pose));

const slow = () => IDS.map(() => 200);

/** Waits until no joint moved more than 1 deg for 0.5 s (hands off). Returns the raw pose. */
export async function waitStill(bus, clock = realClock, timeoutMs = 15000) {
  const t0 = clock.now();
  let ref = (await readState(bus)).raw;
  let since = clock.now();
  for (;;) {
    await clock.sleep(100);
    const raw = (await readState(bus)).raw;
    if (raw.some((r, i) => Math.abs(r - ref[i]) > STILL_DEG * STEPS_PER_DEG)) {
      ref = raw;
      since = clock.now();
    } else if (clock.now() - since >= STILL_MS) return raw;
    if (clock.now() - t0 > timeoutMs) throw new SafetyError("The arm kept moving. Take your hands off it and try again.");
  }
}

/** Torque on exactly where the arm is: still -> goal = present (with limits) -> enable -> verify. */
export async function holdHere(bus, clock = realClock) {
  const raw = await waitStill(bus, clock);
  await sendGoals(bus, raw, slow());
  await bus.syncWrite(REG.TORQUE, IDS.map((id) => [id, [1]]));
  const now = (await readState(bus)).raw;
  const off = now.findIndex((r, i) => Math.abs(r - raw[i]) > 2 * STEPS_PER_DEG);
  if (off >= 0) {
    await relax(bus);
    throw new SafetyError(`The ${label(JOINTS[off])} moved when torque came on, so torque was turned off again. Support the arm and retry.`);
  }
  return raw;
}

/** Holds the arm still where it is now (torque stays on). */
export async function freeze(bus) {
  const { raw } = await readState(bus);
  await sendGoals(bus, raw, slow());
  return raw;
}

/** Torque off on every servo, read back (a sync write gets no reply). Returns true once all report off. */
export async function relax(bus) {
  for (let attempt = 0; attempt < 2; attempt++) {
    await bus.syncWrite(REG.TORQUE, IDS.map((id) => [id, [0]]));
    let off = true;
    for (const id of IDS) off = (await bus.read(id, REG.TORQUE, 1).catch(() => [1]))[0] === 0 && off;
    if (off) return true;
  }
  return false;
}

/** Freeze; if even that fails, torque off as the last resort. */
async function safeHalt(bus) {
  try {
    await freeze(bus);
  } catch {
    await relax(bus).catch(() => {});
  }
}

// ================================================================ routes

export function lerp(a, b, s) {
  return a.map((v, i) => v + (b[i] - v) * s);
}

/**
 * Lowest point of the arm (tip, wrist, elbow) in a pose. Base and self-collision are not modelled: within the
 * sim LIMITS the links cannot reach the base, and the shoulder sits above the table.
 */
export const lowest = (pose) => {
  const p = fk(pose);
  return Math.min(p.tip.z, p.wrist.z, p.elbow.z);
};

/** Lowest point along a straight joint-space move. */
export function minHeight(a, b, samples = 40) {
  let z = Infinity;
  for (let k = 0; k <= samples; k++) z = Math.min(z, lowest(lerp(a, b, k / samples)));
  return z;
}

/** A straight move is clear if it never dips below CLEARANCE, or below its own endpoints when they are lower. */
export function clearMove(a, b) {
  const ends = Math.min(lowest(a), lowest(b));
  return minHeight(a, b) >= Math.min(CLEARANCE, Math.max(0.005, ends)) - 0.001; // never below the sim's 5 mm table threshold
}

/**
 * A route of waypoints from `from` to `to`, every straight segment clear of the table (clearMove) and inside
 * the calibrated range (the first point may start slightly outside it: it was measured, not commanded).
 * Tries direct, then through a raised pose above `from`, then also above `to`. Null = no clear route.
 */
export function safeRoute(cal, from, to) {
  const up = (p) => clampSafe(cal, [p[0], 0, 45, 45, p[4], p[5]]); // upper arm vertical, forearm and hand angled up and out
  const candidates = [[to], [up(from), to], [up(from), up(to), to]];
  for (const c of candidates) {
    let a = from;
    let ok = true;
    for (const w of c) {
      if (outside(cal, w) >= 0 || !clearMove(a, w)) {
        ok = false;
        break;
      }
      a = w;
    }
    if (ok) return c;
  }
  return null;
}

/**
 * Frames along a route, timed so that played at `speed` no joint exceeds MOVE_SPEED (these moves start from
 * wherever the arm is, so they are always slow). Smoothstep peaks at 1.5x the average.
 */
export function routeFrames(from, route, speed = 1) {
  const out = [];
  let a = from;
  const perFrame = MOVE_SPEED / (FPS * speed);
  for (const b of route) {
    const dist = Math.max(...a.map((v, i) => Math.abs(b[i] - v) / (i === 5 ? 3 : 1)));
    const n = Math.max(FPS, Math.ceil((dist * 1.5) / perFrame));
    for (let k = 1; k <= n; k++) {
      const s = k / n;
      out.push(lerp(a, b, s * s * (3 - 2 * s)));
    }
    a = b;
  }
  return out;
}

/**
 * Hardware-driven move: one goal per waypoint, with per-joint speeds scaled so all joints arrive together
 * (a straight joint-space line, the one safeRoute checked). Browser timers only watch; they never drive.
 */
export async function moveSafely(bus, cal, target, { clock = realClock, speed = MOVE_SPEED, cancelled = () => false, onPose = () => {} } = {}) {
  if (!Number.isFinite(speed) || speed <= 0) throw new SafetyError("Internal error: invalid speed. The arm was not moved.");
  speed = Math.min(speed, HW_MAX_DEG_S);
  if (!Array.isArray(target) || target.length !== 6 || !target.every(Number.isFinite)) throw new SafetyError("Internal error: invalid target. The arm was not moved.");
  let cur = rawToSim(cal, (await readState(bus)).raw);
  const route = safeRoute(cal, cur, target);
  if (!route) throw new SafetyError("There is no clear path from where the arm is. Press Relax, support the arm and move it near the rest pose by hand.");
  for (const wp of route) {
    const dist = wp.map((v, i) => Math.abs(v - cur[i]));
    const secs = Math.max(0.5, Math.max(...dist.slice(0, 5)) / speed, dist[5] / 100);
    const goal = goalsFor(cal, wp);
    const raw0 = simToRaw(cal, cur);
    await sendGoals(bus, goal, goal.map((g, i) => Math.abs(g - raw0[i]) / secs));
    const t0 = clock.now();
    const from = cur;
    let blockedSince = null;
    for (;;) {
      await clock.sleep(100);
      const st = await readState(bus);
      cur = rawToSim(cal, st.raw);
      onPose(cur);
      // where the joints should be by now on the straight line, give or take the servo's lag
      const expected = lerp(from, wp, Math.min(1, (clock.now() - t0) / 1000 / secs));
      const stuck = [0, 1, 2, 3, 4].find((j) => Math.abs(cur[j] - expected[j]) > BLOCK_DEG || Math.abs(st.load[j]) > LOAD_LIMIT);
      if (stuck === undefined) blockedSince = null;
      else if (blockedSince === null) blockedSince = clock.now();
      else if (clock.now() - blockedSince >= BLOCK_MS) {
        await freeze(bus);
        throw new SafetyError(`Something is blocking the ${label(JOINTS[stuck])}. The arm is holding still.`);
      }
      if (cancelled()) {
        await freeze(bus);
        return false;
      }
      if (st.fault) {
        await freeze(bus).catch(() => {});
        throw new SafetyError(`The ${label(JOINTS[st.fault - 1])} servo reported a fault (overload, heat or power). The arm is holding still.`);
      }
      if (st.raw.every((r, i) => Math.abs(r - goal[i]) <= 2 * STEPS_PER_DEG || i === 5)) break;
      if (clock.now() - t0 > secs * 1000 * 2 + 2000) {
        await freeze(bus);
        throw new SafetyError("The arm did not reach its target: something may be in the way. It is holding still.");
      }
    }
  }
  return true;
}

/** Pose that points the open gripper 7 cm above a scene spot (for placing the cell and the dock). */
export function hoverPose({ x, y }) {
  return ik({ x, y, z: 0.07 }, 0, 100);
}

// ================================================================ runs

/**
 * Problems in the motion itself, independent of the sim's mission outcome (the sim stops checking once the
 * mission ends, so a run could append anything after docking): shape, limits, height of every frame, jitter.
 */
export function motionProblems(actions) {
  const invalid = validateActions(actions);
  if (invalid) return [`The run breaks the robot's movement rules (${invalid}).`];
  const low = actions.findIndex((a) => lowest(a) < MIN_HEIGHT);
  if (low >= 0) return [`At ${(low / FPS).toFixed(1)}s the arm would touch the table.`];
  for (let j = 0; j < 6; j++) {
    const flips = [];
    let dir = 0;
    for (let t = 1; t < actions.length; t++) {
      const d = actions[t][j] - actions[t - 1][j];
      if (Math.abs(d) <= 1) continue;
      if (dir && Math.sign(d) !== dir) flips.push(t);
      dir = Math.sign(d);
      while (flips.length && t - flips[0] >= FPS) flips.shift();
      if (flips.length > MAX_REVERSALS) return [`At ${(t / FPS).toFixed(1)}s the ${label(JOINTS[j])} shakes back and forth too fast for a real servo.`];
    }
  }
  return [];
}

/** Plain-English problems that make a run unsafe to replay (empty = OK). */
export function checkRun(ep, cal) {
  if (!ep || typeof ep !== "object") return { problems: ["This is not a run file."] };
  if (ep.format !== FORMAT || ep.robot_type !== "so101_follower" || ep.units !== "deg" || ep.sim !== SIM_ID || ep.fps !== FPS)
    return { problems: ["This file is not an OpenForge SO-101 run."] };
  if (typeof ep.seed !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(ep.seed)) return { problems: ["The run has no valid mission seed."] };
  const moveProblems = motionProblems(ep.actions);
  if (moveProblems.length) return { problems: moveProblems };
  const problems = [];
  const outcome = replay(ep.seed, ep.actions);
  if (outcome.events.tableHits > 0) problems.push("The arm hits the table during this run.");
  if (outcome.reason === "cell_lost") problems.push("The run throws the cell off the table.");
  if (cal) {
    const t = ep.actions.findIndex((a) => outside(cal, a) >= 0);
    if (t >= 0) problems.push(`At ${(t / FPS).toFixed(1)}s the ${label(JOINTS[outside(cal, ep.actions[t])])} would go past what your arm can safely reach.`);
  }
  return { problems, outcome };
}

const RAD = Math.PI / 180;

/**
 * The same pose with the gripper tip `dz` higher: pan, hand pitch, roll and gripper unchanged, shoulder and elbow
 * re-solved for the wrist (same elbow branch). Continuous in the input, so a smooth run stays smooth. Null if
 * out of reach or out of the sim's limits.
 */
export function liftPose(a, dz) {
  const { base, upper, fore, hand } = LINKS;
  const p = fk(a);
  const pan = a[0] * RAD;
  const r = p.tip.x * Math.cos(pan) + p.tip.y * Math.sin(pan); // signed reach along the arm's plane
  const pitch = p.pitch * RAD;
  const rw = r - hand * Math.sin(pitch);
  const zw = p.tip.z + dz - hand * Math.cos(pitch) - base;
  const c = (rw * rw + zw * zw - upper * upper - fore * fore) / (2 * upper * fore);
  if (c < -1 || c > 1) return null;
  const elbow = Math.sign(a[2] || 1) * Math.acos(c);
  const lift = Math.atan2(rw, zw) - Math.atan2(fore * Math.sin(elbow), upper + fore * Math.cos(elbow));
  const j = [a[0], lift / RAD, elbow / RAD, p.pitch - lift / RAD - elbow / RAD, a[4], a[5]].map((v) => Math.round(v * 10) / 10);
  return j.every((v, i) => v >= LIMITS[i][0] && v <= LIMITS[i][1]) ? j : null;
}

/** Rehearsal: the same run AIR_OFFSET above the table (continuous lift, then the sim's step limiter). */
export function inTheAir(actions, dz = AIR_OFFSET) {
  const out = [];
  let prev = REST;
  for (const a of actions) {
    prev = limitStep(prev, liftPose(a, dz) || prev);
    out.push(prev);
  }
  return out;
}

/** Per-servo speed cap (steps/s): 1.5x the fastest commanded motion at this playback speed, never above the ceiling. */
export function velocityCaps(frames, speed, cal) {
  const peak = JOINTS.map(() => 0);
  for (let t = 1; t < frames.length; t++) for (let i = 0; i < 6; i++) peak[i] = Math.max(peak[i], Math.abs(frames[t][i] - frames[t - 1][i]));
  const perUnit = (i) => (i === 5 ? Math.abs(cal.gripper.open - cal.gripper.closed) / 100 : STEPS_PER_DEG);
  return peak.map((p, i) => Math.min(HW_MAX_STEPS, Math.max(150, Math.ceil(p * FPS * speed * 1.5 * perUnit(i)))));
}

/** Playback speed actually used: the requested one, lowered so no arm joint exceeds HW_MAX_DEG_S. */
export function effectiveSpeed(actions, speed) {
  let peak = 0;
  for (let t = 1; t < actions.length; t++) for (let i = 0; i < 5; i++) peak = Math.max(peak, Math.abs(actions[t][i] - actions[t - 1][i]));
  return peak > 0 ? Math.min(speed, HW_MAX_DEG_S / (peak * FPS)) : speed;
}

/**
 * Plays `actions` (already checked). Commands go out at a fixed 30 Hz, interpolated along the timeline
 * (start route, run, route back to rest) at `speed`. Events: onState(state, message), onFrame({ commanded, measured, progress }).
 * States: starting, playing, done, stopped, blocked, error. Every stop leaves the arm frozen, torque on.
 */
export function createPlayer({ bus, cal, actions, speed = DEFAULT_SPEED, clock = realClock, onState = () => {}, onFrame = () => {} }) {
  if (!Number.isFinite(speed) || speed <= 0) throw new SafetyError("Pick a playback speed.");
  const problems = motionProblems(actions);
  if (problems.length) throw new SafetyError(problems[0]);
  if (actions.some((a) => outside(cal, a) >= 0)) throw new SafetyError("This run goes past what your arm can safely reach.");
  speed = effectiveSpeed(actions, Math.min(1, Math.max(0.25, speed)));
  const period = 1000 / FPS;
  let stopReq = null;
  let state = "idle";
  const safely = (fn) => (...a) => {
    try {
      fn(...a);
    } catch {} // a UI callback must never break the safety loop
  };
  const emit = safely(onState);
  const frame = safely(onFrame);
  const set = (s, msg = "") => ((state = s), emit(s, msg));

  async function halt(s, msg) {
    await safeHalt(bus);
    set(s, msg);
  }

  let torqueOn = false;
  async function run() {
    set("starting", "Hands off: waiting for the arm to be still, then holding it…");
    const start = rawToSim(cal, await holdHere(bus, clock));
    torqueOn = true;
    const intro = safeRoute(cal, start, actions[0]);
    const outro = safeRoute(cal, actions[actions.length - 1], REST);
    if (!intro || !outro) return halt("error", "There is no clear path to the start of this run from where the arm is. Move it near the rest pose and retry.");
    const introFrames = routeFrames(start, intro, speed);
    const timeline = [...introFrames, ...actions, ...routeFrames(actions[actions.length - 1], outro, speed)];
    const caps = velocityCaps([start, ...timeline], speed, cal);

    set("playing");
    const history = [];
    let blockedSince = null;
    let last = clock.now();
    for (let k = 0; ; k++) {
      // frames are indexed by tick, not wall-clock: a slow browser plays slower, it never catches up
      const tickStart = clock.now();
      const tau = k * speed;
      if (tau > timeline.length - 1) break;
      if (stopReq) return halt("stopped", stopReq);
      if (tickStart - last > period + STALL_MS) return halt("stopped", "The browser paused the playback, so the arm froze where it was.");
      last = tickStart;
      const i = Math.floor(tau);
      const cmd = lerp(timeline[i], timeline[Math.min(i + 1, timeline.length - 1)], tau - i);
      if (i >= introFrames.length && outside(cal, cmd) >= 0) return halt("stopped", "A move left the safe range, so the arm froze.");
      await sendGoals(bus, goalsFor(cal, cmd), caps);
      history.push(cmd);
      if (history.length > HISTORY) history.shift();

      let measured = null;
      if (k % READ_EVERY === 0) {
        const st = await readState(bus);
        measured = rawToSim(cal, st.raw);
        if (st.fault) return halt("blocked", `The ${label(JOINTS[st.fault - 1])} servo reported a fault (overload, heat or power). The arm is holding still; if it went limp, support it.`);
        // gripper excluded: it stalls on purpose when it closes on the cell
        const lag = (j) => Math.min(...history.map((h) => Math.abs(measured[j] - h[j])));
        const stuck = [0, 1, 2, 3, 4].find((j) => lag(j) > BLOCK_DEG || Math.abs(st.load[j]) > LOAD_LIMIT);
        if (stuck === undefined) blockedSince = null;
        else if (blockedSince === null) blockedSince = clock.now();
        else if (clock.now() - blockedSince >= BLOCK_MS) return halt("blocked", `Something is blocking the ${label(JOINTS[stuck])}. The arm is holding still.`);
      }
      frame({ commanded: cmd, measured, progress: tau / (timeline.length - 1) });
      await clock.sleep(period - (clock.now() - tickStart));
    }
    set("done", "Run complete. The arm is back at rest and holding.");
  }

  return {
    get state() {
      return state;
    },
    speed,
    start: () =>
      run().catch(async (e) => {
        if (e instanceof SafetyError && !torqueOn) return set("error", e.message); // nothing is holding the arm: write nothing
        await safeHalt(bus); // never drop a raised arm on a glitch: freeze first, torque off only if that fails
        set("error", e instanceof SafetyError ? e.message : `Connection problem (${e.message}). The arm was told to hold still; if it went limp, support it.`);
      }),
    stop: (reason = "Stopped by you. The arm is holding still.") => {
      if (!stopReq) stopReq = reason;
    },
  };
}
