// Test stage scenes: mission props (markers, cones, rings, beds…) and the mapping from a mission state to the Rig.
// makeTestScene(robotId, view, rig, mission, state) → { update(state), labels, camera, phoneCam? }.
import * as THREE from "three";
import { fk } from "../sim/arm-sim.js";
import { rbox, cyl, sphere, torus, PALETTE } from "../models/look.js";
import { leg } from "./missions/hound.js";
import { gazeOf, pointOf } from "./missions/ax1-desk.js";
import { setHand, setSpider, setDesk, makeBipedPoser, placeComMarkers, setRaw } from "./motions.js";

const RAD = Math.PI / 180;
const sim3 = (p) => new THREE.Vector3(p.x, p.z, -p.y);
const basic = (color, opacity = 1) => new THREE.MeshBasicMaterial({ color, transparent: opacity < 1, opacity });
function flatRing(r, w, color) {
  const m = new THREE.Mesh(new THREE.RingGeometry(r - w, r, 48), basic(color));
  m.rotation.x = -Math.PI / 2;
  m.position.y = 0.002;
  return m;
}
function floorLine(points, color, closed = false) {
  const pts = points.map(([x, z]) => new THREE.Vector3(x, 0.003, z));
  if (closed) pts.push(pts[0].clone());
  return new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color }));
}
function floorArrow(len, color) {
  const g = new THREE.Group();
  const m = basic(color);
  const shaft = new THREE.Mesh(new THREE.PlaneGeometry(len * 0.12, len * 0.7), m);
  shaft.rotation.x = -Math.PI / 2;
  shaft.position.set(0, 0.003, len * 0.35 - len / 2);
  const head = new THREE.Mesh(new THREE.CircleGeometry(len * 0.22, 3), m);
  head.rotation.set(-Math.PI / 2, 0, Math.PI / 2);
  head.position.set(0, 0.003, len * 0.7 - len / 2 + len * 0.05);
  g.add(shaft, head);
  return g;
}
function cone(h = 0.12) {
  const g = new THREE.Group();
  const c = cyl(0.005, 0.05, h, "accent", 24);
  c.position.y = h / 2;
  const band = cyl(0.03, 0.034, 0.018, "shell", 24);
  band.position.y = h * 0.55;
  g.add(c, band);
  return g;
}
const boxOf = (pts) => new THREE.Box3().setFromPoints(pts.map((p) => (p.isVector3 ? p : new THREE.Vector3(p[0], p[1], p[2]))));

// ---------------------------------------------------------------- per robot
function arm(v, rig, m, s) {
  const props = [];
  let target = null, dock = null;
  if (s.target) {
    target = v.addProp(sphere(0.012, "sky"));
    target.position.copy(sim3(s.target));
    const post = v.addProp(cyl(0.0015, 0.0015, s.target.z, "line"));
    post.position.copy(sim3({ ...s.target, z: s.target.z / 2 }));
  }
  if (s.dock) {
    dock = v.addProp(flatRing(s.dock.r, 0.004, PALETTE.sage));
    dock.position.add(sim3({ ...s.dock, z: 0 }));
  }
  const cubes = s.cubes.map((c, i) => v.addProp(rbox(0.03, 0.03, 0.03, i ? "sky" : "sun", 0.004)));
  const tip = v.addProp(new THREE.Object3D());
  props.push(...cubes);
  const labels = [{ node: tip, text: "gripper tip", kind: "actuator" }];
  if (target) labels.push({ node: target, text: "marker", kind: "sensor" });
  if (dock) labels.push({ node: dock, text: "dock", kind: "sensor" });
  cubes.forEach((c, i) => labels.push({ node: c, text: s.level === "stack" ? (i ? "cube B" : "cube A") : "cube", kind: "power" }));
  return {
    labels,
    camera: { az: 62, el: 30, ...fitTo(v, [[-0.05, 0, -0.3], [0.32, 0.25, 0.3]]) },
    update(st) {
      rig.pose({ shoulder_pan: st.joints[0], shoulder_lift: st.joints[1], elbow_flex: st.joints[2], wrist_flex: st.joints[3], wrist_roll: st.joints[4], gripper: st.joints[5] });
      tip.position.copy(sim3(fk(st.joints).tip));
      st.cubes.forEach((c, i) => cubes[i].position.copy(sim3(c)));
    },
  };
}

function fitTo(v, pts, pad = 1.1) {
  const box = boxOf(pts);
  const f = v.frameBox(box, { pad });
  // `box` lets the view fit the scene exactly to the plate's shape (moveCamera); size is the round fallback.
  // A scene that asks for a tight sphere fit (pad < 1) also gets a tighter box margin, never below the box itself.
  return { size: f.size, tx: f.tx, ty: f.ty, tz: f.tz, box, pad: Math.min(1.12, Math.max(1.04, 1.12 * pad)) };
}

