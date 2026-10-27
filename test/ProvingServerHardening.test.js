// Security regressions of scripts/proving-server.mjs (audit fixes), against the in-process Hardhat chain.
// X-Forwarded-For (TRUST_PROXY) gives every test its own client address, so rate limits never leak between tests.
const { expect } = require("chai");
const { ethers, network } = require("hardhat");
const { spawn } = require("child_process");
const http = require("http");
const net = require("net");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { deployAll, reveal } = require("./helpers");

const ROOT = path.join(__dirname, "..");
const ADMIN = "hardening-admin-token-0123456789abcdef";

const rpcStats = { calls: [], down: false, blindTx: 0 }; // every JSON-RPC method the verifiers sent; down = answer HTTP 500 (a transport failure)

function rpcProxy() {
  const server = http.createServer(async (req, res) => {
    let body = "";
    for await (const c of req) body += c;
    if (rpcStats.down) return res.writeHead(500).end("rpc is down");
    const one = async ({ id, method, params }) => {
      rpcStats.calls.push(method);
      if (method === "eth_getTransactionByHash" && rpcStats.blindTx > 0) return (rpcStats.blindTx--, { jsonrpc: "2.0", id, result: null }); // a flaky balanced node that cannot see a pending tx
      try {
        return { jsonrpc: "2.0", id, result: await network.provider.request({ method, params }) };
      } catch (e) {
        return { jsonrpc: "2.0", id, error: { code: -32000, message: e.message, data: e.data } };
      }
    };
    const msg = JSON.parse(body);
    const out = Array.isArray(msg) ? await Promise.all(msg.map(one)) : await one(msg);
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(out));
  });
  return new Promise((ok) => server.listen(0, "127.0.0.1", () => ok(server)));
}

