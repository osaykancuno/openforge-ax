// Procedural robot models for the lab: one builder per robot class plus OpenForge AX-1.
// Every builder returns a Rig: named joints (degrees, clamped), exploded-view offsets, callouts for the
// sensors/brain/actuators/power, and spinners (wheels, props). Units are metres, Y up, the robot faces +Z.
// Shared by the home lab, the Workbench and the Phone Brain twin, so a robot looks the same everywhere.
import * as THREE from "three";
import { mat, rbox, cyl, sphere, torus, at, phone, phoneFace, PALETTE } from "./look.js";

const RAD = Math.PI / 180;

export class Rig {
  constructor(id) {
    this.id = id;
    this.group = new THREE.Group();
    this.group.name = id;
    this.joints = {}; // name -> { node, axis, sign, min, max, home, value }
    this.parts = []; // { node, label, dir: Vector3, base: Vector3 }
    this.callouts = []; // { node, label, kind }
    this.spinners = []; // { node, axis, rate, name }
    this.explode = 0;
    this.face = null; // phoneFace() for robots with a phone
  }
  joint(name, node, axis, [min, max], home = 0, sign = 1) {
    this.joints[name] = { node, axis, sign, min, max, home, value: home };
    this.set(name, home);
    return node;
  }
  set(name, deg) {
    const j = this.joints[name];
    if (!j) return;
    j.value = Math.min(j.max, Math.max(j.min, deg));
    j.node.rotation[j.axis] = j.sign * j.value * RAD;
  }
  get(name) {
    return this.joints[name]?.value ?? 0;
  }
  /** Set many joints: { name: deg }. */
  pose(map) {
    for (const [k, v] of Object.entries(map)) this.set(k, v);
  }
  home() {
    for (const [k, j] of Object.entries(this.joints)) this.set(k, j.home);
  }
  part(node, label, dir) {
    this.parts.push({ node, label, dir: new THREE.Vector3(...dir), base: node.position.clone() });
    return node;
  }
  callout(node, label, kind) {
    this.callouts.push({ node, label, kind });
    return node;
  }
  spin(node, axis, name, rate = 0) {
    this.spinners.push({ node, axis, name, rate });
    return node;
  }
  /** Rate (turns/s) for every spinner whose name starts with `prefix`. */
  setSpin(prefix, rate) {
    for (const s of this.spinners) if (s.name.startsWith(prefix)) s.rate = rate;
  }
  setExplode(t) {
    this.explode = t;
    for (const p of this.parts) p.node.position.copy(p.base).addScaledVector(p.dir, t);
  }
  update(dt, t = 0) {
    for (const s of this.spinners) if (s.rate) s.node.rotation[s.axis] += s.rate * Math.PI * 2 * dt;
    this.face?.tick(t);
  }
}

// ---------------------------------------------------------------- shared parts

/** Feetech STS3215-sized bus servo (45 × 24 × 32 mm) with its horn on +Y. */
function servo(scale = 1) {
  const g = new THREE.Group();
  at(rbox(0.045 * scale, 0.032 * scale, 0.024 * scale, "servo", 0.003), 0, 0, 0, g);
  at(cyl(0.009 * scale, 0.009 * scale, 0.004 * scale, "alu", 20), 0.011 * scale, 0.018 * scale, 0, g);
  return g;
}
/** Micro servo (SG90 size, 23 × 12 × 22 mm) in sky-blue plastic. */
function microServo() {
  const g = new THREE.Group();
  at(rbox(0.023, 0.022, 0.012, "sky", 0.002), 0, 0, 0, g);
  at(cyl(0.003, 0.003, 0.004, "shell", 12), 0.006, 0.013, 0, g);
  return g;
}
function wheel(r, w, hub = "alu") {
  const g = new THREE.Group();
  const tire = at(cyl(r, r, w, "rubber", 40), 0, 0, 0, g);
  tire.rotation.z = Math.PI / 2;
  const h = at(cyl(r * 0.55, r * 0.55, w * 1.04, hub, 24), 0, 0, 0, g);
  h.rotation.z = Math.PI / 2;
  // a spoke so the spin is visible
  at(rbox(w * 1.08, r * 1.1, r * 0.12, "graphite", 0.001), 0, 0, 0, g);
  return g;
}
function board(w, d, color = "pcb") {
  const g = new THREE.Group();
  at(rbox(w, 0.003, d, color, 0.001), 0, 0, 0, g);
  at(rbox(w * 0.3, 0.004, d * 0.3, "graphite", 0.001), 0, 0.0035, 0, g);
  return g;
}
function battery(w, h, d) {
  const g = new THREE.Group();
  at(rbox(w, h, d, "sun", 0.004), 0, 0, 0, g);
  at(rbox(w * 1.01, h * 0.3, d * 1.01, "graphite", 0.002), 0, 0, 0, g);
  return g;
}
const pivot = (x, y, z, parent) => at(new THREE.Group(), x, y, z, parent);

