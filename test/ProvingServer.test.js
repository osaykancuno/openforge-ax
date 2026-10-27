// End-to-end tests of scripts/proving-server.mjs: the real server process, against the in-process Hardhat chain
// (exposed over HTTP by a tiny JSON-RPC proxy), with real EIP-712 signatures and on-chain batch attestation.
const { expect } = require("chai");
const { ethers, network } = require("hardhat");
const { spawn } = require("child_process");
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { deployAll, reveal } = require("./helpers");

const ROOT = path.join(__dirname, "..");
const ADMIN = "test-admin-token-0123456789abcdef-xyz"; // the server requires >= 32 characters

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

describe("Proving Grounds verifier (server process)", function () {
  this.timeout(120_000);
  let ctx, proxy, srv, base, dataDir, depFile, arm, other, sim, lab;
  const get = (p, headers) => fetch(base + p, { headers }).then(async (r) => ({ status: r.status, headers: r.headers, body: await r.json().catch(() => null) }));
  const post = (p, body, headers = {}) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));

  before(async () => {
    sim = {
      ...(await import("../web/js/sim/autopilot.js")),
      ...(await import("../web/js/sim/episode.js")),
      ...(await import("../web/js/sim/arm-sim.js")),
    };
    lab = { ...(await import("../web/js/sim/lab-episode.js")), ...(await import("../web/js/bench/missions/index.js")) };
    ctx = await deployAll({ maxSupply: 40, reserve: 40 });
    await ctx.agents.reserveMint(ctx.bob.address, 40);
    await reveal(ctx.agents);
    const classes = await Promise.all(Array.from({ length: 40 }, (_, i) => ctx.renderer.traitsOf(i + 1).then((t) => Number(t.class_))));
    arm = classes.indexOf(0) + 1; // Synth Arm
    other = classes.findIndex((c) => c !== 0) + 1;
    expect(arm).to.be.gt(0);
    await ctx.rep.setSimAttester(ctx.alice.address, true); // Hardhat dev key #2: the verifier's local attester
    proxy = await rpcProxy();
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "proving-"));
    depFile = path.join(dataDir, "deployment.json");
    fs.writeFileSync(depFile, JSON.stringify({ chainId: 31337, rpcUrl: `http://127.0.0.1:${proxy.address().port}`, agents: await ctx.agents.getAddress(), renderer: await ctx.renderer.getAddress(), reputation: await ctx.rep.getAddress() }));
    srv = await startServer({ DEPLOYMENT_FILE: depFile, DATA_DIR: path.join(dataDir, "data"), FLUSH_SECONDS: "3600", ADMIN_TOKEN: ADMIN, ALLOWED_ORIGIN: "http://site.test" }, 8897);
    base = "http://127.0.0.1:8897";
  });

  after(() => {
    srv?.child.kill();
    proxy?.close();
  });

  async function signedRun(tokenId, signer, { wait = true } = {}) {
    const ch = (await get(`/challenge?tokenId=${tokenId}&owner=${await signer.getAddress()}`)).body;
    const actions = sim.autopilot(ch.seed);
    if (wait) await new Promise((r) => setTimeout(r, (actions.length / sim.FPS) * 1000 + 300));
    const episode = sim.buildEpisode({ tokenId, challengeId: ch.challengeId, seed: ch.seed, actions });
    const episodeHash = ethers.keccak256(ethers.toUtf8Bytes(sim.canonicalize(episode)));
    const deadline = Math.floor(Date.now() / 1000) + 600;
    const td = sim.runTypedData({ chainId: 31337, verifyingContract: await ctx.rep.getAddress(), tokenId, challengeId: ch.challengeId, episodeHash, deadline });
    return { episode, deadline, td, signature: await signer.signTypedData(td.domain, td.types, td.value) };
  }

  it("health and CORS: the configured origin only, with Private Network Access", async () => {
    const r = await get("/health");
    expect(r.status).to.equal(200);
    expect(r.body).to.include({ ok: true, chainId: 31337, attesting: true });
    expect(r.headers.get("access-control-allow-origin")).to.equal("http://site.test");
    expect(r.headers.get("access-control-allow-private-network")).to.equal("true");
    expect(srv.log()).to.not.include(ADMIN); // a configured token is never printed
  });

  it("challenges: validates input, ownership and class", async () => {
    const bob = ctx.bob.address;
    expect((await get(`/challenge?tokenId=${arm}&owner=nope`)).status).to.equal(400);
    expect((await get(`/challenge?tokenId=0&owner=${bob}`)).status).to.equal(400);
    expect((await get(`/challenge?tokenId=${arm}&owner=${ctx.carol.address}`)).status).to.equal(403);
    if (other) expect((await get(`/challenge?tokenId=${other}&owner=${bob}`)).status).to.equal(403);
    const ok = await get(`/challenge?tokenId=${arm}&owner=${bob}`);
    expect(ok.status).to.equal(200);
    expect(ok.body.challengeId).to.match(/^0x[0-9a-f]{64}$/);
  });

  it("a stranger cannot burn a holder's mission quota by requesting challenges", async () => {
    for (let i = 0; i < 35; i++) expect((await get(`/challenge?tokenId=${arm}&owner=${ctx.bob.address}`)).status).to.equal(200);
  });

  it("rejects bad runs without burning the mission: too fast, wrong signer; then accepts the real one once", async () => {
    const fast = await signedRun(arm, ctx.bob, { wait: false });
    expect((await post("/episodes", { episode: fast.episode, signature: fast.signature, deadline: fast.deadline })).body.error).to.match(/faster than real time/);

    const run = await signedRun(arm, ctx.bob);
    const forged = await ctx.carol.signTypedData(run.td.domain, run.td.types, run.td.value);
    expect((await post("/episodes", { episode: run.episode, signature: forged, deadline: run.deadline })).status).to.equal(401);
    const tampered = { ...run.episode, actions: run.episode.actions.slice(0, -1) };
    expect((await post("/episodes", { episode: tampered, signature: run.signature, deadline: run.deadline })).status).to.equal(401); // the signature no longer covers it

    const ok = await post("/episodes", { episode: run.episode, signature: run.signature, deadline: run.deadline });
    expect(ok.status).to.equal(200);
    expect(ok.body).to.include({ attest: true });
    expect(ok.body.outcome.success).to.equal(true);
    expect((await post("/episodes", { episode: run.episode, signature: run.signature, deadline: run.deadline })).body.error).to.match(/unknown or used challenge/);

    const stored = await get(`/episodes/${ok.body.dataHash}`);
    expect(stored.status).to.equal(200);
    expect((await get("/episodes/..%2F..%2Fpackage.json")).status).to.be.oneOf([400, 404]);
    expect((await get("/leaderboard")).body.top.map((t) => t.tokenId)).to.include(arm);
  });

  it("rejects malformed bodies and deadlines", async () => {
    expect((await post("/episodes", { episode: {}, signature: 1, deadline: "x" })).status).to.equal(400);
    const run = await signedRun(arm, ctx.bob, { wait: false });
    expect((await post("/episodes", { episode: run.episode, signature: run.signature, deadline: 1 })).body.error).to.equal("bad deadline");
    const r = await fetch(base + "/episodes", { method: "POST", headers: { "content-type": "application/json" }, body: "{not json" });
    expect(r.status).to.equal(400);
  });

  it("admin flush needs the exact token, then the batch lands on-chain and shows in the metadata", async () => {
    expect((await post("/admin/flush", {}, { "x-admin-token": "wrong" })).status).to.equal(401);
    expect((await post("/admin/flush", {})).status).to.equal(401);
    const r = await post("/admin/flush", {}, { "x-admin-token": ADMIN });
    expect(r.status).to.equal(200);
    expect(r.body.pending).to.equal(0);
    expect((await ctx.rep.simStatsOf(arm)).map(Number)).to.deep.equal([1, 1]);
  });

  // ---------------------------------------------------------------- lab trials (every Workbench robot)
  async function signedLab(tokenId, signer, robot, level, { actions: given, wait = true, mission } = {}) {
    const ch = (await get(`/lab/challenge?tokenId=${tokenId}&owner=${await signer.getAddress()}&robot=${robot}&level=${level}`)).body;
    const m = lab.MISSIONS[robot];
    const actions = given ?? m.solve(level, ch.seed);
    if (wait) await new Promise((r) => setTimeout(r, actions.length * m.dt * 1000 + 300));
    const episode = lab.buildLabEpisode({ tokenId, challengeId: ch.challengeId, robot, level, seed: ch.seed, actions });
    const episodeHash = ethers.keccak256(ethers.toUtf8Bytes(sim.canonicalize(episode)));
    const deadline = Math.floor(Date.now() / 1000) + 600;
    const td = sim.runTypedData({ chainId: 31337, verifyingContract: await ctx.rep.getAddress(), tokenId, challengeId: ch.challengeId, episodeHash, deadline, mission: mission ?? lab.labMission(robot, level), sim: lab.LAB_SIM_ID });
    return { ch, episode, deadline, td, signature: await signer.signTypedData(td.domain, td.types, td.value) };
  }
  /** The quickest scripted pass this agent's class may fly (keeps the real-time wait short). */
  async function quickestLab(tokenId) {
    const cls = Number((await ctx.renderer.traitsOf(tokenId)).class_);
    let best = null;
    for (const robot of lab.robotsForClass(cls))
      for (const lv of lab.MISSIONS[robot].levels) {
        const n = lab.MISSIONS[robot].solve(lv.id, 1).length;
        if (!best || n < best.n) best = { robot, level: lv.id, n };
      }
    return best;
  }

  it("lab challenges: every robot, but only the agent's own class robot or an AX-1 body", async () => {
    const bob = ctx.bob.address;
    expect((await get(`/lab/challenge?tokenId=${arm}&owner=${bob}&robot=nope&level=reach`)).status).to.equal(400);
    expect((await get(`/lab/challenge?tokenId=${arm}&owner=${bob}&robot=so101&level=nope`)).status).to.equal(400);
    expect((await get(`/lab/challenge?tokenId=${arm}&owner=${ctx.carol.address}&robot=so101&level=reach`)).status).to.equal(403);
    expect((await get(`/lab/challenge?tokenId=${arm}&owner=${bob}&robot=hound&level=stand`)).status).to.equal(403); // a Synth Arm is not a Cyber Hound
    for (const robot of ["so101", "ax1-rover", "ax1-desk", "ax1-walker"]) {
      const lv = lab.MISSIONS[robot].levels[0].id;
      const r = await get(`/lab/challenge?tokenId=${arm}&owner=${bob}&robot=${robot}&level=${lv}`);
      expect(r.status, robot).to.equal(200);
      expect(r.body).to.include({ robot, level: lv, sim: lab.LAB_SIM_ID, mission: `lab/${robot}/${lv}` });
      expect(r.body.seed).to.be.a("number");
    }
  });

  it("lab runs: verified by replay, signed by the owner, passes attested on-chain and ranked", async () => {
    const q = await quickestLab(other || arm);
    const tokenId = other || arm;
    const before = (await ctx.rep.simStatsOf(tokenId)).map(Number);

    // asking again does not reroll the layout
    const q1 = `/lab/challenge?tokenId=${tokenId}&owner=${ctx.bob.address}&robot=${q.robot}&level=${q.level}`;
    const c1 = (await get(q1)).body, c2 = (await get(q1)).body;
    expect(c2).to.include({ challengeId: c1.challengeId, seed: c1.seed });

    const fast = await signedLab(tokenId, ctx.bob, q.robot, q.level, { wait: false });
    expect((await post("/lab/episodes", fast)).body.error).to.match(/faster than real time/);

    const run = await signedLab(tokenId, ctx.bob, q.robot, q.level);
    // a lab challenge is not an Energy Cell challenge, and a signature over another mission does not count
    expect((await post("/episodes", run)).body.error).to.match(/unknown or used challenge/);
    const wrongMission = await ctx.bob.signTypedData(run.td.domain, run.td.types, { ...run.td.value, mission: "pick-place-cell" });
    const wm = await post("/lab/episodes", { ...run, signature: wrongMission });
    expect(wm.status, JSON.stringify(wm.body)).to.equal(401);
    const shorter = { ...run.episode, actions: run.episode.actions.slice(0, -1) };
    expect((await post("/lab/episodes", { ...run, episode: shorter })).status).to.equal(401); // the signature no longer covers it
    // padding cannot make the same moves look new: unknown fields and actions after the end are refused
    const junk = { ...run.episode, actions: run.episode.actions.map((x) => (Array.isArray(x) ? [...x, 0] : { ...x, junk: 1 })) };
    expect((await post("/lab/episodes", { ...run, episode: junk })).body.error).to.match(/invalid run/);
    const padded = { ...run.episode, actions: [...run.episode.actions, run.episode.actions.at(-1)] };
    // the signature is checked before any simulation: an unsigned padded run is a 401, only a signed one reaches stepsUsed
    expect((await post("/lab/episodes", { ...run, episode: padded })).status).to.equal(401);
    const paddedHash = ethers.keccak256(ethers.toUtf8Bytes(sim.canonicalize(padded)));
    const paddedTd = sim.runTypedData({ chainId: 31337, verifyingContract: await ctx.rep.getAddress(), tokenId, challengeId: run.ch.challengeId, episodeHash: paddedHash, deadline: run.deadline, mission: lab.labMission(q.robot, q.level), sim: lab.LAB_SIM_ID });
    const paddedSig = await ctx.bob.signTypedData(paddedTd.domain, paddedTd.types, paddedTd.value);
    expect((await post("/lab/episodes", { ...run, episode: padded, signature: paddedSig })).body.error).to.match(/after the run ended/);
    expect((await post("/lab/episodes", { ...run, episode: { ...run.episode, extra: { deep: 1 } } })).body.error).to.match(/does not match/);

    const ok = await post("/lab/episodes", run);
    expect(ok.status).to.equal(200);
    expect(ok.body.outcome.success).to.equal(true);
    expect(ok.body.attest).to.equal(true);
    expect(ok.body.quality).to.equal(ok.body.outcome.score * 100);
    expect((await post("/lab/episodes", run)).body.error).to.match(/unknown or used challenge/);
    expect((await get(`/lab/leaderboard?robot=${q.robot}&level=${q.level}`)).body.top.map((t) => t.tokenId)).to.include(tokenId);
    expect((await get("/leaderboard")).body.top.map((t) => t.tokenId)).to.not.include(other || -1); // the arm ranking stays arm-only

    // a run that does nothing is stored (it is data) but never attested
    const lv = lab.MISSIONS[q.robot].levels.find((l) => l.id === q.level);
    const idle = await signedLab(tokenId, ctx.bob, q.robot, q.level, { actions: Array.from({ length: 30 }, () => lab.MISSIONS[q.robot].idle(lab.MISSIONS[q.robot].init(lv.id, 1))) });
    const stored = await post("/lab/episodes", idle);
    expect(stored.status).to.equal(200);
    expect(stored.body).to.include({ attest: false, episodeUrl: null }); // fails are not kept on disk

    expect((await post("/admin/flush", {}, { "x-admin-token": ADMIN })).body.pending).to.equal(0);
    const after = (await ctx.rep.simStatsOf(tokenId)).map(Number);
    expect(after[0]).to.equal(before[0] + 1);
  });

  async function signedTrial(wallet, { sign = "trial" } = {}) {
    const ch = (await get(`/trial/challenge?wallet=${wallet.address}`)).body;
    const actions = sim.autopilot(ch.seed);
    await new Promise((r) => setTimeout(r, (actions.length / sim.FPS) * 1000 + 300));
    const episode = sim.buildEpisode({ tokenId: 0, challengeId: ch.challengeId, seed: ch.seed, actions });
    const episodeHash = ethers.keccak256(ethers.toUtf8Bytes(sim.canonicalize(episode)));
    const deadline = Math.floor(Date.now() / 1000) + 600;
    const td = sign === "trial"
      ? sim.trialTypedData({ chainId: 31337, wallet: wallet.address, challengeId: ch.challengeId, episodeHash, deadline })
      : sim.runTypedData({ chainId: 31337, verifyingContract: await ctx.rep.getAddress(), tokenId: 0, challengeId: ch.challengeId, episodeHash, deadline });
    return { episode, deadline, signature: await wallet.signTypedData(td.domain, td.types, td.value) };
  }

  it("pilot trials: any wallet, verified by replay, ranked; signatures are not interchangeable with agent runs", async () => {
    const guest = ethers.Wallet.createRandom();
    expect((await get("/trial/challenge?wallet=nope")).status).to.equal(400);
    const runSigned = await signedTrial(guest, { sign: "run" }); // an agent-run signature over a trial
    expect((await post("/trial/episodes", runSigned)).status).to.equal(401);
    const ok = await signedTrial(guest);
    expect((await post("/episodes", ok)).body.error).to.match(/unknown or used challenge/); // trial challenges never reach agent runs
    const r = await post("/trial/episodes", ok);
    expect(r.status, JSON.stringify(r.body)).to.equal(200);
    expect(r.body).to.include({ best: true, successes: 1, eligible: false });
    expect((await post("/trial/episodes", ok)).body.error).to.match(/unknown or used challenge/);
    const board = (await get("/trial/leaderboard")).body;
    const row = board.top.find((t) => t.wallet === guest.address);
    expect(row).to.include({ successes: 1, eligible: false, score: null }); // the score needs 3 docked runs
    expect(board.rule).to.match(/3\+ docked runs on 2\+ days/);
    expect((await get(`/trial/episodes/${row.bestRun}`)).status).to.equal(200); // best runs stay auditable
    const stats = await get("/stats");
    expect(stats.headers.get("cache-control")).to.match(/max-age=60/);
    expect(stats.body.trialPilots).to.be.gte(1);
  });

  it("trial abuse limits: open missions are recycled, not locked; 3 bad signatures retire a mission", async () => {
    const w = ethers.Wallet.createRandom();
    for (let i = 0; i < 7; i++) expect((await get(`/trial/challenge?wallet=${w.address}`)).status).to.equal(200); // the oldest is recycled
    const ch = (await get(`/trial/challenge?wallet=${w.address}`)).body;
    const episode = sim.buildEpisode({ tokenId: 0, challengeId: ch.challengeId, seed: ch.seed, actions: sim.autopilot(ch.seed).slice(0, 3) }); // valid moves, so the signature is what fails
    const bad = { episode, signature: "0x" + "11".repeat(65), deadline: Math.floor(Date.now() / 1000) + 600 };
    await new Promise((r) => setTimeout(r, 1200)); // the real-time check counts whole seconds
    for (let i = 0; i < 3; i++) expect((await post("/trial/episodes", bad)).status).to.equal(401);
    expect((await post("/trial/episodes", bad)).body.error).to.match(/unknown or used challenge/);
  });

  it("trials-only mode before the collection is deployed", async () => {
    const pre = path.join(dataDir, "predeploy.json");
    fs.writeFileSync(pre, JSON.stringify({ chainId: 31337, rpcUrl: JSON.parse(fs.readFileSync(depFile, "utf8")).rpcUrl }));
    const s2 = await startServer({ DEPLOYMENT_FILE: pre, DATA_DIR: path.join(dataDir, "pre"), ALLOWED_ORIGIN: "http://site.test" }, 8899);
    try {
      const h = await (await fetch("http://127.0.0.1:8899/health")).json();
      expect(h).to.include({ trialsOnly: true, attesting: false });
      expect(s2.log()).to.match(/trials-only mode/);
      const c = await fetch(`http://127.0.0.1:8899/challenge?tokenId=1&owner=${ctx.bob.address}`);
      expect(c.status).to.equal(404);
      expect((await fetch(`http://127.0.0.1:8899/trial/challenge?wallet=${ctx.bob.address}`)).status).to.equal(200);
    } finally {
      s2.child.kill();
    }
  });

  it("refuses to start outside the local chain without an allowed origin", async () => {
    const dep1 = path.join(dataDir, "mainnet.json");
    fs.writeFileSync(dep1, JSON.stringify({ ...JSON.parse(fs.readFileSync(depFile, "utf8")), chainId: 1 }));
    const err = await startServer({ DEPLOYMENT_FILE: dep1, DATA_DIR: path.join(dataDir, "d1"), ALLOWED_ORIGIN: "" }, 8898).then(() => null, (e) => e);
    expect(err?.message).to.match(/ALLOWED_ORIGIN is required/);
  });
});
