// AI Pilot, built-in parser: plain English to a plan with no model at all, so the AI panel works out of the box.
//
//   input  := clause (SEP clause)*          SEP := "then" | "and then" | "," | ";" | "." | "!" | "?"
//   clause := move | turn | look | act | wait | speed | stop      (a clause that fails is retried split on "and")
//   number := digits | one..ten | half
//
// Every plan goes through validatePlan, so the parser and the model share one set of limits. Body gating comes
// first: "The Rover has no arms." Angles follow the twin's joints: positive turn / pan = left, positive tilt = up.
import * as P from "../ax-proto.js";
import { LIMITS, validatePlan, cleanSay } from "./tools.js";

export const BODY_NAME = { rover: "Rover", desk: "Desk", walker: "Walker" };
export const HINTS = {
  rover: "forward 2 s, turn left, look up, stop",
  desk: "wave, nod, look left, turn right",
  walker: "stand, crouch, lean left, twist",
};

const MAX_TEXT = 2000;
const MAX_CLAUSES = 40;
const SPEEDS = { slow: 40, fast: 100, slower: 0.6, faster: 1.5 };

const NUMWORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, half: 0.5 };
const UNITS = { s: "s", sec: "s", secs: "s", second: "s", seconds: "s", ms: "ms", msec: "ms", millisecond: "ms", milliseconds: "ms", deg: "deg", degs: "deg", degree: "deg", degrees: "deg", "%": "pct", pct: "pct", percent: "pct" };
const DIST = new Set(["m", "meter", "meters", "metre", "metres", "cm", "centimeter", "centimeters", "mm", "foot", "feet", "ft", "inch", "inches", "step", "steps", "mile", "miles", "km"]);
const FILLER = new Set(["please", "kindly", "now", "just", "robot", "the", "a", "an", "to", "for", "by", "about", "you", "can", "could", "will", "would", "i", "want", "like", "me", "my", "hey", "ok", "okay", "also", "little", "bit", "maybe", "some", "at", "it", "so", "there", "ax", "ax-1", "ax1", "then", "and"]);
// "and" stays a filler only inside a clause that parsed; a clause that did not is retried split on "and" first

const set = (...w) => new Set(w);
const FORWARD = set("forward", "forwards", "ahead", "straight", "advance");
const BACK = set("back", "backward", "backwards", "reverse", "retreat");
const LEFT = set("left");
const RIGHT = set("right");
const UP = set("up", "upward", "upwards");
const DOWN = set("down", "downward", "downwards");
const CENTER = set("center", "centre", "middle", "ahead", "forward", "straight", "home", "neutral");
const STOPS = set("stop", "halt", "freeze", "brake", "abort");
const WAITS = set("wait", "pause", "sleep", "rest", "hang");
const SPEEDW = set("slow", "slowly", "slower", "fast", "faster", "quickly", "quick", "hurry", "speed", "full");
const MOVES = set("go", "move", "drive", "advance", "forward", "forwards", "ahead", "straight", "back", "backward", "backwards", "reverse", "retreat");
const TURNS = set("turn", "rotate", "spin", "pivot", "veer");
const LOOKS = set("look", "face", "glance", "peek", "pan", "tilt", "head");
const ACTS = set("wave", "nod", "point", "shrug", "home", "reset", "neutral", "stand", "crouch", "squat", "duck", "lean", "twist", "hello", "hi", "greet", "yes");

// ---------------------------------------------------------------- tokens

function tokenize(clause) {
  const s = clause
    .toLowerCase()
    .replace(/\bax-?1\b/g, " ")
    .replace(/°/g, " deg ")
    .replace(/%/g, " % ")
    .replace(/[^a-z0-9.%+\- ]/g, " ")
    .replace(/(?<=[a-z])-(?=[a-z])/g, " ")
    .replace(/(\d)([a-z])/g, "$1 $2")
    .replace(/([a-z])(\d)/g, "$1 $2");
  return s
    .split(/\s+/)
    .map((w) => w.replace(/\.+$/, ""))
    .filter((w) => w && w !== "-" && w !== "+" && w !== ".")
    .map((w) => ({ w, used: false }));
}
const isNum = (w) => /^[+-]?(\d+\.?\d*|\.\d+)$/.test(w) || Object.hasOwn(NUMWORDS, w);
const numVal = (w) => (Object.hasOwn(NUMWORDS, w) ? NUMWORDS[w] : Number(w));

