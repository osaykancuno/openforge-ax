// Two-step reveal (anyone can run it): commitReveal -> revealSeed, which only works in block revealBlock + 1.
// The script sends the reveal as soon as revealBlock is mined, with a high priority fee; on a miss it commits again.
//   npx hardhat run scripts/reveal.js --network mainnet        (REVEAL_TIP_GWEI, default 20; MAX_TRIES, default 5)
const { ethers, network } = require("hardhat");
require("./lib/nonce-guard");
const fs = require("fs");

const local = network.name === "hardhat" || network.name === "localhost";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const { chainId } = await ethers.provider.getNetwork();
  const dep = JSON.parse(fs.readFileSync(`deployments-${chainId}.json`, "utf8"));
  const agents = await ethers.getContractAt("OpenForgeAgents", dep.agents);
  const tip = ethers.parseUnits(process.env.REVEAL_TIP_GWEI || "20", "gwei");
  const maxTries = Number(process.env.MAX_TRIES || 5);

  // state is taken from receipts, not re-read: a load-balanced RPC can answer a read with a stale backend
  const event = (receipt, name) => receipt.logs.map((l) => { try { return agents.interface.parseLog(l); } catch { return null; } }).find((e) => e?.name === name);
  let seed = await agents.seed();
  let rb = Number(await agents.revealBlock());
  for (let attempt = 1; attempt <= maxTries && seed === ethers.ZeroHash; attempt++) {
    if (rb === 0 || (await ethers.provider.getBlockNumber()) > rb) {
      try {
        const receipt = await (await agents.commitReveal()).wait();
        rb = Number(event(receipt, "SeedCommitted").args.revealBlock);
      } catch (e) {
        if (!/AlreadyRevealed/.test(`${e.shortMessage} ${e.message}`)) throw e;
        for (let i = 0; i < 20 && seed === ethers.ZeroHash; i++, await sleep(3_000)) seed = await agents.seed(); // revealed meanwhile
        break;
      }
      console.log(`Committed (attempt ${attempt}). Reveal must land in block ${rb + 1}.`);
    }
    // wait until revealBlock is the head, so the reveal goes into the very next block
    if (local) {
      const head = await ethers.provider.getBlockNumber();
      if (rb > head) await network.provider.send("hardhat_mine", [ethers.toQuantity(rb - head)]);
    }
    while ((await ethers.provider.getBlockNumber()) < rb) await sleep(1_000);
    if ((await ethers.provider.getBlockNumber()) > rb) continue; // too late for this commit
    const fee = await ethers.provider.getFeeData();
    try {
      const receipt = await (await agents.revealSeed({ maxPriorityFeePerGas: tip, maxFeePerGas: (fee.maxFeePerGas || 0n) * 2n + tip, gasLimit: 200_000 })).wait();
      seed = event(receipt, "SeedRevealed")?.args.seed ?? seed;
    } catch (e) {
      console.log(`Missed block ${rb + 1}: ${e.shortMessage || e.message}`);
    }
  }

  if (seed === ethers.ZeroHash) throw new Error(`Not revealed after ${maxTries} attempts; run again with a higher REVEAL_TIP_GWEI`);
  const supply = await agents.totalSupply();
  console.log(`\nSeed: ${seed}\nSupply: ${supply}\nNext: node art/generate.mjs --seed ${seed} --supply ${supply}`);
}

module.exports = { main };

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
