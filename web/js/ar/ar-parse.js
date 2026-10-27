// The AR page's parser: what the AI Pilot's built-in parser understands, plus
//   * extensions (objects: "what do you see", "go to the cup"...) that run first,
//   * an obstacle filter: while something is in the Rover's way, forward drives are dropped (turns and backing up stay),
//   * a final validatePlan, so no extension and no filter can produce a step the AI Pilot's own rules would not allow.
// Text is untrusted (a voice transcript): invisible and bidi characters are stripped before any parser sees it.
//
// EXTENSION CONTRACT: an extension is (text, bodyKey, ctx) => null | result, where result has exactly the shape
// parseCommand returns ({ steps, say, unknown, rejected }) and ctx = { opts, getMode, getBlocked }. Extensions run in
// order, the first non-null wins; one that throws or returns something that is not a result is skipped.
import { parseCommand } from "../pilot/ai/grammar.js";
import { cleanSay, validatePlan } from "../pilot/ai/tools.js";

const MAX_TEXT = 2000;
const FORWARD = /^forward/;

const isForward = (s) => !!s && s.tool === "drive" && typeof s.direction === "string" && FORWARD.test(s.direction);
const isResult = (r) => r !== null && typeof r === "object" && Array.isArray(r.steps);

/**
 * filterBlocked(steps, blocked) -> { steps, note }. `blocked` is null, or { distanceM } of the obstacle. Forward drives
 * (also the forward curves) are dropped; note is "" when nothing was dropped.
 */
export function filterBlocked(steps, blocked) {
  if (!blocked) return { steps, note: "" };
  const kept = steps.filter((s) => !isForward(s));
  if (kept.length === steps.length) return { steps, note: "" };
  const d = Number(blocked.distanceM);
  const where = Number.isFinite(d) ? ` (about ${Math.round(d * 100)} cm ahead)` : "";
  return { steps: kept, note: `Something is in my way${where}. I can turn or back up.` };
}

/**
 * createArParser({ getBlocked, getMode, extensions, base }) -> (text, bodyKey, opts) => result.
 * getBlocked() -> null | { distanceM }; getMode() -> "xr" | "camera" (extensions may answer differently).
 */
export function createArParser({ getBlocked = () => null, getMode = () => "xr", extensions = [], base = parseCommand } = {}) {
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
        result = base(clean, bodyKey, opts);
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
    const f = filterBlocked(out.steps, getBlocked());
    if (f.note) {
      out.steps = validatePlan(f.steps, bodyKey, { userSpeed: opts && opts.userSpeed }).steps;
      out.say = out.say ? `${out.say} ${f.note}` : f.note;
    }
    return out;
  };
}
