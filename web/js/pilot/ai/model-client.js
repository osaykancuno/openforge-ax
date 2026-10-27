// AI Pilot model client: talks to ANY OpenAI-compatible server the user runs themselves (Ollama, LM Studio,
// llama.cpp's llama-server): POST {url}/v1/chat/completions with tools, tool_choice "auto", stream false.
// Moves bytes, caps them (64 KB, 20 s by default) and finds the plan in the answer. It does not trust the answer:
// tools.js validates every step. No credentials, cookies, referrer or redirects; no API key field exists.
import { cleanSay } from "./tools.js";

export const DEFAULT_TIMEOUT_MS = 20000;
export const DEFAULT_MAX_BYTES = 65536;
const MAX_CALLS = 40;
const JSON_STARTS = 20; // openers tried when looking for JSON in prose: bounds the work on adversarial text

export class ModelError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.name = "ModelError";
    this.code = code; // bad_url | network | timeout | http | too_large | bad_response
    Object.assign(this, extra);
  }
}
const abortError = () => Object.assign(new Error("Cancelled."), { name: "AbortError" });
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

// ---------------------------------------------------------------- address

const LOOPBACK = new Set(["localhost", "127.0.0.1"]); // [::1] cannot be allowed by the page CSP (Chrome rejects it)
/**
 * Accepts http(s) addresses on this computer (localhost, 127.0.0.1); other hosts only with allowOtherHosts.
 * Returns { ok, url, host, loopback } or { ok: false, error }. A trailing slash and /v1 are dropped.
 */
