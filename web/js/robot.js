// Robot Link wizard: run -> connect -> calibrate -> check -> set up -> play. Plain-English, one action per step.
// All motion logic and safety lives in js/robot/*.js (tested in Node); this file is only the guided UI.
import { loadConfig, renderChrome } from "./chain.js";
import { createArenaView } from "./sim/arena-view.js";
import { CELL, FPS, JOINTS, LIMITS, REST, createMission } from "./sim/arm-sim.js";
import { buildEpisode } from "./sim/episode.js";
import { autopilot } from "./sim/autopilot.js";
import { createBus } from "./robot/sts-bus.js";
import { createVirtualArm } from "./robot/virtual-arm.js";
import { openTransport, pickPort, rememberedPort, serialSupported } from "./robot/serial-transport.js";
import { CalibrationError, POSE, STEPS_PER_DEG, buildCalibration, clampSafe, createRangeTracker, flipJoint, jointStatus, label, matchesArm, nearRest, outside, rawToSim, validCalibration } from "./robot/calibration.js";
import { DEFAULT_SPEED, SPEEDS, SafetyError, checkRun, createPlayer, freeze, holdHere, hoverPose, inTheAir, moveSafely, readEeprom, readState, relax, scan, waitStill } from "./robot/player.js";
import { createRecorder, openCamera, recordingSupported, saveVideo, stopStream } from "./recorder.js";

await loadConfig();
renderChrome("robot");

const $ = (id) => document.getElementById(id);
const view = createArenaView($("view"), { preserveDrawingBuffer: true }); // film mode copies the twin
const S = { ep: null, bus: null, transport: null, virtual: null, cal: null, eeprom: null, moving: false, player: null, cancel: false, rehearsedFor: null, poll: null, anim: null };
const twin = { joints: REST.slice(), cell: { x: 0.2, y: 0, z: CELL / 2, mode: "table" }, dock: { x: 0.2, y: 0.1 }, success: false };
const show = (j) => ((twin.joints = j.slice()), view.update(twin));
show(REST);

// ---------------------------------------------------------------- storage (per-viewer convenience only)
const calKey = () => (S.virtual ? "openforge.robot.cal.virtual" : "openforge.robot.cal");
const store = {
  get(k) {
    try {
      const raw = localStorage.getItem(k);
      return raw && raw.length <= 2_000_000 ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem(k, JSON.stringify(v));
    } catch {}
  },
};

// ---------------------------------------------------------------- step card
const STEPS = ["run", "connect", "calibrate", "check", "scene", "play"];
function card(step, title, bodyHtml, actions = []) {
  for (const li of $("stepper").children) {
    const i = STEPS.indexOf(li.dataset.s);
    li.className = i < STEPS.indexOf(step) ? "done" : i === STEPS.indexOf(step) ? "now" : "";
  }
  $("stepKicker").textContent = `Step ${STEPS.indexOf(step) + 1} of ${STEPS.length}`;
  $("stepTitle").textContent = title;
  $("stepBody").innerHTML = bodyHtml; // static, authored strings only; dynamic values go through text()
  $("stepActions").replaceChildren(...actions.map(button));
  msg("");
}
function button({ label: text, cls = "", onClick, id, disabled, free }) {
  const b = Object.assign(document.createElement("button"), { className: `btn sm ${cls}`, textContent: text, disabled: !!disabled });
  if (id) b.id = id;
  b.onclick = () => (free ? onClick() : guard(onClick, b)); // free: virtual-hand helpers, never block the wizard
  return b;
}
const text = (id, v) => (($(id) || {}).textContent = v);
function msg(t, kind = "") {
  $("stepMsg").textContent = t;
  $("stepMsg").className = `small ${kind === "err" ? "badge bad" : kind === "ok" ? "badge ok" : "muted"}`;
}
let busy = false;
async function guard(fn, b) {
  if (busy) return;
  busy = true;
  if (b) b.disabled = true;
  try {
    await fn();
  } catch (e) {
    msg(e instanceof SafetyError || e instanceof CalibrationError ? e.message : `Something went wrong: ${e.message}`, "err");
  } finally {
    busy = false;
    if (b?.isConnected) b.disabled = false;
  }
}

