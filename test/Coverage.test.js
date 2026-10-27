// Edge cases and guard paths (each branch asserts a concrete behaviour, not just execution).
const { expect } = require("chai");
const { ethers, network } = require("hardhat");
const { time, mine, setBalance } = require("@nomicfoundation/hardhat-network-helpers");
const { deployAll, accountOf, decodeUri, reveal } = require("./helpers");

const DAY = 86400;
const pad = (sel) => sel + "00".repeat(64); // selector + two zero words

describe("OpenForgeAgents - guards and admin paths", () => {
  let ctx;
  beforeEach(async () => {
    ctx = await deployAll();
  });

  it("constructor rejects every invalid parameter", async () => {
    const { owner, treasury, registry, impl, seaDrop } = ctx;
    const F = await ethers.getContractFactory("OpenForgeAgents");
    const now = await time.latest();
    const ok = [owner.address, treasury.address, await registry.getAddress(), await impl.getAddress(), 10, 2, now + 7 * DAY, 500, [await seaDrop.getAddress()]];
    const bad = (i, v) => ok.map((x, k) => (k === i ? v : x));
    for (const args of [bad(4, 0), bad(4, 1025), bad(5, 11), bad(1, ethers.ZeroAddress), bad(2, owner.address), bad(3, owner.address), bad(6, now + 3600), bad(8, [owner.address])]) {
      await expect(F.deploy(...args)).to.be.revertedWithCustomError(F, "InvalidParams");
    }
    await expect(F.deploy(...bad(7, 1001))).to.be.revertedWithCustomError(F, "InvalidRoyaltyBasisPoints");
  });

  it("every admin function is owner-only", async () => {
    const { agents, alice, seaDrop } = ctx;
    const a = agents.connect(alice);
    const sd = await seaDrop.getAddress();
    const drop = { mintPrice: 1, startTime: 0, endTime: 1, maxTotalMintableByWallet: 1, feeBps: 0, restrictFeeRecipients: false };
    const calls = [
      a.reserveMint(alice.address, 1), a.setBaseURI("x"), a.setContractURI("x"), a.setMaxSupply(9), a.setProvenanceHash(ethers.ZeroHash),
      a.setRoyaltyInfo({ royaltyAddress: alice.address, royaltyBps: 1 }), a.emitBatchMetadataUpdate(1, 2), a.setRenderer(sd), a.setReputation(sd),
      a.freezeMetadata(), a.updateAllowedSeaDrop([]), a.updatePublicDrop(sd, drop), a.updateAllowList(sd, { merkleRoot: ethers.ZeroHash, publicKeyURIs: [], allowListURI: "" }),
      a.updateTokenGatedDrop(sd, alice.address, { mintPrice: 0, maxTotalMintableByWallet: 1, startTime: 0, endTime: 1, dropStageIndex: 1, maxTokenSupplyForStage: 1, feeBps: 0, restrictFeeRecipients: false }),
      a.updateDropURI(sd, "x"), a.updateCreatorPayoutAddress(sd, alice.address), a.updateAllowedFeeRecipient(sd, alice.address, true),
      a.updateSignedMintValidationParams(sd, alice.address, { minMintPrice: 0, maxMaxTotalMintableByWallet: 1, minStartTime: 0, maxEndTime: 1, maxMaxTokenSupplyForStage: 1, minFeeBps: 0, maxFeeBps: 1 }),
      a.updatePayer(sd, alice.address, true), a.withdraw(alice.address), a.extendRevealDeadline(0),
    ];
    for (const c of calls) await expect(c).to.be.revertedWithCustomError(agents, "OwnableUnauthorizedAccount");
  });

  it("SeaDrop config calls reach the allowed SeaDrop only; the allowed set can shrink and come back, never grow", async () => {
    const { agents, seaDrop, alice, mint } = ctx;
    const sd = await seaDrop.getAddress();
    await agents.updateDropURI(sd, "ipfs://drop");
    expect(await seaDrop.dropURI(await agents.getAddress())).to.equal("ipfs://drop");
    await agents.updateAllowList(sd, { merkleRoot: ethers.id("root"), publicKeyURIs: [], allowListURI: "" });
    expect(await seaDrop.allowListRoot(await agents.getAddress())).to.equal(ethers.id("root"));
    await agents.updateTokenGatedDrop(sd, alice.address, { mintPrice: 0, maxTotalMintableByWallet: 1, startTime: 0, endTime: 1, dropStageIndex: 1, maxTokenSupplyForStage: 1, feeBps: 0, restrictFeeRecipients: false });
    await agents.updateSignedMintValidationParams(sd, alice.address, { minMintPrice: 0, maxMaxTotalMintableByWallet: 1, minStartTime: 0, maxEndTime: 1, maxMaxTokenSupplyForStage: 1, minFeeBps: 0, maxFeeBps: 1 });
    await agents.updatePayer(sd, alice.address, true);
    await expect(agents.updateDropURI(alice.address, "x")).to.be.revertedWithCustomError(agents, "OnlyAllowedSeaDrop");
    await expect(agents.updateAllowedSeaDrop([alice.address])).to.be.revertedWithCustomError(agents, "OnlyAllowedSeaDrop");
    await agents.updateAllowedSeaDrop([]); // emergency stop
    await expect(mint(alice, 1)).to.be.revertedWithCustomError(agents, "OnlyAllowedSeaDrop");
    await agents.updateAllowedSeaDrop([sd]);
    await mint(alice, 1);
    await expect(agents.connect(alice).mintSeaDrop(alice.address, 1)).to.be.revertedWithCustomError(agents, "OnlyAllowedSeaDrop");
  });

  it("SeaDrop cannot mint past the public supply; the reserve cannot exceed its cap or mint to its own wallet", async () => {
    const { agents, seaDrop, alice } = ctx;
    const sd = await seaDrop.getAddress();
    await network.provider.request({ method: "hardhat_impersonateAccount", params: [sd] });
    await setBalance(sd, ethers.parseEther("1"));
    const asSeaDrop = agents.connect(await ethers.getSigner(sd));
    await expect(asSeaDrop.mintSeaDrop(alice.address, 9)).to.be.revertedWithCustomError(agents, "SoldOut"); // 10 - 2 reserve
    await asSeaDrop.mintSeaDrop(alice.address, 8);
    expect(await agents.numberMinted(alice.address)).to.equal(8n);
    await network.provider.request({ method: "hardhat_stopImpersonatingAccount", params: [sd] });
    await expect(agents.reserveMint(alice.address, 3)).to.be.revertedWithCustomError(agents, "ReserveExceeded");
    await expect(agents.reserveMint(await agents.accountOf(9), 1)).to.be.revertedWithCustomError(agents, "OwnershipCycle");
    await agents.reserveMint(alice.address, 2);
  });

  it("transfers to plain contracts and to other collections' wallets are fine", async () => {
    const { agents, alice, renderer } = ctx;
    await agents.reserveMint(alice.address, 2);
    await agents.connect(alice).transferFrom(alice.address, await renderer.getAddress(), 1); // a contract with no token()
    const other = await deployAll();
    await other.agents.reserveMint(alice.address, 1);
    const foreignWallet = await other.agents.accountOf(1);
    await agents.connect(alice).transferFrom(alice.address, foreignWallet, 2);
    expect(await agents.ownerOf(2)).to.equal(foreignWallet);
  });

  it("reveal edges: no reveal before a commit, no second commit after the seed, empty collection reveals quietly", async () => {
    const { agents, alice } = ctx;
    await expect(agents.revealSeed()).to.be.revertedWithCustomError(agents, "NotRevealable");
    const empty = await deployAll();
    await time.increase(8 * DAY);
    await empty.agents.commitReveal();
    await mine(5);
    await expect(empty.agents.revealSeed()).to.emit(empty.agents, "SeedRevealed").and.not.to.emit(empty.agents, "BatchMetadataUpdate");
    await expect(empty.agents.commitReveal()).to.be.revertedWithCustomError(empty.agents, "AlreadyRevealed");
    await expect(agents.setMaxSupply(9)).to.not.be.reverted; // ctx: still open
    await agents.reserveMint(alice.address, 1);
    await agents.commitReveal();
    await expect(agents.setMaxSupply(9)).to.be.revertedWithCustomError(agents, "MintClosed");
  });

  it("metadata setters: JSON-unsafe strings, missing code, frozen state, royalties, events", async () => {
    const { agents, alice, owner, bob } = ctx;
    await expect(agents.setBaseURI("ipfs://a/")).to.not.emit(agents, "BatchMetadataUpdate"); // nothing minted yet
    for (const s of ['ipfs://"x', "ipfs://\\x", "ipfs://\u0001", "ipfs://\u007f"]) {
      await expect(agents.setBaseURI(s)).to.be.revertedWithCustomError(agents, "UnsafeString");
    }
    await expect(agents.setContractURI("data:x")).to.emit(agents, "ContractURIUpdated").withArgs("data:x");
    await expect(agents.setRenderer(alice.address)).to.be.revertedWithCustomError(agents, "InvalidParams");
    await expect(agents.setReputation(alice.address)).to.be.revertedWithCustomError(agents, "InvalidParams");
    await expect(agents.setRoyaltyInfo({ royaltyAddress: ethers.ZeroAddress, royaltyBps: 1 })).to.be.revertedWithCustomError(agents, "RoyaltyAddressCannotBeZeroAddress");
    await expect(agents.setRoyaltyInfo({ royaltyAddress: bob.address, royaltyBps: 1001 })).to.be.revertedWithCustomError(agents, "InvalidRoyaltyBasisPoints");
    await agents.setRoyaltyInfo({ royaltyAddress: bob.address, royaltyBps: 250 });
    expect(await agents.royaltyInfo(1, 10_000)).to.deep.equal([bob.address, 250n]);
    await expect(agents.emitBatchMetadataUpdate(1, 5)).to.emit(agents, "BatchMetadataUpdate").withArgs(1, 5);
    await expect(agents.connect(bob).refreshMetadata(1)).to.be.revertedWithCustomError(agents, "NotAuthorized");
    await expect(agents.connect(owner).refreshMetadata(1)).to.emit(agents, "MetadataUpdate").withArgs(1);

    // freeze needs a base URI; after it, renderer and reputation are fixed
    const fresh = await deployAll();
    await fresh.agents.reserveMint(alice.address, 1);
    await reveal(fresh.agents);
    await fresh.renderer.lock();
    await expect(fresh.agents.freezeMetadata()).to.be.revertedWithCustomError(fresh.agents, "InvalidParams");
    await fresh.agents.setBaseURI("ipfs://CID/");
    await fresh.agents.freezeMetadata();
    await expect(fresh.agents.setReputation(await fresh.rep.getAddress())).to.be.revertedWithCustomError(fresh.agents, "MetadataIsFrozen");
  });

  it("withdraw recovers stray ETH; interfaces are advertised", async () => {
    const { agents, bob } = ctx;
    await setBalance(await agents.getAddress(), ethers.parseEther("0.5"));
    await expect(agents.withdraw(bob.address)).to.changeEtherBalance(bob, ethers.parseEther("0.5"));
    for (const id of ["0x2a55205a", "0x49064906", "0x80ac58cd", "0x01ffc9a7"]) expect(await agents.supportsInterface(id)).to.equal(true);
    expect(await agents.supportsInterface("0xffffffff")).to.equal(false);
  });
});

