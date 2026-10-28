// QR codes for "scan this with your phone" (My IRL lab's desktop card). No library, no network: byte mode (UTF-8),
// error correction M (about 15 % of the code may be damaged) or H (about 30 %: room for a logo in the middle),
// versions 1–10 (up to 213 bytes at M, 119 at H: plenty for a page URL).
// Follows ISO/IEC 18004: Reed-Solomon over GF(256) with 0x11D, the eight masks, the four penalty rules. Cross-checked
// against the npm "qrcode" encoder and the jsQR decoder (2026-10-28); test/Qr.test.js keeps the structure honest.

// versions 1..10 (index 0 unused): error-correction codewords per block, number of blocks; format = the level's 2 bits
const LEVELS = {
  M: { format: 0b00, ecc: [0, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26], blocks: [0, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5] },
  H: { format: 0b10, ecc: [0, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28], blocks: [0, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8] },
};
const MAX_VERSION = 10;

/** codewords that carry data or error correction in a version (everything but the function patterns), in bytes */
function rawCodewords(ver) {
  let bits = (16 * ver + 128) * ver + 64;
  if (ver >= 2) {
    const n = Math.floor(ver / 7) + 2;
    bits -= (25 * n - 10) * n - 55;
    if (ver >= 7) bits -= 36;
  }
  return Math.floor(bits / 8);
}
const dataCodewords = (ver, L) => rawCodewords(ver) - L.ecc[ver] * L.blocks[ver];

/** centres of the alignment patterns along one axis */
function alignmentCentres(ver) {
  if (ver === 1) return [];
  const n = Math.floor(ver / 7) + 2;
  const step = Math.floor((ver * 8 + n * 3 + 5) / (n * 4 - 4)) * 2;
  const out = [6];
  for (let pos = ver * 4 + 10; out.length < n; pos -= step) out.splice(1, 0, pos);
  return out;
}

// ---------------------------------------------------------------- Reed-Solomon over GF(256), polynomial 0x11D
function gfMul(x, y) {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z;
}
function rsDivisor(degree) {
  const out = new Array(degree).fill(0);
  out[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      out[j] = gfMul(out[j], root);
      if (j + 1 < degree) out[j] ^= out[j + 1];
    }
    root = gfMul(root, 2);
  }
  return out;
}
function rsRemainder(data, divisor) {
  const out = divisor.map(() => 0);
  for (const b of data) {
    const factor = b ^ out.shift();
    out.push(0);
    divisor.forEach((d, i) => { out[i] ^= gfMul(d, factor); });
  }
  return out;
}

/** the data bytes, padded, split into blocks, each with its error correction, interleaved as the symbol reads them */
function codewords(bytes, ver, L) {
  const capacity = dataCodewords(ver, L);
  const bits = [];
  const put = (val, len) => { for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1); };
  put(0b0100, 4); // byte mode
  put(bytes.length, ver < 10 ? 8 : 16);
  for (const b of bytes) put(b, 8);
  put(0, Math.min(4, capacity * 8 - bits.length)); // terminator
  put(0, (8 - (bits.length % 8)) % 8);
  for (let pad = 0xec; bits.length < capacity * 8; pad ^= 0xec ^ 0x11) put(pad, 8);
  const data = [];
  for (let i = 0; i < bits.length; i += 8) data.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0));

  const nBlocks = L.blocks[ver];
  const eccLen = L.ecc[ver];
  const raw = rawCodewords(ver);
  const nShort = nBlocks - (raw % nBlocks);
  const shortData = Math.floor(raw / nBlocks) - eccLen;
  const divisor = rsDivisor(eccLen);
  const blocks = [];
  for (let i = 0, at = 0; i < nBlocks; i++) {
    const len = shortData + (i < nShort ? 0 : 1);
    const d = data.slice(at, at + len);
    at += len;
    blocks.push({ d, e: rsRemainder(d, divisor) });
  }
  const out = [];
  for (let i = 0; i <= shortData; i++) for (const b of blocks) if (i < b.d.length) out.push(b.d[i]);
  for (let i = 0; i < eccLen; i++) for (const b of blocks) out.push(b.e[i]);
  return out;
}

