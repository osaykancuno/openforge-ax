const { expect } = require("chai");

// Retired voxel art (art/voxel-render.mjs), kept for the Neo-Forge avatars. The token art is tested below.
describe("Voxel art (retired, Neo-Forge avatars)", () => {
  let render, traits, avatar;
  before(async () => {
    render = await import("../art/voxel-render.mjs");
    traits = await import("../art/traits.mjs");
    avatar = await import("../web/js/world/voxel-avatar.js");
  });

  const SEED = "0x" + "c0ffee11".repeat(8);
  const worldTraits = (t) => ({ class_: t.class, core: t.core, sensor: t.sensor, finish: t.finish, augment: t.augment, faction: t.faction, legendary: t.legendary });

  it("is deterministic and well formed for every class, sensor and the Prime Constructs", () => {
    for (let c = 0; c < 8; c++)
      for (let s = 0; s < 5; s++) {
        const t = { ...traits.traitsOf(SEED, 1 + c * 5 + s), class: c, sensor: s, legendary: c === 7 && s === 4 ? 1 : 0 };
        const svg = render.renderAgent(42, t);
        expect(svg).to.equal(render.renderAgent(42, t));
        expect(svg.startsWith("<svg")).to.equal(true);
        expect(svg).to.match(/<\/svg>$/);
        expect(svg).to.not.match(/NaN|undefined/);
        expect((svg.match(/<polygon/g) || []).length).to.be.greaterThan(150);
      }
  });

  it("each sensor adds its own glow voxels to the shared avatar, never inside a solid one", () => {
    for (let c = 0; c < 8; c++) {
      const base = avatar.buildAvatar({ class_: c, core: 0, finish: 0, augment: 0, faction: 0, legendary: 0 });
      const counts = [0, 1, 2, 3, 4].map((s) => avatar.buildAvatar({ class_: c, core: 0, finish: 0, augment: 0, faction: 0, legendary: 0, sensor: s }).glow.length);
      expect(counts[0]).to.equal(base.glow.length); // Optic is the built-in eye
      expect(new Set(counts).size).to.be.greaterThan(2);
      for (let s = 1; s < 5; s++) {
        const a = avatar.buildAvatar({ class_: c, core: 0, finish: 0, augment: 0, faction: 0, legendary: 0, sensor: s });
        const solid = new Set(a.solid.map((v) => v.slice(0, 3).join()));
        const before = new Set(base.glow.map((v) => v.slice(0, 3).join()));
        const added = a.glow.filter((v) => !before.has(v.slice(0, 3).join()));
        expect(added.length).to.be.greaterThan(0);
        expect(added.some((v) => solid.has(v.slice(0, 3).join()))).to.equal(false);
      }
    }
  });

  it("the art shows exactly the in-world avatar's voxels", () => {
    const t = traits.traitsOf(SEED, 5);
    t.class %= 8; // the voxels know the 8 original classes only
    const a = avatar.buildAvatar(worldTraits(t));
    const svg = render.renderAgent(5, t);
    const top = (c) => `fill="#${[16, 8, 0].map((s) => Math.min(255, Math.round(((c >> s) & 255) * 1.18)).toString(16).padStart(2, "0")).join("")}"`;
    for (const [, , , c] of a.solid.filter((v) => v[3] !== 0xc9d3e6)) expect(svg).to.include(top(c)); // every avatar colour is drawn
  });

  it("renders the Dormant placeholder", () => {
    const svg = render.renderDormant();
    expect(svg).to.include("DORMANT");
    expect(svg).to.not.match(/NaN|undefined/);
  });
});

// Token art (art/token-render.mjs + art/token/token.html): the lab's own 3D models, drawn in a headless browser.
describe("Token art (3D lab models)", function () {
  this.timeout(120000);
  const fs = require("fs");
  const path = require("path");
  let R, traits, renderer, sharp;
  const SEED = "0x" + "c0ffee11".repeat(8);
  before(async function () {
    R = await import("../art/token-render.mjs");
    traits = await import("../art/traits.mjs");
    sharp = require("sharp");
    try {
      renderer = await R.createTokenRenderer();
    } catch (e) {
      if (/No Chrome\/Edge|web:build/.test(e.message)) return this.skip(); // CI without a browser or a build
      throw e;
    }
  });
  after(async () => renderer && (await renderer.close()));

  it("the provenance covers the traits, the render page and the 3D models, and every file exists", () => {
    expect(R.GENERATOR_FILES).to.include.members(["art/traits.mjs", "art/token/token.html", "web/js/models/robots.js", "web/js/models/look.js"]);
    for (const f of R.GENERATOR_FILES) expect(fs.existsSync(path.join(__dirname, "..", f)), f).to.equal(true);
    for (const f of ["art/generate.mjs", "scripts/assets.mjs"]) expect(fs.readFileSync(path.join(__dirname, "..", f), "utf8")).to.contain("GENERATOR_FILES");
  });

  it("draws every one of the 11 classes and a Prime Construct: 1000 x 1000, deterministic, no page errors", async () => {
    expect(traits.NAMES.class).to.have.length(11);
    for (let c = 0; c <= 11; c++) {
      const prime = c === 11;
      const t = { ...traits.traitsOf(SEED, 100 + c), class: prime ? 4 : c, legendary: prime ? 1 : 0 };
      const info = traits.describe(t);
      const a = await renderer.render(100 + c, t, info);
      const meta = await sharp(a).metadata();
      expect([meta.width, meta.height], info.Class).to.deep.equal([1000, 1000]);
      if (c === 0 || c === 8 || prime) expect((await renderer.render(100 + c, t, info)).equals(a), `${info.Class} twice`).to.equal(true);
    }
  });
});
