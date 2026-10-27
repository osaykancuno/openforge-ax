const { expect } = require("chai");

// Market page sale filter (web/js/market/market-data.js): any contract can emit an OrderFulfilled-shaped event, so a
// receipt counts as a sale only when the event comes from an official Seaport and the agent itself moved in that receipt.
describe("Market sale filter (official Seaport only)", () => {
  let M;
  before(async () => {
    M = await import("../web/js/market/market-data.js");
  });

  const NFT = "0x82EdA215Fa92B45a3a76837C65Ab862b6C7564a8";
  const SEAPORT_15 = "0x00000000000000ADc04C56Bf30aC9d3c0aAF14dC";
  const SEAPORT_16 = "0x0000000000000068F116a894984e2DB1123eB395";
  const FAKE = "0x00000000000000000000000000000000DeaDBeef";
  const MOCK = "0x5FbDB2315678afecb367f032d93F642f64180aa3";
  const pad = (n) => "0x" + BigInt(n).toString(16).padStart(64, "0");
  const addrTopic = (a) => "0x" + a.slice(2).toLowerCase().padStart(64, "0");
  const order = (address) => ({ address, topics: [M.ORDER_FULFILLED, pad(1), pad(2)], data: "0x" });
  const transfer = (id, address = NFT) => ({ address, topics: [M.TRANSFER, addrTopic(FAKE), addrTopic(MOCK), pad(id)], data: "0x" });

  describe("seaportAddresses", () => {
    it("lists the two official Seaports, lowercased, on mainnet and Sepolia", () => {
      for (const chainId of [1, 11155111]) expect(M.seaportAddresses(chainId)).to.deep.equal([SEAPORT_15.toLowerCase(), SEAPORT_16.toLowerCase()]);
    });
    it("adds the local stand-in on the demo chain only, and only when it is a real address", () => {
      expect(M.seaportAddresses(31337, MOCK)).to.include(MOCK.toLowerCase());
      expect(M.seaportAddresses(1, MOCK)).to.not.include(MOCK.toLowerCase());
      expect(M.seaportAddresses(11155111, MOCK)).to.not.include(MOCK.toLowerCase());
      for (const bad of ["", undefined, null, "0x12", "not an address", 5]) expect(M.seaportAddresses(31337, bad)).to.have.length(2);
    });
  });

  describe("movedToken", () => {
    it("is true for the collection's Transfer of that token", () => {
      expect(M.movedToken([transfer(41)], NFT, 41)).to.equal(true);
      expect(M.movedToken([transfer(41, NFT.toLowerCase())], NFT, "41")).to.equal(true);
    });
    it("is false for another token, another contract, an ERC-20 Transfer (no token topic) or no logs", () => {
      expect(M.movedToken([transfer(42)], NFT, 41)).to.equal(false);
      expect(M.movedToken([transfer(41, FAKE)], NFT, 41)).to.equal(false);
      expect(M.movedToken([{ ...transfer(41), topics: transfer(41).topics.slice(0, 3) }], NFT, 41)).to.equal(false);
      expect(M.movedToken([], NFT, 41)).to.equal(false);
      expect(M.movedToken(undefined, NFT, 41)).to.equal(false);
    });
  });

  describe("saleOrderLogs", () => {
    const opts = { chainId: 1, nft: NFT, tokenId: 41 };
    it("keeps a genuine Seaport 1.5 / 1.6 event next to the agent's Transfer", () => {
      expect(M.saleOrderLogs([transfer(41), order(SEAPORT_15)], opts)).to.have.length(1);
      expect(M.saleOrderLogs([order(SEAPORT_16), transfer(41)], opts)).to.have.length(1);
      expect(M.saleOrderLogs([transfer(41), order(SEAPORT_15.toLowerCase())], opts)).to.have.length(1);
    });
    it("drops a forged event from any other contract (the fake 1000 ETH sale)", () => {
      expect(M.saleOrderLogs([transfer(41), order(FAKE)], opts)).to.deep.equal([]);
      expect(M.saleOrderLogs([transfer(41), order(FAKE), order(SEAPORT_15)], opts)).to.have.length(1);
    });
    it("drops a genuine Seaport event when the agent did not move in that receipt", () => {
      expect(M.saleOrderLogs([order(SEAPORT_15)], opts)).to.deep.equal([]);
      expect(M.saleOrderLogs([transfer(7), order(SEAPORT_15)], opts)).to.deep.equal([]);
      expect(M.saleOrderLogs([transfer(41, FAKE), order(SEAPORT_15)], opts)).to.deep.equal([]);
    });
    it("ignores other events from Seaport", () => {
      const other = { address: SEAPORT_15, topics: [pad(99)], data: "0x" };
      expect(M.saleOrderLogs([transfer(41), other], opts)).to.deep.equal([]);
    });
    it("accepts the local stand-in only on the demo chain", () => {
      const logs = [transfer(41), order(MOCK)];
      expect(M.saleOrderLogs(logs, { ...opts, chainId: 31337, localSeaport: MOCK })).to.have.length(1);
      expect(M.saleOrderLogs(logs, { ...opts, chainId: 31337 })).to.deep.equal([]);
      expect(M.saleOrderLogs(logs, { ...opts, chainId: 1, localSeaport: MOCK })).to.deep.equal([]);
    });
    it("copes with missing receipts and malformed logs", () => {
      expect(M.saleOrderLogs(undefined, opts)).to.deep.equal([]);
      expect(M.saleOrderLogs(null, opts)).to.deep.equal([]);
      expect(M.saleOrderLogs([{}, { address: SEAPORT_15 }, null], opts)).to.deep.equal([]);
    });
  });
});
