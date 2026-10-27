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

  // The other seven robots, played with their real controls: arrow pads held, toggles, pulses, slider steps, the Fab
  // Rig's 10 / 1 mm jog taps, the hints and numbers in the readout, and where things sit in the 3D scene.
  it("rovers, hound, hand, Fab Rig, AX-1 Desk and SO-101: a person passes every level within its time", () => {
    const RAD = Math.PI / 180, wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
    const SEEDS = 8;
    const report = (name, fn) => {
      for (let seed = 1; seed <= SEEDS; seed++) {
        const s = fn(seed);
        expect(s.success, `${name} seed ${seed}: ${s.reason || "timeout"}`).to.equal(true);
      }
    };
    const game = (m, lvl, seed) => {
      const s = m.init(lvl, seed);
      const ui = { held: {}, pulse: {}, mode: m.controls.find((c) => c.type === "mode")?.value };
      for (const c of m.controls) if (c.type === "slider") ui[c.id] = c.value ?? c.min;
      Object.assign(ui, m.uiDefaults(s));
      const lv = m.levels.find((l) => l.id === lvl);
      let n = 0;
      const run = (k) => {
        for (let i = 0; i < k && !s.done && n < lv.maxSteps; i++, n++) {
          m.step(s, m.toAction(ui, s) ?? m.idle(s), m.dt);
          ui.pulse = {};
        }
      };
      return { s, ui, run };
    };

    // ---- rovers: hold the arrow buttons, look every 0.2 s
    for (const id of ["rover", "ax1-rover"]) {
      const m = MISSIONS[id];
      const driveTo = (g, p, { stop = true } = {}) => {
        const { s, ui, run } = g;
        for (let k = 0; k < 400 && !s.done; k++) {
          const d = Math.hypot(p.x - s.x, p.z - s.z);
          const e = wrap(Math.atan2(p.x - s.x, p.z - s.z) - s.heading) / RAD;
          ui.held = {};
          if (d < (stop ? 0.12 : 0.06)) { run(stop ? 15 : 0); return; }
          if (Math.abs(e) > 15) ui.held[e > 0 ? "left" : "right"] = true;
          else { ui.held.up = true; if (Math.abs(e) > 5) ui.held[e > 0 ? "left" : "right"] = true; }
          run(6);
        }
      };
      const face = (g, h) => { const { s, ui, run } = g; for (let k = 0; k < 100 && !s.done; k++) { const e = wrap(h - s.heading) / RAD; ui.held = {}; if (Math.abs(e) < 6) break; ui.held[e > 0 ? "left" : "right"] = true; run(Math.abs(e) > 25 ? 6 : 2); ui.held = {}; run(4); } ui.held = {}; };
      report(`${id}/cone`, (seed) => { const g = game(m, "cone", seed); const c = g.s.cones[0]; const d = Math.hypot(c.x, c.z); driveTo(g, { x: c.x * (1 - 0.2 / d), z: c.z * (1 - 0.2 / d) }); g.ui.held = {}; g.run(60); return g.s; });
      report(`${id}/slalom`, (seed) => { const g = game(m, "slalom", seed); for (const gt of g.s.gates) driveTo(g, { x: gt.x + gt.side * 0.3, z: gt.z }, { stop: false }); driveTo(g, { x: 0, z: g.s.finishZ + 0.3 }, { stop: false }); g.ui.held = {}; g.run(60); return g.s; });
      report(`${id}/park`, (seed) => {
        const g = game(m, "park", seed); const b = g.s.box;
        const dir = { x: Math.sin(b.heading), z: Math.cos(b.heading) };
        driveTo(g, { x: b.x - dir.x * 0.5, z: b.z - dir.z * 0.5 });
        face(g, b.heading);
        driveTo(g, { x: b.x, z: b.z });
        face(g, b.heading);
        g.ui.held = {}; g.run(60); return g.s;
      });
    }

    // ---- hound
    {
      const m = MISSIONS.hound;
      report("hound/stand", (seed) => {
        const g = game(m, "stand", seed); const { s, ui, run } = g;
        // follow the readout's "next:" hint, 5° (and 10° of bend) per move, 0.4 s to look again
        for (let k = 0; k < 80 && !s.done; k++) {
          const r = m.readout(s);
          if (/hold it/.test(r)) { run(12); continue; }
          if (/knee bend \+$/.test(r)) ui.bend += 5;
          else if (/knee bend −$/.test(r)) ui.bend -= 5;
          else if (/thigh − and/.test(r)) (ui.thigh -= 5), (ui.bend -= 10);
          else if (/thigh \+ and/.test(r)) (ui.thigh += 5), (ui.bend += 10);
          ui.thigh = Math.max(0, Math.min(90, ui.thigh)); ui.bend = Math.max(0, Math.min(150, ui.bend));
          run(12);
        }
        run(60); return s;
      });
      report("hound/trot", (seed) => { const g = game(m, "trot", seed); g.ui.trot = true; g.run(1200); return g.s; });
      report("hound/turn", (seed) => {
        const g = game(m, "turn", seed); const { s, ui, run } = g;
        ui.turn = s.goal > 0 ? 1 : -1; ui.trot = true;
        for (let k = 0; k < 300 && !s.done; k++) { if (Math.abs(wrap(s.goal - s.heading)) < 10 * RAD) break; run(6); }
        ui.trot = false; run(120); return s;
      });
    }

    // ---- hand
    {
      const m = MISSIONS.hand;
      report("hand/pinch", (seed) => { const g = game(m, "pinch", seed); g.ui.c4 = 65; g.run(10); g.ui.c0 = 55; g.run(90); return g.s; });
      report("hand/power", (seed) => { const g = game(m, "power", seed); for (let i = 0; i < 5; i++) (g.ui[`c${i}`] = 100), g.run(6); g.run(90); return g.s; });
      report("hand/count", (seed) => {
        const g = game(m, "count", seed);
        const set = (up) => { for (let i = 0; i < 5; i++) (g.ui[`c${i}`] = up.includes(i) ? 0 : 90), g.run(4); g.run(40); };
        set([0]); set([0, 1]); set([0, 1, 2]); g.run(30); return g.s;
      });
    }

    // ---- fab: taps on the jog pad (10 mm / 1 mm), pulses, the extrude toggle
    {
      const m = MISSIONS.fab;
      const tap = (g, id, n = 1) => { for (let i = 0; i < n; i++) { g.ui.held[id] = true; g.run(3); g.ui.held[id] = false; g.run(4); } };
      const goTo = (g, x, y) => {
        for (const [ax, plus, minus, to] of [["x", "xp", "xm", x], ["y", "yp", "ym", y]]) {
          for (const step of ["10", "1"]) {
            g.ui.mode = step;
            const n = Math.trunc(Math.round(to - g.s[ax]) / +step);
            tap(g, n > 0 ? plus : minus, Math.abs(n));
            g.run(Math.abs(n) * +step * 1.6 + 6);
          }
        }
        g.ui.mode = "10";
      };
      const square = (g) => {
        const { x, y } = g.s.sq;
        goTo(g, x, y);
        g.ui.ext = true; g.run(3);
        for (const [id, wait] of [["xp", 70], ["yp", 70], ["xm", 70], ["ym", 70]]) { tap(g, id, 4); g.run(wait); }
        g.ui.ext = false; g.run(30);
      };
      report("fab/home", (seed) => { const g = game(m, "home", seed); for (const ax of ["X", "Y", "Z"]) { g.ui.pulse[`home${ax}`] = true; g.run(1); for (let k = 0; k < 200 && g.s.homing; k++) g.run(6); g.run(10); } g.run(30); return g.s; });
      report("fab/square", (seed) => { const g = game(m, "square", seed); g.ui.pulse.gotoZ = true; g.run(10); square(g); return g.s; });
      report("fab/layer", (seed) => {
        const g = game(m, "layer", seed); g.ui.pulse.gotoZ = true; g.run(10);
        for (let k = 0; k < 20; k++) { const r = m.readout(g.s); if (/light drag/.test(r)) break; g.ui.pulse[/too close|scraping|crashed/.test(r) ? "babyUp" : "babyDown"] = true; g.run(10); }
        square(g); return g.s;
      });
    }

    // ---- AX-1 Desk: sliders, reading the gaze / pointing numbers
    {
      const m = MISSIONS["ax1-desk"];
      report("ax1-desk/look", (seed) => { const g = game(m, "look", seed); const t = g.s.target; g.ui.torso = Math.round(t.az / 2); g.run(15); g.ui.pan = t.az - g.ui.torso; g.run(15); g.ui.tilt = t.el; g.run(60); return g.s; });
      report("ax1-desk/wave", (seed) => { const g = game(m, "wave", seed); g.ui.rsh = 130; g.run(40); for (let i = 0; i < 5; i++) { g.ui.rel = 70; g.run(25); g.ui.rel = 10; g.run(25); } return g.s; });
      report("ax1-desk/point", (seed) => {
        const g = game(m, "point", seed);
        for (let k = 0; k < 3 && !g.s.done; k++) { const o = g.s.objects[g.s.order[k]]; g.ui.rel = 0; g.ui.torso = o.az; g.run(15); g.ui.rsh = 90 + o.el; g.run(45); }
        g.run(30); return g.s;
      });
    }

    // ---- SO-101: tip sliders (0.5 cm), the gripper slider, the "nearest cube" / "marker" readouts
    {
      const m = MISSIONS.so101;
      const r05 = (v) => Math.round(v * 2) / 2;
      const moveTip = (g, p) => { g.ui.tx = r05(p.x * 100); g.ui.ty = r05(-p.y * 100); g.ui.tz = r05(p.z * 100); g.run(45); };
      report("so101/reach", (seed) => { const g = game(m, "reach", seed); moveTip(g, g.s.target); g.run(60); return g.s; });
      const carry = (g, cube, to, dropZ) => {
        g.ui.grip = 100; moveTip(g, { ...cube, z: 0.07 }); moveTip(g, { ...cube, z: 0.016 });
        g.ui.grip = 0; g.run(30);
        moveTip(g, { ...cube, z: 0.09 }); moveTip(g, { ...to, z: 0.09 }); moveTip(g, { ...to, z: dropZ });
        g.ui.grip = 100; g.run(60);
      };
      report("so101/place", (seed) => { const g = game(m, "place", seed); carry(g, { ...g.s.cubes[0] }, g.s.dock, 0.04); return g.s; });
      report("so101/stack", (seed) => { const g = game(m, "stack", seed); carry(g, { ...g.s.cubes[1] }, { ...g.s.cubes[0] }, 0.03 * 1.5 + 0.012); return g.s; });
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
