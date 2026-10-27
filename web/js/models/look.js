// The lab look, shared by every 3D view: palette, materials, lights and the paper floor.
// Pure three.js, no DOM except an optional canvas texture. Colours mirror the CSS tokens in css/style.css.
import * as THREE from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";

export const PALETTE = {
  paper: 0xf4efe6,
  paper2: 0xebe4d6,
  ink: 0x23211e,
  line: 0xd8cfbf,
  accent: 0xc8553d,
  sage: 0x5f8a6e,
  sky: 0x4f7ea8,
  sun: 0xe2b04a,
  plum: 0x8a6a9e,
  shell: 0xefeae0, // warm white plastic
  graphite: 0x34312d, // dark plastic
  servo: 0x1f1e1c, // servo cases
  alu: 0xb9b5ad, // brushed aluminium
  rubber: 0x2a2826,
  pcb: 0x3f7d5a,
  copper: 0xc98a4b,
  glass: 0x15171a,
};

const cache = new Map();
const sharedMats = new WeakSet(); // owned by the caches below: never disposed with a rig
const sharedGeos = new WeakSet();
/** Shared material by name (or hex): matte plastics by default, metal for "alu" and "copper". */
export function mat(name, opts = {}) {
  const key = `${name}|${JSON.stringify(opts)}`;
  if (cache.has(key)) return cache.get(key);
  const color = typeof name === "number" ? name : PALETTE[name] ?? 0xff00ff;
  const metal = name === "alu" || name === "copper";
  const m = new THREE.MeshStandardMaterial({
    color,
    roughness: metal ? 0.38 : name === "glass" ? 0.12 : 0.62,
    metalness: metal ? 0.75 : name === "glass" ? 0.2 : 0.02,
    ...opts,
  });
  cache.set(key, m);
  sharedMats.add(m);
  return m;
}

const geoCache = new Map();
function geo(key, make) {
  if (!geoCache.has(key)) {
    const g = make();
    geoCache.set(key, g);
    sharedGeos.add(g);
  }
  return geoCache.get(key);
}

/**
 * Frees the GPU memory an object owns once it leaves the scene: its own geometries, materials and their textures
 * (a robot's outline material, its phone-face canvas). Cached geometries and materials, and geometries flagged
 * userData.shared, are kept for the next robot. Safe on anything: a disposed item is re-uploaded if it is drawn again.
 */
export function disposeObject(root) {
  root?.traverse?.((o) => {
    if (o.geometry && !sharedGeos.has(o.geometry) && !o.geometry.userData?.shared) o.geometry.dispose();
    for (const m of [].concat(o.material || [])) {
      if (sharedMats.has(m)) continue;
      for (const v of Object.values(m)) if (v && v.isTexture) v.dispose();
      m.dispose();
    }
  });
}

/** Rounded box mesh, centred. r = corner radius (clamped to the smallest half-size). */
export function rbox(w, h, d, material, r = 0.02) {
  const rr = Math.min(r, w / 2 - 1e-4, h / 2 - 1e-4, d / 2 - 1e-4);
  const g = geo(`rb${w}|${h}|${d}|${rr}`, () => new RoundedBoxGeometry(w, h, d, 3, Math.max(0.0005, rr)));
  return shadowed(new THREE.Mesh(g, typeof material === "string" || typeof material === "number" ? mat(material) : material));
}

/** Cylinder along Y, centred. */
export function cyl(rTop, rBottom, h, material, seg = 32) {
  const g = geo(`cy${rTop}|${rBottom}|${h}|${seg}`, () => new THREE.CylinderGeometry(rTop, rBottom, h, seg));
  return shadowed(new THREE.Mesh(g, typeof material === "string" || typeof material === "number" ? mat(material) : material));
}

export function sphere(r, material, seg = 24) {
  const g = geo(`sp${r}|${seg}`, () => new THREE.SphereGeometry(r, seg, Math.round(seg * 0.75)));
  return shadowed(new THREE.Mesh(g, typeof material === "string" || typeof material === "number" ? mat(material) : material));
}

