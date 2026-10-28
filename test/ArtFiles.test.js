// Art folder checks before pin / freeze (scripts/lib/art-files.mjs, pin.mjs, finalize.js). No network: fetch is faked.
const { expect } = require("chai");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const guardPath = require.resolve("../scripts/lib/nonce-guard");
require.cache[guardPath] = { id: guardPath, filename: guardPath, loaded: true, exports: {} };

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("image-body")]);
const png = (tag) => Buffer.concat([PNG, Buffer.from(String(tag))]);
const GIF = Buffer.concat([Buffer.from("GIF89a"), Buffer.from("anim-body")]);
const gif = (tag) => Buffer.concat([GIF, Buffer.from(String(tag))]);
/** the right kind of image for a file name: <id>.gif is the animated token, <id>.png the still */
const img = (f, tag = f) => (String(f).endsWith(".gif") ? gif(tag) : png(tag));
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
const names = (n) => ["png", "gif"].flatMap((ext) => Array.from({ length: n }, (_, i) => `${i + 1}.${ext}`));
const reply = (status, body = Buffer.alloc(0)) => ({ status, arrayBuffer: async () => new Uint8Array(body).buffer });

describe("art-files - file set and PNG checks", () => {
  let lib;
  before(async () => {
    lib = await import("../scripts/lib/art-files.mjs");
  });

  it("isPng: signature only; rejects html, empty, truncated, non-buffers", () => {
    expect(lib.isPng(PNG)).to.equal(true);
    expect(lib.isPng(new Uint8Array(PNG))).to.equal(true);
    expect(lib.isPng(Buffer.from("<!doctype html><html>"))).to.equal(false);
    expect(lib.isPng(Buffer.alloc(0))).to.equal(false);
    expect(lib.isPng(PNG.subarray(0, 8))).to.equal(false); // signature with no body
    expect(lib.isPng(PNG.subarray(0, 4))).to.equal(false);
    expect(lib.isPng(undefined)).to.equal(false);
    expect(lib.isPng(null)).to.equal(false);
  });

  it("isGif: GIF89a / GIF87a with a body; a PNG is not a GIF", () => {
    expect(lib.isGif(GIF)).to.equal(true);
    expect(lib.isGif(Buffer.concat([Buffer.from("GIF87a"), Buffer.from("x")]))).to.equal(true);
    expect(lib.isGif(PNG)).to.equal(false);
    expect(lib.isGif(Buffer.from("GIF89a"))).to.equal(false);
    expect(lib.isGif(undefined)).to.equal(false);
  });

  it("checkImageSet: every token needs both its still and its GIF", () => {
    const pngs = Array.from({ length: 5 }, (_, i) => `${i + 1}.png`);
    expect(lib.checkImageSet(pngs, 5)).to.deep.include({ ok: false, extra: [] });
    expect(lib.checkImageSet(pngs, 5).missing).to.have.length(5);
    expect(lib.checkImageSet(names(5).filter((n) => n !== "3.gif"), 5).missing).to.deep.equal(["3.gif"]);
  });

  it("checkImageSet: exactly 1..N.png and 1..N.gif", () => {
    expect(lib.checkImageSet(names(5), 5)).to.deep.include({ ok: true, missing: [], extra: [] });
    expect(lib.checkImageSet(names(5).reverse(), 5).ok).to.equal(true); // order is irrelevant
  });

  it("checkImageSet: missing, extra, dotfiles, json, wrong case and off-by-one are all refused", () => {
    expect(lib.checkImageSet(names(4), 5)).to.deep.include({ ok: false, missing: ["5.png", "5.gif"], extra: [] });
    expect(lib.checkImageSet([...names(5), "6.png"], 5)).to.deep.include({ ok: false, extra: ["6.png"] });
    expect(lib.checkImageSet([...names(5), ".DS_Store"], 5).extra).to.deep.equal([".DS_Store"]);
    expect(lib.checkImageSet([...names(5), "1.json"], 5).ok).to.equal(false);
    expect(lib.checkImageSet([...names(4), "5.PNG"], 5).ok).to.equal(false);
    expect(lib.checkImageSet(["0.png", ...names(4)], 5).ok).to.equal(false);
    expect(lib.checkImageSet(["01.png", ...names(4)], 5).missing).to.deep.equal(["5.png", "5.gif"]);
    expect(lib.checkImageSet(names(5), 0).ok).to.equal(false);
    expect(lib.checkImageSet([], 5).missing).to.have.length(10); // 5 stills + 5 GIFs
    expect(lib.checkImageSet(names(5), NaN).ok).to.equal(false);
  });

  it("assertImageSet: readable error that names the offenders and truncates long lists", () => {
    expect(() => lib.assertImageSet(names(3), 3)).to.not.throw();
    expect(() => lib.assertImageSet([...names(2), "notes.txt"], 3, "art/out/images")).to.throw(/art\/out\/images must contain exactly 1\.png … 3\.png.*Missing: 3\.png.*Unexpected: notes\.txt/);
    expect(() => lib.assertImageSet([], 20)).to.throw(/\(\+32\)/);
  });

  it("the 1024-image set passes and one missing file fails it (scale)", () => {
    expect(lib.checkImageSet(names(1024), 1024).ok).to.equal(true);
    expect(lib.checkImageSet(names(1024).filter((n) => n !== "512.png"), 1024).missing).to.deep.equal(["512.png"]);
  });

  it("sampleIds: first, middle, last, no duplicates", () => {
    expect(lib.sampleIds(1024)).to.deep.equal([1, 512, 1024]);
    expect(lib.sampleIds(1)).to.deep.equal([1]);
    expect(lib.sampleIds(2)).to.deep.equal([1, 2]);
  });

  it("gatewayBase: ipfs URIs go through the gateway, https stays", () => {
    expect(lib.gatewayBase("ipfs://CID/")).to.equal("https://gateway.pinata.cloud/ipfs/CID/");
    expect(lib.gatewayBase("ipfs://CID/sub/", "https://ipfs.io/ipfs/")).to.equal("https://ipfs.io/ipfs/CID/sub/");
    expect(lib.gatewayBase("https://site.xyz/images/")).to.equal("https://site.xyz/images/");
  });

  it("fetchImage: a .gif URL must answer a GIF, anything else a PNG", async () => {
    expect((await lib.fetchImage("u/1.gif", async () => reply(200, GIF))).ok).to.equal(true);
    const wrong = await lib.fetchImage("u/1.gif", async () => reply(200, PNG));
    expect(wrong.ok).to.equal(false);
    expect(wrong.reason).to.match(/not a GIF/);
    expect((await lib.fetchImage("u/1.png", async () => reply(200, GIF))).ok).to.equal(false);
  });

  it("fetchPng: 200 + PNG ok; 404, 200 html and network failures are not", async () => {
    expect((await lib.fetchPng("u", async () => reply(200, PNG))).ok).to.equal(true);
    expect(await lib.fetchPng("u", async () => reply(404))).to.deep.include({ ok: false });
    expect((await lib.fetchPng("u", async () => reply(404))).reason).to.match(/HTTP 404/);
    const html = await lib.fetchPng("u", async () => reply(200, Buffer.from("<html>soft 404</html>")));
    expect(html.ok).to.equal(false);
    expect(html.reason).to.match(/not a PNG/);
    expect(await lib.fetchPng("u", async () => reply(301, PNG))).to.deep.include({ ok: false });
    const net = await lib.fetchPng("u", async () => {
      throw new TypeError("fetch failed");
    });
    expect(net).to.deep.include({ ok: false, network: true });
  });

  describe("verifyPinned", () => {
    const local = (n) => (f) => img(f, `${n}:${f}`);
    const run = (extra) => lib.verifyPinned({ cid: "CID", supply: 10, readLocal: local("a"), delayMs: 0, log: () => {}, ...extra });

    it("passes when the gateway serves the same bytes for 3 sampled tokens (still and GIF)", async () => {
      const urls = [];
      const r = await run({ fetchImpl: async (u) => (urls.push(u), reply(200, local("a")(u.split("/").pop()))) });
      expect(r).to.deep.equal({ skipped: false });
      expect(urls).to.deep.equal(["1.png", "1.gif", "5.png", "5.gif", "10.png", "10.gif"].map((f) => `https://gateway.pinata.cloud/ipfs/CID/${f}`));
    });

    it("throws when a served image differs from the local file", async () => {
      await expect(run({ fetchImpl: async (u) => reply(200, local("tampered")(u.split("/").pop())) })).to.be.rejectedWith(/differs from the local file/);
    });

    it("throws on a persistent HTTP error after retrying, and names the CID", async () => {
      let calls = 0;
      await expect(run({ retries: 3, fetchImpl: async () => (calls++, reply(504)) })).to.be.rejectedWith(/CID CID was created/);
      expect(calls).to.equal(3);
    });

    it("tolerates a gateway that is slow at first", async () => {
      let calls = 0;
      const r = await run({ fetchImpl: async (u) => (++calls === 1 ? reply(404) : reply(200, local("a")(u.split("/").pop()))) });
      expect(r.skipped).to.equal(false);
    });

    it("offline: skipped with a clear message, no failure", async () => {
      const logs = [];
      const r = await run({
        log: (m) => logs.push(m),
        fetchImpl: async () => {
          throw new TypeError("fetch failed");
        },
      });
      expect(r).to.deep.equal({ skipped: true });
      expect(logs.join("\n")).to.match(/Gateway check skipped \(offline\?\)/);
    });
  });
});

