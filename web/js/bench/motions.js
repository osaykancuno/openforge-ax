// "Move" stage animations: each robot's characteristic motion as a pure function of time on its Rig, plus labels.
// A motion is { period, keyT, view, setup(v, rig) → ctx, apply(ctx, t) }. Reduced motion shows the pose at keyT.
import * as THREE from "three";
import { ik } from "../sim/arm-sim.js";
import { mat, rbox, cyl, torus, PALETTE } from "../models/look.js";
import { solveBody } from "./missions/biped.js";
import replicantMission from "./missions/replicant.js";
import walkerMission from "./missions/ax1-walker.js";

const RAD = Math.PI / 180;
const smooth = (a, b, t) => {
  const k = Math.min(1, Math.max(0, (t - a) / (b - a)));
  return k * k * (3 - 2 * k);
};
/** Piecewise keyframes [[t, value]] with smoothstep blends; value can be a number or an object of numbers. */
export function keys(frames, t) {
  if (t <= frames[0][0]) return frames[0][1];
  for (let i = 1; i < frames.length; i++) {
    const [t1, v1] = frames[i];
    if (t <= t1) {
      const [t0, v0] = frames[i - 1];
      const k = smooth(t0, t1, t);
      if (typeof v0 === "number") return v0 + (v1 - v0) * k;
      const o = {};
      for (const key of Object.keys(v1)) o[key] = (v0[key] ?? 0) + (v1[key] - (v0[key] ?? 0)) * k;
      return o;
    }
  }
  return frames[frames.length - 1][1];
}
/** Set a joint's node rotation directly (no clamp), in the rig's axis and sign: used where the lab convention differs. */
export function setRaw(rig, name, deg, sign = null) {
  const j = rig.joints[name];
  if (!j) return;
  j.node.rotation[j.axis] = (sign ?? j.sign) * deg * RAD;
}
const partNode = (rig, re) => rig.parts.find((p) => re.test(p.label))?.node;
const simToThree = (p) => new THREE.Vector3(p.x, p.z, -p.y);

// ---------------------------------------------------------------- SO-101: pick and place with arm-sim IK
function armMotion() {
  const A = { x: 0.19, y: 0.09 }, B = { x: 0.19, y: -0.09 };
  const H = 0.08, G = 0.016;
  const path = [
    [0, { x: 0.16, y: 0, z: 0.16, g: 100 }],
    [1.2, { ...A, z: H, g: 100 }],
    [2.0, { ...A, z: G, g: 100 }],
    [2.6, { ...A, z: G, g: 0 }],
    [3.4, { ...A, z: H + 0.03, g: 0 }],
    [4.8, { ...B, z: H + 0.03, g: 0 }],
    [5.6, { ...B, z: 0.03, g: 0 }],
    [6.2, { ...B, z: 0.03, g: 100 }],
    [7.0, { ...B, z: H, g: 100 }],
    [8.4, { x: 0.16, y: 0, z: 0.16, g: 100 }],
  ];
  return {
    period: 8.4,
    keyT: 3.6,
    view: { az: 60, el: 24, zoom: 1.25, dy: 0 },
    setup(v, rig) {
      const cube = v.addProp(rbox(0.03, 0.03, 0.03, "sun", 0.004));
      const dock = v.addProp(torus(0.03, 0.003, "sage"));
      dock.rotation.x = Math.PI / 2;
      dock.position.copy(simToThree({ ...B, z: 0.002 }));
      const tip = new THREE.Object3D();
      v.addProp(tip);
      return { rig, cube, tip, last: null, labels: [
        { node: tip, text: "IK: tip target → 6 angles", kind: "brain" },
        { node: rig.joints.shoulder_pan.node, text: "pan", kind: "actuator" },
        { node: rig.joints.elbow_flex.node, text: "elbow", kind: "actuator" },
        { node: rig.joints.wrist_flex.node, text: "wrist", kind: "actuator" },
        { node: cube, text: "cube (3 cm)", kind: "power" },
        { node: dock, text: "dock", kind: "sensor" },
      ] };
    },
    apply(c, t) {
      const p = keys(path, t);
      const j = ik({ x: p.x, y: p.y, z: p.z }, 0, p.g) || c.last;
      if (!j) return;
      c.last = j;
      c.rig.pose({ shoulder_pan: j[0], shoulder_lift: j[1], elbow_flex: j[2], wrist_flex: j[3], wrist_roll: j[4], gripper: j[5] });
      c.tip.position.copy(simToThree(p));
      const held = t >= 2.6 && t < 6.2;
      const cp = held ? { x: p.x, y: p.y, z: Math.max(0.015, p.z - 0.001) } : t < 2.6 ? { ...A, z: 0.015 } : { ...B, z: 0.015 };
      c.cube.position.copy(simToThree(cp));
    },
  };
}

