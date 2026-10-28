// Demonstration envelope "openforge.demo.v1": what a holder shows their NFT agent (their own moves, recorded after the
// drive loop's clamping), in one stable, versioned, local-first format. Nothing here ships to users yet: it only makes
// sure demonstrations recorded later never need a migration. Pure: no DOM, no network, clock injected.
//
// Not to be confused with the Proving Grounds episode (episode.js): that one is a verified, public sim run. A demo is
// private data that stays on the device unless its owner exports it. The integrity hash is a hash chain over the
// header and every frame: it catches corruption and edits, it is not a signature.
import { canonicalize } from "./episode.js";
import { JOINTS as ARM_JOINTS, LIMITS as ARM_LIMITS, ROBOT as ARM_ROBOT } from "./arm-sim.js";
import { PROTO_MAJOR, PROTO_MINOR, BODIES, DRIVE_MAX } from "../pilot/ax-proto.js";

export const DEMO_FORMAT = "openforge.demo.v1";
export const PROTO = `${PROTO_MAJOR}.${PROTO_MINOR}`;
export const SOURCES = ["phone-brain", "ar-twin", "workbench", "robot-link", "ai-pilot"];
export const ACTORS = ["human", "ai"];
export const UNITS = { joints: "deg", drive: "permille" };
export const INTEGRITY_ALG = "sha256-chain";
export const DEFAULT_TASK = "Teleoperated demonstration.";

// Caps: a demonstration is minutes of teleoperation, never a data dump.
export const MAX_FRAMES = 54000; // 30 min at 30 fps
export const MAX_DURATION_MS = 30 * 60 * 1000;
export const MAX_FEATURES = 32;
export const MAX_ABS = 1e4;
export const MAX_TASK = 120;

/** Robot ids as in web/js/models/robots.js ROBOTS (a test keeps the two lists equal; that file pulls in three.js). */
export const ROBOT_IDS = ["so101", "rover", "hound", "hand", "spider", "drone", "fab", "replicant", "ax1-rover", "ax1-desk", "ax1-walker"];

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const FEATURE = /^[a-z0-9_]{1,32}\.(pos|cmd)$/;
const isInt = (v) => typeof v === "number" && Number.isSafeInteger(v);
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

// ---------------------------------------------------------------- SHA-256 (sync, so the recorder needs no crypto API)

const K = new Uint32Array(64);
const H0 = new Uint32Array(8);
{
  const primes = [];
  for (let n = 2; primes.length < 64; n++) if (primes.every((p) => n % p)) primes.push(n);
  const frac = (x) => Math.floor((x - Math.floor(x)) * 4294967296);
  primes.forEach((p, i) => {
    K[i] = frac(Math.cbrt(p));
    if (i < 8) H0[i] = frac(Math.sqrt(p));
  });
}
const rotr = (x, n) => (x >>> n) | (x << (32 - n));

/** SHA-256 of a string (UTF-8) as 64 lowercase hex characters. */
export function sha256Hex(str) {
  const msg = new TextEncoder().encode(String(str));
  const len = msg.length;
  const buf = new Uint8Array(((len + 9 + 63) >> 6) << 6);
  buf.set(msg);
  buf[len] = 0x80;
  const dv = new DataView(buf.buffer);
  dv.setUint32(buf.length - 8, Math.floor(len / 0x20000000));
  dv.setUint32(buf.length - 4, (len << 3) >>> 0);
  const h = H0.slice();
  const w = new Uint32Array(64);
  for (let off = 0; off < buf.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
    }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let i = 0; i < 64; i++) {
      const t1 = (hh + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + w[i]) | 0;
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
      hh = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    [a, b, c, d, e, f, g, hh].forEach((v, i) => (h[i] = (h[i] + v) | 0));
  }
  return Array.from(h, (v) => (v >>> 0).toString(16).padStart(8, "0")).join("");
}

/** Hash chain: head = sha256(prev + frame) over every frame, seeded with the header. Covers the whole envelope. */
export function chainHead(header, frames) {
  let head = sha256Hex(canonicalize(header));
  for (const f of frames) head = sha256Hex(head + canonicalize(f));
  return head;
}

