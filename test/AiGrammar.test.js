const { expect } = require("chai");

// AI Pilot, built-in parser (web/js/pilot/ai/grammar.js): plain English to a validated plan with no model at all.
// Conventions (REP-103, as the twin's joints): turn / pan / torso yaw positive = LEFT, tilt positive = UP.
describe("AI Pilot grammar (web/js/pilot/ai/grammar.js)", () => {
  let G, T;
  before(async () => {
    G = await import("../web/js/pilot/ai/grammar.js");
    T = await import("../web/js/pilot/ai/tools.js");
  });

  /** Compact signature of a plan so a table row reads like the plan. */
  const sig = (steps) =>
    steps.map((s) => {
      switch (s.tool) {
        case "drive": return `drive:${s.direction}:${s.seconds}${s.speed < 100 ? `@${s.speed}` : ""}`;
        case "turn": return `turn:${s.degrees}${s.speed < 100 ? `@${s.speed}` : ""}`;
        case "look": return `look:${s.pan ?? "-"}:${s.tilt ?? "-"}`;
        case "wait": return `wait:${s.seconds}`;
        case "gesture": return `gesture:${s.name}`;
        case "pose": return `pose:${s.name}`;
        case "torso": return `torso:${s.yaw}`;
        case "set_joints": return `joints:${Object.entries(s.joints).map(([k, v]) => `${k}=${v}`).join(",")}`;
        default: return s.tool;
      }
    });
  const parse = (text, body) => G.parseCommand(text, body);

  describe("Rover", () => {
    const rows = [
      ["forward", ["drive:forward:1"]],
      ["Forward 2 s", ["drive:forward:2"]],
      ["FORWARD 2 S", ["drive:forward:2"]],
      ["forward 2s", ["drive:forward:2"]],
      ["go forward 2 seconds", ["drive:forward:2"]],
      ["please go forward for 2 seconds", ["drive:forward:2"]],
      ["forward 1.5 s", ["drive:forward:1.5"]],
      ["move ahead three seconds", ["drive:forward:3"]],
      ["go", ["drive:forward:1"]],
      ["back 3 sec", ["drive:back:3"]],
      ["backward", ["drive:back:1"]],
      ["reverse 2", ["drive:back:2"]],
      ["go back half a second", ["drive:back:0.5"]],
      ["drive forward left for 2 seconds", ["drive:forward_left:2"]],
      ["drive forward 2 seconds then turn right", ["drive:forward:2", "turn:-90"]],
      ["forward 2 seconds and then turn left", ["drive:forward:2", "turn:90"]],
      ["forward 1; back 1. turn left", ["drive:forward:1", "drive:back:1", "turn:90"]],
      ["forward, forward", ["drive:forward:1", "drive:forward:1"]],
      ["forward 2 s then turn left then look up", ["drive:forward:2", "turn:90", "look:-:20"]],
      ["turn left", ["turn:90"]],
      ["turn right 45 degrees", ["turn:-45"]],
      ["rotate left 180°", ["turn:180"]],
      ["spin right 30 deg", ["turn:-30"]],
      ["turn right 90", ["turn:-90"]],
      ["turn around", ["turn:180"]],
      ["look left", ["look:45:-"]],
      ["look right", ["look:-45:-"]],
      ["look up", ["look:-:20"]],
      ["look down", ["look:-:-20"]],
      ["look center", ["look:0:0"]],
      ["look centre", ["look:0:0"]],
      ["look left 30", ["look:30:-"]],
      ["pan -30", ["look:-30:-"]],
      ["pan 25", ["look:25:-"]],
      ["tilt 15", ["look:-:15"]],
      ["home", ["look:0:0"]],
      ["wait 2 seconds, forward", ["wait:2", "drive:forward:1"]],
      ["pause", ["wait:1"]],
      ["wait", ["wait:1"]],
      ["stop", ["stop"]],
      ["slow, forward 2 s", ["drive:forward:2@40"]],
      ["fast then forward", ["drive:forward:1"]],
      ["speed 50%, forward 2 s, turn left", ["drive:forward:2@50", "turn:90@50"]],
      ["slow then faster then forward", ["drive:forward:1@60"]],
      ["slower, forward", ["drive:forward:1@60"]],
      ["go forward slowly for 2 seconds", ["drive:forward:2@40"]],
    ];
    for (const [text, want] of rows) {
      it(`"${text}"`, () => {
        const r = parse(text, "rover");
        expect(sig(r.steps)).to.deep.equal(want);
        expect(r.unknown).to.deep.equal([]);
      });
    }

    it("clamps numbers and says so", () => {
      let r = parse("forward 10 s", "rover");
      expect(sig(r.steps)).to.deep.equal(["drive:forward:3"]);
      expect(r.say).to.match(/3 s/);
      r = parse("turn left 400", "rover");
      expect(sig(r.steps)).to.deep.equal(["turn:180"]);
      expect(r.say).to.match(/180/);
      r = parse("look left 200", "rover");
      expect(sig(r.steps)).to.deep.equal(["look:90:-"]);
      r = parse("wait 60", "rover");
      expect(sig(r.steps)).to.deep.equal(["wait:5"]);
      r = parse("speed 5%, forward", "rover");
      expect(sig(r.steps)).to.deep.equal(["drive:forward:1@10"]);
      r = parse("speed 900%, forward", "rover");
      expect(sig(r.steps)).to.deep.equal(["drive:forward:1"]);
    });

    it("body gating: the Rover has no arms, no legs, no neck gestures", () => {
      let r = parse("wave", "rover");
      expect(r.steps).to.deep.equal([]);
      expect(r.say).to.contain("The Rover has no arms.");
      r = parse("wave then forward 1", "rover");
      expect(sig(r.steps)).to.deep.equal(["drive:forward:1"]);
      expect(r.say).to.contain("The Rover has no arms.");
      expect(parse("crouch", "rover").say).to.contain("The Rover has no legs.");
      expect(parse("nod", "rover").say).to.match(/Rover/);
    });

    it("unknown words are reported, known clauses still run", () => {
      let r = parse("dance", "rover");
      expect(r.steps).to.deep.equal([]);
      expect(r.unknown).to.deep.equal(["dance"]);
      expect(r.say).to.match(/I didn't understand 'dance'\. Try: forward 2 s, turn left, look up/);
      r = parse("forward 1 then dance wildly", "rover");
      expect(sig(r.steps)).to.deep.equal(["drive:forward:1"]);
      expect(r.unknown).to.deep.equal(["dance wildly"]);
      r = parse("forward 1 meter", "rover");
      expect(r.unknown.length).to.equal(1);
      expect(r.say).to.match(/seconds/); // distances are not supported: drive by time
    });

    it("bad input never throws: empty, null, numbers, objects, emoji, huge", () => {
      for (const bad of ["", "   ", null, undefined, 42, {}, [], "...", ",,,;;;", "🎉🎉🎉", "\u0000​"]) {
        const r = parse(bad, "rover");
        expect(r.steps).to.deep.equal([]);
        expect(r.unknown).to.be.an("array");
        expect(r.say).to.be.a("string");
      }
      expect(sig(parse("forward 🎉", "rover").steps)).to.deep.equal(["drive:forward:1"]);
      const t0 = Date.now();
      const r = parse("forward 1, ".repeat(300), "rover");
      expect(r.steps.length).to.be.at.most(T.LIMITS.MAX_STEPS);
      expect(Date.now() - t0).to.be.lessThan(1000);
      expect(parse("x".repeat(100000), "rover").steps).to.deep.equal([]);
    });

    it("an unknown body behaves like no tools: nothing runs", () => {
      const r = parse("forward", "toaster");
      expect(r.steps).to.deep.equal([]);
    });
  });

  describe("Desk", () => {
    const rows = [
      ["wave", ["gesture:wave"]],
      ["nod", ["gesture:nod"]],
      ["point", ["gesture:point"]],
      ["shrug", ["gesture:shrug"]],
      ["home", ["gesture:home"]],
      ["hello", ["gesture:wave"]],
      ["wave then look left", ["gesture:wave", "look:45:-"]],
      ["wave and look left", ["gesture:wave", "look:45:-"]],
      ["wave, nod and shrug", ["gesture:wave", "gesture:nod", "gesture:shrug"]],
      ["look up", ["look:-:20"]],
      ["look down", ["look:-:-20"]],
      ["pan -30", ["look:-30:-"]],
      ["turn left", ["joints:torso_yaw=90"]],
      ["turn right 30", ["joints:torso_yaw=-30"]],
      ["wait 1 s then wave", ["wait:1", "gesture:wave"]],
      ["stop", ["stop"]],
    ];
    for (const [text, want] of rows) {
      it(`"${text}"`, () => {
        const r = parse(text, "desk");
        expect(sig(r.steps)).to.deep.equal(want);
        expect(r.unknown).to.deep.equal([]);
      });
    }
    it("clamps to the Desk joint table", () => {
      expect(sig(parse("turn left 500", "desk").steps)).to.deep.equal(["joints:torso_yaw=120"]);
      expect(sig(parse("pan 200", "desk").steps)).to.deep.equal(["look:100:-"]);
      expect(sig(parse("tilt -90", "desk").steps)).to.deep.equal(["look:-:-25"]);
    });
    it("body gating: no wheels, no legs", () => {
      expect(parse("forward 2", "desk").say).to.contain("The Desk has no wheels.");
      expect(parse("forward 2", "desk").steps).to.deep.equal([]);
      expect(parse("crouch", "desk").say).to.contain("The Desk has no legs.");
    });
    it("unknown", () => {
      const r = parse("moonwalk", "desk");
      expect(r.unknown).to.deep.equal(["moonwalk"]);
      expect(r.say).to.match(/Try: wave/);
    });
  });

  describe("Walker", () => {
    const rows = [
      ["stand", ["pose:stand"]],
      ["stand up", ["pose:stand"]],
      ["crouch", ["pose:crouch"]],
      ["lean left", ["pose:lean left"]],
      ["lean right", ["pose:lean right"]],
      ["twist", ["pose:twist"]],
      ["home", ["pose:stand"]],
      ["stand then crouch", ["pose:stand", "pose:crouch"]],
      ["turn left 30", ["torso:30"]],
      ["turn right", ["torso:-30"]],
      ["twist left 20", ["torso:20"]],
      ["turn left 200", ["torso:60"]],
      ["wait 2, stand", ["wait:2", "pose:stand"]],
      ["stop", ["stop"]],
    ];
    for (const [text, want] of rows) {
      it(`"${text}"`, () => {
        const r = parse(text, "walker");
        expect(sig(r.steps)).to.deep.equal(want);
        expect(r.unknown).to.deep.equal([]);
      });
    }
    it("body gating: poses only", () => {
      expect(parse("wave", "walker").say).to.contain("The Walker has no arms.");
      expect(parse("forward", "walker").say).to.match(/The Walker can't walk yet/);
      expect(parse("look up", "walker").say).to.match(/The Walker has no head/);
      expect(parse("forward", "walker").steps).to.deep.equal([]);
    });
  });

  it("every plan it returns passes validatePlan unchanged (same clamping, same allowlist)", () => {
    const samples = ["forward 2 then turn left 45 then look up then wait 1", "wave then nod", "stand then crouch", "forward 99", "stop"];
    for (const body of ["rover", "desk", "walker"])
      for (const text of samples) {
        const r = parse(text, body);
        const v = T.validatePlan(r.steps, body);
        expect(v.rejected, `${body}: ${text}`).to.deep.equal([]);
        expect(v.steps).to.deep.equal(r.steps);
      }
  });
});
