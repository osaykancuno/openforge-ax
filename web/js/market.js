// Market page: the collection in numbers. Everything is read from Ethereum (Transfer logs, Seaport OrderFulfilled
// events in the same transactions, SeaDrop's public drop, the contract's royalty) except the floor price, which only
// OpenSea knows: this site's verifier relays it at /market when it has an OpenSea API key.
import { CONFIG } from "./config.js";
import { loadConfig, renderChrome, agents, reader, eth, isDeployed, esc, short } from "./chain.js";
import { TRAITS } from "./traits-data.js";
import {
  ORDER_FULFILLED, ORDER_FULFILLED_ABI, WETH, salePrice, kindOf, holdersFrom, holderStats, salesStats, traitRows, rarest, formatEth, ago,
} from "./market/market-data.js";

await loadConfig();
renderChrome("market");

const $ = (id) => document.getElementById(id);
const SCAN_MAX = 150; // newest non-mint transfers whose transactions are checked for a Seaport sale
const ROWS = 25;
const set = (id, text, note) => {
  $(id).textContent = text;
  if (note !== undefined) $(`${id}Note`).textContent = note;
};
const eth$ = (wei) => `${formatEth(wei)} ETH`;
const explorer = /^https:\/\//.test(CONFIG.explorer) ? CONFIG.explorer.replace(/\/$/, "") : "";
const txLink = (hash, text) => (explorer ? `<a href="${esc(explorer)}/tx/${esc(hash)}" target="_blank" rel="noopener">${text}<span class="sr-only"> (opens in a new tab)</span></a>` : text);
const agentLink = (id) => `<a href="agent.html?id=${Number(id)}">AX-${String(Number(id)).padStart(4, "0")}</a>`;

$("mkNet").textContent = CONFIG.chainName || "Ethereum";
$("mkBuy").href = CONFIG.openseaDropUrl;

// ---------------------------------------------------------------- rarity (no chain needed: the revealed collection's file, else the target shares)
const rarity = await fetch("data/rarity.json").then((r) => (r.ok ? r.json() : null)).catch(() => null);
function renderRarity() {
  let rows = traitRows(rarity, "Class");
  if (rows.length) $("rarNote").textContent = `Share of each robot class among the ${rarity.supply} revealed agents.`;
  else {
    rows = (TRAITS.Class ?? []).map(([v, pct]) => [v, null, parseFloat(pct) / 100]).sort((a, b) => b[2] - a[2]);
    $("rarNote").textContent = "Target share of each robot class. Real counts appear after the reveal.";
  }
  const max = Math.max(...rows.map((r) => r[2]), 0.01);
  $("classBars").innerHTML = rows
    .map(([v, n, share]) => `<li><span class="mk-bar-label">${esc(v)}</span><span class="mk-bar" aria-hidden="true"><i style="width:${((share / max) * 100).toFixed(1)}%"></i></span><span class="mk-bar-v">${(share * 100).toFixed(share < 0.1 ? 1 : 0)}%${n != null ? ` · ${n}` : ""}</span></li>`)
    .join("");
  const top = rarest(rarity, 10);
  $("rarest").innerHTML = top.length
    ? top.map((t) => `<li><span class="mk-rank">#${Number(t.rank)}</span> ${agentLink(t.id)} <span class="muted">${esc(String(t.name).split(" // ")[1] ?? "")} · ${esc(t.Class)}${t["1/1"] ? " · 1/1" : ""}</span></li>`).join("")
    : `<li class="muted small">Ranks appear after the reveal: traits come from a public random draw once the sale ends.</li>`;
}
renderRarity();

// ---------------------------------------------------------------- floor price (OpenSea, through this site's server)
async function loadFloor() {
  if (!CONFIG.provingApi) return set("kFloor", "—", "on OpenSea");
  try {
    const r = await fetch(`${CONFIG.provingApi.replace(/\/$/, "")}/market`, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) throw new Error(String(r.status));
    const m = await r.json();
    if (m.floor == null) return set("kFloor", "No listings", "OpenSea");
    set("kFloor", `${m.floor} ${m.floorSymbol || "ETH"}`, m.stale ? "OpenSea · a few minutes old" : "OpenSea · lowest listing");
  } catch {
    set("kFloor", "—", "see OpenSea"); // no key on the server, or the server is offline: the link is right above
  }
}

