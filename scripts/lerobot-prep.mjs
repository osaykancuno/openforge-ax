// Step 1 of the LeRobot export: collect verified runs and replay them with the site's own simulator (the single
// source of truth), producing one JSON line per episode with actions, measured joint states and the outcome.
// Step 2 (scripts/real/export_lerobot.py) writes the LeRobot dataset with the official `lerobot` library.
//
//   node scripts/lerobot-prep.mjs --data data/proving [--attested] [--trials] [--runs a.json b.json] [--out lerobot-src.jsonl]
//
//   --data DIR    a verifier DATA_DIR: agent runs (episodes/ + results/)
//   --attested    only runs already attested on-chain (status "attested")
//   --trials      also the best pilot-trial run of each wallet (DATA_DIR/trials/episodes)
//   --runs FILES  run files downloaded from the Proving Grounds ("Download run file")
import { readFileSync, readdirSync, existsSync, writeFileSync } from "node:fs";
import { join, basename } from "node:path";
import { keccak256, toUtf8Bytes } from "ethers";
import { replay, score, validateActions, FPS, JOINTS, ROBOT, SIM_ID, MISSION } from "../web/js/sim/arm-sim.js";
import { buildEpisode, canonicalize } from "../web/js/sim/episode.js";

const argv = process.argv.slice(2);
const flag = (k) => argv.includes(`--${k}`);
const opt = (k) => (argv.includes(`--${k}`) ? argv[argv.indexOf(`--${k}`) + 1] : null);
const list = (k) => {
  const i = argv.indexOf(`--${k}`);
  if (i < 0) return [];
  const out = [];
  for (let j = i + 1; j < argv.length && !argv[j].startsWith("--"); j++) out.push(argv[j]);
  return out;
};
const dataDir = opt("data");
const outFile = opt("out") || "lerobot-src.jsonl";
const TASK = "Pick up the energy cell and place it in the charging dock.";
const lines = [];
const skipped = [];

/** Rebuilds the canonical episode, checks its hash (when known), replays it; null if anything is off. */
function verify(ep, { expectHash = null, source, meta = {} }) {
  if (!ep || !Array.isArray(ep.actions) || typeof ep.seed !== "string") return skipped.push(`${source}: not an episode`), null;
  if (ep.sim !== SIM_ID || ep.mission !== MISSION) return skipped.push(`${source}: other sim or mission (${ep.sim}/${ep.mission})`), null;
  const invalid = validateActions(ep.actions);
  if (invalid) return skipped.push(`${source}: invalid actions (${invalid})`), null;
  const canonical = buildEpisode({ tokenId: ep.tokenId ?? 0, challengeId: ep.challengeId, seed: ep.seed, actions: ep.actions });
  const dataHash = keccak256(toUtf8Bytes(canonicalize(canonical)));
  if (expectHash && dataHash !== expectHash) return skipped.push(`${source}: content does not match its hash`), null;
  const { outcome, states } = replay(ep.seed, canonical.actions, { record: true });
  return {
    dataHash, source, tokenId: canonical.tokenId, seed: ep.seed, challengeId: ep.challengeId,
    fps: FPS, robot_type: ROBOT.robot_type, joints: JOINTS, units: ROBOT.units, task: TASK,
    success: outcome.success, seconds: outcome.seconds, quality: score(outcome), events: outcome.events,
    actions: canonical.actions, states, ...meta,
  };
}

if (dataDir) {
  const results = join(dataDir, "results");
  for (const f of existsSync(results) ? readdirSync(results).filter((f) => f.endsWith(".json")) : []) {
    const rec = JSON.parse(readFileSync(join(results, f), "utf8"));
    if (flag("attested") && rec.status !== "attested") continue;
    const epFile = join(dataDir, "episodes", `${rec.dataHash}.json`);
    if (!existsSync(epFile)) {
      skipped.push(`${rec.dataHash}: episode file missing`);
      continue;
    }
    const v = verify(JSON.parse(readFileSync(epFile, "utf8")), {
      expectHash: rec.dataHash, source: "agent-run",
      meta: { owner: rec.owner, status: rec.status, attestationTx: rec.tx ?? null, verifiedAt: rec.verifiedAt },
    });
    if (v) lines.push(v);
  }
  const trials = join(dataDir, "trials", "episodes");
  if (flag("trials") && existsSync(trials)) {
    for (const f of readdirSync(trials).filter((f) => f.endsWith(".json"))) {
      const v = verify(JSON.parse(readFileSync(join(trials, f), "utf8")), { expectHash: basename(f, ".json"), source: "pilot-trial" });
      if (v) lines.push(v);
    }
  }
}
for (const file of list("runs")) {
  const v = verify(JSON.parse(readFileSync(file, "utf8")), { source: `run-file:${basename(file)}` });
  if (v) lines.push(v);
}

if (!lines.length) {
  console.error(`No episodes to export.${skipped.length ? `\nSkipped:\n - ${skipped.join("\n - ")}` : ""}\nUsage: node scripts/lerobot-prep.mjs --data <DATA_DIR> [--attested] [--trials] [--runs files...]`);
  process.exit(1);
}
// stable order: oldest first, then by hash, so re-exports give the same episode indices
lines.sort((a, b) => (a.verifiedAt ?? 0) - (b.verifiedAt ?? 0) || a.dataHash.localeCompare(b.dataHash));
writeFileSync(outFile, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
const frames = lines.reduce((n, l) => n + l.actions.length, 0);
console.log(`✔ ${lines.length} episodes (${frames} frames, ${lines.filter((l) => l.success).length} docked) → ${outFile}${skipped.length ? `\n  skipped ${skipped.length}: ${skipped.slice(0, 5).join("; ")}` : ""}`);
console.log(`Next: python scripts/real/export_lerobot.py ${outFile} --repo-id <hf-user>/openforge-proving-grounds [--push]`);