describe("AgentAccount - guards", () => {
  let ctx, acct, sink;
  beforeEach(async () => {
    ctx = await deployAll();
    await ctx.agents.reserveMint(ctx.alice.address, 2);
    acct = await accountOf(ctx.agents, 1);
    await ctx.owner.sendTransaction({ to: await acct.getAddress(), value: ethers.parseEther("2") });
    sink = ethers.Wallet.createRandom().address;
  });
  const configure = (level, limit = ethers.parseEther("1")) => acct.connect(ctx.alice).configure(ctx.operator.address, level, limit, DAY);

  it("configure validates level, operator and period", async () => {
    const a = acct.connect(ctx.alice);
    for (const lvl of [0, 4]) await expect(a.configure(ctx.operator.address, lvl, 1, DAY)).to.be.revertedWithCustomError(acct, "InvalidLevel");
    for (const [op, period] of [[ethers.ZeroAddress, DAY], [await acct.getAddress(), DAY], [ctx.operator.address, 3599]]) {
      await expect(a.configure(op, 1, 1, period)).to.be.revertedWithCustomError(acct, "InvalidParams");
    }
  });

  it("holder-only functions reject everyone else", async () => {
    const b = acct.connect(ctx.bob);
    for (const c of [b.configure(ctx.bob.address, 1, 1, DAY), b.setPermission(sink, "0x12345678", true), b.setPaused(true), b.lock((await time.latest()) + DAY), b.revokeOperator(), b.approve(0), b.reject(0)]) {
      await expect(c).to.be.revertedWithCustomError(acct, "NotOwner");
    }
  });

  it("whitelist needs an active policy and a real target; locks must be in the future", async () => {
    const a = acct.connect(ctx.alice);
    await expect(a.setPermission(sink, "0x12345678", true)).to.be.revertedWithCustomError(acct, "OperatorInactive");
    await configure(2);
    for (const t of [ethers.ZeroAddress, await acct.getAddress()]) await expect(a.setPermission(t, "0x12345678", true)).to.be.revertedWithCustomError(acct, "InvalidParams");
    await expect(a.lock(await time.latest())).to.be.revertedWithCustomError(acct, "InvalidParams");
  });

  it("the operator can never move assets: every denied selector, at L3", async () => {
    await configure(3);
    const op = acct.connect(ctx.operator);
    const denied = ["0x095ea7b3", "0xa9059cbb", "0x23b872dd", "0x42842e0e", "0xb88d4fde", "0xa22cb465", "0x39509351", "0xd505accf", "0xf242432a", "0x2eb2c2d6", "0xe3ee160e", "0x87517c45", "0x2b67b570", "0x2a2d80d1", "0x8fcbaf0c", "0x4000aea0", "0x1296ee62", "0xc1d34b89", "0xcae9ca51", "0x9bd9bbc6", "0x62ad1b83", "0x959b8c3f", "0x8fcb4e5b", "0x8b72a2ec", "0xf2fde38b", "0x2f2ff15d", "0x51945447"];
    for (const sel of denied) await expect(op.execute(sink, 0, pad(sel), 0)).to.be.revertedWithCustomError(acct, "AssetMoveForbidden").withArgs(sel);
    await expect(op.execute(sink, 0, "0x1234", 0)).to.be.revertedWithCustomError(acct, "InvalidParams"); // truncated selector
    await expect(op.execute(sink, 0, "0x", 0)).to.not.be.reverted; // value 0: no spend accounting
  });

  it("the operator cannot reach a child agent wallet; foreign and fake accounts are not children", async () => {
    await configure(3);
    const op = acct.connect(ctx.operator);
    await ctx.agents.connect(ctx.alice).transferFrom(ctx.alice.address, await acct.getAddress(), 2); // account 1 now owns agent 2
    const child = await ctx.agents.accountOf(2);
    await expect(op.execute(child, 0, "0x", 0)).to.be.revertedWithCustomError(acct, "NestedAccountForbidden");
    // a contract without token(), an account on another chain id, an account bound to a non-contract: all plain targets
    const { registry, impl } = ctx;
    await registry.createAccount(await impl.getAddress(), ethers.ZeroHash, 999, await ctx.agents.getAddress(), 1);
    const otherChain = await registry.account(await impl.getAddress(), ethers.ZeroHash, 999, await ctx.agents.getAddress(), 1);
    await registry.createAccount(await impl.getAddress(), ethers.ZeroHash, 31337, sink, 1);
    const noCode = await registry.account(await impl.getAddress(), ethers.ZeroHash, 31337, sink, 1);
    for (const t of [await ctx.renderer.getAddress(), otherChain, noCode]) await expect(op.execute(t, 0, "0x", 0)).to.not.be.revertedWithCustomError(acct, "NestedAccountForbidden");
    const foreign = await ethers.getContractAt("AgentAccount", otherChain);
    expect(await foreign.owner()).to.equal(ethers.ZeroAddress); // bound to another chain: nobody here owns it
  });

  it("operator power ends with pause or a wrong caller; failed calls bubble up", async () => {
    await configure(3);
    await expect(acct.connect(ctx.bob).execute(sink, 1, "0x", 0)).to.be.revertedWithCustomError(acct, "NotAuthorized");
    await acct.connect(ctx.alice).setPaused(true);
    await expect(acct.connect(ctx.operator).execute(sink, 1, "0x", 0)).to.be.revertedWithCustomError(acct, "NotAuthorized");
    await expect(acct.connect(ctx.alice).execute(await ctx.agents.getAddress(), 0, "0xdeadbeef", 0)).to.be.revertedWithCustomError(acct, "CallFailed");
  });

  it("proposals: only the operator, not to itself, not while locked, at most 50 open; done ones cannot be reused", async () => {
    await expect(acct.connect(ctx.operator).propose(sink, 1, "0x")).to.be.revertedWithCustomError(acct, "NotOperator"); // no policy yet
    await configure(1);
    const op = acct.connect(ctx.operator);
    await expect(acct.connect(ctx.bob).propose(sink, 1, "0x")).to.be.revertedWithCustomError(acct, "NotOperator");
    await expect(op.propose(await acct.getAddress(), 1, "0x")).to.be.revertedWithCustomError(acct, "InvalidParams");
    for (let i = 0; i < 50; i++) await op.propose(sink, 1, "0x");
    await expect(op.propose(sink, 1, "0x")).to.be.revertedWithCustomError(acct, "TooManyProposals");
    await acct.connect(ctx.alice).reject(0);
    await expect(acct.connect(ctx.alice).reject(0)).to.be.revertedWithCustomError(acct, "ProposalInvalid");
    await expect(acct.connect(ctx.alice).approve(0)).to.be.revertedWithCustomError(acct, "ProposalInvalid");
    await acct.connect(ctx.alice).lock((await time.latest()) + DAY);
    await expect(op.propose(sink, 1, "0x")).to.be.revertedWithCustomError(acct, "AccountLocked");
    await expect(acct.connect(ctx.alice).approve(1)).to.be.revertedWithCustomError(acct, "AccountLocked");
  });

  it("advertises its interfaces", async () => {
    for (const id of ["0x01ffc9a7", "0x6faff5f1", "0x51945447", "0x4e2312e0", "0x150b7a02", "0x1626ba7e"]) expect(await acct.supportsInterface(id)).to.equal(true);
    expect(await acct.supportsInterface("0xffffffff")).to.equal(false);
  });
});

