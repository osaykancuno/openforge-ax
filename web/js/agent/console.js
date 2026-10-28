// The agent console (agent page, holder only): everything a holder can do with their agent's wallet today, in the
// browser, free of project servers. It talks to the chain through the page's own RPC and wallet; the only secret it ever
// holds is the optional agent key, encrypted with a passphrase in this browser's storage.
//   Manual (default): watches the wallet and the lab record and suggests; the holder does each action.
//   Assisted: a key in this browser acts alone for two built-in actions (refuel its gas, sweep surplus to the holder).
//   Autonomous: nothing here; the holder points the agent at their own software.
// The rules live in policy.js / actions.js (pure, tested against the contract); this file is the DOM around them.
import { CONFIG } from "../config.js";
import { eth, reader, send, toast, attr, friendlyError } from "../chain.js";
import { h, download, paneBusy } from "./dom.js";
import { BUILTIN_LIMITS, OWN_SOFTWARE_LIMITS, DEFAULT_LIMIT, MODE_NAMES, MODE_TEXT, DAY, GAS_FLOAT, REFUEL_BELOW, fmtEth, limitNote, effectiveMode, KEY_RISK_TEXT, OPERATOR_RULE, checkOperator, l3Confirmation, L3_PLACEHOLDER } from "./policy.js";
import { ACTIONS, permissionsFor, createRunner, createGate, createIdleLock, withTimeout, parseKeep, sweepKeyValue } from "./actions.js";
import { ACCOUNT_ABI, AGENTS_ABI, REPUTATION_EVENTS_ABI, readState, watchWallet, coach, countToday, weeklyReport, pushSnapshot, readSeen, writeSeen, readHistory, writeHistory, readActivity, logActivity } from "./watch.js";
import { createKey, saveKey, putRecord, loadRecord, forgetKey, unlockKey, exportKeystore, importKeystore, keyId, checkPassphrase, idbStore, memoryStore } from "./keystore.js";
import { createJournal, journalTypedData, KINDS, OUTCOMES } from "./journal.js";
import { robotIdForClass, ROBOT_IDS } from "./links.js";

const $ = (id) => document.getElementById(id);
const ZERO = /^0x0{40}$/i;
const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
const now = () => Math.floor(Date.now() / 1000);
const CONFIRM_MS = 3 * 60_000; // a send that is not mined in this time halts the key; it is never sent again
const local = () => {
  try {
    return localStorage;
  } catch {
    return null; // storage blocked: what the console remembers lasts for this visit
  }
};

/**
 * mountConsole(page): page = { id, acctAddr, signer, owner, meta, refresh, walletAgrees } (the agent page's current
 * facts: read them when needed, they change after every transaction). Returns { selectMode, update }.
 */
