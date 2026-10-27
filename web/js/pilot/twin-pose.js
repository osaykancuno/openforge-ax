// Twin odometry: where the Rover is, integrated from the wheel outputs the bridge REPORTS in AX_STATE (never from what
// the app asked for), so the twin on screen is what the bridge state machine decided. Shared by the Pilot page (flat 3D
// view) and the AR page (the twin on your floor). Pure: no DOM, no three, no allocation per frame.
//
// Frame: metres, Y up, the Rover faces +Z at yaw 0, yaw grows toward +X (forward = (sin yaw, cos yaw)). A positive
// yaw turns the Rover to its right (clockwise seen from above), exactly as the Pilot twin always did.
import * as P from "./ax-proto.js";

export const VMAX = 0.35; // m/s at full wheel output
export const TRACK = 0.2; // m between the wheels
export const FRONT = 0.08; // m from the pose (the wheel axle's middle) to the front bumper

/** Wheel outputs [left, right] (-1000..1000) of a decoded AX_STATE, or [0, 0] (no state, a body without wheels). */
export function wheelsFromState(st, body) {
  const def = P.BODIES[body];
  if (!st || !def || !def.drive || !st.positions) return [0, 0];
  const names = P.stateChannels(body);
  return [st.positions[names.indexOf("drive_l")] || 0, st.positions[names.indexOf("drive_r")] || 0];
}

/**
 * One odometry step. Mutates `pose` ({ x, z, yaw }) in place. With a radius the pose is kept inside that circle around
 * the origin (the edge of the mat) and the return value is true when this step pushed against the edge; a pure turn at
 * the edge, or moving back inside, is not "clamped". Returns false without a radius.
 */
export function stepPose(pose, l, r, dt, { radius = Infinity } = {}) {
  const v = ((l + r) / 2000) * VMAX;
  const w = ((r - l) / 1000) * (VMAX / TRACK);
  pose.yaw += w * dt;
  pose.x += Math.sin(pose.yaw) * v * dt;
  pose.z += Math.cos(pose.yaw) * v * dt;
  const d = Math.hypot(pose.x, pose.z);
  if (d > radius) {
    pose.x *= radius / d;
    pose.z *= radius / d;
    return d - radius > 1e-9; // rounding fuzz after the scale is not an edge hit
  }
  return false;
}

/** World pose of the Rover: the placement { x, y, z, yaw } with the local odometry { x, z, yaw } under it. */
export function composePose(place, local) {
  const s = Math.sin(place.yaw);
  const c = Math.cos(place.yaw);
  return { x: place.x + local.x * c + local.z * s, y: place.y, z: place.z - local.x * s + local.z * c, yaw: place.yaw + local.yaw };
}

/** Yaw that makes a Rover standing at `from` ({ x, z }) face the point `to`. */
export function faceToward(from, to) {
  return Math.atan2(to.x - from.x, to.z - from.z);
}

/**
 * Puts a decoded bridge snapshot on a robot rig: joints (deci -> degrees), wheel spins, and, for a wheeled body, the pose
 * (stepped by `dt`, then written to rig.group). `rig` is duck-typed ({ set, setSpin, group }). With dt = 0 the pose is only
 * written, which is how the AR page applies the pose its controller already advanced. Returns true when the pose hit the
 * edge of the mat. Does nothing (false) without a rig or a state.
 */
export function applyTwinState(rig, snap, body, pose, dt, { radius = Infinity } = {}) {
  if (!rig) return false;
  const st = snap && snap.state;
  if (!(st && snap.body === body)) {
    rig.setSpin("wheel", 0);
    return false;
  }
  const names = P.stateChannels(body);
  names.forEach((n, i) => {
    if (n === "drive_l" || n === "drive_r") return;
    if (i < st.positions.length) rig.set(n, st.positions[i] / 10);
  });
  if (!P.BODIES[body].drive) return false;
  const [l, r] = wheelsFromState(st, body);
  rig.setSpin("wheel-l", (l / 1000) * 1.1);
  rig.setSpin("wheel-r", (r / 1000) * 1.1);
  const clamped = stepPose(pose, l, r, dt, { radius });
  rig.group.position.set(pose.x, 0, pose.z);
  rig.group.rotation.y = pose.yaw;
  return clamped;
}
