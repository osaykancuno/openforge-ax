// The home page as a bright robotics lab: AX-1 (the phone-brain robot) in the middle, looking at you,
// and a ring of benches around it, each with a working robot model. Rendering only: home.js decides what a
// station does (onSelect). Models come from ../models/robots.js, the same ones the Workbench and Phone Brain use.
import * as THREE from "three";
import { makeRenderer, makeStage, mat, rbox, cyl, torus, at, PALETTE, isDarkTheme, onThemeChange, themed } from "../models/look.js";
import { buildRobot, bounds } from "../models/robots.js";

const RING = 5.9; // station ring radius (scene units)
const PLINTH_R = 1.15;

/** A cutting-mat floor: paper with a fine ink grid and centimetre ticks, drawn once. */
function matTexture() {
  const dark = isDarkTheme();
  const c = document.createElement("canvas");
  c.width = c.height = 1024;
  const g = c.getContext("2d");
  g.fillStyle = dark ? "#26231f" : "#ebe4d6";
  g.fillRect(0, 0, 1024, 1024);
  for (let i = 0; i <= 1024; i += 32) {
    g.strokeStyle = dark ? (i % 256 === 0 ? "rgba(241,236,226,.14)" : "rgba(241,236,226,.05)") : i % 256 === 0 ? "rgba(35,33,30,.16)" : "rgba(35,33,30,.06)";
    g.lineWidth = i % 256 === 0 ? 2 : 1;
    g.beginPath(); g.moveTo(i, 0); g.lineTo(i, 1024); g.moveTo(0, i); g.lineTo(1024, i); g.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(6, 6);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

// ---------------------------------------------------------------- props for stations without a robot
function bookProp() {
  const g = new THREE.Group();
  const cover = at(rbox(1.3, 0.05, 0.9, "sage", 0.02), 0, 0.03, 0, g);
  void cover;
  const left = at(new THREE.Group(), 0, 0.07, 0, g);
  const right = at(new THREE.Group(), 0, 0.07, 0, g);
  at(rbox(0.6, 0.03, 0.84, "shell", 0.01), -0.31, 0, 0, left);
  at(rbox(0.6, 0.03, 0.84, "shell", 0.01), 0.31, 0, 0, right);
  left.rotation.z = 0.12;
  right.rotation.z = -0.12;
  // a pop-up on the right page: a tiny robot arm silhouette
  const pop = at(new THREE.Group(), 0.3, 0.1, 0, g);
  at(rbox(0.08, 0.32, 0.08, "accent", 0.02), 0, 0.16, 0, pop);
  at(rbox(0.26, 0.06, 0.06, "graphite", 0.02), 0.1, 0.32, 0, pop);
  const page = at(new THREE.Group(), 0, 0.09, 0, g); // the turning page
  at(rbox(0.58, 0.012, 0.8, "paper", 0.005), 0.3, 0, 0, page);
  g.userData.page = page;
  return g;
}
function framesProp() {
  const g = new THREE.Group();
  const cols = ["accent", "sky", "sun"];
  [-0.5, 0, 0.5].forEach((x, i) => {
    const f = at(new THREE.Group(), x, 0, i === 1 ? -0.12 : 0.05, g);
    f.rotation.y = -x * 0.5;
    at(rbox(0.46, 0.62, 0.04, "shell", 0.015), 0, 0.31 + (i === 1 ? 0.12 : 0), 0, f);
    at(rbox(0.36, 0.36, 0.01, cols[i], 0.01), 0, 0.38 + (i === 1 ? 0.12 : 0), 0.022, f);
    at(rbox(0.3, 0.03, 0.01, "graphite", 0.005), 0, 0.14 + (i === 1 ? 0.12 : 0), 0.022, f);
    at(rbox(0.2, 0.03, 0.01, "line", 0.005), -0.05, 0.09 + (i === 1 ? 0.12 : 0), 0.022, f);
  });
  return g;
}
function coinProp() {
  const g = new THREE.Group();
  at(cyl(0.35, 0.42, 0.08, "shell", 48), 0, 0.04, 0, g);
  const spin = at(new THREE.Group(), 0, 0.62, 0, g);
  const coin = at(cyl(0.42, 0.42, 0.07, "sun", 64), 0, 0, 0, spin);
  coin.rotation.x = Math.PI / 2;
  for (const z of [0.037, -0.037]) {
    at(rbox(0.16, 0.26, 0.012, "graphite", 0.03), 0, 0.02, z, spin); // a phone, the AX mark
    at(rbox(0.1, 0.012, 0.014, "accent", 0.004), 0, -0.13, z * 1.01, spin);
  }
  g.userData.spin = spin;
  return g;
}

/** Each station's centrepiece: a robot rig (animated by `tick`) or a prop. Heights are normalised later. */
const PIECES = {
  bench: { robot: "drone", height: 0.9, lift: 0.75, tick: (r, t) => (r.setSpin("prop", 6), (r.group.position.y = r.group.userData.y + Math.sin(t * 1.6) * 0.012), (r.group.rotation.y = Math.sin(t * 0.4) * 0.5)) },
  pilot: { robot: "ax1-rover", height: 1.25, tick: (r, t) => {
    const a = t * 0.55;
    r.group.position.x = Math.cos(a) * 0.1;
    r.group.position.z = Math.sin(a) * 0.1;
    r.group.rotation.y = -a; // tangent to the circle
    r.setSpin("wheel-l", 0.9); r.setSpin("wheel-r", 0.55);
    r.set("head_pan", Math.sin(t * 0.8) * 30);
    r.face?.setLook(Math.sin(t * 0.8), 0);
  } },
  arena: { robot: "spider", height: 0.75, tick: (r, t) => {
    for (let i = 1; i <= 6; i++) {
      const ph = t * 4 + (i % 2) * Math.PI;
      r.set(`leg${i}_coxa`, Math.sin(ph) * 18);
      r.set(`leg${i}_femur`, -20 + Math.max(0, Math.cos(ph)) * 25);
    }
    r.group.rotation.y = t * 0.25;
  } },
  robot: { robot: "so101", height: 1.45, tick: (r, t) => {
    const k = (Math.sin(t * 0.9) + 1) / 2;
    r.pose({ shoulder_pan: Math.sin(t * 0.45) * 60, shoulder_lift: -30 + k * 55, elbow_flex: 90 - k * 20, wrist_flex: 60 + k * 20, wrist_roll: Math.sin(t * 0.7) * 40, gripper: k > 0.8 ? 20 : 100 });
  } },
  codex: { prop: bookProp, height: 0.5, tick: (p, t) => (p.userData.page.rotation.z = Math.PI * ((Math.sin(t * 0.7) + 1) / 2) * 0.96) },
  gallery: { prop: framesProp, height: 0.95 },
  agents: { robot: "hound", height: 0.95, tick: (r, t) => {
    const b = Math.sin(t * 1.3);
    for (const id of ["fl", "fr", "bl", "br"]) r.set(`${id}_thigh`, 35 + b * 6), r.set(`${id}_knee`, -70 - b * 10);
    r.group.position.y = r.group.userData.y + b * 0.006;
  } },
  mint: { prop: coinProp, height: 1.05, tick: (p, t) => (p.userData.spin.rotation.y = t * 1.1) },
  lore: { robot: "fab", height: 1.25, tick: (r, t) => {
    const s = r.slides;
    s.head.position.x = Math.sin(t * 1.7) * 0.1;
    s.bed.position.z = Math.cos(t * 1.1) * 0.06;
    r.setSpin("spool", 0.15);
  } },
};

/**
 * Options: onHover / onSelect / onFrame / safeArea (see home.js), plus two frame-budget knobs the page passes:
 *  maxFps       cap the loop (0 = every display frame); home.js uses 30 on small screens
 *  adaptiveDpr  drop to pixel ratio 1 when the first 30 frames average more than 24 ms
 */
export function createLabView(canvas, stations, { onHover = () => {}, onSelect = () => {}, onFrame = () => {}, safeArea = () => ({ left: 0, top: 0 }), maxFps = 0, adaptiveDpr = false } = {}) {
  let reduced = matchMedia("(prefers-reduced-motion: reduce)").matches; // also set by the page's "Pause animation"
  const small = matchMedia("(max-width: 760px)").matches;
  const renderer = makeRenderer(canvas);
  renderer.setPixelRatio(Math.min(small ? 1.5 : 2, devicePixelRatio));
  // frames still to draw while everything else is at rest (easing needs ~60 frames to settle); only matters when motion is paused
  let settle = 90;
  const wake = () => (settle = 90);
  const scene = new THREE.Scene();
  const stage = makeStage(scene, renderer, { size: 10, floor: false });
  stage.key.shadow.mapSize.set(small ? 1024 : 2048, small ? 1024 : 2048);
  scene.fog = new THREE.Fog(themed(PALETTE.paper), 26, 46);
  const camera = new THREE.PerspectiveCamera(small ? 40 : 30, 1, 0.1, 120);

  // floor: a cutting mat on paper
  const floor = new THREE.Mesh(new THREE.CircleGeometry(30, 96), new THREE.MeshStandardMaterial({ map: matTexture(), roughness: 0.95 }));
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  scene.add(floor);
  onThemeChange(() => {
    scene.fog.color.setHex(themed(PALETTE.paper));
    floor.material.map.dispose();
    floor.material.map = matTexture();
    floor.material.needsUpdate = true;
    wake();
  });
  const ringLine = at(torus(RING, 0.012, "ink"), 0, 0.005, 0, scene);
  ringLine.rotation.x = Math.PI / 2;
  ringLine.material = new THREE.MeshBasicMaterial({ color: PALETTE.ink, transparent: true, opacity: 0.25 });

  // ---------------------------------------------------------------- centre: AX-1 on a turntable, following the pointer
  const centre = at(new THREE.Group(), 0, 0, 0, scene);
  at(cyl(1.55, 1.7, 0.3, "shell", 72), 0, 0.15, 0, centre);
  at(torus(1.6, 0.025, "accent"), 0, 0.3, 0, centre).rotation.x = Math.PI / 2;
  const hero = buildRobot("ax1-desk");
  const heroScale = 3.4 / (bounds(hero).getSize(new THREE.Vector3()).y || 1);
  hero.group.scale.setScalar(heroScale);
  hero.group.position.y = 0.3;
  centre.add(hero.group);

  // ---------------------------------------------------------------- stations
  // Positions and heights are known at once (so the framing is final from the first frame); the benches and robots
  // themselves are built afterwards in idle chunks, so the hero shows up first.
  const items = stations.map((st, i) => {
    const ang = (i / stations.length) * Math.PI * 2 - Math.PI / 2;
    const group = at(new THREE.Group(), Math.cos(ang) * RING, 0, Math.sin(ang) * RING, scene);
    group.lookAt(0, 0, 0);
    group.rotateY(Math.PI); // face outwards, toward the viewer side of the ring
    const def = PIECES[st.model] || PIECES.gallery;
    const top = 0.22 + (def.lift || 0) + def.height * 1.3;
    return { ...st, group, def, top, lift: 0, ready: false };
  });
  const hits = []; // pickable volumes, added as each station is built

  function buildItem(it) {
    const { group, def } = it;
    const plinth = at(cyl(PLINTH_R, PLINTH_R * 1.06, 0.22, "shell", 64), 0, 0.11, 0, group);
    void plinth;
    const band = at(torus(PLINTH_R * 1.005, 0.018, new THREE.MeshStandardMaterial({ color: it.color, roughness: 0.5 })), 0, 0.2, 0, group);
    band.rotation.x = Math.PI / 2;
    const body = at(new THREE.Group(), 0, 0.22, 0, group);
    let rig = null, node;
    if (def.robot) {
      rig = buildRobot(def.robot);
      node = rig.group;
    } else node = def.prop();
    const size = new THREE.Box3().setFromObject(node).getSize(new THREE.Vector3());
    const s = (def.height * 1.3) / Math.max(size.y, size.x * 0.6, 1e-3);
    const holder = at(new THREE.Group(), 0, def.lift || 0, 0, body);
    holder.scale.setScalar(s);
    holder.add(node);
    node.userData.y = node.position.y;
    const hit = at(new THREE.Mesh(new THREE.CylinderGeometry(PLINTH_R * 1.1, PLINTH_R * 1.1, it.top + 0.4, 16), new THREE.MeshBasicMaterial({ visible: false })), 0, (it.top + 0.4) / 2, 0, group);
    hit.userData.id = it.id;
    const halo = at(new THREE.Mesh(new THREE.RingGeometry(PLINTH_R * 1.15, PLINTH_R * 1.24, 64), new THREE.MeshBasicMaterial({ color: PALETTE.ink, transparent: true, opacity: 0 })), 0, 0.01, 0, group);
    halo.rotation.x = -Math.PI / 2;
    Object.assign(it, { body, rig, node, hit, halo, ready: true });
    hits.push(hit);
  }

  let built = 0, disposed = false;
  const idle = (fn) => (window.requestIdleCallback ? requestIdleCallback(fn, { timeout: 500 }) : setTimeout(() => fn({ timeRemaining: () => 8 }), 30));
  function buildChunk(deadline) {
    if (disposed) return;
    do buildItem(items[built++]);
    while (built < items.length && deadline.timeRemaining() > 8); // at least one station per chunk, more while the browser is idle
    wake();
    if (built < items.length) idle(buildChunk);
    else {
      const w = canvas.clientWidth, h = canvas.clientHeight;
      if (w && h) fit(w, h); // everything is in: frame it once more
    }
  }
  idle(buildChunk);

  // ---------------------------------------------------------------- camera
  const home = { pos: new THREE.Vector3(0, small ? 21 : 13.5, small ? 17 : 19), look: new THREE.Vector3(0, 0.9, 0) };
  const cam = { pos: home.pos.clone(), look: home.look.clone() };
  let tween = null;
  const pointer = new THREE.Vector2(0, 0);
  function moveTo(pos, look, ms = 750) {
    if (reduced) ms = 0;
    tween = { from: { pos: cam.pos.clone(), look: cam.look.clone() }, to: { pos, look }, t0: performance.now(), ms };
    wake();
  }
  function focus(id) {
    const it = items.find((s) => s.id === id);
    if (!it) return;
    const p = it.group.position;
    const dir = p.clone().setY(0).normalize();
    moveTo(p.clone().add(dir.multiplyScalar(4.4)).add(new THREE.Vector3(0, 2.6, 0)), p.clone().add(new THREE.Vector3(0, it.top * 0.55, 0)));
  }
  const reset = (ms) => moveTo(home.pos.clone(), home.look.clone(), ms); // ms 0: snap back, no fly-out

  // ---------------------------------------------------------------- input
  const ray = new THREE.Raycaster();
  let rect = canvas.getBoundingClientRect();
  let hovered = null;
  function pick(e) {
    ray.setFromCamera(new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1), camera);
    return ray.intersectObjects(hits)[0]?.object.userData.id ?? null;
  }
  const setHover = (id) => {
    if (id === hovered) return;
    hovered = id;
    wake();
    canvas.style.cursor = id ? "pointer" : "";
    onHover(id);
  };
  canvas.addEventListener("pointermove", (e) => {
    pointer.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    wake();
    if (e.pointerType === "mouse") setHover(pick(e));
  });
  canvas.addEventListener("pointerleave", () => (setHover(null), pointer.set(0, 0), wake()));
  canvas.addEventListener("click", (e) => {
    const id = pick(e);
    if (id) onSelect(id);
  });

  // ---------------------------------------------------------------- framing
  function resize() {
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    rect = canvas.getBoundingClientRect();
    fit(w, h);
    wake();
  }
  /** Frames the ring inside the area the HUD leaves free (right of it on wide screens, below it on narrow ones). */
  function fit(w, h) {
    const { left, top } = safeArea(w, h);
    const portrait = w < 900;
    const free = portrait ? { x0: 40, y0: top + 52, x1: w - 40, y1: h - 96 } : { x0: left + 60, y0: 60 + 56, x1: w - 60, y1: h - 52 };
    camera.aspect = w / h;
    camera.zoom = 1;
    camera.clearViewOffset();
    camera.updateProjectionMatrix();
    camera.position.copy(home.pos);
    camera.lookAt(home.look);
    camera.updateMatrixWorld();
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const it of items) {
      for (const y of [0, it.top + 0.5]) {
        const v = it.group.position.clone().setY(y).project(camera);
        const px = ((v.x + 1) / 2) * w, py = ((1 - v.y) / 2) * h;
        [x0, y0, x1, y1] = [Math.min(x0, px), Math.min(y0, py), Math.max(x1, px), Math.max(y1, py)];
      }
    }
    const zoom = Math.min(1.4, 0.94 * Math.min((free.x1 - free.x0) / (x1 - x0), (free.y1 - free.y0) / (y1 - y0)));
    const cx = w / 2 + ((x0 + x1) / 2 - w / 2) * zoom, cy = h / 2 + ((y0 + y1) / 2 - h / 2) * zoom;
    camera.zoom = zoom;
    const targetY = portrait ? free.y0 + ((y1 - y0) * zoom) / 2 + 16 : (free.y0 + free.y1) / 2;
    camera.setViewOffset(w, h, -((free.x0 + free.x1) / 2 - cx), -(targetY - cy), w, h);
    camera.updateProjectionMatrix();
  }
  const ro = new ResizeObserver(resize);
  ro.observe(canvas);
  resize();

  // ---------------------------------------------------------------- loop
  const tmp = new THREE.Vector3();
  const anchors = items.map((it) => ({ id: it.id, x: 0, y: 0, visible: true }));
  const look = new THREE.Vector2();
  let raf = 0, last = performance.now(), clock = 0;
  const minDt = maxFps ? 1000 / maxFps - 2 : 0; // 2 ms of slack: display frames come in whole multiples of 16.7 ms
  let seen = 0, prevRaf = 0, sum = 0, n = 0; // frame-time probe for adaptiveDpr: rAF to rAF, first 30 frames after a short warm-up
  const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
  function frame(now) {
    raf = requestAnimationFrame(frame);
    if (adaptiveDpr && n < 30) {
      if (prevRaf && ++seen > 2) {
        sum += now - prevRaf;
        if (++n === 30 && sum / n > 24 && renderer.getPixelRatio() > 1) (renderer.setPixelRatio(1), resize());
      }
      prevRaf = now;
    }
    if (!rect.width) return;
    if (minDt && now - last < minDt) return;
    // nothing moves while paused: no tween, pointer at rest and the easing settled, so there is nothing new to draw
    if (reduced && !tween && settle <= 0) return void (last = now);
    settle--;
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    if (!reduced) clock += dt; // the lab's own time: frozen when paused, so poses hold still
    const t = clock;
    if (tween) {
      const k = tween.ms ? Math.min(1, (now - tween.t0) / tween.ms) : 1;
      cam.pos.lerpVectors(tween.from.pos, tween.to.pos, ease(k));
      cam.look.lerpVectors(tween.from.look, tween.to.look, ease(k));
      if (k >= 1) tween = null;
    }
    const drift = reduced || tween ? 0 : 1;
    camera.position.set(cam.pos.x + (Math.sin(now / 7000) * 0.6 + pointer.x * 0.5) * drift, cam.pos.y + pointer.y * 0.25 * drift, cam.pos.z);
    camera.lookAt(cam.look);

    // AX-1 looks at the pointer (or at the hovered bench), even when motion is paused: it is a response, not a loop
    const target = hovered ? items.find((i) => i.id === hovered).group.position : null;
    if (target) {
      tmp.copy(target).project(camera);
      look.set(tmp.x, Math.min(0.2, tmp.y));
    } else look.copy(pointer);
    hero.set("head_pan", hero.get("head_pan") + (look.x * 70 - hero.get("head_pan")) * 0.08);
    hero.set("head_tilt", hero.get("head_tilt") + (look.y * 22 - hero.get("head_tilt")) * 0.08);
    hero.face.setLook(look.x * 0.8, -look.y * 0.8);
    hero.face.setMood(hovered ? "happy" : "idle");
    if (!reduced) {
      const wave = Math.max(0, Math.sin(t * 0.5)) ** 8; // an occasional wave
      hero.set("r_shoulder", -20 - wave * 120);
      hero.set("r_elbow", -20 - wave * Math.abs(Math.sin(t * 6)) * 60);
      hero.set("l_shoulder", -15 + Math.sin(t * 0.7) * 6);
    }
    hero.update(dt, now / 1000);

    for (const it of items) {
      if (!it.ready) continue;
      const goal = it.id === hovered ? 1 : 0;
      it.lift += (goal - it.lift) * 0.15;
      it.body.position.y = 0.22 + it.lift * 0.18;
      it.halo.material.opacity = it.lift * 0.55;
      if (!reduced) it.def.tick?.(it.rig || it.node, t + it.group.position.x);
      it.rig?.update(reduced ? 0 : dt, now / 1000);
    }
    renderer.render(scene, camera);

    items.forEach((it, i) => {
      tmp.copy(it.group.position).setY(it.top + 0.45 + it.lift * 0.18).project(camera);
      Object.assign(anchors[i], { x: ((tmp.x + 1) / 2) * rect.width, y: ((1 - tmp.y) / 2) * rect.height, visible: it.ready && tmp.z < 1 });
    });
    onFrame(anchors);
  }
  const stop = () => (cancelAnimationFrame(raf), (raf = 0));
  const start = () => !raf && !document.hidden && ((last = performance.now()), (prevRaf = 0), wake(), (raf = requestAnimationFrame(frame)));
  const onVisibility = () => (document.hidden ? stop() : start());
  document.addEventListener("visibilitychange", onVisibility);
  start();

  return {
    focus, reset, hover: setHover, resume: start,
    /** false freezes every automatic motion (drift, robots, waves); hover, clicks and AX-1's gaze still work */
    setMotion: (on) => ((reduced = !on), wake()),
    dispose: () => {
      disposed = true;
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
      ro.disconnect();
      renderer.dispose();
    },
  };
}
