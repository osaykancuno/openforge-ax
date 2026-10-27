// Market page maths, with no I/O: shared by the browser (js/market.js) and the tests.
// Prices come from the chain itself: a sale is a transfer of an agent inside a Seaport order (OrderFulfilled),
// priced from what the buyer paid in ETH or WETH. Nothing here is a valuation or a prediction.

/** topic0 of Seaport's OrderFulfilled(bytes32,address,address,address,SpentItem[],ReceivedItem[]) (Seaport 1.1 to 1.6). */
export const ORDER_FULFILLED = "0x9d9af8e38d66c62e2c12f0225249fd9d721c54b83f48d9352c97c6cacdcb6f31";
export const ORDER_FULFILLED_ABI =
  "event OrderFulfilled(bytes32 orderHash, address indexed offerer, address indexed zone, address recipient, (uint8 itemType, address token, uint256 identifier, uint256 amount)[] offer, (uint8 itemType, address token, uint256 identifier, uint256 amount, address recipient)[] consideration)";
/** Wrapped ether, counted as ETH in prices (offers on OpenSea are paid in WETH). */
export const WETH = { 1: "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2", 11155111: "0xfff9976782d46cc05630d1f6ebab18b2324d6b14" };
export const ZERO = "0x0000000000000000000000000000000000000000";

const ITEM = { NATIVE: 0, ERC20: 1, ERC721: 2, ERC721_WITH_CRITERIA: 4 };
const same = (a, b) => String(a ?? "").toLowerCase() === String(b ?? "").toLowerCase();
const sum = (items) => items.reduce((t, i) => t + BigInt(i.amount), 0n);

/**
 * What one decoded OrderFulfilled paid for agent `tokenId`, in wei, or null when the order is not about it.
 * A bought listing has the agent in the offer and the price in the consideration (seller, royalty and fee shares);
 * an accepted offer has the agent in the consideration and the price (WETH) in the offer.
 */
export function salePrice(order, nft, tokenId, weth = "") {
  const isAgent = (i) => (Number(i.itemType) === ITEM.ERC721 || Number(i.itemType) === ITEM.ERC721_WITH_CRITERIA) && same(i.token, nft) && BigInt(i.identifier) === BigInt(tokenId);
  const isMoney = (i) => Number(i.itemType) === ITEM.NATIVE || (Number(i.itemType) === ITEM.ERC20 && weth && same(i.token, weth));
  const offer = [...(order?.offer ?? [])], consideration = [...(order?.consideration ?? [])];
  if (offer.some(isAgent)) return sum(consideration.filter(isMoney));
  if (consideration.some(isAgent)) return sum(offer.filter(isMoney));
  return null;
}

/** "mint", "burn" or "transfer", from a Transfer log's addresses. */
export const kindOf = (t) => (same(t.from, ZERO) ? "mint" : same(t.to, ZERO) ? "burn" : "transfer");

/** Current holders out of every Transfer since the deploy, replayed in chain order. */
export function holdersFrom(transfers) {
  const owner = new Map(); // tokenId -> address
  const ordered = [...transfers].sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex);
  for (const t of ordered) owner.set(String(t.tokenId), String(t.to).toLowerCase());
  const counts = new Map();
  for (const a of owner.values()) if (!same(a, ZERO)) counts.set(a, (counts.get(a) ?? 0) + 1);
  return counts;
}

/** Holder figures for the page: how many, how spread out, and the biggest wallets. */
export function holderStats(counts, supply) {
  const list = [...counts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  const buckets = { one: 0, few: 0, many: 0 }; // 1 agent, 2-3, 4 or more
  for (const [, n] of list) buckets[n === 1 ? "one" : n <= 3 ? "few" : "many"]++;
  const holders = list.length;
  return { holders, unique: supply ? holders / supply : 0, buckets, top: list.slice(0, 5) };
}

/** Sales figures: count, volume, average, last and highest sale, over all time and the last day and week. */
export function salesStats(sales, nowSec) {
  const window = (sec) => {
    const s = sales.filter((x) => x.timestamp >= nowSec - sec);
    return { count: s.length, volume: sum(s.map((x) => ({ amount: x.price }))) };
  };
  const all = { count: sales.length, volume: sum(sales.map((x) => ({ amount: x.price }))) };
  const byTime = [...sales].sort((a, b) => b.timestamp - a.timestamp || b.logIndex - a.logIndex);
  return {
    ...all,
    average: all.count ? all.volume / BigInt(all.count) : 0n,
    last: byTime[0] ?? null,
    highest: sales.reduce((h, x) => (!h || x.price > h.price ? x : h), null),
    day: window(86_400),
    week: window(7 * 86_400),
  };
}

/** Rows of [value, count, share 0..1] for one trait, most common first, from the revealed collection's rarity file. */
export function traitRows(rarity, trait) {
  const d = rarity?.distribution?.[trait];
  if (!d) return [];
  const total = Object.values(d).reduce((t, n) => t + n, 0) || 1;
  return Object.entries(d).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([v, n]) => [v, n, n / total]);
}

/** The `n` rarest agents by rank (1 = rarest). */
export const rarest = (rarity, n = 10) => [...(rarity?.tokens ?? [])].filter((t) => Number.isInteger(t.rank)).sort((a, b) => a.rank - b.rank).slice(0, n);

/** Wei to a short ETH string: 0.0215, 1.2, 12.4; never scientific notation. */
export function formatEth(wei, digits = 4) {
  const w = BigInt(wei ?? 0);
  const neg = w < 0n, a = neg ? -w : w;
  const whole = a / 10n ** 18n, frac = a % 10n ** 18n;
  const d = whole >= 10n ? Math.min(digits, 2) : digits;
  let f = (frac + 10n ** 18n).toString().slice(1, 1 + d).replace(/0+$/, ""); // truncated, not rounded up
  if (whole === 0n && !f && a > 0n) return "< 0." + "0".repeat(d - 1) + "1";
  return `${neg ? "-" : ""}${whole}${f ? "." + f : ""}`;
}

/** "3 min ago", "5 h ago", "2 d ago", or a date for anything older than 30 days. */
export function ago(sec, nowSec) {
  const d = Math.max(0, nowSec - sec);
  if (d < 90) return "just now";
  if (d < 3600) return `${Math.round(d / 60)} min ago`;
  if (d < 86_400) return `${Math.round(d / 3600)} h ago`;
  if (d < 30 * 86_400) return `${Math.round(d / 86_400)} d ago`;
  return new Date(sec * 1000).toISOString().slice(0, 10);
}

/** The OpenSea collection slug out of a collection link, or "" ("https://opensea.io/collection/<slug>/overview"). */
export const slugOf = (url) => /^https:\/\/(?:testnets\.)?opensea\.io\/collection\/([a-z0-9-]{1,80})(?:[/?#]|$)/.exec(String(url ?? ""))?.[1] ?? "";
