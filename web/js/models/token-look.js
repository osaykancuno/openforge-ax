// How a token's robot looks, shared by the token art (art/token/token.html) and My IRL lab (web/ar.html, "bring your agent
// to life"): the class's robot, its Finish colours (gold for a Prime Construct), its Augment add-on and the token's own
// pose (Frame → how far the pose leaves home). Deterministic: same token id and traits, same robot.
// Part of the art: covered by the provenance hash (GENERATOR_FILES in art/token-render.mjs).
import * as THREE from "three";
import { mat } from "./look.js";
import { ROBOTS } from "./robots.js";

/** Class index → robot id: the ROBOTS catalogue carries each robot's on-chain class. */
export const CLASS_ROBOT = Object.fromEntries(Object.entries(ROBOTS).filter(([, r]) => r.cls !== null).map(([id, r]) => [r.cls, id]));
/** Finish index (as in art/traits.mjs) → shell and trim colours. */
export const FINISH = [
  { shell: 0x3a3733, trim: 0xb9b5ad }, // Blacksteel
  { shell: 0xf8f6f1, trim: 0x8f877b }, // Ghost White
  { shell: 0xefeae0, trim: 0xd9772b }, // Hazard Orange
  { shell: 0xe4e9ee, trim: 0x3f6f9e }, // Ice Cobalt
  { shell: 0xefeae0, trim: 0x4f8a5e }, // Toxic Green
  { shell: 0xefeae0, trim: 0xa8322a }, // Blood Red
  { shell: 0xd6dae0, trim: 0x8a6a9e, metal: true }, // Holo Chrome
];
export const GOLD = { shell: 0xe8d7a2, trim: 0xb8902f, metal: true }; // 24K Circuit (Prime Constructs)

/** The token's random source: a small integer hash, seeded by the token id. */
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Swaps the rig's shell and trim plastics for the finish's (shared, cached materials). */
export function paint(group, f) {
  const opts = f.metal ? { metalness: 0.6, roughness: 0.32 } : {};
  const shell = mat(f.shell, opts), trim = mat(f.trim, opts);
  const from = new Map([[mat("shell"), shell], [mat("accent"), trim]]);
  group.traverse((o) => {
    if (o.isMesh && from.has(o.material)) o.material = from.get(o.material);
  });
}

/**
 * The highest point of the posed robot (world space) and the mesh it belongs to: antennas and halos sit on the robot,
 * not on its bounding box, and ride on that part when the robot moves.
 */
export function topPoint(group) {
  const best = new THREE.Vector3(0, -Infinity, 0);
  let mesh = null;
  const v = new THREE.Vector3();
  group.traverse((o) => {
    if (!o.isMesh || !o.geometry.attributes.position) return;
    const pos = o.geometry.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld);
      if (v.y > best.y) best.copy(v), (mesh = o);
    }
  });
  return { point: best, mesh };
}

