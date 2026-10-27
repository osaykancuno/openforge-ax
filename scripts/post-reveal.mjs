// After the reveal, in one command:  npm run post-reveal -- sepolia   (or mainnet)
//  reads the on-chain seed and supply → generates the 1,024 images → pins them to IPFS (PINATA_JWT) or, without
//  Pinata, puts them in web/images/ for the website → sets the base URI (finalize.js, without freezing) →
//  copies rarity.json to the site.
// Then check tokens on OpenSea, and freeze with: $env:FREEZE="true"; npm run finalize:<network>
import { readFileSync, rmSync, cpSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { Contract, JsonRpcProvider, ZeroHash } from "ethers";
import "dotenv/config";
import { pinFolder } from "./pin.mjs";
import { setEnv } from "./lib/env-file.mjs";

const NETWORKS = {
  sepolia: { chainId: 11155111, rpc: process.env.SEPOLIA_RPC_URL || "https://ethereum-sepolia-rpc.publicnode.com" },
  mainnet: { chainId: 1, rpc: process.env.MAINNET_RPC_URL || "https://ethereum-rpc.publicnode.com" },
};
const name = process.argv[2];
const net = NETWORKS[name];
if (!net) throw new Error("Usage: npm run post-reveal -- sepolia|mainnet");

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dep = JSON.parse(readFileSync(join(root, `deployments-${net.chainId}.json`), "utf8"));
const agents = new Contract(dep.agents, ["function seed() view returns (bytes32)", "function totalSupply() view returns (uint256)"], new JsonRpcProvider(net.rpc, net.chainId, { staticNetwork: true }));
const [seed, supply] = await Promise.all([agents.seed(), agents.totalSupply()]);
if (seed === ZeroHash) throw new Error(`Not revealed yet: run npm run reveal:${name} first`);

const run = (cmd, args, env = {}) => execFileSync(cmd, args, { cwd: root, stdio: "inherit", env: { ...process.env, ...env }, shell: process.platform === "win32" });
run(process.execPath, ["art/generate.mjs", "--seed", seed, "--supply", String(supply)]);

let target;
if (process.env.PINATA_JWT) {
  const cid = await pinFolder(join(root, "art/out/images"), `openforge-images-${name}`);
  setEnv({ IMAGES_CID: cid, BASE_URI: "" });
  target = { IMAGES_CID: cid, BASE_URI: "" };
  console.log(`✔ Images pinned: ipfs://${cid}/ (IMAGES_CID saved in .env)`);
} else {
  // no IPFS account: the website serves the images (they can always be rebuilt from the on-chain seed)
  const site = (process.env.EXTERNAL_URL || "").replace(/\/$/, "");
  if (!/^https:\/\/[^/]+\.[^/]+/.test(site)) throw new Error("Set EXTERNAL_URL (the site's https:// address) in .env, or PINATA_JWT to use IPFS");
  rmSync(join(root, "web/images"), { recursive: true, force: true });
  cpSync(join(root, "art/out/images"), join(root, "web/images"), { recursive: true });
  target = { BASE_URI: `${site}/images/`, IMAGES_CID: "" };
  setEnv(target);
  console.log(`✔ Images copied to web/images/ → served at ${target.BASE_URI}. Publish web/ BEFORE the next step shows on OpenSea.`);
}
run("npx", ["hardhat", "run", "scripts/finalize.js", "--network", name], { ...target, FREEZE: "" });
run(process.execPath, ["scripts/build-web.mjs"]);
console.log(`\nNext: ${target.BASE_URI ? "publish web/ (it now contains the images), then " : ""}on OpenSea "Refresh metadata" on ~10 agents (Prime Constructs included).`);
console.log(target.BASE_URI
  ? `Freeze only if you will keep the domain forever: $env:FREEZE="true"; $env:FREEZE_HTTPS="yes"; npm run finalize:${name}  (or keep it unfrozen and move to IPFS later)`
  : `If all is right: $env:FREEZE="true"; npm run finalize:${name}`);
