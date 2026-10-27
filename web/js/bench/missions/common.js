// Shared helpers for Workbench missions. Pure ES module: no DOM, no three, no platform randomness, no wall clock.
// A mission is { id, robot, dt, levels: [{ id, title, goal, pass, maxSteps }], controls, init(level, seed),
// step(state, action, dt), score(trace), toAction(ui, state), uiDefaults(state), readout(state), solve(level, seed) }.
// A trace is { level, seed, actions: [action per tick] }; score() replays it, so the result never depends on the UI.

export const FPS = 30;
export const DT = 1 / FPS;
export const RAD = Math.PI / 180;

/** Seeded PRNG (mulberry32) from any integer seed. */
export function prng(seed) {
  let a = (Number(seed) >>> 0) ^ 0x9e3779b9;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
export const lerp = (a, b, k) => a + (b - a) * k;
/** Move v toward target by at most maxStep. */
export const approach = (v, target, maxStep) => v + clamp(target - v, -maxStep, maxStep);
/** Wrap an angle in degrees to (-180, 180]. */
export const wrapDeg = (a) => {
  let x = ((a + 180) % 360 + 360) % 360 - 180;
  if (x === -180) x = 180;
  return x;
};
/** Numbers in actions are rounded so traces are compact and replay bit-exact across JSON round trips. */
export const q = (v, digits = 3) => {
  const k = 10 ** digits;
  return Math.round(Number(v) * k) / k;
};
export const num = (v, lo, hi, dflt = 0) => (typeof v === "number" && Number.isFinite(v) ? clamp(v, lo, hi) : dflt);

/** Find a level by id (or index). */
export function levelOf(mission, level) {
  const lv = typeof level === "number" ? mission.levels[level] : mission.levels.find((l) => l.id === level);
  if (!lv) throw new Error(`${mission.id}: unknown level ${level}`);
  return lv;
}

/**
 * Replay a trace with a mission's init/step. Stops at state.done or at the level's maxSteps.
 * Returns the final state; the caller turns it into a score.
 */
export function replay(mission, trace) {
  const lv = levelOf(mission, trace.level);
  const s = mission.init(lv.id, trace.seed);
  const n = Math.min(trace.actions.length, lv.maxSteps);
  for (let i = 0; i < n && !s.done; i++) mission.step(s, trace.actions[i], mission.dt);
  if (!s.done) {
    s.done = true;
    s.success = false;
    s.reason = s.reason || (n >= lv.maxSteps ? "timeout" : "stopped");
  }
  return s;
}

/**
 * Standard score: a pass is 60 + up to 40 for speed (and an optional quality factor 0..1).
 * A fail scores progress (0..1) × 40, so a partial try still shows how close it came.
 */
export function standardScore(mission, trace, s, { quality = 1 } = {}) {
  const lv = levelOf(mission, trace.level);
  const seconds = +(s.t ?? 0).toFixed(2);
  if (s.success) {
    const speed = clamp(1 - seconds / (lv.maxSteps * mission.dt), 0, 1);
    const value = Math.round(60 + 40 * clamp(0.5 * speed + 0.5 * quality, 0, 1));
    return { pass: value >= lv.pass, score: value, reason: s.reason, seconds, metrics: s.metrics ?? {} };
  }
  return { pass: false, score: Math.round(40 * clamp(s.progress ?? 0, 0, 1)), reason: s.reason, seconds, metrics: s.metrics ?? {} };
}

/** Closed-loop scripted solution: run `policy(state)` against the mission until done. Returns the actions. */
export function runPolicy(mission, level, seed, policy) {
  const lv = levelOf(mission, level);
  const s = mission.init(lv.id, seed);
  const actions = [];
  for (let i = 0; i < lv.maxSteps && !s.done; i++) {
    const a = policy(s, i);
    actions.push(a);
    mission.step(s, a, mission.dt);
  }
  return actions;
}

/** "Hold" timer: counts seconds while `ok` holds, resets otherwise. Returns the new value. */
export const hold = (prev, ok, dt) => (ok ? prev + dt : 0);

/** Distance from point p to segment ab (2D, objects with x/y). */
export function segDist(p, a, b) {
  const vx = b.x - a.x, vy = b.y - a.y;
  const L2 = vx * vx + vy * vy;
  const k = L2 ? clamp(((p.x - a.x) * vx + (p.y - a.y) * vy) / L2, 0, 1) : 0;
  return Math.hypot(p.x - (a.x + vx * k), p.y - (a.y + vy * k));
}

/** Point in convex polygon (counter-clockwise or clockwise), with a signed margin (>0 = inside by that much). */
export function polyMargin(p, poly) {
  let inside = Infinity, outside = Infinity, pos = 0, neg = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const ex = b.x - a.x, ey = b.y - a.y;
    const cross = ex * (p.y - a.y) - ey * (p.x - a.x);
    if (cross >= 0) pos++;
    else neg++;
    inside = Math.min(inside, Math.abs(cross) / Math.hypot(ex, ey));
    outside = Math.min(outside, segDist(p, a, b));
  }
  return pos === 0 || neg === 0 ? inside : -outside;
}
