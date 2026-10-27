const { expect } = require("chai");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

// Browser-side hardening that can be checked without a browser: the framing guard (web/js/theme-boot.js) and the
// Web Serial port reuse rule (web/js/robot/serial-transport.js).
describe("Web hardening (theme-boot, serial-transport)", () => {
  const web = path.join(__dirname, "../web");

  describe("theme-boot framing guard", () => {
    const src = fs.readFileSync(path.join(web, "js/theme-boot.js"), "utf8");
    function run({ framed, sameOrigin = false, theme = null }) {
      const calls = { stop: 0, cleared: 0 };
      const root = { dataset: {}, style: {}, replaceChildren: () => calls.cleared++ };
      const self = { location: { origin: "https://site.example" }, stop: () => calls.stop++ };
      self.self = self;
      self.top = framed ? { location: sameOrigin ? { origin: "https://site.example" } : { get origin() { throw new Error("cross-origin"); } } } : self;
      vm.runInNewContext(src, { window: self, document: { documentElement: root }, localStorage: { getItem: () => theme } });
      return { calls, root };
    }
    it("leaves a top-level page alone and applies the saved theme", () => {
      const { calls, root } = run({ framed: false, theme: "dark" });
      expect(calls).to.deep.equal({ stop: 0, cleared: 0 });
      expect(root.style.display).to.equal(undefined);
      expect(root.dataset.theme).to.equal("dark");
    });
    it("hides, stops and empties a page framed by another site, so no wallet prompt can fire in a hidden frame", () => {
      const { calls, root } = run({ framed: true });
      expect(root.style.display).to.equal("none");
      expect(calls.stop).to.equal(1);
      expect(calls.cleared).to.equal(1);
    });
    it("blocks same-origin framing too (nothing on the site frames itself)", () => {
      const { calls, root } = run({ framed: true, sameOrigin: true });
      expect(root.style.display).to.equal("none");
      expect(calls.stop).to.equal(1);
    });
  });

  describe("serial-transport rememberedPort", () => {
    let S;
    before(async () => {
      S = await import("../web/js/robot/serial-transport.js");
    });
    const port = (usbVendorId) => ({ getInfo: () => ({ usbVendorId }) });
    const withPorts = async (ports) => {
      Object.defineProperty(globalThis, "navigator", { value: { serial: { getPorts: async () => ports } }, configurable: true, writable: true });
      try {
        return await S.rememberedPort();
      } finally {
        delete globalThis.navigator;
      }
    };
    it("reuses a single remembered port from a known USB bridge (CH340, FTDI, CP210x)", async () => {
      for (const v of [0x1a86, 0x0403, 0x10c4]) {
        const p = port(v);
        expect(await withPorts([p]), v.toString(16)).to.equal(p);
      }
    });
    it("ignores a remembered port from any other vendor, or without a vendor id", async () => {
      expect(await withPorts([port(0x046d)])).to.equal(null);
      expect(await withPorts([port(undefined)])).to.equal(null);
      expect(await withPorts([{ getInfo: () => ({}) }])).to.equal(null);
      expect(await withPorts([{}])).to.equal(null);
    });
    it("needs exactly one acceptable port: others are skipped, several known ones fall back to the picker", async () => {
      const good = port(0x1a86);
      expect(await withPorts([port(0x046d), good])).to.equal(good);
      expect(await withPorts([good, port(0x0403)])).to.equal(null);
      expect(await withPorts([])).to.equal(null);
    });
  });
});
