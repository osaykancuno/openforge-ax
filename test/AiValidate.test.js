const { expect } = require("chai");

// AI Pilot, tool allowlist and plan validation (web/js/pilot/ai/tools.js). Model output is untrusted: whatever
// comes in, what comes out is a short, clamped plan made only of the tools the body offers.
describe("AI Pilot tools + validatePlan (web/js/pilot/ai/tools.js)", () => {
  let T, P, M;
  before(async () => {
    T = await import("../web/js/pilot/ai/tools.js");
    P = await import("../web/js/pilot/ax-proto.js");
    M = await import("../web/js/pilot/motions.js");
  });
  const names = (body) => T.toolsFor(body).map((t) => t.function.name);
  const BODIES = ["rover", "desk", "walker"];

  describe("toolsFor", () => {
    it("OpenAI function specs, per body", () => {
      expect(names("rover")).to.have.members(["wait", "say", "stop", "drive", "turn", "look"]);
      expect(names("desk")).to.have.members(["wait", "say", "stop", "set_joints", "gesture", "look"]);
      expect(names("walker")).to.have.members(["wait", "say", "stop", "pose", "torso"]);
      for (const b of BODIES)
        for (const t of T.toolsFor(b)) {
          expect(t.type).to.equal("function");
          expect(t.function.description).to.be.a("string").with.length.above(10);
          expect(t.function.parameters.type).to.equal("object");
          expect(t.function.parameters.additionalProperties).to.equal(false);
        }
      expect(T.toolsFor("toaster")).to.deep.equal([]);
    });

    it("never offers arm, connect, config, limits, relax or anything that reaches the network", () => {
      const banned = /arm|connect|config|limit|relax|url|fetch|http|eval|speed_cap|set_speed|setspeed|bluetooth|pair/i;
      for (const b of BODIES) for (const n of names(b)) expect(n, `${b}:${n}`).to.not.match(banned);
      // nor a free-form parameter that could carry a URL or code: the only string parameters are say.text and enums
      for (const b of BODIES)
        for (const t of T.toolsFor(b))
          for (const [k, p] of Object.entries(t.function.parameters.properties))
            if (p.type === "string" && !p.enum) expect(`${t.function.name}.${k}`).to.equal("say.text");
    });

    it("ranges come from the ax-proto BODIES tables", () => {
      const look = (b) => T.toolsFor(b).find((t) => t.function.name === "look").function.parameters.properties;
      for (const [key, body] of [["rover", P.BODY.ROVER], ["desk", P.BODY.DESK]]) {
        const j = (n) => P.BODIES[body].joints.find((x) => x.name === n);
        expect(look(key).pan.minimum).to.equal(j("head_pan").min / 10);
        expect(look(key).pan.maximum).to.equal(j("head_pan").max / 10);
        expect(look(key).tilt.minimum).to.equal(j("head_tilt").min / 10);
        expect(look(key).tilt.maximum).to.equal(j("head_tilt").max / 10);
      }
      const sj = T.toolsFor("desk").find((t) => t.function.name === "set_joints").function.parameters.properties;
      expect(Object.keys(sj)).to.have.members(["torso_yaw", "head_pan", "head_tilt", "l_shoulder", "r_shoulder", "l_elbow", "r_elbow"]);
      expect(sj.l_elbow.maximum).to.equal(0);
      const torso = T.toolsFor("walker").find((t) => t.function.name === "torso").function.parameters.properties;
      expect([torso.yaw.minimum, torso.yaw.maximum]).to.deep.equal([-60, 60]);
      const drive = T.toolsFor("rover").find((t) => t.function.name === "drive").function.parameters.properties;
      expect(drive.direction.enum).to.have.members(["forward", "back", "left", "right", "forward_left", "forward_right"]);
      expect([drive.seconds.minimum, drive.seconds.maximum]).to.deep.equal([0.1, 3]);
      expect([drive.speed.minimum, drive.speed.maximum]).to.deep.equal([10, 100]);
      const pose = T.toolsFor("walker").find((t) => t.function.name === "pose").function.parameters.properties;
      expect(pose.name.enum).to.have.members(Object.keys(M.POSES));
      const g = T.toolsFor("desk").find((t) => t.function.name === "gesture").function.parameters.properties;
      expect(g.name.enum).to.have.members(Object.keys(M.GESTURES));
    });
  });

  describe("validatePlan", () => {
    const one = (raw, body = "rover") => T.validatePlan([raw], body);

    it("accepts the documented shapes: flat, args object, args JSON string, OpenAI function call", () => {
      const want = [{ tool: "drive", direction: "forward", seconds: 1.5, speed: 100 }];
      expect(one({ tool: "drive", direction: "forward", seconds: 1.5 }).steps).to.deep.equal(want);
      expect(one({ tool: "drive", args: { direction: "forward", seconds: 1.5 } }).steps).to.deep.equal(want);
      expect(one({ name: "drive", arguments: '{"direction":"forward","seconds":1.5}' }).steps).to.deep.equal(want);
      expect(one({ type: "function", function: { name: "drive", arguments: '{"direction":"forward","seconds":"1.5"}' } }).steps).to.deep.equal(want);
      expect(T.validatePlan({ say: "ok", steps: [{ tool: "drive", direction: "forward", seconds: 1.5 }] }, "rover").steps).to.deep.equal(want);
    });

    it("fills defaults and normalises names", () => {
      expect(one({ tool: "DRIVE ", direction: " Forward " }).steps).to.deep.equal([{ tool: "drive", direction: "forward", seconds: 1, speed: 100 }]);
      expect(one({ tool: "drive", direction: "backward", seconds: 1 }).steps[0].direction).to.equal("back");
      expect(one({ tool: "pose", name: "lean_left" }, "walker").steps).to.deep.equal([{ tool: "pose", name: "lean left" }]);
      expect(one({ tool: "set_joints", torso_yaw: 10, r_elbow: -40 }, "desk").steps).to.deep.equal([{ tool: "set_joints", joints: { torso_yaw: 10, r_elbow: -40 } }]);
      expect(one({ tool: "look", pan: 30 }, "desk").steps).to.deep.equal([{ tool: "look", pan: 30 }]);
    });

    it("clamps numbers into the tool and body ranges", () => {
      expect(one({ tool: "drive", direction: "forward", seconds: 1e9, speed: 1e9 }).steps[0]).to.include({ seconds: 3, speed: 100 });
      expect(one({ tool: "drive", direction: "forward", seconds: -5, speed: -5 }).steps[0]).to.include({ seconds: 0.1, speed: 10 });
      expect(one({ tool: "turn", degrees: 1e9 }).steps[0].degrees).to.equal(180);
      expect(one({ tool: "turn", degrees: -1e9 }).steps[0].degrees).to.equal(-180);
      expect(one({ tool: "wait", seconds: 1e9 }).steps[0].seconds).to.equal(5);
      expect(one({ tool: "wait", seconds: 0 }).steps[0].seconds).to.equal(0.1);
      expect(one({ tool: "look", pan: 1e9, tilt: -1e9 }).steps[0]).to.include({ pan: 90, tilt: -30 });
      expect(one({ tool: "look", pan: 1e9, tilt: -1e9 }, "desk").steps[0]).to.include({ pan: 100, tilt: -25 });
      expect(one({ tool: "torso", yaw: 1e9 }, "walker").steps[0].yaw).to.equal(60);
      const j = one({ tool: "set_joints", torso_yaw: 1e9, l_elbow: 1e9, r_shoulder: -1e9, head_tilt: 1e9 }, "desk").steps[0].joints;
      expect(j).to.deep.equal({ torso_yaw: 120, l_elbow: 0, r_shoulder: -170, head_tilt: 35 });
    });

    it("rejects NaN, Infinity, non-numeric strings, objects and booleans instead of guessing", () => {
      for (const bad of [NaN, Infinity, -Infinity, "abc", "", "  ", {}, [], true, null, "1e9999", "0x10", "2 seconds"]) {
        const r = one({ tool: "wait", seconds: bad });
        expect(r.steps, String(bad)).to.deep.equal([]);
        expect(r.rejected).to.have.length(1);
      }
      expect(one({ tool: "wait", seconds: "2" }).steps[0].seconds).to.equal(2);
      expect(one({ tool: "wait", seconds: " 2.5 " }).steps[0].seconds).to.equal(2.5);
      expect(one({ tool: "wait" }).steps, "required").to.deep.equal([]);
      expect(one({ tool: "turn" }).steps, "required").to.deep.equal([]);
      expect(one({ tool: "look" }, "desk").steps, "look needs pan or tilt").to.deep.equal([]);
      expect(one({ tool: "set_joints" }, "desk").steps, "set_joints needs a joint").to.deep.equal([]);
    });

    it("rejects unknown tools, including arm and connect, and tools the body does not have", () => {
      for (const t of ["arm", "connect", "disconnect", "config", "set_limit", "relax", "setSpeed", "set_speed", "fetch", "eval", "exec", "http", "navigate", "constructor", "__proto__", "toString", "", " ", 42, null, {}, ["drive"]]) {
        const r = one({ tool: t, direction: "forward" });
        expect(r.steps, String(t)).to.deep.equal([]);
        expect(r.rejected).to.have.length(1);
      }
      // a body only gets its own tools
      expect(one({ tool: "drive", direction: "forward" }, "desk").steps).to.deep.equal([]);
      expect(one({ tool: "gesture", name: "wave" }, "rover").steps).to.deep.equal([]);
      expect(one({ tool: "pose", name: "stand" }, "rover").steps).to.deep.equal([]);
      expect(one({ tool: "turn", degrees: 10 }, "walker").steps).to.deep.equal([]);
      expect(one({ tool: "drive", direction: "forward" }, "toaster").steps).to.deep.equal([]);
    });

    it("rejects enum values outside the list", () => {
      expect(one({ tool: "drive", direction: "up" }).steps).to.deep.equal([]);
      expect(one({ tool: "drive", direction: "forward; arm()" }).steps).to.deep.equal([]);
      expect(one({ tool: "gesture", name: "backflip" }, "desk").steps).to.deep.equal([]);
      expect(one({ tool: "pose", name: "run" }, "walker").steps).to.deep.equal([]);
      expect(one({ tool: "gesture", name: { toString: () => "wave" } }, "desk").steps).to.deep.equal([]);
    });

    it("drops unknown fields and unknown joints: only allowed fields survive", () => {
      const s = one({ tool: "drive", direction: "forward", seconds: 1, speed: 50, url: "http://evil", arm: true, __proto__: { x: 1 }, constructor: "x" }).steps[0];
      expect(Object.keys(s).sort()).to.deep.equal(["direction", "seconds", "speed", "tool"]);
      const j = one({ tool: "set_joints", torso_yaw: 5, l_hip_pitch: 40, evil: 1, "__proto__": 2 }, "desk").steps[0];
      expect(j.joints).to.deep.equal({ torso_yaw: 5 });
      expect(({}).x, "no prototype pollution").to.equal(undefined);
      const parsed = JSON.parse('{"tool":"drive","direction":"forward","__proto__":{"polluted":true}}');
      T.validatePlan([parsed], "rover");
      expect(({}).polluted).to.equal(undefined);
    });

    it("say: plain text, control characters stripped, 200 characters at most, HTML kept inert as text", () => {
      const html = '<img src=x onerror="alert(1)"><script>fetch("//evil")</script>';
      const s = one({ tool: "say", text: html + "x".repeat(500) }).steps[0];
      expect(s.text).to.be.a("string");
      expect(s.text.length).to.be.at.most(200);
      expect(s.text.startsWith(html.slice(0, 20))).to.equal(true); // untouched text: the UI renders it with textContent only
      expect(one({ tool: "say", text: "a\u0000b\u0007c‮d" }).steps[0].text).to.equal("abcd");
      expect(one({ tool: "say", text: 123 }).steps).to.deep.equal([]);
      expect(one({ tool: "say", text: "" }).steps).to.deep.equal([]);
      expect(one({ tool: "say", text: "   " }).steps).to.deep.equal([]);
      expect(one({ tool: "say", text: "hi", url: "http://x" }).steps[0]).to.deep.equal({ tool: "say", text: "hi" });
    });

    it("500 steps: 12 at most, and the rest is reported once instead of flooding", () => {
      const raw = Array.from({ length: 500 }, () => ({ tool: "drive", direction: "forward", seconds: 0.1 }));
      const r = T.validatePlan(raw, "rover");
      expect(r.steps).to.have.length(12);
      expect(r.rejected.length).to.be.at.most(3);
      expect(r.rejected.map((x) => x.reason).join(" ")).to.match(/12/);
    });

    it("500 junk entries cost nothing and return nothing", () => {
      const raw = Array.from({ length: 500 }, (_, i) => (i % 2 ? { tool: "arm" } : "drive"));
      const t0 = Date.now();
      const r = T.validatePlan(raw, "rover");
      expect(r.steps).to.deep.equal([]);
      expect(r.rejected.length).to.be.at.most(30);
      expect(Date.now() - t0).to.be.lessThan(500);
    });

    it("30 seconds in total: later steps are dropped with a reason", () => {
      const raw = Array.from({ length: 12 }, () => ({ tool: "drive", direction: "forward", seconds: 3 }));
      const r = T.validatePlan(raw, "rover");
      const total = r.steps.reduce((a, s) => a + T.stepSeconds(s), 0);
      expect(total).to.be.at.most(30);
      expect(r.steps).to.have.length(10);
      expect(r.rejected.some((x) => /30 s/.test(x.reason))).to.equal(true);
      expect(T.validatePlan(Array.from({ length: 12 }, () => ({ tool: "wait", seconds: 5 })), "rover").steps).to.have.length(6);
    });

    it("stop ends the plan: nothing after it survives", () => {
      const r = T.validatePlan([{ tool: "drive", direction: "forward" }, { tool: "stop" }, { tool: "drive", direction: "back" }], "rover");
      expect(r.steps.map((s) => s.tool)).to.deep.equal(["drive", "stop"]);
      expect(r.rejected).to.have.length(1);
    });

    it("garbage in, empty plan out, never an exception", () => {
      for (const raw of [null, undefined, 42, "drive forward", true, {}, [], [null], [undefined], [[]], [1, 2, 3], { steps: "x" }, { steps: null }, Symbol.iterator && {}, () => 1]) {
        const r = T.validatePlan(raw, "rover");
        expect(r.steps).to.deep.equal([]);
        expect(r.rejected).to.be.an("array");
      }
      // a getter that throws, a circular object and a Proxy that throws on every access
      const evil = { get tool() { throw new Error("boom"); } };
      expect(T.validatePlan([evil], "rover").steps).to.deep.equal([]);
      const circ = { tool: "wait", seconds: 1 };
      circ.self = circ;
      expect(T.validatePlan([circ], "rover").steps).to.have.length(1);
      const px = new Proxy({}, { get() { throw new Error("proxy"); }, has() { throw new Error("proxy"); }, ownKeys() { throw new Error("proxy"); } });
      expect(T.validatePlan([px], "rover").steps).to.deep.equal([]);
    });

    it("rejected entries are short plain strings (safe to show)", () => {
      const r = one({ tool: "x".repeat(10000) });
      expect(r.rejected[0].reason.length).to.be.at.most(120);
      expect(r.rejected[0].reason).to.be.a("string");
    });

    it("fuzz: random junk never yields a step outside the allowlist or outside the ranges", () => {
      let seed = 12345;
      const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
      const pick = (a) => a[Math.floor(rnd() * a.length)];
      const vals = [NaN, Infinity, -1e9, 1e9, 0, 1, -1, 2.5, "3", "x", "", null, undefined, true, {}, [], "forward", "wave", "stand", "<b>", "\u0000"];
      const toolNames = ["drive", "turn", "look", "wait", "say", "stop", "set_joints", "gesture", "pose", "torso", "arm", "connect", "relax"];
      const keys = ["direction", "seconds", "speed", "degrees", "pan", "tilt", "text", "name", "yaw", "torso_yaw", "head_pan", "r_elbow", "url"];
      for (let n = 0; n < 3000; n++) {
        const step = { tool: pick(toolNames) };
        for (let k = 0; k < 4; k++) step[pick(keys)] = pick(vals);
        const body = pick(BODIES);
        const { steps } = T.validatePlan([step, step], body);
        const allowed = new Set(names(body));
        for (const s of steps) {
          expect(allowed.has(s.tool)).to.equal(true);
          for (const [k, v] of Object.entries(s)) if (typeof v === "number") expect(Number.isFinite(v), `${s.tool}.${k}`).to.equal(true);
          if (s.tool === "drive") expect(s.seconds).to.be.within(0.1, 3), expect(s.speed).to.be.within(10, 100);
          if (s.tool === "turn") expect(s.degrees).to.be.within(-180, 180);
          if (s.tool === "wait") expect(s.seconds).to.be.within(0.1, 5);
          if (s.tool === "say") expect(s.text.length).to.be.within(1, 200);
        }
      }
    });
  });

  describe("durations", () => {
    it("stepSeconds and turnSeconds", () => {
      expect(T.stepSeconds({ tool: "wait", seconds: 2 })).to.equal(2);
      expect(T.stepSeconds({ tool: "drive", direction: "forward", seconds: 1.5, speed: 100 })).to.equal(1.5);
      expect(T.stepSeconds({ tool: "say", text: "x" })).to.equal(0);
      expect(T.stepSeconds({ tool: "stop" })).to.equal(0);
      expect(T.stepSeconds({ tool: "gesture", name: "wave" })).to.be.above(4.5);
      // open loop: 200 deg/s at full stick and 100 % user speed
      expect(T.turnSeconds(90, 100, 100)).to.be.closeTo(0.45, 1e-9);
      expect(T.turnSeconds(-90, 100, 50)).to.be.closeTo(0.9, 1e-9);
      expect(T.turnSeconds(90, 50, 100)).to.be.closeTo(0.9, 1e-9);
      expect(T.turnSeconds(0, 100, 100)).to.equal(0);
      expect(T.turnSeconds(180, 10, 5)).to.be.at.most(9);
    });

    it("describeStep reads like English", () => {
      expect(T.describeStep({ tool: "drive", direction: "forward", seconds: 2, speed: 100 })).to.equal("drive forward 2 s");
      expect(T.describeStep({ tool: "drive", direction: "back", seconds: 1, speed: 50 })).to.equal("drive back 1 s at 50%");
      expect(T.describeStep({ tool: "turn", degrees: 90, speed: 100 })).to.equal("turn left about 90°");
      expect(T.describeStep({ tool: "turn", degrees: -45, speed: 100 })).to.equal("turn right about 45°");
      expect(T.describeStep({ tool: "look", pan: 30, tilt: -10 })).to.equal("look left 30°, down 10°");
      expect(T.describeStep({ tool: "gesture", name: "wave" })).to.equal("gesture: wave");
      expect(T.describeStep({ tool: "pose", name: "crouch" })).to.equal("pose: crouch");
      expect(T.describeStep({ tool: "wait", seconds: 2 })).to.equal("wait 2 s");
      expect(T.describeStep({ tool: "stop" })).to.equal("stop");
      expect(T.describeStep({ tool: "say", text: "hello there" })).to.equal('say "hello there"');
    });
  });

  describe("security review fixes", () => {
    it("the 30 s budget counts turns at the live speed (default 60 %)", () => {
      const raw = Array.from({ length: 12 }, () => ({ tool: "turn", degrees: 180 }));
      const fast = T.validatePlan(raw, "rover", { userSpeed: 100 });
      const slow = T.validatePlan(raw, "rover", { userSpeed: 10 });
      const total = (r, sp) => r.steps.reduce((a, s) => a + T.stepSeconds(s, sp), 0);
      expect(fast.steps).to.have.length(12);
      expect(slow.steps).to.have.length(3);
      expect(total(slow, 10)).to.be.at.most(T.LIMITS.MAX_TOTAL_S);
      expect(T.validatePlan(raw, "rover").steps).to.deep.equal(T.validatePlan(raw, "rover", { userSpeed: 60 }).steps);
      expect(T.validatePlan(raw, "rover", { userSpeed: NaN }).steps).to.deep.equal(T.validatePlan(raw, "rover").steps);
    });

    it("cleanSay strips every format character: Cf, tags, U+061C, U+180E, U+FFF9-FFFB, isolates, soft hyphen", () => {
      const evil = "a\u061Cb\u180Ec\uFFF9d\uFFFBe\u{E0041}\u{E007F}f\u2066g\u2069h\u00ADi\u2028j\u200Dk\u0085l";
      expect(T.cleanSay(evil)).to.equal("abcdefghijkl");
      expect(T.cleanSay("ok 👍 ñ 日本")).to.equal("ok 👍 ñ 日本"); // visible text, astral included, is kept
    });
  });
});
