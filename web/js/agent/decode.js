// Reads a proposal (what the agent software asked the holder to approve) and says what it does, with risk flags.
// Pure: the page tells it whether the target is a contract (it asks the node for the target's code). Everything it
// returns is plain text for textContent; the data it reads is never trusted.
import { ASSET_MOVE_NAMES, isAssetMove } from "./policy.js";

const ADDR = /^0x[0-9a-fA-F]{40}$/;
const HEX = /^0x(?:[0-9a-fA-F]{2})*$/;
const UNLIMITED = 1n << 255n; // an allowance this large is "unlimited" in practice
const SPENDER = "0x095ea7b3 0x39509351 0x4000aea0 0x1296ee62 0xcae9ca51".split(" "); // (address, amount, ...)

// Functions that are not asset moves but common enough to name. Anything else on a contract is "unknown".
const KNOWN = {
  "0xd0e30db0": "deposit()",
  "0x2e1a7d4d": "withdraw(uint256)",
  "0x3ccfd60b": "withdraw()",
  "0x4e71d92d": "claim()",
};
export const KNOWN_NAMES = KNOWN;

const word = (data, n) => data.slice(10 + n * 64, 10 + (n + 1) * 64);
const wordAddr = (w) => (/^0{24}[0-9a-f]{40}$/i.test(w) ? `0x${w.slice(24).toLowerCase()}` : null);

function argsOf(sel, data) {
  const out = [];
  const addrAt = (n, label) => {
    const w = word(data, n);
    if (w.length === 64) out.push({ label, value: wordAddr(w) ?? `0x${w}` });
  };
  const amountAt = (n, label) => {
    const w = word(data, n);
    if (w.length === 64) out.push({ label, value: BigInt(`0x${w}`).toString() });
  };
  if (SPENDER.includes(sel)) {
    addrAt(0, sel === "0x095ea7b3" || sel === "0x39509351" ? "Spender" : "To");
    amountAt(1, "Amount (raw units)");
  } else if (sel === "0xa9059cbb") {
    addrAt(0, "To");
    amountAt(1, "Amount (raw units)");
  } else if (sel === "0x23b872dd") {
    addrAt(0, "From");
    addrAt(1, "To");
    amountAt(2, "Amount or token id");
  } else if (sel === "0x42842e0e" || sel === "0xb88d4fde") {
    addrAt(0, "From");
    addrAt(1, "To");
    amountAt(2, "Token id");
  } else if (sel === "0xa22cb465") {
    addrAt(0, "Operator");
    const w = word(data, 1);
    if (w.length === 64) out.push({ label: "Approved", value: BigInt(`0x${w}`) === 0n ? "false" : "true" });
  } else if (sel === "0xf2fde38b") {
    addrAt(0, "New owner");
  }
  return out;
}

const flag = (code, level, text) => ({ code, level, text });
const RANK = { low: 0, medium: 1, high: 2 };

/**
 * decodeCall({ to, value, data }, { isContract, account, holder }) ->
 *   { kind: "eth" | "call", selector, name, bytes, preview, args: [{ label, value }], flags: [{ code, level, text }], risk }
 * `isContract` is true / false / undefined (could not be checked). `account` = this agent's wallet, `holder` = its owner,
 * `trusted` = addresses whose code is known (the agent wallet, the project's own contracts); any other contract is flagged.
 */
export function decodeCall(call, { isContract, account, holder, trusted = [] } = {}) {
  const { to, value, data } = call && typeof call === "object" ? call : {};
  const flags = [];
  const targetOk = typeof to === "string" && ADDR.test(to);
  if (!targetOk) flags.push(flag("malformed-target", "high", "The target is not a valid address."));
  if (typeof value !== "bigint" || value < 0n) flags.push(flag("malformed-value", "high", "The amount is not valid."));

  const dataOk = typeof data === "string" && HEX.test(data);
  const bytes = dataOk ? (data.length - 2) / 2 : 0;
  const base = { kind: bytes === 0 ? "eth" : "call", selector: null, name: null, bytes, preview: dataOk && bytes ? (data.length > 74 ? `${data.slice(0, 74)}…` : data) : "", args: [] };
  if (!dataOk) {
    flags.push(flag("malformed-data", "high", "The call data is not valid hex. Do not approve this."));
    return finish(base, flags);
  }
  if (targetOk && account && to.toLowerCase() === String(account).toLowerCase()) flags.push(flag("to-account", "high", "This calls the agent wallet itself, which the contract does not allow an agent to ask for."));

  if (bytes === 0) {
    if (targetOk && holder && to.toLowerCase() === String(holder).toLowerCase()) flags.push(flag("pays-holder", "low", "Sends ETH to your own address."));
    return finish(base, flags);
  }
  if (bytes < 4) {
    flags.push(flag("short-data", "medium", "The call data is shorter than a function selector, so it does not match any function."));
    return finish(base, flags);
  }

  const sel = data.slice(0, 10).toLowerCase();
  base.selector = sel;
  base.args = argsOf(sel, data.toLowerCase());
  if (isAssetMove(sel)) {
    base.name = ASSET_MOVE_NAMES[sel];
    flags.push(flag("asset-move", "high", "Moves or approves tokens or NFTs held by this agent wallet. Approve only if you know exactly what it is for."));
    if (SPENDER.slice(0, 2).includes(sel)) {
      const w = word(data.toLowerCase(), 1);
      if (w.length === 64 && BigInt(`0x${w}`) >= UNLIMITED) flags.push(flag("unlimited-approval", "high", "Gives the spender an unlimited allowance."));
    }
  } else if (KNOWN[sel]) base.name = KNOWN[sel];

  if (isContract === false) flags.push(flag("eoa-with-data", "medium", "Sends call data to a plain address, not a contract. The data does nothing there; check the address."));
  else if (isContract === undefined) flags.push(flag("target-unchecked", "medium", "Could not check whether the target is a contract."));
  else {
    if (!base.name) flags.push(flag("unknown-selector", "medium", "Calls a function this page does not recognise. Check what it does before approving."));
    // a name comes from the first 4 bytes, which any contract can reuse: it never vouches for the target
    if (!trusted.some((a) => typeof a === "string" && a.toLowerCase() === String(to).toLowerCase())) flags.push(flag("target-unverified", "medium", "This page cannot verify what the contract at this address does. The function name comes from the first 4 bytes, which any contract can reuse. Approve only a contract you trust."));
  }
  return finish(base, flags);
}

function finish(base, flags) {
  const risk = flags.reduce((r, f) => (RANK[f.level] > RANK[r] ? f.level : r), "low");
  return { ...base, flags, risk };
}
