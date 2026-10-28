// The AR page's parser: what the AI Pilot's built-in parser understands, plus
//   * extensions (objects: "what do you see", "go to the cup"...) that run first,
//   * the chip names said out loud: "left", "right" and "spin" alone do what the Left, Right and Spin chips do (the page
//     tells people to say "spin"; the shared parser only reads "turn left", "spin around"),
//   * an obstacle filter: while something is in the Rover's way, forward drives are dropped (turns and backing up stay),
//   * a final validatePlan, so no extension and no filter can produce a step the AI Pilot's own rules would not allow.
// Text is untrusted (a voice transcript): invisible and bidi characters are stripped before any parser sees it.
//
// EXTENSION CONTRACT: an extension is (text, bodyKey, ctx) => null | result, where result has exactly the shape
// parseCommand returns ({ steps, say, unknown, rejected }) and ctx = { opts, getMode, getBlocked }. Extensions run in
// order, the first non-null wins; one that throws or returns something that is not a result is skipped.
import { parseCommand } from "../pilot/ai/grammar.js";
import { cleanSay, validatePlan } from "../pilot/ai/tools.js";
import { chipText } from "./chips.js";

const MAX_TEXT = 2000;
const FORWARD = /^forward/;

// a clause that is only a chip's name (as speech recognition writes it) -> that chip's phrase
const SPOKEN = [
  [/^(?:go |move )?left$/, "left"],
  [/^(?:go |move )?right$/, "right"],
  [/^(?:do a )?spin$/, "spin"],
];
const CLAUSE_SPLIT = /\s*(?:[,;.!?]+|\band then\b|\bthen\b|\band\b)\s*/i;

/** "forward then left" -> "forward then turn left 45"; text without a chip-name clause comes back unchanged. */
export function spokenAliases(text) {
  const clauses = String(text).split(CLAUSE_SPLIT).filter((c) => c.trim());
  let changed = false;
  const out = clauses.map((c) => {
    const key = c.trim().toLowerCase();
    const hit = SPOKEN.find(([re]) => re.test(key));
    if (!hit) return c.trim();
    changed = true;
    return chipText(hit[1]);
  });
  return changed ? out.join(" then ") : text;
}

const isForward = (s) => !!s && s.tool === "drive" && typeof s.direction === "string" && FORWARD.test(s.direction);
const isResult = (r) => r !== null && typeof r === "object" && Array.isArray(r.steps);

/**
 * filterBlocked(steps, blocked, blockedBack) -> { steps, note }. `blocked` / `blockedBack` are null, or { distanceM } of
 * the obstacle ahead / behind. Forward drives (also the forward curves) are dropped when blocked ahead, backward drives when
 * blocked behind; note is "" when nothing was dropped.
 */
export function filterBlocked(steps, blocked, blockedBack = null) {
  if (!blocked && !blockedBack) return { steps, note: "" };
  const isBack = (s) => !!s && s.tool === "drive" && typeof s.direction === "string" && s.direction.startsWith("back");
  const kept = steps.filter((s) => !(blocked && isForward(s)) && !(blockedBack && isBack(s)));
  if (kept.length === steps.length) return { steps, note: "" };
  const droppedFwd = blocked && steps.some(isForward);
  const o = droppedFwd ? blocked : blockedBack;
  const d = o && o.distanceM;
  const where = Number.isFinite(d) ? ` (about ${Math.round(d * 100)} cm ${droppedFwd ? "ahead" : "behind"})` : "";
  return { steps: kept, note: droppedFwd ? `Something is in my way${where}. I can turn or back up.` : `Something is behind me${where}. I can turn or drive forward.` };
}

/**
 * createArParser({ getBlocked, getMode, extensions, base }) -> (text, bodyKey, opts) => result.
 * getBlocked() -> null | { distanceM }; getMode() -> "xr" | "camera" (extensions may answer differently).
 */
export function createArParser({ getBlocked = () => null, getBlockedBack = () => null, getMode = () => "xr", extensions = [], base = parseCommand } = {}) {
  return function arParse(text, bodyKey, opts = {}) {
    const clean = cleanSay(typeof text === "string" ? text : "", MAX_TEXT);
    const ctx = { opts, getMode, getBlocked };
    let result = null;
    let fromBase = true;
    for (const ext of extensions) {
      let r = null;
      try {
        r = ext(clean, bodyKey, ctx);
      } catch {
        r = null;
      }
      if (isResult(r)) {
        result = r;
        fromBase = false;
        break;
      }
    }
    if (!result) {
      try {
        result = base(spokenAliases(clean), bodyKey, opts);
      } catch {
        result = { steps: [], say: "I could not read that. Try: forward 2 s, turn left, look up.", unknown: [], rejected: [] };
      }
    }
    // the same limits as every other plan; steps that were fine stay exactly as they are
    const v = validatePlan(result.steps, bodyKey, { userSpeed: opts && opts.userSpeed });
    const out = {
      steps: v.steps,
      say: fromBase ? String(result.say ?? "") : cleanSay(result.say, 600),
      unknown: Array.isArray(result.unknown) ? result.unknown : [],
      rejected: [...(Array.isArray(result.rejected) ? result.rejected : []), ...v.rejected],
    };
    const f = filterBlocked(out.steps, getBlocked(), getBlockedBack());
    if (f.note) {
      out.steps = validatePlan(f.steps, bodyKey, { userSpeed: opts && opts.userSpeed }).steps;
      out.say = out.say ? `${out.say} ${f.note}` : f.note;
    }
    return out;
  };
}
