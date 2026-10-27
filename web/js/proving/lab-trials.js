// Proving Grounds lab trials: every Workbench robot, three levels each, in the same 3D lab as the Workbench.
// A guest run stays in this browser; an agent run gets a server mission (seed), is signed by the holder (EIP-712,
// free) and replayed by the verifier, which attests passes on-chain (scripts/proving-server.mjs, /lab/*).
import { keccak256, toUtf8Bytes } from "./hash.js";
import { CONFIG } from "../config.js";
import { ROBOTS, buildRobot } from "../models/robots.js";
import { NAMES } from "../traits-data.js";
import { createMissionRunner, createProgressStore } from "../bench/mission-runner.js";
import { createSpeaker, el, overviewLabels, resetRig as resetRigOf, staticLabelList } from "../bench/shared.js";
import { MISSIONS } from "../bench/missions/index.js";
import { canonicalize, runTypedData } from "../sim/episode.js";
import { LAB_SIM_ID, CLASS_ROBOT, OPEN_ROBOTS, buildLabEpisode, labMission } from "../sim/lab-episode.js";

const $ = (id) => document.getElementById(id);
const tokenLabel = (id) => `AX-${String(id).padStart(4, "0")}`;

/**
 * createLabTrials({ api, isOnline, getSigner, getAgents, toast, friendlyError })
 * getAgents() resolves [{ id, name, className }] for the connected wallet (empty for none).
 * Returns { show(robotId), hide(), refreshPilots() }.
 */
