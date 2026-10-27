import { CONFIG } from "./config.js";
import { loadConfig, renderChrome, connect, onWallet, ownedBy, tokenMeta, ipfs, attr, isDeployed, esc } from "./chain.js";

await loadConfig();
renderChrome("mine");

const state = document.getElementById("state");
const grid = document.getElementById("grid");
document.getElementById("connectHere").onclick = () => connect();

async function show(s) {
  if (!isDeployed()) {
    state.innerHTML = "<p>Agents aren't minted yet. You can use the lab now.</p>";
    return;
  }
  state.style.display = "";
  state.innerHTML = "<p>Looking for your agents on the blockchain…</p>";
  let ids, metas;
  try {
    ids = await ownedBy(s.addressChecksum);
    if (ids.length) metas = await Promise.all(ids.map((id) => tokenMeta(id)));
  } catch {
    // an unreachable RPC is expected now and then: calm message, Retry, no uncaught error
    console.warn("Ethereum RPC unreachable");
    state.innerHTML = `<p>Can't reach Ethereum right now. Try again in a moment.</p><button class="btn sm" type="button">Retry</button>`;
    state.querySelector("button").onclick = () => show(s);
    return;
  }
  if (!ids.length) {
    state.innerHTML = `<p>This wallet has no agents yet. The lab works without one.</p><a class="btn primary magenta" href="${CONFIG.openseaDropUrl}" target="_blank" rel="noopener">Mint on OpenSea</a>`;
    return;
  }
  state.style.display = "none";
  grid.innerHTML = ids
    .map(
      (id, i) => `<a class="tile${attr(metas[i], "1/1") ? " legend" : ""}" href="agent.html?id=${id}">
      <img loading="lazy" decoding="async" src="${esc(ipfs(metas[i].image))}" alt="${esc(metas[i].name)}">
      <div class="meta"><b>${esc(metas[i].name)}</b><div class="muted small">Mode: ${esc(attr(metas[i], "Autonomy") ?? "Manual")} · Manage →</div></div></a>`
    )
    .join("");
}

if (!isDeployed()) state.innerHTML = "<p>Agents aren't minted yet. You can use the lab now.</p>"; // no deployment: say so at once, the RPC is never asked
onWallet((s) => s && show(s));
