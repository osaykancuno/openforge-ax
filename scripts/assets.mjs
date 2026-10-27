// Pre-deploy assets in one command:  npm run assets
//  1. preview art + brand images (logo, banner, featured) and the "Dormant" placeholder
//  2. PROVENANCE_HASH (hash of the art generator) into .env
//  3. pins logo/banner/featured/placeholder to IPFS (with PINATA_JWT) and writes their ipfs:// links into .env;
//     without Pinata, the website serves them and .env gets https://<EXTERNAL_URL>/assets/… links
import { mkdirSync, copyFileSync, readFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { keccak256 } from "ethers";
import { pinFolder } from "./pin.mjs";
import { ensureEnv, setEnv } from "./lib/env-file.mjs";
import { GENERATOR_FILES } from "../art/token-render.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const node = (...args) => execFileSync(process.execPath, args, { cwd: root, stdio: "inherit" });
ensureEnv();
await import("dotenv/config");

node("art/generate.mjs", "--preview", "24");
node("scripts/build-web.mjs"); // vendor libs the brand render needs
node("scripts/brand.mjs"); // AX-1 logo, banner, featured, social, placeholder
node("scripts/build-web.mjs"); // copies the fresh placeholder, social card and favicon into web/, CSP

const art = join(root, "art");
const provenance = keccak256(Buffer.concat(GENERATOR_FILES.map((f) => readFileSync(join(root, f)))));
setEnv({ PROVENANCE_HASH: provenance });
console.log(`✔ PROVENANCE_HASH=${provenance}`);

const stage = join(art, "launch-assets");
rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });
copyFileSync(join(root, "web/assets/placeholder.png"), join(stage, "placeholder.png"));
for (const f of ["logo.png", "logo-1000.png", "banner.png", "featured.png", "x-header.png", "lockup.png", "og.png"]) copyFileSync(join(art, "brand", f), join(stage, f));
console.log("✔ Files for OpenSea Studio (upload them there too): art/launch-assets/");

if (!process.env.PINATA_JWT) {
  // no IPFS account: the website serves these files (web/assets/brand/ is published with the site)
  mkdirSync(join(root, "web/assets/brand"), { recursive: true });
  for (const f of ["logo-1000.png", "banner.png", "featured.png"]) copyFileSync(join(stage, f), join(root, "web/assets/brand", f));
  const site = (process.env.EXTERNAL_URL || "").replace(/\/$/, "");
  if (!/^https:\/\/[^/]+\.[^/]+/.test(site)) {
    console.log("\nNext: put the site's https:// address in .env as EXTERNAL_URL (or PINATA_JWT for IPFS), then run npm run assets again.");
    process.exit(0);
  }
  setEnv({
    PLACEHOLDER_IMAGE: `${site}/assets/placeholder.png`,
    COLLECTION_IMAGE: `${site}/assets/brand/logo-1000.png`,
    COLLECTION_BANNER: `${site}/assets/brand/banner.png`,
  });
  console.log(`✔ Image links point at ${site} (written to .env). Publish web/ before deploying.`);
  process.exit(0);
}
const cid = await pinFolder(stage, "openforge-launch-assets");
setEnv({
  PLACEHOLDER_IMAGE: `ipfs://${cid}/placeholder.png`,
  COLLECTION_IMAGE: `ipfs://${cid}/logo-1000.png`,
  COLLECTION_BANNER: `ipfs://${cid}/banner.png`,
});
console.log(`✔ Pinned: ipfs://${cid}/ → PLACEHOLDER_IMAGE, COLLECTION_IMAGE and COLLECTION_BANNER written to .env`);
