// Headless render harness shared by the brand assets (scripts/brand.mjs) and the token art (art/generate.mjs):
// a local Chrome or Edge (BROWSER=path to override) with SwiftShader, and a read-only server on 127.0.0.1 that serves
// only allowlisted repo paths. The pages render the site's own models (web/js/models/), so art and site match.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname, extname, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";

export const root = join(dirname(fileURLToPath(import.meta.url)), "../..");

const BROWSERS = [
  process.env.BROWSER,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "/usr/bin/google-chrome", "/usr/bin/chromium", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
].filter(Boolean);
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".woff2": "font/woff2" };
const ALLOWED = ["art/brand/src/", "art/token/", "web/js/models/", "web/vendor/three/", "node_modules/@fontsource-variable/"];

/** Starts the server and the browser. Returns { base, browser, close() }; base is the server's http origin. */
export async function startHeadless() {
  if (!existsSync(join(root, "web/vendor/three/addons/geometries"))) throw new Error("Run npm run web:build first (vendored three.js addons)");
  const executablePath = BROWSERS.find((p) => existsSync(p));
  if (!executablePath) throw new Error("No Chrome/Edge found: set BROWSER=/path/to/chrome");
  let origin = "";
  const server = createServer(async (req, res) => {
    // only our own page: a different Host header means DNS rebinding from some web page
    if (req.headers.host !== origin) return res.writeHead(421).end();
    try {
      const rel = normalize(decodeURIComponent(new URL(req.url, "http://x").pathname).slice(1)).split(sep).join("/");
      if (rel.includes("..") || !ALLOWED.some((p) => rel.startsWith(p))) return res.writeHead(404).end();
      const data = await readFile(join(root, rel)); // before writeHead, so a missing file can still answer 404
      res.writeHead(200, { "content-type": TYPES[extname(rel)] || "application/octet-stream" }).end(data);
    } catch {
      res.writeHead(404).end(); // malformed URL or missing file
    }
  });
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
  origin = `127.0.0.1:${server.address().port}`;
  let browser;
  try {
    browser = await puppeteer.launch({ executablePath, headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
  } catch (e) {
    server.close();
    throw e;
  }
  return {
    base: `http://${origin}`,
    browser,
    async close() {
      await browser.close().catch(() => {});
      server.close();
    },
  };
}

/** Opens `url` in a new page and waits for window.__ready; page errors are collected in page.errors. */
export async function openPage(browser, url, { width = 1600, height = 1100, scale = 1 } = {}) {
  const page = await browser.newPage();
  page.errors = [];
  page.on("pageerror", (e) => page.errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && page.errors.push(m.text()));
  await page.setViewport({ width, height, deviceScaleFactor: scale });
  await page.goto(url, { waitUntil: "networkidle0" });
  const ok = await page.waitForFunction(() => window.__ready, { timeout: 30000 }).then((h) => h.jsonValue()).catch(() => null);
  if (!ok) throw new Error(`${url}: page did not get ready ${page.errors.join(" | ")}`);
  return { page, ready: ok };
}
