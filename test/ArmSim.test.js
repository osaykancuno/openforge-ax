const { expect } = require("chai");

describe("Proving Grounds arm sim (web/js/sim)", () => {
  let sim, autopilot;
  before(async () => {
    sim = await import("../web/js/sim/arm-sim.js");
    ({ autopilot } = await import("../web/js/sim/autopilot.js"));
  });

  const seed = (i) => "0x" + i.toString(16).padStart(8, "0").repeat(8);

  it("IK and FK agree within 0.1 mm across the mission workspace", () => {
    for (let i = 0; i < 300; i++) {
      const r = 0.15 + (i % 9) * 0.01;
      const a = -60 + (i % 13) * 10;
      const z = 0.016 + (i % 6) * 0.011;
      const target = { x: r * Math.cos((a * Math.PI) / 180), y: r * Math.sin((a * Math.PI) / 180), z };
      const j = sim.ik(target);
      expect(j, JSON.stringify(target)).to.not.equal(null);
      const { tip, pitch } = sim.fk(j);
      expect(Math.hypot(tip.x - target.x, tip.y - target.y, tip.z - target.z)).to.be.lessThan(1e-4);
      expect(pitch).to.be.within(130 - 1e-6, 230 + 1e-6);
    }
  });

  it("mission layouts and scenes are deterministic", () => {
    for (let i = 1; i <= 50; i++) {
      expect(sim.createMission(seed(i))).to.deep.equal(sim.createMission(seed(i)));
      expect(sim.sceneOf(seed(i)).cell.size).to.equal(sim.CELL);
    }
  });

  it("autopilot completes the mission on 100 seeds with valid commands; replay is deterministic", () => {
    for (let i = 1; i <= 100; i++) {
      const actions = autopilot(seed(i));
      expect(sim.validateActions(actions), `seed ${i}`).to.equal(null);
      const o1 = sim.replay(seed(i), actions);
      expect(o1.success, `seed ${i}: ${o1.reason}`).to.equal(true);
      expect(sim.replay(seed(i), actions)).to.deep.equal(o1);
      expect(sim.score(o1)).to.be.within(6000, 8500);
    }
  });

  it("recorded observation.state tracks commands (servo model)", () => {
    const actions = autopilot(seed(3));
    const { states } = sim.replay(seed(3), actions, { record: true });
    expect(states.length).to.equal(actions.length);
    states.forEach((st, t) => st.forEach((v, i) => expect(Math.abs(v - actions[t][i])).to.be.lessThan(0.06)));
  });

  it("validator rejects jumps, out-of-range values and bad precision", () => {
    expect(sim.validateActions([[10, -30, 90, 60, 0, 100]])).to.match(/step too large/);
    expect(sim.validateActions([[0, -30, 90, 60, 0, 101]])).to.match(/out of range/);
    expect(sim.validateActions([[0.05, -30, 90, 60, 0, 100]])).to.match(/precision/);
    expect(sim.validateActions([])).to.match(/bad length/);
    expect(sim.limitStep(sim.REST, [90, -30, 90, 60, 0, 100])[0]).to.equal(sim.MAX_CMD_STEP);
  });

  it("failures score by distinct event types (capped); idle runs score 0", () => {
    const idle = Array.from({ length: 60 }, () => sim.REST);
    const o = sim.replay(seed(2), idle);
    expect(o.success).to.equal(false);
    expect(sim.score(o)).to.equal(0);
    const target = sim.ik({ x: 0.2, y: 0.1, z: 0.05 });
    let cmd = sim.REST;
    const acts = [];
    for (const goal of [target, [...target.slice(0, 5), 0], [...target.slice(0, 5), 100], [...target.slice(0, 5), 0]]) {
      for (let k = 0; k < 40; k++) acts.push((cmd = sim.limitStep(cmd, goal)));
    }
    const o2 = sim.replay(seed(2), acts);
    expect(o2.events.misses).to.equal(2);
    expect(sim.score(o2)).to.equal(600); // repeated misses count once
  });
});
