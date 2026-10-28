// Manual mode, the default: the console WATCHES the agent wallet and the lab record and SUGGESTS. It never acts; the
// holder does each action with one tap. Everything here is plain values in, plain values out (the page reads the chain
// through readState and keeps what it remembers in this browser's storage, injected).
import { fmtEth } from "./policy.js";

const DAY = 86400;
const ZERO = /^0x0{40}$/i;

// ---------------------------------------------------------------- reading the chain
// Human-readable ABIs of just what the console reads or calls; test/AgentRuntimeFlows.test.js runs them against the contract.
export const ACCOUNT_ABI = [
  "function owner() view returns (address)",
  "function operator() view returns (address)",
  "function autonomyLevel() view returns (uint8)",
  "function paused() view returns (bool)",
  "function lockedUntil() view returns (uint64)",
  "function configuredFor() view returns (address)",
  "function configuredNonce() view returns (uint256)",
  "function policyEpoch() view returns (uint256)",
  "function periodLimit() view returns (uint128)",
  "function periodLength() view returns (uint64)",
  "function periodStart() view returns (uint64)",
  "function spentInPeriod() view returns (uint128)",
  "function isAllowed(address target, bytes4 selector) view returns (bool)",
  "function proposalCount() view returns (uint256)",
  "function proposalAt(uint256) view returns (address to, uint256 value, bytes data, bool done, bool valid)",
  "function configure(address operator, uint8 level, uint128 limit, uint64 periodLen)",
  "function setPermission(address target, bytes4 selector, bool ok)",
  "function setPaused(bool)",
  "function revokeOperator()",
  "function approve(uint256 id)",
  "function reject(uint256 id)",
  "function execute(address to, uint256 value, bytes data, uint8 operation) payable returns (bytes)",
];
export const AGENTS_ABI = ["function transferNonce(uint256) view returns (uint256)", "function ownerOf(uint256) view returns (address)"];
export const REPUTATION_EVENTS_ABI = ["event SimAttested(uint256 indexed tokenId, address indexed attester, bool success, uint16 quality, bytes32 dataHash)"];

/**
 * Everything the console needs from the chain, as plain values: amounts and nonces are bigint, times and the level are
 * numbers. `allow` = [{ key, target, selector }] adds `allowed[key]` (whether the holder whitelisted that pair).
 * `time` is the chain's clock (the block's timestamp), which is the clock the daily limit runs on. `blockTag` pins every
 * read to one block: after a transaction, a lagging node must not hand back the state from before it.
 */
export async function readState({ account, agents, tokenId, provider, accountAddress, allow = [], blockTag }) {
  const o = blockTag === undefined ? {} : { blockTag };
  const [owner, operator, level, paused, lockedUntil, configuredFor, configuredNonce, transferNonce, periodLimit, periodLength, periodStart, spentInPeriod, balance, block, ...allowed] = await Promise.all([
    account.owner(o), account.operator(o), account.autonomyLevel(o), account.paused(o), account.lockedUntil(o), account.configuredFor(o), account.configuredNonce(o),
    agents.transferNonce(tokenId, o), account.periodLimit(o), account.periodLength(o), account.periodStart(o), account.spentInPeriod(o), provider.getBalance(accountAddress, blockTag), provider.getBlock(blockTag ?? "latest"),
    ...allow.map((a) => account.isAllowed(a.target, a.selector, o)),
  ]);
  const s = { time: Number(block.timestamp), owner, operator, level: Number(level), paused, lockedUntil: Number(lockedUntil), configuredFor, configuredNonce, transferNonce, periodLimit, periodLength: Number(periodLength), periodStart: Number(periodStart), spentInPeriod, balance };
  if (allow.length) s.allowed = Object.fromEntries(allow.map((a, i) => [a.key, allowed[i]]));
  return s;
}

// ---------------------------------------------------------------- wallet watch
export function duration(sec) {
  const s = Math.max(0, Math.round(sec));
  if (s >= DAY) {
    const d = Math.round(s / DAY);
    return `${d} day${d === 1 ? "" : "s"}`;
  }
  if (s >= 3600) {
    const h = Math.round(s / 3600);
    return `${h} hour${h === 1 ? "" : "s"}`;
  }
  const m = Math.max(1, Math.round(s / 60));
  return `${m} minute${m === 1 ? "" : "s"}`;
}

// a remembered balance is a decimal string; anything else (a corrupt entry) counts as nothing remembered
const remembered = (seen) => (seen && typeof seen === "object" && typeof seen.balance === "string" && /^\d+$/.test(seen.balance) ? BigInt(seen.balance) : null);
const bigOrNull = (v) => (typeof v === "string" && /^\d+$/.test(v) ? BigInt(v) : null);

/**
 * What the wallet watch shows: [{ id, level: "info" | "warn", text }] and the balance to remember for next time.
 * `seen` = what was remembered at the last visit ({ balance, at }, or null).
 */
export function watchWallet(s, seen, now) {
  const items = [{ id: "balance", level: "info", text: `Balance: ${fmtEth(s.balance)} ETH.` }];
  const before = remembered(seen);
  if (before !== null && s.balance > before) items.push({ id: "incoming", level: "info", text: `ETH arrived since your last visit: +${fmtEth(s.balance - before)} ETH.` });
  if (before !== null && s.balance < before) items.push({ id: "outgoing", level: "warn", text: `ETH left since your last visit: -${fmtEth(before - s.balance)} ETH. If you did not do that, pause the agent below.` });
  if (Number(s.lockedUntil) > now) items.push({ id: "lock", level: "info", text: `The wallet is locked for sale; it unlocks in ${duration(Number(s.lockedUntil) - now)}.` });
  if (s.paused) items.push({ id: "paused", level: "warn", text: "The agent is paused: nothing acts until you resume it." });
  const hasOperator = s.operator && !ZERO.test(s.operator);
  const lapsed = !s.owner || String(s.configuredFor).toLowerCase() !== String(s.owner).toLowerCase() || BigInt(s.configuredNonce) !== BigInt(s.transferNonce);
  if (hasOperator && lapsed) items.push({ id: "lapsed", level: "warn", text: "A previous setup is still stored, but it lapsed when the agent changed hands: its key and allowed actions no longer work. Set a mode again if you want one." });
  return { items, seen: { balance: s.balance.toString(), at: now } };
}

