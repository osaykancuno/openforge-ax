const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, mine } = require("@nomicfoundation/hardhat-network-helpers");
const { deployAll, decodeUri, reveal, OPENSEA_FEE_RECIPIENT, CC0 } = require("./helpers");

describe("OpenForgeAgents - SeaDrop mint (OpenSea)", () => {
  let ctx;
  beforeEach(async () => {
    ctx = await deployAll();
  });

  it("only an allowed SeaDrop can mint", async () => {
    await expect(ctx.agents.connect(ctx.alice).mintSeaDrop(ctx.alice.address, 1)).to.be.revertedWithCustomError(ctx.agents, "OnlyAllowedSeaDrop");
  });

  it("mint: payment split between OpenSea fee and creator, agent wallet created automatically", async () => {
    const { agents, alice, treasury, mint, price } = ctx;
    const fee = (price * 2n * 1000n) / 10000n;
    await expect(mint(alice, 2)).to.changeEtherBalances([treasury, OPENSEA_FEE_RECIPIENT], [price * 2n - fee, fee]);
    expect(await agents.ownerOf(2)).to.equal(alice.address);
    for (const id of [1, 2]) {
      expect((await ethers.provider.getCode(await agents.accountOf(id))).length).to.be.gt(2);
    }
    const [n, supply, max] = await agents.getMintStats(alice.address);
    expect([n, supply, max]).to.deep.equal([2n, 2n, 8n]); // 10 - reserve 2
  });

  it("supply: SeaDrop cannot touch the reserve; reserve is owner-only", async () => {
    const { agents, alice, bob, carol, owner, mint } = ctx;
    await mint(alice, 5);
    await mint(bob, 3);
    await expect(mint(carol, 1)).to.be.reverted; // SeaDrop supply exhausted
    await expect(agents.connect(bob).reserveMint(bob.address, 1)).to.be.revertedWithCustomError(agents, "OwnableUnauthorizedAccount");
    await agents.connect(owner).reserveMint(carol.address, 2);
    await expect(agents.reserveMint(carol.address, 1)).to.be.revertedWithCustomError(agents, "ReserveExceeded");
    expect(await agents.totalSupply()).to.equal(10);
  });

  it("setMaxSupply can only decrease, never below minted + remaining reserve", async () => {
    const { agents, alice, mint } = ctx;
    await mint(alice, 3);
    await expect(agents.setMaxSupply(11)).to.be.revertedWithCustomError(agents, "CannotExceedMaxSupplyOfUint64");
    await expect(agents.setMaxSupply(4)).to.be.revertedWithCustomError(agents, "NewMaxSupplyCannotBeLessThenTotalMinted");
    await agents.setMaxSupply(6);
    expect(await agents.maxSupply()).to.equal(4);
  });

  it("provenance hash only before the first mint", async () => {
    const { agents, alice, mint } = ctx;
    await agents.setProvenanceHash(ethers.id("gen"));
    await mint(alice, 1);
    await expect(agents.setProvenanceHash(ethers.id("x"))).to.be.revertedWithCustomError(agents, "ProvenanceHashCannotBeSetAfterMintStarted");
  });

  it("two-step reveal: commit closes mint, reveal only in revealBlock + 1, re-commit after a miss", async () => {
    const { agents, alice, mint } = ctx;
    await mint(alice, 3);
    await expect(agents.commitReveal()).to.be.revertedWithCustomError(agents, "NotRevealable");
    await time.increase(8 * 86400);
    await agents.commitReveal(); // block N, revealBlock = N+5
    let rb = Number(await agents.revealBlock());
    await expect(mint(alice, 1)).to.be.reverted;
    await expect(agents.reserveMint(alice.address, 1)).to.be.revertedWithCustomError(agents, "MintClosed");
    await expect(agents.commitReveal()).to.be.revertedWithCustomError(agents, "NotRevealable"); // window open
    await expect(agents.revealSeed()).to.be.revertedWithCustomError(agents, "NotRevealable");
    await mine(rb + 1 - (await ethers.provider.getBlockNumber())); // head = rb+1: the next tx lands in rb+2
    await expect(agents.revealSeed()).to.be.revertedWithCustomError(agents, "RevealExpired");
    await agents.commitReveal(); // missed: anyone may commit again
    rb = Number(await agents.revealBlock());
    await mine(rb - 1 - (await ethers.provider.getBlockNumber())); // next tx lands in rb itself
    await expect(agents.revealSeed()).to.be.revertedWithCustomError(agents, "NotRevealable");
    await mine(rb - (await ethers.provider.getBlockNumber())); // reverted calls mine nothing; next tx lands in rb+1
    await agents.revealSeed();
    expect(await agents.seed()).to.not.equal(ethers.ZeroHash);
    await expect(agents.revealSeed()).to.be.revertedWithCustomError(agents, "AlreadyRevealed");
  });

  it("owner can only push the reveal deadline later, while minting is open, up to the hard cap", async () => {
    const { agents, alice, bob, mint } = ctx;
    const d0 = await agents.revealDeadline();
    const cap = await agents.LATEST_REVEAL_DEADLINE();
    expect(cap - d0).to.equal(90n * 86400n);
    await expect(agents.connect(alice).extendRevealDeadline(d0 + 1n)).to.be.revertedWithCustomError(agents, "OwnableUnauthorizedAccount");
    await expect(agents.extendRevealDeadline(d0)).to.be.revertedWithCustomError(agents, "InvalidParams");
    await expect(agents.extendRevealDeadline(cap + 1n)).to.be.revertedWithCustomError(agents, "InvalidParams");
    await expect(agents.extendRevealDeadline(d0 + 86400n)).to.emit(agents, "RevealDeadlineExtended").withArgs(d0 + 86400n);
    await time.increaseTo(d0 + 10n); // past the original deadline, but not the extended one
    await expect(agents.connect(bob).commitReveal()).to.be.revertedWithCustomError(agents, "NotRevealable");
    await mint(alice, 1);
    await time.increaseTo(d0 + 86400n + 1n);
    await agents.connect(bob).commitReveal();
    await expect(agents.extendRevealDeadline(cap)).to.be.revertedWithCustomError(agents, "MintClosed");
  });

  it("tokenURI stays cheap enough for marketplaces (< 3M gas)", async () => {
    const { agents, alice, rep, attester } = ctx;
    await agents.reserveMint(alice.address, 2);
    await reveal(agents);
    await rep.setAttester(attester.address, true);
    await rep.connect(attester).attest(1, ethers.id("t"), true, 9000, ethers.id("g"), "");
    for (const id of [1, 2]) expect(await ethers.provider.estimateGas({ to: await agents.getAddress(), data: agents.interface.encodeFunctionData("tokenURI", [id]) })).to.be.lt(3_000_000n);
  });

  it("sold out allows reveal without waiting for the deadline", async () => {
    const { agents, alice, bob, mint } = ctx;
    await mint(alice, 5);
    await mint(bob, 3);
    await agents.reserveMint(alice.address, 2);
    await agents.commitReveal();
  });

  it("tokenURI: dormant before reveal, traits + dynamic attributes after, ERC-4906 refresh on attestations", async () => {
    const { agents, alice, rep, attester, mint } = ctx;
    await mint(alice, 1);
    let meta = decodeUri(await agents.tokenURI(1));
    expect(meta.name).to.equal("AX-0001 // DORMANT");
    expect(meta.image).to.equal("ipfs://placeholder.png");

    await reveal(agents);
    await agents.setBaseURI("ipfs://CID/");
    meta = decodeUri(await agents.tokenURI(1));
    expect(meta.name).to.match(/^AX-0001 \/\/ \w+ \w+$/);
    expect(meta.image).to.equal("ipfs://CID/1.png");
    expect(meta.license).to.equal(CC0);
    expect(meta.background_color).to.match(/^[0-9a-f]{6}$/);
    const get = (n) => meta.attributes.find((a) => a.trait_type === n)?.value;
    for (const k of ["Class", "Core Model", "Sensor", "Finish", "Frame", "District", "Faction", "Augment"]) expect(get(k)).to.be.a("string");
    expect(get("Autonomy")).to.equal("Manual");
    expect(get("Agent Wallet")).to.equal((await agents.accountOf(1)).toLowerCase());

    await rep.setAttester(attester.address, true);
    await expect(rep.connect(attester).attest(1, ethers.id("pick-and-place"), false, 9000, ethers.id("d1"), "ipfs://evidence"))
      .to.emit(agents, "MetadataUpdate").withArgs(1);
    meta = decodeUri(await agents.tokenURI(1));
    const g2 = (n) => meta.attributes.find((a) => a.trait_type === n)?.value;
    expect(g2("Tasks")).to.equal(1);
    expect(g2("Failures Logged")).to.equal(1);
    expect(g2("Data Points")).to.equal(90);
    expect(g2("Reputation")).to.equal("Apprentice");
  });

  it("freeze: locks base URI and renderer", async () => {
    const { agents, alice, mint, renderer } = ctx;
    await mint(alice, 1);
    await expect(agents.freezeMetadata()).to.be.revertedWithCustomError(agents, "InvalidParams");
    await reveal(agents);
    await agents.setBaseURI("ipfs://CID/");
    await expect(agents.freezeMetadata()).to.be.revertedWithCustomError(agents, "InvalidParams"); // renderer not locked
    await renderer.lock();
    await expect(renderer.setPresentation("a", "b", "c")).to.be.revertedWithCustomError(renderer, "Locked");
    await agents.freezeMetadata();
    await expect(agents.setBaseURI("ipfs://EVIL/")).to.be.revertedWithCustomError(agents, "MetadataIsFrozen");
    await expect(agents.setRenderer(await renderer.getAddress())).to.be.revertedWithCustomError(agents, "MetadataIsFrozen");
  });

  it("freeze needs a reputation source and a locked renderer bound to this collection; lock needs a full presentation", async () => {
    const noRep = await deployAll({ withReputation: false });
    await noRep.agents.reserveMint(noRep.alice.address, 1); // reveal() moves time past the public drop window
    await reveal(noRep.agents);
    await noRep.agents.setBaseURI("ipfs://CID/");
    await noRep.renderer.lock();
    await expect(noRep.agents.freezeMetadata()).to.be.revertedWithCustomError(noRep.agents, "InvalidParams");

    const { agents, alice, owner } = ctx;
    await agents.reserveMint(alice.address, 1);
    await reveal(agents);
    await agents.setBaseURI("ipfs://CID/");
    // a renderer of another collection, locked: swapping it in must not allow the freeze
    await agents.setRenderer(await noRep.renderer.getAddress());
    await expect(agents.freezeMetadata()).to.be.revertedWithCustomError(agents, "InvalidParams");

    const blank = await (await ethers.getContractFactory("AgentRenderer")).deploy(await agents.getAddress(), owner.address);
    await expect(blank.lock()).to.be.revertedWithCustomError(blank, "IncompletePresentation");
    await blank.setPresentation("ipfs://p.png", "https://x", "");
    await expect(blank.lock()).to.be.revertedWithCustomError(blank, "IncompletePresentation");
  });

  it("unsafe strings rejected; renounceOwnership disabled", async () => {
    const { agents, renderer } = ctx;
    await expect(agents.setBaseURI('ipfs://x","evil":"')).to.be.revertedWithCustomError(agents, "UnsafeString");
    await expect(renderer.setPresentation('a"b', "u", "l")).to.be.revertedWithCustomError(renderer, "UnsafeString");
    await expect(agents.renounceOwnership()).to.be.revertedWithCustomError(agents, "InvalidParams");
  });

  it("5% royalty and setRoyaltyInfo", async () => {
    const { agents, treasury, bob } = ctx;
    const [rcv, amt] = await agents.royaltyInfo(1, ethers.parseEther("1"));
    expect(rcv).to.equal(treasury.address);
    expect(amt).to.equal(ethers.parseEther("0.05"));
    await agents.setRoyaltyInfo({ royaltyAddress: bob.address, royaltyBps: 750 });
    expect(await agents.royaltyBasisPoints()).to.equal(750);
    await expect(agents.setRoyaltyInfo({ royaltyAddress: bob.address, royaltyBps: 10001 })).to.be.revertedWithCustomError(agents, "InvalidRoyaltyBasisPoints");
  });

  it("supportsInterface: ERC721, ERC2981, ERC4906, SeaDrop", async () => {
    const { agents } = ctx;
    for (const id of ["0x80ac58cd", "0x2a55205a", "0x49064906", "0x5b5e139f"]) expect(await agents.supportsInterface(id)).to.equal(true);
    const sd = new ethers.Interface([
      "function updateAllowedSeaDrop(address[])", "function mintSeaDrop(address,uint256)", "function getMintStats(address)",
      "function updatePublicDrop(address,(uint80,uint48,uint48,uint16,uint16,bool))", "function updateAllowList(address,(bytes32,string[],string))",
      "function updateTokenGatedDrop(address,address,(uint80,uint16,uint48,uint48,uint8,uint32,uint16,bool))", "function updateDropURI(address,string)",
      "function updateCreatorPayoutAddress(address,address)", "function updateAllowedFeeRecipient(address,address,bool)",
      "function updateSignedMintValidationParams(address,address,(uint80,uint24,uint40,uint40,uint40,uint16,uint16))", "function updatePayer(address,address,bool)",
    ]);
    let x = 0n;
    sd.forEachFunction((f) => (x ^= BigInt(f.selector)));
    expect(await agents.supportsInterface(ethers.toBeHex(x, 4))).to.equal(true);
  });

  it("transfers: transferNonce, direct and multi-hop cycle prevention", async () => {
    const { agents, alice, bob, mint } = ctx;
    await mint(alice, 2);
    await agents.connect(alice).transferFrom(alice.address, bob.address, 1);
    await agents.connect(bob).transferFrom(bob.address, alice.address, 1);
    expect(await agents.transferNonce(1)).to.equal(2);
    await expect(agents.connect(alice).transferFrom(alice.address, await agents.accountOf(1), 1)).to.be.revertedWithCustomError(agents, "OwnershipCycle");
    await agents.connect(alice).transferFrom(alice.address, await agents.accountOf(2), 1);
    await expect(agents.connect(alice).transferFrom(alice.address, await agents.accountOf(1), 2)).to.be.revertedWithCustomError(agents, "OwnershipCycle");
  });
});
