// Rust Docks district: deterministic layout + walkability grid. Pure module shared by client and server.
// Units: meters, 1 m grid cells, x east, z south, y up. Water lies along the north edge (low z).

export const DISTRICT = "rust-docks";
export const SIZE = 48;
export const SPAWN = { x: 24.5, z: 30.5 };
export const STATION = { x: 24.5, z: 19.5, r: 2.2, name: "Proving Grounds" };
export const MAX_SPEED = 4; // m/s, enforced by the server

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

const RUST = [0xb8400f, 0x8a3a1c, 0x1f6f6a, 0x2c313d, 0xc2a14b, 0x5a2a6b];
const NEON = [0xff2bd6, 0x00f0ff, 0xffe600, 0xff7a1a];

/** Builds the district once: boxes to render and the walkability grid. */
export function buildDistrict() {
  const r = rng(0xd0c55);
  const blocks = []; // {x, y, z, w, h, d, color, glow?}
  const blocked = new Uint8Array(SIZE * SIZE);
  const block = (x0, z0, w, d) => {
    for (let x = x0; x < x0 + w; x++) for (let z = z0; z < z0 + d; z++) if (x >= 0 && z >= 0 && x < SIZE && z < SIZE) blocked[z * SIZE + x] = 1;
  };

  // water channel + dock edge (north)
  blocks.push({ x: 0, y: -1.2, z: 0, w: SIZE, h: 0.2, d: 7, color: 0x041422 });
  block(0, 0, SIZE, 7);
  for (let x = 1; x < SIZE; x += 4) blocks.push({ x, y: 0, z: 7, w: 0.6, h: 0.5, d: 0.6, color: 0x2c313d });
  blocks.push({ x: 0, y: 0, z: 7, w: SIZE, h: 0.08, d: 0.15, color: 0xffe600, glow: true });

  // gantry cranes over the quay
  for (const cx of [8, 36]) {
    for (const [lx, lz] of [[cx, 8], [cx + 5, 8], [cx, 13], [cx + 5, 13]]) {
      blocks.push({ x: lx, y: 0, z: lz, w: 0.7, h: 9, d: 0.7, color: 0xc24e00 });
      block(lx, lz, 1, 1);
    }
    blocks.push({ x: cx, y: 9, z: 8, w: 5.7, h: 0.8, d: 0.7, color: 0xc24e00 }, { x: cx, y: 9, z: 13, w: 5.7, h: 0.8, d: 0.7, color: 0xc24e00 });
    blocks.push({ x: cx - 1, y: 9.8, z: 7, w: 7.7, h: 0.8, d: 7.7, color: 0x8a3a1c });
    blocks.push({ x: cx + 2.6, y: 4, z: 10.6, w: 0.08, h: 5.8, d: 0.08, color: 0x00f0ff, glow: true });
    blocks.push({ x: cx + 2, y: 3.3, z: 10, w: 1.4, h: 0.7, d: 1.4, color: 0x2c313d });
  }

  // container stacks (seeded), kept off the plaza and the station approach
  const free = (x, z, w, d) => {
    for (let i = x - 1; i <= x + w; i++) for (let j = z - 1; j <= z + d; j++) {
      if (i < 0 || j < 0 || i >= SIZE || j >= SIZE || blocked[j * SIZE + i]) return false;
      if (Math.hypot(i + 0.5 - STATION.x, j + 0.5 - STATION.z) < 6 || Math.hypot(i + 0.5 - SPAWN.x, j + 0.5 - SPAWN.z) < 6) return false;
      if (i >= 21 && i <= 27) return false; // main avenue
    }
    return true;
  };
  for (let n = 0; n < 160 && blocks.length < 260; n++) {
    const rot = r() < 0.5;
    const w = rot ? 1 : 3;
    const d = rot ? 3 : 1;
    const x = 1 + Math.floor(r() * (SIZE - 4));
    const z = 16 + Math.floor(r() * (SIZE - 18));
    if (!free(x, z, w, d)) continue;
    const levels = 1 + Math.floor(r() * 3);
    for (let l = 0; l < levels; l++) blocks.push({ x, y: l * 1.25, z, w, h: 1.2, d, color: RUST[Math.floor(r() * RUST.length)] });
    if (r() < 0.35) blocks.push({ x: x + (rot ? -0.02 : 0.3), y: levels * 1.25 - 0.9, z: z + (rot ? 0.3 : -0.02), w: rot ? 0.04 : 2.4, h: 0.35, d: rot ? 2.4 : 0.04, color: NEON[Math.floor(r() * NEON.length)], glow: true });
    block(x, z, w, d);
  }

  // Proving Grounds station
  blocks.push({ x: 19, y: 0, z: 13, w: 11, h: 5, d: 5, color: 0x14101f });
  blocks.push({ x: 19, y: 5, z: 13, w: 11, h: 0.3, d: 5, color: 0xff2bd6, glow: true });
  blocks.push({ x: 21, y: 3.4, z: 17.98, w: 7, h: 0.9, d: 0.05, color: 0xff2bd6, glow: true });
  blocks.push({ x: 23, y: 0, z: 17.98, w: 3, h: 2.6, d: 0.05, color: 0x00f0ff, glow: true });
  block(19, 13, 11, 5);
  blocks.push({ x: STATION.x - STATION.r, y: 0.02, z: STATION.z - STATION.r, w: STATION.r * 2, h: 0.04, d: STATION.r * 2, color: 0x00f0ff, glow: true, pad: true });

  // street lamps along the avenue
  for (let z = 22; z < SIZE; z += 6) for (const x of [20, 28]) {
    blocks.push({ x, y: 0, z, w: 0.3, h: 3.2, d: 0.3, color: 0x2c313d }, { x: x - 0.2, y: 3.2, z: z - 0.2, w: 0.7, h: 0.25, d: 0.7, color: 0xffe600, glow: true });
    block(x, z, 1, 1);
  }

  // perimeter fence
  for (let i = 0; i < SIZE; i++) {
    blocked[i] = blocked[(SIZE - 1) * SIZE + i] = blocked[i * SIZE] = blocked[i * SIZE + SIZE - 1] = 1;
  }
  blocks.push({ x: 0, y: 0, z: SIZE - 0.3, w: SIZE, h: 1.4, d: 0.3, color: 0x1d2029 }, { x: 0, y: 0, z: 7, w: 0.3, h: 1.4, d: SIZE - 7, color: 0x1d2029 }, { x: SIZE - 0.3, y: 0, z: 7, w: 0.3, h: 1.4, d: SIZE - 7, color: 0x1d2029 });

  const walkable = (x, z) => {
    const i = Math.floor(x);
    const j = Math.floor(z);
    return i >= 0 && j >= 0 && i < SIZE && j < SIZE && !blocked[j * SIZE + i];
  };
  return { blocks, walkable };
}

export const nearStation = (x, z) => Math.hypot(x - STATION.x, z - STATION.z) <= STATION.r;
