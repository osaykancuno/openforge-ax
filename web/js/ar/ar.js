// AX-1 in your room: the page. It probes the device, shows the start card (or "Open this on your phone"), and wires the
// view (ar-view.js: camera, WebXR, drawing) to the controller (ar-controller.js: every arming and stopping rule).
// This file adds no rule of its own: it forwards what the person does and shows what the controller says.
//
//   * The Rover is armed only by a tap on the floor (the view calls place) or by the ARM button (below).
//   * STOP button, Esc, the page going to the background, the page being closed and the AR session ending all stop it.
//   * Every text is set with textContent; nothing here uses innerHTML or the network.
import { loadConfig, renderChrome } from "../chain.js";
import { describeStep } from "../pilot/ai/tools.js";
import { createVoiceInput } from "../pilot/ai/voice.js";
import { createTwinTransport, realTimers } from "../pilot/twin-transport.js";
import { bodyByKey } from "../pilot/ax-proto.js";
import { LINK } from "../pilot/drive-loop.js";
import { applyTwinState } from "../pilot/twin-pose.js";
import { createWakeLock } from "../pilot/sensors.js";
import { $, chip, el } from "../pilot/ui.js";
import { probeAr } from "./ar-caps.js";
import { NEAR_STOP_M, STOP_GAP_M, createArController } from "./ar-controller.js";
import { CHIPS } from "./chips.js";
import { CAMERA_VIEW, createArView } from "./ar-view.js";
import { createSeek } from "./seek.js";
import { createDetector, createLookAround, xrViewOf } from "./vision/detector.js";
import { createVisionIntents } from "./vision/vision-intents.js";
import { createXrCameraReader, createXrDepthContext } from "./vision/xr-camera.js";
import { createWorldObjects, displayName, toViewLabels, zoneHit } from "./vision/world-objects.js";

await loadConfig();
renderChrome("pilot"); // the same nav (sounds, music, dark, menu) and footer as every other page

const LIVE = new Set(["PLACING", "ARMED", "DRIVING", "LATCHED"]);
const BANNER_CAMERA = "Camera view: the robot is not anchored to your floor (your browser has no WebXR AR).";
const NEEDS_AR = "Obstacle sensing needs Android Chrome AR";
const body = document.body;

const DEBUG = new URLSearchParams(location.search).has("debug"); // ar.html?debug: the AR session's facts on screen
const caps = await probeAr({ nav: navigator, win: window });
const canRun = caps.mode === "xr" || caps.mode === "camera";

// ================================================================ pieces

let view = null;
let viewError = "";
if (canRun) {
  try {
    view = createArView({ canvas: $("arCanvas"), video: $("arVideo"), overlay: $("arOverlay"), debug: DEBUG });
  } catch {
    viewError = "3D drawing is not available on this device.";
  }
}

let lastObstacle = null;
let mic = { listening: false, error: "" };
let model = {};

// the browser's speech recognition, watched so the mic button can show when it listens
const rawVoice = createVoiceInput({ lang: "en-US" });
const voice = {
  get supported() {
    return rawVoice.supported;
  },
  get listening() {
    return rawVoice.listening;
  },
  start(onText, onState = () => {}) {
    return rawVoice.start(onText, (s) => {
      mic = { listening: s === "listening", error: s.startsWith("error:") ? s.slice(6) : "" };
      showMic();
      onState(s);
    });
  },
  stop() {
    rawVoice.stop();
  },
};
const wake = createWakeLock();

const ROVER = bodyByKey("rover");
const extensions = []; // parser extensions (object intents); the controller's parser reads this array on every request

// ---- object finding ("Look around"): the world model, the keep-out zones and the trips exist from the start so that
// "what do you see" answers even when Look around is off. The detector loads only when the toggle is on.
const NO_CAMERA_ACCESS = "Object finding in AR needs camera access, which this browser did not give. Camera view can still tell you what it sees.";
const world = createWorldObjects();
const nowMs = () => globalThis.performance.now();
const roverNow = () => (view && view.placed ? view.worldPose() : null);
let looking = false; // "Look around" is on
let lookToken = 0; // bumped on every start and stop: an old detector load never wins
let detector = null;
let reader = null;
let look = null;
let lookNote = "";
let lookTone = "";
let seekNotice = { text: "", asked: 0 }; // a line from a finished trip, shown until the next request
let rawObstacle = null; // the depth tracker's own result
let zoneBlocked = false;
let lastZoneT = 0;
let seek = null;
let intents = null;

