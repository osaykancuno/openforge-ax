// Brand assets for OpenSea, X and the site, rendered from the same AX-1 models the site uses (CC0).
//   npm run brand  -> art/brand/{logo.png, logo-1000.png, lockup.png, featured.png, banner.png, og.png, x-header.png,
//                               placeholder.png, favicon.svg, mark.svg}
// Needs a local Chrome or Edge (BROWSER=path to override). Serves the repo on 127.0.0.1 only, for the render.
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";
import { markSVG } from "../art/brand/src/mark.mjs";
import { openPage, root, startHeadless } from "./lib/headless.mjs";

const out = join(root, "art/brand");
await mkdir(out, { recursive: true });
const hl = await startHeadless();
const base = `${hl.base}/art/brand/src/render.html`;

try {
  async function render(asset, scale = 2) {
    const { page, ready } = await openPage(hl.browser, `${base}?asset=${asset}`, { scale });
    const png = await (await page.$("#art")).screenshot({ type: "png", omitBackground: false });
    await page.close();
    return { png, ...ready };
  }

  const save = (name, img, w, h) => sharp(img).resize(w, h, { fit: "fill" }).png({ compressionLevel: 9 }).toFile(join(out, name));
  for (const [asset, files] of Object.entries({
    logo: [["logo-1000.png", 1000, 1000], ["logo.png", 350, 350]],
    placeholder: [["placeholder.png", 1000, 1000]],
    lockup: [["lockup.png", 1200, 300]],
    featured: [["featured.png", 600, 400]],
    banner: [["banner.png", 1400, 350]],
    og: [["og.png", 1200, 630]],
    xheader: [["x-header.png", 1500, 500]],
  })) {
    const { png } = await render(asset, asset === "logo" || asset === "placeholder" ? 1 : 2);
    for (const [name, w, h] of files) await save(name, png, w, h);
    console.log(`  ${asset} → ${files.map((f) => f[0]).join(", ")}`);
  }
  await writeFile(join(out, "mark.svg"), markSVG({ size: 512, bg: null }));
  await writeFile(join(out, "favicon.svg"), markSVG({ size: 64 }));
} finally {
  await hl.close();
}
console.log(`brand assets in ${out}`);
