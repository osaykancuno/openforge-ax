// "Take a photo" in My IRL lab: the twin in your room as one JPEG, because a screenshot of AR is hard on a phone. The
// view hands over what it drew (ar-view.js capture()): the camera picture (the video in the camera view, the WebXR camera
// image in AR when the browser grants camera access) and the twin's own layer. Here they become one picture with a small
// brand mark in the corner the twin leaves free, and the person shares or saves it. Nothing is uploaded by us: the photo
// goes only where the person shares it.
//
// The maths at the top is pure (Node tests); the canvas and share parts touch the DOM only when called.

export const SITE_URL = "https://osaykancuno.github.io/openforge-ax/";
export const BRAND_LINE = "OpenForge AX · My IRL lab";
export const JPEG_QUALITY = 0.9;
export const MAX_SIDE = 1600; // px on the longer side: sharp on a phone, a few hundred KB

// The smiling AX-1 mark (art/brand/mark.svg), 100 x 100: [x, y, w, h, r, colour] rectangles and the two eye arcs.
const INK = "#23211e", PAPER = "#f4efe6", ACCENT = "#c8553d";
export const MARK = Object.freeze({
  rects: [[6, 40, 10, 20, 3.5, INK], [84, 40, 10, 20, 3.5, INK], [13, 26, 74, 48, 11, INK], [44, 61, 12, 3.6, 1.8, ACCENT], [35, 79, 30, 6, 3, ACCENT]],
  eyes: ["M32 50 q6 -8 12 0", "M56 50 q6 -8 12 0"],
  eyeColour: PAPER,
  eyeWidth: 3.6,
});

/**
 * coverCrop({ srcW, srcH, dstW, dstH }) -> { sx, sy, sw, sh }: the part of a srcW x srcH picture that `object-fit: cover`
 * shows in a dstW x dstH box (centred), so the photo frames exactly what was on screen. null without sizes.
 */
export function coverCrop({ srcW, srcH, dstW, dstH }) {
  if (!(srcW > 0 && srcH > 0 && dstW > 0 && dstH > 0)) return null;
  const s = Math.max(dstW / srcW, dstH / srcH);
  const sw = dstW / s, sh = dstH / s;
  return { sx: (srcW - sw) / 2, sy: (srcH - sh) / 2, sw, sh };
}

/** photoSize(w, h) -> { w, h } scaled so the longer side is at most MAX_SIDE (never up). */
export function photoSize(w, h, max = MAX_SIDE) {
  const k = Math.min(1, max / Math.max(w, h));
  return { w: Math.max(1, Math.round(w * k)), h: Math.max(1, Math.round(h * k)) };
}

/**
 * watermarkLayout({ w, h, corner }) -> the brand badge: its box, the mark's square and the two text lines, sized from the
 * photo's shorter side and kept inside a margin. corner: "bl" | "br" | "tl" | "tr".
 */
