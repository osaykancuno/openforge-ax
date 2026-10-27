// AR Rover, "Look around" inside WebXR: the camera image of an immersive-ar session as small ImageData.
//
// WebXR camera access hands out the image as a WebGL texture (XRWebGLBinding.getCameraImage). The detector wants pixels
// on the CPU, 320 px wide. So: attach the texture to a read framebuffer, let the GPU shrink it into a small renderbuffer
// (blitFramebuffer, linear), read those few hundred KB back, flip the rows (GL reads bottom-up). The renderer's own GL
// state is saved and put back around every read, so three.js never notices.
//
// Nothing here leaves the page. The caller (the AR view) only offers this when the session was granted "camera-access".
// readPixels waits for the GPU, so a read costs a few milliseconds on a phone: keep it at the 2 Hz of the detector.
// LATER: async readback with a pixel buffer (PBO + fenceSync) to avoid even that wait.

import { unproject } from "../obstacle.js";

const MAX_FAILURES = 3;

function defaultMakeImageData(data, w, h) {
  return typeof ImageData !== "undefined" ? new ImageData(data, w, h) : { data, width: w, height: h };
}

/** Box-average shrink of tightly packed RGBA rows (JS fallback when the GPU cannot blit). */
function shrink(src, sw, sh, dw, dh) {
  const out = new Uint8ClampedArray(dw * dh * 4);
  for (let y = 0; y < dh; y++) {
    const y0 = Math.floor((y * sh) / dh);
    const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * sh) / dh));
    for (let x = 0; x < dw; x++) {
      const x0 = Math.floor((x * sw) / dw);
      const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * sw) / dw));
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let n = 0;
      for (let yy = y0; yy < y1; yy++) {
        for (let xx = x0; xx < x1; xx++) {
          const i = (yy * sw + xx) * 4;
          r += src[i];
          g += src[i + 1];
          b += src[i + 2];
          a += src[i + 3];
          n++;
        }
      }
      const o = (y * dw + x) * 4;
      out[o] = r / n;
      out[o + 1] = g / n;
      out[o + 2] = b / n;
      out[o + 3] = a / n;
    }
  }
  return out;
}

/**
 * createXrCameraReader(gl, session, { Binding, width = 320, makeImageData })
 * read(frame, view) -> ImageData | null. null: no camera image on this view (yet), unsupported, or failed.
 * supported, disabled (three failures in a row), close().
 */
