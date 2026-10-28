// AX-1 in your room: the controller behind web/ar.html. No DOM, no three: the page (ar-view.js, ar.js) feeds it what the
// phone sees (taps, voice, depth, visibility) and renders its `view`; every decision about the Rover lives here.
//
//   ready --start()--> starting --> placing --place(gesture)--> armed <--> latched
//   armed --STOP | Esc | page hidden | AR hidden | voice "stop" | plan stop step | bridge latch--> latched (nothing resumes)
//   armed --obstacle ahead | edge of the play area | AR blurred--> armed (hold: the plan is interrupted, wheels 0)
//   latched --ARM button--> armed;   any --AR ended--> ready
//
// The rules of the AI Pilot hold unchanged. Nothing here arms except place() (a tap on the floor) and arm() (the ARM
// button): voice, chips, the model and the AI never reach them. Every motion goes plan -> executor -> guarded drive loop ->
// twin transport -> bridge state machine -> AX_STATE; the guard only REFUSES forward drives that would hit something. The
// Rover is a TWIN: a picture driven by the real bridge logic, never a real robot.
import * as P from "../pilot/ax-proto.js";
import { createDriveLoop, LINK } from "../pilot/drive-loop.js";
import { createTwinTransport, realTimers } from "../pilot/twin-transport.js";
import { createAiPilot } from "../pilot/ai/ai-pilot.js";
import { cleanSay } from "../pilot/ai/tools.js";
import { VMAX, stepPose, wheelsFromState } from "../pilot/twin-pose.js";
import { CHIPS, chipText } from "./chips.js";
import { createArParser } from "./ar-parse.js";
import { edgeAhead, isBackStep, isBackWheels, isForwardStep, isForwardWheels } from "./obstacle.js";

export const STATES = { READY: "ready", STARTING: "starting", PLACING: "placing", ARMED: "armed", LATCHED: "latched" };
export const CAMERA_SENSING = "Obstacle sensing needs Android Chrome AR";
const MAX_SAY = 500;
// Obstacles: the Rover drives up to them and stops STOP_GAP_M before (front bumper to the surface). It starts stopping
// BRAKE_S of travel earlier: the drive loop's stop and the bridge's slew, plus one depth frame of delay.
export const STOP_GAP_M = 0.05;
export const BRAKE_S = 0.2;
export const STOP_TEXT = `I stopped about ${Math.round(STOP_GAP_M * 100)} cm before something in my way. I can turn or back up.`;
export const STOP_BACK_TEXT = `I stopped about ${Math.round(STOP_GAP_M * 100)} cm before something behind me. I can turn or drive forward.`;
const stopAt = (v) => STOP_GAP_M + Math.max(0, v) * BRAKE_S;
/** Nearer than this, even a full-speed start would end inside the gap: sensing says "blocked" (and the page's chip turns red). */
export const NEAR_STOP_M = stopAt(VMAX);
// Hold-to-drive (a direction chip held down): short leases through the same guarded loop as a plan, renewed while the
// finger stays down. Release, STOP, an obstacle or the edge end it; a frozen page ends it by itself within one lease.
export const HOLD_LEASE_MS = 400;
export const HOLD_RENEW_MS = 150;
const HOLD_STICK = { forward: [0, 1], back: [0, -1], left: [-0.6, 0], right: [0.6, 0] }; // x = turn (negative = left), y = forward
const STOP_WORDS = /\b(stop|halt|freeze|brake|abort)\b/i; // anywhere in the sentence: "ok stop" stops at once
const BLUR_MESSAGE = "AR is paused (something is on top of the camera view), so I stopped moving.";
const EMPTY_AI = Object.freeze({ state: "idle", running: false, busy: false, messages: [], plan: null, progress: null });
const ROVER = P.bodyByKey("rover");

const VOICE_ERRORS = {
  "not-allowed": "The microphone is not allowed for this page. Allow it in your browser's site settings, or use the buttons.",
  "service-not-allowed": "Speech recognition is not allowed here. Use the buttons instead.",
  "no-speech": "I did not hear anything. Tap the microphone and try again.",
  "audio-capture": "No microphone found.",
  network: "Speech recognition needs a connection to your browser's speech service. Use the buttons instead.",
  aborted: "",
};
const voiceErrorText = (state) => {
  const code = String(state).slice("error:".length);
  return Object.hasOwn(VOICE_ERRORS, code) ? VOICE_ERRORS[code] : "Voice input stopped. Use the buttons instead.";
};

