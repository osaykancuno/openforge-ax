// AR Rover, "Look around": what the camera saw, as a small world model. Pure: no DOM, no three, no MediaPipe.
//
//   detection {label, score, box:{x,y,w,h} in 0..1 of the picture, origin top-left}
//     -> label gate (COCO-80 only: a label is untrusted text from a model file)
//     -> box + depth -> a point on the floor plan (x, z) in the AR world, or just a bearing from the camera
//     -> smoothing per object, 2 s of memory, a few objects at most
//
// Frames: the AR world is metres, Y up. +Z is the rover's heading at yaw 0, +X is LEFT, yaw grows toward +X (so a
// positive yaw / bearing is a turn to the left, as everywhere in the pilot). The rover pose is {x, z, yaw}.

export const HFOV_DEG = 60; // portrait phone camera, only used to turn a pixel column into a direction when there is no depth
export const KEEP_OUT_M = 0.3;
const FRONT_M = 0.08; // the bumper is this far in front of the rover's centre
const MIN_DEPTH = 0.2;
const MAX_DEPTH = 6; // the phone's depth is noise past a few metres
const MAX_PER_FRAME = 10;
const RAD = 180 / Math.PI;

export const COCO80 = Object.freeze([
  "person", "bicycle", "car", "motorcycle", "airplane", "bus", "train", "truck", "boat", "traffic light",
  "fire hydrant", "stop sign", "parking meter", "bench", "bird", "cat", "dog", "horse", "sheep", "cow",
  "elephant", "bear", "zebra", "giraffe", "backpack", "umbrella", "handbag", "tie", "suitcase", "frisbee",
  "skis", "snowboard", "sports ball", "kite", "baseball bat", "baseball glove", "skateboard", "surfboard", "tennis racket", "bottle",
  "wine glass", "cup", "fork", "knife", "spoon", "bowl", "banana", "apple", "sandwich", "orange",
  "broccoli", "carrot", "hot dog", "pizza", "donut", "cake", "chair", "couch", "potted plant", "bed",
  "dining table", "toilet", "tv", "laptop", "mouse", "remote", "keyboard", "cell phone", "microwave", "oven",
  "toaster", "sink", "refrigerator", "book", "clock", "vase", "scissors", "teddy bear", "hair drier", "toothbrush",
]);

/** What a person may say for a COCO class. */
export const ALIASES = Object.freeze({
  mug: "cup",
  phone: "cell phone",
  cellphone: "cell phone",
  smartphone: "cell phone",
  sofa: "couch",
  tv: "tv",
  television: "tv",
  bike: "bicycle",
  table: "dining table",
  plant: "potted plant",
  ball: "sports ball",
  teddy: "teddy bear",
  fridge: "refrigerator",
  glass: "wine glass",
});

// Maps, not objects: "constructor" and "__proto__" are not words in this table.
const KNOWN = new Set(COCO80);
const ALIAS_MAP = new Map(Object.entries(ALIASES));
const WORDS = /^[a-z]+(?: [a-z]+)*$/;

/**
 * The COCO label for what a person or a model said, or null. Strict on purpose: ASCII lower-case words only after
 * trimming, then the 80 classes, the aliases, and one plural. Nothing else gets through, so nothing else is ever shown,
 * stored or spoken back.
 */
export function canonicalLabel(raw) {
  if (typeof raw !== "string" || raw.length > 40) return null;
  const s = raw.trim().toLowerCase().replace(/ {2,}/g, " ");
  if (!s || !WORDS.test(s)) return null;
  const direct = (w) => (KNOWN.has(w) ? w : ALIAS_MAP.has(w) ? ALIAS_MAP.get(w) : null);
  let out = direct(s);
  if (out) return out;
  if (s.endsWith("es")) out = direct(s.slice(0, -2));
  if (!out && s.endsWith("s")) out = direct(s.slice(0, -1));
  return out;
}

export const displayName = (label) => (label === "tv" ? "TV" : String(label));
export const withArticle = (label) => `${/^[aeiou]/.test(label) ? "an" : "a"} ${displayName(label)}`;

// ---------------------------------------------------------------- words for people

const norm180 = (deg) => {
  let a = ((deg % 360) + 360) % 360;
  if (a > 180) a -= 360;
  return a; // (-180, 180]
};

/** ahead / ahead-left / left / behind-left / behind ... for a bearing in degrees, positive = left. */
export function directionWord(bearingDeg) {
  if (!Number.isFinite(bearingDeg)) return "nearby";
  const b = norm180(bearingDeg);
  const a = Math.abs(b);
  const side = b >= 0 ? "left" : "right";
  if (a <= 20) return "ahead";
  if (a <= 65) return `ahead-${side}`;
  if (a <= 115) return side;
  if (a <= 160) return `behind-${side}`;
  return "behind";
}