// ---------------------------------------------------------------- rovers: a figure-eight with differential wheel speeds
function driveMotion({ ax1 = false } = {}) {
  const A = 0.55, P = 12;
  const pos = (t) => {
    const w = (2 * Math.PI * t) / P;
    return { x: A * Math.sin(w), z: A * Math.sin(w) * Math.cos(w) };
  };
  return {
    period: P,
    keyT: 1.4,
    view: { az: 30, el: 42, zoom: 4.4, dy: -0.2 },
    setup(v, rig) {
      // the figure-eight on the floor
      const pts = [];
      for (let i = 0; i <= 200; i++) {
        const p = pos((i / 200) * P);
        pts.push(new THREE.Vector3(p.x, 0.002, p.z));
      }
      const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineDashedMaterial({ color: PALETTE.line, dashSize: 0.03, gapSize: 0.02 }));
      line.computeLineDistances();
      v.addProp(line);
      const track = ax1 ? 0.2 : 0.19;
      const c = { rig, track, vl: 0, vr: 0 };
      const wl = partNode(rig, /\(L\)/), wr = partNode(rig, /\(R\)/);
      c.labels = [
        { node: wl, text: () => `left wheel ${c.vl.toFixed(2)} m/s`, kind: "actuator", dynamic: true },
        { node: wr, text: () => `right wheel ${c.vr.toFixed(2)} m/s`, kind: "actuator", dynamic: true },
        { node: rig.phone || partNode(rig, /Phone/), text: "phone = brain", kind: "brain" },
      ];
      return c;
    },
    apply(c, t) {
      const dt = 0.02;
      const p0 = pos(t), p1 = pos(t + dt);
      const heading = Math.atan2(p1.x - p0.x, p1.z - p0.z);
      const p2 = pos(t + 2 * dt);
      const h2 = Math.atan2(p2.x - p1.x, p2.z - p1.z);
      const v = Math.hypot(p1.x - p0.x, p1.z - p0.z) / dt;
      let dh = h2 - heading;
      dh = Math.atan2(Math.sin(dh), Math.cos(dh));
      const w = dh / dt;
      c.vl = v - (w * c.track) / 2;
      c.vr = v + (w * c.track) / 2;
      const g = c.rig.group;
      g.position.set(p0.x, 0, p0.z);
      g.rotation.y = heading;
      const r = ax1 ? 0.052 : 0.034;
      if (ax1) {
        c.rig.setSpin("wheel-l", c.vl / (2 * Math.PI * r));
        c.rig.setSpin("wheel-r", c.vr / (2 * Math.PI * r));
        c.rig.set("head_pan", Math.max(-40, Math.min(40, (w / 2) * 40)));
        c.rig.face?.setLook(Math.max(-1, Math.min(1, w / 2)), 0);
      } else c.rig.setSpin("wheel", v / (2 * Math.PI * r));
    },
  };
}

