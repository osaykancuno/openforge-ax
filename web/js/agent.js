import { CONFIG } from "./config.js";
import {
  eth, loadConfig, renderChrome, agents, account, reputation, reader, onWallet, send, toast,
  tokenMeta, ipfs, attr, short, isDeployed, esc,
} from "./chain.js";

await loadConfig();
renderChrome("mine");

const $ = (id) => document.getElementById(id);
const id = Number(new URLSearchParams(location.search).get("id"));
const MODES = ["", "Manual", "Assisted", "Autonomous"];
const DAY = 86400;
let acctAddr, owner, signer;
let locked = false, lockEnd = 0; // the wallet's sale lock (it binds every holder until lockEnd)
const lockTarget = () => Math.floor(Date.now() / 1000) + 7 * DAY;

const OFFLINE = "Can't reach Ethereum right now. Try again in a moment.";
// RPC / network failures are expected now and then; a reverted call (no such token) is not one
const isOffline = (e) => e instanceof TypeError || ["NETWORK_ERROR", "SERVER_ERROR", "TIMEOUT"].includes(e?.code) || /fetch|network|timeout|timed out|failed to/i.test(`${e?.shortMessage || ""} ${e?.message || ""}`);
const available = isDeployed() && Boolean(id); // without a deployment (or a number) the RPC is never asked
const failed = (e) => {
  if (!isOffline(e)) {
    $("name").textContent = "Agent not found. Check the number, or browse the Gallery.";
    console.warn(e);
    return;
  }
  console.warn("Ethereum RPC unreachable");
  $("name").textContent = OFFLINE;
  $("desc").innerHTML = `<button class="btn sm" type="button">Retry</button>`;
  $("desc").querySelector("button").onclick = () => {
    $("name").textContent = "Loading…";
    $("desc").textContent = "";
    refresh();
  };
};
const refresh = () => load().catch(failed);
const readFailed = (e) => (isOffline(e) ? (console.warn("Ethereum RPC unreachable"), toast(OFFLINE, true)) : toast(e?.shortMessage || "Something went wrong.", true));

if (!available) {
  $("name").textContent = id ? "Agents appear here as they are minted, on OpenSea." : "Agent not found. Check the number, or browse the Gallery.";
}

async function load() {
  const c = await agents();
  const [meta, own, acct] = await Promise.all([tokenMeta(id), c.ownerOf(id), c.accountOf(id)]);
  owner = own;
  acctAddr = acct;
  document.title = `${meta.name} — OpenForge AX`;
  $("name").textContent = meta.name;
  $("desc").textContent = meta.description;
  $("img").src = ipfs(meta.image);
  $("img").alt = meta.name;
  $("kicker").textContent = attr(meta, "1/1") ? "FIG. 12 · Prime Construct (1/1)" : `FIG. 12 · ${attr(meta, "Faction") ?? "Dormant agent · revealed after the sale"}`;
  $("osLink").href = CONFIG.openseaItemUrl(CONFIG.agents, id);
  $("acct").textContent = acct;
  $("owner").textContent = own;

  const skip = new Set(["Agent Wallet", "Autonomy", "Reputation", "Tasks", "Successes", "Failures Logged", "Data Points", "Sim Runs", "Sim Successes"]);
  $("traits").innerHTML = meta.attributes
    .filter((a) => !skip.has(a.trait_type))
    .map((a) => `<div><small>${esc(a.trait_type)}</small>${esc(a.value)}</div>`)
    .join("");

  const { formatEther } = await eth(); // ethers loads on demand: the static page is already drawn
  const a = await account(acct);
  const [bal, lvl, paused, lockedUntil, stats] = await Promise.all([
    reader().then((r) => r.getBalance(acct)),
    a.autonomyLevel(),
    a.paused(),
    a.lockedUntil(),
    CONFIG.reputation && !/^0x0{40}$/i.test(CONFIG.reputation) ? reputation().then((r) => r.statsOf(id)) : null,
  ]);
  $("bal").textContent = `${Number(formatEther(bal)).toFixed(4)} ETH`;
  $("lvl").textContent = MODES[Number(lvl)];
  $("rep").textContent = attr(meta, "Reputation") ?? "Rookie";
  $("tasks").textContent = stats ? `${stats.tasks} / ${stats.dataPoints}` : "0 / 0";
  $("sim").textContent = `${attr(meta, "Sim Successes") ?? 0} / ${attr(meta, "Sim Runs") ?? 0}`;
  $("arenaLink").hidden = false; // every class has lab trials in the Proving Grounds

  const now = Math.floor(Date.now() / 1000);
  // the lock binds the wallet, whoever holds the agent: nobody can move what's inside until it expires
  locked = Number(lockedUntil) > now;
  lockEnd = Number(lockedUntil);
  const until = new Date(lockEnd * 1000).toLocaleString("en-US");
  $("badges").innerHTML = [
    paused ? `<span class="badge bad">PAUSED</span>` : `<span class="badge ok">ACTIVE</span>`,
    locked ? `<span class="badge warn">LOCKED until ${until}: nobody can move what's inside, the holder gets control after</span>` : "",
    attr(meta, "1/1") ? `<span class="badge warn">1/1</span>` : "",
  ].join("");

  document.querySelectorAll(".mode").forEach((b) => {
    b.classList.toggle("on", Number(b.dataset.l) === Number(lvl));
    b.setAttribute("aria-pressed", String(Number(b.dataset.l) === Number(lvl)));
  });
  $("pauseBtn").textContent = paused ? "Resume agent" : "Emergency pause";
  $("pauseBtn").dataset.paused = paused ? "1" : "";
  $("secInfo").textContent = locked
    ? `The agent wallet is locked until ${until}: nobody, not even the holder, can move what's inside. A buyer gets control when the lock ends. A lock can only be extended, never shortened. You can list it on OpenSea.`
    : "Before listing the agent on OpenSea, lock its wallet (up to 30 days) so buyers know it can't be emptied. Nobody can unlock it early, you included; a buyer can use what's inside only after the lock ends.";
  // extend-only: while locked, the button is useful only if 7 days from now is later than the current end
  const extendable = !locked || lockTarget() > lockEnd;
  $("lockBtn").textContent = locked ? "Extend the lock (7 days from now)" : "Prepare for sale (lock 7 days)";
  $("lockBtn").disabled = !extendable;
  $("wdBtn").disabled = locked; // execute reverts while locked
  $("wdBtn").title = locked ? "Locked for sale until the lock expires" : "";

  await loadProposals(a);
  showOwnerArea();
}

