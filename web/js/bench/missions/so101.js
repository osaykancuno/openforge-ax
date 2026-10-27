// SO-101 arm missions: reach, pick-and-place, stack. Kinematics, limits and speeds come from the Proving Grounds sim
// (web/js/sim/arm-sim.js); cube handling is a simple lab model (grasp within 3 cm, cubes fall straight down).
import { fk, ik, LIMITS, REST, MAX_SPEED, CELL, DOCK_RADIUS } from "../../sim/arm-sim.js";
import { DT, RAD, prng, clamp, approach, q, num, replay, standardScore, runPolicy, hold } from "./common.js";

const G = 9.81;
const polar = (r, deg) => ({ x: r * Math.cos(deg * RAD), y: r * Math.sin(deg * RAD) });

function layout(level, seed) {
  const r = prng(seed * 7 + level.length);
  const spot = () => polar(0.15 + r() * 0.08, -55 + r() * 110);
  const target = { ...spot(), z: 0.03 + r() * 0.08 };
  const a = spot();
  let b;
  do b = spot();
  while (Math.hypot(b.x - a.x, b.y - a.y) < 0.1);
  return { target, a, b };
}

function init(level, seed) {
  const L = layout(level, seed);
  const s = { level, seed, t: 0, joints: REST.slice(), cubes: [], dock: null, target: null, held: -1, offset: null, hold: 0, done: false, success: false, reason: null, progress: 0, metrics: {} };
  if (level === "reach") s.target = L.target;
  if (level === "place") {
    s.cubes.push({ x: L.a.x, y: L.a.y, z: CELL / 2, vz: 0, mode: "table" });
    s.dock = { ...L.b, r: DOCK_RADIUS };
  }
  if (level === "stack") {
    s.cubes.push({ x: L.a.x, y: L.a.y, z: CELL / 2, vz: 0, mode: "table" }, { x: L.b.x, y: L.b.y, z: CELL / 2, vz: 0, mode: "table" });
  }
  s.start = fk(s.joints).tip;
  s.d0 = s.target ? Math.hypot(s.start.x - s.target.x, s.start.y - s.target.y, s.start.z - s.target.z) : 1;
  return s;
}

/** The farthest reachable point on the straight line from a reachable tip toward `to` (bisection), as joint angles. */
function reachToward(from, to, roll, grip) {
  let best = ik(from, roll, grip);
  if (!best) return null;
  let lo = 0, hi = 1;
  for (let i = 0; i < 12; i++) {
    const k = (lo + hi) / 2;
    const j = ik({ x: from.x + (to.x - from.x) * k, y: from.y + (to.y - from.y) * k, z: from.z + (to.z - from.z) * k }, roll, grip);
    if (j) (best = j), (lo = k);
    else hi = k;
  }
  return best;
}

/** Height a falling cube lands at: on top of another resting cube if mostly over it, else the table. */
function supportZ(s, i) {
  const c = s.cubes[i];
  let z = CELL / 2;
  s.cubes.forEach((o, k) => {
    if (k !== i && o.mode === "table" && Math.hypot(o.x - c.x, o.y - c.y) < CELL * 0.7 && o.z + CELL > z && o.z < c.z) z = o.z + CELL;
  });
  return z;
}

