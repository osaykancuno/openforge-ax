// The agent console's rules, as plain values (no DOM, no ethers): amounts, the daily-limit arithmetic, the copy that
// describes each mode, and when a browser key must stop. AgentAccount is the authority; test/AgentRuntimeFlows.test.js
// runs every rule here against the real contract.

export const DAY = 86400;
export const GAS_FLOAT = 3_000_000_000_000_000n; // 0.003 ETH: what the holder sends the agent key for its own gas
export const REFUEL_BELOW = 1_000_000_000_000_000n; // 0.001 ETH: below this the key asks the agent wallet for more
export const SWEEP_MIN = 5_000_000_000_000_000n; // 0.005 ETH: smaller surpluses are not worth a transaction
export const ETH_TRANSFER = "0x00000000"; // the "selector" of a call with no data, as AgentAccount reads it

// Daily limit choices. The key in this browser starts at 0.01 ETH and has no 0.5 option; software the holder runs
// themselves (Autonomous) may still choose it.
export const BUILTIN_LIMITS = ["0.01", "0.05", "0.1"];
export const OWN_SOFTWARE_LIMITS = ["0.01", "0.05", "0.1", "0.5"];
export const DEFAULT_LIMIT = "0.01";

/**
 * Selectors an operator can never call, at any level: a copy of AgentAccount._isAssetMove (test/AgentRuntimeFlows.test.js
 * compares the two, and the contract itself refuses each one). Value = what the function is.
 */
export const ASSET_MOVE_NAMES = {
  "0x095ea7b3": "approve(address,uint256)",
  "0xa9059cbb": "transfer(address,uint256)",
  "0x23b872dd": "transferFrom(address,address,uint256)",
  "0x42842e0e": "safeTransferFrom(address,address,uint256)",
  "0xb88d4fde": "safeTransferFrom(address,address,uint256,bytes)",
  "0xa22cb465": "setApprovalForAll(address,bool)",
  "0x39509351": "increaseAllowance(address,uint256)",
  "0xd505accf": "permit(address,address,uint256,uint256,uint8,bytes32,bytes32)",
  "0xf242432a": "safeTransferFrom(address,address,uint256,uint256,bytes)",
  "0x2eb2c2d6": "safeBatchTransferFrom(address,address,uint256[],uint256[],bytes)",
  "0xe3ee160e": "transferWithAuthorization(address,address,uint256,uint256,uint256,bytes32,uint8,bytes32,bytes32)",
  "0x87517c45": "approve(address,address,uint160,uint48)",
  "0x2b67b570": "permit(address,((address,uint160,uint48,uint48),address,uint256),bytes)",
  "0x2a2d80d1": "permit(address,((address,uint160,uint48,uint48)[],address,uint256),bytes)",
  "0x8fcbaf0c": "permit(address,address,uint256,uint256,bool,uint8,bytes32,bytes32)",
  "0x4000aea0": "transferAndCall(address,uint256,bytes)",
  "0x1296ee62": "transferAndCall(address,uint256)",
  "0xc1d34b89": "transferFromAndCall(address,address,uint256,bytes)",
  "0xcae9ca51": "approveAndCall(address,uint256,bytes)",
  "0x9bd9bbc6": "send(address,uint256,bytes)",
  "0x62ad1b83": "operatorSend(address,address,uint256,bytes,bytes)",
  "0x959b8c3f": "authorizeOperator(address)",
  "0x8fcb4e5b": "transferShares(address,uint256)",
  "0x8b72a2ec": "transferPunk(address,uint256)",
  "0xf2fde38b": "transferOwnership(address)",
  "0x2f2ff15d": "grantRole(bytes32,address)",
  "0x51945447": "execute(address,uint256,bytes,uint8)",
};
export const ASSET_MOVE = Object.keys(ASSET_MOVE_NAMES);
const ASSET_SET = new Set(ASSET_MOVE);

/** True when calldata (or a bare selector) starts with one of the selectors above. */
export const isAssetMove = (data) => typeof data === "string" && /^0x[0-9a-fA-F]{8}/.test(data) && ASSET_SET.has(data.slice(0, 10).toLowerCase());

// ---------------------------------------------------------------- amounts
/** Wei as a plain decimal ETH string, no trailing zeros ("0.003"). */
export function fmtEth(wei) {
  let v = BigInt(wei);
  const neg = v < 0n;
  if (neg) v = -v;
  const whole = v / 10n ** 18n;
  const frac = (v % 10n ** 18n).toString().padStart(18, "0").replace(/0+$/, "");
  return `${neg ? "-" : ""}${whole}${frac ? `.${frac}` : ""}`;
}

/**
 * What the key may still spend now. AgentAccount keeps one fixed window: once it has run its length, the next spend
 * opens a new one with the whole limit available again. p = { periodLimit, spentInPeriod, periodStart, periodLength }.
 */
export function remainingCap(p, now) {
  if (now >= Number(p.periodStart) + Number(p.periodLength)) return BigInt(p.periodLimit);
  const left = BigInt(p.periodLimit) - BigInt(p.spentInPeriod);
  return left > 0n ? left : 0n;
}

/** The sentence every limit confirmation carries: the window is fixed, so up to twice the limit can leave across its reset. */
export const limitNote = (limitWei) =>
  `Daily limit ${fmtEth(limitWei)} ETH (up to twice that, ${fmtEth(BigInt(limitWei) * 2n)} ETH, can leave across the daily reset).`;