let controller = null;
if (view) {
  controller = createArController({
    makeTransport: () => createTwinTransport({ body: ROVER, clock: realTimers, latencyMs: 15 }),
    voice,
    wake,
    extensions,
    radius: caps.mode === "camera" ? CAMERA_VIEW.radius : 3,
    onChange: (m) => {
      model = m || {};
      if (seek) seek.onAiChange(model.ai); // go to / find: the trip follows the pilot's plans
      render();
    },
  });
  seek = createSeek({
    now: nowMs,
    clock: realTimers,
    world,
    getRover: roverNow,
    getObstacle: () => lastObstacle,
    // a trip asks the pilot for its next plan with plain text, like a chip; the pilot's own rules still apply
    submit: (text) => controller.say(text, { source: "chip" }),
    cancelPlan: (text) => controller.hold(text), // interrupts the plan and zeroes the wheels; the Rover stays armed
    notice: (text) => {
      seekNotice = { text: String(text), asked: askedCount() };
      render();
    },
  });
  intents = createVisionIntents({ world, getRover: roverNow, getViewMode: () => (view && view.mode) || null, isLooking: () => looking, seek });
  controller.seek = seek; // STOP cancels a trip (after the plan, before the wheels)
  extensions.push(intents.extension); // registered even when Look around is off: it then says so
  view.handlers = {
    // every render frame: the controller advances the odometry from what the bridge reports; the twin's joints, wheels and face follow
    frame: (dt, rig) => {
      const p = controller.frame(dt);
      if (intents.avoidLabels().length || zoneBlocked) {
        const t = nowMs();
        if (t - lastZoneT >= 100) {
          lastZoneT = t;
          pushObstacle();
        }
      }
      const snap = controller.snapshot;
      applyTwinState(rig, snap, ROVER, p, 0);
      if (rig.face) rig.face.setMood(snap && snap.link === LINK.DRIVING ? "happy" : snap && (snap.link === LINK.ARMED) ? "idle" : "alert");
      return p;
    },
    // a tap on the floor (the first one arms the twin, inside the controller). Refused while a plan runs: the Rover stays where it is.
    place: (info) => {
      const v = controller.view;
      if (!v.canPlace) return false;
      const busy = v.state === "armed" && Boolean(v.ai && v.ai.running);
      Promise.resolve(controller.place({ gesture: true, source: info.source })).catch(() => {});
      return !busy;
    },
    obstacle: (u) => {
      rawObstacle = u;
      pushObstacle();
    },
    visibility: (s) => controller.visibility(s), // "hidden" stops, "visible-blurred" holds
    ended: (reason) => {
      controller.ended(reason);
      leaveLive(reason);
    },
    hint: (t) => showHint(t),
  };
}

/** The tracker's result with the keep-out discs of "avoid the X" merged in (the nearer obstacle wins). */
function pushObstacle() {
  let u = rawObstacle;
  const zones = intents.avoidZones(nowMs());
  const w = zones.length && view.placed ? view.worldPose() : null;
  const z = w ? zoneHit(zones, w) : { hit: false };
  if (z.hit && !(u && u.state === "blocked" && Number.isFinite(u.distanceM) && u.distanceM <= z.distanceM)) {
    const d = Math.round(z.distanceM * 10) / 10;
    u = { state: "blocked", distanceM: d, nearM: z.distanceM, message: `Something is in my way (about ${Math.round(d * 100)} cm ahead): the ${displayName(z.label)}.` };
    zoneBlocked = true;
  } else if (zoneBlocked && !z.hit) {
    zoneBlocked = false;
    u = u || { state: "clear", distanceM: null, message: "" };
  }
  if (!u) return;
  lastObstacle = u;
  controller.obstacle(u);
  showObstacle();
}