const headerOf = (env) => {
  const { frames, integrity, ...header } = env; // eslint-disable-line no-unused-vars
  return header;
};

// ---------------------------------------------------------------- what each robot's action vector looks like

/** AX-1 body key ("rover" | "desk" | "walker") of an AX-1 robot id, else null. */
const axBodyKey = (robot) => (typeof robot === "string" && robot.startsWith("ax1-") ? robot.slice(4) : null);
const axBody = (key) => Object.values(BODIES).find((b) => b.key === key) || null;

/**
 * Feature names and per-feature limits for robots whose layout this repo knows (AX-1 bodies and the SO-101 arm), else
 * null: any other robot brings its own names. Joints are "<name>.pos" in degrees (the LeRobot convention used by
 * scripts/lerobot-prep.mjs), wheel outputs "<name>.cmd" in permille.
 */
export function layoutOf(robot) {
  const key = axBodyKey(robot);
  if (key) {
    const def = axBody(key);
    if (!def) return null;
    const names = def.joints.map((j) => `${j.name}.pos`);
    const limits = def.joints.map((j) => [j.min / 10, j.max / 10]);
    if (def.drive) names.push("drive_l.cmd", "drive_r.cmd"), limits.push([-DRIVE_MAX, DRIVE_MAX], [-DRIVE_MAX, DRIVE_MAX]);
    return { names, limits, body: key, robotType: `ax1_${key}` };
  }
  if (robot === "so101") return { names: ARM_JOINTS.map((j) => `${j}.pos`), limits: ARM_LIMITS, body: null, robotType: ARM_ROBOT.robot_type };
  return null;
}

// ---------------------------------------------------------------- validation

function headerErrors(env, errors) {
  const e = (m) => errors.push(m);
  if (env.format !== DEMO_FORMAT) return e(`unknown format ${JSON.stringify(env.format)} (this build reads ${DEMO_FORMAT})`), false;
  const allowed = ["format", "chainId", "agents", "tokenId", "holder", "robot", "body", "proto", "source", "actor", "task", "fps", "units", "features", "consent", "frames", "integrity"];
  for (const k of Object.keys(env)) if (!allowed.includes(k)) e(`unknown field "${k}"`);

  if (!(env.chainId === null || (isInt(env.chainId) && env.chainId > 0))) e("chainId must be a positive integer or null");
  if (!(env.agents === null || (typeof env.agents === "string" && ADDRESS.test(env.agents)))) e("agents must be a contract address or null");
  if (!(env.holder === null || (typeof env.holder === "string" && ADDRESS.test(env.holder)))) e("holder must be a wallet address or null");
  if (!(env.tokenId === null || (isInt(env.tokenId) && env.tokenId >= 0))) e("tokenId must be a non-negative integer or null");
  if (env.tokenId !== null && (env.agents === null || env.chainId === null)) e("a token demo needs chainId and agents");

  if (!ROBOT_IDS.includes(env.robot)) e("unknown robot");
  const layout = layoutOf(env.robot);
  const expectBody = axBodyKey(env.robot);
  if (expectBody !== null ? env.body !== expectBody : env.body !== null) e(expectBody ? `body must be "${expectBody}" for ${env.robot}` : "body must be null for this robot");

  const m = typeof env.proto === "string" ? /^(\d{1,3})\.(\d{1,3})$/.exec(env.proto) : null;
  if (!m) e("proto must look like 1.0");
  else if (Number(m[1]) !== PROTO_MAJOR || Number(m[2]) > PROTO_MINOR) e(`unsupported proto ${env.proto} (this build speaks up to ${PROTO})`);

  if (!SOURCES.includes(env.source)) e("unknown source");
  if (!ACTORS.includes(env.actor)) e("unknown actor");
  else if ((env.actor === "ai") !== (env.source === "ai-pilot")) e('actor "ai" and source "ai-pilot" go together: AI runs are never mixed into human demonstrations');
  if (env.source === "robot-link" && !expectBody) e("robot-link demos need an AX-1 body");
  if (typeof env.task !== "string" || !env.task || env.task.length > MAX_TASK) e(`task must be a text of 1 to ${MAX_TASK} characters`);
  if (!(isInt(env.fps) && env.fps >= 1 && env.fps <= 120)) e("fps must be an integer from 1 to 120");

  if (!(isObj(env.units) && Object.keys(env.units).length === 2 && env.units.joints === UNITS.joints && env.units.drive === UNITS.drive)) e(`units must be ${JSON.stringify(UNITS)}`);

  const names = isObj(env.features) && Object.keys(env.features).length === 1 ? env.features.action : null;
  if (!Array.isArray(names) || names.length < 1 || names.length > MAX_FEATURES || !names.every((n) => typeof n === "string" && FEATURE.test(n)) || new Set(names).size !== names.length) {
    e('features must be { action: [unique "name.pos" or "name.cmd" names] }');
  } else if (layout && !same(names, layout.names)) e(`features do not match ${env.robot}`);

  const c = env.consent;
  if (!(isObj(c) && Object.keys(c).length === 3 && c.recorded === true && c.scope === "local" && typeof c.at === "string" && /^\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(c.at) && Number.isFinite(Date.parse(c.at)))) {
    e('consent must be { recorded: true, at: ISO time, scope: "local" }');
  }
  return Array.isArray(names) ? { names, limits: layout ? layout.limits : null } : null;
}

