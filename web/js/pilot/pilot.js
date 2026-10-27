// Phone Brain entry: wires the drive loop, the transports (twin by default, Web Bluetooth when available), the
// sensors and the 3D twin. The twin is driven only by what comes back in AX_STATE, so what you see is what the
// bridge state machine decided, not what the app hoped.
import * as THREE from "three";
import { makeRenderer, makeStage, disposeObject, PALETTE, onThemeChange, themed } from "../models/look.js";
import { buildRobot, bounds } from "../models/robots.js";
import * as P from "./ax-proto.js";
import { createDriveLoop, LINK } from "./drive-loop.js";
import { createTwinTransport, realTimers } from "./twin-transport.js";
import { bleSupported, createBleTransport } from "./ble-transport.js";
import { capabilities, createWakeLock, startCamera, startTilt } from "./sensors.js";
import { $, chip, dpad, el, joystick, renderCaps, slider } from "./ui.js";
import { GESTURES, POSES } from "./motions.js";
import { createAiPilot } from "./ai/ai-pilot.js";
import { loadConfig, renderChrome } from "../chain.js";
import { mountAiPanel } from "./ai/ai-panel.js";
import { createVoiceInput } from "./ai/voice.js";

const caps = capabilities();
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
const wake = createWakeLock();

let mode = "twin";
let bodyKey = "rover";
let transport = null;
let loop = null;
let snap = null;
let gestureTimers = [];
let tilt = null;
let tiltVec = { x: 0, y: 0 };
let camera = null;
let look = { x: 0, y: 0 };
let ai = null; // AI Pilot: plans text requests and runs them through this same loop
let aiPanel = null;
let aiClient = null; // the user's own model server, or null for the built-in parser
const human = () => ai && ai.takeover(); // the human touched a control: the AI lets go
await loadConfig();
renderChrome("pilot"); // the same nav (sounds, music, dark, menu) and footer as every other page

// ================================================================ capability panel

function showCaps() {
  const rows = [
    { ok: true, title: "3D twin", why: "Always works: the twin runs the real bridge logic in this page." },
    {
      ok: caps.bluetooth,
      title: "Web Bluetooth (real robot)",
      why: caps.bluetooth
        ? "This browser can pair with an AX-1 bridge. You will need the 6-digit passkey on the board's sticker."
        : caps.ios
          ? "iPhone and iPad browsers do not offer Web Bluetooth. Drive the twin, or try a BLE-capable browser such as Bluefy."
          : "Use Chrome or Edge on Android, Windows, macOS or Linux to drive a real robot.",
    },
    { ok: caps.motion, title: "Motion sensors", why: caps.motion ? `Tilt to steer is available${caps.motionNeedsPermission ? " (the phone will ask first)" : ""}.` : "No tilt steering on this device; use the joystick or buttons." },
    { ok: caps.camera, title: "Camera", why: caps.camera ? "“Look at movement” can turn the head toward motion. The picture never leaves the phone." : "No camera access here (it needs HTTPS and a camera)." },
    { ok: caps.wakeLock, title: "Keep screen on", why: caps.wakeLock ? "The screen stays on while the robot is armed." : "Your screen may dim while driving; that sends STOP." },
  ];
  if (!caps.secure) rows.push({ ok: false, title: "Secure page (HTTPS)", why: "Bluetooth, camera and motion need HTTPS or localhost." });
  renderCaps($("capList"), rows);
  $("startRobot").hidden = !caps.bluetooth;
  if (!caps.mobile) {
    $("desktopHint").hidden = false;
    $("pageUrl").textContent = location.href.split("#")[0];
  }
}

// ================================================================ 3D twin

const view = { ok: false };
function initView() {
  const canvas = $("twin");
  try {
    view.renderer = makeRenderer(canvas);
  } catch {
    $("noGl").hidden = false;
    canvas.hidden = true;
    return;
  }
  view.ok = true;
  const r = view.renderer;
  r.setPixelRatio(Math.min(devicePixelRatio || 1, 1.5));
  view.scene = new THREE.Scene();
  const stage = makeStage(view.scene, r, { size: 1.2, background: PALETTE.paper2 });
  stage.key.shadow.mapSize.set(1024, 1024);
  stage.key.shadow.radius = 3;
  const grid = new THREE.GridHelper(4, 20, 0xffffff, 0xffffff); // white vertex colours, tinted by the material below
  const paintGrid = () => grid.material.color.setHex(themed(PALETTE.line));
  paintGrid();
  onThemeChange(paintGrid);
  grid.material.transparent = true;
  grid.material.opacity = 0.6;
  grid.position.y = 0.001;
  view.scene.add(grid);
  view.camera = new THREE.PerspectiveCamera(35, 1, 0.01, 30);
  view.target = new THREE.Vector3();
  view.pose = { x: 0, z: 0, yaw: 0 };
  view.last = 0;
  view.lastRender = 0;
  new ResizeObserver(resize).observe(canvas);
  resize();
  requestAnimationFrame(frame);
}

