// AI Pilot tools: the allowlist of what a plan may ask for, as OpenAI function specs (for the model) and as a
// validator (for everything that comes back). One table drives both, so the spec the model sees and the rules we
// enforce cannot drift apart. Model output is untrusted: whatever it sends, validatePlan returns a short, clamped
// plan built only from the tools the body offers, with only the fields each tool defines.
//
// Units: degrees, seconds, percent. The model can stop the robot but there is no arm, connect, config, limits,
// relax, speed-cap or network tool, and no free-form parameter except `say.text`.
// Angle convention (as the twin's joints, REP-103): positive turn / pan / yaw = LEFT, positive tilt = UP.
import * as P from "../ax-proto.js";
import { GESTURES, POSES, gestureMs } from "../motions.js";

export const LIMITS = {
  MAX_STEPS: 12,
  MAX_TOTAL_S: 30,
  SAY_MAX: 200,
  WAIT_S: [0.1, 5],
  DRIVE_S: [0.1, 3],
  SPEED: [10, 100],
  TURN_DEG: [-180, 180],
  SCAN_MAX: 200, // entries inspected in a raw plan; the rest is counted, never parsed
  REJECTED_MAX: 20, // reasons kept; the rest is summarised
};
export const MAX_TURN_S = 9;
/** Open-loop turn rate at full stick and 100 % speed: 2 x 0.35 m/s / 0.2 m track = 3.5 rad/s, as the twin turns. */
export const TURN_DEG_S = 200;
export const MOTION_TOOLS = new Set(["drive", "turn", "look", "set_joints", "gesture", "pose", "torso"]);

/** Stick vectors [x (right +), y (forward +)] per drive direction, as the D-pad (0.6 turn) sends them. */
export const DIRECTIONS = {
  forward: [0, 1],
  back: [0, -1],
  left: [-0.6, 0],
  right: [0.6, 0],
  forward_left: [-0.5, 1],
  forward_right: [0.5, 1],
};
const DIRECTION_ALIASES = { backward: "back", backwards: "back", reverse: "back", forwards: "forward", ahead: "forward", straight: "forward" };

const num = (min, max, description, extra = {}) => ({ kind: "number", min, max, description, ...extra });
const en = (values, description, extra = {}) => ({ kind: "enum", values, description, ...extra });
const str = (maxLength, description) => ({ kind: "string", maxLength, description });

const jointRange = (def, name) => {
  const j = def.joints.find((x) => x.name === name);
  return j ? [j.min / 10, j.max / 10] : [0, 0];
};

const cache = new Map();
/** Tool table for one body: Map name -> { description, params: { name: spec }, required: [names] }. */
function defsFor(bodyKey) {
  if (cache.has(bodyKey)) return cache.get(bodyKey);
  const body = P.bodyByKey(bodyKey);
  const def = P.BODIES[body];
  const t = new Map();
  if (def) {
    t.set("wait", { description: "Pause for a number of seconds before the next step.", params: { seconds: num(...LIMITS.WAIT_S, "Seconds to wait.") }, required: ["seconds"] });
    t.set("say", { description: "Show a short message to the user. It does not move the robot.", params: { text: str(LIMITS.SAY_MAX, "Message, plain text, 200 characters at most.") }, required: ["text"] });
    t.set("stop", { description: "Stop the robot at once and end the plan. The robot then needs the human to press ARM again. Use only when asked to stop.", params: {}, required: [] });
    const speed = num(...LIMITS.SPEED, "Percent of the user's speed setting (10 to 100). It can only be slower than their cap, never faster.", { default: 100 });
    if (def.drive) {
      t.set("drive", {
        description: "Drive the wheels in a direction for a number of seconds (3 at most per step), then stop.",
        params: { direction: en(Object.keys(DIRECTIONS), "Direction. left and right spin in place."), seconds: num(...LIMITS.DRIVE_S, "Seconds to drive.", { default: 1 }), speed },
        required: ["direction"],
      });
      t.set("turn", {
        description: "Turn in place by an angle. Open loop (timed, not measured), so the angle is approximate.",
        params: { degrees: num(...LIMITS.TURN_DEG, "Degrees. Positive = left (counter-clockwise), negative = right."), speed },
        required: ["degrees"],
      });
    }
    if (body === P.BODY.ROVER || body === P.BODY.DESK) {
      const [pmin, pmax] = jointRange(def, "head_pan");
      const [tmin, tmax] = jointRange(def, "head_tilt");
      t.set("look", {
        description: "Move the head. Give pan, tilt or both; an axis you leave out stays where it is.",
        params: { pan: num(pmin, pmax, "Degrees. Positive = left, negative = right, 0 = straight ahead."), tilt: num(tmin, tmax, "Degrees. Positive = up, negative = down, 0 = level.") },
        required: [],
        atLeastOne: ["pan", "tilt"],
      });
    }
    if (body === P.BODY.DESK) {
      const params = {};
      for (const j of def.joints) params[j.name] = num(j.min / 10, j.max / 10, `${j.name.replace(/_/g, " ")} in degrees (${j.min / 10} to ${j.max / 10}).`);
      t.set("set_joints", { description: "Set any of the Desk's joints to angles in degrees. Joints you leave out stay where they are.", params, required: [], jointsTool: true });
      t.set("gesture", { description: "Play a built-in gesture.", params: { name: en(Object.keys(GESTURES), "Gesture name. home returns to the neutral pose.") }, required: ["name"] });
    }
    if (body === P.BODY.WALKER) {
      t.set("pose", { description: "Hold a still pose. The Walker cannot walk.", params: { name: en(Object.keys(POSES), "Pose name.", { fold: "space" }) }, required: ["name"] });
      const [ymin, ymax] = jointRange(def, "torso_yaw");
      t.set("torso", { description: "Turn the torso.", params: { yaw: num(ymin, ymax, "Degrees. Positive = left, negative = right, 0 = straight.") }, required: ["yaw"] });
    }
  }
  cache.set(bodyKey, t);
  return t;
}

