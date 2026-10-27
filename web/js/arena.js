import { keccak256, toUtf8Bytes, hexlify, randomBytes, ZeroHash } from "./proving/hash.js";
import { CONFIG } from "./config.js";
import { loadConfig, renderChrome, onWallet, ownedBy, tokenMeta, attr, toast, friendlyError, isDeployed, short } from "./chain.js";
import { initialState, step, replay, score, fk, ik, limitStep, REST, LIMITS, DT, MAX_TICKS, FPS } from "./sim/arm-sim.js";
import { buildEpisode, canonicalize, runTypedData, trialTypedData } from "./sim/episode.js";
import { autopilot } from "./sim/autopilot.js";
import { createArenaView } from "./sim/arena-view.js";
import { createRecorder, recordingSupported, saveVideo } from "./recorder.js";
import { ROBOTS } from "./models/robots.js";
import { ORDER } from "./bench/content.js";
import { MISSIONS } from "./bench/missions/index.js";

await loadConfig();
renderChrome("arena");

const $ = (id) => document.getElementById(id);
const view = createArenaView($("view"), { preserveDrawingBuffer: true });
let trialId = null; // a pilot-trial challenge (guest with a wallet): the run can enter the pre-mint ranking

// ---------------------------------------------------------------- clip recording
let recArmed = false;
let rec = null;
$("recBtn").hidden = !recordingSupported();
$("recBtn").onclick = () => {
  recArmed = !recArmed;
  $("recBtn").textContent = recArmed ? "● Recording armed" : "Record clip";
  if (recArmed) toast("The next run or demo will be recorded. The video downloads when it ends.");
};
function recStart(subtitle) {
  if (!recArmed) return;
  rec = createRecorder({ left: $("view"), title: "OPENFORGE AX · PROVING GROUNDS", subtitle });
  rec.start();
}
async function recStop(name) {
  if (!rec) return;
  const r = rec;
  rec = null;
  await new Promise((ok) => setTimeout(ok, 1200)); // keep the ending in the clip
  saveVideo(await r.stop(), `openforge-${name}-${Date.now()}.${r.ext}`);
  recArmed = false;
  $("recBtn").textContent = "Record clip";
}
const api = (CONFIG.provingApi || "").replace(/\/$/, "");
let signer = null;
let apiOnline = false;
const healthy = api ? fetch(`${api}/health`).then((r) => r.ok).catch(() => false) : Promise.resolve(false);
let myAgents = []; // [{ id, name, className }] of the connected wallet
// declared before onWallet: it reports the current wallet at once, before the bottom section runs
let lab = null; // lab-trials.js, loaded on first use
let labLoading = null; // one instance even when robots are picked quickly
const current = { id: null, mode: null };

// ---------------------------------------------------------------- run state
let mode = "easy";
let running = false;
let ghost = null;
let s = initialState(hexlify(randomBytes(32)));
let seed, challengeId, actions, cmd, desired, target, gripOpen, lastOutcome;
const keys = new Set();
view.update(s);

const pilotId = () => Number($("pilot").value);

function setMode(m) {
  mode = m;
  $("modeEasy").classList.toggle("sel", m === "easy");
  $("modePro").classList.toggle("sel", m === "pro");
  $("modeEasy").setAttribute("aria-pressed", String(m === "easy"));
  $("modePro").setAttribute("aria-pressed", String(m === "pro"));
  $("helpEasy").hidden = m !== "easy";
  $("helpPro").hidden = m !== "pro";
  $("pad").hidden = m !== "easy";
}
$("modeEasy").onclick = () => setMode("easy");
$("modePro").onclick = () => setMode("pro");
setMode("easy");

async function startRun() {
  ghost = null;
  challengeId = ZeroHash;
  trialId = null;
  seed = hexlify(randomBytes(32));
  if (!pilotId() && apiOnline && signer) {
    // guest with a wallet: a server-issued mission, so the run can enter the pilot ranking
    try {
      const r = await fetch(`${api}/trial/challenge?wallet=${signer.addressChecksum}`);
      const body = await r.json();
      if (r.ok) ({ seed, challengeId: trialId } = body);
    } catch {}
  }
  if (pilotId() && apiOnline && signer) {
    try {
      const r = await fetch(`${api}/challenge?tokenId=${pilotId()}&owner=${signer.addressChecksum}`);
      const body = await r.json();
      if (!r.ok) throw new Error(body.error);
      ({ seed, challengeId } = body);
    } catch (e) {
      toast(`Could not get a mission from the server (${e.message}). Playing as guest.`, true);
      $("pilot").value = "0";
    }
  }
  if ($("armTrial").hidden) return; // the pilot switched robot while the mission request was in flight
  s = initialState(seed);
  actions = [];
  cmd = REST.slice();
  desired = REST.slice();
  const tip = fk(REST).tip;
  target = { r: Math.hypot(tip.x, tip.y), a: Math.atan2(tip.y, tip.x), z: tip.z };
  gripOpen = true;
  running = true;
  $("overlay").hidden = true;
  $("resultPanel").hidden = true;
  view.update(s);
  recStart(pilotId() ? "Energy Cell mission · verified agent run" : "Energy Cell mission · digital twin of the SO-101");
}

