// Scripted pick-and-place via IK waypoints: the "ghost run" demo and a sim regression test.
// Every recorded command respects MAX_CMD_STEP, exactly like a human run recorded in the arena.
import { createMission, ik, initialState, step, limitStep, REST } from "./arm-sim.js";

const HOVER = 0.07;
const GRAB = 0.016;

export function autopilot(seedHex) {
  const { cell, dock } = createMission(seedHex);
  const plan = [
    [{ ...cell, z: HOVER }, 100],
    [{ ...cell, z: GRAB }, 100],
    [{ ...cell, z: GRAB }, 0],
    [{ ...cell, z: HOVER }, 0],
    [{ ...dock, z: HOVER }, 0],
    [{ ...dock, z: 0.04 }, 0],
    [{ ...dock, z: 0.04 }, 100],
    [{ ...dock, z: HOVER }, 100],
  ];
  const actions = [];
  const s = initialState(seedHex);
  let cmd = REST.slice();
  for (const [pos, grip] of plan) {
    const to = ik(pos, 0, grip);
    if (!to) throw new Error(`autopilot: unreachable waypoint ${JSON.stringify(pos)}`);
    // advance until the command reaches the waypoint
    while (cmd.some((v, i) => Math.abs(v - to[i]) > 0.05)) {
      cmd = limitStep(cmd, to);
      actions.push(cmd);
      step(s, cmd);
      if (s.done) return actions;
    }
  }
  return actions;
}