/** Strict check of a demonstration envelope. Never throws; `errors` is empty exactly when `ok`. */
export function validateDemo(env) {
  const errors = [];
  if (!isObj(env)) return { ok: false, errors: ["not an object"] };
  const shape = headerErrors(env, errors);
  if (errors.length && env.format !== DEMO_FORMAT) return { ok: false, errors };

  const fr = env.frames;
  if (!Array.isArray(fr) || fr.length < 1) errors.push("no frames");
  else if (fr.length > MAX_FRAMES) errors.push(`more than ${MAX_FRAMES} frames`);
  else if (shape) {
    const { names, limits } = shape;
    let prev = -1;
    for (let i = 0; i < fr.length && errors.length < 10; i++) {
      const f = fr[i];
      if (!isObj(f) || Object.keys(f).length !== 2 || !isInt(f.t) || !Array.isArray(f.a)) {
        errors.push(`frame ${i}: must be { t, a }`);
        break;
      }
      if (f.t <= prev) errors.push(`frame ${i}: t must increase`);
      if (f.t > MAX_DURATION_MS) errors.push(`frame ${i}: longer than ${MAX_DURATION_MS} ms`);
      prev = f.t;
      if (f.a.length !== names.length) errors.push(`frame ${i}: ${f.a.length} values for ${names.length} features`);
      else {
        for (let k = 0; k < names.length; k++) {
          const v = f.a[k];
          if (typeof v !== "number" || !Number.isFinite(v) || Math.abs(v) > MAX_ABS) errors.push(`frame ${i}: ${names[k]} is not a finite number`);
          else if (limits && (v < limits[k][0] - 1e-6 || v > limits[k][1] + 1e-6)) errors.push(`frame ${i}: ${names[k]} is outside its limits`);
        }
      }
    }
  }

  const ig = env.integrity;
  if (!(isObj(ig) && Object.keys(ig).length === 2 && ig.alg === INTEGRITY_ALG && typeof ig.head === "string" && HEX64.test(ig.head))) errors.push(`integrity must be { alg: "${INTEGRITY_ALG}", head: 64 hex }`);
  else if (!errors.length && chainHead(headerOf(env), fr) !== ig.head) errors.push("integrity hash does not match the content");
  return { ok: errors.length === 0, errors };
}

// ---------------------------------------------------------------- recorder

const round3 = (v) => Math.round(v * 1000) / 1000;

/**
 * createDemoRecorder({ meta, clock }) -> { push(sample), stop() -> envelope }
 * meta: { chainId, agents, tokenId, holder, robot, source, actor, fps, task?, features? } (null for a guest).
 * clock: { now() -> ms (monotonic), wall?() -> epoch ms } (injected; the drive loop's clock fits).
 * push({ joints: [...degrees], drive?: [left, right] }) takes the clamped values the drive loop is about to send and
 * returns whether the sample was kept. It never throws; a sample that is late, malformed or over the caps is dropped.
 * Throws at creation when `meta` cannot make a valid envelope: that is a programming error, caught at setup.
 */