function drive(v, rig, m, s, { ax1 }) {
  const labels = [];
  const pts = [[0, 0, -0.3], [0, 0, 0.3]];
  s.cones.forEach((c, i) => {
    const o = v.addProp(cone());
    o.position.set(c.x, 0, c.z);
    pts.push([c.x, 0, c.z]);
    const g = s.gates[i];
    if (g) {
      // an arrow on the floor on the side to pass
      const a = v.addProp(floorArrow(0.18, PALETTE.sage));
      a.position.set(c.x + g.side * 0.3, 0, c.z);
      labels.push({ node: a, text: `gate ${i + 1}: pass this side`, kind: "sensor" });
    } else labels.push({ node: o, text: "cone", kind: "sensor" });
  });
  if (s.level === "slalom") {
    v.addProp(floorLine([[-0.6, s.finishZ], [0.6, s.finishZ]], PALETTE.ink));
    pts.push([0, 0, s.finishZ + 0.2]);
    const fin = v.addProp(new THREE.Object3D());
    fin.position.set(0.6, 0, s.finishZ);
    labels.push({ node: fin, text: "finish", kind: "brain" });
  }
  if (s.box) {
    const b = s.box;
    const g = new THREE.Group();
    g.position.set(b.x, 0, b.z);
    g.rotation.y = b.heading;
    g.add(floorLine([[-b.w / 2, -b.l / 2], [b.w / 2, -b.l / 2], [b.w / 2, b.l / 2], [-b.w / 2, b.l / 2]], PALETTE.accent, true));
    const arrow = floorArrow(0.14, PALETTE.accent);
    g.add(arrow);
    v.addProp(g);
    labels.push({ node: g, text: "park here, face the arrow", kind: "brain" });
    pts.push([b.x - 0.4, 0, b.z - 0.4], [b.x + 0.4, 0, b.z + 0.4]);
  }
  labels.push({ node: rig.group, text: ax1 ? "AX-1 Rover" : "rover", kind: "actuator" });
  // phone camera: looks forward (+z of the robot) from the phone, tilted down a little
  const phoneCam = new THREE.PerspectiveCamera(62, 4 / 3, 0.02, 20);
  const phoneNode = rig.phone || rig.parts.find((p) => /Phone/.test(p.label))?.node;
  const holder = new THREE.Object3D();
  rig.group.add(holder);
  rig.group.updateMatrixWorld(true);
  const pp = phoneNode ? rig.group.worldToLocal(phoneNode.getWorldPosition(new THREE.Vector3())) : new THREE.Vector3(0, 0.15, 0.05);
  holder.position.copy(pp).add(new THREE.Vector3(0, 0.01, 0.02));
  holder.add(phoneCam);
  phoneCam.rotation.set(-14 * RAD, Math.PI, 0, "YXZ");
  const r = ax1 ? 0.052 : 0.034;
  return {
    labels,
    phoneCam,
    camera: { az: 20, el: 55, ...fitTo(v, pts, 0.95) },
    update(st) {
      rig.group.position.set(st.x, 0, st.z);
      rig.group.rotation.y = st.heading;
      if (ax1) {
        rig.setSpin("wheel-l", st.vl / (2 * Math.PI * r));
        rig.setSpin("wheel-r", st.vr / (2 * Math.PI * r));
        rig.set("head_tilt", -10);
      } else rig.setSpin("wheel", (st.vl + st.vr) / 2 / (2 * Math.PI * r));
    },
  };
}

