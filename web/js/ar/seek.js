// AR Rover, "go to the X" and "find the X": bounded re-planning on top of the AI Pilot. Pure: no DOM, no timers of its own
// beyond an optional 250 ms check on the clock it is given.
//
// The AI Pilot runs ONE validated plan per message (say / turn / drive / wait, leases of 3 s at most, the 45 s plan
// deadline). A trip to an object is several of those: turn toward it, drive, look again, correct. This module is the
// loop around them, and it can only ever do two things: ask the pilot for another plan with plain text ("go to the
// cup", which goes through the parser and validatePlan like everything a person types) and cancel the running plan.
//
//   begin({kind, label})  called by the intent extension while it parses (kind "goto" or "find"); pending until the plan
//                         really runs (an unarmed Rover waits for ARM, and the clock has not started)
//   onAiChange(view)      the ai pilot's onChange view { state, plan }: running -> active, done -> next round
//   tick()                every 250 ms while pending or active (own interval when a clock is given)
//   cancel(reason)        STOP and everything that is not a normal end: quiet, no new plan, ever
//
// Ends: arrived (within ARRIVE_M, or the depth tracker's obstacle is where the target is), lost (target out of sight
// LOST_MS), timeout (DEADLINE_MS overall), rounds (ROUNDS plans), found (find), replaced (the user said something
// else, pressed a chip, took the controls: the pilot already said so), cancelled (STOP).
import { canonicalLabel, describeObject, displayName, toRoverFrame, whereText } from "./vision/world-objects.js";

export const LIMITS = {
  ROUNDS: 5, // plans per trip
  DEADLINE_MS: 45000, // overall, from the first plan running
  LOST_MS: 2000, // target out of sight this long ends the trip
  ARRIVE_M: 0.35, // 0.3 m is where the plan aims; 5 cm of slack for an open-loop drive
  TICK_MS: 250,
  NEXT_MS: 1500, // a re-plan must be running within this
  OBSTACLE_TOL_M: 0.25, // an obstacle this close to the target's distance is the target
};
const FRONT_M = 0.08; // bumper in front of the centre (the depth tracker measures from the bumper)
const KINDS = new Set(["goto", "find"]);
const OVER = new Set(["stopped", "interrupted", "idle"]);

/**
 * createSeek({ now, clock, world, getRover, getObstacle, submit, cancelPlan, notice })
 *   now()                 ms
 *   clock                 optional { setInterval, clearInterval }: runs tick() every 250 ms while pending or active
 *   world                 { find(label, tMs, rover) -> object | null } (world-objects)
 *   getRover()            { x, z, yaw } in the AR world
 *   getObstacle()         { state, distanceM } of the depth tracker, or null
 *   submit(text)          ai.submit
 *   cancelPlan(message)   ai.cancel(message): ends the running plan, the message becomes the notice in the transcript
 *   notice(text)          a transcript line when no plan is running to carry it
 */
