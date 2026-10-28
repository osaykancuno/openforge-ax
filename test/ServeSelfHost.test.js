const { expect } = require("chai");
const http = require("node:http");

// Self-hosting servers: Host guard, per-child secrets, IPv6 /64 rate-limit keys, headers.
describe("Self-hosting server hardening", () => {
  let core, serve, selfhost;
  before(async () => {
    core = await import("../scripts/world/core.mjs");
    serve = await import("../scripts/serve.mjs");
    selfhost = await import("../scripts/selfhost.mjs");
  });

  describe("hostAllowed (DNS-rebinding guard)", () => {
    it("allows loopback names with or without port, case-insensitive", () => {
      for (const h of ["localhost", "localhost:8080", "127.0.0.1:8788", "[::1]:8080", "LOCALHOST"]) expect(core.hostAllowed(h), h).to.equal(true);
    });
    it("allows configured extra hosts only", () => {
      const extra = core.hostsOf(["https://lab.example.org", "my.site:9000", "", undefined, "http://[bad"]);
      expect(extra).to.deep.equal(["lab.example.org", "my.site"]);
      expect(core.hostAllowed("lab.example.org", extra)).to.equal(true);
      expect(core.hostAllowed("evil.example.org", extra)).to.equal(false);
    });
    it("rejects foreign, missing and malformed Host headers", () => {
      for (const h of ["evil.com", "evil.com:8080", "localhost.evil.com", "192.168.1.5:8080", undefined, "", "a b", 5]) expect(core.hostAllowed(h), String(h)).to.equal(false);
    });
    it("isLoopbackHost", () => {
      for (const h of ["127.0.0.1", "localhost", "::1", "127.1.2.3"]) expect(core.isLoopbackHost(h)).to.equal(true);
      for (const h of ["0.0.0.0", "192.168.1.2", "::"]) expect(core.isLoopbackHost(h)).to.equal(false);
    });
  });

  describe("serve.mjs handler", () => {
    let srv;
    const get = (guard, headers = {}) =>
      new Promise((ok, fail) => {
        srv = http.createServer(serve.createHandler(guard));
        srv.listen(0, "127.0.0.1", () => {
          const req = http.get({ port: srv.address().port, path: "/index.html", headers }, (res) => {
            res.resume();
            res.on("end", () => srv.close(() => ok(res)));
          });
          req.on("error", fail);
        });
      });

    it("answers 421 to a foreign Host when guarded", async () => {
      expect((await get([], { host: "evil.example.org" })).statusCode).to.equal(421);
    });
    it("serves loopback and configured hosts when guarded", async () => {
      expect((await get([], { host: "localhost:8080" })).statusCode).to.equal(200);
      expect((await get(["lab.example.org"], { host: "lab.example.org" })).statusCode).to.equal(200);
    });
    it("accepts any Host when unguarded (HOST=0.0.0.0 or a proxy)", async () => {
      expect((await get(null, { host: "192.168.1.20:8080" })).statusCode).to.equal(200);
    });
    it("applies the deployment.json overrides whatever the spelling of the path (case, trailing dot or space, ./, double slash)", async () => {
      const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "serve-")) + path.sep;
      fs.writeFileSync(path.join(dir, "deployment.json"), JSON.stringify({ chainId: 1, provingApi: "http://old" }));
      const srv2 = http.createServer(serve.createHandler(null, dir, { provingApi: "http://new" }));
      await new Promise((ok) => srv2.listen(0, "127.0.0.1", ok));
      const fetchJson = (p) => new Promise((ok, fail) => http.get({ port: srv2.address().port, path: p }, (res) => { let s = ""; res.on("data", (c) => (s += c)); res.on("end", () => ok([res.statusCode, s])); }).on("error", fail));
      try {
        for (const p of ["/deployment.json", "/Deployment.json", "/DEPLOYMENT.JSON", "/./deployment.json", "//deployment.json", "/deployment.json."]) {
          const [code, body] = await fetchJson(p);
          // a spelling the file system does not resolve is a 404; one that resolves must carry the override
          if (code === 200) expect(JSON.parse(body).provingApi, p).to.equal("http://new");
          else expect(code, p).to.equal(404);
        }
        expect(JSON.parse((await fetchJson("/deployment.json"))[1])).to.include({ provingApi: "http://new", chainId: 1 });
      } finally {
        srv2.close();
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
    it("Permissions-Policy matches web/_headers: microphone only on the Phone Brain page", async () => {
      const policy = (p) => new Promise((ok, fail) => { const s = http.createServer(serve.createHandler(null)); s.listen(0, "127.0.0.1", () => http.get({ port: s.address().port, path: p }, (res) => { res.resume(); res.on("end", () => s.close(() => ok(res.headers["permissions-policy"]))); }).on("error", fail)); });
      expect(await policy("/pilot.html")).to.include("microphone=(self)");
      expect(await policy("/index.html")).to.include("microphone=()");
      expect(await policy("/robot.html")).to.include("microphone=()");
    });
    it("the AR page gets exactly web/_headers' policy (camera, microphone, WebXR); every other page keeps WebXR off", async () => {
      const policy = (p) => new Promise((ok, fail) => { const s = http.createServer(serve.createHandler(null)); s.listen(0, "127.0.0.1", () => http.get({ port: s.address().port, path: p }, (res) => { res.resume(); res.on("end", () => s.close(() => ok(res.headers))); }).on("error", fail)); });
      const headersFile = require("fs").readFileSync(require("path").join(__dirname, "..", "web", "_headers"), "utf8");
      const wanted = headersFile.match(/^\/ar\.html\r?\n {2}! Permissions-Policy\r?\n {2}Permissions-Policy: (.+?)\r?$/m)[1];
      expect((await policy("/ar.html"))["permissions-policy"]).to.equal(wanted);
      expect(wanted).to.include("xr-spatial-tracking=(self)").and.include("camera=(self)").and.include("microphone=()"); // no voice on the AR page for now
      expect((await policy("/index.html"))["permissions-policy"]).to.include("xr-spatial-tracking=()");
      expect((await policy("/pilot.html"))["permissions-policy"]).to.include("xr-spatial-tracking=()");
      expect((await policy("/vendor/mediapipe/wasm/vision_wasm_internal.wasm"))["content-type"]).to.equal("application/wasm"); // instantiateStreaming needs it
      // the object finder's worker does not inherit ar.html's <meta> CSP: it gets web/_headers' own, network same-origin only
      const workerCsp = headersFile.match(/^\/js\/ar\/vision\/detect-worker\.js\r?\n {2}Content-Security-Policy: (.+?)\r?$/m)[1];
      expect(workerCsp).to.include("connect-src 'self'").and.include("default-src 'none'");
      expect((await policy("/js/ar/vision/detect-worker.js"))["content-security-policy"]).to.equal(`frame-ancestors 'none'; ${workerCsp}`);
      expect((await policy("/js/ar/ar.js"))["content-security-policy"]).to.equal("frame-ancestors 'none'");
    });
    it("sends the hardening headers", async () => {
      const res = await get(null, { host: "localhost" });
      expect(res.headers["x-content-type-options"]).to.equal("nosniff");
      expect(res.headers["referrer-policy"]).to.equal("strict-origin-when-cross-origin");
      expect(res.headers["x-frame-options"]).to.equal("DENY");
      expect(res.headers["content-security-policy"]).to.equal("frame-ancestors 'none'");
    });
  });

  describe("selfhost childEnv", () => {
    const env = { PATH: "/bin", OPENSEA_API_KEY: "g", OPENSEA_SLUG: "my-slug", PRIVATE_KEY: "a", SEPOLIA_PRIVATE_KEY: "b", PINATA_JWT: "c", ETHERSCAN_API_KEY: "d", SIM_ATTESTER_KEY: "e", ADMIN_TOKEN: "f", PROVING_RPC_URL: "http://rpc", HOST: "0.0.0.0" };
    it("web and world get no secrets", () => {
      for (const n of ["web", "world"]) {
        const e = selfhost.childEnv(n, env, { X: "1" });
        expect(Object.keys(e).sort()).to.deep.equal(["HOST", "OPENSEA_SLUG", "PATH", "PROVING_RPC_URL", "X"]); // the slug is public; the OpenSea key stays with the verifier
      }
    });
    it("proving keeps the attester key, admin token and RPC but loses deploy secrets", () => {
      const e = selfhost.childEnv("proving", env);
      expect(e).to.include({ SIM_ATTESTER_KEY: "e", ADMIN_TOKEN: "f", PROVING_RPC_URL: "http://rpc", OPENSEA_API_KEY: "g" });
      for (const k of ["PRIVATE_KEY", "SEPOLIA_PRIVATE_KEY", "PINATA_JWT", "ETHERSCAN_API_KEY"]) expect(e).to.not.have.property(k);
    });
    it("unknown services get least privilege and the input is not mutated", () => {
      expect(selfhost.childEnv("other", env)).to.not.have.property("SIM_ATTESTER_KEY");
      expect(selfhost.childEnv("other", env)).to.not.have.property("OPENSEA_API_KEY");
      expect(env.PRIVATE_KEY).to.equal("a");
    });
    it("service-specific values override", () => {
      expect(selfhost.childEnv("web", { PORT: "1" }, { PORT: "2" }).PORT).to.equal("2");
    });
  });

  describe("normalizeIp", () => {
    it("maps IPv4-mapped IPv6 to IPv4", () => {
      expect(core.normalizeIp("::ffff:1.2.3.4")).to.equal("1.2.3.4");
      expect(core.normalizeIp("::FFFF:10.0.0.1")).to.equal("10.0.0.1");
    });
    it("leaves IPv4 alone", () => expect(core.normalizeIp("203.0.113.9")).to.equal("203.0.113.9"));
    it("collapses IPv6 to its /64", () => {
      const a = core.normalizeIp("2001:db8:1:2:aaaa:bbbb:cccc:dddd");
      expect(a).to.equal("2001:db8:1:2::/64");
      expect(core.normalizeIp("2001:db8:1:2::1")).to.equal(a);
      expect(core.normalizeIp("2001:0db8:0001:0002:ffff:ffff:ffff:ffff")).to.equal(a);
      expect(core.normalizeIp("2001:db8:1:3::1")).to.not.equal(a);
      expect(core.normalizeIp("::1")).to.equal("0:0:0:0::/64");
      expect(core.normalizeIp("fe80::1%eth0")).to.equal("fe80:0:0:0::/64");
    });
    it("handles junk", () => {
      expect(core.normalizeIp(undefined)).to.equal("unknown");
      expect(core.normalizeIp("")).to.equal("unknown");
    });
  });

  describe("world server", () => {
    const { WebSocket } = require("ws");
    const attempt = (url, headers) =>
      new Promise((ok) => {
        const w = new WebSocket(url, { headers });
        w.on("unexpected-response", (_q, res) => { res.resume(); ok(res.statusCode); });
        let got = false;
        w.on("message", () => { got = true; w.close(); });
        w.on("close", (code) => ok(got ? 101 : code));
        w.on("error", () => {});
      });

    it("refuses a foreign Host with 421 when hosts is set, accepts localhost", async () => {
      const port = 18900 + Math.floor(Math.random() * 500);
      const w = core.createWorldServer({ port, hosts: [], deps: {} });
      await w.ready;
      expect(await attempt(`ws://127.0.0.1:${port}`, { host: "evil.example.org" })).to.equal(421);
      expect(await attempt(`ws://127.0.0.1:${port}`, {})).to.equal(101);
      await w.close();
    });

    it("caps the rate table: with maxIpKeys live keys a new key fails closed", async () => {
      const port = 18900 + Math.floor(Math.random() * 500);
      const w = core.createWorldServer({ port, deps: {}, limits: { maxIpKeys: 1, connectsPerMin: 100 } });
      await w.ready;
      expect(await attempt(`ws://127.0.0.1:${port}`, {})).to.equal(101); // takes the only slot (127.0.0.1)
      expect(await attempt(`ws://127.0.0.1:${port}`, {})).to.equal(101); // same key still served
      expect(await attempt(`ws://[::1]:${port}`, {})).to.be.oneOf([4029, 1006]); // new key: refused (or no IPv6 here)
      await w.close();
    });
  });
});
