// Full deploy for OpenSea (SeaDrop):
//   AgentAccount (impl) -> OpenForgeAgents -> AgentRenderer -> AgentReputation -> wiring -> drop config.
// Configured via .env (see .env.example). Writes deployments-<chainId>.json and web/deployment.json for the site.
const hre = require("hardhat");
require("./lib/nonce-guard");
const fs = require("fs");
const { ethers } = hre;

const CANONICAL_REGISTRY = "0x000000006551c19487814612e58FE06813775758";
const SEADROP = "0x00005EA00Ac477B1030CE78506496e8C2dE24bf5";
const OPENSEA_FEE_RECIPIENT = "0x0000a26b00c1F0DF003000390027140000fAa719";

const blank = (v) => !v || /^(https?|ipfs):\/\/?$/.test(v) || /__|example|PLACEHOLDER/i.test(v);
const ipfsUri = (v) => /^ipfs:\/\/[a-zA-Z0-9]{46,100}(\/[\w.\-/]*)?$/.test(v || "");
// pinned on IPFS, or served by the project's own site (no IPFS account)
const imageUri = (v, site) => ipfsUri(v) || (!blank(site) && /^https:\/\//.test(site || "") && (v || "").startsWith(site.replace(/\/$/, "") + "/") && /\.(png|webp|jpg|gif|svg)$/.test(v));

/** keccak of the files that decide how a token looks (art/token-render.mjs GENERATOR_FILES): the provenance. */
async function generatorHash() {
  const path = require("path");
  const { GENERATOR_FILES } = await import(require("url").pathToFileURL(path.join(__dirname, "../art/token-render.mjs")).href);
  return ethers.keccak256(Buffer.concat(GENERATOR_FILES.map((f) => fs.readFileSync(path.join(__dirname, "..", f)))));
}
const intIn = (v, lo, hi) => /^\d+$/.test(v || "") && Number(v) >= lo && Number(v) <= hi;

// decided launch values: anything else needs an explicit CONFIRM_* that repeats it
const DECIDED_PRICE_ETH = "0.01024"; // one price for everyone, allowlist included (user, 2026-10-28): 1,024 agents
const DECIDED_MAX_PER_WALLET = "3";
const OPENSEA_FEE_BPS_RANGE = [500, 2000]; // OpenSea's primary fee is 1000 (10%): 5-20% catches typos, not policy
const REVEAL_MARGIN = 3 * 86400; // the public phase must end this long before the reveal deadline

/**
 * On mainnet nothing may fall back to a default: these values are public at once and some are locked forever.
 * `nowSec` is injectable for tests.
 */
async function mainnetGuard(env, deployer, nowSec = Math.floor(Date.now() / 1000)) {
  const problems = [];
  for (const k of ["OWNER", "TREASURY"]) {
    if (!ethers.isAddress(env[k] || "")) problems.push(`${k} must be an address (the Safe)`);
    else if (env[k].toLowerCase() === deployer.toLowerCase()) problems.push(`${k} must not be the deploy key`);
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(env.PROVENANCE_HASH || "")) problems.push("PROVENANCE_HASH is required (npm run assets writes it)");
  else {
    // locked once the first token is minted: it must be the hash of the art generator as it is now
    const now = await generatorHash();
    if (env.PROVENANCE_HASH.toLowerCase() !== now.toLowerCase()) problems.push(`PROVENANCE_HASH is stale: the art generator now hashes to ${now}. Run npm run assets again`);
  }
  if (blank(env.EXTERNAL_URL) || !/^https:\/\/[^/]+\.[^/]+/.test(env.EXTERNAL_URL)) problems.push("EXTERNAL_URL must be the real https:// site (locked forever by AgentRenderer.lock)");
  else if (/["\\\x00-\x1f\x7f]/.test(env.EXTERNAL_URL)) problems.push("EXTERNAL_URL must not contain quotes, backslashes or control characters (the renderer refuses them)");
  // supply-defining values are immutable or one-way: no silent defaults and no typos on mainnet
  if (env.MAX_SUPPLY !== "1024") problems.push("MAX_SUPPLY must be exactly 1024");
  if (env.TEAM_RESERVE !== "100") problems.push("TEAM_RESERVE must be exactly 100");
  if (!intIn(env.ROYALTY_BPS, 0, 1000)) problems.push("ROYALTY_BPS must be set, 0-1000");
  if (!intIn(env.REVEAL_DEADLINE_DAYS, 7, 45)) problems.push("REVEAL_DEADLINE_DAYS must be set, 7-45 (it can only be moved later)");
  if (!/^0\.0\d{1,5}$/.test(env.PUBLIC_PRICE_ETH || "") || !(Number(env.PUBLIC_PRICE_ETH) > 0)) problems.push(`PUBLIC_PRICE_ETH must be set explicitly (decided: ${DECIDED_PRICE_ETH})`);
  else if (env.PUBLIC_PRICE_ETH !== DECIDED_PRICE_ETH && env.CONFIRM_PRICE !== env.PUBLIC_PRICE_ETH) {
    problems.push(`PUBLIC_PRICE_ETH=${env.PUBLIC_PRICE_ETH} is not the decided ${DECIDED_PRICE_ETH}: set CONFIRM_PRICE=${env.PUBLIC_PRICE_ETH} to confirm it`);
  }
  if (!intIn(env.MAX_PER_WALLET, 1, 10)) problems.push(`MAX_PER_WALLET must be set explicitly (decided: ${DECIDED_MAX_PER_WALLET})`);
  else if (env.MAX_PER_WALLET !== DECIDED_MAX_PER_WALLET && env.CONFIRM_MAX_PER_WALLET !== env.MAX_PER_WALLET) {
    problems.push(`MAX_PER_WALLET=${env.MAX_PER_WALLET} is not the decided ${DECIDED_MAX_PER_WALLET}: set CONFIRM_MAX_PER_WALLET=${env.MAX_PER_WALLET} to confirm it`);
  }
  if (!intIn(env.OPENSEA_FEE_BPS, OPENSEA_FEE_BPS_RANGE[0], OPENSEA_FEE_BPS_RANGE[1])) {
    problems.push(`OPENSEA_FEE_BPS must be set explicitly, ${OPENSEA_FEE_BPS_RANGE.join("-")} (check the current primary fee in OpenSea Studio; it was 1000)`);
  }
  // the public phase: explicit, not live before the Safe accepts ownership and the reserve is minted, and over
  // well before the reveal deadline (a reveal commit closes minting)
  if (!intIn(env.PUBLIC_START, 1, 4_102_444_800) || !intIn(env.PUBLIC_END, 1, 4_102_444_800)) {
    problems.push("PUBLIC_START and PUBLIC_END must both be set (unix seconds)");
  } else {
    const start = Number(env.PUBLIC_START);
    const end = Number(env.PUBLIC_END);
    if (start <= nowSec) problems.push("PUBLIC_START must be in the future: the drop must not be live before the Safe accepts ownership and the reserve is minted");
    if (end <= start) problems.push("PUBLIC_END must be after PUBLIC_START");
    if (intIn(env.REVEAL_DEADLINE_DAYS, 7, 45) && end + REVEAL_MARGIN > nowSec + Number(env.REVEAL_DEADLINE_DAYS) * 86400) {
      problems.push("PUBLIC_END + 3 days must be on or before the reveal deadline (REVEAL_DEADLINE_DAYS from now); raise REVEAL_DEADLINE_DAYS or shorten the phase");
    }
  }
  for (const k of ["PLACEHOLDER_IMAGE", "COLLECTION_IMAGE", "COLLECTION_BANNER"]) {
    if (!imageUri(env[k], env.EXTERNAL_URL)) problems.push(`${k} must be ipfs://<CID>/… or a file on EXTERNAL_URL (npm run assets writes it)`);
  }
  if (env.CONFIRM_MAINNET !== "yes") problems.push("set CONFIRM_MAINNET=yes for this run only, after checking every value above");
  if (problems.length) throw new Error(`Mainnet deploy refused:\n - ${problems.join("\n - ")}`);
}

async function main() {
  // reserveMint (Safe, after acceptOwnership) must run in batches of about 25 (~145k gas each; 100 in one tx would
  // not fit a block comfortably) and before the public phase ends: a reveal commit closes minting for the reserve too.
  const [deployer] = await ethers.getSigners();
  const net = await ethers.provider.getNetwork();
  const env = process.env;
  if (net.chainId === 1n) await mainnetGuard(env, deployer.address);
  else if (blank(env.OWNER) || blank(env.EXTERNAL_URL)) console.log("⚠ Test network: OWNER/EXTERNAL_URL fall back to defaults. Mainnet refuses that.");
  const treasury = env.TREASURY || deployer.address;
  const owner = env.OWNER || deployer.address;
  const maxSupply = Number(env.MAX_SUPPLY || 1024);
  const reserve = Number(env.TEAM_RESERVE || 100);
  const royaltyBps = Number(env.ROYALTY_BPS || 500);
  const revealDays = Number(env.REVEAL_DEADLINE_DAYS || 14);

  for (const [n, a] of [["Registry ERC-6551", CANONICAL_REGISTRY], ["SeaDrop", SEADROP]]) {
    if ((await ethers.provider.getCode(a)) === "0x") throw new Error(`${n} not found on this network (${a})`);
  }
  console.log(`Network ${hre.network.name} (${net.chainId}) | deployer ${deployer.address}`);

  const impl = await (await ethers.getContractFactory("AgentAccount")).deploy();
  await impl.waitForDeployment();
  const deadline = Math.floor(Date.now() / 1000) + revealDays * 86400;
  const agents = await (await ethers.getContractFactory("OpenForgeAgents")).deploy(
    deployer.address, treasury, CANONICAL_REGISTRY, await impl.getAddress(), maxSupply, reserve, deadline, royaltyBps, [SEADROP]
  );
  await agents.waitForDeployment();
  const deployBlock = (await agents.deploymentTransaction().wait()).blockNumber;
  const renderer = await (await ethers.getContractFactory("AgentRenderer")).deploy(await agents.getAddress(), deployer.address);
  await renderer.waitForDeployment();
  const rep = await (await ethers.getContractFactory("AgentReputation")).deploy(await agents.getAddress(), deployer.address);
  await rep.waitForDeployment();

  const tx = async (label, p) => { await (await p).wait(); console.log("✔", label); };
  const site = (blank(env.EXTERNAL_URL) ? "https://openforge.example" : env.EXTERNAL_URL).replace(/\/$/, "");
  const license = env.LICENSE || "CC0 1.0 Universal - https://creativecommons.org/publicdomain/zero/1.0/";
  await tx("renderer", agents.setRenderer(await renderer.getAddress()));
  await tx("reputation", agents.setReputation(await rep.getAddress()));
  await tx("presentation", renderer.setPresentation(imageUri(env.PLACEHOLDER_IMAGE, env.EXTERNAL_URL) ? env.PLACEHOLDER_IMAGE : "ipfs://__PLACEHOLDER_CID__", site, license));
  const contractMeta = {
    name: "OpenForge Agents",
    description: "OpenForge AX: the 1,024 members of an open robotics lab. Each NFT is an agent with its own wallet (ERC-6551) and an on-chain record; most classes are inspired by a real open-source robot (the AX-1 bodies are our own). Meet AX-1, the CC0 robot with a phone for a brain. Art, metadata and code are CC0 (public domain). No promise of returns.",
    image: imageUri(env.COLLECTION_IMAGE, env.EXTERNAL_URL) ? env.COLLECTION_IMAGE : "ipfs://__COLLECTION_IMAGE_CID__",
    banner_image: imageUri(env.COLLECTION_BANNER, env.EXTERNAL_URL) ? env.COLLECTION_BANNER : "ipfs://__COLLECTION_BANNER_CID__",
    external_link: site,
    license,
    license_url: "https://creativecommons.org/publicdomain/zero/1.0/",
    seller_fee_basis_points: royaltyBps,
    fee_recipient: treasury,
  };
  await tx("contractURI", agents.setContractURI("data:application/json;base64," + Buffer.from(JSON.stringify(contractMeta)).toString("base64")));
  if (env.PROVENANCE_HASH) await tx("provenance", agents.setProvenanceHash(env.PROVENANCE_HASH));
  if (env.ATTESTER) await tx("attester", rep.setAttester(env.ATTESTER, true));
  if (env.SIM_ATTESTER) await tx("sim attester", rep.setSimAttester(env.SIM_ATTESTER, true));

  // SeaDrop: creator payout and OpenSea fee recipient. Stages/prices can also be set in OpenSea Studio.
  await tx("creator payout", agents.updateCreatorPayoutAddress(SEADROP, treasury));
  await tx("OpenSea fee recipient", agents.updateAllowedFeeRecipient(SEADROP, OPENSEA_FEE_RECIPIENT, true));
  if (env.PUBLIC_PRICE_ETH && env.PUBLIC_START) {
    await tx("public drop", agents.updatePublicDrop(SEADROP, {
      mintPrice: ethers.parseEther(env.PUBLIC_PRICE_ETH),
      startTime: Number(env.PUBLIC_START),
      endTime: Number(env.PUBLIC_END || Number(env.PUBLIC_START) + 7 * 86400),
      maxTotalMintableByWallet: Number(env.MAX_PER_WALLET || 3),
      feeBps: Number(env.OPENSEA_FEE_BPS || 1000),
      restrictFeeRecipients: true,
    }));
  }

  if (owner.toLowerCase() !== deployer.address.toLowerCase()) {
    for (const [n, c] of [["agents", agents], ["renderer", renderer], ["reputation", rep]]) await tx(`ownership ${n} -> ${owner}`, c.transferOwnership(owner));
    console.log("!! From", owner, "(the Safe), call acceptOwnership() on all 3 contracts.");
  }

  const out = {
    chainId: Number(net.chainId),
    agents: await agents.getAddress(),
    renderer: await renderer.getAddress(),
    reputation: await rep.getAddress(),
    accountImplementation: await impl.getAddress(),
    seaDrop: SEADROP,
    fromBlock: deployBlock,
    ...(env.PROVING_API ? { provingApi: env.PROVING_API } : {}),
    ...(env.WORLD_WS ? { worldWs: env.WORLD_WS } : {}),
  };
  if (hre.network.name === "hardhat") {
    console.log("In-process network (e.g. mainnet fork): nothing written to disk.");
  } else {
    fs.writeFileSync(`deployments-${net.chainId}.json`, JSON.stringify(out, null, 2));
    if (env.NO_SITE_FILE !== "1") fs.writeFileSync("web/deployment.json", JSON.stringify(out, null, 2)); // rehearsals keep the site as it is
  }
  console.log(JSON.stringify(out, null, 2));
  console.log(`Reveal deadline: ${new Date(deadline * 1000).toISOString()} (the OpenSea public phase must end before it; extendRevealDeadline can add up to 90 days).`);
  console.log("Next, from the Safe after acceptOwnership(): reserveMint(address, n) in batches of about 25 (gas), before the public phase ends.");

  // Etherscan: all four contracts, from inside the script (no shell quoting of constructor arguments)
  if (hre.network.name !== "hardhat" && env.ETHERSCAN_API_KEY) {
    console.log("Waiting for Etherscan to index the bytecode…");
    await rep.deploymentTransaction().wait(5);
    const targets = [
      [out.accountImplementation, []],
      [out.agents, [deployer.address, treasury, CANONICAL_REGISTRY, out.accountImplementation, maxSupply, reserve, deadline, royaltyBps, [SEADROP]]],
      [out.renderer, [out.agents, deployer.address]],
      [out.reputation, [out.agents, deployer.address]],
    ];
    for (const [address, constructorArguments] of targets) {
      try {
        await hre.run("verify:verify", { address, constructorArguments });
      } catch (e) {
        console.log(`⚠ Verify ${address} failed (${e.message.split("\n")[0]}). Retry later: same arguments as in this script.`);
      }
    }
  }
  return { out, agents, renderer, rep, impl, deadline };
}

module.exports = { main, mainnetGuard, generatorHash };

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
