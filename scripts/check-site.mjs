// Run before publishing web/: refuses a site that still points at the local demo or at placeholders.
//   npm run site:check                (mainnet)
//   npm run site:check -- 11155111    (Sepolia dry run)
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const local = (u) => /localhost|127\.0\.0\.1|\[::1\]/.test(u || "");
// the Phone Brain page lists loopback hosts by design: the AI Pilot's model server and the robot bridge run on the visitor's own machine
const LOOPBACK_PAGES = new Set(["pilot.html"]);

/** Everything wrong with the site in `web` for `chain`, as readable lines (empty: ready to publish). */
export function siteProblems(web, chain) {
  const dep = JSON.parse(readFileSync(join(web, "deployment.json"), "utf8"));
  const config = readFileSync(join(web, "js/config.js"), "utf8");
  const value = (k) => dep[k] ?? config.match(new RegExp(`${k}: "([^"]*)"`))?.[1];
  const demo = Number(dep.chainId) === 31337;
  const problems = [];

  if (Number(dep.chainId) !== chain) problems.push(`deployment.json is for chain ${dep.chainId}, expected ${chain}: run the deploy for this network first`);
  // log scans start at the deploy block: from block 0 every visitor would ask the RPC for the whole chain
  if (!demo && !(Number(dep.fromBlock ?? config.match(/fromBlock: (\d+)/)?.[1]) > 0)) problems.push("fromBlock must be the deploy block (greater than 0) in deployment.json");
  for (const k of ["agents", "renderer", "reputation"]) if (!/^0x[0-9a-fA-F]{40}$/.test(dep[k] || "") || /^0x0{40}$/.test(dep[k])) problems.push(`${k} address missing`);
  if (local(value("rpcUrl")) || !/^https:\/\//.test(value("rpcUrl") || "")) problems.push("rpcUrl must be a public https RPC");
  for (const [k, scheme] of [["provingApi", "https://"], ["worldWs", "wss://"]]) {
    const u = dep[k];
    if (u && (local(u) || !u.startsWith(scheme))) problems.push(`${k} must be ${scheme}… or removed from deployment.json (it is ${u})`);
  }
  if (!/^https:\/\/opensea\.io\/collection\/[\w-]+/.test(value("openseaDropUrl") || "")) problems.push("openseaDropUrl must be the real OpenSea collection page");
  if (!/^https:\/\//.test(value("explorer") || "")) problems.push("explorer must be https://etherscan.io (or the testnet explorer)");
  if (/x\.com\/"|discord\.gg\/"/.test(config)) problems.push("config.js social links are still empty (x.com/, discord.gg/)");
  for (const f of ["vendor/ethers.min.js", "vendor/three/three.module.js", "vendor/three/three.module.min.js", "_headers"]) if (!existsSync(join(web, f))) problems.push(`missing web/${f}: run npm run web:build`);
  for (const page of readdirSync(web).filter((f) => f.endsWith(".html"))) {
    const html = readFileSync(join(web, page), "utf8");
    if (!html.includes('http-equiv="Content-Security-Policy"')) problems.push(`${page} has no CSP: run npm run web:build`);
    // an inline script edited after the build no longer matches its CSP hash, and the browser blocks it
    const csp = html.match(/script-src ([^;"]*)/)?.[1] || "";
    for (const m of html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)) {
      const h = createHash("sha256").update(m[1].replace(/\r\n?/g, "\n")).digest("base64");
      if (!csp.includes(`'sha256-${h}'`)) problems.push(`${page}: an inline script does not match its CSP hash: run npm run web:build`);
    }
    if (/cdn\.jsdelivr|unpkg\.com/.test(html)) problems.push(`${page} still loads a script from a CDN`);
    // loopback hosts in a CSP come from a build made against the local demo: a real deployment never lists them
    const meta = html.match(/<meta http-equiv="Content-Security-Policy"[^>]*>/)?.[0] || "";
    if (!demo && !LOOPBACK_PAGES.has(page) && /localhost|127\.0\.0\.1/.test(meta)) problems.push(`${page}: the CSP lists localhost / 127.0.0.1 but the deployment is not the local demo: run npm run web:build`);
  }
  return problems;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const chain = Number(process.argv[2] || 1);
  const problems = siteProblems(join(dirname(fileURLToPath(import.meta.url)), "../web"), chain);
  if (problems.length) {
    console.error(`Site NOT ready to publish:\n - ${problems.join("\n - ")}`);
    process.exit(1);
  }
  console.log(`Site ready to publish for chain ${chain}.`);
}
