# AR Rover blueprint (architect, approved by the lead 2026-10-27)

Page `web/ar.html` "AX-1 in your room": the AX-1 Rover TWIN in AR, voice-driven, mobile only. Never a real robot (label TWIN).

## 0. Repo facts
- `ax1-rover` rig (robots.js, FROZEN: import only) is already real scale (metres, Y up, faces +Z): ~0.226 m wide, ~0.229 m tall, ~0.16 m long, front bumper z ~ +0.075. Scale 1. +Z toward the camera = the phone face smiles at the user.
- `makeRenderer(canvas,{alpha})` (look.js, FROZEN): antialias, PCFSoft shadows, ACES, sRGB, pixelRatio<=2. Does NOT set xr. three r160 setSession calls makeXRCompatible, forces alpha on the XRWebGLLayer, clears alpha 0 in alpha-blend, tone maps the XR target. Use makeRenderer(canvas,{alpha:true}) + setClearColor(0,0), scene.background = null.
- Lighting: makeStage(scene, r, {size:0.6, floor:false, background:null}); move key + key.target (added to scene) with the rover. three addons imported (e.g. three/addons/webxr/XREstimatedLight.js) are vendored automatically by build-web addonClosure.
- Drive loop: a tick gap > 283 ms (TICK_MS+STALL_MS) = STOP. Keep main-thread jank below that (shader compile at placement, MediaPipe inference).
- Bridge sim stops at once (only speed-up is slew limited): ~100 ms, ~2 cm at 60 %.
- Parser: "spin" alone not understood; wave/hello/nod refused for the Rover. Parses: `turn left 45`, `turn left 180 then turn left 180`, `look left then look right then look up then look center`. "arm" is not a verb: voice can never arm.
- test/AiPilot.test.js source check bans `.arm(`, getUserMedia, fetch, innerHTML… in web/js/pilot/ai/*: all new code lives in web/js/ar/; the only ai edit is a 2-line parse hook.
- build-web already puts `media-src 'self' blob: mediastream:` on every page.

## 1. Files and owners (EXCLUSIVE)
Builder A — pure logic + tests (no DOM, no three):
- NEW web/js/pilot/twin-pose.js: VMAX=0.35, TRACK=0.2, FRONT=0.08; wheelsFromState(st, body)->[l,r]; stepPose(pose,l,r,dt,{radius})->clamped (mutates, no alloc); composePose(place,local); faceToward(from,to)->yaw; applyTwinState(rig, snap, body, pose, dt, {radius}) (joints /10, wheel spins, pose; rig duck-typed).
- EDIT web/js/pilot/pilot.js: applyState -> applyTwinState(...,{radius:ARENA}); drop local VMAX/TRACK; ARENA 1.6 stays. (Behaviour identical.)
- EDIT web/js/pilot/ai/ai-pilot.js: one option `parse = parseCommand`, call parse(clean, bodyKey, {userSpeed}). Default = unchanged behaviour.
- NEW web/js/ar/ar-caps.js: async probeAr({nav, win}) -> {mode:"xr"|"camera"|"desktop"|"none", secure, ios, voice, orientationNeedsPermission, why}; isSessionSupported in try/catch.
- NEW web/js/ar/chips.js: CHIPS (id,label,say) + chipText(id). STOP is not a chip.
- NEW web/js/ar/ar-parse.js: createArParser({getBlocked, getMode, extensions=[], base=parseCommand}) -> (text, body, opts) => result. EXTENSION CONTRACT (builder C codes against it): an extension is `(text, bodyKey, ctx) => null | result`, where `result` has exactly the shape parseCommand returns and ctx = {opts, getMode, getBlocked}. Extensions run first, first non-null wins; else base; then filterBlocked; then validatePlan again.
- NEW web/js/ar/obstacle.js: depth geometry + tracker with hysteresis, edgeAhead, isForwardWheels, isForwardStep.
- NEW web/js/ar/orientation.js: orientationQuat(alpha,beta,gamma,screenAngle)->[x,y,z,w], relativeQuat(q0,q).
- NEW web/js/ar/ar-controller.js: state machine, stopAll, guarded loop, voice + AI wiring, odometry ownership.
- NEW test/ArTwin.test.js (mocha/chai, dynamic import() like AiPilot.test.js).

Builder B — page, view, CSS:
- NEW web/ar.html: start card, desktop hint, <video id="arVideo">, <canvas id="arCanvas">, #arOverlay = dom-overlay root holding EVERY control. Same head pattern as pilot.html (theme-boot, importmap only, no inline script), body class="pilot ar". Title "AX-1 in your room · OpenForge AX" + meta description.
- NEW web/css/ar.css: overlay layout, :xr-overlay styles, video object-fit:cover behind transparent canvas, one screen no scroll; reuses .pl-btn/.pl-chip by linking pilot.css (pilot.css not edited).
- NEW web/js/ar/ar-view.js: three + WebXR: renderer, session, reticle, hit-test, anchors, light, shadow catcher, depth reading -> obstacle.js, ray hit-test fallback, camera-view scene, orientation look-around.
- NEW web/js/ar/ar.js: entry: loadConfig, renderChrome("pilot"), caps -> start card / desktop hint, creates controller + view, renders controller.view into the overlay. All text via textContent.

Builder C — objects (phase 2):
- NEW web/js/ar/vision/detector.js: lazy-loads vendored MediaPipe from vendor/mediapipe/ (vision_bundle.mjs, wasm/ folder, model vendor/mediapipe/efficientdet_lite0.tflite — already on disk, sha256 0720bf247bd76e6594ea28fa9c6f7c5242be774818997dbbeffc4da460c723bb). createDetector({delegate:"CPU"}) -> {detect(src,tMs)->[{label,score,box}], close()}.
- NEW web/js/ar/vision/xr-camera.js: createXrCameraReader(gl, session) -> {read(frame, view)->ImageData|null} via XRWebGLBinding.getCameraImage, downscaled to 320 px.
- NEW web/js/ar/vision/world-objects.js (pure): smoothing, 2 s TTL, box+depth -> 3D point, toRoverFrame(point, roverPose)->{bearingDeg, distanceM}, COCO label list + aliases (mug->cup, phone->cell phone, sofa->couch).
- NEW web/js/ar/vision/vision-intents.js (pure): ar-parse extension: "what do you see", "go to / find / avoid the <label>".
- NEW web/js/ar/seek.js (pure): bounded re-planning for go-to/find.
- NEW test/ArVision.test.js.

Lead integrates: build-web.mjs (CSP entry for ar.html: img-src 'self' data: blob:, connect-src 'self', script-src + 'wasm-unsafe-eval' ONLY on ar.html; INDEXABLE += ar; EAGER ar.html = js/ar/ar-view.js; copy MediaPipe bundle+wasm+LICENSE into web/vendor/mediapipe/), _headers + serve.mjs AR_POLICY, site-smoke, links (pilot.html caps card, index.html Pilot line), docs 18/13/17/08, license.html notice.

## 2. APIs, state machine, data flow
twin-pose.js: stepPose(p,l,r,dt,{radius=Infinity}): v=(l+r)/2000*VMAX; w=(r-l)/1000*VMAX/TRACK; yaw+=w*dt; x+=sin(yaw)*v*dt; z+=cos(yaw)*v*dt; clamp to radius; return clamped. composePose({x,y,z,yaw:P},{x,z,yaw}) = {x: px + x*cosP + z*sinP, y: py, z: pz - x*sinP + z*cosP, yaw: P+yaw}.

obstacle.js (column-major Float32Array(16), own small mat4 helpers):
OBST = {LOOKAHEAD:0.6, HALF_W:0.14, MIN_H:0.05, MAX_H:0.26, HEIGHTS:[0.07,0.15,0.23], STEPS:8, LANES:3, MIN_HITS:3, ENTER:3, CLEAR:8, CLEAR_EXTRA:0.08, BLIND_FRAC:0.3}
- corridorSamples(worldPose, opts) -> world points along the forward corridor.
- project(p, worldToView, proj) -> {u,v,zView}|null (normalised view coords, origin top-left, v down).
- unproject(u, v, depthM, invProj, viewToWorld) -> world point.
- evaluateDepth({samples, getDepth(u,v), worldToView, viewToWorld, proj, invProj, worldPose, floorY}) -> {hits, nearestM, visibleFrac}: for each sample project, read real depth at (u,v), unproject the real surface, count a hit only if INSIDE the corridor volume (0..LOOKAHEAD along, |lateral|<HALF_W, MIN_H < y-floorY < MAX_H). Floor returns fall under MIN_H; near-camera occluders fall outside -> "not visible".
- evaluateRays(distancesM) -> hit-test fallback into the same tracker.
- edgeAhead(localPose, radius) -> distance to the play-area boundary along the heading.
- createObstacleTracker() -> {update({hits,nearestM,visibleFrac,source}) -> {state:"clear"|"blocked"|"blind"|"off", distanceM, message}, reset()}: blocked after ENTER consecutive frames with hits>=MIN_HITS; clear after CLEAR frames and distance > enter + CLEAR_EXTRA; distance = min over last 5 frames, measured from FRONT, rounded to 10 cm. Message "Something is in my way (about 30 cm ahead)." "blind" (corridor out of view) does not block; chip "Obstacle sensing: point the phone at the Rover".
- isForwardWheels([l,r]) = l+r>0; isForwardStep(s) = drive with a forward direction.

ar-parse.js: filterBlocked(steps, blocked) drops forward drives, adds note "Something is in my way (about N cm ahead). I can turn or back up."; output re-validated with validatePlan; with no obstacle and no extension output deep-equals parseCommand.

ar-controller.js:
createArController({ clock=realTimers, makeTransport, voice, wake, parse, onChange, createAi=createAiPilot, radius=3 }) -> { view, state, pose,
  start(mode)        // after the view entered XR/camera: new loop + loop.connect() (twin -> LATCHED)
  place({gesture:true}) // XR select on the reticle / camera-view tap: pose reset, ai.takeover(), loop.arm()
  arm()              // ARM button click only
  say(text,{source}) // untrusted -> cleanSay -> transcript "I heard: …" -> ai.submit
  chip(id)           // say(chipText(id),{source:"chip"})
  listen()           // mic tap: voice.start(onText -> /^(stop|halt|freeze|brake|abort)\b/i ? stop() : say())
  stop(reason)       // stopAll: ai.cancel("stop") -> seek?.cancel() -> loop.stop(reason)
  hold(reason)       // ai.cancel(reason) -> loop.setHeld(false) (stays ARMED)
  obstacle(update)   // tracker result; blocked && (isForwardWheels(snap.wheels) || running forward step) -> hold(msg)
  frame(dt) -> {x,z,yaw,clamped} // stepPose from the latest snapshot; clamped -> hold("I'm at the edge of my 3 m play area.")
  ended(reason)      // stop(reason) -> loop.disconnect() -> READY
}
Guarded loop: getLoop hands the AI a Proxy over the real loop; only holdFor(ms,x,y) is wrapped: if y>0 and blocked -> hold(msg) synchronously, return false (cancel bumps the AI generation). Every frame still goes through the drive loop.
AI: createAiPilot({getLoop:()=>guarded, getBodyKey:()=>"rover", getMode:()=>"twin", getModel:()=>null, parse, clock, onChange}); built-in parser only; autoRunTwin stays on.
States: CHECKING -> DESKTOP (terminal: URL + link to pilot.html) | READY(mode xr|camera|none)
READY --Start click--> STARTING --ok--> PLACING; STARTING --error/denied--> READY + message
PLACING --place(gesture)--> ARMED (arm refused -> LATCHED + reason)
ARMED --tap floor again (ai not running)--> ARMED (re-place, pose 0, takeover)
ARMED/DRIVING --STOP button | Esc | document hidden | pagehide | XR visibility "hidden" | voice "stop" | plan stop step | bridge latch/stall--> LATCHED (nothing resumes)
ARMED --obstacle blocked & forward | edge | XR "visible-blurred"--> ARMED (hold: plan interrupted, wheels 0)
LATCHED --ARM button click--> ARMED
any --XR end | Exit--> stop -> disconnect -> READY
ARM only via place() (XR select / canvas tap) and the ARM button: direct user gestures.
Data flow: mic tap -> createVoiceInput({lang:"en-US"}) -> one final sentence (<=500 chars, untrusted) -> "I heard: …" -> ai.submit -> arParse (extensions -> parseCommand -> filterBlocked -> validatePlan) -> plan card (describeStep) -> auto-run if armed else ARM_FIRST -> executor (leases <=3 s, 45 s deadline) -> guarded holdFor -> drive loop 33 ms -> twin transport -> bridge-sim -> AX_STATE -> snapshot -> each render frame controller.frame(dt) -> stepPose(radius 3) -> rig under placeRoot (position = hit pose, yaw = faceToward(hit, camera), no tilt) -> composePose -> world pose for obstacle sampling.
Chips: Forward "forward 1 s"; Back "back 1 s"; Left "turn left 45"; Right "turn right 45"; Spin "turn left 180 then turn left 180"; Curious "look left then look right then look up then look center"; Wiggle "turn left 30 then turn right 60 then turn left 30". A chip interrupts the running plan.

## 3. WebXR (three 0.160) + camera view
ar-view.js must be imported before Start is shown; requestSession must be the FIRST await in the click.
init = { requiredFeatures:["hit-test"], optionalFeatures:["dom-overlay","light-estimation","depth-sensing","anchors", ...(wantObjects?["camera-access"]:[])], domOverlay:{root:overlayRoot}, depthSensing:{usagePreference:["cpu-optimized","gpu-optimized"], dataFormatPreference:["luminance-alpha","float32"]} }
session = await navigator.xr.requestSession("immersive-ar", init); renderer.xr.enabled = true; renderer.xr.setReferenceSpaceType("local"); await renderer.xr.setSession(session); local = renderer.xr.getReferenceSpace(); viewer = await session.requestReferenceSpace("viewer"); hitSource = await session.requestHitTestSource({space:viewer});
overlayRoot "beforexrselect": e.target.closest("button, a, input, .ar-panel") && e.preventDefault() (a tap on a control never places). session select -> onSelect (reticle visible -> place+arm, else hint); end -> onEnd("AR closed"); visibilitychange -> onVisibility(session.visibilityState). renderer.setAnimationLoop(onFrame).
onFrame: reticle from frame.getHitTestResults(hitSource)[0]?.getPose(local) (matrixAutoUpdate=false); anchors via hit.createAnchor() if granted; depth if session.depthUsage==="cpu-optimized": frame.getDepthInformation(view)?.getDepthInMeters(u,v) (clamp u,v to [0,1]; check normDepthBufferFromNormView), view.transform.matrix = viewToWorld, .inverse.matrix = worldToView, view.projectionMatrix = proj, ~15 Hz; ray fallback without CPU depth: requestHitTestSource({space:local, offsetRay:new XRRay({x,y:floorY+0.1,z},{x:sin,y:0,z:cos})}) re-created when moved >5 cm or turned >10° (<=5 Hz), cancel the old one, hits < LOOKAHEAD -> evaluateRays. light-estimation via XREstimatedLight addon else makeStage lights. Shadow: 1.2 m ShadowMaterial({opacity:0.28}) plane follows the rover; key light follows, shadow camera ±0.4 m, map 1024. Warm-up: add rig hidden + renderer.compile(scene,camera) before placement; arm one frame after the first visible frame.
Camera view (iPhone / no immersive-ar), inside the Start click: oriP = DeviceOrientationEvent.requestPermission?.() BEFORE any await; getUserMedia({video:{facingMode:{ideal:"environment"},width:{ideal:1280},height:{ideal:720}},audio:false}) -> #arVideo (playsinline muted, object-fit cover, behind transparent canvas); PerspectiveCamera ~60° at (0,1.25,1.3) looking at origin, rover at origin facing camera, odometry radius 1.5 m; orientation granted -> camera.quaternion = base × relativeQuat(q0, orientationQuat(...)); persistent banner "Camera view: the robot is not anchored to your floor (your browser has no WebXR AR)"; obstacle chip "Obstacle sensing needs Android Chrome AR"; canvas tap -> place() (arms); stop tracks on exit, pagehide, hidden.
Desktop/no camera: "Open this on your phone" + location.href.split("#")[0] + link to pilot.html.
Mic copy: "Speech is turned into text by your browser's speech service. In Chrome the audio may be processed on Google's servers; in Safari, Apple's. Camera frames never leave this phone." + phrases to say. Optional "Enable voice" step on the start card: getUserMedia({audio:true}) then stop at once, so no prompt appears inside AR. "visible-blurred" holds; only "hidden" latches.

## 4. Objects (behind a "Look around" toggle, on demand)
Frames: camera view detectForVideo(video,t) at 2 Hz; XR only if camera-access granted (toggle set before entering AR): getCameraImage(view.camera) -> readback 320 px -> detect(ImageData) 2 Hz; else "Object finding in AR needs camera access, which this browser did not give. Camera view can still tell you what it sees." CPU delegate (GPU would open a second WebGL context).
3D: box centre + depth -> unproject -> floor point. Only COCO labels accepted (aliases). Soft label via canvas texture + textContent overlay, never HTML.
Intents (plans only from say/turn/drive/wait, then validatePlan): "what do you see" -> say plan (runs without ARM) up to 3 items with direction+distance; "find the X" -> scan `turn left 45, wait 1` repeated (12 steps / 30 s limits), seek cancels with "I found the X (about 1.2 m ahead-left)"; "go to the X" -> turn bearing° then drive forward min(3,(d-0.3)/(VMAX*speed)), seek re-submits after done: max 5 rounds, 45 s overall, ends within 0.3 m / obstacle ≈ target distance ("I'm next to the X") / target lost 2 s / STOP / takeover / chip; "avoid the X" -> 0.3 m keep-out disc into the tracker. Camera view: go-to/find answer "the twin is not in your room; I can only tell you what the camera sees."

## 5. Tests (Node)
ArTwin: odometry (1 s full speed z=0.35; spin 3.5 rad/s; clamp |p|=R returns true; composePose/faceToward; wheelsFromState on a real twin snapshot; pilot.js imports twin-pose.js, no local VMAX); caps (fake navigator: xr, camera, desktop, insecure, isSessionSupported throwing); chips (every phrase parses, no unknown words, steps>0, <=30 s, no motion unarmed); ar-parse (no obstacle deep-equals parseCommand over a corpus; blocked drops forward with note, keeps back/turn; invisible/bidi stripped); controller with fake clock + real twin transport + real ai-pilot (voice/chips while LATCHED -> ARM_FIRST never ARM; place() arms; STOP order spied ai.cancel -> seek.cancel -> loop.stop; hidden/pagehide/XR end/XR hidden latch and stay LATCHED after 60 s fake clock with wheels 0; blurred/obstacle/edge hold: ARMED, wheels 0 within one tick, plan interrupted with message; guarded holdFor refuses forward, allows back/turn; every lease <=3000 ms; chip interrupts); obstacle (project/unproject round trip; wall 0.4 m ahead -> blocked about 30 cm; floor-only depth ±3 cm noise stays clear; near-camera occluder -> no hit, blind; hysteresis ENTER 3 / CLEAR 8; rays); orientation known angles; source checks (ar.html no inline script but importmap; web/js/ar/** no innerHTML, no fetch except detector.js; `.arm(` only in place() and arm()).
ArVision: intents; unknown/injected label refused; planGoto within limits; seek rounds/deadline/cancels; world-objects TTL/smoothing.

## 6. Risks
283 ms stalls latch the twin (warm-up, arm after first visible frame, 2 Hz CPU detection, worker later). Mic prompt inside AR (pre-grant on the start card). Depth support varies (gpu-only grant = no depth; thin/glass objects missed; noisy past 2 m). camera-access status unknown in stable Chrome (caniuse lists Chrome Android support; reports of context loss in Chrome 125/126) — always degrade gracefully. MediaPipe: ~13.5 MB wasm first load; no eval/new Function in the bundle (verified), it injects a same-origin <script> for vision_wasm_internal.js; needs only 'wasm-unsafe-eval'. Honesty: obstacle sensing is the phone's depth for the TWIN.