export function createDemoRecorder({ meta = {}, clock } = {}) {
  if (!clock || typeof clock.now !== "function") throw new TypeError("createDemoRecorder needs a clock with now()");
  const layout = layoutOf(meta.robot);
  const names = layout ? layout.names : meta.features && meta.features.action;
  const header = {
    format: DEMO_FORMAT,
    chainId: meta.chainId ?? null,
    agents: meta.agents ?? null,
    tokenId: meta.tokenId ?? null,
    holder: meta.holder ?? null,
    robot: meta.robot,
    body: layout ? layout.body : null,
    proto: PROTO,
    source: meta.source,
    actor: meta.actor ?? (meta.source === "ai-pilot" ? "ai" : "human"),
    task: meta.task ?? DEFAULT_TASK,
    fps: meta.fps ?? 30,
    units: { ...UNITS },
    features: { action: Array.isArray(names) ? names.slice() : names },
    consent: { recorded: true, at: new Date(clock.wall ? clock.wall() : Date.now()).toISOString(), scope: "local" },
  };
  const bad = [];
  headerErrors({ ...header, frames: [], integrity: null }, bad);
  if (bad.length) throw new RangeError(`bad demo meta: ${bad.join("; ")}`);

  const width = header.features.action.length;
  const minGap = Math.max(1, Math.floor(1000 / header.fps / 2)); // at most twice the declared rate
  const start = clock.now();
  const frames = [];
  let last = -1;
  let done = null;

  return {
    push(sample) {
      try {
        if (done || frames.length >= MAX_FRAMES || !sample) return false;
        const a = [...sample.joints, ...(sample.drive || [])];
        if (a.length !== width) return false;
        const t = Math.round(clock.now() - start);
        if (t < 0 || t > MAX_DURATION_MS || (last >= 0 && t - last < minGap)) return false;
        const row = a.map((v) => (typeof v === "number" && Number.isFinite(v) ? round3(v) : NaN));
        if (row.some(Number.isNaN)) return false;
        frames.push({ t, a: row });
        last = t;
        return true;
      } catch {
        return false;
      }
    },
    /** Ends the recording (idempotent) and returns the sealed envelope. Check it with validateDemo before saving. */
    stop() {
      if (!done) done = { ...header, frames, integrity: { alg: INTEGRITY_ALG, head: chainHead(header, frames) } };
      return done;
    },
    get count() {
      return frames.length;
    },
  };
}

// ---------------------------------------------------------------- LeRobot rows

/**
 * One demonstration as an episode line of the LeRobot step-1 format (scripts/lerobot-prep.mjs → scripts/real/
 * export_lerobot.py): the same keys, joints without the ".pos" suffix, degrees. A demo records commands only, so
 * `states` carries the previous command (the first frame its own); `success` is false and `quality` 0 because a
 * demonstration is not scored. AI-run demos are refused unless `allowAi` is set, so a dataset never mixes them in
 * by accident. Throws on an invalid envelope.
 */
export function toLeRobotRows(env, { allowAi = false } = {}) {
  const v = validateDemo(env);
  if (!v.ok) throw new RangeError(`not a valid demonstration: ${v.errors[0]}`);
  if (env.actor === "ai" && !allowAi) throw new RangeError("AI-run demonstrations are not mixed into human ones (pass allowAi to export them on purpose)");
  const layout = layoutOf(env.robot);
  const actions = env.frames.map((f) => f.a);
  return {
    dataHash: env.integrity.head,
    source: `demo:${env.source}`,
    actor: env.actor,
    tokenId: env.tokenId,
    fps: env.fps,
    robot_type: layout ? layout.robotType : env.robot,
    joints: env.features.action.map((n) => n.replace(/\.(pos|cmd)$/, "")),
    units: env.units.joints,
    task: env.task,
    success: false,
    seconds: env.frames[env.frames.length - 1].t / 1000,
    quality: 0,
    events: [],
    seed: "",
    actions,
    states: actions.map((a, i) => (i ? actions[i - 1] : a)),
  };
}