// ---------------------------------------------------------------- 1. Synth Arm = LeRobot SO-101
// Link lengths match web/js/sim/arm-sim.js so the model and the Proving Grounds sim agree.
function so101({ accent = "accent" } = {}) {
  const r = new Rig("so101");
  const root = r.group;
  const L = { base: 0.06, upper: 0.116, fore: 0.135, hand: 0.1 };
  const base = r.part(at(new THREE.Group(), 0, 0, 0, root), "Base and clamp", [0, 0, 0]);
  at(rbox(0.11, 0.012, 0.13, "shell", 0.006), 0, 0.006, 0, base);
  at(cyl(0.045, 0.05, 0.03, "shell"), 0, 0.027, 0, base);
  const panS = at(servo(), 0, 0.03, 0, base);
  panS.rotation.z = Math.PI / 2;
  r.callout(panS, "Bus servo ×6 (STS3215)", "actuator");

  const pan = r.joint("shoulder_pan", pivot(0, 0.045, 0, base), "y", [-110, 110], 0);
  const shoulder = r.part(pivot(0, L.base - 0.045, 0, pan), "Shoulder", [0, 0.05, 0]);
  at(rbox(0.05, 0.05, 0.05, accent, 0.008), 0, 0, 0, shoulder);
  const lift = r.joint("shoulder_lift", pivot(0, 0, 0, shoulder), "z", [-100, 100], -30, -1);
  const upper = r.part(pivot(0, 0, 0, lift), "Upper arm", [0, 0.09, 0]);
  at(rbox(0.032, L.upper, 0.028, "shell", 0.008), 0, L.upper / 2, 0, upper);
  at(servo(), 0, L.upper * 0.45, 0.022, upper).rotation.x = Math.PI / 2;
  const elbow = r.joint("elbow_flex", pivot(0, L.upper, 0, upper), "z", [-100, 100], 90, -1);
  const fore = r.part(pivot(0, 0, 0, elbow), "Forearm", [0.05, 0.12, 0]);
  at(rbox(0.028, L.fore, 0.026, "shell", 0.008), 0, L.fore / 2, 0, fore);
  at(rbox(0.036, 0.036, 0.036, accent, 0.006), 0, 0, 0, fore);
  const wrist = r.joint("wrist_flex", pivot(0, L.fore, 0, fore), "z", [-100, 100], 60, -1);
  at(rbox(0.032, 0.032, 0.032, accent, 0.006), 0, 0, 0, wrist);
  const roll = r.joint("wrist_roll", pivot(0, 0.02, 0, wrist), "y", [-160, 160], 0);
  const hand = r.part(pivot(0, 0, 0, roll), "Gripper", [0.08, 0.16, 0]);
  at(rbox(0.04, 0.05, 0.03, "shell", 0.006), 0, 0.025, 0, hand);
  at(rbox(0.008, L.hand - 0.04, 0.02, "graphite", 0.003), -0.012, 0.05 + (L.hand - 0.04) / 2, 0, hand);
  const jaw = r.joint("gripper", pivot(0.006, 0.05, 0, hand), "z", [0, 100], 100, -0.35);
  at(rbox(0.008, L.hand - 0.045, 0.02, "graphite", 0.003), 0.004, (L.hand - 0.045) / 2, 0, jaw);
  r.callout(hand, "Gripper jaw (servo 6)", "actuator");
  r.callout(base, "USB bus adapter → PC or phone", "brain");
  r.callout(base, "Servo position sensors (magnetic encoders)", "sensor");
  return r;
}

// ---------------------------------------------------------------- 2. Street Rover = OpenBot (phone on wheels)
function rover() {
  const r = new Rig("rover");
  const root = r.group;
  const chassis = r.part(pivot(0, 0.045, 0, root), "Chassis", [0, 0, 0]);
  at(rbox(0.13, 0.03, 0.2, "shell", 0.008), 0, 0, 0, chassis);
  for (const [x, z] of [[-1, 1], [1, 1], [-1, -1], [1, -1]]) {
    const m = r.part(pivot(x * 0.055, -0.005, z * 0.06, chassis), x < 0 ? "Gear motor (L)" : "Gear motor (R)", [x * 0.06, 0, 0]);
    at(rbox(0.04, 0.022, 0.022, "sun", 0.003), 0, 0, 0, m);
    const w = r.spin(at(wheel(0.034, 0.026), x * 0.04, 0, 0, m), "x", "wheel");
    void w;
  }
  const mcu = r.part(at(board(0.07, 0.045), 0, 0.017, -0.05, chassis), "Arduino Nano + driver", [0, 0.08, -0.04]);
  r.callout(mcu, "Microcontroller (motor PWM)", "brain");
  const bat = r.part(at(battery(0.07, 0.022, 0.05), 0, 0.027, 0.03, chassis), "Battery 3×18650", [0, 0.1, 0.05]);
  r.callout(bat, "Battery", "power");
  const mount = r.part(pivot(0, 0.03, 0.07, chassis), "Phone mount + phone", [0, 0.12, 0.06]);
  at(rbox(0.09, 0.012, 0.02, "graphite", 0.004), 0, 0, 0, mount);
  r.face = phoneFace();
  const ph = at(phone({ face: r.face.texture }), 0, 0.085, 0, mount);
  r.callout(ph, "Phone: camera, IMU, compute", "sensor");
  return r;
}

