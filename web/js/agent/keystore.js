// The agent key of Assisted mode. It is made in this browser, encrypted with a passphrase the holder types (scrypt +
// AES, the standard Ethereum keystore file), and kept in IndexedDB, one key per chain + agent wallet + token. The
// plaintext key exists only in memory, only while the console is open and unlocked; nothing leaves the browser.
// ethers and the storage are passed in, so this runs in Node with a Map as well as in the page.

const MIN_PASSPHRASE = 12;
const MAX_KEYSTORE_CHARS = 20_000; // a real keystore file is under 1 KB; refuse a huge paste before parsing it
// scrypt cost (N) an imported file may have: below 2^14 it is cheap to guess, above 2^20 it can freeze the page
const MIN_N = 2 ** 14;
const MAX_N = 2 ** 20;

/** Where one agent's key is kept: chain, agent wallet (any case) and token id. */
export const keyId = (chainId, account, tokenId) => `${Number(chainId)}:${String(account).toLowerCase()}:${Number(tokenId)}`;

// ---------------------------------------------------------------- passphrase
// words and patterns that are tried first by anyone guessing
const COMMON = ["password", "passw0rd", "qwerty", "letmein", "iloveyou", "welcome", "admin", "openforge", "metamask", "ethereum", "bitcoin", "123456", "654321", "000000", "correct horse battery staple", "correcthorsebatterystaple"];

/** A run of 5+ characters that each step up (or each step down) by one: abcde, 12345, edcba. */
function hasSequence(t) {
  let run = 1, dir = 0;
  for (let i = 1; i < t.length; i++) {
    const d = t.charCodeAt(i) - t.charCodeAt(i - 1);
    if (d === 1 || d === -1) {
      run = d === dir ? run + 1 : 2;
      dir = d;
    } else {
      run = 1;
      dir = 0;
    }
    if (run >= 5) return true;
  }
  return false;
}

/**
 * null when the passphrase is acceptable, otherwise what to tell the holder. The key file can be copied, so the passphrase
 * is all that stands between a stolen file and the agent wallet's daily limit: 12+ characters, no repeats, no sequences, no
 * common words, and either three kinds of characters (lower, UPPER, digit, symbol) or four different words.
 */
export function checkPassphrase(p) {
  const need = `Use a passphrase of at least ${MIN_PASSPHRASE} characters that is hard to guess: three kinds of characters (lower, UPPER, digits, symbols) or four different words. Without it the key cannot be opened, and nobody can recover it.`;
  if (typeof p !== "string" || p.length < MIN_PASSPHRASE) return need;
  const t = p.toLowerCase();
  if (new Set(t).size < 6 || /(.)\1{3,}/.test(t) || /(.{2,4})\1{2,}/.test(t)) return `That passphrase repeats itself. ${need}`;
  if (hasSequence(t)) return `That passphrase contains a sequence like abcde or 12345. ${need}`;
  if (COMMON.some((w) => t.includes(w))) return `That passphrase contains a very common word or pattern. ${need}`;
  const kinds = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^a-zA-Z0-9\s]/].filter((r) => r.test(p)).length;
  const words = new Set(t.split(/[\s._-]+/).filter((w) => /^[a-z]{3,}$/.test(w)));
  if (kinds < 3 && words.size < 4) return need;
  return null;
}

// ---------------------------------------------------------------- storage
/** A Map with the same async surface as the IndexedDB store (tests, and a browser with storage blocked). */
export function memoryStore() {
  const m = new Map();
  return { get: async (k) => (m.has(k) ? structuredClone(m.get(k)) : null), put: async (k, v) => void m.set(k, structuredClone(v)), delete: async (k) => void m.delete(k) };
}

