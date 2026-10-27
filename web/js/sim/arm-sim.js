// openforge-arm-sim@1 — deterministic SO-101 arm simulation for the Proving Grounds.
// Pure ES module, no dependencies: the browser (game) and the server (verifier) run this exact file.
// Units: meters and degrees, 30 fps position control. Joint zero pose and signs are defined in ROBOT below;
// mapping to a specific physical arm's calibration is the bridge's job (scripts/real/replay_so101.py).

export const SIM_ID = "openforge-arm-sim@1";
export const MISSION = "pick-place-cell";
export const FPS = 30;
export const DT = 1 / FPS;
export const MAX_TICKS = 60 * FPS;
export const JOINTS = ["shoulder_pan", "shoulder_lift", "elbow_flex", "wrist_flex", "wrist_roll", "gripper"];
export const LIMITS = [[-110, 110], [-100, 100], [-100, 100], [-100, 100], [-160, 160], [0, 100]];
export const MAX_SPEED = 180; // deg/s
export const MAX_CMD_STEP = MAX_SPEED * DT; // 6 deg per tick: commands themselves must be smooth (real servos jump to targets)
export const LINKS = { base: 0.06, upper: 0.116, fore: 0.135, hand: 0.1 };
export const CELL = 0.03;
export const DOCK_RADIUS = 0.03;
export const REST = [0, -30, 90, 60, 0, 100];
export const ROBOT = {
  robot_type: "so101_follower",
  units: "deg",
  zero_pose: "pan 0 = facing +x; lift 0 = upper arm vertical; elbow/wrist 0 = link aligned with previous; positive pitch tilts toward +r",
  gripper: "0 = closed, 100 = open (percent)",
  links_m: LINKS,
};

const RAD = Math.PI / 180;
const G = 9.81;