/** At most one balance snapshot a day, 60 days kept, newest last. */
export function pushSnapshot(history, snap) {
  const h = Array.isArray(history) ? history.filter((x) => x && Number.isFinite(x.at) && typeof x.balance === "string") : [];
  const last = h.at(-1);
  if (!last || Math.floor(last.at / DAY) !== Math.floor(snap.at / DAY)) h.push(snap);
  return h.slice(-60);
}

// ---------------------------------------------------------------- mission coach
/** Accepted lab runs on the current UTC day: the contract's daily cap counts per `timestamp / 1 days`. */
export const countToday = (events, now) => (Array.isArray(events) ? events.filter((e) => Math.floor(e.at / DAY) === Math.floor(now / DAY)).length : 0);

/**
 * Suggestions for the next lab missions. The chain says how many runs were attested today (the daily cap) but not which
 * mission each was, so "not yet passed" comes from this browser's saved progress. Only suggests: the holder plays, and
 * signs, every run.
 */
export function coach({ robotName, levels, progress, today, cap }) {
  const rec = progress && typeof progress === "object" ? progress : {};
  const list = Array.isArray(levels) ? levels : [];
  const todo = list.filter((l) => !rec[l.id]?.passed);
  const used = Math.min(cap, Math.max(0, Number(today) || 0));
  const left = cap - used;
  const lines = [];
  if (!robotName || !list.length) lines.push("Open the Proving Grounds to see the missions your agent can fly.");
  else if (!todo.length) lines.push(`You have passed all three ${robotName} missions in this browser. Try another body: the AX-1 robots take any agent.`);
  else lines.push(`Not yet passed in this browser (${robotName}): ${todo.map((l) => l.title).join(", ")}.`);
  lines.push(
    left > 0
      ? `${used} of ${cap} recorded runs used today (the daily cap resets at 00:00 UTC), so ${left} left. Open the Proving Grounds: you play and sign every run.`
      : `The daily cap of ${cap} recorded runs is used. It resets at 00:00 UTC, so the missions wait until tomorrow; you play and sign every run.`
  );
  return { todo, left, lines };
}

// ---------------------------------------------------------------- weekly report
/**
 * A short report from what this browser remembers: balance snapshots, lab runs attested in the last 7 days (from the chain),
 * what the agent key did, and practice runs in the journal. It describes; it never forecasts or promises anything.
 */
export function weeklyReport({ now, history = [], balance = 0n, labRuns = [], activity = [], practice = 0 }) {
  const since = now - 7 * DAY;
  const snaps = (Array.isArray(history) ? history : []).filter((x) => x && x.at >= since && bigOrNull(x.balance) !== null);
  const lines = [];
  if (snaps.length) {
    const d = BigInt(balance) - BigInt(snaps[0].balance);
    lines.push(`Balance: ${fmtEth(balance)} ETH, ${d >= 0n ? "+" : "-"}${fmtEth(d >= 0n ? d : -d)} ETH since ${new Date(snaps[0].at * 1000).toISOString().slice(0, 10)}.`);
  } else lines.push(`Balance: ${fmtEth(balance)} ETH. Come back in a few days for a comparison: this page remembers one snapshot a day.`);
  const runs = (Array.isArray(labRuns) ? labRuns : []).filter((r) => r.at >= since);
  const passed = runs.filter((r) => r.success).length;
  lines.push(`${runs.length} lab run${runs.length === 1 ? "" : "s"} recorded this week, ${passed} passed.`);
  const acts = (Array.isArray(activity) ? activity : []).filter((a) => a.at >= since);
  lines.push(acts.length ? `${acts.length} action${acts.length === 1 ? "" : "s"} by the agent key this week.` : "No actions by an agent key this week.");
  if (practice) lines.push(`${practice} assisted practice run${practice === 1 ? "" : "s"} in your journal (not verified).`);
  return { lines };
}

// ---------------------------------------------------------------- what this browser remembers
const KEY = {
  seen: (id) => `openforge-agent-seen:${id}`,
  history: (id) => `openforge-agent-history:${id}`,
  activity: (id) => `openforge-agent-activity:${id}`,
};
const load = (storage, key) => {
  try {
    return JSON.parse(storage?.getItem(key));
  } catch {
    return null;
  }
};
const save = (storage, key, v) => {
  try {
    storage?.setItem(key, JSON.stringify(v));
  } catch {
    /* private mode or blocked storage: the memory lasts for this visit */
  }
};
const list = (storage, key) => {
  const v = load(storage, key);
  return Array.isArray(v) ? v : [];
};
export const readSeen = (storage, id) => load(storage, KEY.seen(id));
export const writeSeen = (storage, id, seen) => save(storage, KEY.seen(id), seen);
export const readHistory = (storage, id) => list(storage, KEY.history(id));
export const writeHistory = (storage, id, h) => save(storage, KEY.history(id), h);
export const readActivity = (storage, id) => list(storage, KEY.activity(id));
export function logActivity(storage, id, entry) {
  save(storage, KEY.activity(id), [...readActivity(storage, id), entry].slice(-200));
}
