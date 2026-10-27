// Sky Drone (ESP-Drone / Crazyflie class) missions. Lab model of a ~35 g quad: four motors with a short lag, thrust linear in
// throttle, an inner attitude loop that holds the tilt you ask for (with tilt compensation), linear drag, no wind.
// Yaw comes only from the CW/CCW speed difference: CW props push the body CCW and vice versa; total thrust is unchanged.
import { DT, RAD, prng, clamp, q, num, replay, standardScore, runPolicy, hold } from "./common.js";

const G = 9.81;
const MASS = 0.035; // kg, nominal
const K_T = (MASS * G) / (4 * 0.5); // N per motor at u = 1 (nominal hover at 50 %)
const MIX = 0.15; // yaw authority (throttle fraction)
const K_YAW = 10.5, D_YAW = 3;
const TILT = 20 * RAD;
const RING_R = 0.25, BODY_R = 0.06;
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));

function init(level, seed) {
  const r = prng(seed * 31 + level.length * 7);
  const payload = level === "hover" ? r() * 0.005 : 0; // 0–5 g of payload changes the hover throttle
  const air = level !== "hover";
  const s = {
    level, seed, t: 0, mass: MASS + payload,
    x: 0, y: air ? 1 : 0, z: 0, vx: 0, vy: 0, vz: 0, yaw: 0, yawRate: 0, pitch: 0, roll: 0,
    u: [0, 0, 0, 0], // motors: 0 front-left CW, 1 front-right CCW, 2 back-right CW, 3 back-left CCW
    hold: 0, done: false, success: false, reason: null, progress: 0, metrics: {},
  };
  s.hoverThr = (s.mass * G) / (4 * K_T);
  if (air) s.u = s.u.map(() => s.hoverThr);
  if (level === "yaw") s.goalYaw = (r() < 0.5 ? 90 : -90) * RAD;
  if (level === "ring") {
    const a = (-60 + r() * 120) * RAD;
    const d = 1.5 + r() * 1;
    s.ring = { x: Math.sin(a) * d, y: 0.8 + r() * 0.7, z: Math.cos(a) * d, nx: Math.sin(a), nz: Math.cos(a), r: RING_R };
    s.d0 = Math.hypot(s.ring.x, s.ring.y - 1, s.ring.z);
  }
  return s;
}

