// My IRL lab, "bring your agent to life" (ar.html?agent=<tokenId>): what the page reads from an agent's token.
// Pure: no DOM, no three, no network. The page reads the token's metadata through chain.js (tokenMeta) and hands the
// decoded JSON to these functions. The metadata is chain data: it is checked here, and every text from it is cleaned
// before the page shows it (the page only ever uses textContent).
//
// The JSON is the one contracts/AgentRenderer.sol writes: attributes [{ trait_type, value }], a dormant token has
// { "State": "Dormant" } and no traits, a Prime Construct has "Finish": "24K Circuit", "Augment": "Crown Halo" and a "1/1".
import { NAMES } from "../traits-data.js";

/** The three AX-1 classes (index → AX-1 body): they are driven in AR. Every other class shows its signature move. */
export const AX1_BODY = Object.freeze({ 8: "rover", 9: "desk", 10: "walker" });
export const MAX_AGENT_ID = 1_000_000_000;

// control characters, zero-width and bidirectional marks: never shown from chain data
const UNSAFE = /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/g;
const clean = (s, max) => String(s ?? "").replace(UNSAFE, "").replace(/\s+/g, " ").trim().slice(0, max);

/** "AX-0042": the token's tag, as in its name on the chain. */
export const agentTag = (id) => `AX-${String(id).padStart(4, "0")}`;

/**
 * parseAgentParam(search) → null (no ?agent), { id } (a whole number from 1 to MAX_AGENT_ID) or { bad: true } (anything else).
 * Digits only: "7", not "7.5", "0x7", "-1" or "7abc".
 */
export function parseAgentParam(search) {
  let raw = null;
  try {
    raw = new URLSearchParams(String(search ?? "")).get("agent");
  } catch {
    return null;
  }
  if (raw === null) return null;
  const t = raw.trim();
  if (!/^\d{1,10}$/.test(t)) return { bad: true };
  const id = Number(t);
  return id >= 1 && id <= MAX_AGENT_ID ? { id } : { bad: true };
}

const attrs = (meta) => (meta && typeof meta === "object" && Array.isArray(meta.attributes) ? meta.attributes : null);
function value(list, key) {
  for (const a of list) if (a && typeof a === "object" && a.trait_type === key) return a.value;
  return undefined;
}
const indexOf = (list, v) => (typeof v === "string" ? list.indexOf(v) : -1);

/**
 * classifyMeta(meta) → { status: "ready", traits } | { status: "dormant" } | { status: "bad" }.
 * traits = { class, finish, augment, frame, legendary } as indices into NAMES (traits-data.js), the way the token art
 * reads them. A Prime Construct (a "1/1" attribute): legendary 1, its gold finish and crown are drawn by the art itself,
 * so finish and augment are 0 and do not matter.
 */
export function classifyMeta(meta) {
  const list = attrs(meta);
  if (!list) return { status: "bad" };
  if (value(list, "State") === "Dormant") return { status: "dormant" };
  const cls = indexOf(NAMES.class, value(list, "Class"));
  const frame = indexOf(NAMES.frame, value(list, "Frame"));
  if (cls < 0 || frame < 0) return { status: "bad" };
  const one = value(list, "1/1");
  if (one !== undefined) {
    if (typeof one !== "string" || !one.trim()) return { status: "bad" };
    return { status: "ready", traits: { class: cls, finish: 0, augment: 0, frame, legendary: 1 } };
  }
  const finish = indexOf(NAMES.finish, value(list, "Finish"));
  const augment = indexOf(NAMES.augment, value(list, "Augment"));
  if (finish < 0 || augment < 0) return { status: "bad" };
  return { status: "ready", traits: { class: cls, finish, augment, frame, legendary: 0 } };
}

/** The token's look as indices, or null for a dormant or unrevealed token and for data that does not fit. */
export function traitsFromMeta(meta) {
  const c = classifyMeta(meta);
  return c.status === "ready" ? c.traits : null;
}

/** The callsign from the token's name ("AX-0042 // Nitro Shrike" → "Nitro Shrike"), cleaned; "" when there is none. */
export function callsignOf(meta) {
  const name = meta && typeof meta === "object" && typeof meta.name === "string" ? meta.name : "";
  const at = name.indexOf("//");
  return clean(at >= 0 ? name.slice(at + 2) : "", 40);
}

/**
 * agentFromMeta(id, meta) → the page's agent record, or { status: "dormant" | "bad" }.
 * { status: "ready", id, tag, callsign, className, traits, kind: "ax1" | "showcase", body: "rover" | "desk" | "walker" | null, prime }
 */
export function agentFromMeta(id, meta) {
  const c = classifyMeta(meta);
  if (c.status !== "ready") return { status: c.status };
  const t = c.traits;
  const ax1 = Object.hasOwn(AX1_BODY, t.class);
  const className = NAMES.class[t.class];
  return {
    status: "ready",
    id,
    tag: agentTag(id),
    callsign: callsignOf(meta) || className,
    className,
    traits: t,
    kind: ax1 ? "ax1" : "showcase",
    body: ax1 ? AX1_BODY[t.class] : null,
    prime: t.legendary > 0,
  };
}