/** Names of the tools a body offers. */
export const toolNames = (bodyKey) => [...defsFor(bodyKey).keys()];

function propertySpec(p) {
  if (p.kind === "number") return { type: "number", description: p.description, minimum: p.min, maximum: p.max, ...(p.default !== undefined ? { default: p.default } : {}) };
  if (p.kind === "enum") return { type: "string", description: p.description, enum: [...p.values] };
  return { type: "string", description: p.description, maxLength: p.maxLength };
}

/** OpenAI-style tool specs for a body. Unknown body: no tools. */
export function toolsFor(bodyKey) {
  return [...defsFor(bodyKey)].map(([name, d]) => ({
    type: "function",
    function: {
      name,
      description: d.description,
      parameters: {
        type: "object",
        properties: Object.fromEntries(Object.entries(d.params).map(([k, p]) => [k, propertySpec(p)])),
        required: [...d.required],
        additionalProperties: false,
      },
    },
  }));
}

// ---------------------------------------------------------------- cleaning helpers

// Controls (Cc), format characters (Cf: zero-width, bidi overrides and isolates, tags, interlinear annotations) and
// line/paragraph separators: invisible, and useful only to spoof text. U+061C, U+180E, U+FFF9-FFFB and the tag block
// U+E0000-E007F are listed as well, for engines whose Unicode tables are older.
const INVISIBLE = /[\p{Cc}\p{Cf}\u2028\u2029\u061C\u180E\uFFF9-\uFFFB\u{E0000}-\u{E007F}]/gu;
/** A short plain-text message: no control or bidi characters, whitespace collapsed, 200 characters at most. */
export function cleanSay(text, max = LIMITS.SAY_MAX) {
  if (typeof text !== "string") return "";
  return text.replace(/[\t\r\n]+/g, " ").replace(INVISIBLE, "").replace(/ {2,}/g, " ").trim().slice(0, max);
}
const short = (v, n = 40) => cleanSay(typeof v === "string" ? v : Object.prototype.toString.call(v), n) || "?";
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const own = (o, k) => (Object.hasOwn(o, k) ? o[k] : undefined);
const NUMERIC = /^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i;
const round2 = (x) => {
  const r = Math.round(x * 100) / 100;
  return r === 0 ? 0 : r;
};

class Reject extends Error {}
const reject = (msg) => {
  throw new Reject(msg);
};

