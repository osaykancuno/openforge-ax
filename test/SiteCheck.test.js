const { expect } = require("chai");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// Pre-publish gate (scripts/check-site.mjs): builds a tiny site in a temp folder and checks what the gate refuses.
describe("Site check (scripts/check-site.mjs)", () => {
  let check, root;
  const addr = (n) => "0x" + String(n).repeat(40);
  const CSP = (connect) => `<meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; connect-src ${connect}">`;
  const LOCAL = "http://localhost:* http://127.0.0.1:* ws://localhost:* ws://127.0.0.1:*";
  const deployment = (over = {}) => ({
    chainId: 1, chainName: "Ethereum", rpcUrl: "https://rpc.example.org", explorer: "https://etherscan.io",
    openseaDropUrl: "https://opensea.io/collection/openforge-agents/overview", agents: addr(1), renderer: addr(2), reputation: addr(3), fromBlock: 21_000_000, ...over,
  });

  // writes a publishable site; `over` patches deployment.json, `pages` replaces the html files
  function site({ dep = {}, pages } = {}) {
    const web = fs.mkdtempSync(path.join(root, "web-"));
    fs.mkdirSync(path.join(web, "js"));
    fs.mkdirSync(path.join(web, "vendor/three"), { recursive: true });
    fs.writeFileSync(path.join(web, "deployment.json"), JSON.stringify(deployment(dep)));
    fs.writeFileSync(path.join(web, "js/config.js"), `export const CONFIG = { social: { x: "https://x.com/openforge", discord: "https://discord.gg/openforge" } };`);
    for (const f of ["ethers.min.js", "three/three.module.js", "three/three.module.min.js"]) fs.writeFileSync(path.join(web, "vendor", f), "");
    fs.writeFileSync(path.join(web, "_headers"), "/*\n  X-Frame-Options: DENY\n");
    for (const [name, html] of Object.entries(pages ?? { "index.html": `<!doctype html><meta charset="utf-8">${CSP("'self' https: wss:")}<p>hi` })) fs.writeFileSync(path.join(web, name), html);
    return web;
  }

  before(async () => {
    check = await import("../scripts/check-site.mjs");
    root = fs.mkdtempSync(path.join(os.tmpdir(), "site-check-"));
  });
  after(() => fs.rmSync(root, { recursive: true, force: true }));

  it("passes a clean mainnet site", () => {
    expect(check.siteProblems(site(), 1)).to.deep.equal([]);
  });

  describe("loopback hosts in the CSP", () => {
    const pages = (connect) => ({ "index.html": `<!doctype html><meta charset="utf-8">${CSP(connect)}<p>hi` });
    it("refuses a public build whose CSP still lists localhost / 127.0.0.1", () => {
      for (const connect of [`'self' https: wss: ${LOCAL}`, "'self' https: http://localhost:*", "'self' https: ws://127.0.0.1:*"]) {
        const p = check.siteProblems(site({ pages: pages(connect) }), 1);
        expect(p.some((x) => /index\.html.*(localhost|loopback)/i.test(x)), connect).to.equal(true);
      }
    });
    it("allows them on the local demo chain", () => {
      const web = site({ dep: { chainId: 31337, rpcUrl: "http://127.0.0.1:8545", fromBlock: 0 }, pages: pages(`'self' https: ${LOCAL}`) });
      expect(check.siteProblems(web, 31337).filter((x) => /localhost|loopback/i.test(x))).to.deep.equal([]);
    });
    it("lets the Phone Brain page keep its loopback hosts (local model server and bridge)", () => {
      const html = `<!doctype html><meta charset="utf-8">${CSP("'self' http://localhost:* http://127.0.0.1:*")}<p>hi`;
      expect(check.siteProblems(site({ pages: { "index.html": pages("'self' https:")["index.html"], "pilot.html": html } }), 1)).to.deep.equal([]);
    });
  });

  describe("fromBlock", () => {
    it("refuses a real chain whose log scans start at block 0 (or no fromBlock at all)", () => {
      const zero = check.siteProblems(site({ dep: { fromBlock: 0 } }), 1);
      expect(zero.some((x) => /fromBlock/.test(x))).to.equal(true);
      const none = site();
      const d = JSON.parse(fs.readFileSync(path.join(none, "deployment.json"), "utf8"));
      delete d.fromBlock;
      fs.writeFileSync(path.join(none, "deployment.json"), JSON.stringify(d));
      expect(check.siteProblems(none, 1).some((x) => /fromBlock/.test(x))).to.equal(true);
    });
    it("accepts a positive fromBlock, and does not ask for one on the demo chain", () => {
      expect(check.siteProblems(site({ dep: { fromBlock: 7_000_000, chainId: 11155111 } }), 11155111)).to.deep.equal([]);
      const demo = site({ dep: { chainId: 31337, rpcUrl: "http://127.0.0.1:8545", fromBlock: 0 }, pages: { "index.html": `<!doctype html><meta charset="utf-8">${CSP("'self' https:")}<p>hi` } });
      expect(check.siteProblems(demo, 31337).some((x) => /fromBlock/.test(x))).to.equal(false);
    });
  });
});
