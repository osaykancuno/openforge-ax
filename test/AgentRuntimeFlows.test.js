const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const { deployAll, accountOf, decodeUri } = require("./helpers");

// The agent console's rules (web/js/agent/*) against the real AgentAccount: what the browser key may do alone, what it
// may not, and when it must stop. The contract is the authority; these tests fail if the page's copy of a rule drifts.
describe("Agent runtime flows (console rules vs AgentAccount)", () => {
  let ctx, acct, acctAddr, W, P, A;
  const DAY = 86400;
  const LIMIT = ethers.parseEther("0.01");
  const NOARGS = "0x00000000";

  before(async () => {
    W = await import("../web/js/agent/watch.js");
    P = await import("../web/js/agent/policy.js");
    A = await import("../web/js/agent/actions.js");
  });

  beforeEach(async () => {
    ctx = await deployAll();
    await ctx.agents.reserveMint(ctx.alice.address, 1);
    acct = await accountOf(ctx.agents, 1);
    acctAddr = await acct.getAddress();
    await ctx.owner.sendTransaction({ to: acctAddr, value: ethers.parseEther("5") });
  });

  /** The console's own view of the chain, as the page reads it. */
  const read = async () => W.readState({ account: acct, agents: ctx.agents, tokenId: 1, provider: ethers.provider, accountAddress: acctAddr });
  /** The four steps "Create an agent key" asks the holder to sign. */
  async function enableAssisted(limit = LIMIT) {
    const key = ctx.operator;
    await acct.connect(ctx.alice).configure(key.address, 2, limit, DAY);
    for (const p of A.permissionsFor({ operator: key.address, holder: ctx.alice.address })) await acct.connect(ctx.alice).setPermission(p.target, p.selector, true);
  }
  const run = (call, signer = ctx.operator) => acct.connect(signer).execute(call.to, call.value, call.data, 0);

  describe("the page's ABI and state reader", () => {
    it("reads every field the console needs, in the shapes the pure rules expect", async () => {
      await enableAssisted();
      const s = await read();
      expect(s.owner).to.equal(ctx.alice.address);
      expect(s.operator).to.equal(ctx.operator.address);
      expect(s.level).to.equal(2);
      expect(s.paused).to.equal(false);
      expect(s.configuredFor).to.equal(ctx.alice.address);
      expect(s.configuredNonce).to.equal(s.transferNonce);
      expect(s.periodLimit).to.equal(LIMIT);
      expect(s.periodLength).to.equal(DAY);
      expect(s.balance).to.equal(ethers.parseEther("5"));
      expect(s.lockedUntil).to.equal(0);
      expect(typeof s.periodStart).to.equal("number");
      expect(s.time, "the chain's clock, not the browser's").to.equal((await ethers.provider.getBlock("latest")).timestamp);
    });
    it("reads at a given block, so a lagging node cannot plan from a stale balance", async () => {
      await enableAssisted();
      const b0 = await ethers.provider.getBlockNumber();
      await ctx.owner.sendTransaction({ to: acctAddr, value: 1n });
      const before = await W.readState({ account: acct, agents: ctx.agents, tokenId: 1, provider: ethers.provider, accountAddress: acctAddr, blockTag: b0 });
      const after = await read();
      expect(after.balance - before.balance).to.equal(1n);
    });
    it("the human-readable ABI the page builds contracts from matches the deployed contract", async () => {
      const c = new ethers.Contract(acctAddr, W.ACCOUNT_ABI, ethers.provider);
      await enableAssisted();
      expect(await c.isAllowed(ctx.operator.address, NOARGS)).to.equal(true);
      expect(await c.configuredFor()).to.equal(ctx.alice.address);
      expect(await c.policyEpoch()).to.equal(1n);
      const w = new ethers.Contract(acctAddr, W.ACCOUNT_ABI, ctx.alice);
      await w.setPaused(true);
      expect(await c.paused()).to.equal(true);
      const a = new ethers.Contract(await ctx.agents.getAddress(), W.AGENTS_ABI, ethers.provider);
      expect(await a.transferNonce(1)).to.equal(0n);
    });
  });

  describe("Assisted: the key refuels its own gas and sweeps surplus to the holder", () => {
    beforeEach(enableAssisted);

    it("the two whitelist entries are enough for the built-in actions, nothing else", async () => {
      const op = ctx.operator.address;
      const sink = ethers.Wallet.createRandom().address;
      await expect(run({ to: op, value: 1n, data: "0x" })).to.changeEtherBalance(acctAddr, -1n);
      await expect(run({ to: ctx.alice.address, value: 1n, data: "0x" })).to.changeEtherBalance(ctx.alice, 1n);
      await expect(run({ to: sink, value: 1n, data: "0x" })).to.be.revertedWithCustomError(acct, "TargetNotAllowed");
      await expect(run({ to: ctx.alice.address, value: 0n, data: "0x12345678" })).to.be.revertedWithCustomError(acct, "TargetNotAllowed");
      await expect(run({ to: op, value: 0n, data: "0xdeadbeef" })).to.be.revertedWithCustomError(acct, "TargetNotAllowed");
    });
    it("without the entries the key cannot do even those; a new configure() empties them again", async () => {
      const op = ctx.operator.address;
      await acct.connect(ctx.alice).configure(op, 2, LIMIT, DAY); // same key, new epoch
      expect(await acct.isAllowed(op, NOARGS)).to.equal(false);
      await expect(run({ to: op, value: 1n, data: "0x" })).to.be.revertedWithCustomError(acct, "TargetNotAllowed");
    });
    it("the planner's choices are always accepted by the contract, until the daily limit is spent", async () => {
      // a real browser key: a fresh wallet that holds a little gas and nothing else
      const keyW = ethers.Wallet.createRandom().connect(ethers.provider);
      await acct.connect(ctx.alice).configure(keyW.address, 2, LIMIT, DAY);
      for (const p of A.permissionsFor({ operator: keyW.address, holder: ctx.alice.address })) await acct.connect(ctx.alice).setPermission(p.target, p.selector, true);
      await ctx.owner.sendTransaction({ to: keyW.address, value: ethers.parseEther("0.0009") });
      const gas = { gasLimit: 150000, gasPrice: 2n * 10n ** 9n }; // explicit: the key holds almost nothing
      const go = (call) => acct.connect(keyW).execute(call.to, call.value, call.data, 0, gas);
      const keep = ethers.parseEther("4.98");
      const step = async () => {
        const s = await read();
        const now = (await ethers.provider.getBlock("latest")).timestamp;
        return A.nextAction({
          operator: keyW.address,
          holder: ctx.alice.address,
          keyBalance: await ethers.provider.getBalance(keyW.address),
          accountBalance: s.balance,
          remaining: P.remainingCap(s, now + 1),
          keep,
        });
      };
      const first = await step();
      expect(first.id).to.equal("refuel");
      expect(first.value).to.equal(P.GAS_FLOAT - ethers.parseEther("0.0009"));
      expect(A.guard(first, { operator: keyW.address, holder: ctx.alice.address, remaining: LIMIT })).to.equal(null);
      await go(first);
      const second = await step();
      expect(second.id).to.equal("sweep"); // the key now holds the float
      const before = await ethers.provider.getBalance(ctx.alice.address);
      await go(second);
      expect(await ethers.provider.getBalance(ctx.alice.address)).to.equal(before + second.value);
      // the limit is now spent: the planner has nothing more to do, and the contract would refuse anyway
      expect((await step()).skip).to.equal("cap-reached");
      await expect(acct.connect(keyW).execute(ctx.alice.address, 1n, "0x", 0, gas)).to.be.revertedWithCustomError(acct, "SpendLimitExceeded");
    });
    it("the key pays the gas of its own transactions, not the agent wallet", async () => {
      const op = ctx.operator.address;
      const before = await ethers.provider.getBalance(op);
      const tx = await run({ to: ctx.alice.address, value: 10n, data: "0x" });
      const rc = await tx.wait();
      expect(await ethers.provider.getBalance(op)).to.equal(before - rc.gasUsed * rc.gasPrice);
    });
  });

  describe("daily limit: up to twice across the reset", () => {
    beforeEach(enableAssisted);
    it("the whole limit at the end of one window and again at the start of the next", async () => {
      const call = { to: ctx.alice.address, value: LIMIT, data: "0x" };
      const t0 = (await acct.periodStart()) + 0n; // configure() opened the first window
      await time.setNextBlockTimestamp(t0 + BigInt(DAY) - 5n);
      await run(call);
      expect((await read()).spentInPeriod).to.equal(LIMIT);
      expect(P.remainingCap(await read(), Number(t0) + DAY - 4)).to.equal(0n);
      await expect(run({ ...call, value: 1n })).to.be.revertedWithCustomError(acct, "SpendLimitExceeded");
      await time.setNextBlockTimestamp(t0 + BigInt(DAY) + 2n); // seven seconds after the first spend
      expect(P.remainingCap(await read(), Number(t0) + DAY + 2)).to.equal(LIMIT); // the planner sees the reset the contract will apply
      const before = await ethers.provider.getBalance(ctx.alice.address);
      await run(call);
      expect(await ethers.provider.getBalance(ctx.alice.address)).to.equal(before + LIMIT);
      await expect(run({ ...call, value: 1n })).to.be.revertedWithCustomError(acct, "SpendLimitExceeded");
      // two limits left the wallet within seven seconds: the "up to twice" the confirmation text promises
      expect(P.limitNote(LIMIT)).to.include("0.02 ETH");
    });
    it("remainingCap agrees with the contract after every spend", async () => {
      await run({ to: ctx.alice.address, value: ethers.parseEther("0.004"), data: "0x" });
      const s = await read();
      const now = (await ethers.provider.getBlock("latest")).timestamp;
      expect(P.remainingCap(s, now)).to.equal(ethers.parseEther("0.006"));
      await expect(run({ to: ctx.alice.address, value: ethers.parseEther("0.006") + 1n, data: "0x" })).to.be.revertedWithCustomError(acct, "SpendLimitExceeded");
      await run({ to: ctx.alice.address, value: ethers.parseEther("0.006"), data: "0x" });
    });
  });

  describe("a transfer ends the key's authority", () => {
    beforeEach(enableAssisted);
    const transfer = (from, to) => ctx.agents.connect(from).transferFrom(from.address, to.address, 1);

    it("the key is refused, the level reads Manual, and the console stops with the plain message", async () => {
      const rec = { address: ctx.operator.address, holder: ctx.alice.address };
      expect(P.keyStatus({ ...(await read()), now: 1 }, rec).state).to.equal("acting");
      await transfer(ctx.alice, ctx.bob);
      await expect(run({ to: ctx.alice.address, value: 1n, data: "0x" })).to.be.revertedWithCustomError(acct, "NotAuthorized");
      const s = await read();
      expect(s.level).to.equal(1);
      expect(s.operator).to.equal(ctx.operator.address); // still stored: the policy lapsed, it was not erased
      const st = P.keyStatus({ ...s, now: 1 }, rec);
      expect(st).to.include({ state: "stopped", code: "changed-hands" });
      expect(st.message).to.equal("This agent changed hands; this key no longer acts.");
      expect(W.watchWallet(s, null, 1).items.map((i) => i.id)).to.include("lapsed");
    });
    it("A -> B -> A does not revive it", async () => {
      await transfer(ctx.alice, ctx.bob);
      await transfer(ctx.bob, ctx.alice);
      await expect(run({ to: ctx.alice.address, value: 1n, data: "0x" })).to.be.revertedWithCustomError(acct, "NotAuthorized");
      const st = P.keyStatus({ ...(await read()), now: 1 }, { address: ctx.operator.address, holder: ctx.alice.address });
      expect(st.code).to.equal("changed-hands");
    });
    it("a proposal made before the transfer is invalid afterwards", async () => {
      await acct.connect(ctx.alice).configure(ctx.operator.address, 1, LIMIT, DAY);
      await acct.connect(ctx.operator).propose(ctx.carol.address, 1n, "0x");
      expect((await acct.proposalAt(0)).valid).to.equal(true);
      await transfer(ctx.alice, ctx.bob);
      expect((await acct.proposalAt(0)).valid).to.equal(false);
    });
    it("the new holder starts from nothing: the old key is not in the new policy", async () => {
      await transfer(ctx.alice, ctx.bob);
      await acct.connect(ctx.bob).configure(ctx.carol.address, 2, LIMIT, DAY);
      await expect(run({ to: ctx.alice.address, value: 1n, data: "0x" })).to.be.revertedWithCustomError(acct, "NotAuthorized");
      expect(P.keyStatus({ ...(await read()), now: 1 }, { address: ctx.operator.address, holder: ctx.alice.address }).state).to.equal("stopped");
    });
  });

  describe("the sale lock binds the key too", () => {
    it("blocks execute, propose and approve until it expires, and the console waits instead of stopping", async () => {
      await enableAssisted();
      const until = (await time.latest()) + 3600;
      await acct.connect(ctx.alice).lock(until);
      await expect(run({ to: ctx.alice.address, value: 1n, data: "0x" })).to.be.revertedWithCustomError(acct, "AccountLocked");
      const s = await read();
      const st = P.keyStatus({ ...s, now: await time.latest() }, { address: ctx.operator.address, holder: ctx.alice.address });
      expect(st).to.include({ state: "waiting", code: "locked" });
      expect(W.watchWallet(s, null, await time.latest()).items.map((i) => i.id)).to.include("lock");
      await time.increaseTo(until + 1);
      await expect(run({ to: ctx.alice.address, value: 1n, data: "0x" })).to.changeEtherBalance(ctx.alice, 1n);
    });
    it("blocks proposals and approvals at Manual", async () => {
      await acct.connect(ctx.alice).configure(ctx.operator.address, 1, LIMIT, DAY);
      await acct.connect(ctx.operator).propose(ctx.carol.address, 1n, "0x");
      await acct.connect(ctx.alice).lock((await time.latest()) + 3600);
      await expect(acct.connect(ctx.operator).propose(ctx.carol.address, 1n, "0x")).to.be.revertedWithCustomError(acct, "AccountLocked");
      await expect(acct.connect(ctx.alice).approve(0)).to.be.revertedWithCustomError(acct, "AccountLocked");
    });
    it("pause makes the console wait", async () => {
      await enableAssisted();
      await acct.connect(ctx.alice).setPaused(true);
      await expect(run({ to: ctx.alice.address, value: 1n, data: "0x" })).to.be.revertedWithCustomError(acct, "NotAuthorized");
      expect(P.keyStatus({ ...(await read()), now: 1 }, { address: ctx.operator.address, holder: ctx.alice.address })).to.include({ state: "waiting", code: "paused" });
    });
  });

  describe("Autonomous: the contract refuses every denylisted selector to the operator", () => {
    it("reverts AssetMoveForbidden for each of the page's selectors (so the page's list and the contract's agree)", async () => {
      await acct.connect(ctx.alice).configure(ctx.operator.address, 3, ethers.parseEther("1"), DAY);
      const target = ethers.Wallet.createRandom().address;
      expect(P.ASSET_MOVE).to.have.length(27);
      for (const sel of P.ASSET_MOVE) {
        await expect(acct.connect(ctx.operator).execute(target, 0, sel + "00".repeat(64), 0), sel).to.be.revertedWithCustomError(acct, "AssetMoveForbidden").withArgs(sel);
      }
    });
    it("and a selector outside the list reaches the call (the denylist is not a boundary)", async () => {
      await acct.connect(ctx.alice).configure(ctx.operator.address, 3, ethers.parseEther("1"), DAY);
      const target = ethers.Wallet.createRandom().address;
      expect(P.isAssetMove("0x12345678")).to.equal(false);
      await acct.connect(ctx.operator).execute(target, 0, "0x12345678", 0); // a plain address accepts any data
    });
  });

  describe("revoke", () => {
    beforeEach(enableAssisted);
    it("ends the key's authority, shows Manual, and returns the key's gas float to the holder minus its own fee", async () => {
      // a fresh key holding its gas float, as in the browser (the shared test signers must not be emptied)
      const op = ethers.Wallet.createRandom().connect(ethers.provider);
      await acct.connect(ctx.alice).configure(op.address, 2, LIMIT, DAY);
      await ctx.owner.sendTransaction({ to: op.address, value: P.GAS_FLOAT });
      await acct.connect(ctx.alice).revokeOperator();
      await expect(run({ to: ctx.alice.address, value: 1n, data: "0x" }, op)).to.be.revertedWithCustomError(acct, "NotAuthorized");
      const s = await read();
      expect(s.operator).to.equal(ethers.ZeroAddress);
      expect(P.effectiveMode(s)).to.equal(1);
      expect(P.keyStatus({ ...s, now: 1 }, { address: op.address, holder: ctx.alice.address })).to.include({ state: "stopped", code: "not-operator" });

      const gasPrice = (await ethers.provider.getFeeData()).gasPrice;
      const bal = await ethers.provider.getBalance(op.address);
      const value = A.sweepKeyValue(bal, gasPrice);
      expect(value).to.equal(bal - 21000n * gasPrice);
      const before = await ethers.provider.getBalance(ctx.alice.address);
      const tx = await op.sendTransaction({ to: ctx.alice.address, value, gasPrice, gasLimit: 21000 });
      await tx.wait();
      expect(await ethers.provider.getBalance(ctx.alice.address)).to.equal(before + value);
      expect(await ethers.provider.getBalance(op.address)).to.equal(0n);
      expect(A.sweepKeyValue(10n, gasPrice)).to.equal(0n); // less than a fee: nothing to send
    });
    it("the level reads Manual with no operator, in the contract and in the token metadata (M5)", async () => {
      await enableAssisted();
      expect(await acct.autonomyLevel()).to.equal(2);
      expect(decodeUri(await ctx.agents.tokenURI(1)).attributes.find((a) => a.trait_type === "Autonomy").value).to.equal("Assisted");
      await acct.connect(ctx.alice).revokeOperator();
      expect(await acct.operator()).to.equal(ethers.ZeroAddress);
      expect(await acct.autonomyLevel()).to.equal(1);
      expect(decodeUri(await ctx.agents.tokenURI(1)).attributes.find((a) => a.trait_type === "Autonomy").value).to.equal("Manual");
      // and a fresh configure() brings the level back
      await acct.connect(ctx.alice).configure(ctx.operator.address, 3, LIMIT, DAY);
      expect(await acct.autonomyLevel()).to.equal(3);
    });
    it("a later configure() with the same key starts from an empty whitelist", async () => {
      await acct.connect(ctx.alice).revokeOperator();
      await acct.connect(ctx.alice).configure(ctx.operator.address, 2, LIMIT, DAY);
      expect(await acct.isAllowed(ctx.operator.address, NOARGS)).to.equal(false);
    });
  });

  describe("only the holder moves the account's ETH at Manual", () => {
    it("the one-tap holder path (execute) is untouched, and a stranger is refused", async () => {
      await expect(acct.connect(ctx.alice).execute(ctx.carol.address, 7n, "0x", 0)).to.changeEtherBalance(ctx.carol, 7n);
      await expect(acct.connect(ctx.bob).execute(ctx.carol.address, 7n, "0x", 0)).to.be.revertedWithCustomError(acct, "NotAuthorized");
    });
  });
});
