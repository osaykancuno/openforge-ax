// Usage:
//   node art/generate.mjs --preview 24                      # preview (dummy seed, 1 demo Prime Construct) + contact sheet
//   node art/generate.mjs --seed 0x<seed> --supply 1000     # final build (seed = on-chain OpenForgeAgents.seed())
//   ... --out <dir>                                         # write somewhere else than art/out (the rehearsal does)
//   ... --jobs <n>                                          # browsers drawing in parallel (default 3)
// Per token: images/<id>.png (the still) and images/<id>.gif (the animated token: the metadata's image).
import { mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import sharp from "sharp";
import { keccak256 } from "ethers";
import { traitsOf, legendaryIds, describe } from "./traits.mjs";
import { GENERATOR_FILES, createTokenRenderer } from "./token-render.mjs";
import { assertImageSet } from "../scripts/lib/art-files.mjs";

const argv = process.argv.slice(2);
const arg = (k) => {
  const i = argv.indexOf(`--${k}`);
  if (i < 0) return undefined;
  const v = argv[i + 1];
  return v === undefined || v.startsWith("--") ? true : v;
};
const here = dirname(fileURLToPath(import.meta.url));
const preview = arg("preview") !== undefined;
const supply = Number(preview ? (arg("preview") === true ? 24 : arg("preview")) : arg("supply"));
const seed = preview ? keccak256("0x4f70656e466f726765") : arg("seed");
const out = typeof arg("out") === "string" ? resolve(arg("out")) : join(here, preview ? "out-preview" : "out");
const jobs = Math.max(1, Math.min(8, Number(arg("jobs")) || 3));

if (!seed || !/^0x[0-9a-fA-F]{64}$/.test(seed) || !supply) {
  console.error("Requires --seed 0x<32 bytes> and --supply N (or --preview N).");
  process.exit(1);
}

// start clean: a leftover file from an earlier build would otherwise be pinned with the new ones
for (const d of ["images", "metadata", "agent-cards"]) {
  rmSync(join(out, d), { recursive: true, force: true });
  mkdirSync(join(out, d), { recursive: true });
}

const legends = preview ? [7] : legendaryIds(seed, supply);
const tokens = [];
const thumbs = [];
const counts = {};
const digests = []; // id -> { png, gif } sha256

// headless Chrome/Edge drawing the site's 3D models: one browser per job, each takes the next token
const renderers = await Promise.all(Array.from({ length: jobs }, () => createTokenRenderer()));
const t0 = Date.now();
let next = 1;
let done = 0;
async function worker(renderer) {
  for (let id; (id = next++) <= supply; ) {
    const t = traitsOf(seed, id, legends);
    const { png: still, gif } = await renderer.animate(id, t, describe(t));
    const png = await sharp(still).png({ compressionLevel: 9 }).toBuffer();
    writeFileSync(join(out, "images", `${id}.png`), png);
    writeFileSync(join(out, "images", `${id}.gif`), gif);
    digests[id] = { png: createHash("sha256").update(png).digest("hex"), gif: createHash("sha256").update(gif).digest("hex") };
    if (preview) thumbs[id - 1] = await sharp(png).resize(300, 300).toBuffer();
    if (++done % 50 === 0 || done === supply) console.log(`  ${done}/${supply} tokens (${Math.round((Date.now() - t0) / 1000)} s)`);
  }
}
try {
  await Promise.all(renderers.map(worker));
} finally {
  await Promise.all(renderers.map((r) => r.close()));
}

for (let id = 1; id <= supply; id++) {
  const info = describe(traitsOf(seed, id, legends));
  const { name, ...attrs } = info;
  const label = `AX-${String(id).padStart(4, "0")} // ${name}`;
  // off-chain copy of the static traits (the official tokenURI is generated on-chain by the renderer)
  writeFileSync(
    join(out, "metadata", `${id}.json`),
    JSON.stringify({ name: label, image: `ipfs://__IMAGES_CID__/${id}.gif`, attributes: Object.entries(attrs).map(([trait_type, value]) => ({ trait_type, value })) }, null, 2)
  );
  // ERC-8004 registration file (check the official schema before use)
  writeFileSync(
    join(out, "agent-cards", `${id}.json`),
    JSON.stringify({ type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1", name: label, description: `${info.Class} embodied agent — ${info.Faction}.`, image: `ipfs://__IMAGES_CID__/${id}.gif`, services: [], active: true, registrations: [] }, null, 2)
  );

  tokens.push({ id, name: label, sha256: digests[id].png, gifSha256: digests[id].gif, ...attrs });
  for (const [k, v] of Object.entries(attrs)) {
    counts[k] ??= {};
    counts[k][v] = (counts[k][v] ?? 0) + 1;
  }
}

assertImageSet(readdirSync(join(out, "images")), supply, join(out, "images")); // exactly 1..supply.png + .gif, before anything is pinned

// rarity score (sum of 1/frequency of each trait), used by the site to sort the gallery
for (const tk of tokens) {
  tk.rarityScore = Number(Object.entries(tk).filter(([k]) => counts[k]).reduce((s, [k, v]) => s + supply / counts[k][v], 0).toFixed(2));
}
[...tokens].sort((a, b) => b.rarityScore - a.rarityScore).forEach((tk, i) => (tk.rank = i + 1));

if (preview) {
  const cols = 6;
  const rows = Math.ceil(supply / cols);
  await sharp({ create: { width: cols * 300, height: rows * 300, channels: 3, background: "#f4efe6" } })
    .composite(thumbs.map((input, i) => ({ input, left: (i % cols) * 300, top: Math.floor(i / cols) * 300 })))
    .png()
    .toFile(join(out, "contact-sheet.png"));
}

// provenance covers every file that decides how an agent looks (traits, the render page and the 3D models)
const generatorHash = keccak256(Buffer.concat(GENERATOR_FILES.map((f) => readFileSync(join(here, "..", f)))));
writeFileSync(join(out, "rarity.json"), JSON.stringify({ seed, supply, legendaries: legends, generatorHash, distribution: counts, tokens }, null, 1));
console.log(`OK: ${supply} agents in ${out}\ngeneratorHash (provenance): ${generatorHash}\nPrime Constructs: ${legends.join(", ") || "-"}`);
