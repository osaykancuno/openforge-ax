const { ethers } = require("hardhat");
const { mine, time } = require("@nomicfoundation/hardhat-network-helpers");

const OPENSEA_FEE_RECIPIENT = "0x0000a26b00c1F0DF003000390027140000fAa719";
const CC0 = "CC0 1.0 Universal - https://creativecommons.org/publicdomain/zero/1.0/";

async function deployAll({ maxSupply = 10, reserve = 2, deadlineOffset = 7 * 86400, price = ethers.parseEther("0.05"), perWallet = 5, withReputation = true } = {}) {
  const [owner, treasury, alice, bob, carol, operator, attester] = await ethers.getSigners();
  const registry = await (await ethers.getContractFactory("MockERC6551Registry")).deploy();
  const impl = await (await ethers.getContractFactory("AgentAccount")).deploy();
  const seaDrop = await (await ethers.getContractFactory("MockSeaDrop")).deploy();
  const latest = await time.latest();
  const agents = await (await ethers.getContractFactory("OpenForgeAgents")).deploy(
    owner.address,
    treasury.address,
    await registry.getAddress(),
    await impl.getAddress(),
    maxSupply,
    reserve,
    latest + deadlineOffset,
    500,
    [await seaDrop.getAddress()]
  );
  const renderer = await (await ethers.getContractFactory("AgentRenderer")).deploy(await agents.getAddress(), owner.address);
  await agents.setRenderer(await renderer.getAddress());
  await renderer.setPresentation("ipfs://placeholder.png", "https://openforge.example", CC0);
  const rep = await (await ethers.getContractFactory("AgentReputation")).deploy(await agents.getAddress(), owner.address);
  if (withReputation) await agents.setReputation(await rep.getAddress());

  const sd = await seaDrop.getAddress();
  await agents.updateCreatorPayoutAddress(sd, treasury.address);
  await agents.updateAllowedFeeRecipient(sd, OPENSEA_FEE_RECIPIENT, true);
  await agents.updatePublicDrop(sd, {
    mintPrice: price,
    startTime: latest,
    endTime: latest + 30 * 86400,
    maxTotalMintableByWallet: perWallet,
    feeBps: 1000,
    restrictFeeRecipients: true,
  });

  const mint = (signer, qty) =>
    seaDrop.connect(signer).mintPublic(agents, OPENSEA_FEE_RECIPIENT, ethers.ZeroAddress, qty, { value: price * BigInt(qty) });

  return { owner, treasury, alice, bob, carol, operator, attester, registry, impl, seaDrop, agents, renderer, rep, mint, price };
}

async function accountOf(agents, id) {
  return ethers.getContractAt("AgentAccount", await agents.accountOf(id));
}

function decodeUri(uri) {
  const b64 = uri.replace("data:application/json;base64,", "");
  return JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
}

/** Two-step reveal (commit at N, revealBlock = N+5, reveal mined in N+6), skipping the deadline. */
async function reveal(agents) {
  await time.increase(31 * 86400);
  await agents.commitReveal();
  await mine(5);
  await agents.revealSeed();
}

module.exports = { deployAll, accountOf, decodeUri, reveal, OPENSEA_FEE_RECIPIENT, CC0 };
