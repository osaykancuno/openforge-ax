const { expect } = require("chai");

// Site smoke harness (scripts/site-smoke.mjs): the pure helpers only. The browser run itself is `npm run site:smoke`
// (about two minutes), which is too slow for the unit suite.
describe("Site smoke helpers", () => {
  let smoke;
  before(async () => {
    smoke = await import("../scripts/site-smoke.mjs");
  });

  describe("isExpectedNetworkError (chain, proving and world servers are offline in the smoke run)", () => {
    it("accepts failures that name the local chain / proving / world ports", () => {
      for (const t of [
        "Failed to load resource: net::ERR_CONNECTION_REFUSED http://127.0.0.1:8545/",
        "WebSocket connection to 'ws://localhost:8788/' failed: ",
        "Fetch API cannot load http://localhost:8787/health. Refused",
      ]) expect(smoke.isExpectedNetworkError(t), t).to.equal(true);
    });
    it("uses the failing URL when the text does not carry it", () => {
      expect(smoke.isExpectedNetworkError("Failed to load resource: net::ERR_CONNECTION_REFUSED", "http://127.0.0.1:8545/")).to.equal(true);
      expect(smoke.isExpectedNetworkError("Failed to load resource: net::ERR_CONNECTION_REFUSED", "http://127.0.0.1:8788/x")).to.equal(true);
    });
    it("rejects everything else, including other ports and look-alike hosts", () => {
      for (const [t, u] of [
        ["Uncaught TypeError: x is not a function", ""],
        ["Failed to load resource: the server responded with a status of 404 (Not Found)", "http://127.0.0.1:51234/js/missing.js"],
        ["Failed to load resource: net::ERR_CONNECTION_REFUSED", "http://127.0.0.1:9999/"],
        ["failed http://127.0.0.1:85450/", ""],
        ["failed http://evil.example:8545/", ""],
        ["", ""],
        [undefined, undefined],
      ]) expect(smoke.isExpectedNetworkError(t, u), `${t} ${u}`).to.equal(false);
    });
  });

  describe("isFetchFailure (bare fetch errors carry no URL)", () => {
    it("matches only the bare browser message", () => {
      for (const t of ["TypeError: Failed to fetch", "Failed to fetch", "Uncaught (in promise) TypeError: Failed to fetch"]) expect(smoke.isFetchFailure(t), t).to.equal(true);
      for (const t of ["Failed to fetch /js/x.js: 500", "TypeError: x is undefined", "", undefined]) expect(smoke.isFetchFailure(t), String(t)).to.equal(false);
    });
  });

  describe("overflow checks", () => {
    it("flags document scroll only on short-screen-exempt app pages", () => {
      const m = { app: true, innerHeight: 823, scrollHeight: 900, innerWidth: 1800, scrollWidth: 1800 };
      expect(smoke.layoutProblems(m)).to.deep.equal(["document scrolls (900 > 823)"]);
      expect(smoke.layoutProblems({ ...m, scrollHeight: 824 })).to.deep.equal([]); // 1px tolerance
      expect(smoke.layoutProblems({ ...m, app: false })).to.deep.equal([]); // marketing pages may scroll
      expect(smoke.layoutProblems({ ...m, innerHeight: 560 })).to.deep.equal([]); // short-screen breakpoint scrolls by design
      expect(smoke.layoutProblems({ ...m, innerWidth: 345, scrollWidth: 345, innerHeight: 600, scrollHeight: 1100 })).to.deep.equal([]); // phones with large text scroll
      expect(smoke.layoutProblems({ ...m, innerWidth: 345, scrollWidth: 345, innerHeight: 812, scrollHeight: 1100 })).to.deep.equal(["document scrolls (1100 > 812)"]);
    });
    it("flags a 3D canvas that escaped its box (the Workbench phone bug)", () => {
      const m = { app: true, innerHeight: 600, scrollHeight: 600, innerWidth: 345, scrollWidth: 345, escaped: ["plate"] };
      expect(smoke.layoutProblems(m)).to.deep.equal(["canvas #plate is larger than its box"]);
    });
    it("flags horizontal overflow on every page", () => {
      const m = { app: false, innerHeight: 812, scrollHeight: 2000, innerWidth: 375, scrollWidth: 420 };
      expect(smoke.layoutProblems(m)).to.deep.equal(["horizontal overflow (420 > 375)"]);
    });
  });

  it("covers every page of the site at five viewports and both themes", () => {
    const names = smoke.PAGES.map((p) => p.path);
    for (const p of ["index.html", "bench.html", "bench.html#so101/test", "bench.html#ax1-desk/test", "pilot.html", "arena.html", "robot.html",
      "codex.html#1", "codex.html#8", "gallery.html", "market.html", "agent.html?id=1", "agents.html", "license.html"]) expect(names, p).to.include(p);
    expect(smoke.VIEWPORTS.map((v) => `${v.width}x${v.height}`)).to.deep.equal(["1800x823", "1366x768", "375x812", "345x600", "780x360"]);
    expect(smoke.THEMES).to.deep.equal(["light", "dark"]);
    expect(smoke.VIEWPORTS[2].mobile).to.equal(true);
  });
});