function resize() {
  if (!view.ok) return;
  const c = $("twin");
  const w = c.clientWidth || 1;
  const h = c.clientHeight || 1;
  view.renderer.setSize(w, h, false);
  view.camera.aspect = w / h;
  view.camera.updateProjectionMatrix();
}

function setRig(key) {
  if (!view.ok) return;
  if (view.rig) view.scene.remove(view.rig.group), disposeObject(view.rig.group); // a body switch frees the old robot's GPU memory
  view.rig = buildRobot(`ax1-${key}`);
  view.scene.add(view.rig.group);
  view.pose = { x: 0, z: 0, yaw: 0 };
  view.rig.group.position.set(0, 0, 0);
  view.rig.group.rotation.y = 0;
  const b = bounds(view.rig);
  const size = b.getSize(new THREE.Vector3());
  view.dist = Math.max(size.x, size.y, size.z) * 2.6 + 0.25;
  view.lookY = size.y * 0.55;
  view.target.set(0, view.lookY, 0);
}

const VMAX = 0.35; // m/s at full wheel output
const TRACK = 0.2; // m between wheels
const ARENA = 1.6; // m

function applyState(dt) {
  const rig = view.rig;
  if (!rig) return;
  const st = snap && snap.state;
  const body = P.bodyByKey(bodyKey);
  if (st && snap.body === body) {
    const names = P.stateChannels(body);
    names.forEach((n, i) => {
      if (n === "drive_l" || n === "drive_r") return;
      if (i < st.positions.length) rig.set(n, st.positions[i] / 10);
    });
    if (P.BODIES[body].drive) {
      const l = st.positions[names.indexOf("drive_l")] || 0;
      const r = st.positions[names.indexOf("drive_r")] || 0;
      rig.setSpin("wheel-l", (l / 1000) * 1.1);
      rig.setSpin("wheel-r", (r / 1000) * 1.1);
      const v = ((l + r) / 2000) * VMAX;
      const w = ((r - l) / 1000) * (VMAX / TRACK);
      const p = view.pose;
      p.yaw += w * dt;
      p.x += Math.sin(p.yaw) * v * dt;
      p.z += Math.cos(p.yaw) * v * dt;
      const d = Math.hypot(p.x, p.z);
      if (d > ARENA) (p.x *= ARENA / d), (p.z *= ARENA / d); // the edge of the mat
      rig.group.position.set(p.x, 0, p.z);
      rig.group.rotation.y = p.yaw;
    }
  } else {
    rig.setSpin("wheel", 0);
  }
  if (rig.face) {
    rig.face.setLook(look.x, look.y);
    const l = snap ? snap.link : LINK.DISCONNECTED;
    rig.face.setMood(l === LINK.DRIVING ? "happy" : st && st.state === P.STATE.ARMED ? "idle" : st ? "alert" : "idle");
  }
}

function frame(t) {
  requestAnimationFrame(frame);
  if (document.hidden || !view.rig) return;
  if (t - view.lastRender < 32) return; // ~30 fps is plenty and saves battery
  const dt = Math.min(0.1, (t - (view.lastRender || t)) / 1000);
  view.lastRender = t;
  applyState(dt);
  view.rig.update(dt, t / 1000);
  if (bodyKey === "walker" && (view.ground = (view.ground || 0) + 1) % 8 === 0) {
    // no physics: keep the lowest foot on the floor so poses read right
    const g = view.rig.group;
    g.position.y -= bounds(view.rig).min.y;
  }
  const p = view.rig.group.position;
  const k = reduceMotion ? 1 : 0.08;
  view.target.lerp(new THREE.Vector3(p.x, view.lookY, p.z), k);
  view.camera.position.set(view.target.x + view.dist * 0.55, view.target.y + view.dist * 0.45, view.target.z + view.dist * 0.75);
  view.camera.lookAt(view.target);
  view.renderer.render(view.scene, view.camera);
}

// ================================================================ link

