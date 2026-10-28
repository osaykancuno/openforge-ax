// My IRL lab (AX-1 in AR): the page. It probes the device, shows the start card (or "Open this on your phone"), and wires the
// view (ar-view.js: camera, WebXR, drawing) to the controller (ar-controller.js: every arming and stopping rule).
// This file adds no rule of its own: it forwards what the person does and shows what the controller says.
//
//   * The Rover is armed only by a tap on the floor (the view calls place) or by the ARM button (below).
//   * STOP button, Esc, the page going to the background, the page being closed and the AR session ending all stop it.
//   * Every text is set with textContent; nothing here uses innerHTML or the network.
//
// ar.html?agent=<tokenId> (bring your agent to life): the page reads the token's look through chain.js (tokenMeta, the one
// network read of this page, only with this parameter) and dresses the twin with it (agent-rig.js on top of the token art's own
// look). An AX-1 class (Rover, Desk, Walker) is driven as always. The other eight classes are a SHOWCASE (showcase.js): the
// same shape as the controller, with nothing to arm or stop, that plays the token's signature move and turns on the spot.
import { isDeployed, loadConfig, renderChrome, tokenMeta } from "../chain.js";
import { describeStep } from "../pilot/ai/tools.js";
import { createTwinTransport, realTimers } from "../pilot/twin-transport.js";
import { LINK } from "../pilot/drive-loop.js";
import { applyTwinState } from "../pilot/twin-pose.js";
import { stateChannels } from "../pilot/ax-proto.js";
import { createGait } from "./gait.js";
import { createWakeLock } from "../pilot/sensors.js";
import { $, chip, el } from "../pilot/ui.js";
import { qrArt } from "../qr.js";
import { probeAr } from "./ar-caps.js";
import { openQuickLook, quickLookSupported, usdzUrl } from "./quick-look.js";
import { agentFromMeta, parseAgentParam } from "./agent-token.js";
import { dressAgent, robotIdOf } from "./agent-rig.js";
import { SHOWCASE_NOTE, createShowcase } from "./showcase.js";
import { onTable } from "./orientation.js";
import { canShareFile, composePhoto, photoFileName, savePhoto, sharePhoto, toJpeg } from "./photo.js";
import { BODY_NAMES, NEAR_STOP_M, STOP_GAP_M, createArController } from "./ar-controller.js";
import { chipsFor } from "./chips.js";
import { CAMERA_VIEW, createArView } from "./ar-view.js";
import { createSeek } from "./seek.js";
import { createDetector, createLookAround, xrViewOf } from "./vision/detector.js";
import { createVisionIntents } from "./vision/vision-intents.js";
import { createXrCameraReader, createXrDepthContext } from "./vision/xr-camera.js";
import { createWorldObjects, displayName, toViewLabels, zoneHit } from "./vision/world-objects.js";

await loadConfig();
renderChrome("ar"); // the same nav (sounds, music, dark, menu) and footer as every other page; "My IRL lab" is active

const LIVE = new Set(["PLACING", "ARMED", "DRIVING", "LATCHED"]);
// the camera view (no WebXR AR: iPhone, iPad, other browsers). With the motion sensors the twin stands on the floor and
// stays put while the phone turns; nothing in a browser there follows the person's steps, so the page says so.
const BANNER_CAMERA = "Camera view: the twin stands on your floor and stays put when you turn your phone. It does not follow your steps, and its size is approximate.";
const BANNER_CAMERA_STILL = "Camera view: motion access is off, so the twin is drawn in front of the camera, not on your floor.";
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
let lastObstacleBack = null; // the tracker behind the Rover (reversing)
let model = {};

const wake = createWakeLock();

let bodyKey = "rover"; // the body picked on the start card ("showcase" for an agent shown, not driven); fixed while a session runs
let agent = null; // ar.html?agent=<id>, once its token is read: { id, tag, callsign, className, traits, kind: "ax1" | "showcase", body, prime }
let showing = false; // the agent is a showcase (its class is not an AX-1 body): no ARM, no STOP, nothing drives
const bodyName = () => (showing ? agent.className : BODY_NAMES[bodyKey]);
const extensions = []; // parser extensions (object intents); the controller's parser reads this array on every request