// ---------------------------------------------------------------- twin: instructions or live mirror
function animate(fn) {
  stopAnim();
  const t0 = performance.now();
  S.anim = setInterval(() => show(fn((performance.now() - t0) / 1000)), 1000 / FPS);
  $("hudMode").textContent = "TWIN: INSTRUCTIONS";
}
function stopAnim() {
  clearInterval(S.anim);
  S.anim = null;
}
function poll(fn, ms = 50) {
  stopPoll();
  let inFlight = false;
  S.poll = setInterval(async () => {
    if (inFlight || S.moving || !S.bus) return;
    inFlight = true;
    try {
      fn(await readState(S.bus));
    } catch {
      $("hudMode").textContent = "TWIN: NO SIGNAL"; // never let a stale twin look live
    }
    inFlight = false;
  }, ms);
}
function stopPoll() {
  clearInterval(S.poll);
  S.poll = null;
}
function mirror() {
  stopAnim();
  $("hudMode").textContent = "TWIN: LIVE MIRROR";
  poll((st) => {
    $("hudMode").textContent = "TWIN: LIVE MIRROR";
    show(rawToSim(S.cal, st.raw));
    syncHands();
  }, 100);
}

// ---------------------------------------------------------------- STOP: freezes the arm, everywhere
function stopAll(reason) {
  if (!S.moving) return;
  S.cancel = true;
  S.player?.stop(reason);
}
$("stopBtn").onclick = () => stopAll("Stopped by you. The arm is holding still.");
addEventListener("keydown", (e) => {
  if (!S.moving || (e.code !== "Space" && e.code !== "Escape")) return;
  e.preventDefault();
  stopAll("Stopped by you. The arm is holding still.");
});
document.addEventListener("visibilitychange", () => document.hidden && stopAll("You left the page, so the arm froze where it was."));
addEventListener("blur", () => stopAll("The window lost focus, so the arm froze where it was."));
addEventListener("pagehide", () => {
  stopAll("Page closed.");
  if (S.bus && S.cal) freeze(S.bus).catch(() => {});
});
async function moving(fn) {
  S.moving = true;
  S.cancel = false;
  stopPoll();
  $("stopBtn").hidden = false;
  $("stopBtn").focus();
  try {
    return await fn();
  } finally {
    S.moving = false;
    $("stopBtn").hidden = true;
    if (S.cal) mirror();
  }
}
const move = (target, speed) => moving(() => moveSafely(S.bus, S.cal, target, { speed, cancelled: () => S.cancel, onPose: show }));

$("relaxBtn").onclick = () =>
  guard(async () => {
    if (!S.bus) return;
    if (!confirm("The arm will go limp. Hold it with one hand first. Relax now?")) return;
    if (await relax(S.bus)) msg("Torque off: the arm is limp.");
    else msg("Could not confirm that torque is off. Unplug the arm's power supply.", "err");
  });
const checked = () => S.cal?.verified === true;
async function restNow() {
  if (!S.bus || !S.cal) return;
  if (!checked()) return msg("Finish the direction check first: until then only small test moves are allowed.", "err");
  await holdHere(S.bus);
  if (await move(REST)) msg("The arm is at rest and holding.", "ok");
}
$("restBtn").onclick = () => guard(restNow);
$("recalBtn").onclick = () => guard(async () => S.bus && calibrate());

