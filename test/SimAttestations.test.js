const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const { deployAll, reveal, decodeUri } = require("./helpers");

const r = (tokenId, success, quality, tag) => ({ tokenId, success, quality, dataHash: ethers.id(tag) });

describe("AgentReputation - simulation attestations", () => {
  it("needs a contract for agents and can never be left without an owner", async () => {
    const { rep, owner } = await deployAll();
    const F = await ethers.getContractFactory("AgentReputation");
    await expect(F.deploy(owner.address, owner.address)).to.be.revertedWithCustomError(F, "InvalidAgents");
    await expect(rep.renounceOwnership()).to.be.revertedWithCustomError(rep, "RenounceDisabled");
  });

  async function setup() {
    const ctx = await deployAll();
    await ctx.agents.reserveMint(ctx.alice.address, 2);
    await ctx.rep.setSimAttester(ctx.attester.address, true);
    return ctx;
  }

  it("is sim-attester-only, separate from the real attester role", async () => {
    const { rep, bob, carol, attester, owner } = await setup();
    await expect(rep.connect(bob).attestSimBatch([r(1, true, 100, "a")], "")).to.be.revertedWithCustomError(rep, "NotAttester");
    await rep.setAttester(carol.address, true);
    await expect(rep.connect(carol).attestSimBatch([r(1, true, 100, "a")], "")).to.be.revertedWithCustomError(rep, "NotAttester");
    await expect(rep.connect(attester).attest(1, ethers.id("t"), true, 100, ethers.id("a"), "")).to.be.revertedWithCustomError(rep, "NotAttester");
    await expect(rep.connect(bob).setSimAttester(bob.address, true)).to.be.revertedWithCustomError(rep, "OwnableUnauthorizedAccount");
    await expect(rep.connect(owner).setSimAttester(bob.address, true)).to.emit(rep, "SimAttesterSet").withArgs(bob.address, true);
  });

  it("rejects sim duplicates within and across batches (skipped, not reverted); sim and real hashes never collide", async () => {
    const { rep, attester, carol } = await setup();
    await rep.setAttester(carol.address, true);
    const real = rep.connect(carol);
    await real.attest(1, ethers.id("t"), true, 100, ethers.id("real"), "");
    const tx = rep.connect(attester).attestSimBatch([r(1, true, 100, "real"), r(1, true, 100, "sim"), r(1, true, 1, "sim")], "");
    await expect(tx).to.emit(rep, "SimRejected").withArgs(1, ethers.id("sim"), 3);
    await expect(tx).to.emit(rep, "SimBatch").withArgs(attester.address, 3, 2, "");
    await expect(rep.connect(attester).attestSimBatch([r(1, true, 100, "sim")], "")).to.emit(rep, "SimRejected").withArgs(1, ethers.id("sim"), 3);
    // a sim attester cannot squat a hash that a real attestation will use later
    await expect(real.attest(1, ethers.id("t"), true, 100, ethers.id("sim"), "")).to.emit(rep, "Attested");
    await expect(real.attest(1, ethers.id("t"), true, 100, ethers.id("sim"), "")).to.be.revertedWithCustomError(rep, "DataAlreadyAttested");
    await rep.connect(attester).attestSimBatch([r(2, true, 100, "sim")], ""); // same hash, other token
    expect((await rep.simStatsOf(2))[0]).to.equal(1n);
  });

  it("a mixed batch accepts only valid items and reports each reject reason", async () => {
    const { rep, attester } = await setup();
    const batch = [
      r(1, true, 5000, "ok"),
      r(1, true, 10001, "q"),
      { tokenId: 1, success: true, quality: 1, dataHash: ethers.ZeroHash },
      r(1, true, 5000, "ok"),
      r(99, true, 1, "x"),
    ];
    const tx = rep.connect(attester).attestSimBatch(batch, "u");
    await expect(tx).to.emit(rep, "SimRejected").withArgs(1, ethers.id("q"), 1);
    await expect(tx).to.emit(rep, "SimRejected").withArgs(1, ethers.ZeroHash, 2);
    await expect(tx).to.emit(rep, "SimRejected").withArgs(1, ethers.id("ok"), 3);
    await expect(tx).to.emit(rep, "SimRejected").withArgs(99, ethers.id("x"), 4);
    await expect(tx).to.emit(rep, "SimBatch").withArgs(attester.address, 5, 1, "u");
    expect(await rep.simStatsOf(1)).to.deep.equal([1n, 1n]);
  });

  it("caps sim runs at 10 per token per day (skips with reason 5), resets next day", async () => {
    const { rep, attester } = await setup();
    const a = rep.connect(attester);
    expect(await rep.SIM_DAILY_CAP()).to.equal(10);
    await a.attestSimBatch(Array.from({ length: 10 }, (_, i) => r(1, true, 1, "c" + i)), "");
    await expect(a.attestSimBatch([r(1, true, 1, "over"), r(2, true, 1, "other")], ""))
      .to.emit(rep, "SimRejected").withArgs(1, ethers.id("over"), 5);
    expect((await rep.simStatsOf(1))[0]).to.equal(10n);
    expect((await rep.simStatsOf(2))[0]).to.equal(1n); // per token
    await time.increase(86400);
    await a.attestSimBatch([r(1, true, 1, "over")], "");
    expect((await rep.simStatsOf(1))[0]).to.equal(11n);
  });

  it("validates batch size (the only item-independent reverts)", async () => {
    const { rep, attester } = await setup();
    const a = rep.connect(attester);
    await expect(a.attestSimBatch([], "")).to.be.revertedWithCustomError(rep, "BatchSize");
    const big = Array.from({ length: 101 }, (_, i) => r(1, true, 1, "n" + i));
    await expect(a.attestSimBatch(big, "")).to.be.revertedWithCustomError(rep, "BatchSize");
  });

  it("shows Sim Runs / Sim Successes in tokenURI", async () => {
    const { agents, rep, attester } = await setup();
    await rep.connect(attester).attestSimBatch([r(1, true, 8000, "a"), r(1, false, 8000, "b")], "");
    await reveal(agents);
    const attrs = decodeUri(await agents.tokenURI(1)).attributes;
    expect(attrs.find((x) => x.trait_type === "Sim Runs").value).to.equal(2);
    expect(attrs.find((x) => x.trait_type === "Sim Successes").value).to.equal(1);
  });
});
