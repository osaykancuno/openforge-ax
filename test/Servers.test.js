const { expect } = require("chai");

// Connectors (web/js/servers.js): only sane server URLs can redirect the site to self-hosted servers.
describe("Self-hosting connectors", () => {
  let sv;
  before(async () => {
    sv = await import("../web/js/servers.js");
  });

  it("accepts https/wss anywhere and http/ws only for localhost", () => {
    expect(sv.validServerUrl("proving", "https://proving.example.org/")).to.equal("https://proving.example.org");
    expect(sv.validServerUrl("proving", "http://localhost:8787")).to.equal("http://localhost:8787");
    expect(sv.validServerUrl("proving", "http://127.0.0.1:8787/api/")).to.equal("http://127.0.0.1:8787/api");
    expect(sv.validServerUrl("world", "wss://world.example.org")).to.equal("wss://world.example.org");
    expect(sv.validServerUrl("world", "ws://localhost:8788")).to.equal("ws://localhost:8788");
  });

  it("refuses plain http/ws to remote hosts, other schemes, credentials, queries and junk", () => {
    for (const [k, v] of [
      ["proving", "http://evil.example.org"],
      ["world", "ws://evil.example.org"],
      ["proving", "javascript:alert(1)"],
      ["proving", "wss://proving.example.org"],
      ["world", "https://world.example.org"],
      ["proving", "https://user:pass@proving.example.org"],
      ["proving", "https://proving.example.org/?x=1"],
      ["world", "wss://world.example.org/#a"],
      ["proving", "not a url"],
      ["proving", 42],
      ["proving", "https://" + "a".repeat(300) + ".org"],
      ["other", "https://x.org"],
    ])
      expect(sv.validServerUrl(k, v), `${k} ${v}`).to.equal(null);
  });

  it("applies only valid stored servers over the published config", () => {
    const base = { provingApi: "https://official", worldWs: "wss://official" };
    expect(sv.applyServers(base, null)).to.deep.equal({ ...base, customServers: false });
    expect(sv.applyServers(base, { provingApi: "http://localhost:8787", worldWs: "ws://evil.org" })).to.deep.equal({ provingApi: "http://localhost:8787", worldWs: "wss://official", customServers: true });
  });
});
