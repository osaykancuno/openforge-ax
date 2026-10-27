// Token art renderer: drives art/token/token.html in a headless browser (scripts/lib/headless.mjs) and returns one
// 1000 × 1000 PNG per token, drawn from the site's own 3D models. Used by art/generate.mjs.
import { openPage, startHeadless } from "../scripts/lib/headless.mjs";

/**
 * Every file that decides how a token looks: the provenance hash (PROVENANCE_HASH) covers exactly these, in order.
 * Paths are relative to the repository root.
 */
export const GENERATOR_FILES = [
  "art/traits.mjs",
  "art/token-render.mjs",
  "art/token/token.html",
  "web/js/models/look.js",
  "web/js/models/robots.js",
];

/** Starts the browser once. render(id, t, info) -> PNG Buffer; close() when done. */
export async function createTokenRenderer() {
  const hl = await startHeadless();
  try {
    const { page } = await openPage(hl.browser, `${hl.base}/art/token/token.html`, { width: 1000, height: 1000 });
    const node = await page.$("#art");
    return {
      async render(id, t, info) {
        await page.evaluate((spec) => window.renderToken(spec), { id, t, info });
        if (page.errors.length) throw new Error(`token ${id}: ${page.errors.join(" | ")}`);
        return Buffer.from(await node.screenshot({ type: "png" }));
      },
      close: () => hl.close(),
    };
  } catch (e) {
    await hl.close();
    throw e;
  }
}