function drone(v, rig, m, s) {
  const labels = [];
  const pts = [[-0.4, 0, -0.4], [0.4, 1.2, 0.4]];
  const pole = v.addProp(cyl(0.004, 0.004, 1.5, "line", 12));
  pole.position.set(0.35, 0.75, -0.2);
  const mark = v.addProp(torus(0.03, 0.003, "accent"));
  mark.rotation.x = Math.PI / 2;
  mark.position.set(0.35, 1, -0.2);
  labels.push({ node: mark, text: "1.0 m", kind: "sensor" });
  if (s.level === "yaw") {
    const a = v.addProp(floorArrow(0.3, PALETTE.accent));
    a.rotation.y = s.goalYaw;
    a.position.set(Math.sin(s.goalYaw) * 0.25, 0, Math.cos(s.goalYaw) * 0.25);
    labels.push({ node: a, text: "turn to face this way", kind: "brain" });
  }
  if (s.ring) {
    const g = s.ring;
    const ring = v.addProp(torus(g.r, 0.012, "sun"));
    ring.position.set(g.x, g.y, g.z);
    ring.rotation.y = Math.atan2(g.nx, g.nz);
    const post = v.addProp(cyl(0.006, 0.006, g.y - g.r, "line", 12));
    post.position.set(g.x, (g.y - g.r) / 2, g.z);
    labels.push({ node: ring, text: "ring", kind: "sensor" });
    pts.push([g.x - 0.4, 0, g.z - 0.4], [g.x + 0.4, g.y + 0.4, g.z + 0.4]);
  }
  const fc = rig.parts.find((p) => /Flight controller/.test(p.label))?.node;
  labels.push({ node: fc, text: () => "drone", kind: "actuator" });
  return {
    labels,
    camera: { az: 30, el: 22, ...fitTo(v, pts, 0.85) },
    update(st) {
      const g = rig.group;
      g.position.set(st.x, st.y, st.z);
      g.rotation.set(st.pitch, st.yaw, -st.roll, "YXZ");
      const cw = (st.u[0] + st.u[2]) / 2, ccw = (st.u[1] + st.u[3]) / 2;
      rig.setSpin("prop-cw", -cw * 45);
      rig.setSpin("prop-ccw", ccw * 45);
    },
  };
}

function hound(v, rig, m, s) {
  const labels = [];
  const pts = [[-0.25, 0, -0.3], [0.25, 0.25, 0.3]];
  if (s.level === "trot") {
    v.addProp(floorLine([[-0.3, 0], [0.3, 0]], PALETTE.line));
    v.addProp(floorLine([[-0.3, 1], [0.3, 1]], PALETTE.ink));
    const fin = v.addProp(new THREE.Object3D());
    fin.position.set(0.3, 0, 1);
    labels.push({ node: fin, text: "1 m", kind: "brain" });
    pts.push([0, 0, 1.25]);
  }
  if (s.level === "turn") {
    const a = v.addProp(floorArrow(0.3, PALETTE.accent));
    a.rotation.y = s.goal;
    a.position.set(Math.sin(s.goal) * 0.3, 0, Math.cos(s.goal) * 0.3);
    labels.push({ node: a, text: "face this way", kind: "brain" });
    v.addProp(flatRing(0.25, 0.003, PALETTE.line));
  }
  if (s.level === "stand") {
    const band = v.addProp(rbox(0.3, 0.03, 0.003, mat2(PALETTE.sage), 0.001));
    band.position.set(0, 0.145 + 0.03, -0.16);
    labels.push({ node: band, text: "goal: body 13–16 cm high", kind: "sensor" });
  }
  labels.push({ node: rig.joints.fl_knee.node, text: "knee", kind: "actuator" });
  return {
    labels,
    camera: { az: 70, el: 24, ...fitTo(v, pts, 0.95) },
    update(st) {
      const g = rig.group;
      if (st.level === "stand") {
        for (const id of ["fl", "fr", "bl", "br"]) rig.pose({ [`${id}_thigh`]: st.thigh, [`${id}_knee`]: -st.bend });
        g.position.y = st.height + 0.012 - 0.16;
        return;
      }
      g.position.set(st.x, 0, st.z);
      g.rotation.y = st.heading;
      const legs = { fl: 0, br: 0, fr: 0.5, bl: 0.5 };
      const amp = st.mode === "trot" ? Math.min(1, st.stride / 0.08) : 0;
      for (const [id, off] of Object.entries(legs)) {
        const ph = 2 * Math.PI * (st.phase + off);
        rig.set(`${id}_thigh`, 35 + 14 * amp * Math.sin(ph));
        rig.set(`${id}_knee`, -70 - 28 * amp * Math.max(0, Math.cos(ph)));
      }
      g.position.y = 0.012 + leg(35, 70).h - 0.16;
      g.rotation.z = st.stumble * 0.25 * Math.sin(st.t * 20);
    },
  };
}
const mat2 = (hex) => new THREE.MeshStandardMaterial({ color: hex, transparent: true, opacity: 0.35, roughness: 0.9 });