function makeTransport() {
  return mode === "ble" ? createBleTransport() : createTwinTransport({ body: P.bodyByKey(bodyKey), clock: realTimers, latencyMs: 15 });
}

function newLoop() {
  const old = loop;
  transport = makeTransport();
  let l = null;
  l = createDriveLoop({ transport, clock: realTimers, onChange: (s) => l === loop && render(s) }); // a replaced loop goes quiet
  loop = l;
  if (old) old.disconnect().catch(() => {});
  if (ai) ai.reset(); // a plan made for another loop, body or mode is dropped
  loop.setSpeed(Number(speedCtl.input.value));
  snap = loop.snapshot;
  render(snap);
}

let lastMsg = "";
function render(s) {
  const prevLink = snap ? snap.link : null;
  snap = s;
  const active = s.link === LINK.ARMED || s.link === LINK.DRIVING;
  // a real robot reports its body: follow it
  if (s.info && P.BODIES[s.body] && P.BODIES[s.body].key !== bodyKey) {
    bodyKey = P.BODIES[s.body].key;
    $("bodySel").value = bodyKey;
    setRig(bodyKey);
    buildBodyControls();
  }
  const where = mode === "twin" ? "Twin" : "Robot";
  const linkText = {
    [LINK.DISCONNECTED]: s.reconnecting ? "reconnecting" : "offline",
    [LINK.CONNECTING]: "connecting",
    [LINK.LATCHED]: "stopped · needs ARM",
    [LINK.ARMED]: "armed",
    [LINK.DRIVING]: "driving",
  }[s.link];
  const tone = { [LINK.DISCONNECTED]: "", [LINK.CONNECTING]: "warn", [LINK.LATCHED]: "warn", [LINK.ARMED]: "ok", [LINK.DRIVING]: "live" }[s.link];
  chip($("linkChip"), `${where} · ${linkText}`, tone);
  chip($("stateChip"), linkText, tone);
  chip($("bodyChip"), P.BODIES[P.bodyByKey(bodyKey)].name.replace(/ \(.*\)/, ""), "");
  $("bodyChip").classList.add("plain");

  const connected = s.link !== LINK.DISCONNECTED && s.link !== LINK.CONNECTING;
  $("linkBtn").textContent = connected || s.reconnecting ? "Disconnect" : "Connect";
  $("linkBtn").disabled = s.link === LINK.CONNECTING;
  $("armBtn").disabled = !(s.link === LINK.LATCHED && s.compatible);
  $("bodySel").disabled = connected || mode === "ble";
  for (const r of document.querySelectorAll('input[name="mode"]')) r.disabled = connected || s.reconnecting;
  $("stick").setAttribute("aria-disabled", String(!active));
  $("stickLabel").textContent = active ? (s.link === LINK.DRIVING ? "driving" : "hold to drive") : "arm first";

  if (s.message !== lastMsg) {
    lastMsg = s.message;
    $("linkMsg").textContent = s.message; // aria-live
  }

  const st = s.state;
  const tele = [];
  if (st) {
    tele.push([`bridge: ${P.STATE_NAME[st.state] || st.state}`, st.state === P.STATE.ARMED ? "ok" : "warn"]);
    if (st.state !== P.STATE.ARMED) tele.push([P.LATCH_TEXT[st.latch] || "latched", ""]);
    tele.push([st.flags & P.FLAG.TORQUE ? "torque on" : "torque off", ""]);
    if (st.flags & P.FLAG.RELAX_PENDING) tele.push(["relaxing in 3 s", "warn"]);
    for (const f of P.faultText(st.fault)) tele.push([f, "bad"]);
    tele.push([`seq ${st.lastSeq}`, ""]);
    if (st.battMv) {
      $("battChip").hidden = false;
      chip($("battChip"), `${(st.battMv / 1000).toFixed(2)} V`, st.fault & P.FAULT.LOW_BATT ? "bad" : "ok");
    }
  }
  if (s.info) tele.push([`fw ${P.fwVersionText(s.info.fwVer)} · proto ${s.info.protoMajor}.${s.info.protoMinor}`, s.compatible ? "" : "bad"]);
  if (s.info && P.BODIES[s.info.body] && s.info.limitsHash !== P.limitsHash(s.info.body)) tele.push(["custom joint limits on the bridge", "warn"]);
  $("telemetry").replaceChildren(...tele.map(([t, tone]) => {
    const c = el("span", { class: "pl-chip" });
    chip(c, t, tone);
    return c;
  }));
  $("bleNote").hidden = mode !== "ble";
  if (mode === "ble") $("bleNote").textContent = transport && transport.kind === "ble" && connected ? `Connected to “${transport.name}”.` : "Turn the robot on, press Connect and pick “AX-1”. First time: hold BOOT for 2 s on the bridge to open its 60 s pairing window, then type the passkey from the sticker.";

  if (active && prevLink !== LINK.ARMED && prevLink !== LINK.DRIVING) wake.on();
  if (!active && (prevLink === LINK.ARMED || prevLink === LINK.DRIVING)) {
    wake.off();
    cancelGestures();
    stickCtl.release();
    padCtl.release();
  }
  // keep sliders on the robot's targets after ARM (ARM starts from where the robot is)
  if (active && (prevLink === LINK.LATCHED || prevLink === null)) syncSliders();
  if (ai) {
    ai.onLoopChange(s); // a latch ends a running plan; the Run button follows ARM
    if (ai.running) syncSliders();
  }
}

