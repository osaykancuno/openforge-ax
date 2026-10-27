const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const { deployAll, accountOf } = require("./helpers");

describe("AgentAccount - autonomy policy", () => {
  let ctx, acct, sink;
  const DAY = 86400;

  beforeEach(async () => {
    ctx = await deployAll();
    await ctx.agents.reserveMint(ctx.alice.address, 1);
    acct = await accountOf(ctx.agents, 1);
    await ctx.owner.sendTransaction({ to: await acct.getAddress(), value: ethers.parseEther("5") });
    sink = ethers.Wallet.createRandom().address;
  });

  const configure = (level, limit = ethers.parseEther("1")) =>
    acct.connect(ctx.alice).configure(ctx.operator.address, level, limit, DAY);

  it("holder can always execute; unauthorized callers cannot", async () => {
    await expect(acct.connect(ctx.alice).execute(sink, ethers.parseEther("1"), "0x", 0)).to.changeEtherBalance(sink, ethers.parseEther("1"));
    await expect(acct.connect(ctx.bob).execute(sink, 1, "0x", 0)).to.be.revertedWithCustomError(acct, "NotAuthorized");
    await expect(acct.connect(ctx.alice).execute(sink, 1, "0x", 1)).to.be.revertedWithCustomError(acct, "UnsupportedOperation");
  });

  it("L1: operator cannot execute, only propose; holder approves or rejects", async () => {
    await configure(1);
    await expect(acct.connect(ctx.operator).execute(sink, 1, "0x", 0)).to.be.revertedWithCustomError(acct, "NotAuthorized");
    await acct.connect(ctx.operator).propose(sink, ethers.parseEther("0.5"), "0x");
    await expect(acct.connect(ctx.bob).approve(0)).to.be.revertedWithCustomError(acct, "NotOwner");
    await expect(acct.connect(ctx.alice).approve(0)).to.changeEtherBalance(sink, ethers.parseEther("0.5"));
    await expect(acct.connect(ctx.alice).approve(0)).to.be.revertedWithCustomError(acct, "ProposalInvalid");
    await acct.connect(ctx.operator).propose(sink, 1, "0x");
    await acct.connect(ctx.alice).reject(1);
    await expect(acct.connect(ctx.alice).approve(1)).to.be.revertedWithCustomError(acct, "ProposalInvalid");
  });

  it("L2: (target, selector) whitelist + per-period cap with reset", async () => {
    await configure(2);
    await expect(acct.connect(ctx.operator).execute(sink, 1, "0x", 0)).to.be.revertedWithCustomError(acct, "TargetNotAllowed");
    await acct.connect(ctx.alice).setPermission(sink, "0x00000000", true); // plain ETH transfers
    await expect(acct.connect(ctx.operator).execute(sink, ethers.parseEther("0.6"), "0x", 0)).to.changeEtherBalance(sink, ethers.parseEther("0.6"));
    await expect(acct.connect(ctx.operator).execute(sink, ethers.parseEther("0.5"), "0x", 0)).to.be.revertedWithCustomError(acct, "SpendLimitExceeded");
    await time.increase(DAY + 1);
    await expect(acct.connect(ctx.operator).execute(sink, ethers.parseEther("0.5"), "0x", 0)).to.changeEtherBalance(sink, ethers.parseEther("0.5"));
  });

  it("L2: operator cannot self-configure or call the account itself", async () => {
    await configure(2);
    await expect(acct.connect(ctx.operator).configure(ctx.operator.address, 3, ethers.MaxUint256 >> 128n, DAY)).to.be.revertedWithCustomError(acct, "NotOwner");
    await expect(acct.connect(ctx.operator).execute(await acct.getAddress(), 0, "0x", 0)).to.be.revertedWithCustomError(acct, "InvalidParams");
  });

  it("L3: any target, ETH cap still enforced", async () => {
    await configure(3, ethers.parseEther("1"));
    await expect(acct.connect(ctx.operator).execute(sink, ethers.parseEther("1"), "0x", 0)).to.changeEtherBalance(sink, ethers.parseEther("1"));
    await expect(acct.connect(ctx.operator).execute(sink, 1, "0x", 0)).to.be.revertedWithCustomError(acct, "SpendLimitExceeded");
  });

  it("emergency pause blocks the operator; operator ERC-1271 signatures are never valid", async () => {
    const opWallet = ethers.Wallet.createRandom();
    await acct.connect(ctx.alice).configure(opWallet.address, 3, ethers.parseEther("1"), DAY);
    const hash = ethers.id("order");
    const raw = opWallet.signingKey.sign(hash).serialized;
    expect(await acct.isValidSignature(hash, raw)).to.equal("0xffffffff"); // operator: never
    expect(await acct.isValidSigner(opWallet.address, "0x")).to.equal("0x00000000"); // only the holder is a signer
    await acct.connect(ctx.alice).setPaused(true);
    expect(await acct.isValidSigner(ctx.alice.address, "0x")).to.equal("0x523e3260");
    await acct.connect(ctx.alice).setPaused(false);
    await acct.connect(ctx.alice).configure(ctx.operator.address, 3, ethers.parseEther("1"), DAY);
    await expect(acct.connect(ctx.operator).execute(sink, 1, "0x", 0)).to.changeEtherBalance(sink, 1);
    await acct.connect(ctx.alice).setPaused(true);
    await expect(acct.connect(ctx.operator).execute(sink, 1, "0x", 0)).to.be.revertedWithCustomError(acct, "NotAuthorized");
  });

  it("holder ERC-1271 signature is valid (EOA) and blocked by the sale lock", async () => {
    const wallet = ethers.Wallet.createRandom().connect(ethers.provider);
    await ctx.owner.sendTransaction({ to: wallet.address, value: ethers.parseEther("1") });
    await ctx.agents.reserveMint(wallet.address, 1); // id 2
    const a2 = await accountOf(ctx.agents, 2);
    const hash = ethers.id("seaport-order");
    const sig = wallet.signingKey.sign(hash).serialized;
    expect(await a2.isValidSignature(hash, sig)).to.equal("0x1626ba7e");
    await a2.connect(wallet).lock((await time.latest()) + DAY);
    expect(await a2.isValidSignature(hash, sig)).to.equal("0xffffffff");
  });

  it("operator (L2/L3) cannot move assets: approve/transfer/setApprovalForAll forbidden", async () => {
    await configure(3);
    const iface = new ethers.Interface(["function approve(address,uint256)", "function transfer(address,uint256)", "function setApprovalForAll(address,bool)", "function foo()"]);
    for (const [fn, args] of [["approve", [sink, 1]], ["transfer", [sink, 1]], ["setApprovalForAll", [sink, true]]]) {
      await expect(acct.connect(ctx.operator).execute(await ctx.agents.getAddress(), 0, iface.encodeFunctionData(fn, args), 0))
        .to.be.revertedWithCustomError(acct, "AssetMoveForbidden");
    }
    // short payload (1-3 bytes) rejected
    await expect(acct.connect(ctx.operator).execute(sink, 0, "0x1234", 0)).to.be.revertedWithCustomError(acct, "InvalidParams");
    // the holder can do it
    await acct.connect(ctx.alice).execute(await ctx.agents.getAddress(), 0, iface.encodeFunctionData("setApprovalForAll", [sink, false]), 0);
  });

  it("NFT transfer: seller policy lapses, no operator inherited", async () => {
    await configure(3);
    await acct.connect(ctx.alice).setPermission(sink, "0xffffffff", true);
    await ctx.agents.connect(ctx.alice).transferFrom(ctx.alice.address, ctx.bob.address, 1);
    expect(await acct.autonomyLevel()).to.equal(1);
    await expect(acct.connect(ctx.operator).execute(sink, 1, "0x", 0)).to.be.revertedWithCustomError(acct, "NotAuthorized");
    await expect(acct.connect(ctx.alice).execute(sink, 1, "0x", 0)).to.be.revertedWithCustomError(acct, "NotAuthorized");
    await expect(acct.connect(ctx.bob).execute(sink, 1, "0x", 0)).to.changeEtherBalance(sink, 1);
    // new holder reconfigures: old whitelist is cleared (epoch)
    await acct.connect(ctx.bob).configure(ctx.operator.address, 2, ethers.parseEther("1"), DAY);
    expect(await acct.isAllowed(sink, "0x00000000")).to.equal(false);
  });

  it("previous holder's proposal cannot be approved by the new holder", async () => {
    await configure(1);
    await acct.connect(ctx.operator).propose(sink, 1, "0x");
    await ctx.agents.connect(ctx.alice).transferFrom(ctx.alice.address, ctx.bob.address, 1);
    await acct.connect(ctx.bob).configure(ctx.operator.address, 1, 0, DAY);
    await expect(acct.connect(ctx.bob).approve(0)).to.be.revertedWithCustomError(acct, "ProposalInvalid");
  });

  it("sale lock: blocks execution, signatures and approvals; max 30 days", async () => {
    await expect(acct.connect(ctx.alice).lock((await time.latest()) + 31 * DAY)).to.be.revertedWithCustomError(acct, "InvalidParams");
    await acct.connect(ctx.alice).lock((await time.latest()) + 7 * DAY);
    await expect(acct.connect(ctx.alice).execute(sink, 1, "0x", 0)).to.be.revertedWithCustomError(acct, "AccountLocked");
    expect(await acct.isValidSigner(ctx.alice.address, "0x")).to.equal("0x00000000");
    await time.increase(7 * DAY + 1);
    await expect(acct.connect(ctx.alice).execute(sink, 1, "0x", 0)).to.changeEtherBalance(sink, 1);
  });

  it("receives ERC-721 but rejects its own parent NFT", async () => {
    await ctx.agents.reserveMint(ctx.alice.address, 1); // id 2
    await ctx.agents.connect(ctx.alice)["safeTransferFrom(address,address,uint256)"](ctx.alice.address, await acct.getAddress(), 2);
    expect(await ctx.agents.ownerOf(2)).to.equal(await acct.getAddress());
    await expect(
      ctx.agents.connect(ctx.alice)["safeTransferFrom(address,address,uint256)"](ctx.alice.address, await acct.getAddress(), 1)
    ).to.be.reverted;
  });

  it("revokeOperator removes all operator power", async () => {
    await configure(3);
    await acct.connect(ctx.alice).revokeOperator();
    await expect(acct.connect(ctx.operator).execute(sink, 1, "0x", 0)).to.be.revertedWithCustomError(acct, "NotAuthorized");
  });

  it("whitelist changes bump the ERC-6551 state", async () => {
    await configure(2);
    const s0 = await acct.state();
    await acct.connect(ctx.alice).setPermission(sink, "0x12345678", true);
    expect(await acct.state()).to.not.equal(s0);
  });
});