export function createXrCameraReader(gl, session, { Binding = typeof XRWebGLBinding !== "undefined" ? XRWebGLBinding : undefined, width = 320, makeImageData = defaultMakeImageData } = {}) {
  let binding = null;
  try {
    if (Binding && gl) binding = new Binding(session, gl);
  } catch {
    binding = null;
  }
  const supported = !!binding;
  let readFbo = null;
  let drawFbo = null;
  let rbo = null;
  let rbW = 0;
  let rbH = 0;
  let raw = null;
  let failures = 0;
  let disabled = false;
  let closed = false;

  const fail = () => {
    if (++failures >= MAX_FAILURES) disabled = true;
    return null;
  };

  function read(frame, view) {
    if (!supported || disabled || closed) return null;
    const cam = view && view.camera;
    if (!cam || !(cam.width > 0) || !(cam.height > 0)) return null;
    let tex = null;
    try {
      tex = binding.getCameraImage(cam);
    } catch {
      return fail();
    }
    if (!tex) return null; // the camera has not delivered an image for this frame yet

    const outW = Math.min(Math.floor(cam.width), width);
    const outH = Math.max(1, Math.round((cam.height * outW) / cam.width));
    const prevRead = gl.getParameter(gl.READ_FRAMEBUFFER_BINDING);
    const prevDraw = gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING);
    const prevRb = gl.getParameter(gl.RENDERBUFFER_BINDING);
    try {
      if (typeof gl.isContextLost === "function" && gl.isContextLost()) {
        disabled = true;
        return null;
      }
      if (!readFbo) readFbo = gl.createFramebuffer();
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, readFbo);
      gl.framebufferTexture2D(gl.READ_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      if (gl.checkFramebufferStatus(gl.READ_FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) return fail();

      let pixels;
      const camW = Math.floor(cam.width);
      const camH = Math.floor(cam.height);
      if (outW < camW && typeof gl.blitFramebuffer === "function") {
        if (!drawFbo) {
          drawFbo = gl.createFramebuffer();
          rbo = gl.createRenderbuffer();
        }
        if (rbW !== outW || rbH !== outH) {
          gl.bindRenderbuffer(gl.RENDERBUFFER, rbo);
          gl.renderbufferStorage(gl.RENDERBUFFER, gl.RGBA8, outW, outH);
          gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, drawFbo);
          gl.framebufferRenderbuffer(gl.DRAW_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, rbo);
          rbW = outW;
          rbH = outH;
        } else gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, drawFbo);
        gl.blitFramebuffer(0, 0, camW, camH, 0, 0, outW, outH, gl.COLOR_BUFFER_BIT, gl.LINEAR);
        gl.bindFramebuffer(gl.READ_FRAMEBUFFER, drawFbo);
        if (!raw || raw.length !== outW * outH * 4) raw = new Uint8Array(outW * outH * 4);
        gl.readPixels(0, 0, outW, outH, gl.RGBA, gl.UNSIGNED_BYTE, raw);
        pixels = raw;
      } else {
        if (!raw || raw.length !== camW * camH * 4) raw = new Uint8Array(camW * camH * 4);
        gl.readPixels(0, 0, camW, camH, gl.RGBA, gl.UNSIGNED_BYTE, raw);
        pixels = outW === camW ? raw : shrink(raw, camW, camH, outW, outH);
      }
      if (gl.getError() !== gl.NO_ERROR) return fail();

      // GL rows run bottom-up: the picture's first row is the last one read
      const data = new Uint8ClampedArray(outW * outH * 4);
      const stride = outW * 4;
      for (let y = 0; y < outH; y++) data.set(pixels.subarray((outH - 1 - y) * stride, (outH - y) * stride), y * stride);
      failures = 0;
      return makeImageData(data, outW, outH);
    } catch {
      return fail();
    } finally {
      try {
        gl.bindFramebuffer(gl.READ_FRAMEBUFFER, prevRead);
        gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, prevDraw);
        gl.bindRenderbuffer(gl.RENDERBUFFER, prevRb);
      } catch {} // a lost context has nothing left to restore
    }
  }

  function close() {
    if (closed) return;
    closed = true;
    try {
      if (readFbo) gl.deleteFramebuffer(readFbo);
      if (drawFbo) gl.deleteFramebuffer(drawFbo);
      if (rbo) gl.deleteRenderbuffer(rbo);
    } catch {}
    readFbo = drawFbo = rbo = null;
    raw = null;
  }

  return {
    read,
    close,
    supported,
    get disabled() {
      return disabled;
    },
  };
}

// ---------------------------------------------------------------- depth, to place what the detector found

