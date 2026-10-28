// Cross-engine smoke test: every page of web/ in the three browser engines people use, so the site works for everyone:
//   Chromium (Chrome, Edge, Opera, Samsung Internet: Windows, macOS, Linux, Android), Gecko (Firefox, every desktop OS)
//   and WebKit (Safari on macOS, and EVERY browser on iPhone and iPad, which Apple requires to use WebKit).
//   node scripts/site-engines.mjs            -> one line per engine profile x page; exit 1 on any failure
// Needs Playwright and its browsers, which the repo does not install (CI does: .github/workflows/engines.yml):
//   npm i --no-save playwright && npx playwright install --with-deps chromium firefox webkit
// Env: ENGINES=substring list (e.g. "webkit,firefox"), ONLY=page substring.
// Same rules as scripts/site-smoke.mjs (which stays the Chrome run with themes and viewports): no uncaught error, no
// console.error, no same-origin 4xx/5xx, an <h1>, the nav buttons, no unintended document scroll or horizontal overflow,
// no canvas larger than its box. The chain, proving and world servers are offline here, as in site:smoke.
// One browser launch per page: headless WebKit runs out of WebGL contexts after a dozen pages in one process.
import { createServer } from "node:http";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHandler } from "./serve.mjs";
import { PAGES, layoutProblems, isExpectedNetworkError } from "./site-smoke.mjs";

const webRoot = fileURLToPath(new URL("../web/", import.meta.url));

/** profiles: engine x device; `device` names a Playwright device descriptor (phones and tablets) */
export const PROFILES = [
  { name: "chromium-desktop", engine: "chromium", viewport: { width: 1366, height: 768 } },
  { name: "chromium-android", engine: "chromium", device: "Pixel 7" },
  { name: "firefox-desktop", engine: "firefox", viewport: { width: 1366, height: 768 } },
  { name: "webkit-mac", engine: "webkit", viewport: { width: 1440, height: 820 } },
  { name: "webkit-iphone", engine: "webkit", device: "iPhone 13" },
  { name: "webkit-ipad", engine: "webkit", device: "iPad (gen 7)" },
];

// runs inside the page
const inspect = () => {
  const el = document.scrollingElement || document.documentElement;
  return {
    app: document.body.classList.contains("app"),
    innerHeight: window.innerHeight, scrollHeight: el.scrollHeight, innerWidth: window.innerWidth, scrollWidth: el.scrollWidth,
    h1: document.querySelectorAll("h1").length,
    sound: !!document.querySelector(".sound-btn"),
    escaped: [...document.querySelectorAll("canvas")].filter((c) => {
      const r = c.getBoundingClientRect(), p = c.parentElement?.getBoundingClientRect();
      return r.width && p && !document.body.classList.contains("lab") && (r.height > p.height + 2 || r.width > p.width + 2);
    }).map((c) => c.id || c.className || "canvas"),
  };
};

/** WebGL errors a browser prints when it has no WebGL at all (a GPU-less CI runner): the page's fallback is what is tested then. */
const NO_WEBGL = /WebGL context could not be created|WebGL creation failed|Error creating WebGL context/i;

// Firefox gets software WebGL where it can: on Linux CI the workflow runs it headed under xvfb (HEADED_FIREFOX=1).
const launchOptions = (engine) =>
  engine === "firefox" ? { headless: !process.env.HEADED_FIREFOX, firefoxUserPrefs: { "webgl.force-enabled": true, "webgl.disable-fail-if-major-performance-caveat": true } } : {};