function inputTick() {
  const k = (c) => (keys.has(c) ? 1 : 0);
  if (mode === "easy") {
    const next = {
      r: target.r + (k("ArrowUp") + k("KeyW") - k("ArrowDown") - k("KeyS")) * 0.1 * DT,
      a: target.a + (k("ArrowLeft") + k("KeyA") - k("ArrowRight") - k("KeyD")) * 1.2 * DT,
      z: Math.max(0.012, target.z + (k("KeyR") + k("KeyQ") - k("KeyF") - k("KeyE")) * 0.08 * DT),
    };
    const j = ik({ x: next.r * Math.cos(next.a), y: next.r * Math.sin(next.a), z: next.z }, 0, gripOpen ? 100 : 0);
    if (j) {
      target = next;
      desired = j;
    }
    desired[5] = gripOpen ? 100 : 0;
  } else {
    const map = [["KeyQ", "KeyA"], ["KeyW", "KeyS"], ["KeyE", "KeyD"], ["KeyR", "KeyF"], ["KeyT", "KeyG"]];
    map.forEach(([up, down], i) => {
      desired[i] = Math.min(LIMITS[i][1], Math.max(LIMITS[i][0], desired[i] + (k(up) - k(down)) * 4));
    });
    desired[5] = gripOpen ? 100 : 0;
  }
  cmd = limitStep(cmd, desired);
  actions.push(cmd);
  step(s, cmd);
}

function hud() {
  $("hudTime").textContent = `${Math.max(0, (MAX_TICKS - s.tick) / FPS).toFixed(1)}s`;
  $("hudState").textContent = ghost ? "DEMO" : running ? (s.cell.mode === "held" ? "CELL SECURED" : "RUNNING") : s.success ? "DOCKED" : "READY";
  $("hudGrip").textContent = s.joints[5] > 50 ? "GRIPPER OPEN" : "GRIPPER CLOSED";
}

// fixed 30 Hz simulation clock, decoupled from the render frame rate
let acc = 0;
let last = performance.now();
function loop(now) {
  if ($("armTrial").hidden) {
    last = now; // paused while the lab trials are shown
    return requestAnimationFrame(loop);
  }
  acc += Math.min(0.25, (now - last) / 1000);
  last = now;
  while (acc >= DT) {
    acc -= DT;
    if (running) {
      inputTick();
      if (s.done) endRun();
    } else if (ghost) {
      step(s, ghost.actions[ghost.i++]);
      if (s.done || ghost.i >= ghost.actions.length) {
        ghost = null;
        showOverlay("Demo complete", "That is what a clean run looks like. Your turn.");
        recStop("demo");
      }
    }
  }
  view.update(s);
  hud();
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);

function showOverlay(title, text) {
  $("ovTitle").textContent = title;
  $("ovText").textContent = text;
  $("startBtn").textContent = "Try again";
  $("overlay").hidden = false;
}

function endRun() {
  running = false;
  lastOutcome = replay(seed, actions);
  rememberRun();
  const q = score(lastOutcome);
  const e = lastOutcome.events;
  $("result").innerHTML = `
    <div><small>Outcome</small>${lastOutcome.success ? "✔ Docked" : "✘ " + lastOutcome.reason}</div>
    <div><small>Time</small>${lastOutcome.seconds}s</div>
    <div><small>Quality</small>${q.toLocaleString("en-US")}</div>
    <div><small>Events</small>${e.grasps} grasps · ${e.drops} drops · ${e.misses} misses</div>`;
  const recordable = pilotId() > 0 && challengeId !== ZeroHash;
  const trial = !pilotId() && trialId && lastOutcome.success;
  $("submitBtn").hidden = !recordable;
  $("trialBtn").hidden = !trial;
  $("trialBtn").disabled = false;
  $("submitInfo").textContent = recordable
    ? "Saving is free: you sign a message (no gas). The server replays your run and adds it to your agent's on-chain record."
    : trial
      ? "Submit it to the pilot ranking: a free signature (no gas). The server replays your run and ranks your best times."
      : apiOnline && !signer
        ? "Guest run. Connect any wallet before your next run to enter the pilot ranking (allowlist)."
        : "Guest run: not recorded.";
  recStop(lastOutcome.success ? "docked" : "run");
  $("resultPanel").hidden = false;
  showOverlay(lastOutcome.success ? "Cell docked" : "Mission failed", lastOutcome.success ? `Docked in ${lastOutcome.seconds}s.` : "Failures are data too. Try again.");
}

