// RETIRED as token art in phase 2: tokens are drawn by art/token-render.mjs from the lab's 3D models. Kept for the
// retired Neo-Forge avatars (8 classes only).
// Isometric voxel renderer for the OpenForge Agents art. Deterministic: same traits + id => same SVG.
// The agent is built by web/js/world/voxel-avatar.js, the module Neo-Forge uses for in-world avatars, so a
// token's art and its avatar in the world are the same voxels. Everything else here is the scene and the HUD.
import { buildAvatar } from "../web/js/world/voxel-avatar.js";
import { describe } from "./traits.mjs";

const DISTRICT = [
  { a: "#2a0838", b: "#09020f", sign: ["#ff2bd6", "#00f0ff", "#ffe600"] }, // Neon Bazaar
  { a: "#3a1606", b: "#0d0502", sign: ["#ff7a1a", "#ffd000", "#ff3b3b"] }, // Rust Docks
  { a: "#062a1f", b: "#010806", sign: ["#39ff14", "#00ffa3", "#b6ff00"] }, // Undergrid
  { a: "#0a1f4a", b: "#020612", sign: ["#00f0ff", "#7aa2ff", "#ffffff"] }, // Chrome Spire
  { a: "#2b0a3d", b: "#08020d", sign: ["#b026ff", "#ff2bd6", "#00f0ff"] }, // Data Shrine
  { a: "#0b0b1a", b: "#000000", sign: ["#ffffff", "#00f0ff", "#ff2bd6"] }, // Orbital Yard
];
const FORGE_CORE = { a: "#4a1d00", b: "#0d0400", sign: ["#ffcc33", "#ff2bd6", "#ff6a00"] };
const DORMANT = { a: "#2a0838", b: "#05020a", sign: ["#ff2bd6", "#00f0ff", "#9a92c4"] };
const CORE = [["#00f0ff", "VLA//BASE"], ["#39ff14", "VLA//TUNED"], ["#ffb000", "VLA//PRIME"], ["#ff2bd6", "VLA//GENESIS"]];
const HOLO_BODY = 0xc9d3e6; // Holo Chrome in voxel-avatar.js, recoloured here as an iridescent pattern
const HOLO = [0xdfe7f5, 0xa8f0ff, 0xf3b8ff, 0x9aa6c0];
const GOLD = 0xf5c542;
const FACTION_COLOR = ["#9aa3b5", "#ff7a1a", "#00f0ff", "#b026ff", "#e9e6ff"];

const SIZE = 1000;
const C30 = Math.cos(Math.PI / 6);
const pad4 = (n) => String(n).padStart(4, "0");
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const int = (css) => parseInt(css.slice(1), 16);

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Colour int scaled by k (lighter > 1, darker < 1), as #rrggbb. */
function shade(c, k) {
  const ch = (s) => Math.max(0, Math.min(255, Math.round(((c >> s) & 255) * k)));
  return `#${[16, 8, 0].map((s) => ch(s).toString(16).padStart(2, "0")).join("")}`;
}

// ---------------------------------------------------------------------------- scene
/** Platform, district props and the agent, as voxels {x, y, z, c, glow}. */
function buildScene(id, avatar, D, { holo = false, legendary = false } = {}) {
  const vox = [];
  const lift = avatar.hovers ? 2 : 0;
  const cells = new Set();
  const add = (x, y, z, c, glow = false) => {
    const k = `${x},${y},${z}`;
    if (cells.has(k)) return;
    cells.add(k);
    vox.push({ x, y, z, c, glow });
  };
  for (const [x, y, z, c] of avatar.solid) {
    let col = c;
    if (holo && c === HOLO_BODY) col = HOLO[(((x + 2 * y + z) % 4) + 4) % 4];
    if (legendary && c === GOLD) col = int(shade(GOLD, 0.9 + ((y % 3) + 3) % 3 * 0.08));
    add(x, y + lift, z, col);
  }
  for (const [x, y, z, c] of avatar.glow) add(x, y + lift, z, c, true);

  // platform: an 11x11 tiled deck with a neon rim
  const deck = [int(shade(int(D.a), 0.55)), int(shade(int(D.a), 0.8))];
  for (let x = -5; x <= 5; x++)
    for (let z = -5; z <= 5; z++) {
      const rim = Math.abs(x) === 5 || Math.abs(z) === 5;
      add(x, -1, z, rim && (x + z) % 2 === 0 ? int(D.sign[0]) : deck[(x + z + 10) % 2], rim && (x + z) % 2 === 0);
    }

  // district props at the back of the deck (never in front of the agent)
  const r = rng(id * 7919 + 13);
  const spots = [[-4, -4], [-4, -1], [-1, -4], [4, -4], [-4, 3]];
  for (let i = 0; i < 3; i++) {
    const [px, pz] = spots.splice(Math.floor(r() * spots.length), 1)[0];
    const kind = Math.floor(r() * 3);
    const neon = int(D.sign[1 + Math.floor(r() * 2)]);
    if (kind === 0) { // crate stack
      const h = 1 + Math.floor(r() * 3);
      for (let y = 0; y < h; y++) add(px, y, pz, int(shade(int(D.a), 1.4 + 0.15 * y)));
      add(px, h, pz, neon, true);
    } else if (kind === 1) { // neon pylon
      const h = 4 + Math.floor(r() * 4);
      for (let y = 0; y < h; y++) add(px, y, pz, y % 2 ? 0x1b1f2a : 0x2a2f3d);
      add(px, h, pz, neon, true);
    } else { // data terminal
      add(px, 0, pz, 0x20232c);
      add(px, 1, pz, 0x20232c);
      add(px, 2, pz, neon, true);
    }
  }
  return { vox, cells };
}

