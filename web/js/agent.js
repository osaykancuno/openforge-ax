import { parseEther, isAddress } from "../vendor/ethers.min.js";
import { CONFIG } from "./config.js";
import {
  loadConfig, renderChrome, agents, account, reputation, reader, onWallet, send, toast,
  tokenMeta, ipfs, attr, short, formatEther, isDeployed, esc,
} from "./chain.js";

await loadConfig();
renderChrome("mine");

const $ = (id) => document.getElementById(id);
const id = Number(new URLSearchParams(location.search).get("id"));
const MODES = ["", "Manual", "Assisted", "Autonomous"];
const DAY = 86400;
let acctAddr, owner, signer;

if (!isDeployed() || !id) {
  $("name").textContent = "Agent not found";
  throw new Error("no agent");
}

async function load() {
  const c = agents();
  const [meta, own, acct] = await Promise.all([tokenMeta(id), c.ownerOf(id), c.accountOf(id)]);
  owner = own;
  acctAddr = acct;
  document.title = `${meta.name} — OpenForge AX`;
  $("name").textContent = meta.name;
  $("desc").textContent = meta.description;
  $("img").src = ipfs(meta.image);
  $("img").alt = meta.name;
  $("kicker").textContent = attr(meta, "1/1") ? "FIG. 08 · Legendary 1/1" : `FIG. 08 · ${attr(meta, "Faction") ?? "Dormant agent"}`;
  $("osLink").href = CONFIG.openseaItemUrl(CONFIG.agents, id);
  $("scanLink").href = `${CONFIG.explorer}/address/${acct}`;
  $("acct").textContent = acct;
  $("owner").textContent = own;

  const skip = new Set(["Agent Wallet", "Autonomy", "Reputation", "Tasks", "Successes", "Failures Logged", "Data Points", "Sim Runs", "Sim Successes"]);
  $("traits").innerHTML = meta.attributes
    .filter((a) => !skip.has(a.trait_type))
    .map((a) => `<div><small>${esc(a.trait_type)}</small>${esc(a.value)}</div>`)
    .join("");

  const a = account(acct);
  const [bal, lvl, paused, lockedUntil, lockOwner, stats] = await Promise.all([
    reader().getBalance(acct),
    a.autonomyLevel(),
    a.paused(),
    a.lockedUntil(),
    a.lockOwner(),
    CONFIG.reputation && !/^0x0{40}$/i.test(CONFIG.reputation) ? reputation().statsOf(id) : null,
  ]);
  $("bal").textContent = `${Number(formatEther(bal)).toFixed(4)} ETH`;
  $("lvl").textContent = MODES[Number(lvl)];
  $("rep").textContent = attr(meta, "Reputation") ?? "Rookie";
  $("tasks").textContent = stats ? `${stats.tasks} / ${stats.dataPoints}` : "0 / 0";
  $("sim").textContent = `${attr(meta, "Sim Successes") ?? 0} / ${attr(meta, "Sim Runs") ?? 0}`;
  $("arenaLink").hidden = $("robotLink").hidden = attr(meta, "Class") !== "Synth Arm";

  const now = Math.floor(Date.now() / 1000);
  const locked = Number(lockedUntil) > now && lockOwner.toLowerCase() === own.toLowerCase();
  $("badges").innerHTML = [
    paused ? `<span class="badge bad">PAUSED</span>` : `<span class="badge ok">ACTIVE</span>`,
    locked ? `<span class="badge warn">LOCKED FOR SALE until ${new Date(Number(lockedUntil) * 1000).toLocaleString("en-US")}</span>` : "",
    attr(meta, "1/1") ? `<span class="badge warn">1/1</span>` : "",
  ].join("");

  document.querySelectorAll(".mode").forEach((b) => {
    b.classList.toggle("on", Number(b.dataset.l) === Number(lvl));
    b.setAttribute("aria-pressed", String(Number(b.dataset.l) === Number(lvl)));
  });
  $("pauseBtn").textContent = paused ? "Resume agent" : "Emergency pause";
  $("pauseBtn").dataset.paused = paused ? "1" : "";
  $("secInfo").textContent = locked
    ? "The agent wallet is locked: nobody can move its funds until the lock expires. You can now list it on OpenSea."
    : "Before listing the agent on OpenSea, lock its wallet so buyers know it can't be emptied.";
  $("lockBtn").disabled = locked;
  $("wdBtn").disabled = locked; // execute reverts while locked
  $("wdBtn").title = locked ? "Locked for sale until the lock expires" : "";

  await loadProposals(a);
  showOwnerArea();
}

