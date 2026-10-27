// AI Pilot plan executor: runs a validated plan through the SAME drive loop the buttons use (twin or real robot).
//   * one plan per message, no round trips to the model;
//   * moves are timed: a drive is a lease (loop.holdFor, 3 s at most per lease) so a frozen page cannot leave the
//     wheels running; joint moves wait max|delta| / (90 deg/s x the user's speed) + 150 ms for the bridge to get there;
//   * the AbortSignal is the STOP button: abort() zeroes the wheels in the same call, rejects the wait that is in
//     progress and nothing else is ever sent. After an abort this executor does nothing more, not even a final reset;
//   * a latch (watchdog, fault, low battery, STOP by the human) is noticed within 40 ms and ends the plan;
//   * a hard wall-clock deadline (PLAN_DEADLINE_MS) ends any plan that runs longer, whatever its estimates said;
//   * it never arms, connects or changes the speed setting. A plan that has to move is refused unless the human has
//     armed the robot.
import * as P from "../ax-proto.js";
import { LINK, MAX_LEASE_MS } from "../drive-loop.js";
import { gestureFrames, poseFrames } from "../motions.js";
import { DIRECTIONS, MOTION_TOOLS, turnSeconds, validatePlan } from "./tools.js";

export const ARM_FIRST = "Press ARM to let me move. I can't arm the robot.";
export const POLL_MS = 40; // how often a wait looks at the signal and the link
export const SETTLE_MS = 150; // extra time after a joint move for the servo to arrive
export const MAX_SETTLE_MS = 8000;
export const PLAN_DEADLINE_MS = 45000; // no plan runs longer than this, wall clock
export const PLAN_TIMEOUT = "The plan ran longer than 45 s, so I stopped it. The robot stays armed.";

class Interrupt extends Error {
  constructor(reason, latched = false) {
    super(reason);
    this.reason = reason;
    this.latched = latched;
  }
}
const reasonOf = (signal) => {
  const r = signal.reason;
  return typeof r === "string" ? r : r && typeof r.message === "string" ? r.message : "stop";
};

/**
 * createPlanExecutor({ loop, clock, onEvent, getBodyKey })
 * run(steps, signal) -> { status: "done" | "aborted" | "stopped" | "refused", reason, completed, total, index, latched }
 * Events: plan-start, step-start, step-end, say, done, aborted.
 */
