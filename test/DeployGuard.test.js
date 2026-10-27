// scripts/deploy.js mainnetGuard: nothing falls back to a default on mainnet. Pure checks, no chain calls.
const { expect } = require("chai");
const { ethers } = require("hardhat");

// deploy.js wraps the shared hardhat provider with the nonce guard; keep that out of the other suites
const guardPath = require.resolve("../scripts/lib/nonce-guard");
require.cache[guardPath] = { id: guardPath, filename: guardPath, loaded: true, exports: {} };
const { mainnetGuard, generatorHash } = require("../scripts/deploy.js");

const DAY = 86400;
const NOW = 1_800_000_000;
const CID = "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi";
const deployer = "0x00000000000000000000000000000000000dead1";

async function goodEnv() {
  return {
    OWNER: "0x00000000000000000000000000000000000dead2",
    TREASURY: "0x00000000000000000000000000000000000dead3",
    PROVENANCE_HASH: await generatorHash(),
    EXTERNAL_URL: "https://openforgeax.xyz",
    MAX_SUPPLY: "1024",
    TEAM_RESERVE: "100",
    ROYALTY_BPS: "500",
    REVEAL_DEADLINE_DAYS: "21",
    PUBLIC_PRICE_ETH: "0.015",
    MAX_PER_WALLET: "3",
    OPENSEA_FEE_BPS: "1000",
    PUBLIC_START: String(NOW + 2 * DAY),
    PUBLIC_END: String(NOW + 9 * DAY),
    PLACEHOLDER_IMAGE: `ipfs://${CID}/placeholder.png`,
    COLLECTION_IMAGE: `ipfs://${CID}/logo.png`,
    COLLECTION_BANNER: `ipfs://${CID}/banner.png`,
    CONFIRM_MAINNET: "yes",
  };
}

async function refusal(env) {
  try {
    await mainnetGuard(env, deployer, NOW);
  } catch (e) {
    return e.message;
  }
  return null;
}

describe("deploy.js mainnetGuard - launch values", () => {
  it("accepts the decided configuration", async () => {
    expect(await refusal(await goodEnv())).to.equal(null);
  });

  it("the public phase must be set: PUBLIC_START and PUBLIC_END are both required", async () => {
    for (const drop of [["PUBLIC_START"], ["PUBLIC_END"], ["PUBLIC_START", "PUBLIC_END"]]) {
      const env = await goodEnv();
      for (const k of drop) delete env[k];
      expect(await refusal(env), drop.join("+")).to.match(/PUBLIC_START and PUBLIC_END must both be set/);
    }
    const env = await goodEnv();
    env.PUBLIC_START = "soon";
    expect(await refusal(env)).to.match(/must both be set/);
  });

  it("the drop must not be live at deploy time: PUBLIC_START must be in the future", async () => {
    for (const start of [NOW - DAY, NOW]) {
      const env = await goodEnv();
      env.PUBLIC_START = String(start);
      env.PUBLIC_END = String(NOW + 5 * DAY);
      expect(await refusal(env)).to.match(/PUBLIC_START must be in the future/);
    }
  });

  it("PUBLIC_END must follow PUBLIC_START", async () => {
    const env = await goodEnv();
    env.PUBLIC_END = env.PUBLIC_START;
    expect(await refusal(env)).to.match(/PUBLIC_END must be after PUBLIC_START/);
  });

  it("PUBLIC_END + 3 days must not pass the reveal deadline (boundary exact)", async () => {
    const env = await goodEnv();
    env.REVEAL_DEADLINE_DAYS = "14";
    env.PUBLIC_END = String(NOW + 11 * DAY); // + 3 days = exactly the deadline: allowed
    expect(await refusal(env)).to.equal(null);
    env.PUBLIC_END = String(NOW + 11 * DAY + 1);
    expect(await refusal(env)).to.match(/PUBLIC_END \+ 3 days must be on or before the reveal deadline/);
  });

  it("price and per-wallet cap must be the decided 0.015 / 3 unless confirmed explicitly", async () => {
    const env = await goodEnv();
    env.PUBLIC_PRICE_ETH = "0.02";
    expect(await refusal(env)).to.match(/not the decided 0\.015: set CONFIRM_PRICE=0\.02/);
    env.CONFIRM_PRICE = "0.025"; // a confirmation that does not match is not a confirmation
    expect(await refusal(env)).to.match(/CONFIRM_PRICE=0\.02/);
    env.CONFIRM_PRICE = "0.02";
    expect(await refusal(env)).to.equal(null);
    for (const zero of ["0.00", "0.000", "0.0000"]) { // a free mint is never a typo to confirm
      env.PUBLIC_PRICE_ETH = env.CONFIRM_PRICE = zero;
      expect(await refusal(env)).to.match(/PUBLIC_PRICE_ETH must be set explicitly/);
    }

    const wallet = await goodEnv();
    wallet.MAX_PER_WALLET = "5";
    expect(await refusal(wallet)).to.match(/not the decided 3: set CONFIRM_MAX_PER_WALLET=5/);
    wallet.CONFIRM_MAX_PER_WALLET = "5";
    expect(await refusal(wallet)).to.equal(null);

    const missing = await goodEnv();
    delete missing.PUBLIC_PRICE_ETH;
    delete missing.MAX_PER_WALLET;
    expect(await refusal(missing)).to.match(/PUBLIC_PRICE_ETH must be set explicitly[\s\S]*MAX_PER_WALLET must be set explicitly/);
  });

  it("OPENSEA_FEE_BPS must be set and sane (500-2000)", async () => {
    for (const bad of [undefined, "", "0", "499", "2001", "10000", "10%", "-1", "1e3"]) {
      const env = await goodEnv();
      if (bad === undefined) delete env.OPENSEA_FEE_BPS;
      else env.OPENSEA_FEE_BPS = bad;
      expect(await refusal(env), String(bad)).to.match(/OPENSEA_FEE_BPS must be set explicitly/);
    }
    for (const ok of ["500", "1000", "2000"]) {
      const env = await goodEnv();
      env.OPENSEA_FEE_BPS = ok;
      expect(await refusal(env), ok).to.equal(null);
    }
  });

  it("the older guards still hold: Safe addresses, mainnet confirmation", async () => {
    const env = await goodEnv();
    env.OWNER = deployer;
    delete env.CONFIRM_MAINNET;
    const msg = await refusal(env);
    expect(msg).to.match(/OWNER must not be the deploy key/);
    expect(msg).to.match(/CONFIRM_MAINNET=yes/);
  });
});
