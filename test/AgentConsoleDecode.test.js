const { expect } = require("chai");

// web/js/agent/decode.js: what a proposal does, in words, with risk flags. Pure: the caller says whether the target
// is a contract (it asks the node for its code); the decoder never trusts the data it reads.
describe("Agent console: proposal decoder (web/js/agent/decode.js)", () => {
  let D;
  const pad = (hex) => hex.replace(/^0x/, "").padStart(64, "0");
  const addr = "0x" + "ab".repeat(20);
  const account = "0x" + "cd".repeat(20);
  const holder = "0x" + "ef".repeat(20);
  const codes = (r) => r.flags.map((f) => f.code);
  before(async () => {
    D = await import("../web/js/agent/decode.js");
  });

  it("a plain ETH transfer to a plain address is low risk", () => {
    const r = D.decodeCall({ to: addr, value: 10n ** 16n, data: "0x" }, { isContract: false });
    expect(r.kind).to.equal("eth");
    expect(r.risk).to.equal("low");
    expect(r.selector).to.equal(null);
    expect(r.bytes).to.equal(0);
    expect(r.flags).to.deep.equal([]);
  });

  it("flags every denylisted selector as an asset move, with a name for the common ones", () => {
    const r = D.decodeCall({ to: addr, value: 0n, data: "0xa9059cbb" + pad(addr) + pad("0x" + (5n * 10n ** 18n).toString(16)) }, { isContract: true });
    expect(codes(r)).to.include("asset-move");
    expect(r.risk).to.equal("high");
    expect(r.name).to.equal("transfer(address,uint256)");
    expect(r.args.map((a) => a.value)).to.include(addr);
    expect(r.args.some((a) => /5000000000000000000/.test(a.value))).to.equal(true);
  });

  it("flags an unnamed denylisted selector too (any of the 27)", async () => {
    const { ASSET_MOVE } = await import("../web/js/agent/policy.js");
    for (const sel of ASSET_MOVE) {
      const r = D.decodeCall({ to: addr, value: 0n, data: sel + "00".repeat(32) }, { isContract: true });
      expect(codes(r), sel).to.include("asset-move");
      expect(r.risk, sel).to.equal("high");
    }
  });

  it("an unlimited approval gets its own high-risk flag", () => {
    const max = "f".repeat(64);
    const r = D.decodeCall({ to: addr, value: 0n, data: "0x095ea7b3" + pad(addr) + max }, { isContract: true });
    expect(codes(r)).to.include.members(["asset-move", "unlimited-approval"]);
    const finite = D.decodeCall({ to: addr, value: 0n, data: "0x095ea7b3" + pad(addr) + pad("0x64") }, { isContract: true });
    expect(codes(finite)).to.not.include("unlimited-approval");
  });

  it("an unknown function on a contract is medium risk; on a plain address, the data does nothing", () => {
    const u = D.decodeCall({ to: addr, value: 0n, data: "0x12345678" + pad("0x1") }, { isContract: true });
    expect(codes(u)).to.deep.equal(["unknown-selector", "target-unverified"]);
    expect(u.risk).to.equal("medium");
    expect(u.kind).to.equal("call");
    const e = D.decodeCall({ to: addr, value: 0n, data: "0x12345678" }, { isContract: false });
    expect(codes(e)).to.include("eoa-with-data");
    expect(e.risk).to.equal("medium");
  });

  it("a familiar function name never vouches for the contract: any call with data is flagged unless the target is trusted (M4)", () => {
    for (const data of ["0xd0e30db0", "0x2e1a7d4d" + pad("0x1"), "0x4e71d92d", "0x3ccfd60b"]) {
      const r = D.decodeCall({ to: addr, value: 0n, data }, { isContract: true });
      expect(r.name, data).to.be.a("string");
      expect(codes(r), data).to.deep.equal(["target-unverified"]);
      expect(r.risk).to.equal("medium");
    }
    const asset = D.decodeCall({ to: addr, value: 0n, data: "0xa9059cbb" + pad(addr) + pad("0x1") }, { isContract: true });
    expect(codes(asset)).to.include.members(["asset-move", "target-unverified"]);
    // the agent wallet and the project's own contracts are the only targets that need no warning
    const trusted = [addr.toUpperCase().replace("0X", "0x")];
    expect(codes(D.decodeCall({ to: addr, value: 0n, data: "0xd0e30db0" }, { isContract: true, trusted }))).to.deep.equal([]);
    expect(codes(D.decodeCall({ to: "0x" + "12".repeat(20), value: 0n, data: "0xd0e30db0" }, { isContract: true, trusted }))).to.deep.equal(["target-unverified"]);
    expect(codes(D.decodeCall({ to: addr, value: 0n, data: "0xd0e30db0" }, { isContract: true, trusted: [undefined, null, ""] }))).to.deep.equal(["target-unverified"]);
  });

  it("says so when it could not tell whether the target is a contract", () => {
    const r = D.decodeCall({ to: addr, value: 0n, data: "0x12345678" }, {});
    expect(codes(r)).to.include("target-unchecked");
    expect(D.decodeCall({ to: addr, value: 1n, data: "0x" }, {}).flags).to.deep.equal([]); // plain ETH needs no code check
  });

  it("flags the account itself, a payment to the holder, and short or malformed data", () => {
    expect(codes(D.decodeCall({ to: account, value: 1n, data: "0x" }, { isContract: true, account }))).to.include("to-account");
    const own = D.decodeCall({ to: holder, value: 1n, data: "0x" }, { isContract: false, holder });
    expect(codes(own)).to.deep.equal(["pays-holder"]);
    expect(own.risk).to.equal("low");
    expect(codes(D.decodeCall({ to: addr, value: 0n, data: "0x1234" }, { isContract: true }))).to.include("short-data");
    for (const data of ["0xzz", "12345678", "0x123", 7, null]) {
      const r = D.decodeCall({ to: addr, value: 0n, data }, { isContract: true });
      expect(codes(r), String(data)).to.include("malformed-data");
      expect(r.risk).to.equal("high");
    }
  });

  it("copes with a hostile target or value without throwing", () => {
    const r = D.decodeCall({ to: "<img src=x onerror=alert(1)>", value: -1n, data: "0x" }, { isContract: false });
    expect(codes(r)).to.include("malformed-target");
    expect(() => D.decodeCall(undefined)).to.not.throw();
    expect(() => D.decodeCall({})).to.not.throw();
  });

  it("returns plain strings only (the page shows them through textContent)", () => {
    const r = D.decodeCall({ to: addr, value: 5n, data: "0xa22cb465" + pad(addr) + pad("0x1") }, { isContract: true });
    for (const f of r.flags) {
      expect(f.text).to.be.a("string").and.not.equal("");
      expect(["high", "medium", "low"]).to.include(f.level);
    }
    expect(r.name).to.equal("setApprovalForAll(address,bool)");
  });

  it("truncates a long call to a short preview of the data, and reports its size", () => {
    const r = D.decodeCall({ to: addr, value: 0n, data: "0x12345678" + "ab".repeat(5000) }, { isContract: true });
    expect(r.bytes).to.equal(5004);
    expect(r.preview.length).to.be.below(200);
  });
});
