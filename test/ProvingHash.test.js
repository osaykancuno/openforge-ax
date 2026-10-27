// The pages hash with the vendored @noble/hashes keccak (web/js/proving/hash.js) instead of loading ethers up front:
// the helpers must equal ethers' byte for byte, since the hash is what the wallet signs inside the EIP-712 message.
const { expect } = require("chai");
const { ethers } = require("hardhat");
const fs = require("fs");
const path = require("path");

describe("proving/hash.js (vendored keccak256, utf8, hexlify)", () => {
  let H;
  before(async () => {
    H = await import("../web/js/proving/hash.js");
  });

  const samples = [
    "", "a", "OpenForge AX", "emoji \u{1F916}\u{1F9BE} and ünïcödé — 日本語", "quote \" backslash \ nul \u0000 tab \t", "'; DROP TABLE agents; --",
    "x".repeat(135), "x".repeat(136), "x".repeat(137), "y".repeat(10000),
  ];
  for (let i = 0; i < 200; i++) samples.push(JSON.stringify({ i, v: Array.from({ length: i % 40 }, (_, k) => (i * 31 + k * 7) % 997), s: "z".repeat(i) }));

  it("toUtf8Bytes equals ethers' for every sample", () => {
    for (const s of samples) expect(H.hexlify(H.toUtf8Bytes(s))).to.equal(ethers.hexlify(ethers.toUtf8Bytes(s)));
  });
  it("keccak256(toUtf8Bytes(s)) equals ethers' for every sample", () => {
    for (const s of samples) expect(H.keccak256(H.toUtf8Bytes(s))).to.equal(ethers.keccak256(ethers.toUtf8Bytes(s)));
  });
  it("keccak256 and hexlify equal ethers' on raw bytes (every length 0..300, all byte values)", () => {
    for (let n = 0; n <= 300; n++) {
      const b = Uint8Array.from({ length: n }, (_, k) => (k * 53 + n) & 255);
      expect(H.hexlify(b)).to.equal(ethers.hexlify(b));
      expect(H.keccak256(b)).to.equal(ethers.keccak256(b));
    }
    const all = Uint8Array.from({ length: 256 }, (_, k) => k);
    expect(H.hexlify(all)).to.equal(ethers.hexlify(all));
  });
  it("a lone surrogate is an error (ethers rejects a lone high one; a lone low one it would encode, we refuse it too)", () => {
    const hi = String.fromCharCode(0xd83d), lo = String.fromCharCode(0xde00);
    for (const s of [hi, hi + "x"]) expect(() => ethers.toUtf8Bytes(s)).to.throw();
    for (const s of [hi, "a" + lo + "b", hi + "x"]) expect(() => H.toUtf8Bytes(s)).to.throw(/surrogate/);
    expect(H.hexlify(H.toUtf8Bytes("🤖"))).to.equal(ethers.hexlify(ethers.toUtf8Bytes("🤖")));
  });
  it("knows the empty-string vector and ZeroHash", () => {
    expect(H.keccak256(new Uint8Array())).to.equal("0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470");
    expect(H.ZeroHash).to.equal(ethers.ZeroHash);
  });
  it("randomBytes gives n distinct random bytes as a Uint8Array", () => {
    const a = H.randomBytes(32), b = H.randomBytes(32);
    expect(a).to.be.instanceOf(Uint8Array);
    expect(a.length).to.equal(32);
    expect(H.hexlify(a)).to.not.equal(H.hexlify(b));
    expect(H.hexlify(a)).to.match(/^0x[0-9a-f]{64}$/);
  });
  it("the vendored files match web/vendor/SHA256SUMS", () => {
    const crypto = require("crypto");
    const sums = fs.readFileSync(path.join(__dirname, "../web/vendor/SHA256SUMS"), "utf8");
    for (const f of ["sha3.js", "_u64.js", "utils.js", "crypto.js"]) {
      const h = crypto.createHash("sha256").update(fs.readFileSync(path.join(__dirname, "../web/vendor/noble", f))).digest("hex");
      expect(sums).to.include(`${h}  noble/${f}`);
    }
  });
});
