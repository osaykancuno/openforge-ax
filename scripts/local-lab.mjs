// The whole lab on this PC, with one command:  npm run local
//   1. a local chain (Hardhat, http://127.0.0.1:8545), started here unless one is already running;
//   2. the demo: fresh contracts, 60 agents minted, revealed and drawn with the 3D token art (scripts/demo-local.js);
//   3. the site, the Proving Grounds verifier and the world server (scripts/selfhost.mjs), wired to the demo.
// Ctrl+C stops everything this command started. Nothing here touches a real network or real money.
//   npm run local -- --no-demo   keeps the last demo (contracts and agents) and only starts the servers again
import { spawn } from "node:child_process";
import { rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const RPC = "http://127.0.0.1:8545";
const noDemo = process.argv.includes("--no-demo");
const children = [];
let stopping = false;

const rpcUp = () =>
  fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }) })
    .then((r) => r.json())
    .then((j) => j.result === "0x7a69") // 31337: never run the demo against another chain
    .catch(() => false);

/** Starts a child with its own line prefix. `cmd` is an argv array, or a fixed command line for npx (it needs a shell on Windows). */
function start(name, cmd, env = {}) {
  const opts = { cwd: root, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] };
  const child = typeof cmd === "string" ? spawn(cmd, { ...opts, shell: true }) : spawn(cmd[0], cmd.slice(1), opts);
  const tag = `[${name}]`.padEnd(10);
  for (const [stream, out] of [[child.stdout, process.stdout], [child.stderr, process.stderr]]) {
    let buf = "";
    stream.on("data", (d) => {
      buf += d;
      const lines = buf.split(/\r?\n/);
      buf = lines.pop();
      for (const l of lines) if (name !== "chain" || !/eth_|^\s*$/.test(l)) out.write(`${tag}${l}\n`); // the chain logs every RPC call: keep the rest
    });
  }
  children.push(child);
  return child;
}
const run = (name, cmd, env) =>
  new Promise((ok, fail) => start(name, cmd, env).on("exit", (code) => (code === 0 ? ok() : fail(new Error(`${name} failed (exit ${code})`)))));

function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const c of children) {
    if (c.exitCode !== null) continue;
    if (process.platform === "win32") spawn("taskkill", ["/pid", String(c.pid), "/T", "/F"], { stdio: "ignore" }); // the shell's children too
    else c.kill();
  }
  setTimeout(() => process.exit(code), 500);
}
process.on("SIGINT", () => stop(0));
process.on("SIGTERM", () => stop(0));

try {
  if (await rpcUp()) console.log(`Local chain already running on ${RPC}: using it.`);
  else {
    console.log("Starting the local chain…");
    start("chain", "npx hardhat node").on("exit", (code) => !stopping && (console.error(`[chain]   stopped (exit ${code})`), stop(1)));
    for (let i = 0; !(await rpcUp()); i++) {
      if (i > 120) throw new Error("the local chain did not start in 60 s");
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  if (!noDemo) {
    console.log("Deploying the demo (fresh contracts, 60 agents, 3D token art: about a minute)…");
    await run("demo", "npx hardhat run scripts/demo-local.js --network localhost", { PROVING_API: "http://localhost:8787", WORLD_WS: "ws://localhost:8788" });
    rmSync(join(root, "data/proving"), { recursive: true, force: true }); // its records point at the previous demo's contracts
  }
  const host = start("lab", [process.execPath, join(root, "scripts/selfhost.mjs")]);
  host.on("exit", (code) => !stopping && stop(code || 0));
} catch (e) {
  console.error(`\n${e.message}`);
  stop(1);
}
