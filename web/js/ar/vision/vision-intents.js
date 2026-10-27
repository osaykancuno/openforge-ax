// AR Rover, object intents for the voice parser: an ar-parse extension.
//
//   "what do you see" / "do you see a cup"     -> a say plan (runs without ARM): up to 3 things, direction, distance
//   "go to the cup"                            -> say, turn, drive (the pilot's own validated tools), then seek.js re-plans
//   "find the cup"                             -> a scan: turn 60 degrees, wait 1 s, six times; seek.js stops it when seen
//   "avoid the chair" / "stop avoiding ..."    -> a say plan; a 0.3 m keep-out disc follows the chair
//
// EXTENSION CONTRACT (ar-parse.js): (text, bodyKey, ctx) => null | { steps, say, unknown, rejected }. null = not ours.
// Plans use only the existing tools say / turn / drive / wait and always go through validatePlan: this file cannot make
// the Rover do anything the plain parser could not. Labels are untrusted: only a COCO-80 name (or an alias) is ever
// acted on, and a refusal never repeats what the user typed.
//
// In the camera view the twin is not in the room and there is no depth: go to / find / avoid answer honestly.
import { cleanSay, validatePlan } from "../../pilot/ai/tools.js";
import { VMAX } from "../../pilot/twin-pose.js";
import { LIMITS } from "../seek.js";
import { KEEP_OUT_M, canonicalLabel, describeObject, displayName, toRoverFrame, whereText, withArticle } from "./world-objects.js";

export { VMAX };
export const CAMERA_ONLY = "The twin is not in your room here; I can only tell you what the camera sees.";
export const STOP_SHORT_M = 0.3; // the plan aims to end this far from the object's centre
export const MAX_AVOID = 5;
export const SCAN = { TURNS: 6, DEGREES: 60, WAIT_S: 1 }; // 6 turns + 5 waits + 1 say = the 12 steps of a plan

const MAX_TEXT = 200;
const SHOW_MAX = 3;
const MIN_TURN_DEG = 3;
const REFUSE = "I can only look for everyday objects, like a cup, a chair or a person.";
const ONE_AT_A_TIME = "Ask me for one object at a time, for example 'go to the cup'.";
const LOOK_OFF = "Turn on Look around first, then I can use the camera to find things.";

// first words that make "go to ..." an ordinary movement for the built-in parser ("go to the left", "go to sleep")
const NOT_OBJECTS = new Set(["left", "right", "forward", "forwards", "back", "backward", "backwards", "ahead", "straight", "center", "centre", "middle", "home", "sleep", "rest", "me", "here", "there", "up", "down", "around", "away", "sideways", "it", "end", "start"]);

const PREFIX = /^(?:hey|ok|okay|hi|please|kindly|robot|ax-?1|ax|tell me|could you|can you|would you|will you|i want you to|i'd like you to|let's|lets)\b[ ,]*/;
const SUFFIX = /[ ,]*\b(?:please|now|for me|thanks|thank you)$/;
const ARTICLE = /^(?:the|an?|that|this|my|your|our|some|any)\s+/;

