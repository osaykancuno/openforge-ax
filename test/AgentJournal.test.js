const { expect } = require("chai");
const ethers = require("ethers");

// web/js/agent/journal.js: the assisted-practice journal. Runs flown with the AI Pilot or a twin are written down
// here, hash-chained, in this browser only, and labelled "Assisted, not verified". A signature over the journal uses
// its own EIP-712 domain, so it can never pass for a Proving Grounds run.
describe("Agent console: assisted practice journal (web/js/agent/journal.js)", () => {
  let J, E;
  const mem = () => {
    const m = new Map();
    return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), raw: m };
  };
  const ctx = { chainId: 1, tokenId: 7 };
  const entry = (n = 1) => ({ kind: "ai-pilot", robot: "ax1-rover", mission: "lab/ax1-rover/L1", outcome: "passed", note: `run ${n}` });
  before(async () => {
    J = await import("../web/js/agent/journal.js");
    E = await import("../web/js/sim/episode.js");
  });

  it("labels every entry 'Assisted, not verified'", () => {
    const s = mem();
    const j = J.createJournal({ storage: s, ...ctx, now: () => 1000 });
    const e = j.append(entry());
    expect(e.label).to.equal("Assisted, not verified");
    expect(J.LABEL).to.equal("Assisted, not verified");
  });

  it("chains entries: each hash covers the previous one, and the first starts from zero", () => {
    const j = J.createJournal({ storage: mem(), ...ctx, now: () => 1000 });
    const a = j.append(entry(1));
    const b = j.append(entry(2));
    expect(a.prev).to.equal(J.GENESIS);
    expect(b.prev).to.equal(a.hash);
    expect(a.hash).to.match(/^0x[0-9a-f]{64}$/);
    expect(a.hash).to.not.equal(b.hash);
    expect(a.seq).to.equal(0);
    expect(b.seq).to.equal(1);
    expect(j.head()).to.equal(b.hash);
    expect(j.verify()).to.deep.equal({ ok: true, count: 2 });
  });

  it("the hash is keccak256 of the canonical entry, so anyone can recompute it", () => {
    const j = J.createJournal({ storage: mem(), ...ctx, now: () => 1234 });
    const e = j.append(entry());
    const { hash, ...body } = e;
    expect(hash).to.equal(ethers.keccak256(ethers.toUtf8Bytes(J.canonical(body))));
    expect(J.canonical({ b: 1, a: [2, { d: 1, c: 2 }] })).to.equal('{"a":[2,{"c":2,"d":1}],"b":1}');
  });

  it("detects an edited, removed, inserted or reordered entry", () => {
    const s = mem();
    const j = J.createJournal({ storage: s, ...ctx, now: () => 1000 });
    for (let i = 0; i < 4; i++) j.append(entry(i));
    const good = j.entries();
    const check = (list) => J.verifyChain(list);
    expect(check(good).ok).to.equal(true);
    const edited = structuredClone(good);
    edited[1].outcome = "failed";
    expect(check(edited)).to.deep.equal({ ok: false, at: 1 });
    expect(check([good[0], good[2], good[3]])).to.deep.equal({ ok: false, at: 1 });
    expect(check([good[1], good[0], good[2], good[3]]).ok).to.equal(false);
    const swapped = structuredClone(good);
    swapped[2] = { ...swapped[2], prev: J.GENESIS };
    expect(check(swapped).ok).to.equal(false);
    expect(check([]).ok).to.equal(true);
    expect(check("junk").ok).to.equal(false);
    expect(check([null]).ok).to.equal(false);
  });

  it("is kept per chain and token, in the injected storage only", () => {
    const s = mem();
    const a = J.createJournal({ storage: s, chainId: 1, tokenId: 7, now: () => 1 });
    const b = J.createJournal({ storage: s, chainId: 1, tokenId: 8, now: () => 1 });
    const c = J.createJournal({ storage: s, chainId: 11155111, tokenId: 7, now: () => 1 });
    a.append(entry());
    expect(a.entries()).to.have.length(1);
    expect(b.entries()).to.have.length(0);
    expect(c.entries()).to.have.length(0);
    // a new instance over the same storage sees the same journal
    expect(J.createJournal({ storage: s, chainId: 1, tokenId: 7 }).entries()).to.have.length(1);
  });

  it("refuses unknown kinds, over-long text and non-text fields; trims the note", () => {
    const j = J.createJournal({ storage: mem(), ...ctx, now: () => 1 });
    expect(() => j.append({ ...entry(), kind: "proving-grounds" })).to.throw(/kind/);
    expect(() => j.append({ ...entry(), outcome: "maybe" })).to.throw(/outcome/);
    expect(() => j.append({ ...entry(), robot: { x: 1 } })).to.throw(/robot/);
    expect(() => j.append({ ...entry(), mission: "m".repeat(200) })).to.throw(/mission/);
    expect(() => j.append(null)).to.throw();
    const e = j.append({ ...entry(), note: "n".repeat(500) });
    expect(e.note.length).to.equal(200);
    expect(j.entries()).to.have.length(1);
  });

  it("keeps at most 500 entries; the chain still verifies after the oldest are dropped", () => {
    const j = J.createJournal({ storage: mem(), ...ctx, now: () => 1 });
    for (let i = 0; i < 510; i++) j.append(entry(i));
    expect(j.entries()).to.have.length(500);
    expect(j.entries()[0].seq).to.equal(10);
    expect(j.verify().ok).to.equal(true);
  });

  it("survives corrupt or hostile stored data", () => {
    const s = mem();
    const j = J.createJournal({ storage: s, ...ctx, now: () => 1 });
    j.append(entry());
    for (const k of s.raw.keys()) s.raw.set(k, "{not json");
    expect(j.entries()).to.deep.equal([]);
    expect(j.verify().ok).to.equal(true);
    expect(() => j.append(entry())).to.not.throw();
    expect(J.createJournal({ storage: null, ...ctx }).entries()).to.deep.equal([]);
    expect(() => J.createJournal({ storage: null, ...ctx }).append(entry())).to.not.throw(); // private mode: kept for this visit
  });

  it("exports a file whose chain verifies after a round trip", () => {
    const j = J.createJournal({ storage: mem(), ...ctx, now: () => 5 });
    j.append(entry(1));
    j.append(entry(2));
    const f = j.exportFile();
    expect(f.filename).to.equal("openforge-agent-7-practice-journal.json");
    const parsed = JSON.parse(f.text);
    expect(parsed.label).to.equal("Assisted, not verified");
    expect(J.verifyChain(parsed.entries).ok).to.equal(true);
  });

  describe("signature", () => {
    const head = ethers.id("head");
    const td = () => J.journalTypedData({ chainId: 1, tokenId: 7, count: 3, head });
    it("has its own domain and type, and says what it is", () => {
      const t = td();
      expect(t.domain).to.deep.equal({ name: "OpenForge Agent Journal", version: "1", chainId: 1 });
      expect(Object.keys(t.types)).to.deep.equal(["Journal"]);
      expect(t.value.label).to.equal("Assisted, not verified");
    });
    it("can never be read as a Proving Grounds run, a pilot trial, or the reverse", () => {
      const j = td();
      const run = E.runTypedData({ chainId: 1, verifyingContract: "0x" + "11".repeat(20), tokenId: 7, challengeId: head, episodeHash: head, deadline: 9 });
      expect(j.domain.name).to.not.equal(run.domain.name);
      expect(Object.keys(j.types)).to.not.include("Run");
      expect(ethers.TypedDataEncoder.hashDomain(j.domain)).to.not.equal(ethers.TypedDataEncoder.hashDomain(run.domain));
      // the two digests differ even when the fields line up, and a signature for one recovers a different signer for the other
      const w = ethers.Wallet.createRandom();
      return w.signTypedData(j.domain, j.types, j.value).then((sig) => {
        const asRun = ethers.verifyTypedData(run.domain, run.types, run.value, sig);
        expect(asRun).to.not.equal(w.address);
        expect(ethers.verifyTypedData(j.domain, j.types, j.value, sig)).to.equal(w.address);
      });
    });
    it("is bound to the token, the entry count and the head, so a longer or edited journal needs a new signature", async () => {
      const w = ethers.Wallet.createRandom();
      const sig = await w.signTypedData(td().domain, td().types, td().value);
      for (const over of [{ tokenId: 8 }, { count: 4 }, { head: ethers.id("other") }, { chainId: 2 }]) {
        const t = J.journalTypedData({ chainId: 1, tokenId: 7, count: 3, head, ...over });
        expect(ethers.verifyTypedData(t.domain, t.types, t.value, sig), JSON.stringify(over)).to.not.equal(w.address);
      }
    });
  });
});