/** Splits at separators. "1.5" keeps its dot. */
function splitClauses(text) {
  return text
    .split(/\s*(?:[,;!?\n]|\.(?!\d)|\band then\b|\bthen\b|\bafter that\b|\bnext\b)\s*/i)
    .map((c) => c.trim())
    .filter(Boolean);
}

// ---------------------------------------------------------------- one clause

/** Parses one clause. Returns { steps, notes } (steps may be empty when the body cannot do it), or null if not understood. */
function parseClause(text, ctx) {
  const toks = tokenize(text).filter((t) => !FILLER.has(t.w) || t.w === "and");
  const body = ctx.body;
  const name = BODY_NAME[body];
  const out = { steps: [], notes: [] };
  const find = (s) => toks.find((t) => !t.used && s.has(t.w));
  const take = (s) => {
    const t = find(s);
    if (t) t.used = true;
    return t;
  };
  /** First unused number with its unit (the token right after it). Returns { value, unit } or null. */
  const amountAt = (i) => {
    const t = toks[i];
    if (!t || t.used || !isNum(t.w)) return null;
    t.used = true;
    let unit = null;
    const nx = toks[i + 1];
    if (nx && !nx.used && Object.hasOwn(UNITS, nx.w)) (unit = UNITS[nx.w]), (nx.used = true);
    return { value: numVal(t.w), unit };
  };
  const amount = () => amountAt(toks.findIndex((t) => !t.used && isNum(t.w)));
  const done = () => {
    const rest = toks.filter((t) => !t.used && t.w !== "and");
    if (rest.some((t) => DIST.has(t.w))) ctx.distHint = true;
    return rest.length === 0 ? out : null;
  };
  const verbTok = toks.find((t) => !t.used && (STOPS.has(t.w) || WAITS.has(t.w) || TURNS.has(t.w) || LOOKS.has(t.w) || ACTS.has(t.w) || MOVES.has(t.w) || SPEEDW.has(t.w) || t.w === "hold"));
  if (!verbTok) return null;
  const verb = verbTok.w;
  const hasDir = () => !!(find(LEFT) || find(RIGHT));

  // a speed modifier inside a move or turn clause: "slowly", "fast", "speed 50 %"
  const speedHere = () => {
    const sp = find(set("speed"));
    if (sp) {
      sp.used = true;
      const a = amountAt(toks.indexOf(sp) + 1); // the number right after the word, not the 2 in "forward 2 s at speed 50"
      if (a && (a.unit === "pct" || a.unit === null)) {
        const pct = take(set("%", "pct", "percent"));
        if (pct) pct.used = true;
        return clampSpeed(a.value <= 1 && !pct ? a.value * 100 : a.value, out.notes);
      }
      return null;
    }
    if (take(set("slow", "slowly"))) return SPEEDS.slow;
    if (take(set("fast", "quickly", "quick", "hurry"))) return SPEEDS.fast;
    return null;
  };

  // ---- stop: anything after it is ignored
  if (STOPS.has(verb) && toks.indexOf(verbTok) === toks.findIndex((t) => !t.used)) {
    out.steps.push({ tool: "stop" });
    return out;
  }

  // ---- wait
  if (WAITS.has(verb) || verb === "hold") {
    verbTok.used = true;
    take(set("on", "up"));
    const a = amount();
    let secs = 1;
    if (a) {
      if (a.unit === "deg" || a.unit === "pct") return null;
      secs = a.unit === "ms" ? a.value / 1000 : a.value;
    }
    if (secs > LIMITS.WAIT_S[1]) out.notes.push(`I wait at most ${LIMITS.WAIT_S[1]} s per step; you asked for ${fmt(secs)} s.`);
    out.steps.push({ tool: "wait", seconds: secs });
    return done();
  }

  // ---- speed (a clause of its own: it applies to the clauses after it)
  if (SPEEDW.has(verb) && !MOVES.has(verb)) {
    let sp = null;
    const t = verbTok;
    t.used = true;
    if (verb === "speed") {
      if (take(UP)) sp = Math.min(100, ctx.speed * SPEEDS.faster);
      else {
        const a = amount();
        if (a && (a.unit === "pct" || a.unit === null)) {
          const pct = take(set("%", "pct", "percent"));
          sp = clampSpeed(a.value <= 1 && a.unit === null && !pct ? a.value * 100 : a.value, out.notes);
        }
      }
    } else if (verb === "full") {
      take(set("speed"));
      sp = 100;
    } else if (verb === "slower") sp = Math.max(LIMITS.SPEED[0], ctx.speed * SPEEDS.slower);
    else if (verb === "faster") sp = Math.min(100, ctx.speed * SPEEDS.faster);
    else if (verb === "slow" || verb === "slowly") sp = take(DOWN) ? Math.max(LIMITS.SPEED[0], ctx.speed * SPEEDS.slower) : SPEEDS.slow;
    else sp = SPEEDS.fast;
    if (sp === null) return null;
    take(set("speed"));
    ctx.speed = Math.round(sp);
    return done();
  }

  // ---- turn (and "twist left" on the Walker)
  if (TURNS.has(verb) || (verb === "twist" && body === "walker" && hasDir())) {
    verbTok.used = true;
    let sign = 0;
    let degrees = null;
    let around = false;
    if (take(LEFT)) sign = 1;
    else if (take(RIGHT)) sign = -1;
    else if (take(set("around", "about")) || take(BACK)) around = true;
    const spd = speedHere();
    const a = amount();
    if (a) {
      if (a.unit && a.unit !== "deg") return null;
      degrees = a.value;
    }
    if (!sign && !around && degrees === null) return null; // which way?
    if (around) (degrees = degrees ?? 180), (sign = 1);
    else if (!sign) sign = degrees < 0 ? -1 : 1;
    degrees = Math.abs(degrees ?? (body === "walker" ? 30 : 90)) * sign;
    const lim = body === "rover" ? 180 : body === "desk" ? 120 : 60;
    if (Math.abs(degrees) > lim) out.notes.push(body === "rover" ? `I turn at most ${lim}° per step; you asked for ${fmt(Math.abs(degrees))}°.` : `The ${name}'s body turn stops at ${lim}°; you asked for ${fmt(Math.abs(degrees))}°.`);
    if (body === "rover") out.steps.push({ tool: "turn", degrees, speed: spd ?? ctx.speed });
    else if (body === "desk") out.steps.push({ tool: "set_joints", joints: { torso_yaw: degrees } });
    else out.steps.push({ tool: "torso", yaw: degrees });
    return done();
  }

  // ---- look / pan / tilt
  if (LOOKS.has(verb) && !(verb === "head" && !find(set("left", "right", "up", "down")))) {
    verbTok.used = true;
    if (body === "walker") {
      for (const t of toks) if (!t.used && (LEFT.has(t.w) || RIGHT.has(t.w) || UP.has(t.w) || DOWN.has(t.w) || CENTER.has(t.w) || isNum(t.w) || Object.hasOwn(UNITS, t.w))) t.used = true;
      return gate(out, `The ${name} has no head to move.`, done);
    }
    const axisOnly = verb === "pan" ? "pan" : verb === "tilt" ? "tilt" : null;
    let pan;
    let tilt;
    const dirs = [];
    for (const t of toks) {
      if (t.used) continue;
      if (LEFT.has(t.w)) dirs.push(["pan", 1, t]);
      else if (RIGHT.has(t.w)) dirs.push(["pan", -1, t]);
      else if (UP.has(t.w)) dirs.push(["tilt", 1, t]);
      else if (DOWN.has(t.w)) dirs.push(["tilt", -1, t]);
    }
    for (const d of dirs) d[2].used = true;
    const a = amount();
    if (a && a.unit && a.unit !== "deg") return null;
    const num = a ? a.value : null;
    if (dirs.length) {
      let numUsed = false;
      for (const [axis, sgn] of dirs) {
        const useNum = num !== null && !numUsed && (!axisOnly || axisOnly === axis);
        const mag = useNum ? Math.abs(num) : axis === "pan" ? 45 : 20;
        numUsed = numUsed || useNum;
        if (axis === "pan") pan = sgn * mag;
        else tilt = sgn * mag;
      }
      if (num !== null && !numUsed) return null;
    } else if (axisOnly && num !== null) {
      if (axisOnly === "pan") pan = num;
      else tilt = num;
    } else if (!axisOnly && num === null && take(CENTER)) {
      pan = 0;
      tilt = 0;
    } else if (axisOnly && take(CENTER)) {
      if (axisOnly === "pan") pan = 0;
      else tilt = 0;
    } else return null;
    const def = P.BODIES[P.bodyByKey(body)];
    for (const [label, v, jn] of [["Pan", pan, "head_pan"], ["Tilt", tilt, "head_tilt"]]) {
      if (v === undefined) continue;
      const j = def.joints.find((x) => x.name === jn);
      if (v > j.max / 10 || v < j.min / 10) out.notes.push(`${label} stops at ${v > 0 ? j.max / 10 : j.min / 10}° on the ${name}; you asked for ${fmt(v)}°.`);
    }
    const step = { tool: "look" };
    if (pan !== undefined) step.pan = pan;
    if (tilt !== undefined) step.tilt = tilt;
    out.steps.push(step);
    return done();
  }

  // ---- acts: gestures, poses, home
  if (ACTS.has(verb) && !MOVES.has(verb)) {
    verbTok.used = true;
    const arms = set("wave", "point", "shrug", "hello", "hi", "greet");
    const legsSet = set("stand", "crouch", "squat", "duck", "lean", "twist");
    if (body === "rover") {
      if (verb === "home" || verb === "reset" || verb === "neutral") out.steps.push({ tool: "look", pan: 0, tilt: 0 });
      else if (arms.has(verb)) return gate(out, `The ${name} has no arms.`, done);
      else if (verb === "nod" || verb === "yes") return gate(out, `The ${name} can't nod. Try 'look up' or 'look down'.`, done);
      else return gate(out, `The ${name} has no legs.`, done);
      return done();
    }
    if (body === "desk") {
      if (legsSet.has(verb)) return gate(out, `The ${name} has no legs.`, done);
      const g = { wave: "wave", hello: "wave", hi: "wave", greet: "wave", nod: "nod", yes: "nod", point: "point", shrug: "shrug", home: "home", reset: "home", neutral: "home" }[verb];
      out.steps.push({ tool: "gesture", name: g });
      return done();
    }
    // walker
    if (arms.has(verb)) return gate(out, `The ${name} has no arms.`, done);
    if (verb === "nod" || verb === "yes") return gate(out, `The ${name} has no head to move.`, done);
    if (verb === "stand") take(UP), out.steps.push({ tool: "pose", name: "stand" });
    else if (verb === "home" || verb === "reset" || verb === "neutral") out.steps.push({ tool: "pose", name: "stand" });
    else if (verb === "crouch" || verb === "squat" || verb === "duck") out.steps.push({ tool: "pose", name: "crouch" });
    else if (verb === "twist") out.steps.push({ tool: "pose", name: "twist" });
    else if (verb === "lean") {
      if (take(LEFT)) out.steps.push({ tool: "pose", name: "lean left" });
      else if (take(RIGHT)) out.steps.push({ tool: "pose", name: "lean right" });
      else return null;
    }
    return done();
  }

  // ---- move
  if (MOVES.has(verb)) {
    verbTok.used = true;
    const fw = FORWARD.has(verb) || take(FORWARD) !== undefined; // the verb itself may be the direction: "back 3 s"
    const bk = BACK.has(verb) || take(BACK) !== undefined;
    if (fw && bk) return null; // "forward and back": two clauses
    const l = take(LEFT) !== undefined;
    const r = take(RIGHT) !== undefined;
    const spd = speedHere();
    const a = amount();
    let secs = 1;
    if (a) {
      if (a.unit && a.unit !== "s" && a.unit !== "ms") return null;
      secs = a.unit === "ms" ? a.value / 1000 : a.value;
    }
    if (body !== "rover") {
      const why = body === "desk" ? `The ${name} has no wheels.` : `The ${name} can't walk yet. It only holds poses: stand, crouch, lean left, lean right, twist.`;
      return gate(out, why, done);
    }
    if (!bk && !fw && (l || r)) {
      // "go left": a rover has no sideways drive, so that means turning
      out.steps.push({ tool: "turn", degrees: l ? 90 : -90, speed: spd ?? ctx.speed });
      return done();
    }
    const direction = bk ? "back" : fw && l ? "forward_left" : fw && r ? "forward_right" : "forward";
    if (secs > LIMITS.DRIVE_S[1]) out.notes.push(`I drive at most ${LIMITS.DRIVE_S[1]} s per step; you asked for ${fmt(secs)} s.`);
    out.steps.push({ tool: "drive", direction, seconds: secs, speed: spd ?? ctx.speed });
    return done();
  }
  return null;
}