// ---------------------------------------------------------------- 3. Cyber Hound = Pupper-class quadruped
function hound() {
  const r = new Rig("hound");
  const root = r.group;
  const body = r.part(pivot(0, 0.17, 0, root), "Body", [0, 0, 0]);
  at(rbox(0.11, 0.06, 0.24, "shell", 0.02), 0, 0, 0, body);
  at(rbox(0.112, 0.012, 0.18, "accent", 0.005), 0, 0.031, 0, body);
  const head = at(rbox(0.07, 0.04, 0.03, "graphite", 0.01), 0, 0.01, 0.13, body);
  r.callout(head, "Stereo camera", "sensor");
  const bat = r.part(at(battery(0.08, 0.03, 0.12), 0, -0.01, 0, body), "Battery 2S", [0, -0.12, 0]);
  r.callout(bat, "Battery", "power");
  const pi = r.part(at(board(0.085, 0.056), 0, 0.04, -0.05, body), "Raspberry Pi", [0, 0.1, -0.05]);
  r.callout(pi, "Onboard computer", "brain");
  for (const [side, sx] of [["l", -1], ["r", 1]]) {
    for (const [end, sz] of [["f", 1], ["b", -1]]) {
      const id = end + side;
      const hip = r.joint(`${id}_hip`, pivot(sx * 0.068, -0.01, sz * 0.09, body), "z", [-30, 30], 0, sx);
      at(servo(0.9), 0, 0, 0, hip).rotation.z = Math.PI / 2;
      const thigh = r.joint(`${id}_thigh`, pivot(sx * 0.025, 0, 0, hip), "x", [-90, 90], 35, -1);
      const t = r.part(pivot(0, 0, 0, thigh), "Leg", [sx * 0.08, 0, 0]);
      at(rbox(0.018, 0.08, 0.024, "graphite", 0.006), 0, -0.04, 0, t);
      const knee = r.joint(`${id}_knee`, pivot(0, -0.08, 0, t), "x", [-150, 0], -70, -1);
      at(rbox(0.014, 0.085, 0.016, "shell", 0.005), 0, -0.042, 0, knee);
      at(sphere(0.012, "rubber"), 0, -0.085, 0, knee);
      if (id === "fl") r.callout(hip, "12 actuators (3 per leg)", "actuator");
    }
  }
  return r;
}

// ---------------------------------------------------------------- 4. Ghost Hand = open dexterous hand
function hand() {
  const r = new Rig("hand");
  const root = r.group;
  const wrist = r.part(pivot(0, 0.05, 0, root), "Wrist + servo pack", [0, -0.06, 0]);
  at(cyl(0.035, 0.04, 0.1, "graphite"), 0, 0, 0, wrist);
  for (let i = 0; i < 4; i++) at(servo(0.7), 0, -0.03 + i * 0.022, 0.028, wrist).rotation.y = Math.PI / 2;
  r.callout(wrist, "8 micro servos drive the fingers", "actuator");
  const palm = r.part(pivot(0, 0.06, 0, wrist), "Palm", [0, 0, 0]);
  at(rbox(0.09, 0.1, 0.03, "shell", 0.012), 0, 0.05, 0, palm);
  r.callout(palm, "Fingertip force sensing (optional)", "sensor");
  const xs = [-0.03, -0.01, 0.01, 0.03];
  xs.forEach((x, i) => {
    const len = [0.05, 0.058, 0.056, 0.046][i];
    const f = r.part(pivot(x, 0.1, 0, palm), `Finger ${i + 1}`, [x * 1.5, 0.05, 0]);
    const a = r.joint(`f${i + 1}_base`, pivot(0, 0, 0, f), "x", [0, 90], 10);
    at(rbox(0.017, len, 0.018, i % 2 ? "shell" : "accent", 0.007), 0, len / 2, 0, a);
    const b = r.joint(`f${i + 1}_tip`, pivot(0, len, 0, a), "x", [0, 100], 10);
    at(rbox(0.015, len * 0.75, 0.016, "shell", 0.007), 0, len * 0.37, 0, b);
  });
  const th = r.part(pivot(-0.05, 0.03, 0.005, palm), "Thumb", [-0.06, 0, 0]);
  const t1 = r.joint("thumb_base", pivot(0, 0, 0, th), "z", [0, 70], 35, 1);
  at(rbox(0.02, 0.045, 0.02, "accent", 0.008), 0, 0.022, 0, t1);
  const t2 = r.joint("thumb_tip", pivot(0, 0.045, 0, t1), "z", [0, 80], 10, 1);
  at(rbox(0.017, 0.035, 0.018, "shell", 0.007), 0, 0.017, 0, t2);
  return r;
}