async function submitRun() {
  if (!signer) return toast("Connect your wallet first.", true);
  $("submitBtn").disabled = true;
  try {
    const episode = buildEpisode({ tokenId: pilotId(), challengeId, seed, actions });
    const episodeHash = keccak256(toUtf8Bytes(canonicalize(episode)));
    const deadline = Math.floor(Date.now() / 1000) + 600;
    const td = runTypedData({ chainId: CONFIG.chainId, verifyingContract: CONFIG.reputation, tokenId: pilotId(), challengeId, episodeHash, deadline });
    toast("Sign the run in your wallet (free, no gas)…");
    const signature = await signer.signTypedData(td.domain, td.types, td.value);
    const r = await fetch(`${api}/episodes`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ episode, signature, deadline }) });
    const body = await r.json();
    if (!r.ok) throw new Error(body.error);
    $("submitInfo").textContent = body.attest
      ? `Verified ✔ Quality ${body.quality.toLocaleString("en-US")}. It will appear on your agent after the next on-chain batch.`
      : `Verified ✔ Stored as data (${body.note}).`;
    toast("Run verified by the Proving Grounds ✔");
    loadBoard();
  } catch (e) {
    toast(friendlyError(e), true);
    $("submitBtn").disabled = false;
  }
}

/** Keeps the latest run for Robot Link ("Play on my real robot"). Per-browser convenience only. */
function rememberRun() {
  try {
    localStorage.setItem("openforge.lastRun", JSON.stringify(buildEpisode({ tokenId: pilotId(), challengeId, seed, actions })));
  } catch {}
}

function downloadRun() {
  const episode = buildEpisode({ tokenId: pilotId(), challengeId, seed, actions });
  const { states } = replay(seed, actions, { record: true });
  const blob = new Blob([JSON.stringify({ ...episode, observation_state: states, outcome: lastOutcome }, null, 1)], { type: "application/json" });
  const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: `openforge-run-${pilotId() || "guest"}-${Date.now()}.json` });
  a.click();
  URL.revokeObjectURL(a.href);
}

function watchDemo() {
  running = false;
  const sd = hexlify(randomBytes(32));
  s = initialState(sd);
  ghost = { actions: autopilot(sd), i: 0 };
  $("overlay").hidden = true;
  recStart("Energy Cell mission · demo run on the digital twin");
}

async function submitTrial() {
  if (!signer || !trialId) return;
  $("trialBtn").disabled = true;
  try {
    const episode = buildEpisode({ tokenId: 0, challengeId: trialId, seed, actions });
    const episodeHash = keccak256(toUtf8Bytes(canonicalize(episode)));
    const deadline = Math.floor(Date.now() / 1000) + 600;
    const td = trialTypedData({ chainId: CONFIG.chainId, wallet: signer.addressChecksum, challengeId: trialId, episodeHash, deadline });
    toast("Sign the run in your wallet (free, no gas)…");
    const signature = await signer.signTypedData(td.domain, td.types, td.value);
    const r = await fetch(`${api}/trial/episodes`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ episode, signature, deadline }) });
    const body = await r.json();
    if (!r.ok) throw new Error(body.error);
    $("submitInfo").textContent = `Verified ✔ ${body.best ? "New personal best! " : ""}Best ${Number(body.bestSeconds).toFixed(2)}s · ${Number(body.successes)} docked runs.${body.eligible ? " You meet the allowlist rule." : ""}`;
    toast("Run verified and ranked ✔");
    loadTrialBoard();
  } catch (e) {
    toast(friendlyError(e), true);
    $("trialBtn").disabled = false;
  }
}

