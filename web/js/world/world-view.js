// Three.js rendering of Neo-Forge: district (instanced boxes) + voxel avatars, nameplates, emotes, follow camera.
import * as THREE from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { buildDistrict, SIZE } from "./district.js";
import { buildAvatar, VOXEL, FACTION } from "./voxel-avatar.js";

const EMOTE_TEXT = { wave: "👋", spin: "⟳", ping: "!", gg: "GG" };
const unit = new THREE.BoxGeometry(1, 1, 1);
const voxelGeo = new THREE.BoxGeometry(VOXEL * 0.96, VOXEL * 0.96, VOXEL * 0.96);

function instanced(items, geo, material, place) {
  const mesh = new THREE.InstancedMesh(geo, material, Math.max(1, items.length));
  const m = new THREE.Matrix4();
  const c = new THREE.Color();
  items.forEach((it, i) => {
    place(m, it);
    mesh.setMatrixAt(i, m);
    mesh.setColorAt(i, c.setHex(it.color ?? it[3]));
  });
  mesh.count = items.length;
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  return mesh;
}

function textSprite(text, color = "#ffffff", size = 64, bg = "rgba(5,3,10,0.75)") {
  const c = document.createElement("canvas");
  const ctx = c.getContext("2d");
  ctx.font = `700 ${size}px "Share Tech Mono", Consolas, monospace`;
  const w = Math.ceil(ctx.measureText(text).width) + size;
  c.width = w;
  c.height = size * 1.6;
  ctx.font = `700 ${size}px "Share Tech Mono", Consolas, monospace`;
  if (bg) {
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, w, c.height);
    ctx.strokeStyle = color;
    ctx.lineWidth = 4;
    ctx.strokeRect(2, 2, w - 4, c.height - 4);
  }
  ctx.fillStyle = color;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, w / 2, c.height / 2);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }));
  s.scale.set((w / c.height) * 0.42, 0.42, 1);
  s.renderOrder = 10;
  return s;
}