const askedCount = () => (Array.isArray(model.ai?.messages) ? model.ai.messages.filter((m) => m.role === "user").length : 0);

function setLookNote(text, tone = "") {
  lookNote = text || "";
  lookTone = tone;
  syncLook();
}

function syncLook() {
  const c = $("arLookChip");
  c.hidden = !lookNote;
  if (lookNote) setChip(c, lookNote, lookTone);
  const b = $("arLookBtn");
  b.hidden = !LIVE.has(stateName()) && !looking;
  b.setAttribute("aria-pressed", String(looking));
  setText(b, "Look around");
}

/** Look around off: the finder, its model, the labels, any trip and any keep-out zone go. */
function stopObjects(note = "") {
  lookToken++;
  looking = false;
  look = null;
  if (view) {
    view.onCameraFrame(null);
    view.setLabels([]);
  }
  try {
    reader?.close();
  } catch {}
  try {
    detector?.close();
  } catch {}
  reader = null;
  detector = null;
  world.clear();
  if (seek) seek.cancel();
  if (intents) intents.clearAvoid();
  zoneBlocked = false;
  setLookNote(note);
}

/**
 * "Look around (find objects)" on: loads the on-phone detector (up to about 19 MB, same origin, nothing leaves the phone),
 * then reads camera frames at 2 Hz. In AR the frames need camera access; otherwise only the camera view can look.
 * ctx = { info (what startXr returned, or {}), mode, wantedAtStart }.
 */
async function startObjects(ctx) {
  stopObjects();
  const token = lookToken;
  const xr = ctx.mode === "xr";
  looking = true;
  if (xr && !(ctx.info && ctx.info.cameraAccess && ctx.info.gl && ctx.info.session)) {
    stopObjects(ctx.wantedAtStart ? NO_CAMERA_ACCESS : "Turn Look around on before you start AR, so the browser can ask for camera access.");
    return;
  }
  setLookNote("Loading the object finder…", "warn");
  // the worker does the heavy lifting; the main-thread fallback looks only while the Rover is not armed (a stall latches the twin)
  const mine = createDetector({
    mode: xr ? "IMAGE" : "VIDEO",
    mayRunOnMain: () => !controller.view.armed,
    onNotice: (text) => {
      if (token !== lookToken) return;
      if (mine.disabled) stopObjects(text); // too slow, or it stopped working: driving goes on without it
      else setLookNote(text, "warn"); // information only (it looks while the Rover is idle)
    },
  });
  detector = mine;
  let ok = false;
  try {
    ok = await mine.load();
  } catch {
    ok = false;
  }
  if (token !== lookToken) return; // turned off, or the session ended, while it loaded
  if (!ok) {
    stopObjects(mine.reason || "Object finding could not start on this device. You can keep driving.");
    return;
  }
  if (xr) {
    reader = createXrCameraReader(ctx.info.gl, ctx.info.session);
    if (!reader.supported) {
      stopObjects(NO_CAMERA_ACCESS);
      return;
    }
  }
  look = createLookAround({
    detector: mine,
    reader,
    // runs inside the frame callback: the XR frame and its depth are only valid here, the answer comes later
    capture: (frameInfo) => (frameInfo.kind === "xr" ? createXrDepthContext(frameInfo.frame, xrViewOf(frameInfo)) : null),
    onDetections: (dets, t, frameInfo, depth) => {
      if (token !== lookToken) return;
      world.update(dets, t, depth || {});
      view.setLabels(toViewLabels(world.list(t)));
    },
  });
  const run = look;
  view.onCameraFrame((frameInfo) => run.tick(frameInfo));
  setLookNote(mine.where === "main" ? "Looking around while the Rover is not driving" : "Looking around", "ok");
}

// ================================================================ screens

function show(id, on) {
  $(id).hidden = !on;
}

/** Writes text only when it changed: a live region re-reads whatever is written, even the same words. */
function setText(node, text) {
  const t = String(text ?? "");
  if (node.textContent !== t) node.textContent = t;
}
function setChip(node, text, tone) {
  if (node.textContent !== text || (node.dataset.tone || "") !== (tone || "")) chip(node, text, tone);
}