const SEE = /^(?:what (?:do|can) you see(?: (?:around|here|now|there|right now))?|what are you (?:seeing|looking at)|what you (?:can )?see|what(?:'s| is) (?:around|in front of|near|here)(?: you| me)?|describe (?:what you see|the room))$/;
const SEE_ANY = new Set(["anything", "something", "any objects", "objects", "things", "anything here", "anything there"]);
const DO_SEE = /^(?:do you see|is there|are there) (.+)$/;
const GOTO = /^(?:go|drive|move|head|navigate|come|roll|walk|run) (?:over |up )?(?:to|towards?) (.+)$/;
const FIND = /^(?:find|look for|look around for|search for|locate|where(?:'s| is| are)) (.+)$/;
const AVOID = /^(?:avoid|stay away from|keep away from|steer clear of|dodge|don't (?:hit|touch|bump into)|do not (?:hit|touch|bump into)) (.+)$/;
const UNAVOID = /^(?:stop avoiding|don't avoid|do not avoid|forget about avoiding|no longer avoid|clear (?:the )?(?:avoid|avoiding|avoidance))(?: (.+))?$/;

const round1 = (n) => Math.round(n * 10) / 10;
const round2 = (n) => Math.round(n * 100) / 100;

function normalise(text) {
  let s = cleanSay(text, MAX_TEXT).toLowerCase().replace(/\s+/g, " ");
  s = s.replace(/[.!?\s]+$/, "");
  for (let i = 0; i < 4 && PREFIX.test(s); i++) s = s.replace(PREFIX, "");
  for (let i = 0; i < 3 && SUFFIX.test(s); i++) s = s.replace(SUFFIX, "");
  return s.replace(/[.!?\s]+$/, "").trim();
}

/** The part after the verb, without its article: "the cup" -> "cup". */
const objectWords = (x) => x.replace(ARTICLE, "").trim();

/**
 * createVisionIntents({ world, getRover, getViewMode, isLooking, seek, now })
 *   world         world-objects instance (find, list)
 *   getRover()    { x, z, yaw } of the Rover in the AR world, or null before it is placed
 *   getViewMode() "xr" when the twin stands in the room; anything else is treated as the camera view (never overclaims).
 *                 Default: ctx.getMode() of the parser.
 *   isLooking()   is "Look around" on
 *   seek          seek.js instance (begin, internal), optional
 * -> { extension, avoidZones(tMs), avoidLabels(), clearAvoid() }
 */
export function createVisionIntents({ world, getRover = () => null, getViewMode = null, isLooking = () => true, seek = null, now = () => Date.now() }) {
  const avoid = new Set();

  function extension(text, bodyKey, ctx = {}) {
    if (bodyKey !== "rover" || typeof text !== "string") return null;
    const opts = (ctx && ctx.opts) || {};
    const userSpeed = Number.isFinite(opts.userSpeed) ? Math.min(100, Math.max(10, opts.userSpeed)) : 60;
    const s = normalise(text);
    if (!s) return null;
    const mode = (getViewMode && getViewMode()) ?? (ctx && typeof ctx.getMode === "function" ? ctx.getMode() : undefined);
    const inRoom = mode === "xr"; // anything else: the camera view
    const rover = getRover();
    const t = now();

    const plan = (raw, then) => {
      const v = validatePlan(raw, "rover", { userSpeed });
      if (then && v.steps.some((x) => x.tool === "turn" || x.tool === "drive") && seek && !seek.internal) seek.begin(then);
      return { steps: v.steps, say: "", unknown: [], rejected: v.rejected };
    };
    const sayPlan = (line) => plan([{ tool: "say", text: line }]);
    const refuse = (line) => ({ steps: [], say: line, unknown: [], rejected: [] });

    /** Splits "cup" / "the cup then turn left" into a label, or the answer to give instead. */
    const target = (x) => {
      const words = objectWords(x);
      if (!words || /^\d/.test(words)) return { pass: true };
      if (/[,;.]|\b(?:then|and|also|after|before)\b/.test(words)) return { answer: refuse(ONE_AT_A_TIME) };
      const label = canonicalLabel(words);
      if (label) return { label };
      return { answer: refuse(REFUSE) };
    };

    // ---- what do you see
    if (SEE.test(s)) return describeScene();
    let m = DO_SEE.exec(s);
    if (m) {
      const words = objectWords(m[1]);
      if (SEE_ANY.has(words)) return describeScene();
      const tg = target(m[1]);
      if (tg.pass) return null;
      if (tg.answer) return tg.answer;
      if (!isLooking()) return sayPlan(LOOK_OFF);
      const obj = world.find(tg.label, t, rover);
      if (!obj) return sayPlan(`No, I don't see ${withArticle(tg.label)} right now.`);
      return sayPlan(`Yes, I see ${withArticle(tg.label)} (${whereText(describeObject(obj, rover))}).`);
    }

    // ---- stop avoiding
    m = UNAVOID.exec(s);
    if (m) {
      const words = m[1] ? objectWords(m[1]) : "";
      if (!words || words === "everything" || words === "all" || words === "anything") {
        avoid.clear();
        return sayPlan("I will no longer keep clear of anything.");
      }
      const tg = target(m[1]);
      if (tg.pass) return null;
      if (tg.answer) return tg.answer;
      if (!avoid.delete(tg.label)) return sayPlan(`I was not keeping clear of the ${displayName(tg.label)}.`);
      return sayPlan(`I will no longer keep clear of the ${displayName(tg.label)}.`);
    }

    // ---- go to / find / avoid
    let kind = null;
    if ((m = GOTO.exec(s))) kind = "goto";
    else if ((m = FIND.exec(s))) kind = "find";
    else if ((m = AVOID.exec(s))) kind = "avoid";
    if (!kind) return null;
    const words = objectWords(m[1]);
    if (kind === "goto" && NOT_OBJECTS.has(words.split(" ")[0])) return null; // "go to the left", "go to sleep"
    const tg = target(m[1]);
    if (tg.pass) return null;
    if (tg.answer) return tg.answer;
    const label = tg.label;
    const name = displayName(label);

    if (kind === "avoid") {
      if (!inRoom) return sayPlan(CAMERA_ONLY);
      if (!isLooking()) return sayPlan(LOOK_OFF);
      if (!avoid.has(label) && avoid.size >= MAX_AVOID) return sayPlan(`I can keep clear of ${MAX_AVOID} things at a time. Say 'stop avoiding' first.`);
      avoid.add(label);
      return sayPlan(`OK, I'll keep clear of the ${name}.`);
    }

    if (!isLooking()) return sayPlan(LOOK_OFF);
    const obj = world.find(label, t, rover);

    if (!inRoom) {
      const seen = obj ? `The camera sees ${withArticle(label)} (${whereText(describeObject(obj, null))}).` : `I don't see ${withArticle(label)} right now.`;
      return sayPlan(kind === "find" ? `${CAMERA_ONLY} ${seen}` : CAMERA_ONLY);
    }

    if (kind === "find") {
      if (obj) return sayPlan(`I found the ${name} (${whereText(describeObject(obj, rover))}).`);
      const steps = [{ tool: "say", text: `Looking for the ${name}. Move your phone slowly around the room.` }];
      for (let i = 0; i < SCAN.TURNS; i++) {
        steps.push({ tool: "turn", degrees: SCAN.DEGREES, speed: 100 });
        if (i < SCAN.TURNS - 1) steps.push({ tool: "wait", seconds: SCAN.WAIT_S });
      }
      return plan(steps, { kind: "find", label });
    }

    // goto
    if (!obj) return sayPlan(`I don't see ${withArticle(label)} right now. Say 'find the ${name}' and I will look around.`);
    if (!obj.located) return sayPlan(`I see ${withArticle(label)}, but this phone gave me no depth, so I can't tell how far it is.`);
    const f = rover ? toRoverFrame(obj, rover) : null;
    if (!f) return sayPlan("I'm not standing in your room yet. Tap the floor to place me first.");
    if (f.distanceM <= LIMITS.ARRIVE_M) return sayPlan(`I'm next to the ${name}.`);
    const steps = [];
    if (!(seek && seek.internal)) steps.push({ tool: "say", text: `Going to the ${name} (${whereText(f)}).` });
    if (Math.abs(f.bearingDeg) >= MIN_TURN_DEG) steps.push({ tool: "turn", degrees: round1(f.bearingDeg), speed: 100 });
    const secs = (f.distanceM - STOP_SHORT_M) / (VMAX * (userSpeed / 100));
    steps.push({ tool: "drive", direction: "forward", seconds: round2(Math.min(3, Math.max(0.1, secs))), speed: 100 });
    return plan(steps, { kind: "goto", label });

    // ---- the scene in words
    function describeScene() {
      if (!isLooking()) return sayPlan(LOOK_OFF);
      const items = world.list(t).map((o) => ({ o, w: describeObject(o, inRoom ? rover : null) }));
      if (!items.length) return sayPlan("I don't see anything I know yet. Point your phone around the room and ask again.");
      items.sort((a, b) => {
        const da = Number.isFinite(a.w.distanceM);
        const db = Number.isFinite(b.w.distanceM);
        if (da !== db) return da ? -1 : 1;
        return da ? a.w.distanceM - b.w.distanceM : b.o.score - a.o.score;
      });
      const shown = items.slice(0, SHOW_MAX).map(({ o, w }) => `${withArticle(o.label)} (${whereText(w)})`);
      const more = items.length - shown.length;
      return sayPlan(`I see ${shown.join(", ")}${more > 0 ? ` and ${more} more` : ""}.`);
    }
  }

  return {
    extension,
    /** Keep-out discs for the depth tracker: one per sighting of an avoided label, [{x, z, r, label}] */
    avoidZones(tMs = now()) {
      if (!avoid.size) return [];
      return world
        .list(tMs)
        .filter((o) => o.located && avoid.has(o.label))
        .map((o) => ({ x: o.x, z: o.z, r: KEEP_OUT_M, label: o.label }));
    },
    avoidLabels() {
      return [...avoid];
    },
    clearAvoid() {
      avoid.clear();
    },
  };
}
