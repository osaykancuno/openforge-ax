// AI Pilot orchestrator: one conversation, one plan at a time.
//
//   idle -> thinking -> ready -> running -> done | interrupted | stopped
//
// The rules it enforces (the executor and the drive loop enforce the rest):
//   * it never arms: a plan that has to move waits for the human's ARM and says so;
//   * on the real robot every plan needs a Run click; on the twin a plan runs by itself once armed;
//   * a new message is an interruption: the move and the model request are aborted, the robot STAYS armed, and the
//     model is asked again knowing where the last plan was cut. Replies to older requests are dropped;
//   * STOP always wins: cancel("stop") aborts first and nothing resumes; a latch from the bridge ends a running plan;
//   * the human touching a control ends the plan ("You took the controls.").
import { describeStep, MOTION_TOOLS, cleanSay, toolsFor, validatePlan } from "./tools.js";
import { parseCommand } from "./grammar.js";
import { buildMessages } from "./prompt.js";
import { ARM_FIRST, PLAN_TIMEOUT, createPlanExecutor } from "./executor.js";
import { LINK } from "../drive-loop.js";

export const STATES = ["idle", "thinking", "ready", "running", "done", "interrupted", "stopped"];
export const SOURCE_PARSER = "built-in parser";
export const SOURCE_MODEL = "model";
const MAX_INPUT = 500;
const MAX_MESSAGES = 60;

/**
 * createAiPilot({ getLoop, getBodyKey, getMode, clock, getModel, autoRunTwin, onChange, createExecutor, parse })
 * getModel() returns a model client ({ plan }) or null for the built-in parser. onChange(view) fires on every change.
 */