/** Screen readers: what changed. "alert" for stops and failures, polite for the rest. Emptied first, so a repeat is read again. */
function announce(text, urgent = false) {
  const node = $(urgent ? "arAlert" : "arAnnounce");
  node.textContent = "";
  if (text) setTimeout(() => (node.textContent = String(text)), 50);
}

/** Moves focus only when it was lost: on the page itself, or on a control that is now hidden or disabled. */
function focusIfLost(node) {
  const a = document.activeElement;
  if (!node || node.hidden || node.disabled) return;
  if (!a || a === body || a === document.documentElement || a.closest?.("[hidden]") || a.disabled || a.getAttribute?.("aria-disabled") === "true") node.focus();
}

function showCard() {
  show("arStart", false);
  show("arDesktop", false);
  if (!canRun || !view) {
    show("arDesktop", true);
    $("arUrl").textContent = location.href.split("#")[0];
    const none = caps.mode === "none" || Boolean(viewError);
    $("arDesktopTitle").textContent = none ? "AR cannot start here" : "Open this on your phone";
    $("arDesktopWhy").textContent = viewError || (none ? `${caps.why} You can open this page on another phone:` : "AX-1 in your room uses your phone's camera to put the twin on your floor. Open this page on your phone:");
    return;
  }
  show("arStart", true);
  const xr = caps.mode === "xr";
  $("arStartBtn").textContent = xr ? "Start AR" : "Start camera view";
  $("arLead").textContent = xr
    ? "Meet the AX-1 Rover as a digital twin on your own floor. Point your phone at the ground, tap to place it, then tell it what to do. It is not a real robot."
    : "Meet the AX-1 Rover as a digital twin in front of your camera. Your browser has no WebXR AR, so it is not anchored to your floor. It is not a real robot.";
  if (caps.voice) show("arVoiceBtn", true);
}

function leaveLive(message) {
  body.classList.remove("ar-live", "ar-xr");
  for (const id of ["arTop", "arHud", "arStop", "arBanner", "arHint"]) show(id, false);
  showCard();
  starting = false;
  $("arStartBtn").removeAttribute("aria-disabled");
  $("arStartMsg").textContent = message ? String(message) : "";
  $("arStartMsg").dataset.tone = "";
  hintNow = "";
  lastObstacle = null;
  rawObstacle = null;
  stopObjects();
  seekNotice = { text: "", asked: 0 };
  render();
  focusIfLost($("arStartBtn"));
}

let hintNow = "";
function showHint(t) {
  hintNow = t ? String(t) : "";
  applyHint();
}
function applyHint() {
  const on = Boolean(hintNow) && stateName() === "PLACING";
  show("arHint", on);
  if (on) setText($("arHint"), hintNow);
}

function stateName() {
  return String(model.state ?? controller?.state ?? "").toUpperCase();
}

function obstacleText(u) {
  if (view && view.mode === "camera") return [NEEDS_AR, "warn"];
  if (!u) return ["Obstacle sensing: waiting", ""];
  switch (u.state) {
    case "clear":
      return ["Path clear", "ok"];
    case "blocked": {
      const near = Number.isFinite(u.nearM) ? u.nearM : 0;
      // seen but still room: the Rover drives on and stops STOP_GAP_M before it
      if (near > NEAR_STOP_M) return [`Obstacle about ${Math.round((u.distanceM ?? near) * 100)} cm ahead`, "warn"];
      return [`Stopped ${Math.round(STOP_GAP_M * 100)} cm before an obstacle`, "bad"];
    }
    case "blind":
      return ["Point the phone at the Rover", "warn"];
    default:
      return [u.message ? String(u.message) : "Obstacle sensing is off", "warn"];
  }
}

let lastObstacleTone = "";
function showObstacle() {
  const [text, tone] = obstacleText(lastObstacle);
  setChip($("arObstacle"), text, tone); // not a live region: the distance changes every 10 cm
  if (tone === lastObstacleTone) return;
  const was = lastObstacleTone;
  lastObstacleTone = tone;
  if (!LIVE.has(stateName())) return;
  if (tone === "bad") announce(`I stopped ${Math.round(STOP_GAP_M * 100)} centimetres before something in my way. I can turn or back up.`, true);
  else if (was === "bad" && tone === "ok") announce("Path clear.");
}

