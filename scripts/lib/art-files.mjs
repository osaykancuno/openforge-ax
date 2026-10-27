// Pure helpers that keep the art folder honest between generation, pinning and freezing: a stray, missing or
// non-image file under the base URI is permanent once the metadata is frozen. No network here except through an
// injected `fetchImpl` (tests pass a fake).
import { createHash } from "node:crypto";

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
export const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

/** True if `buf` starts with the 8-byte PNG signature (and has something after it). */
export function isPng(buf) {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf || []);
  return b.length > PNG_MAGIC.length && PNG_MAGIC.every((v, i) => b[i] === v);
}

/** ["1.png", ..., "<supply>.png"] */
export const expectedImageNames = (supply) => Array.from({ length: supply }, (_, i) => `${i + 1}.png`);

/**
 * Compares a folder listing with exactly 1..supply.png (nothing else: no dotfiles, no json, no duplicates).
 * Returns { ok, missing, extra } (names).
 */
export function checkImageSet(names, supply) {
  if (!Number.isInteger(supply) || supply < 1) return { ok: false, missing: [], extra: [...names], error: "supply must be a positive integer" };
  const want = new Set(expectedImageNames(supply));
  const have = new Set(names);
  const missing = [...want].filter((n) => !have.has(n));
  const extra = [...have].filter((n) => !want.has(n));
  return { ok: !missing.length && !extra.length && names.length === supply, missing, extra };
}

/** Throws a readable error unless the listing is exactly 1..supply.png. */
export function assertImageSet(names, supply, where = "folder") {
  const r = checkImageSet(names, supply);
  if (r.ok) return;
  const cut = (a) => (a.length > 8 ? `${a.slice(0, 8).join(", ")} … (+${a.length - 8})` : a.join(", "));
  throw new Error(`${where} must contain exactly 1.png … ${supply}.png${r.error ? ` (${r.error})` : ""}. Missing: ${cut(r.missing) || "none"}. Unexpected: ${cut(r.extra) || "none"}.`);
}

/** Which ids to spot-check: first, middle and last (deduplicated). */
export const sampleIds = (supply) => [...new Set([1, Math.ceil(supply / 2), supply])].filter((i) => i >= 1 && i <= supply);

/** ipfs://<cid>/ -> an https gateway URL a plain GET can read; an https base URI is returned as it is. */
export function gatewayBase(uri, gateway = "https://gateway.pinata.cloud/ipfs") {
  const m = /^ipfs:\/\/([^/]+)\/?(.*)$/.exec(uri);
  return m ? `${gateway.replace(/\/$/, "")}/${m[1]}/${m[2]}` : uri;
}

/** GET `url`; ok only for HTTP 200 and a PNG signature. Never throws: returns { ok, reason, bytes, network }. */
export async function fetchPng(url, fetchImpl = fetch) {
  try {
    const res = await fetchImpl(url);
    if (res.status !== 200) return { ok: false, reason: `HTTP ${res.status} for ${url}` };
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (!isPng(bytes)) return { ok: false, reason: `${url} answered 200 but is not a PNG (first bytes ${Buffer.from(bytes.slice(0, 8)).toString("hex")})` };
    return { ok: true, bytes };
  } catch (e) {
    return { ok: false, network: true, reason: `network error for ${url}: ${e.message}` };
  }
}

/**
 * After pinning: fetch a few images through the gateway and compare sha256 with the local files.
 * `readLocal(name)` returns the local bytes. Returns { skipped: true } when offline, throws on any mismatch.
 */
export async function verifyPinned({ cid, supply, readLocal, fetchImpl = fetch, gateway, retries = 3, delayMs = 3000, log = console.log }) {
  const base = gatewayBase(`ipfs://${cid}/`, gateway);
  for (const id of sampleIds(supply)) {
    let r;
    for (let attempt = 0; attempt < retries; attempt++) {
      r = await fetchPng(`${base}${id}.png`, fetchImpl);
      if (r.ok || r.network) break;
      if (attempt < retries - 1) await new Promise((res) => setTimeout(res, delayMs)); // a fresh pin can take a moment to be served
    }
    if (r.network) {
      log(`⚠ Gateway check skipped (offline?): ${r.reason}. Open ipfs://${cid}/1.png and /${supply}.png yourself before setting the base URI.`);
      return { skipped: true };
    }
    if (!r.ok) throw new Error(`Pinned image ${id}.png is not served correctly: ${r.reason}. CID ${cid} was created: do not use it until this is resolved.`);
    const local = sha256(readLocal(`${id}.png`));
    const remote = sha256(r.bytes);
    if (local !== remote) throw new Error(`Pinned image ${id}.png differs from the local file (local ${local}, gateway ${remote}). CID ${cid}: do not use it.`);
  }
  log(`✔ Gateway check: ${sampleIds(supply).map((i) => `${i}.png`).join(", ")} match the local files (sha256).`);
  return { skipped: false };
}
