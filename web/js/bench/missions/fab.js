// Fab Rig (open 3D printer) missions. Lab model of a bed-slinger: X = toolhead, Y = bed, Z = gantry, in millimetres.
// Moves need homed axes (like Klipper/Marlin), Z homes after X and Y, extrusion only sticks with a 0.12–0.28 mm
// nozzle gap. The bed's real height differs from the nominal one by a hidden offset in level 3 (find it by "paper test").
import { DT, prng, clamp, q, num, replay, standardScore, runPolicy } from "./common.js";

export const BED = 220;
const XY_SPEED = 20, Z_SPEED = 5, HOME_XY = 40, HOME_Z = 10;
const SIDE = 40, STEP = 0.05;
const GOOD = [0.12, 0.28];

export function paperTest(gap) {
  if (gap < -0.1) return "crashed";
  if (gap < 0.05) return "scraping the bed";
  if (gap < GOOD[0]) return "heavy drag (too close)";
  if (gap <= GOOD[1]) return "light drag (just right)";
  if (gap < 0.6) return "no drag (too far)";
  return "far above the bed";
}

function init(level, seed) {
  const r = prng(seed * 53 + level.length);
  const s = { level, seed, t: 0, x: 10, y: 10, z: 5, homed: { x: true, y: true, z: true }, homing: null, ext: false, bedErr: 0, path: [], badMm: 0, strayMm: 0, goodMm: 0, msg: "", done: false, success: false, reason: null, progress: 0, metrics: {} };
  if (level === "home") {
    s.x = Math.round(60 + r() * 100);
    s.y = Math.round(60 + r() * 100);
    s.z = Math.round(20 + r() * 40);
    s.homed = { x: false, y: false, z: false };
  } else {
    s.sq = { x: Math.round(50 + r() * 80), y: Math.round(50 + r() * 80), side: SIDE };
    s.samples = [];
    for (let i = 0; i < SIDE * 4; i++) {
      const e = Math.floor(i / SIDE), k = i % SIDE;
      const [px, py] = [[k, 0], [SIDE, k], [SIDE - k, SIDE], [0, SIDE - k]][e];
      s.samples.push({ x: s.sq.x + px, y: s.sq.y + py, hit: false });
    }
    if (level === "layer") s.bedErr = q((r() < 0.5 ? -1 : 1) * (0.12 + r() * 0.13), 2);
  }
  return s;
}

const gapOf = (s) => s.z + s.bedErr;
function perimDist(s, x, y) {
  const { x: ox, y: oy, side } = s.sq;
  const dx = Math.max(ox - x, 0, x - (ox + side)), dy = Math.max(oy - y, 0, y - (oy + side));
  if (dx > 0 || dy > 0) return Math.hypot(dx, dy);
  return Math.min(x - ox, ox + side - x, y - oy, oy + side - y);
}