// ---------------------------------------------------------------- the symbol
const MASKS = [
  (x, y) => (x + y) % 2 === 0,
  (x, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

function drawFunctionPatterns(m, fn, ver, L) {
  const size = m.length;
  const set = (x, y, dark) => { m[y][x] = dark; fn[y][x] = true; };
  for (let i = 0; i < size; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); } // timing
  for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]]) { // finders and their light separators
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const x = cx + dx, y = cy + dy;
        const d = Math.max(Math.abs(dx), Math.abs(dy));
        if (x >= 0 && x < size && y >= 0 && y < size) set(x, y, d !== 2 && d !== 4);
      }
    }
  }
  const al = alignmentCentres(ver);
  for (let i = 0; i < al.length; i++) {
    for (let j = 0; j < al.length; j++) {
      if ((i === 0 && j === 0) || (i === 0 && j === al.length - 1) || (i === al.length - 1 && j === 0)) continue; // finders
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(al[i] + dx, al[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }
  }
  drawFormat(m, fn, L, 0); // reserves the cells; the real bits are drawn once the mask is chosen
  if (ver >= 7) {
    let rem = ver;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const bits = (ver << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const dark = ((bits >>> i) & 1) === 1;
      const a = size - 11 + (i % 3), b = Math.floor(i / 3);
      set(a, b, dark);
      set(b, a, dark);
    }
  }
}

/** the 15 format bits (the level's 2 bits, then the mask), both copies, plus the dark module */
function drawFormat(m, fn, L, mask) {
  const size = m.length;
  const data = (L.format << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  const bits = ((data << 10) | rem) ^ 0x5412;
  const bit = (i) => ((bits >>> i) & 1) === 1;
  const set = (x, y, dark) => { m[y][x] = dark; fn[y][x] = true; };
  for (let i = 0; i <= 5; i++) set(8, i, bit(i));
  set(8, 7, bit(6));
  set(8, 8, bit(7));
  set(7, 8, bit(8));
  for (let i = 9; i < 15; i++) set(14 - i, 8, bit(i));
  for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(i));
  for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(i));
  set(8, size - 8, true);
}

function drawCodewords(m, fn, words) {
  const size = m.length;
  let i = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5; // the vertical timing column is skipped
    const upward = ((right + 1) & 2) === 0;
    for (let vert = 0; vert < size; vert++) {
      const y = upward ? size - 1 - vert : vert;
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        if (fn[y][x]) continue;
        m[y][x] = i < words.length * 8 && ((words[i >>> 3] >>> (7 - (i & 7))) & 1) === 1;
        i++;
      }
    }
  }
}

function applyMask(m, fn, mask) {
  for (let y = 0; y < m.length; y++) for (let x = 0; x < m.length; x++) if (!fn[y][x] && MASKS[mask](x, y)) m[y][x] = !m[y][x];
}

const FINDER_AFTER = "10111010000"; // a finder look-alike with 4 light modules after it
const FINDER_BEFORE = "00001011101"; // ... and before it

/** ISO 18004 penalty: long runs, 2×2 blocks, finder look-alikes (1:1:3:1:1 with 4 light beside), dark balance */
function penalty(m) {
  const size = m.length;
  let score = 0;
  const line = (get) => {
    let run = 1;
    for (let i = 1; i <= size; i++) {
      if (i < size && get(i) === get(i - 1)) run++;
      else { if (run >= 5) score += run - 2; run = 1; }
    }
    for (let i = 0; i + 11 <= size; i++) {
      let a = true, b = true;
      for (let k = 0; k < 11; k++) {
        const d = get(i + k);
        if (d !== (FINDER_AFTER[k] === "1")) a = false;
        if (d !== (FINDER_BEFORE[k] === "1")) b = false;
      }
      if (a) score += 40;
      if (b) score += 40;
    }
  };
  for (let y = 0; y < size; y++) line((x) => m[y][x]);
  for (let x = 0; x < size; x++) line((y) => m[y][x]);
  let dark = 0;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (m[y][x]) dark++;
      if (x + 1 < size && y + 1 < size && m[y][x] === m[y][x + 1] && m[y][x] === m[y + 1][x] && m[y][x] === m[y + 1][x + 1]) score += 3;
    }
  }
  const total = size * size;
  score += (Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1) * 10;
  return score;
}

/**
 * The QR symbol for `text` as rows of booleans (true = dark), without the quiet zone.
 * @param {string} text
 * @param {{ mask?: number, level?: "M" | "H" }} [opts] level M by default; mask: force one of the 8 (tests), otherwise
 *   the lowest penalty wins
 * @returns {{ version: number, mask: number, size: number, modules: boolean[][] }}
 */
export function qrEncode(text, opts = {}) {
  const L = LEVELS[opts.level || "M"];
  if (!L) throw new RangeError(`QR: unknown level ${opts.level}`);
  const bytes = [...new TextEncoder().encode(String(text))];
  let ver = 1;
  while (ver <= MAX_VERSION && 4 + (ver < 10 ? 8 : 16) + bytes.length * 8 > dataCodewords(ver, L) * 8) ver++;
  if (ver > MAX_VERSION) throw new RangeError(`QR: ${bytes.length} bytes is too long (at most ${dataCodewords(MAX_VERSION, L) - 3})`);
  const size = ver * 4 + 17;
  const grid = () => Array.from({ length: size }, () => new Array(size).fill(false));
  const base = grid();
  const fn = grid();
  drawFunctionPatterns(base, fn, ver, L);
  drawCodewords(base, fn, codewords(bytes, ver, L));

  const masks = opts.mask === undefined ? [0, 1, 2, 3, 4, 5, 6, 7] : [opts.mask];
  let best = null;
  for (const mask of masks) {
    const m = base.map((row) => row.slice());
    applyMask(m, fn, mask);
    drawFormat(m, fn.map((row) => row.slice()), L, mask);
    const score = penalty(m);
    if (!best || score < best.score) best = { score, mask, modules: m };
  }
  return { version: ver, mask: best.mask, size, modules: best.modules };
}

