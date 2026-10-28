// Pure helpers that keep the art folder honest between generation, pinning and freezing: a stray, missing or
// non-image file under the base URI is permanent once the metadata is frozen. No network here except through an
// injected `fetchImpl` (tests pass a fake).
import { createHash } from "node:crypto";

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const GIF_MAGIC = [[0x47, 0x49, 0x46, 0x38, 0x39, 0x61], [0x47, 0x49, 0x46, 0x38, 0x37, 0x61]]; // GIF89a, GIF87a
export const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");
const bytesOf = (buf) => (buf instanceof Uint8Array ? buf : new Uint8Array(buf || []));

/** True if `buf` starts with the 8-byte PNG signature (and has something after it). */
export function isPng(buf) {
  const b = bytesOf(buf);
  return b.length > PNG_MAGIC.length && PNG_MAGIC.every((v, i) => b[i] === v);
}

/** True if `buf` starts with a GIF signature (and has something after it). */
export function isGif(buf) {
  const b = bytesOf(buf);
  return b.length > 6 && GIF_MAGIC.some((m) => m.every((v, i) => b[i] === v));
}

/**
 * Each token has two files under the base URI: <id>.png (the still) and <id>.gif (the animated token, the metadata's
 * `image`). ["1.png", ..., "<supply>.png", "1.gif", ..., "<supply>.gif"]
 */
export const IMAGE_TYPES = Object.freeze(["png", "gif"]);
export const expectedImageNames = (supply) => IMAGE_TYPES.flatMap((ext) => Array.from({ length: supply }, (_, i) => `${i + 1}.${ext}`));

/**
 * Compares a folder listing with exactly 1..supply.png and 1..supply.gif (nothing else: no dotfiles, no json, no
 * duplicates). Returns { ok, missing, extra } (names).
 */
export function checkImageSet(names, supply) {
  if (!Number.isInteger(supply) || supply < 1) return { ok: false, missing: [], extra: [...names], error: "supply must be a positive integer" };
  const want = new Set(expectedImageNames(supply));
  const have = new Set(names);
  const missing = [...want].filter((n) => !have.has(n));
  const extra = [...have].filter((n) => !want.has(n));
  return { ok: !missing.length && !extra.length && names.length === want.size, missing, extra };
}

/** Throws a readable error unless the listing is exactly 1..supply.png and 1..supply.gif. */
export function assertImageSet(names, supply, where = "folder") {
  const r = checkImageSet(names, supply);
  if (r.ok) return;
  const cut = (a) => (a.length > 8 ? `${a.slice(0, 8).join(", ")} … (+${a.length - 8})` : a.join(", "));
  throw new Error(`${where} must contain exactly 1.png … ${supply}.png and 1.gif … ${supply}.gif${r.error ? ` (${r.error})` : ""}. Missing: ${cut(r.missing) || "none"}. Unexpected: ${cut(r.extra) || "none"}.`);
}

/** Which ids to spot-check: first, middle and last (deduplicated). */
export const sampleIds = (supply) => [...new Set([1, Math.ceil(supply / 2), supply])].filter((i) => i >= 1 && i <= supply);

/** ipfs://<cid>/ -> an https gateway URL a plain GET can read; an https base URI is returned as it is. */
export function gatewayBase(uri, gateway = "https://gateway.pinata.cloud/ipfs") {
  const m = /^ipfs:\/\/([^/]+)\/?(.*)$/.exec(uri);
  return m ? `${gateway.replace(/\/$/, "")}/${m[1]}/${m[2]}` : uri;
}

/**
 * GET `url`; ok only for HTTP 200 and the signature its extension promises (.gif: GIF, anything else: PNG). Never throws:
 * returns { ok, reason, bytes, network }.
 */
export async function fetchImage(url, fetchImpl = fetch) {
  const gif = /.gif$/i.test(url);
  try {
    const res = await fetchImpl(url);
    if (res.status !== 200) return { ok: false, reason: `HTTP ${res.status} for ${url}` };
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (!(gif ? isGif(bytes) : isPng(bytes))) return { ok: false, reason: `${url} answered 200 but is not a ${gif ? "GIF" : "PNG"} (first bytes ${Buffer.from(bytes.slice(0, 8)).toString("hex")})` };
    return { ok: true, bytes };
  } catch (e) {
    return { ok: false, network: true, reason: `network error for ${url}: ${e.message}` };
  }
}
/** The PNG-only name the scripts used before the animated tokens (same check). */
export const fetchPng = fetchImage;

/**
 * After pinning: fetch a few images through the gateway and compare sha256 with the local files.
 * `readLocal(name)` returns the local bytes. Returns { skipped: true } when offline, throws on any mismatch.
 */
export async function verifyPinned({ cid, supply, readLocal, fetchImpl = fetch, gateway, retries = 3, delayMs = 3000, log = console.log }) {
  const base = gatewayBase(`ipfs://${cid}/`, gateway);
  const names = sampleIds(supply).flatMap((id) => IMAGE_TYPES.map((ext) => `${id}.${ext}`));
  for (const name of names) {
    let r;
    for (let attempt = 0; attempt < retries; attempt++) {
      r = await fetchImage(`${base}${name}`, fetchImpl);
      if (r.ok || r.network) break;
      if (attempt < retries - 1) await new Promise((res) => setTimeout(res, delayMs)); // a fresh pin can take a moment to be served
    }
    if (r.network) {
      log(`⚠ Gateway check skipped (offline?): ${r.reason}. Open ipfs://${cid}/1.gif and /${supply}.png yourself before setting the base URI.`);
      return { skipped: true };
    }
    if (!r.ok) throw new Error(`Pinned image ${name} is not served correctly: ${r.reason}. CID ${cid} was created: do not use it until this is resolved.`);
    const local = sha256(readLocal(name));
    const remote = sha256(r.bytes);
    if (local !== remote) throw new Error(`Pinned image ${name} differs from the local file (local ${local}, gateway ${remote}). CID ${cid}: do not use it.`);
  }
  log(`✔ Gateway check: ${names.join(", ")} match the local files (sha256).`);
  return { skipped: false };
}