function step(s, a, dt = DT) {
  if (s.done) return s;
  if (s.t - (s.msgAt ?? -9) > 2.5) s.msg = ""; // a refusal stays on screen long enough to read
  const home = a?.home;
  if (home && !s.homing) {
    if (home === "z" && !(s.homed.x && s.homed.y)) (s.msg = "Home X and Y first: Z homes at the bed centre."), (s.msgAt = s.t);
    else if (["x", "y", "z"].includes(home)) s.homing = home;
  }
  if (a?.gotoZ && s.homed.z && !s.homing) s.z = 0.2; // G1 Z0.2 (nominal first-layer height)
  if (a?.baby && s.homed.z) s.z = q(s.z + clamp(Math.round(a.baby), -1, 1) * STEP, 3);
  const x0 = s.x, y0 = s.y;
  if (s.homing) {
    const ax = s.homing;
    if (ax === "z" && (Math.abs(s.x - BED / 2) > 0.01 || Math.abs(s.y - BED / 2) > 0.01)) {
      // travel to the bed centre first, then probe down
      const d = HOME_XY * dt;
      s.x += clamp(BED / 2 - s.x, -d, d);
      s.y += clamp(BED / 2 - s.y, -d, d);
    } else {
      const v = ax === "z" ? HOME_Z : HOME_XY;
      s[ax] = Math.max(0, s[ax] - v * dt);
      if (s[ax] <= 0) {
        s.homed[ax] = true;
        s.homing = null;
        if (ax === "z") s.z = 5; // lift after probing
      }
    }
  } else {
    const jx = num(a?.jx, -1, 1, 0), jy = num(a?.jy, -1, 1, 0), jz = num(a?.jz, -1, 1, 0);
    if ((jx && !s.homed.x) || (jy && !s.homed.y) || (jz && !s.homed.z)) (s.msg = "Must home axis first."), (s.msgAt = s.t);
    if (s.homed.x) s.x = clamp(s.x + jx * XY_SPEED * dt, 0, BED);
    if (s.homed.y) s.y = clamp(s.y + jy * XY_SPEED * dt, 0, BED);
    if (s.homed.z) s.z = clamp(s.z + jz * Z_SPEED * dt, -1, 200);
  }
  s.ext = !!a?.ext && !s.homing && s.level !== "home";
  const gap = gapOf(s);
  s.t += dt;
  if (gap < -0.1) return finish(s, false, "nozzle_crash");

  if (s.level === "home") {
    const n = ["x", "y", "z"].filter((k) => s.homed[k]).length;
    s.progress = n / 3;
    s.metrics.homed = `${n}/3`;
    if (n === 3) finish(s, true, "homed");
    return s;
  }
  const moved = Math.hypot(s.x - x0, s.y - y0);
  if (s.ext && moved > 0) {
    const good = gap >= GOOD[0] && gap <= GOOD[1];
    const mx = (s.x + x0) / 2, my = (s.y + y0) / 2;
    const stray = perimDist(s, mx, my) > 1.5;
    const last = s.path[s.path.length - 1];
    const seg = { x0, y0, x1: s.x, y1: s.y, good };
    if (last && last.good === good && last.x1 === x0 && last.y1 === y0 && Math.abs((last.x1 - last.x0) * (s.y - y0) - (last.y1 - last.y0) * (s.x - x0)) < 1e-9) (last.x1 = s.x), (last.y1 = s.y);
    else s.path.push(seg);
    if (stray) s.strayMm += moved;
    if (!good) s.badMm += moved;
    else {
      s.goodMm += moved;
      for (const p of s.samples) {
        if (p.hit) continue;
        const vx = s.x - x0, vy = s.y - y0;
        const k = clamp(((p.x - x0) * vx + (p.y - y0) * vy) / (vx * vx + vy * vy), 0, 1);
        if (Math.hypot(p.x - (x0 + vx * k), p.y - (y0 + vy * k)) <= 1) p.hit = true;
      }
    }
  }
  const total = s.goodMm + s.badMm;
  const cov = s.samples.filter((p) => p.hit).length / s.samples.length;
  s.metrics.coverage = Math.round(cov * 100);
  s.metrics.stray = total ? Math.round((s.strayMm / total) * 100) : 0;
  s.metrics.bad = total ? Math.round((s.badMm / total) * 100) : 0;
  s.metrics.gapMm = +gap.toFixed(2);
  s.progress = Math.max(s.progress, cov * 0.95);
  const need = s.level === "layer" ? 0.85 : 0.9;
  if (s.strayMm > 120) return finish(s, false, "too_much_stray_plastic");
  if (s.level === "layer" && s.badMm > 30) return finish(s, false, "first_layer_failed");
  if (!s.ext && cov >= need && s.strayMm <= 0.15 * total && (s.level !== "layer" || s.badMm <= 0.1 * total)) finish(s, true, "printed");
  return s;
}

function finish(s, ok, reason) {
  s.done = true;
  s.success = ok;
  s.reason = reason;
  s.ext = false;
  if (ok) s.progress = 1;
  return s;
}

