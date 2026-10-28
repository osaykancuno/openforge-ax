// My IRL lab (AX-1 in AR): the view. WebXR (immersive-ar) on Android Chrome, a camera view with a virtual camera everywhere
// else. It draws the Rover twin, finds the floor, reads the phone's depth for the obstacle tracker and reports what the
// person did (tap, visibility, end). It decides nothing about driving: ar.js wires it to the controller, and the
// controller owns every arming and stopping rule. This file never arms and never stops anything by itself.
//
// Nothing here uses innerHTML or the network. Labels are canvas textures drawn with fillText.
import * as THREE from "three";
import { XREstimatedLight } from "three/addons/webxr/XREstimatedLight.js";
import { makeRenderer, makeStage, disposeObject, PALETTE } from "../models/look.js";
import { ROBOTS, buildRobot, bounds } from "../models/robots.js";
import { composePose, faceToward } from "../pilot/twin-pose.js";
import { corridorSamples, createObstacleTracker, evaluateDepth, evaluateRays } from "./obstacle.js";
import { cameraFovDeg, floorHit, onTable, orientationQuat, phoneHeightFor } from "./orientation.js";
import { photoSize } from "./photo.js";
import { createXrCameraReader } from "./vision/xr-camera.js";

export const CAMERA_VIEW = { fov: 60, pos: [0, 1.25, 1.3], look: [0, 0.1, 0], radius: 1.5 }; // the virtual camera of the camera view
const DEPTH_MS = 66; // obstacle evaluation from the phone's depth: about 15 Hz
const RAY_MS = 200; // hit-test ray fallback: 5 Hz
const RAY_MOVE = 0.05; // m: the ray source is created again after the Rover moved this far...
const RAY_TURN = (10 * Math.PI) / 180; // ...or turned this much
const CAMERA_CB_MS = 100; // object finding looks at 10 Hz at most (the detector slows itself down further)
// Per body: shadow box half-size and key-light target height (m), whether it senses obstacles, its footprint on the reticle.
const BODY_LOOK = Object.freeze({
  rover: { name: "Rover", shadow: 0.4, target: 0.1, senses: true, foot: [[-0.113, -0.085], [0.113, -0.085], [0.113, 0.075], [-0.113, 0.075]] },
  desk: { name: "Desk", shadow: 0.4, target: 0.15, senses: false, foot: Array.from({ length: 24 }, (_, i) => [Math.cos((i / 24) * Math.PI * 2) * 0.11, Math.sin((i / 24) * Math.PI * 2) * 0.11]) },
  walker: { name: "Walker", shadow: 0.5, target: 0.25, senses: true, foot: [[-0.075, -0.05], [0.075, -0.05], [0.075, 0.05], [-0.075, 0.05]] },
});
const footGeometry = (look) => new THREE.BufferGeometry().setFromPoints(look.foot.map(([x, z]) => new THREE.Vector3(x, 0.002, z)));
const RING_R = 0.105; // the reticle ring's outer radius at scale 1 (it is sized for the AX-1 bodies)
/**
 * The look of a robot that is not an AX-1 body (an agent's class, shown in AR): measured from its box at rest, in metres. The
 * shadow box must hold the robot and its gesture, the ring and the footprint must hold the robot's feet. No obstacle sensing:
 * nothing of it drives. `box` is in the frame of the robot's origin (what bounds() gives with no transform above it).
 */
export function lookFromBox(box, name) {
  const sx = box.max.x - box.min.x, sy = box.max.y - box.min.y, sz = box.max.z - box.min.z;
  const big = Math.max(sx, sy, sz);
  return {
    name,
    shadow: Math.min(1, Math.max(0.4, 0.75 * big + 0.15)),
    target: Math.max(0.05, sy * 0.45),
    senses: false,
    ring: Math.min(5, Math.max(1, (Math.hypot(sx, sz) * 0.55) / RING_R)),
    foot: [[box.min.x, box.min.z], [box.max.x, box.min.z], [box.max.x, box.max.z], [box.min.x, box.max.z]],
  };
}
const WARM_SCALE = 1e-4; // the Rover is drawn this small before it is placed, so its shaders are compiled before the drive loop runs
const HIT_FRESH_MS = 400; // a tap places the Rover only if the floor was seen this recently
const HIT_TILT_DEG = 7; // the floor ring sits about 10% of the screen above the middle, clear of the controls
// Low light, from WebXR light estimation: ARCore's primary light intensity (three r160 floors its own intensity at 1, so
// the level is rebuilt as colour x intensity), smoothed. Thresholds to tune on phones: ar.html?debug shows the level.
export const LIGHT = { LOW: 0.2, OK: 0.3, EMA: 0.1 };
const DEPTH_MISS_FRAMES = 45; // frames without a depth picture before the chip says sensing is off
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * createArView({ canvas, video, overlay, handlers }) -> view. Throws when WebGL is missing (ar.js shows a message).
 * handlers (all optional, set or replaced at any time through view.handlers):
 *   frame(dt, rig) -> { x, z, yaw } | null   local pose of the Rover (and the place to move its joints and wheels)
 *   place(info) -> false to refuse          info = { gesture: true, source: "xr" | "tap", x, y, z, yaw }
 *   obstacle(update)                        tracker result { state, distanceM, nearM, message, side: "front" | "back" }
 *   visibility(state)                       XR session visibility: "visible" | "visible-blurred" | "hidden"
 *   ended(reason)                           the session or the camera view is over
 *   hint(text | null)                       what to tell the person while they look for a floor
 *   light(lowLight)                         the room went dark (true) or light again (false)
 * debug: true adds a magenta test cube 60 cm in front of where AR started and fills view.diagnostics() (ar.html?debug).
 */
