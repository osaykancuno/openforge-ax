// Ghost Hand (open dexterous hand class) missions. Lab model: each finger is one "curl" value 0–100 % driven by a
// tendon servo with a speed limit; contact is a curl window per finger, not a contact simulation.
import { DT, prng, clamp, approach, q, num, replay, standardScore, runPolicy, hold } from "./common.js";

export const FINGERS = ["index", "middle", "ring", "pinky", "thumb"];
const RATE = 250; // % per second
const UP = 20, DOWN = 70;

const POSES = {
  one: { name: "one", up: [0], label: "index up" },
  two: { name: "two", up: [0, 1], label: "index and middle up" },
  three: { name: "three", up: [0, 1, 2], label: "index, middle and ring up" },
};
/** A counting pose: listed fingers straight (≤ 20 %), every other finger and the thumb curled (≥ 70 %, thumb ≥ 60 %). */
function poseOk(c, pose) {
  return c.every((v, i) => (pose.up.includes(i) ? v <= UP : v >= (i === 4 ? 60 : DOWN)));
}

function init(level, seed) {
  const r = prng(seed * 23 + level.length);
  const s = { level, seed, t: 0, curl: [10, 10, 10, 10, 10], hold: 0, done: false, success: false, reason: null, progress: 0, metrics: {} };
  if (level === "power") {
    s.objectCm = +(4 + r() * 2).toFixed(1); // cylinder diameter
    s.contact = 85 - (s.objectCm - 4) * 8; // a fatter object stops the fingers earlier
  }
  if (level === "count") (s.seq = ["one", "two", "three"]), (s.k = 0);
  return s;
}

function step(s, a, dt = DT) {
  if (s.done) return s;
  const f = Array.isArray(a?.f) ? a.f : s.curl;
  for (let i = 0; i < 5; i++) {
    let target = num(f[i], 0, 100, s.curl[i]);
    if (s.level === "power" && i < 4) target = Math.min(target, s.contact); // the object blocks the finger
    if (s.level === "power" && i === 4) target = Math.min(target, s.contact - 10);
    s.curl[i] = approach(s.curl[i], target, RATE * dt);
  }
  s.t += dt;
  const c = s.curl;
  if (s.level === "pinch") {
    const ok = c[4] >= 55 && c[4] <= 80 && c[0] >= 45 && c[0] <= 70 && c[1] <= 25 && c[2] <= 25 && c[3] <= 25;
    s.progress = Math.max(s.progress, (c[4] >= 55 && c[4] <= 80 ? 0.4 : 0) + (c[0] >= 45 && c[0] <= 70 ? 0.4 : 0));
    s.hold = hold(s.hold, ok, dt);
    if (s.hold >= 1) finish(s, true, "pinched");
  } else if (s.level === "power") {
    const touching = c.map((v, i) => v >= (i === 4 ? s.contact - 10 : s.contact) - 0.5);
    s.metrics.touching = touching.filter(Boolean).length;
    s.progress = Math.max(s.progress, (s.metrics.touching / 5) * 0.9);
    s.hold = hold(s.hold, touching.every(Boolean), dt);
    if (s.hold >= 1.5) finish(s, true, "grasped");
  } else {
    const pose = POSES[s.seq[s.k]];
    s.hold = hold(s.hold, poseOk(c, pose), dt);
    s.progress = Math.max(s.progress, s.k / 3);
    if (s.hold >= 0.6) {
      s.k++;
      s.hold = 0;
      if (s.k >= 3) finish(s, true, "counted");
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

export const mission = {
  id: "hand",
  dt: DT,
  levels: [
    { id: "pinch", title: "Pinch", goal: "Meet thumb and index: thumb 55–80 %, index 45–70 %, the other three fingers open (≤ 25 %). Hold 1 s.", pass: 60, maxSteps: 30 * 30 },
    { id: "power", title: "Power grasp", goal: "Wrap all five digits around the cylinder until each one touches it, and hold for 1.5 s.", pass: 60, maxSteps: 30 * 30 },
    { id: "count", title: "Count to three", goal: "Show one, two, three in order (straight ≤ 20 %, curled ≥ 70 %, thumb tucked ≥ 60 %), each held 0.6 s.", pass: 60, maxSteps: 45 * 30 },
  ],
  controls: FINGERS.map((f, i) => ({ type: "slider", id: `c${i}`, label: `${f[0].toUpperCase()}${f.slice(1)} curl`, min: 0, max: 100, step: 1, unit: "%", keys: { dec: "qwert"[i], inc: "asdfg"[i] } })),
  uiDefaults: (s) => Object.fromEntries(s.curl.map((v, i) => [`c${i}`, Math.round(v)])),
  toAction: (ui) => ({ f: [0, 1, 2, 3, 4].map((i) => q(ui[`c${i}`] ?? 0, 1)) }),
  init,
  step,
  score(trace) {
    return standardScore(mission, trace, replay(mission, trace));
  },
  readout(s) {
    const c = s.curl.map((v, i) => `${FINGERS[i]} ${Math.round(v)} %`).join(", ");
    if (s.level === "power") return `${c} · ${s.metrics.touching ?? 0}/5 touching the ${s.objectCm} cm cylinder`;
    if (s.level === "count") return `${c} · next pose: ${s.seq[Math.min(s.k, 2)]} (${POSES[s.seq[Math.min(s.k, 2)]].label})`;
    return c;
  },
  solve(level, seed) {
    if (level === "pinch") return runPolicy(mission, level, seed, () => ({ f: [58, 5, 5, 5, 68] }));
    if (level === "power") return runPolicy(mission, level, seed, () => ({ f: [100, 100, 100, 100, 100] }));
    return runPolicy(mission, level, seed, (s) => {
      const up = POSES[s.seq[Math.min(s.k, 2)]].up;
      return { f: [0, 1, 2, 3, 4].map((i) => (up.includes(i) ? 0 : 95)) };
    });
  },
  idle: (s) => ({ f: s.curl.map((v) => q(v, 1)) }),
};
void clamp;
export default mission;