// ---------------------------------------------------------------- chain reads
/** queryFilter over a block range; public RPCs cap the range, so a refused range is split in two until it fits. */
async function logs(contract, filter, from, to) {
  try {
    return await contract.queryFilter(filter, from, to);
  } catch (e) {
    if (to - from < 2000) throw e;
    const mid = from + Math.floor((to - from) / 2);
    return [...(await logs(contract, filter, from, mid)), ...(await logs(contract, filter, mid + 1, to))];
  }
}

async function loadMint(c, minted, max) {
  try {
    const sd = new (await eth()).Contract(CONFIG.seaDrop, ["function getPublicDrop(address) view returns ((uint80 mintPrice, uint48 startTime, uint48 endTime, uint16 maxTotalMintableByWallet, uint16 feeBps, bool restrictFeeRecipients))"], await reader());
    const [d, now] = await Promise.all([sd.getPublicDrop(CONFIG.agents), reader().then((p) => p.getBlock("latest")).then((b) => b.timestamp)]);
    const [start, end] = [Number(d.startTime), Number(d.endTime)];
    const price = `${eth$(d.mintPrice)} · max ${Number(d.maxTotalMintableByWallet)} per wallet`;
    if (minted >= max) return mintState("Sold out", price, false);
    if (!start || now > end) return mintState("Closed", price, false);
    if (now < start) return mintState("Opens soon", `${new Date(start * 1000).toISOString().slice(0, 16).replace("T", " ")} UTC · ${eth$(d.mintPrice)}`, true);
    return mintState("Open", price, true);
  } catch {
    mintState("—", "on OpenSea", false);
  }
}
function mintState(state, note, open) {
  set("kMint", state, note);
  $("mkBuy").firstChild.textContent = open ? "Mint on OpenSea" : "Buy on OpenSea";
}

let rows = []; // { kind, id, from, to, hash, block, logIndex, price, timestamp }
let filter = "sale";
function renderActivity() {
  const list = rows.filter((r) => filter === "all" || r.kind === "sale").slice(0, ROWS);
  if (!list.length) {
    $("activity").innerHTML = `<p class="muted small">${filter === "sale" ? "No secondary sales yet. When agents change hands on OpenSea, each sale shows here with its price." : "No transfers yet."}</p>`;
    return;
  }
  const now = Math.floor(Date.now() / 1000);
  $("activity").innerHTML = `<table class="mk-table"><thead><tr><th scope="col">Agent</th><th scope="col">Event</th><th scope="col" class="num">Price</th><th scope="col">From → to</th><th scope="col">When</th></tr></thead><tbody>${list
    .map((r) => `<tr><td>${agentLink(r.id)}</td><td><span class="mk-kind k-${r.kind}">${r.kind}</span></td><td class="num">${r.price != null ? esc(eth$(r.price)) : "—"}</td><td class="mono">${r.kind === "mint" ? "mint" : esc(short(r.from))} → ${esc(short(r.to))}</td><td>${txLink(r.hash, esc(r.timestamp ? ago(r.timestamp, now) : `block ${r.block}`))}</td></tr>`)
    .join("")}</tbody></table>`;
}
document.querySelectorAll(".mk-filter [data-f]").forEach((b) =>
  b.addEventListener("click", () => {
    filter = b.dataset.f;
    document.querySelectorAll(".mk-filter [data-f]").forEach((x) => (x.classList.toggle("sel", x === b), x.setAttribute("aria-pressed", String(x === b))));
    renderActivity();
  })
);

function renderHolders(st) {
  set("kHolders", st.holders.toLocaleString("en-US"), `${Math.round(st.unique * 100)}% unique owners`);
  const total = st.holders || 1;
  $("buckets").innerHTML = [["1 agent", st.buckets.one], ["2–3 agents", st.buckets.few], ["4 or more", st.buckets.many]]
    .map(([k, n]) => `<li><b>${n}</b><span>${k}</span><small>${Math.round((n / total) * 100)}%</small></li>`)
    .join("");
  $("topHolders").innerHTML = st.top.length ? st.top.map(([a, n]) => `<li><span class="mono">${esc(short(a))}</span> <span class="muted">${n} agent${n > 1 ? "s" : ""}</span></li>`).join("") : `<li class="muted small">No holders yet.</li>`;
}

