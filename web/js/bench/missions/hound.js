// Cyber Hound (Pupper-class quadruped) missions. Lab model, not dynamics: legs are two-link (thigh 8 cm, shin 8.5 cm),
// the trot is a kinematic gait (speed = stride × cadence) with a "stumble" meter for strides past the leg's reach
// or cadences past what the servos can follow. Ground frame: z forward, heading 0 = +z, positive heading = turn left.
import { DT, RAD, prng, clamp, approach, q, num, replay, standardScore, runPolicy, hold } from "./common.js";

const L1 = 0.08, L2 = 0.085;
const MAX_STRIDE = 0.08, MAX_FREQ = 3; // stable envelope of the lab model
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));

/** Leg geometry: thigh angle from vertical, knee bend (both degrees) → hip height and foot offset (m). */
export function leg(thigh, bend) {
  const a = thigh * RAD, b = (thigh - bend) * RAD;
  return { h: L1 * Math.cos(a) + L2 * Math.cos(b), x: L1 * Math.sin(a) + L2 * Math.sin(b) };
}

function init(level, seed) {
  const r = prng(seed * 17 + level.length);
  const lying = level === "stand";
  const s = {
    level, seed, t: 0, thigh: lying ? 80 : 35, bend: lying ? 150 : 70, mode: "stand", stride: 0, freq: 0, turn: 0,
    x: 0, z: 0, heading: 0, v: 0, w: 0, phase: 0, stumble: 0, hold: 0, done: false, success: false, reason: null, progress: 0, metrics: {},
  };
  if (level === "stand") s.thigh = 75 + r() * 10;
  if (level === "turn") s.goal = (r() < 0.5 ? 90 : -90) * RAD;
  s.height = Math.max(0.05, leg(s.thigh, s.bend).h);
  return s;
}

function step(s, a, dt = DT) {
  if (s.done) return s;
  if (s.level === "stand") {
    s.thigh = approach(s.thigh, num(a?.thigh, 0, 90, s.thigh), 180 * dt);
    s.bend = approach(s.bend, num(a?.bend, 0, 150, s.bend), 180 * dt);
    const g = leg(s.thigh, s.bend);
    s.height = Math.max(0.05, g.h);
    s.footX = g.x;
    s.t += dt;
    s.metrics.heightCm = +(s.height * 100).toFixed(1);
    s.metrics.footCm = +(g.x * 100).toFixed(1);
    const ok = s.height >= 0.13 && s.height <= 0.16 && Math.abs(g.x) < 0.025 && s.bend >= 20;
    s.progress = Math.max(s.progress, clamp((s.height - 0.05) / 0.08, 0, 1) * 0.8);
    s.hold = hold(s.hold, ok, dt);
    if (s.hold >= 1) finish(s, true, "standing");
    return s;
  }
  s.mode = a?.gait === "trot" ? "trot" : "stand";
  s.stride = num(a?.stride, 0, 0.12, 0);
  s.freq = num(a?.freq, 0, 4, 0);
  s.turn = s.level === "turn" ? num(a?.turn, -1, 1, 0) : 0;
  const trot = s.mode === "trot";
  const base = trot ? s.stride * s.freq : 0;
  s.v = approach(s.v, base * (1 - Math.abs(s.turn)), 0.6 * dt);
  s.w = approach(s.w, (trot ? (s.turn * s.stride * s.freq) / 0.15 : 0), 3 * dt);
  const unstable = trot && (s.stride > MAX_STRIDE + 1e-9 || s.freq > MAX_FREQ + 1e-9);
  s.stumble = clamp(s.stumble + (unstable ? dt * 1.2 : -dt * 0.5), 0, 1);
  if (s.stumble >= 1) return finish(s, false, "fell_over");
  if (trot) s.phase = (s.phase + s.freq * dt) % 1;
  s.heading = wrap(s.heading + s.w * dt);
  s.x += Math.sin(s.heading) * s.v * dt;
  s.z += Math.cos(s.heading) * s.v * dt;
  s.t += dt;
  s.metrics.distanceCm = Math.round(Math.hypot(s.x, s.z) * 100);
  if (s.level === "trot") {
    s.progress = Math.max(s.progress, clamp(s.z / 1, 0, 1));
    if (s.z >= 1) finish(s, true, "trotted_1m");
  } else {
    const err = Math.abs(wrap(s.goal - s.heading)) / RAD;
    s.metrics.headingErr = Math.round(err);
    const drift = Math.hypot(s.x, s.z);
    if (drift > 0.25) return finish(s, false, "drifted");
    s.progress = Math.max(s.progress, clamp(1 - err / 90, 0, 1));
    s.hold = hold(s.hold, err < 8 && s.mode === "stand" && Math.abs(s.w) < 0.05, dt);
    if (s.hold >= 0.5) finish(s, true, "turned");
  }
  return s;
}