// ---------------------------------------------------------------- copy
export const MODE_NAMES = ["", "Manual", "Assisted", "Autonomous"];
export const MODE_TEXT = {
  1: "Watches its wallet and lab record and suggests; you do each action. Recommended.",
  2: "A key in this browser acts alone, only on actions you allow, up to a daily limit (up to twice that across the reset). Works while this page is open.",
  3: "For your own agent software. Full trust: it can move the tokens and NFTs in this agent's wallet through other apps. ETH is capped.",
};
export const SAFETY_TEXT = "The agent can never touch your own wallet or sign for you. In Manual and Assisted it can't move this wallet's tokens or NFTs; in Autonomous it can.";

// ---------------------------------------------------------------- state
const ZERO = /^0x0{40}$/i;
const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

/**
 * The mode the agent is really in. The contract keeps the level it was configured with after revokeOperator(), so
 * "no operator" means Manual whatever the stored level says.
 */
export function effectiveMode({ operator, level }) {
  if (!operator || ZERO.test(operator)) return 1;
  return level === 1 || level === 2 || level === 3 ? Number(level) : 1;
}

/**
 * Whether the browser key may act. `s` is the chain state (watch.js readState), `rec` the stored key record
 * ({ address, holder }: the key and the holder it was set up for).
 *   stopped: it must never act again (the agent changed hands, or this key was replaced or the mode changed);
 *   waiting: not now (paused, sale lock), and it looks again on the next round;
 *   acting: all clear.
 */
export function keyStatus(s, rec) {
  const nonceOf = (v) => (v === undefined || v === null ? null : BigInt(v));
  const hands =
    !s.owner || ZERO.test(s.owner) || !same(s.owner, rec.holder) || !same(s.configuredFor, s.owner) || nonceOf(s.configuredNonce) !== nonceOf(s.transferNonce);
  if (hands) return { state: "stopped", code: "changed-hands", message: "This agent changed hands; this key no longer acts." };
  if (!s.operator || !same(s.operator, rec.address)) return { state: "stopped", code: "not-operator", message: "This key is no longer the operator of this agent; it does not act." };
  if (Number(s.level) !== 2) return { state: "stopped", code: "not-assisted", message: "The agent is not in Assisted mode; this key does not act." };
  if (s.paused) return { state: "waiting", code: "paused", message: "The agent is paused; the key waits." };
  if (Number(s.lockedUntil) > Number(s.now)) return { state: "waiting", code: "locked", message: "The agent wallet is locked for sale; the key waits until the lock ends." };
  return { state: "acting", code: "ok", message: "The key is watching the wallet." };
}

// ---------------------------------------------------------------- what the browser key can really do
/**
 * Shown before Assisted is turned on, and next to the running key. The contract bounds the key by the daily limit and by
 * two addresses; "refuel" and "sweep" are the only things THIS PAGE does with that power.
 */
export const KEY_RISK_TEXT =
  "The contract caps this key at the daily limit, and lets it send ETH from the agent wallet only to two addresses: its own and yours. It cannot move tokens or NFTs. The two actions (refuel its gas, send the surplus to you) are enforced by this page, not by the contract: if someone stole this key while it is unlocked, they could take the entire daily limit (up to twice that across the reset) to the key's own address, every day, until you switch to Manual.";

// ---------------------------------------------------------------- operator addresses
/** Said in every prompt that sets an operator. */
export const OPERATOR_RULE = "Use only an address whose key you control, never one someone sent you.";

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/**
 * Whether an address may be set as the agent's operator through "Use my own agent software".
 * { error: string | null, warnings: [string] }. `builtinKey` = the key made in this browser (its own Assisted flow), `defaultOperator` =
 * the address this site was configured to suggest (never accepted for full trust), `isContract` = true / false / undefined.
 */
export function checkOperator({ address, level, builtinKey, defaultOperator, account, isContract }) {
  const warnings = [];
  if (typeof address !== "string" || !ADDRESS.test(address) || ZERO.test(address)) return { error: "The agent software address (0x…) is required.", warnings };
  if (account && same(address, account)) return { error: "That is the agent's own wallet; it cannot be its own operator.", warnings };
  if (builtinKey && same(address, builtinKey)) return { error: level === 3 ? "That is the key made in this browser, which is for Assisted mode only. It has no place in Autonomous (full trust)." : "That is the key made in this browser. Set it up through the Assisted mode steps.", warnings };
  if (level === 3 && defaultOperator && same(address, defaultOperator)) return { error: "That is the address this site suggests by default. Full trust needs an address whose key you control: use your own.", warnings };
  if (isContract === true) warnings.push("This address holds contract code. A contract can only act as agent software if it was built to; if someone gave it to you, do not use it.");
  else if (isContract === undefined) warnings.push("Could not check whether this address is a contract.");
  return { error: null, warnings };
}

/** Autonomous is confirmed by typing the last 4 hex characters of the agent wallet (read from the page, not pre-filled). */
export const l3Hint = (account) => String(account).slice(-4).toLowerCase();
export const L3_PLACEHOLDER = "Type the last 4 characters of the agent wallet address";
export const l3Confirmation = (typed, account) => typeof typed === "string" && /^[0-9a-f]{4}$/i.test(typed.trim()) && typed.trim().toLowerCase() === l3Hint(account);