// ---------------------------------------------------------------- 5. Spider Mech = hexapod
function spider() {
  const r = new Rig("spider");
  const root = r.group;
  const body = r.part(pivot(0, 0.11, 0, root), "Body plates", [0, 0, 0]);
  const plate = at(cyl(0.1, 0.1, 0.012, "shell", 6), 0, 0.02, 0, body);
  plate.rotation.y = Math.PI / 6;
  at(cyl(0.1, 0.1, 0.012, "graphite", 6), 0, -0.02, 0, body).rotation.y = Math.PI / 6;
  const ctrl = r.part(at(board(0.06, 0.05), 0, 0.03, 0, body), "ESP32 servo controller", [0, 0.1, 0]);
  r.callout(ctrl, "Controller + gait engine", "brain");
  const bat = r.part(at(battery(0.07, 0.02, 0.04), 0, -0.035, 0, body), "Battery", [0, -0.08, 0]);
  r.callout(bat, "Battery", "power");
  const eye = at(rbox(0.04, 0.02, 0.015, "graphite", 0.005), 0, 0.045, 0.085, body);
  r.callout(eye, "Ultrasonic range sensor", "sensor");
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2 + Math.PI / 6;
    const mount = pivot(Math.sin(a) * 0.1, 0, Math.cos(a) * 0.1, body);
    mount.rotation.y = a;
    const id = `leg${i + 1}`;
    const coxa = r.joint(`${id}_coxa`, pivot(0, 0, 0, mount), "y", [-40, 40], 0);
    at(microServo(), 0, 0, 0.012, coxa);
    const leg = r.part(pivot(0, 0, 0.025, coxa), "Leg", [0, 0, 0.06]);
    const femur = r.joint(`${id}_femur`, pivot(0, 0, 0, leg), "x", [-60, 60], -20, 1);
    at(rbox(0.016, 0.014, 0.06, "accent", 0.005), 0, 0, 0.03, femur);
    const tibia = r.joint(`${id}_tibia`, pivot(0, 0, 0.06, femur), "x", [-30, 120], 90, 1);
    at(rbox(0.012, 0.012, 0.09, "graphite", 0.005), 0, 0, 0.045, tibia);
    at(sphere(0.008, "rubber"), 0, 0, 0.09, tibia);
    if (i === 0) r.callout(coxa, "18 micro servos (3 per leg)", "actuator");
  }
  return r;
}

// ---------------------------------------------------------------- 6. Sky Drone = ESP-Drone / Crazyflie-class quad
function drone() {
  const r = new Rig("drone");
  const root = r.group;
  const body = r.part(pivot(0, 0.06, 0, root), "Frame", [0, 0, 0]);
  at(rbox(0.06, 0.016, 0.09, "shell", 0.006), 0, 0, 0, body);
  const fc = r.part(at(board(0.04, 0.04), 0, 0.012, 0, body), "Flight controller (ESP32 + IMU)", [0, 0.08, 0]);
  r.callout(fc, "IMU: gyro + accelerometer", "sensor");
  r.callout(fc, "ESP32 flight controller", "brain");
  const bat = r.part(at(battery(0.03, 0.012, 0.06), 0, -0.016, 0, body), "1S LiPo", [0, -0.07, 0]);
  r.callout(bat, "Battery", "power");
  const dirs = [[1, 1, "cw"], [-1, 1, "ccw"], [-1, -1, "cw"], [1, -1, "ccw"]];
  dirs.forEach(([x, z, sense], i) => {
    const arm = at(rbox(0.07, 0.008, 0.012, "graphite", 0.003), x * 0.035, 0, z * 0.035, body);
    arm.rotation.y = -Math.atan2(z, x);
    const m = r.part(pivot(x * 0.07, 0.01, z * 0.07, body), `Motor ${i + 1} (${sense.toUpperCase()})`, [x * 0.05, 0.03, z * 0.05]);
    at(cyl(0.009, 0.009, 0.016, "alu", 20), 0, 0, 0, m);
    const prop = r.spin(pivot(0, 0.011, 0, m), "y", `prop-${sense}`);
    for (const k of [0, 1]) {
      const blade = at(rbox(0.065, 0.002, 0.011, sense === "cw" ? "sky" : "accent", 0.001), 0, 0, 0, prop);
      blade.rotation.y = k * Math.PI;
      blade.position.x = (k ? -1 : 1) * 0.03;
      blade.rotation.x = (k ? -1 : 1) * 0.15;
    }
    if (i === 0) r.callout(m, "4 coreless motors", "actuator");
  });
  return r;
}