// The microphone permission. The browser asks with a prompt that is not shown inside AR, so it is asked on the start
// card (Enable microphone); inside AR the mic button does not ask, it says what to do. "unknown": no Permissions API
// (Safari): the mic button then just tries.
let micState = "unknown"; // "granted" | "prompt" | "denied" | "unknown"
let micNote = "";
const MIC_OFF_NOTE = "Voice needs the microphone, and the browser cannot ask for it inside AR. Tap Exit, then Enable microphone.";
async function watchMic() {
  try {
    const st = await navigator.permissions.query({ name: "microphone" });
    micState = st.state;
    st.onchange = () => {
      micState = st.state;
      if (micState === "granted") micNote = "";
      showMicPermission();
      showMic();
    };
  } catch {} // no Permissions API, or no "microphone" in it
  showMicPermission();
  showMic();
}
/** The start card's microphone button says where the permission stands. */
function showMicPermission() {
  const b = $("arVoiceBtn");
  if (micState === "granted") {
    b.textContent = "Microphone on";
    b.setAttribute("aria-disabled", "true");
  } else {
    b.textContent = micState === "denied" ? "Microphone blocked" : "Enable microphone";
    b.removeAttribute("aria-disabled");
  }
}
const micMissing = () => micState === "prompt" || micState === "denied";

/**
 * Why getUserMedia gave no microphone, and where to fix it. On Android a refusal without any question on screen means
 * Android has not given the microphone to Chrome, or Chrome stopped asking after earlier refusals: the site's own
 * permissions do not even list the microphone then (seen on a Galaxy S24).
 */
export function micFailText(name, siteState) {
  switch (name) {
    case "NotAllowedError":
    case "SecurityError":
      if (siteState === "denied") return "The microphone is blocked for this site. Tap the icon left of the address, then Permissions, then Microphone: Allow. Then tap Enable microphone again.";
      return "Chrome did not get the microphone, and no question appeared. On Android: Settings, Apps, Chrome, Permissions, Microphone: Allow. If it still fails: tap the icon left of the address, then Reset permissions, and tap Enable microphone again.";
    case "NotReadableError":
    case "AbortError":
      return "Another app is using the microphone. Close it, then tap Enable microphone again.";
    case "NotFoundError":
    case "OverconstrainedError":
      return "No microphone was found on this device.";
    default:
      return `The microphone did not start${name ? ` (${String(name).slice(0, 40)})` : ""}. Tap Enable microphone to try again.`;
  }
}

function showMic() {
  const listening = Boolean(model.listening ?? mic.listening);
  const mb = $("arMic");
  mb.setAttribute("aria-pressed", String(listening));
  setText($("arMicText"), !voice.supported ? "Voice is not available" : listening ? "Listening… tap to stop" : micMissing() ? "Microphone off" : "Tap to talk");
  mb.disabled = !voice.supported || !LIVE.has(stateName());
  const priv = $("arPrivacy");
  if (micNote) setText(priv, micNote);
  else if (model.voiceNote) setText(priv, model.voiceNote);
  else if (!voice.supported) setText(priv, "Your browser has no speech recognition. Chrome on Android and Safari on iPhone have it. The quick buttons work everywhere.");
  else setText(priv, "Your browser's speech service hears the mic (Google in Chrome, Apple in Safari).");
}

function steps(plan) {
  return (plan.steps || []).map((s) => describeStep(s));
}

const PLAN_STATUS = { ready: "ready", running: "running", done: "done", interrupted: "interrupted", stopped: "stopped", discarded: "replaced" };