describe("AgentReputation", () => {
  it("attester-only, no data reuse, quality <= 10000, existing token, tiers", async () => {
    const { agents, rep, alice, attester, bob } = await deployAll();
    await agents.reserveMint(alice.address, 1);
    const args = (hash, q = 5000, ok = true) => [1, ethers.id("task"), ok, q, hash, "ipfs://e"];
    await expect(rep.connect(attester).attest(...args(ethers.id("a")))).to.be.revertedWithCustomError(rep, "NotAttester");
    await rep.setAttester(attester.address, true);
    await expect(rep.connect(attester).attest(...args(ethers.id("a"), 10001))).to.be.revertedWithCustomError(rep, "InvalidQuality");
    await expect(rep.connect(attester).attest(...args(ethers.ZeroHash))).to.be.revertedWithCustomError(rep, "EmptyDataHash");
    await expect(rep.connect(attester).attest(99, ethers.id("t"), true, 10, ethers.id("x"), "")).to.be.revertedWithCustomError(rep, "UnknownAgent");
    await rep.connect(attester).attest(...args(ethers.id("a"), 10000));
    await expect(rep.connect(attester).attest(...args(ethers.id("a")))).to.be.revertedWithCustomError(rep, "DataAlreadyAttested");
    expect(await rep.tierOf(1)).to.equal(1); // 100 points
    for (let i = 0; i < 2; i++) await rep.connect(attester).attest(...args(ethers.id("b" + i), 10000, false));
    expect(await rep.tierOf(1)).to.equal(2); // 300 points
    const [tasks, ok, fail, pts] = await rep.statsOf(1);
    expect([tasks, ok, fail, pts]).to.deep.equal([3n, 1n, 2n, 300n]);
    await expect(rep.connect(bob).setAttester(bob.address, true)).to.be.revertedWithCustomError(rep, "OwnableUnauthorizedAccount");
  });
});