// ---- object finding ("Look around"): the world model, the keep-out zones and the trips exist from the start so that
// "what do you see" answers even when Look around is off. The detector loads only when the toggle is on.
const NO_CAMERA_ACCESS = "Object finding in AR needs camera access, which this browser did not give. Camera view can still tell you what it sees.";
const world = createWorldObjects();
const nowMs = () => globalThis.performance.now();

// the Walker twin's walk cycle: the step offsets (gait.js) on top of the pose the bridge reports, paced by how far the
// controller moved it this frame, so the legs settle back into that pose when it stops
const gait = createGait();
function walkLegs(rig, snap, dt, p) {
  gait.step(dt, p.ds, p.dyaw);
  if (!gait.amp) return;
  const names = stateChannels(controller.body);
  const pos = snap && snap.state && snap.state.positions;
  for (const [joint, deg] of Object.entries(gait.offsets())) {
    const i = names.indexOf(joint);
    rig.set(joint, (pos && i >= 0 && i < pos.length ? pos[i] / 10 : 0) + deg);
  }
}
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

let controller = null; // the AX-1 controller, or the showcase when the agent is shown (dressTwin)
let axController = null;
let showcase = null;
/** Every change of the twin's state (either controller): the page shows what it says. */
const onModel = (m) => {
  model = m || {};
  if (seek) seek.onAiChange(model.ai); // go to / find: the trips follow the pilot's plans
  render();
};
if (view) {
  controller = axController = createArController({
    makeTransport: (b) => createTwinTransport({ body: b, clock: realTimers, latencyMs: 15 }),
    wake, // no voice on this page for now (2026-10-28): buttons only
    extensions,
    radius: caps.mode === "camera" ? CAMERA_VIEW.radius : 3,
    onChange: onModel,
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
      if (showing) return showcase.frame(dt); // the joints and the body follow the token's own motion (showcase.js); the turn is the yaw
      const p = controller.frame(dt);
      if (intents.avoidLabels().length || zoneBlocked) {
        const t = nowMs();
        if (t - lastZoneT >= 100) {
          lastZoneT = t;
          pushObstacle();
        }
      }
      const snap = controller.snapshot;
      applyTwinState(rig, snap, controller.body, p, 0);
      if (controller.bodyKey === "walker") walkLegs(rig, snap, dt, p);
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
      if (u && u.side === "back") {
        // behind: no keep-out zones there, straight to the controller
        lastObstacleBack = u;
        controller.obstacle(u);
        showObstacle();
        return;
      }
      rawObstacle = u;
      pushObstacle();
    },
    visibility: (s) => controller.visibility(s), // "hidden" stops, "visible-blurred" holds
    ended: (reason) => {
      controller.ended(reason);
      leaveLive(reason);
    },
    hint: (t) => showHint(t),
    light: () => showObstacle(), // the chip says when sensing is less sure in the dark
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
  b.hidden = (!LIVE.has(stateName()) && !looking) || bodyKey !== "rover"; // object finding: the Rover only in v1
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
    const url = location.href.split("#")[0];
    const qr = qrArt(url); // drawn here, no network: the link never leaves this page
    $("arQr").setAttribute("viewBox", qr.viewBox);
    $("arQrPath").setAttribute("d", qr.modules);
    $("arQrEyes").setAttribute("d", qr.eyes);
    const { x, y, w } = qr.hole; // the AX-1 mark on a white pad, in the hole level H leaves for it
    for (const [k, v] of Object.entries({ x, y, width: w, height: w, rx: w * 0.18 })) $("arQrPad").setAttribute(k, v);
    $("arQrLogo").setAttribute("transform", `translate(${x + w * 0.06} ${y + w * 0.06}) scale(${(w * 0.88) / 100})`);
    $("arCopy").onclick = async () => {
      const msg = $("arCopyMsg");
      try {
        await navigator.clipboard.writeText(url);
        msg.textContent = "Link copied. Send it to your phone.";
        delete msg.dataset.tone;
      } catch {
        msg.textContent = "This browser would not copy the link. Scan the code instead.";
        msg.dataset.tone = "warn";
      }
    };
    const none = caps.mode === "none" || Boolean(viewError);
    $("arDesktopTitle").textContent = none ? "AR cannot start here" : "Open this on your phone";
    $("arDesktopWhy").textContent = viewError || (none ? `${caps.why} Scan this code with another phone:` : "My IRL lab uses your phone's camera to put the twin on your floor. Scan this code with your phone:");
    return;
  }
  show("arStart", true);
  const xr = caps.mode === "xr";
  const n = bodyName();
  const a = agent;
  $("arStartBtn").textContent = xr ? "Start AR" : "Start camera view";
  const does = { rover: "drive it with the buttons", desk: "make it wave, nod and point with the buttons", walker: "walk it and pose it with the buttons" }[bodyKey];
  const onDesk = showing ? onTable(`agent:${robotIdOf(a)}`) : bodyKey === "desk";
  const surface = onDesk ? "a table" : "the floor";
  const where = xr ? `Point your phone at ${onDesk ? "a table or the floor" : "the ground"}` : `Your browser has no WebXR AR, so the camera view is used: point at ${surface}`;
  const camera = xr ? "" : " It stays put when you turn your phone but does not follow your steps.";
  if (a) {
    // ar.html?agent=<id>: the title and the lead name the agent; the twin is honest about being a twin
    $("arFig").replaceChildren(document.createTextNode("FIG. 01 · "), el("b", { text: "Your agent, in real life" }));
    $("arTitle").textContent = `${a.tag} · ${a.callsign}`;
    const what = showing ? `your ${a.className} as a digital twin, at its real size` : `its AX-1 ${n} body as a digital twin, in the finish and add-on of your token`;
    const then = showing ? "play its signature move, turn it around and take a photo" : does;
    $("arLead").textContent = `Bring ${a.tag} ${a.callsign} to life: ${what}, ${xr ? "in your own room" : "on your floor"}. ${where}, tap to place it, then ${then}.${camera} It is a twin, not a real robot. Camera pictures never leave this phone.`;
  } else {
    $("arFig").replaceChildren(document.createTextNode("FIG. 01 · "), el("b", { text: "The twin, in real life" }));
    $("arTitle").textContent = "My IRL lab";
    $("arLead").textContent = xr
      ? `Meet the AX-1 ${n} as a digital twin in your own room. Point your phone at ${bodyKey === "desk" ? "a table or the floor" : "the ground"}, tap to place it, then ${does}. It is not a real robot. Camera pictures never leave this phone.`
      : `Meet the AX-1 ${n} as a digital twin. Your browser has no WebXR AR, so the camera view is used: point at ${bodyKey === "desk" ? "a table" : "the floor"}, tap to place it, then ${does}. It stays put when you turn your phone but does not follow your steps. It is not a real robot. Camera pictures never leave this phone.`;
  }
  show("arBodies", !a); // an agent has its own body: no picker
  $("arStep2").textContent = showing ? `Point at ${surface}, then tap to put the ${n} down.` : bodyKey === "desk" ? "Point at a table or the floor, then tap to put the Desk down." : `Point at the floor, then tap to put the ${n} down.`;
  $("arStep3").textContent = showing
    ? "Tap Its move to see its signature move. Tap Turn left or Turn right to turn it, or hold to keep turning. Take a photo whenever you like."
    : bodyKey === "rover" ? "Tap a button for a short move, or hold Forward, Back, Left or Right to keep moving. STOP always stops it." : bodyKey === "walker" ? "Tap Forward, Back, Left or Right for a few steps, or hold one to keep walking; the other buttons are poses. STOP always stops it." : `Tap a button: the ${n} does that move. STOP always stops it.`;
  // photos with the room in AR need the camera picture: asked for only with this option (the camera view has it anyway)
  show("arPhotosRow", xr);
  show("arPhotosNote", xr);
  // object finding is for the Rover in v1
  show("arLookRow", bodyKey === "rover");
  show("arLookNote", bodyKey === "rover");
  if (bodyKey !== "rover") $("arLook").checked = false;
  $("arPlaceBtn").textContent = `Place the ${n} here`;
  $("arCanvas").setAttribute("aria-label", a ? `${a.tag} ${a.callsign}, your ${showing ? a.className : `AX-1 ${n}`} twin, drawn over your camera picture` : `The AX-1 ${n} twin, drawn over your camera picture`);
  document.title = a ? `${a.tag} · ${a.callsign} · My IRL lab · OpenForge AX` : BASE_TITLE;
  // iPhone and iPad: true floor placement through Apple's AR viewer, next to the camera view that drives it
  const ql = QUICK_LOOK && !xr;
  show("arQlRow", ql);
  show("arQlNote", ql);
  setText($("arQlNote"), showing ? "Apple AR shows the twin at its real size on your floor: walk around it. To play its move, use the camera view." : QL_NOTE);
  if (ql) prepareQuickLook(qlKey());
  showLookup();
}

