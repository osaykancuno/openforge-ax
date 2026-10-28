// What the agent key in this browser may do ALONE: two actions, nothing else. Both are plain ETH transfers out of the
// agent wallet (a call with no data), so each needs one whitelist entry that the holder signs when turning Assisted on:
//   refuel: the agent wallet sends the key a little ETH when the key is low on gas;
//   sweep:  the agent wallet sends the holder's own address whatever it holds above a balance the holder chose to keep.
// Everything else the console finds stays a suggestion for the holder. The daily limit counts both.
import { ETH_TRANSFER, GAS_FLOAT, REFUEL_BELOW, SWEEP_MIN, keyStatus, remainingCap } from "./policy.js";

export const ACTIONS = {
  refuel: { label: "Refuel its own gas", target: "operator", selector: ETH_TRANSFER },
  sweep: { label: "Send surplus to you", target: "holder", selector: ETH_TRANSFER },
};

/** The (target, selector) pairs the holder allows when turning Assisted on: exactly one per built-in action. */
export const permissionsFor = ({ operator, holder }) => [
  { action: "refuel", target: operator, selector: ACTIONS.refuel.selector },
  { action: "sweep", target: holder, selector: ACTIONS.sweep.selector },
];

const min = (...v) => v.reduce((a, b) => (b < a ? b : a));

/** s = { keyBalance, accountBalance, remaining, below, float } in wei. A call, or { skip: reason }. */
export function planRefuel({ keyBalance, accountBalance, remaining, below = REFUEL_BELOW, float = GAS_FLOAT }) {
  if (keyBalance >= below) return { skip: "gas-ok" };
  if (accountBalance <= 0n) return { skip: "wallet-empty" };
  if (remaining <= 0n) return { skip: "cap-reached" };
  return { id: "refuel", value: min(float - keyBalance, remaining, accountBalance) };
}

/** s = { accountBalance, keep, min, remaining } in wei. `keep` null/undefined = the holder has not turned sweeping on. */
export function planSweep({ accountBalance, keep, min: floor = SWEEP_MIN, remaining }) {
  if (keep === null || keep === undefined || keep < 0n) return { skip: "off" }; // a negative balance to keep would sweep more than the wallet holds
  const surplus = accountBalance - keep;
  if (surplus < floor) return { skip: "nothing-to-sweep" };
  if (remaining <= 0n) return { skip: "cap-reached" };
  return { id: "sweep", value: min(surplus, remaining, accountBalance) };
}

/**
 * The one call the key should make now, or { skip: reason }. Refuel comes first (without gas it can do nothing).
 * A call is { id, to, value, data: "0x" }.
 */
export function nextAction({ operator, holder, keyBalance, accountBalance, remaining, keep }) {
  const r = planRefuel({ keyBalance, accountBalance, remaining });
  if (r.id) return { id: r.id, to: operator, value: r.value, data: "0x" };
  const s = planSweep({ accountBalance, keep, remaining });
  if (s.id) return { id: s.id, to: holder, value: s.value, data: "0x" };
  return { skip: r.skip === "gas-ok" ? s.skip : r.skip };
}

const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

/**
 * The last check before the key signs: null if the call is one of the two built-in actions within what is left of the
 * daily limit, otherwise the reason it is refused. It does not trust whoever built the call.
 */
export function guard(call, { operator, holder, remaining }) {
  if (!call || typeof call !== "object") return "No call.";
  if (call.data !== "0x") return "Built-in actions send plain ETH, with no data.";
  if (!same(call.to, operator) && !same(call.to, holder)) return "Built-in actions only go to the agent key itself or to the holder.";
  if (typeof call.value !== "bigint" || call.value <= 0n) return "The amount must be more than zero.";
  if (call.value > remaining) return "More than the daily limit has left.";
  return null;
}

/**
 * What the key can send back to the holder when it is revoked: its balance minus the network fee of that one transfer.
 * `feePerGas` is the transaction's gas price (or maxFeePerGas, which leaves a little dust).
 */
export function sweepKeyValue(balance, feePerGas, gasLimit = 21000n) {
  const v = BigInt(balance) - BigInt(gasLimit) * BigInt(feePerGas);
  return v > 0n ? v : 0n;
}

/**
 * The balance to keep, as typed: { wei: null } (empty = never sweep), { wei } (zero or more), or { error }.
 * `parse` turns "0.25" into wei (ethers.parseEther).
 */
export function parseKeep(text, parse) {
  const t = String(text ?? "").trim();
  if (!t) return { wei: null };
  let wei;
  try {
    wei = parse(t);
  } catch {
    return { error: "Enter the balance to keep as a number of ETH, like 0.05, or leave it empty." };
  }
  if (wei < 0n) return { error: "The balance to keep must be zero or more." };
  return { wei };
}