// ---------------------------------------------------------------------------- isometric projection
const proj = (x, y, z) => [(x - z) * C30, (x + z) * 0.5 - y];

function faces(vox, cells) {
  const has = (x, y, z) => cells.has(`${x},${y},${z}`);
  // painter's order for a camera looking from +x, +y, +z: farther cubes have a smaller x + y + z
  const order = [...vox].sort((a, b) => a.x + a.y + a.z - (b.x + b.y + b.z) || a.y - b.y || a.x - b.x);
  const out = [];
  for (const v of order) {
    const { x, y, z } = v;
    if (!has(x, y + 1, z)) out.push({ v, k: 1.18, pts: [[x, y + 1, z], [x + 1, y + 1, z], [x + 1, y + 1, z + 1], [x, y + 1, z + 1]] });
    if (!has(x, y, z + 1)) out.push({ v, k: 0.95, pts: [[x, y, z + 1], [x + 1, y, z + 1], [x + 1, y + 1, z + 1], [x, y + 1, z + 1]] });
    if (!has(x + 1, y, z)) out.push({ v, k: 0.7, pts: [[x + 1, y, z], [x + 1, y, z + 1], [x + 1, y + 1, z + 1], [x + 1, y + 1, z]] });
  }
  return out;
}

function drawVoxels(vox, cells, box) {
  const fs = faces(vox, cells);
  const pts = fs.flatMap((f) => f.pts.map((p) => proj(...p)));
  const [minX, maxX] = [Math.min(...pts.map((p) => p[0])), Math.max(...pts.map((p) => p[0]))];
  const [minY, maxY] = [Math.min(...pts.map((p) => p[1])), Math.max(...pts.map((p) => p[1]))];
  const s = Math.min(box.w / (maxX - minX), box.h / (maxY - minY));
  const ox = box.cx - ((minX + maxX) / 2) * s;
  const oy = box.cy - ((minY + maxY) / 2) * s;
  const poly = (f) => f.pts.map((p) => proj(...p)).map(([px, py]) => `${(ox + px * s).toFixed(1)},${(oy + py * s).toFixed(1)}`).join(" ");
  let solid = "";
  let bloom = "";
  for (const f of fs) {
    const fill = f.v.glow ? shade(f.v.c, Math.max(1, f.k)) : shade(f.v.c, f.k);
    // dark finishes (Blacksteel, treads) get a cool rim light so they read against the night sky
    const dark = Math.max((f.v.c >> 16) & 255, (f.v.c >> 8) & 255, f.v.c & 255) < 70;
    const edge = f.v.glow ? shade(f.v.c, 0.8) : dark ? shade(0x7c86a6, f.k) : shade(f.v.c, f.k * 0.55);
    solid += `<polygon points="${poly(f)}" fill="${fill}" stroke="${edge}" stroke-width="1.2" stroke-linejoin="round"/>`;
    if (f.v.glow) bloom += `<polygon points="${poly(f)}" fill="${shade(f.v.c, 1)}"/>`;
  }
  return { solid, bloom, s };
}

// ---------------------------------------------------------------------------- background and HUD
function skyline(id, D) {
  const r = rng(id * 104729 + 7);
  let out = "";
  for (const [op, hmin, hmax, step] of [[0.5, 220, 480, 48], [0.9, 120, 300, 40]]) {
    let x = -step;
    while (x < SIZE) {
      const w = step * (1 + Math.floor(r() * 3));
      const h = Math.round((hmin + r() * (hmax - hmin)) / 16) * 16;
      const y = 720 - h;
      out += `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${D.b}" opacity="${op}"/>`;
      for (let wy = y + 16; wy < 700; wy += 24)
        for (let wx = x + 8; wx < x + w - 12; wx += 20)
          if (r() < 0.22) out += `<rect x="${wx}" y="${wy}" width="10" height="10" fill="${D.sign[Math.floor(r() * 3)]}" opacity="${(0.25 + r() * 0.5).toFixed(2)}"/>`;
      x += w + 8;
    }
  }
  return out;
}

function frame(g, strong) {
  return `<rect x="18" y="18" width="964" height="964" fill="none" stroke="${g}" stroke-opacity="${strong ? 0.95 : 0.45}" stroke-width="${strong ? 6 : 2}"/>
<path d="M18 80V18H80M920 18H982V80M982 920V982H920M80 982H18V920" fill="none" stroke="${g}" stroke-width="${strong ? 10 : 5}"/>`;
}