function hand(v, rig, m, s) {
  const labels = [{ node: rig.parts.find((p) => /Finger 1/.test(p.label)).node, text: "index", kind: "actuator" }, { node: rig.parts.find((p) => /Thumb/.test(p.label)).node, text: "thumb", kind: "actuator" }];
  if (s.level === "power") {
    const c = v.addProp(cyl(s.objectCm / 200, s.objectCm / 200, 0.12, "sun", 32));
    c.rotation.z = Math.PI / 2;
    c.position.set(0, 0.2, 0.035);
    labels.push({ node: c, text: `cylinder ⌀ ${s.objectCm} cm`, kind: "sensor" });
  }
  const palm = rig.parts.find((p) => /Palm/.test(p.label)).node;
  if (s.level === "count") labels.push({ node: palm, text: () => `show: ${["one", "two", "three"][Math.min(stRef.k ?? 0, 2)]}`, kind: "brain", dynamic: true });
  const stRef = {};
  return {
    labels,
    camera: { az: 30, el: 12, ...fitTo(v, [[-0.12, 0, -0.08], [0.12, 0.33, 0.12]], 0.85) },
    update(st) {
      stRef.k = st.k;
      setHand(rig, st.curl);
    },
  };
}

function spider(v, rig, m, s) {
  const labels = [{ node: rig.joints.leg1_coxa.node, text: "tripod A (1·3·5)", kind: "actuator" }, { node: rig.joints.leg2_coxa.node, text: "tripod B (2·4·6)", kind: "sensor" }];
  const pts = [[-0.3, 0, -0.3], [0.3, 0.2, 0.3]];
  if (s.level !== "rotate") {
    v.addProp(floorLine([[-0.25, s.goalZ], [0.25, s.goalZ]], PALETTE.ink));
    const fin = v.addProp(new THREE.Object3D());
    fin.position.set(0.25, 0, s.goalZ);
    labels.push({ node: fin, text: `${Math.round(s.goalZ * 100)} cm`, kind: "brain" });
    pts.push([0, 0, s.goalZ + 0.25]);
  } else {
    const a = v.addProp(floorArrow(0.3, PALETTE.accent));
    a.rotation.y = s.goal;
    a.position.set(Math.sin(s.goal) * 0.32, 0, Math.cos(s.goal) * 0.32);
    labels.push({ node: a, text: "face this way", kind: "brain" });
  }
  return {
    labels,
    camera: { az: 35, el: 38, ...fitTo(v, pts, 0.95) },
    update(st) {
      setSpider(rig, { liftA: st.liftA, liftB: st.liftB, swing: st.swing });
      rig.group.position.set(st.x, 0, st.z);
      rig.group.rotation.y = st.heading;
    },
  };
}

function fab(v, rig, m, s) {
  const { bed, gantry, head } = rig.slides;
  const base = { bed: bed.position.clone(), gantry: gantry.position.clone(), head: head.position.clone() };
  const labels = [{ node: head, text: "toolhead (X)", kind: "actuator" }, { node: bed, text: "bed (Y)", kind: "actuator" }, { node: gantry, text: "gantry (Z)", kind: "sensor" }];
  const attached = [];
  const mm = (x, y) => new THREE.Vector3((x - 110) / 1000, 0.0055, -(y - 110) / 1000);
  if (s.sq) {
    const q = s.sq;
    const pts = [[q.x, q.y], [q.x + q.side, q.y], [q.x + q.side, q.y + q.side], [q.x, q.y + q.side], [q.x, q.y]].map(([x, y]) => mm(x, y));
    const outline = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineDashedMaterial({ color: PALETTE.ink, dashSize: 0.003, gapSize: 0.002 }));
    outline.computeLineDistances();
    bed.add(outline);
    const corner = sphere(0.003, "sky");
    corner.position.copy(mm(q.x, q.y));
    bed.add(corner);
    attached.push(outline, corner);
    labels.push({ node: corner, text: "start corner", kind: "brain" });
  }
  const printed = new THREE.Group();
  bed.add(printed);
  attached.push(printed);
  v.fxGroup.userData.attached = (v.fxGroup.userData.attached || []).concat(attached);
  let drawn = -1;
  return {
    labels,
    camera: { az: 30, el: 42, ...fitTo(v, [[-0.2, 0, -0.2], [0.2, 0.35, 0.2]], 0.95) },
    update(st) {
      head.position.x = base.head.x + (st.x - 110) / 1000;
      bed.position.z = base.bed.z + (st.y - 110) / 1000;
      // Z: 1 mm on the printer = 1 mm in the model above a gantry height where the nozzle touches the bed
      gantry.position.y = 0.1285 + Math.max(0, st.z) / 1000 * 4 + Math.min(st.z, 0) / 1000;
      const key = st.path.length * 100000 + (st.path.length ? Math.round(st.path[st.path.length - 1].x1 * 10 + st.path[st.path.length - 1].y1 * 1000) : 0);
      if (key !== drawn) {
        drawn = key;
        printed.clear();
        for (const p of st.path) {
          const g = new THREE.BufferGeometry().setFromPoints([mm(p.x0, p.y0), mm(p.x1, p.y1)]);
          printed.add(new THREE.Line(g, new THREE.LineBasicMaterial({ color: p.good ? PALETTE.accent : PALETTE.sun })));
        }
      }
    },
  };
}