export function parseModelUrl(input, { allowOtherHosts = false } = {}) {
  const fail = (error) => ({ ok: false, error });
  if (typeof input !== "string" || !input.trim() || input.length > 300) return fail("Enter the address of your model server, for example http://localhost:11434.");
  let u;
  try {
    u = new URL(input.trim());
  } catch {
    return fail("That is not a web address. Example: http://localhost:11434");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return fail("Only http:// and https:// addresses work.");
  if (u.username || u.password) return fail("Put no user name or password in the address.");
  const loopback = LOOPBACK.has(u.hostname.toLowerCase());
  if (!loopback && !allowOtherHosts) return fail("This page talks only to a model on this computer (localhost or 127.0.0.1). Tick 'other hosts' to allow another address.");
  const path = u.pathname.replace(/\/+$/, "").replace(/\/v1$/, "");
  return { ok: true, url: `${u.protocol}//${u.host}${path}`, host: u.host, loopback };
}

// ---------------------------------------------------------------- finding the plan in an answer

function balancedEnd(text, i) {
  let depth = 0;
  let inStr = false;
  for (let k = i; k < text.length; k++) {
    const c = text[k];
    if (inStr) {
      if (c === "\\") k++;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === "{" || c === "[") depth++;
    else if ((c === "}" || c === "]") && --depth === 0) return k;
  }
  return -1;
}
/** Successive JSON values found in prose (balanced {...} or [...] that parse), nested ones skipped. */
function* jsonValues(text) {
  let starts = 0;
  for (let i = 0; i < text.length && starts < JSON_STARTS; i++) {
    if (text[i] !== "{" && text[i] !== "[") continue;
    starts++;
    const end = balancedEnd(text, i);
    if (end < 0) continue;
    let v;
    try {
      v = JSON.parse(text.slice(i, end + 1));
    } catch {
      continue;
    }
    i = end;
    yield v;
  }
}

function parseArgs(a) {
  if (isObj(a)) return a;
  if (typeof a === "string") {
    try {
      const v = JSON.parse(a);
      return isObj(v) ? v : null;
    } catch {
      return null;
    }
  }
  return a === undefined || a === null ? {} : null;
}
/** One call in any of the usual shapes -> { tool, args } or null. */
function callFrom(o) {
  if (!isObj(o)) return null;
  const fn = isObj(o.function) ? o.function : null;
  const tool = o.tool ?? o.name ?? (fn ? fn.name : undefined);
  if (typeof tool !== "string") return null;
  const given = o.arguments ?? o.args ?? o.parameters ?? (fn ? fn.arguments : undefined);
  if (given !== undefined) return { tool, args: parseArgs(given) };
  const skip = new Set(["tool", "function", "type", "id", ...(o.tool === undefined ? ["name"] : [])]);
  const args = {};
  for (const [k, v] of Object.entries(o)) if (!skip.has(k)) args[k] = v;
  return { tool, args };
}
function planFrom(v) {
  if (Array.isArray(v)) {
    const steps = v.slice(0, MAX_CALLS).map(callFrom).filter(Boolean);
    return steps.length ? { say: "", steps } : null;
  }
  if (!isObj(v)) return null;
  if (Array.isArray(v.steps) || Array.isArray(v.tool_calls) || typeof v.say === "string") {
    const list = Array.isArray(v.steps) ? v.steps : Array.isArray(v.tool_calls) ? v.tool_calls : [];
    return { say: cleanSay(v.say), steps: list.slice(0, MAX_CALLS).map(callFrom).filter(Boolean) };
  }
  const one = callFrom(v);
  return one ? { say: "", steps: [one] } : null;
}

/**
 * extractPlan(content) -> { via: "content" | "none", say, steps: [{ tool, args }], text }
 * Looks for <tool_call>{...}</tool_call> blocks, then for the first JSON value in the text that looks like a plan:
 * { say, steps }, a list of calls, or one call. Pure and total.
 */
const OPEN_TAG = "<tool_call>";
const CLOSE_TAG = "</tool_call>";
/** The first MAX_CALLS <tool_call> bodies and the text outside every block: one linear, ASCII-case-insensitive scan. */
function toolCallBlocks(text) {
  const lower = text.replace(/[A-Z]+/g, (c) => c.toLowerCase()); // same length as text, so indexes match
  const blocks = [];
  let outside = "";
  let at = 0;
  for (;;) {
    const i = lower.indexOf(OPEN_TAG, at);
    if (i < 0) break;
    const j = lower.indexOf(CLOSE_TAG, i + OPEN_TAG.length);
    if (j < 0) break;
    if (blocks.length < MAX_CALLS) blocks.push(text.slice(i + OPEN_TAG.length, j));
    outside += `${text.slice(at, i)} `;
    at = j + CLOSE_TAG.length;
  }
  return { blocks, outside: outside + text.slice(at) };
}

export function extractPlan(content) {
  const text = typeof content === "string" ? content.slice(0, DEFAULT_MAX_BYTES) : "";
  const none = { via: "none", say: "", steps: [], text: text.slice(0, 2000) };
  if (!text.trim()) return none;
  const calls = [];
  const { blocks, outside } = toolCallBlocks(text);
  for (const block of blocks) {
    for (const v of jsonValues(block)) {
      const c = callFrom(v);
      if (c) calls.push(c);
      break;
    }
    if (calls.length >= MAX_CALLS) break;
  }
  if (calls.length) return { via: "content", say: cleanSay(outside), steps: calls, text: text.slice(0, 2000) };
  for (const v of jsonValues(text)) {
    const p = planFrom(v);
    if (p) return { via: "content", say: p.say, steps: p.steps, text: text.slice(0, 2000) };
  }
  return none;
}

// ---------------------------------------------------------------- the client

/**
 * createModelClient({ url, model, fetch, timeoutMs, maxBytes, allowOtherHosts, timers })
 * -> { probe(signal), plan({ messages, tools, signal }) }
 * plan() resolves { via: "tool_calls" | "content" | "none", say, steps: [{ tool, args }], text } or rejects with a
 * ModelError (network, timeout, http, too_large, bad_response) or an AbortError when the caller aborted.
 */
export function createModelClient({ url, model, fetch: fetchImpl = globalThis.fetch, timeoutMs = DEFAULT_TIMEOUT_MS, maxBytes = DEFAULT_MAX_BYTES, allowOtherHosts = false, timers = globalThis } = {}) {
  const parsed = parseModelUrl(url, { allowOtherHosts });
  if (!parsed.ok) throw new ModelError("bad_url", parsed.error);
  const base = parsed.url;
  const where = parsed.host;
  const common = { redirect: "error", credentials: "omit", cache: "no-store", referrerPolicy: "no-referrer" };

  /** One abort signal for "the caller gave up" and "too slow". */
  function linked(signal, ms) {
    const ctrl = new AbortController();
    const state = { timedOut: false };
    const onAbort = () => ctrl.abort();
    if (signal) signal.addEventListener("abort", onAbort, { once: true });
    const t = timers.setTimeout(() => {
      state.timedOut = true;
      ctrl.abort();
    }, ms);
    return {
      signal: ctrl.signal,
      state,
      cleanup() {
        timers.clearTimeout(t);
        if (signal) signal.removeEventListener("abort", onAbort);
      },
    };
  }

  async function readBody(res) {
    const tooBig = () => new ModelError("too_large", `The model's answer is larger than ${Math.round(maxBytes / 1024)} KB, so I ignored it.`);
    const len = Number(res.headers && res.headers.get ? res.headers.get("content-length") : NaN);
    if (Number.isFinite(len) && len > maxBytes) {
      try {
        await res.body.cancel();
      } catch {}
      throw tooBig();
    }
    if (!res.body || typeof res.body.getReader !== "function") {
      const t = await res.text();
      if (t.length > maxBytes) throw tooBig();
      return t;
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let total = 0;
    let out = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        reader.cancel().catch(() => {});
        throw tooBig();
      }
      out += dec.decode(value, { stream: true });
    }
    return out + dec.decode();
  }

  /** Runs one request with the shared limits and maps every failure to a ModelError (or AbortError). */
  async function request(path, init, signal) {
    if (signal && signal.aborted) throw abortError();
    const link = linked(signal, timeoutMs);
    try {
      const res = await fetchImpl(`${base}${path}`, { ...init, ...common, signal: link.signal });
      if (!res.ok) {
        try {
          await res.body.cancel();
        } catch {}
        const hint = res.status === 404 ? " Check the address and the model name." : res.status === 403 ? " The server may be blocking this page (CORS or allowed origins)." : "";
        throw new ModelError("http", `The model server answered ${res.status}.${hint}`, { status: res.status });
      }
      return await readBody(res);
    } catch (e) {
      if (signal && signal.aborted) throw abortError();
      if (link.state.timedOut) throw new ModelError("timeout", `The model did not answer within ${timeoutMs >= 1000 ? `${Math.round(timeoutMs / 1000)} s` : `${timeoutMs} ms`}, so I stopped waiting (timed out).`);
      if (e instanceof ModelError) throw e;
      throw new ModelError("network", `Could not reach the model at ${where}. Is the server running? If it is, see "Set up a model" for CORS.`);
    } finally {
      link.cleanup();
    }
  }

  return {
    where,
    model,

    async plan({ messages, tools, signal } = {}) {
      const body = JSON.stringify({ model, messages, tools, tool_choice: "auto", stream: false, temperature: 0.2, max_tokens: 600 });
      const text = await request("/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json" }, body }, signal);
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        throw new ModelError("bad_response", "The model server did not answer with JSON. Is this an OpenAI-compatible address?");
      }
      const choices = data && data.choices;
      const msg = Array.isArray(choices) && choices[0] ? choices[0].message : null;
      if (!isObj(msg)) throw new ModelError("bad_response", "The model server's answer had no message in it.");
      const content = typeof msg.content === "string" ? msg.content : "";
      if (Array.isArray(msg.tool_calls) && msg.tool_calls.length) {
        const steps = msg.tool_calls.slice(0, MAX_CALLS).map((c) => {
          const fn = c && isObj(c.function) ? c.function : {};
          return { tool: fn.name, args: parseArgs(fn.arguments) };
        });
        return { via: "tool_calls", say: cleanSay(content), steps, text: content.slice(0, 2000) };
      }
      return extractPlan(content);
    },

    /** Is the server there, and does it list the model? Never throws. */
    async probe(signal) {
      try {
        const text = await request("/v1/models", { method: "GET", headers: { accept: "application/json" } }, signal);
        let data = null;
        try {
          data = JSON.parse(text);
        } catch {}
        const list = data && Array.isArray(data.data) ? data.data : data && Array.isArray(data.models) ? data.models : [];
        const models = list.map((m) => (m && typeof m.id === "string" ? m.id : m && typeof m.name === "string" ? m.name : null)).filter(Boolean).slice(0, 100).map((s) => cleanSay(s, 80));
        return { ok: true, models, hasModel: models.includes(model) };
      } catch (e) {
        return { ok: false, error: e && e.name === "AbortError" ? "Cancelled." : e && e.message ? e.message : "Could not reach the server." };
      }
    },
  };
}
