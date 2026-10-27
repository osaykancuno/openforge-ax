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
    const t = make();
    let first;
    for (let i = 0; i < 5001; i++) {
      const [code, ch] = t.challenge(`${(i >> 16) + 20}.${(i >> 8) & 255}.${i & 255}.1`, ethers.getAddress(ethers.hexlify(ethers.randomBytes(20))));
      expect(code, `challenge ${i}`).to.equal(200);
      first ??= ch.challengeId;
    }
    expect(await isOpen(t, first)).to.equal(false);
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
});
