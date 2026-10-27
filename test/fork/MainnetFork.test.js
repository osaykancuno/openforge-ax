// Runs only on a mainnet fork (npm run test:fork): checks the contracts against the REAL
// canonical ERC-6551 registry and OpenSea SeaDrop instead of the local mocks.
const { expect } = require("chai");
const hre = require("hardhat");
const { time, mine } = require("@nomicfoundation/hardhat-network-helpers");
const { OPENSEA_FEE_RECIPIENT } = require("../helpers");

const { ethers } = hre;
const REGISTRY = "0x000000006551c19487814612e58FE06813775758";
const SEADROP = "0x00005EA00Ac477B1030CE78506496e8C2dE24bf5";
const FORKED = Boolean(hre.network.config.forking?.enabled);

(FORKED ? describe : describe.skip)("Mainnet fork - real ERC-6551 registry + SeaDrop", () => {
  const price = ethers.parseEther("0.015"); // public launch price
  let owner, treasury, alice, bob, agents, renderer, seaDrop, registry, impl, start;

  before(async () => {
    [owner, treasury, alice, bob] = await ethers.getSigners();
    // The public Hardhat dev keys carry EIP-7702 sweeper delegations on mainnet, which reject ETH: strip them.
    for (const s of [owner, treasury, alice, bob]) await ethers.provider.send("hardhat_setCode", [s.address, "0x"]);
    expect((await ethers.provider.getNetwork()).chainId).to.equal(1n);
    seaDrop = await ethers.getContractAt("ISeaDrop", SEADROP);
    registry = await ethers.getContractAt("IERC6551Registry", REGISTRY);
    impl = await (await ethers.getContractFactory("AgentAccount")).deploy();
    start = await time.latest();
    agents = await (await ethers.getContractFactory("OpenForgeAgents")).deploy(
      owner.address, treasury.address, REGISTRY, await impl.getAddress(), 1024, 100, start + 14 * 86400, 500, [SEADROP]
    );
    renderer = await (await ethers.getContractFactory("AgentRenderer")).deploy(await agents.getAddress(), owner.address);
    await agents.setRenderer(await renderer.getAddress());
    await renderer.setPresentation("ipfs://placeholder.png", "https://openforge.example", "CC0 1.0 Universal - https://creativecommons.org/publicdomain/zero/1.0/");
  });

  it("real SeaDrop accepts the drop configuration (interface id check passes)", async () => {
    await agents.updateCreatorPayoutAddress(SEADROP, treasury.address);
    await agents.updateAllowedFeeRecipient(SEADROP, OPENSEA_FEE_RECIPIENT, true);
    await agents.updatePublicDrop(SEADROP, {
      mintPrice: price,
      startTime: start,
      endTime: start + 7 * 86400,
      maxTotalMintableByWallet: 3,
      feeBps: 1000,
      restrictFeeRecipients: true,
    });
    const nft = await agents.getAddress();
    const drop = await seaDrop.getPublicDrop(nft);
    expect(drop.mintPrice).to.equal(price);
    expect(drop.feeBps).to.equal(1000n);
    expect(await seaDrop.getCreatorPayoutAddress(nft)).to.equal(treasury.address);
    expect(await seaDrop.getAllowedFeeRecipients(nft)).to.deep.equal([OPENSEA_FEE_RECIPIENT]);
  });

  it("public mint through SeaDrop: 10% OpenSea fee, 90% to the treasury, wallets created by the real registry", async () => {
    const nft = await agents.getAddress();
    const total = price * 3n;
    const fee = total / 10n;
    const tx = seaDrop.connect(alice).mintPublic(nft, OPENSEA_FEE_RECIPIENT, ethers.ZeroAddress, 3, { value: total });
    await expect(tx).to.changeEtherBalances([alice, treasury, OPENSEA_FEE_RECIPIENT], [-total, total - fee, fee]);
    const gas = (await (await tx).wait()).gasUsed;
    console.log(`      gas for a 3-token mint: ${gas} (~${gas / 3n} per agent incl. its wallet)`);

    for (const id of [1n, 2n, 3n]) {
      expect(await agents.ownerOf(id)).to.equal(alice.address);
      const addr = await agents.accountOf(id);
      expect(addr).to.equal(await registry.account(await impl.getAddress(), ethers.ZeroHash, 1, nft, id));
      expect((await ethers.provider.getCode(addr)).length).to.be.gt(2);
      const acc = await ethers.getContractAt("AgentAccount", addr);
      expect(await acc.token()).to.deep.equal([1n, nft, id]);
      expect(await acc.owner()).to.equal(alice.address);
    }
  });

  it("SeaDrop enforces the wallet limit, wrong payment and unlisted fee recipients", async () => {
    const nft = await agents.getAddress();
    await expect(seaDrop.connect(alice).mintPublic(nft, OPENSEA_FEE_RECIPIENT, ethers.ZeroAddress, 1, { value: price }))
      .to.be.revertedWithCustomError(seaDrop, "MintQuantityExceedsMaxMintedPerWallet");
    await expect(seaDrop.connect(bob).mintPublic(nft, OPENSEA_FEE_RECIPIENT, ethers.ZeroAddress, 1, { value: price - 1n }))
      .to.be.revertedWithCustomError(seaDrop, "IncorrectPayment");
    await expect(seaDrop.connect(bob).mintPublic(nft, bob.address, ethers.ZeroAddress, 1, { value: price }))
      .to.be.revertedWithCustomError(seaDrop, "FeeRecipientNotAllowed");
    await expect(agents.connect(bob).mintSeaDrop(bob.address, 1)).to.be.revertedWithCustomError(agents, "OnlyAllowedSeaDrop");
  });

  it("the holder controls the wallet from the real registry proxy; it follows the NFT on transfer", async () => {
    const acc = await ethers.getContractAt("AgentAccount", await agents.accountOf(1));
    await alice.sendTransaction({ to: await acc.getAddress(), value: ethers.parseEther("0.1") });
    await expect(acc.connect(alice).execute(bob.address, ethers.parseEther("0.04"), "0x", 0))
      .to.changeEtherBalance(bob, ethers.parseEther("0.04"));
    await expect(acc.connect(bob).execute(bob.address, 1n, "0x", 0)).to.be.revertedWithCustomError(acc, "NotAuthorized");

    await agents.connect(alice).transferFrom(alice.address, bob.address, 1);
    expect(await acc.owner()).to.equal(bob.address);
    await expect(acc.connect(alice).execute(alice.address, 1n, "0x", 0)).to.be.revertedWithCustomError(acc, "NotAuthorized");
    await expect(agents.connect(bob).transferFrom(bob.address, await acc.getAddress(), 1))
      .to.be.revertedWithCustomError(agents, "OwnershipCycle");
  });

  it("reserve mint, reveal and on-chain metadata work on mainnet state", async () => {
    await agents.reserveMint(treasury.address, 2);
    expect(await agents.totalSupply()).to.equal(5n);
    await time.increase(15 * 86400);
    await agents.commitReveal();
    await mine(5); // the reveal must be mined in revealBlock + 1
    await agents.revealSeed();
    expect(await agents.seed()).to.not.equal(ethers.ZeroHash);
    const meta = JSON.parse(Buffer.from((await agents.tokenURI(5)).split(",")[1], "base64").toString());
    expect(meta.attributes.length).to.be.gte(8);
    await expect(seaDrop.connect(bob).mintPublic(await agents.getAddress(), OPENSEA_FEE_RECIPIENT, ethers.ZeroAddress, 1, { value: price }))
      .to.be.reverted; // drop window over and minting closed at commit
  });
});