/** "about 30 cm" below a metre (10 cm steps), "about 1.2 m" above. */
export function distanceText(m) {
  if (!Number.isFinite(m)) return "";
  if (m < 0.95) return `about ${Math.max(10, Math.round(m * 10) * 10)} cm`;
  return `about ${Number((Math.round(m * 10) / 10).toFixed(1))} m`;
}

/** "about 1.2 m ahead-left", or just "ahead-left" when the distance is not known. */
export function whereText({ bearingDeg, distanceM }) {
  const d = Number.isFinite(distanceM) ? `${distanceText(distanceM)} ` : "";
  return `${d}${directionWord(bearingDeg)}`;
}

// ---------------------------------------------------------------- geometry

const isNum = (n) => typeof n === "number" && Number.isFinite(n);
const validPose = (p) => !!p && isNum(p.x) && isNum(p.z);

/** Where a world point is as seen from the rover: bearing in degrees (left +) and distance in metres. null for bad input. */
export function toRoverFrame(point, rover) {
  if (!validPose(point) || !validPose(rover)) return null;
  const dx = point.x - rover.x;
  const dz = point.z - rover.z;
  const distanceM = Math.hypot(dx, dz);
  const yaw = isNum(rover.yaw) ? rover.yaw : 0;
  const bearingDeg = distanceM < 1e-6 ? 0 : norm180(Math.atan2(dx, dz) * RAD - yaw * RAD);
  return { bearingDeg, distanceM };
}

/** Direction of a box from the camera's axis, degrees, left of the picture = positive. */
export function cameraBearingDeg(box, hfovDeg = HFOV_DEG) {
  const u = box.x + box.w / 2;
  return Math.atan((0.5 - u) * 2 * Math.tan((hfovDeg / 2) / RAD)) * RAD;
}

function cleanBox(b) {
  if (!b || typeof b !== "object" || !isNum(b.x) || !isNum(b.y) || !isNum(b.w) || !isNum(b.h)) return null;
  if (b.w <= 0 || b.h <= 0 || b.x < 0 || b.y < 0 || b.x > 1 || b.y > 1 || b.w > 1 || b.h > 1) return null;
  return { x: b.x, y: b.y, w: b.w, h: b.h };
}

const median = (xs) => {
  const s = xs.slice().sort((a, b) => a - b);
  const n = s.length;
  return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
};

/**
 * The world point of a box: the median of five depth readings (centre and a cross around it) unprojected at the box
 * centre. ctx = { getDepth(u, v) -> metres | null, unproject(u, v, depthM) -> {x,y,z} | [x,y,z] }.
 * Wire it with obstacle.js: unproject: (u, v, d) => unproject(u, v, d, invProj, viewToWorld). Needs two valid readings.
 */
export function boxToPoint(box, ctx) {
  const b = cleanBox(box);
  if (!b || !ctx || typeof ctx.getDepth !== "function" || typeof ctx.unproject !== "function") return null;
  const cx = b.x + b.w / 2;
  const cy = b.y + b.h / 2;
  const spots = [[cx, cy], [cx - b.w / 4, cy], [cx + b.w / 4, cy], [cx, cy - b.h / 4], [cx, cy + b.h / 4]];
  const depths = [];
  for (const [u, v] of spots) {
    let d = null;
    try {
      d = ctx.getDepth(u, v);
    } catch {
      d = null;
    }
    if (isNum(d) && d >= MIN_DEPTH && d <= MAX_DEPTH) depths.push(d);
  }
  if (depths.length < 2) return null;
  let p = null;
  try {
    p = ctx.unproject(cx, cy, median(depths));
  } catch {
    return null;
  }
  const out = Array.isArray(p) ? { x: p[0], y: p[1], z: p[2] } : p && { x: p.x, y: p.y, z: p.z };
  return out && isNum(out.x) && isNum(out.y) && isNum(out.z) ? out : null;
}

/**
 * Do the keep-out discs ("avoid the chair") cut the rover's centre line within `lookahead` metres of its bumper?
 * zones: [{x, z, r, label}]. Returns { hit, distanceM, label }; distanceM is from the front, like the depth tracker.
 */
export function zoneHit(zones, rover, { lookahead = 0.6, front = FRONT_M } = {}) {
  let best = null;
  if (!Array.isArray(zones) || !validPose(rover)) return { hit: false };
  const yaw = isNum(rover.yaw) ? rover.yaw : 0;
  const hx = Math.sin(yaw);
  const hz = Math.cos(yaw);
  for (const z of zones) {
    if (!z || !isNum(z.x) || !isNum(z.z) || !isNum(z.r)) continue;
    const dx = z.x - rover.x;
    const dz = z.z - rover.z;
    const along = dx * hx + dz * hz;
    const lateral = Math.abs(dx * hz - dz * hx);
    if (lateral > z.r) continue;
    const half = Math.sqrt(z.r * z.r - lateral * lateral);
    if (along + half < front) continue; // behind us
    const entry = Math.max(0, along - half - front);
    if (entry <= lookahead && (!best || entry < best.distanceM)) best = { hit: true, distanceM: entry, label: z.label };
  }
  return best || { hit: false };
}

