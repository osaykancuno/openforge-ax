// Re-verifies a run file with the same sim the verifier uses. Prints JSON; exit 0 = valid.
//   node scripts/real/verify-run.mjs run.json
import { readFileSync } from "node:fs";
import { replay, validateActions, SIM_ID, FPS } from "../../web/js/sim/arm-sim.js";

const ep = JSON.parse(readFileSync(process.argv[2], "utf8"));
const error =
  ep.sim !== SIM_ID ? `unsupported sim ${ep.sim}` : ep.fps !== FPS ? `fps must be ${FPS}` : validateActions(ep.actions);
const outcome = error ? null : replay(ep.seed, ep.actions);
console.log(JSON.stringify({ valid: !error, error, outcome }));
process.exit(error ? 1 : 0);