/**
 * The symbol as one SVG path (dark modules), with a 4-module quiet zone: `viewBox` is `0 0 n n`, scale it with CSS.
 * @param {string} text
 * @returns {{ viewBox: string, d: string, size: number }}
 */
export function qrPath(text) {
  const { modules, size } = qrEncode(text);
  const n = size + 8;
  let d = "";
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (!modules[y][x]) continue;
      let w = 1;
      while (x + w < size && modules[y][x + w]) w++;
      d += `M${x + 4} ${y + 4}h${w}v1h-${w}z`;
      x += w - 1;
    }
  }
  return { viewBox: `0 0 ${n} ${n}`, d, size: n };
}

/**
 * The branded symbol (My IRL lab's card): level H, so the middle can hold the AX-1 mark. Data modules become rounded
 * pills (one per horizontal run), the three finders rounded "eyes"; nothing is drawn in the square hole, where the page
 * puts the logo on white. Everything is in module units with a 4-module quiet zone (`viewBox` `0 0 n n`).
 * @param {string} text
 * @returns {{ viewBox: string, size: number, version: number, modules: string, eyes: string,
 *   hole: { x: number, y: number, w: number }, runs: { x: number, y: number, w: number }[] }}
 */
export function qrArt(text) {
  const { modules: m, size, version } = qrEncode(text, { level: "H" });
  let w = Math.round(size * 0.27);
  if (w % 2 === 0) w--; // odd: centred on the middle module
  const h0 = (size - w) / 2;
  const inFinder = (x, y) => (x < 8 && y < 8) || (x >= size - 8 && y < 8) || (x < 8 && y >= size - 8);
  const inHole = (x, y) => x >= h0 - 1 && x < h0 + w + 1 && y >= h0 - 1 && y < h0 + w + 1; // plus one module of margin
  const runs = [];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (!m[y][x] || inFinder(x, y) || inHole(x, y)) continue;
      let len = 1;
      while (x + len < size && m[y][x + len] && !inFinder(x + len, y) && !inHole(x + len, y)) len++;
      runs.push({ x: x + 4, y: y + 4, w: len });
      x += len - 1;
    }
  }
  const t = 0.08; // a pill is 0.84 tall: the gaps between rows keep the modules readable as separate rows
  const r = 0.5 - t;
  const pill = ({ x, y, w: len }) => `M${x + r + t} ${y + t}h${len - 2 * (r + t)}a${r} ${r} 0 0 1 0 ${2 * r}h${-(len - 2 * (r + t))}a${r} ${r} 0 0 1 0 ${-2 * r}z`;
  const round = (x, y, s, rad) => `M${x + rad} ${y}h${s - 2 * rad}a${rad} ${rad} 0 0 1 ${rad} ${rad}v${s - 2 * rad}a${rad} ${rad} 0 0 1 ${-rad} ${rad}h${-(s - 2 * rad)}a${rad} ${rad} 0 0 1 ${-rad} ${-rad}v${-(s - 2 * rad)}a${rad} ${rad} 0 0 1 ${rad} ${-rad}z`;
  // counter-clockwise inner square, so the ring has a hole with the default nonzero fill
  const roundCcw = (x, y, s, rad) => `M${x + rad} ${y}a${rad} ${rad} 0 0 0 ${-rad} ${rad}v${s - 2 * rad}a${rad} ${rad} 0 0 0 ${rad} ${rad}h${s - 2 * rad}a${rad} ${rad} 0 0 0 ${rad} ${-rad}v${-(s - 2 * rad)}a${rad} ${rad} 0 0 0 ${-rad} ${-rad}z`;
  let eyes = "";
  for (const [fx, fy] of [[0, 0], [size - 7, 0], [0, size - 7]]) {
    const x = fx + 4, y = fy + 4;
    eyes += round(x, y, 7, 2.2) + roundCcw(x + 1, y + 1, 5, 1.5) + round(x + 2, y + 2, 3, 1);
  }
  const n = size + 8;
  return { viewBox: `0 0 ${n} ${n}`, size: n, version, modules: runs.map(pill).join(""), eyes, hole: { x: h0 + 4, y: h0 + 4, w }, runs };
}