describe("AgentRenderer - guards and display paths", () => {
  it("constructor and owner checks; lock needs every presentation field; unsafe strings are refused", async () => {
    const ctx = await deployAll();
    const R = await ethers.getContractFactory("AgentRenderer");
    await expect(R.deploy(ctx.alice.address, ctx.owner.address)).to.be.revertedWithCustomError(R, "UnsafeString");
    await expect(ctx.renderer.connect(ctx.bob).setPresentation("a", "b", "c")).to.be.revertedWithCustomError(ctx.renderer, "OwnableUnauthorizedAccount");
    await expect(ctx.renderer.connect(ctx.bob).lock()).to.be.revertedWithCustomError(ctx.renderer, "OwnableUnauthorizedAccount");
    for (const [p, u, l] of [["", "u", "l"], ["p", "", "l"], ["p", "u", ""]]) {
      await ctx.renderer.setPresentation(p, u, l);
      await expect(ctx.renderer.lock()).to.be.revertedWithCustomError(ctx.renderer, "IncompletePresentation");
    }
    for (const s of ['a"', "a\\", "a\u0001", "a\u007f"]) await expect(ctx.renderer.setPresentation(s, "u", "l")).to.be.revertedWithCustomError(ctx.renderer, "UnsafeString");
    await expect(ctx.renderer.traitsOf(1)).to.be.revertedWithCustomError(ctx.renderer, "NotRevealed");
    await expect(ctx.renderer.legendaryIds()).to.be.revertedWithCustomError(ctx.renderer, "NotRevealed");
  });

  it("reputation tiers in metadata climb with data points; a missing or foreign reputation source is skipped", async () => {
    const ctx = await deployAll();
    await ctx.agents.reserveMint(ctx.alice.address, 2);
    await reveal(ctx.agents);
    await ctx.rep.setAttester(ctx.attester.address, true);
    const tier = async () => decodeUri(await ctx.agents.tokenURI(1)).attributes.find((a) => a.trait_type === "Reputation").value;
    let n = 0;
    const attest = async (k) => {
      for (let i = 0; i < k; i++) await ctx.rep.connect(ctx.attester).attest(1, ethers.id("t"), true, 10_000, ethers.id(`d${n++}`), ""); // 100 points each
    };
    await attest(3);
    expect(await tier()).to.equal("Operator");
    await attest(7);
    expect(await tier()).to.equal("Veteran");
    await attest(40);
    expect(await tier()).to.equal("Elite");

    const noRep = await deployAll({ withReputation: false });
    await noRep.agents.reserveMint(noRep.alice.address, 1);
    await reveal(noRep.agents);
    const attrs = decodeUri(await noRep.agents.tokenURI(1)).attributes.map((a) => a.trait_type);
    expect(attrs).to.include("Autonomy").and.not.include("Reputation");
    await ctx.agents.setReputation(await ctx.seaDrop.getAddress()); // a contract without statsOf
    expect(decodeUri(await ctx.agents.tokenURI(1)).attributes.map((a) => a.trait_type)).to.not.include("Reputation");
  });

  it("a full 1,024 collection: 10 legendaries at most, unique ids, four-digit names", async function () {
    this.timeout(600_000);
    const ctx = await deployAll({ maxSupply: 1024, reserve: 1024 });
    for (let i = 0; i < 1024; i += 64) await ctx.agents.reserveMint(ctx.alice.address, 64);
    await reveal(ctx.agents);
    expect(await ctx.renderer.legendaryCount()).to.equal(10n);
    const ids = (await ctx.renderer.legendaryIds()).map(Number);
    expect(new Set(ids).size).to.equal(10);
    expect(decodeUri(await ctx.agents.tokenURI(1024)).name).to.match(/^(AX-1024|[A-Z0-9 ]+)/);
    const plain = Array.from({ length: 1024 }, (_, i) => i + 1).find((id) => !ids.includes(id) && id >= 1000);
    expect(decodeUri(await ctx.agents.tokenURI(plain)).name).to.match(new RegExp(`^AX-${plain} // `));
  });
});

describe("AgentReputation - tier names", () => {
  it("names every tier, matching the renderer", async () => {
    const { rep } = await deployAll();
    expect(await Promise.all([0, 1, 2, 3, 4].map((t) => rep.tierName(t)))).to.deep.equal(["Rookie", "Apprentice", "Operator", "Veteran", "Elite"]);
  });
});
