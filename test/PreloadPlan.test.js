const { expect } = require("chai");
const fs = require("fs");
const path = require("path");

// scripts/lib/preload-plan.mjs: what each page announces in <head> (priorities, the config fetch, fonts) and which three.js
// addons the vendor copy needs. Runs against the real pages in web/, so a new import cannot silently escape the plan.
const web = path.join(__dirname, "..", "web");
const EAGER = {
  "index.html": ["js/lab/lab-view.js"],
  "bench.html": ["js/bench/bench-view.js", "js/bench/motions.js", "js/bench/test-scenes.js"],
  "pilot.html": ["js/pilot/ai/ai-pilot.js", "js/pilot/ai/ai-panel.js", "js/pilot/ai/voice.js"],
};
const FONTS = ["assets/fonts/inter-latin-wght-normal.woff2", "assets/fonts/inter-tight-latin-wght-normal.woff2", "assets/fonts/jetbrains-mono-latin-wght-normal.woff2"];

describe("Preload plan (scripts/lib/preload-plan.mjs)", () => {
  let P;
  before(async () => {
    P = await import("../scripts/lib/preload-plan.mjs");
  });
  const links = (page) => {
    const html = fs.readFileSync(path.join(web, page), "utf8").replace(/\s*<!--preload-->[\s\S]*?<!--\/preload-->/, "");
    return P.preloadLinks({ html, page, web, eager: EAGER, fonts: FONTS });
  };
  const mod = (l, href) => l.find((x) => x.includes(`rel="modulepreload"`) && x.includes(`href="${href}"`));

  it("preloads deployment.json (same URL and credentials as chain.js's fetch) on every page that loads chain.js", () => {
    const chain = fs.readFileSync(path.join(web, "js/chain.js"), "utf8");
    expect(chain).to.match(/fetch\(new URL\("\.\.\/deployment\.json", import\.meta\.url\), \{ credentials: "same-origin" \}\)/);
    for (const page of ["index.html", "bench.html", "gallery.html", "market.html", "pilot.html", "agent.html", "codex.html", "license.html"]) {
      const l = links(page);
      expect(l[0], page).to.equal(`<link rel="preload" as="fetch" crossorigin href="deployment.json">`);
      expect(l.filter((x) => x.includes("deployment.json")), page).to.have.length(1);
    }
  });

  it("does not preload the config where chain.js is not loaded", () => {
    expect(links("404.html").some((x) => x.includes("deployment.json"))).to.equal(false);
  });

  it("the home page's 3D lab modules (reached only through EAGER) are low priority; the page's own graph is not", () => {
    const l = links("index.html");
    for (const m of ["js/lab/lab-view.js", "js/models/look.js", "js/models/robots.js", "vendor/three/three.module.min.js", "vendor/three/addons/geometries/RoundedBoxGeometry.js", "vendor/three/addons/environments/RoomEnvironment.js"])
      expect(mod(l, m), m).to.include(`fetchpriority="low"`);
    for (const m of ["js/home.js", "js/chain.js", "js/traits-data.js", "js/config.js", "js/audio-buttons.js"]) expect(mod(l, m), m).to.not.include("fetchpriority");
  });

  it("the audio code is no longer part of any page's graph (it loads on the first gesture)", () => {
    for (const page of fs.readdirSync(web).filter((f) => f.endsWith(".html"))) {
      const l = links(page);
      expect(mod(l, "js/ambient.js"), page).to.equal(undefined);
      expect(mod(l, "js/ui-sounds.js"), page).to.equal(undefined);
    }
  });

  it("the Workbench's dynamic modules are announced, at low priority", () => {
    const l = links("bench.html");
    for (const m of ["js/bench/bench-view.js", "js/bench/motions.js", "js/bench/test-scenes.js"]) expect(mod(l, m), m).to.include(`fetchpriority="low"`);
    expect(mod(l, "js/bench/bench.js")).to.not.include("fetchpriority");
  });

  it("the Phone Brain's AI modules are announced at low priority and not in its first graph", () => {
    const l = links("pilot.html");
    for (const m of ["js/pilot/ai/ai-pilot.js", "js/pilot/ai/ai-panel.js", "js/pilot/ai/voice.js"]) expect(mod(l, m), m).to.include(`fetchpriority="low"`);
    expect(mod(l, "js/pilot/pilot.js")).to.not.include("fetchpriority");
  });

  it("agent.html no longer preloads ethers (it loads on demand, after the static page is drawn)", () => {
    expect(links("agent.html").some((x) => x.includes("ethers"))).to.equal(false);
  });

  it("an inline module (license.html) contributes the modules it imports", () => {
    const l = links("license.html");
    expect(mod(l, "js/chain.js")).to.be.a("string");
    expect(mod(l, "js/theme.js")).to.be.a("string");
  });

  it("only the JetBrains Mono preload is low priority", () => {
    const fonts = links("index.html").filter((x) => x.includes('as="font"'));
    expect(fonts).to.have.length(3);
    for (const f of fonts) expect(f.includes('fetchpriority="low"'), f).to.equal(/jetbrains/.test(f));
  });

  it("finds the addon imports of the real site and follows addons that import addons", () => {
    expect(P.addonImports(`import { A } from "three/addons/controls/OrbitControls.js"; // import "three/addons/x/Y.js"`)).to.deep.equal(["controls/OrbitControls.js"]);
    const jsm = path.join(__dirname, "..", "node_modules", "three", "examples", "jsm");
    const used = new Set();
    const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).forEach((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : /\.js$/.test(e.name) && P.addonImports(fs.readFileSync(path.join(d, e.name), "utf8")).forEach((a) => used.add(a))));
    walk(path.join(web, "js"));
    const all = P.addonClosure([...used], (p) => fs.readFileSync(path.join(jsm, p), "utf8"));
    for (const a of ["controls/OrbitControls.js", "environments/RoomEnvironment.js", "geometries/RoundedBoxGeometry.js", "postprocessing/EffectComposer.js", "postprocessing/UnrealBloomPass.js"]) expect(all, a).to.include(a);
    // the closure: the composer pulls its passes and shaders, the bloom pass its own
    for (const a of ["postprocessing/Pass.js", "postprocessing/MaskPass.js", "postprocessing/ShaderPass.js", "shaders/CopyShader.js", "shaders/LuminosityHighPassShader.js"]) expect(all, a).to.include(a);
    expect(all.length).to.be.lessThan(20); // not the ~120 files of the examples folder
    expect(all).to.not.include("postprocessing/SSRPass.js");
  });
});