async function onConnect() {
  if (!loop) newLoop();
  const s = loop.snapshot;
  if (s.link !== LINK.DISCONNECTED || s.reconnecting) {
    await loop.disconnect();
    return;
  }
  newLoop(); // a fresh transport for the chosen mode/body
  await loop.connect();
}

// ================================================================ controls

let stickCtl, padCtl, speedCtl;
const sliders = new Map();

function heldChanged(on) {
  if (on) human();
  if (!loop) return;
  loop.setHeld(on);
  if (on && tilt && $("tiltToggle").checked) loop.setStick(tiltVec.x, tiltVec.y);
}

function buildStatic() {
  stickCtl = joystick($("stick"), $("knob"), {
    onHold: heldChanged,
    onMove: (x, y) => loop && !$("tiltToggle").checked && loop.setStick(x, y),
  });
  padCtl = dpad($("dpad"), { onHold: heldChanged, onMove: (x, y) => loop && loop.setStick(x, y) });
  speedCtl = slider($("speedSlider"), { label: "max speed", min: 10, max: 100, value: 60, step: 5, unit: "%", onInput: (v) => (human(), loop && loop.setSpeed(v)) });
  $("dpadToggle").addEventListener("change", (e) => {
    $("dpad").hidden = !e.target.checked;
    $("stick").hidden = e.target.checked;
  });
  $("tiltToggle").addEventListener("change", async (e) => {
    if (!e.target.checked) {
      if (tilt) tilt.stop();
      tilt = null;
      return;
    }
    try {
      const t = await startTilt((v) => {
        tiltVec = v;
        if (loop && loop.snapshot.held && !(ai && ai.running)) loop.setStick(v.x, v.y); // an AI drive lease is not the tilt's to steer
      });
      if (!e.target.checked) return t.stop(); // unchecked while the permission prompt was open
      tilt = t;
      $("linkMsg").textContent = "Tilt to steer is on: hold the joystick and tilt the phone. The pose you start in is centre.";
    } catch (err) {
      e.target.checked = false;
      $("linkMsg").textContent = err.message;
    }
  });
  $("camBtn").addEventListener("click", toggleCamera);
  $("camBtn").disabled = !caps.camera;
}

function buildBodyControls() {
  const body = P.bodyByKey(bodyKey);
  const def = P.BODIES[body];
  for (const sec of document.querySelectorAll("[data-for]")) sec.hidden = !sec.dataset.for.split(" ").includes(bodyKey);
  sliders.clear();
  const mk = (parent, names, labels = {}) => {
    parent.replaceChildren();
    for (const n of names) {
      const j = def.joints.find((x) => x.name === n);
      if (!j) continue;
      sliders.set(n, slider(parent, { label: labels[n] || n.replace(/_/g, " "), min: j.min / 10, max: j.max / 10, value: j.home / 10, onInput: (v) => (human(), loop && loop.setJoint(n, v)) }));
    }
  };
  mk($("headSliders"), ["head_pan", "head_tilt", ...(bodyKey === "desk" ? ["torso_yaw"] : [])], { head_pan: "head pan", head_tilt: "head tilt", torso_yaw: "body turn" });
  mk($("armSliders"), ["l_shoulder", "l_elbow", "r_shoulder", "r_elbow"]);
  mk($("walkerSliders"), ["torso_yaw"], { torso_yaw: "torso turn" });
  const gestures = $("gestures");
  gestures.replaceChildren(...Object.keys(GESTURES).map((g) => el("button", { class: "pl-btn sm", type: "button", text: g, onclick: () => playGesture(GESTURES[g]) })));
  $("poses").replaceChildren(...Object.keys(POSES).map((p) => el("button", { class: "pl-btn sm", type: "button", text: p, onclick: () => playGesture([[0, POSES[p]]]) })));
}