async function loadProposals(a) {
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
}

// ---------------------------------------------------------------- owner actions
const acctW = () => account(acctAddr, signer);
let pendingLevel = 1;

document.querySelectorAll(".mode").forEach((b) =>
  b.addEventListener("click", async () => {
    pendingLevel = Number(b.dataset.l);
    document.querySelectorAll(".mode").forEach((x) => (x.classList.toggle("on", x === b), x.setAttribute("aria-pressed", String(x === b))));
    const op = await account(acctAddr).operator();
    $("operator").value = CONFIG.defaultOperator || (/^0x0{40}$/i.test(op) ? "" : op);
    $("operator").hidden = Boolean(CONFIG.defaultOperator);
    $("modeOpts").hidden = false;
  })
);

$("applyMode").onclick = async () => {
  const op = CONFIG.defaultOperator || $("operator").value.trim();
  if (!isAddress(op)) return toast("The agent runtime address (0x…) is required.", true);
  const limit = parseEther($("limit").value);
  if (await send(`${MODES[pendingLevel]} mode`, () => acctW().configure(op, pendingLevel, limit, DAY))) load();
};

$("pauseBtn").onclick = async () => {
  const resume = Boolean($("pauseBtn").dataset.paused);
  if (await send(resume ? "Resume agent" : "Emergency pause", () => acctW().setPaused(!resume))) load();
};

$("lockBtn").onclick = async () => {
  if (!confirm("The agent wallet will stay locked for 7 days (not even you can move funds). If you sell, the lock ends for the new owner. Confirm?")) return;
  const until = Math.floor(Date.now() / 1000) + 7 * DAY;
  if (await send("Prepare for sale", () => acctW().lock(until))) load();
};

$("depBtn").onclick = async () => {
  const v = $("dep").value;
  if (!(Number(v) > 0)) return toast("Enter how much ETH to send to the agent.", true);
  if (await send("Top up", () => signer.sendTransaction({ to: acctAddr, value: parseEther(v) }))) load();
};

$("wdBtn").onclick = async () => {
  const bal = await reader().getBalance(acctAddr);
  if (bal === 0n) return toast("The agent wallet is empty.");
  if (await send("Withdraw all", () => acctW().execute(signer.addressChecksum, bal, "0x", 0))) load();
};

$("proposals").addEventListener("click", async (e) => {
  const ok = e.target.dataset.ok;
  const no = e.target.dataset.no;
  if (ok !== undefined) {
    // the full target, checked by the human: a look-alike address must never be approved by habit
    const p = await acctW().proposalAt(ok);
    if (!confirm(`Approve proposal #${ok}?

To: ${p.to}
Value: ${formatEther(p.value)} ETH
${p.data.length > 2 ? `Contract call ${p.data.slice(0, 10)} (${(p.data.length - 2) / 2} bytes)` : "ETH transfer"}`)) return;
    if (await send(`Approve #${ok}`, () => acctW().approve(ok))) load();
  }
  if (no !== undefined && (await send(`Reject #${no}`, () => acctW().reject(no)))) load();
});

onWallet((s) => {
  signer = s;
  showOwnerArea();
});

load().catch((e) => {
  $("name").textContent = "Agent not found";
  console.error(e);
});