// ---------------------------------------------------------------- quadruped trot (on a treadmill)
function houndMotion() {
  return {
    period: 4,
    keyT: 0.25,
    view: { az: 70, el: 18, zoom: 1.35 },
    setup(v, rig) {
      const tm = v.treadmill(0.4, 0.9);
      return { rig, tm, labels: [
        { node: rig.joints.fl_hip.node, text: "pair A: front-left + back-right", kind: "actuator" },
        { node: rig.joints.fr_hip.node, text: "pair B: front-right + back-left", kind: "sensor" },
        { node: rig.joints.bl_knee.node, text: "knee folds to lift the swing foot", kind: "actuator" },
      ] };
    },
    apply(c, t) {
      const f = 2; // cadence (Hz)
      const legs = { fl: 0, br: 0, fr: 0.5, bl: 0.5 };
      for (const [id, off] of Object.entries(legs)) {
        const ph = 2 * Math.PI * (f * t + off);
        c.rig.set(`${id}_thigh`, 35 + 14 * Math.sin(ph));
        c.rig.set(`${id}_knee`, -70 - 28 * Math.max(0, Math.cos(ph)));
      }
      c.rig.group.position.y = 0.004 * Math.abs(Math.sin(2 * Math.PI * f * t));
      c.tm.set(t * 0.18);
    },
  };
}

// ---------------------------------------------------------------- hand: wrap, pinch, count
const HANDSEQ = [
  [0, [10, 10, 10, 10, 10]],
  [1.2, [10, 10, 10, 10, 10]],
  [2.2, [90, 90, 90, 90, 70]],
  [3.4, [90, 90, 90, 90, 70]],
  [4.2, [10, 10, 10, 10, 10]],
  [5.0, [55, 5, 5, 5, 65]],
  [6.2, [55, 5, 5, 5, 65]],
  [7.0, [5, 95, 95, 95, 85]],
  [8.0, [5, 5, 95, 95, 85]],
  [9.0, [5, 5, 5, 95, 85]],
  [10.2, [5, 5, 5, 95, 85]],
  [11.2, [10, 10, 10, 10, 10]],
];
export function setHand(rig, c) {
  for (let i = 0; i < 4; i++) {
    rig.set(`f${i + 1}_base`, c[i] * 0.85);
    rig.set(`f${i + 1}_tip`, c[i] * 0.95);
  }
  rig.set("thumb_base", 35 - c[4] * 0.3);
  rig.set("thumb_tip", c[4] * 0.6);
}
function handMotion() {
  const say = (t) => (t < 1.6 ? "open" : t < 3.9 ? "power grasp: all fingers wrap" : t < 4.6 ? "open" : t < 6.6 ? "pinch: thumb meets index" : t < 7.5 ? "one" : t < 8.5 ? "two" : t < 10.6 ? "three" : "open");
  return {
    period: 11.2,
    keyT: 2.8,
    view: { az: 25, el: 12, zoom: 1.2 },
    setup(v, rig) {
      const c = { rig, t: 0 };
      c.labels = [
        { node: partNode(rig, /Palm/), text: () => say(c.t), kind: "brain", dynamic: true },
        { node: partNode(rig, /Finger 1/), text: "index", kind: "actuator" },
        { node: partNode(rig, /Thumb/), text: "thumb opposes", kind: "actuator" },
        { node: partNode(rig, /Wrist/), text: "servos pull the joints", kind: "power" },
      ];
      return c;
    },
    apply(c, t) {
      c.t = t;
      setHand(c.rig, keys(HANDSEQ.map(([k, v]) => [k, { ...v }]), t));
    },
  };
}

