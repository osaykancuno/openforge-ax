const { expect } = require("chai");
const fs = require("node:fs");
const path = require("node:path");

// Local-first demonstration storage (web/js/sim/demo-store.js): in-memory and IndexedDB adapters (the latter against a
// small fake of the IndexedDB API), save / list / load / delete, owner keys, and the export file.
describe("Demonstration store (web/js/sim/demo-store.js)", () => {
  let D, S;
  before(async () => {
    D = await import("../web/js/sim/demo-episode.js");
    S = await import("../web/js/sim/demo-store.js");
  });

  const ADDR = "0x" + "ab".repeat(20);
  const HOLDER = "0x" + "cd".repeat(20);
  function demo(extra = {}, { n = 4, at = 0, bias = 0 } = {}) {
    let t = 0;
    const rec = D.createDemoRecorder({
      meta: { chainId: 8453, agents: ADDR, tokenId: 7, holder: HOLDER, robot: "ax1-rover", source: "phone-brain", ...extra },
      clock: { now: () => t, wall: () => Date.UTC(2026, 9, 28, 12, 0, at) },
    });
    const joints = D.layoutOf(extra.robot || "ax1-rover").names.filter((x) => x.endsWith(".pos")).length;
    for (let i = 0; i < n; i++, t += 33) rec.push({ joints: Array.from({ length: joints }, (_, k) => (k ? 0 : i + bias)), drive: joints === 2 ? [10 * i, 0] : undefined });
    return rec.stop();
  }

  /** The smallest fake of IndexedDB the adapter needs: open / upgrade, a transaction per call, get / put / delete / getAllKeys. */
  function fakeIndexedDB({ failOpen = 0 } = {}) {
    const stores = new Map();
    const fake = { opens: 0 };
    fake.open = (name) => {
      fake.opens++;
      const rq = { result: null, error: null };
      setImmediate(() => {
        if (failOpen-- > 0) return rq.onerror && rq.onerror(((rq.error = new Error("blocked")), {}));
        const fresh = !stores.has(name);
        if (fresh) stores.set(name, new Map());
        const data = stores.get(name);
        rq.result = {
          createObjectStore: () => {},
          transaction: () => {
            const tx = { error: null };
            const op = (fn) => {
              const r = { result: undefined };
              setImmediate(() => {
                r.result = fn();
                tx.oncomplete && tx.oncomplete();
              });
              return r;
            };
            tx.objectStore = () => ({
              get: (k) => op(() => (data.has(k) ? structuredClone(data.get(k)) : undefined)),
              put: (v, k) => op(() => void data.set(k, structuredClone(v))),
              delete: (k) => op(() => void data.delete(k)),
              getAllKeys: () => op(() => [...data.keys()]),
            });
            return tx;
          },
        };
        if (fresh) rq.onupgradeneeded && rq.onupgradeneeded();
        rq.onsuccess && rq.onsuccess();
      });
      return rq;
    };
    return fake;
  }

  const adapters = {
    memory: () => S.memoryAdapter(),
    indexedDB: () => S.idbAdapter({ indexedDB: fakeIndexedDB() }),
  };

  for (const [kind, make] of Object.entries(adapters)) {
    describe(`with the ${kind} adapter`, () => {
      it("saves, lists, loads and deletes", async () => {
        const store = S.createDemoStore(make());
        expect(await store.list()).to.deep.equal([]);
        const env = demo();
        const sum = await store.save(env);
        expect(sum).to.include({ id: env.integrity.head, tokenId: 7, holder: HOLDER, robot: "ax1-rover", source: "phone-brain", actor: "human", frames: 4, durationMs: 99, owner: `8453:${ADDR}:7` });
        expect(await store.list()).to.deep.equal([sum]);
        expect(await store.load(env.integrity.head)).to.deep.equal(env);
        expect(await store.delete(env.integrity.head)).to.equal(true);
        expect(await store.delete(env.integrity.head)).to.equal(false);
        expect(await store.load(env.integrity.head)).to.equal(null);
        expect(await store.list()).to.deep.equal([]);
      });

      it("saving the same demo twice keeps one; the copy handed back is detached", async () => {
        const store = S.createDemoStore(make());
        const env = demo();
        await store.save(env);
        await store.save(env);
        expect(await store.list()).to.have.length(1);
        const got = await store.load(env.integrity.head);
        got.frames[0].a[0] = 99; // editing the loaded copy does not touch the stored one
        expect(D.validateDemo(await store.load(env.integrity.head)).ok).to.equal(true);
      });

      it("lists newest first and filters by owner, actor, robot and token", async () => {
        const store = S.createDemoStore(make());
        const a = demo({}, { at: 1 });
        const b = demo({ tokenId: 8 }, { at: 3 });
        const c = demo({ source: "ai-pilot" }, { at: 2 });
        const g = demo({ tokenId: null, agents: null, chainId: null, holder: null, robot: "ax1-desk", source: "workbench" }, { at: 4, bias: 0 });
        for (const e of [a, b, c, g]) await store.save(e);
        const all = await store.list();
        expect(all.map((s) => s.id)).to.deep.equal([g, b, c, a].map((e) => e.integrity.head));
        expect((await store.list({ actor: "ai" })).map((s) => s.id)).to.deep.equal([c.integrity.head]);
        expect((await store.list({ actor: "human", tokenId: 7 })).map((s) => s.id)).to.deep.equal([a.integrity.head]);
        expect((await store.list({ owner: "guest" })).map((s) => s.id)).to.deep.equal([g.integrity.head]);
        expect((await store.list({ owner: `8453:${ADDR}:8` })).map((s) => s.id)).to.deep.equal([b.integrity.head]);
        expect((await store.list({ robot: "ax1-desk" })).length).to.equal(1);
      });

      it("refuses to store an invalid or tampered demo, and notices a damaged stored one", async () => {
        const adapter = make();
        const store = S.createDemoStore(adapter);
        const env = demo();
        const tampered = JSON.parse(JSON.stringify(env));
        tampered.frames[1].a[0] = 5;
        for (const junk of [tampered, null, {}, "x", { ...env, format: "openforge.demo.v2" }]) {
          let err;
          await store.save(junk).catch((e) => (err = e));
          expect(err, JSON.stringify(junk)?.slice(0, 40)).to.be.instanceOf(RangeError);
        }
        expect(await store.list()).to.deep.equal([]);
        await store.save(env);
        await adapter.put("demo:" + env.integrity.head, tampered); // disk corruption
        let err;
        await store.load(env.integrity.head).catch((e) => (err = e));
        expect(err).to.be.instanceOf(RangeError);
        expect(err.message).to.match(/damaged/);
      });

      it("a half-saved demo (body without its summary) never shows in the list", async () => {
        const adapter = make();
        const store = S.createDemoStore(adapter);
        const env = demo();
        await adapter.put("demo:" + env.integrity.head, env);
        expect(await store.list()).to.deep.equal([]);
      });
    });
  }

  it("the store is capped", async () => {
    const store = S.createDemoStore(S.memoryAdapter());
    for (let i = 0; i < S.MAX_DEMOS; i++) await store.save(demo({ tokenId: i }, { n: 1 }));
    let err;
    await store.save(demo({ tokenId: 100000 }, { n: 1 })).catch((e) => (err = e));
    expect(err.message).to.match(/store is full/);
    const first = (await store.list())[0];
    await store.save(await store.load(first.id)); // an existing demo can still be saved again
    expect(await store.delete(first.id)).to.equal(true);
    await store.save(demo({ tokenId: 100000 }, { n: 1 })); // and room is back
  });

  it("rejects a storage adapter that lacks a method", () => {
    expect(() => S.createDemoStore(null)).to.throw(TypeError);
    expect(() => S.createDemoStore({ get() {}, put() {}, keys() {} })).to.throw(/remove/);
  });

  it("the IndexedDB adapter needs IndexedDB, and retries after a failed open", async () => {
    expect(() => S.idbAdapter({ indexedDB: undefined })).to.throw(/not available/);
    const fake = fakeIndexedDB({ failOpen: 1 });
    const a = S.idbAdapter({ indexedDB: fake });
    let err;
    await a.get("k").catch((e) => (err = e));
    expect(err).to.be.instanceOf(Error);
    await a.put("k", { v: 1 });
    expect(await a.get("k")).to.deep.equal({ v: 1 });
    expect(await a.keys()).to.deep.equal(["k"]);
    await a.remove("k");
    expect(await a.get("k")).to.equal(undefined);
    expect(fake.opens).to.equal(2); // one failed, one reused for every later call
  });

  describe("export file", () => {
    it("exportFile gives compact JSON, a name and a Blob; the text reads back to the same demo", async () => {
      const env = demo();
      const f = S.exportFile(env);
      expect(f.mime).to.equal("application/json");
      expect(f.name).to.equal(`openforge-demo-token-7-ax1-rover-${env.integrity.head.slice(0, 8)}.json`);
      expect(f.json).to.equal(JSON.stringify(env));
      expect(f.blob).to.be.instanceOf(Blob);
      expect(await f.blob.text()).to.equal(f.json);
      expect(S.parseDemoFile(f.json)).to.deep.equal(env);
      expect(S.exportFile(demo({ tokenId: null, agents: null, chainId: null, holder: null })).name).to.match(/^openforge-demo-guest-/);
      const store = S.createDemoStore(S.memoryAdapter());
      const sum = await store.importFile(f.json);
      expect(sum.id).to.equal(env.integrity.head);
      expect(await store.load(sum.id)).to.deep.equal(env);
    });

    it("refuses to export an invalid demo and to import anything but a valid file", async () => {
      const env = demo();
      env.frames[0].a[0] = 3;
      expect(() => S.exportFile(env)).to.throw(RangeError);
      expect(() => S.exportFile(null)).to.throw(RangeError);
      for (const text of ["", "nope", "[]", "null", "{}", JSON.stringify({ ...demo(), format: "openforge.demo.v2" }), JSON.stringify(env), 42, null, "x".repeat(S.MAX_FILE_BYTES + 1)]) {
        expect(() => S.parseDemoFile(text), String(text).slice(0, 20)).to.throw(RangeError);
      }
      const store = S.createDemoStore(S.memoryAdapter());
      let err;
      await store.importFile(JSON.stringify(env)).catch((e) => (err = e));
      expect(err).to.be.instanceOf(RangeError);
      expect(await store.list()).to.deep.equal([]);
    });
  });

  it("is local-only: no network, no DOM in the module", () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "web/js/sim/demo-store.js"), "utf8").replace(/^\s*\/\/.*$/gm, "");
    for (const bad of [/\bfetch\s*\(/, /XMLHttpRequest/, /\bdocument\./, /\bwindow\./, /localStorage|sessionStorage/, /WebSocket|sendBeacon|navigator/]) expect(src, String(bad)).to.not.match(bad);
  });
});
