// DeviceOrientation to a camera quaternion, for the camera view (no WebXR): the phone's compass/tilt angles, in degrees as
// the browser reports them (alpha about Z, beta about X, gamma about Y), become the rotation of a three.js camera that
// looks out of the back of the phone. Same maths as three's DeviceOrientationControls, without three. Pure.

const RAD = Math.PI / 180;
const num = (v) => (Number.isFinite(v) ? v : 0);

/** Quaternion product a * b, both [x, y, z, w]. */
function mul(a, b) {
  return [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ];
}

/**
 * orientationQuat(alpha, beta, gamma, screenAngle) -> [x, y, z, w]. Angles in degrees; null or NaN read as 0.
 * Phone upright facing the horizon (beta 90) is the identity; alpha turns the camera to the left.
 */
export function orientationQuat(alpha, beta, gamma, screenAngle) {
  // Euler (beta, alpha, -gamma) in YXZ order
  const x = num(beta) * RAD;
  const y = num(alpha) * RAD;
  const z = -num(gamma) * RAD;
  const c1 = Math.cos(x / 2), c2 = Math.cos(y / 2), c3 = Math.cos(z / 2);
  const s1 = Math.sin(x / 2), s2 = Math.sin(y / 2), s3 = Math.sin(z / 2);
  let q = [s1 * c2 * c3 + c1 * s2 * s3, c1 * s2 * c3 - s1 * c2 * s3, c1 * c2 * s3 - s1 * s2 * c3, c1 * c2 * c3 + s1 * s2 * s3];
  q = mul(q, [-Math.SQRT1_2, 0, 0, Math.SQRT1_2]); // the camera looks out of the back of the phone: -90 degrees about X
  const o = -num(screenAngle) * RAD; // counter-rotate for the screen orientation, about Z
  q = mul(q, [0, 0, Math.sin(o / 2), Math.cos(o / 2)]);
  const n = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
  return [q[0] / n, q[1] / n, q[2] / n, q[3] / n];
}

/** q0^-1 * q: the turn since the reference orientation q0, so the camera view starts where the user was looking. */
export function relativeQuat(q0, q) {
  return mul([-q0[0], -q0[1], -q0[2], q0[3]], q);
}

// ---------------------------------------------------------------- the floor in the camera view (iPhone, any phone without WebXR AR)
// With the motion sensors the camera view knows the phone's real tilt (gravity), so the floor of the 3D scene lines up with
// the real floor: the phone is assumed at a typical height above the surface and a tap's ray meets that floor. It follows
// the phone's turning, not its steps (no ARKit/ARCore tracking in the browser here).

/** Height of the phone above the surface the twin stands on, in metres: standing over the floor, or sitting at a table. */
export const PHONE_HEIGHT = Object.freeze({ rover: 1.25, walker: 1.25, desk: 0.45 });

/** tan(half the field of view) along the long side of a phone's main back camera (about 26 mm equivalent). */
export const CAMERA_TAN_LONG = 0.68;

/**
 * cameraFovDeg({ videoW, videoH, viewW, viewH }) -> the vertical field of view (degrees) of the picture shown with
 * `object-fit: cover` in a viewW x viewH box, so the 3D camera matches the real lens. null until the video has a size.
 */
export function cameraFovDeg({ videoW, videoH, viewW, viewH, tanLong = CAMERA_TAN_LONG }) {
  if (!(videoW > 0 && videoH > 0 && viewW > 0 && viewH > 0)) return null;
  const s = Math.max(viewW / videoW, viewH / videoH); // cover: the video is scaled up until it fills the box
  const shownH = viewH / s; // video pixels visible from top to bottom
  const tanHalf = (tanLong * shownH) / Math.max(videoW, videoH);
  return (2 * Math.atan(tanHalf) * 180) / Math.PI;
}

/**
 * floorHit(origin, dir, { floorY, maxM }) -> { x, z, dist } where the ray origin + t * dir meets the horizontal floor,
 * or null when it points level or up, or meets the floor farther than maxM (horizontally) from the phone.
 */
export function floorHit(origin, dir, { floorY = 0, maxM = 4 } = {}) {
  const [ox, oy, oz] = origin;
  const [dx, dy, dz] = dir;
  if (!(dy < -0.02) || !(oy > floorY)) return null;
  const t = (floorY - oy) / dy;
  const x = ox + dx * t, z = oz + dz * t;
  const dist = Math.hypot(x - ox, z - oz);
  return dist <= maxM ? { x, z, dist } : null;
}
