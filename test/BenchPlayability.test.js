const { expect } = require("chai");

// The Workbench missions played the way a person plays them: one control at a time, a reaction time, and only what
// the screen shows (readout, hints). The scripted solutions in Bench.test.js prove a level can be passed; these prove
// a visitor can pass it, and that every control visibly does something.
describe("Workbench missions: human playability", function () {
  this.timeout(120000);
  let MISSIONS, fk;
  before(async () => {
    ({ MISSIONS } = await import("../web/js/bench/missions/index.js"));
    ({ fk } = await import("../web/js/sim/arm-sim.js"));
  });
  const RAD = Math.PI / 180;
  const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
  const player = (m, s, ui) => (n) => {
    for (let i = 0; i < n && !s.done; i++) m.step(s, m.toAction(ui, s) ?? m.idle(s), m.dt);
  };

  it("no level is passed by doing nothing (100 layouts each)", () => {
    for (const [id, m] of Object.entries(MISSIONS))
      for (const lv of m.levels)
        for (let seed = 0; seed < 100; seed++) {
          const s = m.init(lv.id, seed);
          const r = m.score({ level: lv.id, seed, actions: Array.from({ length: lv.maxSteps }, () => m.idle(s)) });
          expect(r.pass, `${id}/${lv.id} seed ${seed}`).to.equal(false);
        }
  });

  it("SO-101: every tip slider dragged to either end moves the arm (out of reach goes as far as it can)", () => {
    const m = MISSIONS.so101;
    for (const lvl of ["reach", "place", "stack"])
      for (const k of ["tx", "ty", "tz"])
        for (const end of ["min", "max"]) {
          const c = m.controls.find((x) => x.id === k);
          const s = m.init(lvl, 3);
          const ui = { mode: "tip", ...m.uiDefaults(s), [k]: c[end] };
          const before = fk(s.joints).tip;
          player(m, s, ui)(60);
          const after = fk(s.joints).tip;
          expect(Math.hypot(after.x - before.x, after.y - before.y, after.z - before.z), `${lvl} ${k}=${end}`).to.be.greaterThan(0.005);
        }
  });

  it("Spider: one natural tripod step passes level 1, and a swing with all feet down says why nothing moves", () => {
    const m = MISSIONS.spider;
    const s = m.init("step", 1);
    const ui = m.uiDefaults(s);
    const run = player(m, s, ui);
    ui.swing = 20;
    run(15);
    expect(s.z).to.equal(0);
    expect(m.readout(s)).to.match(/lift a tripod before you swing/);
    ui.swing = 0;
    run(15);
    Object.assign(ui, { liftB: true }), run(10);
    Object.assign(ui, { swing: 20 }), run(15);
    Object.assign(ui, { liftB: false }), run(20);
    expect(s.success, s.reason).to.equal(true);
  });

  it("Bipeds: a person following the TIPPING hints passes every level", () => {
    for (const id of ["replicant", "ax1-walker"]) {
      const m = MISSIONS[id];
      for (const lv of m.levels)
        for (let seed = 1; seed <= 12; seed++) {
          const s = m.init(lv.id, seed);
          const ui = { ...m.uiDefaults(s) };
          const run = player(m, s, ui);
          for (let move = 0; move < 80 && !s.done; move++) {
            // one slider toward the goal shown in the readout, finer near it
            if (lv.id === "squat") (s.metrics.hipPct ?? 100) > 70 && (ui.knee += (s.metrics.hipPct ?? 100) < 76 ? 4 : 10);
            else if (lv.id === "lean") (s.metrics.comPct ?? 0) < 70 && (ui.ankle += 5);
            else if (s.body.com.lat < 0.02 && ui.shift < 15) ui.shift += 2;
            else ui.lift = Math.min(60, ui.lift + 10);
            run(12); // 0.4 s to react
            for (let c = 0; c < 12 && !s.done; c++) {
              const t = /TIPPING (\w+): (ankle|hip pitch|weight shift) ([+−])/.exec(m.readout(s));
              if (!t) break;
              const k = { ankle: "ankle", "hip pitch": "lean", "weight shift": "shift" }[t[2]];
              ui[k] += (t[3] === "+" ? 1 : -1) * (k === "shift" ? 1 : 5);
              run(4);
            }
            run(12);
          }
          run(90);
          expect(s.success, `${id}/${lv.id} seed ${seed}: ${s.reason}`).to.equal(true);
        }
    }
  });

  it("Bipeds: an uncorrected slip falls, but not before the warning had time to be read", () => {
    const m = MISSIONS.replicant;
    const s = m.init("squat", 3);
    const ui = { ...m.uiDefaults(s), knee: s.pose.knee + 25 };
    const run = player(m, s, ui);
    let firstOut = null;
    for (let i = 0; i < 90 && !s.done; i++) {
      run(1);
      if (firstOut == null && s.body.margin < 0) firstOut = s.t;
    }
    expect(firstOut).to.not.equal(null);
    expect(s.reason).to.equal("fell_over");
    expect(s.t - firstOut).to.be.greaterThan(0.6);
  });

  it("Drone: altitude hold keeps the height with the climb slider at 0, and a person flies yaw and ring", () => {
    const m = MISSIONS.drone;
    expect(m.controls.find((c) => c.id === "thr").levels).to.deep.equal(["hover"]);
    const still = m.init("ring", 2);
    player(m, still, { held: {}, ...m.uiDefaults(still) })(150);
    expect(Math.abs(still.y - 1)).to.be.lessThan(0.05);
    for (const lvl of ["yaw", "ring"])
      for (let seed = 1; seed <= 12; seed++) {
        const s = m.init(lvl, seed);
        const ui = { held: {}, ...m.uiDefaults(s) };
        const run = player(m, s, ui);
        for (let k = 0; k < 400 && !s.done; k++) {
          const want = lvl === "yaw" ? s.goalYaw : Math.atan2(s.ring.x - s.x, s.ring.z - s.z);
          const e = wrap(want - s.yaw) / RAD;
          ui.held = {};
          const far = Math.abs(e) > 25, near = Math.abs(e) > 3 && Math.abs(s.yawRate) < 8 * RAD;
          if ((far && Math.abs(s.yawRate) < 60 * RAD) || near) ui.held[e > 0 ? "yawL" : "yawR"] = true;
          if (!far && near) run(2), (ui.held = {});
          if (lvl === "ring") {
            const dy = s.ring.y - s.y;
            ui.climb = Math.abs(dy) > 0.08 ? Math.sign(dy) * 0.3 : 0;
            if (Math.abs(e) < 10 && Math.abs(dy) < 0.12) ui.held.fwd = true;
          }
          run(6);
        }
        run(60);
        expect(s.success, `drone/${lvl} seed ${seed}: ${s.reason}`).to.equal(true);
      }
  });

  it("Fab Rig: a refused command keeps its reason on screen long enough to read", () => {
    const m = MISSIONS.fab;
    const s = m.init("home", 1);
    m.step(s, m.toAction({ held: {}, pulse: { homeZ: true } }, s), m.dt);
    for (let i = 0; i < 60; i++) m.step(s, m.toAction({ held: {}, pulse: {} }, s), m.dt);
    expect(m.readout(s)).to.match(/Home X and Y first/);
  });
});
