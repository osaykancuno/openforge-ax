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
