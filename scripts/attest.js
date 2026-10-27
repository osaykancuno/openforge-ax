// Attester: records a task or data attestation for an agent.
//   TOKEN=42 TASK=pick-and-place SUCCESS=false QUALITY=8500 EVIDENCE=./run-042.json \
//   npx hardhat run scripts/attest.js --network mainnet
// QUALITY (0-10000) measures how informative the data is: a well-documented failure is still worth a lot.
const { ethers } = require("hardhat");
const fs = require("fs");

async function main() {
  const { TOKEN, TASK, SUCCESS, QUALITY, EVIDENCE, EVIDENCE_URI } = process.env;
  if (!TOKEN || !TASK || QUALITY === undefined || !EVIDENCE) throw new Error("TOKEN, TASK, QUALITY and EVIDENCE (file) are required");
  const { chainId } = await ethers.provider.getNetwork();
  const dep = JSON.parse(fs.readFileSync(`deployments-${chainId}.json`, "utf8"));
  const rep = await ethers.getContractAt("AgentReputation", dep.reputation);
  const dataHash = ethers.keccak256(fs.readFileSync(EVIDENCE));
  const tx = await rep.attest(BigInt(TOKEN), ethers.id(TASK), SUCCESS === "true", Number(QUALITY), dataHash, EVIDENCE_URI || "");
  await tx.wait();
  console.log(`Attested agent #${TOKEN} (${TASK}, ${SUCCESS === "true" ? "success" : "failure"}, q=${QUALITY}) dataHash=${dataHash}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