// ---------------------------------------------------------------- virtual arm "hands"
// The virtual arm has its own hidden mounting offsets, so calibrating it is a real exercise.
const V_ZERO = [2048, 2140, 1960, 2030, 2048];
const V_SIGN = [1, -1, 1, -1, 1];
const vRaw = (i, d) => (i === 5 ? 1500 + 11 * d : Math.round(V_ZERO[i] + V_SIGN[i] * d * STEPS_PER_DEG));
const vDeg = (i, r) => (i === 5 ? (r - 1500) / 11 : (r - V_ZERO[i]) / (V_SIGN[i] * STEPS_PER_DEG));
const V_RANGE = [[-120, 120], [-108, 108], [-108, 108], [-108, 108], [-170, 170], [0, 105]];
const sliders = [];
function buildHands() {
  $("handsPanel").hidden = false;
  $("hands").replaceChildren(
    ...JOINTS.map((j, i) => {
      const row = document.createElement("label");
      const s = Object.assign(document.createElement("input"), { type: "range", min: V_RANGE[i][0], max: V_RANGE[i][1], step: 1, value: REST[i] });
      s.oninput = () => S.virtual.hand(i + 1, vRaw(i, Number(s.value)));
      sliders[i] = s;
      row.append(Object.assign(document.createElement("span"), { textContent: label(j) }), s);
      return row;
    })
  );
}
function syncHands() {
  if (!S.virtual) return;
  sliders.forEach((s, i) => {
    s.disabled = S.virtual.torque(i + 1);
    if (s.disabled) s.value = Math.round(vDeg(i, S.virtual.position(i + 1)));
  });
}
/** "Do it for me": plays a hand movement on the virtual arm (degrees per joint, over time). */
function handPath(i, points, degPerS = 90) {
  return new Promise((resolve) => {
    let at = Number(sliders[i].value);
    let k = 0;
    const timer = setInterval(() => {
      if (k >= points.length) return clearInterval(timer), resolve();
      const d = points[k] - at;
      const stepDeg = (degPerS / 20) * Math.sign(d);
      at = Math.abs(d) <= Math.abs(stepDeg) ? points[k++] : at + stepDeg;
      sliders[i].value = at;
      sliders[i].oninput();
    }, 50);
  });
}

// ================================================================ 1. run
function stepRun() {
  card("run", "Choose a run",
    `<p>Pick what your arm will do. Runs come from the <a href="arena.html">Proving Grounds</a>, where you pilot your agent's digital twin.</p>
     <input type="file" id="runFile" accept=".json,application/json" hidden>`,
    [
      { label: "My last Proving Grounds run", cls: "primary", onClick: () => loadRun(store.get("openforge.lastRun"), "your last run"), disabled: !store.get("openforge.lastRun") },
      { label: "Upload a run file", onClick: () => $("runFile").click() },
      { label: "Demo run", onClick: () => loadRun(demoRun(), "a demo run") },
    ]);
  $("runFile").onchange = async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    if (f.size > 2_000_000) return msg("That file is too big to be a run.", "err");
    let ep;
    try {
      ep = JSON.parse(await f.text());
    } catch {
      return msg("That file is not a run (it is not valid JSON).", "err");
    }
    loadRun(ep, "your file");
  };
}
function demoRun() {
  const seed = "0x" + Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, "0")).join("");
  return buildEpisode({ tokenId: 0, challengeId: "0x" + "0".repeat(64), seed, actions: autopilot(seed) });
}
function loadRun(ep, source) {
  const { problems, outcome } = checkRun(ep);
  if (problems.length) return msg(`Can't use ${source}: ${problems.join(" ")}`, "err");
  S.ep = ep;
  const m = createMission(ep.seed);
  twin.cell = { x: m.cell.x, y: m.cell.y, z: CELL / 2, mode: "table" };
  twin.dock = m.dock;
  animate((t) => ep.actions[Math.floor(t * FPS) % ep.actions.length]);
  const who = ep.tokenId ? `Agent AX-${String(ep.tokenId).padStart(4, "0")}` : "Demo";
  card("run", "Run loaded", `<p><b id="runWho"></b> · <span id="runInfo"></span></p><p class="muted">The twin is playing it. Next, plug in your arm.</p>`, [
    { label: "Next: connect the arm", cls: "primary", onClick: stepConnect },
    { label: "Pick another run", onClick: stepRun },
  ]);
  text("runWho", who);
  text("runInfo", `${(ep.actions.length / FPS).toFixed(1)} s · ${outcome.success ? "cell docked in the sim" : `sim result: ${outcome.reason}`}`);
}