// ================================================================ ar.html?agent=<id>: read the token, then dress the twin

const PARAM = parseAgentParam(location.search); // null | { id } | { bad: true }
const BASE_TITLE = document.title;
const LOOKUP_MS = 15000; // a read that hangs this long is an error with a Retry
let lookup = PARAM ? (PARAM.bad ? { status: "bad" } : { status: "loading" }) : { status: "none" };
let lookupToken = 0; // bumped on every read: an old answer never wins
let lookupDeferred = false; // an answer arrived while a session ran: it is applied when the session is over

const tagOf = () => `AX-${String(PARAM && PARAM.id ? PARAM.id : 0).padStart(4, "0")}`;
/** What the start card says about the agent's lookup, and whether Retry shows: [text, tone, retry]. */
function lookupText() {
  const meanwhile = "meet the AX-1 twins meanwhile";
  switch (lookup.status) {
    case "loading":
      return [`Looking up ${tagOf()}…`, "", false];
    case "unminted":
      return [`Agents are not minted yet: ${meanwhile}.`, "warn", false];
    case "error":
      return [`${tagOf()} could not be read just now (the network, or it does not exist yet). Retry, or ${meanwhile}.`, "warn", true];
    case "dormant":
      return [`This agent is still dormant: it wakes at the reveal. Or ${meanwhile}.`, "warn", false];
    case "bad":
      return [PARAM && PARAM.bad ? `That is not an agent number: ${meanwhile}.` : `${tagOf()} could not be read as an agent: ${meanwhile}.`, "warn", false];
    case "ready":
      return [showing ? SHOWCASE_NOTE : "", "", false];
    default:
      return ["", "", false];
  }
}
function showLookup() {
  const [text, tone, retry] = lookupText();
  const note = $("arAgentNote");
  note.hidden = !text;
  setText(note, text);
  if (tone) note.dataset.tone = tone;
  else delete note.dataset.tone;
  show("arAgentRetryRow", retry);
}