/** A small add-on placed from the posed robot (world space). kind = Augment index, or "crown" for a Prime Construct. */
export function augment(kind, box, trim, peak) {
  const g = new THREE.Group();
  const size = box.getSize(new THREE.Vector3());
  const c = box.getCenter(new THREE.Vector3());
  const s = Math.max(size.x, size.y, size.z);
  const top = peak.y;
  const add = (geo, material, x, y, z) => {
    const m = new THREE.Mesh(geo, material);
    m.position.set(x, y, z);
    m.castShadow = true;
    g.add(m);
    return m;
  };
  if (kind === 1) { // Antenna Array
    for (const [dx, h] of [[-0.12, 0.22], [0, 0.3], [0.12, 0.18]]) {
      add(new THREE.CylinderGeometry(s * 0.006, s * 0.006, s * h, 8), mat("graphite"), peak.x + dx * s * 0.4, top + (s * h) / 2 - s * 0.01, peak.z);
      add(new THREE.SphereGeometry(s * 0.018, 14, 10), mat(trim), peak.x + dx * s * 0.4, top + s * h - s * 0.01, peak.z);
    }
  } else if (kind === 2 || kind === "crown") { // Holo Halo, or the Prime Construct crown
    const ring = add(new THREE.TorusGeometry(s * 0.2, s * 0.012, 10, 48), kind === "crown" ? mat(GOLD.trim, { metalness: 0.7, roughness: 0.3 }) : new THREE.MeshBasicMaterial({ color: 0x7fb6e0, transparent: true, opacity: 0.75 }), peak.x, top + s * 0.1, peak.z);
    ring.rotation.x = Math.PI / 2;
    if (kind === "crown") for (let k = 0; k < 6; k++) {
      const a = (k / 6) * Math.PI * 2;
      add(new THREE.SphereGeometry(s * 0.022, 14, 10), mat(GOLD.trim, { metalness: 0.7, roughness: 0.3 }), peak.x + Math.cos(a) * s * 0.2, top + s * 0.13, peak.z + Math.sin(a) * s * 0.2);
    }
  } else if (kind === 3) { // Cable Spine
    const curve = new THREE.CatmullRomCurve3([
      new THREE.Vector3(c.x - size.x * 0.25, top - size.y * 0.1, box.min.z - s * 0.02),
      new THREE.Vector3(c.x, c.y + size.y * 0.1, box.min.z - s * 0.06),
      new THREE.Vector3(c.x + size.x * 0.2, box.min.y + size.y * 0.25, box.min.z - s * 0.02),
    ]);
    add(new THREE.TubeGeometry(curve, 48, s * 0.012, 8), mat(trim), 0, 0, 0);
  } else if (kind === 4) { // Visor Band
    const band = add(new THREE.TorusGeometry(Math.max(size.x, size.z) * 0.56, s * 0.012, 8, 64), new THREE.MeshBasicMaterial({ color: 0x2f5f8a, transparent: true, opacity: 0.8 }), c.x, box.min.y + size.y * 0.78, c.z);
    band.rotation.x = Math.PI / 2;
  } else if (kind === 5) { // Exhaust Vents
    for (const dx of [-0.08, 0.08]) {
      const v = add(new THREE.CylinderGeometry(s * 0.03, s * 0.036, s * 0.09, 18), mat("alu"), c.x + dx * s, box.min.y + size.y * 0.55, box.min.z - s * 0.04);
      v.rotation.x = Math.PI / 2;
    }
  }
  return g;
}

/**
 * Dresses a freshly built robot (`buildRobot(CLASS_ROBOT[t.class])`) as token `id`: its pose, finish and add-on, and
 * turns it to the token's side. `pose: false` keeps the joints at home (a twin that the drive loop moves).
 * Returns { r, look0, prime, kind } — r is the token's random source, to hand on to createMotion (motion.mjs) next.
 * @param {*} rig  a rig from robots.js; its group should already sit in the scene (world matrices are read)
 * @param {{ id: number, t: { class: number, finish: number, augment: number, frame: number, legendary: number } }} token
 */
export function dressToken(rig, { id, t }, { pose = true } = {}) {
  const prime = t.legendary > 0;
  const r = rng(id * 2654435761);
  rig.home();
  const reach = pose ? 0.06 * t.frame : 0; // Mk-I stands at home; each later frame leaves home a little more
  for (const [name, j] of Object.entries(rig.joints)) rig.set(name, j.home + (r() - 0.5) * reach * (j.max - j.min));
  const look0 = [r() * 1.2 - 0.6, r() * 0.4 - 0.1];
  paint(rig.group, prime ? GOLD : FINISH[t.finish]);
  const side = r() < 0.5 ? -1 : 1;
  rig.group.rotation.y = side * (0.35 + r() * 0.45);
  rig.group.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(rig.group);
  const kind = prime ? "crown" : t.augment;
  const top = topPoint(rig.group);
  const aug = augment(kind, box, (prime ? GOLD : FINISH[t.finish]).trim, top.point);
  rig.group.parent?.add(aug);
  // add-ons move with the robot: antennas are mounted on the part they stand on; the floating halo and crown, and the
  // rest, go with the body (a halo on a finger or a propeller would tumble with it)
  (kind === 1 && top.mesh ? top.mesh : rig.group).attach(aug);
  return { r, look0, prime, kind };
}