export function watermarkLayout({ w, h, corner = "bl" }) {
  const u = Math.min(w, h);
  const pad = Math.round(u * 0.022);
  const margin = Math.round(u * 0.035);
  const mark = Math.round(u * 0.085);
  const title = Math.max(11, Math.round(u * 0.032));
  const small = Math.max(9, Math.round(u * 0.022));
  const textW = Math.round(Math.max(BRAND_LINE.length * title * 0.56, SITE_URL.replace(/^https:\/\//, "").length * small * 0.56));
  const bw = Math.min(w - 2 * margin, pad * 3 + mark + textW);
  const bh = pad * 2 + Math.max(mark, title + small + Math.round(small * 0.5));
  const x = corner[1] === "r" ? w - margin - bw : margin;
  const y = corner[0] === "t" ? margin : h - margin - bh;
  return {
    box: { x, y, w: bw, h: bh, r: Math.round(bh * 0.28) },
    mark: { x: x + pad, y: y + (bh - mark) / 2, size: mark },
    title: { x: x + pad * 2 + mark, y: y + pad + title, size: title, text: BRAND_LINE },
    url: { x: x + pad * 2 + mark, y: y + pad + title + Math.round(small * 0.5) + small, size: small, text: SITE_URL.replace(/^https:\/\//, "") },
  };
}

/** pickCorner(coverage) -> the corner whose badge would hide the least of the twin; ties keep the bottom left. */
export function pickCorner(coverage) {
  let best = "bl";
  for (const c of ["bl", "br", "tl", "tr"]) if ((coverage[c] ?? Infinity) < (coverage[best] ?? Infinity) - 1e-9) best = c;
  return best;
}

/** photoFileName(date) -> "openforge-ax-my-irl-lab-20261028-143005.jpg" (local time). */
export function photoFileName(date = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `openforge-ax-my-irl-lab-${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}.jpg`;
}

// ---------------------------------------------------------------- canvas (browser only)

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  if (typeof ctx.roundRect === "function") ctx.roundRect(x, y, w, h, r);
  else ctx.rect(x, y, w, h);
}

function drawMark(ctx, x, y, size) {
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(size / 100, size / 100);
  for (const [rx, ry, rw, rh, rr, c] of MARK.rects) {
    ctx.fillStyle = c;
    roundRect(ctx, rx, ry, rw, rh, rr);
    ctx.fill();
  }
  ctx.strokeStyle = MARK.eyeColour;
  ctx.lineWidth = MARK.eyeWidth;
  ctx.lineCap = "round";
  for (const d of MARK.eyes) ctx.stroke(new Path2D(d));
  ctx.restore();
}

/** How much of the twin layer lies under each corner's badge (mean alpha of a coarse sample grid). */
function coverageOf(twin, w, h) {
  const out = {};
  try {
    const c = document.createElement("canvas");
    c.width = 64;
    c.height = Math.max(1, Math.round((64 * h) / w));
    const g = c.getContext("2d", { willReadFrequently: true });
    g.drawImage(twin, 0, 0, c.width, c.height);
    const px = g.getImageData(0, 0, c.width, c.height).data;
    for (const corner of ["bl", "br", "tl", "tr"]) {
      const { box } = watermarkLayout({ w, h, corner });
      let sum = 0, n = 0;
      for (let y = Math.floor((box.y / h) * c.height); y < Math.ceil(((box.y + box.h) / h) * c.height); y++) {
        for (let x = Math.floor((box.x / w) * c.width); x < Math.ceil(((box.x + box.w) / w) * c.width); x++) {
          sum += px[(y * c.width + x) * 4 + 3];
          n++;
        }
      }
      out[corner] = n ? sum / n : 0;
    }
  } catch {} // an unreadable layer: the default corner
  return out;
}

/** The paper backdrop when AR gives no camera picture: the site's paper, a faint grid and an honest line. */
function drawPaper(ctx, w, h) {
  const g = ctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, "#f7f3ec");
  g.addColorStop(1, "#e9e1d3");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = "rgba(35,33,30,0.07)";
  ctx.lineWidth = 1;
  const step = Math.round(Math.min(w, h) / 14);
  for (let x = step; x < w; x += step) ctx.strokeRect(x, -1, 0, h + 2);
  for (let y = step; y < h; y += step) ctx.strokeRect(-1, y, w + 2, 0);
  ctx.fillStyle = "rgba(35,33,30,0.55)";
  ctx.font = `600 ${Math.round(Math.min(w, h) * 0.028)}px system-ui, sans-serif`;
  ctx.textAlign = "center";
  ctx.fillText("AX-1 digital twin · the room's picture stays on your phone", w / 2, Math.round(h * 0.08));
  ctx.textAlign = "start";
}

/**
 * composePhoto(shot) -> canvas. `shot` from view.capture(): { w, h, twin (canvas), video (camera view) | camera
 * (ImageData, AR) | null }. Background (cover-cropped like the screen), then the twin, then the brand badge.
 */
export function composePhoto(shot) {
  const { w, h } = photoSize(shot.w, shot.h);
  const out = document.createElement("canvas");
  out.width = w;
  out.height = h;
  const ctx = out.getContext("2d");
  let bg = null, bw = 0, bh = 0;
  if (shot.video && shot.video.videoWidth) (bg = shot.video), (bw = shot.video.videoWidth), (bh = shot.video.videoHeight);
  else if (shot.camera) {
    bg = document.createElement("canvas");
    bg.width = bw = shot.camera.width;
    bg.height = bh = shot.camera.height;
    bg.getContext("2d").putImageData(shot.camera, 0, 0);
  }
  const crop = bg ? coverCrop({ srcW: bw, srcH: bh, dstW: w, dstH: h }) : null;
  if (crop) ctx.drawImage(bg, crop.sx, crop.sy, crop.sw, crop.sh, 0, 0, w, h);
  else drawPaper(ctx, w, h);
  ctx.drawImage(shot.twin, 0, 0, w, h);
  const L = watermarkLayout({ w, h, corner: pickCorner(coverageOf(shot.twin, w, h)) });
  ctx.save();
  ctx.shadowColor = "rgba(0,0,0,0.25)";
  ctx.shadowBlur = L.box.h * 0.2;
  ctx.fillStyle = "rgba(255,255,255,0.92)";
  roundRect(ctx, L.box.x, L.box.y, L.box.w, L.box.h, L.box.r);
  ctx.fill();
  ctx.restore();
  drawMark(ctx, L.mark.x, L.mark.y, L.mark.size);
  ctx.fillStyle = INK;
  ctx.font = `700 ${L.title.size}px system-ui, sans-serif`;
  ctx.fillText(L.title.text, L.title.x, L.title.y);
  ctx.fillStyle = "#5b554c";
  ctx.font = `500 ${L.url.size}px system-ui, sans-serif`;
  ctx.fillText(L.url.text, L.url.x, L.url.y);
  return out;
}

/** The canvas as a JPEG Blob. */
export function toJpeg(canvas, quality = JPEG_QUALITY) {
  return new Promise((ok, no) => canvas.toBlob((b) => (b ? ok(b) : no(new Error("The photo could not be encoded."))), "image/jpeg", quality));
}

/** True when this browser can share a picture file (Web Share Level 2). */
export function canShareFile(file, nav = globalThis.navigator) {
  try {
    return !!(nav && typeof nav.share === "function" && typeof nav.canShare === "function" && nav.canShare({ files: [file] }));
  } catch {
    return false;
  }
}

/**
 * sharePhoto(file) -> "shared" | "cancelled" | "unsupported". Call it in a tap (the browser wants the person's gesture).
 */
export async function sharePhoto(file, nav = globalThis.navigator) {
  if (!canShareFile(file, nav)) return "unsupported";
  try {
    await nav.share({ files: [file], title: "My IRL lab", text: "AX-1's twin in my IRL lab · OpenForge AX", url: SITE_URL });
    return "shared";
  } catch (e) {
    if (e && e.name === "AbortError") return "cancelled";
    throw e;
  }
}

/** Saves the photo through a download link (every browser; iPhone shows it to keep in Photos). */
export function savePhoto(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.rel = "noopener";
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}
