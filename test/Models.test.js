const { expect } = require("chai");

// web/js/models/robots.js: physical sanity of the AX-1 models, which the Workbench, the AR twin and the token art all
// draw. A real robot's parts cannot pass through each other: these checks measure the meshes' vertices over the
// whole range of the joints (Node, no WebGL; the phone face's canvas is stubbed).
describe("Robot models: no part passes through another", () => {
  let THREE, M, saved;
  before(async () => {
    saved = globalThis.document;
    const noop = new Proxy(function () {}, { get: (t, k) => (k === "measureText" ? () => ({ width: 10 }) : noop), apply: () => noop, set: () => true });
    globalThis.document = { createElement: () => ({ width: 0, height: 0, getContext: () => noop, style: {} }) };
    THREE = await import("three");
    M = await import("../web/js/models/robots.js");
  });
  after(() => {
    globalThis.document = saved;
  });

  /** Every vertex of the meshes under `node`, in the frame of `frame` (world when frame is null). */
  function vertices(node, frame = null) {
    node.updateWorldMatrix(true, true);
    const inv = frame ? frame.matrixWorld.clone().invert() : new THREE.Matrix4();
    const out = [];
    const v = new THREE.Vector3();
    node.traverse((o) => {
      if (!o.isMesh) return;
      const p = o.geometry.attributes.position;
      for (let i = 0; i < p.count; i++) out.push(v.fromBufferAttribute(p, i).applyMatrix4(o.matrixWorld).applyMatrix4(inv).clone());
    });
    return out;
  }

  it("AX-1 Desk: the arms never reach into the base or the torso, in any pose", () => {
    const rig = M.buildRobot("ax1-desk");
    const baseTop = 0.025 + 0.004; // the base and its trim ring
    const torsoHalf = 0.06; // the torso is 12 cm wide
    const body = rig.joints.torso_yaw.node.children.find((c) => c.children.length > 1); // the torso pivot (it holds the arms)
    let lowest = Infinity, closest = Infinity;
    for (const yaw of [-120, 0, 120]) {
      for (let sh = -170; sh <= 40; sh += 15) {
        for (let el = -120; el <= 0; el += 20) {
          rig.pose({ torso_yaw: yaw, l_shoulder: sh, r_shoulder: sh, l_elbow: el, r_elbow: el });
          for (const s of ["l", "r"]) {
            const arm = rig.joints[`${s}_shoulder`].node;
            for (const p of vertices(arm)) lowest = Math.min(lowest, p.y);
            for (const p of vertices(arm, body)) closest = Math.min(closest, Math.abs(p.x));
          }
        }
      }
    }
    expect(lowest, "lowest point of an arm (m)").to.be.greaterThan(baseTop + 0.005);
    expect(closest, "nearest arm point to the torso's middle (m)").to.be.greaterThan(torsoHalf + 0.004);
  });

  it("AX-1 Walker: the protocol's signs (hip_pitch < 0 = leg forward; flat foot when hip + knee + ankle = 0)", () => {
    const rig = M.buildRobot("ax1-walker");
    const tilt = (s) => {
      const up = new THREE.Vector3(0, 1, 0).applyQuaternion(rig.joints[`${s}_ankle_roll`].node.getWorldQuaternion(new THREE.Quaternion()));
      return (Math.acos(Math.min(1, up.y)) * 180) / Math.PI;
    };
    const z = (name) => rig.joints[name].node.getWorldPosition(new THREE.Vector3()).z;
    // the Phone Brain's crouch (web/js/pilot/motions.js) and a step: knees come forward (the robot faces +Z), feet stay flat
    for (const [hip, knee, ankle] of [[-40, 80, -40], [-38, 70, -32], [-60, 90, -30]]) {
      rig.home();
      rig.pose({ l_hip_pitch: hip, l_knee: knee, l_ankle_pitch: ankle });
      rig.group.updateMatrixWorld(true);
      expect(z("l_knee"), `knee forward at ${hip}/${knee}/${ankle}`).to.be.greaterThan(z("l_hip_pitch") + 0.02);
      expect(tilt("l"), `foot tilt at ${hip}/${knee}/${ankle}`).to.be.below(1 + Math.abs(hip + knee + ankle));
    }
  });

  it("AX-1 Desk: stands on its base (nothing below the table) and is about 30 cm tall", () => {
    const rig = M.buildRobot("ax1-desk");
    rig.home();
    const b = M.bounds(rig);
    expect(b.min.y).to.be.closeTo(0, 0.001);
    expect(b.max.y).to.be.within(0.28, 0.32);
  });
});
