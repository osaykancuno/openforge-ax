const { expect } = require("chai");
const fs = require("node:fs");
const path = require("node:path");

// The AR page "AX-1 in your room" (web/ar.html, css/ar.css, js/ar/ar.js, js/ar/ar-view.js): source checks for the rules no
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
    expect(html).to.match(/<title>AX-1 in your room · OpenForge AX<\/title>/);
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
    for (const id of ["arStop", "arMic", "arArm", "arExit", "arChips", "arStartBtn", "arLook", "arHeard", "arPlan", "arObstacle", "arTwin", "arLink", "arHint", "arBanner", "arUrl"]) {
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
    expect(html).to.match(/Google in Chrome, Apple in Safari/);
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
    expect(html).to.match(/id="arMic"[^>]*aria-pressed="false"/);
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

  it("has a big STOP, 44 px targets, visible focus and respects reduced motion", () => {
    expect(css).to.match(/\.ar-stop\s*\{[^}]*min-height:\s*(?:6[4-9]|[7-9]\d)px/);
    expect(css).to.match(/\.ar-chips \.pl-btn\s*\{[^}]*min-height:\s*44px/);
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
    expect(xr).to.match(/wantObjects\s*\?\s*\["camera-access"\]\s*:\s*\[\]/);
    expect(xr).to.match(/domOverlay:\s*\{\s*root:\s*overlay\s*\}/);

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
    expect(start).to.match(/await controller\.start\(mode\)/);
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
    expect((arJs.match(/controller\.obstacle\(/g) || []).length).to.equal(1);
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