export function createWorldView(canvas) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(1.5, window.devicePixelRatio));
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x12060a);
  scene.fog = new THREE.Fog(0x12060a, 14, 46);
  const camera = new THREE.PerspectiveCamera(55, 1, 0.1, 120);

  scene.add(new THREE.HemisphereLight(0xffb27a, 0x1a0626, 0.9));
  const sun = new THREE.DirectionalLight(0xff7a3a, 1.2);
  sun.position.set(-20, 30, -10);
  scene.add(sun);
  for (const [x, z, c] of [[10, 30, 0xff2bd6], [38, 34, 0x00f0ff], [24, 20, 0xff2bd6]]) {
    const l = new THREE.PointLight(c, 30, 22, 1.6);
    l.position.set(x, 6, z);
    scene.add(l);
  }

  // ground
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(SIZE, SIZE), new THREE.MeshStandardMaterial({ color: 0x1a1412, roughness: 0.95 }));
  ground.rotation.x = -Math.PI / 2;
  ground.position.set(SIZE / 2, 0, SIZE / 2);
  scene.add(ground);
  const grid = new THREE.GridHelper(SIZE, SIZE, 0xff7a1a, 0x3a1a0e);
  grid.position.set(SIZE / 2, 0.01, SIZE / 2);
  grid.material.transparent = true;
  grid.material.opacity = 0.35;
  scene.add(grid);

  // district: 2 draw calls (solid + glow)
  const { blocks } = buildDistrict();
  const place = (m, b) => m.compose(new THREE.Vector3(b.x + b.w / 2, b.y + b.h / 2, b.z + b.d / 2), new THREE.Quaternion(), new THREE.Vector3(b.w, b.h, b.d));
  scene.add(instanced(blocks.filter((b) => !b.glow), unit, new THREE.MeshStandardMaterial({ roughness: 0.7, metalness: 0.3 }), place));
  scene.add(instanced(blocks.filter((b) => b.glow), unit, new THREE.MeshBasicMaterial({ toneMapped: false }), place));

  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  composer.addPass(new UnrealBloomPass(new THREE.Vector2(1, 1), 0.8, 0.5, 0.2));

  // avatars
  const avatars = new Map(); // id -> { group, body, target, emote }
  const vplace = (m, v) => m.makeTranslation(v[0] * VOXEL, (v[1] + 0.5) * VOXEL, v[2] * VOXEL);
  const solidMat = new THREE.MeshStandardMaterial({ roughness: 0.5, metalness: 0.4 });
  const glowMat = new THREE.MeshBasicMaterial({ toneMapped: false });

  function upsert(p) {
    if (avatars.has(p.id)) return;
    const vox = buildAvatar(p.traits);
    const group = new THREE.Group();
    const body = new THREE.Group();
    body.add(instanced(vox.solid, voxelGeo, solidMat, vplace), instanced(vox.glow, voxelGeo, glowMat, vplace));
    group.add(body);
    const color = p.traits ? "#" + FACTION[p.traits.legendary ? 4 : p.traits.faction].toString(16).padStart(6, "0") : "#9a92c4";
    const label = textSprite(p.name, color, 40);
    label.position.y = vox.height * VOXEL + 0.45;
    group.add(label);
    group.position.set(p.x, 0, p.z);
    group.rotation.y = p.yaw;
    scene.add(group);
    avatars.set(p.id, { group, body, height: vox.height * VOXEL, hovers: vox.hovers, target: { x: p.x, z: p.z, yaw: p.yaw }, emote: null });
  }

  function remove(id) {
    const a = avatars.get(id);
    if (!a) return;
    scene.remove(a.group);
    avatars.delete(id);
  }

  function setTarget(id, x, z, yaw) {
    const a = avatars.get(id);
    if (a) a.target = { x, z, yaw };
  }

  function emote(id, e) {
    const a = avatars.get(id);
    if (!a) return;
    if (a.emote) a.group.remove(a.emote.sprite);
    const sprite = textSprite(EMOTE_TEXT[e] || "?", "#ffe600", 64, null);
    sprite.position.y = a.height + 1;
    sprite.scale.multiplyScalar(1.6);
    a.group.add(sprite);
    a.emote = { e, sprite, t: 0 };
  }

  let localId = null;
  const camPos = new THREE.Vector3(24, 8, 40);
  function update(dt, time) {
    for (const [id, a] of avatars) {
      const g = a.group;
      const k = id === localId ? 1 : Math.min(1, dt * 10); // others: smooth interpolation toward the latest snapshot
      g.position.x += (a.target.x - g.position.x) * k;
      g.position.z += (a.target.z - g.position.z) * k;
      let dy = a.target.yaw - g.rotation.y;
      dy = Math.atan2(Math.sin(dy), Math.cos(dy));
      g.rotation.y += dy * k;
      a.body.position.y = a.hovers ? 0.15 + Math.sin(time * 3 + g.position.x) * 0.08 : 0;
      if (a.emote) {
        a.emote.t += dt;
        if (a.emote.e === "spin") a.body.rotation.y = a.emote.t * 10;
        if (a.emote.e === "wave") a.body.position.y += Math.abs(Math.sin(a.emote.t * 10)) * 0.25;
        a.emote.sprite.position.y = a.height + 1 + a.emote.t * 0.4;
        if (a.emote.t > 2) {
          a.group.remove(a.emote.sprite);
          a.body.rotation.y = 0;
          a.emote = null;
        }
      }
    }
    const me = avatars.get(localId);
    if (me) {
      const g = me.group;
      const want = new THREE.Vector3(g.position.x - Math.sin(g.rotation.y) * 6.5, 4.6, g.position.z - Math.cos(g.rotation.y) * 6.5);
      camPos.lerp(want, Math.min(1, dt * 4));
      camera.position.copy(camPos);
      camera.lookAt(g.position.x, 1.2, g.position.z);
    } else {
      camera.position.copy(camPos);
      camera.lookAt(24, 0, 24);
    }
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (canvas.width !== Math.floor(w * renderer.getPixelRatio())) {
      renderer.setSize(w, h, false);
      composer.setSize(w, h);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    }
    composer.render();
  }

  return { upsert, remove, setTarget, emote, update, setLocal: (id) => (localId = id), count: () => avatars.size };
}