async function readAgent() {
  const token = ++lookupToken;
  if (!PARAM || PARAM.bad || !view) return;
  setLookup({ status: "loading" });
  if (!isDeployed()) return setLookup({ status: "unminted" });
  let meta = null;
  let timer = 0;
  try {
    meta = await Promise.race([tokenMeta(PARAM.id), new Promise((_, no) => (timer = setTimeout(() => no(new Error("timeout")), LOOKUP_MS)))]);
  } catch {
    if (token === lookupToken) setLookup({ status: "error" });
    return;
  } finally {
    clearTimeout(timer);
  }
  if (token !== lookupToken) return;
  const found = agentFromMeta(PARAM.id, meta);
  setLookup(found.status === "ready" ? found : { status: found.status });
}

function setLookup(next) {
  lookup = next;
  lookupDeferred = true;
  flushLookup();
}

/** Applies the latest answer, unless a session is running (then leaveLive does it): the body never changes under a session. */
function flushLookup(sessionOver = false) {
  if (!lookupDeferred || (!sessionOver && (starting || LIVE.has(stateName())))) return;
  lookupDeferred = false;
  if (lookup.status === "ready" && !agent) {
    try {
      dressTwin(lookup);
    } catch {
      lookup = { status: "bad" }; // the robot could not be dressed: the plain twins stay
    }
  }
  showCard();
  render();
}

/** The twin of this agent: its robot, its look. The AX-1 classes keep the drive controller, the others get the showcase. */
function dressTwin(a) {
  if (a.kind === "ax1") {
    view.setBody(a.body, { dress: (rig) => dressAgent(rig, a, { pose: false }) }); // the drive loop owns the joints
    agent = a;
    showing = false;
    bodyKey = a.body;
    controller = axController;
  } else {
    const made = createShowcase({ name: a.className, onChange: onModel });
    const dressed = view.setRobot(robotIdOf(a), { name: a.className, dress: (rig) => dressAgent(rig, a, { pose: true, motion: true }) });
    made.attach(dressed);
    showcase = made;
    agent = a;
    showing = true;
    bodyKey = "showcase";
    controller = showcase;
  }
  model = {};
  buildChips(bodyKey);
}

