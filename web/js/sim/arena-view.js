// Three.js view of the arm sim (lab-notebook look: paper, soft daylight, the shared SO-101 model).
// Rendering only: all physics lives in arm-sim.js. Used by the Proving Grounds and by the Robot Link twin.
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { LINKS, CELL, DOCK_RADIUS } from "./arm-sim.js";
import { PALETTE, makeStage, inkOutline, onThemeChange, themed } from "../models/look.js";
import { buildRobot } from "../models/robots.js";

const RAD = Math.PI / 180;
const TABLE_R = 0.42;
const TABLE_H = 0.018;

// sim (x, y, z-up) -> three (x, z-up as y, -y)
const toThree = (p) => new THREE.Vector3(p.x, p.z, -p.y);

/** Notebook grid on the tabletop (canvas texture, decorative). */
function tableTexture() {
  const c = Object.assign(document.createElement("canvas"), { width: 1024, height: 1024 });
  const g = c.getContext("2d");
  g.fillStyle = "#fbf8f2";
  g.fillRect(0, 0, 1024, 1024);
  const cm = 1024 / (TABLE_R * 2 * 100); // pixels per centimetre
  for (let i = 0, x = 512 % cm; x < 1024; x += cm, i++) {
    g.strokeStyle = i % 5 === 0 ? "rgba(35,33,30,0.16)" : "rgba(35,33,30,0.07)";
    g.lineWidth = i % 5 === 0 ? 2 : 1;
    g.beginPath(), g.moveTo(x, 0), g.lineTo(x, 1024), g.stroke();
    g.beginPath(), g.moveTo(0, x), g.lineTo(1024, x), g.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

/**
 * The shared SO-101 model, with its hand pivot moved so the fixed finger ends exactly LINKS.hand past the wrist
 * (the model's hand is 1 cm longer than the sim's): the model's fingertip then coincides with fk().tip.
 */
function simArm() {
  const rig = buildRobot("so101");
  const roll = rig.joints.wrist_roll.node;
  roll.position.y = LINKS.hand - 0.11; // fixed finger tip sits 0.11 m above the roll pivot in the model
  rig.setExplode(0);
  inkOutline(rig.group, { opacity: 0.22 });
  return rig;
}

/** preserveDrawingBuffer lets web/js/recorder.js copy the canvas at any moment (clip and film recording). */
export function createArenaView(canvas, { preserveDrawingBuffer = false } = {}) {
  // same settings as makeRenderer() in models/look.js, plus preserveDrawingBuffer for the recorder
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer, powerPreference: "high-performance" });
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  const scene = new THREE.Scene();
  const { key, ground } = makeStage(scene, renderer, { size: 0.6, background: PALETTE.paper });
  key.shadow.mapSize.set(1024, 1024);
  ground.position.y = -TABLE_H - 0.004; // paper floor just under the tabletop
  const paintRoom = () => ground.material.color.setHex(themed(PALETTE.paper)); // paper floor; the lit table stays light
  paintRoom();
  onThemeChange(paintRoom);

  const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 10);
  camera.position.set(0.32, 0.46, 0.62);
  const controls = new OrbitControls(camera, canvas);
  controls.target.set(0.1, 0.06, 0);
  controls.enableDamping = true;
  controls.maxPolarAngle = Math.PI * 0.49;
  controls.minDistance = 0.25;
  controls.maxDistance = 1.4;

  // table: a round notebook-grid top (z = 0 in the sim) with an ink rim
  const table = new THREE.Mesh(
    new THREE.CylinderGeometry(TABLE_R, TABLE_R, TABLE_H, 96),
    [
      new THREE.MeshStandardMaterial({ color: PALETTE.paper2, roughness: 0.9 }),
      new THREE.MeshStandardMaterial({ map: tableTexture(), roughness: 0.92 }),
      new THREE.MeshStandardMaterial({ color: PALETTE.paper2, roughness: 0.9 }),
    ]
  );
  table.position.y = -TABLE_H / 2;
  table.receiveShadow = true;
  scene.add(table);
  const rim = new THREE.Mesh(new THREE.RingGeometry(TABLE_R - 0.004, TABLE_R, 96), new THREE.MeshBasicMaterial({ color: PALETTE.ink, side: THREE.DoubleSide }));
  rim.rotation.x = -Math.PI / 2;
  rim.position.y = 0.0006;
  scene.add(rim);

  // dock: a sage target printed on the table
  const dock = new THREE.Group();
  const dockRing = new THREE.Mesh(new THREE.RingGeometry(DOCK_RADIUS - 0.003, DOCK_RADIUS, 48), new THREE.MeshBasicMaterial({ color: PALETTE.sage, side: THREE.DoubleSide }));
  dockRing.rotation.x = -Math.PI / 2;
  const dockPad = new THREE.Mesh(new THREE.CircleGeometry(DOCK_RADIUS, 48), new THREE.MeshBasicMaterial({ color: PALETTE.sage, transparent: true, opacity: 0.18 }));
  dockPad.rotation.x = -Math.PI / 2;
  const cross = new THREE.Mesh(new THREE.RingGeometry(0.002, 0.0035, 24), new THREE.MeshBasicMaterial({ color: PALETTE.sage, side: THREE.DoubleSide }));
  cross.rotation.x = -Math.PI / 2;
  dock.add(dockRing, dockPad, cross);
  dock.position.y = 0.0012;
  scene.add(dock);

  // the cell: a sun-yellow block with an ink outline; terracotta while held
  const cellGeo = new THREE.BoxGeometry(CELL, CELL, CELL);
  const cellMat = new THREE.MeshStandardMaterial({ color: PALETTE.sun, roughness: 0.55 });
  const cell = new THREE.Mesh(cellGeo, cellMat);
  cell.castShadow = true;
  cell.add(new THREE.LineSegments(new THREE.EdgesGeometry(cellGeo), new THREE.LineBasicMaterial({ color: PALETTE.ink, transparent: true, opacity: 0.55 })));
  scene.add(cell);

  // arm: the shared SO-101 model, same joint conventions as fk() in arm-sim.js (0 = straight up, + tilts outward)
  const rig = simArm();
  scene.add(rig.group);
  const JOINT_NAMES = ["shoulder_pan", "shoulder_lift", "elbow_flex", "wrist_flex", "wrist_roll", "gripper"];

  function resize() {
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (canvas.width !== Math.floor(w * renderer.getPixelRatio()) || canvas.height !== Math.floor(h * renderer.getPixelRatio())) {
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      frame();
    }
  }

  // the arm's workspace (reach, dock and cell) fills the plate whatever its shape: the camera keeps its angle and
  // moves to the distance where a sphere of WORK_R around the target just fits the narrower field of view; after the
  // visitor zooms, a resize keeps their zoom relative to that fit instead of snapping back
  const WORK_R = 0.24;
  let lastFit = 0;
  function frame() {
    const vfov = THREE.MathUtils.degToRad(camera.fov);
    const hfov = 2 * Math.atan(Math.tan(vfov / 2) * camera.aspect);
    const fit = WORK_R / Math.sin(Math.min(vfov, hfov) / 2);
    const now = camera.position.distanceTo(controls.target);
    const d = THREE.MathUtils.clamp(lastFit ? fit * (now / lastFit) : fit, controls.minDistance, controls.maxDistance);
    lastFit = fit;
    camera.position.sub(controls.target).setLength(d).add(controls.target);
  }

  function update(state) {
    const j = state.joints;
    // the rig clamps to its own limits, which equal LIMITS in arm-sim.js
    JOINT_NAMES.forEach((name, i) => rig.set(name, j[i]));
    // wrist_roll: the sim turns about +Y like the model; gripper: 0 closed .. 100 open on both
    cell.position.copy(toThree(state.cell));
    cellMat.color.setHex(state.cell.mode === "held" ? PALETTE.accent : PALETTE.sun);
    dock.position.set(state.dock.x, 0.0012, -state.dock.y);
    dockPad.material.opacity = state.success ? 0.55 : 0.18;
  }

  let raf;
  let paused = false; // hidden (the Proving Grounds lab trials are shown): no GPU work
  (function loop() {
    if (!paused) {
      resize();
      controls.update();
      renderer.render(scene, camera);
    }
    raf = requestAnimationFrame(loop);
  })();

  return { update, setPaused: (p) => (paused = !!p), dispose: () => cancelAnimationFrame(raf) };
}