export function createSeek({ now, clock = null, world, getRover = () => null, getObstacle = () => null, submit, cancelPlan, notice = () => {}, limits = {} }) {
  const L = { ...LIMITS, ...limits };
  let state = "idle"; // idle | pending | active
  let intent = null;
  let internal = false;
  let awaitingNext = false;
  let awaitUntil = 0;
  let waiting = false; // the plan is done, the target is out of sight, we wait for it (up to LOST_MS)
  let pendingPlan = null;
  let ourPlan = null;
  let rounds = 0;
  let startedAt = 0;
  let lostSince = null;
  let lastAi = "idle";
  let result = null;
  let handle = null;

  const name = () => displayName(intent.label);
  const safe = (fn, ...a) => {
    try {
      return fn(...a);
    } catch {
      return undefined;
    }
  };

  function stopTimer() {
    if (handle !== null && clock) safe(() => clock.clearInterval(handle));
    handle = null;
  }
  function startTimer() {
    stopTimer();
    if (clock && typeof clock.setInterval === "function") handle = clock.setInterval(tick, L.TICK_MS);
  }

  function reset() {
    stopTimer();
    state = "idle";
    awaitingNext = false;
    waiting = false;
    pendingPlan = null;
    ourPlan = null;
    lostSince = null;
  }

  /** Ends the seek. say: where the line goes: "plan" = cancel the running plan with it, "notice" = transcript, "" = nothing. */
  function end(kind, text = "", how = "") {
    if (state === "idle") return;
    const was = lastAi;
    const label = intent && intent.label;
    const n = rounds;
    reset(); // first: the pilot's notifications caused by our own cancel must find us idle
    intent = null;
    result = { kind, label, rounds: n, text };
    if (!text) return;
    const planLive = was === "running" || was === "ready" || was === "thinking";
    if (how === "plan" && planLive) safe(cancelPlan, text);
    else safe(notice, text);
  }

  function place(label) {
    const rover = safe(getRover) || null;
    const obj = safe(() => world.find(label, now(), rover));
    return { rover, obj: obj || null };
  }

  /** Where the target is from the rover: { d, text } or null when it has no place in the room. */
  function targetState() {
    const { rover, obj } = place(intent.label);
    if (!obj) return { rover, obj: null, d: NaN };
    const f = obj.located && rover ? toRoverFrame(obj, rover) : null;
    return { rover, obj, f, d: f ? f.distanceM : NaN };
  }

  function arrivedNow(ts) {
    if (Number.isFinite(ts.d) && ts.d <= L.ARRIVE_M) return true;
    const ob = safe(getObstacle);
    return !!ob && ob.state === "blocked" && Number.isFinite(ob.distanceM) && Number.isFinite(ts.d) && Math.abs(ob.distanceM + FRONT_M - ts.d) <= L.OBSTACLE_TOL_M;
  }

  const foundText = (ts) => `I found the ${name()} (${whereText(ts.f || describeObject(ts.obj, ts.rover))}).`;

  function continueTrip() {
    rounds++;
    awaitingNext = true;
    awaitUntil = now() + L.NEXT_MS;
    waiting = false;
    internal = true; // ROUNDS and DEADLINE hold because the built-in parser runs synchronously inside submit (getModel is null on
    // ar.html): with a model client, begin() would arrive after internal is false and reset them. Keep the AR page parser-only.
    try {
      const p = submit(`go to the ${intent.label}`);
      if (p && typeof p.catch === "function") p.catch(() => {});
    } catch {
      /* the pilot refused: the check on awaitingNext ends the trip */
    } finally {
      internal = false;
    }
  }

  /** The plan we were running is over (done). Decide: end, wait for the target, or the next round. */
  function planFinished() {
    awaitingNext = false;
    if (intent.kind === "find") {
      const ts = targetState();
      if (ts.obj) return end("found", foundText(ts), "notice");
      return end("notfound", `I looked all around and could not find the ${name()}.`, "notice");
    }
    const ts = targetState();
    if (!ts.obj || !ts.f) {
      lostSince = lostSince ?? now();
      waiting = true;
      return undefined;
    }
    lostSince = null;
    if (arrivedNow(ts)) return end("arrived", `I'm next to the ${name()}.`, "notice");
    if (rounds >= L.ROUNDS) return end("rounds", `I tried ${L.ROUNDS} times and could not get to the ${name()}.`, "notice");
    continueTrip();
    return undefined;
  }

  function activate(plan) {
    state = "active";
    ourPlan = plan;
    pendingPlan = null;
    rounds = 1;
    startedAt = now();
    lostSince = null;
    waiting = false;
  }

  function onAiChange(view) {
    if (state === "idle" || !view) return;
    const s = view.state;
    const plan = view.plan || null;
    lastAi = s;
    if (state === "pending") {
      if (s === "thinking") {
        if (pendingPlan) end("replaced"); // a new message: the plan we waited for is discarded
      } else if (s === "ready" || s === "running") {
        if (!pendingPlan) pendingPlan = plan;
        if (plan !== pendingPlan) return end("replaced");
        if (s === "running") activate(plan);
      } else end("replaced"); // stopped, interrupted, idle, done: the plan we waited for is gone
      return undefined;
    }
    // active
    switch (s) {
      case "thinking":
        if (!awaitingNext) end("replaced");
        break;
      case "ready":
        if (!awaitingNext) end("replaced");
        else if (plan && plan.blocked) end("stalled", `I couldn't carry on to the ${name()}: ${plan.note || "I need ARM again."}`, "notice");
        break;
      case "running":
        if (plan !== ourPlan) {
          if (awaitingNext) {
            ourPlan = plan;
            awaitingNext = false;
          } else end("replaced");
        }
        break;
      case "done":
        planFinished();
        break;
      default:
        if (OVER.has(s)) {
          if (awaitingNext) end("stalled", `I couldn't carry on to the ${name()}.`, "notice");
          else if (intent.kind === "goto" && s === "interrupted" && arrivedNow(targetState())) end("arrived", `I'm next to the ${name()}.`, "notice");
          else end("interrupted"); // the pilot (hold, takeover, a new message) already told the user why
        }
    }
    return undefined;
  }

  function tick() {
    if (state === "idle") return;
    const t = now();
    if (state === "pending") {
      if (intent.kind === "find") {
        const ts = targetState();
        if (ts.obj) end("found", foundText(ts), "plan");
      }
      return;
    }
    if (t - startedAt >= L.DEADLINE_MS) return end("timeout", `I stopped after ${Math.round(L.DEADLINE_MS / 1000)} s. I could not get to the ${name()} in time.`, "plan");
    if (awaitingNext) {
      if (t > awaitUntil) end("stalled", `I couldn't carry on to the ${name()}.`, "notice");
      return;
    }
    const ts = targetState();
    if (intent.kind === "find") {
      if (ts.obj) end("found", foundText(ts), "plan");
      return;
    }
    if (!ts.obj || !ts.f) {
      lostSince = lostSince ?? t;
      if (t - lostSince >= L.LOST_MS) end("lost", `I lost sight of the ${name()}.`, lastAi === "done" ? "notice" : "plan");
      return;
    }
    lostSince = null;
    if (arrivedNow(ts)) return end("arrived", `I'm next to the ${name()}.`, lastAi === "done" ? "notice" : "plan");
    if (waiting) {
      if (rounds >= L.ROUNDS) end("rounds", `I tried ${L.ROUNDS} times and could not get to the ${name()}.`, "notice");
      else continueTrip();
    }
  }

  return {
    /** The intent extension calls this while it parses. Ignored while this module itself is re-submitting. */
    begin(i) {
      if (internal) return;
      const label = i && typeof i === "object" ? canonicalLabel(i.label) : null;
      if (!label || !KINDS.has(i.kind)) return;
      if (state !== "idle") reset(); // the user asked for something new: the old trip is over, quietly
      intent = { kind: i.kind, label };
      state = "pending";
      rounds = 0;
      result = null;
      startTimer();
    },
    onAiChange,
    tick,
    /** STOP, and anything that is not a normal end. Quiet: the caller already cancelled the plan. Nothing resumes. */
    cancel() {
      if (state === "idle") return;
      end("cancelled");
    },
    get state() {
      return state;
    },
    get active() {
      return state === "active";
    },
    get internal() {
      return internal;
    },
    get intent() {
      return intent ? { kind: intent.kind, label: intent.label } : null;
    },
    get rounds() {
      return rounds;
    },
    get result() {
      return result;
    },
  };
}