function showTalk() {
  const ai = model.ai || {};
  const msgs = Array.isArray(ai.messages) ? ai.messages : [];
  const progress = ai.progress || null;
  let at = -1;
  for (let i = msgs.length - 1; i >= 0 && at < 0; i--) if (msgs[i].role === "user") at = i;
  const userMsg = at >= 0 ? msgs[at] : null;
  // a spoken request comes with its own "I heard: ..." from the controller; a tapped chip shows its phrase
  setText($("arHeard"), model.heard ? String(model.heard) : userMsg ? `You asked: “${userMsg.text}”` : "");
  const out = [];
  const sig = [];
  for (const m of at >= 0 ? msgs.slice(at + 1) : []) {
    if (m.role === "plan" && m.plan) {
      const p = m.plan;
      const list = el("ol", { class: "pl-ai-steps" });
      const words = steps(p);
      words.forEach((t) => list.append(el("li", { text: t })));
      const status = p.status === "ready" && p.blocked ? "waiting for ARM" : PLAN_STATUS[p.status] || p.status;
      out.push(el("p", { class: "ar-plan-head", text: `Plan · ${status}` }), list);
      sig.push(`Plan · ${status}`, ...words);
      if (p.note) {
        out.push(el("p", { class: "pl-ai-note", text: p.note }));
        sig.push(p.note);
      }
    } else if (m.text && (m.role === "notice" || m.role === "pilot" || m.role === "model")) {
      out.push(el("p", { class: "pl-ai-note", text: m.text }));
      sig.push(m.text);
    }
  }
  const notes = [];
  if (seekNotice.text && seekNotice.asked === askedCount()) notes.push(seekNotice.text);
  for (const t of [model.notice, model.message]) if (t) notes.push(String(t));
  for (const t of notes) out.push(el("p", { class: "pl-ai-note", text: t }));
  sig.push(...notes);
  const plan = $("arPlan");
  const key = sig.join("\n");
  if (plan.dataset.sig !== key) {
    plan.dataset.sig = key;
    plan.replaceChildren(...out);
  }
  // the panel only takes room when it has something to say: the middle of the screen is where the Rover is
  show("arTalk", Boolean($("arHeard").textContent) || out.length > 0);
  // the step that runs now: an attribute, so the list is not read out again on every step
  const running = msgs
    .slice(at + 1)
    .filter((m) => m.role === "plan" && m.plan)
    .pop();
  const now = running && running.plan.status === "running" && progress ? progress.index : -1;
  const lists = plan.querySelectorAll("ol");
  const items = lists.length ? lists[lists.length - 1].children : [];
  for (let i = 0; i < items.length; i++) {
    if (i === now) items[i].dataset.now = "true";
    else delete items[i].dataset.now;
  }
}

let prevState = "";
function render() {
  const st = stateName();
  const live = LIVE.has(st);
  const was = prevState;
  prevState = st;
  if (live || st === "STARTING") body.classList.add("ar-live");
  else if (!starting) body.classList.remove("ar-live", "ar-xr"); // the controller says READY after leaveLive (ended() is async): the site chrome comes back
  show("arTop", live);
  show("arHud", live);
  show("arStop", live);
  syncLook();
  show("arBanner", live && view && view.mode === "camera");
  if (view && view.mode === "camera") setText($("arBanner"), view.orientationOn ? BANNER_CAMERA : `${BANNER_CAMERA} Motion access is off, so the view stays still.`);
  applyHint();
  const driving = st === "ARMED" && model.link === LINK.DRIVING;
  const link = driving ? ["Driving", "live"] : { PLACING: ["Place the Rover", "warn"], ARMED: ["Armed", "ok"], LATCHED: ["Stopped · press ARM", "warn"] }[st] || ["Offline", ""];
  setChip($("arLink"), link[0], link[1]);
  $("arArm").disabled = !model.canArm;
  show("arPlaceBtn", st === "PLACING");
  body.classList.toggle("ar-placing", st === "PLACING"); // placing: only Place and STOP, the floor ring stays in view
  showMic();
  showObstacle();
  showTalk();
  if (st !== was) stateChanged(was, st);
}

