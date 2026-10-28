// My IRL lab, "bring your agent to life": the SHOWCASE for the eight robot classes that are not AX-1 bodies (Synth Arm,
// Street Rover, Cyber Hound, Ghost Hand, Spider Mech, Sky Drone, Fab Rig, Replicant). Nothing here drives: there is no
// bridge, no drive loop, no ARM and no STOP (nothing can move toward anything). The twin stands where it was placed and
//   * "Its move" plays the token's own gesture once, frame by frame at MOTION.fps, the same frames as its animated NFT
//     (web/js/models/motion.mjs); the twin ends on the token's pose,
//   * "Turn left" / "Turn right" turn it on the spot: a tap turns 45°, a hold keeps turning until the finger lifts.
// It has the same interface ar.js uses from ar-controller.js (view, state, snapshot, start, place, frame, chip, press,
// release, stop, hold, obstacle, visibility, ended, arm, say, seek, body, bodyKey), most of it doing nothing, so ar.js
// branches in a few places and the AX-1 paths stay untouched. No DOM, no three: the motion arrives from the page.
import { MOTION } from "../models/motion.mjs";
import { chipsFor } from "./chips.js";

export const STATES = { READY: "ready", STARTING: "starting", PLACING: "placing", ARMED: "armed", LATCHED: "latched" };
/** Turning: rad/s, one tap, the longest frame step honoured (a stalled page never jumps), the longest a hold may last. */
export const TURN = Object.freeze({ RATE: 1.2, TAP: Math.PI / 4, MAX_DT: 0.1, MAX_HOLD_S: 20 });
export const SHOWCASE_NOTE = "Only the AX-1 bodies are driven in AR today. This one shows its signature move and turns on the spot.";

const EMPTY_AI = Object.freeze({ state: "idle", running: false, busy: false, messages: [], plan: null, progress: null });
/** An angle in (-π, π]. */
export const wrap = (a) => {
  const t = Math.PI * 2;
  let r = a % t;
  if (r > Math.PI) r -= t;
  else if (r <= -Math.PI) r += t;
  return r;
};

/**
 * createShowcase({ name, onChange }) -> controller-shaped object. `name` is the robot's class name ("Cyber Hound").
 * attach({ motion, face, faceHome }) hands it the token's motion once the view has built and dressed the robot:
 * motion = createMotion(...) ({ frames, pose(i) } -> { look, mood }), face = the rig's phone face or null,
 * faceHome = { look: [x, y], mood } as the art draws it at rest.
 */
