const { expect } = require("chai");
const { ethers } = require("hardhat");

// Market page maths (web/js/market/market-data.js), the OpenSea stats relay (scripts/lib/market-proxy.mjs), and the
// local Seaport stand-in: a sale made through MockSeaport must be priced by the same code the page runs on mainnet.
describe("Market (market-data.js, market-proxy.mjs, MockSeaport)", () => {
  let M, P;
  before(async () => {
    M = await import("../web/js/market/market-data.js");
    P = await import("../scripts/lib/market-proxy.mjs");
  });

  const NFT = "0x82EdA215Fa92B45a3a76837C65Ab862b6C7564a8";
  const WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
  const eth = (v) => ethers.parseEther(v);

  describe("salePrice", () => {
    it("prices a bought listing from the ETH consideration (seller + royalty + fee)", () => {
      const order = {
        offer: [{ itemType: 2, token: NFT, identifier: 41n, amount: 1n }],
        consideration: [
          { itemType: 0, token: ethers.ZeroAddress, identifier: 0n, amount: eth("0.0189") },
          { itemType: 0, token: ethers.ZeroAddress, identifier: 0n, amount: eth("0.00105") },
          { itemType: 0, token: ethers.ZeroAddress, identifier: 0n, amount: eth("0.00105") },
        ],
      };
      expect(M.salePrice(order, NFT.toLowerCase(), 41, WETH)).to.equal(eth("0.021"));
    });
    it("prices an accepted WETH offer from the offer side, and ignores other tokens", () => {
      const order = {
        offer: [{ itemType: 1, token: WETH, identifier: 0n, amount: eth("0.03") }, { itemType: 1, token: "0x000000000000000000000000000000000000dEaD", identifier: 0n, amount: eth("99") }],
        consideration: [{ itemType: 2, token: NFT, identifier: 7n, amount: 1n, recipient: NFT }],
      };
      expect(M.salePrice(order, NFT, 7, WETH)).to.equal(eth("0.03"));
      expect(M.salePrice(order, NFT, 7, "")).to.equal(0n); // WETH unknown on this chain: no price invented
    });
    it("returns null for an order about another agent or another collection", () => {
      const order = { offer: [{ itemType: 2, token: NFT, identifier: 8n, amount: 1n }], consideration: [] };
      expect(M.salePrice(order, NFT, 9, WETH)).to.equal(null);
      expect(M.salePrice(order, WETH, 8, WETH)).to.equal(null);
    });
    it("knows Seaport's OrderFulfilled topic", () => {
      expect(new ethers.Interface([M.ORDER_FULFILLED_ABI]).getEvent("OrderFulfilled").topicHash).to.equal(M.ORDER_FULFILLED);
    });
  });

  describe("holders and sales figures", () => {
    const tf = (tokenId, from, to, blockNumber, logIndex = 0) => ({ tokenId, from, to, blockNumber, logIndex });
    const A = "0x00000000000000000000000000000000000000a1", B = "0x00000000000000000000000000000000000000b2";
    it("replays transfers in chain order, whatever order they arrive in", () => {
      const counts = M.holdersFrom([tf(1, A, B, 5), tf(1, M.ZERO, A, 1), tf(2, M.ZERO, A, 1, 1), tf(3, M.ZERO, B, 2), tf(3, B, M.ZERO, 9)]);
      expect(Object.fromEntries(counts)).to.deep.equal({ [A]: 1, [B]: 1 });
      const st = M.holderStats(counts, 3);
      expect(st.holders).to.equal(2);
      expect(st.buckets).to.deep.equal({ one: 2, few: 0, many: 0 });
    });
    it("sums volume over all time, the last day and the last week", () => {
      const now = 10 * 86_400;
      const sales = [{ price: eth("1"), timestamp: now - 100, logIndex: 0 }, { price: eth("2"), timestamp: now - 3 * 86_400, logIndex: 0 }, { price: eth("4"), timestamp: now - 9 * 86_400, logIndex: 0 }];
      const s = M.salesStats(sales, now);
      expect(s.volume).to.equal(eth("7"));
      expect(s.day).to.deep.equal({ count: 1, volume: eth("1") });
      expect(s.week).to.deep.equal({ count: 2, volume: eth("3") });
      expect(s.average).to.equal(eth("7") / 3n);
      expect(s.last.price).to.equal(eth("1"));
      expect(s.highest.price).to.equal(eth("4"));
    });
    it("formats ETH without rounding up or scientific notation", () => {
      expect(M.formatEth(eth("0.021"))).to.equal("0.021");
      expect(M.formatEth(eth("0.023599"))).to.equal("0.0235");
      expect(M.formatEth(eth("12.3456"))).to.equal("12.34");
      expect(M.formatEth(1n)).to.equal("< 0.0001");
      expect(M.formatEth(0n)).to.equal("0");
    });
    it("reads the rarity file and the OpenSea slug", () => {
      const rarity = { distribution: { Class: { "AX-1 Rover": 3, "Fab Rig": 1 } }, tokens: [{ id: 2, rank: 2 }, { id: 9, rank: 1 }, { id: 4 }] };
      expect(M.traitRows(rarity, "Class")).to.deep.equal([["AX-1 Rover", 3, 0.75], ["Fab Rig", 1, 0.25]]);
      expect(M.rarest(rarity, 5).map((t) => t.id)).to.deep.equal([9, 2]);
      expect(M.slugOf("https://opensea.io/collection/openforge-agents/overview")).to.equal("openforge-agents");
      expect(M.slugOf("https://evil.example/collection/x")).to.equal("");
    });
  });

  describe("OpenSea stats relay", () => {
    const upstream = { total: { floor_price: 0.0189, floor_price_symbol: "ETH", num_owners: 412, sales: 90, volume: 2.1, average_price: 0.023, market_cap: 9 }, intervals: [{ interval: "one_day", volume: 0.1, sales: 4, average_price: 0.025 }], junk: "<script>" };
    it("is off without a key or with a bad slug", async () => {
      expect((await P.createMarketProxy({ apiKey: "", slug: "a" }).get()).status).to.equal(404);
      expect(P.createMarketProxy({ apiKey: "k", slug: "../x" }).enabled).to.equal(false);
    });
    it("relays only the checked fields, sends the key upstream only, and caches", async () => {
      let calls = 0, seen = null, t = 0;
      const fetchImpl = async (url, opts) => ((calls++, (seen = { url, opts })), { ok: true, json: async () => upstream });
      const px = P.createMarketProxy({ apiKey: "secret", slug: "openforge-agents", fetchImpl, now: () => t, ttlMs: 1000 });
      const r = await px.get();
      expect(r.status).to.equal(200);
      expect(r.body).to.include({ floor: 0.0189, floorSymbol: "ETH", owners: 412, source: "opensea" });
      expect(r.body.day).to.deep.equal({ volume: 0.1, sales: 4, average: 0.025 });
      expect(JSON.stringify(r.body)).not.to.match(/secret|script|market_cap/);
      expect(seen.url).to.equal("https://api.opensea.io/api/v2/collections/openforge-agents/stats");
      expect(seen.opts.headers["x-api-key"]).to.equal("secret");
      await px.get();
      expect(calls).to.equal(1);
      t = 2000;
      await px.get();
      expect(calls).to.equal(2);
    });
    it("serves the last good figures (marked stale) when OpenSea fails, 502 when there are none", async () => {
      let ok = true, t = 0;
      const px = P.createMarketProxy({ apiKey: "k", slug: "s", now: () => t, ttlMs: 10, fetchImpl: async () => (ok ? { ok: true, json: async () => upstream } : { ok: false, status: 500 }) });
      await px.get();
      ok = false;
      t = 100;
      const r = await px.get();
      expect(r.status).to.equal(200);
      expect(r.body.stale).to.equal(true);
      const cold = P.createMarketProxy({ apiKey: "k", slug: "s", fetchImpl: async () => ({ ok: false, status: 500 }) });
      expect((await cold.get()).status).to.equal(502);
    });
    it("never follows a redirect with the key: fetch is told to error out", async () => {
      let seen = null;
      const px = P.createMarketProxy({ apiKey: "secret", slug: "s", fetchImpl: async (_u, opts) => ((seen = opts), { ok: true, json: async () => upstream }) });
      await px.get();
      expect(seen.redirect).to.equal("error");
    });
    it("remembers an upstream failure for a minute: no new upstream call, stale figures or 502 meanwhile, then it retries", async () => {
      let calls = 0, ok = true, t = 0;
      const fetchImpl = async () => (calls++, ok ? { ok: true, json: async () => upstream } : { ok: false, status: 429 });
      const px = P.createMarketProxy({ apiKey: "k", slug: "s", fetchImpl, now: () => t, ttlMs: 10 });
      await px.get(); // good figures cached
      ok = false;
      t = 100;
      expect((await px.get()).body.stale).to.equal(true); // the failing call
      expect(calls).to.equal(2);
      t = 20_000;
      expect((await px.get()).body.stale).to.equal(true); // inside the negative window: served without calling OpenSea
      expect(calls).to.equal(2);
      t = 100 + 61_000;
      await px.get();
      expect(calls).to.equal(3); // window over: asked again
      const cold = P.createMarketProxy({ apiKey: "k", slug: "s", now: () => t, fetchImpl: async () => (calls++, { ok: false, status: 500 }) });
      const before = calls;
      expect((await cold.get()).status).to.equal(502);
      t += 5000;
      expect((await cold.get()).status).to.equal(502);
      expect(calls).to.equal(before + 1); // the second 502 cost no upstream call
    });
    it("does not put the key or a URL in its log line", async () => {
      const lines = [];
      const orig = console.error;
      console.error = (...a) => lines.push(a.join(" "));
      try {
        await P.createMarketProxy({ apiKey: "topsecretkey", slug: "s", fetchImpl: async () => { throw new Error("connect failed https://api.opensea.io/api/v2/x with topsecretkey"); } }).get();
      } finally {
        console.error = orig;
      }
      const logged = lines.join(" | ");
      expect(logged).to.not.match(/topsecretkey|api[.]opensea/);
      expect(logged).to.match(/connect failed/);
    });
  });

  it("MockSeaport sells an agent; the page's code reads the full price back from the receipt", async () => {
    const { deployAll } = require("./helpers");
    const { agents, alice, bob, carol, seaDrop, mint, price } = await deployAll();
    await mint(alice, 1);
    const seaport = await (await ethers.getContractFactory("MockSeaport")).deploy();
    const value = eth("0.021");
    const [royaltyTo, royalty] = await agents.royaltyInfo(1, value);
    await agents.connect(alice).approve(await seaport.getAddress(), 1);
    const before = await ethers.provider.getBalance(alice.address);
    const rc = await (await seaport.connect(bob).buy(agents, 1, royaltyTo, royalty, carol.address, value / 100n, { value })).wait();
    expect(await agents.ownerOf(1)).to.equal(bob.address);
    expect((await ethers.provider.getBalance(alice.address)) > before).to.equal(true); // the seller was paid
    const iface = new ethers.Interface([M.ORDER_FULFILLED_ABI]);
    const orders = rc.logs.filter((l) => l.topics[0] === M.ORDER_FULFILLED).map((l) => iface.parseLog(l).args);
    expect(orders).to.have.length(1);
    expect(M.salePrice(orders[0], await agents.getAddress(), 1, "")).to.equal(value);
    expect(M.salePrice(orders[0], await agents.getAddress(), 2, "")).to.equal(null);
    expect((await seaDrop.getPublicDrop(await agents.getAddress())).mintPrice).to.equal(price); // the Market page's mint line
  });
});