function startServer(env, port) {
  const child = spawn(process.execPath, [path.join(ROOT, "scripts/proving-server.mjs")], { cwd: ROOT, env: { ...process.env, ...env, PORT: String(port) } });
  let log = "";
  return new Promise((ok, ko) => {
    const t = setTimeout(() => ko(new Error(`server did not start:\n${log}`)), 20_000);
    child.stdout.on("data", (d) => {
      log += d;
      if (/verifier on/.test(log)) clearTimeout(t), ok({ child, log: () => log });
    });
    child.stderr.on("data", (d) => (log += d));
    child.on("exit", (code) => (clearTimeout(t), ko(Object.assign(new Error(`server exited (${code}):\n${log}`), { log }))));
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe("Proving Grounds verifier hardening (server process)", function () {
  this.timeout(180_000);
  let ctx, proxy, dataDir, depFile, arm, sim, lab, deployed;
  const servers = [];
  let base = "http://127.0.0.1:8895";
  let ip = "10.0.0.1";
  const get = (p, headers = {}) => fetch(base + p, { headers: { "x-forwarded-for": ip, ...headers } }).then(async (r) => ({ status: r.status, headers: r.headers, body: await r.json().catch(() => null) }));
  const post = (p, body, headers = {}) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": ip, ...headers }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
  const spawnServer = async (name, port, extra = {}) => {
    const s = await startServer({ DEPLOYMENT_FILE: depFile, DATA_DIR: path.join(dataDir, name), ALLOWED_ORIGIN: "http://site.test", TRUST_PROXY: "true", FLUSH_SECONDS: "3600", ADMIN_TOKEN: ADMIN, ...extra }, port);
    servers.push(s);
    return s;
  };

  before(async () => {
    sim = { ...(await import("../web/js/sim/autopilot.js")), ...(await import("../web/js/sim/episode.js")), ...(await import("../web/js/sim/arm-sim.js")) };
    lab = { ...(await import("../web/js/sim/lab-episode.js")), ...(await import("../web/js/bench/missions/index.js")) };
    ctx = await deployAll({ maxSupply: 40, reserve: 40 });
    await ctx.agents.reserveMint(ctx.bob.address, 40);
    await reveal(ctx.agents);
    const classes = await Promise.all(Array.from({ length: 40 }, (_, i) => ctx.renderer.traitsOf(i + 1).then((t) => Number(t.class_))));
    arm = classes.indexOf(0) + 1;
    expect(arm).to.be.gt(0);
    await ctx.rep.setSimAttester(ctx.alice.address, true);
    proxy = await rpcProxy();
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "proving-hard-"));
    depFile = path.join(dataDir, "deployment.json");
    deployed = { chainId: 31337, rpcUrl: `http://127.0.0.1:${proxy.address().port}`, agents: await ctx.agents.getAddress(), renderer: await ctx.renderer.getAddress(), reputation: await ctx.rep.getAddress() };
    fs.writeFileSync(depFile, JSON.stringify(deployed));
    await spawnServer("main", 8895);
  });

  after(async () => {
    await network.provider.send("evm_setAutomine", [true]);
    for (const s of servers) s.child.kill();
    proxy?.close();
  });

  async function signedLab(tokenId, signer, robot, level) {
    const ch = (await get(`/lab/challenge?tokenId=${tokenId}&owner=${await signer.getAddress()}&robot=${robot}&level=${level}`)).body;
    const m = lab.MISSIONS[robot];
    const actions = m.solve(level, ch.seed);
    await sleep(actions.length * m.dt * 1000 + 300);
    const episode = lab.buildLabEpisode({ tokenId, challengeId: ch.challengeId, robot, level, seed: ch.seed, actions });
    const episodeHash = ethers.keccak256(ethers.toUtf8Bytes(sim.canonicalize(episode)));
    const deadline = Math.floor(Date.now() / 1000) + 600;
    const td = sim.runTypedData({ chainId: 31337, verifyingContract: await ctx.rep.getAddress(), tokenId, challengeId: ch.challengeId, episodeHash, deadline, mission: lab.labMission(robot, level), sim: lab.LAB_SIM_ID });
    return { ch, episode, deadline, signature: await signer.signTypedData(td.domain, td.types, td.value) };
  }

  async function signedArm(tokenId, signer) {
    const ch = (await get(`/challenge?tokenId=${tokenId}&owner=${await signer.getAddress()}`)).body;
    const actions = sim.autopilot(ch.seed);
    await sleep((actions.length / sim.FPS) * 1000 + 300);
    const episode = sim.buildEpisode({ tokenId, challengeId: ch.challengeId, seed: ch.seed, actions });
    const episodeHash = ethers.keccak256(ethers.toUtf8Bytes(sim.canonicalize(episode)));
    const deadline = Math.floor(Date.now() / 1000) + 600;
    const td = sim.runTypedData({ chainId: 31337, verifyingContract: await ctx.rep.getAddress(), tokenId, challengeId: ch.challengeId, episodeHash, deadline });
    return { episode, deadline, signature: await signer.signTypedData(td.domain, td.types, td.value) };
  }

  it("L5: JSON responses carry nosniff and no-store (stats stays public)", async () => {
    ip = "10.1.0.1";
    const h = await get("/health");
    expect(h.headers.get("x-content-type-options")).to.equal("nosniff");
    expect(h.headers.get("cache-control")).to.equal("no-store");
    expect((await get("/stats")).headers.get("cache-control")).to.match(/max-age=60/);
    const miss = await get(`/results/0x${"00".repeat(32)}`);
    expect(miss.status).to.equal(404);
    expect(miss.headers.get("x-content-type-options")).to.equal("nosniff");
  });

  it("L1: a short ADMIN_TOKEN refuses to start; /admin/flush is rate-limited", async () => {
    const err = await startServer({ DEPLOYMENT_FILE: depFile, DATA_DIR: path.join(dataDir, "short"), ALLOWED_ORIGIN: "http://site.test", ADMIN_TOKEN: "too-short" }, 8893).then(() => null, (e) => e);
    expect(err?.message).to.match(/ADMIN_TOKEN must be at least 32 characters/);
    ip = "10.2.0.1";
    for (let i = 0; i < 30; i++) expect((await post("/admin/flush", {}, { "x-admin-token": "wrong" })).status).to.equal(401);
    expect((await post("/admin/flush", {}, { "x-admin-token": ADMIN })).status).to.equal(429);
  });

  it("M1/M5: file GETs are rate-limited per network: an IPv6 /64 and an IPv4-mapped address count as one client", async () => {
    // 240 per minute: spread over addresses of one /64
    for (let i = 0; i < 240; i++) expect((await get("/batches/x", { "x-forwarded-for": `2001:db8:aa:bb:${i}::${i + 1}` })).status, `request ${i}`).to.equal(400);
    expect((await get("/batches/x", { "x-forwarded-for": "2001:db8:aa:bb:ffff::9" })).status).to.equal(429);
    expect((await get("/batches/x", { "x-forwarded-for": "2001:db8:aa:cc::1" })).status).to.equal(400); // another /64
    for (let i = 0; i < 120; i++) await get("/batches/x", { "x-forwarded-for": "::ffff:9.9.9.9" });
    for (let i = 0; i < 120; i++) await get("/batches/x", { "x-forwarded-for": "9.9.9.9" });
    expect((await get("/batches/x", { "x-forwarded-for": "::ffff:9.9.9.9" })).status).to.equal(429);
  });

  it("M2: the signature is checked before any simulation; 20 wrong signatures per agent rate-limit (429) without retiring the challenge", async () => {
    ip = "10.3.0.1";
    const tokenId = arm === 3 ? 4 : 3;
    const robot = "ax1-rover";
    const level = lab.MISSIONS[robot].levels[0].id;
    const run = await signedLab(tokenId, ctx.bob, robot, level);
    const forged = await ctx.carol.signTypedData(
      ...(() => {
        const td = sim.runTypedData({ chainId: 31337, verifyingContract: deployed.reputation, tokenId, challengeId: run.ch.challengeId, episodeHash: ethers.keccak256(ethers.toUtf8Bytes(sim.canonicalize(run.episode))), deadline: run.deadline, mission: lab.labMission(robot, level), sim: lab.LAB_SIM_ID });
        return [td.domain, td.types, td.value];
      })()
    );
    // a run with actions after the end and a wrong signature is a 401, not an "after the run ended" 400
    const padded = { ...run.episode, actions: [...run.episode.actions, run.episode.actions.at(-1)] };
    expect((await post("/lab/episodes", { episode: padded, signature: forged, deadline: run.deadline })).status).to.equal(401);
    for (let i = 0; i < 19; i++) expect((await post("/lab/episodes", { episode: run.episode, signature: forged, deadline: run.deadline })).status, `bad ${i}`).to.equal(401);
    expect((await post("/lab/episodes", { episode: run.episode, signature: forged, deadline: run.deadline })).status).to.equal(429);
    // never retired: the same open mission is still served
    expect((await get(`/lab/challenge?tokenId=${tokenId}&owner=${ctx.bob.address}&robot=${robot}&level=${level}`)).body.challengeId).to.equal(run.ch.challengeId);
    // a stranger who spent the budget cannot lock the real owner out: the owner's correctly signed run still goes through (local ecrecover, no RPC)...
    const good = await post("/lab/episodes", { episode: run.episode, signature: run.signature, deadline: run.deadline });
    expect(good.status).to.equal(200);
    expect(good.body.outcome.success).to.equal(true);
    // ...while the rule for wrong signatures stands: the next wrong one on a fresh mission is still a 429, and an unsigned/garbage one too
    const level2 = lab.MISSIONS[robot].levels[1].id;
    const run2 = await signedLab(tokenId, ctx.bob, robot, level2);
    const td2 = sim.runTypedData({ chainId: 31337, verifyingContract: deployed.reputation, tokenId, challengeId: run2.ch.challengeId, episodeHash: ethers.keccak256(ethers.toUtf8Bytes(sim.canonicalize(run2.episode))), deadline: run2.deadline, mission: lab.labMission(robot, level2), sim: lab.LAB_SIM_ID });
    const forged2 = await ctx.carol.signTypedData(td2.domain, td2.types, td2.value);
    expect((await post("/lab/episodes", { episode: run2.episode, signature: forged2, deadline: run2.deadline })).status).to.equal(429);
    expect((await post("/lab/episodes", { episode: run2.episode, signature: "0x" + "11".repeat(65), deadline: run2.deadline })).status).to.equal(429);
    expect((await post("/lab/episodes", { episode: run2.episode, signature: run2.signature, deadline: run2.deadline })).status).to.equal(200);
  });

  it("L4: open Energy Cell challenges per agent and network are bounded, the oldest dropped", async () => {
    ip = "10.4.0.1";
    const ids = [];
    for (let i = 0; i < 11; i++) ids.push((await get(`/challenge?tokenId=${arm}&owner=${ctx.bob.address}`)).body.challengeId);
    const probe = (id) => post("/episodes", { episode: { challengeId: id, tokenId: arm }, signature: "0x00", deadline: Math.floor(Date.now() / 1000) + 60 });
    expect((await probe(ids[0])).body.error).to.match(/unknown or used challenge/);
    expect((await probe(ids[1])).body.error).to.not.match(/unknown or used challenge/);
    ip = "10.4.0.2"; // another network does not push this one out
    await get(`/challenge?tokenId=${arm}&owner=${ctx.bob.address}`);
    ip = "10.4.0.1";
    expect((await probe(ids[2])).body.error).to.not.match(/unknown or used challenge/);
  });

  it("M4: a quality run is stored and attested; episode files exist only for attested arm runs", async () => {
    ip = "10.5.0.1";
    const run = await signedArm(arm, ctx.bob);
    const ok = await post("/episodes", run);
    expect(ok.status).to.equal(200);
    expect(ok.body.attest).to.equal(true);
    expect((await get(`/episodes/${ok.body.dataHash}`)).status).to.equal(200);
    const again = await signedArm(arm, ctx.bob); // same autopilot trajectory only for the same seed: new seed, a fresh pass
    const second = await post("/episodes", again);
    if (!second.body.attest) {
      expect(second.body.episodeUrl).to.equal(null);
      expect((await get(`/episodes/${second.body.dataHash}`)).status).to.equal(404);
    }
  });

  it("M6a: the local demo binds to loopback and refuses a foreign Host header (421); an explicit HOST turns the guard off", async () => {
    const hostGet = (port, host) =>
      new Promise((ok, ko) => http.get({ host: "127.0.0.1", port, path: "/health", headers: { host } }, (res) => (res.resume(), ok(res.statusCode))).on("error", ko));
    expect(await hostGet(8895, "evil.example:8895")).to.equal(421);
    expect(await hostGet(8895, "localhost:8895")).to.equal(200);
    expect(await hostGet(8895, "127.0.0.1:8895")).to.equal(200);
    expect(await hostGet(8895, "[::1]:8895")).to.equal(200);
    await spawnServer("open", 8892, { HOST: "0.0.0.0" });
    expect(await hostGet(8892, "evil.example:8892")).to.equal(200);
  });

  it("H1: a batch whose tx is still pending is never resent, even after the wait times out; reconcile settles it once mined", async () => {
    await network.provider.send("evm_setAutomine", [false]);
    try {
      await spawnServer("h1", 8894, { FLUSH_SECONDS: "1", TX_TIMEOUT_MS: "1500" });
      base = "http://127.0.0.1:8894";
      ip = "10.6.0.1";
      const run = await signedArm(arm, ctx.bob);
      const ok = await post("/episodes", run);
      expect(ok.body.attest, JSON.stringify(ok.body)).to.equal(true);
      await sleep(8000); // several flush/reconcile rounds after the 1.5 s wait timed out
      const pendingTxs = async () => (await network.provider.send("eth_getBlockByNumber", ["pending", false])).transactions.length;
      expect(await pendingTxs()).to.equal(1);
      await network.provider.send("evm_setAutomine", [true]);
      await network.provider.send("evm_mine");
      let status;
      for (let i = 0; i < 15 && status !== "attested"; i++) {
        await sleep(1000);
        status = (await get(`/results/${ok.body.dataHash}`)).body?.status;
      }
      expect(status).to.equal("attested");
    } finally {
      base = "http://127.0.0.1:8895";
      await network.provider.send("evm_setAutomine", [true]);
    }
  });

  // ---------------------------------------------------------------- security review fixes
  const rawRequest = (port, text) =>
    new Promise((ok, ko) => {
      let data = "";
      const s = net.connect(port, "127.0.0.1", () => s.write(text));
      s.on("data", (d) => (data += d));
      s.on("close", () => ok(data));
      s.on("error", ko);
      setTimeout(() => (s.destroy(), ok(data)), 3000);
    });
  const onServer = async (name, port, extra, fn) => {
    const s = await spawnServer(name, port, extra);
    const keep = base;
    base = `http://127.0.0.1:${port}`;
    try {
      return await fn(s);
    } finally {
      base = keep;
      s.child.kill();
    }
  };
  const ethCalls = () => rpcStats.calls.filter((m) => m === "eth_call").length;

  it("a request line that does not parse (GET //[) is a 400, never a crash; garbage is closed; /health still answers", async () => {
    await onServer("rawline", 8891, {}, async () => {
      const reply = await rawRequest(8891, "GET //[ HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n");
      expect(reply).to.match(/^HTTP\/1\.1 400/);
      const junk = await rawRequest(8891, "\u0000\u0001 NOT HTTP AT ALL\r\n\r\n");
      expect(junk === "" || /^HTTP\/1\.1 400/.test(junk)).to.equal(true);
      expect((await fetch("http://127.0.0.1:8891/health")).status).to.equal(200);
    });
  });

  it("a corrupt, null or half-written results file does not stop startup: it is skipped and logged, the good record is served", async () => {
    const d = path.join(dataDir, "corrupt");
    fs.mkdirSync(path.join(d, "results"), { recursive: true });
    fs.writeFileSync(path.join(d, "results", "bad.json"), "{not json");
    fs.writeFileSync(path.join(d, "results", "null.json"), "null");
    fs.writeFileSync(path.join(d, "results", `${"cd".repeat(32)}.json.1234.tmp`), '{"half":'); // a write that never got renamed
    const dataHash = "0x" + "ab".repeat(32);
    fs.writeFileSync(path.join(d, "results", `${dataHash}.json`), JSON.stringify({ dataHash, trajectoryHash: dataHash, tokenId: 5, owner: ctx.bob.address, sim: "openforge-arm-sim@1", outcome: { success: true, seconds: 9 }, quality: 9000, attest: true, status: "attested", verifiedAt: Math.floor(Date.now() / 1000) }));
    await onServer("corrupt", 8886, {}, async (s) => {
      expect(s.log()).to.match(/skipped unreadable bad\.json/);
      expect(s.log()).to.match(/skipped unreadable null\.json/);
      expect(s.log()).to.not.match(/\.tmp/);
      expect((await fetch(`http://127.0.0.1:8886/results/${dataHash}`)).status).to.equal(200);
      expect((await (await fetch("http://127.0.0.1:8886/stats")).json()).verifiedRuns).to.equal(1);
    });
  });

  it("files are written atomically: after real runs the data directories hold only finished .json files", async () => {
    for (const sub of ["results", "episodes", "batches"]) {
      const files = fs.readdirSync(path.join(dataDir, "main", sub));
      expect(files.length, sub).to.be.gte(sub === "batches" ? 0 : 1);
      expect(files.filter((f) => !f.endsWith(".json")), sub).to.deep.equal([]);
    }
  });

  it("MAX_FEE_GWEI: above the ceiling nothing is sent and the run stays queued (not cacheable); under it, the run is attested and then cacheable", async () => {
    ip = "10.7.0.1";
    const before = (await ctx.rep.simStatsOf(arm)).map(Number);
    await onServer("fee-low", 8890, { MAX_FEE_GWEI: "0.0001", FLUSH_SECONDS: "1" }, async (s) => {
      const ok = await post("/episodes", await signedArm(arm, ctx.bob));
      expect(ok.body.attest, JSON.stringify(ok.body)).to.equal(true);
      await sleep(4000); // several flush rounds
      const rec = await get(`/results/${ok.body.dataHash}`);
      expect(rec.body.status).to.equal("queued");
      expect(rec.headers.get("cache-control")).to.equal("no-store"); // not settled: never cacheable
      expect(s.log()).to.match(/fee ceiling/);
      expect((await ctx.rep.simStatsOf(arm)).map(Number)).to.deep.equal(before);
    });
    await onServer("fee-high", 8890, { MAX_FEE_GWEI: "1000" }, async () => {
      const ok = await post("/episodes", await signedArm(arm, ctx.bob));
      expect(ok.body.attest).to.equal(true);
      expect((await post("/admin/flush", {}, { "x-admin-token": ADMIN })).body.pending).to.equal(0);
      const rec = await get(`/results/${ok.body.dataHash}`);
      expect(rec.body.status).to.equal("attested");
      expect(rec.headers.get("cache-control")).to.equal("public, max-age=30"); // settled
      const batch = await get(`/batches/${rec.body.batch}`);
      expect(batch.status).to.equal(200);
      expect(batch.headers.get("cache-control")).to.equal("public, max-age=30");
      expect((await ctx.rep.simStatsOf(arm)).map(Number)[0]).to.equal(before[0] + 1);
    });
  });

  it("REPLACE_AFTER_MIN: a batch still pending is re-sent at the same nonce with at least +12.5% on both fees, and attested exactly once", async () => {
    await network.provider.send("evm_setAutomine", [false]);
    try {
      ip = "10.8.0.1";
      const before = (await ctx.rep.simStatsOf(arm)).map(Number);
      await onServer("replace", 8889, { FLUSH_SECONDS: "1", TX_TIMEOUT_MS: "1200", REPLACE_AFTER_MIN: "0.1", MAX_FEE_GWEI: "1000" }, async () => {
        const ok = await post("/episodes", await signedArm(arm, ctx.bob));
        expect(ok.body.attest).to.equal(true);
        const rec = async () => (await get(`/results/${ok.body.dataHash}`)).body;
        let first;
        for (let i = 0; i < 30 && !first; i++) {
          await sleep(300);
          const r = await rec();
          if (r.status === "sent") first = r.tx;
        }
        expect(first, "the batch was never sent").to.be.a("string");
        const tx1 = await network.provider.send("eth_getTransactionByHash", [first]);
        let second;
        for (let i = 0; i < 40 && !second; i++) {
          await sleep(500);
          const r = await rec();
          if (r.tx !== first) second = r.tx;
        }
        expect(second, "the stuck batch was never replaced").to.be.a("string");
        const tx2 = await network.provider.send("eth_getTransactionByHash", [second]);
        expect(BigInt(tx2.nonce)).to.equal(BigInt(tx1.nonce));
        expect(BigInt(tx2.maxFeePerGas) * 1000n).to.be.gte(BigInt(tx1.maxFeePerGas) * 1125n);
        expect(BigInt(tx2.maxPriorityFeePerGas) * 1000n).to.be.gte(BigInt(tx1.maxPriorityFeePerGas) * 1125n);
        expect(BigInt(tx2.maxFeePerGas)).to.be.lte(1000n * 10n ** 9n);
        const pendingTxs = (await network.provider.send("eth_getBlockByNumber", ["pending", false])).transactions;
        expect(pendingTxs).to.deep.equal([second]); // the old one is gone, there is no second batch behind it
        await network.provider.send("evm_setAutomine", [true]);
        await network.provider.send("evm_mine");
        let status;
        for (let i = 0; i < 15 && status !== "attested"; i++) {
          await sleep(1000);
          status = (await rec()).status;
        }
        expect(status).to.equal("attested");
        expect((await ctx.rep.simStatsOf(arm)).map(Number)[0]).to.equal(before[0] + 1); // exactly once
      });
    } finally {
      await network.provider.send("evm_setAutomine", [true]);
    }
  });

  it("a pending batch that one flaky RPC answer cannot find is not requeued or resent at a new nonce", async () => {
    await network.provider.send("evm_setAutomine", [false]);
    try {
      ip = "10.8.1.1";
      await onServer("blind", 8887, { FLUSH_SECONDS: "1", TX_TIMEOUT_MS: "800", REPLACE_AFTER_MIN: "600" }, async () => {
        const ok = await post("/episodes", await signedArm(arm, ctx.bob));
        expect(ok.body.attest).to.equal(true);
        const rec = async () => (await get(`/results/${ok.body.dataHash}`)).body;
        let first;
        for (let i = 0; i < 30 && !first; i++) {
          await sleep(300);
          const r = await rec();
          if (r.status === "sent") first = r.tx;
        }
        expect(first, "the batch was never sent").to.be.a("string");
        expect((await rec()).nonce).to.be.a("number");
        rpcStats.blindTx = 1; // exactly one reconcile round fails to see the transaction
        await sleep(4500);
        expect(rpcStats.blindTx).to.equal(0);
        expect((await rec()).status).to.equal("sent");
        expect((await rec()).tx).to.equal(first);
        const pendingTxs = (await network.provider.send("eth_getBlockByNumber", ["pending", false])).transactions;
        expect(pendingTxs).to.deep.equal([first]); // no second batch behind it
        await network.provider.send("evm_setAutomine", [true]);
        await network.provider.send("evm_mine");
        let status;
        for (let i = 0; i < 15 && status !== "attested"; i++) {
          await sleep(1000);
          status = (await rec()).status;
        }
        expect(status).to.equal("attested");
      });
    } finally {
      rpcStats.blindTx = 0;
      await network.provider.send("evm_setAutomine", [true]);
    }
  });

  it("ownerOf and class answers are reused: a second identical challenge makes no eth_call, for an Energy Cell and a lab mission alike", async () => {
    ip = "10.9.0.1";
    await onServer("cache", 8888, {}, async () => {
      const arm1 = `/challenge?tokenId=${arm}&owner=${ctx.bob.address}`;
      const robot = "so101";
      const lab1 = `/lab/challenge?tokenId=${arm}&owner=${ctx.bob.address}&robot=${robot}&level=${lab.MISSIONS[robot].levels[0].id}`;
      const wrong = `/challenge?tokenId=${arm}&owner=${ctx.carol.address}`;
      expect((await get(arm1)).status).to.equal(200);
      const afterFirst = ethCalls();
      expect(afterFirst).to.be.gte(2); // ownerOf and traitsOf were really asked once
      for (const q of [arm1, arm1, lab1, lab1, wrong]) await get(q);
      expect((await get(wrong)).status).to.equal(403); // still judged against the cached owner
      expect(ethCalls()).to.equal(afterFirst);
      expect((await get(`/challenge?tokenId=${arm === 1 ? 2 : 1}&owner=${ctx.bob.address}`)).status).to.be.oneOf([200, 403]);
      expect(ethCalls()).to.be.gt(afterFirst); // another token is a new question
    });
  });

  it("rate limits also count the wider network: rotating /64s inside one /48, or hosts inside one /24, cannot reset a budget", async () => {
    const adminTry = (xff) => post("/admin/flush", {}, { "x-admin-token": "wrong", "x-forwarded-for": xff }).then((r) => r.status);
    // 30 per /64 per hour means 240 per /48 / per /24: one request from each of 240 networks passes, the 241st does not
    for (let i = 0; i < 240; i++) expect(await adminTry(`2001:db8:48:${i.toString(16)}::1`), `v6 ${i}`).to.equal(401);
    expect(await adminTry("2001:db8:48:ffff::1")).to.equal(429);
    expect(await adminTry("2001:db8:49::1")).to.equal(401); // another /48 is unaffected
    for (let i = 0; i < 240; i++) expect(await adminTry(`10.77.5.${(i % 250) + 1}`), `v4 ${i}`).to.equal(401);
    expect(await adminTry("10.77.5.251")).to.equal(429);
    expect(await adminTry("10.77.6.1")).to.equal(401);
  });

  it("security counters live in their own table: churning the network table does not forgive wrong signatures", async () => {
    await onServer("churn", 8887, { MAX_HITS: "50" }, async () => {
      ip = "10.12.0.1";
      const tokenId = arm === 3 ? 4 : 3;
      const robot = "ax1-rover";
      const level = lab.MISSIONS[robot].levels[0].id;
      const run = await signedLab(tokenId, ctx.bob, robot, level);
      const td = sim.runTypedData({ chainId: 31337, verifyingContract: deployed.reputation, tokenId, challengeId: run.ch.challengeId, episodeHash: ethers.keccak256(ethers.toUtf8Bytes(sim.canonicalize(run.episode))), deadline: run.deadline, mission: lab.labMission(robot, level), sim: lab.LAB_SIM_ID });
      const forged = await ctx.carol.signTypedData(td.domain, td.types, td.value);
      const bad = () => post("/lab/episodes", { episode: run.episode, signature: forged, deadline: run.deadline }).then((r) => r.status);
      for (let i = 0; i < 20; i++) expect(await bad(), `bad ${i}`).to.equal(401);
      expect(await bad()).to.equal(429);
      for (let i = 0; i < 120; i++) await get("/batches/x", { "x-forwarded-for": `${100 + (i % 100)}.${i}.1.1` }); // 240 network keys through a 50-key table
      expect(await bad(), "the hourly budget survived the churn").to.equal(429);
      expect(await bad(), "still spent after the right one is looked at").to.equal(429);
      expect((await post("/lab/episodes", { episode: run.episode, signature: run.signature, deadline: run.deadline })).status, "the owner is never locked out").to.equal(200);
    });
  });

  it("deeply nested JSON under a canonical key is a 400 on every submit route (never a 500), and the process survives", async () => {
    ip = "10.11.0.1";
    const deep = "[".repeat(50_000) + "]".repeat(50_000); // 100 KB: under the arm body limit, far past what a recursive walk survives
    const send = (route, episode, extra = {}) =>
      fetch(base + route, { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": ip }, body: JSON.stringify({ episode: { ...episode, seed: "@@DEEP@@" }, signature: "0x00", deadline: Math.floor(Date.now() / 1000) + 600, ...extra }).replace('"@@DEEP@@"', deep) }).then((r) => r.status);
    const bob = ctx.bob.address;
    const a = (await get(`/challenge?tokenId=${arm}&owner=${bob}`)).body;
    expect(await send("/episodes", sim.buildEpisode({ tokenId: arm, challengeId: a.challengeId, seed: a.seed, actions: sim.autopilot(a.seed) }))).to.equal(400);
    const robot = "ax1-rover";
    const level = lab.MISSIONS[robot].levels[0].id;
    const l = (await get(`/lab/challenge?tokenId=${arm}&owner=${bob}&robot=${robot}&level=${level}`)).body;
    expect(await send("/lab/episodes", lab.buildLabEpisode({ tokenId: arm, challengeId: l.challengeId, robot, level, seed: l.seed, actions: lab.MISSIONS[robot].solve(level, l.seed) }))).to.equal(400);
    const t = (await get(`/trial/challenge?wallet=${bob}`)).body;
    expect(await send("/trial/episodes", sim.buildEpisode({ tokenId: 0, challengeId: t.challengeId, seed: t.seed, actions: sim.autopilot(t.seed) }))).to.equal(400);
    expect((await get("/health")).status).to.equal(200);
  });

  it("body limits: Energy Cell and pilot runs stop at 256 KB (413), lab traces keep 1 MB; a real run is far below", async () => {
    ip = "10.12.0.1";
    const pad = "x".repeat(300_000); // 300 KB: over the arm limit, under the lab one
    const status = (route) => fetch(base + route, { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": ip }, body: JSON.stringify({ episode: { pad }, signature: "0x00", deadline: 1 }) }).then((r) => r.status, () => 413); // the server may close the socket while the client still uploads: the same refusal
    expect(await status("/episodes")).to.equal(413);
    expect(await status("/trial/episodes")).to.equal(413);
    expect(await status("/lab/episodes")).to.equal(400); // read in full, then refused as a bad deadline
    const real = JSON.stringify({ episode: sim.buildEpisode({ tokenId: arm, challengeId: "0x" + "a".repeat(64), seed: "0x" + "b".repeat(64), actions: sim.autopilot("0x" + "b".repeat(64)) }), signature: "0x" + "c".repeat(130), deadline: 1e9 });
    expect(real.length).to.be.below(256 * 1024 / 2);
  });

  it("rankings are served pre-serialized and cacheable for 30 s (stale-while-revalidate 60)", async () => {
    ip = "10.13.0.1";
    const robot = "ax1-rover";
    const level = lab.MISSIONS[robot].levels[0].id;
    for (const p of ["/leaderboard", `/lab/leaderboard?robot=${robot}&level=${level}`, "/trial/leaderboard"]) {
      const r = await get(p);
      expect(r.status, p).to.equal(200);
      expect(r.headers.get("cache-control"), p).to.equal("public, max-age=30, stale-while-revalidate=60");
      expect(r.headers.get("x-content-type-options"), p).to.equal("nosniff");
      expect(r.headers.get("access-control-allow-origin"), p).to.equal("http://site.test");
      expect(r.body, p).to.be.an("object");
    }
    expect((await get("/lab/leaderboard?robot=nope&level=x")).headers.get("cache-control")).to.equal("no-store"); // errors are never cached
  });

  it("a 500 is logged without the RPC URL or its key", async () => {
    const dep2 = path.join(dataDir, "secret-rpc.json");
    fs.writeFileSync(dep2, JSON.stringify({ ...deployed, rpcUrl: `${deployed.rpcUrl}/v2/SECRETKEY0123456789?apikey=QUERYSECRET99` }));
    const s = await startServer({ DEPLOYMENT_FILE: dep2, DATA_DIR: path.join(dataDir, "redact"), ALLOWED_ORIGIN: "http://site.test", TRUST_PROXY: "true", FLUSH_SECONDS: "3600", ADMIN_TOKEN: ADMIN }, 8885);
    servers.push(s);
    const keep = base;
    base = "http://127.0.0.1:8885";
    try {
      ip = "10.14.0.1";
      const run = await signedArm(arm, ctx.bob);
      rpcStats.down = true; // the owner is asked fresh when a run is verified: the chain is "down"
      let res;
      try {
        res = await post("/episodes", run);
      } finally {
        rpcStats.down = false;
      }
      expect(res.status).to.equal(500);
      await sleep(300);
      expect(s.log()).to.match(/server error:/);
      expect(s.log()).to.not.match(/SECRETKEY0123456789|QUERYSECRET99/);
      expect(s.log()).to.not.match(/127\.0\.0\.1:\d+\/v2/);
    } finally {
      base = keep;
      s.child.kill();
    }
  });
});