// ---------------------------------------------------------------- hexapod tripod gait
export function setSpider(rig, { liftA = 0, liftB = 0, swing = 0, bob = 0 }) {
  for (let i = 0; i < 6; i++) {
    const a = i % 2 === 0;
    const lift = a ? liftA : liftB;
    rig.set(`leg${i + 1}_coxa`, (a ? swing : -swing) * (i < 3 ? 1 : -1));
    rig.set(`leg${i + 1}_femur`, -20 - 30 * lift);
    rig.set(`leg${i + 1}_tibia`, 90 - 15 * lift);
  }
  rig.group.position.y = bob;
}
function spiderMotion() {
  return {
    period: 2.4,
    keyT: 0.3,
    view: { az: 40, el: 30, zoom: 1.3 },
    setup(v, rig) {
      const tm = v.treadmill(0.5, 0.9);
      const legA = rig.joints.leg1_coxa.node, legB = rig.joints.leg2_coxa.node;
      return { rig, tm, labels: [
        { node: legA, text: "tripod A: legs 1·3·5", kind: "actuator" },
        { node: legB, text: "tripod B: legs 2·4·6", kind: "sensor" },
      ] };
    },
    apply(c, t) {
      const ph = (t / 2.4) % 1;
      // half cycle each: the lifted tripod swings forward while the other pushes
      const half = ph < 0.5 ? ph * 2 : (ph - 0.5) * 2;
      const lift = Math.sin(Math.PI * half);
      const swing = (ph < 0.5 ? -1 + 2 * half : 1 - 2 * half) * 18;
      setSpider(c.rig, { liftA: ph < 0.5 ? 0 : lift, liftB: ph < 0.5 ? lift : 0, swing, bob: 0.003 * lift });
      c.tm.set(t * 0.06);
    },
  };
}

// ---------------------------------------------------------------- drone: spin up, cancel twists, tilt, turn
function droneMotion() {
  const P = 14;
  const phase = (t) => (t < 2 ? "spin" : t < 5 ? "hover" : t < 8 ? "forward" : t < 11.5 ? "turn" : "land");
  return {
    period: P,
    keyT: 4,
    view: { az: 30, el: 30, zoom: 1.7, dy: 0.45 },
    setup(v, rig) {
      const motors = rig.parts.filter((p) => /^Motor/.test(p.label)).map((p) => ({ node: p.node, cw: /\(CW\)/.test(p.label) }));
      const arrows = motors.map((m) => v.spinArrow(m.node, { radius: 0.045, color: m.cw ? PALETTE.sky : PALETTE.accent, dir: m.cw ? -1 : 1, y: 0.02, tube: 0.0025 }));
      const thrust = motors.map((m) => v.forceArrow(m.cw ? PALETTE.sky : PALETTE.accent));
      const yawArrow = v.spinArrow(rig.group, { radius: 0.13, color: PALETTE.ink, dir: 1, y: 0.06, tube: 0.003 });
      const c = { rig, motors, arrows, thrust, yawArrow, ph: "spin" };
      const centre = rig.parts.find((p) => /Flight controller/.test(p.label))?.node;
      c.labels = [
        ...motors.map((m) => ({ node: m.node, text: m.cw ? "CW" : "CCW", kind: m.cw ? "sensor" : "actuator", dynamic: true })),
        { node: centre, text: () => ({ spin: "spin up: lift grows with prop speed", hover: "twists cancel: heading holds", forward: "tilt → part of the lift pushes forward", turn: "CW pair faster → frame twists CCW", land: "less thrust than weight → it sinks" }[c.ph]), kind: "brain", dynamic: true },
      ];
      return c;
    },
    apply(c, t) {
      c.ph = phase(t);
      const g = c.rig.group;
      const spin = keys([[0, 0], [2, 1], [12, 1], [14, 0.25]], t);
      const alt = keys([[0, 0], [2, 0], [4, 0.35], [11.5, 0.35], [14, 0]], t);
      const pitch = keys([[5, 0], [5.6, 14], [7.4, 14], [8, 0]], t);
      const fwd = keys([[5, 0], [8, 0.25], [11.5, 0.25], [14, 0]], t);
      const yaw = keys([[8, 0], [11.5, 90], [14, 90]], t) * RAD;
      const turn = c.ph === "turn" ? 0.18 : 0;
      g.position.set(Math.sin(0) * fwd, alt + 0.004 * Math.sin(t * 5) * (alt > 0.05 ? 1 : 0), fwd);
      g.rotation.set(pitch * RAD, yaw, 0, "YXZ");
      c.rig.setSpin("prop-cw", -(8 + 30 * spin) * (1 + turn));
      c.rig.setSpin("prop-ccw", (8 + 30 * spin) * (1 - turn));
      c.yawArrow.visible = c.ph === "turn";
      c.motors.forEach((m, i) => {
        const a = c.thrust[i];
        const p = m.node.getWorldPosition(new THREE.Vector3());
        const up = new THREE.Vector3(0, 1, 0).applyQuaternion(g.quaternion);
        a.position.copy(p).addScaledVector(up, 0.02);
        a.setDirection(up);
        const k = spin * (m.cw ? 1 + turn : 1 - turn);
        a.setLength(Math.max(0.025, 0.02 + 0.07 * k), 0.018, 0.011);
        a.visible = spin > 0.05;
      });
    },
  };
}

