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
    it("sends the hardening headers", async () => {
      const res = await get(null, { host: "localhost" });
      expect(res.headers["x-content-type-options"]).to.equal("nosniff");
      expect(res.headers["referrer-policy"]).to.equal("strict-origin-when-cross-origin");
      expect(res.headers["x-frame-options"]).to.equal("DENY");
      expect(res.headers["content-security-policy"]).to.equal("frame-ancestors 'none'");
    });
  });

  describe("selfhost childEnv", () => {
    const env = { PATH: "/bin", PRIVATE_KEY: "a", SEPOLIA_PRIVATE_KEY: "b", PINATA_JWT: "c", ETHERSCAN_API_KEY: "d", SIM_ATTESTER_KEY: "e", ADMIN_TOKEN: "f", PROVING_RPC_URL: "http://rpc", HOST: "0.0.0.0" };
    it("web and world get no secrets", () => {
      for (const n of ["web", "world"]) {
        const e = selfhost.childEnv(n, env, { X: "1" });
        expect(Object.keys(e).sort()).to.deep.equal(["HOST", "PATH", "PROVING_RPC_URL", "X"]);
      }
    });
    it("proving keeps the attester key, admin token and RPC but loses deploy secrets", () => {
      const e = selfhost.childEnv("proving", env);
      expect(e).to.include({ SIM_ATTESTER_KEY: "e", ADMIN_TOKEN: "f", PROVING_RPC_URL: "http://rpc" });
      for (const k of ["PRIVATE_KEY", "SEPOLIA_PRIVATE_KEY", "PINATA_JWT", "ETHERSCAN_API_KEY"]) expect(e).to.not.have.property(k);
    });
    it("unknown services get least privilege and the input is not mutated", () => {
      expect(selfhost.childEnv("other", env)).to.not.have.property("SIM_ATTESTER_KEY");
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
