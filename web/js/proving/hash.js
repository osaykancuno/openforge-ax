// Hashing and randomness for the pages that sign runs (arena, lab trials) without loading all of ethers up front:
// keccak-256 from the vendored @noble/hashes (the same audited code ethers uses), the platform's own random bytes.
import { keccak_256 } from "../../vendor/noble/sha3.js";

const enc = new TextEncoder();
const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, "0"));
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

export const ZeroHash = "0x" + "00".repeat(32);
/** UTF-8 bytes of a string; like ethers, a lone surrogate is an error (it would silently become U+FFFD). */
export const toUtf8Bytes = (s) => {
  s = String(s);
  if (LONE_SURROGATE.test(s)) throw new TypeError("invalid surrogate pair");
  return enc.encode(s);
};
export const hexlify = (bytes) => "0x" + Array.from(bytes, (b) => HEX[b]).join("");
/** 0x-prefixed lowercase keccak-256 of bytes. */
export const keccak256 = (bytes) => hexlify(keccak_256(bytes));
/** n cryptographically random bytes. */
export const randomBytes = (n) => crypto.getRandomValues(new Uint8Array(n));