async function checkPage(pw, profile, origin, entry) {
  const notes = new Set();
  let webgl = true;
  const browser = await pw[profile.engine].launch(launchOptions(profile.engine));
  try {
    const ctx = await browser.newContext(profile.device ? { ...pw.devices[profile.device] } : { viewport: profile.viewport });
    const page = await ctx.newPage();
    await page.route("**/*", (r) => (isExpectedNetworkError("", r.request().url()) ? r.abort() : r.continue()));
    page.on("pageerror", (e) => notes.add(`pageerror: ${String(e.message).slice(0, 200)}`));
    page.on("console", (m) => {
      if (m.type() === "error" && !isExpectedNetworkError(m.text(), m.location()?.url)) notes.add(`console.error: ${m.text().slice(0, 200)}`);
    });
    page.on("response", (r) => {
      if (r.url().startsWith(origin) && r.status() >= 400) notes.add(`HTTP ${r.status()} ${r.url().replace(origin, "")}`);
    });
    await page.goto(`${origin}/${entry.path}`, { waitUntil: "domcontentloaded", timeout: 60000 });
    webgl = await page.evaluate(() => {
      try {
        const c = document.createElement("canvas");
        return !!(c.getContext("webgl2") || c.getContext("webgl"));
      } catch {
        return false;
      }
    });
    await page.waitForFunction(() => document.querySelector(".sound-btn"), null, { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(2000);
    const m = await page.evaluate(inspect);
    if (!m.h1) notes.add("no <h1>");
    if (!m.sound) notes.add("no .sound-btn");
    for (const p of layoutProblems(m)) notes.add(p);
    if (entry.click) {
      await page.click(entry.click, { timeout: 10000 });
      await page.waitForTimeout(2000);
      for (const p of layoutProblems(await page.evaluate(inspect))) notes.add(`after click: ${p}`);
    }
  } catch (e) {
    notes.add(`load failed: ${String(e.message).split("\n")[0]}`);
  } finally {
    await browser.close().catch(() => {});
  }
  // no WebGL in this browser at all: three's own "could not create a context" lines are expected; everything else
  // (uncaught errors, layout, the fallback's <h1> and buttons) still counts
  if (webgl) return [...notes];
  const what = `${profile.name} ${entry.path}: no WebGL in this browser here, the page's no-WebGL fallback was checked instead`;
  console.log(process.env.GITHUB_ACTIONS ? `::notice title=no WebGL::${what}` : `note ${what}`);
  return [...notes].filter((n) => !NO_WEBGL.test(n));
}

export async function run({ engines = process.env.ENGINES, only = process.env.ONLY } = {}) {
  let pw;
  try {
    pw = await import("playwright");
  } catch {
    throw new Error("Playwright is not installed: npm i --no-save playwright && npx playwright install --with-deps chromium firefox webkit");
  }
  const want = String(engines || "").split(",").map((s) => s.trim()).filter(Boolean);
  const profiles = PROFILES.filter((p) => !want.length || want.some((w) => p.name.includes(w)));
  const server = createServer(createHandler([], webRoot)); // [] = loopback Host guard only
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const rows = [];
  try {
    for (const profile of profiles) {
      for (const entry of PAGES.filter((p) => !only || p.path.includes(only))) {
        const reasons = await checkPage(pw, profile, origin, entry);
        rows.push({ profile: profile.name, page: entry.path, reasons });
        console.log(`${reasons.length ? "FAIL" : "ok  "} ${profile.name.padEnd(17)} ${entry.path}${reasons.map((r) => `\n      - ${r}`).join("")}`);
      }
    }
  } finally {
    server.close();
  }
  return rows;
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  // On GitHub Actions every failure is also an annotation: run logs need a signed-in viewer, annotations do not
  // (GET /repos/<owner>/<repo>/check-runs/<job id>/annotations), so a failing run can be read without an account.
  const annotate = (title, text) => process.env.GITHUB_ACTIONS && console.log(`::error title=${title.replace(/[:,\r\n]/g, " ")}::${String(text).replace(/\r?\n/g, " | ").slice(0, 900)}`);
  const rows = await run().catch((e) => {
    console.error(`site-engines: ${e.message}`);
    annotate("site-engines", e.message);
    process.exit(1);
  });
  const bad = rows.filter((r) => r.reasons.length);
  for (const r of bad) annotate(`${r.profile} ${r.page}`, r.reasons.join(" | "));
  console.log(`\n${rows.length - bad.length}/${rows.length} ok`);
  if (bad.length) process.exit(1);
}
