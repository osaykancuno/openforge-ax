// Deterministic voxel avatars from on-chain trait indices (same order as AgentRenderer.traitsOf).
// Pure module, single source of truth for how an agent looks: Neo-Forge renders it in 3D (world-view.js) and the
// Neo-Forge is retired; the NFT art no longer uses these voxels (art/token-render.mjs draws the 3D lab models).

export const VOXEL = 0.12; // meters per avatar voxel

// front-top of each class's "head" (where its sensors sit), in avatar voxel coordinates
const HEAD = [[0, 8, 6], [0, 9, -1], [0, 8, 6], [0, 9, 1], [0, 7, 1], [0, 7, 2], [0, 10, 3], [0, 13, 1]];

/** Sensor trait: Optic (built-in eye), Stereo Depth, Haptic, Lidar Halo, Omni Array. Never overlaps a solid voxel. */
function sensorVoxels(cls, sensor, g, solid) {
  if (cls < 0) return;
  const [x, y, z] = HEAD[cls];
  const taken = new Set(solid.map((v) => `${v[0]},${v[1]},${v[2]}`));
  const put = (a, b, c) => taken.has(`${a},${b},${c}`) || g(a, b, c);
  if (sensor === 1) [-1, 1].forEach((d) => put(x + d, y, z + 1));
  else if (sensor === 2) [-1, 0, 1].forEach((d) => put(x + d, y - 1, z + 1));
  else if (sensor === 3) for (let a = 0; a < 8; a++) put(x + Math.round(2 * Math.cos((a * Math.PI) / 4)), y + 1, z - 1 + Math.round(2 * Math.sin((a * Math.PI) / 4)));
  else if (sensor === 4) [[2, 0], [-2, 0], [0, 2], [0, -2]].forEach(([dx, dz]) => put(x + dx, y + 1, z - 1 + dz));
}

const FINISH = [0x1d2029, 0xd9dde6, 0xff6a00, 0x2453ff, 0x2bd46b, 0xd1132f, 0xc9d3e6];
const FINISH_MID = [0x2c313d, 0xa9b0bf, 0xc24e00, 0x173bc0, 0x1b9c4c, 0x8f0c20, 0x8792ab];
const CORE = [0x00f0ff, 0x39ff14, 0xffb000, 0xff2bd6];
export const FACTION = [0x9aa3b5, 0xff7a1a, 0x00f0ff, 0xb026ff, 0xe9e6ff];
const GOLD = 0xf5c542;
const GOLD_MID = 0xb8860b;
const DARK = 0x0b0d12;

/**
 * @param {object} t trait indices {class_, core, finish, augment, faction, legendary, sensor?} or null for a Visitor
 * @returns {{solid: number[][], glow: number[][], height: number}} voxels as [x, y, z, color]; +z is forward
 */
