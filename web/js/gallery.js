import { loadConfig, renderChrome, agents, isDeployed, tokenMeta, ipfs, still, attr, esc } from "./chain.js";
import { NAMES } from "./traits-data.js";

await loadConfig();
renderChrome("gallery");

const grid = document.getElementById("grid");
const more = document.getElementById("more");
const $ = (id) => document.getElementById(id);
const PAGE = 24;

for (const [sel, list] of [["fClass", NAMES.class], ["fFaction", [...NAMES.faction, "Prime Constructs"]]]) {
  $(sel).insertAdjacentHTML("beforeend", list.map((n) => `<option>${n}</option>`).join(""));
}

let ids = [];
let shown = 0;
let rarity = null;

function tile(id, meta) {
  const legend = attr(meta, "1/1");
  const rank = rarity?.tokens?.[id - 1]?.rank;
  const [num, call = ""] = String(meta.name).split(" // ");
  return `<a class="tile${legend ? " legend" : ""}" href="agent.html?id=${Number(id)}">
    <img loading="lazy" decoding="async" src="${esc(ipfs(still(meta.image)))}" alt="${esc(meta.name)}">
    <div class="meta"><b>${esc(num)}</b>${esc(call)}
    <div class="muted small">${esc(attr(meta, "Class") ?? "Dormant")}${rank ? ` · #${Number(rank)} rarity` : ""}</div></div></a>`;
}

// an unreachable RPC is expected now and then: a calm message and a Retry button, never an uncaught error
function offline(retry) {
  console.warn("Ethereum RPC unreachable");
  more.style.display = "none";
  grid.innerHTML = `<div class="empty">Can't reach Ethereum right now. Try again in a moment.<div style="margin-top:14px"><button class="btn sm" type="button">Retry</button></div></div>`;
  grid.querySelector("button").onclick = retry;
}

async function renderNext() {
  const start = shown;
  const batch = ids.slice(shown, shown + PAGE);
  shown += batch.length;
  const metas = await Promise.all(batch.map((id) => tokenMeta(id).catch(() => null)));
  if (batch.length && metas.every((m) => !m)) {
    shown = start; // nothing could be read: the chain is out of reach, not 24 broken agents
    throw new Error("rpc");
  }
  const fc = $("fClass").value;
  const ff = $("fFaction").value;
  grid.insertAdjacentHTML(
    "beforeend",
    batch
      .map((id, i) => [id, metas[i]])
      .filter(([, m]) => m && (!fc || attr(m, "Class") === fc) && (!ff || attr(m, "Faction") === ff))
      .map(([id, m]) => tile(id, m))
      .join("")
  );
  more.style.display = shown < ids.length ? "" : "none";
  if (!grid.children.length && shown >= ids.length) grid.innerHTML = `<div class="empty">No agents match the filters.</div>`;
}

async function reset() {
  try {
    await load();
  } catch {
    offline(reset);
  }
}

async function load() {
  grid.innerHTML = "";
  shown = 0;
  const raw = $("q").value.trim();
  const q = Number(raw.match(/\d+/)?.[0]); // accepts 42, #42, AX-0042
  const supply = Number(await (await agents()).totalSupply());
  ids = Array.from({ length: supply }, (_, i) => i + 1);
  if (raw && !q) {
    grid.innerHTML = `<div class="empty">Search by agent number, for example 42 or AX-0042.</div>`;
    more.style.display = "none";
    return;
  }
  if (q) ids = ids.filter((i) => i === q);
  if ($("sort").value === "rank" && rarity) ids.sort((a, b) => (rarity.tokens[a - 1]?.rank ?? 1e9) - (rarity.tokens[b - 1]?.rank ?? 1e9));
  const fc = $("fClass").value, ff = $("fFaction").value;
  if (fc || ff) {
    // The published traits (data/rarity.json, the same file the Market reads) say which agents can match, so only those
    // are read from the chain, a page at a time; the on-chain traits still decide what is shown (renderNext checks them).
    // Without that file, or if its seed is not the chain seed, or it does not cover every minted agent, every agent is read, as before.
    const trusted = rarity?.tokens?.length >= supply && String(await (await agents()).seed().catch(() => "")).toLowerCase() === String(rarity.seed).toLowerCase(); // the file describes this collection
    if (trusted) ids = ids.filter((i) => { const t = rarity.tokens[i - 1]; return t && (!fc || t.Class === fc) && (!ff || t.Faction === ff); });
    else {
      while (shown < ids.length) await renderNext();
      if (!supply) grid.innerHTML = `<div class="empty">No agents minted yet. Minting happens on OpenSea only.</div>`;
      return;
    }
    if (!ids.length) {
      grid.innerHTML = `<div class="empty">No agents match the filters.</div>`;
      more.style.display = "none";
      return;
    }
  }
  await renderNext();
  if (!supply) grid.innerHTML = `<div class="empty">No agents minted yet. Minting happens on OpenSea only.</div>`;
}

if (!isDeployed()) {
  grid.innerHTML = `<div class="empty">No agents minted yet. Minting happens on OpenSea only.</div>`;
  more.style.display = "none";
} else {
  rarity = await fetch("data/rarity.json").then((r) => (r.ok ? r.json() : null)).catch(() => null);
  more.onclick = () => renderNext().catch(() => offline(reset));
  for (const id of ["q", "fClass", "fFaction", "sort"]) $(id).addEventListener("change", reset);
  reset();
}