// ---------------------------------------------------------------- printer: draw a square layer
function fabMotion() {
  const S = 0.07; // square side (m)
  const sq = (u) => {
    const e = Math.floor(u * 4) % 4, k = (u * 4) % 1;
    return [[-S / 2 + S * k, -S / 2], [S / 2, -S / 2 + S * k], [S / 2 - S * k, S / 2], [-S / 2, S / 2 - S * k]][e];
  };
  return {
    period: 10,
    keyT: 6,
    view: { az: 35, el: 30, zoom: 1.1 },
    setup(v, rig) {
      const { bed, gantry, head } = rig.slides;
      const base = { bed: bed.position.clone(), gantry: gantry.position.clone(), head: head.position.clone() };
      const N = 400;
      const geo = new THREE.BufferGeometry().setFromPoints(Array.from({ length: N + 1 }, (_, i) => {
        const [x, z] = sq(Math.min(0.9999, i / N));
        return new THREE.Vector3(x - 0.04, 0.0055, z + 0.04);
      }));
      const line = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: PALETTE.accent, linewidth: 2 }));
      bed.add(line);
      v.fxGroup.userData.attached = (v.fxGroup.userData.attached || []).concat(line);
      rig.setSpin("spool", 0.05);
      return { rig, bed, gantry, head, base, line, N, labels: [
        { node: head, text: "X: the toolhead moves left–right", kind: "actuator" },
        { node: bed, text: "Y: the bed moves front–back", kind: "actuator" },
        { node: gantry, text: "Z: the gantry sets the 0.2 mm layer", kind: "sensor" },
      ] };
    },
    apply(c, t) {
      const u = Math.max(0, (t - 1) / 8);
      const drawing = u > 0 && u < 1;
      const [x, z] = drawing ? sq(u) : [0, 0];
      c.head.position.x = c.base.head.x + x - 0.04;
      c.bed.position.z = c.base.bed.z - (z + 0.04);
      c.gantry.position.y = keys([[0, c.base.gantry.y], [1, 0.133], [9, 0.133], [10, c.base.gantry.y]], t);
      c.line.geometry.setDrawRange(0, Math.floor(Math.min(1, Math.max(0, u)) * c.N));
    },
  };
}