function step(s, action, dt = DT) {
  if (s.done) return s;
  const a = Array.isArray(action) ? action : s.joints;
  const prevGrip = s.joints[5];
  for (let i = 0; i < 6; i++) s.joints[i] = approach(s.joints[i], num(a[i], LIMITS[i][0], LIMITS[i][1], s.joints[i]), MAX_SPEED * dt);
  const { tip } = fk(s.joints);
  const grip = s.joints[5];
  const closing = prevGrip >= 30 && grip < 30;
  const opening = prevGrip <= 50 && grip > 50;

  if (s.held >= 0) {
    const c = s.cubes[s.held];
    c.x = tip.x + s.offset.x;
    c.y = tip.y + s.offset.y;
    c.z = Math.max(CELL / 2, tip.z + s.offset.z);
    if (opening) {
      c.mode = "falling";
      c.vz = 0;
      s.held = -1;
    }
  } else if (closing) {
    let best = -1, bd = 0.03;
    s.cubes.forEach((c, i) => {
      const d = Math.hypot(tip.x - c.x, tip.y - c.y, tip.z - c.z);
      if (c.mode === "table" && d < bd) (best = i), (bd = d);
    });
    if (best >= 0) {
      const c = s.cubes[best];
      c.mode = "held";
      s.held = best;
      s.offset = { x: c.x - tip.x, y: c.y - tip.y, z: c.z - tip.z };
      s.metrics.grasps = (s.metrics.grasps || 0) + 1;
    } else s.metrics.misses = (s.metrics.misses || 0) + 1;
  }
  s.cubes.forEach((c, i) => {
    if (c.mode !== "falling") return;
    c.vz -= G * dt;
    c.z += c.vz * dt;
    const zs = supportZ(s, i);
    if (c.z <= zs) (c.z = zs), (c.vz = 0), (c.mode = "table");
  });
  s.t += dt;

  const open = grip > 50 && s.held < 0;
  const settled = s.cubes.every((c) => c.mode === "table");
  if (s.level === "reach") {
    const d = Math.hypot(tip.x - s.target.x, tip.y - s.target.y, tip.z - s.target.z);
    s.metrics.distanceCm = +(d * 100).toFixed(1);
    s.progress = Math.max(s.progress, clamp(1 - d / s.d0, 0, 1));
    s.hold = hold(s.hold, d < 0.02, dt);
    if (s.hold >= 0.5) finish(s, true, "reached");
  } else if (s.level === "place") {
    const c = s.cubes[0];
    const d = Math.hypot(c.x - s.dock.x, c.y - s.dock.y);
    s.metrics.dockCm = +(d * 100).toFixed(1);
    s.progress = Math.max(s.progress, s.held === 0 ? 0.5 : 0, s.metrics.grasps ? 0.4 : 0);
    if (settled && open && d <= s.dock.r) finish(s, true, "docked");
  } else {
    const [a, b] = s.cubes;
    const off = Math.hypot(a.x - b.x, a.y - b.y);
    const stacked = (top, base) => top.z > base.z + CELL * 0.9 && Math.hypot(top.x - base.x, top.y - base.y) < 0.012;
    s.metrics.offsetMm = +(off * 1000).toFixed(0);
    s.progress = Math.max(s.progress, s.held >= 0 ? 0.5 : 0, s.metrics.grasps ? 0.4 : 0);
    if (settled && open && (stacked(b, a) || stacked(a, b))) finish(s, true, "stacked");
  }
  if (!s.done && s.cubes.some((c) => Math.hypot(c.x, c.y) > 0.45)) finish(s, false, "cube_lost");
  return s;
}

function finish(s, ok, reason) {
  s.done = true;
  s.success = ok;
  s.reason = reason;
  if (ok) s.progress = 1;
}

