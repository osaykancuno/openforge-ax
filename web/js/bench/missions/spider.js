// Spider Mech (open hexapod) missions: the tripod gait by hand. Legs 1-3-5 form tripod A and 2-4-6 tripod B.
// Lab model: one coxa "swing" angle drives tripod A (+) and tripod B (−); a grounded tripod that swings pushes the body,
// a lifted one moves freely. Both tripods down while swinging = feet scuff; both up = the body drops.
import { DT, RAD, prng, clamp, approach, q, num, replay, standardScore, runPolicy, hold } from "./common.js";

const REACH = 0.1; // effective lever from body to feet (m)
const SWING_MAX = 25;
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));

function init(level, seed) {
  const r = prng(seed * 41 + level.length);
  const s = { level, seed, t: 0, liftA: 0, liftB: 0, swing: 0, x: 0, z: 0, heading: 0, scuffs: 0, scuffing: false, hold: 0, done: false, success: false, reason: null, progress: 0, metrics: {} };
  s.goalZ = level === "step" ? 0.04 : 0.5;
  if (level === "rotate") s.goal = (r() < 0.5 ? 90 : -90) * RAD;
  return s;
}

function step(s, a, dt = DT) {
  if (s.done) return s;
  s.liftA = approach(s.liftA, a?.liftA ? 1 : 0, 6 * dt);
  s.liftB = approach(s.liftB, a?.liftB ? 1 : 0, 6 * dt);
  const prev = s.swing;
  s.swing = approach(s.swing, num(a?.swing, -SWING_MAX, SWING_MAX, s.swing), 150 * dt);
  const d = (s.swing - prev) * RAD;
  const downA = s.liftA < 0.5, downB = s.liftB < 0.5;
  if (!downA && !downB) return finish(s, false, "body_dropped");
  const moving = Math.abs(d) > 1e-9;
  const scuff = downA && downB && moving;
  if (scuff && !s.scuffing) s.scuffs++;
  s.scuffing = scuff;
  if (moving && !scuff) {
    // A grounded: its feet sweep back by +d, the body goes forward. B grounded: B's swing is −d, so the sign flips.
    const push = downA ? d : -d;
    if (s.level === "rotate") s.heading = wrap(s.heading + push * 0.6);
    else {
      s.x += Math.sin(s.heading) * push * REACH;
      s.z += Math.cos(s.heading) * push * REACH;
    }
  }
  s.t += dt;
  s.metrics.scuffs = s.scuffs;
  if (s.scuffs > 4) return finish(s, false, "feet_scuffing");
  const settled = downA && downB;
  if (s.level === "rotate") {
    const err = Math.abs(wrap(s.goal - s.heading)) / RAD;
    s.metrics.headingErr = Math.round(err);
    s.progress = Math.max(s.progress, clamp(1 - err / 90, 0, 1));
    s.hold = hold(s.hold, err < 8 && settled, dt);
    if (s.hold >= 0.5) finish(s, true, "rotated");
  } else {
    s.metrics.distanceCm = +(s.z * 100).toFixed(1);
    s.progress = Math.max(s.progress, clamp(s.z / s.goalZ, 0, 1));
    if (s.z >= s.goalZ && settled) finish(s, true, s.level === "step" ? "stepped" : "walked");
  }
  return s;
}

function finish(s, ok, reason) {
  s.done = true;
  s.success = ok;
  s.reason = reason;
  if (ok) s.progress = 1;
  return s;
}

export const mission = {
  id: "spider",
  dt: DT,
  levels: [
    { id: "step", title: "One tripod step", goal: "Lift one tripod, swing, put it down: move the body 4 cm forward without dropping it or scuffing more than 4 times.", pass: 60, maxSteps: 40 * 30 },
    { id: "walk", title: "Walk straight 50 cm", goal: "Repeat the tripod cycle: lift B, swing +, lower B, lift A, swing −, lower A …", pass: 60, maxSteps: 90 * 30 },
    { id: "rotate", title: "Rotate in place", goal: "Same cycle, but the swing turns the body: face the marked heading (±8°) with all six feet down.", pass: 60, maxSteps: 60 * 30 },
  ],
  controls: [
    { type: "toggle", id: "liftA", label: "Lift tripod A (legs 1·3·5)", key: "a" },
    { type: "toggle", id: "liftB", label: "Lift tripod B (legs 2·4·6)", key: "b" },
    { type: "slider", id: "swing", label: "Swing (A +, B −)", min: -SWING_MAX, max: SWING_MAX, step: 1, unit: "°", keys: { dec: "ArrowLeft", inc: "ArrowRight" }, keyStep: 5 },
  ],
  uiDefaults: () => ({ liftA: false, liftB: false, swing: 0 }),
  toAction: (ui) => ({ liftA: !!ui.liftA, liftB: !!ui.liftB, swing: q(ui.swing ?? 0, 1) }),
  init,
  step,
  score(trace) {
    return standardScore(mission, trace, replay(mission, trace));
  },
  readout(s) {
    const st = (v) => (v >= 0.5 ? "up" : "down");
    const out = [`Tripod A ${st(s.liftA)} · B ${st(s.liftB)}`, `swing ${Math.round(s.swing)}°`, `scuffs ${s.scuffs}`];
    if (s.level === "rotate") out.push(`heading ${Math.round(s.heading / RAD)}° (goal ${Math.round(s.goal / RAD)}°)`);
    else out.push(`${(s.z * 100).toFixed(1)} / ${s.goalZ * 100} cm`);
    return out.join(" · ");
  },
  solve(level, seed) {
    // phase machine: 0 lift B → 1 swing + → 2 lower B → 3 lift A → 4 swing − → 5 lower A → 0 …
    let ph = 0, tgt = null;
    return runPolicy(mission, level, seed, (s) => {
      if (level === "rotate" && Math.abs(wrap(s.goal - s.heading)) < 2 * RAD && (ph === 0 || ph === 3)) return { liftA: false, liftB: false, swing: s.swing };
      if (tgt === null && (ph === 1 || ph === 4)) {
        if (level === "rotate") {
          const err = wrap(s.goal - s.heading) / RAD / 0.6; // swing needed for the remaining turn
          tgt = clamp(ph === 1 ? s.swing + err : s.swing - err, -20, 20);
        } else tgt = ph === 1 ? 20 : -20;
        tgt = q(tgt, 1);
      }
      const want = { 0: [false, true], 1: [false, true], 2: [false, false], 3: [true, false], 4: [true, false], 5: [false, false] }[ph];
      const [la, lb] = want;
      const swing = ph === 1 || ph === 4 ? tgt : s.swing;
      const reached = (la ? s.liftA >= 1 : s.liftA <= 0) && (lb ? s.liftB >= 1 : s.liftB <= 0) && Math.abs(s.swing - swing) < 1e-6;
      if (reached) (ph = (ph + 1) % 6), (tgt = null);
      return { liftA: la, liftB: lb, swing };
    });
  },
  idle: () => ({ liftA: false, liftB: false, swing: 0 }),
};
export default mission;
