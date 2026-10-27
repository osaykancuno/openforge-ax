// Site smoke test: loads every page of web/ in headless Chrome and fails loudly on regressions.
//   npm run site:smoke   -> table of page x viewport x theme; exit 1 on any failure
// Needs a local Chrome or Edge (BROWSER=path to override) and a built web/ (npm run web:build).
// Env: ONLY=substring (run only the pages whose path contains it), SETTLE=ms (default 2000), JOBS=n parallel tabs (default 2).
// The full run takes about 6 minutes: software-rendered WebGL (SwiftShader) is CPU-bound, more tabs barely help.
// Serves web/ with scripts/serve.mjs's own handler, bound to 127.0.0.1 on a free port (loopback Host guard on).
// Fails on: uncaught page errors, console.error, same-origin HTTP 4xx/5xx or failed requests, a page without <h1>,
// document scroll on body.app pages (height >= 561, the one-screen layout; phones up to 480 x 700 scroll by design),
// horizontal overflow, a 3D canvas larger than its own box (it then covers the page), music playing before
// any gesture, missing .sound-btn / .music-btn, .music-btn not aria-pressed="false" by default.
// Expected and ignored: the chain, proving and world servers (127.0.0.1/localhost :8545, :8787, :8788) are offline here;
// requests to them are aborted, so the result does not depend on a local chain that happens to be running.
import { createServer } from "node:http";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHandler } from "./serve.mjs";
import { startHeadless } from "./lib/headless.mjs";

const webRoot = fileURLToPath(new URL("../web/", import.meta.url));

export const PAGES = [
  { path: "index.html" },
  { path: "bench.html" },
  { path: "bench.html#so101/test" },
  { path: "bench.html#ax1-desk/test" },
  { path: "pilot.html", click: "#startTwin" },
  { path: "ar.html" }, // no click: the start card (or the desktop hint) must load with no permission prompt
  { path: "arena.html" },
  { path: "robot.html" },
  { path: "codex.html#1" },
  { path: "codex.html#8" },
  { path: "gallery.html" },
  { path: "market.html" },
  { path: "agent.html?id=1" },
  { path: "agents.html" },
  { path: "license.html" },
];
export const VIEWPORTS = [
  { width: 1800, height: 823 },
  { width: 1366, height: 768 },
  { width: 375, height: 812, mobile: true },
  { width: 345, height: 600, mobile: true }, // a phone with large text (Android font scaling) under the address bar
  { width: 780, height: 360, mobile: true }, // a phone on its side
];
export const THEMES = ["light", "dark"];
const MOBILE_UA = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36";
const SHORT_SCREEN = 561; // below this height the app pages scroll by design (WCAG 1.4.10)
const OFFLINE = /(?:127\.0\.0\.1|localhost):(?:8545|8787|8788)(?![0-9])/;

/** True for a message about the local chain / proving / world servers, which are not running during the smoke run. */
export const isExpectedNetworkError = (text, url = "") => OFFLINE.test(`${text ?? ""} ${url ?? ""}`);

/** Layout problems out of the page metrics { app, innerHeight, scrollHeight, innerWidth, scrollWidth }. */
export function layoutProblems(m) {
  const out = [];
  const scrollsByDesign = m.innerHeight < SHORT_SCREEN || (m.innerWidth <= 480 && m.innerHeight <= 700); // same breakpoints as the CSS
  if (m.app && !scrollsByDesign && m.scrollHeight > m.innerHeight + 1) out.push(`document scrolls (${m.scrollHeight} > ${m.innerHeight})`);
  if (m.scrollWidth > m.innerWidth + 1) out.push(`horizontal overflow (${m.scrollWidth} > ${m.innerWidth})`);
  for (const c of m.escaped ?? []) out.push(`canvas #${c} is larger than its box`);
  return out;
}

// runs inside the page
const inspect = () => {
  const el = document.scrollingElement || document.documentElement;
  const music = document.querySelector(".music-btn");
  return {
    app: document.body.classList.contains("app"),
    innerHeight: window.innerHeight, scrollHeight: el.scrollHeight, innerWidth: window.innerWidth, scrollWidth: el.scrollWidth,
    h1: document.querySelectorAll("h1").length,
    music: document.documentElement.dataset.music || "",
    sound: !!document.querySelector(".sound-btn"),
    musicBtn: !!music,
    musicPressed: music ? music.getAttribute("aria-pressed") : null,
    // a canvas absolutely placed in a box that lost its positioning grows to the whole page and swallows every touch
    escaped: [...document.querySelectorAll("canvas")].filter((c) => {
      const r = c.getBoundingClientRect(), p = c.parentElement?.getBoundingClientRect();
      return r.width && p && !document.body.classList.contains("lab") && (r.height > p.height + 2 || r.width > p.width + 2);
    }).map((c) => c.id || c.className || "canvas"),
  };
};

/** A bare fetch failure ("TypeError: Failed to fetch"): the browser gives no URL, so it only counts as expected when an offline-server request was blocked on that page. */
export const isFetchFailure = (text) => /^(?:Uncaught \(in promise\) )?(?:TypeError: )?Failed to fetch$/.test(String(text ?? "").trim());

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const short = (s, n = 140) => (String(s).length > n ? `${String(s).slice(0, n)}...` : String(s)).replace(/\s+/g, " ");

