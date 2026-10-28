// Token art renderer: drives art/token/token.html in a headless browser (scripts/lib/headless.mjs) and returns, per token,
// a 1000 × 1000 PNG (the still: the token's pose) and an animated GIF of the same plate where the robot plays its class's
// short gesture, then rests (web/js/models/motion.mjs). Drawn from the site's own 3D models. Used by art/generate.mjs.
import sharp from "sharp";
import { openPage, startHeadless } from "../scripts/lib/headless.mjs";
import { MOTION } from "../web/js/models/motion.mjs";

/**
 * Every file that decides how a token looks: the provenance hash (PROVENANCE_HASH) covers exactly these, in order.
 * Paths are relative to the repository root.
 */
export const GENERATOR_FILES = [
  "art/traits.mjs",
  "art/token-render.mjs",
  "art/token/token.html",
  "web/js/models/token-look.js",
  "web/js/models/motion.mjs",
  "web/js/models/look.js",
  "web/js/models/robots.js",
];

/**
 * The animated token: drawn natively at `scale` × 1000 px (text and 3D, no resampling), timed by MOTION (fps and the
 * rest before each loop), and the encoder's settings. Inter-frame error lets nearly identical pixels be reused from the
 * previous frame: the plate and the paper never change, so each frame stores little more than the moving robot.
 */
/**
 * The Prime Construct's gold frame on the animated token, drawn here (librsvg) rather than by the page: the browser's
 * anti-aliased border edge at 0.75 can differ by one level between renders, and the GIF must be reproducible. Same
 * place and size as the page's .frame at 1000 px (18 px in, 3 px wide, 10 px radius), scaled by GIF.scale.
 */
export const PRIME_FRAME_SVG = (k) => {
  const w = 1000 * k, sw = 3 * k, at = 18 * k + sw / 2;
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${w}"><rect x="${at}" y="${at}" width="${w - 2 * at}" height="${w - 2 * at}" rx="${10 * k - sw / 2}" fill="none" stroke="#9c7a22" stroke-width="${sw}"/></svg>`);
};

export const GIF = Object.freeze({ scale: 0.75, colours: 128, dither: 0.6, interFrameMaxError: 6, interPaletteMaxError: 6, effort: 7 });

/** Starts the browser once. render(id, t, info) -> PNG Buffer; animate(id, t, info) -> { png, gif }; close() when done. */
export async function createTokenRenderer() {
  const hl = await startHeadless();
  try {
    const url = `${hl.base}/art/token/token.html`;
    const { page } = await openPage(hl.browser, url, { width: 1000, height: 1000 });
    const { page: anim } = await openPage(hl.browser, url, { width: 1000, height: 1000, scale: GIF.scale }); // the GIF's own page
    const node = await page.$("#art");
    const shot = async () => Buffer.from(await node.screenshot({ type: "png" }));
    const frame = async () => Buffer.from(await anim.screenshot({ type: "png", clip: { x: 0, y: 0, width: 1000, height: 1000 }, optimizeForSpeed: true }));
    const check = (id) => {
      for (const p of [page, anim]) if (p.errors.length) throw new Error(`token ${id}: ${p.errors.join(" | ")}`);
    };
    return {
      async render(id, t, info) {
        await page.bringToFront();
        await page.evaluate((spec) => window.renderToken(spec), { id, t, info });
        check(id);
        return shot();
      },
      async animate(id, t, info) {
        // a page in the background gets no animation frames (renderToken waits for two): each works in front
        await page.bringToFront();
        await page.evaluate((spec) => window.renderToken(spec), { id, t, info });
        check(id);
        const png = await shot(); // the still: frame 0 at full size (a background page cannot be captured either)
        await anim.bringToFront();
        const { frames, prime } = await anim.evaluate((spec) => window.renderToken(spec), { id, t, info });
        check(id);
        const overlay = prime ? [{ input: PRIME_FRAME_SVG(GIF.scale) }] : null;
        const grab = async () => (overlay ? sharp(await frame()).composite(overlay).png().toBuffer() : frame());
        const shots = [await grab()];
        for (let i = 1; i < frames; i++) {
          await anim.evaluate((k) => window.poseToken(k), i);
          shots.push(await grab());
        }
        check(id);
        // the rest frame first (shown while the GIF loads, and as the pause before every loop), then the gesture;
        // GIF delays are whole hundredths of a second
        const step = Math.round(100 / MOTION.fps) * 10;
        const delay = shots.map((_, i) => (i === 0 ? Math.round(MOTION.pauseS * 1000) : step));
        const gif = await sharp(shots, { join: { animated: true } })
          .gif({ loop: 0, delay, colours: GIF.colours, dither: GIF.dither, effort: GIF.effort, interFrameMaxError: GIF.interFrameMaxError, interPaletteMaxError: GIF.interPaletteMaxError, reuse: true })
          .toBuffer();
        return { png, gif };
      },
      close: () => hl.close(),
    };
  } catch (e) {
    await hl.close();
    throw e;
  }
}