async function loadTrialBoard() {
  try {
    const { top, rule } = await (await fetch(`${api}/trial/leaderboard`)).json();
    $("trialRule").textContent = String(rule || "").replace(/^eligible: /, "");
    const rows = top
      .slice(0, 10)
      .filter((t) => /^0x[0-9a-fA-F]{40}$/.test(t.wallet)) // a self-hosted verifier is not trusted
      .map((t, i) => `<tr><td>#${i + 1} <span class="mono">${short(t.wallet)}</span>${t.eligible ? " ✔" : ""}</td><td>${t.score === null ? "—" : Number(t.score).toFixed(2) + "s"} · ${Number(t.successes) | 0} docked</td></tr>`);
    $("trialBoard").innerHTML = rows.length ? `<table class="trait-table">${rows.join("")}</table>` : "No pilots yet. Be the first.";
    $("trialPanel").hidden = false;
  } catch {
    $("trialPanel").hidden = true;
  }
}

$("startBtn").onclick = startRun;
$("ghostBtn").onclick = watchDemo;
$("submitBtn").onclick = submitRun;
$("trialBtn").onclick = submitTrial;
$("downloadBtn").onclick = downloadRun;

// ---------------------------------------------------------------- input
const GAME_KEYS = new Set(["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Space", "KeyW", "KeyA", "KeyS", "KeyD", "KeyQ", "KeyE", "KeyR", "KeyF", "KeyT", "KeyG"]);
// the mission keys never take a key from a field, and Space still presses a focused button outside the pad (WCAG 2.1.4)
const typing = (t) => t.closest?.("input, textarea, select, [contenteditable]");
const ownsSpace = (t) => t.closest?.("button, a[href], summary") && !t.closest("#pad");
addEventListener("keydown", (e) => {
  if (!running || $("armTrial").hidden || !GAME_KEYS.has(e.code) || typing(e.target) || (e.code === "Space" && ownsSpace(e.target))) return;
  e.preventDefault();
  if (e.code === "Space") {
    if (!e.repeat) gripOpen = !gripOpen;
  } else keys.add(e.code);
});
addEventListener("keyup", (e) => keys.delete(e.code));
addEventListener("blur", () => keys.clear());
for (const b of document.querySelectorAll("#pad button")) {
  const k = b.dataset.k;
  if (k === "Space") b.addEventListener("click", () => running && (gripOpen = !gripOpen));
  else {
    b.addEventListener("pointerdown", (e) => (e.preventDefault(), keys.add(k), b.classList.add("on")));
    for (const ev of ["pointerup", "pointerleave", "pointercancel", "blur"]) b.addEventListener(ev, () => (keys.delete(k), b.classList.remove("on")));
    // keyboard: hold Enter or Space on a focused pad button, like holding it with the mouse
    const held = (e) => e.key === "Enter" || e.key === " ";
    b.addEventListener("keydown", (e) => held(e) && (e.preventDefault(), e.stopPropagation(), keys.add(k), b.classList.add("on")));
    b.addEventListener("keyup", (e) => held(e) && (e.stopPropagation(), keys.delete(k), b.classList.remove("on")));
  }
}

// ---------------------------------------------------------------- pilots, server, leaderboard
onWallet(async (sg) => {
  signer = sg;
  myAgents = [];
  lab?.refreshPilots();
  if (!sg || !isDeployed()) return;
  const ids = await ownedBy(sg.addressChecksum);
  const metas = await Promise.all(ids.map((id) => tokenMeta(id)));
  const arms = ids.filter((_, i) => attr(metas[i], "Class") === "Synth Arm");
  for (const id of arms) $("pilot").add(new Option(metas[ids.indexOf(id)].name, String(id)));
  const wanted = Number(new URLSearchParams(location.search).get("pilot"));
  if (arms.length) $("pilot").value = String(arms.includes(wanted) ? wanted : arms[0]);
  $("pilotInfo").textContent = arms.length
    ? "Your Synth Arm runs are verified and added to its on-chain record."
    : "None of your agents is a Synth Arm. Pick your agent's robot above to fly its lab trials, or play as guest.";
  if (signer !== sg) return; // another wallet event won while these loaded
  myAgents = ids.map((id, i) => ({ id, name: metas[i].name, className: attr(metas[i], "Class") }));
  lab?.refreshPilots();
});

