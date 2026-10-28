const { expect } = require("chai");

// My IRL lab, "bring your agent to life": the showcase for the eight non-AX-1 classes (web/js/ar/showcase.js), the way the
// robot is dressed for AR (web/js/ar/agent-rig.js, on top of the shared token-look.js and motion.mjs) and the real robots'
// motion: every gesture ends on the token's pose, turning is bounded. Node, no WebGL (the phone face's canvas is stubbed).
describe("AR agent: showcase mode", () => {
  let THREE, S, R, M, TL, MO;
  let saved;
  before(async () => {
    saved = globalThis.document;
    const noop = new Proxy(function () {}, { get: (t, k) => (k === "measureText" ? () => ({ width: 10 }) : noop), apply: () => noop, set: () => true });
    globalThis.document = { createElement: () => ({ width: 0, height: 0, getContext: () => noop, style: {} }) };
    THREE = await import("three");
    S = await import("../web/js/ar/showcase.js");
    R = await import("../web/js/ar/agent-rig.js");
    M = await import("../web/js/models/robots.js");
    TL = await import("../web/js/models/token-look.js");
    MO = await import("../web/js/models/motion.mjs");
  });
  after(() => {
    globalThis.document = saved;
  });

  // ---------------------------------------------------------------- the showcase state machine, with a fake motion
  function fake() {
    const calls = [];
    const faceCalls = [];
    return {
      calls,
      faceCalls,
      motion: { frames: 39, pose: (i) => (calls.push(i), { look: [0.1, 0], mood: i > 10 && i < 20 ? "happy" : null }) },
      face: { setLook: (x, y) => faceCalls.push(["look", x, y]), setMood: (m) => faceCalls.push(["mood", m]) },
    };
  }
  async function placed(f = fake(), changes = []) {
    const sc = S.createShowcase({ name: "Cyber Hound", onChange: (v) => changes.push(v) });
    sc.attach({ motion: f.motion, face: f.face, faceHome: { look: [0.2, 0.1], mood: "idle" } });
    expect(await sc.start("xr")).to.equal(true);
    expect(await sc.place({ gesture: true })).to.equal(true);
    return sc;
  }
  const run = (sc, seconds, dt = 1 / 60) => {
    for (let t = 0; t < seconds; t += dt) sc.frame(dt);
  };

  it("walks ready -> placing -> on show, and a tap that is not a person's gesture places nothing", async () => {
    const sc = S.createShowcase({ name: "Cyber Hound" });
    sc.attach(fake());
    expect(sc.state).to.equal("ready");
    expect(await sc.place({ gesture: true })).to.equal(false); // not started
    expect(await sc.start("camera")).to.equal(true);
    expect(await sc.start("camera")).to.equal(false);
    expect(sc.state).to.equal("placing");
    expect(sc.view.canPlace).to.equal(true);
    expect(sc.view.hint).to.include("Cyber Hound");
    expect(await sc.place()).to.equal(false);
    expect(await sc.place({ gesture: "yes" })).to.equal(false);
    expect(sc.state).to.equal("placing");
    expect(sc.chip("move") instanceof Promise).to.equal(true); // buttons do nothing before the twin is placed
    expect(sc.press("left")).to.equal(false);
    expect(await sc.place({ gesture: true })).to.equal(true);
    expect(sc.state).to.equal("armed");
    expect(sc.view.placed).to.equal(true);
    await sc.ended("Closed");
    expect(sc.state).to.equal("ready");
    expect(sc.view.placed).to.equal(false);
  });

  it("nothing is driven: no ARM, no STOP, no sensing, no body, no voice", async () => {
    const sc = await placed();
    const v = sc.view;
    expect(v.drives).to.equal(false);
    expect(v.walks).to.equal(false);
    expect(v.canArm).to.equal(false);
    expect(v.canStop).to.equal(false);
    expect(v.armed).to.equal(false);
    expect(v.sensing.text).to.equal("");
    expect(sc.body).to.equal(null);
    expect(sc.snapshot).to.equal(null);
    expect(await sc.arm()).to.equal(false);
    expect(await sc.say("drive forward")).to.equal(null);
    expect(sc.listen()).to.equal(false);
    expect(v.chips.map((c) => c.id)).to.deep.equal(["move", "left", "right"]);
    expect(v.chips.map((c) => c.label)).to.deep.equal(["Its move", "Turn left", "Turn right"]);
    expect(v.chips.filter((c) => c.hold).map((c) => c.id)).to.deep.equal(["left", "right"]);
    expect(S.SHOWCASE_NOTE).to.match(/Only the AX-1 bodies are driven in AR today/);
  });

  it("Its move plays the token's frames 0.. at MOTION.fps, once, and ends exactly on the token's pose", async () => {
    const f = fake();
    const changes = [];
    const sc = await placed(f, changes);
    f.calls.length = 0; // attach and start rested on frame 0
    await sc.chip("move");
    expect(sc.playing).to.equal(true);
    expect(sc.view.playing).to.equal(true);
    run(sc, 1.0);
    // 1 s at 15 fps: frames 0..14, each posed once, in order
    expect(f.calls).to.deep.equal(Array.from({ length: f.calls.length }, (_, i) => i));
    expect(f.calls.length).to.be.within(14, 16);
    expect(Math.max(...f.calls)).to.be.at.most(15);
    run(sc, 3);
    expect(sc.playing).to.equal(false);
    expect(Math.max(...f.calls.slice(0, -1))).to.be.at.most(38); // never past the last moving frame
    expect(f.calls[f.calls.length - 1], "the last pose is the token's own").to.equal(0);
    // the face follows the gesture's look and mood, and is back at its resting look and mood
    expect(f.faceCalls.some((c) => c[0] === "mood" && c[1] === "happy")).to.equal(true);
    const [lk, md] = f.faceCalls.slice(-2);
    expect(lk[0]).to.equal("look");
    expect(lk[1]).to.be.closeTo(0.2 + 0.1, 1e-9); // faceHome.look plus the (fake) motion's look at frame 0
    expect(lk[2]).to.be.closeTo(0.1, 1e-9);
    expect(md).to.deep.equal(["mood", "idle"]);
    const before = f.calls.length;
    run(sc, 2);
    expect(f.calls.length, "plays once").to.equal(before);
    expect(changes[changes.length - 1].playing).to.equal(false);
  });

  it("a press while the move plays is ignored; after it ends the move plays again", async () => {
    const f = fake();
    const sc = await placed(f);
    await sc.chip("move");
    run(sc, 1);
    const n = f.calls.length;
    await sc.chip("move");
    run(sc, 0.5);
    expect(f.calls.slice(n).every((i, k, a) => k === 0 || i === a[k - 1] + 1), "continues, does not restart").to.equal(true);
    run(sc, 3);
    expect(sc.playing).to.equal(false);
    await sc.chip("move");
    expect(sc.playing).to.equal(true);
  });

  it("a stalled page (one huge frame step) advances at most 0.1 s of the gesture and of the turn", async () => {
    const f = fake();
    const sc = await placed(f);
    await sc.chip("move");
    f.calls.length = 0;
    sc.frame(5);
    expect(f.calls.length).to.be.at.most(1);
    expect(Math.max(...f.calls)).to.be.at.most(1);
    await sc.chip("left");
    const h = sc.heading;
    sc.frame(5);
    expect(Math.abs(sc.heading - h)).to.be.at.most(S.TURN.RATE * S.TURN.MAX_DT + 1e-9);
    for (const bad of [NaN, -1, undefined, Infinity, "x"]) {
      const h2 = sc.heading;
      sc.frame(bad);
      expect(Math.abs(sc.heading - h2), String(bad)).to.be.at.most(S.TURN.RATE * S.TURN.MAX_DT + 1e-9);
    }
  });

  it("a tap on Turn left / Turn right turns exactly 45 degrees on the spot, at a bounded rate", async () => {
    const sc = await placed();
    let prev = sc.heading;
    let worst = 0;
    let moved = 0;
    await sc.chip("right");
    for (let i = 0; i < 300; i++) {
      const out = sc.frame(1 / 60);
      worst = Math.max(worst, Math.abs(out.yaw - prev));
      moved += Math.abs(out.x) + Math.abs(out.z); // it turns on the spot: it never moves
      prev = out.yaw;
    }
    expect(worst).to.be.at.most(S.TURN.RATE / 60 + 1e-9);
    expect(moved).to.equal(0);
    expect(sc.heading).to.be.closeTo(Math.PI / 4, 1e-6);
    await sc.chip("left");
    run(sc, 2);
    expect(sc.heading).to.be.closeTo(0, 1e-6);
    await sc.chip("left");
    run(sc, 2);
    expect(sc.heading).to.be.closeTo(-Math.PI / 4, 1e-6);
  });

  it("holding a turn button keeps turning until the finger lifts; a lost lift ends by itself; the heading stays in (-pi, pi]", async () => {
    const sc = await placed();
    expect(sc.press("sideways")).to.equal(false);
    expect(sc.press("left")).to.equal(true);
    run(sc, 1);
    expect(sc.heading).to.be.closeTo(-S.TURN.RATE, 0.03);
    sc.release();
    const h = sc.heading;
    run(sc, 2);
    expect(sc.heading, "stops at once on release").to.equal(h);
    // a hold that is never released: bounded
    expect(sc.press("right")).to.equal(true);
    run(sc, S.TURN.MAX_HOLD_S + 5);
    const stopped = sc.heading;
    run(sc, 3);
    expect(sc.heading).to.equal(stopped);
    // many turns round and round: the angle never leaves (-pi, pi]
    let lo = 0, hi = 0;
    for (let k = 0; k < 12; k++) {
      sc.press(k % 2 ? "left" : "right");
      for (let t = 0; t < 3; t += 1 / 30) {
        sc.frame(1 / 30);
        lo = Math.min(lo, sc.heading);
        hi = Math.max(hi, sc.heading);
      }
      sc.release();
    }
    expect(lo).to.be.at.least(-Math.PI - 1e-9);
    expect(hi).to.be.at.most(Math.PI + 1e-9);
    expect(S.wrap(3 * Math.PI)).to.be.closeTo(Math.PI, 1e-9);
    expect(S.wrap(-Math.PI)).to.be.closeTo(Math.PI, 1e-9);
    expect(S.wrap(7)).to.be.closeTo(7 - 2 * Math.PI, 1e-9);
  });

  it("STOP, Esc, a hidden page and AR being blurred end the turn and the gesture; the twin rests on the token's pose", async () => {
    for (const how of ["stop", "hold", "hidden", "visible-blurred"]) {
      const f = fake();
      const sc = await placed(f);
      await sc.chip("move");
      sc.press("right");
      run(sc, 0.5);
      f.calls.length = 0;
      if (how === "stop" || how === "hold") await sc[how]("x");
      else await sc.visibility(how);
      expect(sc.playing, how).to.equal(false);
      expect(f.calls, how).to.deep.equal([0]);
      const h = sc.heading;
      run(sc, 1);
      expect(sc.heading, how).to.equal(h);
      expect(sc.state, how).to.equal("armed"); // still on show: nothing latches
    }
    const sc = await placed();
    await sc.visibility("visible"); // nothing by itself
    expect(sc.state).to.equal("armed");
  });

  it("placing again turns the twin back to face the person; leaving resets everything", async () => {
    const sc = await placed();
    await sc.chip("right");
    run(sc, 2);
    expect(sc.heading).to.not.equal(0);
    await sc.place({ gesture: true });
    expect(sc.heading).to.equal(0);
    sc.press("left");
    run(sc, 0.5);
    await sc.ended("Closed");
    expect(sc.heading).to.equal(0);
    expect(sc.view.turning).to.equal(false);
    expect(sc.frame(0.016).yaw).to.equal(0);
  });

  it("a throwing onChange never breaks the twin", async () => {
    const sc = S.createShowcase({ name: "x", onChange: () => { throw new Error("ui"); } });
    sc.attach(fake());
    expect(await sc.start("xr")).to.equal(true);
    expect(await sc.place({ gesture: true })).to.equal(true);
  });

  // ---------------------------------------------------------------- the real robots
  // one token per class: (id, frame, finish, augment, prime) varied so poses, add-ons and gold all get exercised
  const TOKENS = [];
  for (let cls = 0; cls < 8; cls++) {
    TOKENS.push({ id: 100 + cls, traits: { class: cls, finish: cls % 7, augment: (cls % 5) + 1, frame: cls % 4, legendary: 0 } });
    TOKENS.push({ id: 900 + cls, traits: { class: cls, finish: 0, augment: 0, frame: 3, legendary: 1 } });
  }
  const dressed = (agent) => {
    const rig = M.buildRobot(TL.CLASS_ROBOT[agent.traits.class]);
    const scene = new THREE.Scene();
    scene.add(rig.group);
    const d = R.dressAgent(rig, agent, { pose: true, motion: true });
    return { rig, scene, d };
  };
  const snapshot = (rig, inner) => ({
    joints: Object.fromEntries(Object.entries(rig.joints).map(([n, j]) => [n, j.value])),
    pos: inner.position.toArray(),
    rot: [inner.rotation.x, inner.rotation.y, inner.rotation.z],
    slides: Object.fromEntries(Object.entries(rig.slides || {}).map(([n, node]) => [n, node.position.toArray()])),
    spin: rig.spinners.map((sp) => [Math.sin(sp.node.rotation[sp.axis]), Math.cos(sp.node.rotation[sp.axis])]),
  });
  /** The first difference between two snapshots ("" when they match): plain loops, it runs thousands of times. */
  const diff = (a, b) => {
    const off = (x, y) => Math.abs(x - y) > 1e-6;
    for (const n of Object.keys(a.joints)) if (off(a.joints[n], b.joints[n])) return `joint ${n}: ${a.joints[n]} vs ${b.joints[n]}`;
    for (let i = 0; i < 3; i++) if (off(a.pos[i], b.pos[i]) || off(a.rot[i], b.rot[i])) return `body axis ${i}`;
    for (const n of Object.keys(a.slides)) for (let i = 0; i < 3; i++) if (off(a.slides[n][i], b.slides[n][i])) return `slide ${n}`;
    for (let i = 0; i < a.spin.length; i++) if (off(a.spin[i][0], b.spin[i][0]) || off(a.spin[i][1], b.spin[i][1])) return `spinner ${i}`;
    return "";
  };
  const same = (a, b, label) => expect(diff(a, b), label).to.equal("");

  it("every class has a robot, a motion and a dressed look (finish, add-on) in the rig, and the outer group is left free for the view", () => {
    for (const a of TOKENS) {
      const { rig, d } = dressed(a);
      const label = `${a.traits.class}/${a.traits.legendary}`;
      expect(d.motion.frames, label).to.equal(Math.round(MO.MOTION.fps * MO.MOTION.activeS));
      expect(rig.group.children, label).to.have.length(1); // the inner group only
      expect(rig.group.children[0]).to.equal(d.inner);
      expect(rig.group.position.toArray(), label).to.deep.equal([0, 0, 0]);
      expect(rig.group.rotation.y, label).to.equal(0);
      expect(Math.abs(d.inner.rotation.y), `${label} token side`).to.be.within(0.35 - 1e-9, 0.8 + 1e-9);
      expect(d.prime, label).to.equal(a.traits.legendary > 0);
      if (a.traits.legendary > 0 || a.traits.augment > 0) {
        const n = M.buildRobot(TL.CLASS_ROBOT[a.traits.class]);
        let plain = 0, dressedMeshes = 0;
        n.group.traverse((o) => o.isMesh && plain++);
        rig.group.traverse((o) => o.isMesh && dressedMeshes++);
        expect(dressedMeshes, `${label} add-on`).to.be.greaterThan(plain);
      }
    }
  });

  it("the gesture moves the robot (something differs from the rest pose) and returns to the token's pose at its end, for every class", () => {
    for (const a of TOKENS) {
      const { rig, d } = dressed(a);
      const label = `class ${a.traits.class} ${a.traits.legendary ? "prime" : "plain"}`;
      d.motion.pose(0);
      const rest = snapshot(rig, d.inner);
      let moved = false;
      for (let i = 1; i < d.motion.frames; i++) {
        d.motion.pose(i);
        if (diff(rest, snapshot(rig, d.inner))) moved = true;
      }
      expect(moved, `${label} moves`).to.equal(true);
      d.motion.pose(d.motion.frames); // the end of the gesture
      same(rest, snapshot(rig, d.inner), `${label} end`);
      d.motion.pose(0);
      same(rest, snapshot(rig, d.inner), `${label} back at 0`);
    }
  });

  it("through the showcase: a played move ends with the rig exactly where the token's pose was, whatever the frame rate", async () => {
    for (const a of TOKENS.slice(0, 8)) {
      for (const dt of [1 / 60, 1 / 30, 0.09]) {
        const { rig, d } = dressed(a);
        const sc = S.createShowcase({ name: "x" });
        sc.attach({ motion: d.motion, face: d.face, faceHome: d.faceHome });
        await sc.start("xr");
        await sc.place({ gesture: true });
        const rest = snapshot(rig, d.inner);
        await sc.chip("move");
        let mid = false;
        for (let t = 0; t < 4; t += dt) {
          sc.frame(dt);
          if (!mid && sc.playing && diff(rest, snapshot(rig, d.inner))) mid = true;
        }
        expect(sc.playing).to.equal(false);
        expect(mid, `class ${a.traits.class} dt ${dt} moved`).to.equal(true);
        same(rest, snapshot(rig, d.inner), `class ${a.traits.class} dt ${dt}`);
      }
    }
  });

  it("the view moving the outer group never disturbs the motion (the inner group carries the gesture)", () => {
    const a = TOKENS[10]; // Sky Drone: lift, yaw, tilt and spin on the group
    const { rig, d } = dressed(a);
    d.motion.pose(0);
    const innerRest = d.inner.position.toArray();
    rig.group.position.set(2, 0.5, -1);
    rig.group.rotation.y = 1.3;
    for (let i = 0; i < d.motion.frames; i++) d.motion.pose(i);
    expect(rig.group.position.toArray()).to.deep.equal([2, 0.5, -1]);
    expect(rig.group.rotation.y).to.equal(1.3);
    d.motion.pose(0);
    expect(d.inner.position.toArray()).to.deep.equal(innerRest);
    // the drone lifts: the inner group rises relative to the outer one
    d.motion.pose(Math.round(d.motion.frames * 0.5));
    expect(d.inner.position.y).to.be.greaterThan(innerRest[1] + 0.01);
  });

  it("the robots are small enough for a room and large enough to see (real size, metres)", () => {
    const sizes = [];
    for (const a of TOKENS.filter((t) => !t.traits.legendary)) {
      const { rig } = dressed(a);
      const box = M.bounds(rig);
      const size = box.getSize(new THREE.Vector3());
      sizes.push(`${a.traits.class} ${TL.CLASS_ROBOT[a.traits.class]} ${size.x.toFixed(2)}x${size.y.toFixed(2)}x${size.z.toFixed(2)}`);
      expect(Math.max(size.x, size.y, size.z), sizes[sizes.length - 1]).to.be.within(0.05, 1.2);
    }
  });

  it("the dressed AX-1 twin keeps its joints at home for the drive loop (pose: false) and has no wrapper", () => {
    for (const [cls, id] of [[8, "ax1-rover"], [9, "ax1-desk"], [10, "ax1-walker"]]) {
      const rig = M.buildRobot(id);
      const scene = new THREE.Scene();
      scene.add(rig.group);
      const agent = { id: 4321, traits: { class: cls, finish: 3, augment: 2, frame: 3, legendary: 0 } };
      const d = R.dressAgent(rig, agent);
      expect(d.motion).to.equal(undefined);
      expect(R.robotIdOf(agent)).to.equal(id);
      for (const [n, j] of Object.entries(rig.joints)) expect(j.value, `${id} ${n}`).to.equal(j.home);
      expect(rig.group.children.some((c) => c.name === "agent-body")).to.equal(false);
    }
  });
});