/** Deterministic PRNG (mulberry32) seeded from a 0x-hex string. */
export function rng(seedHex) {
  let a = 0;
  const hex = seedHex.replace(/^0x/, "");
  for (let i = 0; i < hex.length; i += 8) a = (a ^ parseInt(hex.slice(i, i + 8), 16)) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Mission layout from the server seed (robot base frame, meters). */
export function createMission(seedHex) {
  const r = rng(seedHex);
  const polar = (rad, deg) => ({ x: rad * Math.cos(deg * RAD), y: rad * Math.sin(deg * RAD) });
  const cell = polar(0.15 + r() * 0.08, -60 + r() * 120);
  let dock;
  do dock = polar(0.15 + r() * 0.08, -60 + r() * 120);
  while (Math.hypot(dock.x - cell.x, dock.y - cell.y) < 0.1);
  return { cell, dock };
}

/** Physical scene spec, enough to set up a real station. */
export function sceneOf(seedHex) {
  const { cell, dock } = createMission(seedHex);
  return {
    frame: "robot_base", units: "m", table_z: 0,
    cell: { x: +cell.x.toFixed(4), y: +cell.y.toFixed(4), z: CELL / 2, size: CELL, mass_kg: 0.02 },
    dock: { x: +dock.x.toFixed(4), y: +dock.y.toFixed(4), radius: DOCK_RADIUS },
  };
}

/** Forward kinematics. Pitch angles are cumulative from vertical; points in sim frame (z up). */
export function fk(j) {
  const pan = j[0] * RAD;
  const p1 = j[1] * RAD;
  const p2 = p1 + j[2] * RAD;
  const p3 = p2 + j[3] * RAD;
  const { base, upper, fore, hand } = LINKS;
  const pts = [[0, base]];
  let r = 0;
  let z = base;
  for (const [L, phi] of [[upper, p1], [fore, p2], [hand, p3]]) {
    r += L * Math.sin(phi);
    z += L * Math.cos(phi);
    pts.push([r, z]);
  }
  const to3 = ([rr, zz]) => ({ x: rr * Math.cos(pan), y: rr * Math.sin(pan), z: zz });
  return { shoulder: to3(pts[0]), elbow: to3(pts[1]), wrist: to3(pts[2]), tip: to3(pts[3]), pitch: p3 / RAD };
}

const inLimits = (j) => j.every((v, i) => v >= LIMITS[i][0] - 1e-9 && v <= LIMITS[i][1] + 1e-9);

/**
 * Inverse kinematics: gripper as vertical as possible (tilts up to 50 deg either way when needed).
 * Returns joint targets or null if unreachable or too close to a singularity.
 */
export function ik({ x, y, z }, roll = 0, gripper = 100) {
  const { base, upper, fore, hand } = LINKS;
  const pan = Math.atan2(y, x) / RAD;
  const rt = Math.hypot(x, y);
  // try vertical first, then tilt alternately away from / toward the base (180, 178, 182, 176, ...)
  for (let k = 0; k <= 50; k++) {
    const pitch = 180 + (k % 2 ? -1 : 1) * Math.ceil(k / 2) * 2;
    const p = pitch * RAD;
    const rw = rt - hand * Math.sin(p);
    const zw = z - hand * Math.cos(p) - base;
    const c = (rw * rw + zw * zw - upper * upper - fore * fore) / (2 * upper * fore);
    if (c < -1 || c > 0.995) continue;
    const elbow = Math.acos(c);
    const phi1 = Math.atan2(rw, zw) - Math.atan2(fore * Math.sin(elbow), upper + fore * Math.cos(elbow));
    const j = [pan, phi1 / RAD, elbow / RAD, pitch - phi1 / RAD - elbow / RAD, roll, gripper];
    if (inLimits(j)) return j;
  }
  return null;
}

export const quantize = (a) => a.map((v, i) => Math.round(Math.min(LIMITS[i][1], Math.max(LIMITS[i][0], v)) * 10) / 10);

/** Move `from` toward `to` by at most MAX_CMD_STEP per joint (client-side command limiter). */
export const limitStep = (from, to) => quantize(to.map((v, i) => from[i] + Math.max(-MAX_CMD_STEP, Math.min(MAX_CMD_STEP, v - from[i]))));

/** Server-side validation: shape, limits, and per-tick command step (no clamping: invalid runs are rejected). */
export function validateActions(actions) {
  if (!Array.isArray(actions) || actions.length < 1 || actions.length > MAX_TICKS) return "bad length";
  let prev = REST;
  for (let t = 0; t < actions.length; t++) {
    const a = actions[t];
    if (!Array.isArray(a) || a.length !== 6 || !a.every((v) => typeof v === "number" && Number.isFinite(v))) return `bad action at ${t}`;
    for (let i = 0; i < 6; i++) {
      if (a[i] < LIMITS[i][0] || a[i] > LIMITS[i][1]) return `joint ${JOINTS[i]} out of range at ${t}`;
      if (Math.abs(a[i] - prev[i]) > MAX_CMD_STEP + 1e-6) return `command step too large on ${JOINTS[i]} at ${t}`;
      if (Math.round(a[i] * 10) !== a[i] * 10) return `precision > 0.1 at ${t}`;
    }
    prev = a;
  }
  return null;
}

export function initialState(seedHex) {
  const m = createMission(seedHex);
  return {
    tick: 0,
    joints: REST.slice(),
    cell: { x: m.cell.x, y: m.cell.y, z: CELL / 2, vz: 0, mode: "table" }, // table | held | falling
    dock: m.dock,
    holdOffset: null,
    prevTip: null,
    contact: false,
    belowTable: false,
    events: { grasps: 0, misses: 0, releases: 0, drops: 0, pushes: 0, tableHits: 0 },
    done: false,
    success: false,
    reason: null,
  };
}

/** Advance one tick with joint targets `action` (degrees). Mutates and returns `s`. */
export function step(s, action) {
  if (s.done) return s;
  const target = quantize(action);
  const prevGrip = s.joints[5];
  for (let i = 0; i < 6; i++) s.joints[i] += Math.max(-MAX_CMD_STEP, Math.min(MAX_CMD_STEP, target[i] - s.joints[i]));
  const { tip } = fk(s.joints);

  const below = tip.z < 0.005;
  if (below && !s.belowTable) s.events.tableHits++;
  s.belowTable = below;

  const c = s.cell;
  const grip = s.joints[5];
  const closing = prevGrip >= 30 && grip < 30;
  const opening = prevGrip <= 50 && grip > 50;
  const dist = Math.hypot(tip.x - c.x, tip.y - c.y, tip.z - c.z);

  if (c.mode === "held") {
    c.x = tip.x + s.holdOffset.x;
    c.y = tip.y + s.holdOffset.y;
    c.z = Math.max(CELL / 2, tip.z + s.holdOffset.z);
    if (opening) {
      c.mode = "falling";
      c.vz = 0;
      s.events.releases++;
    }
  } else {
    if (closing) {
      if (c.mode === "table" && dist < 0.03) {
        c.mode = "held";
        s.holdOffset = { x: c.x - tip.x, y: c.y - tip.y, z: c.z - tip.z };
        s.events.grasps++;
      } else s.events.misses++;
    }
    if (c.mode === "falling") {
      c.vz -= G * DT;
      c.z += c.vz * DT;
      if (c.z <= CELL / 2) {
        c.z = CELL / 2;
        c.mode = "table";
        if (Math.hypot(c.x - s.dock.x, c.y - s.dock.y) > DOCK_RADIUS) s.events.drops++;
      }
    } else if (c.mode === "table" && s.prevTip) {
      // the open gripper sweeping through the cell at table height pushes it
      const touching = Math.hypot(tip.x - c.x, tip.y - c.y) < 0.022 && tip.z < CELL;
      if (touching && grip > 50) {
        c.x += tip.x - s.prevTip.x;
        c.y += tip.y - s.prevTip.y;
        if (!s.contact) s.events.pushes++;
      }
      s.contact = touching;
    }
  }
  s.prevTip = tip;
  s.tick++;

  if (Math.hypot(c.x, c.y) > 0.42) finish(s, false, "cell_lost");
  else if (c.mode === "table" && grip > 50 && Math.hypot(c.x - s.dock.x, c.y - s.dock.y) <= DOCK_RADIUS) finish(s, true, "docked");
  else if (s.tick >= MAX_TICKS) finish(s, false, "timeout");
  return s;
}

function finish(s, success, reason) {
  s.done = true;
  s.success = success;
  s.reason = reason;
}

/** Authoritative replay. With `record`, also returns observation.state (measured joints) per tick. */
export function replay(seedHex, actions, { record = false } = {}) {
  const s = initialState(seedHex);
  const states = [];
  for (const a of actions) {
    step(s, a);
    if (record) states.push(s.joints.map((v) => Math.round(v * 100) / 100));
    if (s.done) break;
  }
  if (!s.done) finish(s, false, "incomplete");
  const outcome = { success: s.success, reason: s.reason, ticks: s.tick, seconds: +(s.tick / FPS).toFixed(3), events: s.events };
  return record ? { outcome, states } : outcome;
}

/**
 * Quality 0..10000. Success: 6000 + speed bonus (<= 2500).
 * Failure: one credit per distinct event type (flailing does not stack), capped at 3000.
 */
export function score(outcome) {
  if (outcome.success) return Math.round(6000 + Math.min(1, Math.max(0, 1 - (outcome.seconds - 5) / 50)) * 2500);
  const kinds = ["grasps", "misses", "releases", "drops", "pushes", "tableHits"].filter((k) => outcome.events[k] > 0).length;
  return Math.min(3000, kinds * 600);
}