export function createShowcase({ name = "Robot", onChange = () => {} } = {}) {
  let state = STATES.READY;
  let mode = null;
  let placed = false;
  let motion = null;
  let face = null;
  let faceHome = { look: [0, 0], mood: "idle" };
  let heading = 0; // rad, the turn on the spot, added to the placement's own direction
  let turnLeft = 0; // rad still to turn (a tap), signed: negative = left
  let holdDir = 0; // -1 left, +1 right while a turn button is held
  let heldFor = 0;
  let playing = false;
  let elapsed = 0;
  let lastFrame = -1;
  let notice = "";
  const out = { x: 0, z: 0, yaw: 0, clamped: false, ds: 0, dyaw: 0 };

  const emit = () => {
    try {
      onChange(api.view);
    } catch {} // a UI callback never breaks the twin
  };

  function look(f) {
    if (!face) return;
    const [bx, by] = faceHome.look;
    face.setLook(bx + (f && f.look ? f.look[0] : 0), by + (f && f.look ? f.look[1] : 0));
    face.setMood((f && f.mood) || faceHome.mood);
  }
  function rest() {
    if (motion) look(motion.pose(0)); // frame 0 is the token's own pose
    playing = false;
    elapsed = 0;
    lastFrame = -1;
  }
  const idle = () => {
    holdDir = 0;
    heldFor = 0;
    turnLeft = 0;
  };

  const api = {
    get state() {
      return state;
    },
    get body() {
      return null; // no ax-proto body: nothing is connected
    },
    get bodyKey() {
      return "showcase";
    },
    get pose() {
      return out;
    },
    get snapshot() {
      return null;
    },
    get seek() {
      return null;
    },
    set seek(v) {},
    /** The heading added by the person's turning, in (-π, π]. */
    get heading() {
      return heading;
    },
    get playing() {
      return playing;
    },
    get view() {
      return {
        state,
        mode,
        link: "disconnected",
        armed: false,
        placed,
        message: "",
        notice,
        heard: "",
        hint: state === STATES.PLACING ? (mode === "camera" ? `Tap the screen to put the ${name} down.` : `Aim at the floor and tap to put the ${name} there.`) : state === STATES.ARMED ? `The ${name} is on show. Tap Its move.` : "",
        canPlace: state === STATES.PLACING || state === STATES.ARMED,
        canArm: false,
        canStop: false,
        listening: false,
        voiceSupported: false,
        voiceNote: "",
        sensing: { level: "none", text: "" },
        radius: 0,
        body: "showcase",
        name,
        drives: false,
        walks: false,
        walking: false,
        showcase: true,
        playing,
        turning: holdDir !== 0 || turnLeft !== 0,
        chips: chipsFor("showcase"),
        odometry: { x: 0, z: 0, yaw: heading },
        ai: EMPTY_AI,
      };
    },

    attach(m) {
      motion = m && m.motion ? m.motion : null;
      face = m && m.face ? m.face : null;
      faceHome = m && m.faceHome ? m.faceHome : { look: [0, 0], mood: "idle" };
      heading = 0;
      idle();
      rest();
    },

    /** The view is open (AR or the camera view): wait for the tap that puts the twin down. */
    async start(m) {
      if (state !== STATES.READY) return false;
      mode = m === "camera" ? "camera" : "xr";
      placed = false;
      heading = 0;
      idle();
      rest();
      notice = "";
      state = STATES.PLACING;
      emit();
      return true;
    },

    /** A tap on the floor (the view calls it): the twin stands there, facing the person, ready to show. Nothing to arm. */
    async place(opts) {
      if (!opts || opts.gesture !== true) return false;
      if (state !== STATES.PLACING && state !== STATES.ARMED) return false;
      heading = 0;
      idle();
      placed = true;
      state = STATES.ARMED; // "armed" is the page's word for "live"; here it means the twin is on show
      emit();
      return true;
    },

    arm() {
      return Promise.resolve(false); // nothing to arm
    },
    say() {
      return Promise.resolve(null);
    },
    listen() {
      return false;
    },

    /** A button: "move" plays the gesture once (a press while it plays is ignored); "left" / "right" turn 45°. */
    chip(id) {
      if (state !== STATES.ARMED || !motion) return Promise.resolve(null);
      if (id === "move") {
        if (!playing) {
          playing = true;
          elapsed = 0;
          lastFrame = -1;
          emit();
        }
      } else if (id === "left" || id === "right") {
        holdDir = 0;
        turnLeft = (id === "left" ? -1 : 1) * TURN.TAP;
        emit();
      }
      return Promise.resolve(null);
    },

    /** A turn button held down: it keeps turning until release() (or TURN.MAX_HOLD_S, if a lift is ever lost). */
    press(dir) {
      if (state !== STATES.ARMED || (dir !== "left" && dir !== "right")) return false;
      turnLeft = 0;
      holdDir = dir === "left" ? -1 : 1;
      heldFor = 0;
      emit();
      return true;
    },
    release() {
      if (!holdDir) return;
      holdDir = 0;
      emit();
    },

    /** STOP, Esc, the page going to the background: the turning stops and the gesture ends on the token's pose. */
    stop() {
      idle();
      if (playing) rest();
      emit();
      return Promise.resolve();
    },
    hold() {
      return api.stop();
    },
    obstacle() {},
    visibility(v) {
      if (v === "hidden" || v === "visible-blurred") return api.stop();
      return Promise.resolve();
    },

    /**
     * Every render frame, with the seconds since the last. Advances the gesture (frame floor(t * fps) of the token's motion)
     * and the turning; returns the pose the view puts the twin at { x: 0, z: 0, yaw } (the view adds the placement).
     */
    frame(dt) {
      out.ds = 0;
      out.dyaw = 0;
      out.clamped = false;
      const d = Number.isFinite(dt) ? Math.min(Math.max(dt, 0), TURN.MAX_DT) : 0;
      if (d > 0 && state === STATES.ARMED) {
        if (playing && motion) {
          elapsed += d;
          const i = Math.floor(elapsed * MOTION.fps);
          if (i >= motion.frames) {
            rest(); // the gesture is over: exactly the token's pose
            emit();
          } else if (i !== lastFrame) {
            lastFrame = i;
            look(motion.pose(i));
          }
        }
        let step = 0;
        if (holdDir) {
          heldFor += d;
          if (heldFor > TURN.MAX_HOLD_S) holdDir = 0;
          else step = holdDir * TURN.RATE * d;
        } else if (turnLeft) {
          step = Math.sign(turnLeft) * Math.min(Math.abs(turnLeft), TURN.RATE * d);
          turnLeft -= step;
          if (Math.abs(turnLeft) < 1e-9) {
            turnLeft = 0;
            emit();
          }
        }
        if (step) {
          heading = wrap(heading + step);
          out.dyaw = step;
        }
      }
      out.yaw = heading;
      return out;
    },

    /** The AR session or the camera view ended, or the person left. */
    async ended() {
      idle();
      rest();
      mode = null;
      placed = false;
      heading = 0;
      state = STATES.READY;
      emit();
    },
  };
  return api;
}
