// Workbench 3D plate: one robot on warm paper, an orthographic isometric camera, DOM callout labels projected from 3D,
// tweens, effects (signal path, arrows, treadmill), an optional phone-camera inset. Renders on demand (≤ 60 fps).
import * as THREE from "three";
import { makeRenderer, makeStage, inkOutline, disposeObject, PALETTE, onThemeChange } from "../models/look.js";
import { buildRobot, bounds } from "../models/robots.js";

const RAD = Math.PI / 180;
export const ease = {
  inOut: (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
  out: (t) => 1 - Math.pow(1 - t, 3),
  linear: (t) => t,
};
const cssColor = (name, fallback) => {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  try {
    return v ? new THREE.Color(v) : new THREE.Color(fallback);
  } catch {
    return new THREE.Color(fallback);
  }
};

export { hasWebGL } from "./shared.js";

export function createBenchView(canvas, labelLayer, { reduced = false } = {}) {
  const small = matchMedia("(max-width: 760px)").matches;
  const renderer = makeRenderer(canvas);
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, small ? 1.5 : 2));
  const scene = new THREE.Scene();
  const stage = makeStage(scene, renderer, { size: 2 });
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.01, 60);
  const world = new THREE.Group(); // robot + props
  scene.add(world);
  const fxGroup = new THREE.Group();
  scene.add(fxGroup);

  // ---------------------------------------------------------------- camera: az/el/size/target, tweened
  const cam = { az: 35, el: 28, size: 0.4, tx: 0, ty: 0.12, tz: 0 };
  let aspect = 1;
  let viewW = 0, viewH = 0; // the canvas's size, read once per resize (not per frame)
  function placeCamera() {
    const d = 12;
    const az = cam.az * RAD, el = cam.el * RAD;
    const target = new THREE.Vector3(cam.tx, cam.ty, cam.tz);
    camera.position.set(target.x + d * Math.cos(el) * Math.sin(az), target.y + d * Math.sin(el), target.z + d * Math.cos(el) * Math.cos(az));
    camera.lookAt(target);
    const h = cam.size, w = h * aspect;
    camera.left = -w;
    camera.right = w;
    camera.top = h;
    camera.bottom = -h;
    camera.near = 0.01;
    camera.far = 40;
    camera.updateProjectionMatrix();
    // shadows follow the framing
    const k = stage.key, c = k.shadow.camera, ext = Math.max(0.4, cam.size * 1.6 * Math.max(1, aspect));
    k.position.set(target.x + ext * 0.7, target.y + ext * 2.2, target.z + ext * 1.1);
    k.target.position.copy(target);
    k.target.updateMatrixWorld();
    c.left = c.bottom = -ext;
    c.right = c.top = ext;
    c.far = ext * 6;
    c.updateProjectionMatrix();
  }
  function resize() {
    const w = canvas.clientWidth, h = canvas.clientHeight;
    viewW = w;
    viewH = h;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    aspect = w / h;
    sizesStale(); // a new plate size can reflow the labels (media queries, wrapping)
    // a framed scene keeps filling the plate when the plate changes shape (unless the visitor moved the camera)
    if (home.box && resetBtn.hidden) cam.size = home.size = fitSize(home.box, cam.az, cam.el, home.pad);
    placeCamera();
    invalidate();
  }
  const ro = new ResizeObserver(resize);
  ro.observe(canvas);

  // ---------------------------------------------------------------- tweens
  const anims = new Set();
  function animate(ms, fn, easing = ease.inOut) {
    if (reduced) ms = 0;
    return new Promise((resolve) => {
      const a = { t0: performance.now(), ms, fn, easing, resolve };
      anims.add(a);
      if (!ms) stepAnim(a, a.t0);
      wake();
    });
  }
  function stepAnim(a, now) {
    const k = a.ms ? Math.min(1, (now - a.t0) / a.ms) : 1;
    a.fn(a.easing(k));
    if (k >= 1) anims.delete(a), a.resolve();
  }
  const cancelAnims = () => {
    for (const a of anims) a.resolve();
    anims.clear();
  };
  /** Half-height of the orthographic view that shows the whole box from (az, el) on this plate's aspect, with a margin. */
  function fitSize(box, az, el, pad = 1.1) {
    const A = az * RAD, E = el * RAD;
    const fwd = new THREE.Vector3(-Math.cos(E) * Math.sin(A), -Math.sin(E), -Math.cos(E) * Math.cos(A));
    const right = new THREE.Vector3().crossVectors(fwd, new THREE.Vector3(0, 1, 0)).normalize();
    const up = new THREE.Vector3().crossVectors(right, fwd);
    const c = box.getCenter(new THREE.Vector3());
    let hw = 0, hh = 0;
    for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y]) for (const z of [box.min.z, box.max.z]) {
      const d = new THREE.Vector3(x, y, z).sub(c);
      hw = Math.max(hw, Math.abs(d.dot(right)));
      hh = Math.max(hh, Math.abs(d.dot(up)));
    }
    return Math.max(hh, hw / aspect, 0.02) * pad;
  }
  function moveCamera(to, ms = 900) {
    const from = { ...cam };
    const goal = { ...cam, ...to };
    if (to.box) goal.size = fitSize(to.box, goal.az, goal.el, to.pad); // fills the plate, whatever its shape
    home = { ...goal }; // the page's view: "Reset view" comes back here
    setChanged(false);
    // shortest way round in azimuth
    let daz = goal.az - from.az;
    daz = ((daz + 540) % 360) - 180;
    return animate(ms, (k) => {
      for (const key of ["el", "size", "tx", "ty", "tz"]) cam[key] = from[key] + (goal[key] - from[key]) * k;
      cam.az = from.az + daz * k;
      placeCamera();
    });
  }

  // ---------------------------------------------------------------- the visitor's camera: drag to turn, right-drag or
  // Shift-drag to pan, wheel or pinch to zoom, double-click (or "Reset view") to go back to the page's view
  const host = canvas.parentElement;
  let home = { ...cam };
  const tools = document.createElement("div");
  tools.className = "bn-viewtools";
  tools.setAttribute("role", "group");
  tools.setAttribute("aria-label", "3D view");
  const tool = (text, label, fn) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "btn sm";
    b.textContent = text;
    b.setAttribute("aria-label", label);
    b.title = label;
    b.onclick = fn;
    tools.append(b);
    return b;
  };
  tool("+", "Zoom in", () => zoomBy(1 / 1.25));
  tool("−", "Zoom out", () => zoomBy(1.25));
  const resetBtn = tool("Reset view", "Reset view", () => resetView());
  resetBtn.hidden = true;
  host.append(tools);
  // the plate takes focus on a click, so the mission's keys work while the visitor looks at the robot
  if (!host.hasAttribute("tabindex")) host.tabIndex = 0;
  host.setAttribute("role", "group");
  host.setAttribute("aria-label", "3D view. Drag to turn, right-drag or Shift-drag to move, wheel or pinch to zoom, double-click to reset. Mission keys work here.");
  function setChanged(on) {
    resetBtn.hidden = !on;
  }
  function userMoved() {
    placeCamera();
    invalidate();
    setChanged(true);
  }
  function zoomBy(f) {
    cam.size = Math.min(home.size * 3, Math.max(home.size * 0.25, cam.size * f));
    userMoved();
  }
  function orbitBy(dx, dy) {
    cam.az -= dx * 0.4;
    cam.el = Math.min(85, Math.max(2, cam.el + dy * 0.3));
    userMoved();
  }
  function panBy(dx, dy) {
    const perPx = (2 * cam.size) / Math.max(1, canvas.clientHeight); // orthographic: world units per pixel
    camera.updateMatrixWorld();
    const right = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0);
    const up = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 1);
    const d = right.multiplyScalar(-dx * perPx).add(up.multiplyScalar(dy * perPx));
    cam.tx += d.x;
    cam.ty += d.y;
    cam.tz += d.z;
    userMoved();
  }
  const resetView = () => moveCamera(home, 450);
  const pointers = new Map();
  let drag = null;
  canvas.addEventListener("pointerdown", (e) => {
    canvas.setPointerCapture?.(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    drag = { pan: e.button === 2 || e.shiftKey, x: e.clientX, y: e.clientY, pinch: 0 };
    host.focus({ preventScroll: true }); // the mission's keys work from the 3D view too
  });
  canvas.addEventListener("pointermove", (e) => {
    if (!pointers.has(e.pointerId) || !drag) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      if (drag.pinch) zoomBy(drag.pinch / dist);
      drag.pinch = dist;
      return;
    }
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    drag.x = e.clientX;
    drag.y = e.clientY;
    if (drag.pan) panBy(dx, dy);
    else orbitBy(dx, dy);
  });
  const release = (e) => {
    pointers.delete(e.pointerId);
    if (!pointers.size) drag = null;
    else if (drag) drag.pinch = 0;
  };
  canvas.addEventListener("pointerup", release);
  canvas.addEventListener("pointercancel", release);
  canvas.addEventListener("contextmenu", (e) => e.preventDefault()); // right-drag pans
  canvas.addEventListener("wheel", (e) => (e.preventDefault(), zoomBy(Math.exp(Math.max(-1, Math.min(1, e.deltaY * 0.0015))))), { passive: false });
  canvas.addEventListener("dblclick", () => resetView());

  // ---------------------------------------------------------------- robot
  let rig = null, fit = null;
  function setRobot(id) {
    clearProps();
    clearFx();
    if (rig) world.remove(rig.group), disposeObject(rig.group);
    rig = buildRobot(id);
    inkOutline(rig.group, { opacity: 0.22, minSize: 0.025 });
    world.add(rig.group);
    rig.home();
    rig.setExplode(0);
    const b = bounds(rig);
    const sph = b.getBoundingSphere(new THREE.Sphere());
    fit = { center: sph.center.clone(), radius: sph.radius, box: b };
    invalidate();
    return rig;
  }
  /** A camera view in "fit" units: size relative to the robot radius, target as fractions of the bounds. */
  function view(v = {}) {
    const f = fit || { center: new THREE.Vector3(0, 0.1, 0), radius: 0.2 };
    return {
      az: v.az ?? 35,
      el: v.el ?? 26,
      size: (v.zoom ?? 1) * f.radius * 1.02, // fallback before a robot is set
      tx: f.center.x + (v.dx ?? 0) * f.radius,
      ty: f.center.y + (v.dy ?? 0) * f.radius,
      tz: f.center.z + (v.dz ?? 0) * f.radius,
      // fit the robot's box to the plate's shape; zoom keeps its meaning (room for an exploded view, a close-up)
      ...(f.box ? { box: f.box, pad: Math.max(1.04, (v.zoom ?? 1) * 1.0) + Math.hypot(v.dx ?? 0, v.dy ?? 0) * 0.5 } : {}),
    };
  }

  // ---------------------------------------------------------------- props (mission/move objects) and effects
  const props = new THREE.Group();
  world.add(props);
  function addProp(obj) {
    props.add(obj);
    invalidate();
    return obj;
  }
  function clearProps() {
    for (const c of props.children.slice()) props.remove(c), dispose(c);
  }
  function clearFx() {
    for (const c of fxGroup.children.slice()) fxGroup.remove(c), dispose(c);
    signal = null;
  }
  function dispose(o) {
    disposeObject(o); // hoisted: clearProps/clearFx may run before this line
  }

  // signal path: sensor → brain → actuator, a dot travelling along a soft curve
  let signal = null;
  function showSignal(nodes) {
    clearFx();
    const pts = nodes.map((n) => n.getWorldPosition(new THREE.Vector3()));
    if (pts.length < 2) return;
    // lift the middle of each hop a little so the path reads as a flow, not a straight wire
    const ctrl = [];
    pts.forEach((p, i) => {
      ctrl.push(p.clone());
      if (i < pts.length - 1) ctrl.push(p.clone().lerp(pts[i + 1], 0.5).add(new THREE.Vector3(0, fit.radius * 0.35, 0)));
    });
    const curve = new THREE.CatmullRomCurve3(ctrl);
    const tube = new THREE.Mesh(new THREE.TubeGeometry(curve, 96, fit.radius * 0.012, 8), new THREE.MeshBasicMaterial({ color: PALETTE.ink, transparent: true, opacity: 0.35, depthTest: false }));
    tube.renderOrder = 5;
    const dotMat = new THREE.MeshBasicMaterial({ color: PALETTE.accent, depthTest: false });
    const dots = [0, 1, 2].map(() => {
      const d = new THREE.Mesh(new THREE.SphereGeometry(fit.radius * 0.035, 16, 12), dotMat);
      d.renderOrder = 6;
      fxGroup.add(d);
      return d;
    });
    const rings = pts.map((p) => {
      const r = new THREE.Mesh(new THREE.SphereGeometry(fit.radius * 0.05, 16, 12), new THREE.MeshBasicMaterial({ color: PALETTE.accent, transparent: true, opacity: 0.25, depthTest: false }));
      r.position.copy(p);
      r.renderOrder = 4;
      fxGroup.add(r);
      return r;
    });
    fxGroup.add(tube);
    signal = { curve, dots, rings };
    placeSignal(reduced ? 0.66 : 0);
    invalidate();
  }
  function placeSignal(t) {
    if (!signal) return;
    signal.dots.forEach((d, i) => d.position.copy(signal.curve.getPointAt(((t * 0.35 + i / 3) % 1 + 1) % 1)));
    signal.rings.forEach((r, i) => r.scale.setScalar(1 + 0.25 * Math.sin(t * 4 - i)));
  }

  /** Curved arrow around a vertical axis (prop spin, yaw torque). dir +1 = CCW seen from above. */
  function spinArrow(node, { radius, color, dir = 1, y = 0, tube = 0.004 }) {
    const g = new THREE.Group();
    const m = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9, depthTest: false });
    const arc = new THREE.Mesh(new THREE.TorusGeometry(radius, tube, 8, 48, Math.PI * 1.4), m);
    arc.rotation.x = Math.PI / 2;
    const head = new THREE.Mesh(new THREE.ConeGeometry(tube * 3, tube * 7, 12), m);
    // arrow head at the arc end, pointing along the tangent
    const a = Math.PI * 1.4;
    head.position.set(radius * Math.cos(a), 0, -radius * Math.sin(a));
    head.rotation.set(0, a, 0);
    head.rotateZ(Math.PI / 2);
    g.add(arc, head);
    g.renderOrder = 7;
    arc.renderOrder = head.renderOrder = 7;
    if (dir < 0) g.scale.x = -1;
    g.position.y = y;
    node.add(g);
    fxGroup.userData.attached = (fxGroup.userData.attached || []).concat(g);
    return g;
  }
  function clearAttached() {
    for (const g of fxGroup.userData.attached || []) g.parent?.remove(g);
    fxGroup.userData.attached = [];
  }

  /** Thrust/force arrow: a straight arrow from a node along a world direction, length set later. */
  function forceArrow(color) {
    const a = new THREE.ArrowHelper(new THREE.Vector3(0, 1, 0), new THREE.Vector3(), 0.1, color, 0.02, 0.012);
    a.line.material.depthTest = false;
    a.cone.material.depthTest = false;
    a.renderOrder = 7;
    fxGroup.add(a);
    return a;
  }

  /** Floor stripes that slide under a robot walking "on the spot". */
  function treadmill(width = 0.4, length = 0.8) {
    const g = new THREE.Group();
    const m = new THREE.MeshBasicMaterial({ color: PALETTE.line });
    for (let i = 0; i < 10; i++) {
      const s = new THREE.Mesh(new THREE.PlaneGeometry(width, 0.006), m);
      s.rotation.x = -Math.PI / 2;
      s.position.set(0, 0.0015, -length / 2 + (i * length) / 10);
      g.add(s);
    }
    g.userData.length = length;
    fxGroup.add(g);
    return {
      group: g,
      set(offset) {
        g.children.forEach((s, i) => (s.position.z = (((i * length) / 10 - offset) % length + length) % length - length / 2));
      },
    };
  }

  // ---------------------------------------------------------------- labels (DOM, projected)
  let labels = []; // { el, line, dot, anchor: () => Vector3 | null, text: () => string }
  const svgNS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(svgNS, "svg");
  svg.setAttribute("class", "bn-leaders");
  svg.setAttribute("aria-hidden", "true");
  const list = document.createElement("ul");
  list.className = "bn-labels-list";
  list.setAttribute("aria-label", "Labels on the figure");
  labelLayer.replaceChildren(svg, list);

  /**
   * specs: [{ node | point | anchor(), text (string or function), kind }]. Labels are real list items (screen-reader text),
   * positioned on screen next to their 3D anchor with a thin leader line.
   */
  function setLabels(specs) {
    labels = [];
    list.replaceChildren();
    svg.replaceChildren();
    const seen = new Set();
    for (const s of specs) {
      const txt = typeof s.text === "function" ? s.text() : s.text;
      if (!s.dynamic && seen.has(txt)) continue;
      seen.add(txt);
      const li = document.createElement("li");
      li.className = `bn-label ${s.kind ? `k-${s.kind}` : ""}`;
      li.textContent = txt;
      list.append(li);
      const line = document.createElementNS(svgNS, "line");
      const dot = document.createElementNS(svgNS, "circle");
      dot.setAttribute("r", "3");
      svg.append(line, dot);
      const tmp = new THREE.Vector3();
      const anchor = s.anchor || (s.node ? () => s.node.getWorldPosition(tmp) : () => tmp.copy(s.point));
      labels.push({ el: li, line, dot, anchor, text: typeof s.text === "function" ? s.text : null, last: txt, side: s.side, w: 0, h: 22 });
    }
    invalidate();
  }
  // Layout runs on every live frame, so it reads and writes in separate passes (no layout thrash), keeps each label's
  // size until its text or the plate changes, writes only what moved, and allocates nothing.
  const labelV = new THREE.Vector3();
  const slots = [], colRight = [], colLeft = [];
  const byY = (a, b) => a.ly - b.ly;
  const sizesStale = () => {
    for (const l of labels) l.w = 0;
  };
  function layoutLabels() {
    if (!labels.length) return;
    const W = viewW, H = viewH;
    // 1. writes that change a label's size: dynamic text
    for (const l of labels) {
      if (!l.text) continue;
      const t = l.text();
      if (t !== l.last) (l.el.textContent = t), (l.last = t), (l.w = 0);
    }
    // 2. reads: the size of every label that has none yet (one layout for all of them)
    for (const l of labels) if (!l.w) (l.w = l.el.offsetWidth || 120), (l.h = l.el.offsetHeight || 22);
    // 3. pure maths: projection, then keep labels on each side from overlapping (sort by height, push each below the one
    // above; real heights, a long label wraps to two lines)
    colRight.length = colLeft.length = 0;
    let n = 0;
    for (const l of labels) {
      const p = l.anchor();
      if (!p) {
        l.show = false;
        continue;
      }
      labelV.copy(p).project(camera);
      const x = ((labelV.x + 1) / 2) * W, y = ((1 - labelV.y) / 2) * H;
      const right = l.side ? l.side > 0 : x >= W / 2;
      const q = (slots[n++] ??= {});
      q.l = l;
      q.x = x;
      q.y = y;
      q.ly = y - 26;
      l.show = true;
      (right ? colRight : colLeft).push(q);
      q.right = right;
    }
    for (const col of [colRight, colLeft]) {
      col.sort(byY);
      let next = 6, last = 0;
      for (const q of col) {
        q.ly = Math.max(q.ly, next);
        next = q.ly + q.l.h + 4;
        last = q.ly + q.l.h;
      }
      const over = last - (H - 6);
      if (over > 0) for (const q of col) q.ly -= over;
    }
    // 4. writes: only what changed since the last frame
    for (const l of labels) if (!l.show && l.vis !== false) (l.el.style.visibility = "hidden"), (l.vis = false);
    for (let i = 0; i < n; i++) {
      const q = slots[i], l = q.l, w = l.w;
      const lx = q.right ? Math.min(W - w - 6, Math.max(q.x + 34, W * 0.62)) : Math.max(6, Math.min(q.x - 34 - w, W * 0.38 - w));
      if (l.vis !== true) (l.el.style.visibility = "visible"), (l.vis = true);
      const tx = Math.round(lx), ty = Math.round(q.ly);
      if (tx !== l.tx || ty !== l.ty) (l.el.style.transform = `translate(${tx}px, ${ty}px)`), (l.tx = tx), (l.ty = ty);
      const x1 = Math.round(q.x * 10) / 10, y1 = Math.round(q.y * 10) / 10;
      const x2 = Math.round((q.right ? lx - 4 : lx + w + 4) * 10) / 10, y2 = Math.round((q.ly + 11) * 10) / 10;
      if (x1 !== l.x1 || y1 !== l.y1) {
        l.line.setAttribute("x1", x1);
        l.line.setAttribute("y1", y1);
        l.dot.setAttribute("cx", x1);
        l.dot.setAttribute("cy", y1);
        (l.x1 = x1), (l.y1 = y1);
      }
      if (x2 !== l.x2 || y2 !== l.y2) {
        l.line.setAttribute("x2", x2);
        l.line.setAttribute("y2", y2);
        (l.x2 = x2), (l.y2 = y2);
      }
    }
  }

  // ---------------------------------------------------------------- phone camera inset
  let phoneCam = null, phoneRect = null; // phoneRect: { el } DOM frame to align with
  function setPhoneView(cameraObj, frameEl) {
    phoneCam = cameraObj;
    phoneRect = frameEl;
    invalidate();
  }

  // ---------------------------------------------------------------- loop (on demand)
  let raf = 0, last = 0, dirty = true, live = 0, t = 0;
  let onTick = null; // (dt, t) => void, for Move loops and missions
  function invalidate() {
    dirty = true;
    wake();
  }
  function wake() {
    if (!raf && !document.hidden) (last = performance.now()), (raf = requestAnimationFrame(frame));
  }
  /** Keep rendering every frame while `on` (ref-counted by callers through the returned release). */
  function setLive(on) {
    live = on ? 1 : 0;
    if (on) wake();
  }
  function frame(now) {
    raf = 0;
    const gap = now - last;
    if (gap < 1000 / 61 && (live || anims.size)) {
      raf = requestAnimationFrame(frame); // cap at 60 fps on high-refresh screens
      return;
    }
    const dt = Math.min(0.05, gap / 1000);
    last = now;
    for (const a of anims) stepAnim(a, now);
    if (live && !reduced) t += dt;
    if (onTick) onTick(reduced ? 0 : dt, t);
    if (rig) rig.update(live && !reduced ? dt : 0, t);
    placeSignal(t);
    if (viewW) {
      renderer.setViewport(0, 0, viewW, viewH);
      renderer.setScissorTest(false);
      renderer.render(scene, camera);
      if (phoneCam && phoneRect && !phoneRect.hidden) {
        const cr = canvas.getBoundingClientRect(), fr = phoneRect.getBoundingClientRect();
        const x = fr.left - cr.left, y = cr.bottom - fr.bottom, w = fr.width, h = fr.height;
        if (w > 4 && h > 4) {
          phoneCam.aspect = w / h;
          phoneCam.updateProjectionMatrix();
          renderer.setScissorTest(true);
          renderer.setScissor(x, y, w, h);
          renderer.setViewport(x, y, w, h);
          labelLayer.hidden = false;
          renderer.render(scene, phoneCam);
          renderer.setScissorTest(false);
        }
      }
      layoutLabels();
    }
    dirty = false;
    if (live || anims.size) raf = requestAnimationFrame(frame);
  }
  const onVis = () => {
    if (document.hidden) cancelAnimationFrame(raf), (raf = 0);
    else invalidate();
  };
  document.addEventListener("visibilitychange", onVis);

  function applyTheme() {
    scene.background = cssColor("--paper", PALETTE.paper);
    if (stage.ground) stage.ground.material.color = cssColor("--paper-2", PALETTE.paper2);
    invalidate();
  }

  document.fonts?.ready.then(() => (sizesStale(), invalidate())); // label sizes change when the web fonts land
  onThemeChange(applyTheme);
  applyTheme();
  resize();
  return {
    THREE,
    scene,
    world,
    camera,
    get rig() { return rig; },
    get fit() { return fit; },
    get time() { return t; },
    set time(v) { t = v; },
    get reduced() { return reduced; },
    setReduced(v) { reduced = v; invalidate(); },
    setRobot,
    view,
    moveCamera,
    frameBox(box, { az = 35, el = 40, pad = 1.15 } = {}) {
      const s = box.getBoundingSphere(new THREE.Sphere());
      return { az, el, size: s.radius * pad, tx: s.center.x, ty: s.center.y, tz: s.center.z };
    },
    animate,
    cancelAnims,
    addProp,
    clearProps,
    clearFx() { clearAttached(); clearFx(); invalidate(); },
    showSignal,
    spinArrow,
    forceArrow,
    treadmill,
    fxGroup,
    setLabels,
    setPhoneView,
    setLive,
    set onTick(fn) { onTick = fn; },
    invalidate,
    dispose() {
      cancelAnimationFrame(raf);
      cancelAnims();
      ro.disconnect();
      document.removeEventListener("visibilitychange", onVis);
      renderer.dispose();
    },
  };
}
