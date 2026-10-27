// Pilot trials: pre-mint ranking for guests (any wallet, nothing on-chain). See docs/10-GROWTH-TOOLS.md.
// The ranking is a gate for the allowlist, not a straight top-N: the team exports it (scripts/trials-export.mjs),
// reviews clusters of wallets, then fills the SeaDrop allowlist.
import { mkdirSync, readFileSync, writeFileSync, renameSync, readdirSync, existsSync, unlinkSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes, createHmac } from "node:crypto";
import { getAddress, hexlify, keccak256, toUtf8Bytes } from "ethers";
import { replay, validateActions, MISSION, SIM_ID, FPS } from "../../web/js/sim/arm-sim.js";
import { buildEpisode, canonicalize, trialTypedData } from "../../web/js/sim/episode.js";
import { netOf, net24Of } from "./signatures.mjs";

const TTL = 10 * 60;
const MAX_OPEN_PER_WALLET = 5;
const MAX_OPEN_TOTAL = 5000; // beyond it the oldest open mission is dropped (never a refusal)
const MAX_OPEN_PER_NET = 20; // open missions per /24 (IPv4) or /64 (IPv6), whatever the wallets: oldest dropped
const NEW_WALLETS_PER_IP_DAY = 10;
const MAX_PILOTS = 200_000; // bounds disk and memory
// A speed bump for the allowlist, not proof of a human: the mission is deterministic, so a scripted solver can
// qualify. The team reviews the export (clusters, submit timing, best-run files) before granting spots.
export const ELIGIBLE = { successes: 3, days: 2 }; // distinct seeds are implied: one per challenge

const day = (t) => Math.floor(t / 86400);
/** Top-level fields must be exactly the canonical ones (checked before canonicalize walks untrusted data). */
const sameKeys = (a, b) => Object.keys(a).sort().join() === Object.keys(b).sort().join();
const median3 = (xs) => (xs.length >= 3 ? [...xs].sort((a, b) => a - b)[1] : null);

