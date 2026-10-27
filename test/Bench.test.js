const { expect } = require("chai");
const fs = require("fs");
const path = require("path");

describe("Workbench missions (web/js/bench/missions)", function () {
  this.timeout(120000);
  let MISSIONS, specs, common;
  before(async () => {
    ({ MISSIONS } = await import("../web/js/bench/missions/index.js"));
    common = await import("../web/js/bench/missions/common.js");
    specs = await import("../web/js/models/robot-specs.js");
  });

  const IDS = ["so101", "rover", "hound", "hand", "spider", "drone", "fab", "replicant", "ax1-rover", "ax1-desk", "ax1-walker"];
  const SEEDS = [1, 2, 7, 42, 1234];

  it("every robot has a mission with 3 levels and the required interface", () => {
    expect(Object.keys(MISSIONS).sort()).to.deep.equal(IDS.slice().sort());
    for (const id of IDS) {
      const m = MISSIONS[id];
      expect(m.id).to.equal(id);
      expect(m.levels).to.have.length(3);
      for (const lv of m.levels) {
        expect(lv.id).to.be.a("string");
        expect(lv.title).to.be.a("string");
        expect(lv.goal).to.be.a("string");
        expect(lv.pass).to.be.a("number");
        expect(lv.maxSteps).to.be.greaterThan(0);
      }
      for (const fn of ["init", "step", "score", "solve", "toAction", "readout", "uiDefaults", "idle"]) expect(m[fn], `${id}.${fn}`).to.be.a("function");
      expect(m.dt).to.equal(1 / 30);
      expect(m.controls.length).to.be.greaterThan(0);
    }
  });

  for (const id of IDS) {
    describe(id, () => {
      it("scripted solutions pass every level on several seeds; replay is deterministic and JSON-stable", () => {
        const m = MISSIONS[id];
        for (const lv of m.levels) {
          for (const seed of SEEDS) {
            const actions = m.solve(lv.id, seed);
            const trace = { level: lv.id, seed, actions };
            const r1 = m.score(trace);
            expect(r1.pass, `${id}/${lv.id} seed ${seed}: ${r1.reason} ${JSON.stringify(r1.metrics)}`).to.equal(true);
            expect(r1.score).to.be.within(60, 100);
            const r2 = m.score(JSON.parse(JSON.stringify(trace)));
            expect(r2).to.deep.equal(r1);
          }
        }
      });

      it("do-nothing runs fail every level and score below the pass mark", () => {
        const m = MISSIONS[id];
        for (const lv of m.levels) {
          const s = m.init(lv.id, 3);
          const actions = Array.from({ length: lv.maxSteps }, () => m.idle(s));
          const r = m.score({ level: lv.id, seed: 3, actions });
          expect(r.pass, `${id}/${lv.id}`).to.equal(false);
          expect(r.score).to.be.lessThan(lv.pass);
          expect(m.score({ level: lv.id, seed: 3, actions: [] }).pass).to.equal(false);
        }
      });

      it("layouts are deterministic per seed and the UI mapping yields valid actions", () => {
        const m = MISSIONS[id];
        for (const lv of m.levels) {
          expect(JSON.stringify(m.init(lv.id, 9))).to.equal(JSON.stringify(m.init(lv.id, 9)));
          const s = m.init(lv.id, 9);
          const ui = { mode: m.controls.find((c) => c.type === "mode")?.value, held: {}, pulse: {}, ...m.uiDefaults(s) };
          const a = m.toAction(ui, s);
          m.step(s, a ?? m.idle(s), m.dt);
          expect(m.readout(s)).to.be.a("string").and.not.equal("");
        }
      });
    });
  }

  it("missions are pure: no Math.random, clocks or DOM", () => {
    const dir = path.join(__dirname, "../web/js/bench/missions");
    for (const f of fs.readdirSync(dir)) {
      const src = fs.readFileSync(path.join(dir, f), "utf8");
      expect(src, f).to.not.match(/Math\.random|performance\.now|Date\.now|new Date|document\.|window\.|from "three"/);
    }
  });

  it("seeded PRNG is reproducible and in [0, 1)", () => {
    const a = common.prng(5), b = common.prng(5);
    for (let i = 0; i < 1000; i++) {
      const v = a();
      expect(v).to.equal(b());
      expect(v).to.be.within(0, 0.9999999999);
    }
  });

  it("robot specs cover all robots, never invent unverified data, and are pure", () => {
    const { ROBOT_SPECS, TO_VERIFY } = specs;
    expect(Object.keys(ROBOT_SPECS).sort()).to.deep.equal(IDS.slice().sort());
    for (const id of IDS) {
      const r = ROBOT_SPECS[id];
      expect(r.id).to.equal(id);
      for (const k of ["name", "platform", "softwareLicense", "hardwareLicense", "cc0Compatible", "phoneBrain"]) expect(r[k], `${id}.${k}`).to.be.a("string").and.not.equal("");
      expect(["link only", "derive ok", TO_VERIFY]).to.include(r.cc0Compatible);
      expect(r.bomUSD === TO_VERIFY || (Array.isArray(r.bomUSD) && r.bomUSD.length === 2 && r.bomUSD[0] <= r.bomUSD[1]), `${id}.bomUSD`).to.equal(true);
      expect(r.difficulty).to.be.within(1, 5);
      expect(r.parts).to.be.an("array").that.is.not.empty;
      if (r.upstream !== TO_VERIFY) expect(r.upstream).to.match(/^https:\/\//);
      if (/\bNC\b|NonCommercial|non-commercial/i.test(`${r.hardwareLicense} ${r.softwareLicense}`)) expect(r.cc0Compatible).to.equal("link only");
    }
    const src = fs.readFileSync(path.join(__dirname, "../web/js/models/robot-specs.js"), "utf8");
    expect(src).to.not.match(/from "three"/);
  });

  it("Proving Grounds lab trials: every robot and level verifies by replay, and the verifier rejects junk", async () => {
    const L = await import("../web/js/sim/lab-episode.js");
    expect(L.LAB_ROBOTS).to.have.members(IDS);
    expect(L.CLASS_ROBOT).to.have.length(11); // AgentRenderer class order: 8 open platforms, then AX-1 Rover / Desk / Walker
    for (let c = 0; c < 8; c++) expect(L.robotsForClass(c)).to.deep.equal([L.CLASS_ROBOT[c], "ax1-rover", "ax1-desk", "ax1-walker"]);
    expect(L.robotsForClass(8)).to.deep.equal(["ax1-rover", "ax1-desk", "ax1-walker"]); // no repeats for the AX-1 classes
    expect(L.robotsForClass(9)).to.deep.equal(["ax1-desk", "ax1-rover", "ax1-walker"]);
    expect(L.robotsForClass(10)).to.deep.equal(["ax1-walker", "ax1-rover", "ax1-desk"]);
    for (const id of IDS)
      for (const lv of MISSIONS[id].levels) {
        const seed = 314159;
        const actions = JSON.parse(JSON.stringify(MISSIONS[id].solve(lv.id, seed))); // as it arrives over HTTP
        expect(L.validateLabActions(id, lv.id, actions), `${id}/${lv.id}`).to.equal(null);
        const r = L.scoreLabRun(id, lv.id, seed, actions);
        expect(r.outcome.success, `${id}/${lv.id}`).to.equal(true);
        expect(r.quality).to.equal(r.outcome.score * 100);
        const ep = L.buildLabEpisode({ tokenId: 5, challengeId: "0x01", robot: id, level: lv.id, seed, actions });
        expect(ep).to.include({ robot: id, level: lv.id, sim: L.LAB_SIM_ID, mission: `lab/${id}/${lv.id}` });
      }
    // what the browser records (toAction from the controls) fits the verifier's schema for every mission
    for (const id of IDS)
      for (const l of MISSIONS[id].levels) {
        const st = MISSIONS[id].init(l.id, 5);
        const ui = { ...MISSIONS[id].uiDefaults(st), held: {}, pulse: {}, mode: MISSIONS[id].controls.find((c) => c.type === "mode")?.value };
        const a = MISSIONS[id].toAction(ui, st) ?? MISSIONS[id].idle(st);
        expect(L.validateLabActions(id, l.id, [a]), `${id}/${l.id} ui`).to.equal(null);
        expect(L.validateLabActions(id, l.id, [MISSIONS[id].idle(st)]), `${id}/${l.id} idle`).to.equal(null);
      }
    // padding: a trace longer than the mission consumed is detectable
    const solved = MISSIONS.rover.solve("cone", 9);
    expect(L.stepsUsed("rover", "cone", 9, [...solved, { l: 0, r: 0 }])).to.equal(solved.length);
    const m = MISSIONS.rover;
    const lv = m.levels[0].id;
    expect(L.validateLabActions("rover", lv, [])).to.match(/no actions/);
    expect(L.validateLabActions("nope", lv, [{}])).to.match(/unknown/);
    expect(L.validateLabActions("rover", lv, Array(m.levels[0].maxSteps + 1).fill({ l: 0, r: 0 }))).to.match(/longer/);
    expect(L.validateLabActions("rover", lv, [{ l: Infinity }])).to.match(/bad field/);
    expect(L.validateLabActions("rover", lv, [JSON.parse('{"__proto__": {"x": 1}}')])).to.match(/bad field/);
    expect(L.validateLabActions("rover", lv, [{ l: "x".repeat(40) }])).to.match(/bad field/);
    expect(L.validateLabActions("rover", lv, [{ l: 0, r: 0, junk: 1 }])).to.match(/bad field/);
    expect(L.validateLabActions("rover", lv, [null])).to.match(/not an object/);
    expect(L.validateLabActions("so101", "reach", [[1, NaN]])).to.match(/joint vector/);
    expect(L.validateLabActions("so101", "reach", [[0, 0, 0, 0, 0, 0, 0]])).to.match(/joint vector/);
    // junk that passes the shape check still cannot crash the verifier: it is a failed run
    expect(L.scoreLabRun("rover", lv, 1, [{ l: "fast", r: true }]).outcome.success).to.equal(false);
    expect(L.labLevel("constructor", "x")).to.equal(null);
  });
});
