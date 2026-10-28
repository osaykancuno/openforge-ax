const { expect } = require("chai");

// createRunner (web/js/agent/actions.js): the loop of the key in this browser, with every effect injected. It must act
// only when the chain says it may, do one thing per round, never overlap with another use of the key's nonce, and stop
// for good when the agent changed hands.
describe("Agent console: the key's loop (createRunner)", () => {
  let A, P;
  const ETH = 10n ** 18n;
  const holder = "0x" + "a".repeat(40);
  const key = "0x" + "b".repeat(40);
  const record = { address: key, holder };
  before(async () => {
    A = await import("../web/js/agent/actions.js");
    P = await import("../web/js/agent/policy.js");
  });

  const chain = (o = {}) => ({
    time: 2000, owner: holder, configuredFor: holder, configuredNonce: 1n, transferNonce: 1n, operator: key, level: 2, paused: false, lockedUntil: 0,
    periodLimit: ETH / 100n, periodLength: 86400, periodStart: 1000, spentInPeriod: 0n, balance: ETH, allowed: { operator: true, holder: true }, ...o,
  });
  const tick = () => new Promise((r) => setImmediate(r));
  function rig(over = {}) {
    const r = { sent: [], logs: [], statuses: [], stops: [], reads: [], state: chain(), keyBalance: 0n, visible: true, failSend: false, keep: null, active: 0, maxActive: 0, hold: null, ...over };
    r.make = (extra = {}) =>
      A.createRunner({
        record,
        keep: r.keep,
        gate: r.gate,
        readState: async (blockTag) => (r.reads.push(blockTag), r.state),
        keyBalance: async () => r.keyBalance,
        execute: async (call) => {
          r.active++;
          r.maxActive = Math.max(r.maxActive, r.active);
          try {
            if (r.hold) await r.hold;
            if (r.failSend) throw r.failSend === true ? new Error("boom") : r.failSend;
            r.sent.push(call);
            return { hash: "0xtx" + r.sent.length, blockNumber: 100 + r.sent.length };
          } finally {
            r.active--;
          }
        },
        log: (e) => r.logs.push(e),
        visible: () => r.visible,
        now: () => 99999, // the browser's clock is wrong on purpose: the chain's time (state.time) rules
        onStatus: (s) => r.statuses.push(s),
        onStop: (m) => r.stops.push(m),
        ...extra,
      });
    r.gate = A.createGate();
    r.runner = r.make();
    return r;
  }

  it("refuels the key when it is low on gas, once per round, and logs it", async () => {
    const r = rig();
    await r.runner.tick();
    expect(r.sent).to.have.length(1);
    expect(r.sent[0]).to.deep.include({ id: "refuel", to: key, data: "0x", value: P.GAS_FLOAT });
    expect(r.logs[0]).to.include({ id: "refuel", to: key, tx: "0xtx1" });
  });

  it("sweeps the surplus to the holder only when the holder set a balance to keep", async () => {
    const off = rig({ keyBalance: P.GAS_FLOAT });
    await off.runner.tick();
    expect(off.sent).to.have.length(0);
    const on = rig({ keyBalance: P.GAS_FLOAT, keep: ETH / 2n });
    await on.runner.tick();
    expect(on.sent[0]).to.deep.include({ id: "sweep", to: holder, value: ETH / 100n }); // the daily limit is the bound
  });

  it("never sweeps with a negative balance to keep (M1)", async () => {
    const r = rig({ keyBalance: P.GAS_FLOAT, keep: -ETH });
    await r.runner.tick();
    expect(r.sent).to.have.length(0);
  });

  it("plans the daily limit from the chain's clock, not the browser's (L)", async () => {
    // the window opened at 1000 and runs 86400s: on the chain's clock (2000) it has 0.004 left; on the browser's (99999) it would look rolled over
    const r = rig({ state: chain({ spentInPeriod: (ETH / 100n) * 95n / 100n }) });
    await r.runner.tick();
    expect(r.sent[0].value).to.equal(ETH / 2000n); // 0.0005 left on the chain's clock; the browser's would have allowed the 0.003 float
  });

  it("stops for good the moment the agent changed hands, and never sends after that", async () => {
    const r = rig();
    r.state = chain({ transferNonce: 2n });
    await r.runner.tick();
    expect(r.stops).to.deep.equal(["This agent changed hands; this key no longer acts."]);
    expect(r.runner.stopped).to.equal(true);
    r.state = chain();
    await r.runner.tick();
    expect(r.sent).to.have.length(0);
  });

  it("waits, without stopping, while paused or locked; and when the page is hidden", async () => {
    for (const over of [{ paused: true }, { lockedUntil: 9999 }]) {
      const r = rig();
      r.state = chain(over);
      await r.runner.tick();
      expect(r.sent).to.have.length(0);
      expect(r.runner.stopped).to.equal(false);
    }
    const h = rig({ visible: false });
    await h.runner.tick();
    expect(h.sent).to.have.length(0);
    expect(h.statuses.at(-1).code).to.equal("hidden");
  });

  it("does nothing when the two allowed actions are missing (a new setup clears them)", async () => {
    const r = rig();
    r.state = chain({ allowed: { operator: true, holder: false } });
    await r.runner.tick();
    expect(r.sent).to.have.length(0);
    expect(r.statuses.at(-1).code).to.equal("no-permission");
  });

  it("stays inside what is left of the daily limit", async () => {
    const r = rig();
    r.state = chain({ spentInPeriod: ETH / 100n - 5n });
    await r.runner.tick();
    expect(r.sent[0].value).to.equal(5n);
    r.state = chain({ spentInPeriod: ETH / 100n });
    await r.runner.tick();
    expect(r.sent).to.have.length(1); // nothing left until the window rolls over
  });

  it("does not overlap rounds", async () => {
    const r = rig();
    await Promise.all([r.runner.tick(), r.runner.tick(), r.runner.tick()]);
    expect(r.sent).to.have.length(1);
  });

  it("stops after three failures in a row, with a plain message; a success resets the count", async () => {
    const r = rig({ failSend: true });
    await r.runner.tick();
    await r.runner.tick();
    expect(r.runner.stopped).to.equal(false);
    r.failSend = false;
    await r.runner.tick();
    r.failSend = true;
    r.keyBalance = 0n;
    await r.runner.tick();
    await r.runner.tick();
    expect(r.runner.stopped).to.equal(false); // 2 in a row after a success
    await r.runner.tick();
    expect(r.runner.stopped).to.equal(true);
    expect(r.stops[0]).to.match(/three failed attempts/);
  });

  it("an unreadable chain counts as a failure, not as permission", async () => {
    const r = rig();
    r.runner = r.make({ readState: async () => { throw new Error("rpc down"); } });
    await r.runner.tick();
    expect(r.sent).to.have.length(0);
    expect(r.statuses.at(-1).code).to.equal("error");
  });

  describe("H2: one use of the key at a time", () => {
    it("after a send, the next round reads the chain at the block that included it (a lagging node cannot hand back the old balance)", async () => {
      const r = rig();
      await r.runner.tick();
      await r.runner.tick();
      expect(r.reads[0]).to.equal(undefined); // first round: latest
      expect(r.reads[1]).to.equal(101); // second round: not before the first send's block
    });

    it("a send that is not confirmed in time halts the key with a clear message and is never resent", async () => {
      const r = rig({ failSend: A_TIMEOUT() });
      await r.runner.tick();
      expect(r.runner.stopped).to.equal(true);
      expect(r.stops[0]).to.match(/not confirmed.*not send it again|will not resend/i);
      r.failSend = false;
      await r.runner.tick();
      expect(r.sent).to.have.length(0);
    });

    it("a new runner started while the old one is mid-send never overlaps it; stop() waits for the send", async () => {
      let release;
      const r = rig();
      r.hold = new Promise((res) => (release = res));
      const first = r.runner.tick(); // inside execute, waiting
      await tick();
      expect(r.active).to.equal(1);
      let stopped = false;
      const stopping = r.runner.stop().then(() => (stopped = true));
      const next = r.make(); // the holder pressed Start again: shares the gate
      const second = next.tick();
      await tick();
      expect(stopped, "stop() must wait for the in-flight send").to.equal(false);
      expect(r.active, "the new runner must wait for the old send").to.equal(1);
      release();
      await Promise.all([first, stopping, second]);
      expect(r.maxActive).to.equal(1);
      expect(stopped).to.equal(true);
    });

    it("a sweep of the key's own ETH goes through the same gate, after the in-flight round", async () => {
      let release;
      const r = rig();
      r.hold = new Promise((res) => (release = res));
      const order = [];
      const first = r.runner.tick().then(() => order.push("round"));
      await tick();
      const sweep = r.gate.run(async () => order.push("sweep"));
      await tick();
      expect(order).to.deep.equal([]);
      release();
      await Promise.all([first, sweep]);
      expect(order).to.deep.equal(["round", "sweep"]);
    });

    it("a stop that arrives while the chain is being read sends nothing", async () => {
      let release;
      const r = rig();
      r.runner = r.make({ readState: async () => (await new Promise((res) => (release = res)), r.state) });
      const round = r.runner.tick();
      await tick();
      const stopping = r.runner.stop();
      release();
      await Promise.all([round, stopping]);
      expect(r.sent).to.have.length(0);
    });

    it("the gate keeps going after a failure in one job", async () => {
      const g = A.createGate();
      const bad = g.run(async () => { throw new Error("x"); });
      let err;
      try { await bad; } catch (e) { err = e; }
      expect(err.message).to.equal("x");
      expect(await g.run(async () => "ok")).to.equal("ok");
    });

    it("withTimeout rejects with a halting error after the time, and passes a result through", async () => {
      expect(await A.withTimeout(Promise.resolve(7), 50, "late")).to.equal(7);
      let err;
      try { await A.withTimeout(new Promise(() => {}), 10, "late"); } catch (e) { err = e; }
      expect(err.message).to.equal("late");
      expect(err.halt).to.equal(true);
    });
  });

  describe("H1c: the key locks itself again", () => {
    it("drops the key after the idle time with no runner activity or visibility, and not while it is active", () => {
      let t = 0, locked = 0;
      const idle = A.createIdleLock({ idleMs: 15 * 60_000, now: () => t, lock: () => locked++ });
      t = 14 * 60_000;
      idle.tick(false);
      expect(locked).to.equal(0);
      idle.tick(true); // the runner is running on a visible page: that is activity
      t = 14 * 60_000 + 14 * 60_000;
      idle.tick(false);
      expect(locked).to.equal(0);
      t += 2 * 60_000;
      idle.tick(false);
      expect(locked).to.equal(1);
    });
    it("a touch (the holder is using the console) restarts the clock; locking happens once per idle period", () => {
      let t = 0, locked = 0;
      const idle = A.createIdleLock({ idleMs: 1000, now: () => t, lock: () => locked++ });
      t = 900;
      idle.touch();
      t = 1800;
      idle.tick(false);
      expect(locked).to.equal(0);
      t = 2000;
      idle.tick(false);
      idle.tick(false);
      expect(locked).to.equal(1);
    });
    it("the default idle time is 15 minutes", () => {
      expect(A.IDLE_MS).to.equal(15 * 60_000);
    });
  });

  // a send whose confirmation never came (execute() throws what withTimeout throws)
  function A_TIMEOUT() {
    return Object.assign(new Error("The transaction was sent but not confirmed in time. The key will not resend it; check the explorer, then start the key again."), { halt: true });
  }
});