export const mission = {
  id: "fab",
  dt: DT,
  levels: [
    { id: "home", title: "Home the axes", goal: "Send each axis to its endstop. Z homes last, at the bed centre.", pass: 60, maxSteps: 40 * 30 },
    { id: "square", title: "Print a square perimeter", goal: "Go to Z 0.2, move to the marked corner, extrude around the 40 mm square (≥ 90 % covered, ≤ 15 % stray), then stop extruding.", pass: 60, maxSteps: 120 * 30 },
    { id: "layer", title: "First layer, right Z", goal: "This bed sits a little high or low. After Z 0.2, baby-step until the paper test says light drag, then print the square.", pass: 60, maxSteps: 150 * 30 },
  ],
  controls: [
    { type: "pulse", id: "homeX", label: "Home X", levels: ["home"] },
    { type: "pulse", id: "homeY", label: "Home Y", levels: ["home"] },
    { type: "pulse", id: "homeZ", label: "Home Z", levels: ["home"] },
    { type: "pad", id: "jog", label: "Jog", buttons: [{ id: "yp", label: "Y+", key: "ArrowUp" }, { id: "xm", label: "X−", key: "ArrowLeft" }, { id: "ym", label: "Y−", key: "ArrowDown" }, { id: "xp", label: "X+", key: "ArrowRight" }, { id: "zp", label: "Z up", key: "PageUp" }, { id: "zm", label: "Z down", key: "PageDown" }] },
    { type: "pulse", id: "gotoZ", label: "Go to Z 0.2", levels: ["square", "layer"], key: "z" },
    { type: "pulse", id: "babyDown", label: "Baby-step −0.05", levels: ["layer"], key: "-" },
    { type: "pulse", id: "babyUp", label: "Baby-step +0.05", levels: ["layer"], key: "=" },
    { type: "toggle", id: "ext", label: "Extrude", levels: ["square", "layer"], key: "e" },
  ],
  uiDefaults: () => ({ ext: false }),
  toAction(ui) {
    const h = ui.held || {}, p = ui.pulse || {};
    return {
      jx: (h.xp ? 1 : 0) - (h.xm ? 1 : 0), jy: (h.yp ? 1 : 0) - (h.ym ? 1 : 0), jz: (h.zp ? 1 : 0) - (h.zm ? 1 : 0),
      ext: !!ui.ext, home: p.homeX ? "x" : p.homeY ? "y" : p.homeZ ? "z" : null, gotoZ: !!p.gotoZ, baby: p.babyUp ? 1 : p.babyDown ? -1 : 0,
    };
  },
  init,
  step,
  score(trace) {
    const s = replay(mission, trace);
    return standardScore(mission, trace, s, { quality: s.level === "home" ? 1 : clamp(1 - (s.metrics.stray ?? 0) / 15, 0, 1) });
  },
  readout(s) {
    const h = ["x", "y", "z"].map((k) => `${k.toUpperCase()}${s.homed[k] ? " ✓" : " ?"}`).join(" ");
    const pos = `X ${s.x.toFixed(1)} Y ${s.y.toFixed(1)} Z ${s.z.toFixed(2)} mm`;
    if (s.level === "home") return `${pos} · homed: ${h}${s.homing ? ` · homing ${s.homing.toUpperCase()}…` : ""}${s.msg ? ` · ${s.msg}` : ""}`;
    const out = [pos, `paper test: ${paperTest(gapOf(s))}`, `perimeter ${s.metrics.coverage ?? 0} % · stray ${s.metrics.stray ?? 0} %`, s.ext ? "extruding" : "not extruding"];
    if (s.level === "layer") out.push(`bad first layer ${s.metrics.bad ?? 0} %`);
    if (s.msg) out.push(s.msg);
    return out.join(" · ");
  },
  solve(level, seed) {
    if (level === "home") {
      const order = ["x", "y", "z"];
      let i = 0, sent = false;
      return runPolicy(mission, level, seed, (s) => {
        while (i < 3 && s.homed[order[i]]) (i++), (sent = false);
        if (i >= 3 || s.homing) return {};
        const a = sent ? {} : { home: order[i] };
        sent = true;
        return a;
      });
    }
    const s0 = init(level, seed);
    const { x: ox, y: oy } = s0.sq;
    const loop = [{ x: ox + SIDE, y: oy }, { x: ox + SIDE, y: oy + SIDE }, { x: ox, y: oy + SIDE }, { x: ox, y: oy }];
    let ph = 0, k = 0;
    const jog = (s, p) => ({ jx: q(clamp((p.x - s.x) / (XY_SPEED * DT), -1, 1), 4), jy: q(clamp((p.y - s.y) / (XY_SPEED * DT), -1, 1), 4) });
    const at = (s, p) => Math.abs(s.x - p.x) < 1e-6 && Math.abs(s.y - p.y) < 1e-6;
    return runPolicy(mission, level, seed, (s) => {
      if (ph === 0) return (ph = 1), { gotoZ: true };
      if (ph === 1) {
        const g = gapOf(s);
        if (g < 0.15) return { baby: 1 };
        if (g > 0.25) return { baby: -1 };
        ph = 2;
      }
      if (ph === 2) {
        if (!at(s, { x: ox, y: oy })) return jog(s, { x: ox, y: oy });
        ph = 3;
      }
      if (ph === 3) {
        if (k < loop.length) {
          if (at(s, loop[k])) k++;
          if (k < loop.length) return { ...jog(s, loop[k]), ext: true };
        }
        ph = 4;
      }
      return { ext: false };
    });
  },
  idle: () => ({}),
};
export default mission;