/** IndexedDB-backed store: one object store of { key -> record }. Rejects if the browser blocks IndexedDB. */
export function idbStore(name = "openforge-agent-keys") {
  const open = () =>
    new Promise((resolve, reject) => {
      const r = indexedDB.open(name, 1);
      r.onupgradeneeded = () => r.result.createObjectStore("keys");
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  const tx = async (mode, fn) => {
    const db = await open();
    return new Promise((resolve, reject) => {
      const t = db.transaction("keys", mode);
      const req = fn(t.objectStore("keys"));
      t.oncomplete = () => (db.close(), resolve(req.result ?? null));
      t.onerror = t.onabort = () => (db.close(), reject(t.error));
    });
  };
  return { get: (k) => tx("readonly", (s) => s.get(k)), put: (k, v) => tx("readwrite", (s) => s.put(v, k)), delete: (k) => tx("readwrite", (s) => s.delete(k)) };
}

// ---------------------------------------------------------------- the key
/**
 * A fresh random key, encrypted. Returns { wallet, json, address }: `json` is what gets stored and exported; `wallet`
 * is the unlocked key, for this visit only. `scryptN` is for tests; the page uses ethers' default cost.
 */
export async function createKey({ ethers, passphrase, scryptN }) {
  const bad = checkPassphrase(passphrase);
  if (bad) throw new Error(bad);
  const wallet = ethers.Wallet.createRandom();
  const options = scryptN ? { scrypt: { N: scryptN } } : undefined;
  const json = await ethers.encryptKeystoreJson({ address: wallet.address, privateKey: wallet.privateKey }, passphrase, options);
  return { wallet, json, address: wallet.address };
}

/**
 * Writes a record. An existing key is never overwritten silently: that needs `replace: true` (the page asks the holder
 * first), so a second tab or a stale page cannot swap the key out from under them.
 */
export async function putRecord(store, record, { replace = false } = {}) {
  if (!replace && (await store.get(record.id))) throw Object.assign(new Error("A key for this agent is already stored in this browser. Forget it first, or confirm replacing it."), { code: "EXISTS" });
  await store.put(record.id, record);
  return record;
}

/** Stores the encrypted key with the facts the console needs later (never the plaintext key). */
export async function saveKey(store, { chainId, account, tokenId, holder }, json, address, opts) {
  return putRecord(store, { v: 1, id: keyId(chainId, account, tokenId), chainId: Number(chainId), account, tokenId: Number(tokenId), holder, address, keystore: json, createdAt: Date.now() }, opts);
}

export const loadRecord = async (store, id) => (await store.get(id)) ?? null;
export const forgetKey = async (store, id) => void (await store.delete(id));

/** Opens the stored key with the passphrase. Throws "Wrong passphrase." (nothing else leaks about the file). */
export async function unlockKey({ ethers, record, passphrase }) {
  try {
    const w = await ethers.Wallet.fromEncryptedJson(record.keystore, passphrase);
    if (w.address.toLowerCase() !== String(record.address).toLowerCase()) throw new Error("mismatch");
    return w;
  } catch {
    throw new Error("Wrong passphrase.");
  }
}

/** The encrypted file to download: exactly what is stored, still locked by the passphrase. */
export const exportKeystore = (record) => ({ filename: `openforge-agent-${record.tokenId}-key.json`, text: record.keystore });

/** True when a parsed keystore uses scrypt at a cost this page accepts (a power of two from 2^14 to 2^20). */
export function kdfCostOk(j) {
  const c = j?.crypto ?? j?.Crypto;
  const n = c?.kdfparams?.n;
  return c?.kdf === "scrypt" && Number.isInteger(n) && n >= MIN_N && n <= MAX_N && (n & (n - 1)) === 0;
}

/**
 * Brings an exported file back (a new browser, a cleared one). Only an encrypted keystore is accepted, never a raw
 * private key; its scrypt cost must be sane; the passphrase must open it; and the key is re-encrypted at this page's own
 * cost. Returns the record WITHOUT storing it: the page shows the address and asks the holder first.
 */
export async function importKeystore({ ethers, text, passphrase, meta, scryptN }) {
  const notKeystore = new Error("That is not an agent key file. Choose the encrypted keystore file you exported.");
  if (typeof text !== "string" || text.length === 0 || text.length > MAX_KEYSTORE_CHARS || !ethers.isKeystoreJson(text)) throw notKeystore;
  if (!kdfCostOk(JSON.parse(text))) throw new Error("This key file's encryption strength is outside what this page accepts (scrypt cost 2^14 to 2^20), so it was not opened. Import only a file you exported from this page.");
  let w;
  try {
    w = await ethers.Wallet.fromEncryptedJson(text, passphrase);
  } catch {
    throw new Error("Wrong passphrase.");
  }
  const json = await ethers.encryptKeystoreJson({ address: w.address, privateKey: w.privateKey }, passphrase, scryptN ? { scrypt: { N: scryptN } } : undefined);
  return { v: 1, id: keyId(meta.chainId, meta.account, meta.tokenId), chainId: Number(meta.chainId), account: meta.account, tokenId: Number(meta.tokenId), holder: meta.holder, address: w.address, keystore: json, createdAt: Date.now() };
}