// ---------------------------------------------------------------- 7. Fab Rig = open 3D printer
function fab() {
  const r = new Rig("fab");
  const root = r.group;
  const S = 0.32;
  const frame = r.part(pivot(0, 0, 0, root), "Frame (2020 extrusion)", [0, 0, 0]);
  for (const [x, z] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) at(rbox(0.02, S, 0.02, "alu", 0.002), (x * S) / 2, S / 2, (z * S) / 2, frame);
  for (const y of [0.01, S]) {
    for (const z of [-1, 1]) at(rbox(S, 0.02, 0.02, "alu", 0.002), 0, y, (z * S) / 2, frame);
    for (const x of [-1, 1]) at(rbox(0.02, 0.02, S, "alu", 0.002), (x * S) / 2, y, 0, frame);
  }
  // bed moves on Y (front/back), gantry on Z (height), toolhead on X: joints are linear, so expose them as "slides"
  const bed = r.part(pivot(0, 0.06, 0, frame), "Heated bed", [0, -0.05, 0.12]);
  at(rbox(0.22, 0.008, 0.22, "graphite", 0.003), 0, 0, 0, bed);
  at(rbox(0.06, 0.02, 0.06, "accent", 0.004), 0.03, 0.014, -0.02, bed); // a print
  const gantry = r.part(pivot(0, 0.2, 0, frame), "Gantry", [0, 0.1, 0]);
  at(rbox(S, 0.02, 0.025, "graphite", 0.004), 0, 0, 0, gantry);
  const head = r.part(pivot(0, -0.02, 0.02, gantry), "Toolhead + hotend", [0, 0.1, 0.1]);
  at(rbox(0.05, 0.06, 0.04, "accent", 0.006), 0, 0, 0, head);
  at(cyl(0.002, 0.006, 0.015, "copper", 12), 0, -0.037, 0, head);
  r.callout(head, "Hotend thermistor", "sensor");
  const ctrl = r.part(at(board(0.1, 0.07), S / 2 + 0.02, 0.06, 0, frame), "Mainboard", [0.1, 0, 0]);
  ctrl.rotation.z = Math.PI / 2;
  r.callout(ctrl, "Mainboard + Klipper host", "brain");
  const steppers = at(rbox(0.042, 0.042, 0.042, "servo", 0.004), -S / 2, 0.035, -S / 2, frame);
  r.callout(steppers, "4 stepper motors", "actuator");
  const spool = r.spin(r.part(pivot(-S / 2 - 0.04, S * 0.75, 0, frame), "Filament spool", [-0.1, 0, 0]), "x", "spool");
  const sp = at(cyl(0.07, 0.07, 0.05, "sage", 32), 0, 0, 0, spool);
  sp.rotation.z = Math.PI / 2;
  r.callout(spool, "PSU 24 V", "power");
  r.slides = { bed, gantry, head }; // Workbench animates these as linear axes
  return r;
}

