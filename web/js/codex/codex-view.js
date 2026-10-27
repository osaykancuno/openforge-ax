// The OpenForge Codex: a pop-up lab notebook on a wooden desk. Each chapter pops a small diorama out of the right page;
// the left page's text is real HTML laid over it (codex.js). This file renders the book, turns pages and runs dioramas.
import * as THREE from "three";
import { PALETTE, makeStage } from "../models/look.js";

export const PAGE_W = 4.2, PAGE_D = 5.2; // one page, in metres (x across, z down the page)
const SEG = 28;

/** Cream notebook paper with a title block on the left page (decorative; the readable text is HTML). */
function pageTexture({ left, number = "", title = "" }) {
  const c = Object.assign(document.createElement("canvas"), { width: 840, height: 1040 });
  const g = c.getContext("2d");
  // a soft shade towards the spine, like a real open book
  const grd = g.createLinearGradient(left ? 840 : 0, 0, left ? 0 : 840, 0);
  grd.addColorStop(0, "#e6dccb");
  grd.addColorStop(0.12, "#f6f1e7");
  grd.addColorStop(1, "#fbf8f2");
  g.fillStyle = grd;
  g.fillRect(0, 0, 840, 1040);
  g.strokeStyle = "rgba(35,33,30,0.06)";
  g.lineWidth = 1;
  for (let x = 0; x <= 840; x += 40) g.beginPath(), g.moveTo(x, 0), g.lineTo(x, 1040), g.stroke();
  for (let y = 0; y <= 1040; y += 40) g.beginPath(), g.moveTo(0, y), g.lineTo(840, y), g.stroke();
  g.strokeStyle = "rgba(35,33,30,0.35)";
  g.lineWidth = 2;
  g.strokeRect(36, 36, 768, 968);
  if (left && number) {
    g.fillStyle = "rgba(180,71,47,0.12)";
    g.font = "800 300px 'Inter Tight', Inter, system-ui, sans-serif";
    g.fillText(number, 60, 330); // the readable title is the HTML laid over this page
    void title;
  }
  if (!left) {
    g.fillStyle = "rgba(107,101,92,0.8)";
    g.font = "600 22px 'JetBrains Mono', Consolas, monospace";
    g.fillText("FIG. · THE OPENFORGE CODEX", 440, 990);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

/** Warm wood grain for the desk (decorative). */
function woodTexture() {
  const c = Object.assign(document.createElement("canvas"), { width: 512, height: 512 });
  const g = c.getContext("2d");
  g.fillStyle = "#b98a5e";
  g.fillRect(0, 0, 512, 512);
  for (let i = 0; i < 90; i++) {
    const y = (i * 512) / 90 + Math.sin(i * 1.7) * 3;
    g.strokeStyle = i % 3 ? `rgba(120,80,48,${0.1 + (i % 5) * 0.03})` : `rgba(214,172,126,${0.12 + (i % 4) * 0.03})`;
    g.lineWidth = 1 + (i % 4);
    g.beginPath();
    g.moveTo(0, y);
    for (let x = 0; x <= 512; x += 32) g.lineTo(x, y + Math.sin(x / 70 + i) * 2.5);
    g.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(3, 2);
  return t;
}

export function createCodexView(canvas, { onPick = () => {}, onLayout = () => {} } = {}) {
  let reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const small = matchMedia("(max-width: 760px)").matches;
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: !small, preserveDrawingBuffer: false });
  renderer.setPixelRatio(Math.min(small ? 1 : 1.75, devicePixelRatio));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.95; // a touch lower than the lab default: the pages are large white areas
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(36, 1, 0.1, 100);
  // soft daylight from the shared lab look (no floor: the desk is the floor)
  const { key } = makeStage(scene, renderer, { size: 6, floor: false, background: PALETTE.paper });
  key.position.set(-3.5, 9, 5.5);
  if (small) key.shadow.mapSize.set(1024, 1024);

  // a warm wooden desk with a faint grain
  const woodTex = woodTexture();
  const bench = new THREE.Mesh(new THREE.BoxGeometry(26, 0.4, 16), new THREE.MeshStandardMaterial({ map: woodTex, roughness: 0.7 }));
  bench.position.y = -0.32;
  bench.receiveShadow = true;
  scene.add(bench);

  // book: terracotta cloth cover + cream page blocks + the two open pages
  const book = new THREE.Group();
  scene.add(book);
  const cover = new THREE.Mesh(new THREE.BoxGeometry(PAGE_W * 2 + 0.35, 0.08, PAGE_D + 0.35), new THREE.MeshStandardMaterial({ color: PALETTE.accent, roughness: 0.85 }));
  cover.position.y = -0.06;
  cover.castShadow = cover.receiveShadow = true;
  book.add(cover);
  const edgeMat = new THREE.MeshStandardMaterial({ color: PALETTE.paper2, roughness: 0.95 });
  for (const side of [-1, 1]) {
    const block = new THREE.Mesh(new THREE.BoxGeometry(PAGE_W - 0.05, 0.12, PAGE_D - 0.05), edgeMat);
    block.position.set((side * PAGE_W) / 2, 0.02, 0);
    block.castShadow = block.receiveShadow = true;
    book.add(block);
  }

  // pages bend slightly up towards the spine, like a real open book
  function pageGeometry() {
    const g = new THREE.PlaneGeometry(PAGE_W, PAGE_D, SEG, 1);
    g.rotateX(-Math.PI / 2);
    return g;
  }
  function curl(geo) {
    const p = geo.attributes.position;
    for (let i = 0; i < p.count; i++) p.setY(i, 0.09 + Math.pow(1 - Math.abs(p.getX(i)) / PAGE_W, 6) * 0.18); // |x| = distance from the spine
    p.needsUpdate = true;
    geo.computeVertexNormals();
  }
  const leftGeo = pageGeometry(), rightGeo = pageGeometry();
  leftGeo.translate(-PAGE_W / 2, 0, 0);
  rightGeo.translate(PAGE_W / 2, 0, 0);
  curl(leftGeo);
  curl(rightGeo);
  const leftMat = new THREE.MeshStandardMaterial({ roughness: 0.95, map: pageTexture({ left: true }) });
  const rightMat = new THREE.MeshStandardMaterial({ roughness: 0.95, map: pageTexture({ left: false }) });
  const leftPage = new THREE.Mesh(leftGeo, leftMat);
  const rightPage = new THREE.Mesh(rightGeo, rightMat);
  leftPage.receiveShadow = rightPage.receiveShadow = true;
  book.add(leftPage, rightPage);

  // the turning page: a strip of columns walked out from the spine, each bent a little more (a curl)
  const turnGeo = new THREE.PlaneGeometry(PAGE_W, PAGE_D, SEG, 1);
  const turnMat = new THREE.MeshStandardMaterial({ roughness: 0.95, side: THREE.DoubleSide, map: rightMat.map }); // one texture, reused every turn
  const turn = new THREE.Mesh(turnGeo, turnMat);
  turn.visible = false;
  book.add(turn);
  const cols = SEG + 1;
  function setTurn(p) {
    // p: 0 = lying on the right page, 1 = lying on the left page
    const pos = turnGeo.attributes.position;
    const theta = p * Math.PI;
    const bend = -0.9 * Math.sin(p * Math.PI);
    const ds = PAGE_W / SEG;
    let x = 0, y = 0.1;
    const xs = [0], ys = [y];
    for (let i = 1; i < cols; i++) {
      const phi = theta + bend * (i / SEG);
      x += ds * Math.cos(phi);
      y += ds * Math.sin(phi);
      xs.push(x), ys.push(Math.max(0.1, y));
    }
    for (let v = 0; v < pos.count; v++) {
      const i = v % cols;
      const row = Math.floor(v / cols); // PlaneGeometry rows run along z (top, bottom)
      pos.setXYZ(v, xs[i], ys[i] + 0.004, row === 0 ? -PAGE_D / 2 : PAGE_D / 2);
    }
    pos.needsUpdate = true;
    turnGeo.computeVertexNormals();
  }

  // diorama slot on the right page
  const slot = new THREE.Group();
  slot.position.set(PAGE_W / 2, 0.12, 0.1);
  book.add(slot);
  let current = null; // { group, update, pickables }


  // ---------------------------------------------------------------- camera: wide = whole book, phone = the diorama page
  let focusRight = small;
  const camPos = new THREE.Vector3(), camLook = new THREE.Vector3();
  let rect = canvas.getBoundingClientRect();
  function frameCamera() {
    const w = canvas.clientWidth, h = canvas.clientHeight;
    camera.aspect = w / h;
    // phones: the text sheet covers the lower part, so the diorama is framed in the upper part
    if (focusRight) camera.setViewOffset(w, h, 0, h * 0.24, w, h);
    else camera.clearViewOffset();
    camera.updateProjectionMatrix();
    const target = focusRight ? new THREE.Vector3(PAGE_W / 2, 0.6, -0.2) : new THREE.Vector3(0, 0.3, 0.45);
    // what must fit across / down, with room for perspective (the near edge of the book looks wider)
    const span = focusRight ? PAGE_W * 1.12 : PAGE_W * 2.4; // wide: the book fills the screen, so the printed text stays large
    const vfov = (camera.fov * Math.PI) / 180;
    const hfov = 2 * Math.atan(Math.tan(vfov / 2) * camera.aspect);
    const dist = Math.max(span / 2 / Math.tan(hfov / 2), (PAGE_D * (focusRight ? 1.2 : 1.22)) / 2 / Math.tan(vfov / 2));
    const dir = new THREE.Vector3(0, 0.95, 1.15).normalize(); // low enough that pop-ups stand up off the page
    camPos.copy(target).addScaledVector(dir, dist);
    camLook.copy(target);
  }
  function resize() {
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    rect = canvas.getBoundingClientRect();
    frameCamera();
    layout();
    dirty = true;
  }
  /** Screen rectangle of the left page (where codex.js lays out the text). */
  function layout() {
    camera.position.copy(camPos);
    camera.lookAt(camLook);
    camera.updateMatrixWorld();
    const pts = [[-PAGE_W + 0.25, -PAGE_D / 2 + 0.3], [-0.35, -PAGE_D / 2 + 0.3], [-PAGE_W + 0.25, PAGE_D / 2 - 0.3], [-0.35, PAGE_D / 2 - 0.3]]
      .map(([x, z]) => new THREE.Vector3(x, 0.1, z).project(camera))
      .map((v) => ({ x: ((v.x + 1) / 2) * rect.width, y: ((1 - v.y) / 2) * rect.height }));
    const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
    // quad: the page's corners on screen (top-left, top-right, bottom-left, bottom-right), so the text can lie on the paper
    onLayout({ x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys), quad: pts, focusRight });
  }
  const ro = new ResizeObserver(resize);
  ro.observe(canvas);

  // ---------------------------------------------------------------- input
  const ray = new THREE.Raycaster();
  const ptr = new THREE.Vector2();
  const pickAt = (e) => {
    if (!current) return null;
    ptr.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    ray.setFromCamera(ptr, camera);
    for (const hit of ray.intersectObjects(current.pickables, true)) {
      let o = hit.object;
      while (o && !o.userData.action) o = o.parent;
      if (o) return o.userData.action;
    }
    return null;
  };
  canvas.addEventListener("pointermove", (e) => e.pointerType === "mouse" && (canvas.style.cursor = pickAt(e) ? "pointer" : ""));
  canvas.addEventListener("click", (e) => {
    const a = pickAt(e);
    if (a) onPick(a);
  });

  // ---------------------------------------------------------------- animation helpers
  const anims = new Set();
  const ease = { out: (t) => 1 - Math.pow(1 - t, 3), back: (t) => 1 + 2.2 * Math.pow(t - 1, 3) + 1.2 * Math.pow(t - 1, 2), inOut: (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2) };
  function animate(ms, fn, easing = ease.inOut) {
    if (reduced) ms = Math.min(ms, 1);
    const p = new Promise((resolve) => anims.add({ t0: performance.now(), ms, fn, easing, resolve }));
    watchdog();
    return p;
  }
  function stepAnims(now) {
    for (const a of anims) {
      const k = a.ms ? Math.min(1, (now - a.t0) / a.ms) : 1;
      a.fn(a.easing(k));
      if (k >= 1) anims.delete(a), a.resolve();
    }
  }
  // where the browser throttles rAF without hiding the page (embedded or occluded views), awaited turns still finish
  let dog = 0, lastFrame = 0;
  function watchdog() {
    if (dog) return;
    dog = setTimeout(function tick() {
      dog = 0;
      if (!anims.size) return;
      const now = performance.now();
      if (now - lastFrame > 250) stepAnims(now), (dirty = true);
      dog = setTimeout(tick, 100);
    }, 100);
  }

  async function sinkCurrent() {
    if (!current) return;
    const g = current.group;
    await animate(260, (k) => g.scale.set(1, Math.max(0.001, 1 - k), 1));
    slot.remove(g);
    current.dispose?.();
    current = null;
  }
  async function popIn(dio) {
    current = dio;
    const g = dio.group;
    g.scale.set(1, 0.001, 1);
    slot.add(g);
    // children rise one after another, like a pop-up book
    const kids = g.children.slice();
    // objects a chapter starts hidden (revealed by an action) stay hidden
    kids.forEach((c) => (c.userData.y0 = c.position.y, c.userData.later = !c.visible, c.position.y -= 0.6, c.visible = false));
    await animate(650, (k) => {
      g.scale.set(1, Math.max(0.001, ease.back(Math.min(1, k * 1.4))), 1);
      kids.forEach((c, i) => {
        const local = Math.min(1, Math.max(0, (k - (i / kids.length) * 0.45) / 0.55));
        c.visible = local > 0 && !c.userData.later;
        c.position.y = c.userData.y0 - 0.6 * (1 - ease.out(local));
      });
    }, (t) => t);
  }

  /** Show a chapter: number/title on the left page texture, a fresh diorama on the right. */
  async function show(chapter, dio, { direction = 1, first = false } = {}) {
    if (!first) {
      await sinkCurrent();
      turn.visible = true;
      await animate(720, (k) => setTurn(direction > 0 ? k : 1 - k));
      turn.visible = false;
    }
    leftMat.map?.dispose();
    leftMat.map = pageTexture({ left: true, number: chapter.number, title: chapter.title });
    leftMat.needsUpdate = true;
    await popIn(dio);
  }

  // ---------------------------------------------------------------- loop
  let raf = 0, last = performance.now();
  let motionT = 0; // the clock idle animations use: it stops while motion is paused or reduced
  let dirty = true; // something changed while paused: render one frame
  function frame(now) {
    raf = requestAnimationFrame(frame);
    const dt = Math.min(0.05, (now - last) / 1000);
    last = lastFrame = now;
    stepAnims(now); // animations always progress (even at zero size), so awaited page turns and actions can never hang
    if (!rect.width) return;
    if (!reduced) motionT += dt;
    if (current?.update) current.update(reduced ? 0 : dt, motionT);
    camera.position.set(camPos.x + Math.sin(motionT / 4) * 0.15, camPos.y, camPos.z);
    camera.lookAt(camLook);
    // idle and paused: nothing moves, so skip the render and save battery
    if (!reduced || anims.size || dirty) renderer.render(scene, camera);
    dirty = false;
  }
  const stop = () => (cancelAnimationFrame(raf), (raf = 0));
  const start = () => !raf && !document.hidden && ((last = performance.now()), (raf = requestAnimationFrame(frame)));
  const onVis = () => (document.hidden ? stop() : start());
  document.addEventListener("visibilitychange", onVis);
  resize();
  start();
  return {
    show,
    animate,
    ease,
    setMotion: (on) => ((reduced = !on), (dirty = true)),
    get reduced() { return reduced; },
    setFocusRight(v) { if (v === focusRight) return; focusRight = v; frameCamera(); layout(); dirty = true; },
    resume: start,
    dispose() {
      stop();
      clearTimeout(dog);
      for (const a of anims) a.resolve(); // nobody waits forever
      anims.clear();
      document.removeEventListener("visibilitychange", onVis);
      ro.disconnect();
      woodTex.dispose();
      renderer.dispose();
    },
  };
}
