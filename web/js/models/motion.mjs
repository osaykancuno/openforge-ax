// Token motion: the short gesture each robot class plays in its animated token (art/token/token.html, art/token-render.mjs)
// and in My IRL lab when an agent comes to life (web/js/ar/showcase.js). Plain ESM with no imports: pages and Node (the
// GIF timing) all load it.
// One loop = a few seconds of movement, then a still pause on the token's own pose, so the first frame and the pause are
// the still image and the loop restarts without a jump. Every gesture starts and ends at the token's pose (envelopes are
// 0 at both ends), wheels and props turn a whole number of times, and nothing is random: same token, same animation.
// Part of the art: covered by the provenance hash (GENERATOR_FILES in art/token-render.mjs).

/** Timing of one loop. The GIF holds the last (rest) frame for `pauseS`. */
export const MOTION = Object.freeze({ fps: 15, activeS: 2.6, pauseS: 1.6 });

const TAU = Math.PI * 2;
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smooth = (v) => (v = clamp01(v)) * v * (3 - 2 * v);
/** 0 → 1 → 0 between a and b (sin²): a single smooth swell. */
const win = (s, a, b) => (s <= a || s >= b ? 0 : Math.sin((Math.PI * (s - a)) / (b - a)) ** 2);
/** Up from a1 to a2, held, down from b1 to b2. */
const hold = (s, a1, a2, b1, b2) => Math.min(smooth((s - a1) / (a2 - a1)), 1 - smooth((s - b1) / (b2 - b1)));
/** A wave inside the held part: n cycles over [0, 1]. */
const wave = (s, n, phase = 0) => Math.sin(TAU * n * s + phase);
/** 0 → 1 over the loop with a soft start and stop: the share of a spinner's turns done by time s. */
const ramp = (s) => smooth(s);