// ================================================================ 2. connect
function stepConnect() {
  const ok = serialSupported();
  card("connect", "Connect the arm",
    ok
      ? `<ol><li>Plug the arm's power supply in.</li><li>Plug the USB cable into this computer.</li><li>Click <b>Connect my arm</b> and pick the port (often "USB Single Serial" or "CH343").</li></ol>`
      : `<p class="badge warn">This browser can't talk to USB devices. Use Chrome, Edge or Opera on a computer. You can still try the virtual arm here.</p>`,
    [
      ...(ok ? [{ label: "Connect my arm", cls: "primary", onClick: () => connectReal(false) }, { label: "Show all ports", onClick: () => connectReal(true) }] : []),
      { label: "Try the virtual arm", cls: ok ? "" : "primary", onClick: connectVirtual },
    ]);
}
async function connectReal(all) {
  const port = (!all && (await rememberedPort())) || (await pickPort({ all }));
  await disconnect();
  S.transport = await openTransport(port, () => {
    stopAll("The arm was disconnected.");
    msg("The arm was disconnected. Check the USB cable, then connect again.", "err");
  });
  S.bus = createBus(S.transport);
  await afterConnect();
}
async function connectVirtual() {
  await disconnect();
  S.virtual = createVirtualArm({ start: REST.map((d, i) => vRaw(i, d)), limits: V_RANGE.map((r, i) => [vRaw(i, V_SIGN[i] > 0 || i === 5 ? r[0] : r[1]), vRaw(i, V_SIGN[i] > 0 || i === 5 ? r[1] : r[0])]) });
  S.bus = createBus(S.virtual.transport);
  buildHands();
  await afterConnect();
}
async function disconnect() {
  stopPoll();
  await S.transport?.close().catch(() => {});
  Object.assign(S, { bus: null, transport: null, virtual: null, cal: null, rehearsedFor: null });
  $("handsPanel").hidden = true;
  $("armPanel").hidden = true;
  $("hudArm").textContent = "NO ARM";
}
async function afterConnect() {
  msg("Looking for the six servos…");
  const res = await scan(S.bus);
  if (res.problems.length || res.missing.length) {
    card("connect", "Almost there", `<ul id="scanList"></ul><p class="muted">Open "Trouble connecting?" below for help.</p>`, [
      { label: "Try again", cls: "primary", onClick: afterConnect },
      { label: "Back", onClick: stepConnect },
    ]);
    $("scanList").replaceChildren(...[...res.problems, res.hint].filter(Boolean).map((t) => Object.assign(document.createElement("li"), { textContent: t })));
    return;
  }
  S.eeprom = await readEeprom(S.bus);
  $("hudArm").textContent = S.virtual ? "VIRTUAL ARM" : `SO-101 · ${res.volts.toFixed(1)} V`;
  $("armPanel").hidden = false;
  text("armInfo", `6 servos found · power ${res.volts.toFixed(1)} V`);
  const saved = store.get(calKey());
  const { raw } = await readState(S.bus);
  // only a calibration that passed the direction check, recorded on these servos, and still in range
  if (saved?.verified === true && validCalibration(saved, S.eeprom) && matchesArm(saved, raw) === -1) return welcomeBack(saved);
  calibrate();
}