function readNumber(v, name) {
  let n = null;
  if (typeof v === "number") n = v;
  else if (typeof v === "string" && NUMERIC.test(v.trim())) n = Number(v.trim());
  if (n === null || !Number.isFinite(n)) reject(`${name}: not a number`);
  return n;
}
function readEnum(v, p, name) {
  if (typeof v !== "string") reject(`${name}: not a name`);
  let s = v.trim().toLowerCase();
  if (p.fold === "space") s = s.replace(/[_-]+/g, " ").replace(/ {2,}/g, " ");
  else s = s.replace(/[\s-]+/g, "_");
  if (name === "direction" && Object.hasOwn(DIRECTION_ALIASES, s)) s = DIRECTION_ALIASES[s];
  if (!p.values.includes(s)) reject(`${name}: '${short(v, 24)}' is not one of ${p.values.length} allowed values`);
  return s;
}
function readParam(src, key, p, { required }) {
  const v = src === null ? undefined : own(src, key);
  if (v === undefined || v === null) {
    if (required) reject(`${key} is required`);
    return undefined;
  }
  if (p.kind === "number") return round2(Math.min(p.max, Math.max(p.min, readNumber(v, key))));
  if (p.kind === "enum") return readEnum(v, p, key);
  const s = cleanSay(v, p.maxLength);
  if (!s) reject(`${key}: empty`);
  return s;
}

/** Reads one raw entry into { name, args, flat }: flat fields, { args }, { arguments: object | JSON string }, or an OpenAI call. */
function unpack(e) {
  if (!isObj(e)) reject("not a step");
  const fn = isObj(e.function) ? e.function : null;
  const name = e.tool ?? e.name ?? (fn ? fn.name : undefined);
  const hasArgs = e.args !== undefined || e.arguments !== undefined || e.parameters !== undefined || (fn !== null && fn.arguments !== undefined);
  let args = e.args ?? e.arguments ?? e.parameters ?? (fn ? fn.arguments : undefined);
  if (typeof args === "string") {
    try {
      args = JSON.parse(args);
    } catch {
      args = null;
    }
  }
  return { name, src: hasArgs ? (isObj(args) ? args : {}) : e };
}

function checkStep(entry, bodyKey, defs) {
  const { name, src } = unpack(entry);
  if (typeof name !== "string") reject("no tool name");
  const key = name.trim().toLowerCase();
  const d = defs.get(key);
  if (!d) reject(`unknown tool '${short(name)}' for this body`);
  const step = { tool: key };
  if (d.jointsTool) {
    const joints = {};
    const from = isObj(own(src, "joints")) ? src.joints : src;
    for (const [jn, p] of Object.entries(d.params)) {
      const v = readParam(from, jn, p, { required: false });
      if (v !== undefined) joints[jn] = v;
    }
    if (!Object.keys(joints).length) reject("set_joints needs at least one joint");
    step.joints = joints;
    return step;
  }
  for (const [pn, p] of Object.entries(d.params)) {
    let v = readParam(src, pn, p, { required: d.required.includes(pn) });
    if (v === undefined && p.default !== undefined) v = p.default;
    if (v !== undefined) step[pn] = v;
  }
  if (d.atLeastOne && !d.atLeastOne.some((k) => step[k] !== undefined)) reject(`${key} needs ${d.atLeastOne.join(" or ")}`);
  return step;
}

// ---------------------------------------------------------------- durations (estimates, for the 30 s budget and the UI)

/** Seconds an open-loop turn takes at the given step speed and user speed (both percent). 0 for 0 degrees. */
export function turnSeconds(degrees, speedPct, userSpeedPct) {
  if (!degrees) return 0;
  const rate = TURN_DEG_S * (Math.max(1, speedPct) / 100) * (Math.max(1, userSpeedPct) / 100);
  return Math.min(MAX_TURN_S, Math.abs(degrees) / rate);
}

/** Rough duration of a step in seconds (the real time depends on the robot's speed). */
export function stepSeconds(step, userSpeed = 60) {
  switch (step.tool) {
    case "wait":
    case "drive":
      return step.seconds;
    case "turn":
      return turnSeconds(step.degrees, step.speed ?? 100, userSpeed);
    case "gesture":
      return gestureMs(step.name) / 1000 + 1.5;
    case "pose":
      return 2;
    case "look":
    case "set_joints":
    case "torso":
      return 1.5;
    default:
      return 0;
  }
}

// ---------------------------------------------------------------- validatePlan

