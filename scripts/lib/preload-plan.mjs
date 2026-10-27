// What each page announces in <head> (scripts/build-web.mjs writes it between <!--preload--> markers), and which three.js
// addons the vendor copy needs. Pure given the files on disk, so test/PreloadPlan.test.js checks the real pages.
import { existsSync, readFileSync } from "node:fs";
import { join, dirname, posix } from "node:path";

export const STATIC_IMPORT = /(?:^|[\s;}])(?:import|export)\s*(?:[^'"()]*?\bfrom\s*)?["']([^"']+)["']/g; // import/export ... from "x" and import "x"; never import("x")
// comments out, string and template literals kept as they are (a "/*" inside a // comment or a "//" inside a URL string are not comment starts)
export const stripComments = (src) => src.replace(/("(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`)|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (m, str) => str ?? "");

const resolveBare = (spec, importmap) => {
  if (importmap[spec]) return importmap[spec];
  const prefix = Object.keys(importmap).filter((k) => k.endsWith("/") && spec.startsWith(k)).sort((a, b) => b.length - a.length)[0];
  return prefix ? importmap[prefix] + spec.slice(prefix.length) : null;
};
/** The file a static import points at (relative to the importing file, or through the page's import map), or null. */
function resolveSpec(spec, fromDir, importmap, web) {
  if (/^\.{0,2}\//.test(spec)) return join(fromDir, spec);
  if (/^[a-z@][^:]*$/i.test(spec)) return resolveBare(spec, importmap) ? join(web, resolveBare(spec, importmap)) : null;
  return null;
}
const importsOf = (src) => [...stripComments(src).matchAll(STATIC_IMPORT)].map((m) => m[1]);

/** Every file reachable from `entries` through static imports (dynamic import() is not followed). */
export function moduleGraph(entries, importmap, web) {
  const seen = new Set();
  const queue = [...entries];
  while (queue.length) {
    const file = queue.shift();
    if (seen.has(file)) continue;
    if (!existsSync(file)) throw new Error(`module graph: ${file} does not exist`);
    seen.add(file);
    for (const spec of importsOf(readFileSync(file, "utf8"))) {
      const target = resolveSpec(spec, dirname(file), importmap, web);
      if (!target) throw new Error(`module graph: cannot resolve "${spec}" imported by ${file}`);
      queue.push(target);
    }
  }
  return [...seen];
}

/**
 * The <head> tags of one page:
 *  - modulepreload for its whole module graph. Modules reachable only through `eager[page]` (dynamic imports made right
 *    at start, e.g. the 3D view) get fetchpriority="low": they must not compete with the scripts and styles that paint
 *    the first frame;
 *  - a fetch preload of deployment.json on every page that loads chain.js (its loadConfig() is the first thing a page
 *    awaits; chain.js fetches the very same URL with the same credentials, so the browser reuses the download);
 *  - the normal-style fonts, the mono one at low priority (small uppercase labels, not the text a visitor reads first).
 */
export function preloadLinks({ html, page, web, eager = {}, fonts = [] }) {
  const importmap = JSON.parse((html.match(/<script type="importmap">([\s\S]*?)<\/script>/) || [, '{"imports":{}}'])[1]).imports;
  const entries = [...html.matchAll(/<script[^>]*\btype="module"[^>]*\bsrc="([^"]+)"/g)].map((m) => join(web, m[1]));
  for (const m of html.matchAll(/<script[^>]*\btype="module"(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)) { // an inline module (license.html): what it imports
    for (const spec of importsOf(m[1])) {
      const target = resolveSpec(spec, web, importmap, web);
      if (!target) throw new Error(`module graph: cannot resolve "${spec}" imported by the inline module of ${page}`);
      entries.push(target);
    }
  }
  const early = new Set(moduleGraph(entries, importmap, web));
  const all = moduleGraph([...entries, ...(eager[page] || []).map((f) => join(web, f))], importmap, web);
  const rel = (f) => f.slice(web.length + 1).replace(/\\/g, "/");
  const links = all.map((f) => `<link rel="modulepreload"${early.has(f) ? "" : ' fetchpriority="low"'} href="${rel(f)}">`);
  if (all.some((f) => rel(f) === "js/chain.js")) links.unshift(`<link rel="preload" as="fetch" crossorigin href="deployment.json">`);
  links.push(...fonts.map((f) => `<link rel="preload" as="font" type="font/woff2" crossorigin${/jetbrains-mono/.test(f) ? ' fetchpriority="low"' : ""} href="${f}">`));
  return links;
}

// ---------------------------------------------------------------- vendored three.js addons
/** `three/addons/<path>` imports in a source text. */
export const addonImports = (src) => [...stripComments(src).matchAll(/["']three\/addons\/([A-Za-z0-9_\-./]+\.js)["']/g)].map((m) => m[1]);

/** The addon files (paths under examples/jsm) needed by `entries`, with the addons they import in turn (`read(path)` returns a file's text). */
export function addonClosure(entries, read) {
  const seen = new Set();
  const queue = [...entries];
  while (queue.length) {
    const file = posix.normalize(queue.shift());
    if (seen.has(file)) continue;
    seen.add(file);
    for (const spec of importsOf(read(file))) {
      if (/^\.{1,2}\//.test(spec)) queue.push(posix.join(posix.dirname(file), spec)); // another addon; "three" itself is not an addon
    }
  }
  return [...seen].sort();
}