export function torus(r, tube, material, arc = Math.PI * 2) {
  const g = geo(`to${r}|${tube}|${arc}`, () => new THREE.TorusGeometry(r, tube, 12, 48, arc));
  return shadowed(new THREE.Mesh(g, typeof material === "string" || typeof material === "number" ? mat(material) : material));
}

function shadowed(m) {
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

/** Place an object: at(obj, x, y, z, parent?) returns obj. */
export function at(obj, x = 0, y = 0, z = 0, parent) {
  obj.position.set(x, y, z);
  parent?.add(obj);
  return obj;
}

/** Renderer with the lab settings (soft shadows, ACES, sRGB). */
export function makeRenderer(canvas, { alpha = false } = {}) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha, powerPreference: "high-performance" });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  return renderer;
}

// ---------------------------------------------------------------- theme: light paper by default, dark when the visitor picks it
// (web/js/theme.js sets <html data-theme="dark"> and fires "ofx-theme"). Only the room changes colour: the robots don't.
const DARK_ROOM = { [PALETTE.paper]: 0x1c1a17, [PALETTE.paper2]: 0x26231f, [PALETTE.line]: 0x3d3933 };
export const isDarkTheme = () => typeof document !== "undefined" && document.documentElement.dataset.theme === "dark";
/** A room colour (paper, paper2, line) as the current theme shows it; any other colour is returned unchanged. */
export const themed = (hex) => (isDarkTheme() && Object.hasOwn(DARK_ROOM, hex) ? DARK_ROOM[hex] : hex);
/** Calls fn() each time the visitor switches theme; returns the unsubscribe. No-op outside a browser (brand and token renders stay light). */
export function onThemeChange(fn) {
  if (typeof window === "undefined") return () => {};
  window.addEventListener("ofx-theme", fn);
  return () => window.removeEventListener("ofx-theme", fn);
}

/** Daylight studio: environment reflections, a soft key light with shadows, a cool fill. Background and floor follow the theme. */
export function makeStage(scene, renderer, { size = 6, floor = true, background = PALETTE.paper } = {}) {
  const paint = () => {
    scene.background = background === null ? null : new THREE.Color(themed(background));
    if (ground) ground.material.color.setHex(themed(PALETTE.paper2));
  };
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(renderer), 0.04).texture;
  scene.environmentIntensity = 0.55; // ignored before r163; harmless
  pmrem.dispose();

  const hemi = new THREE.HemisphereLight(0xfffaf0, 0xd9cdb8, 0.9);
  scene.add(hemi);
  const key = new THREE.DirectionalLight(0xfff4e2, 2.1);
  key.position.set(size * 0.6, size * 1.4, size * 0.9);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.bias = -0.0004;
  key.shadow.normalBias = 0.02;
  key.shadow.radius = 6;
  const c = key.shadow.camera;
  c.left = c.bottom = -size;
  c.right = c.top = size;
  c.near = 0.1;
  c.far = size * 5;
  scene.add(key);
  const fill = new THREE.DirectionalLight(0xdfe8ff, 0.45);
  fill.position.set(-size, size * 0.6, -size * 0.4);
  scene.add(fill);

  let ground = null;
  if (floor) {
    ground = new THREE.Mesh(new THREE.PlaneGeometry(size * 8, size * 8), new THREE.MeshStandardMaterial({ color: PALETTE.paper2, roughness: 0.95 }));
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    scene.add(ground);
  }
  paint();
  onThemeChange(paint);
  return { key, fill, hemi, ground };
}

/** Thin ink outline around a group (lab-plate look). Skips tiny meshes. */
export function inkOutline(group, { color = PALETTE.ink, opacity = 0.35, minSize = 0.02 } = {}) {
  const line = new THREE.LineBasicMaterial({ color, transparent: true, opacity });
  const box = new THREE.Box3();
  const v = new THREE.Vector3();
  group.traverse((o) => {
    if (!o.isMesh || o.userData.noOutline) return;
    o.geometry.computeBoundingBox();
    box.copy(o.geometry.boundingBox).getSize(v);
    if (Math.max(v.x, v.y, v.z) < minSize) return;
    const key = `edge|${o.geometry.uuid}`;
    const eg = geo(key, () => new THREE.EdgesGeometry(o.geometry, 40));
    const l = new THREE.LineSegments(eg, line);
    l.userData.noOutline = true;
    l.raycast = () => {};
    o.add(l);
  });
}