/**
 * createArController({ clock, makeTransport, voice, wake, parse, extensions, onChange, createAi, radius })
 *   clock          { now, setInterval, ... } (twin-transport realTimers by default; tests pass a fake)
 *   makeTransport  () => twin transport (default: the Rover twin with 15 ms of simulated BLE latency)
 *   voice          createVoiceInput() result or null;  wake  createWakeLock() result or null
 *   parse          (text, bodyKey, opts) => result; default = createArParser({ obstacle filter, extensions })
 *   extensions     ar-parse extensions (object intents), used by the default parser
 *   onChange(view) fires on every change (a throwing callback never breaks the controller)
 *   radius         play area radius in metres (3; the camera view uses at most 1.5)
 */
export function createArController({ clock = realTimers, makeTransport = null, voice = null, wake = null, parse = null, extensions = [], onChange = () => {}, createAi = createAiPilot, radius = 3 } = {}) {
  let state = STATES.READY;
  let mode = null; // "xr" | "camera"
  let loop = null; // the REAL drive loop
  let guarded = null; // what the AI gets: the same loop, with holdFor guarded
  let ai = null;
  let snap = null; // latest drive-loop snapshot
  let obst = null; // latest obstacle tracker result
  let obstPose = null; // the odometry pose when that result was measured
  let obstBack = null; // the same, behind the Rover (reversing)
  let obstBackPose = null;
  let pressing = null; // hold-to-drive: { dir, timer } while a chip is held down
  let seek = null; // an object-seeking helper with cancel(), set by the page
  let placed = false;
  let ending = false;
  let message = "";
  let notice = "";
  let heard = "";
  let listening = false;
  let voiceNote = "";
  let playRadius = radius;
  let loopSig = "";
  const pose = { x: 0, z: 0, yaw: 0 }; // local odometry under the placement
  const out = { x: 0, z: 0, yaw: 0, clamped: false }; // frame()'s result, reused

  const emit = () => {
    try {
      onChange(api.view);
    } catch {} // a UI callback never breaks the Rover
  };
  const resetPose = () => {
    pose.x = 0;
    pose.z = 0;
    pose.yaw = 0;
  };
  /**
   * Metres from the bumper to the obstacle now (side "front" or "back"): the measured distance minus what the Rover drove
   * toward it since. Infinity: none.
   */
  const obstacleAhead = (side = "front") => {
    const o = side === "back" ? obstBack : obst;
    if (mode !== "xr" || !o || o.state !== "blocked") return Infinity;
    const p = (side === "back" ? obstBackPose : obstPose) || pose;
    const driven = (pose.x - p.x) * Math.sin(p.yaw) + (pose.z - p.z) * Math.cos(p.yaw); // forward along the heading
    return o.nearM - (side === "back" ? -driven : driven);
  };
  /** Blocked = too close to drive toward that side at speed v (m/s): the stop would end nearer than STOP_GAP_M. */
  const isBlocked = (v = 0, side = "front") => obstacleAhead(side) <= stopAt(v);
  const forwardSpeed = () => {
    if (!snap || snap.body !== ROVER) return 0;
    const [l, r] = wheelsFromState(snap.state, ROVER);
    return ((l + r) / 2000) * VMAX;
  };
  const edgeText = () => `I'm at the edge of my ${+playRadius.toFixed(2)} m play area.`;

  function sensing() {
    if (mode === "camera") return { level: "off", text: CAMERA_SENSING };
    if (isBlocked(VMAX, "back") && !isBlocked(VMAX)) return { level: "blocked", text: STOP_BACK_TEXT }; // backed up to something
    if (!obst) return { level: "off", text: "" };
    if (obst.state === "blocked" && !isBlocked(VMAX)) return { level: "ahead", text: obst.message || "" }; // seen, still room to drive
    const text = obst.state === "clear" ? "Obstacle sensing: clear" : obst.state === "blocked" ? STOP_TEXT : obst.message || "";
    return { level: obst.state, text };
  }
  function hint() {
    switch (state) {
      case STATES.PLACING:
        return mode === "camera" ? "Tap the screen to wake the Rover." : "Aim at the floor and tap to put the Rover there.";
      case STATES.ARMED:
        return "The Rover is awake. Say or tap what it should do. STOP stops it.";
      case STATES.LATCHED:
        return "The Rover is stopped. Press ARM to let it move again.";
      default:
        return "";
    }
  }

  // The loop the AI gets: everything passes straight through except holdFor, which refuses a forward drive into an obstacle
  // or past the edge of the play area (and then interrupts the plan), and the calls that would arm, connect or change the
  // speed cap, which are not the AI's to make.
  const denied = {
    arm: () => Promise.resolve(false),
    connect: () => Promise.resolve(),
    disconnect: () => Promise.resolve(),
    setSpeed: () => {},
    setStick: () => {}, // a stick would bypass the obstacle and edge checks on holdFor
  };
  function guard(real) {
    return new Proxy(real, {
      get(target, prop) {
        if (prop === "holdFor") {
          return (ms, x = 0, y = 1) => {
            // the speed this lease will really drive at: the stick times the speed cap the bridge applies
            const v = Math.abs(y) * VMAX * ((target.snapshot && Number.isFinite(target.snapshot.speed) ? target.snapshot.speed : 100) / 100);
            if (y < 0 && isBlocked(v, "back")) return api.hold(STOP_BACK_TEXT), false;
            if (y > 0) {
              if (isBlocked(v)) return api.hold(STOP_TEXT), false;
              if (edgeAhead(pose, playRadius) < 0.01) return api.hold(edgeText()), false;
            }
            return target.holdFor(ms, x, y);
          };
        }
        if (typeof prop === "string" && Object.hasOwn(denied, prop)) return denied[prop];
        return Reflect.get(target, prop, target);
      },
    });
  }

  /** Ends hold-to-drive renewals (the wheels are zeroed by whoever called this). */
  function releaseHold() {
    if (!pressing) return;
    clock.clearInterval(pressing.timer);
    pressing = null;
  }

  /** Holds a move that would end nearer than STOP_GAP_M to an obstacle ahead (driving forward) or behind (reversing). */
  function checkObstacle() {
    if (state !== STATES.ARMED || !loop) return;
    const step = ai && ai.running ? (ai.view.progress || {}).step : null;
    const w = loop.snapshot.wheels;
    if (isForwardWheels(w) || (!isBackWheels(w) && isForwardStep(step))) {
      if (isBlocked(isForwardWheels(w) ? forwardSpeed() : 0)) api.hold(STOP_TEXT);
    } else if (isBackWheels(w) || isBackStep(step)) {
      if (isBlocked(isBackWheels(w) ? -forwardSpeed() : 0, "back")) api.hold(STOP_BACK_TEXT);
    }
  }

  function onLoop(s) {
    snap = s;
    if (ai) ai.onLoopChange(s);
    const active = s.link === LINK.ARMED || s.link === LINK.DRIVING;
    if (state === STATES.ARMED && !active) {
      state = STATES.LATCHED; // the bridge latched, the loop stalled or the link dropped: nothing resumes
      message = s.message || "The Rover is stopped.";
    }
    const sig = `${s.link}|${s.message}|${state}`;
    if (sig !== loopSig) {
      loopSig = sig;
      emit();
    }
  }

  const api = {
    get state() {
      return state;
    },
    /** Local odometry { x, z, yaw } under the placement. Live object: do not keep it, read it. */
    get pose() {
      return pose;
    },
    get snapshot() {
      return loop ? loop.snapshot : snap;
    },
    /** Setter for the page: an object-seeking helper with cancel(); STOP cancels it. */
    get seek() {
      return seek;
    },
    set seek(v) {
      seek = v || null;
    },
    /** The real drive loop. For tests only: the page never touches it. */
    get _loop() {
      return loop;
    },
    get view() {
      const l = snap ? snap.link : LINK.DISCONNECTED;
      const armed = l === LINK.ARMED || l === LINK.DRIVING;
      const aiView = ai ? ai.view : EMPTY_AI;
      return {
        state,
        mode,
        link: l,
        armed,
        placed,
        message,
        notice,
        heard,
        hint: hint(),
        canPlace: state === STATES.PLACING || state === STATES.ARMED || state === STATES.LATCHED,
        canArm: state === STATES.LATCHED && placed,
        canStop: state === STATES.ARMED || aiView.busy,
        listening,
        voiceSupported: !!(voice && voice.supported),
        voiceNote,
        sensing: sensing(),
        radius: playRadius,
        chips: CHIPS,
        odometry: { x: pose.x, z: pose.z, yaw: pose.yaw },
        ai: aiView,
      };
    },

    /** The view has entered XR / the camera view. Connects the twin (LATCHED) and waits for the tap that places it. */
    async start(m) {
      if (state !== STATES.READY) return false;
      state = STATES.STARTING;
      mode = m === "camera" ? "camera" : "xr";
      playRadius = mode === "camera" ? Math.min(radius, 1.5) : radius;
      resetPose();
      placed = false;
      obst = null;
      obstBack = null;
      message = "";
      notice = "";
      heard = "";
      loopSig = "";
      const transport = (makeTransport || (() => createTwinTransport({ body: ROVER, clock, latencyMs: 15 })))();
      const mine = createDriveLoop({ transport, clock, onChange: onLoop });
      loop = mine;
      guarded = guard(mine);
      const arParse =
        parse ||
        createArParser({
          getBlocked: () => (isBlocked() ? { distanceM: Math.max(0, obstacleAhead()), message: STOP_TEXT } : null),
          getBlockedBack: () => (isBlocked(0, "back") ? { distanceM: Math.max(0, obstacleAhead("back")), message: STOP_BACK_TEXT } : null),
          getMode: () => mode,
          extensions,
        });
      ai = createAi({ getLoop: () => guarded, getBodyKey: () => "rover", getMode: () => "twin", getModel: () => null, parse: arParse, clock, onChange: () => emit() });
      emit();
      await mine.connect();
      if (loop !== mine) return false; // ended meanwhile
      if (mine.link !== LINK.LATCHED) {
        message = mine.snapshot.message || "The twin could not start.";
        loop = null;
        guarded = null;
        state = STATES.READY;
        emit();
        return false;
      }
      state = STATES.PLACING;
      if (wake) Promise.resolve(wake.on()).catch(() => {});
      emit();
      return true;
    },

    /**
     * A tap on the reticle / the floor / the camera view. A direct user gesture: the page must pass { gesture: true }.
     * First time (placing) the tap also arms the twin; afterwards it only moves the Rover back to the tap (pose 0), and
     * never while a plan is running. After a STOP it moves the Rover but does not arm.
     */
    async place(opts) {
      if (!opts || opts.gesture !== true) return false;
      if (!loop || state === STATES.READY || state === STATES.STARTING) return false;
      if (state === STATES.ARMED && ai && ai.running) {
        notice = "Let me finish first, or press STOP.";
        emit();
        return false;
      }
      if (ai) ai.takeover();
      resetPose();
      obst = null;
      obstBack = null;
      placed = true;
      notice = "";
      if (state !== STATES.PLACING) {
        emit();
        return true;
      }
      const mine = loop;
      const ok = await mine.arm(); // the user's tap is the one that arms
      if (loop !== mine) return false; // the session ended while it armed: READY stays READY
      if (ok) {
        state = STATES.ARMED;
        message = "";
      } else {
        state = STATES.LATCHED;
        message = (loop && loop.snapshot.message) || "The Rover could not be armed.";
      }
      emit();
      return ok;
    },

    /** The ARM button (a click). The only way back after a STOP. */
    async arm() {
      if (!loop || state !== STATES.LATCHED || !placed) return false;
      const mine = loop;
      const ok = await mine.arm();
      if (loop !== mine) return false; // the session ended while it armed
      if (ok) {
        state = STATES.ARMED;
        message = "";
        notice = "";
      } else {
        message = (loop && loop.snapshot.message) || "The Rover could not be armed.";
      }
      emit();
      return ok;
    },

    /** A request in words (voice transcript, chip phrase): untrusted text. A stop word anywhere in it is STOP. */
    async say(text, { source = "text" } = {}) {
      if (!loop || !ai || state === STATES.READY || state === STATES.STARTING) return null;
      const clean = cleanSay(typeof text === "string" ? text : "", MAX_SAY);
      if (!clean) return null;
      if (STOP_WORDS.test(clean)) {
        heard = source === "chip" ? "" : `I heard: ${clean}`;
        api.stop("Stopped: you said stop.");
        return null;
      }
      heard = source === "chip" ? "" : `I heard: ${clean}`;
      notice = "";
      emit();
      return ai.submit(clean);
    },

    chip(id) {
      const t = chipText(id);
      return t ? api.say(t, { source: "chip" }) : Promise.resolve(null);
    },

    /** The microphone button: listen for one sentence; tap again to stop listening. */
    listen() {
      if (!voice || !voice.supported || !loop) return false;
      if (voice.listening) {
        voice.stop();
        return true;
      }
      voiceNote = "";
      return voice.start(
        (text) => api.say(text, { source: "voice" }),
        (s) => {
          listening = s === "listening";
          voiceNote = String(s).startsWith("error:") ? voiceErrorText(s) : "";
          emit();
        },
      );
    },

    /**
     * Hold-to-drive: "forward" | "back" | "left" | "right" while a chip is held down. ARMED only; it ends a running plan
     * (you took the controls) and moves in HOLD_LEASE_MS leases through the guarded loop (obstacle stop, play-area edge).
     * Returns false when it cannot move (not armed, blocked: the reason is shown).
     */
    press(dir) {
      releaseHold();
      const xy = typeof dir === "string" && Object.hasOwn(HOLD_STICK, dir) ? HOLD_STICK[dir] : null;
      if (!xy || !guarded || state !== STATES.ARMED) return false;
      if (ai && ai.running) ai.takeover("You took the controls.");
      if (seek && typeof seek.cancel === "function") {
        try {
          seek.cancel("takeover");
        } catch {}
      }
      notice = "";
      const lease = () => {
        if (state === STATES.ARMED && guarded && guarded.holdFor(HOLD_LEASE_MS, xy[0], xy[1])) return true;
        releaseHold();
        return false;
      };
      if (!lease()) {
        emit();
        return false;
      }
      pressing = { dir, timer: clock.setInterval(lease, HOLD_RENEW_MS) };
      emit();
      return true;
    },

    /** The finger left the chip: the wheels stop at once. */
    release() {
      if (!pressing) return;
      releaseHold();
      if (loop) loop.setHeld(false);
      emit();
    },

    /** STOP, in this order: the AI first (it zeroes the wheels in the same call), then any seeking, then the drive loop. */
    stop(reason = "Stopped by you.") {
      releaseHold();
      notice = "";
      if (ai) ai.cancel("stop");
      if (seek && typeof seek.cancel === "function") {
        try {
          seek.cancel("stop");
        } catch {}
      }
      const done = loop ? loop.stop(reason) : Promise.resolve();
      if (state === STATES.ARMED) {
        state = STATES.LATCHED;
        message = cleanSay(reason, 200);
      }
      emit();
      return done;
    },

    /** Interrupts the plan and zeroes the wheels, but the Rover STAYS armed (an obstacle, the edge, AR paused). */
    hold(reason) {
      releaseHold();
      notice = cleanSay(String(reason), 200);
      if (ai) ai.cancel(notice);
      if (loop) loop.setHeld(false);
      emit();
    },

    /**
     * The tracker's latest result. An obstacle ahead lets the Rover drive on until it is STOP_GAP_M away (with the braking
     * distance at its speed added); then a forward move is held. A blocked result without a distance stops at once. The
     * camera view has no sensing.
     */
    obstacle(update) {
      if (mode !== "xr") return;
      if (update && typeof update === "object") {
        const near = Number.isFinite(update.nearM) ? update.nearM : Number.isFinite(update.distanceM) ? update.distanceM : 0;
        const o = { state: update.state, distanceM: update.distanceM ?? null, nearM: near, message: String(update.message || "") };
        const at = { x: pose.x, z: pose.z, yaw: pose.yaw };
        if (update.side === "back") {
          obstBack = o;
          obstBackPose = at;
        } else {
          obst = o;
          obstPose = at;
        }
      } else obst = null;
      checkObstacle();
      emit();
    },

    /** Call every render frame with the seconds since the last. Advances the odometry from what the bridge reports. */
    frame(dt) {
      out.clamped = false;
      if (loop && snap && snap.body === ROVER && dt > 0) {
        const [l, r] = wheelsFromState(snap.state, ROVER);
        out.clamped = stepPose(pose, l, r, Math.min(dt, 0.1), { radius: playRadius });
        if (out.clamped) api.hold(edgeText());
        else checkObstacle(); // between depth frames too: the odometry says how much nearer it is now
      }
      out.x = pose.x;
      out.z = pose.z;
      out.yaw = pose.yaw;
      return out;
    },

    /** XR visibilityState: "hidden" latches; "visible-blurred" holds; "visible" changes nothing by itself. */
    visibility(v) {
      if (v === "hidden") return api.stop("AR is hidden, so I stopped. Press ARM to continue.");
      if (v === "visible-blurred") api.hold(BLUR_MESSAGE);
      return Promise.resolve();
    },

    /** The AR session or camera view ended, or the user left: stop, disconnect, back to READY. */
    async ended(reason = "AR closed") {
      if (!loop || ending) return;
      ending = true;
      releaseHold();
      const l = loop;
      try {
        await api.stop(reason);
        await l.disconnect();
      } finally {
        if (voice && voice.listening) voice.stop();
        if (wake) Promise.resolve(wake.off()).catch(() => {});
        if (ai) ai.reset();
        loop = null;
        guarded = null;
        snap = null;
        obst = null;
        obstBack = null;
        mode = null;
        placed = false;
        listening = false;
        resetPose();
        state = STATES.READY;
        message = cleanSay(reason, 200);
        notice = "";
        ending = false;
        emit();
      }
    },
  };
  return api;
}