export function buildAvatar(t) {
  const solid = [];
  const glow = [];
  const L = t && t.legendary > 0;
  const body = !t ? 0x3a3f4c : L ? GOLD : FINISH[t.finish];
  const mid = !t ? 0x2a2e38 : L ? GOLD_MID : FINISH_MID[t.finish];
  const core = !t ? 0xffffff : L ? 0xffcc33 : CORE[t.core];
  const box = (x0, x1, y0, y1, z0, z1, c, into = solid) => {
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) into.push([x, y, z, c]);
  };
  const g = (x, y, z, c = core) => glow.push([x, y, z, c]);

  const cls = t ? t.class_ : -1;
  switch (cls) {
    case 0: // Synth Arm on a tracked base
      box(-3, 3, 0, 1, -3, 3, DARK);
      box(-2, 2, 2, 3, -2, 2, mid);
      box(-1, 1, 4, 9, -1, 1, body);
      box(-1, 1, 9, 10, 0, 5, body);
      box(-1, 1, 7, 8, 5, 6, mid);
      box(-1, -1, 5, 6, 7, 7, mid);
      box(1, 1, 5, 6, 7, 7, mid);
      g(0, 6, 6);
      g(0, 3, 3);
      break;
    case 1: // Street Rover
      box(-3, 3, 2, 3, -4, 4, body);
      for (const [x, z] of [[-4, -3], [4, -3], [-4, 3], [4, 3]]) box(x, x, 0, 2, z - 1, z + 1, DARK);
      box(0, 0, 4, 7, -2, -2, mid);
      box(-1, 1, 8, 9, -3, -1, body);
      g(0, 9, 0);
      g(0, 3, 5);
      break;
    case 2: // Cyber Hound
      for (const [x, z] of [[-2, -3], [2, -3], [-2, 3], [2, 3]]) box(x, x, 0, 3, z, z, mid);
      box(-2, 2, 4, 6, -4, 4, body);
      box(-1, 1, 5, 8, 4, 6, body);
      box(0, 0, 6, 8, -6, -5, mid);
      g(-1, 7, 7);
      g(1, 7, 7);
      g(0, 5, 0);
      break;
    case 3: // Ghost Hand on two legs
      box(-2, -2, 0, 3, 0, 0, mid);
      box(2, 2, 0, 3, 0, 0, mid);
      box(-3, 3, 4, 9, -1, 1, body);
      for (const x of [-3, -1, 1, 3]) box(x, x, 10, 13, 0, 0, body);
      box(-5, -4, 6, 7, 0, 0, body);
      for (const x of [-3, -1, 1, 3]) g(x, 14, 0);
      g(0, 6, 2);
      break;
    case 4: // Spider Mech
      box(-2, 2, 4, 5, -2, 2, body);
      for (const s of [-1, 1]) for (const z of [-2, 0, 2]) {
        box(s * 3, s * 3, 4, 4, z, z, mid);
        box(s * 4, s * 4, 2, 3, z, z, mid);
        box(s * 5, s * 5, 0, 1, z, z, mid);
      }
      box(-1, 1, 6, 7, -1, 1, body);
      g(0, 7, 2);
      g(0, 5, 3);
      break;
    case 5: // Sky Drone (hovers)
      box(-2, 2, 6, 7, -2, 2, body);
      for (const [x, z] of [[-4, -4], [4, -4], [-4, 4], [4, 4]]) {
        box(Math.sign(x) * 3, Math.sign(x) * 3, 7, 7, Math.sign(z) * 3, Math.sign(z) * 3, mid);
        box(x - 1, x + 1, 8, 8, z - 1, z + 1, core, glow);
      }
      box(0, 0, 4, 5, 0, 0, DARK);
      g(0, 4, 1);
      break;
    case 6: // Fab Rig on treads
      box(-3, 3, 0, 1, -3, 3, DARK);
      for (const [x, z] of [[-3, -3], [3, -3], [-3, 3], [3, 3]]) box(x, x, 2, 9, z, z, mid);
      box(-3, 3, 10, 10, -3, 3, body);
      box(-1, 1, 6, 9, -1, 1, body);
      g(0, 5, 0);
      g(0, 4, 0);
      break;
    case 7: // Replicant
      box(-2, -1, 0, 4, -1, 0, mid);
      box(1, 2, 0, 4, -1, 0, mid);
      box(-3, 3, 5, 10, -1, 1, body);
      box(-4, -4, 5, 9, -1, 0, mid);
      box(4, 4, 5, 9, -1, 0, mid);
      box(-1, 1, 11, 13, -1, 1, body);
      g(-1, 12, 2);
      g(1, 12, 2);
      g(0, 8, 2);
      break;
    default: // Visitor drone
      box(-1, 1, 6, 8, -1, 1, body);
      box(-2, 2, 9, 9, -2, 2, mid);
      g(0, 7, 2, 0xffffff);
      g(0, 5, 0, 0x9a92c4);
  }

  const height = Math.max(...solid.map((v) => v[1]), ...glow.map((v) => v[1])) + 1;
  if (t) {
    // faction badge on the chest, augment on top
    const by = Math.max(2, Math.floor(height / 2));
    let bz = -4 + (cls === 2 ? 9 : cls === 1 ? 9 : 6);
    while (solid.some((v) => v[0] === 0 && v[1] === by && v[2] === bz)) bz++; // on the surface, never inside the body
    g(0, by, bz, FACTION[L ? 4 : t.faction]);
    const top = height;
    if (L) {
      for (let a = 0; a < 12; a++) g(Math.round(3 * Math.cos((a * Math.PI) / 6)), top + 1, Math.round(3 * Math.sin((a * Math.PI) / 6)), 0xffcc33);
      for (const [x, z] of [[0, 3], [3, 0], [0, -3], [-3, 0]]) g(x, top + 2, z, 0xffcc33);
    } else if (t.augment === 1) {
      box(0, 0, top, top + 2, 0, 0, 0x9aa3b5);
      g(0, top + 3, 0);
    } else if (t.augment === 2) {
      for (let a = 0; a < 12; a++) g(Math.round(3 * Math.cos((a * Math.PI) / 6)), top + 1, Math.round(3 * Math.sin((a * Math.PI) / 6)));
    } else if (t.augment === 3) {
      box(0, 0, 2, top - 1, -5, -5, DARK);
      g(0, top - 2, -5);
    } else if (t.augment === 4) {
      for (let x = -2; x <= 2; x++) g(x, top - 1, 3);
    } else if (t.augment === 5) {
      box(-2, -2, top - 3, top, -3, -3, 0x20232c);
      box(2, 2, top - 3, top, -3, -3, 0x20232c);
      solid.push([-2, top + 1, -3, 0x6b7080], [2, top + 1, -3, 0x6b7080]);
    }
  }
  // sensors last: they never move the badge or the augments, and never sit inside a solid voxel
  if (t && Number.isInteger(t.sensor)) sensorVoxels(cls, t.sensor, g, solid);
  return { solid, glow, height: Math.max(...solid.map((v) => v[1]), ...glow.map((v) => v[1])) + 1, hovers: cls === 5 || cls === -1 };
}