/** Where an object is, for words: rover frame when it has a place in the room, else its direction from the camera. */
export function describeObject(obj, rover) {
  if (obj && obj.located) {
    const f = toRoverFrame(obj, rover);
    if (f) return f;
  }
  return { bearingDeg: obj && isNum(obj.bearingCam) ? obj.bearingCam : NaN, distanceM: null };
}

/** Labels for the AR view: plain text of a COCO name at the object. Only objects with a place in the room. */
export function toViewLabels(list) {
  const out = [];
  for (const o of list || []) {
    if (!o || !o.located || !KNOWN.has(o.label) || !isNum(o.x) || !isNum(o.y) || !isNum(o.z)) continue;
    out.push({ id: String(o.id), text: o.label, x: o.x, y: o.y, z: o.z });
  }
  return out;
}

// ---------------------------------------------------------------- the model

/**
 * createWorldObjects({ ttlMs = 2000, alpha = 0.5, assocM = 0.5, assocDeg = 15, maxObjects = 16, hfovDeg })
 * update(detections, tMs, ctx) -> list: ctx = { getDepth, unproject, hfovDeg } (depth is optional)
 * list(tMs), find(label, tMs, rover), clear().
 */
export function createWorldObjects({ ttlMs = 2000, alpha = 0.5, assocM = 0.5, assocDeg = 15, maxObjects = 16, hfovDeg = HFOV_DEG } = {}) {
  let objects = [];
  let seq = 0;
  const time = (t) => (isNum(t) ? t : 0);
  const prune = (t) => {
    objects = objects.filter((o) => t - o.t <= ttlMs);
  };
  const blend = (old, now) => old + alpha * (now - old);

  function update(detections, tMs, ctx = {}) {
    const t = time(tMs);
    prune(t);
    const list = Array.isArray(detections) ? detections.slice(0, MAX_PER_FRAME) : [];
    for (const d of list) {
      if (!d || typeof d !== "object") continue;
      const label = canonicalLabel(d.label);
      const box = cleanBox(d.box);
      if (!label || !box || !isNum(d.score) || d.score < 0 || d.score > 1) continue;
      const bearing = cameraBearingDeg(box, isNum(ctx.hfovDeg) ? ctx.hfovDeg : hfovDeg);
      const point = boxToPoint(box, ctx);
      let o;
      if (point) {
        o = objects.find((x) => x.label === label && x.located && Math.hypot(x.x - point.x, x.z - point.z) <= assocM);
        if (o) {
          o.x = blend(o.x, point.x);
          o.y = blend(o.y, point.y);
          o.z = blend(o.z, point.z);
        } else objects.push((o = { id: ++seq, label, located: true, x: point.x, y: point.y, z: point.z, score: d.score, bearingCam: bearing, t, firstSeen: t }));
      } else {
        o = objects.find((x) => x.label === label && !x.located && Math.abs(x.bearingCam - bearing) <= assocDeg);
        if (!o) objects.push((o = { id: ++seq, label, located: false, score: d.score, bearingCam: bearing, t, firstSeen: t }));
      }
      o.bearingCam = blend(o.bearingCam, bearing);
      o.score = blend(o.score, d.score);
      o.t = t;
    }
    while (objects.length > maxObjects) {
      let oldest = 0;
      for (let i = 1; i < objects.length; i++) if (objects[i].t < objects[oldest].t) oldest = i;
      objects.splice(oldest, 1);
    }
    return list_(t);
  }

  function list_(tMs) {
    const t = time(tMs);
    prune(t);
    return objects.map((o) => ({ ...o }));
  }

  /** The best sighting of a label: one with a place in the room first (nearest to the rover, if given), else the surest. */
  function find(label, tMs, rover) {
    const l = canonicalLabel(label);
    if (!l) return null;
    const all = list_(tMs).filter((o) => o.label === l);
    if (!all.length) return null;
    const placed = all.filter((o) => o.located);
    const pool = placed.length ? placed : all;
    if (placed.length && validPose(rover)) return pool.slice().sort((a, b) => Math.hypot(a.x - rover.x, a.z - rover.z) - Math.hypot(b.x - rover.x, b.z - rover.z))[0];
    return pool.slice().sort((a, b) => b.score - a.score)[0];
  }

  return {
    update,
    list: list_,
    find,
    clear() {
      objects = [];
    },
  };
}