export function createAiPilot({ getLoop, getBodyKey, getMode = () => "twin", clock, getModel = () => null, autoRunTwin = () => true, onChange = () => {}, createExecutor = createPlanExecutor, parse = parseCommand }) {
  let state = "idle";
  let generation = 0; // bumped by every interruption, STOP and reset: older replies and results are dropped
  let ctrl = null; // AbortController of the current request and plan
  let plan = null; // the latest plan record (also referenced from messages)
  let messages = [];
  let history = [];
  let progress = null;
  let runPromise = Promise.resolve();
  let seq = 0;

  const armed = () => {
    const loop = getLoop();
    return !!loop && (loop.link === LINK.ARMED || loop.link === LINK.DRIVING);
  };
  const view = () => ({ state, running: state === "running", busy: state === "running" || state === "thinking", messages: messages.slice(), plan, progress: progress && { ...progress } });
  const notify = () => {
    try {
      onChange(view());
    } catch {} // a UI callback never breaks the pilot
  };
  const setState = (s) => {
    state = s;
    notify();
  };
  const push = (m) => {
    const rec = { id: ++seq, ...m };
    messages.push(rec);
    if (messages.length > MAX_MESSAGES) messages = messages.slice(-MAX_MESSAGES);
    return rec;
  };
  const remember = (role, text) => {
    const t = cleanSay(text, 300);
    if (t) history.push({ role, text: t });
    if (history.length > 24) history = history.slice(-24);
  };

  /** Run gate of a ready plan: ARM first, and a click on the real robot. */
  function refresh(p) {
    if (!p || p.status !== "ready") return;
    p.blocked = p.needsArm && !armed() ? "arm" : null;
    p.confirm = !p.stopOnly && getMode() === "ble";
    p.canRun = p.blocked === null;
    p.note = p.blocked ? ARM_FIRST : p.confirm ? "This moves the real robot. Check that it is clear, then press Run." : "";
  }

  function interruptNow() {
    const was = state;
    const where = was === "running" && progress ? `step ${progress.index + 1}/${progress.total} (${describeStep(progress.step)})` : null;
    if (plan && plan.status === "running") plan.status = "interrupted";
    if (ctrl) ctrl.abort("interrupt"); // the model request and the executor; the executor lets go of the wheels in this call
    if (was === "running") {
      const loop = getLoop();
      if (loop) loop.setHeld(false); // belt and braces; the robot stays ARMED
    }
    progress = null;
    return where;
  }

  async function submit(text) {
    const clean = cleanSay(typeof text === "string" ? text : "", MAX_INPUT);
    if (!clean) return null;
    let interrupted = null;
    if (state === "running" || state === "thinking") interrupted = interruptNow();
    if (plan && plan.status === "ready") plan.status = "discarded"; // superseded by this message
    const gen = ++generation;
    const mine = (ctrl = new AbortController());
    push({ role: "user", text: clean });
    remember("user", clean);
    setState("thinking");

    const bodyKey = getBodyKey();
    const loop = getLoop();
    const model = getModel();
    const userSpeed = loop ? loop.snapshot.speed : undefined;
    let source = SOURCE_PARSER;
    let steps = [];
    let fallbackWhy = "";
    let rejected = [];
    let usable = false;

    if (model) {
      try {
        const messagesForModel = buildMessages({ bodyKey, snapshot: loop ? loop.snapshot : null, history, interrupted });
        const res = await model.plan({ messages: messagesForModel, tools: toolsFor(bodyKey), signal: mine.signal });
        if (gen !== generation) return null;
        if (res && res.via !== "none") {
          usable = true;
          source = SOURCE_MODEL;
          const say = cleanSay(res.say);
          if (say) push({ role: "model", text: say });
          const v = validatePlan(res.steps, bodyKey, { userSpeed });
          steps = v.steps;
          rejected = v.rejected;
          if (!steps.length) {
            const why = v.rejected.length ? `The model asked for something I do not allow (${v.rejected.slice(0, 3).map((r) => r.reason).join("; ")}). Nothing was run.` : say ? "" : "The model did not ask for any action.";
            if (why) push({ role: "notice", text: why });
            remember("assistant", say || "(no action)");
            setState("idle");
            return null;
          }
          if (v.rejected.length) push({ role: "notice", text: `I dropped ${v.rejected.length === 1 ? "one step" : `${v.rejected.length} steps`} the model asked for: ${v.rejected.slice(0, 3).map((r) => r.reason).join("; ")}.` });
        } else {
          fallbackWhy = "I could not use the model's answer, so I used the built-in parser.";
        }
      } catch (e) {
        if (gen !== generation) return null;
        fallbackWhy = `${e && e.name === "ModelError" && e.message ? e.message : "The model did not answer."} I used the built-in parser instead.`;
      }
    }
    if (gen !== generation) return null;

    if (!usable) {
      if (fallbackWhy) push({ role: "notice", text: fallbackWhy });
      const g = parse(clean, bodyKey, { userSpeed }); // the built-in parser, or a wrapper with the same result shape (the AR page adds an obstacle filter)
      steps = g.steps;
      rejected = g.rejected;
      if (g.say) push({ role: "pilot", text: g.say });
      if (!steps.length) {
        remember("assistant", g.say || "(nothing to do)");
        setState("idle");
        return null;
      }
    }

    const rec = {
      id: ++seq,
      role: "plan",
      source,
      steps,
      rejected,
      status: "ready",
      needsArm: steps.some((s) => MOTION_TOOLS.has(s.tool)),
      stopOnly: steps.every((s) => s.tool === "stop" || s.tool === "say"),
      blocked: null,
      confirm: false,
      canRun: false,
      note: "",
    };
    // the message holds the record itself, so the card follows its status
    const card = { id: rec.id, role: "plan", plan: rec };
    messages.push(card);
    plan = rec;
    refresh(rec);
    remember("assistant", `Plan: ${steps.map(describeStep).join("; ")}`);
    setState("ready");
    // a plan that only stops or talks needs no confirmation; on the twin an armed plan runs by itself
    if (rec.canRun && (rec.stopOnly || (!rec.confirm && autoRunTwin()))) startRun(rec, gen, mine);
    return rec;
  }

  function startRun(rec, gen, mine) {
    const loop = getLoop();
    rec.status = "running";
    rec.canRun = false;
    progress = { index: 0, total: rec.steps.length, step: rec.steps[0] };
    const ex = createExecutor({
      loop,
      clock,
      getBodyKey,
      onEvent: (e) => {
        if (gen !== generation) return;
        if (e.type === "step-start") {
          progress = { index: e.index, total: rec.steps.length, step: e.step };
          notify();
        } else if (e.type === "say") {
          push({ role: "model", text: e.text });
          notify();
        }
      },
    });
    setState("running");
    runPromise = ex
      .run(rec.steps, mine.signal)
      .then((result) => {
        if (gen !== generation) return result; // interrupted, stopped or reset meanwhile: that path already set the state
        progress = null;
        if (result.status === "done") {
          rec.status = "done";
          setState("done");
        } else if (result.status === "stopped") {
          rec.status = "stopped";
          push({ role: "notice", text: "The plan stopped the robot. Press ARM to continue." });
          setState("stopped");
        } else if (result.status === "refused") {
          rec.status = "ready";
          refresh(rec);
          setState("ready");
        } else if (result.latched) {
          rec.status = "stopped";
          push({ role: "notice", text: `Stopped: ${cleanSay(result.reason, 200)}` });
          setState("stopped");
        } else {
          rec.status = "interrupted";
          if (result.reason === PLAN_TIMEOUT) push({ role: "notice", text: PLAN_TIMEOUT });
          setState("interrupted");
        }
        return result;
      })
      .catch((e) => {
        if (gen !== generation) return null;
        progress = null;
        rec.status = "stopped";
        push({ role: "notice", text: "Something went wrong while running the plan. I stopped." });
        setState("stopped");
        return null;
      });
    return runPromise;
  }

  /**
   * The Run button of plan card `id`. Returns the executor's result, or { status: "refused" } while the robot is not
   * armed. A card that is not the current plan (stale) runs nothing.
   */
  async function run(id) {
    if (state !== "ready" || !plan || plan.status !== "ready") return null;
    if (id !== undefined && id !== plan.id) return null;
    refresh(plan);
    if (!plan.canRun) {
      notify();
      return { status: "refused", reason: plan.note };
    }
    return startRun(plan, generation, ctrl);
  }

  /**
   * STOP, or any hard cancel. The abort comes FIRST (it zeroes the wheels in the same call); the caller then cancels its
   * gesture timers and stops the loop. Returns true if something was in flight. Never resumes.
   */
  function cancel(reason = "stop") {
    const was = state;
    if (ctrl) ctrl.abort(reason);
    generation++;
    if (was !== "thinking" && was !== "running" && was !== "ready") return false;
    const isStop = reason === "stop";
    if (plan && (plan.status === "running" || plan.status === "ready")) plan.status = isStop ? "stopped" : "interrupted";
    progress = null;
    push({ role: "notice", text: isStop ? "Stopped." : String(reason) });
    setState(isStop ? "stopped" : "interrupted");
    return true;
  }

  /** The human touched a control. Ends a running or pending plan; the robot stays as the human left it. */
  function takeover(message = "You took the controls.") {
    if (state === "running" || state === "thinking") cancel(message);
  }

  /** Call with every drive-loop snapshot: a latch ends a running plan; the Run gate follows ARM. */
  function onLoopChange(snap) {
    if (state === "running" && plan && plan.needsArm && snap && snap.link !== LINK.ARMED && snap.link !== LINK.DRIVING) {
      if (ctrl) ctrl.abort("latched");
      generation++;
      plan.status = "stopped";
      progress = null;
      push({ role: "notice", text: `Stopped: ${cleanSay(snap.message || "the robot is no longer armed.", 200)}` });
      setState("stopped");
      return;
    }
    if (plan && plan.status === "ready") {
      const before = `${plan.canRun}|${plan.blocked}|${plan.note}`;
      refresh(plan);
      if (before !== `${plan.canRun}|${plan.blocked}|${plan.note}`) notify(); // the loop reports 10 times a second: only tell the UI what changed
    }
  }

  function discard() {
    if (state !== "ready" || !plan) return;
    plan.status = "discarded";
    plan = null;
    setState("idle");
  }

  /** The loop, body or mode changed: drop everything in flight, quietly. The transcript stays. */
  function reset() {
    if (ctrl) ctrl.abort("reset");
    generation++;
    if (plan && (plan.status === "ready" || plan.status === "running")) plan.status = "discarded";
    plan = null;
    progress = null;
    history = [];
    setState("idle");
  }

  return {
    submit,
    run,
    cancel,
    takeover,
    discard,
    reset,
    onLoopChange,
    refresh: () => {
      refresh(plan);
      notify();
    },
    /** Resolves when the current run has finished (and its state is set). */
    whenIdle: () => runPromise.then(() => undefined, () => undefined),
    get state() {
      return state;
    },
    get view() {
      return view();
    },
    get running() {
      return state === "running";
    },
  };
}