/**
 * The next move toward a stand. The good poses are a narrow diagonal (knee bend ≈ twice the thigh angle), so the
 * readout names the slider: more bend brings the feet back under the hips, and thigh and bend move together (1 : 2)
 * to raise or lower the body without moving the feet.
 */
function standHint(s) {
  const x = s.footX ?? leg(s.thigh, s.bend).x, h = s.height;
  if (x >= 0.025) return "next: knee bend +";
  if (x <= -0.025) return "next: knee bend −";
  if (s.bend < 20) return "next: knee bend +";
  if (h < 0.13) return "next: thigh − and knee bend − together (about 1 : 2)";
  if (h > 0.16) return "next: thigh + and knee bend + together (about 1 : 2)";
  return "hold it";
}

function finish(s, ok, reason) {
  s.done = true;
  s.success = ok;
  s.reason = reason;
  if (ok) s.progress = 1;
  return s;
}

export const mission = {
  id: "hound",
  dt: DT,
  levels: [
    { id: "stand", title: "Stand up", goal: "From lying down, set thigh and knee so the body is 13–16 cm high with the feet under the hips (±2.5 cm) and the knees bent. Hold 1 s.", pass: 60, maxSteps: 40 * 30 },
    { id: "trot", title: "Trot 1 m", goal: "Switch to trot and pick a stride and cadence that carry the body 1 m forward without stumbling.", pass: 60, maxSteps: 40 * 30 },
    { id: "turn", title: "Turn on the spot", goal: "Trot with full turn to face the marked heading (±8°), stay within 25 cm of the start, then stand still.", pass: 60, maxSteps: 40 * 30 },
  ],
  controls: [
    { type: "slider", id: "thigh", levels: ["stand"], label: "Thigh angle", min: 0, max: 90, step: 1, unit: "°" },
    { type: "slider", id: "bend", levels: ["stand"], label: "Knee bend", min: 0, max: 150, step: 1, unit: "°" },
    { type: "toggle", id: "trot", levels: ["trot", "turn"], label: "Trot", key: "t" },
    { type: "slider", id: "stride", levels: ["trot", "turn"], label: "Stride", min: 0, max: 12, step: 0.5, unit: "cm", value: 4 },
    { type: "slider", id: "freq", levels: ["trot", "turn"], label: "Cadence", min: 0, max: 4, step: 0.1, unit: "Hz", value: 1.5 },
    { type: "slider", id: "turn", levels: ["turn"], label: "Turn (− right · + left)", min: -1, max: 1, step: 0.05, unit: "", value: 0 },
  ],
  uiDefaults: (s) => ({ thigh: Math.round(s.thigh), bend: Math.round(s.bend), stride: 4, freq: 1.5, turn: 0, trot: false }),
  toAction(ui) {
    return { thigh: q(ui.thigh ?? 0, 1), bend: q(ui.bend ?? 0, 1), gait: ui.trot ? "trot" : "stand", stride: q((ui.stride ?? 0) / 100), freq: q(ui.freq ?? 0, 2), turn: q(ui.turn ?? 0, 2) };
  },
  init,
  step,
  score(trace) {
    return standardScore(mission, trace, replay(mission, trace));
  },
  readout(s) {
    if (s.level === "stand") return `Body height ${(s.height * 100).toFixed(1)} cm · feet ${s.metrics.footCm ?? 0} cm from under the hips · knee bend ${Math.round(s.bend)}° · ${standHint(s)}`;
    const out = [`${s.mode === "trot" ? "Trotting" : "Standing"}`, `speed ${(s.v * 100).toFixed(0)} cm/s`, `stumble ${Math.round(s.stumble * 100)} %`];
    if (s.level === "trot") out.push(`${Math.max(0, Math.round(s.z * 100))} / 100 cm`);
    else out.push(`heading ${Math.round(s.heading / RAD)}° (goal ${Math.round(s.goal / RAD)}°)`, `drift ${s.metrics.distanceCm ?? 0} cm`);
    return out.join(" · ");
  },
  solve(level, seed) {
    if (level === "stand") return runPolicy(mission, level, seed, () => ({ thigh: 35, bend: 70, gait: "stand", stride: 0, freq: 0, turn: 0 }));
    if (level === "trot") return runPolicy(mission, level, seed, () => ({ thigh: 35, bend: 70, gait: "trot", stride: 0.07, freq: 2.5, turn: 0 }));
    return runPolicy(mission, level, seed, (s) => {
      const e = wrap(s.goal - s.heading);
      const go = Math.abs(e) > 6 * RAD;
      return { thigh: 35, bend: 70, gait: go ? "trot" : "stand", stride: 0.06, freq: 1.5, turn: go ? (e > 0 ? 1 : -1) : 0 };
    });
  },
  idle: (s) => ({ thigh: q(s.thigh, 1), bend: q(s.bend, 1), gait: "stand", stride: 0, freq: 0, turn: 0 }),
};
export default mission;
