// Marketing kit for the launch: stills, GIFs and videos of AX-1, rendered from the site's own models (CC0), plus a
// lab tour made from screenshots of the real pages. Copy, captions and the editorial plan: docs/17-LAUNCH-PLAN.md.
//   npm run marketing            -> art/marketing/out/*.png|gif|mp4
//   npm run marketing -- teaser  -> only the assets whose name contains "teaser"
// Needs a local Chrome or Edge (BROWSER=path) and ffmpeg on the PATH. No prices anywhere: they confuse people.
import { mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { openPage, root, startHeadless } from "./lib/headless.mjs";
import { createHandler } from "./serve.mjs";

const out = join(root, "art/marketing/out");
const only = process.argv[2] || "";
const want = (name) => !only || name.includes(only);
await mkdir(out, { recursive: true });

const ffmpeg = (args) =>
  new Promise((ok, ko) => {
    const p = spawn("ffmpeg", ["-y", "-loglevel", "error", ...args], { stdio: ["ignore", "inherit", "inherit"] });
    p.on("error", ko);
    p.on("exit", (code) => (code === 0 ? ok() : ko(new Error(`ffmpeg exited ${code}`))));
  });

const STILLS = { hero: "ax1-hero-1600x900.png", portrait: "ax1-portrait-1080x1350.png", story: "ax1-story-1080x1920.png", lineup: "class-lineup-1600x900.png", whyphone: "why-a-phone-1080x1350.png", ref: "ref-ax1-rover-1080x1920.png", refdesk: "ref-ax1-desk-1080x1920.png" };
// name -> [asset, seconds, fps, outputs]
const ANIMS = {
  turntable: ["turntable", 4, 20, ["ax1-turntable.gif", "ax1-turntable.mp4"]],
  wave: ["wave", 3, 20, ["ax1-wave.gif", "ax1-wave.mp4"]],
  teaser: ["teaser", 8, 30, ["ax1-signal-teaser-1080x1350.mp4"]],
  whyphone: ["whyphonevideo", 12.5, 30, ["why-a-phone-1080x1350.mp4"]],
  reveal: ["reveal", 9, 30, ["ax1-reveal-1920x1080.mp4"]],
};

const hl = await startHeadless();
const base = `${hl.base}/art/marketing/src/render.html`;
try {
  for (const [asset, file] of Object.entries(STILLS)) {
    if (!want(file)) continue;
    const { page } = await openPage(hl.browser, `${base}?asset=${asset}`, { width: 2000, height: 2000 });
    await (await page.$("#art")).screenshot({ path: join(out, file), type: "png" });
    if (page.errors.length) console.warn(`  ${file}: ${page.errors.join(" | ")}`);
    await page.close();
    console.log(`  ${file}`);
  }

  for (const [asset, secs, fps, files] of Object.values(ANIMS)) {
    if (!files.some(want)) continue;
    const dir = join(tmpdir(), `ofx-${asset}-${process.pid}`);
    await mkdir(dir, { recursive: true });
    const { page } = await openPage(hl.browser, `${base}?asset=${asset}`, { width: 2000, height: 2000 });
    const node = await page.$("#art");
    const n = Math.round(secs * fps);
    for (let i = 0; i < n; i++) {
      await page.evaluate((t) => window.__frame(t), i / fps);
      await node.screenshot({ path: join(dir, `f${String(i).padStart(4, "0")}.png`), type: "png" });
    }
    if (page.errors.length) console.warn(`  ${asset}: ${page.errors.join(" | ")}`);
    await page.close();
    const input = ["-framerate", String(fps), "-i", join(dir, "f%04d.png")];
    for (const f of files) {
      if (f.endsWith(".mp4")) await ffmpeg([...input, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "20", "-preset", "slow", "-movflags", "+faststart", "-vf", "pad=ceil(iw/2)*2:ceil(ih/2)*2", join(out, f)]);
      else await ffmpeg([...input, "-vf", "scale=600:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128[p];[b][p]paletteuse=dither=sierra2_4a", "-loop", "0", join(out, f)]);
      console.log(`  ${f}`);
    }
    await rm(dir, { recursive: true, force: true });
  }

  // lab tour: the real pages, one after another, with a slow push-in (screenshots of web/, local chain if running)
  if (want("lab-tour")) {
    const server = createServer(createHandler([], join(root, "web")));
    await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
    const site = `http://127.0.0.1:${server.address().port}`;
    const dir = join(tmpdir(), `ofx-tour-${process.pid}`);
    await mkdir(dir, { recursive: true });
    const SHOTS = [["index.html", 4500], ["bench.html#ax1-rover", 4000], ["bench.html#hand/test", 4000], ["pilot.html", 4000, "#startTwin"], ["arena.html", 4000], ["market.html", 4500]];
    try {
      const page = await hl.browser.newPage();
      await page.setViewport({ width: 1920, height: 1080 });
      let k = 0;
      for (const [path, wait, click] of SHOTS) {
        await page.goto(`${site}/${path}`, { waitUntil: "networkidle2", timeout: 60000 }).catch(() => {});
        if (click) await page.click(click).catch(() => {});
        await new Promise((r) => setTimeout(r, wait));
        await page.screenshot({ path: join(dir, `s${k++}.png`) });
      }
      await page.close();
      // each shot 3 s with a gentle zoom, crossfaded
      const inputs = [], filters = [];
      for (let i = 0; i < k; i++) {
        inputs.push("-i", join(dir, `s${i}.png`)); // one still per page: zoompan makes its 102 frames (3.4 s)
        filters.push(`[${i}:v]scale=2880:-1,zoompan=z='min(zoom+0.0007,1.08)':d=102:s=1920x1080:fps=30,setsar=1[v${i}]`);
      }
      let last = "v0";
      for (let i = 1; i < k; i++) {
        filters.push(`[${last}][v${i}]xfade=transition=fade:duration=0.4:offset=${(3.4 - 0.4) * i}[x${i}]`);
        last = `x${i}`;
      }
      await ffmpeg([...inputs, "-filter_complex", [...filters, `[${last}]scale=1280:-2:flags=lanczos[out]`].join(";"), "-map", "[out]", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "27", "-movflags", "+faststart", join(out, "lab-tour-1280x720.mp4")]);
      console.log("  lab-tour-1280x720.mp4");
    } finally {
      server.close();
      await rm(dir, { recursive: true, force: true });
    }
  }
} finally {
  await hl.close();
}
await writeFile(join(out, "README.txt"), "AX-1 launch kit, rendered by `npm run marketing`. CC0. Captions and the plan: docs/17-LAUNCH-PLAN.md.\n");
console.log(`marketing kit in ${out}`);