function step(s, action, dt = DT) {
  if (s.done) return s;
  const thr = num(action?.thr, 0, 1, 0);
  const yawIn = num(action?.yaw, -1, 1, 0);
  const pIn = num(action?.pitch, -1, 1, 0);
  const rIn = num(action?.roll, -1, 1, 0);
  // inner attitude loop (first order), then tilt compensation of the collective
  const k = 1 - Math.exp(-dt / 0.12);
  s.pitch += (pIn * TILT - s.pitch) * k;
  s.roll += (rIn * TILT - s.roll) * k;
  const cosT = Math.cos(s.pitch) * Math.cos(s.roll);
  const coll = clamp(thr / Math.max(0.8, cosT), 0, 1);
  const cmd = [coll + yawIn * MIX, coll - yawIn * MIX, coll + yawIn * MIX, coll - yawIn * MIX].map((v) => clamp(v, 0, 1));
  const km = 1 - Math.exp(-dt / 0.04);
  for (let i = 0; i < 4; i++) s.u[i] += (cmd[i] - s.u[i]) * km;
  const T = K_T * (s.u[0] + s.u[1] + s.u[2] + s.u[3]);
  const cw = s.u[0] + s.u[2], ccw = s.u[1] + s.u[3];

  s.yawRate += (K_YAW * (cw - ccw) - D_YAW * s.yawRate) * dt;
  s.yaw = wrap(s.yaw + s.yawRate * dt);
  const ay = (T * cosT) / s.mass - G - 0.6 * s.vy;
  // horizontal: tilt → acceleration in the body frame (pitch forward, roll right), then drag
  const fwd = G * Math.tan(s.pitch), right = G * Math.tan(s.roll);
  const ax = Math.sin(s.yaw) * fwd - Math.cos(s.yaw) * right - 0.8 * s.vx;
  const az = Math.cos(s.yaw) * fwd + Math.sin(s.yaw) * right - 0.8 * s.vz;
  const prev = { x: s.x, y: s.y, z: s.z };
  s.vx += ax * dt;
  s.vy += ay * dt;
  s.vz += az * dt;
  s.x += s.vx * dt;
  s.y += s.vy * dt;
  s.z += s.vz * dt;
  if (s.y <= 0) {
    if (s.vy < -1.6) return finish(s, false, "hard_landing");
    s.y = 0;
    s.vy = Math.max(0, s.vy);
    s.vx *= 0.5;
    s.vz *= 0.5;
    s.yawRate *= 0.5;
  }
  s.t += dt;
  s.metrics.altitude = +s.y.toFixed(2);
  s.metrics.cwVsCcw = +(cw - ccw).toFixed(3);
  if (s.y > 4 || Math.hypot(s.x, s.z) > 5) return finish(s, false, "flew_away");

  if (s.level === "hover") {
    s.progress = Math.max(s.progress, clamp(1 - Math.abs(s.y - 1), 0, 1) * 0.7 + clamp(s.hold / 3, 0, 1) * 0.3);
    s.hold = hold(s.hold, Math.abs(s.y - 1) < 0.1 && Math.abs(s.vy) < 0.15, dt);
    if (s.hold >= 3) finish(s, true, "hovering");
  } else if (s.level === "yaw") {
    const err = Math.abs(wrap(s.goalYaw - s.yaw)) / RAD;
    s.metrics.yawErr = Math.round(err);
    s.progress = Math.max(s.progress, clamp(1 - err / 90, 0, 1));
    if (s.y < 0.2) return finish(s, false, "lost_altitude");
    s.hold = hold(s.hold, err < 5 && Math.abs(s.yawRate) < 10 * RAD && s.y > 0.5 && s.y < 1.6, dt);
    if (s.hold >= 1) finish(s, true, "turned");
  } else {
    const g = s.ring;
    const side = (p) => (p.x - g.x) * g.nx + (p.z - g.z) * g.nz;
    const d = Math.hypot(s.x - g.x, s.y - g.y, s.z - g.z);
    s.metrics.ringCm = Math.round(d * 100);
    s.progress = Math.max(s.progress, clamp(1 - d / s.d0, 0, 1) * 0.9);
    // distance from the ring's tube: radial distance in the ring plane vs its radius
    const radial = Math.hypot((s.x - g.x) * g.nz - (s.z - g.z) * g.nx, s.y - g.y);
    if (Math.abs(side(s)) < BODY_R && Math.abs(radial - g.r) < BODY_R) return finish(s, false, "hit_the_ring");
    const a = side(prev), b = side(s);
    if (a < 0 && b >= 0) {
      const k2 = a / (a - b);
      const px = prev.x + (s.x - prev.x) * k2, py = prev.y + (s.y - prev.y) * k2, pz = prev.z + (s.z - prev.z) * k2;
      const rr = Math.hypot((px - g.x) * g.nz - (pz - g.z) * g.nx, py - g.y);
      if (rr < g.r - BODY_R) finish(s, true, "through_the_ring");
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
  id: "drone",
  dt: DT,
  levels: [
    { id: "hover", title: "Hover at 1 m", goal: "Find the throttle where thrust equals weight: hold 1.0 m (±10 cm) for 3 seconds. The payload differs per layout.", pass: 60, maxSteps: 45 * 30 },
    { id: "yaw", title: "Yaw 90°", goal: "Turn to the marked heading (±5°) using only the CW/CCW speed difference, and stay in the air.", pass: 60, maxSteps: 40 * 30 },
    { id: "ring", title: "Fly through the ring", goal: "Turn, tilt and climb so the drone passes through the ring from the near side.", pass: 60, maxSteps: 60 * 30 },
  ],
  // Hover teaches the raw throttle. Yaw and ring fly with altitude hold, like most camera drones: the slider asks for a
  // climb speed and the flight controller sets the throttle (raw throttle there sent people to the ceiling in 2 s).
  controls: [
    { type: "slider", id: "thr", levels: ["hover"], label: "Throttle", min: 0, max: 100, step: 0.5, unit: "%", keys: { dec: "s", inc: "w" } },
    { type: "slider", id: "climb", levels: ["yaw", "ring"], label: "Climb speed (altitude hold)", min: -0.6, max: 0.6, step: 0.05, unit: "m/s", value: 0, keys: { dec: "s", inc: "w" }, keyStep: 0.1 },
    { type: "pad", id: "stick", label: "Stick", buttons: [
      { id: "yawL", label: "Yaw left", key: "q" }, { id: "fwd", label: "Forward", key: "ArrowUp" }, { id: "yawR", label: "Yaw right", key: "e" },
      { id: "left", label: "Left", key: "ArrowLeft" }, { id: "back", label: "Back", key: "ArrowDown" }, { id: "right", label: "Right", key: "ArrowRight" },
    ] },
  ],
  uiDefaults: (s) => (s.level === "hover" ? { thr: 0 } : { climb: 0 }),
  toAction(ui, s) {
    const h = ui.held || {};
    // altitude hold: a speed loop around the hover throttle (the recorded action is still a plain throttle)
    const held = s && s.level !== "hover" ? clamp(s.hoverThr + 0.3 * ((ui.climb ?? 0) - s.vy), 0, 1) : null;
    return {
      thr: q(held ?? (ui.thr ?? 0) / 100),
      yaw: (h.yawL ? 1 : 0) - (h.yawR ? 1 : 0),
      pitch: q(((h.fwd ? 1 : 0) - (h.back ? 1 : 0)) * 0.6),
      roll: q(((h.right ? 1 : 0) - (h.left ? 1 : 0)) * 0.6),
    };
  },
  init,
  step,
  score(trace) {
    return standardScore(mission, trace, replay(mission, trace));
  },
  readout(s) {
    const cw = (s.u[0] + s.u[2]) * 50, ccw = (s.u[1] + s.u[3]) * 50;
    const out = [`Altitude ${s.y.toFixed(2)} m`, `climb ${s.vy.toFixed(2)} m/s`, `CW props ${cw.toFixed(0)} % · CCW props ${ccw.toFixed(0)} %`, `heading ${Math.round(s.yaw / RAD)}°`];
    if (s.level === "yaw") out.push(`goal ${Math.round(s.goalYaw / RAD)}°`);
    if (s.level === "ring") out.push(`ring ${s.metrics.ringCm ?? "–"} cm away`);
    return out.join(" · ");
  },
  solve(level, seed) {
    const s0 = init(level, seed);
    const altHold = (s, target) => clamp(s.hoverThr + 0.25 * (target - s.y) - 0.2 * s.vy, 0, 1);
    return runPolicy(mission, level, seed, (s) => {
      if (level === "hover") return { thr: q(altHold(s, 1)), yaw: 0, pitch: 0, roll: 0 };
      if (level === "yaw") {
        const e = wrap(s.goalYaw - s.yaw);
        return { thr: q(altHold(s, 1)), yaw: q(clamp(1.5 * e - 0.6 * s.yawRate, -1, 1)), pitch: 0, roll: 0 };
      }
      const g = s0.ring;
      const want = Math.atan2(g.x - s.x, g.z - s.z);
      const e = wrap(want - s.yaw);
      const facing = Math.abs(e) < 8 * RAD && Math.abs(s.y - g.y) < 0.1;
      return { thr: q(altHold(s, g.y)), yaw: q(clamp(1.5 * e - 0.6 * s.yawRate, -1, 1)), pitch: facing ? 0.4 : 0, roll: 0 };
    });
  },
  idle: () => ({ thr: 0, yaw: 0, pitch: 0, roll: 0 }),
};
export default mission;