export const mission = {
  id: "so101",
  dt: DT,
  levels: [
    { id: "reach", title: "Reach the marker", goal: "Bring the gripper tip within 2 cm of the marker and hold it there for half a second.", pass: 60, maxSteps: 45 * 30 },
    { id: "place", title: "Pick and place", goal: "Grasp the cube (close the gripper around it), carry it and release it inside the dock ring.", pass: 60, maxSteps: 90 * 30 },
    { id: "stack", title: "Stack two cubes", goal: "Put one cube on top of the other, within 12 mm, and let go.", pass: 60, maxSteps: 120 * 30 },
  ],
  controls: [
    { type: "mode", id: "mode", label: "Control", options: [{ id: "tip", label: "Tip (IK)" }, { id: "joints", label: "Joints" }], value: "tip" },
    { type: "slider", id: "tx", group: "tip", label: "Forward", min: 8, max: 32, step: 0.5, unit: "cm" },
    { type: "slider", id: "ty", group: "tip", label: "Left ↔ right", min: -22, max: 22, step: 0.5, unit: "cm" },
    { type: "slider", id: "tz", group: "tip", label: "Height", min: 1, max: 24, step: 0.5, unit: "cm" },
    { type: "slider", id: "j0", group: "joints", label: "Shoulder pan", min: LIMITS[0][0], max: LIMITS[0][1], step: 1, unit: "°" },
    { type: "slider", id: "j1", group: "joints", label: "Shoulder lift", min: LIMITS[1][0], max: LIMITS[1][1], step: 1, unit: "°" },
    { type: "slider", id: "j2", group: "joints", label: "Elbow", min: LIMITS[2][0], max: LIMITS[2][1], step: 1, unit: "°" },
    { type: "slider", id: "j3", group: "joints", label: "Wrist flex", min: LIMITS[3][0], max: LIMITS[3][1], step: 1, unit: "°" },
    { type: "slider", id: "j4", group: "joints", label: "Wrist roll", min: LIMITS[4][0], max: LIMITS[4][1], step: 1, unit: "°" },
    { type: "slider", id: "grip", label: "Gripper (0 closed · 100 open)", min: 0, max: 100, step: 1, unit: "%" },
  ],
  uiDefaults(s) {
    const { tip } = fk(s.joints);
    return { tx: q(tip.x * 100, 1), ty: q(-tip.y * 100, 1), tz: q(tip.z * 100, 1), j0: s.joints[0], j1: s.joints[1], j2: s.joints[2], j3: s.joints[3], j4: s.joints[4], grip: s.joints[5] };
  },
  /**
   * UI values → joint targets. A tip out of reach (about a third of the slider box) goes as far as the arm can along the
   * way there, so the arm always follows the sliders; null only when even the current tip has no IK solution.
   */
  toAction(ui, s) {
    if (ui.mode === "joints") return [ui.j0, ui.j1, ui.j2, ui.j3, ui.j4, ui.grip].map((v) => q(v, 1));
    const want = { x: ui.tx / 100, y: -ui.ty / 100, z: ui.tz / 100 };
    const j = ik(want, ui.j4 ?? 0, ui.grip) ?? (s ? reachToward(fk(s.joints).tip, want, ui.j4 ?? 0, ui.grip) : null);
    return j ? j.map((v) => q(v, 1)) : null;
  },
  init,
  step,
  score(trace) {
    const s = replay(mission, trace);
    return standardScore(mission, trace, s);
  },
  readout(s) {
    const { tip } = fk(s.joints);
    const parts = [`Tip ${(tip.x * 100).toFixed(1)} fwd, ${(-tip.y * 100).toFixed(1)} side, ${(tip.z * 100).toFixed(1)} cm up`, `gripper ${s.joints[5] > 50 ? "open" : "closed"}`];
    if (s.target) parts.push(`marker ${s.metrics.distanceCm ?? "–"} cm away`);
    // how far the gripper is from grabbing: closing grasps a cube within 3 cm of the tip
    const free = s.cubes.filter((c) => c.mode === "table");
    if (s.held < 0 && free.length) parts.push(`nearest cube ${(Math.min(...free.map((c) => Math.hypot(tip.x - c.x, tip.y - c.y, tip.z - c.z))) * 100).toFixed(1)} cm from the tip (close the gripper within 3 cm)`);
    if (s.dock) parts.push(`cube ${s.held === 0 ? "held" : "on table"}, ${s.metrics.dockCm ?? "–"} cm from dock`);
    if (s.level === "stack") parts.push(`cubes ${s.metrics.offsetMm ?? "–"} mm apart`);
    return parts.join(" · ");
  },
  /** Scripted solution through IK waypoints (used by tests and the "Show me" demo). */
  solve(level, seed) {
    const s0 = init(level, seed);
    const plan = [];
    const go = (p, grip, extra = 6) => plan.push({ p, grip, extra });
    if (level === "reach") go(s0.target, 100, 20);
    else {
      const [from, to] = level === "place" ? [s0.cubes[0], s0.dock] : [s0.cubes[1], s0.cubes[0]];
      const dropZ = level === "place" ? 0.04 : CELL * 1.5 + 0.012;
      go({ x: from.x, y: from.y, z: 0.07 }, 100);
      go({ x: from.x, y: from.y, z: 0.016 }, 100);
      go({ x: from.x, y: from.y, z: 0.016 }, 0);
      go({ x: from.x, y: from.y, z: 0.09 }, 0);
      go({ x: to.x, y: to.y, z: 0.09 }, 0);
      go({ x: to.x, y: to.y, z: dropZ }, 0);
      go({ x: to.x, y: to.y, z: dropZ }, 100, 30);
    }
    let k = 0, waited = 0;
    return runPolicy(mission, level, seed, (s) => {
      const w = plan[Math.min(k, plan.length - 1)];
      const target = ik(w.p, 0, w.grip).map((v) => q(v, 1));
      if (target.every((v, i) => Math.abs(v - s.joints[i]) < 0.05)) {
        if (++waited > w.extra) (k = Math.min(k + 1, plan.length - 1)), (waited = 0);
      }
      return target;
    });
  },
  idle: (s) => s.joints.map((v) => q(v, 1)),
};

/** sim frame (x fwd, y left, z up) → three.js (x, y up, z): the rig's pan 0 faces +x. */
export const toThree = (p) => ({ x: p.x, y: p.z, z: -p.y });
export default mission;