function syncSliders() {
  if (!loop) return;
  const s = loop.snapshot;
  const def = P.BODIES[s.body];
  if (!def) return;
  def.joints.forEach((j, i) => sliders.get(j.name) && sliders.get(j.name).set(s.targets[i] / 10));
}

// Gestures and poses are app-side keyframes shared with the AI Pilot (motions.js); the bridge rate-limits every move to 90 deg/s x speed.
function cancelGestures() {
  for (const t of gestureTimers) clearTimeout(t);
  gestureTimers = [];
}
function playGesture(frames) {
  human();
  if (!loop || (loop.link !== LINK.ARMED && loop.link !== LINK.DRIVING)) {
    $("linkMsg").textContent = "Press ARM first.";
    return;
  }
  cancelGestures();
  for (const [at, pose] of frames)
    gestureTimers.push(
      setTimeout(() => {
        if (loop.link !== LINK.ARMED && loop.link !== LINK.DRIVING) return cancelGestures();
        loop.setPose(pose);
        syncSliders();
      }, at),
    );
}

// ================================================================ camera: look at movement

let camBusy = false;
function stopCamera() {
  if (!camera) return;
  camera.stop();
  camera = null;
  $("camBtn").setAttribute("aria-pressed", "false");
  $("cam").hidden = true;
  look = { x: 0, y: 0 };
}

async function toggleCamera() {
  const btn = $("camBtn");
  if (camera) return stopCamera();
  if (camBusy) return; // a second click while the permission prompt is open would open a second stream
  camBusy = true;
  try {
    camera = await startCamera($("cam"), (m) => {
      look = { x: m.x, y: m.y };
      if (!loop || !$("followToggle").checked || (ai && ai.running)) return; // the AI owns the head while it runs a plan
      const l = loop.link;
      if (l !== LINK.ARMED && l !== LINK.DRIVING) return;
      if (bodyKey === "walker") loop.setJoint("torso_yaw", m.x * 40);
      else {
        loop.setJoint("head_pan", m.x * 60);
        loop.setJoint("head_tilt", -m.y * 20);
      }
      syncSliders();
    });
    btn.setAttribute("aria-pressed", "true");
    $("cam").hidden = false;
    $("senseNote").textContent = "Watching for movement. Wave a hand: the eyes follow, and the head too once armed.";
  } catch (e) {
    $("senseNote").textContent = `Camera not available: ${e && e.message ? e.message : e}`;
  } finally {
    camBusy = false;
  }
}

// ================================================================ safety wiring

function stopAll(reason) {
  if (ai) ai.cancel("stop"); // 1. the AI plan, before anything else: STOP always wins and nothing resumes
  cancelGestures(); // 2. app-side gesture timers
  // 3. the loop (below)
  stickCtl.release();
  padCtl.release();
  if (loop) loop.stop(reason);
}

const KEYS = { ArrowUp: [0, 1], ArrowDown: [0, -1], ArrowLeft: [-0.6, 0], ArrowRight: [0.6, 0], w: [0, 1], s: [0, -1], a: [-0.6, 0], d: [0.6, 0] };
const LETTERS = new Set(["w", "a", "s", "d"]);
// Shift or Caps Lock must not change which key is held, or a released key would stay "held" (dead-man)
const keyOf = (e) => (e.key.length === 1 ? e.key.toLowerCase() : e.key);
const down = new Set();
function keyStick() {
  let x = 0;
  let y = 0;
  for (const k of down) (x += KEYS[k][0]), (y += KEYS[k][1]);
  loop.setStick(x, y);
}

