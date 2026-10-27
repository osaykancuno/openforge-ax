import { loadConfig, renderChrome, agents, isDeployed, tokenMeta, ipfs, attr, esc } from "./chain.js";
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
    <img loading="lazy" src="${esc(ipfs(meta.image))}" alt="${esc(meta.name)}">
    <div class="meta"><b>${esc(num)}</b>${esc(call)}
    <div class="muted small">${esc(attr(meta, "Class") ?? "Dormant")}${rank ? ` · #${Number(rank)} rarity` : ""}</div></div></a>`;
}

async function renderNext() {
  const batch = ids.slice(shown, shown + PAGE);
  shown += batch.length;
  const metas = await Promise.all(batch.map((id) => tokenMeta(id).catch(() => null)));
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
  grid.innerHTML = "";
  shown = 0;
  const raw = $("q").value.trim();
  const q = Number(raw.match(/\d+/)?.[0]); // accepts 42, #42, AX-0042
  const supply = Number(await agents().totalSupply());
  ids = Array.from({ length: supply }, (_, i) => i + 1);
  if (raw && !q) {
    grid.innerHTML = `<div class="empty">Search by agent number, for example 42 or AX-0042.</div>`;
    more.style.display = "none";
    return;
  }
  if (q) ids = ids.filter((i) => i === q);
  if ($("sort").value === "rank" && rarity) ids.sort((a, b) => (rarity.tokens[a - 1]?.rank ?? 1e9) - (rarity.tokens[b - 1]?.rank ?? 1e9));
  // With filters active, load everything; otherwise paginate
  if ($("fClass").value || $("fFaction").value) {
    while (shown < ids.length) await renderNext();
  } else await renderNext();
  if (!supply) grid.innerHTML = `<div class="empty">No agents minted yet. Minting happens on OpenSea.</div>`;
}

if (!isDeployed()) {
  grid.innerHTML = `<div class="empty">The collection has not been published yet.</div>`;
  more.style.display = "none";
} else {
  rarity = await fetch("data/rarity.json").then((r) => (r.ok ? r.json() : null)).catch(() => null);
  more.onclick = renderNext;
  for (const id of ["q", "fClass", "fFaction", "sort"]) $(id).addEventListener("change", reset);
  reset();
}