function page(D, g, scene, hud, strong) {
  const scan = Array.from({ length: 250 }, (_, i) => `<rect y="${i * 4}" width="1000" height="1.2"/>`).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">
<defs>
  <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${D.b}"/><stop offset="0.68" stop-color="${D.a}"/><stop offset="1" stop-color="${D.b}"/></linearGradient>
  <radialGradient id="vig" cx="50%" cy="50%" r="70%"><stop offset="0.6" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity="0.75"/></radialGradient>
  <radialGradient id="halo" cx="50%" cy="50%" r="50%"><stop offset="0" stop-color="${g}" stop-opacity="0.3"/><stop offset="1" stop-color="${g}" stop-opacity="0"/></radialGradient>
  <filter id="bloom" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="9"/></filter>
</defs>
<rect width="${SIZE}" height="${SIZE}" fill="url(#sky)"/>
${scene.sky}
<circle cx="500" cy="520" r="400" fill="url(#halo)"/>
${scene.voxels.solid}
<g filter="url(#bloom)" opacity="0.75">${scene.voxels.bloom}</g>
<g fill="#000" opacity="0.16">${scan}</g>
<rect width="${SIZE}" height="${SIZE}" fill="url(#vig)"/>
${hud}
${frame(g, strong)}
</svg>`;
}

// ---------------------------------------------------------------------------- public
export function renderAgent(id, t) {
  const L = t.legendary > 0;
  const info = describe(t);
  const [g, tag] = L ? ["#ffcc33", "1/1 // PRIME CONSTRUCT"] : CORE[t.core];
  const D = L ? FORGE_CORE : DISTRICT[t.district];
  const avatar = buildAvatar({ class_: t.class, core: t.core, sensor: t.sensor, finish: t.finish, augment: t.augment, faction: t.faction, legendary: t.legendary });
  const { vox, cells } = buildScene(id, avatar, D, { holo: !L && t.finish === 6, legendary: L });
  const voxels = drawVoxels(vox, cells, { cx: 500, cy: 500, w: 720, h: 660 });
  const title = esc(info.name.toUpperCase());
  const fc = FACTION_COLOR[L ? 4 : t.faction];
  const hud = `<g font-family="'Share Tech Mono', Consolas, 'Courier New', monospace">
  <rect x="40" y="40" width="250" height="56" fill="#05030a" opacity="0.75" stroke="${g}" stroke-width="2"/>
  <text x="58" y="80" font-size="34" font-weight="700" fill="#f2f5ff" letter-spacing="3">AX-${pad4(id)}</text>
  <text x="960" y="78" font-size="22" text-anchor="end" fill="${g}" letter-spacing="3">${esc(tag)}</text>
  <text x="963" y="112" font-size="16" text-anchor="end" fill="#9aa3c7" letter-spacing="2">${esc(info.Frame)} // ${esc(info.Sensor.toUpperCase())}</text>
  <text x="104" y="905" font-size="44" font-weight="700" fill="#00f0ff" opacity="0.8" letter-spacing="4">${title}</text>
  <text x="98" y="901" font-size="44" font-weight="700" fill="#ff2bd6" opacity="0.8" letter-spacing="4">${title}</text>
  <text x="101" y="903" font-size="44" font-weight="700" fill="#ffffff" letter-spacing="4">${title}</text>
  <text x="102" y="945" font-size="20" fill="#9aa3c7" letter-spacing="3">${esc(`${info.Class} · ${info.Faction} · ${info.District}`.toUpperCase())}</text>
</g>
<g transform="translate(46 880)"><rect width="40" height="40" fill="${fc}" opacity="0.18" stroke="${fc}" stroke-width="2"/><rect x="12" y="12" width="16" height="16" fill="${fc}"/></g>`;
  return page(D, g, { sky: skyline(id, D), voxels }, hud, L);
}

/** Pre-reveal image: an unlit Visitor-class silhouette on the deck. */
export function renderDormant() {
  const avatar = buildAvatar(null);
  const dim = { ...avatar, solid: avatar.solid.map(([x, y, z]) => [x, y, z, 0x1a1426]), glow: avatar.glow.map(([x, y, z]) => [x, y, z, 0x00f0ff]) };
  const { vox, cells } = buildScene(0, dim, DORMANT);
  const voxels = drawVoxels(vox, cells, { cx: 500, cy: 500, w: 640, h: 560 });
  const hud = `<g font-family="'Share Tech Mono', Consolas, 'Courier New', monospace" text-anchor="middle">
  <text x="500" y="860" font-size="56" font-weight="700" fill="#fff" letter-spacing="10">DORMANT</text>
  <text x="500" y="905" font-size="22" fill="#9a92c4" letter-spacing="6">OPENFORGE AX // AWAITING SEED</text></g>`;
  return page(DORMANT, "#ff2bd6", { sky: skyline(0, DORMANT), voxels }, hud, false);
}
