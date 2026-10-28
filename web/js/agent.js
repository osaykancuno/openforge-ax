import { CONFIG } from "./config.js";
import {
  eth, loadConfig, renderChrome, agents, account, reputation, reader, onWallet, send, toast,
  tokenMeta, ipfs, attr, isDeployed,
} from "./chain.js";
import { MODE_NAMES, effectiveMode, fmtEth } from "./agent/policy.js";
import { decodeCall } from "./agent/decode.js";
import { arLink, buildLink, cleanMeta } from "./agent/links.js";
import { h } from "./agent/dom.js";

await loadConfig();
renderChrome("mine");

const $ = (id) => document.getElementById(id);
const id = Number(new URLSearchParams(location.search).get("id"));
const MODES = MODE_NAMES;
const DAY = 86400;
let acctAddr, owner, signer, meta;
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
  $("desc").replaceChildren(h("button", { class: "btn sm", type: "button", onclick: () => {
    $("name").textContent = "Loading…";
    $("desc").textContent = "";
    refresh();
  } }, "Retry"));
};
const refresh = () => load().catch(failed);
const readFailed = (e) => (isOffline(e) ? (console.warn("Ethereum RPC unreachable"), toast(OFFLINE, true)) : toast(e?.shortMessage || "Something went wrong.", true));

if (!available) {
  $("name").textContent = id ? "Agents appear here as they are minted, on OpenSea." : "Agent not found. Check the number, or browse the Gallery.";
}