async function loadProposals(a) {
  const { formatEther } = await eth();
  const n = Number(await a.proposalCount());
  const rows = [];
  for (let i = n - 1; i >= 0 && rows.length < 10; i--) {
    const p = await a.proposalAt(i);
    if (!p.valid) continue;
    rows.push(`<div class="row" style="justify-content:space-between;border-bottom:1px dashed var(--line);padding:8px 0">
      <span>#${i} → <span class="mono">${esc(p.to)}</span> · ${formatEther(p.value)} ETH · ${p.data.length > 2 ? `contract call <span class="mono">${esc(p.data.slice(0, 10))}</span>${p.data.length > 10 ? `<span class="muted small"> (${(p.data.length - 2) / 2} bytes)</span>` : ""}` : "ETH transfer"}</span>
      <span><button class="btn sm" data-ok="${i}">Approve</button> <button class="btn sm danger" data-no="${i}">Reject</button></span></div>`);
  }
  $("proposals").innerHTML = rows.join("") || "No pending proposals.";
}

function showOwnerArea() {
  const mine = signer && owner && signer.addressChecksum.toLowerCase() === owner.toLowerCase();
  $("ownerArea").hidden = !mine;
  $("modeCell").hidden = mine; // owners set the mode in the panel below, which already shows the current one
}

// ---------------------------------------------------------------- owner actions
const acctW = () => account(acctAddr, signer); // a promise of the contract, signing
/**
 * The page learned this agent's wallet from one public RPC. Before money or approvals move, the connected wallet's own
 * provider must report the same address (a lying RPC could otherwise point a top-up or an approval elsewhere).
 */
async function walletAgrees() {
  if (!signer) return toast("Connect your wallet first.", true), false;
  try {
    const seen = await (await agents(signer.provider)).accountOf(id);
    if (String(seen).toLowerCase() === String(acctAddr).toLowerCase()) return true;
  } catch (e) {
    return readFailed(e), false;
  }
  toast("Your wallet sees a different agent wallet than this page. Nothing was sent: reload the page and check the address.", true);
  return false;
}
let pendingLevel = 1;

document.querySelectorAll(".mode").forEach((b) =>
  b.addEventListener("click", async () => {
    pendingLevel = Number(b.dataset.l);
    document.querySelectorAll(".mode").forEach((x) => (x.classList.toggle("on", x === b), x.setAttribute("aria-pressed", String(x === b))));
    let op;
    try {
      op = await (await account(acctAddr)).operator();
    } catch (e) {
      return readFailed(e);
    }
    $("operator").value = CONFIG.defaultOperator || (/^0x0{40}$/i.test(op) ? "" : op);
    $("operator").hidden = Boolean(CONFIG.defaultOperator); // the confirmation below always shows the address anyway
    $("modeOpts").hidden = false;
  })
);

