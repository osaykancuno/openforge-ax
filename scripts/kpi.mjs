// KPI report: npm run kpi -- mainnet|sepolia|localhost   → table on screen + kpi-<chainId>-<date>.json
// On-chain numbers via Multicall3 (one pinned block), verifier numbers via its public /stats.
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Contract, Interface, JsonRpcProvider, ZeroAddress } from "ethers";
import "dotenv/config";

const NETS = {
  mainnet: { chainId: 1, rpc: process.env.MAINNET_RPC_URL || "https://ethereum-rpc.publicnode.com" },
  sepolia: { chainId: 11155111, rpc: process.env.SEPOLIA_RPC_URL || "https://ethereum-sepolia-rpc.publicnode.com" },
  localhost: { chainId: 31337, rpc: "http://127.0.0.1:8545" },
};
const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11";
const net = NETS[process.argv[2] || "mainnet"];
if (!net) throw new Error("Usage: npm run kpi -- mainnet|sepolia|localhost");

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dep = JSON.parse(readFileSync(join(root, net.chainId === 31337 ? "web/deployment.json" : `deployments-${net.chainId}.json`), "utf8"));
const provider = new JsonRpcProvider(net.rpc, net.chainId, { staticNetwork: true });
const blockTag = await provider.getBlockNumber();

const agentsI = new Interface(["function totalSupply() view returns (uint256)", "function ownerOf(uint256) view returns (address)", "function accountOf(uint256) view returns (address)", "function seed() view returns (bytes32)"]);
const acctI = new Interface(["function operator() view returns (address)", "function lockedUntil() view returns (uint64)", "function lockOwner() view returns (address)", "function paused() view returns (bool)"]);
const repI = new Interface(["function statsOf(uint256) view returns (uint32,uint32,uint32,uint64)", "function simStatsOf(uint256) view returns (uint32,uint32)"]);
const mc = new Contract(MULTICALL3, ["function aggregate3((address target,bool allowFailure,bytes callData)[] calls) view returns ((bool success,bytes returnData)[])"], provider);

const hasMulticall = (await provider.getCode(MULTICALL3)) !== "0x"; // deployed on mainnet and testnets, not on a local node

/** Batched view calls; a failed or empty return (e.g. an undeployed account) decodes to null. */
async function batch(calls) {
  const out = [];
  if (!hasMulticall) {
    for (let i = 0; i < calls.length; i += 50) {
      const part = await Promise.all(calls.slice(i, i + 50).map(async ([target, iface, fn, args]) => {
        try {
          const data = await provider.call({ to: target, data: iface.encodeFunctionData(fn, args), blockTag });
          return data === "0x" ? null : iface.decodeFunctionResult(fn, data);
        } catch {
          return null;
        }
      }));
      out.push(...part);
    }
    return out;
  }
  for (let i = 0; i < calls.length; i += 250) {
    const chunk = calls.slice(i, i + 250);
    const res = await mc.aggregate3.staticCall(chunk.map(([target, iface, fn, args]) => ({ target, allowFailure: true, callData: iface.encodeFunctionData(fn, args) })), { blockTag });
    res.forEach((r, k) => {
      const [, iface, fn] = chunk[k];
      try {
        out.push(r.success && r.returnData !== "0x" ? iface.decodeFunctionResult(fn, r.returnData) : null);
      } catch {
        out.push(null);
      }
    });
  }
  return out;
}

const [[supply], [seed]] = await batch([[dep.agents, agentsI, "totalSupply", []], [dep.agents, agentsI, "seed", []]]);
const ids = Array.from({ length: Number(supply) }, (_, i) => i + 1);
const owners = await batch(ids.map((id) => [dep.agents, agentsI, "ownerOf", [id]]));
const accounts = await batch(ids.map((id) => [dep.agents, agentsI, "accountOf", [id]]));
const acctCalls = accounts.flatMap((a) => ["operator", "lockedUntil", "lockOwner"].map((fn) => [a[0], acctI, fn, []]));
const acct = await batch(acctCalls);
const rep = dep.reputation ? await batch(ids.flatMap((id) => [[dep.reputation, repI, "statsOf", [id]], [dep.reputation, repI, "simStatsOf", [id]]])) : [];
const { timestamp } = await provider.getBlock(blockTag);

let configured = 0, locked = 0, tasks = 0, failures = 0, simRuns = 0, agentsWithRecord = 0;
ids.forEach((_, i) => {
  const [op, until] = [acct[i * 3]?.[0], acct[i * 3 + 1]?.[0]];
  if (op && op !== ZeroAddress) configured++;
  if (until && Number(until) > timestamp) locked++; // the sale lock binds the wallet for every holder until it expires
  const st = rep[i * 2];
  const sim = rep[i * 2 + 1];
  if (st) [tasks, failures] = [tasks + Number(st[0]), failures + Number(st[2])];
  if (sim) simRuns += Number(sim[0]);
  if ((st && Number(st[0]) > 0) || (sim && Number(sim[0]) > 0)) agentsWithRecord++;
});
const holders = new Set(owners.filter(Boolean).map((o) => o[0])).size;

let verifier = null;
const api = (process.env.PROVING_API || dep.provingApi || "").replace(/\/$/, "");
if (api) verifier = await fetch(`${api}/stats`).then((r) => (r.ok ? r.json() : null)).catch(() => null);

const pct = (n) => (supply > 0n ? ` (${Math.round((n / Number(supply)) * 100)}%)` : "");
const report = {
  network: process.argv[2] || "mainnet", block: blockTag, at: new Date(timestamp * 1000).toISOString(), collection: dep.agents,
  minted: Number(supply), revealed: seed !== "0x" + "0".repeat(64), holders, walletsWithOperator: configured, walletsLockedForSale: locked,
  agentsWithRecord, realTasks: tasks, failuresLogged: failures, simRunsAttested: simRuns, verifier,
};
const rows = [
  ["Minted", report.minted], ["Revealed", report.revealed ? "yes" : "no"], ["Unique holders", holders],
  ["Agent wallets with an operator (mode set)", configured + pct(configured)], ["Wallets locked for sale", locked + pct(locked)],
  ["Agents with an on-chain record", agentsWithRecord + pct(agentsWithRecord)], ["Real tasks attested / failures logged", `${tasks} / ${failures}`], ["Sim runs attested", simRuns],
  ...(verifier ? [["Pilot trials submitted / pilots / allowlist-eligible", `${verifier.trialSubmissions} / ${verifier.trialPilots} / ${verifier.trialEligible}`], ["Verified agent runs / pilots", `${verifier.verifiedRuns} / ${verifier.pilots}`]] : [["Verifier", api ? "offline" : "PROVING_API not set"]]),
];
console.log(`\nOpenForge AX KPIs · ${report.network} · block ${blockTag} · ${report.at}\n`);
for (const [k, v] of rows) console.log(`${k.padEnd(52)} ${v}`);
const file = `kpi-${net.chainId}-${report.at.slice(0, 10)}.json`;
writeFileSync(join(root, file), JSON.stringify(report, null, 2));
console.log(`\nSaved ${file}. Site traffic: Cloudflare Web Analytics (Pages dashboard → Metrics).`);