async function load() {
  const c = await agents();
  const [m, own, acct] = await Promise.all([tokenMeta(id), c.ownerOf(id), c.accountOf(id)]);
  meta = cleanMeta(m); // a token whose attributes are not a list must not break the page
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
  $("traits").replaceChildren(...meta.attributes
    .filter((a) => !skip.has(a.trait_type))
    .map((a) => h("div", {}, h("small", {}, a.trait_type), String(a.value ?? ""))));

  // the agent's robot: the AR twin runs for any agent; the build guide needs its class (a dormant token has none yet)
  $("arLink").href = arLink(id);
  $("arLink").hidden = false;
  const build = buildLink(attr(meta, "Class"));
  if (build) $("buildLink").href = build;
  $("buildLink").hidden = !build;

  const { formatEther } = await eth(); // ethers loads on demand: the static page is already drawn
  const a = await account(acct);
  const [bal, lvl, op, paused, lockedUntil, stats] = await Promise.all([
    reader().then((r) => r.getBalance(acct)),
    a.autonomyLevel(),
    a.operator(),
    a.paused(),
    a.lockedUntil(),
    CONFIG.reputation && !/^0x0{40}$/i.test(CONFIG.reputation) ? reputation().then((r) => r.statsOf(id)) : null,
  ]);
  const mode = effectiveMode({ operator: op, level: Number(lvl) }); // a revoked operator leaves the stored level behind
  $("bal").textContent = `${Number(formatEther(bal)).toFixed(4)} ETH`;
  $("lvl").textContent = MODES[mode];
  $("rep").textContent = attr(meta, "Reputation") ?? "Rookie";
  $("tasks").textContent = stats ? `${stats.tasks} / ${stats.dataPoints}` : "0 / 0";
  $("sim").textContent = `${attr(meta, "Sim Successes") ?? 0} / ${attr(meta, "Sim Runs") ?? 0}`;
  $("arenaLink").hidden = false; // every class has lab trials in the Proving Grounds

  const now = Math.floor(Date.now() / 1000);
  // the lock binds the wallet, whoever holds the agent: nobody can move what's inside until it expires
  locked = Number(lockedUntil) > now;
  lockEnd = Number(lockedUntil);
  const until = new Date(lockEnd * 1000).toLocaleString("en-US");
  $("badges").replaceChildren(
    h("span", { class: `badge ${paused ? "bad" : "ok"}` }, paused ? "PAUSED" : "ACTIVE"),
    locked ? h("span", { class: "badge warn" }, `LOCKED until ${until}: nobody can move what's inside, the holder gets control after`) : null,
    attr(meta, "1/1") ? h("span", { class: "badge warn" }, "1/1") : null
  );

  document.querySelectorAll(".mode").forEach((b) => {
    b.classList.toggle("on", Number(b.dataset.l) === mode);
    b.setAttribute("aria-pressed", String(Number(b.dataset.l) === mode));
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
  const first = consoleReady === null;
  showOwnerArea();
  if (!first) (await consoleReady)?.update(); // the console re-reads the chain after every change made here
}

// ---------------------------------------------------------------- proposals: what each one does, with risk flags
const RISK = { high: "HIGH RISK", medium: "CHECK", low: "" };

/** True / false when the node says whether `addr` holds code, undefined when it could not be asked. */
async function isContract(addr) {
  try {
    return (await (await reader()).getCode(addr)) !== "0x";
  } catch {
    return undefined;
  }
}

function describe(d) {
  return d.kind === "eth" ? "ETH transfer" : `${d.name ?? "contract call"} ${d.selector ?? ""}${d.bytes > 4 ? ` (${d.bytes} bytes)` : ""}`.trim();
}

async function loadProposals(a) {
  const { formatEther } = await eth();
  const n = Number(await a.proposalCount());
  const rows = [];
  for (let i = n - 1; i >= 0 && rows.length < 10; i--) {
    const p = await a.proposalAt(i);
    if (!p.valid) continue;
    const d = decodeCall({ to: p.to, value: p.value, data: p.data }, { isContract: p.data.length > 2 ? await isContract(p.to) : undefined, account: acctAddr, holder: owner, trusted: [acctAddr, CONFIG.agents, CONFIG.reputation, CONFIG.renderer] });
    rows.push(h("div", { class: `proposal risk-${d.risk}` },
      h("div", { class: "proposal-head" },
        h("span", {}, `#${i} → `, h("span", { class: "mono" }, p.to), ` · ${formatEther(p.value)} ETH · ${describe(d)}`),
        d.risk === "low" ? null : h("span", { class: `badge ${d.risk === "high" ? "bad" : "warn"}` }, RISK[d.risk])),
      d.args.length ? h("div", { class: "muted small" }, d.args.map((x) => `${x.label}: ${x.value}`).join(" · ")) : null,
      d.flags.length ? h("ul", { class: "flags" }, d.flags.map((f) => h("li", { class: f.level }, f.text))) : null,
      h("span", {}, h("button", { class: "btn sm", "data-ok": i }, "Approve"), " ", h("button", { class: "btn sm danger", "data-no": i }, "Reject"))));
  }
  $("proposals").replaceChildren(...(rows.length ? rows : ["No pending proposals."]));
}

function showOwnerArea() {
  const mine = signer && owner && signer.addressChecksum.toLowerCase() === owner.toLowerCase();
  $("ownerArea").hidden = !mine;
  $("modeCell").hidden = mine; // owners set the mode in the panel below, which already shows the current one
  if (mine) consoleReady ??= startConsole();
}

// ---------------------------------------------------------------- the console (loads when the holder is here)
let consoleReady = null; // a promise of the mounted console, once the holder is connected
function startConsole() {
  return import("./agent/console.js")
    .then((m) => m.mountConsole({
      get id() { return id; },
      get acctAddr() { return acctAddr; },
      get owner() { return owner; },
      get signer() { return signer; },
      get meta() { return meta; },
      refresh,
      walletAgrees,
    }))
    .catch((e) => {
      console.warn(e);
      $("consoleBody").textContent = "The console could not load. Reload the page to try again.";
      return null;
    });
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

// choosing a mode only opens its pane; nothing is sent until the holder confirms there
document.querySelectorAll(".mode").forEach((b) =>
  b.addEventListener("click", async () => {
    const lv = Number(b.dataset.l);
    document.querySelectorAll(".mode").forEach((x) => (x.classList.toggle("on", x === b), x.setAttribute("aria-pressed", String(x === b))));
    (await consoleReady)?.selectMode(lv);
  })
);

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
    // the full target, checked by the human: a look-alike address must never be approved by habit
    if (!(await walletAgrees())) return;
    const read = async () => (await account(acctAddr, signer.provider)).proposalAt(ok); // through the wallet's own provider
    let p;
    try {
      p = await read();
    } catch (e) {
      return readFailed(e);
    }
    const d = decodeCall({ to: p.to, value: p.value, data: p.data }, { isContract: p.data.length > 2 ? await isContract(p.to) : undefined, account: acctAddr, holder: owner, trusted: [acctAddr, CONFIG.agents, CONFIG.reputation, CONFIG.renderer] });
    if (!confirm(`Approve proposal #${ok}?

To: ${p.to}
Value: ${fmtEth(p.value)} ETH
${d.kind === "eth" ? "ETH transfer" : `Contract call ${describe(d)}`}${d.args.map((x) => `\n${x.label}: ${x.value}`).join("")}${d.flags.length ? `\n\nCheck before approving:\n${d.flags.map((f) => `- ${f.text}`).join("\n")}` : ""}`)) return;
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