async function checkPage(browser, origin, entry, vp, theme, settle) {
  const page = await browser.newPage();
  let blocked = 0; // requests to the offline servers that were aborted on this page
  const fetchFailures = [];
  const reasons = new Map(); // message with digits folded -> [first message, count]
  const note = (r) => {
    const k = short(r).replace(/\d+/g, "N");
    reasons.has(k) ? reasons.get(k)[1]++ : reasons.set(k, [short(r), 1]);
  };
  try {
    await page.setRequestInterception(true);
    page.on("request", (r) => (isExpectedNetworkError("", r.url()) ? (blocked++, r.abort("connectionrefused")) : r.continue()));
    if (vp.mobile) await page.setUserAgent(MOBILE_UA);
    await page.setViewport({ width: vp.width, height: vp.height, deviceScaleFactor: vp.mobile ? 2 : 1, isMobile: !!vp.mobile, hasTouch: !!vp.mobile });
    if (theme === "dark") await page.evaluateOnNewDocument(() => { try { localStorage.setItem("ofx-theme", "dark"); } catch {} });
    page.on("pageerror", (e) => (isFetchFailure(e.message) ? fetchFailures.push(`pageerror: ${e.message}`) : note(`pageerror: ${e.message}`)));
    page.on("console", (m) => {
      if (m.type() !== "error") return;
      const url = m.location()?.url || "";
      if (isExpectedNetworkError(m.text(), url)) return;
      const text = `console.error: ${m.text()}${url ? ` (${url.replace(origin, "")})` : ""}`;
      if (isFetchFailure(m.text())) fetchFailures.push(text);
      else note(text);
    });
    page.on("response", (r) => {
      if (r.url().startsWith(origin) && r.status() >= 400) note(`HTTP ${r.status()} ${r.url().replace(origin, "")}`);
    });
    page.on("requestfailed", (r) => {
      if (r.url().startsWith(origin) && r.failure()?.errorText !== "net::ERR_ABORTED") note(`request failed ${r.url().replace(origin, "")} ${r.failure()?.errorText}`);
    });
    await page.goto(`${origin}/${entry.path}`, { waitUntil: "domcontentloaded", timeout: 60000 });
    await sleep(settle);
    // the nav buttons are added by script: give a slow (software-rendered) page time to get there
    await page.waitForFunction(() => document.querySelector(".sound-btn") && document.querySelector(".music-btn"), { timeout: 15000 }).catch(() => {});
    const before = await page.evaluate(inspect);
    // audio must not start on its own (the click below is a gesture, so it is checked before)
    if (before.music === "playing") note("music playing without a gesture");
    if (!before.sound) note("no .sound-btn");
    if (!before.musicBtn) note("no .music-btn");
    else if (before.musicPressed !== "false") note(`.music-btn aria-pressed=${before.musicPressed}`);
    if (!before.h1) note("no <h1>");
    for (const p of layoutProblems(before)) note(p);
    if (entry.click) {
      await page.click(entry.click);
      await sleep(settle);
      const after = await page.evaluate(inspect);
      if (!after.h1) note(`no <h1> after clicking ${entry.click}`);
      for (const p of layoutProblems(after)) note(`after click: ${p}`);
    }
  } catch (e) {
    note(`load failed: ${e.message}`);
    if (!blocked) fetchFailures.forEach(note); // a failed fetch with no blocked request behind it is a real error
  } finally {
    await page.close().catch(() => {});
  }
  return [...reasons.values()].map(([m, n]) => (n > 1 ? `${m} (x${n})` : m));
}

export async function run({ only = process.env.ONLY, settle = Number(process.env.SETTLE) || 2000, jobs = Number(process.env.JOBS) || 2 } = {}) {
  const hl = await startHeadless(); // also checks that web/ is built (vendored three.js)
  const server = createServer(createHandler([], webRoot)); // [] = loopback Host guard only
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const rows = [];
  for (const entry of PAGES.filter((p) => !only || p.path.includes(only))) for (const vp of VIEWPORTS) for (const theme of THEMES) rows.push({ entry, vp, theme, page: entry.path, reasons: null });
  let next = 0;
  const worker = async () => {
    for (let r; (r = rows[next++]); ) r.reasons = await checkPage(hl.browser, origin, r.entry, r.vp, r.theme, settle);
  };
  try {
    await Promise.all(Array.from({ length: Math.max(1, jobs) }, worker));
  } finally {
    await hl.close();
    server.close();
  }
  return rows;
}

/** Compact table: one line per page, one cell per viewport x theme. */
export function formatTable(rows) {
  const cols = VIEWPORTS.flatMap((v) => THEMES.map((t) => `${v.width}x${v.height} ${t}`));
  const pages = [...new Set(rows.map((r) => r.page))];
  const w = Math.max(4, ...pages.map((p) => p.length));
  const cell = (page, c) => {
    const r = rows.find((x) => x.page === page && `${x.vp.width}x${x.vp.height} ${x.theme}` === c);
    return r ? (r.reasons.length ? "FAIL" : "ok") : "-";
  };
  return [["page".padEnd(w), ...cols].join("  "), ...pages.map((p) => [p.padEnd(w), ...cols.map((c) => cell(p, c).padEnd(c.length))].join("  "))].join("\n");
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  const rows = await run().catch((e) => { console.error(`site:smoke: ${e.message}`); process.exit(1); });
  const bad = rows.filter((r) => r.reasons.length);
  console.log(formatTable(rows));
  console.log(`\n${rows.length - bad.length}/${rows.length} ok`);
  if (bad.length) {
    console.log("\nFailures:");
    for (const r of bad) console.log(`  ${r.page} @ ${r.vp.width}x${r.vp.height} ${r.theme}\n${r.reasons.map((x) => `      - ${x}`).join("\n")}`);
    process.exit(1);
  }
}
