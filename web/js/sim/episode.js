// Episode format + signing payload shared by the arena (browser) and the verifier (Node). Pure, no deps.
import { SIM_ID, MISSION, FPS, JOINTS, ROBOT, sceneOf } from "./arm-sim.js";

export const FORMAT = "openforge.episode.v1";

/** Builds the client episode. `actions` are the recorded joint commands (degrees, 0.1 precision). */
export function buildEpisode({ tokenId, challengeId, seed, actions }) {
  return {
    format: FORMAT,
    sim: SIM_ID,
    mission: MISSION,
    task: "Pick up the energy cell and place it in the charging dock.",
    robot_type: ROBOT.robot_type,
    units: ROBOT.units,
    fps: FPS,
    tokenId: Number(tokenId),
    challengeId,
    seed,
    scene: sceneOf(seed),
    features: { action: JOINTS.map((j) => `${j}.pos`) },
    actions,
  };
}

/** Deterministic JSON: object keys sorted recursively, no whitespace. Hashing this gives dataHash. */
export function canonicalize(v) {
  if (Array.isArray(v)) return `[${v.map(canonicalize).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonicalize(v[k])}`).join(",")}}`;
  return JSON.stringify(v);
}

/** EIP-712 typed data the holder signs (free, no gas) to submit a run. Lab trials pass their own mission and sim. */
export function runTypedData({ chainId, verifyingContract, tokenId, challengeId, episodeHash, deadline, mission = MISSION, sim = SIM_ID }) {
  return {
    domain: { name: "OpenForge Proving Grounds", version: "1", chainId, verifyingContract },
    types: {
      Run: [
        { name: "tokenId", type: "uint256" },
        { name: "challengeId", type: "bytes32" },
        { name: "episodeHash", type: "bytes32" },
        { name: "mission", type: "string" },
        { name: "sim", type: "string" },
        { name: "deadline", type: "uint256" },
      ],
    },
    value: { tokenId, challengeId, episodeHash, mission, sim, deadline },
  };
}

/**
 * EIP-712 typed data for a pilot trial (pre-mint ranking, any wallet, nothing on-chain). A different domain name
 * and primary type than Run, so a trial signature can never be replayed as an agent run, nor the reverse.
 */
export const TRIAL_NOTICE = "Free signature, not a transaction. It publishes this address and run on the OpenForge pilot ranking.";

export function trialTypedData({ chainId, wallet, challengeId, episodeHash, deadline }) {
  return {
    domain: { name: "OpenForge Pilot Trials", version: "1", chainId },
    types: {
      Trial: [
        { name: "notice", type: "string" },
        { name: "wallet", type: "address" },
        { name: "challengeId", type: "bytes32" },
        { name: "episodeHash", type: "bytes32" },
        { name: "mission", type: "string" },
        { name: "sim", type: "string" },
        { name: "deadline", type: "uint256" },
      ],
    },
    value: { notice: TRIAL_NOTICE, wallet, challengeId, episodeHash, mission: MISSION, sim: SIM_ID, deadline },
  };
}
