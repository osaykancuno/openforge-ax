// Differential-drive missions (Street Rover = OpenBot class, AX-1 Rover). Lab model: two wheels with a first-order
// speed lag, no slip, no inertia beyond that lag. Ground frame: x (robot's left at start), z forward, heading 0 = +z.
import { DT, prng, clamp, approach, q, num, replay, standardScore, runPolicy, hold } from "./common.js";

const CONE_R = 0.05;
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));

export function makeDriveMission({ id, track = 0.13, vmax = 0.6, tau = 0.15, radius = 0.09, label = "rover" }) {
  function init(level, seed) {
    const r = prng(seed * 13 + level.length * 101);
    const s = { level, seed, t: 0, x: 0, z: 0, heading: 0, vl: 0, vr: 0, cones: [], gates: [], box: null, passed: 0, hold: 0, done: false, success: false, reason: null, progress: 0, metrics: {} };
    if (level === "cone") {
      const a = (-40 + r() * 80) * (Math.PI / 180);
      const d = 1.2 + r() * 0.6;
      s.cones.push({ x: Math.sin(a) * d, z: Math.cos(a) * d });
      s.d0 = d;
    } else if (level === "slalom") {
      let side = r() < 0.5 ? 1 : -1;
      for (let i = 0; i < 3; i++) {
        const c = { x: (r() - 0.5) * 0.2, z: 0.8 * (i + 1) };
        s.cones.push(c);
        s.gates.push({ ...c, side }); // side +1: pass with the robot on the +x side of the cone
        side = -side;
      }
      s.finishZ = 3.2;
    } else {
      const h = [0, 90, -90, 180][Math.floor(r() * 4)] * (Math.PI / 180);
      s.box = { x: (r() - 0.5) * 1.2, z: 1.3 + r() * 0.5, heading: h, w: track + 0.17, l: 0.42 };
      s.d0 = Math.hypot(s.box.x, s.box.z);
    }
    return s;
  }

  function step(s, action, dt = DT) {
    if (s.done) return s;
    const l = num(action?.l, -1, 1, 0), rr = num(action?.r, -1, 1, 0);
    const k = 1 - Math.exp(-dt / tau);
    s.vl += (l * vmax - s.vl) * k;
    s.vr += (rr * vmax - s.vr) * k;
    const v = (s.vl + s.vr) / 2;
    const w = (s.vr - s.vl) / track;
    const zPrev = s.z, xPrev = s.x;
    s.heading = wrap(s.heading + w * dt);
    s.x += Math.sin(s.heading) * v * dt;
    s.z += Math.cos(s.heading) * v * dt;
    s.t += dt;
    s.speed = Math.abs(v);
    for (const c of s.cones) if (Math.hypot(s.x - c.x, s.z - c.z) < CONE_R + radius) return finish(s, false, "hit_cone");
    if (Math.abs(s.x) > 2 || s.z < -0.8 || s.z > 4.2) return finish(s, false, "left_the_arena");

    if (s.level === "cone") {
      const c = s.cones[0];
      const d = Math.hypot(s.x - c.x, s.z - c.z);
      s.metrics.distanceCm = Math.round(d * 100);
      s.progress = Math.max(s.progress, clamp(1 - (d - 0.3) / s.d0, 0, 1));
      s.hold = hold(s.hold, d < 0.3 && s.speed < 0.1, dt);
      if (s.hold >= 0.3) finish(s, true, "at_the_cone");
    } else if (s.level === "slalom") {
      const g = s.gates[s.passed];
      if (g && zPrev < g.z && s.z >= g.z) {
        const xc = xPrev + ((s.x - xPrev) * (g.z - zPrev)) / (s.z - zPrev || 1);
        if (Math.sign(xc - g.x) !== g.side) return finish(s, false, "wrong_side");
        s.passed++;
      }
      s.progress = s.passed / 4;
      s.metrics.gates = `${s.passed}/3`;
      if (s.z >= s.finishZ) {
        if (s.passed === 3) finish(s, true, "finished");
        else finish(s, false, "missed_gate");
      }
    } else {
      const b = s.box;
      const dx = s.x - b.x, dz = s.z - b.z;
      // into the box frame: u across, v along the box heading
      const u = dx * Math.cos(b.heading) - dz * Math.sin(b.heading);
      const vv = dx * Math.sin(b.heading) + dz * Math.cos(b.heading);
      const herr = Math.abs(wrap(s.heading - b.heading)) * (180 / Math.PI);
      const inside = Math.abs(u) < b.w / 2 - 0.06 && Math.abs(vv) < b.l / 2 - 0.08;
      s.metrics.headingErr = Math.round(herr);
      s.metrics.distanceCm = Math.round(Math.hypot(dx, dz) * 100);
      s.progress = Math.max(s.progress, clamp(1 - Math.hypot(dx, dz) / s.d0, 0, 1) * 0.8 + (inside ? 0.2 : 0));
      s.hold = hold(s.hold, inside && herr < 15 && s.speed < 0.03, dt);
      if (s.hold >= 1) finish(s, true, "parked");
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

  /** Steer toward waypoints (pure pursuit-ish); the last waypoint is a stop. */
  function follow(points, { slow = 0.35, final } = {}) {
    let i = 0;
    return (s) => {
      let p = points[i];
      while (p && Math.hypot(p.x - s.x, p.z - s.z) < (i === points.length - 1 ? 0.03 : 0.12)) p = points[++i];
      if (!p) {
        if (final && Math.abs(wrap(final - s.heading)) > 0.08) {
          const e = wrap(final - s.heading);
          return { l: q(-clamp(e * 1.5, -0.5, 0.5)), r: q(clamp(e * 1.5, -0.5, 0.5)) };
        }
        return { l: 0, r: 0 };
      }
      const e = wrap(Math.atan2(p.x - s.x, p.z - s.z) - s.heading);
      const near = i === points.length - 1 ? clamp(Math.hypot(p.x - s.x, p.z - s.z) * 2, 0.15, 1) : 1;
      const f = clamp(Math.cos(e), 0, 1) * near * (i === points.length - 1 ? slow : 0.8);
      const t = clamp(e * 1.6, -0.7, 0.7);
      return { l: q(clamp(f - t, -1, 1)), r: q(clamp(f + t, -1, 1)) };
    };
  }

  const mission = {
    id,
    dt: DT,
    kind: "drive",
    levels: [
      { id: "cone", title: "Drive to the cone", goal: "Stop within 30 cm of the cone without touching it.", pass: 60, maxSteps: 40 * 30 },
      { id: "slalom", title: "Slalom", goal: "Pass each cone on the marked side, in order, then cross the finish line.", pass: 60, maxSteps: 60 * 30 },
      { id: "park", title: "Park in the box", goal: "Use the phone camera view to stop fully inside the box, facing the arrow (±15°), for one second.", pass: 60, maxSteps: 75 * 30, phoneView: true },
    ],
    controls: [
      { type: "pad", id: "drive", label: "Drive", buttons: [{ id: "up", label: "Forward", key: "ArrowUp" }, { id: "left", label: "Left", key: "ArrowLeft" }, { id: "down", label: "Back", key: "ArrowDown" }, { id: "right", label: "Right", key: "ArrowRight" }] },
      { type: "slider", id: "speed", label: "Speed limit", min: 10, max: 100, step: 5, unit: "%", value: 50 },
    ],
    uiDefaults: () => ({ speed: 50 }),
    toAction(ui) {
      const h = ui.held || {};
      const f = (h.up ? 1 : 0) - (h.down ? 1 : 0);
      const t = (h.left ? 1 : 0) - (h.right ? 1 : 0);
      const k = (ui.speed ?? 50) / 100;
      const turn = t * (f ? 0.45 : 0.6);
      return { l: q(clamp((f - turn) * k, -1, 1)), r: q(clamp((f + turn) * k, -1, 1)) };
    },
    init,
    step,
    score(trace) {
      return standardScore(mission, trace, replay(mission, trace));
    },
    readout(s) {
      const out = [`Speed ${(s.speed ?? 0).toFixed(2)} m/s`, `heading ${Math.round((s.heading * 180) / Math.PI)}°`];
      if (s.level === "cone") out.push(`cone ${s.metrics.distanceCm ?? "–"} cm away`);
      if (s.level === "slalom") out.push(`gates ${s.passed}/3`, s.gates[s.passed] ? `next: keep the cone on your ${s.gates[s.passed].side > 0 ? "right" : "left"}` : "now cross the finish line");
      if (s.level === "park") out.push(`box ${s.metrics.distanceCm ?? "–"} cm away`, `heading error ${s.metrics.headingErr ?? "–"}°`);
      return out.join(" · ");
    },
    solve(level, seed) {
      const s0 = init(level, seed);
      let pts, opts = {};
      if (level === "cone") {
        const c = s0.cones[0];
        const d = Math.hypot(c.x, c.z);
        pts = [{ x: (c.x * (d - 0.22)) / d, z: (c.z * (d - 0.22)) / d }];
      } else if (level === "slalom") {
        pts = s0.gates.flatMap((g) => [{ x: g.x + g.side * 0.32, z: g.z - 0.25 }, { x: g.x + g.side * 0.32, z: g.z + 0.25 }]).concat([{ x: 0, z: 3.5 }]);
        opts.slow = 0.8;
      } else {
        const b = s0.box;
        const back = (d) => ({ x: b.x - Math.sin(b.heading) * d, z: b.z - Math.cos(b.heading) * d });
        pts = [back(0.6), back(0.3), back(0)];
        opts = { slow: 0.3, final: b.heading };
      }
      return runPolicy(mission, level, seed, follow(pts, opts));
    },
    idle: () => ({ l: 0, r: 0 }),
  };
  void label;
  void approach;
  return mission;
}

export default makeDriveMission;