// ================================================================ Take a photo (photo.js composes it; nothing is uploaded here)

let photo = null; // { blob, file, url } of the photo on show
let taking = false;

function closePhoto() {
  if (photo) URL.revokeObjectURL(photo.url);
  photo = null;
  show("arShot", false);
  $("arShotImg").removeAttribute("src");
  $("arShotMsg").textContent = "";
}

async function onPhoto() {
  if (taking || !view || !view.mode) return;
  taking = true;
  $("arPhoto").setAttribute("aria-disabled", "true");
  announce("Taking the photo…");
  try {
    const shot = await view.capture();
    const blob = await toJpeg(composePhoto(shot));
    closePhoto();
    const name = photoFileName();
    photo = { blob, file: new File([blob], name, { type: "image/jpeg" }), url: URL.createObjectURL(blob), name };
    $("arShotImg").src = photo.url;
    show("arShare", canShareFile(photo.file));
    show("arShot", true);
    const msg = $("arShotMsg");
    msg.dataset.tone = shot.kind === "xr-nocam" ? "warn" : "";
    msg.textContent =
      shot.kind === "xr-nocam"
        ? 'Your browser did not give this page the camera picture in AR, so the twin stands on paper. Tick "Photos show my room" before Start to have your room in it.'
        : "Photo ready. It stays on this phone unless you share it.";
    announce(msg.textContent);
    ($("arShare").hidden ? $("arSave") : $("arShare")).focus();
  } catch (e) {
    announce(`The photo could not be taken. ${e && e.message ? e.message : "Try again."}`, true);
  } finally {
    taking = false;
    $("arPhoto").removeAttribute("aria-disabled");
  }
}

async function onShare() {
  if (!photo) return;
  const msg = $("arShotMsg");
  try {
    const r = await sharePhoto(photo.file);
    if (r === "shared") msg.textContent = "Shared.";
    else if (r === "cancelled") msg.textContent = "Not shared. You can share or save it again.";
    else {
      savePhoto(photo.blob, photo.name);
      msg.textContent = "This browser cannot share files, so the photo was saved instead.";
    }
  } catch {
    savePhoto(photo.blob, photo.name);
    msg.textContent = "Sharing did not work here, so the photo was saved instead.";
  }
  msg.dataset.tone = "";
}

function onSave() {
  if (!photo) return;
  savePhoto(photo.blob, photo.name);
  $("arShotMsg").textContent = "Saved. On iPhone, keep it from the preview that opens (Save to Photos).";
  $("arShotMsg").dataset.tone = "";
}

if (view) {
  $("arPhoto").addEventListener("click", onPhoto);
  $("arShare").addEventListener("click", onShare);
  $("arSave").addEventListener("click", onSave);
  $("arShotClose").addEventListener("click", () => {
    closePhoto();
    $("arPhoto").focus();
  });
}

// ================================================================ AR Quick Look (iPhone, iPad)

const QUICK_LOOK = quickLookSupported();
const QL_NOTE = "Apple AR shows the twin at its real size on your floor: walk around it. To drive it, use the camera view.";
const qlReady = new Map(); // body, or "agent-<id>" -> blob URL of its USDZ model

/** The Quick Look model of what the page shows: the AX-1 body, or the agent's own robot in its token's look. */
const qlKey = () => (agent ? `agent-${agent.id}` : bodyKey);
function qlModel(key) {
  if (!agent) return usdzUrl(key);
  const a = agent;
  return usdzUrl(key, { id: key, robotId: robotIdOf(a), dress: (rig) => dressAgent(rig, a, { pose: true }) }); // the token's own pose
}

/** Makes the body's model ahead of the tap: Safari opens Quick Look only from the tap itself, with nothing awaited. */
function prepareQuickLook(key) {
  if (!qlReady.has(key)) qlModel(key).then((u) => qlReady.set(key, u), () => {});
}