/**
 * validatePlan(raw, bodyKey, { userSpeed }) -> { steps, rejected: [{ index, reason }] }.
 * userSpeed: the robot's live speed setting (percent), so the 30 s budget holds at a low speed too (turns slow down).
 * raw: an array of steps, or { steps: [...] }. A step: { tool, ...fields }, { tool, args }, { name, arguments } or an
 * OpenAI tool call. Never throws. Steps are normalised to { tool, ...clamped fields } (set_joints: { tool, joints }).
 */
export function validatePlan(raw, bodyKey, { userSpeed = 60 } = {}) {
  const steps = [];
  const rejected = [];
  let dropped = 0;
  const note = (index, reason) => {
    if (rejected.length < LIMITS.REJECTED_MAX) rejected.push({ index, reason: String(reason).slice(0, 120) });
    else dropped++;
  };
  let list = [];
  try {
    if (Array.isArray(raw)) list = raw;
    else if (isObj(raw) && Array.isArray(raw.steps)) list = raw.steps;
    else if (isObj(raw) && (raw.tool !== undefined || raw.name !== undefined || raw.function !== undefined)) list = [raw];
  } catch {
    list = [];
  }
  const defs = defsFor(bodyKey);
  let total = 0;
  let limited = 0;
  let stopped = false;
  const n = Math.min(list.length, LIMITS.SCAN_MAX);
  for (let i = 0; i < n; i++) {
    if (limited) {
      limited++;
      continue;
    }
    let step;
    try {
      step = checkStep(list[i], bodyKey, defs);
    } catch (e) {
      note(i, e instanceof Reject ? e.message : "unreadable step");
      continue;
    }
    if (stopped) {
      note(i, "ignored: the plan ends at stop");
      continue;
    }
    const secs = stepSeconds(step, Number.isFinite(userSpeed) ? userSpeed : 60);
    if (steps.length >= LIMITS.MAX_STEPS || total + secs > LIMITS.MAX_TOTAL_S) {
      limited = 1;
      continue;
    }
    total += secs;
    steps.push(step);
    if (step.tool === "stop") stopped = true;
  }
  limited += Math.max(0, list.length - n);
  if (limited || dropped) {
    const more = limited + dropped;
    rejected.push({ index: steps.length, reason: `Plan limit is ${LIMITS.MAX_STEPS} steps and ${LIMITS.MAX_TOTAL_S} s in total: ${more} more ${more === 1 ? "step" : "steps"} dropped.` });
  }
  return { steps, rejected };
}

// ---------------------------------------------------------------- reading a step back to the user

const fmt = (n) => String(round2(n));
const side = (deg) => (deg >= 0 ? "left" : "right");
/** A short English description of a validated step, for the plan card and the interruption note. */
export function describeStep(s) {
  const at = s.speed !== undefined && s.speed < 100 ? ` at ${fmt(s.speed)}%` : "";
  switch (s.tool) {
    case "drive":
      return `drive ${s.direction} ${fmt(s.seconds)} s${at}`;
    case "turn":
      return `turn ${side(s.degrees)} about ${fmt(Math.abs(s.degrees))}°${at}`;
    case "look": {
      const parts = [];
      if (s.pan !== undefined) parts.push(s.pan === 0 ? "pan centre" : `${side(s.pan)} ${fmt(Math.abs(s.pan))}°`);
      if (s.tilt !== undefined) parts.push(s.tilt === 0 ? "tilt level" : `${s.tilt > 0 ? "up" : "down"} ${fmt(Math.abs(s.tilt))}°`);
      return `look ${parts.join(", ")}`;
    }
    case "set_joints":
      return `set joints: ${Object.entries(s.joints || {}).map(([k, v]) => `${k.replace(/_/g, " ")} ${fmt(v)}°`).join(", ")}`;
    case "gesture":
      return `gesture: ${s.name}`;
    case "pose":
      return `pose: ${s.name}`;
    case "torso":
      return s.yaw === 0 ? "torso straight" : `torso turn ${side(s.yaw)} ${fmt(Math.abs(s.yaw))}°`;
    case "wait":
      return `wait ${fmt(s.seconds)} s`;
    case "say":
      return `say "${s.text.length > 40 ? `${s.text.slice(0, 40)}…` : s.text}"`;
    case "stop":
      return "stop";
    default:
      return String(s.tool);
  }
}
