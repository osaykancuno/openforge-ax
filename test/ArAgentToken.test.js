const { expect } = require("chai");

// web/js/ar/agent-token.js: what My IRL lab reads from an agent's token (ar.html?agent=<id>). The metadata below has the
// shape contracts/AgentRenderer.sol writes (tokenURI): 8 trait attributes, then the dynamic ones; a Prime Construct has
// "24K Circuit", "Crown Halo" and a "1/1"; a token before the reveal has only State: Dormant.
describe("AR agent: the token's look (agent-token.js)", () => {
  let A, NAMES;
  before(async () => {
    A = await import("../web/js/ar/agent-token.js");
    NAMES = (await import("../web/js/traits-data.js")).NAMES;
  });

  const dynamic = () => [
    { trait_type: "Agent Wallet", value: "0x00000000000000000000000000000000000000aa" },
    { trait_type: "Autonomy", value: "Manual" },
    { trait_type: "Reputation", value: "Rookie" },
    { trait_type: "Tasks", display_type: "number", value: 0 },
  ];
  const revealed = (id, o = {}) => ({
    name: `AX-${String(id).padStart(4, "0")} // ${o.callsign ?? "Nitro Shrike"}`,
    description: "Free units that work for whoever pays and answer to no one.",
    image: `ipfs://bafy/${id}.gif`,
    attributes: [
      { trait_type: "Class", value: o.class ?? "Cyber Hound" },
      { trait_type: "Core Model", value: "VLA-Base" },
      { trait_type: "Sensor", value: "Optic" },
      { trait_type: "Finish", value: o.finish ?? "Hazard Orange" },
      { trait_type: "Frame", value: o.frame ?? "Mk-III" },
      { trait_type: "District", value: "Rust Docks" },
      { trait_type: "Faction", value: "Free Units" },
      { trait_type: "Augment", value: o.augment ?? "Holo Halo" },
      ...dynamic(),
    ],
  });
  const prime = (id) => {
    const m = revealed(id, { class: "AX-1 Walker", callsign: "The Architect" });
    const set = (k, v) => (m.attributes.find((a) => a.trait_type === k).value = v);
    set("Finish", "24K Circuit");
    set("Augment", "Crown Halo");
    set("Core Model", "VLA-Genesis");
    m.attributes.splice(8, 0, { trait_type: "1/1", value: "The Architect" });
    return m;
  };
  const dormant = (id) => ({
    name: `AX-${String(id).padStart(4, "0")} // DORMANT`,
    image: "assets/placeholder.png",
    attributes: [{ trait_type: "State", value: "Dormant" }, ...dynamic()],
  });

  describe("traitsFromMeta", () => {
    it("reads a revealed token as indices into NAMES", () => {
      const t = A.traitsFromMeta(revealed(42));
      expect(t).to.deep.equal({ class: NAMES.class.indexOf("Cyber Hound"), finish: NAMES.finish.indexOf("Hazard Orange"), augment: NAMES.augment.indexOf("Holo Halo"), frame: 2, legendary: 0 });
      expect(t).to.deep.equal({ class: 2, finish: 2, augment: 2, frame: 2, legendary: 0 });
    });

    it("every class, finish, augment and frame name maps to its own index", () => {
      NAMES.class.forEach((c, i) => expect(A.traitsFromMeta(revealed(1, { class: c })).class, c).to.equal(i));
      NAMES.finish.forEach((f, i) => expect(A.traitsFromMeta(revealed(1, { finish: f })).finish, f).to.equal(i));
      NAMES.augment.forEach((a, i) => expect(A.traitsFromMeta(revealed(1, { augment: a })).augment, a).to.equal(i));
      ["Mk-I", "Mk-II", "Mk-III", "Mk-IV"].forEach((f, i) => expect(A.traitsFromMeta(revealed(1, { frame: f })).frame, f).to.equal(i));
    });

    it("a Prime Construct: legendary wins, its 24K Circuit finish and Crown Halo augment (not in NAMES) do not matter", () => {
      expect(NAMES.finish).to.not.include("24K Circuit");
      expect(NAMES.augment).to.not.include("Crown Halo");
      const t = A.traitsFromMeta(prime(7));
      expect(t.legendary).to.be.greaterThan(0);
      expect(t.class).to.equal(10);
      expect(t.frame).to.equal(2);
      expect(t.finish).to.equal(0);
      expect(t.augment).to.equal(0);
    });

    it("a dormant or unrevealed token has no look", () => {
      expect(A.traitsFromMeta(dormant(3))).to.equal(null);
      expect(A.classifyMeta(dormant(3))).to.deep.equal({ status: "dormant" });
    });

    it("unknown values and a missing trait are bad data, never a guess", () => {
      expect(A.traitsFromMeta(revealed(1, { class: "Toaster" }))).to.equal(null);
      expect(A.traitsFromMeta(revealed(1, { finish: "24K Circuit" }))).to.equal(null); // gold without the 1/1 is not a real token
      expect(A.traitsFromMeta(revealed(1, { augment: "Rocket Boots" }))).to.equal(null);
      expect(A.traitsFromMeta(revealed(1, { frame: "Mk-V" }))).to.equal(null);
      const m = revealed(1);
      m.attributes = m.attributes.filter((a) => a.trait_type !== "Frame");
      expect(A.traitsFromMeta(m)).to.equal(null);
      expect(A.classifyMeta(m)).to.deep.equal({ status: "bad" });
      const p = prime(9);
      p.attributes = p.attributes.filter((a) => a.trait_type !== "Class");
      expect(A.traitsFromMeta(p)).to.equal(null);
      const empty1 = prime(9);
      empty1.attributes.find((a) => a.trait_type === "1/1").value = "";
      expect(A.traitsFromMeta(empty1)).to.equal(null);
    });

    it("null, undefined, wrong types and hostile shapes are bad data and never throw", () => {
      for (const bad of [null, undefined, 0, 7, "x", [], {}, { attributes: null }, { attributes: "Class" }, { attributes: [null, 3, "x", {}] }, { attributes: [{ trait_type: "Class", value: 8 }] }, { attributes: [{ trait_type: "Class", value: ["Cyber Hound"] }] }, { attributes: [{ trait_type: "Class", value: { toString: () => "Cyber Hound" } }] }]) {
        expect(A.traitsFromMeta(bad), JSON.stringify(bad)).to.equal(null);
        expect(A.classifyMeta(bad).status).to.equal("bad");
      }
      // names that exist on Object.prototype are not classes
      expect(A.traitsFromMeta(revealed(1, { class: "constructor" }))).to.equal(null);
      expect(A.traitsFromMeta(revealed(1, { class: "__proto__" }))).to.equal(null);
    });

    it("the first State attribute wins, and a State other than Dormant does not hide a revealed token", () => {
      const m = revealed(5);
      m.attributes.push({ trait_type: "State", value: "Awake" });
      expect(A.traitsFromMeta(m)).to.not.equal(null);
    });
  });

  describe("agentFromMeta", () => {
    it("an AX-1 class drives: its body, its tag and its callsign", () => {
      for (const [cls, body] of [["AX-1 Rover", "rover"], ["AX-1 Desk", "desk"], ["AX-1 Walker", "walker"]]) {
        const a = A.agentFromMeta(42, revealed(42, { class: cls }));
        expect(a.status).to.equal("ready");
        expect(a.kind).to.equal("ax1");
        expect(a.body).to.equal(body);
        expect(a.tag).to.equal("AX-0042");
        expect(a.callsign).to.equal("Nitro Shrike");
        expect(a.className).to.equal(cls);
      }
    });

    it("the other eight classes are a showcase and have no AX-1 body", () => {
      for (const cls of NAMES.class.slice(0, 8)) {
        const a = A.agentFromMeta(1234, revealed(1234, { class: cls }));
        expect(a.kind, cls).to.equal("showcase");
        expect(a.body, cls).to.equal(null);
        expect(a.tag).to.equal("AX-1234");
      }
    });

    it("a Prime Construct is flagged and keeps its own name", () => {
      const a = A.agentFromMeta(7, prime(7));
      expect(a.prime).to.equal(true);
      expect(a.callsign).to.equal("The Architect");
      expect(A.agentFromMeta(8, revealed(8)).prime).to.equal(false);
    });

    it("dormant and bad data come back as a status, not a record", () => {
      expect(A.agentFromMeta(3, dormant(3))).to.deep.equal({ status: "dormant" });
      expect(A.agentFromMeta(3, { attributes: [] })).to.deep.equal({ status: "bad" });
      expect(A.agentFromMeta(3, null)).to.deep.equal({ status: "bad" });
    });

    it("cleans the callsign: control characters, bidi marks and long names; falls back to the class name", () => {
      const evil = revealed(9, { callsign: "Sp‮oof\u0000​  Name\n<b>x</b>" + "y".repeat(100) });
      const a = A.agentFromMeta(9, evil);
      expect(a.callsign).to.not.match(/[\u0000-\u001f‪-‮​-‏]/);
      expect(a.callsign.length).to.be.at.most(40);
      expect(a.callsign.startsWith("Spoof Name")).to.equal(true);
      for (const name of ["AX-0009", "", undefined, 5, "AX-0009 // ", "AX-0009 //  ‮ "]) {
        const m = revealed(9);
        m.name = name;
        expect(A.agentFromMeta(9, m).callsign, String(name)).to.equal("Cyber Hound");
      }
    });

    it("emoji and non-Latin callsigns pass through", () => {
      expect(A.agentFromMeta(9, revealed(9, { callsign: "Rēx 🦖 机器人" })).callsign).to.equal("Rēx 🦖 机器人");
    });
  });

  describe("parseAgentParam", () => {
    it("reads a whole number from the query string", () => {
      expect(A.parseAgentParam("?agent=42")).to.deep.equal({ id: 42 });
      expect(A.parseAgentParam("?debug&agent=7")).to.deep.equal({ id: 7 });
      expect(A.parseAgentParam("?agent=%2042%20")).to.deep.equal({ id: 42 });
      expect(A.parseAgentParam("?agent=1000000000")).to.deep.equal({ id: 1e9 });
    });
    it("no parameter means the plain page", () => {
      for (const s of ["", "?", "?debug", "?agents=3", undefined, null]) expect(A.parseAgentParam(s), String(s)).to.equal(null);
    });
    it("anything that is not a plain positive whole number is bad", () => {
      for (const v of ["", "0", "-1", "7.5", "0x7", "1e3", "7abc", "abc", "1000000001", "99999999999", "%00", "NaN", "Infinity", "٣"]) {
        expect(A.parseAgentParam(`?agent=${v}`), v).to.deep.equal({ bad: true });
      }
    });
    it("agentTag pads to four digits and keeps longer numbers", () => {
      expect(A.agentTag(7)).to.equal("AX-0007");
      expect(A.agentTag(12345)).to.equal("AX-12345");
    });
  });

  it("the module is pure: no DOM, no three, no network", () => {
    const fs = require("node:fs");
    const src = fs.readFileSync(require("node:path").join(__dirname, "..", "web/js/ar/agent-token.js"), "utf8").replace(/\/\/.*$/gm, "");
    expect(src).to.not.match(/from "three|document\.|window\.|fetch\(|localStorage|innerHTML/);
  });
});
