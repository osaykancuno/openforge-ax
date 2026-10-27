// Pilot trials (scripts/lib/trials.mjs) called in-process: caps on open missions, best-run file hygiene, strict fields.
const { expect } = require("chai");
const { ethers } = require("hardhat");
const fs = require("fs");
const os = require("os");
const path = require("path");

describe("Pilot trials hardening (in-process)", function () {
  this.timeout(120_000);
  let sim, createTrials, dir, realNow, offset;
  const nowSec = () => Math.floor(realNow() / 1000);

  before(async () => {
    sim = { ...(await import("../web/js/sim/autopilot.js")), ...(await import("../web/js/sim/episode.js")), ...(await import("../web/js/sim/arm-sim.js")) };
    ({ createTrials } = await import("../scripts/lib/trials.mjs"));
    realNow = Date.now;
    offset = 0;
    Date.now = () => realNow() + offset; // lets a test skip the real-time wait
  });
  after(() => {
    Date.now = realNow;
  });
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "trials-"));
  });

  const make = (extra = {}) => createTrials({ dataDir: dir, chainId: 31337, verifySignature: async () => true, rateLimited: () => false, now: nowSec, ...extra });
  const body = (wallet, ch, actions, tweak = {}) => ({
    episode: { ...sim.buildEpisode({ tokenId: 0, challengeId: ch.challengeId, seed: ch.seed, actions }), ...tweak },
    signature: "0x00",
    deadline: nowSec() + 600,
  });
  const isOpen = async (t, id) => (await t.submit({ episode: { challengeId: id }, signature: "x", deadline: nowSec() + 60 }))[1].error !== "unknown or used challenge";

  it("caps open missions per network: the oldest is dropped, never a refusal", async () => {
    const t = make();
    const ids = [];
    // 5 wallets x 5 missions from one /24 (different hosts): the per-wallet cap alone would allow all 25
    for (let w = 0; w < 5; w++) {
      const wallet = ethers.Wallet.createRandom().address;
      for (let i = 0; i < 5; i++) {
        const [code, ch] = t.challenge(`10.7.7.${w + 1}`, wallet);
        expect(code).to.equal(200);
        ids.push(ch.challengeId);
      }
    }
    expect(await isOpen(t, ids[0])).to.equal(false); // dropped
    expect(await isOpen(t, ids.at(-1))).to.equal(true);
    // another /24 is not affected
    const [code, other] = t.challenge("10.8.8.1", ethers.Wallet.createRandom().address);
    expect(code).to.equal(200);
    expect(await isOpen(t, ids[10])).to.equal(true);
    expect(await isOpen(t, other.challengeId)).to.equal(true);
  });

  it("an IPv6 client rotating inside its /64 shares one network cap", async () => {
    const t = make();
    const ids = [];
    for (let w = 0; w < 5; w++) {
      const wallet = ethers.Wallet.createRandom().address;
      for (let i = 0; i < 5; i++) ids.push(t.challenge(`2001:db8:1:2:${w}::${i + 1}`, wallet)[1].challengeId);
    }
    expect(await isOpen(t, ids[0])).to.equal(false);
  });

  it("when the total of open missions is full the oldest goes, instead of a 503", async () => {
    const t = make({ newWalletsPerHour: 1e9 }); // this test is about the open-missions cap, not the new-wallet ceiling
    let first;
    for (let i = 0; i < 5001; i++) {
      const [code, ch] = t.challenge(`${(i >> 16) + 20}.${(i >> 8) & 255}.${i & 255}.1`, ethers.getAddress(ethers.hexlify(ethers.randomBytes(20))));
      expect(code, `challenge ${i}`).to.equal(200);
      first ??= ch.challengeId;
    }
    expect(await isOpen(t, first)).to.equal(false);
  });

  it("one replay gives steps and score: byte-identical to stepsUsed + scoreLabRun for every robot and level (solved, truncated, padded, idle, junk)", async () => {
    const L = await import("../web/js/sim/lab-episode.js");
    const { MISSIONS } = await import("../web/js/bench/missions/index.js");
    const { scoreLabRunCounted } = await import("../scripts/lib/trials.mjs");
    let cases = 0;
    for (const robot of L.LAB_ROBOTS)
      for (const lv of MISSIONS[robot].levels)
        for (const seed of [1, 314159, 999999]) {
          const m = MISSIONS[robot];
          const solved = JSON.parse(JSON.stringify(m.solve(lv.id, seed)));
          const idle = JSON.parse(JSON.stringify(m.idle(m.init(lv.id, seed))));
          const traces = [solved, solved.slice(0, Math.max(1, solved.length >> 1)), [...solved, ...Array.from({ length: 40 }, () => idle)], Array.from({ length: 90 }, () => idle), [idle], Array.from({ length: lv.maxSteps }, () => idle)];
          for (const actions of traces) {
            const used = L.stepsUsed(robot, lv.id, seed, actions);
            const old = L.scoreLabRun(robot, lv.id, seed, actions);
            const now = scoreLabRunCounted(robot, lv.id, seed, actions);
            expect(JSON.stringify({ outcome: now.outcome, quality: now.quality }), `${robot}/${lv.id} #${seed}`).to.equal(JSON.stringify(old));
            expect(now.steps, `steps ${robot}/${lv.id} #${seed}`).to.equal(used);
            expect(now.crashed).to.equal(false);
            cases++;
          }
        }
    expect(cases).to.be.above(100);
    expect(MISSIONS["ax1-rover"].step, "the mission's own step is restored").to.be.a("function");
    expect(scoreLabRunCounted("nope", "x", 1, [{}]).crashed).to.equal(true);
  });

  it("an episode with an unknown top-level field is refused before signature or replay", async () => {
    let signatureChecks = 0;
    const t = make({ verifySignature: async () => (signatureChecks++, true) });
    const wallet = ethers.Wallet.createRandom().address;
    const [, ch] = t.challenge("10.9.9.1", wallet);
    offset += 3_600_000;
    const [code, res] = await t.submit(body(wallet, ch, sim.autopilot(ch.seed), { extra: 1 }));
    expect(code).to.equal(400);
    expect(res.error).to.match(/does not match/);
    expect(signatureChecks).to.equal(0);
  });

  it("only the current best run file of a wallet stays on disk", async () => {
    const t = make();
    const wallet = ethers.Wallet.createRandom().address;
    const files = () => fs.readdirSync(path.join(dir, "trials", "episodes"));
    let supersessions = 0;
    for (let i = 0; i < 60 && supersessions < 2; i++) {
      const [, ch] = t.challenge("10.5.5.1", wallet);
      offset += 3_600_000;
      const [code, res] = await t.submit(body(wallet, ch, sim.autopilot(ch.seed)));
      expect(code, JSON.stringify(res)).to.equal(200);
      if (res.best && i > 0) supersessions++;
      expect(files(), `after run ${i}`).to.deep.equal([`${t.leaderboard()[1].top.find((r) => r.wallet === wallet).bestRun}.json`]);
    }
    expect(supersessions, "the autopilot should improve its best on some seeds").to.be.gte(1);
  });

  // ---------------------------------------------------------------- abuse budgets (security review)
  /** A real fixed-window counter in place of the always-false stub: same contract as the server's rateLimited. */
  const counting = () => {
    const m = new Map();
    return (key, max) => {
      const n = m.get(key) || 0;
      if (n >= max) return true;
      m.set(key, n + 1);
      return false;
    };
  };
  const fresh = () => ethers.Wallet.createRandom().address;

  it("new wallets are also limited per /48 (IPv6) and per /24 (IPv4), however the /64 or the host rotates", async () => {
    const t = make({ rateLimited: counting() });
    for (let i = 0; i < 80; i++) expect(t.challenge(`2001:db8:1:${i}::1`, fresh())[0], `v6 ${i}`).to.equal(200); // 80 /64s of one /48
    const [code, res] = t.challenge("2001:db8:1:ffff::1", fresh());
    expect([code, res.error]).to.deep.equal([429, "too many new wallets from this network today"]);
    expect(t.challenge("2001:db8:2:0::1", fresh())[0]).to.equal(200); // another /48

    for (let i = 0; i < 80; i++) expect(t.challenge(`10.20.30.${i + 1}`, fresh())[0], `v4 ${i}`).to.equal(200); // 80 hosts of one /24
    expect(t.challenge("10.20.30.200", fresh())[0]).to.equal(429);
    expect(t.challenge("10.20.31.1", fresh())[0]).to.equal(200);
  });

  it("a global new-wallets-per-hour ceiling answers 429 (never evicts), spares open missions, and resets", async () => {
    let clock = nowSec();
    const t = make({ newWalletsPerHour: 5, now: () => clock });
    const w0 = fresh();
    for (let i = 0; i < 5; i++) expect(t.challenge(`20.0.${i}.1`, i === 0 ? w0 : fresh())[0]).to.equal(200);
    const [code, res] = t.challenge("21.0.0.1", fresh());
    expect([code, res.error]).to.deep.equal([429, "busy, try again later"]);
    expect(t.challenge("20.0.0.1", w0)[0]).to.equal(200); // same wallet, same network, mission still open: not a new wallet
    clock += 3601;
    expect(t.challenge("21.0.0.1", fresh())[0]).to.equal(200);
    expect(t.stats().trialPilots).to.equal(0); // nothing was evicted or invented
  });

  it("deeply nested JSON under a canonical key is a 400 before it reaches canonicalize, not a stack overflow", async () => {
    let signatureChecks = 0;
    const t = make({ verifySignature: async () => (signatureChecks++, true) });
    const wallet = fresh();
    const [, ch] = t.challenge("10.9.8.1", wallet);
    offset += 3_600_000;
    const deep = JSON.parse("[".repeat(300_000) + "]".repeat(300_000));
    const [code, res] = await t.submit(body(wallet, ch, sim.autopilot(ch.seed), { seed: deep }));
    expect(code).to.equal(400);
    expect(res.error).to.match(/nested|does not match/);
    expect(signatureChecks).to.equal(0);
  });

  describe("contract-wallet signature checks (the verifier would eth_call whatever address a guest names)", () => {
    // a wallet verifier that behaves like ownerVerifier does for a contract: it spends the budget the context offers
    const contractLike = (log) => async (_w, _td, _sig, ctx) => {
      if (ctx && !ctx.allowRpc()) return (ctx.limited = true), false;
      log.rpc++;
      return false;
    };
    const attempt = async (t, ip, wallet) => {
      const [, ch] = t.challenge(ip, wallet);
      offset += 3_600_000;
      return t.submit(body(wallet, ch, sim.autopilot(ch.seed)));
    };

    it("is limited per /64: after 20 an hour the answer is 429 and the chain is no longer asked", async () => {
      const log = { rpc: 0 };
      const t = make({ rateLimited: counting(), verifySignature: contractLike(log) });
      const w = fresh();
      for (let i = 0; i < 20; i++) expect((await attempt(t, "2001:db8:7:7::1", w))[0], `try ${i}`).to.equal(401);
      const [code, res] = await attempt(t, "2001:db8:7:7::2", w);
      expect(code).to.equal(429);
      expect(res.error).to.match(/contract-wallet/);
      expect(log.rpc).to.equal(20);
    });

    it("is limited per /24 across hosts: 60 an hour, whoever in the /24 asks", async () => {
      const log = { rpc: 0 };
      const t = make({ rateLimited: counting(), verifySignature: contractLike(log) });
      for (let i = 0; i < 60; i++) expect((await attempt(t, `10.44.55.${(i % 10) + 1}`, fresh()))[0], `try ${i}`).to.equal(401);
      expect((await attempt(t, "10.44.55.99", fresh()))[0]).to.equal(429);
      expect(log.rpc).to.equal(60);
    });
  });
});