export function createPlanExecutor({ loop, clock, onEvent = () => {}, getBodyKey = null }) {
  let running = false;
  const emit = (e) => {
    try {
      onEvent(e);
    } catch {} // a UI callback never breaks a move
  };
  const armed = () => loop.link === LINK.ARMED || loop.link === LINK.DRIVING;
  const latchReason = () => loop.snapshot.message || "The robot is no longer armed.";

  async function run(rawSteps, signal) {
    const total0 = Array.isArray(rawSteps) ? rawSteps.length : 0;
    let completed = 0;
    let index = null;
    const finish = (status, reason = "", latched = false) => ({ status, reason, completed, total: steps ? steps.length : total0, index, latched });
    let steps = null;
    if (running) return finish("refused", "A plan is already running.");
    if (signal.aborted) return finish("aborted", reasonOf(signal));
    const bodyKey = getBodyKey ? getBodyKey() : (P.BODIES[loop.snapshot.body] || {}).key;
    steps = validatePlan(rawSteps, bodyKey, { userSpeed: loop.snapshot.speed }).steps; // again: the executor never trusts its caller
    const needsArm = steps.some((s) => MOTION_TOOLS.has(s.tool));
    if (needsArm && !armed()) return finish("refused", ARM_FIRST);

    running = true;
    const deadline = clock.now() + PLAN_DEADLINE_MS;
    const overtime = () => clock.now() >= deadline;
    const onAbort = () => loop.setHeld(false); // STOP's first effect, in the same call as abort(): wheels to zero
    signal.addEventListener("abort", onAbort, { once: true });

    const guard = () => {
      if (signal.aborted) throw new Interrupt(reasonOf(signal));
      if (needsArm && !armed()) throw new Interrupt(latchReason(), true);
      if (overtime()) throw new Interrupt(PLAN_TIMEOUT);
    };

    /** Abortable wait. Looks at the signal and the link every POLL_MS and ends exactly at `ms`. */
    const sleep = (ms) =>
      new Promise((resolve, reject) => {
        const end = clock.now() + ms;
        let h = null;
        const cleanup = () => {
          if (h !== null) clock.clearTimeout(h);
          h = null;
          signal.removeEventListener("abort", fail);
        };
        const fail = () => (cleanup(), reject(new Interrupt(reasonOf(signal))));
        const poll = () => {
          h = null;
          if (signal.aborted) return fail();
          if (needsArm && !armed()) return cleanup(), reject(new Interrupt(latchReason(), true));
          if (overtime()) return cleanup(), reject(new Interrupt(PLAN_TIMEOUT));
          const left = end - clock.now();
          if (left <= 0) return cleanup(), resolve();
          h = clock.setTimeout(poll, Math.min(left, POLL_MS));
        };
        if (signal.aborted) return fail();
        signal.addEventListener("abort", fail, { once: true });
        poll();
      });

    /** Where the joints are now, in deci: what the bridge reports, else what the app last commanded. */
    const present = (s, def) => (s.state && s.state.positions.length >= def.joints.length ? s.state.positions : s.targets);

    /** Sets joint targets (degrees, by name) and waits for the bridge to get there. */
    async function applyPose(map, wait = true) {
      guard();
      const s = loop.snapshot;
      const def = P.BODIES[s.body];
      let delta = 0;
      if (def) {
        const now = present(s, def);
        for (const [name, deg] of Object.entries(map)) {
          const i = def.joints.findIndex((j) => j.name === name);
          if (i < 0) continue;
          const j = def.joints[i];
          const target = Math.max(j.min, Math.min(j.max, Math.round(deg * 10)));
          delta = Math.max(delta, Math.abs(target - (now[i] ?? j.home)) / 10);
        }
      }
      loop.setPose(map);
      if (wait) await sleep(Math.min(MAX_SETTLE_MS, (delta / (P.MAX_DEG_S * (Math.max(5, s.speed) / 100))) * 1000 + SETTLE_MS));
    }

    /** Drives with a stick vector for `ms`, in leases of at most MAX_LEASE_MS, then lets go. */
    async function hold(ms, x, y) {
      let left = ms;
      while (left > 0) {
        guard();
        const chunk = Math.min(left, MAX_LEASE_MS);
        if (!loop.holdFor(chunk, x, y)) throw new Interrupt(armed() ? "This body cannot drive." : latchReason(), !armed());
        await sleep(chunk);
        left -= chunk;
      }
      loop.setHeld(false);
    }

    async function frames(list) {
      const t0 = clock.now();
      for (let i = 0; i < list.length; i++) {
        const [at, pose] = list[i];
        await sleep(t0 + at - clock.now());
        await applyPose(pose, i === list.length - 1);
      }
    }

    async function runStep(step) {
      guard();
      switch (step.tool) {
        case "wait":
          return sleep(step.seconds * 1000);
        case "say":
          return emit({ type: "say", text: step.text });
        case "stop":
          await loop.stop("The AI pilot stopped the robot. Press ARM to continue.");
          return "stop";
        case "drive": {
          const [dx, dy] = DIRECTIONS[step.direction];
          const k = (step.speed ?? 100) / 100; // scales the stick inside the user's cap: the cap itself is never touched
          return hold(step.seconds * 1000, dx * k, dy * k);
        }
        case "turn": {
          const secs = turnSeconds(step.degrees, step.speed ?? 100, loop.snapshot.speed);
          if (secs <= 0) return undefined;
          const k = (step.speed ?? 100) / 100;
          return hold(secs * 1000, (step.degrees > 0 ? -1 : 1) * k, 0); // stick x is right-positive, degrees are left-positive
        }
        case "look": {
          const pose = {};
          if (step.pan !== undefined) pose.head_pan = step.pan;
          if (step.tilt !== undefined) pose.head_tilt = step.tilt;
          return applyPose(pose);
        }
        case "set_joints":
          return applyPose(step.joints);
        case "torso":
          return applyPose({ torso_yaw: step.yaw });
        case "gesture":
          return frames(gestureFrames(step.name) || []);
        case "pose":
          return frames(poseFrames(step.name) || []);
        default:
          return undefined;
      }
    }

    emit({ type: "plan-start", total: steps.length });
    try {
      for (let i = 0; i < steps.length; i++) {
        index = i;
        guard();
        emit({ type: "step-start", index: i, step: steps[i] });
        const r = await runStep(steps[i]);
        completed++;
        emit({ type: "step-end", index: i, step: steps[i] });
        if (r === "stop") {
          emit({ type: "done" });
          return finish("stopped", "The plan stopped the robot.");
        }
      }
      index = null;
      emit({ type: "done" });
      return finish("done");
    } catch (e) {
      if (!(e instanceof Interrupt)) throw e;
      if (e.reason === PLAN_TIMEOUT) loop.setHeld(false); // not an abort: let go of the wheels here
      emit({ type: "aborted", reason: e.reason, index });
      return finish("aborted", e.reason, e.latched);
    } finally {
      signal.removeEventListener("abort", onAbort);
      running = false;
    }
  }

  return {
    run,
    get running() {
      return running;
    },
  };
}
