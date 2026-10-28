const { expect } = require("chai");
const fs = require("node:fs");
const path = require("node:path");

// web/js/agent/policy.js + actions.js + links.js: the pure rules behind the agent console. The contract is the
// authority (test/AgentRuntimeFlows.test.js runs these rules against it); here the numbers and the copy are pinned.
describe("Agent console policy (web/js/agent/policy.js, actions.js, links.js)", () => {
  let P, A, L;
  const ETH = 10n ** 18n;
  const eth = (s) => BigInt(Math.round(Number(s) * 1e6)) * 10n ** 12n;
  before(async () => {
    P = await import("../web/js/agent/policy.js");
    A = await import("../web/js/agent/actions.js");
    L = await import("../web/js/agent/links.js");
  });

  describe("asset-move denylist", () => {
    const sol = fs.readFileSync(path.join(__dirname, "../contracts/AgentAccount.sol"), "utf8");
    const body = sol.slice(sol.indexOf("function _isAssetMove"), sol.indexOf("function _isOwnedAccount"));
    const fromContract = [...body.matchAll(/s == (0x[0-9a-f]{8})/g)].map((m) => m[1]);

    it("is the same list as AgentAccount._isAssetMove (27 selectors), no more and no less", () => {
      expect(fromContract.length).to.equal(27);
      expect([...P.ASSET_MOVE].sort()).to.deep.equal([...fromContract].sort());
    });
    it("every name given to a selector really hashes to it (page copy and decoder labels)", async () => {
      const { id } = require("ethers");
      for (const [sel, sig] of Object.entries(P.ASSET_MOVE_NAMES)) expect(id(sig).slice(0, 10), sig).to.equal(sel);
      const { KNOWN_NAMES } = await import("../web/js/agent/decode.js");
      for (const [sel, sig] of Object.entries(KNOWN_NAMES)) expect(id(sig).slice(0, 10), sig).to.equal(sel);
    });
    it("recognises a selector from calldata or alone, in any case, and nothing else", () => {
      expect(P.isAssetMove("0xa9059cbb" + "00".repeat(64))).to.equal(true);
      expect(P.isAssetMove("0xA9059CBB")).to.equal(true);
      expect(P.isAssetMove("0x00000000")).to.equal(false);
      expect(P.isAssetMove("0x")).to.equal(false);
      expect(P.isAssetMove(undefined)).to.equal(false);
      expect(P.isAssetMove(null)).to.equal(false);
      expect(P.isAssetMove(42)).to.equal(false);
    });
  });

  describe("amounts", () => {
    it("formats wei as plain decimals without trailing zeros", () => {
      expect(P.fmtEth(0n)).to.equal("0");
      expect(P.fmtEth(ETH)).to.equal("1");
      expect(P.fmtEth(eth("0.003"))).to.equal("0.003");
      expect(P.fmtEth(1n)).to.equal("0.000000000000000001");
      expect(P.fmtEth(ETH + 5n * 10n ** 17n)).to.equal("1.5");
    });
    it("remainingCap: full limit after the window, limit minus spent inside it, never negative", () => {
      const p = { periodLimit: eth("0.01"), spentInPeriod: eth("0.004"), periodStart: 1000, periodLength: 86400 };
      expect(P.remainingCap(p, 1000)).to.equal(eth("0.006"));
      expect(P.remainingCap(p, 1000 + 86399)).to.equal(eth("0.006"));
      expect(P.remainingCap(p, 1000 + 86400)).to.equal(eth("0.01")); // the window rolled over: _spend resets
      expect(P.remainingCap({ ...p, spentInPeriod: eth("0.02") }, 1000)).to.equal(0n);
    });
    it("the limit note says up to twice across the reset", () => {
      const note = P.limitNote(eth("0.01"));
      expect(note).to.include("0.01 ETH");
      expect(note).to.match(/up to twice that/i);
      expect(note).to.include("0.02 ETH");
    });
    it("the built-in key has no 0.5 ETH option and starts at 0.01; own software may still choose 0.5", () => {
      expect(P.BUILTIN_LIMITS).to.not.include("0.5");
      expect(P.DEFAULT_LIMIT).to.equal("0.01");
      expect(P.BUILTIN_LIMITS).to.include(P.DEFAULT_LIMIT);
      expect(P.OWN_SOFTWARE_LIMITS).to.include("0.5");
    });
    it("the gas float is about 0.003 ETH and sits above the refuel threshold", () => {
      expect(P.GAS_FLOAT).to.equal(eth("0.003"));
      expect(P.REFUEL_BELOW < P.GAS_FLOAT).to.equal(true);
    });
  });

  describe("copy", () => {
    it("states each mode as the blueprint says, and never calls Assisted free", () => {
      expect(P.MODE_TEXT[1]).to.equal("Watches its wallet and lab record and suggests; you do each action. Recommended.");
      expect(P.MODE_TEXT[2]).to.equal("A key in this browser acts alone, only on actions you allow, up to a daily limit (up to twice that across the reset). Works while this page is open.");
      expect(P.MODE_TEXT[3]).to.equal("For your own agent software. Full trust: it can move the tokens and NFTs in this agent's wallet through other apps. ETH is capped.");
      for (const t of Object.values(P.MODE_TEXT)) expect(t).to.not.match(/\bfree\b/i);
    });
    it("the safety line is true at every level", () => {
      expect(P.SAFETY_TEXT).to.equal("The agent can never touch your own wallet or sign for you. In Manual and Assisted it can't move this wallet's tokens or NFTs; in Autonomous it can.");
      expect(P.SAFETY_TEXT).to.not.include("In no mode");
    });
  });

  describe("effectiveMode", () => {
    const zero = "0x" + "0".repeat(40);
    it("is Manual without an operator, whatever the stored level says (revoke leaves the level behind)", () => {
      expect(P.effectiveMode({ operator: zero, level: 2 })).to.equal(1);
      expect(P.effectiveMode({ operator: undefined, level: 3 })).to.equal(1);
    });
    it("is the contract's level with an operator", () => {
      expect(P.effectiveMode({ operator: "0x" + "1".repeat(40), level: 2 })).to.equal(2);
      expect(P.effectiveMode({ operator: "0x" + "1".repeat(40), level: 1 })).to.equal(1);
      expect(P.effectiveMode({ operator: "0x" + "1".repeat(40), level: 9 })).to.equal(1);
    });
  });

  describe("keyStatus", () => {
    const holder = "0x" + "a".repeat(40);
    const key = "0x" + "b".repeat(40);
    const base = { owner: holder, configuredFor: holder, configuredNonce: 3n, transferNonce: 3n, operator: key, level: 2, paused: false, lockedUntil: 0, now: 1000 };
    const rec = { address: key, holder };
    it("acts when the key is the operator at L2 for the holder who enabled it", () => {
      expect(P.keyStatus(base, rec)).to.include({ state: "acting", code: "ok" });
    });
    it("stops for good when the agent changed hands (owner, configuredFor or nonce differ)", () => {
      for (const s of [{ owner: "0x" + "c".repeat(40) }, { configuredFor: "0x" + "c".repeat(40) }, { transferNonce: 4n }, { configuredNonce: 2n }]) {
        const r = P.keyStatus({ ...base, ...s }, rec);
        expect(r.state, Object.keys(s)[0]).to.equal("stopped");
        expect(r.code).to.equal("changed-hands");
        expect(r.message).to.equal("This agent changed hands; this key no longer acts.");
      }
    });
    it("compares addresses without case", () => {
      expect(P.keyStatus({ ...base, owner: holder.toUpperCase().replace("0X", "0x"), operator: key.toUpperCase().replace("0X", "0x") }, rec).state).to.equal("acting");
    });
    it("stops when the key is no longer the operator or the mode is not Assisted", () => {
      expect(P.keyStatus({ ...base, operator: "0x" + "d".repeat(40) }, rec)).to.include({ state: "stopped", code: "not-operator" });
      expect(P.keyStatus({ ...base, level: 3 }, rec)).to.include({ state: "stopped", code: "not-assisted" });
      expect(P.keyStatus({ ...base, level: 1 }, rec)).to.include({ state: "stopped", code: "not-assisted" });
    });
    it("waits (does not stop) while paused or locked", () => {
      expect(P.keyStatus({ ...base, paused: true }, rec)).to.include({ state: "waiting", code: "paused" });
      expect(P.keyStatus({ ...base, lockedUntil: 2000 }, rec)).to.include({ state: "waiting", code: "locked" });
      expect(P.keyStatus({ ...base, lockedUntil: 1000 }, rec)).to.include({ state: "acting" }); // the lock ends at lockedUntil
    });
    it("changed hands wins over a lock or pause", () => {
      expect(P.keyStatus({ ...base, paused: true, transferNonce: 9n }, rec).code).to.equal("changed-hands");
    });
  });

  describe("built-in actions (refuel, sweep)", () => {
    const op = "0x" + "b".repeat(40);
    const holder = "0x" + "a".repeat(40);
    const ctx = { operator: op, holder };

    it("lists exactly two whitelist entries, both plain-ETH transfers (empty-data selector 0x00000000)", () => {
      const perms = A.permissionsFor(ctx);
      expect(perms).to.have.length(2);
      expect(perms.map((p) => p.target)).to.deep.equal([op, holder]);
      for (const p of perms) expect(p.selector).to.equal("0x00000000");
    });
    it("the catalogue has only refuel and sweep", () => {
      expect(Object.keys(A.ACTIONS).sort()).to.deep.equal(["refuel", "sweep"]);
    });

    describe("planRefuel", () => {
      let s;
      before(() => {
        s = { keyBalance: 0n, accountBalance: ETH, remaining: eth("0.01"), below: P.REFUEL_BELOW, float: P.GAS_FLOAT };
      });
      it("tops the key up to the float when it is below the threshold", () => {
        expect(A.planRefuel({ ...s, keyBalance: eth("0.0005") })).to.deep.include({ id: "refuel", value: eth("0.0025") });
      });
      it("does nothing at or above the threshold", () => {
        expect(A.planRefuel({ ...s, keyBalance: P.REFUEL_BELOW }).skip).to.equal("gas-ok");
        expect(A.planRefuel({ ...s, keyBalance: eth("0.002") }).skip).to.equal("gas-ok");
      });
      it("is bounded by what is left of the daily limit and by the wallet balance", () => {
        expect(A.planRefuel({ ...s, remaining: eth("0.001") }).value).to.equal(eth("0.001"));
        expect(A.planRefuel({ ...s, accountBalance: eth("0.0002") }).value).to.equal(eth("0.0002"));
        expect(A.planRefuel({ ...s, remaining: 0n }).skip).to.equal("cap-reached");
        expect(A.planRefuel({ ...s, accountBalance: 0n }).skip).to.equal("wallet-empty");
      });
    });

    describe("planSweep", () => {
      let s;
      before(() => {
        s = { accountBalance: eth("0.5"), keep: eth("0.1"), min: P.SWEEP_MIN, remaining: eth("1") };
      });
      it("is off until the holder sets a balance to keep", () => {
        expect(A.planSweep({ ...s, keep: null }).skip).to.equal("off");
        expect(A.planSweep({ ...s, keep: undefined }).skip).to.equal("off");
      });
      it("sends the surplus above the kept balance", () => {
        expect(A.planSweep(s)).to.deep.include({ id: "sweep", value: eth("0.4") });
      });
      it("never touches the kept balance, never sweeps dust, never exceeds the daily limit", () => {
        expect(A.planSweep({ ...s, accountBalance: eth("0.1") }).skip).to.equal("nothing-to-sweep");
        expect(A.planSweep({ ...s, accountBalance: eth("0.05") }).skip).to.equal("nothing-to-sweep");
        expect(A.planSweep({ ...s, accountBalance: eth("0.103") }).skip).to.equal("nothing-to-sweep"); // under the dust floor
        expect(A.planSweep({ ...s, remaining: eth("0.02") }).value).to.equal(eth("0.02"));
        expect(A.planSweep({ ...s, remaining: 0n }).skip).to.equal("cap-reached");
      });
    });

    describe("nextAction", () => {
      const s = { operator: op, holder, keyBalance: 0n, accountBalance: ETH, remaining: eth("0.01"), keep: eth("0.1") };
      it("refuels first, then sweeps, one action per round", () => {
        expect(A.nextAction(s).id).to.equal("refuel");
        const call = A.nextAction({ ...s, keyBalance: P.GAS_FLOAT });
        expect(call.id).to.equal("sweep");
        expect(call.to).to.equal(holder);
        expect(call.data).to.equal("0x");
      });
      it("builds calls only to the key itself or to the holder, with empty data", () => {
        const r = A.nextAction(s);
        expect(r.to).to.equal(op);
        expect(r.data).to.equal("0x");
        expect(A.nextAction({ ...s, keyBalance: P.GAS_FLOAT, accountBalance: eth("0.1") })).to.have.property("skip");
      });
    });

    describe("guard", () => {
      const rem = eth("0.01");
      const ok = { to: op, value: eth("0.002"), data: "0x" };
      it("accepts a catalogue call", () => {
        expect(A.guard(ok, { ...ctx, remaining: rem })).to.equal(null);
        expect(A.guard({ to: holder, value: eth("0.01"), data: "0x" }, { ...ctx, remaining: rem })).to.equal(null);
      });
      it("refuses any other target, any calldata, zero value, more than the daily limit left", () => {
        const g = (c) => A.guard(c, { ...ctx, remaining: rem });
        expect(g({ ...ok, to: "0x" + "9".repeat(40) })).to.be.a("string");
        expect(g({ ...ok, data: "0xa9059cbb" })).to.be.a("string");
        expect(g({ ...ok, data: "0x12345678" })).to.be.a("string");
        expect(g({ ...ok, value: 0n })).to.be.a("string");
        expect(g({ ...ok, value: eth("0.011") })).to.be.a("string");
      });
    });
  });

  describe("what the key can really do (H1a)", () => {
    it("the warning says the contract caps the key at the daily limit, that the two actions are this page's, and what a stolen key could take", () => {
      const t = P.KEY_RISK_TEXT;
      expect(t).to.match(/contract caps this key at the daily limit/);
      expect(t).to.match(/only to two addresses/);
      expect(t).to.match(/enforced by this page, not by the contract/);
      expect(t).to.match(/entire daily limit/);
      expect(t).to.match(/up to twice/);
      expect(t).to.match(/until you switch to Manual/);
      expect(t).to.not.match(/\bfree\b/i);
    });
  });

  describe("operator addresses (M2)", () => {
    const acct = "0x" + "cc".repeat(20);
    const key = "0x" + "bb".repeat(20);
    const dflt = "0x" + "dd".repeat(20);
    const addr = "0x" + "ee".repeat(20);
    const chk = (over) => P.checkOperator({ address: addr, level: 3, builtinKey: key, defaultOperator: dflt, account: acct, isContract: false, ...over });
    it("accepts an ordinary address and warns about nothing", () => {
      expect(chk({})).to.deep.equal({ error: null, warnings: [] });
    });
    it("refuses blank, malformed, zero and the agent wallet itself", () => {
      for (const address of ["", "0x", "0x123", "not an address", undefined, "0x" + "0".repeat(40), acct, acct.toUpperCase().replace("0X", "0x")]) expect(chk({ address }).error, String(address)).to.be.a("string");
    });
    it("refuses the browser key for Autonomous, and the site's default operator for Autonomous", () => {
      expect(chk({ address: key }).error).to.match(/Assisted/);
      expect(chk({ address: key.toUpperCase().replace("0X", "0x") }).error).to.be.a("string");
      expect(chk({ address: dflt }).error).to.match(/pre-filled|suggested|default/i);
      expect(chk({ address: dflt, level: 1 }).error).to.equal(null); // only full trust is closed to it
      expect(chk({ address: key, level: 1 }).error).to.be.a("string"); // the browser key has its own Assisted flow
    });
    it("warns when the address holds code, or when that could not be checked", () => {
      expect(chk({ isContract: true }).warnings.join(" ")).to.match(/contract/i);
      expect(chk({ isContract: undefined }).warnings.join(" ")).to.match(/could not check/i);
    });
    it("every operator prompt carries the same rule", () => {
      expect(P.OPERATOR_RULE).to.match(/only an address whose key you control/i);
      expect(P.OPERATOR_RULE).to.match(/never one someone sent you/i);
    });
    it("Autonomous is confirmed by typing the last 4 hex characters of the agent wallet, and the hint never prints them", () => {
      expect(P.l3Hint(acct)).to.equal("cccc");
      for (const ok of ["cccc", " CCCC ", "Cccc"]) expect(P.l3Confirmation(ok, acct), ok).to.equal(true);
      for (const bad of ["", "ccc", "ccccc", "0xcccc", "7", "dddd", "00007", undefined, null, 7]) expect(P.l3Confirmation(bad, acct), String(bad)).to.equal(false);
      const acct2 = "0x" + "12".repeat(19) + "a1b2";
      expect(P.l3Confirmation("A1B2", acct2)).to.equal(true);
      expect(P.L3_PLACEHOLDER).to.not.match(/\b[0-9a-f]{4}\b/i);
      expect(P.L3_PLACEHOLDER).to.match(/last 4 characters/);
    });
  });

  describe("balance to keep (M1)", () => {
    const parse = (t) => require("ethers").parseEther(t);
    it("empty means never sweep; a number means keep that much; negatives and nonsense are refused", () => {
      expect(A.parseKeep("", parse)).to.deep.equal({ wei: null });
      expect(A.parseKeep("   ", parse)).to.deep.equal({ wei: null });
      expect(A.parseKeep("0", parse)).to.deep.equal({ wei: 0n });
      expect(A.parseKeep("0.25", parse)).to.deep.equal({ wei: ETH / 4n });
      for (const t of ["-1", "-0.0001", "abc", "1e3x", "0x10"]) expect(A.parseKeep(t, parse).error, t).to.be.a("string");
      expect(A.parseKeep("-1", parse).error).to.match(/negative|zero or more/i);
    });
    it("a negative or missing keep switches sweeping off, and a sweep never exceeds the wallet's balance", () => {
      expect(A.planSweep({ accountBalance: ETH, keep: -ETH, remaining: 10n * ETH }).skip).to.equal("off");
      const r = A.planSweep({ accountBalance: ETH, keep: 0n, remaining: 10n * ETH });
      expect(r.value).to.equal(ETH);
    });
  });

  describe("robot links", () => {
    it("cleanMeta turns odd token metadata into something the page can read (a non-array attributes list must not break it)", () => {
      for (const attributes of [undefined, null, "x", 7, {}, { find: 1 }]) {
        const m = L.cleanMeta({ name: "N", attributes });
        expect(m.attributes, String(attributes)).to.deep.equal([]);
        expect(m.name).to.equal("N");
      }
      expect(L.cleanMeta({ attributes: [{ trait_type: "Class", value: "Synth Arm" }, null, 3, { value: 1 }] }).attributes).to.deep.equal([{ trait_type: "Class", value: "Synth Arm" }]);
      expect(L.cleanMeta(null)).to.deep.equal({ name: "", description: "", image: "", attributes: [] });
      expect(L.cleanMeta("x").attributes).to.deep.equal([]);
    });
    let ROBOTS, NAMES;
    before(async () => {
      const saved = globalThis.document;
      const noop = new Proxy(function () {}, { get: (t, k) => (k === "measureText" ? () => ({ width: 10 }) : noop), apply: () => noop, set: () => true });
      globalThis.document = { createElement: () => ({ width: 0, height: 0, getContext: () => noop, style: {} }) };
      try {
        ({ ROBOTS } = await import("../web/js/models/robots.js"));
      } finally {
        globalThis.document = saved;
      }
      ({ NAMES } = await import("../web/js/traits-data.js"));
    });
    it("maps every on-chain class to the robot whose cls and name match it", () => {
      expect(NAMES.class).to.have.length(11);
      NAMES.class.forEach((name, i) => {
        const id = L.robotIdForClass(name);
        expect(ROBOTS[id], name).to.not.equal(undefined);
        expect(ROBOTS[id].cls, name).to.equal(i);
        expect(ROBOTS[id].name, name).to.equal(name);
        expect(L.robotIdForClass(i)).to.equal(id);
      });
    });
    it("returns null for an unknown, missing or hostile class", () => {
      for (const v of [undefined, null, "", "Toaster", "__proto__", 11, -1, 1.5, {}]) expect(L.robotIdForClass(v), String(v)).to.equal(null);
    });
    it("builds the two links; a dormant token gets no build link", () => {
      expect(L.arLink(7)).to.equal("ar.html?agent=7");
      expect(L.buildLink("AX-1 Walker")).to.equal("bench.html#ax1-walker/build");
      expect(L.buildLink("Synth Arm")).to.equal("bench.html#so101/build");
      expect(L.buildLink(undefined)).to.equal(null);
    });
    it("every build link lands on a robot and stage the Workbench knows", () => {
      const bench = fs.readFileSync(path.join(__dirname, "../web/js/bench/bench.js"), "utf8");
      expect(bench).to.match(/id: "build"|"build"/);
      for (const n of NAMES.class) expect(L.buildLink(n)).to.match(/^bench\.html#[a-z0-9-]+\/build$/);
    });
  });
});
