// Obstacle sensing for the AR Rover twin: is something in the box in front of the Rover?
//
// The phone's depth image (WebXR depth-sensing) tells how far the real surface is in every pixel. A grid of sample points
// is laid in a corridor in front of the twin, each point is looked at through the depth image, and the REAL surface it sees
// is unprojected back to the world. A surface counts as an obstacle only when it lies INSIDE the corridor volume (not
// further than LOOKAHEAD from the bumper, narrower than the Rover, taller than the floor noise, lower than a hand held
// up to the lens). The floor falls under MIN_H; something right in front of the camera falls outside the corridor and
// makes those samples "not visible" instead. Without depth, hit-test rays feed the same tracker.
//
// Phones without a depth sensor (a Galaxy S24, for one) estimate depth from motion: on a plain floor it reads several per
// cent short, which lifts the floor above MIN_H and blocked the Rover "0 cm ahead" on a clear floor. Two guards:
//   1. Calibration, every evaluation: the floor AROUND the Rover (a ring beside and behind it, never the corridor ahead) is
//      looked at too, and the median of measured / expected depth there is the phone's floor error right now (clamped to
//      FLOOR_K_MIN..FLOOR_K_MAX). Every depth in the corridor is divided by it before it is judged.
//   2. A surface has to stand clearly IN FRONT of the floor its line of sight would reach: nearer than that floor by
//      FLOOR_ABS or FLOOR_REL of its distance, whichever is more. What is left of the floor error is ignored; anything
//      rising from the floor still counts.
//
// Matrices are column-major Float32Array(16) as WebXR hands them out. View space: the camera looks down -Z, depth is the
// distance along the view axis. Normalised view coordinates (u, v): origin top-left, v down. Pure: no DOM, no three.
// Honesty: this is the PHONE's depth sensing, protecting the TWIN. It protects nothing else.
import { FRONT } from "../pilot/twin-pose.js";

export const OBST = {
  LOOKAHEAD: 0.6, // m from the front bumper
  HALF_W: 0.14, // m half-width of the corridor (the Rover is 0.226 m wide)
  MIN_H: 0.05, // m above the floor: lower is floor noise
  MAX_H: 0.26, // m above the floor: the Rover's height; higher passes over
  HEIGHTS: [0.07, 0.15, 0.23], // heights of the sample layers
  STEPS: 8, // samples along the corridor
  LANES: 3, // samples across it
  MIN_HITS: 3, // samples that must see an obstacle in one frame
  ENTER: 3, // consecutive frames with obstacle before "blocked"
  CLEAR: 8, // consecutive clear frames before "clear" again
  CLEAR_EXTRA: 0.08, // m: a weak return must be this much further than where the obstacle appeared to count as clear
  BLIND_FRAC: 0.3, // below this fraction of the corridor in view, the tracker cannot judge ("blind")
};
const OCCLUDED_BY = 0.1; // m: a surface this much nearer than a sample hides it
export const FLOOR_ABS = 0.05; // m: a surface must be at least this much nearer than the floor along its line of sight...
export const FLOOR_REL = 0.06; // ...or this share of the floor's distance, whichever is more
export const FLOOR_K_MIN = 0.7; // the floor calibration never believes the phone is more than 30% short...
export const FLOOR_K_MAX = 1.2; // ...or 20% long
const RING = { R: 0.35, STEP_DEG: 30, SKIP_DEG: 50, MIN: 4 }; // calibration ring: 35 cm around the Rover, not within 50 deg of ahead
export const BLIND_MESSAGE = "Obstacle sensing: point the phone at the Rover";

const xyz = (p) => (Array.isArray(p) || ArrayBuffer.isView(p) ? [p[0], p[1], p[2]] : [p.x, p.y, p.z]);
/** m * [x, y, z, 1] (column-major) -> [x, y, z, w]. */
function mulPoint(m, x, y, z) {
  return [m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13], m[2] * x + m[6] * y + m[10] * z + m[14], m[3] * x + m[7] * y + m[11] * z + m[15]];
}

/**
 * Points of the corridor in front of a Rover standing at worldPose { x, y, z, yaw } (y = floor height). Each is
 * { x, y, z } in world space. opts may override any OBST value.
 */
export function corridorSamples(worldPose, opts = {}) {
  const o = { ...OBST, ...opts };
  const fx = Math.sin(worldPose.yaw);
  const fz = Math.cos(worldPose.yaw);
  const rx = fz; // to the Rover's right
  const rz = -fx;
  const out = [];
  for (let i = 0; i < o.STEPS; i++) {
    const along = FRONT + (o.LOOKAHEAD * (i + 0.5)) / o.STEPS;
    for (let l = 0; l < o.LANES; l++) {
      const lat = o.LANES > 1 ? ((l / (o.LANES - 1)) * 2 - 1) * o.HALF_W * 0.8 : 0;
      for (const h of o.HEIGHTS) out.push({ x: worldPose.x + fx * along + rx * lat, y: worldPose.y + h, z: worldPose.z + fz * along + rz * lat });
    }
  }
  return out;
}

