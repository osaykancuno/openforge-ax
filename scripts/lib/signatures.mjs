// Owner signature checks shared by the Proving Grounds verifier and the Neo-Forge world server.
import { Contract, TypedDataEncoder, getAddress, verifyTypedData } from "ethers";

const MAGIC_1271 = "0x1626ba7e";
const NO_CODE_TTL_MS = 60_000; // an address seen without code is not asked again for a minute
const NO_CODE_MAX = 5000;

/** Returns async (owner, typedData, signature) => boolean. EOA via ecrecover first; ERC-1271 (Safe) only if needed. */
export function ownerVerifier(provider, { timeoutMs = 5000 } = {}) {
  const withTimeout = (p) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error("rpc timeout")), timeoutMs))]);
  const noCode = new Map(); // owner -> expiry (ms): wrong signatures from an EOA owner cost no RPC call
  return async (owner, td, signature) => {
    try {
      if (getAddress(verifyTypedData(td.domain, td.types, td.value, signature)) === owner) return true;
    } catch {}
    try {
      if ((noCode.get(owner) ?? 0) > Date.now()) return false;
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
