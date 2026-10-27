// OpenSea collection stats for the Market page (floor price, listings-side figures), fetched server-side so the API
// key never reaches the browser. Optional: without OPENSEA_API_KEY the page shows on-chain figures only.
// Cached (5 min by default) and coalesced: one upstream call at a time, whatever the traffic. A failure is remembered too
// (default 45 s): meanwhile the last good figures are served, or a 502, without calling OpenSea again.
import { redactSecrets } from "./signatures.mjs";
const SLUG = /^[a-z0-9-]{1,80}$/;
const num = (v) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null);

/** Only the fields the page shows, checked: never relay an upstream payload as is. */
export function pickStats(raw) {
  const t = raw?.total ?? {};
  const iv = (name) => {
    const i = (Array.isArray(raw?.intervals) ? raw.intervals : []).find((x) => x?.interval === name) ?? {};
    return { volume: num(i.volume), sales: num(i.sales), average: num(i.average_price) };
  };
  const symbol = typeof t.floor_price_symbol === "string" && /^[A-Z]{2,6}$/.test(t.floor_price_symbol) ? t.floor_price_symbol : "ETH";
  return { floor: num(t.floor_price), floorSymbol: symbol, owners: num(t.num_owners), sales: num(t.sales), volume: num(t.volume), average: num(t.average_price), day: iv("one_day"), week: iv("seven_day") };
}

export function createMarketProxy({ apiKey = "", slug = "", fetchImpl = globalThis.fetch, ttlMs = 5 * 60_000, failTtlMs = 45_000, now = Date.now } = {}) {
  const enabled = Boolean(apiKey) && SLUG.test(slug);
  let cache = null;
  let inflight = null;
  let failedAt = null;
  const unavailable = () => (cache ? { status: 200, body: { ...cache.body, stale: true } } : { status: 502, body: { error: "market data unavailable" } });
  /** -> { status, body } for GET /market */
  async function get() {
    if (!enabled) return { status: 404, body: { error: "market data not configured" } };
    if (cache && now() - cache.at < ttlMs) return { status: 200, body: cache.body };
    if (failedAt !== null && now() - failedAt < failTtlMs) return unavailable(); // OpenSea failed a moment ago: do not hammer it with the key
    inflight ??= (async () => {
      const r = await fetchImpl(`https://api.opensea.io/api/v2/collections/${slug}/stats`, { headers: { "x-api-key": apiKey, accept: "application/json" }, signal: AbortSignal.timeout(8000), redirect: "error" });
      if (!r.ok) throw new Error(`OpenSea ${r.status}`);
      return { ...pickStats(await r.json()), source: "opensea", updated: new Date(now()).toISOString() };
    })().finally(() => (inflight = null));
    try {
      const body = await inflight;
      cache = { at: now(), body };
      failedAt = null;
      return { status: 200, body };
    } catch (e) {
      failedAt = now();
      console.error("market stats:", redactSecrets(e.message, [apiKey])); // a failed fetch can quote the URL
      return unavailable();
    }
  }
  return { enabled, get };
}