export async function createLabTrials({ api, isOnline, getSigner, getAgents, toast, friendlyError }) {
  const store = createProgressStore();
  let view = null, scenes = null, rig = null, runner = null, robotId = null, challenge = null, last = null;
  let reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  try {
    const viewMod = await import("../bench/bench-view.js");
    if (viewMod.hasWebGL() && !new URLSearchParams(location.search).has("nogl")) {
      scenes = await import("../bench/test-scenes.js");
      view = viewMod.createBenchView($("labView"), $("labLabels"), { reduced });
    }
  } catch (e) {
    console.warn("3D view unavailable", e);
    view = null;
  }
  $("labNoGL").hidden = !!view;
  $("labView").hidden = !view;
  $("labView").parentElement.classList.toggle("is-nogl", !view);

  const speak = createSpeaker($("labStatus"));
  const resetRig = () => resetRigOf(view, rig, $("labPhone"));

  // ---------------------------------------------------------------- pilots: own-class agents, any agent for AX-1
  const pilotId = () => Number($("labPilot").value);
  async function refreshPilots() {
    const sel = $("labPilot");
    const keep = sel.value;
    sel.replaceChildren(new Option("Guest (runs are not recorded)", "0"));
    if (!robotId) return;
    const agents = await getAgents().catch(() => []);
    const open = OPEN_ROBOTS.includes(robotId);
    const fit = agents.filter((a) => open || CLASS_ROBOT[NAMES.class.indexOf(a.className)] === robotId);
    for (const a of fit) sel.add(new Option(a.name, String(a.id))); // textContent, never HTML
    if (fit.some((a) => String(a.id) === keep)) sel.value = keep;
    else if (fit.length) sel.value = String(fit[0].id);
    const cls = CLASS_ROBOT.indexOf(robotId);
    $("labPilotInfo").textContent = !getSigner()
      ? "Connect your wallet to fly one of your agents: its passed runs are verified and added to its on-chain record."
      : fit.length
        ? `Runs flown by ${open ? "any of your agents" : `your ${NAMES.class[cls]}`} are verified and added to its on-chain record.`
        : open
          ? "You have no agents yet. You can still fly as guest."
          : `This robot is flown by ${NAMES.class[cls]} agents (and every agent flies the AX-1 bodies). You can still fly as guest.`;
  }

  // ---------------------------------------------------------------- runs
  async function beforeStart(level) {
    challenge = null;
    $("labResultPanel").hidden = true;
    const signer = getSigner();
    const robot = robotId, tokenId = pilotId();
    if (!tokenId || !signer || !(await isOnline())) return null;
    try {
      const q = new URLSearchParams({ tokenId: String(tokenId), owner: signer.addressChecksum, robot, level });
      const r = await fetch(`${api}/lab/challenge?${q}`);
      const body = await r.json();
      if (!r.ok) throw new Error(body.error);
      if (robot !== robotId) return null; // the pilot switched robot meanwhile
      challenge = { challengeId: body.challengeId, seed: body.seed, robot, level, tokenId };
      return { seed: body.seed };
    } catch (e) {
      toast(`Could not get a mission from the server (${e.message}). Flying as guest.`, true);
      return null;
    }
  }

  function onFinish({ robot, level, seed, actions, result, demo }) {
    if (demo) return;
    last = { robot, level, seed, actions, result };
    const recordable = !!challenge && challenge.robot === robot && challenge.level === level && challenge.seed === seed && result.pass;
    $("labSubmit").hidden = !recordable;
    $("labSubmit").disabled = false;
    $("labSubmitInfo").textContent = recordable
      ? "Saving is free: you sign a message (no gas). The verifier replays your run and adds the pass to your agent's on-chain record."
      : challenge && !result.pass
        ? "Only passed runs are recorded. Try again."
        : "Guest run: kept in this browser only.";
    $("labResultPanel").hidden = false;
  }

  async function submit() {
    const signer = getSigner();
    const ch = challenge, run = last;
    if (!signer) return toast("Connect your wallet first.", true);
    if (!ch || !run) return toast("This run has no server mission: fly it again with your agent selected.", true);
    $("labSubmit").disabled = true;
    try {
      const episode = buildLabEpisode({ tokenId: ch.tokenId, challengeId: ch.challengeId, robot: run.robot, level: run.level, seed: run.seed, actions: run.actions });
      const episodeHash = keccak256(toUtf8Bytes(canonicalize(episode)));
      const deadline = Math.floor(Date.now() / 1000) + 600;
      const td = runTypedData({ chainId: CONFIG.chainId, verifyingContract: CONFIG.reputation, tokenId: ch.tokenId, challengeId: ch.challengeId, episodeHash, deadline, mission: labMission(run.robot, run.level), sim: LAB_SIM_ID });
      toast("Sign the run in your wallet (free, no gas)…");
      const signature = await signer.signTypedData(td.domain, td.types, td.value);
      const r = await fetch(`${api}/lab/episodes`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ episode, signature, deadline }) });
      const body = await r.json();
      if (!r.ok) throw new Error(body.error);
      $("labSubmitInfo").textContent = body.attest ? `Verified ✔ Score ${Number(body.outcome.score) | 0}. It will appear on your agent after the next on-chain batch.` : `Verified ✔ Stored as data (${String(body.note)}).`;
      if (challenge === ch) challenge = null; // one mission, one run (a newer one stays)
      toast("Run verified by the Proving Grounds ✔");
      loadBoard();
    } catch (e) {
      toast(friendlyError(e), true);
      $("labSubmit").disabled = false;
    }
  }

  function download() {
    if (!last) return;
    const episode = buildLabEpisode({ tokenId: challenge?.tokenId || 0, challengeId: challenge?.challengeId || "0x", robot: last.robot, level: last.level, seed: last.seed, actions: last.actions });
    const blob = new Blob([JSON.stringify({ ...episode, outcome: last.result }, null, 1)], { type: "application/json" });
    const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: `openforge-lab-${last.robot}-${last.level}-${Date.now()}.json` });
    a.click();
    URL.revokeObjectURL(a.href);
  }
  $("labSubmit").onclick = submit;
  $("labDownload").onclick = download;

  // ---------------------------------------------------------------- leaderboard: top 5 per level, passes only
  async function loadBoard() {
    const box = $("labBoard");
    if (!api || !(await isOnline())) return void (box.textContent = "Leaderboard offline.");
    const id = robotId;
    try {
      const boards = await Promise.all(
        MISSIONS[id].levels.map((lv) =>
          fetch(`${api}/lab/leaderboard?robot=${id}&level=${lv.id}`).then((r) => {
            if (!r.ok) throw new Error(String(r.status));
            return r.json();
          }),
        ),
      );
      if (id !== robotId) return;
      const list = el("dl", "pg-board");
      MISSIONS[id].levels.forEach((lv, i) => {
        list.append(el("dt", null, `L${i + 1} · ${lv.title}`));
        const top = Array.isArray(boards[i].top) ? boards[i].top.slice(0, 5) : [];
        const dd = el("dd");
        if (!top.length) dd.textContent = "No verified passes yet.";
        for (const t of top) {
          const tid = Number(t.tokenId) | 0; // a self-hosted verifier is not trusted
          const a = el("a", null, tokenLabel(tid));
          a.href = `agent.html?id=${tid}`;
          const row = el("span", "pg-board-row");
          row.append(a, document.createTextNode(` ${Number(t.score) | 0} · ${Number(t.seconds).toFixed(1)} s`));
          dd.append(row);
        }
        list.append(dd);
      });
      box.replaceChildren(list);
    } catch {
      box.textContent = "Leaderboard offline.";
    }
  }

  // ---------------------------------------------------------------- show / hide
  async function show(id) {
    runner?.destroy();
    robotId = id;
    challenge = null;
    last = null;
    $("labResultPanel").hidden = true;
    $("labTitle").textContent = `${ROBOTS[id].name} · lab trials`;
    if (view) rig = view.setRobot(id);
    else $("labLabels").replaceChildren(staticLabelList(overviewLabels(buildRobot(id)))); // no WebGL: what the robot is made of, as text
    runner = createMissionRunner({
      robotId: id, view, scenes, getRig: () => rig, resetRig, isReduced: () => reduced, speak, phoneFrame: $("labPhone"), store, onFinish, beforeStart, idPrefix: "lab-", keyScope: $("labView").parentElement,
      note: "Lab sim: deterministic physics written for learning, the same as the Workbench. Agent runs are replayed by the verifier; a pass is lab data, not real-robot proof.",
    });
    $("labRunner").replaceChildren(runner.element);
    runner.preview();
    await refreshPilots();
    loadBoard();
  }
  function hide() {
    runner?.destroy();
    runner = null;
    if (view) (view.onTick = null), view.setLive(false);
  }
  return { show, hide, refreshPilots, setReduced: (r) => ((reduced = r), view?.setReduced(r)) };
}