// ---------------------------------------------------------------- 8. Replicant = small open humanoid
function replicant() {
  const r = new Rig("replicant");
  const root = r.group;
  const pelvis = r.part(pivot(0, 0.27, 0, root), "Pelvis", [0, 0, 0]);
  at(rbox(0.1, 0.035, 0.05, "graphite", 0.01), 0, 0, 0, pelvis);
  const torsoJ = r.joint("torso_yaw", pivot(0, 0.02, 0, pelvis), "y", [-60, 60], 0);
  const torso = r.part(pivot(0, 0, 0, torsoJ), "Torso", [0, 0.06, 0]);
  at(rbox(0.11, 0.12, 0.06, "shell", 0.018), 0, 0.065, 0, torso);
  at(rbox(0.06, 0.03, 0.062, "accent", 0.006), 0, 0.08, 0, torso);
  const pi = at(board(0.06, 0.04), 0, 0.06, -0.035, torso);
  pi.rotation.x = Math.PI / 2;
  r.callout(pi, "Onboard computer", "brain");
  const neck = r.joint("head_pan", pivot(0, 0.13, 0, torso), "y", [-80, 80], 0);
  const head = r.part(pivot(0, 0.03, 0, neck), "Head", [0, 0.06, 0]);
  at(rbox(0.07, 0.055, 0.06, "shell", 0.02), 0, 0, 0, head);
  const visor = at(rbox(0.055, 0.018, 0.005, "glass", 0.004), 0, 0.005, 0.03, head);
  r.callout(visor, "Camera + IMU", "sensor");
  for (const [s, sx] of [["l", -1], ["r", 1]]) {
    const sh = r.joint(`${s}_shoulder`, pivot(sx * 0.07, 0.11, 0, torso), "x", [-170, 60], 0, 1); // negative raises the arm forward
    const arm = r.part(pivot(0, 0, 0, sh), "Arm", [sx * 0.06, 0, 0]);
    at(rbox(0.024, 0.07, 0.026, "graphite", 0.008), 0, -0.035, 0, arm);
    const el = r.joint(`${s}_elbow`, pivot(0, -0.07, 0, arm), "x", [-120, 0], -15, 1);
    at(rbox(0.022, 0.065, 0.024, "shell", 0.008), 0, -0.032, 0, el);
    const hip = r.joint(`${s}_hip`, pivot(sx * 0.03, -0.02, 0, pelvis), "x", [-90, 60], 0, -1);
    const leg = r.part(pivot(0, 0, 0, hip), "Leg", [sx * 0.05, -0.02, 0]);
    at(rbox(0.03, 0.11, 0.034, "shell", 0.01), 0, -0.055, 0, leg);
    const knee = r.joint(`${s}_knee`, pivot(0, -0.11, 0, leg), "x", [0, 130], 0, 1);
    at(rbox(0.028, 0.11, 0.03, "graphite", 0.01), 0, -0.055, 0, knee);
    const ankle = r.joint(`${s}_ankle`, pivot(0, -0.11, 0, knee), "x", [-60, 60], 0, -1);
    at(rbox(0.04, 0.014, 0.075, "graphite", 0.005), 0, -0.012, 0.012, ankle);
    if (s === "l") r.callout(hip, "Bus servos at hips, knees, ankles", "actuator");
  }
  const bat = at(battery(0.06, 0.04, 0.025), 0, 0.05, -0.045, torso);
  r.callout(bat, "Battery 3S", "power");
  return r;
}

// ---------------------------------------------------------------- 9. OpenForge AX-1: one phone brain, three bodies

/** ESP32 bridge board (Waveshare-style driver: bus servo port + motor driver + BLE). */
function bridge() {
  const g = board(0.065, 0.05, "sky");
  at(rbox(0.018, 0.004, 0.025, "alu", 0.001), -0.018, 0.004, 0, g); // ESP32 module can
  return g;
}

/** Neck: a pan servo and a short post. Returns the tilt pivot, where the head sits. */
function neck(r, parent, y, panRange, tiltRange, postH = 0.035) {
  const pan = r.joint("head_pan", pivot(0, y, 0, parent), "y", panRange, 0);
  at(cyl(0.018, 0.022, 0.016, "graphite", 24), 0, 0.008, 0, pan);
  at(cyl(0.011, 0.011, postH, "alu", 20), 0, 0.016 + postH / 2, 0, pan);
  r.callout(pan, "Neck servos (pan + tilt)", "actuator");
  return r.joint("head_tilt", pivot(0, 0.016 + postH, 0, pan), "x", tiltRange, 0, -1);
}

function ax1Rover(r) {
  const root = r.group;
  const chassis = r.part(pivot(0, 0.058, 0, root), "Chassis (printed)", [0, 0, 0]);
  at(rbox(0.17, 0.062, 0.15, "shell", 0.026), 0, 0, 0, chassis);
  at(rbox(0.172, 0.014, 0.12, "accent", 0.006), 0, 0.018, 0, chassis);
  for (const sx of [-1, 1]) {
    const w = r.part(pivot(sx * 0.1, -0.006, 0.012, chassis), sx < 0 ? "Wheel + gear motor (L)" : "Wheel + gear motor (R)", [sx * 0.06, 0, 0]);
    r.spin(at(wheel(0.052, 0.026), 0, 0, 0, w), "x", sx < 0 ? "wheel-l" : "wheel-r");
  }
  at(sphere(0.014, "alu"), 0, -0.045, -0.055, chassis); // caster
  const br = r.part(at(bridge(), 0, -0.012, -0.02, chassis), "ESP32 bridge", [0, -0.09, -0.07]);
  r.callout(br, "ESP32 bridge: BLE ⇄ motors + servos", "brain");
  const bat = r.part(at(battery(0.08, 0.022, 0.045), 0, 0.012, 0.04, chassis), "2S battery", [0, 0.09, 0.09]);
  r.callout(bat, "2S Li-ion + 5 V buck", "power");
  return neck(r, chassis, 0.031, [-90, 90], [-30, 30], 0.03);
}