// ---------------------------------------------------------------- bipeds: pose = (ankle, knee, lean, shift, lift, arms)
/** Drive a biped rig from a lab pose so the right foot stays planted (anchor solve), arms raise forward. */
export function makeBipedPoser(rig, kind) {
  const walker = kind === "walker";
  const J = walker ? { hip: "hip_pitch", knee: "knee", ankle: "ankle_pitch" } : { hip: "hip", knee: "knee", ankle: "ankle" };
  const anchorNode = rig.joints[`r_${J.ankle}`].node;
  rig.home();
  rig.group.updateMatrixWorld(true);
  const home = anchorNode.getWorldPosition(new THREE.Vector3());
  const base = rig.group.position.clone();
  return function pose(p, { wave = 0, nod = 0, look = 0 } = {}) {
    const torso = p.ankle - p.knee + p.lean; // world pitch of the pelvis/torso
    for (const s of ["l", "r"]) {
      const lift = s === "l" ? p.lift : 0;
      // the lab pose's own pitch direction (the Walker model follows the protocol's signs, which are the opposite)
      const pitch = walker ? -1 : null;
      setRaw(rig, `${s}_${J.hip}`, p.lean + lift, pitch);
      setRaw(rig, `${s}_${J.knee}`, p.knee + 1.5 * lift);
      setRaw(rig, `${s}_${J.ankle}`, p.ankle + 0.5 * lift, pitch);
      if (walker) {
        setRaw(rig, `${s}_hip_roll`, -p.shift, 1);
        setRaw(rig, `${s}_ankle_roll`, p.shift, 1);
      }
    }
    if (!walker) {
      // arms: forward raise (lab convention), wave = elbow swing on the right arm
      setRaw(rig, "l_shoulder", -p.arms, 1);
      setRaw(rig, "r_shoulder", -Math.max(p.arms, wave ? 160 : 0), 1);
      setRaw(rig, "r_elbow", -(wave ? 40 + 35 * Math.sin(wave) : 15), 1);
      setRaw(rig, "l_elbow", -15, 1);
      rig.set("head_pan", look);
    } else {
      rig.set("torso_yaw", look);
      rig.set("head_tilt", nod);
    }
    const g = rig.group;
    g.position.copy(base);
    g.rotation.set(torso * RAD, 0, walker ? 0 : -p.shift * 0.6 * RAD);
    g.updateMatrixWorld(true);
    const now = anchorNode.getWorldPosition(new THREE.Vector3());
    g.position.add(home.clone().sub(now));
    g.updateMatrixWorld(true);
  };
}
function bipedMotion(kind) {
  const walker = kind === "walker";
  const geo = (walker ? walkerMission : replicantMission).geometry;
  const P = 16;
  const Z = { ankle: 0, knee: 0, lean: 0, shift: 0, lift: 0, arms: 0 };
  const frames = [
    [0, Z],
    [1, Z],
    [3, { ...Z, ankle: 30, knee: 70, lean: 45 }],
    [4.5, { ...Z, ankle: 30, knee: 70, lean: 45 }],
    [6, Z],
    [7.5, { ...Z, shift: 12 }],
    [9, { ...Z, shift: 12, lift: 45 }],
    [10.5, { ...Z, shift: 12, lift: 45 }],
    [12, Z],
    [16, Z],
  ];
  return {
    period: P,
    keyT: 9.6,
    view: { az: 40, el: 16, zoom: 1.25 },
    setup(v, rig) {
      const poser = makeBipedPoser(rig, kind);
      const com = new THREE.Mesh(new THREE.SphereGeometry(0.008, 16, 12), new THREE.MeshBasicMaterial({ color: PALETTE.accent, depthTest: false }));
      com.renderOrder = 8;
      v.fxGroup.add(com);
      const shadow = new THREE.Mesh(new THREE.CircleGeometry(0.008, 24), new THREE.MeshBasicMaterial({ color: PALETTE.accent }));
      shadow.rotation.x = -Math.PI / 2;
      v.fxGroup.add(shadow);
      const sup = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ color: PALETTE.sage, transparent: true, opacity: 0.35, depthWrite: false }));
      sup.rotation.x = -Math.PI / 2;
      v.fxGroup.add(sup);
      const c = { rig, poser, com, shadow, sup, geo, body: null, t: 0 };
      c.labels = [
        { node: com, text: "centre of mass", kind: "brain" },
        { node: sup, text: () => (c.body?.lifted ? "support: one foot" : "support: both feet"), kind: "sensor", dynamic: true },
      ];
      return c;
    },
    apply(c, t) {
      const p = keys(frames, t);
      const wave = !walker && t > 12.3 && t < 15.5 ? (t - 12.3) * 9 : 0;
      c.poser(p, { wave, nod: walker ? 12 * Math.sin(t * 2) * (t > 12 ? 1 : 0) : 0, look: t > 12 ? 30 * Math.sin((t - 12) * 1.5) : 0 });
      placeComMarkers(c, p);
    },
  };
}
/** Show the COM (lab model) and the support polygon under the rig's planted foot. */
export function placeComMarkers(c, p) {
  const b = (c.body = solveBody(c.geo, p));
  const anchor = c.rig.joints[c.rig.joints.r_ankle_pitch ? "r_ankle_pitch" : "r_ankle"].node.getWorldPosition(new THREE.Vector3());
  // the lab model's lateral axis points toward the planted ("r") foot, at +x in the rig; the model x is forward (+z)
  const toWorld = (fx, lat) => new THREE.Vector3(anchor.x - (c.geo.hw - lat), 0.002, anchor.z + fx);
  const w = toWorld(b.com.x, b.com.lat);
  c.shadow.position.copy(w);
  c.com.position.set(w.x, b.com.y, w.z);
  const s = b.support;
  c.sup.scale.set(s.lat1 - s.lat0, s.x1 - s.x0, 1);
  const mid = toWorld((s.x0 + s.x1) / 2, (s.lat0 + s.lat1) / 2);
  c.sup.position.set(mid.x, 0.0015, mid.z);
  c.sup.material.color.setHex(b.margin >= 0 ? PALETTE.sage : PALETTE.accent);
}

