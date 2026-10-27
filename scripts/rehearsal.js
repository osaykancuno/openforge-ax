// Full launch rehearsal on a test network, end to end, with the REAL SeaDrop and ERC-6551 registry:
// deploy → public mint through SeaDrop → reserve (sold out) → agent wallet actions → reveal → reputation →
// metadata → token art (drawn from the on-chain seed, checked against tokenURI) → base URI → renderer lock + freeze →
// report. A 5-agent collection keeps it cheap.
// REHEARSAL_PIN=yes pins the 5 rendered images to IPFS (PINATA_JWT) and uses them as the base URI, so the test
// collection shows the real art; without it the base URI points at a dummy CID.
//   npm run rehearsal:sepolia        (needs a little Sepolia ETH on PRIVATE_KEY or SEPOLIA_PRIVATE_KEY)
//   npm run rehearsal:fork           (Sepolia fork, no funds needed)
const hre = require("hardhat");
require("./lib/nonce-guard");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { ethers, network } = hre;

const SEADROP = "0x00005EA00Ac477B1030CE78506496e8C2dE24bf5";
const FEE_RECIPIENT = "0x0000a26b00c1F0DF003000390027140000fAa719";
const fork = network.name === "hardhat";
const results = [];
// `cond` is re-read for up to a minute on a real network: public RPCs can answer from a lagging backend
const check = async (cond, what) => {
  let ok = false;
  for (let i = 0; i < (fork ? 1 : 20) && !ok; i++) {
    if (i) await new Promise((r) => setTimeout(r, 3000));
    ok = Boolean(await cond());
  }
  results.push(`${ok ? "PASS" : "FAIL"}  ${typeof what === "function" ? await what() : what}`);
  console.log(results.at(-1).replace(/^PASS {2}/, "✔ ").replace(/^FAIL {2}/, "✘ "));
  if (!ok) throw new Error(`Rehearsal failed: ${results.at(-1)}`);
};
const decode = (uri) => JSON.parse(Buffer.from(uri.split(",")[1], "base64").toString());