describe("AgentAccount - sale scenarios", () => {
  const DAY = 86400;
  it("A -> B -> A: A's policy does not revive, even if B configured nothing", async () => {
    const ctx = await deployAll();
    await ctx.agents.reserveMint(ctx.alice.address, 1);
    const acct = await accountOf(ctx.agents, 1);
    await ctx.owner.sendTransaction({ to: await acct.getAddress(), value: ethers.parseEther("1") });
    await acct.connect(ctx.alice).configure(ctx.operator.address, 3, ethers.parseEther("1"), DAY);
    await ctx.agents.connect(ctx.alice).transferFrom(ctx.alice.address, ctx.bob.address, 1);
    await ctx.agents.connect(ctx.bob).transferFrom(ctx.bob.address, ctx.alice.address, 1);
    expect(await acct.autonomyLevel()).to.equal(1);
    await expect(acct.connect(ctx.operator).execute(ethers.Wallet.createRandom().address, 1, "0x", 0)).to.be.revertedWithCustomError(acct, "NotAuthorized");
  });

  it("seller's lock is not inherited by the buyer", async () => {
    const ctx = await deployAll();
    await ctx.agents.reserveMint(ctx.alice.address, 1);
    const acct = await accountOf(ctx.agents, 1);
    await ctx.owner.sendTransaction({ to: await acct.getAddress(), value: ethers.parseEther("1") });
    await acct.connect(ctx.alice).lock((await time.latest()) + 30 * DAY);
    await expect(acct.connect(ctx.alice).execute(ctx.bob.address, 1, "0x", 0)).to.be.revertedWithCustomError(acct, "AccountLocked");
    await ctx.agents.connect(ctx.alice).transferFrom(ctx.alice.address, ctx.bob.address, 1);
    await expect(acct.connect(ctx.bob).execute(ctx.carol.address, 1, "0x", 0)).to.changeEtherBalance(ctx.carol, 1);
    // the buyer can set a shorter lock of its own; its own lock is then extend-only
    await acct.connect(ctx.bob).lock((await time.latest()) + 7 * DAY);
    await expect(acct.connect(ctx.bob).lock((await time.latest()) + 3 * DAY)).to.be.revertedWithCustomError(acct, "InvalidParams");
  });

  it("a seller's lock does not come back when the seller buys the agent back (A -> B -> A)", async () => {
    const ctx = await deployAll();
    await ctx.agents.reserveMint(ctx.alice.address, 1);
    const acct = await accountOf(ctx.agents, 1);
    await ctx.owner.sendTransaction({ to: await acct.getAddress(), value: ethers.parseEther("1") });
    await acct.connect(ctx.alice).lock((await time.latest()) + 30 * DAY);
    await ctx.agents.connect(ctx.alice).transferFrom(ctx.alice.address, ctx.bob.address, 1);
    await ctx.agents.connect(ctx.bob).transferFrom(ctx.bob.address, ctx.alice.address, 1);
    await expect(acct.connect(ctx.alice).execute(ctx.carol.address, 1, "0x", 0)).to.changeEtherBalance(ctx.carol, 1);
    // a fresh holding period: a new, shorter lock is accepted and then extend-only again
    await acct.connect(ctx.alice).lock((await time.latest()) + 3 * DAY);
    await expect(acct.connect(ctx.alice).execute(ctx.carol.address, 1, "0x", 0)).to.be.revertedWithCustomError(acct, "AccountLocked");
    await expect(acct.connect(ctx.alice).lock((await time.latest()) + 2 * DAY)).to.be.revertedWithCustomError(acct, "InvalidParams");
  });
});