function ax1Desk(r) {
  const root = r.group;
  // Clearances (checked in test/Models.test.js): a hanging arm ends 14 mm above the base, and the arms clear the torso's
  // sides by 9 mm: the torso stands on the yaw servo's turntable, the shoulders sit at the top of the torso.
  const base = r.part(pivot(0, 0, 0, root), "Base (printed)", [0, 0, 0]);
  at(cyl(0.1, 0.11, 0.025, "shell", 64), 0, 0.0125, 0, base);
  at(torus(0.104, 0.004, "accent"), 0, 0.025, 0, base).rotation.x = Math.PI / 2;
  const br = r.part(at(bridge(), 0, 0.027, -0.068, base), "ESP32 bridge", [0, 0.05, -0.1]);
  r.callout(br, "ESP32 bridge: BLE ⇄ bus servos", "brain");
  const bat = r.part(at(battery(0.06, 0.02, 0.035), 0, 0.011, 0.05, base), "2S battery (inside the base)", [0, 0, 0.12]);
  r.callout(bat, "2S Li-ion or 12 V USB-C", "power");
  const yaw = r.joint("torso_yaw", pivot(0, 0.025, 0, base), "y", [-120, 120], 0);
  at(cyl(0.034, 0.034, 0.025, "servo", 32), 0, 0.0125, 0, yaw); // the yaw servo's turntable: the torso stands on it
  const body = r.part(pivot(0, 0.025, 0, yaw), "Torso", [0, 0.03, 0]);
  at(rbox(0.12, 0.11, 0.08, "graphite", 0.034), 0, 0.058, 0, body);
  at(rbox(0.07, 0.012, 0.082, "accent", 0.005), 0, 0.075, 0, body);
  r.callout(body, "7 bus servos (STS3215)", "actuator");
  for (const sx of [-1, 1]) {
    const s = sx < 0 ? "l" : "r";
    const sh = r.joint(`${s}_shoulder`, pivot(sx * 0.074, 0.1, 0, body), "x", [-170, 40], 0, 1); // negative raises the arm forward
    const arm = r.part(pivot(0, 0, 0, sh), "Arm", [sx * 0.07, 0, 0]);
    at(cyl(0.018, 0.018, 0.022, "servo", 24), sx * 0.006, 0, 0, arm).rotation.z = Math.PI / 2;
    at(rbox(0.026, 0.046, 0.03, "shell", 0.012), sx * 0.012, -0.025, 0, arm);
    const el = r.joint(`${s}_elbow`, pivot(sx * 0.012, -0.048, 0, arm), "x", [-120, 0], -20, 1);
    at(rbox(0.024, 0.046, 0.028, "shell", 0.012), 0, -0.022, 0, el);
    at(sphere(0.013, "accent"), 0, -0.046, 0, el);
  }
  return neck(r, body, 0.113, [-100, 100], [-25, 35], 0.022);
}

function ax1Walker(r) {
  const root = r.group;
  const hips = r.part(pivot(0, 0.235, 0, root), "Hip block", [0, 0, 0]);
  at(rbox(0.13, 0.035, 0.06, "graphite", 0.014), 0, 0, 0, hips);
  for (const [s, sx] of [["l", -1], ["r", 1]]) {
    const yaw = r.joint(`${s}_hip_yaw`, pivot(sx * 0.042, -0.022, 0, hips), "y", [-30, 30], 0);
    const roll = r.joint(`${s}_hip_roll`, pivot(0, -0.018, 0, yaw), "z", [-25, 25], 0, sx);
    at(servo(0.85), 0, 0, 0, roll).rotation.z = Math.PI / 2;
    // protocol signs (web/js/pilot/ax-proto.js): hip_pitch < 0 swings the leg forward, and the foot stays flat when
    // hip_pitch + knee + ankle_pitch = 0 (checked in test/Models.test.js)
    const pitch = r.joint(`${s}_hip_pitch`, pivot(0, -0.012, 0, roll), "x", [-90, 60], 0, 1);
    const thigh = r.part(pivot(0, 0, 0, pitch), "Leg", [sx * 0.06, 0, 0]);
    at(rbox(0.034, 0.08, 0.036, "shell", 0.013), 0, -0.045, 0, thigh);
    const knee = r.joint(`${s}_knee`, pivot(0, -0.088, 0, thigh), "x", [0, 130], 0, 1);
    at(cyl(0.017, 0.017, 0.038, "servo", 20), 0, 0, 0, knee).rotation.z = Math.PI / 2;
    at(rbox(0.03, 0.078, 0.032, "graphite", 0.012), 0, -0.042, 0, knee);
    const ap = r.joint(`${s}_ankle_pitch`, pivot(0, -0.084, 0, knee), "x", [-60, 60], 0, 1);
    const ar = r.joint(`${s}_ankle_roll`, pivot(0, -0.008, 0, ap), "z", [-25, 25], 0, sx);
    at(rbox(0.05, 0.014, 0.088, "accent", 0.006), 0, -0.007, 0.012, ar);
    if (s === "l") r.callout(pitch, "12 leg servos + 1 torso yaw", "actuator");
  }
  const yaw = r.joint("torso_yaw", pivot(0, 0.018, 0, hips), "y", [-60, 60], 0);
  const torso = r.part(pivot(0, 0, 0, yaw), "Torso", [0, 0.05, 0]);
  at(rbox(0.12, 0.06, 0.07, "shell", 0.024), 0, 0.03, 0, torso);
  at(rbox(0.122, 0.01, 0.06, "accent", 0.004), 0, 0.03, 0, torso);
  const br = r.part(at(bridge(), 0, 0.035, -0.04, torso), "ESP32 bridge", [0, 0, -0.1]);
  br.rotation.x = Math.PI / 2;
  r.callout(br, "ESP32 bridge: BLE ⇄ 13 bus servos", "brain");
  const bat = r.part(at(battery(0.07, 0.022, 0.04), 0, 0.03, -0.012, torso), "3S battery (inside the torso)", [0, 0, 0.12]);
  r.callout(bat, "3S Li-ion", "power");
  const tilt = r.joint("head_tilt", pivot(0, 0.062, 0, torso), "x", [-15, 20], 0, -1);
  at(cyl(0.011, 0.011, 0.012, "alu", 20), 0, 0.006, 0, tilt);
  return tilt;
}