/** World point -> { u, v, zView } (zView = distance along the view axis), or null when behind the camera or outside the view. */
export function project(p, worldToView, proj) {
  const [x, y, z] = xyz(p);
  const v = mulPoint(worldToView, x, y, z);
  const zView = -v[2];
  if (!(zView > 1e-4)) return null;
  const c = mulPoint(proj, v[0], v[1], v[2]);
  if (!(c[3] > 1e-6)) return null;
  const nx = c[0] / c[3];
  const ny = c[1] / c[3];
  if (!(Math.abs(nx) <= 1 && Math.abs(ny) <= 1)) return null;
  return { u: (nx + 1) / 2, v: (1 - ny) / 2, zView };
}

/** The world point seen at (u, v) when the depth there is depthM (along the view axis). Returns [x, y, z]. */
export function unproject(u, v, depthM, invProj, viewToWorld) {
  const c = mulPoint(invProj, 2 * u - 1, 1 - 2 * v, -1); // a point of the near plane, in view space
  const px = c[0] / c[3];
  const py = c[1] / c[3];
  const pz = c[2] / c[3];
  const k = depthM / -pz;
  const w = mulPoint(viewToWorld, px * k, py * k, pz * k);
  return [w[0], w[1], w[2]];
}

/**
 * Looks at every sample through the depth image.
 * -> { hits, nearestM, visibleFrac, floorK, floorRatio }: hits = samples whose real surface is inside the corridor volume;
 * nearestM = the nearest such surface, in metres from the front bumper (Infinity without hits); visibleFrac = share of the
 * samples the camera could actually judge (in view, valid depth, not hidden behind something near the lens); floorK = the
 * floor calibration used (1 when the ring could not be read); floorRatio = corrected depth / floor depth in the corridor
 * (median, about 1 on a clear floor).
 */
export function evaluateDepth({ samples, getDepth, worldToView, viewToWorld, proj, invProj, worldPose, floorY = worldPose.y }) {
  const fx = Math.sin(worldPose.yaw);
  const fz = Math.cos(worldPose.yaw);
  const eyeY = viewToWorld[13]; // the camera's height in the world
  // where the line of sight through (u, v) meets the floor (depth along the view axis); Infinity when it never does
  const floorDepth = (u, v) => {
    const y1 = unproject(u, v, 1, invProj, viewToWorld)[1];
    return y1 < eyeY - 1e-6 && eyeY > floorY ? (eyeY - floorY) / (eyeY - y1) : Infinity;
  };
  const readDepth = (u, v) => {
    const d = getDepth(u, v);
    return typeof d === "number" && d > 0 && Number.isFinite(d) ? d : null;
  };
  const median = (a) => (a.sort((x, y) => x - y), a.length ? a[a.length >> 1] : null);
  // 1. the phone's floor error right now, from the floor beside and behind the Rover
  const ring = [];
  for (let deg = 0; deg < 360; deg += RING.STEP_DEG) {
    if (Math.min(deg, 360 - deg) < RING.SKIP_DEG) continue; // never the corridor ahead
    const a = worldPose.yaw + (deg * Math.PI) / 180;
    const pr = project({ x: worldPose.x + Math.sin(a) * RING.R, y: floorY, z: worldPose.z + Math.cos(a) * RING.R }, worldToView, proj);
    if (!pr) continue;
    const d = readDepth(pr.u, pr.v);
    const fd = floorDepth(pr.u, pr.v);
    if (d !== null && Number.isFinite(fd)) ring.push(d / fd);
  }
  const k = ring.length >= RING.MIN ? Math.min(FLOOR_K_MAX, Math.max(FLOOR_K_MIN, median(ring))) : 1;
  let hits = 0;
  let visible = 0;
  let nearest = Infinity;
  const ratios = []; // corrected depth / floor depth, for the debug panel
  for (const s of samples) {
    const pr = project(s, worldToView, proj);
    if (!pr) continue; // out of view
    const raw = readDepth(pr.u, pr.v);
    if (raw === null) continue; // no depth there
    const d = raw / k;
    const floorD = floorDepth(pr.u, pr.v);
    if (Number.isFinite(floorD)) ratios.push(d / floorD);
    // 2. it must stand clearly in front of the floor its line of sight would reach
    const standsOut = d < floorD - Math.max(FLOOR_ABS, FLOOR_REL * floorD);
    const [sx, sy, sz] = unproject(pr.u, pr.v, d, invProj, viewToWorld);
    const dx = sx - worldPose.x;
    const dz = sz - worldPose.z;
    const along = dx * fx + dz * fz - FRONT;
    const lateral = dx * fz - dz * fx;
    const h = sy - floorY;
    if (standsOut && along >= 0 && along <= OBST.LOOKAHEAD && Math.abs(lateral) < OBST.HALF_W && h > OBST.MIN_H && h < OBST.MAX_H) {
      hits++;
      visible++;
      if (along < nearest) nearest = along;
    } else if (d >= pr.zView - OCCLUDED_BY) visible++; // the sample's own line of sight is free (it ends on the floor or a far wall)
    // else: something near the lens hides this sample: not visible
  }
  return { hits, nearestM: nearest, visibleFrac: samples.length ? visible / samples.length : 0, floorK: k, floorRatio: median(ratios) };
}