/** A phone: rounded slab, dark screen (optionally a live canvas face), camera bump on the back. */
export function phone({ w = 0.075, h = 0.155, d = 0.009, face = null, landscape = false } = {}) {
  if (landscape) [w, h] = [h, w];
  const g = new THREE.Group();
  g.name = "phone";
  at(rbox(w, h, d, "graphite", 0.008), 0, 0, 0, g);
  const screenMat = face ? new THREE.MeshBasicMaterial({ map: face, toneMapped: false }) : mat("glass");
  const screen = at(new THREE.Mesh(geo(`scr${w}|${h}`, () => new THREE.PlaneGeometry(w * 0.9, h * 0.93)), screenMat), 0, 0, d / 2 + 0.0004, g);
  screen.name = "screen";
  const bs = Math.min(w, h) * 0.5; // camera island, top-left of the back
  const bx = -w / 2 + bs * 0.65, by = h / 2 - bs * 0.65;
  at(rbox(bs, bs, 0.003, "graphite", 0.006), bx, by, -d / 2 - 0.0015, g);
  for (const [x, y] of [[-0.22, 0.22], [0.22, 0.22], [-0.22, -0.22]]) {
    const lens = at(cyl(bs * 0.17, bs * 0.17, 0.003, "glass", 20), bx + x * bs, by + y * bs, -d / 2 - 0.003, g);
    lens.rotation.x = Math.PI / 2;
  }
  return g;
}

/**
 * Animated robot face for a phone screen: two eyes that blink and look around.
 * Returns { texture, setLook(x, y), setMood(name), tick(t) }. Needs a DOM (OffscreenCanvas if available).
 */
export function phoneFace({ w = 256, h = 512 } = {}) {
  const canvas = typeof OffscreenCanvas !== "undefined" ? new OffscreenCanvas(w, h) : Object.assign(document.createElement("canvas"), { width: w, height: h });
  const ctx = canvas.getContext("2d");
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  let look = [0, 0];
  let mood = "idle";
  let last = -1;
  function draw(t) {
    ctx.fillStyle = "#1b1a18";
    ctx.fillRect(0, 0, w, h);
    // same geometry as the AX-1 mark (art/brand/src/mark.mjs): eyes 0.24·w apart, mouth under them
    const blink = (t % 4.2) > 4.05 ? 0.12 : 1;
    const happy = mood === "happy";
    const u = Math.min(w, h * 1.6); // face unit: works for landscape and portrait screens
    const cx = w / 2 + look[0] * u * 0.06;
    const cy = h * 0.44 + look[1] * h * 0.07;
    ctx.fillStyle = mood === "alert" ? "#e2b04a" : "#f4efe6";
    for (const s of [-1, 1]) {
      const ex = cx + s * u * 0.12;
      ctx.beginPath();
      if (happy) {
        ctx.lineWidth = u * 0.035;
        ctx.lineCap = "round";
        ctx.strokeStyle = ctx.fillStyle;
        ctx.arc(ex, cy + u * 0.04, u * 0.06, Math.PI * 1.15, Math.PI * 1.85);
        ctx.stroke();
      } else {
        ctx.ellipse(ex, cy, u * 0.05, u * 0.068 * blink, 0, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.fillStyle = "#c8553d";
    const mw = u * 0.11, mh = u * 0.032;
    ctx.beginPath();
    ctx.roundRect ? ctx.roundRect(w / 2 - mw / 2, h * 0.7, mw, mh, mh / 2) : ctx.rect(w / 2 - mw / 2, h * 0.7, mw, mh);
    ctx.fill();
    texture.needsUpdate = true;
  }
  draw(0);
  return {
    texture,
    setLook(x, y) {
      look = [Math.max(-1, Math.min(1, x)), Math.max(-1, Math.min(1, y))];
    },
    setMood(m) {
      mood = m;
    },
    tick(t) {
      const frame = Math.floor(t * 20); // 20 fps is plenty for a face
      if (frame !== last) (last = frame), draw(t);
    },
  };
}