const fmt = (n) => String(Math.round(n * 100) / 100);
function clampSpeed(v, notes) {
  const c = Math.min(100, Math.max(LIMITS.SPEED[0], v));
  if (c !== v) notes.push(`Speed is limited to ${LIMITS.SPEED[0]} to 100 % of your speed setting.`);
  return c;
}
/** A clause the body cannot do: understood, but nothing to run. Leftover words still make it "not understood". */
function gate(out, message, done) {
  out.notes.push(message);
  return done();
}

// ---------------------------------------------------------------- the whole text

/** parseCommand(text, bodyKey, { userSpeed }) -> { steps, say, unknown: [clause text], rejected } */
export function parseCommand(text, bodyKey, { userSpeed } = {}) {
  const body = typeof bodyKey === "string" && Object.hasOwn(BODY_NAME, bodyKey) ? bodyKey : null;
  const result = { steps: [], say: "", unknown: [], rejected: [] };
  if (!body) {
    result.say = "I don't know this robot body.";
    return result;
  }
  const input = typeof text === "string" ? text.slice(0, MAX_TEXT) : "";
  const clauses = splitClauses(input).slice(0, MAX_CLAUSES);
  if (!clauses.length) {
    result.say = `Tell me what to do. Try: ${HINTS[body]}.`;
    return result;
  }
  const ctx = { body, speed: 100, distHint: false };
  const raw = [];
  const notes = [];
  const attempt = (clause) => {
    const snapshot = ctx.speed;
    const r = parseClause(clause, ctx);
    if (r === null) ctx.speed = snapshot;
    return r;
  };
  for (const clause of clauses) {
    let r = attempt(clause);
    if (r === null && /\band\b/i.test(clause)) {
      const parts = clause.split(/\band\b/i).map((x) => x.trim()).filter(Boolean);
      const speed0 = ctx.speed;
      const rs = parts.map(attempt);
      if (parts.length > 1 && rs.every((x) => x !== null)) r = { steps: rs.flatMap((x) => x.steps), notes: rs.flatMap((x) => x.notes) };
      else ctx.speed = speed0;
    }
    if (r === null) {
      result.unknown.push(cleanSay(clause, 40));
      continue;
    }
    raw.push(...r.steps);
    notes.push(...r.notes);
  }
  const v = validatePlan(raw, body, { userSpeed });
  result.steps = v.steps;
  result.rejected = v.rejected;
  if (v.rejected.some((x) => /Plan limit/.test(x.reason))) notes.push(`I kept the first ${v.steps.length} steps: the limit is ${LIMITS.MAX_STEPS} steps and ${LIMITS.MAX_TOTAL_S} s in total.`);
  const parts = [...new Set(notes)];
  if (result.unknown.length) {
    parts.push(`I didn't understand ${result.unknown.map((u) => `'${u}'`).join(", ")}. Try: ${HINTS[body]}.`);
    if (ctx.distHint) parts.push("I can only drive by time (seconds), not distance.");
  }
  result.say = parts.join(" ");
  return result;
}
