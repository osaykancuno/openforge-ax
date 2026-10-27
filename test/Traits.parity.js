const { expect } = require("chai");
const { ethers } = require("hardhat");
const { deployAll, reveal, decodeUri } = require("./helpers");

describe("Solidity <-> JS trait parity (art/traits.mjs)", () => {
  it("on-chain traits, Prime Constructs and callsigns match JS for every token", async function () {
    this.timeout(120000);
    const { traitsOf, legendaryIds, describe } = await import("../art/traits.mjs");
    const { agents, renderer } = await deployAll({ maxSupply: 120, reserve: 120 });
    const holder = (await ethers.getSigners())[2].address;
    await agents.reserveMint(holder, 60);
    await agents.reserveMint(holder, 60);
    await reveal(agents);
    const seed = await agents.seed();

    const legendsJs = legendaryIds(seed, 120);
    const legendsSol = (await renderer.legendaryIds()).map(Number);
    expect(legendsSol).to.deep.equal(legendsJs);
    expect(legendsJs.length).to.equal(2);

    const names = new Set();
    for (let id = 1; id <= 120; id++) {
      const js = traitsOf(seed, id, legendsJs);
      const sol = await renderer.traitsOf(id);
      expect([sol.class_, sol.core, sol.sensor, sol.finish, sol.frame, sol.district, sol.faction, sol.augment, sol.prefix, sol.suffix, sol.legendary].map(Number))
        .to.deep.equal([js.class, js.core, js.sensor, js.finish, js.frame, js.district, js.faction, js.augment, js.prefix, js.suffix, js.legendary]);

      const meta = decodeUri(await agents.tokenURI(id));
      const d = describe(js);
      expect(meta.name).to.equal(`AX-${String(id).padStart(4, "0")} // ${d.name}`);
      names.add(d.name);
      for (const [k, v] of Object.entries(d)) {
        if (k === "name") continue;
        expect(meta.attributes.find((a) => a.trait_type === k)?.value, `${id}:${k}`).to.equal(v);
      }
    }
    expect(names.size).to.equal(120); // no duplicate callsigns

    // the callsign permutation covers all 1024 indices without repeats
    const { nameIndex } = await import("../art/traits.mjs");
    expect(new Set(Array.from({ length: 1024 }, (_, i) => nameIndex(seed, i + 1))).size).to.equal(1024);
  });
});