function wireSafety() {
  $("stopBtn").addEventListener("click", () => stopAll("Stopped by you. Press ARM to continue."));
  addEventListener("keydown", (e) => {
    const t = e.target instanceof Element ? e.target : null;
    if (e.key === " " || e.key === "Escape") {
      if (e.key === " " && t && t.matches("input[type=text], textarea")) return; // Space keeps typing in a text box; Esc always stops
      // Space keeps its native action on controls (ARM, checkboxes...), except the D-pad: there Space means STOP only
      if (e.key === "Escape" || !t || !t.closest("button, input, select, summary") || t.closest("#dpad")) e.preventDefault();
      stopAll("Stopped by you (keyboard). Press ARM to continue.");
      return;
    }
    const k = keyOf(e);
    if (!loop || bodyKey !== "rover" || !KEYS[k] || e.repeat) return;
    if (t && t.closest("input, select, textarea")) return;
    if (LETTERS.has(k) && t !== $("stick")) return; // single-letter keys only with the joystick focused (WCAG 2.1.4)
    if (loop.link !== LINK.ARMED && loop.link !== LINK.DRIVING) return; // arrows still scroll the page
    e.preventDefault();
    if (!down.size) (human(), loop.setHeld(true));
    down.add(k);
    keyStick();
  });
  addEventListener("keyup", (e) => {
    const k = keyOf(e);
    if (!down.has(k)) return;
    down.delete(k);
    if (!loop) return down.clear();
    if (!down.size) loop.setHeld(false);
    else keyStick();
  });
  addEventListener("blur", () => {
    if (down.size) down.clear(), loop && loop.setHeld(false);
    // the human cannot reach STOP from another window: an AI plan on the real robot stops with the focus
    if (ai && ai.running && mode === "ble") stopAll("The window lost focus, so the robot was told to hold. Press ARM to continue.");
  });
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) return;
    stopAll("The page went to the background, so the robot was told to hold. Press ARM to continue.");
    stopCamera();
  });
  addEventListener("pagehide", () => {
    stopAll("Page closed.");
    stopCamera();
  });
}

// ================================================================ start

function start(withRobot) {
  $("caps").hidden = true;
  $("main").hidden = false;
  $("stopBtn").hidden = false;
  scrollTo(0, 0);
  if (withRobot) {
    mode = "ble";
    document.querySelector('input[name="mode"][value="ble"]').checked = true;
  }
  resize();
  newLoop();
  if (!withRobot) loop.connect(); // the twin connects at once; ARM still needs your tap
  $("mainTitle").focus(); // the start button was just hidden: keep focus at the top of the controls
}

function safeStorage() {
  try {
    return localStorage;
  } catch {
    return null; // storage blocked: settings last until the page closes
  }
}

function init() {
  showCaps();
  initView();
  buildStatic();
  setRig(bodyKey);
  buildBodyControls();
  wireSafety();
  ai = createAiPilot({ getLoop: () => loop, getBodyKey: () => bodyKey, getMode: () => mode, clock: realTimers, getModel: () => aiClient, onChange: (v) => aiPanel && aiPanel.render(v) });
  aiPanel = mountAiPanel({ ai, storage: safeStorage(), setModel: (client) => (aiClient = client), origin: location.origin });
  // voice: one spoken request becomes the same text request as the box (same plan card, same safety rules)
  const voice = createVoiceInput({ lang: navigator.language || "en-US" });
  if (voice.supported) {
    const mic = $("aiVoice");
    mic.hidden = false;
    $("aiVoiceNote").hidden = false;
    mic.addEventListener("click", () => {
      if (voice.listening) return voice.stop();
      voice.start(
        (text) => {
          $("aiInput").value = text;
          $("aiForm").requestSubmit();
        },
        (state) => {
          mic.setAttribute("aria-pressed", String(state === "listening"));
          mic.textContent = state === "listening" ? "Listening…" : "Speak";
          if (state.startsWith("error:")) $("aiStatus").textContent = state === "error:not-allowed" ? "Microphone blocked: allow it in the browser to speak a request." : "Voice did not catch that. Try again, or type it.";
        }
      );
    });
  }
  $("startTwin").addEventListener("click", () => start(false));
  $("startRobot").addEventListener("click", () => start(true));
  $("linkBtn").addEventListener("click", onConnect);
  $("armBtn").addEventListener("click", () => loop && loop.arm());
  $("bodySel").addEventListener("change", (e) => {
    bodyKey = e.target.value;
    setRig(bodyKey);
    buildBodyControls();
    newLoop();
    if (mode === "twin" && !$("main").hidden) loop.connect(); // as at start: the twin links at once, ARM still needs a tap
  });
  for (const r of document.querySelectorAll('input[name="mode"]'))
    r.addEventListener("change", (e) => {
      mode = e.target.value;
      if (mode === "ble" && !bleSupported()) {
        mode = "twin";
        document.querySelector('input[name="mode"][value="twin"]').checked = true;
        $("linkMsg").textContent = caps.ios ? "iPhone browsers have no Web Bluetooth. Keep driving the twin, or open this page in a BLE-capable browser such as Bluefy." : "This browser has no Web Bluetooth. Use Chrome or Edge.";
        return;
      }
      newLoop();
    });
}

init();
