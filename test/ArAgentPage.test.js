const { expect } = require("chai");
const fs = require("node:fs");
const path = require("node:path");

// ar.html?agent=<tokenId> ("bring your agent to life", My IRL lab): source checks for what Node cannot see in a browser, plus the
// pure pieces of the view and the orientation helpers. The behaviour per class is checked on the phone (see the builder's report).
const root = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");
const noComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
const html = read("web/ar.html");
const css = noComments(read("web/css/ar.css"));
const src = Object.fromEntries(["ar", "ar-view", "agent-token", "agent-rig", "showcase", "quick-look", "chips"].map((f) => [f, noComments(read(`web/js/ar/${f}.js`))]));

/** the part of the HTML inside <div id="arOverlay" ...> ... </div> (nesting counted) */
function overlayHtml() {
  const start = html.indexOf('<div id="arOverlay"');
  const tag = /<(\/?)div\b[^>]*>/g;
  tag.lastIndex = start;
  let depth = 0;
  for (let m; (m = tag.exec(html)); ) {
    depth += m[1] ? -1 : 1;
    if (depth === 0) return html.slice(start, m.index + m[0].length);
  }
  throw new Error("overlay not closed");
}

describe("AR agent: the page (ar.html?agent=<id>)", () => {
  it("parses the ?agent parameter with the pure parser, and reads the token only through chain.js", () => {
    expect(src.ar).to.match(/import \{ agentFromMeta, parseAgentParam \} from "\.\/agent-token\.js"/);
    expect(src.ar).to.match(/parseAgentParam\(location\.search\)/);
    expect(src.ar).to.match(/import \{ isDeployed, loadConfig, renderChrome, tokenMeta \} from "\.\.\/chain\.js"/);
    expect((src.ar.match(/tokenMeta\(/g) || []).length).to.equal(1);
    // after loadConfig, only when a collection is deployed
    expect(src.ar.indexOf("await loadConfig()")).to.be.lessThan(src.ar.indexOf("readAgent()"));
    expect(src.ar).to.match(/if \(!isDeployed\(\)\) return setLookup\(\{ status: "unminted" \}\)/);
    // a read that hangs is an error with Retry; an old answer never wins
    expect(src.ar).to.match(/const LOOKUP_MS = \d+/);
    expect(src.ar).to.match(/if \(token !== lookupToken\) return;/);
  });

  it("adds no network origin and no network call of its own", () => {
    for (const f of ["ar", "ar-view", "agent-token", "agent-rig", "showcase", "quick-look"]) {
      expect(src[f], f).to.not.match(/https?:\/\/|wss?:\/\//);
      expect(src[f], f).to.not.match(/\bfetch\s*\(|XMLHttpRequest|WebSocket|sendBeacon|EventSource|importScripts/);
    }
    // the page's own files stay the ones the build knows: nothing is loaded from a remote script
    expect(html).to.not.match(/<script[^>]+src="https?:/);
  });

  it("writes no HTML, and chain data (the callsign, the class) reaches only text nodes, attributes and the title", () => {
    for (const f of ["ar", "agent-token", "agent-rig", "showcase", "quick-look"]) {
      expect(src[f], f).to.not.match(/\b(?:innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\s*\(|new Function)\b/);
    }
    for (const line of src.ar.split("\n").filter((l) => /callsign|className/.test(l))) {
      expect(line).to.not.match(/innerHTML|insertAdjacentHTML|\.append\(\s*`|createContextualFragment/);
    }
    // the agent record is built by agent-token.js, which cleans the callsign; ar.js never reads the metadata itself
    expect(src.ar).to.not.match(/meta\.name|meta\.attributes|\.attributes\b|trait_type/);
    expect(src["agent-token"]).to.match(/UNSAFE/);
  });

  it("the lookup note and Retry live inside #arOverlay (the WebXR dom-overlay root), with live regions", () => {
    const inside = overlayHtml();
    for (const id of ["arAgentNote", "arAgentRetry", "arAgentRetryRow", "arFig", "arBodies", "arChips"]) expect(inside, id).to.include(`id="${id}"`);
    expect(html).to.match(/id="arAgentNote"[^>]*role="status"[^>]*aria-live="polite"[^>]*hidden/);
    expect(html).to.match(/<button class="pl-btn" id="arAgentRetry" type="button">Retry<\/button>/);
    expect(html).to.match(/<div class="pl-row pl-wrap" id="arAgentRetryRow" hidden>/);
  });

  it("the showcase controls are the existing chips in #arChips (inside the overlay), and Photo and Exit are the existing top-bar buttons", () => {
    const inside = overlayHtml();
    expect(inside).to.include('id="arChips"');
    expect(inside).to.match(/id="arPhoto" type="button">Take a photo</);
    expect(inside).to.match(/id="arExit"/);
    // no control outside the overlay appeared
    for (const re of [/<button\b/g, /<a\b/g, /<input\b/g]) expect((inside.match(re) || []).length, String(re)).to.equal((html.match(re) || []).length);
    // the chips come from chips.js: a tap on "Its move", holds on the two turn buttons
    expect(src.chips).to.match(/showcase: Object\.freeze\(\[/);
    expect(src.chips).to.match(/\{ id: "move", label: "Its move" \}/);
    expect(src.chips).to.match(/\{ id: "left", label: "Turn left", hold: true \}/);
    expect(src.chips).to.match(/\{ id: "right", label: "Turn right", hold: true \}/);
    expect(src.ar).to.match(/buildChips\(bodyKey\)/);
  });

  it("a showcase has no STOP, no ARM and no obstacle chip; the AX-1 paths still do", () => {
    expect(src.ar).to.match(/show\("arStop", live && !showing\)/);
    expect(src.ar).to.match(/show\("arArm", !showing\)/);
    expect(src.ar).to.match(/show\("arObstacle", !showing\)/);
    // the AX-1 branch of the frame handler is untouched and comes second
    expect(src.ar).to.match(/if \(showing\) return showcase\.frame\(dt\);[\s\S]{0,120}const p = controller\.frame\(dt\);/);
    expect(src.ar).to.match(/applyTwinState\(rig, snap, controller\.body, p, 0\)/);
    // it says plainly that only the AX-1 bodies are driven in AR today
    expect(src.showcase).to.match(/Only the AX-1 bodies are driven in AR today/);
    expect(src.ar).to.match(/showing \? SHOWCASE_NOTE : ""/);
  });

  it("the body never changes under a session: an answer that arrives mid-session waits for leaveLive", () => {
    expect(src.ar).to.match(/if \(!lookupDeferred \|\| \(!sessionOver && \(starting \|\| LIVE\.has\(stateName\(\)\)\)\)\) return;/);
    expect(src.ar).to.match(/flushLookup\(true\)/);
    expect(src.ar).to.match(/if \(agent \|\| !Object\.hasOwn\(BODY_NAMES, key\)/); // the body picker is off with an agent
    const idx = (re) => src.ar.search(re);
    expect(idx(/dressTwin\(lookup\)/)).to.be.greaterThan(idx(/function flushLookup/));
    expect((src.ar.match(/dressTwin\(/g) || []).length).to.equal(2); // its definition and the one call
  });

  it("honest fallbacks on the start card, each with its words", () => {
    expect(src.ar).to.include("Agents are not minted yet: ${meanwhile}.");
    expect(src.ar).to.include("meet the AX-1 twins meanwhile");
    expect(src.ar).to.include("This agent is still dormant: it wakes at the reveal.");
    expect(src.ar).to.include("That is not an agent number");
    expect(src.ar).to.match(/could not be read just now[^`]*Retry/);
    // the lead of an agent: a twin, not a real robot, pictures stay on the phone
    expect(src.ar).to.include("Bring ${a.tag} ${a.callsign} to life:");
    expect(src.ar).to.match(/It is a twin, not a real robot\. Camera pictures never leave this phone\./);
    expect(src.ar).to.include("`${a.tag} · ${a.callsign}`"); // the title
  });

  it("the look is the shared one: dressToken and createMotion are imported, never re-implemented", () => {
    expect(src["agent-rig"]).to.match(/import \{ CLASS_ROBOT, dressToken \} from "\.\.\/models\/token-look\.js"/);
    expect(src["agent-rig"]).to.match(/import \{ createMotion \} from "\.\.\/models\/motion\.mjs"/);
    expect(src["agent-rig"]).to.match(/dressToken\(rig, \{ id: agent\.id, t: agent\.traits \}, \{ pose \}\)/);
    expect(src["agent-rig"]).to.match(/Object\.create\(rig, \{ group: \{ value: inner \} \}\)/);
    for (const f of ["ar", "agent-rig", "showcase", "ar-view"]) expect(src[f], f).to.not.match(/const (?:FINISH|GOLD)\b|function (?:paint|augment|topPoint|rng)\b|GESTURES/);
    expect(src.showcase).to.match(/import \{ MOTION \} from "\.\.\/models\/motion\.mjs"/);
    expect(src.showcase).to.match(/Math\.floor\(elapsed \* MOTION\.fps\)/);
    // the AX-1 twin keeps its joints for the drive loop
    expect(src.ar).to.match(/dressAgent\(rig, a, \{ pose: false \}\)/);
    expect(src.ar).to.match(/dressAgent\(rig, a, \{ pose: true, motion: true \}\)/);
  });

  it("the view dresses the robot in a scene of its own and sets a showcase twin on the floor once", () => {
    expect(src["ar-view"]).to.match(/function setRobot\(robotId, \{ dress = null, name = "" \} = \{\}\)/);
    expect(src["ar-view"]).to.match(/if \(view\.mode\) throw new Error\("Pick the body before AR or the camera view starts"\)/);
    expect((src["ar-view"].match(/Pick the body before AR or the camera view starts/g) || []).length).to.equal(2);
    expect(src["ar-view"]).to.match(/groundY = live \|\| look \? 0 : -box\.min\.y/);
    expect(src["ar-view"]).to.match(/if \(groundLive && placeRoot\.scale\.x === 1/);
    expect(src["ar-view"]).to.match(/bodyLook = look \|\| lookFromBox\(box, name\)/);
    expect(src["ar-view"]).to.match(/camera\.position\.set\(0, phoneHeightFor\(bodyKey\), 0\)/);
    expect(src["ar-view"]).to.match(/senses: false/);
    expect(src["ar-view"]).to.not.match(/BODY_LOOK\[bodyKey\]/);
  });

  it("Quick Look on iPhone makes the USDZ of the dressed robot after it is in the scene; the AX-1 path is unchanged", () => {
    expect(src["quick-look"]).to.match(/export function usdzUrl\(body, \{ id = body, robotId = `ax1-\$\{body\}`, dress = null \} = \{\}\)/);
    const q = src["quick-look"];
    expect(q.indexOf("scene.add(rig.group)")).to.be.lessThan(q.indexOf("dress?.(rig)"));
    expect(q).to.match(/#allowsContentScaling=0/);
    expect(src.ar).to.match(/usdzUrl\(key, \{ id: key, robotId: robotIdOf\(a\), dress: \(rig\) => dressAgent\(rig, a, \{ pose: true \}\) \}\)/);
    expect(src.ar).to.match(/const qlKey = \(\) => \(agent \? `agent-\$\{agent\.id\}` : bodyKey\)/);
  });

  it("css: the lookup note is a plain line on the paper tokens", () => {
    expect(css).to.match(/\.ar-agent-note\s*\{/);
    expect(css).to.match(/\.ar-start #arAgentRetryRow/);
  });
});

describe("AR agent: the view's pure helpers and the phone heights", () => {
  let V, O, THREE, saved;
  before(async () => {
    saved = globalThis.document;
    const noop = new Proxy(function () {}, { get: (t, k) => (k === "measureText" ? () => ({ width: 10 }) : noop), apply: () => noop, set: () => true });
    globalThis.document = { createElement: () => ({ width: 0, height: 0, getContext: () => noop, style: {} }) };
    THREE = await import("three");
    O = await import("../web/js/ar/orientation.js");
    V = await import("../web/js/ar/ar-view.js");
  });
  after(() => {
    globalThis.document = saved;
  });

  it("phoneHeightFor: floor robots 1.25 m, the Desk and the desk-top robots 0.45 m, anything unknown 1.25 m", () => {
    expect(O.phoneHeightFor("rover")).to.equal(1.25);
    expect(O.phoneHeightFor("walker")).to.equal(1.25);
    expect(O.phoneHeightFor("desk")).to.equal(0.45);
    for (const id of ["so101", "hand", "fab"]) expect(O.phoneHeightFor(`agent:${id}`), id).to.equal(0.45);
    for (const id of ["rover", "hound", "spider", "drone", "replicant"]) expect(O.phoneHeightFor(`agent:${id}`), id).to.equal(1.25);
    for (const k of ["", "x", undefined, null, "__proto__", "constructor", "toString"]) expect(O.phoneHeightFor(k), String(k)).to.equal(1.25);
    expect(O.onTable("desk")).to.equal(true);
    expect(O.onTable("agent:fab")).to.equal(true);
    expect(O.onTable("agent:drone")).to.equal(false);
    expect(O.onTable("rover")).to.equal(false);
  });

  it("the AX-1 phone heights are as before", () => {
    expect(O.PHONE_HEIGHT).to.deep.equal({ rover: 1.25, walker: 1.25, desk: 0.45 });
  });

  it("lookFromBox: a robot's shadow box, key-light target, ring and footprint come from its bounds, and it senses nothing", () => {
    const small = V.lookFromBox(new THREE.Box3(new THREE.Vector3(-0.1, 0, -0.08), new THREE.Vector3(0.1, 0.2, 0.08)), "Cyber Hound");
    expect(small.name).to.equal("Cyber Hound");
    expect(small.senses).to.equal(false);
    expect(small.shadow).to.equal(0.4); // never smaller than the AX-1 bodies' box
    expect(small.target).to.be.closeTo(0.09, 1e-9);
    expect(small.ring).to.be.at.least(1);
    expect(small.foot).to.deep.equal([[-0.1, -0.08], [0.1, -0.08], [0.1, 0.08], [-0.1, 0.08]]);
    const big = V.lookFromBox(new THREE.Box3(new THREE.Vector3(-0.23, 0, -0.18), new THREE.Vector3(0.18, 0.33, 0.17)), "Fab Rig");
    expect(big.shadow).to.be.within(0.4, 1);
    expect(big.shadow).to.be.greaterThan(small.shadow);
    expect(big.ring).to.be.greaterThan(small.ring);
    const huge = V.lookFromBox(new THREE.Box3(new THREE.Vector3(-5, 0, -5), new THREE.Vector3(5, 5, 5)), "x");
    expect(huge.shadow).to.equal(1);
    expect(huge.ring).to.equal(5);
    const flat = V.lookFromBox(new THREE.Box3(new THREE.Vector3(-0.05, 0.04, -0.05), new THREE.Vector3(0.05, 0.04, 0.05)), "flat");
    expect(flat.target).to.equal(0.05);
  });

  it("CAMERA_VIEW and the AX-1 bodies' looks are untouched", () => {
    expect(V.CAMERA_VIEW).to.deep.equal({ fov: 60, pos: [0, 1.25, 1.3], look: [0, 0.1, 0], radius: 1.5 });
  });
});
