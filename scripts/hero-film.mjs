// The AX-1 launch film (docs/19-HERO-VIDEO.md): the digital twin from the lab turns into the real robot (AI shots),
// then the end card. Local parts (twin, captions, end card, sound) are rendered from the site's own models and fonts.
//   node scripts/hero-film.mjs   -> art/marketing/out/ax1-hero-film-1080x1920.mp4 and a 1080x1080 cut
// Needs art/marketing/hero/{keyframe-a.png, shot1.mp4, shot2.mp4} (Higgsfield), Chrome/Edge and ffmpeg.
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { openPage, root, startHeadless } from "./lib/headless.mjs";

const hero = join(root, "art/marketing/hero");
const out = join(root, "art/marketing/out");
const tmp = join(tmpdir(), `ofx-hero-${process.pid}`);
await mkdir(tmp, { recursive: true });
const ffmpeg = (args) =>
  new Promise((ok, ko) => {
    const p = spawn("ffmpeg", ["-y", "-loglevel", "error", ...args], { stdio: ["ignore", "inherit", "inherit"] });
    p.on("error", ko);
    p.on("exit", (c) => (c === 0 ? ok() : ko(new Error(`ffmpeg exited ${c}`))));
  });

// timeline (s): twin 0–2.6 → real still (cross-fade) 2.1–3.3 → shot 1 3.3–6.3 → shot 2 6.3–11.3 → end card 10.9–14.3
const T = { twin: 2.6, still: 1.2, fade1: 0.5, shot1: 3, shot2: 5, fade2: 0.4, end: 3.4 };
const CAPTIONS = [
  ["c1", "Your old phone is about to get a body.", 260, 0.2, 2.3],
  ["c2", "Designed in an open 3D lab.", 260, 2.4, 4.0],
  ["c3", "Built for your desk.", 260, 4.0, 6.2],
  ["c4", "Meet AX-1.", 1460, 7.0, 10.8],
];

const hl = await startHeadless();
const base = `${hl.base}/art/marketing/src/render.html`;
try {
  for (const [asset, secs] of [["twinopen", T.twin], ["endcard", T.end]]) {
    const { page } = await openPage(hl.browser, `${base}?asset=${asset}`, { width: 2000, height: 2000 });
    const node = await page.$("#art");
    for (let i = 0; i < Math.round(secs * 30); i++) {
      await page.evaluate((t) => window.__frame(t), i / 30);
      await node.screenshot({ path: join(tmp, `${asset}${String(i).padStart(4, "0")}.png`) });
    }
    await page.close();
  }
  for (const [name, text, y] of CAPTIONS) {
    const { page } = await openPage(hl.browser, `${base}?asset=caption&text=${encodeURIComponent(text)}&y=${y}`, { width: 2000, height: 2000 });
    await (await page.$("#art")).screenshot({ path: join(tmp, `${name}.png`), omitBackground: true });
    await page.close();
  }
  const { page } = await openPage(hl.browser, `${base}?asset=caption&label=1`, { width: 2000, height: 2000 });
  await (await page.$("#art")).screenshot({ path: join(tmp, "label.png"), omitBackground: true });
  await page.close();
} finally {
  await hl.close();
}

const V = "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,fps=30,format=yuv420p,setsar=1,settb=AVTB";
const t1 = T.twin - T.fade1; // still starts
const s1 = t1 + T.still; // shot 1 starts
const s2 = s1 + T.shot1;
const e0 = s2 + T.shot2 - T.fade2; // end card starts
const total = e0 + T.end;
const inputs = [
  "-framerate", "30", "-i", join(tmp, "twinopen%04d.png"),
  "-loop", "1", "-framerate", "30", "-t", String(T.still), "-i", join(hero, "keyframe-a.png"),
  "-i", join(hero, "shot1.mp4"),
  "-i", join(hero, "shot2.mp4"),
  "-framerate", "30", "-i", join(tmp, "endcard%04d.png"),
  ...CAPTIONS.flatMap(([n]) => ["-i", join(tmp, `${n}.png`)]),
  "-i", join(tmp, "label.png"),
];
const f = [
  `[0:v]${V}[tw]`,
  `[1:v]${V},zoompan=z='1+0.025*on/36':d=1:s=1080x1920:fps=30,settb=AVTB,setpts=PTS-STARTPTS[st]`, // a slow push-in on the real frame
  `[2:v]trim=0:${T.shot1},setpts=PTS-STARTPTS,${V}[a]`,
  `[3:v]trim=0:${T.shot2},setpts=PTS-STARTPTS,${V}[b]`,
  `[4:v]${V}[en]`,
  `[tw][st]xfade=transition=fade:duration=${T.fade1}:offset=${t1}[x1]`,
  `[x1][a]concat=n=2:v=1[x2]`,
  `[x2][b]concat=n=2:v=1[x3]`,
  `[x3][en]xfade=transition=fade:duration=${T.fade2}:offset=${e0}[x4]`,
];
let last = "x4";
CAPTIONS.forEach(([, , , a, b], i) => {
  f.push(`[${last}][${5 + i}:v]overlay=0:0:enable='between(t,${a},${b})'[o${i}]`);
  last = `o${i}`;
});
f.push(`[${last}][${5 + CAPTIONS.length}:v]overlay=0:0:enable='between(t,${t1},${e0 + 0.2})'[vout]`);
// sound: a warm low pad, a click when the phone lands, a rising chime when the face wakes, a soft chime on the card
const click = s1 + 1.3, wake = s1 + 2.6, card = e0 + 0.5;
const audio =
  `aevalsrc='0.05*sin(2*PI*110*t)*min(1,t/2)*min(1,(${total}-t)/1.5)+0.035*sin(2*PI*164.81*t)*min(1,t/3)*min(1,(${total}-t)/1.5)+0.025*sin(2*PI*220*t+sin(2*PI*0.3*t))*min(1,t/4)*min(1,(${total}-t)/1.5)` +
  `+0.5*(random(0)-0.5)*exp(-90*(t-${click}))*gte(t,${click})` +
  `+0.12*sin(2*PI*880*t)*exp(-3*(t-${wake}))*gte(t,${wake})+0.08*sin(2*PI*1318.5*t)*exp(-3*(t-${wake + 0.12}))*gte(t,${wake + 0.12})` +
  `+0.09*sin(2*PI*659.25*t)*exp(-2.5*(t-${card}))*gte(t,${card})+0.06*sin(2*PI*987.77*t)*exp(-2.5*(t-${card + 0.15}))*gte(t,${card + 0.15})':s=48000:d=${total}`;
const film = join(out, "ax1-hero-film-1080x1920.mp4");
await ffmpeg([...inputs, "-f", "lavfi", "-i", audio, "-filter_complex", f.join(";"), "-map", "[vout]", "-map", `${6 + CAPTIONS.length}:a`,
  "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "18", "-preset", "slow", "-c:a", "aac", "-b:a", "160k", "-shortest", "-movflags", "+faststart", film]);
// square cut for X and feeds: the middle of the frame, where the robot is
await ffmpeg(["-i", film, "-vf", "crop=1080:1080:0:420", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "19", "-c:a", "copy", "-movflags", "+faststart", join(out, "ax1-hero-film-1080x1080.mp4")]);
await rm(tmp, { recursive: true, force: true });
console.log(`hero film: ${film} (${total.toFixed(1)} s)`);
