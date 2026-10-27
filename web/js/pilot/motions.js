// Move library shared by the buttons (pilot.js), the AI parser and the AI executor: Desk gestures as app-side
// keyframes, Walker poses, and the Desk's home pose. The bridge rate-limits every move to 90 deg/s x speed.
//
// Frames are [milliseconds from the start, { joint_name: degrees }]. Joint names and ranges come from ax-proto.js.
// Angle convention of the twin's joints: positive yaw / pan = LEFT, positive tilt = UP.

export const DESK_HOME = { torso_yaw: 0, head_pan: 0, head_tilt: 0, l_shoulder: 0, l_elbow: -20, r_shoulder: 0, r_elbow: -20 };

export const GESTURES = {
  wave: [[0, { r_shoulder: -150, r_elbow: -40, head_tilt: 10 }], [1600, { r_elbow: -100 }], [2300, { r_elbow: -40 }], [3000, { r_elbow: -100 }], [3700, { r_elbow: -40 }], [4500, DESK_HOME]],
  nod: [[0, { head_tilt: 25 }], [700, { head_tilt: -10 }], [1400, { head_tilt: 25 }], [2100, { head_tilt: -10 }], [2800, { head_tilt: 0 }]],
  point: [[0, { torso_yaw: -25, head_pan: -20, r_shoulder: -90, r_elbow: 0 }], [3000, DESK_HOME]],
  shrug: [[0, { l_shoulder: -40, r_shoulder: -40, l_elbow: -90, r_elbow: -90, head_tilt: 15 }], [1800, DESK_HOME]],
  home: [[0, DESK_HOME]],
};

const legs = (o) => ({ ...Object.fromEntries(["l", "r"].flatMap((s) => [`${s}_hip_yaw`, `${s}_hip_roll`, `${s}_hip_pitch`, `${s}_knee`, `${s}_ankle_pitch`, `${s}_ankle_roll`].map((n) => [n, 0]))), torso_yaw: 0, ...o });

export const POSES = {
  stand: legs({}),
  crouch: legs({ l_hip_pitch: -40, r_hip_pitch: -40, l_knee: 80, r_knee: 80, l_ankle_pitch: -40, r_ankle_pitch: -40 }),
  "lean left": legs({ l_hip_roll: 10, r_hip_roll: 10, l_ankle_roll: -10, r_ankle_roll: -10 }),
  "lean right": legs({ l_hip_roll: -10, r_hip_roll: -10, l_ankle_roll: 10, r_ankle_roll: 10 }),
  twist: legs({ torso_yaw: 40 }),
};

/** Gesture keyframes by name (own keys only), or null. */
export const gestureFrames = (name) => (typeof name === "string" && Object.hasOwn(GESTURES, name) ? GESTURES[name] : null);
/** A pose as keyframes, or null. */
export const poseFrames = (name) => (typeof name === "string" && Object.hasOwn(POSES, name) ? [[0, POSES[name]]] : null);
/** Total length of a gesture in milliseconds (its last keyframe), 0 if unknown. */
export const gestureMs = (name) => {
  const f = gestureFrames(name);
  return f ? f[f.length - 1][0] : 0;
};
