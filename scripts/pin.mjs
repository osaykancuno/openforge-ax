// Uploads a folder to IPFS via Pinata and prints the CID.
//   node scripts/pin.mjs art/out/images "openforge-images" [supply]   (PINATA_JWT in .env)
// Refuses to pin a folder that is not exactly 1.png … <supply>.png (supply: argument, option, or ../rarity.json),
// then fetches three images back through the gateway and compares sha256 with the local files.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, basename, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import "dotenv/config";
import { assertImageSet, verifyPinned } from "./lib/art-files.mjs";

/** The supply the folder must match: explicit, else the rarity.json art/generate.mjs wrote next to `images/`. */
function supplyFor(dir, supply) {
  if (supply !== undefined) return Number(supply);
  const rarity = join(dirname(dir), "rarity.json");
  if (existsSync(rarity)) return Number(JSON.parse(readFileSync(rarity, "utf8")).supply);
  throw new Error(`Cannot tell how many images ${dir} should hold: pass the supply, or keep rarity.json next to the folder`);
}

/**
 * Pins every file of `dir` as one folder; returns its CIDv1. Files are then at ipfs://<CID>/<file>.
 * The folder must be exactly 1.png … <supply>.png: anything else would be pinned forever under the base URI.
 */
export async function pinFolder(dir, name = basename(dir), { supply, fetchImpl } = {}) {
  const jwt = process.env.PINATA_JWT;
  if (!jwt) throw new Error("PINATA_JWT is missing in .env (free account at pinata.cloud → API Keys → New key → copy the JWT)");
  const n = supplyFor(dir, supply);
  const files = readdirSync(dir);
  assertImageSet(files, n, dir);
  const form = new FormData();
  for (const f of files) form.append("file", new Blob([readFileSync(join(dir, f))]), `${name}/${f}`);
  form.append("pinataMetadata", JSON.stringify({ name }));
  form.append("pinataOptions", JSON.stringify({ cidVersion: 1 }));
  console.log(`Uploading ${files.length} files to IPFS (${name})…`);
  const res = await fetch("https://api.pinata.cloud/pinning/pinFileToIPFS", { method: "POST", headers: { Authorization: `Bearer ${jwt}` }, body: form });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Pinata error ${res.status}: ${JSON.stringify(body)}`);
  const cid = body.IpfsHash;
  await verifyPinned({ cid, supply: n, readLocal: (f) => readFileSync(join(dir, f)), fetchImpl, gateway: process.env.IPFS_GATEWAY });
  return cid;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dir = process.argv[2];
  if (!dir) {
    console.error("Usage: node scripts/pin.mjs <folder> [name]");
    process.exit(1);
  }
  const cid = await pinFolder(dir, process.argv[3], { supply: process.argv[4] });
  console.log(`CID: ${cid}\nbaseURI to set: ipfs://${cid}/`);
}
