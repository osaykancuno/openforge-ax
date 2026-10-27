import { CONFIG } from "./config.js";
import { loadConfig, renderChrome, connect, onWallet, ownedBy, tokenMeta, ipfs, attr, isDeployed, esc } from "./chain.js";

await loadConfig();
renderChrome("mine");

const state = document.getElementById("state");
const grid = document.getElementById("grid");
document.getElementById("connectHere").onclick = () => connect();

onWallet(async (s) => {
  if (!s) return;
  if (!isDeployed()) {
    state.innerHTML = "<p>The collection has not been published yet.</p>";
    return;
  }
  state.innerHTML = "<p>Looking for your agents on the blockchain…</p>";
  const ids = await ownedBy(s.addressChecksum);
  if (!ids.length) {
    state.innerHTML = `<p>This wallet does not own any agents yet.</p><a class="btn primary magenta" href="${CONFIG.openseaDropUrl}" target="_blank" rel="noopener">Mint on OpenSea</a>`;
    return;
  }
  state.style.display = "none";
  const metas = await Promise.all(ids.map((id) => tokenMeta(id)));
  grid.innerHTML = ids
    .map(
      (id, i) => `<a class="tile${attr(metas[i], "1/1") ? " legend" : ""}" href="agent.html?id=${id}">
      <img src="${esc(ipfs(metas[i].image))}" alt="${esc(metas[i].name)}">
      <div class="meta"><b>${esc(metas[i].name)}</b><div class="muted small">Mode: ${esc(attr(metas[i], "Autonomy") ?? "Manual")} · Manage →</div></div></a>`
    )
    .join("");
});
