const { expect } = require("chai");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// scripts/prepare-site.mjs (the published copy for Cloudflare and the github.io preview), scripts/lib/rpc-origins.mjs
// (the RPC origins the AR page may reach) and web/js/chain.js rpcUrls() (the RPCs the site reads from).
describe("Publishing: prepare-site, RPC origins, RPC fallbacks", () => {
  let P, R, tmp;
  const web = path.join(__dirname, "..", "web");
  before(async () => {
    P = await import("../scripts/prepare-site.mjs");
    R = await import("../scripts/lib/rpc-origins.mjs");
  });
  beforeEach(() => (tmp = fs.mkdtempSync(path.join(os.tmpdir(), "site-"))));
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const read = (out, f) => fs.readFileSync(path.join(out, f), "utf8");
  const local = JSON.parse(fs.readFileSync(path.join(web, "deployment.json"), "utf8")).chainId === 31337;

  it("cloudflare: keeps _headers, adds noindex until --index, prunes the never-published files", () => {
    const out = path.join(tmp, "cf");
    P.prepareSite({ target: "cloudflare", out });
    expect(read(out, "_headers")).to.include("X-Frame-Options: DENY").and.include("X-Robots-Tag: noindex");
    expect(read(out, "robots.txt")).to.match(/Disallow: \//);
    expect(fs.existsSync(path.join(out, "sitemap.xml"))).to.equal(false);
    for (const p of P.NEVER_PUBLISHED) expect(fs.existsSync(path.join(out, p)), p).to.equal(false);
    const launched = path.join(tmp, "cf-launch");
    P.prepareSite({ target: "cloudflare", out: launched, index: true });
    expect(read(launched, "_headers")).to.not.include("X-Robots-Tag: noindex\n/*").and.not.include("prepare-site.mjs without --index");
  });

  it("_headers: one rule per path (Cloudflare keeps only the last), and the published /* rule keeps every security header", () => {
    const paths = (text) => text.split(/\r?\n/).filter((l) => l && !/^\s/.test(l) && !l.startsWith("#"));
    const dupes = (list) => list.filter((p, i) => list.indexOf(p) !== i);
    expect(dupes(paths(fs.readFileSync(path.join(web, "_headers"), "utf8"))), "web/_headers").to.deep.equal([]);
    for (const index of [false, true]) {
      const out = path.join(tmp, `cf-${index}`);
      P.prepareSite({ target: "cloudflare", out, index });
      const text = read(out, "_headers");
      expect(dupes(paths(text)), `published, index=${index}`).to.deep.equal([]);
      const all = text.split(/\r?\n(?=\S)/).find((block) => /^\/\*\s*$/m.test(block.split(/\r?\n/)[0]));
      for (const h of ["X-Frame-Options: DENY", "Strict-Transport-Security:", "Cross-Origin-Opener-Policy: same-origin", "frame-ancestors 'none'", "Permissions-Policy:"]) expect(all, h).to.include(h);
      // no Early Hints: a Link modulepreload header is fetched before the import map, so "three" fails on the 3D pages
      expect(all, "! Link").to.match(/^ {2}! Link\r?$/m);
      expect(all.includes("X-Robots-Tag: noindex"), "noindex until launch").to.equal(!index);
    }
  });

  it("github: no _headers, no sitemap, never indexed", () => {
    const out = path.join(tmp, "gh");
    P.prepareSite({ target: "github", out });
    expect(fs.existsSync(path.join(out, "_headers"))).to.equal(false);
    expect(fs.existsSync(path.join(out, ".nojekyll"))).to.equal(true);
    expect(read(out, "robots.txt")).to.equal("User-agent: *\nDisallow: /\n");
  });

  (local ? it : it.skip)("the local demo's config never ships: public deployment, no loopback, the AR page on the public RPCs", () => {
    const out = path.join(tmp, "cf");
    P.prepareSite({ target: "cloudflare", out });
    expect(read(out, "deployment.json")).to.equal(P.PUBLIC_DEPLOYMENT);
    expect(fs.existsSync(path.join(out, "data/rarity.json"))).to.equal(false);
    for (const f of fs.readdirSync(out).filter((f) => f.endsWith(".html") && f !== "pilot.html")) {
      expect(read(out, f), f).to.not.match(/(localhost|127\.0\.0\.1)/);
    }
    expect(read(out, "ar.html")).to.match(/connect-src 'self' https:\/\/ethereum-rpc\.publicnode\.com https:\/\/eth\.drpc\.org https:\/\/1rpc\.io;/);
    expect(read(out, "pilot.html")).to.include("http://127.0.0.1:*"); // the visitor's own model server, by design
  });

  it("refuses an unknown target, an output on top of web/, and a tampered vendored file", () => {
    expect(() => P.prepareSite({ target: "netlify", out: path.join(tmp, "x") })).to.throw(/--target/);
    expect(() => P.prepareSite({ target: "github", out: web })).to.throw(/separate folder/);
    const fake = path.join(tmp, "web");
    fs.mkdirSync(path.join(fake, "vendor"), { recursive: true });
    fs.writeFileSync(path.join(fake, "vendor/lib.js"), "tampered");
    fs.writeFileSync(path.join(fake, "vendor/SHA256SUMS"), `# a comment\n${"0".repeat(64)}  lib.js\n`);
    expect(() => P.prepareSite({ target: "github", out: path.join(tmp, "o"), web: fake })).to.throw(/not the file web:build vendored/);
  });

  it("stripLoopback removes loopback hosts at any port, keeps everything else", () => {
    expect(P.stripLoopback("connect-src 'self' https: http://localhost:* http://127.0.0.1:8545 ws://localhost:8788;")).to.equal("connect-src 'self' https:;");
  });

  it("rpcOrigins: deployment first, else the default plus mainnet fallbacks; https only, loopback only in the demo", () => {
    const configJs = fs.readFileSync(path.join(web, "js/config.js"), "utf8");
    expect(R.rpcOrigins({ configJs, deployment: { chainId: 1 } })).to.deep.equal(["https://ethereum-rpc.publicnode.com", "https://eth.drpc.org", "https://1rpc.io"]);
    expect(R.rpcOrigins({ configJs, deployment: { chainId: 11155111 } })).to.deep.equal(["https://ethereum-rpc.publicnode.com"]);
    expect(R.rpcOrigins({ configJs, deployment: { chainId: 31337, rpcUrl: "http://127.0.0.1:8545" }, localDemo: true })).to.deep.equal(["http://127.0.0.1:8545"]);
    expect(R.rpcOrigins({ configJs, deployment: { chainId: 1, rpcUrl: "http://evil.example" } })).to.deep.equal([]);
    expect(R.arConnectSrc([])).to.equal("connect-src 'self'");
  });

  it("chain.js rpcUrls: mainnet adds the https fallbacks, other chains use only their RPC", async () => {
    const src = fs.readFileSync(path.join(web, "js/chain.js"), "utf8");
    const body = src.slice(src.indexOf("export function rpcUrls"), src.indexOf("\n}", src.indexOf("export function rpcUrls")) + 2);
    const rpcUrls = new Function(`${body.replace("export function", "function")}; return rpcUrls;`)();
    expect(rpcUrls({ chainId: 1, rpcUrl: "https://a.example", rpcFallbacks: ["https://b.example", "http://c.example", "https://a.example"] })).to.deep.equal(["https://a.example", "https://b.example"]);
    expect(rpcUrls({ chainId: 11155111, rpcUrl: "https://s.example", rpcFallbacks: ["https://b.example"] })).to.deep.equal(["https://s.example"]);
  });
});
