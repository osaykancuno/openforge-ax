// The assisted-practice journal: runs flown with the AI Pilot or a twin, written down in this browser, each entry
// chained to the one before by its hash. It is a diary, not a record: every entry says "Assisted, not verified", and
// nothing here is ever sent to the Proving Grounds verifier or written on-chain. A holder may sign the journal's head
// (free, EIP-712) to say "I, the holder, signed this head" (it does not prove the runs happened); that signature has its own domain, so it can never pass for a run.
import { keccak256, toUtf8Bytes } from "../proving/hash.js";

export const LABEL = "Assisted, not verified";
export const GENESIS = "0x" + "00".repeat(32);
export const KINDS = ["ai-pilot", "twin"];
export const OUTCOMES = ["passed", "failed", "stopped"];
const MAX_ENTRIES = 500;
const NOTE_MAX = 200;

/** JSON with sorted keys, so the same entry always hashes the same. */
export function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}`;
  return JSON.stringify(v);
}

const hashOf = (body) => keccak256(toUtf8Bytes(canonical(body)));

/**
 * Checks a list of entries: every hash recomputes, every entry points at the one before it, sequence numbers count up.
 * The first entry is the anchor (older ones may have been dropped). { ok: true, count } or { ok: false, at }.
 */
export function verifyChain(list) {
  if (!Array.isArray(list)) return { ok: false, at: 0 };
  for (let i = 0; i < list.length; i++) {
    const e = list[i];
    if (!e || typeof e !== "object" || typeof e.hash !== "string") return { ok: false, at: i };
    const { hash, ...body } = e;
    if (hashOf(body) !== hash) return { ok: false, at: i };
    if (i > 0 && (e.prev !== list[i - 1].hash || e.seq !== list[i - 1].seq + 1)) return { ok: false, at: i };
  }
  return { ok: true, count: list.length };
}

const text = (v, field, max, required = true) => {
  if (v === undefined && !required) return "";
  if (typeof v !== "string" || (required && !v) || v.length > max) throw new Error(`Journal ${field} must be text of 1 to ${max} characters.`);
  return v;
};

/**
 * createJournal({ storage, chainId, tokenId, now }): the journal of one agent on one chain. `storage` is localStorage
 * (or any object with getItem/setItem; null keeps the journal for this visit only).
 */
export function createJournal({ storage, chainId, tokenId, now = () => Math.floor(Date.now() / 1000) }) {
  const key = `openforge-agent-journal:${Number(chainId)}:${Number(tokenId)}`;
  let memory = [];
  const read = () => {
    if (!storage) return memory;
    try {
      const v = JSON.parse(storage.getItem(key));
      return Array.isArray(v) ? v : [];
    } catch {
      return [];
    }
  };
  const write = (list) => {
    memory = list;
    try {
      storage?.setItem(key, JSON.stringify(list));
    } catch {
      /* blocked storage: kept for this visit */
    }
  };
  const entries = () => read().slice();
  const head = () => entries().at(-1)?.hash ?? GENESIS;
  return {
    entries,
    head,
    verify: () => verifyChain(read()),
    /** Adds one practice run: { kind: "ai-pilot" | "twin", robot, mission, outcome, note? }. Returns the stored entry. */
    append(input) {
      if (!input || typeof input !== "object") throw new Error("Journal entry must be an object.");
      if (!KINDS.includes(input.kind)) throw new Error(`Journal kind must be one of ${KINDS.join(", ")}.`);
      if (!OUTCOMES.includes(input.outcome)) throw new Error(`Journal outcome must be one of ${OUTCOMES.join(", ")}.`);
      const list = read();
      const last = list.at(-1);
      const body = {
        v: 1,
        seq: last ? last.seq + 1 : 0,
        at: now(),
        chainId: Number(chainId),
        tokenId: Number(tokenId),
        label: LABEL,
        kind: input.kind,
        robot: text(input.robot, "robot", 40),
        mission: text(input.mission, "mission", 80),
        outcome: input.outcome,
        note: text(input.note, "note", Infinity, false).slice(0, NOTE_MAX),
        prev: last ? last.hash : GENESIS,
      };
      const entry = { ...body, hash: hashOf(body) };
      write([...list, entry].slice(-MAX_ENTRIES));
      return entry;
    },
    clear: () => write([]),
    /** The journal as a file the holder can keep or share. */
    exportFile() {
      const list = read();
      return { filename: `openforge-agent-${Number(tokenId)}-practice-journal.json`, text: JSON.stringify({ label: LABEL, chainId: Number(chainId), tokenId: Number(tokenId), head: head(), entries: list }, null, 2) };
    },
  };
}

/**
 * EIP-712 data the holder may sign over the journal's head. Its own domain name and primary type ("Journal"), so it can
 * never be read as a Proving Grounds Run or a pilot trial, nor the reverse. Free (no gas, nothing on-chain).
 */
export const journalTypedData = ({ chainId, tokenId, count, head }) => ({
  domain: { name: "OpenForge Agent Journal", version: "1", chainId },
  types: {
    Journal: [
      { name: "tokenId", type: "uint256" },
      { name: "count", type: "uint256" },
      { name: "head", type: "bytes32" },
      { name: "label", type: "string" },
    ],
  },
  value: { tokenId, count, head, label: LABEL },
});