/** Screen-reader announcements and focus when the state changes (the chips themselves are not read on every frame). */
function stateChanged(was, st) {
  if (st === "PLACING") {
    const camera = view && view.mode === "camera";
    announce(`${camera ? `${BANNER_CAMERA} ` : ""}Place the Rover: ${camera ? "tap the picture" : "point at the floor and tap"}, or press Place the Rover here.`);
    focusIfLost($("arPlaceBtn"));
  } else if (st === "ARMED" && (was === "PLACING" || was === "LATCHED")) {
    announce("Armed. Press Tap to talk, or use the quick commands.");
    focusIfLost($("arMic").disabled ? $("arStop") : $("arMic"));
  } else if (st === "LATCHED") {
    announce(was === "PLACING" ? "The Rover is placed but not armed. Press ARM to drive." : "Stopped. Press ARM to drive again.", was !== "PLACING");
    focusIfLost($("arArm").disabled ? $("arStop") : $("arArm"));
  } else if (LIVE.has(was) && !LIVE.has(st)) {
    focusIfLost($("arStartBtn")); // the session is over: back to Start (the focused Exit or STOP is hidden now)
  }
}

// ================================================================ start

let starting = false;
let lastStart = { info: {}, mode: null }; // what the view returned when this session began (the Look around button needs it)

/** The browser's motion permission (iPhone). It must be called in the tap, before any await. */
function requestOrientation() {
  const D = globalThis.DeviceOrientationEvent;
  if (!D) return Promise.resolve("denied");
  if (typeof D.requestPermission === "function") {
    try {
      return Promise.resolve(D.requestPermission()).catch(() => "denied");
    } catch {
      return Promise.resolve("denied");
    }
  }
  return Promise.resolve("granted");
}

function failText(e) {
  const n = e && e.name;
  if (n === "NotAllowedError" || n === "PermissionDeniedError") return "The camera was not allowed. Allow it in your browser and tap Start again.";
  if (n === "NotFoundError" || n === "OverconstrainedError") return "No camera was found on this device.";
  if (n === "SecurityError") return "AR needs a secure page (HTTPS).";
  if (n === "NotSupportedError") return "This browser cannot start AR here. Try the camera view or the 3D twin.";
  return `It did not start${n ? ` (${String(n).slice(0, 40)})` : ""}. Tap Start to try again.`;
}

async function onStart() {
  if (starting || !view || !controller) return;
  starting = true;
  $("arStartBtn").setAttribute("aria-disabled", "true"); // not disabled: a disabled button would drop the focus
  const mode = caps.mode;
  const wantObjects = $("arLook").checked;
  $("arStartMsg").textContent = mode === "xr" ? "Starting AR…" : "Opening the camera…";
  $("arStartMsg").dataset.tone = "";
  // nothing may be awaited before these two calls: the browser wants the tap that started them
  const oriP = mode === "camera" ? requestOrientation() : null;
  const opened = mode === "xr" ? view.startXr({ wantObjects }) : view.startCamera({ orientation: oriP });
  try {
    const info = await opened;
    show("arStart", false);
    show("arDesktop", false);
    body.classList.add("ar-live");
    if (mode === "xr") body.classList.add("ar-xr");
    $("arStartMsg").textContent = "";
    announce("", true); // an earlier failure's alert is over
    if (!(await controller.start(mode))) {
      // the twin could not start: close the view again and say why
      const why = controller.view.message || "The twin could not start. Tap Start to try again.";
      view.exit(why);
      return;
    }
    lastStart = { info, mode };
    if (wantObjects) startObjects({ info, mode, wantedAtStart: true }).catch(() => stopObjects("Object finding could not start on this device. You can keep driving."));
    render();
  } catch (e) {
    starting = false;
    $("arStartBtn").removeAttribute("aria-disabled");
    $("arStartMsg").textContent = failText(e);
    $("arStartMsg").dataset.tone = "bad";
    announce(failText(e), true);
    body.classList.remove("ar-live", "ar-xr");
    if (view.mode) view.exit(failText(e)); // the camera or AR opened, then something after it failed: close it again
  }
}

// ================================================================ events

