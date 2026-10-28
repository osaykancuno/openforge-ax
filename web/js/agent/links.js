// The two links from an agent to its robot: the AR twin and the Workbench build guide. A class is an index into
// the on-chain class list (AgentRenderer.className) or its name; the robot ids are the Workbench's.

/** Robot id by on-chain class index (same order as traits-data.js NAMES.class and lab-episode.js CLASS_ROBOT). */
const ROBOT_BY_CLASS = ["so101", "rover", "hound", "hand", "spider", "drone", "fab", "replicant", "ax1-rover", "ax1-desk", "ax1-walker"];
const CLASS_NAMES = ["Synth Arm", "Street Rover", "Cyber Hound", "Ghost Hand", "Spider Mech", "Sky Drone", "Fab Rig", "Replicant", "AX-1 Rover", "AX-1 Desk", "AX-1 Walker"];

/** The robot of a Class trait (its name, or its index), or null for anything else (a dormant token has no class yet). */
export function robotIdForClass(cls) {
  const i = typeof cls === "number" ? cls : CLASS_NAMES.indexOf(cls);
  return Number.isInteger(i) && i >= 0 && i < ROBOT_BY_CLASS.length ? ROBOT_BY_CLASS[i] : null;
}

export const ROBOT_IDS = ROBOT_BY_CLASS;
export const arLink = (id) => `ar.html?agent=${encodeURIComponent(id)}`;

/** The Workbench's build guide for the agent's robot, or null when its class is not known yet. */
export function buildLink(cls) {
  const id = robotIdForClass(cls);
  return id ? `bench.html#${id}/build` : null;
}

/** Token metadata as the page can safely read it: text where text is expected, an attributes list that really is a list. */
export function cleanMeta(m) {
  const o = m && typeof m === "object" ? m : {};
  return {
    ...o,
    name: String(o.name ?? ""),
    description: String(o.description ?? ""),
    image: String(o.image ?? ""),
    attributes: Array.isArray(o.attributes) ? o.attributes.filter((a) => a && typeof a === "object" && typeof a.trait_type === "string") : [],
  };
}