/** Inverse of a 4x4 column-major matrix (array-like of 16), or null when it is singular. */
export function invert4(m) {
  if (!m || m.length < 16) return null;
  const a = Array.from(m);
  const inv = new Array(16);
  inv[0] = a[5] * a[10] * a[15] - a[5] * a[11] * a[14] - a[9] * a[6] * a[15] + a[9] * a[7] * a[14] + a[13] * a[6] * a[11] - a[13] * a[7] * a[10];
  inv[4] = -a[4] * a[10] * a[15] + a[4] * a[11] * a[14] + a[8] * a[6] * a[15] - a[8] * a[7] * a[14] - a[12] * a[6] * a[11] + a[12] * a[7] * a[10];
  inv[8] = a[4] * a[9] * a[15] - a[4] * a[11] * a[13] - a[8] * a[5] * a[15] + a[8] * a[7] * a[13] + a[12] * a[5] * a[11] - a[12] * a[7] * a[9];
  inv[12] = -a[4] * a[9] * a[14] + a[4] * a[10] * a[13] + a[8] * a[5] * a[14] - a[8] * a[6] * a[13] - a[12] * a[5] * a[10] + a[12] * a[6] * a[9];
  inv[1] = -a[1] * a[10] * a[15] + a[1] * a[11] * a[14] + a[9] * a[2] * a[15] - a[9] * a[3] * a[14] - a[13] * a[2] * a[11] + a[13] * a[3] * a[10];
  inv[5] = a[0] * a[10] * a[15] - a[0] * a[11] * a[14] - a[8] * a[2] * a[15] + a[8] * a[3] * a[14] + a[12] * a[2] * a[11] - a[12] * a[3] * a[10];
  inv[9] = -a[0] * a[9] * a[15] + a[0] * a[11] * a[13] + a[8] * a[1] * a[15] - a[8] * a[3] * a[13] - a[12] * a[1] * a[11] + a[12] * a[3] * a[9];
  inv[13] = a[0] * a[9] * a[14] - a[0] * a[10] * a[13] - a[8] * a[1] * a[14] + a[8] * a[2] * a[13] + a[12] * a[1] * a[10] - a[12] * a[2] * a[9];
  inv[2] = a[1] * a[6] * a[15] - a[1] * a[7] * a[14] - a[5] * a[2] * a[15] + a[5] * a[3] * a[14] + a[13] * a[2] * a[7] - a[13] * a[3] * a[6];
  inv[6] = -a[0] * a[6] * a[15] + a[0] * a[7] * a[14] + a[4] * a[2] * a[15] - a[4] * a[3] * a[14] - a[12] * a[2] * a[7] + a[12] * a[3] * a[6];
  inv[10] = a[0] * a[5] * a[15] - a[0] * a[7] * a[13] - a[4] * a[1] * a[15] + a[4] * a[3] * a[13] + a[12] * a[1] * a[7] - a[12] * a[3] * a[5];
  inv[14] = -a[0] * a[5] * a[14] + a[0] * a[6] * a[13] + a[4] * a[1] * a[14] - a[4] * a[2] * a[13] - a[12] * a[1] * a[6] + a[12] * a[2] * a[5];
  inv[3] = -a[1] * a[6] * a[11] + a[1] * a[7] * a[10] + a[5] * a[2] * a[11] - a[5] * a[3] * a[10] - a[9] * a[2] * a[7] + a[9] * a[3] * a[6];
  inv[7] = a[0] * a[6] * a[11] - a[0] * a[7] * a[10] - a[4] * a[2] * a[11] + a[4] * a[3] * a[10] + a[8] * a[2] * a[7] - a[8] * a[3] * a[6];
  inv[11] = -a[0] * a[5] * a[11] + a[0] * a[7] * a[9] + a[4] * a[1] * a[11] - a[4] * a[3] * a[9] - a[8] * a[1] * a[7] + a[8] * a[3] * a[5];
  inv[15] = a[0] * a[5] * a[10] - a[0] * a[6] * a[9] - a[4] * a[1] * a[10] + a[4] * a[2] * a[9] + a[8] * a[1] * a[6] - a[8] * a[2] * a[5];
  const det = a[0] * inv[0] + a[1] * inv[4] + a[2] * inv[8] + a[3] * inv[12];
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return null;
  return inv.map((x) => x / det);
}

const clamp01 = (n) => Math.min(1, Math.max(0, n));

const GRID = 48;

/**
 * A snapshot of this frame's depth as the { getDepth, unproject } pair world-objects.update() wants, or null when the
 * phone gave no CPU depth. The detection answers some frames LATER (it runs in a worker) and an XRFrame and its depth are
 * only valid inside their own callback, so this reads a GRID x GRID sample of the depth picture now and copies the
 * view's matrices. Call it inside the frame callback (lookAround's capture hook does).
 *   xrView = frame.getViewerPose(space).views[0], i.e. xrViewOf(info) from detector.js
 */
export function createXrDepthContext(frame, xrView, { grid = GRID } = {}) {
  if (!frame || !xrView || typeof frame.getDepthInformation !== "function") return null;
  let di = null;
  try {
    di = frame.getDepthInformation(xrView);
  } catch {
    di = null;
  }
  if (!di || typeof di.getDepthInMeters !== "function") return null;
  const inv = invert4(xrView.projectionMatrix);
  const toWorld = xrView.transform && xrView.transform.matrix ? Array.from(xrView.transform.matrix) : null;
  if (!inv || !toWorld) return null;
  const samples = new Float32Array(grid * grid);
  for (let r = 0; r < grid; r++) {
    for (let c = 0; c < grid; c++) {
      let d = 0;
      try {
        d = di.getDepthInMeters((c + 0.5) / grid, (r + 0.5) / grid);
      } catch {
        d = 0;
      }
      samples[r * grid + c] = Number.isFinite(d) && d > 0 ? d : 0;
    }
  }
  return {
    getDepth(u, v) {
      const c = Math.min(grid - 1, Math.max(0, Math.floor(clamp01(u) * grid)));
      const r = Math.min(grid - 1, Math.max(0, Math.floor(clamp01(v) * grid)));
      return samples[r * grid + c];
    },
    unproject: (u, v, depthM) => unproject(u, v, depthM, inv, toWorld),
  };
}
