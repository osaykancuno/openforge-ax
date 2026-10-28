const { expect } = require("chai");
const fs = require("node:fs");
const path = require("node:path");

// The AR page "My IRL lab" (web/ar.html, css/ar.css, js/ar/ar.js, js/ar/ar-view.js): source checks for the rules no
// unit test can see in Node (a browser and a phone are needed for the behaviour; see the report of the builder).
const root = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");
const html = read("web/ar.html");
// drops /* block */ and // line comments (a "//" right after ':' or a quote, as in "https://", stays)
const noComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
const css = noComments(read("web/css/ar.css"));
const arJs = noComments(read("web/js/ar/ar.js"));
const viewJs = noComments(read("web/js/ar/ar-view.js"));

/** the body of `function name(...) {...}` / `async function name(...) {...}` (brace matching, strings not parsed: enough here) */
function fnBody(src, name) {
  const at = src.search(new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`));
  if (at < 0) throw new Error(`no function ${name}`);
  const open = src.indexOf("{", src.indexOf(")", at));
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return src.slice(open, i + 1);
  }
  throw new Error(`unbalanced ${name}`);
}

/** the part of the HTML inside <div id="arOverlay" ...> ... </div> (nesting counted) */
function overlayHtml() {
  const start = html.indexOf('<div id="arOverlay"');
  expect(start, "overlay root").to.be.greaterThan(-1);
  const tag = /<(\/?)div\b[^>]*>/g;
  tag.lastIndex = start;
  let depth = 0;
  for (let m; (m = tag.exec(html)); ) {
    depth += m[1] ? -1 : 1;
    if (depth === 0) return html.slice(start, m.index + m[0].length);
  }
  throw new Error("overlay not closed");
}

describe("AR page: ar.html", () => {
  it("has a title, a description and the lab-notebook head of the other app pages", () => {
    expect(html).to.match(/<title>My IRL lab · OpenForge AX<\/title>/);
    expect(html).to.match(/<meta name="description" content="[^"]{60,}">/);
    expect(html).to.match(/<meta name="viewport" content="[^"]*viewport-fit=cover/);
    expect(html).to.match(/<html lang="en">/);
    expect(html).to.match(/<body class="pilot ar">/);
    expect(html.indexOf("js/theme-boot.js")).to.be.greaterThan(-1);
    expect(html.indexOf("js/theme-boot.js")).to.be.lessThan(html.indexOf("css/style.css"));
  });

  it("links style.css, pilot.css, then ar.css (the last one wins)", () => {
    const a = html.indexOf('href="css/style.css"');
    const b = html.indexOf('href="css/pilot.css"');
    const c = html.indexOf('href="css/ar.css"');
    expect(a).to.be.greaterThan(-1);
    expect(b).to.be.greaterThan(a);
    expect(c).to.be.greaterThan(b);
  });

  it("has no inline script except the import map, and no hand-written security policy (the build writes it)", () => {
    const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)];
    expect(scripts.length).to.be.greaterThan(1);
    for (const [, attrs, inner] of scripts) {
      if (/\bsrc=/.test(attrs)) expect(inner.trim(), "a script with src has no body").to.equal("");
      else expect(attrs, "only the import map is inline").to.match(/type="importmap"/);
    }
    // the build writes the policy (once, right after <meta charset>); nobody hand-writes a looser one
    const csp = html.match(/<meta http-equiv="Content-Security-Policy"/g) || [];
    expect(csp.length).to.be.at.most(1);
    if (csp.length) {
      expect(html).to.match(/<meta charset="utf-8">\s*<meta http-equiv="Content-Security-Policy"/);
      expect(html).to.not.match(/script-src[^;"]*(?:unsafe-inline|(?<!wasm-)unsafe-eval)/);
    }
    expect(html).to.not.match(/\son[a-z]+\s*=/i); // no inline event handlers
    expect(html).to.match(/<script type="module" src="js\/ar\/ar\.js"><\/script>/);
    expect(html).to.include('"three": "./vendor/three/three.module.min.js"');
    expect(html).to.include('"three/addons/": "./vendor/three/addons/"');
    expect(html).to.include("<!--preload-->").and.include("<!--seo-->"); // the build fills these in
  });

  it("keeps EVERY control inside #arOverlay (the WebXR dom-overlay root)", () => {
    const inside = overlayHtml();
    const count = (s, re) => (s.match(re) || []).length;
    for (const re of [/<button\b/g, /<a\b/g, /<input\b/g, /<select\b/g, /<textarea\b/g]) {
      expect(count(inside, re), String(re)).to.equal(count(html, re));
    }
    for (const id of ["arStop", "arArm", "arExit", "arChips", "arStartBtn", "arLook", "arHeard", "arPlan", "arObstacle", "arTwin", "arLink", "arHint", "arBanner", "arQr", "arCopy"]) {
      expect(inside, id).to.include(`id="${id}"`);
    }
    // the picture itself is not a control: video and canvas stay outside, behind it
    expect(html.indexOf('id="arVideo"')).to.be.lessThan(html.indexOf('id="arOverlay"'));
    expect(html.indexOf('id="arCanvas"')).to.be.lessThan(html.indexOf('id="arOverlay"'));
  });

  it("has the required copy and labels", () => {
    expect(html).to.include("Look around (find objects)");
    expect(html).to.match(/up to about 19 MB/);
    expect(html).to.match(/Nothing leaves the phone/);
    expect(html).to.match(/Open this on your phone/);
    expect(html).to.include('href="pilot.html"');
    expect(html).to.match(/>TWIN</);
    expect(html).to.match(/Obstacle sensing/);
    expect(html).to.match(/Camera pictures (?:stay on|never leave) this phone/);
    expect(html).to.match(/id="arStop"[^>]*>[\s\S]*?STOP/);
    expect(html).to.match(/id="arArm"[^>]*>ARM</);
    // the look-around toggle is off by default
    expect(html).to.match(/<input type="checkbox" id="arLook"[^>]*>/);
    expect(html).to.not.match(/id="arLook"[^>]*checked/);
  });

  it("gives every button an accessible name and every live region the right role", () => {
    for (const m of html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)) {
      const text = m[2].replace(/<[^>]*>/g, "").trim();
      expect(Boolean(text) || /aria-label="[^"]+"/.test(m[1]), `button ${m[1]}`).to.equal(true);
      expect(m[1], "buttons are type=button").to.match(/type="button"/);
    }
    for (const id of ["arHeard", "arPlan", "arLink", "arHint", "arStartMsg", "arAnnounce"]) {
      expect(html, id).to.match(new RegExp(`id="${id}"[^>]*aria-live="polite"`));
    }
    // stops and failures are alerts; the obstacle chip is not live (its distance changes every 10 cm): ar.js announces state changes
    expect(html).to.match(/id="arAlert"[^>]*role="alert"/);
    expect(html).to.not.match(/id="arObstacle"[^>]*aria-live/);
    expect(html).to.match(/id="arPlan"[^>]*aria-atomic="false"/);
    // no pointer needed to place the Rover; STOP comes first after the top bar and names its shortcut
    expect(html).to.match(/id="arPlaceBtn"[^>]*>Place the Rover here</);
    expect(html.indexOf('id="arStop"')).to.be.lessThan(html.indexOf('id="arHud"'));
    expect(html).to.match(/id="arStop"[^>]*aria-keyshortcuts="Escape"/);
    expect(html).to.match(/id="arLook" aria-describedby="arLookNote"/);
    expect(html).to.match(/<canvas id="arCanvas"[^>]*aria-label="[^"]+"/);
    const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
    expect(new Set(ids).size, "ids are unique").to.equal(ids.length);
  });

  it("only ar.js asks for ids that exist", () => {
    const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
    for (const m of arJs.matchAll(/\$\("([A-Za-z0-9_-]+)"\)/g)) expect(ids.has(m[1]), m[1]).to.equal(true);
    for (const m of arJs.matchAll(/show\("([A-Za-z0-9_-]+)"/g)) expect(ids.has(m[1]), m[1]).to.equal(true);
    for (const m of arJs.matchAll(/\bfor \(const id of \[([^\]]+)\]\)/g)) for (const s of m[1].matchAll(/"([^"]+)"/g)) expect(ids.has(s[1]), s[1]).to.equal(true);
  });
});

describe("AR page: css/ar.css", () => {
  it("is the lab-notebook look: tokens, paper backing, no glow, one screen", () => {
    expect(css).to.not.match(/text-shadow\s*:(?!\s*none)/); // no glow on text
    expect(css).to.not.match(/filter\s*:\s*(?:blur|drop-shadow)/);
    expect(css).to.not.match(/#(?:0ff|f0f|0f0|39ff14)\b/i); // no neon
    expect(css).to.match(/\.ar-panel\s*\{[^}]*background:[^}]*var\(--card\)/);
    expect(css).to.match(/body\.ar\s*\{[^}]*overflow:\s*hidden/); // the page never scrolls
    expect(css).to.match(/max-height:\s*560px/); // the short-screen layout
    expect(css).to.match(/:xr-overlay/);
    expect(css).to.match(/\.ar-video\s*\{[^}]*object-fit:\s*cover/);
    expect(css).to.match(/\.ar-canvas\s*\{[^}]*background:\s*transparent/);
    // theme: only existing tokens, so light and dark both work
    expect(css).to.not.match(/data-theme/);
    for (const v of new Set([...css.matchAll(/var\((--[a-z0-9-]+)/g)].map((m) => m[1]))) {
      expect(read("web/css/style.css"), v).to.include(`${v}:`);
    }
  });

  it("keeps the :xr-overlay rule alone (an unknown selector would void a shared rule)", () => {
    for (const m of css.matchAll(/[^{}]*:xr-overlay[^{]*\{/g)) expect(m[0].trim().split(",").length, m[0]).to.equal(1);
  });

  it("has no voice for now (user, 2026-10-28): no mic button, no microphone request, no speech recognition", () => {
    expect(html).to.not.match(/id="arMic"|id="arVoiceBtn"|id="arPrivacy"|Enable microphone|Tap to talk/);
    expect(html).to.not.match(/your voice|voice\.js/i);
    expect(arJs).to.not.match(/voice\.js|createVoiceInput|getUserMedia\(\{ audio|name: "microphone"|controller\.listen\(/);
    expect(arJs).to.not.match(/\bvoice,/); // the controller gets no voice input
    // the drive buttons say how they work
    expect(html).to.match(/Tap a button for a short move, or hold Forward, Back, Left or Right to keep moving\. STOP always stops it\./);
  });

  it("direction chips: a tap is the short move, a hold drives until the finger lifts, a long press opens no menu", () => {
    // which chips hold comes from chips.js (the Rover's four direction chips), not from a list in the page
    expect(arJs).to.not.match(/HOLDABLE/);
    expect(arJs).to.match(/for \(const c of chipsFor\(key\)\) \{/);
    expect(arJs).to.match(/if \(c\.hold\) \{/);
    expect(arJs).to.match(/held = controller\.press\(c\.id\)/);
    expect(arJs).to.match(/for \(const t of \["pointerup", "pointercancel", "lostpointercapture"\]\) b\.addEventListener\(t, lift\)/);
    expect(arJs).to.match(/if \(held\) controller\.release\(\)/);
    expect(arJs).to.match(/addEventListener\("contextmenu", \(e\) => e\.preventDefault\(\)\)/);
    expect(arJs).to.match(/if \(!e\.isTrusted \|\| e\.button > 0\) return;/);
    expect(css).to.match(/\.ar-chips \.pl-btn \{[^}]*-webkit-touch-callout: none/);
  });

  it("bodies: a Rover / Desk / Walker picker, the Walker never claims to walk, the body is fixed while a session runs", () => {
    const radios = [...html.matchAll(/<input type="radio" name="arBody" value="(\w+)"( checked)?>/g)];
    expect(radios.map((m) => m[1])).to.deep.equal(["rover", "desk", "walker"]);
    expect(radios[0][2]).to.equal(" checked");
    expect(html).to.match(/<b>Walker<\/b> Walks on two legs and strikes poses\./);
    // nothing anywhere says the Walker walks
    for (const [name, src] of [["ar.html", html], ["ar.js", arJs], ["ar-view.js", viewJs]]) expect(src, name).to.not.match(/Walker[^."]{0,80}\bwalks\b/);
    // the body is chosen before the session: setBody never runs after the view started
    expect(viewJs).to.match(/if \(view\.mode\) throw new Error\("Pick the body before AR or the camera view starts"\)/);
    expect(viewJs).to.not.match(/buildRobot\("ax1-rover"\)[\s\S]*buildRobot\("ax1-rover"\)/); // one default, then setBody
    expect(fnBody(arJs, "onStart")).to.not.match(/setBody\(/);
    expect(arJs).to.match(/r\.disabled = starting \|\| live;/);
    // obstacle sensing only for the body that drives
    expect(viewJs).to.match(/if \(view\.placed && BODY_LOOK\[bodyKey\]\.senses\) sense\(/);
    expect(arJs).to.match(/applyTwinState\(rig, snap, controller\.body, p, 0\)/);
  });

  it("keeps the middle of the screen clear: that is where the floor ring and the Rover are", () => {
    // the HUD is a <section>: the site's 72 px section padding must not apply, and it sits at the bottom of its row
    expect(css).to.match(/\.ar-hud\s*\{[^}]*align-self:\s*end[^}]*padding:\s*0[;\s]/);
    // placing: only Place and STOP; the talk panel shows only with text
    expect(css).to.match(/body\.ar-placing \.ar-chips, body\.ar-placing \.ar-drive-row > :not\(#arPlaceBtn\)\s*\{\s*display:\s*none/);
    expect(html).to.match(/id="arTalk" hidden/);
    expect(arJs).to.match(/body\.classList\.toggle\("ar-placing", st === "PLACING"\)/);
    expect(arJs).to.match(/show\("arTalk", /);
    // AR: the floor finder looks above the middle of the screen, clear of the controls
    expect(viewJs).to.match(/requestHitTestSource\(\{ space: viewer, offsetRay: new XRRay\(/);
    expect(viewJs).to.match(/const HIT_TILT_DEG = [5-9];/);
  });

  it("has a big STOP, thumb-sized drive buttons (52 px), 44 px targets, visible focus and respects reduced motion", () => {
    expect(css).to.match(/\.ar-stop\s*\{[^}]*min-height:\s*(?:6[4-9]|[7-9]\d)px/);
    expect(css).to.match(/\.ar-chips \.pl-btn\s*\{[^}]*min-height:\s*52px/);
    expect(css).to.match(/\.ar-exit\s*\{[^}]*min-height:\s*44px/);
    expect(css).to.match(/:focus-visible/);
    expect(css).to.match(/prefers-reduced-motion:\s*reduce\)\s*\{[^}]*animation:\s*none/);
  });
});

describe("AR page: js/ar/ar.js and js/ar/ar-view.js", () => {
  const files = { "ar.js": arJs, "ar-view.js": viewJs };

  it("never use innerHTML, the network, eval or document.write", () => {
    for (const [name, src] of Object.entries(files)) {
      expect(src, name).to.not.match(/\b(?:innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\s*\(|new Function|importScripts)\b/);
      expect(src, name).to.not.match(/\bfetch\s*\(|XMLHttpRequest|WebSocket|sendBeacon|EventSource/);
    }
  });

  it("calls .arm( exactly once, in the ARM button's click handler; the view never", () => {
    expect((viewJs.match(/\.arm\s*\(/g) || []).length, "ar-view.js").to.equal(0);
    expect((arJs.match(/\.arm\s*\(/g) || []).length, "ar.js").to.equal(1);
    // the one ARM path: an explicit click on the ARM button, through the controller
    const handler = arJs.match(/\$\("arArm"\)\.addEventListener\("click",\s*\(e?\)\s*=>\s*\{([^}]*)\}\);/);
    expect(handler, "ARM click handler").to.not.equal(null);
    expect(handler[1]).to.match(/controller\.arm\(\)/);
    expect(handler[1], "a scripted click never arms").to.match(/if \(!e\.isTrusted\) return;/);
    expect((arJs.match(/controller\.arm\b/g) || []).length).to.equal(1);
    // a placement goes through controller.place only, from the view's tap
    expect((arJs.match(/controller\.place\(/g) || []).length).to.equal(1);
    expect(arJs).to.match(/controller\.place\(\{\s*gesture:\s*true/);
    expect(viewJs).to.not.match(/\bcontroller\b/);
  });

  it("ask for the XR session first, and for the motion permission before any await", () => {
    const xr = fnBody(viewJs, "startXr");
    const firstAwait = xr.indexOf("await");
    expect(xr.slice(firstAwait, firstAwait + 60)).to.match(/await navigator\.xr\.requestSession\("immersive-ar", init\)/);
    expect(xr.slice(0, firstAwait)).to.not.match(/\bawait\b/);
    for (const f of ["hit-test", "dom-overlay", "light-estimation", "depth-sensing", "anchors", "camera-access"]) expect(xr).to.include(`"${f}"`);
    expect(xr).to.match(/requiredFeatures:\s*\["hit-test"\]/);
    expect(xr).to.match(/wantObjects \|\| wantPhotos \? \["camera-access"\] : \[\]/); // only when asked: object finding, or photos with the room
    expect(xr).to.match(/domOverlay:\s*\{\s*root:\s*overlay\s*\}/);
    // three must draw into the classic XRWebGLLayer: a projection layer the session did not ask for is never shown in AR
    // (Galaxy S24, Chrome). The session's renderState.layers is hidden before three reads it in setSession.
    const hide = xr.indexOf('Object.defineProperty(s.renderState, "layers", { value: undefined');
    expect(hide, "renderState.layers hidden").to.be.greaterThan(-1);
    expect(hide).to.be.lessThan(xr.indexOf("await renderer.xr.setSession(s)"));
    expect(xr).to.not.match(/Features:\s*\[[^\]]*"layers"/); // and the session never asks for the layers feature

    const cam = fnBody(viewJs, "startCamera");
    expect(cam.slice(0, cam.indexOf("await"))).to.match(/navigator\.mediaDevices\.getUserMedia\(/);
    expect(cam).to.match(/facingMode:\s*\{\s*ideal:\s*"environment"\s*\}/);
    expect(cam).to.match(/audio:\s*false/);

    const start = fnBody(arJs, "onStart");
    const before = start.slice(0, start.indexOf("await"));
    expect(before).to.match(/requestOrientation\(\)/);
    expect(before).to.match(/view\.startXr\(/);
    expect(before).to.match(/view\.startCamera\(/);
    expect(fnBody(arJs, "requestOrientation")).to.match(/requestPermission\(\)/);
    expect(fnBody(arJs, "requestOrientation").slice(0, fnBody(arJs, "requestOrientation").indexOf("requestPermission"))).to.not.match(/\bawait\b/);
  });

  it("stop on STOP, Esc, the page going away and the session ending; hold when AR is blurred", () => {
    expect(arJs).to.match(/\$\("arStop"\)\.addEventListener\("pointerdown"/);
    expect(arJs).to.match(/\$\("arStop"\)\.addEventListener\("click"/);
    expect(arJs).to.match(/e\.key === "Escape"/);
    expect(arJs).to.match(/visibilitychange[\s\S]{0,200}document\.hidden[\s\S]{0,120}stop\(/);
    expect(arJs).to.match(/addEventListener\("pagehide"[\s\S]{0,120}stop\(/);
    // XR visibility goes to the controller: "hidden" latches, "visible-blurred" holds
    expect(arJs).to.match(/visibility:\s*\(s\)\s*=>\s*controller\.visibility\(s\)/);
    expect(read("web/js/ar/ar-controller.js")).to.match(/v === "hidden"\)\s*return api\.stop\(/);
    expect(read("web/js/ar/ar-controller.js")).to.match(/v === "visible-blurred"\)\s*api\.hold\(/);
    expect(arJs).to.match(/ended:\s*\(reason\)\s*=>\s*\{\s*controller\.ended\(reason\)/);
    // the view reports each of those
    expect(viewJs).to.match(/addEventListener\("visibilitychange",\s*\(\)\s*=>\s*view\.handlers\.visibility\?\.\(/);
    expect(viewJs).to.match(/addEventListener\("end",\s*onXrEnd\)/);
  });

  it("closes the view again when the twin cannot start, and refuses a second placement while a plan runs", () => {
    const start = fnBody(arJs, "onStart");
    expect(start).to.match(/await controller\.start\(mode, bodyKey\)/);
    expect(start).to.match(/view\.exit\(why\)/);
    expect(arJs).to.match(/place:\s*\(info\)\s*=>/);
    expect(arJs).to.match(/!v\.canPlace\)\s*return false/);
    expect(arJs).to.match(/v\.ai\.running/);
  });

  it("a tap on a control never places, and the camera tracks stop on exit", () => {
    expect(viewJs).to.match(/addEventListener\("beforexrselect"/);
    expect(viewJs).to.match(/closest\?\.\("button, a, input, label, \.ar-panel"\)\s*&&\s*e\.preventDefault\(\)/);
    const stop = fnBody(viewJs, "stopTracks");
    expect(stop).to.match(/getTracks\(\)\.forEach\(\(tr\) => tr\.stop\(\)\)/);
    expect(stop).to.match(/srcObject = null/);
    expect(fnBody(viewJs, "cleanupCamera")).to.match(/stopTracks\(\)/);
    expect(viewJs).to.match(/document\.addEventListener\("visibilitychange", pageUp\)/);
  });

  it("offer the hooks for object finding: onCameraFrame, setLabels and a camera-access option", () => {
    expect(viewJs).to.match(/onCameraFrame\(cb\)/);
    expect(viewJs).to.match(/\bsetLabels\b/);
    expect(viewJs).to.match(/\.fillText\(/);
    expect(viewJs).to.match(/wantObjects/);
  });

  it("wire object finding: lazy detector, camera access in AR, trips, keep-out zones, and a full shutdown", () => {
    // the intents are registered whether Look around is on or not; the detector loads only inside startObjects
    expect(arJs).to.match(/extensions\.push\(intents\.extension\)/);
    expect(arJs).to.match(/controller\.seek = seek/);
    expect(arJs).to.match(/seek\.onAiChange\(model\.ai\)/);
    expect(arJs).to.match(/isLooking:\s*\(\)\s*=>\s*looking/);
    expect((arJs.match(/createDetector\(/g) || []).length).to.equal(1);
    const start = fnBody(arJs, "startObjects");
    expect(start).to.match(/createDetector\(/);
    expect(start).to.match(/await mine\.load\(\)/);
    expect(start).to.match(/mode:\s*xr \? "IMAGE" : "VIDEO"/);
    expect(start).to.match(/createXrCameraReader\(/);
    expect(start).to.match(/info\.cameraAccess/); // no camera access: the plain message, driving goes on
    expect(arJs).to.include("Object finding in AR needs camera access, which this browser did not give. Camera view can still tell you what it sees.");
    expect(start).to.match(/createXrDepthContext\(frameInfo\.frame, xrViewOf\(frameInfo\)\)/);
    expect(start).to.match(/view\.setLabels\(toViewLabels\(world\.list\(t\)\)\)/);
    expect(start).to.match(/capture:\s*\(frameInfo\)/); // the XR frame is read inside the callback; the answer comes later
    expect(start).to.match(/mayRunOnMain:\s*\(\)\s*=>\s*!controller\.view\.armed/); // the main-thread fallback never runs while armed
    expect(start).to.match(/view\.onCameraFrame\(/);
    // a trip asks the pilot with plain text and cancels through hold(); STOP cancels it through the controller
    expect(arJs).to.match(/submit:\s*\(text\)\s*=>\s*controller\.say\(text,\s*\{\s*source:\s*"chip"\s*\}\)/);
    expect(arJs).to.match(/cancelPlan:\s*\(text\)\s*=>\s*controller\.hold\(text\)/);
    // "avoid the X": the keep-out discs are merged into the obstacle result before the controller sees it
    const push = fnBody(arJs, "pushObstacle");
    expect(push).to.match(/zoneHit\(zones, w\)/);
    expect(push.indexOf("zoneHit")).to.be.lessThan(push.indexOf("controller.obstacle(u)"));
    // two paths reach the controller: ahead (through the keep-out merge) and behind (straight: no zones behind)
    expect((arJs.match(/controller\.obstacle\(/g) || []).length).to.equal(2);
    expect(arJs).to.match(/if \(u && u\.side === "back"\) \{[\s\S]{0,200}?controller\.obstacle\(u\);/);
    // off / exit / pagehide: detector closed, labels cleared, trips cancelled
    const stop = fnBody(arJs, "stopObjects");
    for (const part of [/detector\?\.close\(\)/, /reader\?\.close\(\)/, /view\.setLabels\(\[\]\)/, /view\.onCameraFrame\(null\)/, /seek\.cancel\(\)/, /intents\.clearAvoid\(\)/]) expect(stop).to.match(part);
    expect(fnBody(arJs, "leaveLive")).to.match(/stopObjects\(\)/);
    expect(arJs).to.match(/addEventListener\("pagehide"[\s\S]{0,160}stopObjects\(\)/);
    // the toggle is off by default and the model is not touched by the page itself
    expect(html).to.not.match(/id="arLook"[^>]*checked/);
    expect(arJs).to.not.match(/vendor\/mediapipe/);
  });

  it("do not touch the frozen model files or ask for sound", () => {
    expect(viewJs).to.match(/from "\.\.\/models\/look\.js"/);
    expect(viewJs).to.not.match(/AudioContext|new Audio\(|\.play\(\)\.then[\s\S]{0,0}audio/);
    expect(arJs).to.not.match(/AudioContext|new Audio\(/);
  });
});

describe("AR page: iPhone and iPad (Apple AR Quick Look, camera-view floor)", () => {
  const qlJs = noComments(read("web/js/ar/quick-look.js"));
  it("has a hidden rel=ar link holding an <img> (Safari opens Quick Look only then) and a visible button", () => {
    expect(html).to.match(/<a rel="ar" id="arQlLink" hidden[^>]*><img [^>]*alt=""[^>]*><\/a>/);
    expect(html).to.match(/<button class="pl-btn" id="arQlBtn" type="button">See it on my floor \(Apple AR\)<\/button>/);
    expect(html).to.match(/<div class="pl-row pl-wrap" id="arQlRow" hidden>/);
  });
  it("loads the USDZ exporter only when a model is made, and opens the link at real size", () => {
    expect(qlJs).to.not.match(/^import [^;]*USDZExporter/m);
    expect(qlJs).to.match(/await import\("three\/addons\/exporters\/USDZExporter\.js"\)/);
    expect(qlJs).to.include("#allowsContentScaling=0");
    expect(qlJs).to.match(/relList\?\.supports\?\.\("ar"\)/);
    expect(qlJs).to.match(/quickLookCompatible: true/);
    expect(qlJs).to.match(/isMeshBasicMaterial/); // the unlit face becomes a standard material, or Quick Look drops it
  });
  it("makes the model before the tap and offers it only where Quick Look exists and WebXR AR does not", () => {
    expect(arJs).to.match(/const ql = QUICK_LOOK && !xr;/);
    expect(fnBody(arJs, "showCard")).to.include("prepareQuickLook(bodyKey)");
    expect(fnBody(arJs, "onQuickLook")).to.include('openQuickLook($("arQlLink"), url, key)');
  });
  it("the camera view's floor mode: real tilt, a phone height, the lens's field of view, taps on the floor", () => {
    expect(viewJs).to.match(/orientationQuat\(oriLatest\.a - oriA0, oriLatest\.b, oriLatest\.g, sa\)/);
    expect(fnBody(viewJs, "enterFloorMode")).to.include("PHONE_HEIGHT[bodyKey]");
    expect(fnBody(viewJs, "fitFov")).to.include("cameraFovDeg(");
    expect(fnBody(viewJs, "onCanvasTap")).to.match(/e\.isTrusted === false/); // a scripted click never places
    expect(arJs).to.include("It does not follow your steps");
  });
  it("the cross-engine smoke covers Chromium, Firefox and WebKit, with iPhone and iPad profiles", async () => {
    const { PROFILES } = await import("../scripts/site-engines.mjs");
    expect(new Set(PROFILES.map((p) => p.engine))).to.deep.equal(new Set(["chromium", "firefox", "webkit"]));
    for (const d of ["iPhone 13", "iPad (gen 7)", "Pixel 7"]) expect(PROFILES.some((p) => p.device === d), d).to.equal(true);
  });
});

describe("AR page: Take a photo (photo.js)", () => {
  let PH;
  before(async () => { PH = await import("../web/js/ar/photo.js"); });
  const photoJs = noComments(read("web/js/ar/photo.js"));

  it("coverCrop frames exactly what object-fit: cover shows", () => {
    // a 720 x 1280 portrait video in a 390 x 844 screen: the full height, the sides trimmed
    const c = PH.coverCrop({ srcW: 720, srcH: 1280, dstW: 390, dstH: 844 });
    expect(c.sh).to.be.closeTo(1280, 1e-9);
    expect(c.sw).to.be.closeTo((390 / 844) * 1280, 1e-9);
    expect(c.sx).to.be.closeTo((720 - c.sw) / 2, 1e-9);
    expect(c.sy).to.equal(0);
    // a landscape camera image in a portrait photo: the middle strip
    const d = PH.coverCrop({ srcW: 1280, srcH: 720, dstW: 600, dstH: 1000 });
    expect(d.sh).to.equal(720);
    expect(d.sw / d.sh).to.be.closeTo(0.6, 1e-9);
    expect(d.sx).to.be.closeTo((1280 - d.sw) / 2, 1e-9);
    expect(PH.coverCrop({ srcW: 0, srcH: 720, dstW: 1, dstH: 1 })).to.equal(null);
  });

  it("photoSize keeps the shape and caps the longer side; it never enlarges", () => {
    expect(PH.photoSize(1170, 2532)).to.deep.equal({ w: Math.round(1170 * (1600 / 2532)), h: 1600 });
    expect(PH.photoSize(800, 600)).to.deep.equal({ w: 800, h: 600 });
  });

  it("the brand badge stays inside the photo in every corner, with the mark, the name and the site", () => {
    for (const [w, h] of [[1080, 1920], [1600, 900], [600, 600], [320, 568]]) {
      for (const corner of ["bl", "br", "tl", "tr"]) {
        const L = PH.watermarkLayout({ w, h, corner });
        expect(L.box.x, `${w}x${h} ${corner}`).to.be.at.least(0);
        expect(L.box.y).to.be.at.least(0);
        expect(L.box.x + L.box.w).to.be.at.most(w);
        expect(L.box.y + L.box.h).to.be.at.most(h);
        expect(L.mark.size).to.be.below(L.box.h + 1);
        expect(L.title.text).to.equal("OpenForge AX · My IRL lab");
        expect(L.url.text).to.equal("osaykancuno.github.io/openforge-ax/");
        expect(L.box.w * L.box.h).to.be.below(w * h * 0.12); // a small corner, never over the twin's middle
      }
      expect(PH.watermarkLayout({ w, h, corner: "br" }).box.x).to.be.above(PH.watermarkLayout({ w, h, corner: "bl" }).box.x);
      expect(PH.watermarkLayout({ w, h, corner: "tl" }).box.y).to.be.below(PH.watermarkLayout({ w, h, corner: "bl" }).box.y);
    }
  });

  it("the badge goes to the corner the twin covers least (bottom left on a tie)", () => {
    expect(PH.pickCorner({ bl: 0, br: 0, tl: 0, tr: 0 })).to.equal("bl");
    expect(PH.pickCorner({ bl: 200, br: 10, tl: 50, tr: 90 })).to.equal("br");
    expect(PH.pickCorner({ bl: 30, br: 30, tl: 5, tr: 30 })).to.equal("tl");
    expect(PH.pickCorner({})).to.equal("bl");
  });

  it("names the file by date and time", () => {
    expect(PH.photoFileName(new Date(2026, 9, 28, 14, 30, 5))).to.equal("openforge-ax-my-irl-lab-20261028-143005.jpg");
  });

  it("shares a file with Web Share Level 2, says when the person cancels, and reports browsers that cannot", async () => {
    const file = { name: "x.jpg" };
    const calls = [];
    const nav = (canShare, share) => ({ canShare, share: async (d) => (calls.push(d), share && share()) });
    expect(await PH.sharePhoto(file, {})).to.equal("unsupported");
    expect(await PH.sharePhoto(file, nav(() => false))).to.equal("unsupported");
    expect(await PH.sharePhoto(file, nav(() => true))).to.equal("shared");
    expect(calls[0].files).to.deep.equal([file]);
    expect(calls[0].url).to.equal(PH.SITE_URL);
    const abort = Object.assign(new Error("no"), { name: "AbortError" });
    expect(await PH.sharePhoto(file, nav(() => true, () => { throw abort; }))).to.equal("cancelled");
    let thrown = null;
    await PH.sharePhoto(file, nav(() => true, () => { throw new Error("broken"); })).catch((e) => (thrown = e));
    expect(thrown && thrown.message).to.equal("broken"); // the page then saves it instead
    expect(PH.canShareFile(file, { canShare: () => { throw new Error("x"); }, share() {} })).to.equal(false);
  });

  it("page: a Take a photo button in the live top bar, a preview with Share, Save and Close, all inside #arOverlay", () => {
    const inside = overlayHtml();
    for (const id of ["arPhoto", "arShot", "arShotImg", "arShare", "arSave", "arShotClose", "arShotMsg", "arPhotos"]) expect(inside, id).to.include(`id="${id}"`);
    expect(html).to.match(/<button class="pl-btn sm" id="arPhoto" type="button">Take a photo<\/button>/);
    expect(html).to.match(/<p class="pl-msg" id="arShotMsg" role="status" aria-live="polite"><\/p>/);
    expect(html).to.match(/<input type="checkbox" id="arPhotos" checked/);
  });

  it("source: the photo is drawn from the view's own frame, never uploaded, and falls back to saving", () => {
    expect(fnBody(viewJs, "renderTwinLayer")).to.include("rt.isXRRenderTarget = true"); // the same tone mapping and sRGB as the screen
    expect(fnBody(viewJs, "renderTwinLayer")).to.include('rt.texture.internalFormat = "RGBA8"'); // else sRGB is applied twice
    expect(fnBody(viewJs, "takeXrShot")).to.match(/createXrCameraReader\(/);
    expect(fnBody(viewJs, "takeXrShot")).to.include('"xr-nocam"');
    expect(viewJs).to.match(/if \(shot\) takeXrShot\(frame, vp\);/);
    expect(viewJs).to.match(/if \(shot\) takeCameraShot\(\);/);
    expect(photoJs).to.not.match(/fetch\(|XMLHttpRequest|sendBeacon|WebSocket/);
    expect(fnBody(arJs, "onShare")).to.include("savePhoto(photo.blob, photo.name)");
    expect(fnBody(arJs, "leaveLive")).to.include("closePhoto()");
    expect(fnBody(arJs, "onPhoto")).to.include("Photos show my room");
  });
});
