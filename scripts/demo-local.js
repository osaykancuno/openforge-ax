// Full demo on a local node: deploy (with SeaDrop and registry mocks), "OpenSea" mint, reveal,
// art, reputation and autonomy modes. The site in web/ then shows real data.
//   terminal 1: npx hardhat node
//   terminal 2: npm run demo   (then npm run serve -> http://localhost:8080)
const hre = require("hardhat");
const { execFile } = require("child_process");
const run = (args) => new Promise((ok, ko) => execFile(process.execPath, args, (e, out) => (e ? ko(e) : (process.stdout.write(out), ok()))));
const fs = require("fs");
const path = require("path");
const { ethers } = hre;

const FEE = "0x0000a26b00c1F0DF003000390027140000fAa719";
const SUPPLY = 60;
const RESERVE = 10;

async function main() {
  const s = await ethers.getSigners();
  const [owner, treasury, attester, operator] = s;
  const wait = async (p) => (await p).wait();

  const registry = await (await ethers.getContractFactory("MockERC6551Registry")).deploy();
  const seaDrop = await (await ethers.getContractFactory("MockSeaDrop")).deploy();
  const impl = await (await ethers.getContractFactory("AgentAccount")).deploy();
  const now = (await ethers.provider.getBlock("latest")).timestamp;
  const agents = await (await ethers.getContractFactory("OpenForgeAgents")).deploy(
    owner.address, treasury.address, await registry.getAddress(), await impl.getAddress(), SUPPLY, RESERVE, now + 2 * 86400, 500, [await seaDrop.getAddress()]
  );
  const fromBlock = (await agents.deploymentTransaction().wait()).blockNumber;
  const renderer = await (await ethers.getContractFactory("AgentRenderer")).deploy(await agents.getAddress(), owner.address);
  const rep = await (await ethers.getContractFactory("AgentReputation")).deploy(await agents.getAddress(), owner.address);
  await wait(agents.setRenderer(await renderer.getAddress()));
  await wait(agents.setReputation(await rep.getAddress()));
  await wait(renderer.setPresentation("http://localhost:8080/assets/placeholder.png", "http://localhost:8080", "CC0 1.0 Universal - https://creativecommons.org/publicdomain/zero/1.0/"));
  await wait(rep.setAttester(attester.address, true));
  await wait(rep.setSimAttester(attester.address, true));

  const sd = await seaDrop.getAddress();
  const price = ethers.parseEther("0.015"); // public launch price
  await wait(agents.updateCreatorPayoutAddress(sd, treasury.address));
  await wait(agents.updateAllowedFeeRecipient(sd, FEE, true));
  await wait(agents.updatePublicDrop(sd, { mintPrice: price, startTime: now, endTime: now + 7 * 86400, maxTotalMintableByWallet: 10, feeBps: 1000, restrictFeeRecipients: true }));
  console.log("✔ contracts", await agents.getAddress());

  // public mint (as from OpenSea) + reserve
  let left = SUPPLY - RESERVE;
  for (let i = 4; left > 0; i++) {
    const q = Math.min(left, 3 + (i % 5));
    await wait(seaDrop.connect(s[i]).mintPublic(agents, FEE, ethers.ZeroAddress, q, { value: price * BigInt(q) }));
    left -= q;
  }
  await wait(agents.reserveMint(owner.address, RESERVE));
  console.log("✔ sold out:", (await agents.totalSupply()).toString());

  // reveal
  await wait(agents.commitReveal());
  await hre.network.provider.send("hardhat_mine", ["0x5"]); // the reveal must be mined in revealBlock + 1
  await wait(agents.revealSeed());
  const seed = await agents.seed();
  console.log("✔ seed", seed);

  // deterministic art from the on-chain seed
  const root = path.join(__dirname, "..");
  await run([path.join(root, "art/generate.mjs"), "--seed", seed, "--supply", String(SUPPLY)]);
  const dst = path.join(root, "web/demo-images");
  fs.mkdirSync(dst, { recursive: true });
  for (const f of fs.readdirSync(path.join(root, "art/out/images"))) fs.copyFileSync(path.join(root, "art/out/images", f), path.join(dst, f));
  await wait(agents.setBaseURI("http://localhost:8080/demo-images/"));

  // agent activity: attestations (including failures), modes, proposals
  for (let id = 1; id <= 20; id++) {
    for (let k = 0; k < (id % 6) + 1; k++) {
      await wait(rep.connect(attester).attest(id, ethers.id("pick-and-place"), k % 3 !== 0, 4000 + ((id * 977 + k * 131) % 6000), ethers.id(`run-${id}-${k}`), `ipfs://demo/run-${id}-${k}`));
    }
  }
  const acct = async (id) => ethers.getContractAt("AgentAccount", await agents.accountOf(id));
  const holderOf = async (id) => ethers.getSigner(await agents.ownerOf(id));
  for (const [id, level] of [[1, 2], [2, 3], [3, 1]]) {
    const h = await holderOf(id);
    const a = await acct(id);
    await wait(h.sendTransaction({ to: await a.getAddress(), value: ethers.parseEther("0.2") }));
    await wait(a.connect(h).configure(operator.address, level, ethers.parseEther("0.05"), 86400));
  }
  await wait((await acct(3)).connect(operator).propose(treasury.address, ethers.parseEther("0.01"), "0x"));
  console.log("✔ attestations, modes and proposals created");

  fs.writeFileSync(
    path.join(root, "web/deployment.json"),
    JSON.stringify({ chainId: 31337, chainName: "Hardhat Local", rpcUrl: "http://127.0.0.1:8545", provingApi: process.env.PROVING_API || "http://localhost:8787", worldWs: process.env.WORLD_WS || "ws://localhost:8788", explorer: "#", openseaDropUrl: "#demo-opensea", agents: await agents.getAddress(), renderer: await renderer.getAddress(), reputation: await rep.getAddress(), fromBlock }, null, 2)
  );
  await run([path.join(root, "scripts/build-web.mjs")]);
  console.log("\nDemo ready: npm run serve  ->  http://localhost:8080");
  const o1 = await agents.ownerOf(1);
  console.log(`Holder of agent #1: ${o1} (Hardhat account #${s.findIndex((x) => x.address === o1)}, private key printed by 'npx hardhat node')`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
