// After reveal + art generation + IPFS upload, in two runs:
//   IMAGES_CID=bafy... npx hardhat run scripts/finalize.js --network mainnet          (sets the base URI; then check OpenSea)
//   IMAGES_CID=bafy... FREEZE=true npx hardhat run scripts/finalize.js --network ...  (locks the renderer and FREEZES: irreversible)
// FREEZE refuses to run unless the base URI is already this CID, so nothing is frozen unchecked.
// Without IPFS: BASE_URI=https://<site>/images/ serves the images from the website (npm run post-reveal does this
// when there is no PINATA_JWT). Freezing an https base URI ties the images to that domain forever, so it also
// needs FREEZE_HTTPS=yes.
// If an owner is a Safe, this script only prints the calldata, in execution order; sign from the Safe.
const { ethers } = require("hardhat");
require("./lib/nonce-guard");
const fs = require("fs");

async function main() {
  const { IMAGES_CID, BASE_URI, FREEZE, FREEZE_HTTPS } = process.env;
  const https = Boolean(BASE_URI);
  if (https && !/^https:\/\/[^/\s"\\]+\/[^\s"\\]*\/$/.test(BASE_URI)) throw new Error("BASE_URI must be https://<site>/<folder>/ (with the final /)");
  if (!https && !/^[a-zA-Z0-9]{46,100}$/.test(IMAGES_CID || "")) throw new Error("Set IMAGES_CID (a bare IPFS CID) or BASE_URI (https://<site>/images/)");
  const freeze = FREEZE === "true";
  if (freeze && https && FREEZE_HTTPS !== "yes") {
    throw new Error("Freezing an https base URI ties every image to that domain forever. Prefer IPFS, or set FREEZE_HTTPS=yes if you will keep the domain.");
  }
  const { chainId } = await ethers.provider.getNetwork();
  const dep = JSON.parse(fs.readFileSync(`deployments-${chainId}.json`, "utf8"));
  const agents = await ethers.getContractAt("OpenForgeAgents", dep.agents);
  const renderer = await ethers.getContractAt("AgentRenderer", await agents.renderer());
  const uri = https ? BASE_URI : `ipfs://${IMAGES_CID}/`;
  const [signer] = await ethers.getSigners();
  const me = signer.address.toLowerCase();
  const ownsAgents = (await agents.owner()).toLowerCase() === me;
  const ownsRenderer = (await renderer.owner()).toLowerCase() === me;
  const needsLock = freeze && !(await renderer.locked());
  if (freeze) {
    if ((await agents.seed()) === ethers.ZeroHash) throw new Error("Reveal first: freezeMetadata needs the seed");
    if ((await agents.baseURI()) !== uri) throw new Error(`Run without FREEZE first and check OpenSea: the base URI is not ${uri}`);
    if ((await agents.reputation()) === ethers.ZeroAddress) throw new Error("Set the reputation source first: a freeze would disable it forever");
    if (needsLock && (!(await renderer.placeholderImage()) || !(await renderer.externalUrl()) || !(await renderer.license()))) {
      throw new Error("Complete AgentRenderer.setPresentation first: it can never change after the lock");
    }
  }

  const calls = freeze
    ? [...(needsLock ? [[renderer, "lock"]] : []), [agents, "freezeMetadata"]] // freezeMetadata reverts until the renderer is locked
    : [[agents, "setBaseURI", [uri]]];
  if (!ownsAgents || (needsLock && !ownsRenderer)) {
    console.log("Not every owner is this wallet. Execute from the Safe, in this order:");
    for (const [i, [c, fn, args = []]] of calls.entries()) {
      console.log(`${i + 1}. ${await c.getAddress()} ${fn}${freeze ? " (irreversible)" : ""}:`, c.interface.encodeFunctionData(fn, args));
    }
    return;
  }
  if (!freeze) {
    await (await agents.setBaseURI(uri)).wait();
    console.log("✔ baseURI =", uri, "- check 5-10 tokens on OpenSea (Refresh metadata), then run again with FREEZE=true.");
  } else {
    if (needsLock) {
      await (await renderer.lock()).wait();
      console.log("✔ Renderer presentation locked forever.");
    }
    await (await agents.freezeMetadata()).wait();
    console.log("✔ Metadata frozen forever.");
  }
}

module.exports = { main };

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
