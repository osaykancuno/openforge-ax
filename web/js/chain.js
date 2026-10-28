import { themeButton } from "./theme.js";
import { soundsDom, musicDom, lazyAudio } from "./audio-buttons.js"; // the audio code itself (ui-sounds.js, ambient.js) loads on the first gesture
import { CONFIG } from "./config.js";
import { SERVERS_KEY, applyServers, validServerUrl } from "./servers.js";

// ethers is ~270 KB: loaded on first use, so pages that only show the chrome (home, bench, codex...) never fetch it
let E;
export const eth = () => (E ??= import("../vendor/ethers.min.js"));

export const ABI = {
  agents: [
    "function totalSupply() view returns (uint256)",
    "function maxSupply() view returns (uint256)",
    "function MAX_SUPPLY_CAP() view returns (uint256)",
    "function TEAM_RESERVE() view returns (uint256)",
    "function reserveMinted() view returns (uint256)",
    "function seed() view returns (bytes32)",
    "function revealBlock() view returns (uint64)",
    "function revealDeadline() view returns (uint64)",
    "function ownerOf(uint256) view returns (address)",
    "function balanceOf(address) view returns (uint256)",
    "function tokenURI(uint256) view returns (string)",
    "function accountOf(uint256) view returns (address)",
    "function royaltyBasisPoints() view returns (uint256)",
    "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)",
  ],
  account: [
    "function autonomyLevel() view returns (uint8)",
    "function operator() view returns (address)",
    "function paused() view returns (bool)",
    "function lockedUntil() view returns (uint64)",
    "function lockOwner() view returns (address)",
    "function owner() view returns (address)",
    "function periodLimit() view returns (uint128)",
    "function spentInPeriod() view returns (uint128)",
    "function proposalCount() view returns (uint256)",
    "function proposalAt(uint256) view returns (address to, uint256 value, bytes data, bool done, bool valid)",
    "function configure(address operator, uint8 level, uint128 limit, uint64 periodLen)",
    "function setPaused(bool)",
    "function lock(uint64 until)",
    "function revokeOperator()",
    "function approve(uint256 id)",
    "function reject(uint256 id)",
    "function execute(address to, uint256 value, bytes data, uint8 operation) payable returns (bytes)",
  ],
  reputation: [
    "function statsOf(uint256) view returns (uint32 tasks, uint32 successes, uint32 failures, uint64 dataPoints)",
    "function tierOf(uint256) view returns (uint8)",
  ],
};

// ---------------------------------------------------------------- deployment override
let ready;
export function loadConfig() {
  // same URL and credentials as the <link rel="preload" as="fetch" crossorigin href="deployment.json"> that scripts/build-web.mjs puts in each page, so the browser reuses that download
  ready ??= fetch(new URL("../deployment.json", import.meta.url), { credentials: "same-origin" })
    .then((r) => (r.ok ? r.json() : {}))
    .catch(() => ({}))
    .then((d) => Object.assign(CONFIG, applyServers({ ...CONFIG, ...pickDeployment(d) }, storedServers())));
  return ready;
}

