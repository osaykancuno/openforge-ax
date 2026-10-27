// AI Pilot prompt: what the local model is told. Privacy rule: only the user's text, the body key, the joint names and
// limits, the joint positions, the link state and the speed cap ever reach the model. Never the camera picture, a
// passkey, a device name, a wallet, the page address or anything from storage: snapshotForModel() picks fields one by one
// from the loop snapshot, so a new field on the snapshot can never leak by accident.
import * as P from "../ax-proto.js";
import { LINK } from "../drive-loop.js";
import { cleanSay } from "./tools.js";

export const MAX_HISTORY = 6; // messages sent back, newest last
export const MAX_TEXT = 300; // characters per message
export const MAX_NOTE = 200;
const round1 = (n) => Math.round(n * 10) / 10;

const LINK_TEXT = {
  [LINK.ARMED]: "armed",
  [LINK.DRIVING]: "armed",
  [LINK.LATCHED]: "latched",
  [LINK.DISCONNECTED]: "disconnected",
  [LINK.CONNECTING]: "connecting",
};

/** The robot state as the model sees it. Exactly these five fields. */
export function snapshotForModel(snapshot, bodyKey) {
  const def = P.BODIES[P.bodyByKey(bodyKey)];
  const s = snapshot && typeof snapshot === "object" ? snapshot : {};
  const link = Object.hasOwn(LINK_TEXT, s.link) ? LINK_TEXT[s.link] : "disconnected";
  const pos = s.state && Array.isArray(s.state.positions) ? s.state.positions : Array.isArray(s.targets) ? s.targets : [];
  const cap = Number.isFinite(s.speed) ? Math.min(100, Math.max(5, Math.round(s.speed))) : 60;
  return {
    body: def ? def.key : "unknown",
    link,
    can_move: link === "armed",
    speed_cap_percent: cap,
    joints: def
      ? def.joints.map((j, i) => ({ name: j.name, min_deg: j.min / 10, max_deg: j.max / 10, now_deg: round1((Number.isFinite(pos[i]) ? pos[i] : j.home) / 10) }))
      : [],
  };
}

const EXAMPLES = {
  rover: '"turn left" -> turn(degrees=90). "look right" -> look(pan=-45). "drive forward 2 seconds, then stop" -> drive(direction="forward", seconds=2), stop().',
  desk: '"wave" -> gesture(name="wave"). "look left and up" -> look(pan=45, tilt=20). "turn the body right" -> set_joints(torso_yaw=-60).',
  walker: '"crouch" -> pose(name="crouch"). "turn the torso left" -> torso(yaw=30). The Walker cannot walk.',
};

function systemText(bodyKey, view, interrupted) {
  const lines = [
    `You are the pilot of a small hobby robot, OpenForge AX-1 (body: ${view.body}). Turn the user's request into tool calls. Call every tool you need, in order, in ONE reply. You may add one short plain sentence.`,
    "Rules:",
    "- Use only the tools you were given. You cannot arm, connect or configure the robot: a human does that. If it is not armed yet, plan anyway.",
    "- Angles are in degrees. Positive pan, turn and torso yaw mean LEFT, negative mean RIGHT. Positive tilt means UP.",
    "- Keep the plan short: 12 steps at most, 30 seconds in total, drive 3 seconds at most per step. Speed is a percent of the user's own speed setting, never above it.",
    "- If the user says stop, call stop. If the body cannot do what was asked, say so in one sentence and call no motion tool.",
    `Examples: ${EXAMPLES[bodyKey] || EXAMPLES.rover}`,
  ];
  const note = interrupted ? cleanSay(String(interrupted), MAX_NOTE) : "";
  if (note) lines.push(`The user interrupted your previous plan at ${note}. The robot stopped moving but is still armed. Plan again from the current state.`);
  lines.push(`ROBOT STATE (JSON): ${JSON.stringify(view)}`);
  return lines.join("\n");
}

/**
 * buildMessages({ bodyKey, snapshot, history, interrupted }) -> [{ role, content }]
 * history: [{ role: "user" | "assistant", text }], newest last. Other roles and non-text are dropped.
 */
export function buildMessages({ bodyKey, snapshot, history, interrupted = null } = {}) {
  const view = snapshotForModel(snapshot, bodyKey);
  const msgs = [];
  for (const m of Array.isArray(history) ? history : []) {
    if (!m || (m.role !== "user" && m.role !== "assistant") || typeof m.text !== "string") continue;
    const content = cleanSay(m.text, MAX_TEXT);
    if (content) msgs.push({ role: m.role, content });
  }
  const tail = msgs.slice(-MAX_HISTORY);
  while (tail.length && tail[0].role !== "user") tail.shift(); // chat templates want the first turn to be the user's
  return [{ role: "system", content: systemText(bodyKey, view, interrupted) }, ...tail];
}