export function createTrials({ dataDir, chainId, verifySignature, rateLimited, now }) {
  const dir = join(dataDir, "trials");
  mkdirSync(join(dir, "episodes"), { recursive: true });
  // IP hashes (salted, kept private) let the team cluster wallets at export time; raw IPs are never stored
  const saltFile = join(dir, ".salt");
  if (!existsSync(saltFile)) writeFileSync(saltFile, hexlify(randomBytes(32)));
  const salt = readFileSync(saltFile, "utf8");
  // IPv6 clients can rotate inside their /64: hash the /64 prefix (IPv4, incl. ::ffff:a.b.c.d, as is)
  const ipHash = (ip) => createHmac("sha256", salt).update(netOf(ip)).digest("hex").slice(0, 16);
  const netHash = (ip) => createHmac("sha256", salt).update(net24Of(ip)).digest("hex").slice(0, 16);

  const challenges = new Map(); // trial challenges only, never shared with agent runs
  const pilots = new Map(); // wallet -> record (in-memory index, loaded once)
  let submissions = 0;
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
    try {
      const r = JSON.parse(readFileSync(join(dir, f), "utf8"));
      pilots.set(r.wallet, r);
      submissions += r.runs;
    } catch {
      console.error(`trials: skipped unreadable ${f}`); // one bad file must not stop the server
    }
  }
  const atomicWrite = (file, data) => {
    writeFileSync(`${file}.tmp`, data);
    renameSync(`${file}.tmp`, file);
  };
  const save = (r) => atomicWrite(join(dir, `${r.wallet.toLowerCase()}.json`), JSON.stringify(r));

  setInterval(() => {
    for (const [id, c] of challenges) if (now() - c.issuedAt > TTL) challenges.delete(id);
  }, 60_000).unref();

  /** Count and oldest match (the map is in insertion order = issue order); no allocation, it runs on every request. */
  function scan(pred) {
    let count = 0, oldest;
    for (const [id, c] of challenges) if (pred(c)) (count++, (oldest ??= id));
    return { count, oldest };
  }

  function challenge(ip, walletParam) {
    let wallet;
    try {
      wallet = getAddress(walletParam || "");
    } catch {
      return [400, { error: "invalid wallet" }];
    }
    const net = ipHash(ip);
    if (rateLimited(`trial-ip:${net}`, 120)) return [429, { error: "too many requests" }];
    // the cap counts only this network's open missions for the wallet, so a stranger cannot lock someone out;
    // the oldest unused one is recycled instead of refusing
    const mine = scan((c) => c.wallet === wallet && c.ip === net && !c.used);
    // "new wallet" is charged once per wallet and network, not on every reload
    if (!pilots.has(wallet) && !mine.count && rateLimited(`trial-new:${net}`, NEW_WALLETS_PER_IP_DAY, 86400)) return [429, { error: "too many new wallets from this network today" }];
    if (mine.count >= MAX_OPEN_PER_WALLET) challenges.delete(mine.oldest);
    if (pilots.size >= MAX_PILOTS && !pilots.has(wallet)) return [503, { error: "busy, try again later" }]; // existing pilots are never locked out
    const wide = netHash(ip);
    const sameNet = scan((c) => c.net === wide && !c.busy);
    if (sameNet.count >= MAX_OPEN_PER_NET) challenges.delete(sameNet.oldest);
    if (challenges.size >= MAX_OPEN_TOTAL) challenges.delete(challenges.keys().next().value); // insertion order = oldest first
    const challengeId = hexlify(randomBytes(32));
    const seed = hexlify(randomBytes(32));
    challenges.set(challengeId, { wallet, seed, issuedAt: now(), issuedMs: Date.now(), used: false, ip: net, net: wide, badSigs: 0 });
    return [200, { challengeId, seed, mission: MISSION, sim: SIM_ID, expiresAt: now() + TTL }];
  }

  async function submit({ episode, signature, deadline }) {
    if (!episode || typeof episode !== "object" || typeof signature !== "string" || !Number.isInteger(deadline)) return [400, { error: "missing fields" }];
    if (deadline < now() || deadline > now() + 3600) return [400, { error: "bad deadline" }];
    const ch = challenges.get(episode.challengeId);
    if (!ch || ch.used) return [400, { error: "unknown or used challenge" }];
    if (ch.busy) return [409, { error: "this run is already being verified" }];
    ch.busy = true;
    try {
      if (now() - ch.issuedAt > TTL) return [400, { error: "challenge expired" }];
      if (episode.tokenId !== 0) return [400, { error: "trials use tokenId 0" }];
      const invalid = validateActions(episode.actions);
      if (invalid) return [400, { error: `invalid run: ${invalid}` }];
      const canonical = buildEpisode({ tokenId: 0, challengeId: episode.challengeId, seed: ch.seed, actions: episode.actions });
      if (!sameKeys(canonical, episode) || canonicalize(canonical) !== canonicalize(episode)) return [400, { error: "episode does not match the issued mission" }];
      const elapsed = now() - ch.issuedAt;
      // in ms: a clock floored to seconds reads up to 1 s short
      if (Date.now() - (ch.issuedMs ?? ch.issuedAt * 1000) < (episode.actions.length / FPS) * 900) return [400, { error: "run submitted faster than real time" }];
      const bytes = canonicalize(canonical);
      const dataHash = keccak256(toUtf8Bytes(bytes));
      const td = trialTypedData({ chainId, wallet: ch.wallet, challengeId: episode.challengeId, episodeHash: dataHash, deadline });
      if (!(await verifySignature(ch.wallet, td, signature))) {
        if (++ch.badSigs >= 3) challenges.delete(episode.challengeId); // bounds signature checks (and RPC calls) per mission
        return [401, { error: "signature is not from this wallet" }];
      }
      if (rateLimited(`trial-wallet:${ch.wallet}`, 30)) return [429, { error: "too many missions this hour" }];
      ch.used = true;

      // synchronous from here: no other request can interleave this read-modify-write
      const outcome = replay(ch.seed, canonical.actions); // without { record } it returns the outcome itself
      const r = pilots.get(ch.wallet) || { wallet: ch.wallet, runs: 0, successes: 0, bestSeconds: null, bestDataHash: null, best3: [], days: [], ips: [], elapsed: [], firstAt: now(), lastAt: 0 };
      r.runs++;
      r.lastAt = now();
      submissions++;
      if (!r.ips.includes(ch.ip)) r.ips = [...r.ips, ch.ip].slice(-5);
      r.elapsed = [...r.elapsed, elapsed].slice(-10); // submit minus issue: batches of instant solves stand out
      let best = false;
      if (outcome.success) {
        r.successes++;
        if (!r.days.includes(day(now()))) r.days = [...r.days, day(now())].slice(-30);
        r.best3 = [...r.best3, outcome.seconds].sort((a, b) => a - b).slice(0, 3);
        if (r.bestSeconds === null || outcome.seconds < r.bestSeconds) {
          const previous = r.bestDataHash;
          [r.bestSeconds, r.bestDataHash, r.bestAt, best] = [outcome.seconds, dataHash, now(), true];
          atomicWrite(join(dir, "episodes", `${dataHash}.json`), bytes); // the best run per wallet stays auditable
          if (previous && previous !== dataHash) {
            try {
              unlinkSync(join(dir, "episodes", `${previous}.json`)); // only the current best is kept: disk use stays per wallet
            } catch {}
          }
        }
      }
      pilots.set(ch.wallet, r);
      save(r);
      board = null;
      return [200, { dataHash, outcome, best, bestSeconds: r.bestSeconds, successes: r.successes, runs: r.runs, eligible: isEligible(r) }];
    } finally {
      ch.busy = false;
    }
  }

  const isEligible = (r) => r.successes >= ELIGIBLE.successes && r.days.length >= ELIGIBLE.days;
  const publicRow = (r) => ({ wallet: r.wallet, score: median3(r.best3), bestSeconds: r.bestSeconds, successes: r.successes, runs: r.runs, eligible: isEligible(r), bestRun: r.bestDataHash });

  let board = null;
  function leaderboard() {
    if (!board || board.at < Date.now() - 15_000) {
      // ranked by the median of the best 3 runs (one lucky run is not enough); ties go to whoever got there first
      const top = [...pilots.values()]
        .filter((r) => r.bestSeconds !== null)
        .sort((a, b) => (median3(a.best3) ?? 1e9) - (median3(b.best3) ?? 1e9) || a.bestSeconds - b.bestSeconds || a.bestAt - b.bestAt)
        .slice(0, 100)
        .map(publicRow);
      board = { at: Date.now(), body: { mission: MISSION, rule: `eligible: ${ELIGIBLE.successes}+ docked runs on ${ELIGIBLE.days}+ days; score = median of the best 3`, top } };
    }
    return [200, board.body];
  }

  async function episodeFile(hash) {
    return readFile(join(dir, "episodes", `${hash}.json`)).catch(() => null);
  }

  const stats = () => ({ trialSubmissions: submissions, trialPilots: pilots.size, trialEligible: [...pilots.values()].filter(isEligible).length });

  return { challenge, submit, leaderboard, episodeFile, stats };
}