// only known keys, of the right kind, are taken from deployment.json (no __proto__, no javascript: links)
const DEPLOYMENT_KEYS = ["chainId", "chainName", "rpcUrl", "provingApi", "worldWs", "explorer", "openseaDropUrl", "ipfsGateway", "agents", "renderer", "reputation", "defaultOperator", "seaDrop", "fromBlock"];
const isLink = (v) => typeof v === "string" && (/^https:\/\//.test(v) || /^(#|\.\/|\/)/.test(v) || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/.test(v)) && !/["'<>\s]/.test(v);
function pickDeployment(d) {
  const out = {};
  if (!d || typeof d !== "object") return out;
  for (const k of DEPLOYMENT_KEYS) {
    if (!Object.hasOwn(d, k)) continue;
    const v = d[k];
    if (k === "chainId" || k === "fromBlock") Number.isSafeInteger(v) && v >= 0 && (out[k] = v);
    else if (["agents", "renderer", "reputation", "defaultOperator", "seaDrop"].includes(k)) (v === "" || /^0x[0-9a-fA-F]{40}$/.test(v)) && (out[k] = v);
    else if (k === "chainName") typeof v === "string" && v.length < 60 && (out[k] = v);
    else if (k === "provingApi" || k === "worldWs") (v === "" || (typeof v === "string" && /^(https|wss|http|ws):\/\/[^"'<>\s]+$/.test(v))) && (out[k] = v);
    else if (isLink(v)) out[k] = v;
  }
  return out;
}

// ---------------------------------------------------------------- connectors (self-hosted servers)
function storedServers() {
  try {
    return JSON.parse(localStorage.getItem(SERVERS_KEY)) || {};
  } catch {
    return {};
  }
}

function serversDialog() {
  const d = document.createElement("dialog");
  d.className = "servers";
  d.innerHTML = `<form method="dialog">
    <h3>Your servers</h3>
    <p class="muted small">Running OpenForge AX yourself (<code>npm run selfhost</code>)? Point this site at your Proving Grounds and Neo-Forge servers. Leave empty to use the published ones. Saved only in this browser.</p>
    <label>Proving Grounds <input type="text" name="proving" placeholder="https://proving.example.org or http://localhost:8787" autocomplete="off"></label>
    <label>Neo-Forge <input type="text" name="world" placeholder="wss://world.example.org or ws://localhost:8788" autocomplete="off"></label>
    <p class="small" role="status"></p>
    <div class="row"><button class="btn sm primary" value="save">Save</button><button class="btn sm" value="reset">Use published servers</button><button class="btn sm" value="cancel">Cancel</button></div>
  </form>`;
  const f = d.querySelector("form");
  const s = storedServers();
  f.proving.value = s.provingApi || "";
  f.world.value = s.worldWs || "";
  f.onsubmit = (e) => {
    const action = e.submitter?.value;
    if (action === "cancel") return;
    if (action === "reset") {
      try {
        localStorage.removeItem(SERVERS_KEY);
      } catch {}
      return location.reload();
    }
    const provingApi = f.proving.value.trim() ? validServerUrl("proving", f.proving.value) : "";
    const worldWs = f.world.value.trim() ? validServerUrl("world", f.world.value) : "";
    if (provingApi === null || worldWs === null) {
      e.preventDefault();
      d.querySelector("[role=status]").textContent = "Use https:// and wss:// (http:// and ws:// only for localhost), with no user, query or #.";
      return;
    }
    try {
      localStorage.setItem(SERVERS_KEY, JSON.stringify({ provingApi, worldWs }));
    } catch {}
    location.reload();
  };
  document.body.append(d);
  return d;
}

// ---------------------------------------------------------------- provider
let readProvider;
export async function reader() {
  const { JsonRpcProvider } = await eth();
  readProvider ??= new JsonRpcProvider(CONFIG.rpcUrl, CONFIG.chainId, { staticNetwork: true });
  return readProvider;
}

// async: the first call loads ethers; every helper resolves to a Contract
export const agents = async (runner) => new (await eth()).Contract(CONFIG.agents, ABI.agents, runner ?? (await reader()));
export const account = async (addr, runner) => new (await eth()).Contract(addr, ABI.account, runner ?? (await reader()));
export const reputation = async (runner) => new (await eth()).Contract(CONFIG.reputation, ABI.reputation, runner ?? (await reader()));
export const isDeployed = () => CONFIG.agents && !/^0x0{40}$/i.test(CONFIG.agents);

// ---------------------------------------------------------------- wallet
let signer = null;
const listeners = new Set();
export const onWallet = (fn) => (listeners.add(fn), fn(signer));
export const currentSigner = () => signer;

/** A phone or tablet (iPadOS says Mac): browsers there take no wallet extensions. */
const onPhone = () => /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) || (/Macintosh/i.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
/** MetaMask's own link: the app opens this same page in its built-in browser, where the wallet is (Android and iPhone). */
export const metamaskLink = (loc = location) => `https://metamask.app.link/dapp/${loc.host}${loc.pathname}${loc.search}`;

export async function connect() {
  if (!window.ethereum) {
    if (onPhone() && location.protocol === "https:") {
      toast("Opening this page in the MetaMask app (free): connect from there. No app yet? The link leads to its store page.");
      location.href = metamaskLink();
      return null;
    }
    toast("No wallet found. Install MetaMask or Rabby (see the home page FAQ): it takes 2 minutes.", true);
    return null;
  }
  const { BrowserProvider, getAddress } = await eth();
  const bp = new BrowserProvider(window.ethereum);
  try {
    await bp.send("eth_requestAccounts", []);
  } catch (e) {
    toast(friendlyError(e), true);
    return null;
  }
  const net = await bp.getNetwork();
  if (Number(net.chainId) !== CONFIG.chainId) {
    try {
      await bp.send("wallet_switchEthereumChain", [{ chainId: "0x" + CONFIG.chainId.toString(16) }]);
    } catch {
      toast(`In your wallet, switch to the ${CONFIG.chainName} network and try again.`, true);
      return null;
    }
  }
  signer = await new BrowserProvider(window.ethereum).getSigner();
  signer.addressChecksum = getAddress(await signer.getAddress());
  localStorageSafe("set", "ofx-connected", "1");
  listeners.forEach((fn) => fn(signer));
  return signer;
}

export async function autoReconnect() {
  if (!window.ethereum || localStorageSafe("get", "ofx-connected") !== "1") return;
  const accs = await window.ethereum.request({ method: "eth_accounts" }).catch(() => []);
  if (accs.length) await connect().catch(() => {});
}

// Pages where a visitor signs something (the agent pages, the Proving Grounds, Neo-Forge) get their wallet back at
// load, which means loading ethers (160 KB gz). Every other page only shows the remembered address in the nav, read
// from the wallet without ethers, and loads ethers when the visitor clicks Connect.
export const WALLET_PAGES = ["mine", "arena", "world"];
export const walletByDefault = (active) => WALLET_PAGES.includes(active);

/** The address of a wallet the visitor already connected here, as the nav shows it, or "" (no ethers; not checksummed). */
export async function rememberedAddress() {
  if (!window.ethereum || localStorageSafe("get", "ofx-connected") !== "1") return "";
  const accs = await window.ethereum.request({ method: "eth_accounts" }).catch(() => []);
  return /^0x[0-9a-fA-F]{40}$/.test(accs?.[0]) ? short(accs[0]) : "";
}

if (window.ethereum?.on) {
  window.ethereum.on("accountsChanged", () => location.reload());
  window.ethereum.on("chainChanged", () => location.reload()); // a network switch must never leave the page signing for another chain
}

function localStorageSafe(op, k, v) {
  try {
    return op === "set" ? localStorage.setItem(k, v) : localStorage.getItem(k);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- transactions with plain-language messages
// One transaction at a time: buttons stay locked until the network confirms
export async function send(label, fn) {
  if (document.body.classList.contains("busy")) return false;
  document.body.classList.add("busy");
  try {
    // the wallet must still be on our network: the user may have switched since connecting
    if (signer && Number((await signer.provider.getNetwork()).chainId) !== CONFIG.chainId) throw new Error(`WRONG_NETWORK`);
    toast(`${label}: confirm in your wallet…`);
    const tx = await fn();
    toast(`${label}: transaction sent, waiting for network confirmation…`);
    await tx.wait();
    toast(`${label}: done ✔`);
    return true;
  } catch (e) {
    toast(friendlyError(e), true);
    return false;
  } finally {
    document.body.classList.remove("busy");
  }
}

export function friendlyError(e) {
  const m = `${e?.shortMessage || ""} ${e?.message || ""} ${e?.info?.error?.message || ""}`;
  if (/user rejected|denied|ACTION_REJECTED/i.test(m)) return "Cancelled in your wallet. No cost.";
  if (/WRONG_NETWORK/.test(m)) return `Your wallet is on another network: switch to ${CONFIG.chainName} and try again. Nothing was sent.`;
  if (/insufficient funds/i.test(m)) return "Not enough ETH to cover the network fee (gas).";
  if (/AccountLocked/.test(m)) return "The agent wallet is locked for sale: wait for the lock to expire.";
  if (/NotOwner|NotAuthorized/.test(m)) return "Only the agent's owner can do this.";
  if (/SpendLimitExceeded/.test(m)) return "The agent's daily spend limit has been reached.";
  return "Something went wrong: " + (e?.shortMessage || e?.message || "unknown error").slice(0, 160);
}

// ---------------------------------------------------------------- metadata
export function decodeTokenURI(uri) {
  if (uri.startsWith("data:application/json;base64,")) {
    const bin = atob(uri.slice(29));
    return JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0))));
  }
  throw new Error("Unsupported tokenURI");
}

/** HTML-escapes chain or server data before it goes into innerHTML (metadata is only as trusted as the renderer). */
export const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
export const ipfs = (u) =>
  u?.startsWith("ipfs://") ? CONFIG.ipfsGateway + u.slice(7) : /^(https:\/\/|https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/|assets\/|demo-images\/)/.test(u || "") ? u : "assets/placeholder.png"; // https only (plain http: the local demo)
/** A token's still: <id>.png sits next to the animated <id>.gif under the base URI (grids load the light one). */
export const still = (u) => String(u ?? "").replace(/(\/\d+)\.gif$/i, "$1.png");
export const attr = (meta, k) => meta?.attributes?.find((a) => a.trait_type === k)?.value;
export const short = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "");

const metaCache = new Map();
/** Find the wallet's tokens from Transfer events; if the RPC limits logs, scan ownerOf instead. */
export async function ownedBy(addr) {
  const c = await agents();
  try {
    const logs = await c.queryFilter(c.filters.Transfer(null, addr), CONFIG.fromBlock || 0);
    const candidates = [...new Set(logs.map((l) => Number(l.args.tokenId)))];
    const owners = await Promise.all(candidates.map((id) => c.ownerOf(id)));
    return candidates.filter((_, i) => owners[i].toLowerCase() === addr.toLowerCase()).sort((a, b) => a - b);
  } catch {
    const supply = Number(await c.totalSupply());
    const out = [];
    for (let s = 1; s <= supply; s += 50) {
      const ids = Array.from({ length: Math.min(50, supply - s + 1) }, (_, i) => s + i);
      const owners = await Promise.all(ids.map((id) => c.ownerOf(id)));
      ids.forEach((id, i) => owners[i].toLowerCase() === addr.toLowerCase() && out.push(id));
    }
    return out;
  }
}

export async function tokenMeta(id) {
  if (!metaCache.has(id)) {
    const p = agents().then((c) => c.tokenURI(id)).then(decodeTokenURI);
    metaCache.set(id, p);
    p.catch(() => metaCache.delete(id)); // a failed read (RPC down) must not stick: Retry has to ask again
  }
  return metaCache.get(id);
}

// ---------------------------------------------------------------- shared UI
function toastEl() {
  let el = document.getElementById("toast");
  if (!el) {
    el = document.createElement("div");
    el.id = "toast";
    el.setAttribute("role", "status");
    document.body.append(el);
  }
  return el;
}
if (typeof document !== "undefined") document.readyState === "loading" ? addEventListener("DOMContentLoaded", toastEl) : toastEl();

export function toast(msg, isErr = false) {
  const el = toastEl();
  el.setAttribute("role", isErr ? "alert" : "status");
  el.textContent = msg;
  el.className = isErr ? "err" : "";
  clearTimeout(el._t);
  el._t = setTimeout(() => (el.textContent = ""), isErr ? 9000 : 6000);
}

/**
 * The page chrome. There is no bar of sections: the 3D lab (index.html) is the only menu, one station per section.
 * Every other page gets "← Lab" (top left, back to the lab) and, top right, one ⚙ button that opens the sounds, music and
 * theme toggles, plus "Connect wallet" only on the pages that use the wallet (WALLET_PAGES, or `wallet: true`).
 * `wallet`: restore the connected wallet now (loads ethers). Default: only on the pages that sign (WALLET_PAGES).
 */
export function renderChrome(active, { wallet = walletByDefault(active) } = {}) {
  const home = active === "home";
  const nav = document.createElement("nav");
  nav.className = home ? "nav" : "nav nav-page";
  nav.setAttribute("aria-label", home ? "OpenForge AX" : "Back to the lab and settings");
  nav.innerHTML = `<div class="wrap">
    ${home ? '<a class="logo" href="index.html" aria-label="OpenForge AX, the lab">OpenForge <b>AX</b></a>' : '<a class="logo nav-back" href="index.html" data-sound="move"><span aria-hidden="true">←</span> Lab<span class="sr-only">: back to the lab</span></a>'}
    <div class="nav-tools">
      ${wallet ? '<button class="btn sm" id="connectBtn" title="Connect to fly your agents and save their verified runs">Connect wallet</button>' : ""}
      <button class="btn sm ghost settings-btn" id="settingsBtn" aria-expanded="false" aria-controls="settingsPanel" title="Sounds, music and theme"><span aria-hidden="true">⚙</span><span class="sr-only">Settings: sounds, music and theme</span></button>
      <div class="nav-settings" id="settingsPanel" hidden></div>
    </div></div>`;
  const skip = document.querySelector(".skip"); // the skip link stays first, so it can skip the nav
  if (skip) skip.after(nav);
  else document.body.prepend(nav);
  const gear = nav.querySelector("#settingsBtn");
  const panel = nav.querySelector("#settingsPanel");
  const soundsBtn = soundsDom(), musicBtn = musicDom();
  panel.append(soundsBtn, musicBtn, themeButton()); // light and quiet by default: soft interface sounds only; dark and music when the visitor picks them
  lazyAudio(soundsBtn, musicBtn); // their code loads on the first gesture, not with the page
  const close = (focusGear = false) => {
    if (panel.hidden) return;
    panel.hidden = true;
    gear.setAttribute("aria-expanded", "false");
    if (focusGear) gear.focus();
  };
  gear.onclick = () => {
    const open = panel.hidden;
    panel.hidden = !open;
    gear.setAttribute("aria-expanded", String(open));
  };
  panel.addEventListener("keydown", (e) => e.key === "Escape" && close(true)); // Escape closes it and returns to the gear
  gear.addEventListener("keydown", (e) => e.key === "Escape" && close());
  document.addEventListener("pointerdown", (e) => !nav.contains(e.target) && close()); // a tap elsewhere closes it
  addEventListener("pageshow", () => close()); // Back (bfcache) never returns to an open panel
  const btn = nav.querySelector("#connectBtn");
  if (btn) {
    btn.onclick = () => connect();
    onWallet((s) => s && ((btn.textContent = short(s.addressChecksum)), btn.removeAttribute("title")));
  }

  const foot = document.createElement("footer");
  foot.innerHTML = `<div class="wrap">
    <div>OpenForge AX · an open robotics lab · CC0. No promise of returns.</div>
    <div><a href="license.html">CC0</a> ·
    <a href="#" id="serversLink">Servers${CONFIG.customServers ? " (yours)" : ""}</a> ·
    <a href="${CONFIG.explorer}/address/${CONFIG.agents}" target="_blank" rel="noopener">Contract<span class="sr-only"> (opens in a new tab)</span></a> ·
    <a href="${esc(CONFIG.social.x)}" target="_blank" rel="noopener">X<span class="sr-only"> (opens in a new tab)</span></a> ·
    <a href="${esc(CONFIG.social.discord)}" target="_blank" rel="noopener">Discord<span class="sr-only"> (opens in a new tab)</span></a></div></div>`;
  document.body.append(foot);
  let dlg;
  foot.querySelector("#serversLink").onclick = (e) => (e.preventDefault(), (dlg ??= serversDialog()).showModal());
  if (wallet) autoReconnect();
}