describe("pin.mjs - refuses a folder that is not exactly 1..N.png + 1..N.gif", () => {
  let dir, pin, savedFetch, savedJwt;
  const put = (f, body = img(f)) => fs.writeFileSync(path.join(dir, f), body);

  before(async () => {
    pin = await import("../scripts/pin.mjs");
  });
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "pin-"));
    savedFetch = globalThis.fetch;
    savedJwt = process.env.PINATA_JWT;
    process.env.PINATA_JWT = "test-jwt";
  });
  afterEach(() => {
    globalThis.fetch = savedFetch;
    if (savedJwt === undefined) delete process.env.PINATA_JWT;
    else process.env.PINATA_JWT = savedJwt;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("rejects a stray file, a gap or an unknown supply BEFORE any upload", async () => {
    globalThis.fetch = async () => {
      throw new Error("the network must not be touched");
    };
    for (const f of [...names(3), "stray.json"]) put(f);
    await expect(pin.pinFolder(dir, "t", { supply: 3 })).to.be.rejectedWith(/exactly 1\.png … 3\.png and 1\.gif … 3\.gif.*Unexpected: stray\.json/);
    fs.rmSync(path.join(dir, "stray.json"));
    fs.rmSync(path.join(dir, "2.png"));
    await expect(pin.pinFolder(dir, "t", { supply: 3 })).to.be.rejectedWith(/Missing: 2\.png/);
    put("2.png");
    await expect(pin.pinFolder(dir, "t")).to.be.rejectedWith(/Cannot tell how many images/);
  });

  it("pins a clean folder, verifies it through the gateway and returns the CID", async () => {
    for (const f of names(3)) put(f);
    const sent = [];
    globalThis.fetch = async (url, opts) => {
      if (String(url).includes("pinFileToIPFS")) {
        sent.push(opts.body.getAll("file").map((b) => b.name));
        return { ok: true, status: 200, json: async () => ({ IpfsHash: "CIDX" }) };
      }
      return reply(200, fs.readFileSync(path.join(dir, String(url).split("/").pop())));
    };
    const log = console.log;
    console.log = () => {};
    try {
      expect(await pin.pinFolder(dir, "set", { supply: 3 })).to.equal("CIDX");
    } finally {
      console.log = log;
    }
    expect(sent[0]).to.have.members(names(3).map((f) => `set/${f}`));
  });

  it("does not return a CID whose gateway copy differs", async () => {
    for (const f of names(3)) put(f);
    globalThis.fetch = async (url) => (String(url).includes("pinFileToIPFS") ? { ok: true, status: 200, json: async () => ({ IpfsHash: "CIDX" }) } : reply(200, png("other")));
    const log = console.log;
    console.log = () => {};
    try {
      await expect(pin.pinFolder(dir, "set", { supply: 3 })).to.be.rejectedWith(/differs from the local file/);
    } finally {
      console.log = log;
    }
  });
});

