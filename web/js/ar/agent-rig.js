// My IRL lab, "bring your agent to life": dresses a freshly built robot as the agent's token. The look itself (pose, finish,
// add-on, side) is web/js/models/token-look.js, shared with the token art and NOT re-implemented here; the gesture is
// web/js/models/motion.mjs. This file only fits them to AR:
//   * AX-1 classes (rover, desk, walker): `dressToken(..., { pose: false })`, so the drive loop keeps the joints;
//   * the other classes (showcase): the token's pose, plus a motion that can run while the view moves the robot about.
//     The view overwrites rig.group's position and yaw every frame, and createMotion moves rig.group too (lift, yaw,
//     tilt, move), so the robot's children go into an inner group and the motion gets a rig whose `group` is that inner
//     one. The joints, slides and spinners are shared with the real rig, so every rig method still works.
import * as THREE from "three";
import { CLASS_ROBOT, dressToken } from "../models/token-look.js";
import { createMotion } from "../models/motion.mjs";

/** The robots.js id of the agent's class ("hound", "ax1-walker", ...). */
export const robotIdOf = (agent) => CLASS_ROBOT[agent.traits.class];

/**
 * dressAgent(rig, agent, { pose, motion }) → { r, look0, prime, motion?, inner?, face?, faceHome? }.
 * The rig's group must already be in a scene whose ancestors have no transform (dressToken reads world matrices).
 *   pose: the token's own pose (a showcase twin and a Quick Look model); false keeps the joints at home (an AX-1 twin);
 *   motion: also wrap the robot and build the token's gesture (showcase).
 */
export function dressAgent(rig, agent, { pose = false, motion = false } = {}) {
  const dressed = dressToken(rig, { id: agent.id, t: agent.traits }, { pose });
  if (!motion) return dressed;
  const g = rig.group;
  const inner = new THREE.Group();
  inner.name = "agent-body";
  inner.position.copy(g.position);
  inner.rotation.copy(g.rotation); // the token's side: kept on the inner group, the outer one turns with the person
  inner.scale.copy(g.scale);
  for (const c of [...g.children]) inner.add(c);
  g.position.set(0, 0, 0);
  g.rotation.set(0, 0, 0);
  g.scale.set(1, 1, 1);
  g.add(inner);
  g.updateMatrixWorld(true);
  const moving = Object.create(rig, { group: { value: inner } });
  const m = createMotion(robotIdOf(agent), moving, dressed.r);
  m.pose(0);
  return { ...dressed, motion: m, inner, face: rig.face || null, faceHome: { look: dressed.look0, mood: dressed.prime ? "happy" : "idle" } };
}