async function loadChain() {
  const c = await agents();
  const p = await reader();
  const [minted, max, royaltyBps, latest] = await Promise.all([c.totalSupply().then(Number), c.maxSupply().then(Number), c.royaltyBasisPoints().then(Number).catch(() => null), p.getBlockNumber()]);
  set("kMinted", `${minted.toLocaleString("en-US")} / ${max.toLocaleString("en-US")}`, royaltyBps != null ? `royalty ${royaltyBps / 100}% on resales` : "");
  loadMint(c, minted, max);

  const transfers = (await logs(c, c.filters.Transfer(), CONFIG.fromBlock || 0, latest)).map((l) => ({
    kind: null, id: Number(l.args.tokenId), from: l.args.from, to: l.args.to, hash: l.transactionHash, block: l.blockNumber, logIndex: l.index ?? l.logIndex, price: null, timestamp: 0,
  }));
  for (const t of transfers) t.kind = kindOf(t);
  renderHolders(holderStats(holdersFrom(transfers.map((t) => ({ ...t, blockNumber: t.block, tokenId: t.id }))), minted));

  // sales: the newest transfers' transactions, checked for a Seaport order that moved that agent
  rows = transfers.sort((a, b) => b.block - a.block || b.logIndex - a.logIndex);
  const candidates = rows.filter((r) => r.kind === "transfer").slice(0, SCAN_MAX);
  const iface = new (await eth()).Interface([ORDER_FULFILLED_ABI]);
  const weth = WETH[CONFIG.chainId] ?? "";
  const receipts = new Map();
  for (let i = 0; i < candidates.length; i += 10) {
    const hashes = [...new Set(candidates.slice(i, i + 10).map((r) => r.hash))].filter((h) => !receipts.has(h));
    (await Promise.all(hashes.map((h) => p.getTransactionReceipt(h).catch(() => null)))).forEach((rc, k) => receipts.set(hashes[k], rc));
  }
  for (const r of candidates) {
    const orders = (receipts.get(r.hash)?.logs ?? []).filter((l) => l.topics[0] === ORDER_FULFILLED).map((l) => iface.parseLog(l)?.args).filter(Boolean);
    for (const o of orders) {
      const price = salePrice(o, CONFIG.agents, r.id, weth);
      if (price != null) (r.kind = "sale"), (r.price = price);
    }
  }
  // timestamps for what is shown and for the 1-day / 7-day windows
  const sales = rows.filter((r) => r.kind === "sale");
  const blocks = [...new Set([...sales, ...rows.slice(0, ROWS)].map((r) => r.block))];
  const times = new Map((await Promise.all(blocks.map((b) => p.getBlock(b).catch(() => null)))).filter(Boolean).map((b) => [b.number, b.timestamp]));
  for (const r of rows) r.timestamp = times.get(r.block) ?? 0;

  const now = (await p.getBlock("latest"))?.timestamp ?? Math.floor(Date.now() / 1000);
  const s = salesStats(sales, now);
  const capped = rows.filter((r) => r.kind === "transfer" || r.kind === "sale").length > SCAN_MAX;
  set("kLast", s.last ? eth$(s.last.price) : "—", s.last ? `AX-${String(s.last.id).padStart(4, "0")} · ${ago(s.last.timestamp, now)}` : "no sales yet");
  set("kWeek", eth$(s.week.volume), `${s.week.count} sale${s.week.count === 1 ? "" : "s"} · ${s.day.count} today`);
  set("kTotal", eth$(s.volume), `${s.count} sale${s.count === 1 ? "" : "s"}${capped ? ` in the latest ${SCAN_MAX} transfers` : ""}`);
  set("kAvg", s.count ? eth$(s.average) : "—", s.highest ? `highest ${eth$(s.highest.price)}` : "—");
  $("actNote").textContent = `${rows.length.toLocaleString("en-US")} transfers since the deploy · prices from Seaport orders${capped ? ` (latest ${SCAN_MAX} transfers checked)` : ""}`;
  renderActivity();
}

function offline() {
  $("activity").innerHTML = `<div class="empty">Can't reach Ethereum right now. Try again in a moment.<div style="margin-top:14px"><button class="btn sm" type="button">Retry</button></div></div>`;
  $("activity").querySelector("button").onclick = start;
}
async function start() {
  $("kpis").setAttribute("aria-busy", "true");
  loadFloor();
  if (!isDeployed()) {
    $("activity").innerHTML = `<p class="muted small">The collection is not deployed yet. Sales, holders and the mint state appear here once it is live.</p>`;
    set("kMint", "Soon", "on OpenSea");
    $("kpis").setAttribute("aria-busy", "false");
    return;
  }
  try {
    await loadChain();
  } catch (e) {
    console.warn("Ethereum RPC unreachable", e?.shortMessage || e?.message);
    offline();
  }
  $("kpis").setAttribute("aria-busy", "false");
}
start();
