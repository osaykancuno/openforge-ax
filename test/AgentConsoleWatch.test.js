const { expect } = require("chai");

// web/js/agent/watch.js: the wallet watch, the mission coach and the weekly report (Manual mode: it watches and
// suggests, the holder does every action). Pure: the page reads the chain and passes plain values in.
describe("Agent console: watch, coach and weekly report (web/js/agent/watch.js)", () => {
  let W;
  const DAY = 86400;
  const ETH = 10n ** 18n;
  const holder = "0x" + "a".repeat(40);
  const op = "0x" + "b".repeat(40);
  const zero = "0x" + "0".repeat(40);
  const state = (o = {}) => ({ balance: ETH, operator: zero, level: 1, owner: holder, configuredFor: holder, configuredNonce: 1n, transferNonce: 1n, paused: false, lockedUntil: 0, ...o });
  const ids = (r) => r.items.map((i) => i.id);
  before(async () => {
    W = await import("../web/js/agent/watch.js");
  });

  describe("watchWallet", () => {
    it("always reports the balance and remembers it for next time", () => {
      const r = W.watchWallet(state(), null, 1000);
      expect(r.items.find((i) => i.id === "balance").text).to.include("1 ETH");
      expect(r.seen).to.deep.equal({ balance: ETH.toString(), at: 1000 });
      expect(ids(r)).to.not.include("incoming");
    });
    it("notices ETH that arrived, or left, since the last visit", () => {
      const up = W.watchWallet(state({ balance: ETH + 25n * 10n ** 16n }), { balance: ETH.toString(), at: 10 }, 1000);
      expect(up.items.find((i) => i.id === "incoming").text).to.include("0.25 ETH");
      const down = W.watchWallet(state({ balance: ETH / 2n }), { balance: ETH.toString(), at: 10 }, 1000);
      expect(down.items.find((i) => i.id === "outgoing").text).to.include("0.5 ETH");
      expect(down.items.find((i) => i.id === "outgoing").level).to.equal("warn");
    });
    it("ignores a corrupt remembered balance", () => {
      for (const seen of [{ balance: "abc", at: 1 }, { balance: -5, at: 1 }, "x", 7, {}]) expect(() => W.watchWallet(state(), seen, 1000), JSON.stringify(seen)).to.not.throw();
      expect(ids(W.watchWallet(state(), { balance: "abc", at: 1 }, 1000))).to.not.include("incoming");
    });
    it("reports the lock with its remaining time, and the pause", () => {
      const l = W.watchWallet(state({ lockedUntil: 1000 + 3 * DAY }), null, 1000).items.find((i) => i.id === "lock");
      expect(l.text).to.include("3 days");
      expect(ids(W.watchWallet(state({ lockedUntil: 900 }), null, 1000))).to.not.include("lock");
      expect(ids(W.watchWallet(state({ paused: true }), null, 1000))).to.include("paused");
    });
    it("reports a lapsed policy when an operator is set but the agent changed hands", () => {
      const lapsed = W.watchWallet(state({ operator: op, level: 2, transferNonce: 2n }), null, 1000);
      expect(lapsed.items.find((i) => i.id === "lapsed").level).to.equal("warn");
      expect(ids(W.watchWallet(state({ operator: op, level: 2 }), null, 1000))).to.not.include("lapsed");
      expect(ids(W.watchWallet(state({ operator: zero, transferNonce: 2n }), null, 1000))).to.not.include("lapsed"); // no operator: nothing lapsed
      expect(ids(W.watchWallet(state({ operator: op, level: 2, configuredFor: "0x" + "c".repeat(40) }), null, 1000))).to.include("lapsed");
    });
  });

  describe("countToday / coach", () => {
    const levels = [{ id: "L1", title: "First steps" }, { id: "L2", title: "Around the box" }, { id: "L3", title: "Tight corner" }];
    const noon = 100 * DAY + DAY / 2;
    it("counts accepted lab runs on the current UTC day, as the contract's daily cap does", () => {
      const ev = [{ at: 100 * DAY + 5, success: true }, { at: 100 * DAY + 9, success: false }, { at: 99 * DAY + DAY - 1, success: true }];
      expect(W.countToday(ev, noon)).to.equal(2);
      expect(W.countToday([], noon)).to.equal(0);
      expect(W.countToday(undefined, noon)).to.equal(0);
    });
    it("suggests the missions not yet passed in this browser, and says the holder plays and signs each run", () => {
      const c = W.coach({ robotName: "AX-1 Rover", levels, progress: { L1: { passed: true } }, today: 3, cap: 10, now: noon });
      expect(c.todo.map((l) => l.id)).to.deep.equal(["L2", "L3"]);
      expect(c.left).to.equal(7);
      expect(c.lines.join(" ")).to.include("Tight corner").and.include("Around the box");
      expect(c.lines.join(" ")).to.match(/you play and sign every run/i);
      expect(c.lines.join(" ")).to.not.include("First steps");
    });
    it("is aware of the daily cap", () => {
      const c = W.coach({ robotName: "AX-1 Rover", levels, progress: {}, today: 10, cap: 10, now: noon });
      expect(c.left).to.equal(0);
      expect(c.lines.join(" ")).to.match(/daily cap/i).and.match(/tomorrow|UTC/);
      const d = W.coach({ robotName: "AX-1 Rover", levels, progress: { L1: { passed: true }, L2: { passed: true }, L3: { passed: true } }, today: 0, cap: 10, now: noon });
      expect(d.todo).to.deep.equal([]);
      expect(d.lines.join(" ")).to.match(/all three/i);
    });
    it("handles an agent with no known robot yet, and a broken progress record", () => {
      expect(W.coach({ robotName: null, levels: [], progress: null, today: 0, cap: 10, now: noon }).lines.length).to.be.above(0);
      expect(() => W.coach({ robotName: "X", levels, progress: "garbage", today: -4, cap: 10, now: noon })).to.not.throw();
    });
  });

  describe("weeklyReport", () => {
    const now = 100 * DAY;
    const hist = [{ at: now - 9 * DAY, balance: "5" + "0".repeat(17) }, { at: now - 6 * DAY, balance: ETH.toString() }, { at: now - DAY, balance: (ETH + ETH / 4n).toString() }];
    it("compares the balance with the first snapshot of the past 7 days, ignoring older ones", () => {
      const r = W.weeklyReport({ now, history: hist, balance: ETH + ETH / 2n, labRuns: [], activity: [], practice: 0 });
      expect(r.lines.join("\n")).to.include("+0.5 ETH");
    });
    it("counts lab runs, key actions and practice runs of the week only", () => {
      const r = W.weeklyReport({
        now,
        history: hist,
        balance: ETH,
        labRuns: [{ at: now - DAY, success: true }, { at: now - 2 * DAY, success: false }, { at: now - 20 * DAY, success: true }],
        activity: [{ at: now - DAY, id: "refuel", value: "3000000000000000" }, { at: now - 30 * DAY, id: "sweep", value: "1" }],
        practice: 4,
      });
      const t = r.lines.join("\n");
      expect(t).to.include("2 lab runs").and.include("1 passed");
      expect(t).to.include("1 action by the agent key");
      expect(t).to.include("4 assisted practice");
    });
    it("works with no history and promises nothing", () => {
      const r = W.weeklyReport({ now, history: [], balance: 0n, labRuns: [], activity: [], practice: 0 });
      expect(r.lines.length).to.be.above(0);
      expect(r.lines.join(" ")).to.not.match(/profit|return|earn|yield|gain/i);
      expect(() => W.weeklyReport({ now })).to.not.throw();
    });
  });

  describe("history", () => {
    it("keeps at most one snapshot a day, newest last, 60 days at most", () => {
      let h = [];
      for (let d = 0; d < 80; d++) h = W.pushSnapshot(h, { at: d * DAY + 10, balance: String(d) });
      h = W.pushSnapshot(h, { at: 79 * DAY + 500, balance: "x" });
      expect(h).to.have.length(60);
      expect(h.at(-1).balance).to.equal("79");
      expect(W.pushSnapshot("junk", { at: 1, balance: "1" })).to.have.length(1);
    });
  });

  describe("activity and storage", () => {
    const mem = () => {
      const m = new Map();
      return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
    };
    it("keeps the last 200 actions of the agent key, per agent, and survives a corrupt entry", () => {
      const s = mem();
      for (let i = 0; i < 230; i++) W.logActivity(s, "k1", { at: i, id: "refuel", value: "1", tx: "0x" + i });
      expect(W.readActivity(s, "k1")).to.have.length(200);
      expect(W.readActivity(s, "k1").at(-1).at).to.equal(229);
      expect(W.readActivity(s, "k2")).to.deep.equal([]);
      s.setItem("openforge-agent-activity:bad", "{not json");
      expect(W.readActivity(s, "bad")).to.deep.equal([]);
      expect(W.readActivity(null, "k1")).to.deep.equal([]);
    });
  });
});