async function onQuickLook() {
  const key = qlKey();
  const msg = $("arStartMsg");
  let url = qlReady.get(key);
  if (!url) {
    msg.textContent = "Making the 3D model…";
    msg.dataset.tone = "";
    try {
      url = await qlModel(key);
      qlReady.set(key, url);
    } catch {
      msg.textContent = "The 3D model could not be made on this phone. Use the camera view.";
      msg.dataset.tone = "bad";
      return;
    }
    msg.textContent = "";
  }
  openQuickLook($("arQlLink"), url, key);
}
if (QUICK_LOOK) $("arQlBtn").addEventListener("click", onQuickLook);

/** The body picked on the start card: the view draws it, the chips and the texts follow. Never while a session runs. */
function chooseBody(key) {
  if (agent || !Object.hasOwn(BODY_NAMES, key) || starting || LIVE.has(stateName())) return;
  try {
    view.setBody(key);
  } catch {
    return; // a session is running: the body stays
  }
  bodyKey = key;
  buildChips(key);
  showCard();
}

function leaveLive(message) {
  closePhoto();
  body.classList.remove("ar-live", "ar-xr");
  for (const id of ["arTop", "arHud", "arStop", "arBanner", "arHint"]) show(id, false);
  showCard();
  starting = false;
  flushLookup(true); // the agent's answer, if it came while the session ran (the controller says READY a moment later)
  $("arStartBtn").removeAttribute("aria-disabled");
  $("arStartMsg").textContent = message ? String(message) : "";
  $("arStartMsg").dataset.tone = "";
  hintNow = "";
  lastObstacle = null;
  lastObstacleBack = null;
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

/** The chip: what is ahead, unless something behind is nearer to being hit (reversing). */
function obstacleText(u, back = lastObstacleBack) {
  if (model.drives === false && !model.walks) return [model.sensing?.text || "", ""]; // the Desk does not move about: no sensing
  if (view && view.mode === "camera") return [NEEDS_AR, "warn"];
  const backNear = back && back.state === "blocked" && Number.isFinite(back.nearM) ? back.nearM : Infinity;
  const frontNear = u && u.state === "blocked" ? (Number.isFinite(u.nearM) ? u.nearM : 0) : Infinity;
  if (backNear < frontNear) {
    if (backNear <= NEAR_STOP_M) return [`Stopped ${Math.round(STOP_GAP_M * 100)} cm before an obstacle behind`, "bad"];
    if (!u || u.state !== "blocked") return [`Obstacle about ${Math.round((back.distanceM ?? backNear) * 100)} cm behind`, "warn"];
  }
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
      return [`Point the phone at the ${bodyName()}`, "warn"];
    default:
      return [u.message ? String(u.message) : "Obstacle sensing is off", "warn"];
  }
}

let lastObstacleTone = "";
function showObstacle() {
  let [text, tone] = obstacleText(lastObstacle);
  if (view && view.lowLight && tone !== "bad") {
    text = `${text} · low light, less sure`;
    if (tone === "ok") tone = "warn";
  }
  setChip($("arObstacle"), text, tone); // not a live region: the distance changes every 10 cm
  if (tone === lastObstacleTone) return;
  const was = lastObstacleTone;
  lastObstacleTone = tone;
  if (!LIVE.has(stateName())) return;
  if (tone === "bad") announce(`I stopped ${Math.round(STOP_GAP_M * 100)} centimetres before something. I can turn or drive the other way.`, true);
  else if (was === "bad" && tone === "ok") announce("Path clear.");
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
  show("arStop", live && !showing); // a showcase drives nothing: no STOP, no ARM
  show("arArm", !showing);
  show("arObstacle", !showing);
  syncLook();
  show("arBanner", live && view && view.mode === "camera");
  if (view && view.mode === "camera") setText($("arBanner"), view.orientationOn ? BANNER_CAMERA : BANNER_CAMERA_STILL);
  applyHint();
  const driving = st === "ARMED" && model.link === LINK.DRIVING;
  const link = showing
    ? { PLACING: [`Place the ${bodyName()}`, "warn"], ARMED: model.playing ? [`${agent.callsign} · its move`, "live"] : [`${agent.callsign} · on show`, "ok"] }[st] || ["Offline", ""]
    : driving ? ["Driving", "live"] : { PLACING: [`Place the ${bodyName()}`, "warn"], ARMED: [`${bodyName()} · Armed`, "ok"], LATCHED: ["Stopped · press ARM", "warn"] }[st] || ["Offline", ""];
  for (const r of document.querySelectorAll('input[name="arBody"]')) r.disabled = starting || live; // fixed while a session runs
  setChip($("arLink"), link[0], link[1]);
  $("arArm").disabled = !model.canArm;
  show("arPlaceBtn", st === "PLACING");
  body.classList.toggle("ar-placing", st === "PLACING"); // placing: only Place and STOP, the floor ring stays in view
  showObstacle();
  showTalk();
  if (st !== was) stateChanged(was, st);
}