export async function mountConsole(page) {
  const E = await eth();
  const body = $("consoleBody");
  const pane = $("modePane");
  const storage = local();
  const sid = `${CONFIG.chainId}:${page.id}`; // what this browser remembers is per chain and agent
  const kid = () => keyId(CONFIG.chainId, page.acctAddr, page.id);
  const journal = createJournal({ storage, chainId: CONFIG.chainId, tokenId: page.id });

  let store = idbStore();
  let storeNote = "";
  try {
    await store.get("probe");
  } catch {
    store = memoryStore();
    storeNote = "This browser blocks storage for this site, so the key would be lost when you leave this page. Export the key file right after you create it.";
  }

  let st = null; // last chain state
  let rec = null; // the stored (encrypted) key record, if any
  let wallet = null; // the unlocked key: in memory only
  let runner = null;
  let paneOpen = false; // the mode pane stays closed until the holder picks a mode
  let level = 1; // the mode whose pane is open
  let labCache = null;
  const gate = createGate(); // one use of the key at a time: a round of the loop, sending its ETH back, a stop
  // the unlocked key is dropped again after 15 minutes with no activity (nobody using the console, no loop running on a visible page)
  const idle = createIdleLock({ lock: () => wallet && relock("The key was locked again after 15 minutes without activity. Unlock it with your passphrase to use it.") });

  const provider = () => reader();
  const accountC = async (runnerOrSigner) => new E.Contract(page.acctAddr, ACCOUNT_ABI, runnerOrSigner ?? (await provider()));
  const agentsC = async () => new E.Contract(CONFIG.agents, AGENTS_ABI, await provider());
  const holder = () => page.owner;
  const allowList = () => (rec ? permissionsFor({ operator: rec.address, holder: rec.holder }).map((p) => ({ key: p.action === "refuel" ? "operator" : "holder", target: p.target, selector: p.selector })) : []);
  const readChain = async (blockTag) => {
    const p = await provider();
    return readState({ account: await accountC(p), agents: await agentsC(), tokenId: page.id, provider: p, accountAddress: page.acctAddr, allow: allowList(), blockTag });
  };
  /** true / false when the node says whether the address holds code, undefined when it could not be asked */
  const isContract = async (addr) => {
    try {
      return (await (await provider()).getCode(addr)) !== "0x";
    } catch {
      return undefined;
    }
  };

  // ---------------------------------------------------------------- Manual: wallet watch, coach, report
  const watchBox = h("div", { class: "console-list", "aria-live": "polite" });
  const coachBox = h("div", { class: "console-list" });
  const reportBox = h("div", { class: "console-list" });
  const journalBox = h("div");

  function renderWatch() {
    if (!st) return watchBox.replaceChildren(h("p", { class: "muted small" }, "Reading the wallet…"));
    const w = watchWallet(st, readSeen(storage, sid), now());
    watchBox.replaceChildren(...w.items.map((i) => h("p", { class: `console-item ${i.level}` }, i.text)));
    return w;
  }

  async function labRuns() {
    if (labCache) return labCache;
    if (!CONFIG.reputation || ZERO.test(CONFIG.reputation)) return (labCache = { runs: [], ok: true });
    try {
      const p = await provider();
      const rc = new E.Contract(CONFIG.reputation, REPUTATION_EVENTS_ABI, p);
      const latest = await p.getBlockNumber();
      const logs = (await rc.queryFilter(rc.filters.SimAttested(page.id), Math.max(CONFIG.fromBlock || 0, latest - 60000))).slice(-40);
      const stamps = new Map(await Promise.all([...new Set(logs.map((l) => l.blockNumber))].map(async (b) => [b, (await p.getBlock(b)).timestamp])));
      return (labCache = { runs: logs.map((l) => ({ at: stamps.get(l.blockNumber), success: l.args.success })), ok: true });
    } catch (e) {
      console.warn(e);
      return { runs: [], ok: false };
    }
  }

  async function renderCoach() {
    const robotId = robotIdForClass(attr(page.meta, "Class"));
    let levels = [];
    let robotName = null;
    if (robotId) {
      const { MISSIONS } = await import("../bench/missions/index.js");
      levels = MISSIONS[robotId]?.levels ?? [];
      robotName = attr(page.meta, "Class");
    }
    let progress = null;
    try {
      progress = JSON.parse(storage?.getItem("ofx-bench-v1"))?.[robotId] ?? null; // the Workbench and Proving Grounds save passes here
    } catch {}
    const lab = await labRuns();
    const c = coach({ robotName, levels, progress, today: countToday(lab.runs, now()), cap: 10 });
    coachBox.replaceChildren(
      ...c.lines.map((t) => h("p", { class: "console-item info" }, t)),
      ...(lab.ok ? [] : [h("p", { class: "console-item warn" }, "Could not read the lab record just now.")]), // replaceChildren would print a null
      h("a", { class: "btn sm yellow", href: "arena.html" }, "Open the Proving Grounds")
    );
  }

  async function renderReport() {
    const lab = await labRuns();
    const r = weeklyReport({ now: now(), history: readHistory(storage, sid), balance: st?.balance ?? 0n, labRuns: lab.runs, activity: readActivity(storage, kid()), practice: journal.entries().filter((e) => e.at >= now() - 7 * DAY).length });
    reportBox.replaceChildren(...r.lines.map((t) => h("p", { class: "console-item info" }, t)), h("p", { class: "muted small" }, "Kept only in this browser. It describes the week; it predicts nothing."));
  }

  async function look(force = false) {
    try {
      st = await readChain();
    } catch (e) {
      console.warn(e);
      return watchBox.replaceChildren(h("p", { class: "console-item warn" }, "Can't reach Ethereum right now. The console tries again in a minute."));
    }
    const w = renderWatch();
    writeSeen(storage, sid, w.seen);
    writeHistory(storage, sid, pushSnapshot(readHistory(storage, sid), { at: now(), balance: st.balance.toString() }));
    await Promise.all([renderCoach(), renderReport()]).catch(console.warn);
    renderPane(force);
  }

  // ---------------------------------------------------------------- journal
  function renderJournal() {
    const list = journal.entries();
    const v = journal.verify();
    const robot = h("select", { "aria-label": "Robot" }, ROBOT_IDS.map((r) => h("option", { value: r }, r)));
    const robotId = robotIdForClass(attr(page.meta, "Class"));
    if (robotId) robot.value = robotId;
    const kind = h("select", { "aria-label": "How you flew it" }, KINDS.map((k) => h("option", { value: k }, k === "ai-pilot" ? "AI Pilot" : "Twin")));
    const outcome = h("select", { "aria-label": "Outcome" }, OUTCOMES.map((o) => h("option", { value: o }, o)));
    const mission = h("input", { type: "text", maxlength: "80", placeholder: "Mission", "aria-label": "Mission", value: "practice" });
    const note = h("input", { type: "text", maxlength: "200", placeholder: "Note (optional)", "aria-label": "Note" });
    const add = h("button", { class: "btn sm", type: "button" }, "Add to the journal");
    add.onclick = () => {
      try {
        journal.append({ kind: kind.value, robot: robot.value, mission: mission.value.trim() || "practice", outcome: outcome.value, note: note.value.trim() });
      } catch (e) {
        return toast(e.message, true);
      }
      renderJournal();
      renderReport();
    };
    const exp = h("button", { class: "btn sm", type: "button" }, "Export");
    exp.onclick = () => {
      const f = journal.exportFile();
      download(f.filename, f.text);
    };
    const sign = h("button", { class: "btn sm", type: "button", disabled: !list.length || !v.ok }, "Sign the journal (free)");
    sign.onclick = signJournal;
    journalBox.replaceChildren(
      h("p", { class: "muted small" }, "Practice runs with the AI Pilot or the twin. Every entry says \"Assisted, not verified\": the Proving Grounds never counts it, and it is not on-chain. Kept only in this browser. The pilot and the twin do not write here yet; add a run by hand."),
      h("p", { class: `console-item ${v.ok ? "info" : "warn"}` }, v.ok ? `${v.count} entr${v.count === 1 ? "y" : "ies"}; unchanged since saved in this browser (the chain of hashes is intact).` : `The journal was edited: the chain breaks at entry ${v.at + 1}.`),
      h("ul", { class: "journal-list" }, list.slice(-8).reverse().map((e) => h("li", {}, `${new Date(e.at * 1000).toISOString().slice(0, 16).replace("T", " ")} · ${e.kind === "ai-pilot" ? "AI Pilot" : "Twin"} · ${e.robot} · ${e.mission} · ${e.outcome}${e.note ? ` · ${e.note}` : ""} · ${e.label}`))),
      h("div", { class: "row" }, kind, robot, mission, outcome, note, add),
      h("div", { class: "row" }, exp, sign)
    );
  }

  async function signJournal() {
    const s = page.signer;
    if (!s) return toast("Connect your wallet first.", true);
    const list = journal.entries();
    const td = journalTypedData({ chainId: CONFIG.chainId, tokenId: page.id, count: list.length, head: journal.head() });
    if (!confirm(`Sign your practice journal?\n\nThis is a free signature, not a transaction. It says only that you, the holder, signed this head: this journal of ${list.length} practice run${list.length === 1 ? "" : "s"} for agent ${page.id} (head ${journal.head()}) the holder signed this head. It does not prove the runs happened. It is labelled "Assisted, not verified", goes nowhere and never counts as a Proving Grounds run.`)) return;
    try {
      const signature = await s.signTypedData(td.domain, td.types, td.value);
      const f = journal.exportFile();
      download(f.filename.replace(".json", "-signed.json"), JSON.stringify({ ...JSON.parse(f.text), signed: { typedData: td, signer: s.addressChecksum, signature } }, null, 2));
    } catch (e) {
      toast(friendlyError(e), true);
    }
  }

  // ---------------------------------------------------------------- mode pane
  // "force": the holder just did something. Otherwise (the minute-by-minute refresh) a pane with a half-typed field is left alone.
  function renderPane(force) {
    if (!st || !paneOpen) return;
    if (!force && paneBusy(pane)) return;
    const mode = effectiveMode(st);
    const parts = [h("p", {}, MODE_TEXT[level])];
    if (level === 1) parts.push(...manualPane(mode));
    else if (level === 2) parts.push(...assistedPane(mode));
    else parts.push(...autonomousPane(mode));
    pane.replaceChildren(...parts);
    pane.hidden = false;
  }

  const op = () => (st && st.operator && !ZERO.test(st.operator) ? st.operator : null);
  const current = (mode) => (op() ? h("p", { class: "muted small" }, `Right now: ${MODE_NAMES[mode]}. Agent software address: `, h("span", { class: "mono" }, op())) : h("p", { class: "muted small" }, "Right now: Manual. No agent software is set."));

  function manualPane(mode) {
    const out = [current(mode)];
    if (op()) {
      const b = h("button", { class: "btn sm primary", type: "button" }, "Switch to Manual (remove the agent software)");
      b.onclick = revokeFlow;
      out.push(b);
    } else {
      out.push(h("p", { class: "muted small" }, "Nothing to set: the console below watches your agent and suggests. You do each action with one tap, and it works with no key and no gas."));
    }
    if (rec && !enabledOnChain()) out.push(leftover());
    out.push(ownSoftware(1));
    return out;
  }

  // an agent key that is no longer the operator may still hold its gas money: it can be sent back to the holder
  function leftover() {
    const p = pass("Passphrase of the agent key", { autocomplete: "current-password" });
    const go = h("button", { class: "btn sm", type: "button" }, wallet ? "Send the key's gas money back to me" : "Unlock and send the key's gas money back to me");
    go.onclick = async () => {
      if (!wallet) {
        try {
          wallet = await unlockKey({ ethers: E, record: rec, passphrase: p.value });
        } catch (e) {
          return toast(e.message, true);
        } finally {
          p.value = "";
        }
      }
      await sweepKey();
    };
    return h("div", {}, keyLine(), h("div", { class: "row" }, wallet ? null : p, go), keyActions());
  }

  function autonomousPane(mode) {
    return [
      current(mode),
      h("p", { class: "muted small" }, "The console adds nothing in this mode: your own agent software does the work. It needs its own key, which you keep. You choose the daily limit; ETH is capped, tokens and NFTs are not."),
      ownSoftware(3, true),
    ];
  }

  // "Use my own agent software": the only place an operator address is pasted
  function ownSoftware(lv, open = false) {
    const addr = h("input", { type: "text", placeholder: "Agent software address (0x…)", "aria-label": "Agent software address", autocomplete: "off", spellcheck: "false", value: lv === 3 ? "" : CONFIG.defaultOperator || (op() ?? "") }); // nothing is pre-filled for full trust
    const limit = h("select", { "aria-label": "Daily limit" }, OWN_SOFTWARE_LIMITS.map((v) => h("option", { value: v, selected: v === DEFAULT_LIMIT }, `${v} ETH`)));
    const typed = lv === 3 ? h("input", { type: "text", placeholder: L3_PLACEHOLDER, "aria-label": L3_PLACEHOLDER, autocomplete: "off", spellcheck: "false", maxlength: "6" }) : null;
    const apply = h("button", { class: "btn sm primary", type: "button" }, lv === 1 ? "Let it suggest actions" : `Set ${MODE_NAMES[lv]}`);
    apply.onclick = async () => {
      if (!(await sameAccount())) return;
      let address;
      try {
        address = E.getAddress(addr.value.trim());
      } catch {
        return toast("The agent software address (0x…) is required.", true);
      }
      const chk = checkOperator({ address, level: lv, builtinKey: rec?.address, defaultOperator: CONFIG.defaultOperator, account: page.acctAddr, isContract: await isContract(address) });
      if (chk.error) return toast(chk.error, true);
      if (typed && !l3Confirmation(typed.value, page.acctAddr)) return toast("Type the last 4 characters of the agent wallet address to confirm Autonomous.", true);
      const limitWei = E.parseEther(limit.value);
      const lines = [
        `${MODE_NAMES[lv]} mode for agent ${page.id}`,
        "",
        `Agent software address: ${address}`,
        `Agent wallet: ${page.acctAddr}`,
        limitNote(limitWei),
        "",
        ...chk.warnings,
        OPERATOR_RULE,
        "",
        lv === 3 ? "FULL TRUST: this address can call any contract for the agent, including moving the tokens and NFTs in this agent's wallet through other apps. Only the ETH is capped." : lv === 2 ? "This address can act alone only on actions you allow one by one. Allow none and it can do nothing." : "This address can only suggest actions; you approve each one.",
        "It can never touch your own wallet or sign for you. A transfer of the agent ends this setup.",
      ];
      if (!confirm(lines.join("\n"))) return;
      if (await send(`${MODE_NAMES[lv]} mode`, async () => (await accountC(page.signer)).configure(address, lv, limitWei, DAY))) page.refresh();
    };
    return h("details", { class: "own-software", open }, h("summary", {}, "Use my own agent software"), h("p", { class: "muted small" }, lv === 3 ? "Full trust. Type the last 4 characters of the agent wallet address to confirm." : "Software you run yourself, with a key you keep."), h("div", { class: "row" }, addr, limit, typed, apply));
  }

  async function sameAccount() {
    if (!page.signer) return toast("Connect your wallet first.", true), false;
    if (!same(page.signer.addressChecksum, holder())) return toast("Connect the wallet that holds this agent.", true), false;
    return page.walletAgrees();
  }

  // ---------------------------------------------------------------- Manual again: revoke
  async function revokeFlow() {
    if (!(await sameAccount())) return;
    const hasKey = rec && op() && same(rec.address, op());
    if (!confirm(`Switch to Manual\n\nThis removes the agent software that can act for agent ${page.id}:\n${op()}\n\nIt stops at once and its allowed actions are cleared.${hasKey ? "\n\nThe agent key in this browser keeps its leftover gas money; you can send it back to your wallet afterwards." : ""}`)) return;
    await stopRunner();
    wallet = null; // the key is locked again; sending its leftover ETH back asks for the passphrase
    if (await send("Manual mode", async () => (await accountC(page.signer)).revokeOperator())) await page.refresh();
  }

  // ---------------------------------------------------------------- Assisted: the key in this browser
  const keyLine = () => h("p", { class: "muted small" }, "Agent key: ", h("span", { class: "mono" }, rec.address));
  const pass = (label, extra = {}) => h("input", { type: "password", placeholder: label, "aria-label": label, autocomplete: "new-password", ...extra });

  function assistedPane(mode) {
    const out = [
      current(mode),
      h("p", { class: "muted small" }, `This page uses the key for two things: sending itself a little gas money from the agent wallet when it runs low, and, only if you set a balance to keep, sending the surplus above it to your own address. Both count against the daily limit. It runs only while this page is open and visible. Network gas applies to the setup and to everything the key does.`),
      h("p", { class: "console-item warn" }, KEY_RISK_TEXT),
    ];
    if (storeNote) out.push(h("p", { class: "console-item warn" }, storeNote));
    if (!rec) out.push(createForm());
    else if (!wallet) out.push(keyLine(), unlockForm());
    else out.push(keyLine(), enabledOnChain() ? runPanel() : setupForm());
    out.push(ownSoftware(2));
    return out;
  }

  const enabledOnChain = () => st && rec && same(st.operator, rec.address) && st.level === 2 && st.allowed?.operator && st.allowed?.holder;

  function createForm() {
    const p1 = pass("Passphrase (12+ characters)");
    const p2 = pass("Repeat the passphrase");
    const go = h("button", { class: "btn sm primary", type: "button" }, "Create an agent key in this browser");
    go.onclick = async () => {
      if (p1.value !== p2.value) return toast("The two passphrases differ.", true);
      const bad = checkPassphrase(p1.value);
      if (bad) return toast(bad, true);
      go.disabled = true;
      toast("Creating and locking the key (a few seconds)…");
      try {
        const made = await createKey({ ethers: E, passphrase: p1.value });
        rec = await saveKey(store, { chainId: CONFIG.chainId, account: page.acctAddr, tokenId: page.id, holder: holder() }, made.json, made.address);
        wallet = made.wallet;
        toast("Key created. Export the key file now: if this browser forgets it, only the file can bring it back.");
      } catch (e) {
        if (e.code === "EXISTS") rec = await loadRecord(store, kid()); // another tab made one first: keep it, never overwrite
        toast(e.code === "EXISTS" ? e.message : friendlyError(e), true);
      }
      p1.value = p2.value = "";
      go.disabled = false;
      await look(true);
    };
    const file = h("input", { type: "file", accept: ".json,application/json", "aria-label": "Key file to import" });
    const ip = pass("Passphrase of that file");
    const imp = h("button", { class: "btn sm", type: "button" }, "Import a key file");
    imp.onclick = async () => {
      const f = file.files?.[0];
      if (!f) return toast("Choose the key file you exported.", true);
      try {
        toast("Opening the file (a few seconds)…");
        const next = await importKeystore({ ethers: E, text: f.size > 20000 ? "" : await f.text(), passphrase: ip.value, meta: { chainId: CONFIG.chainId, account: page.acctAddr, tokenId: page.id, holder: holder() } });
        if (!confirm(`Import this agent key?\n\nKey address: ${next.address}\n\nImport only a file you exported yourself from this page. A file from anyone else holds a key they know. Once imported, this key is not the agent's operator: it only acts after you turn Assisted on with it.`)) return;
        try {
          await putRecord(store, next);
        } catch (e) {
          if (e.code !== "EXISTS") throw e;
          if (!confirm("A key for this agent is already stored in this browser. Replace it with the imported one? Without a file you exported, the old key cannot be recovered.")) return;
          await putRecord(store, next, { replace: true });
        }
        rec = next;
        wallet = await unlockKey({ ethers: E, record: rec, passphrase: ip.value });
        toast("Key imported.");
      } catch (e) {
        toast(e.message || "Could not import that file.", true);
      }
      ip.value = "";
      await look(true);
    };
    return h("div", {}, h("div", { class: "row" }, p1, p2, go), h("details", { class: "own-software" }, h("summary", {}, "I already have a key file"), h("div", { class: "row" }, file, ip, imp)));
  }

  function unlockForm() {
    const p = pass("Passphrase", { autocomplete: "current-password" });
    const un = h("button", { class: "btn sm primary", type: "button" }, "Unlock for this visit");
    un.onclick = async () => {
      try {
        wallet = await unlockKey({ ethers: E, record: rec, passphrase: p.value });
      } catch (e) {
        toast(e.message, true);
      }
      p.value = "";
      idle.touch();
      renderPane(true);
    };
    return h("div", {}, h("div", { class: "row" }, p, un), keyActions());
  }

  function keyActions() {
    const exp = h("button", { class: "btn sm", type: "button" }, "Export the key file");
    exp.onclick = () => {
      const f = exportKeystore(rec);
      download(f.filename, f.text);
    };
    const forget = h("button", { class: "btn sm danger", type: "button" }, "Forget this key");
    forget.onclick = async () => {
      const live = st && same(st.operator, rec.address);
      if (!confirm(`Forget the agent key ${rec.address} in this browser?\n\n${live ? "It is still the agent's operator. Switch to Manual first, or the agent keeps an operator nobody here controls.\n\n" : ""}Without the exported file it cannot be recovered.`)) return;
      await stopRunner();
      await forgetKey(store, rec.id);
      rec = null;
      wallet = null;
      await look(true);
    };
    return h("div", { class: "row" }, exp, forget);
  }

  const keepKey = () => `openforge-agent-keep:${kid()}`;
  const readKeep = () => {
    try {
      return parseKeep(storage?.getItem(keepKey()), E.parseEther).wei ?? null; // a damaged or negative saved value means no sweeping
    } catch {
      return null;
    }
  };

  function setupForm() {
    const limit = h("select", { "aria-label": "Daily limit" }, BUILTIN_LIMITS.map((v) => h("option", { value: v, selected: v === DEFAULT_LIMIT }, `${v} ETH`)));
    const keep = h("input", { type: "text", inputmode: "decimal", placeholder: "Keep at least … ETH (empty = never sweep)", "aria-label": "ETH to keep in the agent wallet", value: storage?.getItem(keepKey()) ?? "" });
    const go = h("button", { class: "btn sm primary", type: "button" }, "Turn Assisted on with this key");
    go.onclick = async () => {
      if (!(await sameAccount())) return;
      const limitWei = E.parseEther(limit.value);
      const pk = parseKeep(keep.value, E.parseEther);
      if (pk.error) return toast(pk.error, true);
      const keepWei = pk.wei;
      const perms = permissionsFor({ operator: rec.address, holder: holder() });
      const keyBal = await (await provider()).getBalance(rec.address);
      const needFloat = keyBal < REFUEL_BELOW;
      if (!confirm([
        `Turn Assisted on for agent ${page.id}`,
        "",
        `Agent key (acts alone, in this browser): ${rec.address}`,
        `Agent wallet it draws from: ${page.acctAddr}`,
        `Your address (receives the surplus): ${holder()}`,
        "",
        limitNote(limitWei),
        "",
        KEY_RISK_TEXT,
        keepWei === null ? "Sweeping the surplus to you is OFF." : `Sweeping is ON: the agent wallet keeps at least ${fmtEth(keepWei)} ETH and the key sends the rest to you.`,
        "It cannot touch your own wallet or sign for you. A transfer of the agent ends all this.",
        "",
        `You will sign ${needFloat ? 4 : 3} transactions (network gas applies): set the mode, allow the ${ACTIONS.refuel.label.toLowerCase()} action, allow the ${ACTIONS.sweep.label.toLowerCase()} action${needFloat ? `, and send the key ${fmtEth(GAS_FLOAT)} ETH for gas` : ""}.`,
      ].join("\n"))) return;
      const c = () => accountC(page.signer);
      const steps = [
        ["Set Assisted mode", async () => (await c()).configure(rec.address, 2, limitWei, DAY)],
        [`Allow: ${ACTIONS.refuel.label}`, async () => (await c()).setPermission(perms[0].target, perms[0].selector, true)],
        [`Allow: ${ACTIONS.sweep.label}`, async () => (await c()).setPermission(perms[1].target, perms[1].selector, true)],
      ];
      if (needFloat) steps.push([`Send the key ${fmtEth(GAS_FLOAT)} ETH for gas`, () => page.signer.sendTransaction({ to: rec.address, value: GAS_FLOAT })]);
      for (const [label, fn] of steps) if (!(await send(label, fn))) return toast("Stopped. Nothing else was sent; you can start again.", true);
      try {
        if (keepWei === null) storage?.removeItem(keepKey());
        else storage?.setItem(keepKey(), keep.value.trim());
      } catch {}
      await page.refresh();
      startRunner();
    };
    return h("div", {}, h("div", { class: "row" }, limit, keep, go), keyActions());
  }

  const statusLine = h("p", { class: "console-item info", "aria-live": "polite" });
  const logBox = h("ul", { class: "journal-list" });

  function runPanel() {
    const active = runner && !runner.stopped;
    const toggle = h("button", { class: `btn sm ${active ? "" : "primary"}`, type: "button" }, active ? "Stop the key" : "Start the key");
    toggle.onclick = () => (active ? relock("Stopped. The key is locked again: unlock it with your passphrase to start it.") : startRunner());
    const swp = h("button", { class: "btn sm", type: "button" }, "Send the key's gas money back to me");
    swp.onclick = sweepKey;
    renderLog();
    return h("div", {}, h("p", { class: "muted small" }, limitNote(st.periodLimit)), statusLine, h("div", { class: "row" }, toggle, swp), logBox, keyActions());
  }

  function renderLog() {
    const acts = readActivity(storage, kid()).slice(-5).reverse();
    logBox.replaceChildren(...acts.map((a) => h("li", {}, `${new Date(a.at * 1000).toISOString().slice(0, 16).replace("T", " ")} · ${ACTIONS[a.id]?.label ?? a.id} · ${fmtEth(a.value)} ETH to ${a.to} · ${a.tx}`)));
  }

  async function startRunner() {
    if (!wallet || !rec) return;
    await stopRunner(); // any round of an old runner finishes first: two never sign with the same nonce
    idle.touch();
    runner = createRunner({
      record: rec,
      keep: readKeep(),
      gate,
      readState: readChain,
      keyBalance: async (blockTag) => (await provider()).getBalance(rec.address, blockTag),
      execute: async (call) => {
        const tx = await (await accountC(wallet.connect(await provider()))).execute(call.to, call.value, "0x", 0);
        const receipt = await withTimeout(tx.wait(), CONFIRM_MS, `The transaction ${tx.hash} was sent but not confirmed in ${CONFIRM_MS / 60000} minutes. The key will not send it again. Check it on the explorer, then start the key again.`);
        return { hash: tx.hash, blockNumber: receipt.blockNumber };
      },
      log: (e) => (logActivity(storage, kid(), e), renderLog(), look()),
      visible: () => document.visibilityState === "visible",
      onStatus: (s) => (statusLine.textContent = s.message),
      onStop: (m) => ((statusLine.textContent = m), clearInterval(timer), renderPane(true)),
    });
    timer = setInterval(() => runner.tick(), 30_000);
    runner.tick();
    renderPane(true);
  }
  let timer = null;
  /** Stops the loop and waits for any round (and so any send) already under way. */
  async function stopRunner() {
    clearInterval(timer);
    timer = null;
    if (runner) await runner.stop();
    else await gate.run(async () => {});
  }
  /** Stops the loop and forgets the unlocked key; the passphrase is needed again. */
  function relock(message) {
    return stopRunner().then(() => {
      wallet = null;
      if (message) toast(message);
      renderPane(true);
    });
  }

  // the key sends its own ETH back to the holder, keeping only the fee of that transfer
  async function sweepKey() {
    if (!wallet) return toast("Unlock the key first.", true);
    await stopRunner(); // the loop must not sign at the same time (same nonce); it is started again by hand
    const w = wallet;
    await gate.run(async () => {
      const p = await provider();
      const fee = await p.getFeeData();
      const price = fee.maxFeePerGas ?? fee.gasPrice;
      const bal = await p.getBalance(rec.address);
      const value = sweepKeyValue(bal, price);
      if (value === 0n) return toast("The key holds too little to send back.");
      if (!confirm(`Send the agent key's ETH back to your wallet?\n\nFrom (agent key): ${rec.address}\nTo (you): ${holder()}\nAmount: ${fmtEth(value)} ETH (the key keeps what the network fee needs)\n\nThe loop of the key is stopped while this is sent.`)) return;
      try {
        toast("Sending the key's ETH back…");
        const tx = await w.connect(p).sendTransaction({ to: holder(), value, gasLimit: 21000n, maxFeePerGas: price, maxPriorityFeePerGas: fee.maxPriorityFeePerGas ?? 0n });
        await withTimeout(tx.wait(), CONFIRM_MS, `The transaction ${tx.hash} was sent but not confirmed in ${CONFIRM_MS / 60000} minutes. It will not be sent again; check it on the explorer.`);
        toast("Done: the key's ETH is back in your wallet.");
      } catch (e) {
        toast(e?.halt ? e.message : friendlyError(e), true);
      }
    });
    renderPane(true);
  }

  // ---------------------------------------------------------------- mount
  const section = (title, ...kids) => h("section", { class: "console-sec" }, h("h4", {}, title), ...kids);
  body.replaceChildren(
    h("p", { class: "muted small" }, "Runs in this browser, free of project servers, and only while this page is open. It watches and suggests; you do each action."),
    section("Wallet watch", watchBox),
    section("Mission coach", coachBox),
    section("Weekly report", reportBox),
    section("Assisted practice journal", journalBox)
  );
  renderJournal();
  rec = await loadRecord(store, kid()).catch(() => null);
  setInterval(() => document.visibilityState === "visible" && look(), 60_000);
  setInterval(() => idle.tick(Boolean(wallet && runner && !runner.stopped && document.visibilityState === "visible")), 30_000);
  for (const ev of ["pointerdown", "keydown"]) document.addEventListener(ev, idle.touch); // the holder is here
  document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && runner && !runner.stopped && runner.tick());
  await look();

  return {
    selectMode(lv) {
      level = lv;
      paneOpen = true;
      renderPane(true);
    },
    async update() {
      labCache = null;
      await look(true);
    },
  };
}