// ---------------------------------------------------------------- one gesture per class (robot ids as in web/js/models/robots.js)
// Each gets (s, k, j, root) and returns nothing: s = 0..1 through the moving part, k = this token's variety
// { amp, side, lean }, j(name, deltaDeg) moves a joint from the token's pose, root.{move, lift, yaw, tilt} moves the body.
const GESTURES = {
  // Synth Arm: reaches to one side, closes the gripper on an imaginary cube, lifts it, turns it, sets it back
  so101(s, k, j) {
    const reach = hold(s, 0, 0.3, 0.7, 1);
    j("shoulder_pan", k.side * 38 * k.amp * win(s, 0, 1));
    j("shoulder_lift", 22 * k.amp * reach);
    j("elbow_flex", -18 * k.amp * reach);
    j("wrist_flex", 16 * k.amp * win(s, 0.1, 0.9));
    j("gripper", -75 * hold(s, 0.25, 0.4, 0.62, 0.78));
    j("wrist_roll", k.side * 70 * win(s, 0.38, 0.66));
  },
  // Street Rover: a curious scoot forward and back, a little wiggle, eyes following
  rover(s, k, j, root) {
    root.move(0.07 * k.amp * win(s, 0, 1));
    root.yaw(k.side * 0.07 * wave(s, 2) * win(s, 0, 1));
    root.look(k.side * 0.8 * win(s, 0.1, 0.9), 0);
  },
  // Cyber Hound: a play bow (front legs down), a happy bounce, back up
  hound(s, k, j, root) {
    const bow = hold(s, 0, 0.25, 0.6, 0.9);
    for (const leg of ["fl", "fr"]) {
      j(`${leg}_thigh`, 32 * k.amp * bow);
      j(`${leg}_knee`, -38 * k.amp * bow);
    }
    for (const leg of ["bl", "br"]) j(`${leg}_hip`, (leg === "bl" ? 1 : -1) * 10 * wave(s, 3) * bow);
    root.lift(0.012 * k.amp * win(s, 0.62, 0.82));
  },
  // Ghost Hand: the fingers curl one after another like a wave, then the thumb, then all open again
  hand(s, k, j) {
    for (let i = 0; i < 4; i++) {
      const f = k.side > 0 ? i : 3 - i;
      const c = win(s, 0.05 + f * 0.1, 0.5 + f * 0.1);
      j(`f${i + 1}_base`, 62 * k.amp * c);
      j(`f${i + 1}_tip`, 70 * k.amp * c);
    }
    const t = win(s, 0.45, 0.95);
    j("thumb_base", 25 * t);
    j("thumb_tip", 55 * t);
  },
  // Spider Mech: a tripod shuffle in place, two steps, the body swaying with it
  spider(s, k, j, root) {
    const on = hold(s, 0, 0.12, 0.88, 1);
    for (let i = 1; i <= 6; i++) {
      const group = i % 2 ? 0 : Math.PI; // legs 1, 3, 5 and 2, 4, 6 step in turn
      const step = wave(s, 2, group);
      j(`leg${i}_femur`, -24 * k.amp * on * Math.max(0, step));
      j(`leg${i}_coxa`, 14 * k.amp * on * wave(s, 2, group + Math.PI / 2));
    }
    root.lift(0.006 * on * (1 + wave(s, 4)) * 0.5);
    root.yaw(k.side * 0.04 * on * wave(s, 2));
  },
  // Sky Drone: props spin up, it lifts off, turns to look around, settles back on its pad
  drone(s, k, j, root) {
    const up = hold(s, 0.12, 0.38, 0.66, 0.92);
    root.lift(0.11 * k.amp * up);
    root.yaw(k.side * 0.6 * win(s, 0.25, 0.85));
    root.tilt(0.08 * up * wave(s, 1.5), 0.06 * up * wave(s, 1, 1));
    // whole turns, so the props are where they started when the loop restarts; at most ~55° per frame at 20 fps, so the
    // two-blade props never seem to run backwards
    root.spin("prop", 5, s);
  },
  // Fab Rig: a short print move, the toolhead drawing back and forth while the bed steps and the spool unwinds
  fab(s, k, j, root) {
    const on = hold(s, 0, 0.15, 0.85, 1);
    root.slide("head", "x", 0.075 * k.amp * on * wave(s, 3));
    root.slide("bed", "z", 0.04 * k.amp * on * wave(s, 1, Math.PI / 2) - 0.04 * k.amp * on);
    root.slide("gantry", "y", 0.012 * on);
    root.spin("spool", 1, s);
  },
  // Replicant: turns toward you and waves hello
  replicant(s, k, j) {
    const arm = k.side > 0 ? "r" : "l";
    const up = hold(s, 0.02, 0.25, 0.75, 0.97);
    j(`${arm}_shoulder`, -145 * up);
    j(`${arm}_elbow`, (-35 - 30 * wave(s, 3)) * up);
    j("head_pan", k.side * 22 * win(s, 0, 1));
    j("torso_yaw", k.side * 12 * win(s, 0, 1));
  },
  // AX-1 Rover: looks around (left, right), rolls a little closer, smiles
  "ax1-rover"(s, k, j, root) {
    j("head_pan", k.side * 45 * k.amp * win(s, 0, 0.5) - k.side * 35 * k.amp * win(s, 0.42, 0.9));
    j("head_tilt", 12 * win(s, 0.2, 0.8));
    root.move(0.05 * k.amp * win(s, 0.1, 1));
    root.look(k.side * 0.8 * win(s, 0, 0.5) - k.side * 0.6 * win(s, 0.42, 0.9), -0.2 * win(s, 0.2, 0.8));
    root.mood(s > 0.3 && s < 0.85 ? "happy" : null);
  },
  // AX-1 Desk: a wave and a nod
  "ax1-desk"(s, k, j, root) {
    const arm = k.side > 0 ? "r" : "l";
    const up = hold(s, 0.02, 0.25, 0.72, 0.95);
    j(`${arm}_shoulder`, -135 * up);
    j(`${arm}_elbow`, (-30 - 28 * wave(s, 3)) * up);
    j("torso_yaw", k.side * 18 * win(s, 0, 1));
    j("head_tilt", 14 * win(s, 0.55, 0.75) + 10 * win(s, 0.75, 0.95));
    root.look(k.side * 0.5 * win(s, 0, 1), 0);
    root.mood(s > 0.2 && s < 0.8 ? "happy" : null);
  },
  // AX-1 Walker: walks on the spot, four steps, the weight rolling onto the standing foot and the head bobbing along
  "ax1-walker"(s, k, j, root) {
    const on = hold(s, 0, 0.1, 0.9, 1);
    const gait = wave(s, 2); // two strides: left lifts while it is > 0, right while it is < 0
    for (const [leg, sign] of [["l", 1], ["r", -1]]) {
      const lift = on * Math.max(0, sign * gait) * k.amp;
      j(`${leg}_hip_pitch`, -46 * lift); // the thigh comes forward...
      j(`${leg}_knee`, 86 * lift); // ...the knee bends...
      j(`${leg}_ankle_pitch`, -40 * lift); // ...and the foot stays level (hip + knee + ankle = 0)
      j(`${leg}_hip_roll`, 6 * on * gait); // the body leans over the foot that stays down
      j(`${leg}_ankle_roll`, -6 * on * gait);
    }
    j("torso_yaw", k.side * 8 * on * gait);
    j("head_tilt", 5 * on * Math.abs(gait));
    root.lift(0.004 * on * Math.abs(gait)); // a little rise with every step
    root.look(k.side * 0.3 * on * gait, 0);
  },
};