// ---------------------------------------------------------------- one use of the key at a time
/**
 * A queue of one: every use of the key (a round of the loop, sending its leftover ETH back, a stop) runs through the same
 * gate, so two never sign with the same nonce. A job that throws does not block the next.
 */
export function createGate() {
  let tail = Promise.resolve();
  return {
    run(fn) {
      const p = tail.then(fn);
      tail = p.catch(() => {});
      return p;
    },
  };
}

/** Rejects with an error that halts the key if `promise` has not settled in `ms` (the key never resends at a new nonce). */
export function withTimeout(promise, ms, message) {
  let t;
  const late = new Promise((_, reject) => {
    t = setTimeout(() => reject(Object.assign(new Error(message), { halt: true })), ms);
  });
  return Promise.race([promise, late]).finally(() => clearTimeout(t));
}

// ---------------------------------------------------------------- the key locks itself again
export const IDLE_MS = 15 * 60_000;

/**
 * Drops the unlocked key after `idleMs` with no activity. Activity = the holder using the console (touch), or the loop
 * running on a visible page (tick(true)). A hidden page or a stopped loop is idle.
 */
export function createIdleLock({ idleMs = IDLE_MS, now = Date.now, lock }) {
  let last = now();
  let locked = false;
  const touch = () => {
    last = now();
    locked = false;
  };
  return {
    touch,
    tick(active) {
      if (active) return touch();
      if (!locked && now() - last >= idleMs) {
        locked = true;
        lock();
      }
    },
  };
}

/**
 * The loop of the key in this browser. All effects are injected, so it can be tested without a page or a chain:
 *   readState(blockTag) -> chain state (watch.js readState), keyBalance(blockTag) -> wei,
 *   execute(call) -> { hash, blockNumber } once the transaction is mined (it throws an error with `halt: true` if it
 *   is not confirmed in time), log(entry), visible() -> bool, onStatus({ state, code, message }), onStop(message).
 * One action per round, through a gate shared with everything else that signs with the key. After a send the next round
 * reads the chain no earlier than the block that included it. It stops for good when the agent changed hands, after three
 * errors in a row, when a send is not confirmed (it never resends), and on stop().
 */
export function createRunner({ record, keep = null, gate = createGate(), readState, keyBalance, execute, log = () => {}, visible = () => true, now = () => Math.floor(Date.now() / 1000), onStatus = () => {}, onStop = () => {} }) {
  let stopped = false, queued = false, fails = 0, sinceBlock;
  const halt = (message) => {
    stopped = true;
    onStop(message);
  };
  async function round() {
    if (stopped) return;
    if (!visible()) return onStatus({ state: "waiting", code: "hidden", message: "This page is in the background; the key waits until you come back." });
    try {
      const s = await readState(sinceBlock);
      const t = s.time ?? now(); // the daily limit runs on the chain's clock
      const st = keyStatus({ ...s, now: t }, record);
      onStatus(st);
      if (st.state === "stopped") return halt(st.message);
      if (st.state === "waiting") return;
      if (s.allowed && (!s.allowed.operator || !s.allowed.holder)) {
        return onStatus({ state: "waiting", code: "no-permission", message: "The two allowed actions are not set (a new setup clears them). Turn Assisted on again." });
      }
      const remaining = remainingCap(s, t);
      const holder = record.holder;
      const call = nextAction({ operator: record.address, holder, keyBalance: await keyBalance(sinceBlock), accountBalance: s.balance, remaining, keep });
      if (call.skip) return onStatus({ state: "acting", code: `idle-${call.skip}`, message: "Nothing to do right now." });
      const why = guard(call, { operator: record.address, holder, remaining });
      if (why) return onStatus({ state: "waiting", code: "refused", message: why });
      if (stopped) return; // stopped while the chain was being read: nothing is sent
      const tx = await execute(call);
      fails = 0;
      if (tx.blockNumber !== undefined) sinceBlock = tx.blockNumber;
      log({ at: now(), id: call.id, to: call.to, value: call.value.toString(), tx: tx.hash });
      onStatus({ state: "acting", code: `did-${call.id}`, message: `${ACTIONS[call.id].label}: done.` });
    } catch (e) {
      if (e?.halt) return halt(e.message);
      fails += 1;
      onStatus({ state: "waiting", code: "error", message: `The last attempt failed (${fails} of 3): ${String(e?.shortMessage || e?.message || e).slice(0, 120)}` });
      if (fails >= 3) halt("Stopped after three failed attempts in a row. Check the agent, then start the key again.");
    }
  }
  return {
    /** One round, unless one is already waiting its turn. Resolves when the round is over. */
    tick() {
      if (stopped || queued) return Promise.resolve();
      queued = true;
      return gate.run(async () => {
        queued = false;
        await round();
      });
    },
    /** Stops the loop; resolves once any round already under way (and so any send) has finished. */
    stop() {
      if (!stopped) halt("Stopped.");
      return gate.run(async () => {});
    },
    get stopped() {
      return stopped;
    },
  };
}