export function createArView({ canvas, video, overlay, handlers = {}, debug = false }) {
  const renderer = makeRenderer(canvas, { alpha: true });
  renderer.setClearColor(0x000000, 0);
  renderer.setPixelRatio(Math.min(globalThis.devicePixelRatio || 1, 1.5));
  renderer.xr.setReferenceSpaceType("local");
  renderer.xr.setFramebufferScaleFactor(0.8);

  const scene = new THREE.Scene();
  scene.background = null;
  const stage = makeStage(scene, renderer, { size: 0.6, floor: false, background: null });
  const key = stage.key;
  key.shadow.mapSize.set(1024, 1024);
  key.shadow.radius = 4;
  const sc = key.shadow.camera;
  sc.left = sc.bottom = -0.4;
  sc.right = sc.top = 0.4;
  sc.near = 0.1;
  sc.far = 6;
  sc.updateProjectionMatrix();
  scene.add(key.target); // the key light follows the Rover: its target must live in the scene
  const keyHome = key.intensity;
  const hemiHome = stage.hemi.intensity;

  const camera = new THREE.PerspectiveCamera(CAMERA_VIEW.fov, 1, 0.02, 30);
  camera.position.fromArray(CAMERA_VIEW.pos);
  camera.lookAt(...CAMERA_VIEW.look);
  const baseQ = camera.quaternion.clone();

  // the Rover: real size (metres), +Z toward the person, under a root that carries the placement
  const placeRoot = new THREE.Group();
  placeRoot.visible = false;
  scene.add(placeRoot);
  let bodyKey = "rover"; // setBody() and setRobot() change it, only between sessions: "rover" | "desk" | "walker" | "agent:<robots.js id>"
  let bodyLook = BODY_LOOK.rover; // the look of that body (shadow box, key-light target, footprint, whether it senses)
  let groundLive = false; // the Desk and the Walker are put on the floor every few frames; the others once, in setRobot
  let rig = buildRobot("ax1-rover");
  placeRoot.add(rig.group);
  let groundY = 0; // the Desk and Walker are put on the floor through bounds() (their models' origin is not at their soles)
  let groundTick = 0;

  // a shadow catcher on the real floor: only the shadow is drawn, the camera picture shows through
  const shadow = new THREE.Mesh(new THREE.PlaneGeometry(1.2, 1.2), new THREE.ShadowMaterial({ opacity: 0.28 }));
  shadow.rotation.x = -Math.PI / 2;
  shadow.receiveShadow = true;
  shadow.visible = false;
  scene.add(shadow);

  // the reticle: where a tap would put the Rover (the Rover's footprint and a ring)
  const reticle = new THREE.Group();
  reticle.matrixAutoUpdate = false;
  reticle.visible = false;
  const ringMat = new THREE.MeshBasicMaterial({ color: PALETTE.accent, transparent: true, opacity: 0.95, side: THREE.DoubleSide });
  const ring = new THREE.Mesh(new THREE.RingGeometry(0.09, 0.105, 40).rotateX(-Math.PI / 2), ringMat);
  const foot = new THREE.LineLoop(footGeometry(BODY_LOOK.rover), new THREE.LineBasicMaterial({ color: PALETTE.ink, transparent: true, opacity: 0.8 }));
  reticle.add(ring, foot);
  scene.add(reticle);

  // soft labels (objects found around the room)
  const labelGroup = new THREE.Group();
  scene.add(labelGroup);
  const labels = new Map(); // id -> { sprite, text }

  // ar.html?debug: what the AR session really does on a phone (nothing of this runs otherwise)
  const dbg = { frames: 0, hitResults: 0, upHits: 0, calls: 0, tris: 0, glErr: 0, ndc: null, cube: null };
  const dbgV = new THREE.Vector3();

  const tracker = createObstacleTracker(); // ahead
  const trackerBack = createObstacleTracker(); // behind (reversing)
  const resetTrackers = () => {
    tracker.reset();
    trackerBack.reset();
  };
  const view = {
    handlers,
    renderer,
    scene,
    camera,
    get rig() {
      return rig;
    },
    get bodyKey() {
      return bodyKey;
    },
    setBody,
    setRobot,
    mode: null, // null | "xr" | "camera"
    placed: false,
    cameraAccess: false, // camera-access granted (object finding inside AR)
    depthSensing: false, // the phone gave us CPU depth
    orientationOn: false, // camera view follows the phone's turning
    floorMode: false, // camera view with the motion sensors: the 3D floor lines up with the real one, taps place on it
    lowLight: false, // AR light estimation says it is dark: obstacle sensing is more careful
    get floorY() {
      return placeRoot.position.y;
    },
    /** world pose of the Rover { x, y, z, yaw } (placement composed with the local odometry pose) */
    worldPose() {
      const w = composePose({ x: placeRoot.position.x, y: placeRoot.position.y, z: placeRoot.position.z, yaw: placeRoot.rotation.y }, local);
      return w;
    },
    onCameraFrame(cb) {
      cameraCb = typeof cb === "function" ? cb : null;
    },
    setLabels,
    placeHere,
    diagnostics,
    capture,
    startXr,
    startCamera,
    exit,
    dispose,
  };

  let local = { x: 0, z: 0, yaw: 0 };
  let cameraCb = null;
  let session = null;
  let refSpace = null;
  let hitSource = null;
  let xrLight = null;
  let anchor = null;
  let anchorOn = false;
  let endReason = "";
  let lastT = 0;
  let lastDepthT = 0;
  let lastCbT = 0;
  let depthMisses = 0;
  let offSent = false;
  let hit = null; // { x, y, z, t } the latest floor the phone saw
  let pending = null; // a placement waiting for the first drawn frame with the Rover visible
  let hintText;
  let stream = null;
  let oriLatest = null;
  let oriListener = null;
  let oriA0 = null; // floor mode: the compass reading at the start, so the scene starts where the phone looks
  let floorAim = null; // floor mode: { x, z } where the reticle meets the floor, or null
  let fovKey = "";
  let pageUp = null;
  const cam = { x: 0, y: 0, z: 0 }; // the phone's position in the room (XR)
  const ray = { src: null, pending: false, dist: [], x: 0, z: 0, yaw: 0, t: 0, failed: false };
  const tmpM = new THREE.Matrix4();
  const invProj = new Float32Array(16);
  const invM = new THREE.Matrix4();
  let overlayGuard = null;

  const say = (t) => {
    if (t === hintText) return;
    hintText = t;
    view.handlers.hint?.(t);
  };

  // ---------------------------------------------------------------- size
  const resize = () => {
    if (renderer.xr.isPresenting) return;
    const w = canvas.clientWidth || 1;
    const h = canvas.clientHeight || 1;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  };
  const ro = typeof ResizeObserver === "function" ? new ResizeObserver(resize) : null;
  ro?.observe(canvas);
  resize();

  // ---------------------------------------------------------------- shared frame work
  function step(t) {
    const dt = lastT ? Math.min(0.1, Math.max(0, (t - lastT) / 1000)) : 0;
    lastT = t;
    return dt;
  }

  /**
   * The AX-1 twin to draw: "rover" | "desk" | "walker". Only before a session starts (it throws while AR or the camera view
   * runs), so the warm-up compile at the start covers the right model and no shader compiles mid-session.
   * opts.dress(rig) -> anything: called with the new rig already in the scene (an agent's finish and add-on, agent-rig.js);
   * setBody returns what it returned. Without opts.dress an unchanged body is left as it is.
   */
  function setBody(key, { dress = null } = {}) {
    if (!Object.hasOwn(BODY_LOOK, key)) throw new Error(`Unknown body: ${key}`);
    if (view.mode) throw new Error("Pick the body before AR or the camera view starts");
    if (key === bodyKey && !dress) return null;
    return install(`ax1-${key}`, key, BODY_LOOK[key], key !== "rover", dress);
  }

  /**
   * Any robot of robots.js at its real size (an agent's class, "bring your agent to life"). Before a session only, like
   * setBody. Its look is measured from the robot as dress() left it (opts.dress, with the rig already in the scene). It is put
   * on the floor once, at rest. opts.name is what the hints call it ("Tap to put the Cyber Hound here."). Returns dress()'s result.
   */
  function setRobot(robotId, { dress = null, name = "" } = {}) {
    if (!Object.hasOwn(ROBOTS, robotId)) throw new Error(`Unknown robot: ${robotId}`);
    if (view.mode) throw new Error("Pick the body before AR or the camera view starts");
    return install(robotId, `agent:${robotId}`, null, false, dress, name || ROBOTS[robotId].name);
  }

  /** Builds the robot, dresses it in a scene of its own (token-look.js reads world matrices), then swaps it for the old one. */
  function install(robotId, key, look, live, dress, name = "") {
    const next = buildRobot(robotId);
    const holder = new THREE.Group(); // no transform: the robot's frame is the world's
    scene.add(holder);
    holder.add(next.group);
    let out = null;
    let box = null;
    try {
      out = dress ? dress(next) : null;
      box = bounds(next);
    } catch (e) {
      scene.remove(holder);
      disposeObject(next.group);
      throw e;
    }
    scene.remove(holder);
    placeRoot.remove(rig.group);
    disposeObject(rig.group);
    rig = next;
    placeRoot.add(rig.group);
    bodyKey = key;
    bodyLook = look || lookFromBox(box, name);
    groundLive = live;
    groundY = live || look ? 0 : -box.min.y; // a robot that is not driven stands on its lowest point from the start
    rig.group.position.y = groundY;
    foot.geometry.dispose();
    foot.geometry = footGeometry(bodyLook);
    ring.scale.setScalar(bodyLook.ring || 1);
    const half = bodyLook.shadow;
    sc.left = sc.bottom = -half;
    sc.right = sc.top = half;
    sc.updateProjectionMatrix();
    return out;
  }

  function updateRig(dt, t) {
    const p = view.handlers.frame?.(dt, rig);
    if (p) {
      local = p;
      rig.group.position.set(p.x, groundY, p.z);
      rig.group.rotation.y = p.yaw;
    }
    rig.update?.(dt, t / 1000);
    // the Desk and the Walker: keep the lowest point on the floor (the Walker's soles sit 11 mm below its origin, and the
    // Walker's legs bend); the Desk every few frames, the Walker every frame (its feet lift while it walks), only at full
    // size. The Rover sits on its wheels already.
    if (groundLive && placeRoot.scale.x === 1 && (bodyKey === "walker" || ++groundTick % 6 === 0)) {
      const low = bounds(rig).min.y - placeRoot.position.y;
      if (Number.isFinite(low) && Math.abs(low) > 0.001) {
        groundY -= low;
        rig.group.position.y = groundY;
      }
    }
    // the key light, its shadow box and the shadow catcher follow the Rover
    const w = placeRoot.visible ? view.worldPose() : null;
    if (w) {
      shadow.position.set(w.x, w.y + 0.001, w.z);
      key.target.position.set(w.x, w.y + bodyLook.target, w.z);
      key.position.set(w.x + keyDir.x * 1.2, w.y + keyDir.y * 1.2, w.z + keyDir.z * 1.2);
      key.target.updateMatrixWorld();
    }
  }
  const keyDir = new THREE.Vector3(0.3, 0.8, 0.45).normalize();

  function sendObstacle(update, side = "front") {
    view.handlers.obstacle?.({ ...update, side });
  }
  function sendOff(message) {
    if (offSent) return;
    offSent = true;
    sendObstacle({ state: "off", distanceM: null, message });
  }

  function afterRender(t, extra) {
    if (pending) {
      const info = pending;
      pending = null;
      const ok = view.handlers.place?.(info);
      if (ok === false) unplace();
      else {
        view.placed = true;
        resetTrackers();
        offSent = false;
        depthMisses = 0;
        say(null);
      }
    }
    if (cameraCb && t - lastCbT >= CAMERA_CB_MS) {
      lastCbT = t;
      try {
        cameraCb({ kind: view.mode === "xr" ? "xr" : "video", t, video, ...extra, view });
      } catch {} // object finding never breaks the picture
    }
  }

  function unplace() {
    view.placed = false;
    pending = null;
    shadow.visible = false;
    dropAnchor();
    placeRoot.visible = (view.mode === "camera" && !view.floorMode) || view.mode === "xr"; // in AR it waits at a tiny size (see WARM_SCALE); in floor mode the reticle shows the spot
    placeRoot.scale.setScalar(view.mode === "xr" ? WARM_SCALE : 1);
    resetTrackers();
  }

  // ---------------------------------------------------------------- WebXR
  async function startXr({ wantObjects = false, wantPhotos = false } = {}) {
    if (session || view.mode) throw new Error("AR is already running");
    const init = {
      requiredFeatures: ["hit-test"],
      // camera access (the page may read the camera picture) only when the person asked for it: object finding, or
      // photos that show the room
      optionalFeatures: ["dom-overlay", "light-estimation", "depth-sensing", "anchors", ...(wantObjects || wantPhotos ? ["camera-access"] : [])],
      domOverlay: { root: overlay },
      depthSensing: { usagePreference: ["cpu-optimized", "gpu-optimized"], dataFormatPreference: ["luminance-alpha", "float32"] },
    };
    // requestSession is the first await: the browser needs the tap that started it
    const s = await navigator.xr.requestSession("immersive-ar", init);
    session = s;
    endReason = "";
    const on = (s.enabledFeatures || []).slice();
    view.cameraAccess = on.includes("camera-access");
    anchorOn = on.includes("anchors");
    view.depthSensing = s.depthUsage === "cpu-optimized";
    try {
      if (on.includes("light-estimation")) {
        // SH light and a directional light only (no environment cube: swapping the environment would recompile shaders mid-drive)
        xrLight = new XREstimatedLight(renderer, false);
        xrLight.addEventListener("estimationstart", () => {
          estimating = true;
          stage.hemi.intensity = hemiHome * 0.35;
        });
        xrLight.addEventListener("estimationend", () => {
          estimating = false;
          stage.hemi.intensity = hemiHome;
          key.intensity = keyHome;
          keyDir.set(0.3, 0.8, 0.45).normalize();
        });
        scene.add(xrLight); // present from the start (intensity 0): lights never change count while driving
      }
      s.addEventListener("end", onXrEnd);
      s.addEventListener("select", onSelect);
      s.addEventListener("visibilitychange", () => view.handlers.visibility?.(s.visibilityState));
      overlayGuard = (e) => e.target?.closest?.("button, a, input, label, .ar-panel") && e.preventDefault(); // a tap on a control never places
      overlay.addEventListener("beforexrselect", overlayGuard);
      renderer.xr.enabled = true;
      renderer.xr.setReferenceSpaceType("local");
      // Chrome on recent Android phones exposes WebXR Layers (renderState.layers) even though this session did not ask
      // for them, and three r160 then draws into a projection layer that the AR compositor never shows (measured on a
      // Galaxy S24: frames, draw calls and triangles, nothing on screen). Hidden on this session only, three uses the
      // classic XRWebGLLayer, which AR shows. three reads it once, here.
      try {
        Object.defineProperty(s.renderState, "layers", { value: undefined, configurable: true });
      } catch {} // a browser that refuses: three keeps its own choice
      await renderer.xr.setSession(s);
      refSpace = renderer.xr.getReferenceSpace();
      const viewer = await s.requestReferenceSpace("viewer");
      // the floor finder looks a little above the middle of the screen: the controls take the lower part, so the ring
      // and the Rover placed on it land where the camera picture is clear
      const tilt = (HIT_TILT_DEG * Math.PI) / 180;
      hitSource = await s.requestHitTestSource({ space: viewer, offsetRay: new XRRay({ x: 0, y: 0, z: 0, w: 1 }, { x: 0, y: Math.sin(tilt), z: -Math.cos(tilt), w: 0 }) });
      if (!session) throw new Error("AR closed before it started"); // the person left while the floor finder started
    } catch (e) {
      s.removeEventListener("end", onXrEnd); // the caller reports the failure itself
      s.end().catch(() => {});
      cleanupXr();
      throw e;
    }
    view.mode = "xr";
    video.hidden = true;
    if (debug && !dbg.cube) {
      // unlit, bright, 10 cm: if even this does not show, nothing from WebGL reaches the screen
      dbg.cube = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.1, 0.1), new THREE.MeshBasicMaterial({ color: 0xff00ff }));
      dbg.cube.position.set(0, 0, -0.6);
      scene.add(dbg.cube);
    }
    unplace();
    placeRoot.visible = true; // drawn at a tiny size: shaders compile now, not when the Rover is placed
    placeRoot.scale.setScalar(WARM_SCALE);
    const warmLabel = new THREE.Sprite(new THREE.SpriteMaterial({ map: labelTexture("·"), transparent: true, depthTest: false, depthWrite: false }));
    warmLabel.scale.setScalar(WARM_SCALE);
    labelGroup.add(warmLabel); // the labels' shader compiles now too, not at the first object found mid-drive
    try {
      renderer.compile(scene, camera);
    } catch {}
    labelGroup.remove(warmLabel);
    warmLabel.material.map?.dispose();
    warmLabel.material.dispose();
    lastT = 0;
    renderer.setAnimationLoop(onXrFrame);
    say("Move your phone slowly to find the floor.");
    return { cameraAccess: view.cameraAccess, depth: view.depthSensing, anchors: anchorOn, lightEstimation: Boolean(xrLight), gl: renderer.getContext(), session: s };
  }

  let estimating = false;

  function onXrEnd() {
    const reason = endReason || "AR closed";
    cleanupXr();
    view.handlers.ended?.(reason);
  }

  function cleanupXr() {
    renderer.setAnimationLoop(null);
    shot?.reject(new Error("AR closed before the photo was taken."));
    shot = null;
    photoReader?.close();
    photoReader = null;
    try {
      hitSource?.cancel();
      ray.src?.cancel();
    } catch {}
    hitSource = null;
    ray.src = null;
    ray.pending = false;
    ray.failed = false;
    dropAnchor();
    if (overlayGuard) overlay.removeEventListener("beforexrselect", overlayGuard);
    overlayGuard = null;
    if (xrLight) {
      scene.remove(xrLight);
      xrLight.dispose?.();
      xrLight = null;
    }
    estimating = false;
    stage.hemi.intensity = hemiHome;
    key.intensity = keyHome;
    renderer.xr.enabled = false;
    session = null;
    refSpace = null;
    hit = null;
    reticle.visible = false;
    view.mode = view.mode === "xr" ? null : view.mode;
    view.cameraAccess = false;
    view.depthSensing = false;
    unplace();
    placeRoot.visible = false;
    placeRoot.scale.setScalar(1);
    say(null);
  }

  function updateHit(frame, t) {
    let shown = false;
    const results = hitSource ? frame.getHitTestResults(hitSource) : [];
    if (debug) dbg.hitResults = results.length;
    const pose = results.length ? results[0].getPose(refSpace) : null;
    if (pose) {
      const m = pose.transform.matrix;
      if (debug) dbg.upY = Math.round(m[5] * 100) / 100;
      if (m[5] > 0.8) {
        if (debug) dbg.upHits++;
        // only floors and tables: the plane's up axis points up
        reticle.matrix.fromArray(m);
        reticle.matrixWorldNeedsUpdate = true;
        hit = { x: m[12], y: m[13], z: m[14], t: globalThis.performance?.now?.() ?? t };
        shown = true;
      }
    }
    reticle.visible = shown;
    if (!view.placed && !pending) {
      if (shown) {
        say(`Tap to put the ${bodyLook.name} here.`);
        // keep the warm-up Rover next to the reticle (it is invisible at this size)
        placeRoot.position.set(hit.x, hit.y, hit.z);
      } else say(lowLight ? "It's dark here: turn on a light, then move your phone slowly to find the floor." : "Move your phone slowly to find the floor.");
    }
  }

  function updateAnchor(frame) {
    if (!anchor || !refSpace) return;
    if (!frame.trackedAnchors || !frame.trackedAnchors.has(anchor)) return;
    const p = frame.getPose(anchor.anchorSpace, refSpace);
    if (p) placeRoot.position.set(p.transform.position.x, p.transform.position.y, p.transform.position.z);
  }

  let lightLevel = null; // smoothed light estimate (null: unknown)
  let lowLight = false;
  function updateLight() {
    if (!estimating || !xrLight) return;
    const d = xrLight.directionalLight;
    if (!d) return;
    const level = Math.max(d.color.r, d.color.g, d.color.b) * d.intensity;
    if (Number.isFinite(level)) {
      lightLevel = lightLevel === null ? level : lightLevel + LIGHT.EMA * (level - lightLevel);
      if (lowLight ? lightLevel > LIGHT.OK : lightLevel < LIGHT.LOW) {
        lowLight = !lowLight;
        tracker.setLowLight(lowLight);
        trackerBack.setLowLight(lowLight);
        view.lowLight = lowLight;
        view.handlers.light?.(lowLight);
      }
    }
    const dir = d.position;
    if (dir.lengthSq() > 1e-6) {
      keyDir.copy(dir).normalize();
      keyDir.y = Math.max(keyDir.y, 0.35); // a low sun would throw a shadow metres long
      keyDir.normalize();
    }
    key.color.copy(d.color);
    key.intensity = Math.min(1.5, Math.max(0.3, d.intensity * 0.4)); // the estimate's own light adds the rest
  }

  function onSelect(e) {
    const now = globalThis.performance?.now?.() ?? 0;
    if (!hit || now - hit.t > HIT_FRESH_MS) {
      say("I can't see the floor there. Move your phone slowly and tap again.");
      return;
    }
    const yaw = faceToward({ x: hit.x, z: hit.z }, { x: cam.x, z: cam.z });
    const info = { gesture: true, source: "xr", x: hit.x, y: hit.y, z: hit.z, yaw };
    if (view.placed) {
      // placing again: ask first, move only if the controller agrees
      if (view.handlers.place?.(info) === false) return;
      moveTo(info);
      resetTrackers();
      makeAnchor(e, info);
      return;
    }
    // the first placement: show the Rover now, tell the controller after the first frame that drew it
    moveTo(info);
    pending = info;
    makeAnchor(e, info);
  }

  /** Pins the placement to the real room, so it stays put while the phone refines its map. Needs the tap's frame. */
  function makeAnchor(e, info) {
    dropAnchor();
    if (!anchorOn || !e.frame?.createAnchor) return;
    try {
      e.frame
        .createAnchor(new XRRigidTransform({ x: info.x, y: info.y, z: info.z }, { x: 0, y: 0, z: 0, w: 1 }), refSpace)
        .then((a) => {
          if (!session || !(view.placed || pending)) return void a.delete();
          dropAnchor();
          anchor = a;
        })
        .catch(() => {});
    } catch {}
  }

  function dropAnchor() {
    try {
      anchor?.delete();
    } catch {}
    anchor = null;
  }

  function moveTo(info) {
    placeRoot.position.set(info.x, info.y, info.z);
    placeRoot.rotation.y = info.yaw;
    placeRoot.scale.setScalar(1);
    placeRoot.visible = true;
    shadow.visible = true;
    reticle.visible = true;
  }

  function onXrFrame(t, frame) {
    if (!frame || !session || !refSpace) return;
    const dt = step(t);
    const vp = frame.getViewerPose(refSpace);
    if (vp) {
      const p = vp.transform.position;
      cam.x = p.x;
      cam.y = p.y;
      cam.z = p.z;
    }
    updateHit(frame, t);
    updateAnchor(frame);
    updateLight();
    updateRig(dt, t);
    if (view.placed && bodyLook.senses) sense(frame, vp, t); // obstacles: the Rover and the walking Walker
    renderer.render(scene, camera);
    if (shot) takeXrShot(frame, vp);
    if (debug) {
      dbg.frames++;
      dbg.calls = renderer.info.render.calls;
      dbg.tris = renderer.info.render.triangles;
      const e = renderer.getContext().getError();
      if (e) dbg.glErr = e;
      const xc = renderer.xr.getCamera();
      const c0 = xc && xc.cameras && xc.cameras[0];
      dbg.ndc = c0 ? rig.group.getWorldPosition(dbgV).project(c0).toArray().map((n) => Math.round(n * 100) / 100) : null;
    }
    afterRender(t, { frame, session, gl: renderer.getContext(), pose: vp, floorY: placeRoot.position.y, space: refSpace });
  }

  /** ar.html?debug: one line per fact, plain text. */
  function diagnostics() {
    const s = session;
    const rs = s && s.renderState;
    const base = rs && rs.baseLayer;
    const r2 = (n) => Math.round(n * 100) / 100;
    const w = view.placed || placeRoot.visible ? view.worldPose() : null;
    const size = renderer.getSize(dbgV.set(0, 0, 0));
    return [
      `three r${THREE.REVISION} · mode ${view.mode} · presenting ${renderer.xr.isPresenting} · blend ${s ? s.environmentBlendMode : "-"}`,
      `layer ${base ? `base ${base.framebufferWidth}x${base.framebufferHeight}` : rs && rs.layers ? `layers(${rs.layers.length})` : "none"} · canvas ${size.x}x${size.y} · ctx lost ${renderer.getContext().isContextLost()}`,
      `features ${s && s.enabledFeatures ? s.enabledFeatures.join(",") : "?"} · depth ${s ? s.depthUsage || "-" : "-"}`,
      `frames ${dbg.frames} · draw calls ${dbg.calls} · triangles ${dbg.tris} · gl error ${dbg.glErr}`,
      `hit results ${dbg.hitResults} · floor hits ${dbg.upHits} · up ${dbg.upY ?? "-"} · reticle ${reticle.visible}`,
      `placed ${view.placed} · root visible ${placeRoot.visible} scale ${r2(placeRoot.scale.x)} · rover ${w ? [w.x, w.y, w.z].map(r2).join(", ") : "-"}`,
      `camera ${[cam.x, cam.y, cam.z].map(r2).join(", ")} · distance ${w ? r2(Math.hypot(w.x - cam.x, w.y - cam.y, w.z - cam.z)) : "-"} m · rover on screen ${dbg.ndc ? dbg.ndc.join(", ") : "-"}`,
      `behind: hits ${dbg.depthBack ? dbg.depthBack.hits : "-"} · nearest ${dbg.depthBack && Number.isFinite(dbg.depthBack.nearestM) ? r2(dbg.depthBack.nearestM) : "-"} m`,
      `depth: hits ${dbg.depth ? dbg.depth.hits : "-"} · in view ${dbg.depth ? r2(dbg.depth.visibleFrac) : "-"} · nearest ${dbg.depth && Number.isFinite(dbg.depth.nearestM) ? r2(dbg.depth.nearestM) : "-"} m · floor k ${dbg.depth ? r2(dbg.depth.floorK) : "-"} · depth/floor ${dbg.depth && dbg.depth.floorRatio !== null ? r2(dbg.depth.floorRatio) : "-"}`,
      `light ${lightLevel === null ? "unknown" : r2(lightLevel)} (low under ${LIGHT.LOW}) · low light ${lowLight}`,
      `test cube ${dbg.cube ? "magenta, 60 cm ahead of the start" : "off"}`,
    ].join("\n");
  }

  // ---------------------------------------------------------------- obstacle sensing (depth, or a hit-test ray)
  function sense(frame, vp, t) {
    const v = vp && vp.views && vp.views[0];
    if (!v) return;
    if (view.depthSensing) return senseDepth(frame, v, t);
    senseRay(frame, t);
  }

  function senseDepth(frame, v, t) {
    if (t - lastDepthT < DEPTH_MS) return;
    let di = null;
    try {
      di = frame.getDepthInformation(v);
    } catch {}
    if (!di) {
      if (++depthMisses > DEPTH_MISS_FRAMES) sendOff("Obstacle sensing is waiting for the phone's depth picture.");
      return;
    }
    lastDepthT = t;
    depthMisses = 0;
    offSent = false;
    invM.fromArray(v.projectionMatrix).invert().toArray(invProj);
    const world = view.worldPose();
    const floorY = placeRoot.position.y;
    const judge = (pose) =>
      evaluateDepth({
        samples: corridorSamples(pose, { floorY }),
        getDepth: (u, w) => {
          const d = di.getDepthInMeters(clamp01(u), clamp01(w));
          return d > 0 && Number.isFinite(d) ? d : 0;
        },
        worldToView: v.transform.inverse.matrix,
        viewToWorld: v.transform.matrix,
        proj: v.projectionMatrix,
        invProj,
        worldPose: pose,
        floorY,
        lowLight,
      });
    const res = judge(world);
    const resBack = judge({ ...world, yaw: world.yaw + Math.PI }); // the same corridor behind the Rover
    if (debug) {
      dbg.depth = res;
      dbg.depthBack = resBack;
    }
    sendObstacle(tracker.update({ hits: res.hits, nearestM: res.nearestM, visibleFrac: res.visibleFrac, source: "depth" }));
    sendObstacle(trackerBack.update({ hits: resBack.hits, nearestM: resBack.nearestM, visibleFrac: resBack.visibleFrac, source: "depth" }), "back");
  }

  function senseRay(frame, t) {
    if (ray.failed) return sendOff("Obstacle sensing is not available on this phone.");
    const w = view.worldPose();
    const moved = Math.hypot(w.x - ray.x, w.z - ray.z) > RAY_MOVE || Math.abs(Math.atan2(Math.sin(w.yaw - ray.yaw), Math.cos(w.yaw - ray.yaw))) > RAY_TURN;
    if ((moved || !ray.src) && !ray.pending && session && t - ray.t >= RAY_MS) {
      ray.t = t;
      ray.pending = true;
      ray.x = w.x;
      ray.z = w.z;
      ray.yaw = w.yaw;
      const y = placeRoot.position.y + 0.1;
      try {
        const offsetRay = new XRRay({ x: w.x, y, z: w.z, w: 1 }, { x: Math.sin(w.yaw), y: 0, z: Math.cos(w.yaw), w: 0 });
        const s = session;
        s.requestHitTestSource({ space: refSpace, offsetRay })
          .then((src) => {
            ray.pending = false;
            if (session !== s) return void src.cancel();
            try {
              ray.src?.cancel();
            } catch {}
            ray.src = src;
          })
          .catch(() => {
            ray.pending = false;
            ray.failed = true;
          });
      } catch {
        ray.pending = false;
        ray.failed = true;
      }
    }
    if (!ray.src) return;
    const results = frame.getHitTestResults(ray.src);
    ray.dist.length = 0;
    for (const r of results) {
      const p = r.getPose(refSpace);
      if (!p) continue;
      const d = Math.hypot(p.transform.position.x - ray.x, p.transform.position.z - ray.z);
      ray.dist.push(d); // evaluateRays keeps only what is inside the look-ahead
    }
    if (t - lastDepthT < RAY_MS) return;
    lastDepthT = t;
    offSent = false;
    const res = evaluateRays(ray.dist.slice());
    sendObstacle(tracker.update({ hits: res.hits, nearestM: res.nearestM, visibleFrac: res.visibleFrac, source: "rays" }));
  }

  // ---------------------------------------------------------------- camera view (no WebXR AR: iPhone, desktop browsers)
  /**
   * startCamera({ orientation }) opens the back camera behind the canvas. Call it in the tap that starts the view, and
   * request the motion permission in that same tap before any await; pass that promise as `orientation`.
   * Resolves { orientation: boolean } (true when the view follows the phone's turning).
   */
  async function startCamera({ orientation = null } = {}) {
    if (session || view.mode) throw new Error("The camera view is already running");
    // getUserMedia is the first call (still inside the tap)
    const gum = navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
    let granted = null;
    try {
      stream = await gum;
      granted = orientation ? await Promise.resolve(orientation).catch(() => "denied") : null;
      if (document.hidden) throw new Error("The page went to the background before the camera opened");
    } catch (e) {
      if (stream) stopTracks();
      throw e;
    }
    video.srcObject = stream;
    video.muted = true;
    video.hidden = false;
    try {
      await video.play();
    } catch {} // a blocked autoplay shows a still first picture; the view still works
    view.mode = "camera";
    endReason = "";
    camera.position.fromArray(CAMERA_VIEW.pos);
    camera.quaternion.copy(baseQ);
    view.orientationOn = granted === "granted" || granted === true;
    // the floor mode needs the sensors' real tilt; it turns on with the first reading (desktops have none)
    view.floorMode = false;
    oriA0 = null;
    oriLatest = null;
    floorAim = null;
    fovKey = "";
    if (view.orientationOn) {
      oriListener = (e) => {
        if (e.alpha == null && e.beta == null && e.gamma == null) return;
        oriLatest = { a: e.alpha || 0, b: e.beta || 0, g: e.gamma || 0 };
      };
      addEventListener("deviceorientation", oriListener);
    }
    placeRoot.position.set(0, 0, 0);
    placeRoot.rotation.y = faceToward({ x: 0, z: 0 }, { x: CAMERA_VIEW.pos[0], z: CAMERA_VIEW.pos[2] });
    placeRoot.scale.setScalar(1);
    placeRoot.visible = true;
    shadow.visible = true;
    view.placed = false;
    resize();
    try {
      renderer.compile(scene, camera);
    } catch {}
    canvas.addEventListener("click", onCanvasTap);
    pageUp = () => {
      if (document.hidden) exit("Camera paused");
    };
    document.addEventListener("visibilitychange", pageUp);
    lastT = 0;
    renderer.setAnimationLoop(onCameraFrame);
    say(`Tap anywhere to put the ${bodyLook.name} down.`);
    return { orientation: view.orientationOn };
  }

  /** The first motion reading: from now on the 3D camera stands at a phone's height and tilts like the phone. */
  function enterFloorMode() {
    view.floorMode = true;
    oriA0 = oriLatest.a;
    camera.position.set(0, phoneHeightFor(bodyKey), 0);
    if (!view.placed && !pending) {
      placeRoot.visible = false; // the reticle shows where it will stand
      shadow.visible = false;
    } else movePlacedAhead = true; // placed before the sensors answered: it stood at the phone's feet
  }
  let movePlacedAhead = false;

  /** Floor mode, placed before it began: the twin moves 1 m ahead of where the phone looks, facing the person. */
  function placeAhead() {
    movePlacedAhead = false;
    const d = camera.getWorldDirection(new THREE.Vector3());
    const len = Math.hypot(d.x, d.z) || 1;
    const p = { x: (d.x / len) * 1, z: (d.z / len) * 1 };
    const info = { gesture: true, source: "tap", x: p.x, y: 0, z: p.z, yaw: faceToward(p, { x: 0, z: 0 }) };
    moveTo(info);
    if (pending) pending = info;
  }

  /** Floor mode: where the ray through a screen point (NDC) meets the floor, or null. */
  const caster = new THREE.Raycaster();
  const ndcV = new THREE.Vector2();
  function floorAt(nx, ny) {
    caster.setFromCamera(ndcV.set(nx, ny), camera);
    const o = caster.ray.origin, d = caster.ray.direction;
    return floorHit([o.x, o.y, o.z], [d.x, d.y, d.z], { maxM: 4 });
  }

  /** Floor mode: the 3D camera's field of view follows the real lens and the way the picture is cropped on screen. */
  function fitFov() {
    const vw = video.videoWidth, vh = video.videoHeight, cw = canvas.clientWidth, ch = canvas.clientHeight;
    const k = `${vw}x${vh}/${cw}x${ch}`;
    if (k === fovKey) return;
    const fov = cameraFovDeg({ videoW: vw, videoH: vh, viewW: cw, viewH: ch });
    if (!fov) return;
    fovKey = k;
    camera.fov = fov;
    camera.updateProjectionMatrix();
  }

  /** Floor mode: the reticle sits where the phone points (a little above the middle, clear of the controls). */
  function updateFloorReticle() {
    floorAim = floorAt(0, 0.15);
    if (floorAim) {
      reticle.matrix.makeTranslation(floorAim.x, 0, floorAim.z);
      reticle.matrixWorldNeedsUpdate = true;
    }
    reticle.visible = !!floorAim;
    if (!view.placed && !pending) say(floorAim ? `Tap to put the ${bodyLook.name} here.` : `Point your phone down at the ${onTable(bodyKey) ? "table" : "floor"}.`);
  }

  /**
   * The "Place the Rover here" button (keyboard, switch and screen-reader users): the same as a tap at the reticle in AR
   * (without an anchor: a button click has no XR frame) or on the picture in the camera view.
   */
  function placeHere() {
    if (view.mode === "xr") onSelect({});
    else if (view.mode === "camera") onCanvasTap();
  }

  function onCanvasTap(e) {
    if (view.mode !== "camera" || (e && e.isTrusted === false)) return; // a scripted click is not a person's tap
    if (view.floorMode) {
      // where the finger touched the floor; the Place button (no pointer) uses the reticle
      let p = floorAim;
      if (e && Number.isFinite(e.clientX)) {
        const r = canvas.getBoundingClientRect();
        p = floorAt(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      }
      if (!p) return say(`That is not the ${onTable(bodyKey) ? "table" : "floor"}. Point your phone down and tap it.`);
      const info = { gesture: true, source: "tap", x: p.x, y: 0, z: p.z, yaw: faceToward({ x: p.x, z: p.z }, { x: 0, z: 0 }) };
      if (view.placed) {
        if (view.handlers.place?.(info) === false) return;
        moveTo(info);
        resetTrackers();
        return;
      }
      moveTo(info);
      pending = info;
      return;
    }
    const info = { gesture: true, source: "tap", x: 0, y: 0, z: 0, yaw: placeRoot.rotation.y };
    if (view.placed) {
      if (view.handlers.place?.(info) !== false) resetTrackers();
      return;
    }
    pending = info;
  }

  function onCameraFrame(t) {
    if (view.mode !== "camera") return;
    const dt = step(t);
    if (oriLatest) {
      const sa = globalThis.screen?.orientation?.angle ?? globalThis.orientation ?? 0;
      if (!view.floorMode) enterFloorMode();
      // the real tilt (gravity) and the turn since the start: the scene's floor is the room's floor
      const q = orientationQuat(oriLatest.a - oriA0, oriLatest.b, oriLatest.g, sa);
      camera.quaternion.set(q[0], q[1], q[2], q[3]);
      if (movePlacedAhead) placeAhead();
    }
    if (view.floorMode) {
      fitFov();
      updateFloorReticle();
    }
    updateRig(dt, t);
    renderer.render(scene, camera);
    if (shot) takeCameraShot();
    afterRender(t, {});
  }

  // ---------------------------------------------------------------- photo ("Take a photo", photo.js composes it)
  let shot = null; // { resolve, reject }: a photo waiting for the next drawn frame
  let photoReader = null; // the WebXR camera image at photo size (sessions granted camera access only)

  /**
   * capture() -> Promise<{ w, h, twin, video, camera, kind }> from the next drawn frame: the twin's own layer (a canvas,
   * transparent where nothing is drawn) and the room's picture: the live video in the camera view, the WebXR camera
   * image in AR when the session has camera access ("xr"), else none ("xr-nocam": photo.js puts the twin on paper).
   */
  function capture() {
    if (!view.mode) return Promise.reject(new Error("Start AR or the camera view first."));
    if (shot) return Promise.reject(new Error("A photo is already being taken."));
    return new Promise((resolve, reject) => {
      shot = { resolve, reject };
    });
  }

  /**
   * The twin through `cam` into a w x h target we can read, then a canvas. Flagged as an XR target so three tone-maps and
   * encodes it exactly as it does on screen, into a plain RGBA8 buffer (an sRGB texture format would encode it twice; a
   * multisampled XR target without it reads back empty). Measured in the browser: identical to the screen's pixels.
   */
  function renderTwinLayer(cam, w, h) {
    const rt = new THREE.WebGLRenderTarget(w, h, { samples: 4 });
    rt.texture.colorSpace = THREE.SRGBColorSpace;
    rt.texture.internalFormat = "RGBA8";
    rt.isXRRenderTarget = true;
    const wasXr = renderer.xr.enabled;
    const prev = renderer.getRenderTarget();
    const px = new Uint8Array(w * h * 4);
    const ui = [reticle, labelGroup].map((o) => [o, o.visible]); // the floor ring and the object labels are controls, not the photo
    try {
      for (const [o] of ui) o.visible = false;
      renderer.xr.enabled = false;
      renderer.setRenderTarget(rt);
      renderer.clear();
      renderer.render(scene, cam);
      renderer.readRenderTargetPixels(rt, 0, 0, w, h, px);
    } finally {
      renderer.setRenderTarget(prev);
      renderer.xr.enabled = wasXr;
      for (const [o, v] of ui) o.visible = v;
      rt.dispose();
    }
    const out = document.createElement("canvas");
    out.width = w;
    out.height = h;
    const img = new ImageData(w, h);
    const row = w * 4;
    for (let y = 0; y < h; y++) img.data.set(px.subarray((h - 1 - y) * row, (h - y) * row), y * row); // GL rows run bottom-up
    out.getContext("2d").putImageData(img, 0, 0);
    return out;
  }

  function takeCameraShot() {
    const s = shot;
    shot = null;
    try {
      const { w, h } = photoSize(canvas.clientWidth * (globalThis.devicePixelRatio || 1), canvas.clientHeight * (globalThis.devicePixelRatio || 1));
      s.resolve({ w, h, twin: renderTwinLayer(camera, w, h), video, camera: null, kind: "camera" });
    } catch (e) {
      s.reject(e);
    }
  }

  function takeXrShot(frame, vp) {
    const s = shot;
    shot = null;
    try {
      const xv = vp && vp.views && vp.views[0];
      const xrCam = renderer.xr.getCamera();
      const c0 = xrCam && xrCam.cameras && xrCam.cameras[0];
      if (!xv || !c0) throw new Error("AR has no view to photograph right now. Try again.");
      const port = session.renderState.baseLayer?.getViewport(xv);
      const { w, h } = photoSize(port?.width || canvas.width, port?.height || canvas.height);
      const twin = renderTwinLayer(c0, w, h);
      let cameraImage = null;
      if (view.cameraAccess) {
        photoReader = photoReader || createXrCameraReader(renderer.getContext(), session, { width: Math.max(w, h) });
        cameraImage = photoReader.read(frame, xv);
      }
      s.resolve({ w, h, twin, video: null, camera: cameraImage, kind: cameraImage ? "xr" : "xr-nocam" });
    } catch (e) {
      s.reject(e);
    }
  }

  function stopTracks() {
    try {
      stream?.getTracks().forEach((tr) => tr.stop());
    } catch {}
    stream = null;
    video.srcObject = null;
    video.hidden = true;
  }

  function cleanupCamera() {
    renderer.setAnimationLoop(null);
    shot?.reject(new Error("The camera view closed before the photo was taken."));
    shot = null;
    stopTracks();
    canvas.removeEventListener("click", onCanvasTap);
    if (oriListener) removeEventListener("deviceorientation", oriListener);
    oriListener = null;
    if (pageUp) document.removeEventListener("visibilitychange", pageUp);
    pageUp = null;
    oriLatest = null;
    oriA0 = null;
    floorAim = null;
    movePlacedAhead = false;
    view.orientationOn = false;
    view.floorMode = false;
    reticle.visible = false;
    camera.fov = CAMERA_VIEW.fov;
    camera.updateProjectionMatrix();
    view.mode = null;
    unplace();
    placeRoot.visible = false;
    say(null);
  }

  // ---------------------------------------------------------------- leave
  /** Ends AR or the camera view (the camera tracks stop here). Safe to call twice. */
  function exit(reason = "Closed") {
    if (session) {
      endReason = reason;
      session.end().catch(() => {}); // the "end" event does the rest and calls handlers.ended
      return;
    }
    if (view.mode === "camera") {
      cleanupCamera();
      view.handlers.ended?.(reason);
    }
  }

  // ---------------------------------------------------------------- labels
  function labelTexture(text) {
    const c = document.createElement("canvas");
    c.width = 256;
    c.height = 64;
    const g = c.getContext("2d");
    g.fillStyle = "rgba(251, 248, 242, 0.94)";
    g.strokeStyle = "rgba(35, 33, 30, 0.8)";
    g.lineWidth = 3;
    g.beginPath();
    g.roundRect ? g.roundRect(3, 3, 250, 58, 14) : g.rect(3, 3, 250, 58);
    g.fill();
    g.stroke();
    g.fillStyle = "#23211e";
    g.font = "600 28px Inter, system-ui, sans-serif";
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.fillText(text, 128, 33, 232);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }

  /** setLabels([{ id, text, x, y, z }]): soft paper labels at room positions (metres). An empty list clears them. */
  function setLabels(list) {
    const next = new Set();
    for (const item of Array.isArray(list) ? list.slice(0, 8) : []) {
      const id = String(item.id);
      const text = String(item.text ?? "").replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g, "").slice(0, 28);
      if (!text || ![item.x, item.y, item.z].every(Number.isFinite)) continue;
      next.add(id);
      let rec = labels.get(id);
      if (!rec || rec.text !== text) {
        if (rec) disposeLabel(rec);
        const mat = new THREE.SpriteMaterial({ map: labelTexture(text), transparent: true, depthTest: false, depthWrite: false });
        const sprite = new THREE.Sprite(mat);
        sprite.scale.set(0.2, 0.05, 1);
        sprite.renderOrder = 20;
        labelGroup.add(sprite);
        rec = { sprite, text };
        labels.set(id, rec);
      }
      rec.sprite.position.set(item.x, item.y, item.z);
    }
    for (const [id, rec] of labels) {
      if (next.has(id)) continue;
      disposeLabel(rec);
      labels.delete(id);
    }
  }
  function disposeLabel(rec) {
    labelGroup.remove(rec.sprite);
    rec.sprite.material.map?.dispose();
    rec.sprite.material.dispose();
  }

  function dispose() {
    exit("Closed");
    setLabels([]);
    ro?.disconnect();
    disposeObject(placeRoot);
    renderer.dispose();
  }

  return view;
}