async function loadBoard() {
  if (!api) return ($("board").textContent = "Leaderboard offline.");
  try {
    const { top } = await (await fetch(`${api}/leaderboard`)).json();
    $("board").innerHTML = top.length
      ? `<table class="trait-table">${top
          .slice(0, 50)
          .map((t, i) => [i, Number(t.tokenId) | 0, Number(t.bestSeconds), Number(t.successes) | 0, Number(t.runs) | 0]) // a self-hosted verifier is not trusted
          .map(([i, id, best, ok, runs]) => `<tr><td>#${i + 1} <a href="agent.html?id=${id}">AX-${String(id).padStart(4, "0")}</a></td><td>${best.toFixed(2)}s · ${ok}/${runs}</td></tr>`)
          .join("")}</table>`
      : "No verified runs yet. Be the first.";
  } catch {
    $("board").textContent = "Leaderboard offline.";
  }
}

(async () => {
  if (!api) return loadBoard();
  apiOnline = await healthy;
  loadBoard();
  if (apiOnline) loadTrialBoard();
})();

// ---------------------------------------------------------------- every robot: picker, Synth Arm modes, lab trials
/** One spoken line per robot or mode change (#labStatus stays outside both sections). */
function announce(text) {
  $("labStatus").textContent = "";
  setTimeout(() => ($("labStatus").textContent = text), 60);
}
const LEAD_ENERGY = $("pgLead").textContent;
const picker = $("pgRobots");
for (const [i, id] of ORDER.entries()) {
  const li = document.createElement("li");
  const b = document.createElement("button");
  b.type = "button";
  b.dataset.id = id;
  const n = document.createElement("small");
  n.textContent = String(i + 1).padStart(2, "0");
  n.setAttribute("aria-hidden", "true");
  b.append(n, document.createTextNode(ROBOTS[id].name));
  b.onclick = () => (id === current.id ? null : select(id, id === "so101" ? "energy" : "lab"));
  li.append(b);
  picker.append(li);
}
$("pgEnergy").onclick = () => select("so101", "energy");
$("pgArmLab").onclick = () => select("so101", "lab");

async function select(id, mode, { push = true } = {}) {
  const energy = id === "so101" && mode === "energy";
  Object.assign(current, { id, mode: energy ? "energy" : "lab" });
  picker.querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.id === id)));
  $("pgModes").hidden = id !== "so101";
  $("pgEnergy").setAttribute("aria-pressed", String(energy));
  $("pgArmLab").setAttribute("aria-pressed", String(id === "so101" && !energy));
  if (push) history.replaceState(null, "", energy ? location.pathname + location.search : `#${id}${id === "so101" ? "/lab" : ""}`);
  if (!energy && (running || ghost)) {
    running = false;
    ghost = null;
    rec = null; // an armed clip is dropped, not saved half-way
    showOverlay("Ready", "Press Start, then use the controls below.");
  }
  view.setPaused(!energy);
  $("armTrial").hidden = !energy;
  $("labTrial").hidden = energy;
  if (energy) {
    lab?.hide();
    $("pgKicker").textContent = "SO-101 twin";
    $("pgTitle").textContent = "Mission: Energy Cell";
    $("pgLead").textContent = LEAD_ENERGY;
    if (push) announce("Mission: Energy Cell.");
    return;
  }
  const levels = MISSIONS[id].levels.map((l, k) => `L${k + 1} ${l.title}`).join(", ");
  $("pgKicker").textContent = "Lab trials";
  $("pgTitle").textContent = `Test: ${ROBOTS[id].name}`;
  $("pgLead").textContent = `Three trials in the lab sim: ${levels}. Fly as guest, or fly your agent: passed runs are replayed by the verifier and added to its on-chain record.`;
  labLoading ??= import("./proving/lab-trials.js").then(({ createLabTrials }) => createLabTrials({ api, isOnline: () => healthy, getSigner: () => signer, getAgents: async () => myAgents, toast, friendlyError }));
  try {
    lab = await labLoading;
  } catch (e) {
    labLoading = null;
    return toast(`The lab trials could not load (${e.message}). Reload the page to try again.`, true);
  }
  if (current.id !== id || current.mode !== "lab") return; // another pick won while loading
  await lab.show(id);
  if (push) announce(`Test: ${ROBOTS[id].name}. Three lab trials.`);
}
matchMedia("(prefers-reduced-motion: reduce)").addEventListener?.("change", (e) => lab?.setReduced(e.matches));

function fromHash() {
  const [id, sub] = location.hash.replace(/^#/, "").split("/");
  if (ORDER.includes(id)) select(id, id === "so101" && sub !== "lab" ? "energy" : "lab", { push: false });
  else select("so101", "energy", { push: false });
}
addEventListener("hashchange", fromHash);
fromHash();
