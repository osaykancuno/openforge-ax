// The AX-1 Walker twin's walk (My IRL lab): a step cycle on its leg joints, driven by how far the twin really moved, so
// the feet keep pace with the body. Pure: no DOM, no three. The real Walker's bridge has no gait yet: this walk is the
// twin's (see docs/18), the protocol and the firmware are unchanged.
//
// Angles are the bridge's degrees (ax-proto.js joints), added to whatever pose the bridge holds (stand, crouch...).
// Signs, from the crouch pose: hip_pitch < 0 swings the leg forward, knee > 0 bends it, and a foot stays flat on the
// floor when hip_pitch + knee + ankle_pitch = 0.

export const WALK = Object.freeze({
  SPEED: 0.12, // m/s, walking forward or back
  TURN: Math.PI / 4, // rad/s, turning on the spot
  CYCLE_M: 0.22, // metres per full cycle (a left and a right step of about 11 cm)
  TURN_R: 0.07, // metres a foot travels per radian when turning on the spot (half the stance width)
  HIP: 18, // degrees of leg swing
  KNEE: 34, // degrees of knee lift on the swinging leg
  ROLL: 5, // degrees of side sway onto the standing leg
  HIP_YAW: 10, // degrees of foot turn per step when turning
  TORSO: 5, // degrees of torso counter-twist
  TILT: 2, // degrees of head bob
  EASE: 8, // 1/s: how fast the legs settle in and out of the walk
});

/**
 * gaitOffsets(phase, amp, turn) -> { joint: degrees } to add to the bridge's pose. `phase` in radians (one cycle is
 * 2π: the left leg swings while cos(phase) > 0), `amp` 0..1 (0: no offset at all), `turn` -1..1 (left..right on the spot).
 */
export function gaitOffsets(phase, amp, turn = 0) {
  const s = Math.sin(phase), c = Math.cos(phase);
  const a = Number.isFinite(amp) ? Math.min(1, Math.max(0, amp)) : 0;
  const t = Number.isFinite(turn) ? Math.min(1, Math.max(-1, turn)) : 0;
  const hip = WALK.HIP * s * (1 - Math.abs(t) * 0.6); // smaller strides when turning on the spot
  const lHip = -hip * a, rHip = hip * a;
  const lKnee = WALK.KNEE * Math.max(0, c) * a, rKnee = WALK.KNEE * Math.max(0, -c) * a;
  const sway = WALK.ROLL * c * a; // onto the right leg while the left one swings
  const yaw = WALK.HIP_YAW * t * Math.abs(s) * a;
  return {
    l_hip_pitch: lHip,
    r_hip_pitch: rHip,
    l_knee: lKnee,
    r_knee: rKnee,
    l_ankle_pitch: -(lHip + lKnee), // the foot stays flat
    r_ankle_pitch: -(rHip + rKnee),
    l_hip_roll: sway,
    r_hip_roll: sway,
    l_ankle_roll: -sway,
    r_ankle_roll: -sway,
    l_hip_yaw: yaw,
    r_hip_yaw: -yaw,
    torso_yaw: WALK.TORSO * s * a,
    head_tilt: WALK.TILT * Math.sin(2 * phase) * a,
  };
}

/**
 * createGait() -> { step(dt, ds, dyaw), offsets() }: `ds` metres moved forward (negative: back) and `dyaw` radians turned
 * since the last frame. The phase follows the distance, the amplitude eases in while it moves and out when it stops.
 */
export function createGait() {
  let phase = 0;
  let amp = 0;
  let turn = 0;
  return {
    step(dt, ds, dyaw) {
      const d = Number.isFinite(dt) ? Math.max(0, Math.min(dt, 0.1)) : 0;
      const move = Number.isFinite(ds) ? ds : 0;
      const rot = Number.isFinite(dyaw) ? dyaw : 0;
      const travel = Math.abs(move) > 1e-6 ? move : Math.abs(rot) * WALK.TURN_R; // turning on the spot: small steps
      phase = (phase + (2 * Math.PI * travel) / WALK.CYCLE_M) % (2 * Math.PI);
      const moving = Math.abs(move) > 1e-6 || Math.abs(rot) > 1e-6;
      amp += ((moving ? 1 : 0) - amp) * Math.min(1, d * WALK.EASE);
      if (!moving && amp < 0.01) amp = 0;
      turn = Math.abs(move) > 1e-6 ? 0 : Math.sign(rot);
      return amp;
    },
    get phase() {
      return phase;
    },
    get amp() {
      return amp;
    },
    offsets() {
      return gaitOffsets(phase, amp, turn);
    },
  };
}
