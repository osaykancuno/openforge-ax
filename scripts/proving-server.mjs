// Proving Grounds verifier: issues mission challenges, verifies signed runs by deterministic replay,
// stores episodes as data, and batch-attests them on-chain (AgentReputation.attestSimBatch).
// Two kinds of run: the Synth Arm "Energy Cell" (arm-sim) and the lab trials of every Workbench robot (/lab/*).
//   node scripts/proving-server.mjs            (reads web/deployment.json; env overrides below)
// Env: DEPLOYMENT_FILE (default web/deployment.json), SIM_ATTESTER_KEY, PROVING_RPC_URL, PORT=8787, FLUSH_SECONDS=60, PUBLIC_URL, ALLOWED_ORIGIN, DATA_DIR, ADMIN_TOKEN,
//      TRUST_PROXY=true behind a TLS proxy, OPENSEA_API_KEY (+ OPENSEA_SLUG, default from openseaDropUrl) for GET /market. Outside the local chain ALLOWED_ORIGIN is required, and attesting needs an
//      https PUBLIC_URL (it is written on-chain in every batch).
//      MAX_FEE_GWEI (unset = no ceiling): never send an attestation whose maxFeePerGas would exceed it; the runs stay queued and the next flush tries again.
//      REPLACE_AFTER_MIN=10: a sent batch still pending after this long is re-sent at the same nonce with +12.5% fees (under MAX_FEE_GWEI).
//      TRIAL_NEW_WALLETS_PER_HOUR=3000: global ceiling on new pilot wallets (429 beyond it); MAX_HITS=100000: size of the per-network rate-limit table.
// Without SIM_ATTESTER_KEY (outside the local chain) it runs in verify-only mode: missions, verification, storage
// and leaderboard all work; on-chain attestation needs an address with the isSimAttester role.
import { createServer } from "node:http";
import { mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import "dotenv/config";
import { Contract, JsonRpcProvider, Wallet, verifyTypedData, getAddress, hexlify, keccak256, parseUnits, toUtf8Bytes, isHexString } from "ethers";
import { readFile, writeFile, rename, unlink } from "node:fs/promises";
import { ownerVerifier, netOf, coarseOf, tooDeep, redactSecrets } from "./lib/signatures.mjs";
import { hostAllowed, hostsOf, isLoopbackHost, hardenHttpServer, installCrashGuards } from "./world/core.mjs";
import { createMarketProxy } from "./lib/market-proxy.mjs";
import { slugOf } from "../web/js/market/market-data.js";
import { createTrials, scoreLabRunCounted } from "./lib/trials.mjs";
import { replay, score, validateActions, SIM_ID, MISSION, FPS } from "../web/js/sim/arm-sim.js";
import { FORMAT, buildEpisode, canonicalize, runTypedData } from "../web/js/sim/episode.js";
import { LAB_SIM_ID, LAB_FORMAT, robotsForClass, labLevel, labMission, validateLabActions, buildLabEpisode, labTrajectoryKey, idlePasses } from "../web/js/sim/lab-episode.js";

installCrashGuards("proving"); // a stray rejected promise is logged, it must not take the verifier down

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const env = process.env;
const dep = JSON.parse(readFileSync(env.DEPLOYMENT_FILE || join(root, "web/deployment.json"), "utf8"));
const PORT = Number(env.PORT || 8787);
const FLUSH_SECONDS = Number(env.FLUSH_SECONDS || 60);
const PUBLIC_URL = (env.PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/$/, "");
const LOCAL = dep.chainId === 31337;
if (!LOCAL && !env.ALLOWED_ORIGIN) throw new Error("ALLOWED_ORIGIN is required outside the local chain (the site's origin)");
// "*" exists only on the local demo (chain 31337, bound to 127.0.0.1 behind the Host guard, nothing of value to protect); every other chain must name the site (checked above)
const ORIGIN = env.ALLOWED_ORIGIN || "*";
const TRUST_PROXY = env.TRUST_PROXY === "true";
// the local demo binds to loopback only (HOST=0.0.0.0 opts out); elsewhere all interfaces, as before
const HOST = env.HOST || (dep.chainId === 31337 ? "127.0.0.1" : undefined);
const GUARD_HOSTS = HOST && isLoopbackHost(HOST) ? hostsOf([PUBLIC_URL]) : null; // loopback-bound: a foreign Host header is DNS rebinding
const DATA = env.DATA_DIR || join(root, "data/proving");
// locally a random token is printed for convenience; elsewhere /admin/flush exists only if ADMIN_TOKEN is set
if (env.ADMIN_TOKEN && env.ADMIN_TOKEN.length < 32) throw new Error("ADMIN_TOKEN must be at least 32 characters (for example: openssl rand -hex 24)");
const ADMIN_TOKEN = env.ADMIN_TOKEN || (LOCAL ? hexlify(randomBytes(16)) : "");
const CHALLENGE_TTL = 10 * 60;
const DAILY_CAP = 10; // mirrors AgentReputation.SIM_DAILY_CAP (the contract skips anything above it)
const LAB_DAILY_CAP = 5; // lab passes per agent per day: the rest of the shared cap stays for the Energy Cell
const LAB_LEVEL_DAILY_CAP = 1; // and one per level, so one easy level cannot fill it
const MAX_BAD_SIGNATURES = 3; // per Energy Cell challenge, then it is retired (lab ids are re-served: never retired)
const REUSE_MIN_LEFT = 5 * 60; // seconds a re-served lab challenge must still have
const MIN_QUALITY = 1000;
const BATCH_MAX = 50;
const TX_TIMEOUT_MS = Number(env.TX_TIMEOUT_MS || 120_000);
const MAX_BAD_SIGS_HOUR = 20; // wrong signatures per agent per hour (any challenge), then 429; never retires a lab challenge
const MAX_OPEN_CHALLENGES = 20_000; // open challenges overall: the oldest is dropped beyond it
const MAX_OPEN_ARM_PER_NET = 10; // open Energy Cell challenges per agent and client network: the oldest is dropped
const MAX_HITS = Number(env.MAX_HITS || 100_000); // per-network rate-limit keys kept in memory: the oldest is dropped beyond it
const MAX_STRICT = 500_000; // security counters (below): never evicted by network churn; a table full of live keys fails closed
const REGION_FACTOR = 8; // a /24 (IPv4) or /48 (IPv6) gets this many times the budget of one address (/64): rotating inside a /64 or a /48 cannot reset a limit
const OWNER_TTL_MS = 20_000; // ownerOf answers are reused this long (challenges only: a verified run always asks the chain)
const UNREVEALED_TTL_MS = 20_000;
// fee control for attestations (see the header)
const MAX_FEE = env.MAX_FEE_GWEI ? parseUnits(String(env.MAX_FEE_GWEI), "gwei") : 0n;
if (env.MAX_FEE_GWEI && MAX_FEE <= 0n) throw new Error("MAX_FEE_GWEI must be a positive number of gwei");
const REPLACE_AFTER_MS = Number(env.REPLACE_AFTER_MIN ?? 10) * 60_000;
const GET_FILES_PER_MIN = 240; // stored files (results, episodes, batches) per client network
const SYNTH_ARM = 0;
const DEV_KEY = "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a"; // Hardhat public dev key #2

const PUBLIC_RPC = { 1: "https://ethereum-rpc.publicnode.com", 11155111: "https://ethereum-sepolia-rpc.publicnode.com", 31337: "http://127.0.0.1:8545" };
const rpcUrl = env.PROVING_RPC_URL || dep.rpcUrl || PUBLIC_RPC[dep.chainId];
if (!rpcUrl) throw new Error(`No RPC for chain ${dep.chainId}: set PROVING_RPC_URL`);
// what must never reach a log line: the RPC URL and the key pieces it carries (path segments, query values, password)
const LOG_SECRETS = (() => {
  const out = [rpcUrl, env.SIM_ATTESTER_KEY, env.OPENSEA_API_KEY, env.ADMIN_TOKEN];
  try {
    const u = new URL(rpcUrl);
    out.push(...u.pathname.split("/").filter((p) => p.length >= 8), ...u.searchParams.values(), u.password);
  } catch {}
  return out;
})();
const logError = (label, e) => console.error(label, redactSecrets(e, LOG_SECRETS));
const provider = new JsonRpcProvider(rpcUrl, dep.chainId, { staticNetwork: true });
const realChainId = Number((await provider.getNetwork()).chainId);
if (realChainId !== dep.chainId) throw new Error(`RPC chain ${realChainId} != deployment chain ${dep.chainId}`);
for (const d of ["episodes", "results", "batches"]) mkdirSync(join(DATA, d), { recursive: true });
// the Market page's floor price and listing figures: OpenSea's stats, with the key kept here (optional)
const market = createMarketProxy({ apiKey: env.OPENSEA_API_KEY || "", slug: env.OPENSEA_SLUG || slugOf(dep.openseaDropUrl) });

// before the collection is deployed the server runs pilot trials only (pre-mint ranking, nothing on-chain)
const TRIALS_ONLY = !/^0x[0-9a-fA-F]{40}$/.test(dep.agents || "") || /^0x0{40}$/.test(dep.agents);
const attester = !TRIALS_ONLY && env.ATTEST !== "off" && (env.SIM_ATTESTER_KEY || realChainId === 31337) ? new Wallet(env.SIM_ATTESTER_KEY || DEV_KEY, provider) : null; // null = verify-only (ATTEST=off forces it)
if (attester && !LOCAL && !/^https:\/\//.test(PUBLIC_URL)) throw new Error("Set PUBLIC_URL to this server's https:// address: it is written on-chain in every batch");
const agents = TRIALS_ONLY ? null : new Contract(dep.agents, ["function ownerOf(uint256) view returns (address)"], provider);
const renderer = TRIALS_ONLY ? null : new Contract(dep.renderer, ["function traitsOf(uint256) view returns ((uint8 class_,uint8 core,uint8 sensor,uint8 finish,uint8 frame,uint8 district,uint8 faction,uint8 augment,uint8 prefix,uint8 suffix,uint8 legendary))"], provider);
const reputation = TRIALS_ONLY
  ? null
  : new Contract(
      dep.reputation,
      [
        "function attestSimBatch((uint256 tokenId,bool success,uint16 quality,bytes32 dataHash)[] results, string uri)",
        "function isSimAttester(address) view returns (bool)",
        "event SimRejected(uint256 indexed tokenId, bytes32 dataHash, uint8 reason)",
      ],
      attester || provider
    );

// ---------------------------------------------------------------- state (rebuilt from disk on start)
const challenges = new Map(); // challengeId -> { kind: "arm" | "lab", tokenId, owner, seed, issuedAt, used, robot?, level? }
const hits = new Map(); // per-network rate-limit key -> timestamps (evicted oldest-first when full)
const strict = new Map(); // security counters (badsig:, owner:, trial-wallet:) -> timestamps: their own table, so network churn cannot flush them
const trajectories = new Set(); // coarse trajectory hashes (duplicate rejection)
const results = new Map(); // dataHash -> result record (without observation_state)
const attestedToday = new Map(); // `${tokenId}:${day}` -> count (lab keys add `:lab` and `:lab:<robot>/<level>`)
const labSeedCount = new Map(); // `${tokenId}|${robot}|${level}|${day}` -> missions used: the next seed is fixed by it
const labIndex = new Map(); // `tokenId|owner|robot|level` -> id of the latest lab challenge (the only one that can still be reused)
const armIndex = new Map(); // `tokenId|network` -> ids of Energy Cell challenges, oldest first
const labKey = (tokenId, owner, robot, level) => `${tokenId}|${owner}|${robot}|${level}`;
/** Registers an open challenge; the map stays bounded: oldest dropped (never one being verified). Indexed, so no scan of every open challenge. */
function addChallenge(id, ch) {
  if (ch.kind === "arm") {
    const key = `${ch.tokenId}|${ch.ip}`;
    const open = (armIndex.get(key) || []).filter((i) => challenges.get(i) && !challenges.get(i).used);
    const victim = open.length >= MAX_OPEN_ARM_PER_NET ? open.find((i) => !challenges.get(i).busy) : undefined;
    if (victim) (challenges.delete(victim), open.splice(open.indexOf(victim), 1));
    armIndex.set(key, [...open, id]);
  } else {
    labIndex.set(labKey(ch.tokenId, ch.owner, ch.robot, ch.level), id);
  }
  if (challenges.size >= MAX_OPEN_CHALLENGES) {
    let drop; // insertion order = issue order: the first one not being verified is the oldest
    for (const [k, c] of challenges) if (!c.busy) { drop = k; break; }
    challenges.delete(drop ?? challenges.keys().next().value);
  }
  challenges.set(id, ch);
}
const SEED_KEY = randomBytes(32); // per process: seeds cannot be predicted, and asking again returns the same one
let pending = [];

const now = () => Math.floor(Date.now() / 1000);
/** Milliseconds since a challenge was issued: the real-time check needs more than whole seconds (a floored clock reads up to 1 s short). */
const elapsedMs = (ch) => Date.now() - (ch.issuedMs ?? ch.issuedAt * 1000);
const day = (t) => Math.floor(t / 86400);
/** Daily-cap counters a run counts against: the shared one, plus the lab total and its level for lab runs. */
function capKeys(r, d) {
  const base = `${r.tokenId}:${d}`;
  return r.sim === LAB_SIM_ID ? [base, `${base}:lab`, `${base}:lab:${r.robot}/${r.level}`] : [base];
}
const resultFile = (h) => join(DATA, "results", `${h}.json`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Writes to a temp file, then renames it over the target: a crash leaves the old file or the new one, never half of one. */
async function atomicWrite(file, data) {
  const tmp = `${file}.${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(tmp, data);
  for (let i = 0; ; i++) {
    try {
      return await rename(tmp, file);
    } catch (e) {
      if (i >= 4 || !["EPERM", "EBUSY", "EACCES"].includes(e.code)) {
        await unlink(tmp).catch(() => {});
        throw e;
      }
      await sleep(20 * (i + 1)); // Windows: a reader may hold the target for a moment
    }
  }
}
const saving = new Map(); // dataHash -> last queued write: read-merge-write of one record never interleaves with itself
const saveRecord = (r, extra = {}) => {
  const h = r.dataHash;
  const run = async () => {
    const prev = await readFile(resultFile(h), "utf8").then((t) => { try { return JSON.parse(t); } catch { return {}; } }, () => ({}));
    await atomicWrite(resultFile(h), JSON.stringify({ ...prev, ...r, ...extra }));
  };
  const next = (saving.get(h) ?? Promise.resolve()).catch(() => {}).then(run);
  saving.set(h, next);
  const done = () => saving.get(h) === next && saving.delete(h);
  next.then(done, done);
  return next;
};

for (const f of readdirSync(join(DATA, "results")).filter((f) => f.endsWith(".json"))) {
  try {
    const { observation_state, ...r } = JSON.parse(readFileSync(join(DATA, "results", f), "utf8"));
    if (typeof r.dataHash !== "string") throw new Error("no dataHash");
    results.set(r.dataHash, r);
    if (r.attest) {
      trajectories.add(r.trajectoryHash);
      for (const k of capKeys(r, day(r.verifiedAt))) attestedToday.set(k, (attestedToday.get(k) || 0) + 1);
    }
    if (r.attest && r.status !== "attested" && r.status !== "rejected") pending.push(r);
  } catch {
    console.error(`results: skipped unreadable ${f}`); // one bad file must not stop the verifier
  }
}

/**
 * Records marked "sent" survived a crash or timeout: settle them from the receipt, or resend (duplicates are skipped on-chain).
 * A transaction the node still knows (pending, or an RPC hiccup) is never resent as a new batch: that would stack a second one
 * behind it. One that stays pending past REPLACE_AFTER_MIN is replaced at the SAME nonce with higher fees (a fee bump, not a resend).
 */
const unknownRounds = new Map(); // tx hash -> consecutive rounds in which neither a receipt nor the transaction was found
const UNKNOWN_ROUNDS_PASSED = 2; // ... and the account's confirmed nonce is past the batch's: something else took that nonce
const UNKNOWN_ROUNDS_BLIND = 10; // ... without that proof: a load-balanced node that cannot see a pending tx must not make us resend it at a new nonce
async function reconcile() {
  if (flushing) return; // the flush in progress owns its batch
  for (const hash of new Set(pending.filter((x) => x.status === "sent" && x.tx).map((x) => x.tx))) {
    const recs = pending.filter((x) => x.status === "sent" && x.tx === hash);
    let receipt = null, known = null;
    try {
      receipt = await provider.getTransactionReceipt(hash);
      if (!receipt) known = await provider.getTransaction(hash);
      // a bumped-over transaction may still have been the one that got mined: look at the earlier hashes before calling the batch lost
      if (!receipt && !known) for (const old of recs[0].replaced ?? []) if ((receipt = await provider.getTransactionReceipt(old))) break;
    } catch {
      continue; // cannot tell: keep "sent", ask again next round
    }
    if (flushing) return;
    if (receipt || known) unknownRounds.delete(hash);
    if (receipt?.status === 1) for (const r of recs) await settle([r], receipt, r.batch);
    else if (!receipt && known) await replaceStuck(hash, recs, known); // still pending
    else if (receipt) for (const r of recs) r.status = "queued"; // reverted: back to the queue
    else {
      // nobody knows this transaction: dropped, or a flaky node. Only requeue once that is stable, and prefer proof that its nonce was used
      const rounds = (unknownRounds.get(hash) ?? 0) + 1;
      unknownRounds.set(hash, rounds);
      let passed = false;
      try {
        passed = recs[0].nonce != null && (await provider.getTransactionCount(attester.address, "latest")) > recs[0].nonce;
      } catch {
        continue;
      }
      if (rounds < (passed ? UNKNOWN_ROUNDS_PASSED : UNKNOWN_ROUNDS_BLIND)) continue;
      unknownRounds.delete(hash);
      for (const r of recs) r.status = "queued";
    }
  }
}

/** Same nonce, same call, at least +12.5% on both fee fields (what nodes accept as a replacement), never above MAX_FEE_GWEI. */
async function replaceStuck(hash, recs, known) {
  const sentAt = Math.min(...recs.map((r) => r.sentAt ?? 0)); // a record from before this field existed counts as old
  if (!attester || Date.now() - sentAt < REPLACE_AFTER_MS) return;
  if (known.maxFeePerGas == null || known.maxPriorityFeePerGas == null || getAddress(known.from) !== attester.address) return; // legacy or foreign: left to the node
  const bump = (v) => (v * 1125n + 999n) / 1000n;
  const maxFeePerGas = bump(known.maxFeePerGas);
  const maxPriorityFeePerGas = bump(known.maxPriorityFeePerGas);
  if (MAX_FEE && maxFeePerGas > MAX_FEE) return console.log(`batch ${recs[0].batch} is stuck but replacing it would pass MAX_FEE_GWEI: waiting`);
  try {
    const tx = await attester.sendTransaction({ to: known.to, data: known.data, value: known.value, nonce: known.nonce, gasLimit: known.gasLimit, type: 2, maxFeePerGas, maxPriorityFeePerGas });
    const sent = { tx: tx.hash, sentAt: Date.now() };
    for (const r of recs) Object.assign(r, sent, { replaced: [...(r.replaced ?? []), hash] });
    await Promise.all(recs.map((r) => saveRecord(r)));
    console.log(`batch ${recs[0].batch} was pending too long: replaced ${hash} with ${tx.hash} (maxFeePerGas ${maxFeePerGas})`);
  } catch (e) {
    logError("replacing a stuck batch failed, will look again:", e.shortMessage || e); // e.g. the original was mined meanwhile
  }
}

// ---------------------------------------------------------------- helpers
const STRICT_KEY = /^(badsig|owner|trial-wallet):/; // keyed by agent / verified owner / signing wallet: a small natural key space, no network involved
const WIDE_KEY = /^(ip|submit|trial-submit|files|market|admin):(.+)$/; // keyed by client network: also counted per /24 or /48
/** Remember a key last, dropping the least recently used when the table is full. */
function remember(table, cap, key, stamps) {
  table.delete(key);
  if (table.size >= cap) table.delete(table.keys().next().value);
  table.set(key, stamps);
}
function rateLimited(key, max, windowSec = 3600) {
  const table = STRICT_KEY.test(key) ? strict : hits;
  if (table === strict && !strict.has(key) && strict.size >= MAX_STRICT) return true; // full of live security keys: fail closed, never evict
  const wide = table === hits ? WIDE_KEY.exec(key) : null;
  const checks = [[key, max], ...(wide ? [[`${wide[1]}~:${coarseOf(wide[2])}`, max * REGION_FACTOR]] : [])];
  const recent = checks.map(([k]) => (table.get(k) || []).filter((t) => t > now() - windowSec));
  if (recent.some((r, i) => r.length >= checks[i][1])) return true;
  checks.forEach(([k], i) => remember(table, table === hits ? MAX_HITS : MAX_STRICT, k, [...recent[i], now()]));
  return false;
}

setInterval(() => {
  for (const [id, c] of challenges) if (now() - c.issuedAt > CHALLENGE_TTL) challenges.delete(id);
  for (const [k, id] of labIndex) if (!challenges.has(id)) labIndex.delete(k);
  for (const [k, ids] of armIndex) if (!ids.some((i) => challenges.has(i))) armIndex.delete(k);
  for (const [k, ts] of hits) if (!ts.some((t) => t > now() - (k.startsWith("trial-new") ? 86400 : 3600))) hits.delete(k); // daily window for new trial wallets
  for (const [k, ts] of strict) if (!ts.some((t) => t > now() - 3600)) strict.delete(k);
}, 60_000).unref();

// wrong signatures per agent in the last hour (counted on failures only, so honest runs never feed it)
const badSigRecent = (tokenId) => (strict.get(`badsig:${tokenId}`) || []).filter((t) => t > now() - 3600);
const tooManyBadSigs = (tokenId) => badSigRecent(tokenId).length >= MAX_BAD_SIGS_HOUR;
/**
 * The 20-wrong-signatures-an-hour rule stops further WRONG signatures (and contract-wallet checks, which cost an RPC call), but it must not lock
 * the real owner out: a stranger can burn the budget of any agent whose owner address is public. So once the budget is spent, a submission whose
 * signature recovers (locally, no RPC) to the owner of this challenge, who is still the current owner (cached read), is let through.
 */
async function withinBadSigBudget(td, signature, ch) {
  if (!tooManyBadSigs(ch.tokenId)) return true;
  try {
    if (getAddress(verifyTypedData(td.domain, td.types, td.value, signature)) !== ch.owner) return false;
    return (await ownerNow(ch.tokenId)) === ch.owner;
  } catch {
    return false;
  }
}
function noteBadSig(tokenId) {
  remember(strict, MAX_STRICT, `badsig:${tokenId}`, [...badSigRecent(tokenId), now()]);
}

// behind a proxy the RIGHTMOST X-Forwarded-For entry is the one our proxy appended; leftmost entries are client-supplied.
// Every rate-limit key uses the network (IPv6 -> its /64, IPv4-mapped -> the IPv4): an IPv6 client owns a whole /64
const clientIp = (req) => netOf((TRUST_PROXY && String(req.headers["x-forwarded-for"] || "").split(",").at(-1).trim()) || req.socket.remoteAddress);

const json = (res, code, body, extra = {}) => {
  // allow-private-network lets the configured site reach a server on the user's own machine (Chrome Private
  // Network Access); never for a wildcard origin, or any website could probe a local verifier
  res.writeHead(code, {
    "content-type": "application/json", "x-content-type-options": "nosniff", "cache-control": "no-store", "access-control-allow-origin": ORIGIN, "access-control-allow-headers": "content-type, x-admin-token",
    "access-control-allow-methods": "GET, POST, OPTIONS", ...(ORIGIN !== "*" && { "access-control-allow-private-network": "true" }), ...extra,
  });
  res.end(JSON.stringify(body));
};
const fail = (res, code, error) => json(res, code, { error });
/** A stored file as is (already JSON). Content-addressed episodes may be cached briefly; the rest changes. */
const sendBytes = (res, bytes, cache = "no-store") => {
  res.writeHead(200, { "content-type": "application/json", "x-content-type-options": "nosniff", "cache-control": cache, "access-control-allow-origin": ORIGIN, ...(ORIGIN !== "*" && { "access-control-allow-private-network": "true" }) });
  res.end(bytes);
};

// Energy Cell and pilot episodes are at most 1800 six-joint commands (~100 KB), so 256 KB is generous. Lab traces are bigger (fab/layer: up to 4500 steps of 7 fields), so they keep 1 MB.
const BODY_LIMIT = 256 * 1024;
const LAB_BODY_LIMIT = 1_000_000;
async function readBody(req, limit = BODY_LIMIT) {
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw Object.assign(new Error("body too large"), { code: 413 });
    chunks.push(c);
  }
  const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!body || typeof body !== "object") throw Object.assign(new Error("invalid body"), { code: 400 });
  return body;
}

/** The agent's on-chain class index, or null before the reveal / for an unknown token. Traits never change once revealed: kept for good. */
const classCache = new Map(); // tokenId -> class
const unrevealed = new Map(); // tokenId -> ms until which "not revealed" is believed (a reveal is a one-off event)
async function classOf(tokenId) {
  if (classCache.has(tokenId)) return classCache.get(tokenId);
  if ((unrevealed.get(tokenId) ?? 0) > Date.now()) return null;
  try {
    const cls = Number((await renderer.traitsOf(tokenId)).class_);
    classCache.set(tokenId, cls);
    return cls;
  } catch {
    unrevealed.set(tokenId, Date.now() + UNREVEALED_TTL_MS);
    return null;
  }
}
/** Who owns the agent now, from the chain; reused for OWNER_TTL_MS. An unknown token is remembered too, so unminted ids cannot amplify RPC load. */
const ownerCache = new Map(); // tokenId -> { owner | null, at }
async function ownerNow(tokenId) {
  const c = ownerCache.get(tokenId);
  if (c && Date.now() - c.at < OWNER_TTL_MS) {
    if (!c.owner) throw new Error("unknown agent");
    return c.owner;
  }
  try {
    const owner = getAddress(await agents.ownerOf(tokenId));
    ownerCache.set(tokenId, { owner, at: Date.now() });
    return owner;
  } catch (e) {
    ownerCache.set(tokenId, { owner: null, at: Date.now() });
    throw e;
  }
}
const isSynthArm = async (tokenId) => (await classOf(tokenId)) === SYNTH_ARM;
const isArmRecord = (r) => !r.sim || r.sim === SIM_ID; // records written before lab trials carry no sim

const signedByOwner = ownerVerifier(provider);
const trials = createTrials({ dataDir: DATA, chainId: dep.chainId, verifySignature: signedByOwner, rateLimited, now, newWalletsPerHour: env.TRIAL_NEW_WALLETS_PER_HOUR ? Number(env.TRIAL_NEW_WALLETS_PER_HOUR) : undefined });

let statsCache = null;
function stats() {
  // aggregate counters only, cached: no per-IP or time-series data
  if (!statsCache || statsCache.at < Date.now() - 60_000) {
    const all = [...results.values()];
    statsCache = {
      at: Date.now(),
      body: { mission: MISSION, ...trials.stats(), verifiedRuns: all.length, labRuns: all.filter((r) => !isArmRecord(r)).length, pilots: new Set(all.map((r) => r.owner)).size, agents: new Set(all.map((r) => r.tokenId)).size, attestedRuns: all.filter((r) => r.status === "attested").length },
    };
  }
  return statsCache.body;
}

// ---------------------------------------------------------------- handlers
/** Validates tokenId + owner and checks ownership on-chain. Returns { tokenId, owner } or sends the error. */
async function ownedAgent(req, res, q) {
  const tokenId = Number(q.get("tokenId"));
  let owner;
  try {
    owner = getAddress(q.get("owner") || "");
  } catch {
    return fail(res, 400, "invalid owner");
  }
  if (!Number.isInteger(tokenId) || tokenId < 1 || tokenId > 1024) return fail(res, 400, "invalid tokenId");
  if (rateLimited(`ip:${clientIp(req)}`, 120)) return fail(res, 429, "too many requests");
  let current;
  try {
    current = await ownerNow(tokenId);
  } catch {
    return fail(res, 404, "unknown agent");
  }
  if (current !== owner) return fail(res, 403, "this wallet does not own the agent");
  return { tokenId, owner };
}

async function getChallenge(req, res, q) {
  const a = await ownedAgent(req, res, q);
  if (!a) return;
  if (!(await isSynthArm(a.tokenId))) return fail(res, 403, "only Synth Arm agents can fly this mission");
  // the per-owner quota is charged on signed submissions (postEpisode): anyone can ask for a challenge with any
  // public address, so charging it here would let a stranger burn a holder's missions
  const challengeId = hexlify(randomBytes(32));
  const seed = hexlify(randomBytes(32));
  addChallenge(challengeId, { kind: "arm", ...a, seed, issuedAt: now(), issuedMs: Date.now(), used: false, ip: clientIp(req) });
  json(res, 200, { challengeId, seed, mission: MISSION, sim: SIM_ID, expiresAt: now() + CHALLENGE_TTL });
}

/** Lab trial: the agent's own class robot, or any AX-1 body. The seed is a small integer, as on the Workbench. */
async function getLabChallenge(req, res, q) {
  const robot = String(q.get("robot") || "");
  const level = String(q.get("level") || "");
  if (!labLevel(robot, level)) return fail(res, 400, "unknown robot or level");
  const a = await ownedAgent(req, res, q);
  if (!a) return;
  const cls = await classOf(a.tokenId);
  if (cls === null) return fail(res, 403, "this agent is not revealed yet");
  if (!robotsForClass(cls).includes(robot)) return fail(res, 403, "an agent flies its own class robot and the three AX-1 bodies only");
  // asking again never rerolls the layout: the open mission comes back, and a new one only after a submission
  // (same token and owner, at least REUSE_MIN_LEFT left to fly and sign; otherwise a new id with the same layout)
  const openId = labIndex.get(labKey(a.tokenId, a.owner, robot, level));
  const open = openId && challenges.get(openId);
  if (open && !open.used && CHALLENGE_TTL - (now() - open.issuedAt) >= REUSE_MIN_LEFT)
    return json(res, 200, { challengeId: openId, seed: open.seed, robot, level, mission: labMission(robot, level), sim: LAB_SIM_ID, expiresAt: open.issuedAt + CHALLENGE_TTL });
  const challengeId = hexlify(randomBytes(32));
  const seed = labSeed(a.tokenId, robot, level);
  addChallenge(challengeId, { kind: "lab", ...a, robot, level, seed, issuedAt: now(), issuedMs: Date.now(), used: false, badSigs: 0, ip: clientIp(req) });
  json(res, 200, { challengeId, seed, robot, level, mission: labMission(robot, level), sim: LAB_SIM_ID, expiresAt: now() + CHALLENGE_TTL });
}

/** Small least-recently-used memo: the layout work below is pure, so a repeat costs a lookup. */
function lru(max) {
  const m = new Map();
  return {
    get(k) {
      if (!m.has(k)) return undefined;
      const v = m.get(k);
      m.delete(k);
      m.set(k, v);
      return v;
    },
    set(k, v) {
      m.delete(k);
      if (m.size >= max) m.delete(m.keys().next().value);
      m.set(k, v);
    },
  };
}
const idleMemo = lru(4096); // robot|level|seed -> does doing nothing pass
const seedMemo = lru(2048); // token|robot|level|day|missions used -> the seed handed out
const idleCached = (robot, level, seed) => {
  const k = `${robot}|${level}|${seed}`;
  let v = idleMemo.get(k);
  if (v === undefined) idleMemo.set(k, (v = idlePasses(robot, level, seed)));
  return v;
};

/** Deterministic per (agent, robot, level, day, missions used); skips layouts that doing nothing would pass. */
function labSeed(tokenId, robot, level) {
  const n = labSeedCount.get(`${tokenId}|${robot}|${level}|${day(now())}`) || 0;
  const memoKey = `${tokenId}|${robot}|${level}|${day(now())}|${n}`;
  const known = seedMemo.get(memoKey);
  if (known !== undefined) return known;
  for (let k = 0; ; k++) {
    const h = createHmac("sha256", SEED_KEY).update(`${memoKey}|${k}`).digest();
    const seed = (h.readUInt32BE(0) % 999_999) + 1;
    if (k >= 20 || !idleCached(robot, level, seed)) return (seedMemo.set(memoKey, seed), seed);
  }
}

async function postEpisode(req, res) {
  const { episode, signature, deadline } = await readBody(req);
  if (!episode || typeof episode !== "object" || typeof signature !== "string" || !Number.isInteger(deadline)) return fail(res, 400, "missing fields");
  if (tooDeep(episode)) return fail(res, 400, "episode does not match the issued mission"); // before canonicalize walks it
  if (deadline < now() || deadline > now() + 3600) return fail(res, 400, "bad deadline");
  const ch = challenges.get(episode.challengeId);
  if (!ch || ch.used || ch.kind !== "arm") return fail(res, 400, "unknown or used challenge");
  ch.badSigs ??= 0;
  if (ch.busy) return fail(res, 409, "this run is already being verified");
  ch.busy = true; // set before any await: no concurrent double submit; a bad signature does not burn the mission
  try {
    return await verifyAndStore(res, episode, signature, deadline, ch);
  } finally {
    ch.busy = false;
  }
}

async function postLabEpisode(req, res) {
  const { episode, signature, deadline } = await readBody(req, LAB_BODY_LIMIT);
  if (!episode || typeof episode !== "object" || typeof signature !== "string" || !Number.isInteger(deadline)) return fail(res, 400, "missing fields");
  if (tooDeep(episode)) return fail(res, 400, "episode does not match the issued mission");
  if (deadline < now() || deadline > now() + 3600) return fail(res, 400, "bad deadline");
  const ch = challenges.get(episode.challengeId);
  if (!ch || ch.used || ch.kind !== "lab") return fail(res, 400, "unknown or used challenge");
  if (ch.busy) return fail(res, 409, "this run is already being verified");
  ch.busy = true;
  try {
    return await verifyLabAndStore(res, episode, signature, deadline, ch);
  } finally {
    ch.busy = false;
  }
}

/** Top-level fields must be exactly the canonical ones (checked before canonicalize walks untrusted data). */
const sameKeys = (a, b) => Object.keys(a).sort().join() === Object.keys(b).sort().join();

/** A wrong signature does not burn the mission (a typo, the wrong account), but a few in a row retire it. */
function badSignature(res, ch) {
  // a lab id is handed to anyone who asks with the public owner address, so a stranger must not be able to retire it
  if (ch.kind === "arm" && ++ch.badSigs >= MAX_BAD_SIGNATURES) ch.used = true;
  noteBadSig(ch.tokenId); // the per-agent hourly counter rate-limits, it never retires a challenge
  return fail(res, 401, "signature is not from the agent's owner");
}

/**
 * Shared tail of both run kinds: dedupe, daily caps, store, queue for attestation.
 * The decision and the counters are settled before the first await (no two submissions can pass the same duplicate or cap check);
 * the files are written next (episode first, then the record), and only then is the run queued for the batch. A failed write undoes the counters.
 */
async function storeRun({ record, bytes, attestable, failNote, extra = {} }) {
  const d = day(now());
  const [shared, labTotal, labLevelKey] = capKeys(record, d);
  let attest = true;
  let note = attester ? "queued for on-chain attestation" : "verified and stored (this server does not attest on-chain)";
  if (!attestable) [attest, note] = [false, failNote];
  else if (trajectories.has(record.trajectoryHash)) [attest, note] = [false, "duplicate trajectory"];
  else if ((attestedToday.get(shared) || 0) >= DAILY_CAP) [attest, note] = [false, "daily cap reached for this agent"];
  else if (labTotal && (attestedToday.get(labTotal) || 0) >= LAB_DAILY_CAP) [attest, note] = [false, `daily lab cap reached for this agent (${LAB_DAILY_CAP})`];
  else if (labLevelKey && (attestedToday.get(labLevelKey) || 0) >= LAB_LEVEL_DAILY_CAP) [attest, note] = [false, "this level already counted today for this agent"];
  Object.assign(record, { attest, status: attest ? "queued" : "stored", verifiedAt: now() });
  if (attest) {
    trajectories.add(record.trajectoryHash); // only counted runs block a resubmission
    for (const k of capKeys(record, d)) attestedToday.set(k, (attestedToday.get(k) || 0) + 1);
  }
  try {
    // episode files are kept only for attested runs (disk use): failed, duplicate and capped runs keep just their small record
    if (attest) await atomicWrite(join(DATA, "episodes", `${record.dataHash}.json`), bytes);
    await saveRecord(record, attest ? extra : {});
  } catch (e) {
    if (attest) {
      trajectories.delete(record.trajectoryHash);
      for (const k of capKeys(record, d)) attestedToday.set(k, attestedToday.get(k) - 1);
    }
    throw e;
  }
  results.set(record.dataHash, record);
  if (attest) pending.push(record);
  leaderboardCache = null;
  labBoards.clear();
  return { attest, note };
}

async function verifyLabAndStore(res, episode, signature, deadline, ch) {
  if (now() - ch.issuedAt > CHALLENGE_TTL) return fail(res, 400, "challenge expired");
  if (episode.tokenId !== ch.tokenId) return fail(res, 400, "token mismatch");
  const invalid = validateLabActions(ch.robot, ch.level, episode.actions);
  if (invalid) return fail(res, 400, `invalid run: ${invalid}`);
  const canonical = buildLabEpisode({ tokenId: ch.tokenId, challengeId: episode.challengeId, robot: ch.robot, level: ch.level, seed: ch.seed, actions: episode.actions });
  if (!sameKeys(canonical, episode) || canonicalize(canonical) !== canonicalize(episode)) return fail(res, 400, "episode does not match the issued mission");
  const { m } = labLevel(ch.robot, ch.level);
  if (elapsedMs(ch) < episode.actions.length * m.dt * 900) return fail(res, 400, "run submitted faster than real time");

  // the signature is checked before any simulation (stepsUsed, scoring): the typed data needs only the canonical hash
  const bytes = canonicalize(canonical);
  const dataHash = keccak256(toUtf8Bytes(bytes));
  const mission = labMission(ch.robot, ch.level);
  const td = runTypedData({ chainId: dep.chainId, verifyingContract: dep.reputation, tokenId: ch.tokenId, challengeId: episode.challengeId, episodeHash: dataHash, deadline, mission, sim: LAB_SIM_ID });
  if (!(await withinBadSigBudget(td, signature, ch))) return fail(res, 429, "too many wrong signatures for this agent, try again later");
  if (!(await signedByOwner(ch.owner, td, signature))) return badSignature(res, ch); // local ecrecover first; an EOA's wrong signature costs no RPC call twice
  const owner = getAddress(await agents.ownerOf(ch.tokenId));
  if (owner !== ch.owner) return badSignature(res, ch);
  // one replay gives the steps the mission consumed (a longer trace carries padding) and the score
  const scored = scoreLabRunCounted(ch.robot, ch.level, ch.seed, canonical.actions);
  if (scored.crashed) return fail(res, 400, "invalid run");
  if (scored.steps < canonical.actions.length) return fail(res, 400, "invalid run: actions after the run ended");
  if (rateLimited(`owner:${owner}`, 30)) return fail(res, 429, "too many missions this hour");
  ch.used = true;
  const seedKey = `${ch.tokenId}|${ch.robot}|${ch.level}|${day(now())}`;
  labSeedCount.set(seedKey, (labSeedCount.get(seedKey) || 0) + 1); // the next mission gets the next layout

  const { outcome, quality } = scored;
  const trajectoryHash = keccak256(toUtf8Bytes(labTrajectoryKey(ch.tokenId, ch.robot, ch.level, canonical.actions)));
  const record = { dataHash, trajectoryHash, tokenId: ch.tokenId, owner, sim: LAB_SIM_ID, format: LAB_FORMAT, mission, robot: ch.robot, level: ch.level, outcome, quality };
  // only passes are attested: a lab fail says little, and the daily cap is shared with the Synth Arm mission
  const { attest, note } = await storeRun({ record, bytes, attestable: outcome.success, failNote: "not passed: stored, not attested" });
  json(res, 200, { dataHash, outcome, quality, attest, note, episodeUrl: attest ? `${PUBLIC_URL}/episodes/${dataHash}` : null });
}

async function verifyAndStore(res, episode, signature, deadline, ch) {
  if (now() - ch.issuedAt > CHALLENGE_TTL) return fail(res, 400, "challenge expired");
  if (episode.tokenId !== ch.tokenId) return fail(res, 400, "token mismatch");
  const invalid = validateActions(episode.actions);
  if (invalid) return fail(res, 400, `invalid run: ${invalid}`);
  // rebuild the canonical episode server-side: only the recorded actions come from the client
  const canonical = buildEpisode({ tokenId: ch.tokenId, challengeId: episode.challengeId, seed: ch.seed, actions: episode.actions });
  if (!sameKeys(canonical, episode) || canonicalize(canonical) !== canonicalize(episode)) return fail(res, 400, "episode does not match the issued mission");
  if (elapsedMs(ch) < (episode.actions.length / FPS) * 900) return fail(res, 400, "run submitted faster than real time");

  const bytes = canonicalize(canonical);
  const dataHash = keccak256(toUtf8Bytes(bytes));
  const td = runTypedData({ chainId: dep.chainId, verifyingContract: dep.reputation, tokenId: ch.tokenId, challengeId: episode.challengeId, episodeHash: dataHash, deadline });
  if (!(await withinBadSigBudget(td, signature, ch))) return fail(res, 429, "too many wrong signatures for this agent, try again later");
  if (!(await signedByOwner(ch.owner, td, signature))) return badSignature(res, ch);
  const owner = getAddress(await agents.ownerOf(ch.tokenId));
  if (owner !== ch.owner) return badSignature(res, ch);
  if (rateLimited(`owner:${owner}`, 30)) return fail(res, 429, "too many missions this hour");
  ch.used = true;

  const { outcome, states } = replay(ch.seed, canonical.actions, { record: true });
  const quality = score(outcome);
  // coarse trajectory (1 deg, seed excluded) catches resubmissions of the same moves with tiny noise
  const trajectoryHash = keccak256(toUtf8Bytes(`${ch.tokenId}|${canonical.actions.map((a) => a.map(Math.round).join(",")).join(";")}`));
  const record = { dataHash, trajectoryHash, tokenId: ch.tokenId, owner, sim: SIM_ID, outcome, quality };
  // full joint-state traces are kept only for runs worth attesting (dataset value), to bound disk use
  const { attest, note } = await storeRun({ record, bytes, attestable: quality >= MIN_QUALITY, failNote: "quality below the attestation threshold", extra: { observation_state: states } });
  json(res, 200, { dataHash, outcome, quality, attest, note, episodeUrl: attest ? `${PUBLIC_URL}/episodes/${dataHash}` : null });
}

// rankings are rebuilt at most every 30 s and serialized once; clients and proxies may reuse them for as long
const BOARD_CACHE = "public, max-age=30, stale-while-revalidate=60";
let leaderboardCache = null;
function leaderboard(res) {
  if (!leaderboardCache || leaderboardCache.at < Date.now() - 30_000) {
    const by = new Map();
    for (const r of results.values()) {
      if (!isArmRecord(r)) continue;
      const e = by.get(r.tokenId) || { tokenId: r.tokenId, runs: 0, successes: 0, bestSeconds: null };
      e.runs++;
      if (r.outcome.success) {
        e.successes++;
        e.bestSeconds = e.bestSeconds === null ? r.outcome.seconds : Math.min(e.bestSeconds, r.outcome.seconds);
      }
      by.set(r.tokenId, e);
    }
    const top = [...by.values()].filter((e) => e.bestSeconds !== null).sort((a, b) => a.bestSeconds - b.bestSeconds).slice(0, 20);
    leaderboardCache = { at: Date.now(), text: JSON.stringify({ mission: MISSION, top }) };
  }
  sendBytes(res, leaderboardCache.text, BOARD_CACHE);
}

/** Lab ranking per robot and level: each agent's best score (then the fastest time), passes only. */
const labBoards = new Map();
function labLeaderboard(res, q) {
  const robot = String(q.get("robot") || "");
  const level = String(q.get("level") || "");
  if (!labLevel(robot, level)) return fail(res, 400, "unknown robot or level");
  const key = `${robot}/${level}`;
  let board = labBoards.get(key);
  if (!board || board.at < Date.now() - 30_000) {
    const best = new Map();
    for (const r of results.values()) {
      if (r.sim !== LAB_SIM_ID || r.robot !== robot || r.level !== level || !r.outcome.success || !r.attest) continue;
      const b = best.get(r.tokenId);
      if (!b || r.outcome.score > b.score || (r.outcome.score === b.score && r.outcome.seconds < b.seconds)) best.set(r.tokenId, { tokenId: r.tokenId, score: r.outcome.score, seconds: r.outcome.seconds });
    }
    const top = [...best.values()].sort((a, b) => b.score - a.score || a.seconds - b.seconds).slice(0, 20);
    board = { at: Date.now(), text: JSON.stringify({ mission: labMission(robot, level), top }) };
    labBoards.set(key, board);
  }
  sendBytes(res, board.text, BOARD_CACHE);
}

async function serveFile(res, dir, name, valid) {
  if (!valid) return fail(res, 400, "bad id");
  const bytes = await readFile(join(DATA, dir, `${name}.json`)).catch(() => null);
  if (!bytes) return fail(res, 404, "not found");
  // content-addressed episodes never change; a result or batch stops changing once it is settled on-chain
  let settled = false;
  if (dir === "results") settled = ["attested", "rejected"].includes(results.get(name.toLowerCase())?.status);
  else if (dir === "batches") settled = (() => { try { return JSON.parse(bytes).block != null; } catch { return false; } })();
  sendBytes(res, bytes, dir === "episodes" ? "public, max-age=300" : settled ? "public, max-age=30" : "no-store");
}

// ---------------------------------------------------------------- batching
const REJECT = { 1: "invalid quality", 2: "empty data hash", 3: "duplicate", 4: "unknown agent", 5: "daily cap" };

async function settle(batch, receipt, id) {
  const rejected = new Map();
  for (const l of receipt.logs) {
    try {
      const ev = reputation.interface.parseLog(l);
      if (ev?.name === "SimRejected") rejected.set(ev.args.dataHash, REJECT[Number(ev.args.reason)] || "rejected");
    } catch {}
  }
  for (const r of batch) r.status = rejected.has(r.dataHash) ? "rejected" : "attested";
  pending = pending.filter((r) => !batch.includes(r));
  await Promise.all(batch.map((r) => saveRecord(r, { status: r.status, rejectReason: rejected.get(r.dataHash) ?? null, batch: id, tx: receipt.hash })));
}

let flushing = false;
async function flush() {
  if (!attester) return; // verify-only mode
  if (flushing) return;
  const batch = pending.filter((r) => r.status === "queued").sort((a, b) => a.tokenId - b.tokenId).slice(0, BATCH_MAX);
  if (!batch.length) return;
  flushing = true;
  const id = `${now()}-${batch[0].dataHash.slice(2, 10)}`;
  try {
    // fee ceiling: ask what the network wants now and send nothing above MAX_FEE_GWEI; the runs stay queued for the next flush
    let overrides = [];
    if (MAX_FEE) {
      const fd = await provider.getFeeData();
      const eip1559 = fd.maxFeePerGas != null;
      const price = eip1559 ? fd.maxFeePerGas : fd.gasPrice;
      if (price == null || price > MAX_FEE) return console.log(`fee ceiling: network wants ${price == null ? "an unknown fee" : `${price} wei`}, MAX_FEE_GWEI allows ${MAX_FEE} wei: ${batch.length} runs stay queued`);
      overrides = [eip1559 ? { maxFeePerGas: price, maxPriorityFeePerGas: fd.maxPriorityFeePerGas != null && fd.maxPriorityFeePerGas < price ? fd.maxPriorityFeePerGas : price } : { gasPrice: price }];
    }
    const uri = `${PUBLIC_URL}/batches/${id}`;
    const sims = [...new Set(batch.map((r) => r.sim || SIM_ID))];
    const meta = { id, sim: sims[0], sims, format: sims.length > 1 ? [FORMAT, LAB_FORMAT] : sims[0] === SIM_ID ? FORMAT : LAB_FORMAT, dataHashes: batch.map((r) => r.dataHash) };
    await atomicWrite(join(DATA, "batches", `${id}.json`), JSON.stringify(meta, null, 1));
    const tx = await reputation.attestSimBatch(batch.map((r) => ({ tokenId: r.tokenId, success: r.outcome.success, quality: r.quality, dataHash: r.dataHash })), uri, ...overrides);
    const sentAt = Date.now();
    for (const r of batch) Object.assign(r, { status: "sent", tx: tx.hash, batch: id, sentAt, nonce: tx.nonce });
    await Promise.all(batch.map((r) => saveRecord(r, { status: "sent", tx: tx.hash, batch: id, sentAt, nonce: tx.nonce }))); // persisted before waiting: survives crashes
    const receipt = await tx.wait(1, TX_TIMEOUT_MS);
    await settle(batch, receipt, id);
    await atomicWrite(join(DATA, "batches", `${id}.json`), JSON.stringify({ ...meta, tx: tx.hash, block: receipt.blockNumber }, null, 1));
    console.log(`attested batch ${id}: ${batch.length} runs (${tx.hash})`);
  } catch (e) {
    // once the tx is sent the batch stays "sent" (also on a wait timeout: it may still be pending) and reconcile() settles it;
    // only failures before the send go back to the queue
    for (const r of batch) if (r.status !== "sent") r.status = "queued";
    logError("batch failed, will retry:", e.shortMessage || e);
  } finally {
    flushing = false;
  }
}
if (!TRIALS_ONLY) {
  await reconcile();
  setInterval(() => reconcile().then(flush).catch((e) => logError("flush round failed:", e)), FLUSH_SECONDS * 1000);
}

// ---------------------------------------------------------------- http
const server = createServer(async (req, res) => {
  try {
    if (GUARD_HOSTS && !hostAllowed(req.headers.host, GUARD_HOSTS)) return fail(res, 421, "misdirected request");
    let url;
    try {
      url = new URL(req.url, "http://x"); // a raw request line like "GET //[" does not parse: that is the client's fault, not a crash
    } catch {
      return fail(res, 400, "bad request");
    }
    const tail = (prefix) => url.pathname.slice(prefix.length);
    if (req.method === "OPTIONS") return json(res, 204, {});
    if (req.method === "GET" && url.pathname === "/health") return json(res, 200, { ok: true, sim: SIM_ID, labSim: LAB_SIM_ID, chainId: dep.chainId, attesting: Boolean(attester), trialsOnly: TRIALS_ONLY, pending: pending.length });
    if (req.method === "GET" && url.pathname === "/stats") return json(res, 200, stats(), { "cache-control": "public, max-age=60" });
    if (req.method === "GET" && url.pathname === "/market") {
      if (rateLimited(`market:${clientIp(req)}`, 60, 60)) return fail(res, 429, "too many requests");
      const { status, body } = await market.get();
      return json(res, status, body, status === 200 ? { "cache-control": "public, max-age=60" } : {});
    }
    // pilot trials (pre-mint ranking, any wallet)
    if (req.method === "GET" && url.pathname === "/trial/challenge") return json(res, ...trials.challenge(clientIp(req), url.searchParams.get("wallet")));
    if (req.method === "POST" && url.pathname === "/trial/episodes") {
      if (rateLimited(`trial-submit:${clientIp(req)}`, 60)) return fail(res, 429, "too many submissions"); // before parsing or any RPC
      return json(res, ...(await trials.submit(await readBody(req))));
    }
    if (req.method === "GET" && url.pathname === "/trial/leaderboard") return sendBytes(res, trials.leaderboard()[2], BOARD_CACHE);
    if (req.method === "GET" && url.pathname.startsWith("/trial/episodes/")) {
      const h = tail("/trial/episodes/");
      if (rateLimited(`files:${clientIp(req)}`, GET_FILES_PER_MIN, 60)) return fail(res, 429, "too many requests");
      const file = isHexString(h, 32) ? await trials.episodeFile(h) : null;
      if (!file) return fail(res, isHexString(h, 32) ? 404 : 400, "not found");
      return sendBytes(res, file, "public, max-age=300");
    }
    if (TRIALS_ONLY) return fail(res, 404, "the collection is not deployed yet: only pilot trials are open");
    if (req.method === "GET" && url.pathname === "/challenge") return await getChallenge(req, res, url.searchParams);
    if (req.method === "POST" && (url.pathname === "/episodes" || url.pathname === "/lab/episodes") && rateLimited(`submit:${clientIp(req)}`, 120)) return fail(res, 429, "too many submissions"); // before parsing or any RPC
    if (req.method === "POST" && url.pathname === "/episodes") return await postEpisode(req, res);
    if (req.method === "GET" && url.pathname === "/leaderboard") return leaderboard(res);
    if (req.method === "GET" && url.pathname === "/lab/challenge") return await getLabChallenge(req, res, url.searchParams);
    if (req.method === "POST" && url.pathname === "/lab/episodes") return await postLabEpisode(req, res);
    if (req.method === "GET" && url.pathname === "/lab/leaderboard") return labLeaderboard(res, url.searchParams);
    if (req.method === "GET" && /^\/(episodes|results|batches)\//.test(url.pathname) && rateLimited(`files:${clientIp(req)}`, GET_FILES_PER_MIN, 60)) return fail(res, 429, "too many requests");
    if (req.method === "GET" && url.pathname.startsWith("/episodes/")) return serveFile(res, "episodes", tail("/episodes/"), isHexString(tail("/episodes/"), 32));
    if (req.method === "GET" && url.pathname.startsWith("/results/")) return serveFile(res, "results", tail("/results/"), isHexString(tail("/results/"), 32));
    if (req.method === "GET" && url.pathname.startsWith("/batches/")) return serveFile(res, "batches", tail("/batches/"), /^\d+-[0-9a-f]{8}$/.test(tail("/batches/")));
    if (req.method === "POST" && url.pathname === "/admin/flush") {
      if (rateLimited(`admin:${clientIp(req)}`, 30)) return fail(res, 429, "too many requests");
      const given = Buffer.from(String(req.headers["x-admin-token"] || ""));
      const expected = Buffer.from(ADMIN_TOKEN);
      if (!ADMIN_TOKEN || given.length !== expected.length || !timingSafeEqual(given, expected)) return fail(res, 401, "unauthorized");
      await flush();
      return json(res, 200, { ok: true, pending: pending.length });
    }
    fail(res, 404, "not found");
  } catch (e) {
    // a RangeError is untrusted JSON nested past what the stack can walk
    const code = e.code === 413 || e.code === 400 ? e.code : e instanceof SyntaxError || e instanceof RangeError ? 400 : 500;
    if (!res.headersSent) fail(res, code, code === 500 ? "server error" : e instanceof RangeError ? "invalid body" : e.message);
    if (code === 500) logError("server error:", e); // redacted: ethers errors carry the RPC URL, key included
  }
});
hardenHttpServer(server, { maxConnections: 2000 });
server.listen(PORT, HOST, async () => {
  if (TRIALS_ONLY) {
    console.log(`Proving Grounds verifier on ${PUBLIC_URL} (chain ${dep.chainId}) — trials-only mode (no collection deployed yet)`);
  } else if (!attester) {
    console.log(`Proving Grounds verifier on ${PUBLIC_URL} (chain ${dep.chainId}) — verify-only mode (no SIM_ATTESTER_KEY)`);
  } else {
    const ok = await reputation.isSimAttester(attester.address).catch(() => false);
    console.log(`Proving Grounds verifier on ${PUBLIC_URL} (chain ${dep.chainId}) — attester ${attester.address}`);
    if (!ok) console.error("WARNING: attester is NOT authorized (call AgentReputation.setSimAttester). Runs will queue until it is.");
  }
  if (!env.ADMIN_TOKEN && LOCAL) console.log(`admin token (this session): ${ADMIN_TOKEN}`);
});
