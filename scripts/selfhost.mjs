// Run all of OpenForge AX yourself, with one command: the site, the Proving Grounds verifier and the (retired)
// Neo-Forge world server, already wired to each other. Reads .env and web/deployment.json (see docs/06-SELF-HOSTING.md).
//   npm run selfhost
// Env: WEB_PORT=8080, PORT=8787 (proving), WORLD_PORT=8788, plus everything the two servers accept.
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import "dotenv/config";

// Children get only what they need. Secrets are an explicit denylist (the .env is loaded for all of them).
const CHAIN_SECRETS = ["PRIVATE_KEY", "SEPOLIA_PRIVATE_KEY", "PINATA_JWT", "ETHERSCAN_API_KEY"]; // deploy-time only, no service uses them
const ATTEST_SECRETS = ["SIM_ATTESTER_KEY", "ADMIN_TOKEN"]; // the verifier only
const MARKET_SECRETS = ["OPENSEA_API_KEY"]; // the verifier only (its GET /market relay); the site and the world server never call OpenSea
const DENY = { web: [...CHAIN_SECRETS, ...ATTEST_SECRETS, ...MARKET_SECRETS], world: [...CHAIN_SECRETS, ...ATTEST_SECRETS, ...MARKET_SECRETS], proving: CHAIN_SECRETS };
export function childEnv(name, env, extra = {}) {
  const deny = new Set(DENY[name] || [...CHAIN_SECRETS, ...ATTEST_SECRETS, ...MARKET_SECRETS]); // unknown service: least privilege
  return { ...Object.fromEntries(Object.entries(env).filter(([k]) => !deny.has(k))), ...extra };
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) main();

function main() {
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const env = process.env;
  const WEB = Number(env.WEB_PORT || 8080);
  const PROVING = Number(env.PORT || 8787);
  const WORLD = Number(env.WORLD_PORT || 8788);
  const site = `http://localhost:${WEB}`; // HOST (e.g. 0.0.0.0, for a phone on the LAN) is passed through to the servers

  const depFile = join(root, "web/deployment.json");
  if (!existsSync(depFile)) {
    console.error("web/deployment.json is missing: deploy the contracts (or run the local demo) first.");
    process.exit(1);
  }
  const dep = JSON.parse(readFileSync(depFile, "utf8"));

  const services = [
    { name: "web", script: "scripts/serve.mjs", args: [String(WEB)], env: { SITE_OVERRIDES: JSON.stringify({ provingApi: `http://localhost:${PROVING}`, worldWs: `ws://localhost:${WORLD}` }) } },
    { name: "proving", script: "scripts/proving-server.mjs", args: [], env: { PORT: String(PROVING), ALLOWED_ORIGIN: env.ALLOWED_ORIGIN || site } },
    { name: "world", script: "scripts/world-server.mjs", args: [], env: { WORLD_PORT: String(WORLD), ALLOWED_ORIGINS: env.ALLOWED_ORIGINS || site } },
  ];

  const children = [];
  let stopping = false;
  function stop(code = 0) {
    if (stopping) return;
    stopping = true;
    for (const c of children) c.kill();
    setTimeout(() => process.exit(code), 300);
  }

  for (const s of services) {
    const child = spawn(process.execPath, [join(root, s.script), ...s.args], { cwd: root, env: childEnv(s.name, env, s.env), stdio: ["ignore", "pipe", "pipe"] });
    const tag = `[${s.name}]`.padEnd(10);
    const pipe = (stream, out) => {
      let buf = "";
      stream.on("data", (d) => {
        buf += d;
        const lines = buf.split(/\r?\n/);
        buf = lines.pop();
        for (const l of lines) out.write(`${tag}${l}\n`);
      });
    };
    pipe(child.stdout, process.stdout);
    pipe(child.stderr, process.stderr);
    child.on("exit", (code) => {
      if (stopping) return;
      console.error(`${tag}stopped (exit ${code}). Stopping the others: fix the error above and run again.`);
      stop(code || 1);
    });
    children.push(child);
  }

  process.on("SIGINT", () => stop(0));
  process.on("SIGTERM", () => stop(0));

  console.log(`
  OpenForge AX, self-hosted (chain ${dep.chainId}${dep.chainId === 31337 ? ", local demo" : ""})
    Lab (home)      ${site}
    Workbench       ${site}/bench.html   (11 robots in 3D, 7 stages, 3 missions each)
    Phone Brain     ${site}/pilot.html   (AX-1 twin, AI Pilot; a real AX-1 over Bluetooth in Chrome on Android)
    Proving Grounds ${site}/arena.html   (verifier http://localhost:${PROVING}${env.SIM_ATTESTER_KEY || dep.chainId === 31337 ? "" : ", verify-only: set SIM_ATTESTER_KEY to attest on-chain"})
    Robot Link      ${site}/robot.html   (Chrome or Edge, real SO-101 over USB, or the virtual arm)
    The Codex       ${site}/codex.html
    Gallery         ${site}/gallery.html (the agents, with their 3D token art)
    Market          ${site}/market.html (floor, sales, holders and rarity)
  Ctrl+C stops everything.
  `);
}