/** A saved calibration is reused only after a physical check: folded to rest, the arm must read as rest. */
function welcomeBack(saved) {
  stopAnim();
  show(REST);
  card("connect", "Welcome back",
    `<p>This looks like the arm you calibrated before. To make sure: fold it into the rest pose like the twin, then <b>take your hands off</b>.</p>`,
    [
      { label: "Check it's my arm", cls: "primary", onClick: async () => {
        msg("Waiting for the arm to be still…");
        const bad = nearRest(saved, await waitStill(S.bus));
        if (bad >= 0) return msg(`The ${label(JOINTS[bad])} does not read as the rest pose. Fold the arm like the twin and retry, or recalibrate.`, "err");
        S.cal = saved;
        mirror();
        card("connect", "It's your arm", `<p class="badge ok">Calibration confirmed. The twin now mirrors the arm live.</p>`, [
          { label: "Next: set up the mission", cls: "primary", onClick: stepScene },
          { label: "Run the direction check again", onClick: stepCheck },
        ]);
      } },
      ...(S.virtual ? [{ label: "Do it for me", free: true, onClick: () => Promise.all(REST.map((d, i) => handPath(i, [d], 120))) }] : []),
      { label: "Recalibrate", onClick: calibrate },
    ]);
}

// ================================================================ 3. calibrate
const HOW = [
  "Turn the base the way the twin turns, then gently all the way to both sides.",
  "Tilt the upper arm the way the twin does, then gently to both ends.",
  "Move the forearm the way the twin does, then gently to both ends.",
  "Bend the gripper the way the twin does, then gently to both ends.",
  "Twist the gripper a quarter turn the way the twin does. No need to reach the ends.",
  "Open the gripper all the way, then close it again.",
];
let poseRaw = null;
let trackers = [];
function calibrate() {
  S.cal = null;
  stopPoll();
  show(POSE);
  stopAnim();
  card("calibrate", "Teach Robot Link your arm",
    `<p>Takes about 3 minutes. You will move the arm by hand while the twin shows you how.</p><p><b>First:</b> hold the arm with one hand. The next button turns the motors off, so it goes limp.</p>`,
    [{ label: "I'm holding it: turn the motors off", cls: "primary", onClick: async () => {
      if (!(await relax(S.bus))) return msg("Could not confirm that the motors are off. Unplug the arm's power supply, plug it back in, then retry.", "err");
      stepPose();
    } }]);
}
function stepPose() {
  show(POSE);
  card("calibrate", "Pose the arm like the twin",
    `<ul><li>Base facing forward.</li><li>Upper arm straight up.</li><li>Forearm pointing straight forward.</li><li>Gripper pointing straight down, fully <b>closed</b>.</li></ul>
     <p class="muted">Then press the button and hold still: it captures after a 5 s countdown, once the arm is steady.</p>`,
    [
      { label: "Capture the pose", cls: "primary", onClick: capturePose },
      ...(S.virtual ? [{ label: "Do it for me", free: true, onClick: () => Promise.all(POSE.map((d, i) => handPath(i, [d], 120))) }] : []),
    ]);
}
async function capturePose() {
  for (let s = 5; s > 0; s--) {
    msg(`Hold the pose… ${s}`);
    await new Promise((r) => setTimeout(r, 1000));
  }
  msg("Hold still…");
  let ref = null;
  let since = performance.now();
  for (const t0 = performance.now(); performance.now() - t0 < 10000; ) {
    const { raw } = await readState(S.bus);
    if (!ref || raw.some((r, i) => Math.abs(r - ref[i]) > STEPS_PER_DEG)) (ref = raw), (since = performance.now());
    else if (performance.now() - since > 1000) {
      poseRaw = raw;
      trackers = [];
      return stepJoint(0);
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  msg("The arm kept moving. Try again, resting your elbow on the table helps.", "err");
}
function stepJoint(i) {
  card("calibrate", `Joint ${i + 1} of 6: ${label(JOINTS[i])}`,
    `<p>${HOW[i]}</p><p>Direction <b id="chipDir">waiting…</b>${i === 4 ? "" : ` · Travel <b id="chipRange">0°</b>`}</p>`,
    [
      { label: i === 5 ? "Done: finish calibration" : "Next joint", cls: "primary", id: "jointNext", disabled: true, onClick: () => (i === 5 ? finishCalibration() : stepJoint(i + 1)) },
      ...(S.virtual ? [{ label: "Do it for me", free: true, onClick: () => handPath(i, i === 5 ? [60, 104, 0] : i === 4 ? [POSE[4] + 45, POSE[4]] : [POSE[i] + 30, V_RANGE[i][1], V_RANGE[i][0], POSE[i]]) }] : []),
      { label: "Start over", onClick: stepPose },
    ]);
  const amp = i === 5 ? 50 : 35;
  animate((t) => {
    const j = POSE.slice();
    j[i] = i === 5 ? 50 - 50 * Math.cos(t * 2) : POSE[i] + amp * Math.sin(t * 2);
    return j.map((v, k) => Math.min(LIMITS[k][1], Math.max(LIMITS[k][0], v)));
  });
  let tr = null;
  poll(({ raw }) => {
    if (!tr) tr = trackers[i] = createRangeTracker(raw[i]);
    tr.update(raw[i]);
    const st = jointStatus(tr, i, poseRaw[i]);
    text("chipDir", tr.dir ? "✔ got it" : "waiting…");
    if (i !== 4) text("chipRange", `${Math.round(tr.rangeDeg())}°${st === "ok" ? " ✔" : st === "other" ? " · keep going the other way too" : ""}`);
    $("jointNext").disabled = st !== "ok";
  });
}
function finishCalibration() {
  stopPoll();
  try {
    S.cal = buildCalibration({ poseRaw, trackers, eeprom: S.eeprom }); // saved only once the direction check passes
  } catch (e) {
    if (!(e instanceof CalibrationError)) throw e;
    card("calibrate", "One more try", `<p id="calErr"></p>`, [
      { label: "Repeat that step", cls: "primary", onClick: () => (e.joint >= 0 ? stepJoint(e.joint) : stepPose()) },
      { label: "Start over", onClick: stepPose },
    ]);
    return text("calErr", e.message);
  }
  stepCheck();
}

// ================================================================ 4. check
function stepCheck() {
  stopPoll();
  stopAnim();
  show(REST);
  card("check", "Check the directions",
    `<p>Fold the arm roughly like the twin (the rest pose), then <b>take your hands off</b>. The motors will hold it and gently nudge one joint at a time.</p><p class="muted">Watch the real arm and the twin: they should move the same way.</p>`,
    [
      { label: "Hands off: hold the arm", cls: "primary", onClick: async () => (msg("Waiting for the arm to be still…"), await holdHere(S.bus), mirror(), nudgeJoint(0)) },
      ...(S.virtual ? [{ label: "Do it for me", free: true, onClick: () => Promise.all(REST.map((d, i) => handPath(i, [d], 120))) }] : []),
    ]);
}
async function nudgeJoint(i) {
  if (i === 6) {
    S.cal = { ...S.cal, verified: true };
    store.set(calKey(), S.cal);
    return card("check", "All joints match", `<p class="badge ok">Your arm is calibrated and checked. It is saved in this browser.</p>`, [
      { label: "Next: set up the mission", cls: "primary", onClick: stepScene },
    ]);
  }
  card("check", `Testing the ${label(JOINTS[i])}`, `<p>Moving it a little and back…</p>`, []);
  const cur = clampSafe(S.cal, rawToSim(S.cal, (await readState(S.bus)).raw));
  const amount = i === 5 ? 25 : 8;
  const there = cur.slice();
  there[i] = Math.min(S.cal.safe[i][1], Math.max(S.cal.safe[i][0], cur[i] + amount));
  let ok;
  try {
    ok = (await move(there, 20)) && (await move(cur, 20));
  } catch (e) {
    retryNudge(i);
    return msg(e.message, "err");
  }
  if (!ok) return retryNudge(i), msg("Stopped. Press the button to continue when ready.", "err");
  card("check", `Did the ${label(JOINTS[i])} move like the twin?`, `<p class="muted">The twin shows what Robot Link thinks the arm did.</p>`, [
    { label: "Yes", cls: "primary", onClick: () => nudgeJoint(i + 1) },
    { label: "No, it went the other way", onClick: () => ((S.cal = flipJoint(S.cal, i)), nudgeJoint(i)) }, // flipped = unverified until the check ends
    { label: "Show me again", onClick: () => nudgeJoint(i) },
  ]);
}
function retryNudge(i) {
  $("stepActions").replaceChildren(button({ label: "Continue the check", cls: "primary", onClick: () => nudgeJoint(i) }));
}

// ================================================================ 5. scene
const cm = (m) => `${Math.abs(Math.round(m * 1000) / 10)} cm`;
const where = (p) => `${cm(p.x)} in front of the base centre and ${cm(p.y)} to the ${p.y >= 0 ? "left" : "right"}`;
function stepScene() {
  const m = createMission(S.ep.seed);
  twin.cell = { x: m.cell.x, y: m.cell.y, z: CELL / 2, mode: "table" };
  twin.dock = m.dock;
  card("scene", "Set up the mission",
    `<p><b>Energy cell</b> (any 3 cm cube, a foam block or a sugar cube): <span id="cellAt"></span>.</p>
     <p><b>Dock</b> (a coin or a 6 cm circle drawn on paper): <span id="dockAt"></span>.</p>
     <p class="muted">Easiest: let the arm point to each spot and put the object right under the gripper.</p>`,
    [
      { label: "Show me with the arm", cls: "primary", onClick: () => pointTo(m.cell, "cell", m) },
      { label: "I placed them by hand", onClick: stepPlay },
    ]);
  text("cellAt", where(m.cell));
  text("dockAt", where(m.dock));
}
async function pointTo(spot, what, m) {
  if (!checked()) return msg("Finish the direction check first.", "err");
  const pose = hoverPose(spot);
  if (!pose) return msg("The arm can't reach that spot from here.", "err");
  // otherwise moveSafely would blame the arm's position, when the spot is beyond the calibrated range
  const j = outside(S.cal, pose);
  if (j >= 0) return msg(`That spot is beyond the range you calibrated for the ${label(JOINTS[j])}. Place it by hand (${where(spot)}), or press Recalibrate and turn that joint further to both sides.`, "err");
  await holdHere(S.bus);
  if (!(await move(pose))) return msg("Stopped. The arm is holding still.", "err");
  if (what === "cell")
    return card("scene", "Place the cell", `<p>Put the cell on the table <b>right under the gripper</b>.</p>`, [
      { label: "Done: show me the dock spot", cls: "primary", onClick: () => pointTo(m.dock, "dock", m) },
      { label: "I'll place the dock by hand", onClick: async () => (await move(REST)) && stepPlay() },
    ]);
  card("scene", "Place the dock", `<p>Put the dock marker <b>right under the gripper</b>.</p>`, [
    { label: "Done: back to rest", cls: "primary", onClick: async () => (await move(REST)) && stepPlay() },
  ]);
}

// ================================================================ 6. play
// a rehearsal counts for this exact run, on this exact calibration (a new run, arm or calibration needs a new one)
const rehearsed = () => S.rehearsedFor?.ep === S.ep && S.rehearsedFor?.cal === S.cal;
function stepPlay() {
  const mustRehearse = !rehearsed();
  card("play", "Play the run",
    `<label class="check"><input type="checkbox" id="air" checked ${mustRehearse ? "disabled" : ""}> Rehearse 5 cm above the table${mustRehearse ? " (always first, for each run)" : ""}</label>
     <label class="check">Speed <select id="speed">${SPEEDS.map((s) => `<option value="${s}" ${s === DEFAULT_SPEED ? "selected" : ""}>${s}×</option>`).join("")}</select></label>
     <label class="check"><input type="checkbox" id="clear"> The space around the arm is clear and I can reach its power plug</label>
     <label class="check" id="filmRow" hidden><input type="checkbox" id="film"> Film mode: record the twin next to your camera (the video downloads at the end; nothing is uploaded)</label>
     <video id="filmCam" muted playsinline hidden style="width:100%;max-height:180px;margin-top:8px;border:1px solid var(--line)"></video>
     <p class="muted">STOP (or Space / Esc) freezes the arm instantly. A sim success means a plausible path: the real grasp may still miss, and that is normal.</p>`,
    [{ label: "Play", cls: "primary", onClick: play }]);
  $("filmRow").hidden = !recordingSupported() || !navigator.mediaDevices?.getUserMedia;
  $("film").checked = Boolean(S.film);
  if (S.film) showFilmPreview();
  // the camera is asked for here, before Play and never during a move: its prompt can blur the page, which freezes the arm
  $("film").onchange = async () => {
    if (!$("film").checked) return endFilm();
    try {
      msg("Allow the camera in the browser prompt.");
      S.film = await openCamera();
      showFilmPreview();
      msg("Camera ready. Point it at the arm, then press Play.", "ok");
    } catch {
      $("film").checked = false;
      msg("No camera available (or permission denied). Film mode is off.", "err");
    }
  };
}
function showFilmPreview() {
  const v = $("filmCam");
  v.srcObject = S.film;
  v.hidden = false;
  v.play().catch(() => {});
}
function endFilm() {
  stopStream(S.film);
  S.film = null;
  if ($("filmCam")) $("filmCam").hidden = true;
}
addEventListener("pagehide", endFilm);
async function play() {
  if (!$("clear").checked) return msg("Tick the safety box first.", "err");
  const air = !rehearsed() || $("air").checked; // the first play of each run is always in the air
  const actions = air ? inTheAir(S.ep.actions) : S.ep.actions;
  const { problems } = checkRun({ ...S.ep, actions }, S.cal);
  if (problems.length) return msg(`Not safe on your arm: ${problems.join(" ")}`, "err");
  const speed = Number($("speed").value);
  const rehearsal = { ep: S.ep, cal: S.cal };
  // film mode only reads the twin canvas and the camera; any recorder error is contained here
  let rec = null;
  if (S.film && $("film").checked) {
    try {
      rec = createRecorder({
        left: $("view"), right: $("filmCam"), labels: ["DIGITAL TWIN", S.virtual ? "VIRTUAL ARM (CAMERA)" : "REAL SO-101"],
        title: "BROWSER RUN → REAL SO-101", subtitle: `OpenForge AX · Robot Link${air ? " · rehearsal 5 cm above the table" : ""} · ${speed}×`,
      });
      rec.start();
    } catch {
      rec = null;
    }
  }
  await moving(async () => {
    S.player = createPlayer({
      bus: S.bus, cal: S.cal, actions, speed,
      onState: (s, m) => (s === "playing" ? msg(air ? "Rehearsing in the air…" : "Playing…") : m && msg(m, s === "done" ? "ok" : s === "starting" ? "" : "err")),
      onFrame: ({ commanded, progress }) => (show(commanded), ($("hudMode").textContent = `PLAYING ${Math.round(progress * 100)}%`)),
    });
    if (S.player.speed < speed - 1e-9) msg(`This run is fast: it plays at ${S.player.speed.toFixed(2)}× to stay under the arm's safe speed.`);
    await S.player.start();
  });
  const end = S.player.state;
  if (end === "done" && air) S.rehearsedFor = rehearsal;
  // the arm has finished or is frozen before the recording stops and the download (which may blur the page) starts
  if (rec) rec.stop().then((blob) => saveVideo(blob, `openforge-robot-link-${Date.now()}.${rec.ext}`)).catch(() => {});
  $("stepActions").replaceChildren(
    ...(end === "done"
      ? [button({ label: air ? "Now for real" : "Play again", cls: "primary", onClick: () => (stepPlay(), ($("air").checked = false)) })] // rehearsed: both go for real
      : [button({ label: "Return to rest", cls: "primary", onClick: restNow }), button({ label: "Back to play", onClick: stepPlay })])
  );
}

// ---------------------------------------------------------------- start
stepRun();
if (new URLSearchParams(location.search).get("run") === "last" && store.get("openforge.lastRun")) loadRun(store.get("openforge.lastRun"), "your last run");
