// Uploads a folder to IPFS via Pinata and prints the CID.
//   node scripts/pin.mjs art/out/images "openforge-images"     (PINATA_JWT in .env)
import { readdirSync, readFileSync } from "node:fs";
import { join, basename } from "node:path";
import { fileURLToPath } from "node:url";
import "dotenv/config";

/** Pins every file of `dir` as one folder; returns its CIDv1. Files are then at ipfs://<CID>/<file>. */
export async function pinFolder(dir, name = basename(dir)) {
  const jwt = process.env.PINATA_JWT;
  if (!jwt) throw new Error("PINATA_JWT is missing in .env (free account at pinata.cloud → API Keys → New key → copy the JWT)");
  const files = readdirSync(dir).filter((f) => !f.startsWith("."));
  const form = new FormData();
  for (const f of files) form.append("file", new Blob([readFileSync(join(dir, f))]), `${name}/${f}`);
  form.append("pinataMetadata", JSON.stringify({ name }));
  form.append("pinataOptions", JSON.stringify({ cidVersion: 1 }));
  console.log(`Uploading ${files.length} files to IPFS (${name})…`);
  const res = await fetch("https://api.pinata.cloud/pinning/pinFileToIPFS", { method: "POST", headers: { Authorization: `Bearer ${jwt}` }, body: form });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Pinata error ${res.status}: ${JSON.stringify(body)}`);
  return body.IpfsHash;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dir = process.argv[2];
  if (!dir) {
    console.error("Usage: node scripts/pin.mjs <folder> [name]");
    process.exit(1);
  }
  const cid = await pinFolder(dir, process.argv[3]);
  console.log(`CID: ${cid}\nbaseURI to set: ipfs://${cid}/`);
}
