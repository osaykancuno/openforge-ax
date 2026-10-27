// Allowlist export from the pilot trials: npm run trials:export [-- <DATA_DIR>]  → allowlist-candidates.csv
// Eligible = the gate in scripts/lib/trials.mjs (3+ docked runs on 2+ days). Wallets sharing a network (salted IP
// hash, never published) form a cluster: give one spot per cluster after a human look. Then upload the final list
// in OpenSea Studio (allowlist stage).
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { ELIGIBLE } from "./lib/trials.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dir = join(process.argv[2] || process.env.DATA_DIR || join(root, "data/proving"), "trials");
const pilots = readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")));
const median3 = (xs) => (xs.length >= 3 ? [...xs].sort((a, b) => a - b)[1] : null);

// union-find over shared IP hashes
const parent = new Map();
const find = (x) => (parent.get(x) === x ? x : (parent.set(x, find(parent.get(x))), parent.get(x)));
for (const p of pilots) parent.set(p.wallet, p.wallet);
const byIp = new Map();
for (const p of pilots) for (const h of p.ips || []) byIp.set(h, [...(byIp.get(h) || []), p.wallet]);
for (const ws of byIp.values()) for (const w of ws.slice(1)) parent.set(find(w), find(ws[0]));

const rows = pilots
  .map((p) => ({ ...p, score: median3(p.best3 || []), eligible: p.successes >= ELIGIBLE.successes && (p.days || []).length >= ELIGIBLE.days, cluster: find(p.wallet).slice(0, 10), minElapsed: Math.min(...(p.elapsed || [Infinity])) }))
  .sort((a, b) => (b.eligible - a.eligible) || (a.score ?? 1e9) - (b.score ?? 1e9));
const sizes = rows.reduce((m, r) => m.set(r.cluster, (m.get(r.cluster) || 0) + 1), new Map());
const csv = ["wallet,eligible,score_median_best3,best_seconds,docked_runs,runs,days,cluster,cluster_size,fastest_submit_s,best_run"]
  .concat(rows.map((r) => [r.wallet, r.eligible, r.score ?? "", r.bestSeconds ?? "", r.successes, r.runs, (r.days || []).length, r.cluster, sizes.get(r.cluster), r.minElapsed, r.bestDataHash ?? ""].join(",")))
  .join("\n");
writeFileSync(join(root, "allowlist-candidates.csv"), csv + "\n");
console.log(`${rows.length} pilots, ${rows.filter((r) => r.eligible).length} eligible, ${new Set(rows.filter((r) => r.eligible).map((r) => r.cluster)).size} distinct clusters → allowlist-candidates.csv`);