/**
 * createMotion(robotId, rig, rnd) -> { frames, pose(i) } for a rig already in the token's pose (and painted, with its
 * add-ons attached). frames = how many moving frames; pose(i) puts frame i (0 = the token's pose, then the gesture)
 * and returns the face time to draw. rnd = the token's own random source (after the still pose used it).
 */
export function createMotion(robotId, rig, rnd) {
  const gesture = GESTURES[robotId];
  if (!gesture) throw new Error(`no motion for ${robotId}`);
  const k = { amp: 0.85 + rnd() * 0.3, side: rnd() < 0.5 ? -1 : 1 };
  const base = Object.fromEntries(Object.entries(rig.joints).map(([n, jt]) => [n, jt.value]));
  const g = rig.group;
  const pos0 = g.position.clone();
  const rot0 = { x: g.rotation.x, y: g.rotation.y, z: g.rotation.z };
  const slides = Object.fromEntries(Object.entries(rig.slides || {}).map(([n, node]) => [n, node.position.clone()]));
  const spin0 = rig.spinners.map((sp) => sp.node.rotation[sp.axis]);
  const wheels = rig.spinners.filter((sp) => sp.name.startsWith("wheel"));
  const wheelR = { rover: 0.034, "ax1-rover": 0.052 }[robotId] || 0.04;
  const frames = Math.round(MOTION.fps * MOTION.activeS);
  let face = { look: null, mood: null };

  function pose(i) {
    const s = i / frames;
    for (const [n, v] of Object.entries(base)) rig.set(n, v);
    g.position.copy(pos0);
    g.rotation.set(rot0.x, rot0.y, rot0.z);
    for (const [n, p] of Object.entries(slides)) rig.slides[n].position.copy(p);
    rig.spinners.forEach((sp, idx) => (sp.node.rotation[sp.axis] = spin0[idx]));
    face = { look: null, mood: null };
    let dist = 0;
    const root = {
      move(d) {
        dist = d;
        g.position.x += Math.sin(g.rotation.y) * d;
        g.position.z += Math.cos(g.rotation.y) * d;
      },
      lift(h) {
        g.position.y += h;
      },
      drop(v) {
        g.position.y -= 0.012 * v; // bent knees: the walker sinks a little
      },
      yaw(a) {
        g.rotation.y += a;
      },
      tilt(x, z) {
        g.rotation.x += x;
        g.rotation.z += z;
      },
      slide(n, axis, d) {
        if (rig.slides?.[n]) rig.slides[n].position[axis] += d;
      },
      spin(prefix, turns, t) {
        rig.spinners.forEach((sp, idx) => {
          if (sp.name.startsWith(prefix)) sp.node.rotation[sp.axis] = spin0[idx] + (sp.name.endsWith("ccw") ? -1 : 1) * turns * TAU * ramp(t);
        });
      },
      look(x, y) {
        face.look = [x, y];
      },
      mood(m) {
        face.mood = m;
      },
    };
    gesture(s, k, (n, d) => rig.joints[n] && rig.set(n, base[n] + d), root);
    // wheels roll with the body: the angle follows the distance, so they are back where they were at the end
    for (const sp of wheels) sp.node.rotation[sp.axis] = spin0[rig.spinners.indexOf(sp)] + dist / wheelR;
    g.updateMatrixWorld(true);
    return face;
  }
  return { frames, pose, side: k.side };
}
