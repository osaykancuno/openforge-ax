// Biped balance missions (Replicant small humanoid, AX-1 Walker). Quasi-static lab model: rigid links with point
// masses, joints slew at 90°/s, and the robot falls when its centre of mass (COM) stays outside the support polygon
// (the foot or feet on the ground) for more than FALL_S. No dynamics, no walking: this is the balance lesson only.
import { DT, RAD, prng, clamp, approach, q, num, replay, standardScore, runPolicy, hold } from "./common.js";

const SLEW = 90; // deg/s
// time the COM may spend outside the feet before the robot falls: long enough for a person moving one slider at a
// time to see the warning and correct with another (a squat needs a dozen alternating moves of ~10°)
const FALL_S = 0.8;

/** Geometry → pose → COM and support polygon. Units m, deg. x forward, lat toward the right foot, y up. */
export function solveBody(g, p) {
  const a = p.ankle * RAD, k = p.knee * RAD, lean = p.lean * RAD, sh = p.shift * RAD, lift = p.lift * RAD;
  const phT = a - k; // thigh angle from vertical (knee→hip)
  const hip = { x: g.shank * Math.sin(a) + g.thigh * Math.sin(phT), y: g.shank * Math.cos(a) + g.thigh * Math.cos(phT) };
  const phTorso = phT + lean;
  const latP = hip.y * Math.sin(sh); // the legs lean sideways together (ankle roll + hip roll), the pelvis moves over
  const pts = [];
  const add = (m, x, y, lat) => pts.push({ m, x, y, lat });
  // stance-shaped right leg
  add(g.mShank, (g.shank / 2) * Math.sin(a), (g.shank / 2) * Math.cos(a), g.hw + latP * 0.25);
  add(g.mThigh, g.shank * Math.sin(a) + (g.thigh / 2) * Math.sin(phT), g.shank * Math.cos(a) + (g.thigh / 2) * Math.cos(phT), g.hw + latP * 0.75);
  // left leg: same as the right one, plus the lift (hip flexion swings the knee forward, the knee folds more)
  const phTl = phT - lift, phSl = phTl + k + 1.5 * lift;
  const kneeL = { x: hip.x - g.thigh * Math.sin(phTl), y: hip.y - g.thigh * Math.cos(phTl) };
  const footL = { x: kneeL.x - g.shank * Math.sin(phSl), y: kneeL.y - g.shank * Math.cos(phSl) };
  add(g.mThigh, (hip.x + kneeL.x) / 2, (hip.y + kneeL.y) / 2, -g.hw + latP * 0.75);
  add(g.mShank, (kneeL.x + footL.x) / 2, (kneeL.y + footL.y) / 2, -g.hw + latP * (footL.y > 0.005 ? 1 : 0.25));
  add(g.mPelvis, hip.x, hip.y, latP);
  add(g.mTorso, hip.x + g.torso * Math.sin(phTorso), hip.y + g.torso * Math.cos(phTorso), latP);
  if (g.mArm) {
    const sx = hip.x + g.shoulder * Math.sin(phTorso), sy = hip.y + g.shoulder * Math.cos(phTorso);
    const ang = phTorso + Math.PI - p.arms * RAD;
    add(g.mArm * 2, sx + (g.arm / 2) * Math.sin(ang), sy + (g.arm / 2) * Math.cos(ang), latP);
  }
  const M = pts.reduce((s, o) => s + o.m, 0);
  const com = { x: pts.reduce((s, o) => s + o.m * o.x, 0) / M, y: pts.reduce((s, o) => s + o.m * o.y, 0) / M, lat: pts.reduce((s, o) => s + o.m * o.lat, 0) / M };
  const lifted = footL.y > 0.005;
  // support: rectangle(s) under the planted foot/feet
  const lo = lifted ? g.hw - g.footW / 2 : -g.hw - g.footW / 2, hi = g.hw + g.footW / 2;
  const support = { x0: -g.heel, x1: g.toe, lat0: lo, lat1: hi };
  const margin = Math.min(com.x - support.x0, support.x1 - com.x, com.lat - support.lat0, support.lat1 - com.lat);
  return { hip, com, footLift: Math.max(0, footL.y), lifted, support, margin, torsoDeg: phTorso / RAD, stand: g.shank + g.thigh };
}