/** Screen-reader announcements and focus when the state changes (the chips themselves are not read on every frame). */
function stateChanged(was, st) {
  if (st === "PLACING") {
    const camera = view && view.mode === "camera";
    announce(`${camera ? `${view.orientationOn ? BANNER_CAMERA : BANNER_CAMERA_STILL} ` : ""}Place the ${bodyName()}: ${camera && !view.orientationOn ? "tap the picture" : "point at the floor and tap"}, or press Place the ${bodyName()} here.`);
    focusIfLost($("arPlaceBtn"));
  } else if (st === "ARMED" && showing) {
    if (was === "PLACING") announce(`${agent.callsign} is on show. Tap Its move to see its signature move, or Turn left or Turn right to turn it.`);
    focusIfLost($("arChips").querySelector("button") || $("arExit"));
  } else if (st === "ARMED" && (was === "PLACING" || was === "LATCHED")) {
    announce(bodyKey === "rover" ? "Armed. Tap a button for a short move, or hold it to keep moving." : bodyKey === "walker" ? "Armed. Tap Forward, Back, Left or Right for a few steps, or hold one to keep walking." : `Armed. Tap a button and the ${bodyName()} does that move.`);
    focusIfLost($("arChips").querySelector("button") || $("arStop"));
  } else if (st === "LATCHED") {
    announce(was === "PLACING" ? `The ${bodyName()} is placed but not armed. Press ARM to move it.` : "Stopped. Press ARM to move again.", was !== "PLACING");
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
  const wantPhotos = $("arPhotos").checked;
  $("arStartMsg").textContent = mode === "xr" ? "Starting AR…" : "Opening the camera…";
  $("arStartMsg").dataset.tone = "";
  // nothing may be awaited before these two calls: the browser wants the tap that started them
  const oriP = mode === "camera" ? requestOrientation() : null;
  const opened = mode === "xr" ? view.startXr({ wantObjects, wantPhotos }) : view.startCamera({ orientation: oriP });
  try {
    const info = await opened;
    show("arStart", false);
    show("arDesktop", false);
    body.classList.add("ar-live");
    if (mode === "xr") body.classList.add("ar-xr");
    $("arStartMsg").textContent = "";
    announce("", true); // an earlier failure's alert is over
    if (!(await controller.start(mode, bodyKey))) {
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
  $("arAgentRetry").addEventListener("click", () => {
    readAgent().catch(() => {});
    focusIfLost($("arStartBtn"));
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
  for (const r of document.querySelectorAll('input[name="arBody"]')) r.addEventListener("change", () => r.checked && chooseBody(r.value));
}

/**
 * The chips of body `key`. A tap is the chip's short move; holding a chip marked `hold` (the Rover's Forward, Back, Left,
 * Right) keeps it moving until the finger lifts (controller.press / release: short leases, the same obstacle and edge guards).
 */
function buildChips(key) {
  const chips = $("arChips");
  chips.replaceChildren();
  const HOLD_START_MS = 250;
  for (const c of chipsFor(key)) {
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
    if (c.hold) {
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

if (view && controller) buildChips(bodyKey);
showCard();
render();
readAgent().catch(() => {}); // ar.html?agent=<id>: the one network read of this page (chain.js), only with that parameter

if (DEBUG && view) {
  // inside the overlay: in AR it is the only part of the page on screen
  const pre = el("pre", { class: "ar-debug", "aria-hidden": "true" });
  $("arOverlay").append(pre);
  setInterval(() => {
    pre.textContent = `${view.diagnostics()}\nstate ${stateName()} · link ${model.link ?? "-"}`;
  }, 500);
}
