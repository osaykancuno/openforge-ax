// The public copy of the site, made from the built web/ folder, for one host:
//   node scripts/prepare-site.mjs --target cloudflare [--out _site] [--index]   the production site (openforge-ax.tech);
//                                                                  --index only from the launch: search engines welcome
//   node scripts/prepare-site.mjs --target github [--out _site]       the github.io preview
// Node built-ins only (the CI runs it without npm install). It refuses to publish when a vendored library is not the
// exact file web:build copied (web/vendor/SHA256SUMS). Until contracts are deployed for real, the local demo's
// deployment.json (chain 31337) is replaced by the public defaults, and no page may allow loopback hosts in its CSP
// (the Phone Brain keeps its own: the visitor's local model server).
//   cloudflare: keeps _headers (security and cache headers), sitemap.xml and the build's robots.txt;
//   github: drops what GitHub Pages ignores or must not have (_headers, the sitemap) and is never indexed.
import { cpSync, existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { arConnectSrc, rpcOrigins } from "./lib/rpc-origins.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
export const TARGETS = ["cloudflare", "github"];
/** Files no page references: the unminified three.js (art renders only), the demo token images, unused showcase previews. */
export const NEVER_PUBLISHED = ["assets/showcase", "demo-images", "vendor/three/three.module.js"];
export const PUBLIC_DEPLOYMENT = '{ "chainId": 1, "chainName": "Ethereum" }\n';
const LOOPBACK = / (http|ws):\/\/(localhost|127\.0\.0\.1):(\*|[0-9]+)/g;

/** The CSP of a page without loopback hosts (any port). */
export const stripLoopback = (html) => html.replace(LOOPBACK, "");

/** Throws unless every file listed in vendor/SHA256SUMS ("<sha256>  <path>") has exactly that hash. */
export function verifyVendor(dir) {
  const sums = readFileSync(join(dir, "vendor/SHA256SUMS"), "utf8").split(/\r?\n/).filter((l) => l && !l.startsWith("#")); // # = a comment line
  if (!sums.length) throw new Error("vendor/SHA256SUMS is empty");
  for (const line of sums) {
    const m = /^([0-9a-f]{64}) [ *](.+)$/.exec(line);
    if (!m) throw new Error(`vendor/SHA256SUMS: bad line "${line}"`);
    const got = createHash("sha256").update(readFileSync(join(dir, "vendor", m[2]))).digest("hex");
    if (got !== m[1]) throw new Error(`vendor/${m[2]} is not the file web:build vendored (sha256 ${got})`);
  }
  return sums.length;
}

export function prepareSite({ target, out = join(root, "_site"), web = join(root, "web"), index = false }) {
  if (!TARGETS.includes(target)) throw new Error(`--target must be one of ${TARGETS.join(", ")}`);
  out = resolve(out);
  if (out === resolve(web) || out === resolve(root)) throw new Error("--out must be a separate folder");
  rmSync(out, { recursive: true, force: true });
  cpSync(web, out, { recursive: true });
  const vendored = verifyVendor(out); // before anything is pruned
  let demo = false;
  try {
    demo = JSON.parse(readFileSync(join(out, "deployment.json"), "utf8")).chainId === 31337;
  } catch {} // no deployment.json: nothing to replace
  if (demo) {
    writeFileSync(join(out, "deployment.json"), PUBLIC_DEPLOYMENT);
    rmSync(join(out, "data/rarity.json"), { force: true }); // the demo's 60 test agents, never the real collection
    // the AR page reads the chain from the public RPCs (it listed the demo's loopback one)
    const arConnect = arConnectSrc(rpcOrigins({ configJs: readFileSync(join(out, "js/config.js"), "utf8"), deployment: JSON.parse(PUBLIC_DEPLOYMENT) }));
    for (const f of readdirSync(out).filter((f) => f.endsWith(".html") && f !== "pilot.html")) {
      const p = join(out, f);
      let html = stripLoopback(readFileSync(p, "utf8"));
      if (f === "ar.html") html = html.replace(/connect-src 'self'[^;"]*/, arConnect);
      writeFileSync(p, html);
    }
  }
  for (const p of NEVER_PUBLISHED) rmSync(join(out, p), { recursive: true, force: true });
  for (const f of readdirSync(out, { recursive: true })) if (/\.md$/i.test(f)) rmSync(join(out, f), { force: true }); // developer notes are not pages
  if (target === "github") {
    rmSync(join(out, "_headers"), { force: true });
    rmSync(join(out, "sitemap.xml"), { force: true });
    writeFileSync(join(out, "robots.txt"), "User-agent: *\nDisallow: /\n");
    writeFileSync(join(out, ".nojekyll"), "");
  } else {
    if (!existsSync(join(out, "_headers"))) throw new Error("web/_headers is missing: Cloudflare would serve the site without its security headers");
    // before the launch the real domain stays out of search engines too; --index (at launch) keeps the build's
    // robots.txt and sitemap
    if (!index) {
      writeFileSync(join(out, "robots.txt"), "User-agent: *\nDisallow: /\n");
      rmSync(join(out, "sitemap.xml"), { force: true });
      // into the existing "/*" rule: Cloudflare keeps one rule per path, so a second "/*" would replace the first and
      // drop every security header in it
      const headers = readFileSync(join(out, "_headers"), "utf8");
      const all = /^\/\*[ \t]*\r?\n/m;
      if (!all.test(headers)) throw new Error('web/_headers has no "/*" rule to carry the noindex header');
      writeFileSync(join(out, "_headers"), headers.replace(all, (m) => `${m}  X-Robots-Tag: noindex\n`));
    }
  }
  return { out, vendored, demo };
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  const arg = (k) => {
    const i = process.argv.indexOf(`--${k}`);
    return i > 0 ? process.argv[i + 1] : undefined;
  };
  try {
    const r = prepareSite({ target: arg("target"), out: arg("out"), index: process.argv.includes("--index") });
    console.log(`site ready for ${arg("target")} in ${r.out} (${r.vendored} vendored files checked${r.demo ? ", local demo config replaced" : ""})`);
  } catch (e) {
    console.error(`prepare-site: ${e.message}`);
    process.exit(1);
  }
}
