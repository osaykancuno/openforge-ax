// Security regressions of scripts/proving-server.mjs (audit fixes), against the in-process Hardhat chain.
// X-Forwarded-For (TRUST_PROXY) gives every test its own client address, so rate limits never leak between tests.
const { expect } = require("chai");
const { ethers, network } = require("hardhat");
const { spawn } = require("child_process");
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { deployAll, reveal } = require("./helpers");

const ROOT = path.join(__dirname, "..");
const ADMIN = "hardening-admin-token-0123456789abcdef";

function rpcProxy() {
  const server = http.createServer(async (req, res) => {
    let body = "";
    for await (const c of req) body += c;
    const one = async ({ id, method, params }) => {
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
    expect((await post("/lab/episodes", { episode: run.episode, signature: run.signature, deadline: run.deadline })).status).to.equal(429); // even the right one, for the hour
    // never retired: the same open mission is still served
    expect((await get(`/lab/challenge?tokenId=${tokenId}&owner=${ctx.bob.address}&robot=${robot}&level=${level}`)).body.challengeId).to.equal(run.ch.challengeId);
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
});