/**
 * AX-1: body = "rover" | "desk" | "walker". The phone lies landscape in a head cradle on the neck (or torso)
 * and shows AX-1's live face; same proportions as the logo mark (art/brand/src/mark.mjs).
 */
function ax1({ body = "rover" } = {}) {
  const r = new Rig(`ax1-${body}`);
  const top = { rover: ax1Rover, desk: ax1Desk, walker: ax1Walker }[body](r);
  const head = r.part(pivot(0, 0.012, 0, top), "Head cradle + phone", [0, 0.07, 0]);
  const H = 0.082; // cradle height; the phone (155 × 75 mm) sits in it landscape
  at(rbox(0.168, H, 0.014, "graphite", 0.012), 0, H / 2, -0.009, head);
  for (const sx of [-1, 1]) at(rbox(0.016, 0.042, 0.03, "graphite", 0.006), sx * 0.088, H / 2, -0.004, head); // clamp jaws = "ears"
  at(rbox(0.05, 0.012, 0.03, "accent", 0.005), 0, 0.004, -0.004, head); // chin bar
  r.face = phoneFace({ w: 512, h: 248 });
  const ph = at(phone({ face: r.face.texture, landscape: true }), 0, H / 2, 0.003, head);
  r.callout(ph, "Phone camera + IMU + mic", "sensor");
  r.callout(ph, "Phone = the brain (Phone Brain app)", "brain");
  r.phone = ph;
  r.head = head;
  return r;
}

// ---------------------------------------------------------------- catalogue

/** Display metadata. `cls` = index of the on-chain Class trait (AX-1 Rover / Desk / Walker are 8 / 9 / 10). Platform facts live in bench data. */
export const ROBOTS = {
  so101: { name: "Synth Arm", platform: "LeRobot SO-101", cls: 0, build: so101, color: PALETTE.accent },
  rover: { name: "Street Rover", platform: "OpenBot", cls: 1, build: rover, color: PALETTE.sun },
  hound: { name: "Cyber Hound", platform: "Open quadruped (Pupper class)", cls: 2, build: hound, color: PALETTE.sage },
  hand: { name: "Ghost Hand", platform: "Open dexterous hand", cls: 3, build: hand, color: PALETTE.plum },
  spider: { name: "Spider Mech", platform: "Open hexapod", cls: 4, build: spider, color: PALETTE.accent },
  drone: { name: "Sky Drone", platform: "ESP-Drone / Crazyflie class", cls: 5, build: drone, color: PALETTE.sky },
  fab: { name: "Fab Rig", platform: "Open 3D printer", cls: 6, build: fab, color: PALETTE.sage },
  replicant: { name: "Replicant", platform: "Open small humanoid", cls: 7, build: replicant, color: PALETTE.plum },
  "ax1-rover": { name: "AX-1 Rover", platform: "OpenForge AX-1", cls: 8, build: () => ax1({ body: "rover" }), color: PALETTE.accent },
  "ax1-desk": { name: "AX-1 Desk", platform: "OpenForge AX-1", cls: 9, build: () => ax1({ body: "desk" }), color: PALETTE.accent },
  "ax1-walker": { name: "AX-1 Walker", platform: "OpenForge AX-1", cls: 10, build: () => ax1({ body: "walker" }), color: PALETTE.accent },
};

/** Build a robot by id. Throws on an unknown id. */
export function buildRobot(id, opts) {
  const def = ROBOTS[id];
  if (!def) throw new Error(`unknown robot ${id}`);
  const rig = def.build(opts);
  rig.group.userData.robot = id;
  return rig;
}

/** Axis-aligned bounds of a rig at its current pose (for camera framing). */
export function bounds(rig) {
  rig.group.updateMatrixWorld(true);
  return new THREE.Box3().setFromObject(rig.group);
}

export { mat };