export function makeBipedMission({ id, geometry, name = "robot", arms = false }) {
  const g = geometry;
  const KEYS = ["ankle", "knee", "lean", "shift", "lift", "arms"];
  const RANGE = { ankle: [-30, 45], knee: [0, 120], lean: [-20, 110], shift: [-15, 15], lift: [0, 60], arms: [0, 170] };

  function init(level, seed) {
    const r = prng(seed * 61 + level.length);
    const s = { level, seed, t: 0, pose: { ankle: 0, knee: 0, lean: 0, shift: 0, lift: 0, arms: 0 }, out: 0, hold: 0, done: false, success: false, reason: null, progress: 0, metrics: {} };
    // a small seeded starting stance, so every layout starts a little differently
    s.pose.knee = Math.round(r() * 10);
    s.pose.ankle = Math.round(s.pose.knee / 2);
    s.body = solveBody(g, s.pose);
    return s;
  }

  function step(s, a, dt = DT) {
    if (s.done) return s;
    for (const k of KEYS) {
      if (k === "arms" && !arms) continue;
      s.pose[k] = approach(s.pose[k], num(a?.[k], RANGE[k][0], RANGE[k][1], s.pose[k]), SLEW * dt);
    }
    const b = (s.body = solveBody(g, s.pose));
    s.t += dt;
    s.out = b.margin < 0 ? s.out + dt : 0;
    s.metrics.marginMm = Math.round(b.margin * 1000);
    if (s.out > FALL_S) return finish(s, false, "fell_over");
    const len = b.support.x1 - b.support.x0;
    if (s.level === "lean") {
      const front = (b.com.x - b.support.x0) / len; // 0 = heel, 1 = toe
      s.metrics.comPct = Math.floor(front * 100); // shown rounded toward "not yet": 70 % on screen always passes
      s.progress = Math.max(s.progress, clamp((front - 0.35) / 0.35, 0, 1) * 0.9);
      s.hold = hold(s.hold, front >= 0.7 && b.margin > 0 && !b.lifted, dt);
      if (s.hold >= 1.5) finish(s, true, "leaning");
    } else if (s.level === "squat") {
      const ratio = b.hip.y / b.stand;
      s.metrics.hipPct = Math.ceil(ratio * 100);
      s.progress = Math.max(s.progress, clamp((1 - ratio) / 0.3, 0, 1) * 0.9);
      s.hold = hold(s.hold, ratio <= 0.7 && b.margin > 0 && !b.lifted, dt);
      if (s.hold >= 1) finish(s, true, "squatting");
    } else {
      s.metrics.liftCm = Math.floor(b.footLift * 1000) / 10;
      s.progress = Math.max(s.progress, clamp(b.footLift / 0.03, 0, 1) * 0.6 + clamp(s.pose.shift / 10, 0, 1) * 0.3);
      s.hold = hold(s.hold, b.footLift >= 0.03 && b.margin > 0, dt);
      if (s.hold >= 2) finish(s, true, "one_foot");
    }
    return s;
  }

  /** The way back over the feet: the side the COM left by, and the slider that moves it back (one with room left). */
  function tipHint(b, p) {
    const { com, support: sp } = b;
    if (com.x < sp.x0) return p.ankle < RANGE.ankle[1] - 2 ? "backward: ankle + (or hip pitch +)" : "backward: hip pitch +";
    if (com.x > sp.x1) return p.ankle > RANGE.ankle[0] + 2 ? "forward: ankle − (or hip pitch −)" : "forward: hip pitch −";
    return com.lat > sp.lat1 ? "right: weight shift −" : b.lifted ? "left: weight shift + or lower the left foot" : "left: weight shift +";
  }

  function finish(s, ok, reason) {
    s.done = true;
    s.success = ok;
    s.reason = reason;
    if (ok) s.progress = 1;
    return s;
  }

  const controls = [
    { type: "slider", id: "ankle", label: "Ankle pitch (lean the shins)", min: RANGE.ankle[0], max: RANGE.ankle[1], step: 1, unit: "°" },
    { type: "slider", id: "knee", label: "Knee bend", min: RANGE.knee[0], max: RANGE.knee[1], step: 1, unit: "°" },
    { type: "slider", id: "lean", label: "Hip pitch (lean the torso)", min: RANGE.lean[0], max: RANGE.lean[1], step: 1, unit: "°" },
    { type: "slider", id: "shift", label: "Weight shift (→ right foot)", min: RANGE.shift[0], max: RANGE.shift[1], step: 0.5, unit: "°" },
    { type: "slider", id: "lift", label: "Lift left foot", min: RANGE.lift[0], max: RANGE.lift[1], step: 1, unit: "°" },
  ];
  if (arms) controls.push({ type: "slider", id: "arms", label: "Raise arms", min: 0, max: 170, step: 1, unit: "°" });

  const mission = {
    id,
    dt: DT,
    kind: "biped",
    geometry: g,
    levels: [
      { id: "lean", title: "Balance on the edge", goal: "Move the centre of mass into the front 30 % of the feet (but not past the toes) and hold 1.5 s. Posing moves the COM: watch the dot.", pass: 60, maxSteps: 40 * 30 },
      { id: "squat", title: "Squat", goal: "Lower the hips to 70 % of standing height and hold 1 s, without the COM leaving the feet.", pass: 60, maxSteps: 45 * 30 },
      { id: "shift", title: "Stand on one foot", goal: "Shift your weight over the right foot, then lift the left foot 3 cm and hold 2 s.", pass: 60, maxSteps: 45 * 30 },
    ],
    controls,
    uiDefaults: (s) => ({ ...s.pose }),
    toAction: (ui) => Object.fromEntries(KEYS.filter((k) => arms || k !== "arms").map((k) => [k, q(ui[k] ?? 0, 1)])),
    init,
    step,
    score(trace) {
      return standardScore(mission, trace, replay(mission, trace));
    },
    readout(s) {
      const b = s.body;
      const out = [`COM ${Math.round(b.com.x * 1000)} mm forward, ${Math.round(b.com.lat * 1000)} mm right`, `${b.margin >= 0 ? "inside" : "OUTSIDE"} the support by ${Math.abs(Math.round(b.margin * 1000))} mm`, b.lifted ? "on the right foot" : "on both feet"];
      if (s.level === "lean") out.push(`COM at ${s.metrics.comPct ?? 0} % of the foot length (goal ≥ 70 %)`);
      if (s.level === "squat") out.push(`hips at ${s.metrics.hipPct ?? 100} % of standing height (goal ≤ 70 %)`);
      if (s.level === "shift") out.push(`left foot ${s.metrics.liftCm ?? 0} cm up (goal ≥ 3)`);
      if (b.margin < 0) out.unshift(`TIPPING ${tipHint(b, s.pose)}`); // which slider brings it back, first
      return out.join(" · ");
    },
    solve(level, seed) {
      // search a goal pose whose straight-line path from the start stays balanced, then blend toward it
      const start = init(level, seed).pose;
      const goal = findPose(level, start);
      const legs = level === "shift" ? [{ ...goal, lift: 0 }, goal] : [goal];
      let k = 0, from = { ...start }, u = 0;
      return runPolicy(mission, level, seed, () => {
        const to = legs[k];
        const span = Math.max(...KEYS.map((key) => Math.abs((to[key] ?? 0) - (from[key] ?? 0))), 1e-9);
        u = Math.min(1, u + (SLEW * 0.8 * DT) / span);
        const cmd = Object.fromEntries(KEYS.filter((key) => arms || key !== "arms").map((key) => [key, q((from[key] ?? 0) + ((to[key] ?? 0) - (from[key] ?? 0)) * u, 3)]));
        if (u >= 1 && k < legs.length - 1) (from = { ...to }), (k++), (u = 0);
        return cmd;
      });
    },
    idle: (s) => mission.toAction(s.pose),
  };

  /** Grid search for a pose that meets the level goal with a safety margin (deterministic). */
  function findPose(level, start) {
    const safe = (a, b) => {
      for (let i = 0; i <= 20; i++) {
        const p = Object.fromEntries(KEYS.map((key) => [key, (a[key] ?? 0) + ((b[key] ?? 0) - (a[key] ?? 0)) * (i / 20)]));
        if (solveBody(g, p).margin < 0.003) return false;
      }
      return true;
    };
    let best = null;
    for (let ankle = -20; ankle <= 40; ankle += 5)
      for (let knee = 0; knee <= 110; knee += 10)
        for (let lean = 0; lean <= 90; lean += 10) {
          const p = { ankle, knee, lean, shift: level === "shift" ? 12 : 0, lift: level === "shift" ? 50 : 0, arms: 0 };
          const b = solveBody(g, p);
          if (b.margin < 0.004) continue;
          const len = b.support.x1 - b.support.x0;
          const ok = level === "lean" ? (b.com.x - b.support.x0) / len >= 0.74 : level === "squat" ? b.hip.y / b.stand <= 0.66 : b.footLift >= 0.033;
          if (!ok) continue;
          const mid = level === "shift" ? { ...p, lift: 0 } : p;
          if (!safe(start, mid) || !safe(mid, p)) continue;
          if (!best || Math.abs(ankle) + knee + lean < Math.abs(best.ankle) + best.knee + best.lean) best = p;
        }
    if (!best) throw new Error(`${id}: no balanced pose for ${level}`);
    return best;
  }
  void name;
  return mission;
}
