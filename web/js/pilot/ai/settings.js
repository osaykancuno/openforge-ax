// AI Pilot settings: the model address and name, saved by the page in its storage (passed in, so this file stays pure
// and testable). There is no API key field and none is ever stored: the model is yours, on your own machine.
import { cleanSay } from "./tools.js";
import { createModelClient, parseModelUrl } from "./model-client.js";

export const STORAGE_KEY = "openforge.ai-pilot.v1";
const DEFAULT_URL = "http://localhost:11434"; // Ollama's default
const MAX_MODEL = 80;

const cleanModel = (v) => (typeof v === "string" ? cleanSay(v, MAX_MODEL) : "");

/** { url, model, allowOtherHosts } from storage. Anything missing, hostile or broken falls back to the defaults. */
export function loadSettings(storage) {
  const out = { url: DEFAULT_URL, model: "", allowOtherHosts: false };
  let raw = null;
  try {
    raw = JSON.parse(storage.getItem(STORAGE_KEY));
  } catch {
    return out;
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return out;
  out.allowOtherHosts = raw.allowOtherHosts === true;
  const p = parseModelUrl(raw.url, { allowOtherHosts: out.allowOtherHosts });
  if (p.ok) out.url = p.url;
  out.model = cleanModel(raw.model);
  return out;
}

/** Validates and saves. Returns { ok, settings } or { ok: false, error }. Only url, model and allowOtherHosts are kept. */
export function saveSettings(storage, input) {
  const src = input && typeof input === "object" ? input : {};
  const allowOtherHosts = src.allowOtherHosts === true;
  const p = parseModelUrl(src.url, { allowOtherHosts });
  if (!p.ok) return { ok: false, error: p.error };
  const settings = { url: p.url, model: cleanModel(src.model), allowOtherHosts };
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    return { ok: false, error: "This browser would not save the settings (private mode?). They work until you close the page." };
  }
  return { ok: true, settings };
}

/** The header line: says plainly what is in charge. */
export function modelLabel(settings) {
  const s = settings || {};
  if (!s.model) return "No model: built-in parser";
  const p = parseModelUrl(s.url, { allowOtherHosts: true });
  const host = p.ok ? p.host : String(s.url);
  return `Model: ${s.model} at ${host} (${p.ok && p.loopback ? "this computer" : "another computer"})`;
}

/** A model client for these settings, or null when no model is set (or the address is not allowed). */
export function clientFromSettings(settings, opts = {}) {
  const s = settings || {};
  if (!s.model) return null;
  const p = parseModelUrl(s.url, { allowOtherHosts: s.allowOtherHosts === true });
  if (!p.ok) return null;
  return createModelClient({ url: p.url, model: s.model, allowOtherHosts: s.allowOtherHosts === true, ...opts });
}