if (view && controller) {
  $("arStartBtn").addEventListener("click", onStart);

  $("arVoiceBtn").addEventListener("click", async () => {
    // a one-time microphone permission now, on the start card, so no prompt appears inside AR
    const b = $("arVoiceBtn");
    if (b.getAttribute("aria-disabled") === "true") return;
    b.setAttribute("aria-disabled", "true");
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: true });
      s.getTracks().forEach((t) => t.stop());
      micState = "granted";
      micNote = "";
      $("arStartMsg").textContent = "Microphone on. Voice is ready.";
      $("arStartMsg").dataset.tone = "";
    } catch (e) {
      // ask the browser where the permission really stands: "denied" only when the SITE is blocked
      let site = "unknown";
      try {
        site = (await navigator.permissions.query({ name: "microphone" })).state;
      } catch {}
      if (site === "denied" || site === "prompt" || site === "granted") micState = site;
      $("arStartMsg").textContent = `${micFailText(e && e.name, site)} The buttons work without it.`;
      $("arStartMsg").dataset.tone = "bad";
    }
    showMicPermission();
    showMic();
  });

  const stop = (why) => controller.stop(why);
  $("arStop").addEventListener("pointerdown", () => stop("STOP button")); // as early as the finger lands
  $("arStop").addEventListener("click", () => stop("STOP button")); // keyboard and assistive tools
  addEventListener("keydown", (e) => {
    if (e.key === "Escape") stop("Esc");
  });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      stop("The page went to the background.");
      if (view.mode === "camera") view.exit("The camera paused when the page went to the background.");
    }
  });
  addEventListener("pagehide", () => {
    stop("The page closed.");
    stopObjects();
    view.exit("The page closed.");
  });

  // ARM: only this button, an explicit click, through the controller
  $("arArm").addEventListener("click", (e) => {
    if (!e.isTrusted) return; // a person's click only
    controller.arm().catch(() => {});
  });
  $("arLookBtn").addEventListener("click", () => {
    if (looking) stopObjects("Look around is off.");
    else startObjects({ ...lastStart, wantedAtStart: false }).catch(() => stopObjects("Object finding could not start on this device. You can keep driving."));
  });
  $("arExit").addEventListener("click", () => view.exit("Closed"));
  $("arPlaceBtn").addEventListener("click", (e) => e.isTrusted && view.placeHere()); // a tap without a pointer: same path, same rules
  $("arMic").addEventListener("click", () => {
    if (micMissing() && !(model.listening ?? mic.listening)) {
      // the browser's question would be invisible inside AR: say what to do instead of asking
      micNote = MIC_OFF_NOTE;
      showMic();
      announce(MIC_OFF_NOTE);
      return;
    }
    micNote = "";
    controller.listen(); // starts listening for one sentence, or stops when it already listens
  });

  // A tap is the chip's short move; holding Forward, Back, Left or Right keeps the Rover moving until the finger lifts
  // (controller.press / release: short leases, the same obstacle and edge guards).
  const chips = $("arChips");
  const HOLDABLE = new Set(["forward", "back", "left", "right"]);
  const HOLD_START_MS = 250;
  for (const c of CHIPS) {
    const b = el("button", { class: "pl-btn", type: "button", "data-chip": c.id, text: c.label });
    let timer = null;
    let held = false; // a hold happened: the click that follows the lift is not a tap
    b.addEventListener("click", () => {
      if (held) {
        held = false;
        return;
      }
      controller.chip(c.id);
    });
    if (HOLDABLE.has(c.id)) {
      const lift = () => {
        clearTimeout(timer);
        timer = null;
        if (held) controller.release();
      };
      b.addEventListener("pointerdown", (e) => {
        if (!e.isTrusted || e.button > 0) return;
        held = false;
        try {
          b.setPointerCapture(e.pointerId);
        } catch {}
        timer = setTimeout(() => {
          timer = null;
          held = controller.press(c.id);
        }, HOLD_START_MS);
      });
      for (const t of ["pointerup", "pointercancel", "lostpointercapture"]) b.addEventListener(t, lift);
      b.addEventListener("contextmenu", (e) => e.preventDefault()); // a long press must not open the phone's menu
    }
    chips.append(b);
  }
}

showCard();
render();
if (caps.voice) watchMic();

if (DEBUG && view) {
  // inside the overlay: in AR it is the only part of the page on screen
  const pre = el("pre", { class: "ar-debug", "aria-hidden": "true" });
  $("arOverlay").append(pre);
  setInterval(() => {
    pre.textContent = `${view.diagnostics()}\nstate ${stateName()} · link ${model.link ?? "-"}`;
  }, 500);
}