/**
 * Hit-test rays (no depth sensing): distancesM = distances from the Rover's centre to the real planes the horizontal rays
 * found. One plane inside the look-ahead is already a confirmed detection, so it counts as MIN_HITS.
 */
export function evaluateRays(distancesM) {
  let n = 0;
  let nearest = Infinity;
  for (const d of Array.isArray(distancesM) ? distancesM : []) {
    if (typeof d !== "number" || !Number.isFinite(d) || d < 0) continue;
    const along = Math.max(0, d - FRONT);
    if (along > OBST.LOOKAHEAD) continue;
    n++;
    if (along < nearest) nearest = along;
  }
  return { hits: n ? Math.max(n, OBST.MIN_HITS) : 0, nearestM: nearest, visibleFrac: 1 };
}

/** Metres from the front bumper to the edge of the play circle (radius around the placement), along the heading. 0 at the edge. */
export function edgeAhead(localPose, radius) {
  const fx = Math.sin(localPose.yaw);
  const fz = Math.cos(localPose.yaw);
  const b = localPose.x * fx + localPose.z * fz;
  const c = localPose.x * localPose.x + localPose.z * localPose.z - radius * radius;
  const disc = b * b - c;
  if (disc < 0) return 0;
  return Math.max(0, -b + Math.sqrt(disc) - FRONT);
}

/** True when the wheel outputs [l, r] drive the Rover forward. */
export const isForwardWheels = (w) => Array.isArray(w) && w.length >= 2 && w[0] + w[1] > 0;
/** True for a plan step that drives forward (also the forward curves). */
export const isForwardStep = (s) => !!s && s.tool === "drive" && typeof s.direction === "string" && s.direction.startsWith("forward");

const fin = (v, d) => (typeof v === "number" && Number.isFinite(v) ? v : d);

/**
 * A tracker with hysteresis, fed with {hits, nearestM, visibleFrac, source} once per evaluation.
 * update(x) -> { state: "clear" | "blocked" | "blind" | "off", distanceM, message }.
 * Blocked after ENTER consecutive frames with obstacle; clear again after CLEAR consecutive clear frames (a weak return
 * nearer than where the obstacle appeared + CLEAR_EXTRA is not clear). While blocked, frames that cannot see the corridor
 * change nothing. distanceM is the minimum over the last 5 obstacle frames, from the bumper, rounded to 10 cm (1 cm under
 * 20 cm); nearM is the nearest of the last 3 obstacle frames, not rounded: the controller stops the Rover on it.
 */
export function createObstacleTracker() {
  let blocked = false;
  let enter = 0;
  let clear = 0;
  let enterDist = Infinity;
  let recent = [];
  const clearResult = () => ({ state: "clear", distanceM: null, message: "" });
  const blockedResult = () => {
    const m = Math.min(...recent);
    const d = m < 0.2 ? Math.round(m * 100) / 100 : Math.round(m * 10) / 10;
    return { state: "blocked", distanceM: d, nearM: Math.min(...recent.slice(-3)), message: `Something is in my way (about ${Math.round(d * 100)} cm ahead).` };
  };
  const api = {
    update(u) {
      if (!u || u.source === "off") {
        api.reset();
        return { state: "off", distanceM: null, message: "" };
      }
      const hits = fin(u.hits, 0);
      const near = Math.max(0, fin(u.nearestM, Infinity));
      const vis = fin(u.visibleFrac, 0);
      if (hits >= OBST.MIN_HITS) {
        // an obstacle seen is an obstacle, whatever else is out of view
        enter++;
        clear = 0;
        recent.push(Number.isFinite(near) ? near : 0);
        if (recent.length > 5) recent.shift();
        if (!blocked && enter >= OBST.ENTER) {
          blocked = true;
          enterDist = Math.min(...recent);
        }
        return blocked ? blockedResult() : clearResult();
      }
      enter = 0;
      if (!blocked) recent = []; // a broken streak: the next one measures its own distance, not an older nearer one
      if (vis < OBST.BLIND_FRAC) return blocked ? blockedResult() : { state: "blind", distanceM: null, message: BLIND_MESSAGE };
      if (!blocked) {
        recent = [];
        return clearResult();
      }
      clear = near > enterDist + OBST.CLEAR_EXTRA ? clear + 1 : 0;
      if (clear >= OBST.CLEAR) {
        blocked = false;
        clear = 0;
        recent = [];
        return clearResult();
      }
      return blockedResult();
    },
    reset() {
      blocked = false;
      enter = 0;
      clear = 0;
      enterDist = Infinity;
      recent = [];
    },
  };
  return api;
}
