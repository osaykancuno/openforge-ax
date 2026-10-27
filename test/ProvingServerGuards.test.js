// Small in-process guards shared by the servers: coarse networks, JSON depth, log redaction, contract-wallet RPC budget,
// HTTP hardening and crash safety nets. The server-process regressions live in ProvingServerHardening.test.js.
const { expect } = require("chai");
const { EventEmitter } = require("events");
const http = require("http");
const { ethers } = require("hardhat");

describe("Server guards (in-process)", () => {
  let S, core;
  before(async () => {
    S = await import("../scripts/lib/signatures.mjs");
    core = await import("../scripts/world/core.mjs");
  });

  describe("coarseOf: the wider network behind a rate-limit key", () => {
    it("IPv4 -> its /24, IPv6 -> its /48, IPv4-mapped -> the IPv4's /24", () => {
      expect(S.coarseOf("203.0.113.77")).to.equal("203.0.113.0/24");
      expect(S.coarseOf("::ffff:203.0.113.77")).to.equal("203.0.113.0/24");
      const a = S.coarseOf("2001:db8:1:2:aaaa::1");
      expect(a).to.equal("2001:db8:1::/48");
      expect(S.coarseOf("2001:db8:1:ffff::9")).to.equal(a); // another /64 of the same /48
      expect(S.coarseOf("2001:db8:2:2::1")).to.not.equal(a);
    });
    it("is idempotent on netOf output", () => {
      for (const ip of ["198.51.100.4", "2001:db8:1:2::5"]) expect(S.coarseOf(S.netOf(ip))).to.equal(S.coarseOf(ip));
    });
  });

  describe("tooDeep", () => {
    it("accepts the shapes a run really has, refuses deep nesting without overflowing the stack", () => {
      expect(S.tooDeep({ format: "x", actions: [{ l: 1, r: 2 }, { f: [1, 2, 3] }], features: { action: ["a"] } })).to.equal(false);
      const n = 400_000;
      const deep = JSON.parse("[".repeat(n) + "]".repeat(n));
      expect(S.tooDeep({ seed: deep })).to.equal(true);
      let nested = {};
      for (let i = 0; i < 20; i++) nested = { n: nested };
      expect(S.tooDeep(nested)).to.equal(true);
    });
  });

  describe("redactSecrets", () => {
    it("strips URLs (an RPC key lives in the path or query) and the configured secrets", () => {
      const msg = "failed to detect network (url=https://eth-mainnet.g.alchemy.com/v2/SECRETKEY, code=X) at wss://x.example/ws?key=abc and token HUNTER2HUNTER2";
      const out = S.redactSecrets(msg, ["HUNTER2HUNTER2"]);
      expect(out).to.not.match(/SECRETKEY|alchemy|key=abc|HUNTER2/);
      expect(out).to.include("failed to detect network");
    });
    it("copes with non-strings", () => {
      expect(S.redactSecrets(undefined)).to.equal("");
      expect(S.redactSecrets(new Error("boom https://a.b/c?k=1")).includes("a.b")).to.equal(false);
    });
  });

  describe("ownerVerifier: contract-wallet checks spend an RPC budget", () => {
    const owner = ethers.Wallet.createRandom().address;
    const other = ethers.Wallet.createRandom();
    const td = { domain: { name: "T", version: "1", chainId: 1 }, types: { M: [{ name: "a", type: "uint256" }] }, value: { a: 1 } };
    const fake = (code) => {
      const calls = { getCode: 0, call: 0 };
      return { calls, getCode: async () => (calls.getCode++, code), call: async () => (calls.call++, "0x1626ba7e" + "00".repeat(28)) };
    };

    it("a valid EOA signature never asks for the budget or the chain", async () => {
      const p = fake("0x");
      let asked = 0;
      const verify = S.ownerVerifier(p);
      const sig = await other.signTypedData(td.domain, td.types, td.value);
      expect(await verify(other.address, td, sig, { allowRpc: () => (asked++, true) })).to.equal(true);
      expect(asked).to.equal(0);
      expect(p.calls.getCode).to.equal(0);
    });
    it("when the budget is spent there is no getCode and no eth_call, and the context says why", async () => {
      const p = fake("0x6000");
      const verify = S.ownerVerifier(p);
      const ctx = { allowRpc: () => false };
      expect(await verify(owner, td, "0x" + "11".repeat(65), ctx)).to.equal(false);
      expect(ctx.limited).to.equal(true);
      expect(p.calls).to.deep.equal({ getCode: 0, call: 0 });
    });
    it("with budget, a contract wallet that answers the ERC-1271 magic value passes (and without a context it behaves as before)", async () => {
      const p = fake("0x6000");
      const verify = S.ownerVerifier(p);
      expect(await verify(owner, td, "0x" + "11".repeat(65), { allowRpc: () => true })).to.equal(true);
      expect(await verify(owner, td, "0x" + "11".repeat(65))).to.equal(true);
      expect(p.calls.call).to.equal(2);
    });
  });

  describe("hardenHttpServer", () => {
    it("sets the header and request timeouts and a connection ceiling", () => {
      const srv = core.hardenHttpServer(http.createServer(), { maxConnections: 321 });
      expect(srv.headersTimeout).to.equal(10_000);
      expect(srv.requestTimeout).to.equal(15_000);
      expect(srv.maxConnections).to.equal(321);
      srv.close();
    });
    it("a malformed request does not crash the process: the socket is answered 400 and closed", async () => {
      const srv = core.hardenHttpServer(http.createServer((_q, res) => res.end("ok")));
      await new Promise((r) => srv.listen(0, "127.0.0.1", r));
      const net = require("net");
      const reply = await new Promise((ok, ko) => {
        let data = "";
        const s = net.connect(srv.address().port, "127.0.0.1", () => s.write("NOT HTTP AT ALL\r\n\r\n"));
        s.on("data", (d) => (data += d));
        s.on("close", () => ok(data));
        s.on("error", ko);
      });
      expect(reply).to.match(/^HTTP\/1\.1 400/);
      await new Promise((r) => srv.close(r));
    });
    // Chrome opens spare (preconnect) sockets and sends a request on them later: a "400" written into such a socket when
    // the timeout fires was read by the browser as the answer to its next request (every page 400 after ~20 s idle)
    const replyOf = async (send) => {
      const net = require("net");
      const srv = http.createServer((_q, res) => res.end("ok"));
      core.hardenHttpServer(srv, { headersTimeout: 300, requestTimeout: 400 });
      srv.connectionsCheckingInterval = 100;
      await new Promise((r) => srv.listen(0, "127.0.0.1", r));
      const reply = await new Promise((ok, ko) => {
        let data = "";
        const s = net.connect(srv.address().port, "127.0.0.1", () => send && s.write(send));
        s.on("data", (d) => (data += d));
        s.on("close", () => ok(data));
        s.on("error", ko);
        setTimeout(() => (s.destroy(), ok(data)), 3000);
      });
      await new Promise((r) => srv.close(r));
      return reply;
    };
    it("a silent socket (a browser's preconnect) that times out is closed without a reply, never a stale 400", async () => {
      expect(await replyOf(null)).to.equal("");
    });
    it("a request whose headers stop arriving gets 408 (as Node's own default), then the socket closes", async () => {
      expect(await replyOf("GET / HTTP/1.1\r\nHost: x\r\n")).to.match(/^HTTP\/1\.1 408/);
    });
  });

  describe("installCrashGuards", () => {
    it("logs an unhandled rejection instead of letting it take the process down", () => {
      const proc = new EventEmitter();
      const lines = [];
      core.installCrashGuards("test", { proc, log: (...a) => lines.push(a.join(" ")) });
      proc.emit("unhandledRejection", new Error("boom https://rpc.example/v2/KEY"), Promise.resolve());
      expect(proc.listenerCount("unhandledRejection")).to.equal(1);
      expect(lines.join("\n")).to.match(/boom/);
      expect(lines.join("\n")).to.not.match(/KEY|rpc\.example/);
    });
  });
});