describe("finalize.js - FREEZE needs the first and last token's PNG and GIF served", () => {
  const { assertImagesServed } = require("../scripts/finalize.js");
  const quiet = async (fn) => {
    const log = console.log;
    console.log = () => {};
    try {
      return await fn();
    } finally {
      console.log = log;
    }
  };

  it("passes when 1.png, 1.gif, <supply>.png and <supply>.gif answer 200 with the right bytes", async () => {
    const urls = [];
    await quiet(() => assertImagesServed("https://site.xyz/images/", 1024, async (u) => (urls.push(u), reply(200, img(u)))));
    expect(urls).to.deep.equal(["1.png", "1.gif", "1024.png", "1024.gif"].map((f) => `https://site.xyz/images/${f}`));
  });

  it("reads ipfs:// through the gateway", async () => {
    const urls = [];
    await quiet(() => assertImagesServed("ipfs://CID/", 3, async (u) => (urls.push(u), reply(200, img(u)))));
    expect(urls[0]).to.equal("https://gateway.pinata.cloud/ipfs/CID/1.png");
  });

  it("refuses on 404, on a 200 that is not a PNG, and when the LAST image is the broken one", async () => {
    await expect(assertImagesServed("ipfs://CID/", 3, async () => reply(404))).to.be.rejectedWith(/Refusing to freeze: HTTP 404/);
    await expect(assertImagesServed("ipfs://CID/", 3, async () => reply(200, Buffer.from("<html>")))).to.be.rejectedWith(/not a PNG/);
    await expect(assertImagesServed("ipfs://CID/", 3, async (u) => (u.endsWith("/3.png") ? reply(404) : reply(200, img(u))))).to.be.rejectedWith(/3\.png/);
    await expect(assertImagesServed("ipfs://CID/", 3, async () => reply(200, PNG))).to.be.rejectedWith(/1\.gif.*not a GIF/); // a still where the GIF should be
  });

  it("refuses when offline (a freeze is never done unchecked) and with nothing minted", async () => {
    await expect(assertImagesServed("ipfs://CID/", 3, async () => { throw new TypeError("fetch failed"); })).to.be.rejectedWith(/Refusing to freeze: network error/);
    await expect(assertImagesServed("ipfs://CID/", 0, async () => reply(200, PNG))).to.be.rejectedWith(/Nothing minted/);
  });

  it("supply 1 checks the single token once (still and GIF)", async () => {
    const urls = [];
    await quiet(() => assertImagesServed("ipfs://CID/", 1, async (u) => (urls.push(u), reply(200, img(u)))));
    expect(urls).to.have.length(2);
  });
});
