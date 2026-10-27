// AX-1 Desk missions: a desk companion that looks, waves and points. Lab model: joint angles slew at 120°/s;
// the gaze is torso yaw + head pan (azimuth) and head tilt (elevation); the right arm points along its forearm.
import { DT, RAD, prng, clamp, approach, q, num, replay, standardScore, runPolicy, hold } from "./common.js";

const SLEW = 120;
const J = { torso: [-120, 120], pan: [-100, 100], tilt: [-25, 35], rsh: [0, 170], rel: [0, 120], lsh: [0, 170], lel: [0, 120] };
const KEYS = Object.keys(J);

const unit = (az, el) => ({ x: Math.cos(el * RAD) * Math.sin(az * RAD), y: Math.sin(el * RAD), z: Math.cos(el * RAD) * Math.cos(az * RAD) });
export const angleBetween = (a, b) => {
  const u = unit(a.az, a.el), v = unit(b.az, b.el);
  return Math.acos(clamp(u.x * v.x + u.y * v.y + u.z * v.z, -1, 1)) / RAD;
};
export const gazeOf = (j) => ({ az: j.torso + j.pan, el: j.tilt });
/** Right forearm direction: upper arm elevation = raise − 90°, the elbow bend lifts the forearm further. */
export function pointOf(j) {
  let el = j.rsh - 90 + j.rel;
  let az = j.torso;
  if (el > 90) (el = 180 - el), (az += 180);
  return { az, el };
}

function init(level, seed) {
  const r = prng(seed * 71 + level.length);
  const s = { level, seed, t: 0, j: { torso: 0, pan: 0, tilt: 0, rsh: 0, rel: 20, lsh: 0, lel: 20 }, hold: 0, done: false, success: false, reason: null, progress: 0, metrics: {} };
  if (level === "look") s.target = { az: Math.round(-80 + r() * 160), el: Math.round(-10 + r() * 35) };
  if (level === "wave") (s.swings = 0), (s.elbowSide = "low");
  if (level === "point") {
    const azs = [-70, 0, 70].map((a) => a + Math.round((r() - 0.5) * 30));
    // a seeded order of the three objects
    const order = [0, 1, 2];
    for (let i = 2; i > 0; i--) {
      const k = Math.floor(r() * (i + 1));
      [order[i], order[k]] = [order[k], order[i]];
    }
    s.objects = azs.map((az, i) => ({ id: i, az, el: -15 + Math.round(r() * 15) }));
    s.order = order;
    s.k = 0;
  }
  s.start = gazeOf(s.j);
  return s;
}

function step(s, a, dt = DT) {
  if (s.done) return s;
  for (const k of KEYS) s.j[k] = approach(s.j[k], num(a?.[k], J[k][0], J[k][1], s.j[k]), SLEW * dt);
  s.t += dt;
  if (s.level === "look") {
    const e = angleBetween(gazeOf(s.j), s.target);
    s.metrics.gazeErr = Math.round(e);
    s.progress = Math.max(s.progress, clamp(1 - e / 90, 0, 1) * 0.9);
    s.hold = hold(s.hold, e < 5, dt);
    if (s.hold >= 1) finish(s, true, "looking");
  } else if (s.level === "wave") {
    const raised = s.j.rsh >= 120;
    if (raised) {
      if (s.elbowSide === "low" && s.j.rel >= 60) (s.elbowSide = "high"), s.swings++;
      else if (s.elbowSide === "high" && s.j.rel <= 20) (s.elbowSide = "low"), s.swings++;
    }
    s.metrics.swings = s.swings;
    s.progress = Math.max(s.progress, (raised ? 0.3 : clamp(s.j.rsh / 120, 0, 1) * 0.3) + clamp(s.swings / 4, 0, 1) * 0.6);
    if (s.swings >= 4) finish(s, true, "waved");
  } else {
    const obj = s.objects[s.order[s.k]];
    const e = angleBetween(pointOf(s.j), obj);
    s.metrics.pointErr = Math.round(e);
    s.hold = hold(s.hold, e < 8 && s.j.rel <= 30, dt);
    s.progress = Math.max(s.progress, s.k / 3);
    if (s.hold >= 0.7) {
      s.k++;
      s.hold = 0;
      if (s.k >= 3) finish(s, true, "pointed");
    }
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

const LABELS = { torso: "Torso yaw", pan: "Head pan", tilt: "Head tilt (+ up)", rsh: "Right shoulder raise", rel: "Right elbow bend", lsh: "Left shoulder raise", lel: "Left elbow bend" };
export const mission = {
  id: "ax1-desk",
  dt: DT,
  levels: [
    { id: "look", title: "Look at the target", goal: "Turn torso and head so the phone's camera points at the marker (within 5°) for 1 s.", pass: 60, maxSteps: 30 * 30 },
    { id: "wave", title: "Wave", goal: "Raise the right arm above 120° and swing the elbow between ≤ 20° and ≥ 60°: four swings.", pass: 60, maxSteps: 30 * 30 },
    { id: "point", title: "Point at three objects", goal: "Point the right forearm (elbow ≤ 30°) at the objects in the numbered order, within 8°, holding 0.7 s each.", pass: 60, maxSteps: 60 * 30 },
  ],
  controls: KEYS.map((k) => ({ type: "slider", id: k, label: LABELS[k], min: J[k][0], max: J[k][1], step: 1, unit: "°" })),
  uiDefaults: (s) => ({ ...s.j }),
  toAction: (ui) => Object.fromEntries(KEYS.map((k) => [k, q(ui[k] ?? 0, 1)])),
  init,
  step,
  score(trace) {
    return standardScore(mission, trace, replay(mission, trace));
  },
  readout(s) {
    const g = gazeOf(s.j), p = pointOf(s.j);
    const out = [`Gaze ${Math.round(g.az)}° / ${Math.round(g.el)}°`, `arm points ${Math.round(p.az)}° / ${Math.round(p.el)}°`];
    if (s.level === "look") out.push(`target ${s.target.az}° / ${s.target.el}°, off by ${s.metrics.gazeErr ?? "–"}°`);
    if (s.level === "wave") out.push(`swings ${s.swings}/4`);
    if (s.level === "point") out.push(`next: object ${Math.min(s.k, 2) + 1} of 3 (${s.objects[s.order[Math.min(s.k, 2)]].az}°), off by ${s.metrics.pointErr ?? "–"}°`);
    return out.join(" · ");
  },
  solve(level, seed) {
    const s0 = init(level, seed);
    if (level === "look") {
      const torso = clamp(s0.target.az, -120, 120) / 2;
      const goal = { ...s0.j, torso, pan: s0.target.az - torso, tilt: s0.target.el };
      return runPolicy(mission, level, seed, () => goal);
    }
    if (level === "wave") {
      let up = true;
      return runPolicy(mission, level, seed, (s) => {
        if (s.j.rsh >= 140) {
          if (up && s.j.rel >= 70) up = false;
          else if (!up && s.j.rel <= 10) up = true;
        }
        return { ...s0.j, rsh: 150, rel: s.j.rsh >= 140 ? (up ? 80 : 0) : 20 };
      });
    }
    return runPolicy(mission, level, seed, (s) => {
      const o = s.objects[s.order[Math.min(s.k, 2)]];
      return { ...s0.j, torso: o.az, pan: 0, rsh: o.el + 90, rel: 0 };
    });
  },
  idle: (s) => ({ ...s.j }),
};
export default mission;
