// Local-first storage for demonstrations (web/js/sim/demo-episode.js). The storage is injected: an IndexedDB adapter
// in the browser, an in-memory one in tests. Nothing here talks to the network; a demo leaves the device only when its
// owner exports the file. Demos are keyed by owner (chain, contract, token, holder at record time): on a sale they stay
// on the seller's device.
import { validateDemo } from "./demo-episode.js";

export const MAX_DEMOS = 200;
export const MAX_FILE_BYTES = 16 * 1024 * 1024;
const META = "meta:";
const BODY = "demo:";

// ---------------------------------------------------------------- adapters: async key/value { get, put, remove, keys }

export function memoryAdapter() {
  const m = new Map();
  return {
    async get(k) {
      return m.has(k) ? structuredClone(m.get(k)) : undefined;
    },
    async put(k, v) {
      m.set(k, structuredClone(v));
    },
    async remove(k) {
      m.delete(k);
    },
    async keys() {
      return [...m.keys()];
    },
  };
}

/** IndexedDB adapter (one object store, out-of-line keys). Throws at creation where IndexedDB does not exist. */
export function idbAdapter({ indexedDB = globalThis.indexedDB, name = "openforge-demos", storeName = "demos" } = {}) {
  if (!indexedDB) throw new Error("IndexedDB is not available here");
  let opened = null;
  const open = () =>
    (opened ||= new Promise((resolve, reject) => {
      const rq = indexedDB.open(name, 1);
      rq.onupgradeneeded = () => rq.result.createObjectStore(storeName);
      rq.onsuccess = () => resolve(rq.result);
      rq.onerror = rq.onblocked = () => reject(rq.error || new Error("IndexedDB is blocked"));
    }).catch((e) => {
      opened = null; // let the next call try again
      throw e;
    }));
  const run = async (mode, fn) => {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, mode);
      const rq = fn(tx.objectStore(storeName));
      tx.oncomplete = () => resolve(rq ? rq.result : undefined);
      tx.onerror = tx.onabort = () => reject(tx.error || new Error("IndexedDB transaction failed"));
    });
  };
  return {
    get: (k) => run("readonly", (s) => s.get(k)),
    put: (k, v) => run("readwrite", (s) => s.put(v, k)),
    remove: (k) => run("readwrite", (s) => s.delete(k)),
    keys: () => run("readonly", (s) => s.getAllKeys()),
  };
}

// ---------------------------------------------------------------- files

/** The owner a demo belongs to, as one stable key. */
export const ownerKey = (e) => (e.tokenId === null ? "guest" : `${e.chainId}:${e.agents.toLowerCase()}:${e.tokenId}`);

/**
 * The file the owner can keep: { name, mime, json, blob } (blob only where Blob exists). Refuses an invalid envelope.
 * Compact JSON, the same text for the same demo.
 */
export function exportFile(env) {
  const v = validateDemo(env);
  if (!v.ok) throw new RangeError(`not a valid demonstration: ${v.errors[0]}`);
  const json = JSON.stringify(env);
  const owner = env.tokenId === null ? "guest" : `token-${env.tokenId}`;
  return {
    name: `openforge-demo-${owner}-${env.robot}-${env.integrity.head.slice(0, 8)}.json`,
    mime: "application/json",
    json,
    blob: typeof Blob === "function" ? new Blob([json], { type: "application/json" }) : null,
  };
}

/** Reads an exported file back: size-capped, parsed and strictly validated. Throws with the first reason. */
export function parseDemoFile(text) {
  if (typeof text !== "string" || text.length > MAX_FILE_BYTES) throw new RangeError("not a demonstration file (too large or not text)");
  let env;
  try {
    env = JSON.parse(text);
  } catch {
    throw new RangeError("not a demonstration file (not JSON)");
  }
  const v = validateDemo(env);
  if (!v.ok) throw new RangeError(`not a valid demonstration: ${v.errors[0]}`);
  return env;
}

// ---------------------------------------------------------------- store

const summaryOf = (id, e) => ({
  id,
  owner: ownerKey(e),
  chainId: e.chainId,
  agents: e.agents,
  tokenId: e.tokenId,
  holder: e.holder,
  robot: e.robot,
  body: e.body,
  source: e.source,
  actor: e.actor,
  task: e.task,
  frames: e.frames.length,
  durationMs: e.frames[e.frames.length - 1].t,
  at: e.consent.at,
});

/** createDemoStore(adapter) -> { save, list, load, delete, exportFile, importFile } (all async but exportFile). */
export function createDemoStore(adapter) {
  for (const m of ["get", "put", "remove", "keys"]) if (!adapter || typeof adapter[m] !== "function") throw new TypeError(`the storage adapter needs ${m}()`);
  const ids = async () => (await adapter.keys()).filter((k) => typeof k === "string" && k.startsWith(META)).map((k) => k.slice(META.length));
  const store = {
    /** Stores a valid demo under its content hash (saving the same demo twice keeps one). Returns the summary. */
    async save(env) {
      const v = validateDemo(env);
      if (!v.ok) throw new RangeError(`not a valid demonstration: ${v.errors[0]}`);
      const id = env.integrity.head;
      if (!(await adapter.get(META + id)) && (await ids()).length >= MAX_DEMOS) throw new RangeError(`the demo store is full (${MAX_DEMOS}): delete some first`);
      const summary = summaryOf(id, env);
      await adapter.put(BODY + id, env);
      await adapter.put(META + id, summary); // the summary last: a half-saved demo never shows in the list
      return summary;
    },
    /** Summaries, newest first. Filter by { owner, tokenId, actor, robot }. */
    async list(filter = {}) {
      const out = [];
      for (const id of await ids()) {
        const s = await adapter.get(META + id);
        if (!s) continue;
        if (["owner", "tokenId", "actor", "robot"].some((k) => filter[k] !== undefined && s[k] !== filter[k])) continue;
        out.push(s);
      }
      return out.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : a.id < b.id ? -1 : 1));
    },
    /** The envelope, or null when absent. A stored demo that no longer validates (corrupted) throws. */
    async load(id) {
      const env = await adapter.get(BODY + id);
      if (env === undefined) return null;
      const v = validateDemo(env);
      if (!v.ok || env.integrity.head !== id) throw new RangeError(`stored demonstration is damaged: ${v.errors[0] || "wrong id"}`);
      return env;
    },
    /** Deletes one demo for good. Returns whether it existed. */
    async delete(id) {
      const had = (await adapter.get(META + id)) !== undefined || (await adapter.get(BODY + id)) !== undefined;
      await adapter.remove(META + id);
      await adapter.remove(BODY + id);
      return had;
    },
    exportFile,
    /** Validates a file's text and stores it. */
    async importFile(text) {
      return store.save(parseDemoFile(text));
    },
  };
  return store;
}