// ---------------------------------------------------------------- AX-1 desk: look, nod, wave, point
export function setDesk(rig, j) {
  rig.set("torso_yaw", j.torso);
  rig.set("head_pan", j.pan);
  rig.set("head_tilt", j.tilt);
  setRaw(rig, "r_shoulder", -j.rsh, 1);
  setRaw(rig, "r_elbow", -j.rel, 1);
  setRaw(rig, "l_shoulder", -j.lsh, 1);
  setRaw(rig, "l_elbow", -j.lel, 1);
}
function deskMotion() {
  const Z = { torso: 0, pan: 0, tilt: 0, rsh: 0, rel: 20, lsh: 0, lel: 20 };
  const frames = [
    [0, Z],
    [1.2, { ...Z, pan: 50, tilt: 10 }],
    [2.4, { ...Z, pan: -50, tilt: 0 }],
    [3.2, { ...Z, tilt: 25 }],
    [3.8, { ...Z, tilt: -15 }],
    [4.4, { ...Z, tilt: 0 }],
    [5.4, { ...Z, rsh: 150, rel: 20 }],
    [8.2, { ...Z, rsh: 150, rel: 20 }],
    [9.2, { ...Z, torso: 45, rsh: 85, rel: 0, pan: 0 }],
    [10.6, { ...Z, torso: 45, rsh: 85, rel: 0 }],
    [11.6, { ...Z, torso: -45, rsh: 85, rel: 0 }],
    [13, { ...Z, torso: -45, rsh: 85, rel: 0 }],
    [14, Z],
  ];
  const say = (t) => (t < 2.6 ? "look around" : t < 4.6 ? "nod" : t < 8.6 ? "wave" : t < 13.2 ? "point" : "rest");
  return {
    period: 14,
    keyT: 6.4,
    view: { az: 30, el: 16, zoom: 1.35 },
    setup(v, rig) {
      const c = { rig, t: 0 };
      c.labels = [
        { node: rig.head || rig.phone, text: () => say(c.t), kind: "brain", dynamic: true },
        { node: rig.joints.r_shoulder.node, text: "shoulder", kind: "actuator" },
        { node: rig.joints.torso_yaw.node, text: "torso yaw", kind: "actuator" },
      ];
      return c;
    },
    apply(c, t) {
      c.t = t;
      const j = keys(frames, t);
      if (t > 5.4 && t < 8.2) j.rel = 40 + 35 * Math.sin((t - 5.4) * 8);
      setDesk(c.rig, j);
      c.rig.face?.setLook(j.pan / 60, -j.tilt / 40);
      c.rig.face?.setMood(t > 5.4 && t < 8.6 ? "happy" : "idle");
    },
  };
}

export const MOTIONS = {
  so101: armMotion,
  rover: () => driveMotion(),
  hound: houndMotion,
  hand: handMotion,
  spider: spiderMotion,
  drone: droneMotion,
  fab: fabMotion,
  replicant: () => bipedMotion("replicant"),
  "ax1-rover": () => driveMotion({ ax1: true }),
  "ax1-desk": deskMotion,
  "ax1-walker": () => bipedMotion("walker"),
};
void mat;
void cyl;
