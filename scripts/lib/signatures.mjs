// Owner signature checks and small request guards shared by the Proving Grounds verifier and the Neo-Forge world server.
import { Contract, TypedDataEncoder, getAddress, verifyTypedData } from "ethers";

const MAGIC_1271 = "0x1626ba7e";
const NO_CODE_TTL_MS = 60_000; // an address seen without code is not asked again for a minute
const NO_CODE_MAX = 5000;

/**
 * Returns async (owner, typedData, signature, ctx?) => boolean. EOA via ecrecover first; ERC-1271 (Safe) only if needed.
 * ctx.allowRpc() is asked right before the first chain call (getCode / isValidSignature): a guest-chosen address would
 * otherwise make the verifier call any contract. When it says no, nothing is called, ctx.limited is set and the result is false.
 */
export function ownerVerifier(provider, { timeoutMs = 5000 } = {}) {
  const withTimeout = (p) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error("rpc timeout")), timeoutMs))]);
  const noCode = new Map(); // owner -> expiry (ms): wrong signatures from an EOA owner cost no RPC call
  return async (owner, td, signature, ctx) => {
    try {
      if (getAddress(verifyTypedData(td.domain, td.types, td.value, signature)) === owner) return true;
    } catch {}
    try {
      if ((noCode.get(owner) ?? 0) > Date.now()) return false;
      if (ctx?.allowRpc && !ctx.allowRpc()) return (ctx.limited = true), false;
      if ((await withTimeout(provider.getCode(owner))) === "0x") {
        if (noCode.size >= NO_CODE_MAX) noCode.delete(noCode.keys().next().value);
        noCode.set(owner, Date.now() + NO_CODE_TTL_MS);
        return false;
      }
      noCode.delete(owner);
      const wallet = new Contract(owner, ["function isValidSignature(bytes32,bytes) view returns (bytes4)"], provider);
      return (await withTimeout(wallet.isValidSignature(TypedDataEncoder.hash(td.domain, td.types, td.value), signature))) === MAGIC_1271;
    } catch {
      return false;
    }
  };
}

/**
 * Client network for rate-limit keys: an IPv6 client can rotate inside its /64, so it is reduced to the prefix;
 * IPv4-mapped IPv6 (::ffff:a.b.c.d, or the hex form) becomes the plain IPv4. Idempotent.
 */
export function netOf(ip) {
  const s = String(ip).toLowerCase().split("%")[0];
  if (!s.includes(":")) return s;
  if (s.endsWith("::/64")) return s;
  const dotted = s.match(/^(?:0*:)*:?ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) return dotted[1];
  const hex = s.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hex) {
    const [a, b] = [parseInt(hex[1], 16), parseInt(hex[2], 16)];
    return `${a >> 8}.${a & 255}.${b >> 8}.${b & 255}`;
  }
  const [head, tail = ""] = s.split("::");
  const h = head ? head.split(":") : [];
  const t = s.includes("::") && tail ? tail.split(":") : [];
  const groups = s.includes("::") ? [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill("0"), ...t] : h;
  return groups.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, "")).join(":") + "::/64";
}

/** Coarser network for open-challenge caps: /24 for IPv4, /64 for IPv6. */
export function net24Of(ip) {
  const n = netOf(ip);
  return n.includes(":") ? n : n.replace(/\.\d+$/, ".0/24");
}

/**
 * Wider network behind a rate-limit key, so rotating inside the fine one (a /64, a host) does not reset a budget:
 * IPv4 -> its /24, IPv6 -> its /48. Takes a raw address or a netOf() result.
 */
export function coarseOf(ip) {
  const n = netOf(ip);
  if (!n.includes(":")) return n.replace(/\.\d+$/, ".0/24");
  return n.split("::")[0].split(":").slice(0, 3).join(":") + "::/48";
}

/**
 * True when a parsed JSON value nests deeper than any run needs (an episode is 3 levels: actions -> action -> list).
 * Checked before canonicalize walks untrusted data recursively; the walk itself stops at the limit.
 */
export function tooDeep(v, limit = 8, depth = 0) {
  if (!v || typeof v !== "object") return false;
  if (depth >= limit) return true;
  for (const x of Array.isArray(v) ? v : Object.values(v)) if (tooDeep(x, limit, depth + 1)) return true;
  return false;
}

/** A log-safe message: URLs (an RPC key hides in the path or query) and the given secrets are blanked. */
export function redactSecrets(err, secrets = []) {
  let text = typeof err === "string" ? err : err?.stack || err?.message || String(err ?? "");
  for (const s of secrets) if (s && String(s).length >= 6) text = text.split(String(s)).join("[redacted]");
  return text.replace(/\b(?:https?|wss?):\/\/[^\s"'<>)\]]+/gi, "[url]");
}