async function main() {
  const { chainId } = await ethers.provider.getNetwork();
  if (chainId !== 11155111n && chainId !== 31337n) throw new Error("The rehearsal runs only on Sepolia or a local chain: it deploys and freezes a test collection");
  if (process.env.REHEARSAL_PIN === "yes" && !fork && !process.env.PINATA_JWT) throw new Error("REHEARSAL_PIN=yes needs PINATA_JWT in .env: fix it before spending test ETH");
  const [me] = await ethers.getSigners();
  if (fork) await network.provider.send("hardhat_setCode", [me.address, "0x"]); // public dev keys carry EIP-7702 sweepers
  const startBalance = await ethers.provider.getBalance(me.address);
  console.log(`Rehearsal on ${fork ? "a Sepolia fork" : network.name} (${chainId}) with ${me.address}, balance ${ethers.formatEther(startBalance)} ETH`);

  const now = (await ethers.provider.getBlock("latest")).timestamp;
  Object.assign(process.env, {
    MAX_SUPPLY: "5", TEAM_RESERVE: "2", REVEAL_DEADLINE_DAYS: "2", OWNER: "", TREASURY: "",
    PUBLIC_PRICE_ETH: "0.0001", PUBLIC_START: String(now - 60), PUBLIC_END: String(now + 86400), MAX_PER_WALLET: "3",
    NO_SITE_FILE: "1", REVEAL_TIP_GWEI: process.env.REVEAL_TIP_GWEI || "2", MAX_TRIES: "6",
  });

  // 1. deploy (the same script as mainnet)
  const { out, agents, renderer, rep } = await require("./deploy.js").main();
  if (fork) fs.writeFileSync(`deployments-${chainId}.json`, JSON.stringify(out, null, 2)); // reveal/finalize read it
  await check(async () => Boolean(out.agents && out.renderer && out.reputation), "deploy: 4 contracts wired");

  // 2. public mint through the real SeaDrop (as OpenSea does)
  const seaDrop = new ethers.Contract(SEADROP, ["function mintPublic(address nftContract,address feeRecipient,address minterIfNotPayer,uint256 quantity) payable"], me);
  await (await seaDrop.mintPublic(out.agents, FEE_RECIPIENT, ethers.ZeroAddress, 3, { value: ethers.parseEther("0.0003") })).wait();
  await check(async () => (await agents.totalSupply()) === 3n && (await agents.ownerOf(1)) === me.address, "SeaDrop public mint: 3 agents minted");
  await (await agents.reserveMint(me.address, 2)).wait();
  await check(async () => (await agents.totalSupply()) === 5n, "reserve mint: sold out (5/5)");

  // 3. agent wallet (ERC-6551) created at mint, usable by its holder
  const acct = await ethers.getContractAt("AgentAccount", await agents.accountOf(1));
  await check(async () => (await ethers.provider.getCode(await acct.getAddress())) !== "0x" && (await acct.owner()) === me.address, "agent wallet exists and belongs to the holder");
  await (await me.sendTransaction({ to: await acct.getAddress(), value: 1000n })).wait();
  await (await acct.execute(me.address, 400n, "0x", 0)).wait();
  await check(async () => (await ethers.provider.getBalance(await acct.getAddress())) === 600n, "holder moves ETH out of the agent wallet");
  await (await acct.configure(ethers.Wallet.createRandom().address, 1, 1000n, 3600)).wait();
  await check(async () => (await acct.autonomyLevel()) === 1n, "autonomy policy set (Manual)");

  // 4. reveal (the same script as mainnet: exact block, retries)
  await require("./reveal.js").main();
  await check(async () => (await agents.seed()) !== ethers.ZeroHash, "reveal: seed set in revealBlock + 1");

  // 5. reputation and on-chain metadata
  await (await rep.setAttester(me.address, true)).wait();
  await (await rep.attest(1, ethers.id("pick-and-place"), true, 9000, ethers.id(`rehearsal-${Date.now()}`), "ipfs://evidence")).wait();
  let meta;
  const attr = (k) => meta.attributes.find((a) => a.trait_type === k)?.value;
  await check(async () => {
    meta = decode(await agents.tokenURI(1));
    return Boolean(attr("Class")) && attr("Tasks") === 1 && attr("Autonomy") === "Manual";
  }, () => `tokenURI: ${meta.name} · ${attr("Class")} · Tasks ${attr("Tasks")}`);

  // 6. token art: the off-chain generator, fed the on-chain seed, must agree with the on-chain traits
  const seed = await agents.seed();
  const supply = Number(await agents.totalSupply());
  const artDir = fs.mkdtempSync(path.join(os.tmpdir(), "openforge-rehearsal-art-"));
  execFileSync(process.execPath, [path.join(__dirname, "../art/generate.mjs"), "--seed", seed, "--supply", String(supply), "--out", artDir], { stdio: "inherit" });
  const KEYS = ["Class", "Core Model", "Sensor", "Finish", "Frame", "District", "Faction", "Augment"];
  const classes = [];
  for (let id = 1; id <= supply; id++) {
    const off = JSON.parse(fs.readFileSync(path.join(artDir, "metadata", `${id}.json`), "utf8"));
    const offAttr = Object.fromEntries(off.attributes.map((a) => [a.trait_type, a.value]));
    let on;
    await check(async () => {
      on = decode(await agents.tokenURI(id));
      const onAttr = Object.fromEntries(on.attributes.map((a) => [a.trait_type, a.value]));
      return on.name === off.name && KEYS.every((k) => onAttr[k] === offAttr[k]) && fs.statSync(path.join(artDir, "images", `${id}.png`)).size > 10_000;
    }, () => `token art #${id}: ${off.name} · ${offAttr.Class} · image and traits match tokenURI`);
    classes.push(offAttr.Class);
  }
  results.push(`INFO  classes in this collection: ${classes.join(", ")}${classes.some((c) => c.startsWith("AX-1")) ? "" : " (no AX-1 class among 5 tokens: expected 31% each)"}`);
  console.log(results.at(-1));

  // 7. base URI, then lock + freeze (irreversible, fine on a test collection)
  await (await renderer.setPresentation("ipfs://bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy/placeholder.png", "https://openforge-ax.test", "CC0 1.0 Universal")).wait();
  const finalize = require("./finalize.js").main;
  let imagesCid = "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi"; // a dummy CID unless REHEARSAL_PIN=yes
  if (process.env.REHEARSAL_PIN === "yes" && !fork) {
    const { pinFolder } = await import("./pin.mjs");
    imagesCid = await pinFolder(path.join(artDir, "images"), `openforge-rehearsal-${out.agents.slice(2, 10)}`);
    results.push(`INFO  images pinned: ipfs://${imagesCid}/`);
    console.log(results.at(-1));
  }
  Object.assign(process.env, { IMAGES_CID: imagesCid, BASE_URI: "", FREEZE: "" });
  await finalize();
  await check(async () => (await agents.baseURI()) === `ipfs://${imagesCid}/`, "finalize: base URI set");
  process.env.FREEZE = "true";
  for (let i = 0; ; i++) {
    try {
      await finalize();
      break;
    } catch (e) {
      // its safety read of the base URI may still hit a lagging backend right after the first run
      if (i >= 5 || !/Run without FREEZE first/.test(e.message)) throw e;
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
  await check(async () => (await agents.metadataFrozen()) && (await renderer.locked()), "finalize: renderer locked, metadata frozen");

  const spent = startBalance - (await ethers.provider.getBalance(me.address));
  results.push(`ETH spent: ${ethers.formatEther(spent)} · collection ${out.agents}`);
  console.log(`\n${results.join("\n")}`);
  fs.rmSync(artDir, { recursive: true, force: true });
  if (fork) fs.rmSync(`deployments-${chainId}.json`, { force: true });
  else fs.writeFileSync(`rehearsal-${chainId}.txt`, `${new Date().toISOString()}\n${results.join("\n")}\n`);
}

main().catch((e) => {
  console.error(e);
  if (fork) fs.rmSync("deployments-11155111.json", { force: true });
  process.exit(1);
});