$("applyMode").onclick = async () => {
  const { parseEther, isAddress, formatEther } = await eth();
  const op = CONFIG.defaultOperator || $("operator").value.trim();
  if (!isAddress(op)) return toast("The agent software address (0x…) is required.", true);
  let limit;
  try {
    limit = parseEther($("limit").value.trim());
  } catch {
    return toast("Enter the daily limit as a number of ETH, like 0.05.", true);
  }
  // the human sees exactly who gets the power and how much per day, whatever the page pre-filled
  if (!confirm(`${MODES[pendingLevel]} mode

Agent software address: ${op}
Daily limit: ${formatEther(limit)} ETH
${pendingLevel === 1 ? "" : "\nThis address can act for the agent within that limit."}`)) return;
  if (await send(`${MODES[pendingLevel]} mode`, () => acctW().then((a) => a.configure(op, pendingLevel, limit, DAY)))) refresh();
};

$("pauseBtn").onclick = async () => {
  const resume = Boolean($("pauseBtn").dataset.paused);
  if (await send(resume ? "Resume agent" : "Emergency pause", () => acctW().then((a) => a.setPaused(!resume)))) refresh();
};

$("lockBtn").onclick = async () => {
  if (!confirm(`${locked ? "Extend the lock to" : "Lock the agent wallet for"} 7 days from now.

Nobody can move what's inside until then, not even you, and nobody can end the lock early. A lock can only be extended, never shortened.
If you sell, the buyer can use the contents only after the lock ends. Confirm?`)) return;
  const until = lockTarget();
  if (await send("Prepare for sale", () => acctW().then((a) => a.lock(until)))) refresh();
};

$("depBtn").onclick = async () => {
  const { parseEther, formatEther } = await eth();
  const v = $("dep").value.trim();
  if (!(Number(v) > 0)) return toast("Enter how much ETH to send to the agent.", true);
  let value;
  try {
    value = parseEther(v);
  } catch {
    return toast("Enter the amount as a number of ETH, like 0.05.", true);
  }
  if (!(await walletAgrees())) return;
  if (!confirm(`Send ${formatEther(value)} ETH to this agent's wallet?

${acctAddr}

Check the full address: it must be the one shown on this page.`)) return;
  if (await send("Top up", () => signer.sendTransaction({ to: acctAddr, value }))) refresh();
};

$("wdBtn").onclick = async () => {
  let bal;
  try {
    bal = await (await reader()).getBalance(acctAddr);
  } catch (e) {
    return readFailed(e);
  }
  if (bal === 0n) return toast("The agent wallet is empty.");
  if (await send("Withdraw all", () => acctW().then((a) => a.execute(signer.addressChecksum, bal, "0x", 0)))) refresh();
};

$("proposals").addEventListener("click", async (e) => {
  const ok = e.target.dataset.ok;
  const no = e.target.dataset.no;
  if (ok !== undefined) {
    const { formatEther } = await eth();
    // the full target, checked by the human: a look-alike address must never be approved by habit
    if (!(await walletAgrees())) return;
    const read = async () => (await account(acctAddr, signer.provider)).proposalAt(ok); // through the wallet's own provider
    let p;
    try {
      p = await read();
    } catch (e) {
      return readFailed(e);
    }
    if (!confirm(`Approve proposal #${ok}?

To: ${p.to}
Value: ${formatEther(p.value)} ETH
${p.data.length > 2 ? `Contract call ${p.data.slice(0, 10)} (${(p.data.length - 2) / 2} bytes)` : "ETH transfer"}`)) return;
    try {
      // what the wallet's node holds now must still be what the human just read
      const q = await read();
      if (!q.valid || q.to !== p.to || q.value !== p.value || q.data !== p.data) return toast("The proposal changed while you were reading it. Nothing was approved: reload and check it again.", true);
    } catch (e) {
      return readFailed(e);
    }
    if (await send(`Approve #${ok}`, () => acctW().then((a) => a.approve(ok)))) refresh();
  }
  if (no !== undefined && (await send(`Reject #${no}`, () => acctW().then((a) => a.reject(no))))) refresh();
});

onWallet((s) => {
  signer = s;
  showOwnerArea();
});

if (available) refresh();
