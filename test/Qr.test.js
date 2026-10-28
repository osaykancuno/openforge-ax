const { expect } = require("chai");
const { createHash } = require("node:crypto");

// web/js/qr.js: the QR code on My IRL lab's "Open this on your phone" card. The encoder was cross-checked bit for bit
// against the npm "qrcode" encoder (levels M and H, all 8 masks, versions 1–10), and the branded page symbol (pills,
// round eyes, the AX-1 mark in the middle) decoded with jsQR at 120–440 px, on 2026-10-28; these checks keep the
// structure and that verified symbol from drifting.
describe("QR encoder (web/js/qr.js)", () => {
  let Q;
  before(async () => { Q = await import("../web/js/qr.js"); });

  const bits = (q) => q.modules.map((r) => r.map((b) => (b ? 1 : 0)).join("")).join("\n");

  it("encodes the live AR link as the verified symbol (version 4, level M)", () => {
    const q = Q.qrEncode("https://osaykancuno.github.io/openforge-ax/ar.html");
    expect([q.version, q.size, q.mask]).to.deep.equal([4, 33, 2]);
    expect(createHash("sha256").update(bits(q)).digest("hex")).to.equal("d1120240507250917b2b5e0fcee3f4ae23753a21a898b049d3b7ef47cde8a892");
  });

  it("draws the three finder patterns, the timing lines and the dark module", () => {
    const { modules: m, size } = Q.qrEncode("http://localhost:8080/ar.html");
    const finder = ["1111111", "1000001", "1011101", "1011101", "1011101", "1000001", "1111111"];
    for (const [x0, y0] of [[0, 0], [size - 7, 0], [0, size - 7]]) {
      const got = finder.map((_, dy) => m[y0 + dy].slice(x0, x0 + 7).map((b) => (b ? 1 : 0)).join(""));
      expect(got, `finder at ${x0},${y0}`).to.deep.equal(finder);
    }
    for (let i = 8; i < size - 8; i++) {
      expect(m[6][i], `timing row ${i}`).to.equal(i % 2 === 0);
      expect(m[i][6], `timing column ${i}`).to.equal(i % 2 === 0);
    }
    expect(m[size - 8][8]).to.equal(true);
  });

  it("picks the smallest version that fits and refuses text that does not", () => {
    expect(Q.qrEncode("A").version).to.equal(1);
    expect(Q.qrEncode("x".repeat(14)).version).to.equal(1); // 14 bytes is version 1-M's limit
    expect(Q.qrEncode("x".repeat(15)).version).to.equal(2);
    expect(Q.qrEncode("z".repeat(213)).version).to.equal(10);
    expect(() => Q.qrEncode("z".repeat(214))).to.throw(RangeError);
  });

  it("level H (room for the logo) uses its own blocks and format bits", () => {
    const url = "https://osaykancuno.github.io/openforge-ax/ar.html";
    const h = Q.qrEncode(url, { level: "H" });
    expect(h.version).to.equal(6); // 50 bytes: version 6-H holds 58 (verified against "qrcode" for all 8 masks)
    // the format bits beside the top-left finder name the level: they must differ between M and H
    const m = Q.qrEncode(url).modules, mh = h.modules;
    expect([0, 1, 2, 3, 4, 5].map((i) => mh[i][8])).to.not.deep.equal([0, 1, 2, 3, 4, 5].map((i) => m[i][8]));
    expect(Q.qrEncode("x".repeat(119), { level: "H" }).version).to.equal(10);
    expect(() => Q.qrEncode("x".repeat(120), { level: "H" })).to.throw(RangeError);
    expect(() => Q.qrEncode("x", { level: "Q" })).to.throw(RangeError);
  });

  it("qrArt leaves an odd, centred hole for the mark and draws no module inside it", () => {
    for (const url of ["https://osaykancuno.github.io/openforge-ax/ar.html", "http://localhost:8080/ar.html"]) {
      const a = Q.qrArt(url);
      const { x, y, w } = a.hole;
      expect(w % 2, "odd").to.equal(1);
      expect(x * 2 + w, "centred").to.equal(a.size);
      expect(x).to.equal(y);
      for (const r of a.runs) expect(r.y < y - 1 || r.y > y + w || r.x + r.w <= x - 1 || r.x > y + w, `run at ${r.x},${r.y}`).to.equal(true);
      expect(a.eyes.match(/M/g)).to.have.length(9); // three finders, three shapes each
    }
  });

  it("returns an SVG path with a 4-module quiet zone", () => {
    const p = Q.qrPath("A");
    expect(p.viewBox).to.equal("0 0 29 29"); // 21 + 2 × 4
    expect(p.d).to.match(/^M4 4h7v1h-7z/); // the top-left finder's first row
  });
});