function biped(v, rig, m, s, kind) {
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
  const c = { rig, com, shadow, sup, geo: m.geometry, body: null };
  return {
    labels: [
      { node: com, text: "centre of mass", kind: "brain" },
      { node: sup, text: () => (c.body?.margin >= 0 ? "support polygon" : "COM outside: falling"), kind: "sensor", dynamic: true },
    ],
    camera: { az: 35, el: 14, ...fitTo(v, [[-0.15, 0, -0.12], [0.15, kind === "walker" ? 0.4 : 0.42, 0.15]], 1.0) },
    update(st) {
      poser(st.pose);
      if (st.done && !st.success) rig.group.rotation.x += 0.35 * Math.sign(st.body.com.x || 1);
      placeComMarkers(c, st.pose);
    },
  };
}

function desk(v, rig, m, s) {
  const labels = [];
  const head = rig.head || rig.phone;
  rig.group.updateMatrixWorld(true);
  const eye = head.getWorldPosition(new THREE.Vector3());
  const dir = (az, el) => new THREE.Vector3(Math.cos(el * RAD) * Math.sin(az * RAD), Math.sin(el * RAD), Math.cos(el * RAD) * Math.cos(az * RAD));
  const R = 0.45;
  const framed = [[-0.15, 0, -0.15], [0.15, 0.42, 0.15]]; // the robot, then each target and object
  const frame = (p) => framed.push(p.clone().addScalar(0.05), p.clone().addScalar(-0.05));
  if (s.target) {
    const t = v.addProp(sphere(0.018, "sky"));
    t.position.copy(eye).addScaledVector(dir(s.target.az, s.target.el), R);
    frame(t.position);
    labels.push({ node: t, text: "look here", kind: "sensor" });
  }
  if (s.objects) {
    const sh = rig.joints.r_shoulder.node.getWorldPosition(new THREE.Vector3());
    s.order.forEach((objIdx, n) => {
      const o = s.objects[objIdx];
      const b = v.addProp(rbox(0.035, 0.035, 0.035, ["sun", "sage", "sky"][objIdx], 0.006));
      b.position.copy(sh).addScaledVector(dir(o.az, o.el), R);
      frame(b.position);
      labels.push({ node: b, text: `${n + 1}`, kind: "brain" });
    });
  }
  // gaze and pointing rays
  const rayMat = new THREE.LineBasicMaterial({ color: PALETTE.sky, transparent: true, opacity: 0.8 });
  const gaze = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(0, 0, R)]), rayMat);
  const pointRay = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(0, 0, R)]), new THREE.LineBasicMaterial({ color: PALETTE.accent }));
  v.fxGroup.add(gaze, pointRay);
  pointRay.visible = s.level === "point";
  return {
    labels,
    camera: { az: 45, el: 32, ...fitTo(v, framed, 0.85) }, // the robot and its targets, not a fixed 1 m box
    update(st) {
      setDesk(rig, st.j);
      rig.group.updateMatrixWorld(true);
      const g = gazeOf(st.j), p = pointOf(st.j);
      gaze.position.copy(head.getWorldPosition(new THREE.Vector3()));
      gaze.lookAt(gaze.position.clone().add(dir(g.az, g.el)));
      pointRay.position.copy(rig.joints.r_shoulder.node.getWorldPosition(new THREE.Vector3()));
      pointRay.lookAt(pointRay.position.clone().add(dir(p.az, p.el)));
      rig.face?.setLook(st.j.pan / 60, -st.j.tilt / 40);
    },
  };
}

export function makeTestScene(id, v, rig, mission, state) {
  rig.home();
  rig.group.position.set(0, 0, 0);
  rig.group.rotation.set(0, 0, 0);
  rig.setExplode(0);
  const make = {
    so101: arm,
    rover: (a, b, c, d) => drive(a, b, c, d, { ax1: false }),
    "ax1-rover": (a, b, c, d) => drive(a, b, c, d, { ax1: true }),
    drone,
    hound,
    hand,
    spider,
    fab,
    replicant: (a, b, c, d) => biped(a, b, c, d, "replicant"),
    "ax1-walker": (a, b, c, d) => biped(a, b, c, d, "walker"),
    "ax1-desk": desk,
  }[id];
  const scene = make(v, rig, mission, state);
  scene.update(state);
  return scene;
}
void setRaw;
