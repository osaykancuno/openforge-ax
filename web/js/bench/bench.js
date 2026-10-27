// Workbench page: shelf of robots, stage list, captions, chips, big idea; the 3D plate (bench-view.js);
// Test stage missions (missions/*, deterministic) and the Build stage from robot-specs.js.
import { loadConfig, renderChrome } from "../chain.js";
import { ROBOTS, buildRobot } from "../models/robots.js";
import { ROBOT_SPECS, TO_VERIFY, formatBom, RESEARCH_DATE } from "../models/robot-specs.js";
import { ORDER, stagesFor, robotText } from "./content.js";
import { MISSIONS } from "./missions/index.js";
import { createMissionRunner, createProgressStore } from "./mission-runner.js";
import { KIND_ORDER, createSpeaker, el, overviewLabels as overviewOf, resetRig as resetRigOf, staticLabelList } from "./shared.js";

try {
  await loadConfig();
  renderChrome("bench");
} catch (e) {
  console.warn("site chrome unavailable", e);
}

const $ = (id) => document.getElementById(id);
let reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;

// ---------------------------------------------------------------- progress (shared with the Proving Grounds)
const store = createProgressStore();
const levelRec = store.rec;

// ---------------------------------------------------------------- 3D view (optional)
let view = null, viewMod = null, motionsMod = null, scenesMod = null;
try {
  viewMod = await import("./bench-view.js");
  if (viewMod.hasWebGL() && !new URLSearchParams(location.search).has("nogl")) {
    [motionsMod, scenesMod] = await Promise.all([import("./motions.js"), import("./test-scenes.js")]);
    view = viewMod.createBenchView($("plate"), $("labels"), { reduced });
  }
} catch (e) {
  console.warn("3D view unavailable", e);
  view = null;
}
document.body.classList.toggle("no-gl", !view);
$("noGL").hidden = !!view;
$("motionBtn").hidden = !view;

const speak = createSpeaker($("status"));

// ---------------------------------------------------------------- shelf
const shelf = $("shelf");
ORDER.forEach((id, i) => {
  const li = el("li");
  const a = el("a", "bn-tab");
  a.href = `#${id}`;
  a.dataset.id = id;
  const n = el("span", "bn-tab-n", String(i + 1).padStart(2, "0"));
  n.setAttribute("aria-hidden", "true");
  a.append(n, el("span", "bn-tab-name", ROBOTS[id].name));
  const done = MISSIONS[id].levels.filter((l) => levelRec(id, l.id)?.passed).length;
  const prog = el("span", "bn-tab-prog", done ? `${done}/3` : "");
  prog.dataset.prog = id;
  a.append(prog);
  li.append(a);
  shelf.append(li);
});
function refreshShelf() {
  shelf.querySelectorAll("a").forEach((a) => {
    const on = a.dataset.id === robotId;
    if (on) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
    const done = MISSIONS[a.dataset.id].levels.filter((l) => levelRec(a.dataset.id, l.id)?.passed).length;
    const p = a.querySelector(".bn-tab-prog");
    p.textContent = done ? `${done}/3` : "";
    p.title = done ? `${done} of 3 missions passed` : "";
  });
  shelf.querySelector('[aria-current="page"]')?.scrollIntoView?.({ block: "nearest", inline: "nearest", behavior: reduced ? "auto" : "smooth" });
}

// ---------------------------------------------------------------- state
let robotId = null, stages = [], stageIdx = 0, rig = null, prevChips = [];
let runner = null; // the Test stage's mission runner (mission-runner.js)
let enterToken = 0;

function parseHash() {
  const [id, st] = location.hash.replace(/^#/, "").split("/");
  return { id: ORDER.includes(id) ? id : ORDER[0], stage: st };
}

function selectRobot(id, stageId) {
  runner?.stop();
  const prev = robotId;
  robotId = id;
  const t = robotText(id);
  const spec = ROBOT_SPECS[id];
  stages = stagesFor(id);
  $("figNo").textContent = `FIG. ${String(ORDER.indexOf(id) + 1).padStart(2, "0")} · ${t.fig}`;
  $("figTitle").textContent = ROBOTS[id].name;
  const plat = $("platform");
  plat.replaceChildren(document.createTextNode(`${t.title}. Real-world platform: `));
  if (spec.upstream && spec.upstream !== TO_VERIFY) {
    const a = el("a", null, spec.platform);
    a.href = spec.upstream;
    a.rel = "noopener";
    a.target = "_blank";
    a.append(el("span", "sr-only", " (opens in a new tab)"));
    plat.append(a);
  } else plat.append(document.createTextNode(spec.platform));
  $("idea").textContent = t.bigIdea;
  document.title = `${ROBOTS[id].name} · Workbench · OpenForge Lab`;
  if (view) rig = view.setRobot(id);
  else rig = buildRobot(id); // labels still come from the model, as text
  prevChips = [];
  renderStageList();
  refreshShelf();
  const idx = Math.max(0, stages.findIndex((s) => s.id === stageId));
  goStage(idx, { first: true });
  if (prev) speak(`${ROBOTS[id].name}, stage ${idx + 1} of ${stages.length}: ${stages[idx].title}`);
}

function renderStageList() {
  const ol = $("stageList");
  ol.replaceChildren(
    ...stages.map((s, i) => {
      const li = el("li");
      const b = el("button", "bn-stage");
      b.type = "button";
      b.append(el("span", "bn-stage-n", String(i + 1)), el("span", "bn-stage-t", s.title));
      b.onclick = () => goStage(i);
      b.onkeydown = (e) => {
        const k = e.key;
        let to = null;
        if (k === "ArrowDown" || k === "ArrowRight") to = Math.min(stages.length - 1, i + 1);
        if (k === "ArrowUp" || k === "ArrowLeft") to = Math.max(0, i - 1);
        if (k === "Home") to = 0;
        if (k === "End") to = stages.length - 1;
        if (to != null) {
          e.preventDefault();
          goStage(to);
          ol.querySelectorAll("button")[to].focus();
        }
      };
      li.append(b);
      return li;
    })
  );
}

function renderChips(chips) {
  const ul = $("chips");
  const before = new Map(prevChips);
  ul.replaceChildren(
    ...chips.map(([k, v]) => {
      const li = el("li", "bn-chip");
      if (prevChips.length && before.get(k) !== v) li.classList.add("is-new");
      li.append(el("span", "bn-chip-k", k), el("span", "bn-chip-v", v));
      return li;
    })
  );
  prevChips = chips;
}

// ---------------------------------------------------------------- stages
const STAGE_VIEW = {
  assemble: { az: 35, el: 24, zoom: 1.1 },
  apart: { az: 42, el: 30, zoom: 1.75 },
  sensors: { az: 18, el: 20, zoom: 1.05 },
  brain: { az: -32, el: 28, zoom: 1.1 },
  build: { az: 30, el: 20, zoom: 1.1 },
};

function calloutLabels(kinds) {
  return rig.callouts.filter((c) => kinds.includes(c.kind)).map((c) => ({ node: c.node, text: c.label, kind: c.kind }));
}
/** Sensor callouts; robots whose sensing lives in the servos label the actuators with the content note. */
function sensorLabels() {
  const own = calloutLabels(["sensor"]);
  if (own.length) return own;
  const note = robotText(robotId).sensorNote || "servo feedback";
  return rig.callouts.filter((c) => c.kind === "actuator").slice(0, 1).map((c) => ({ node: c.node, text: note, kind: "sensor" }));
}
function partLabels() {
  return rig.parts.filter((p) => p.dir.lengthSq() > 0 || rig.parts.length < 4).map((p) => ({ node: p.node, text: p.label, kind: "part" }));
}
/** One callout of each kind (assemble overview). */
const overviewLabels = () => overviewOf(rig);

const resetRig = () => resetRigOf(view, rig, $("phoneFrame"));

async function goStage(i, { first = false } = {}) {
  runner?.stop();
  stageIdx = i;
  const s = stages[i];
  const token = ++enterToken;
  $("stageList").querySelectorAll("button").forEach((b, k) => {
    if (k === i) b.setAttribute("aria-current", "step"), matchMedia("(max-width: 760px)").matches && b.scrollIntoView?.({ block: "nearest", inline: "nearest" });
    else b.removeAttribute("aria-current");
  });
  $("caption").textContent = s.caption;
  renderChips(stageChips(s));
  const want = `#${robotId}${i ? `/${s.id}` : ""}`;
  if (location.hash !== want && !(i === 0 && location.hash === `#${robotId}`)) history.replaceState(null, "", want);
  renderPanel(s.id);
  if (!first) speak(`Stage ${i + 1} of ${stages.length}: ${s.title}`);
  if (!view) return renderStaticLabels(s.id);
  resetRig();
  view.setLabels([]);
  const camTo = (v) => view.moveCamera(view.view(v), first ? 0 : 900);
  const live = (fn) => {
    view.onTick = fn;
    view.setLive(!reduced);
    if (reduced) fn(0, view.time);
  };
  switch (s.id) {
    case "assemble": {
      rig.setExplode(reduced ? 0 : 1.4);
      camTo(STAGE_VIEW.assemble);
      await view.animate(1300, (k) => rig.setExplode(1.4 * (1 - k)));
      if (token !== enterToken) return;
      view.setLabels(overviewLabels());
      idleSpin();
      break;
    }
    case "apart": {
      camTo(STAGE_VIEW.apart);
      await view.animate(1100, (k) => rig.setExplode(k));
      if (token !== enterToken) return;
      view.setLabels(partLabels());
      break;
    }
    case "sensors":
      camTo(STAGE_VIEW.sensors);
      view.setLabels(sensorLabels());
      break;
    case "brain": {
      camTo(STAGE_VIEW.brain);
      await new Promise((r) => setTimeout(r, first || reduced ? 0 : 450));
      if (token !== enterToken) return;
      const pick = (k) => rig.callouts.find((c) => c.kind === k)?.node || (k === "sensor" ? rig.callouts.find((c) => c.kind === "actuator")?.node : null);
      const chain = [pick("sensor"), pick("brain"), pick("actuator")].filter((n, k, a) => n && a.indexOf(n) === k);
      view.showSignal(chain);
      const labels = calloutLabels(["brain"]);
      const sen = rig.callouts.find((c) => c.kind === "sensor"), act = rig.callouts.find((c) => c.kind === "actuator");
      if (sen) labels.unshift({ node: sen.node, text: `sense: ${sen.label}`, kind: "sensor" });
      else if (robotText(robotId).sensorNote && act) labels.unshift({ node: act.node, text: `sense: ${robotText(robotId).sensorNote}`, kind: "sensor" });
      if (act) labels.push({ node: act.node, text: `act: ${act.label}`, kind: "actuator" });
      view.setLabels(labels);
      live(() => {});
      break;
    }
    case "move": {
      const motion = motionsMod.MOTIONS[robotId]();
      const ctx = motion.setup(view, rig);
      camTo(motion.view);
      view.setLabels(ctx.labels);
      view.time = 0;
      live((dt, t) => motion.apply(ctx, reduced ? motion.keyT : t % motion.period));
      if (reduced) motion.apply(ctx, motion.keyT), view.invalidate();
      break;
    }
    case "test":
      // the panel's level picker builds the scene
      runner?.preview();
      break;
    case "build":
      camTo(STAGE_VIEW.build);
      view.setLabels(overviewLabels());
      idleSpin();
      break;
  }
}
function idleSpin() {
  if (reduced) return;
  const y0 = rig.group.rotation.y;
  view.onTick = (dt, t) => (rig.group.rotation.y = y0 + Math.sin(t * 0.35) * 0.35);
  view.setLive(true);
}
function stageChips(s) {
  const chips = s.chips.slice();
  const spec = ROBOT_SPECS[robotId];
  if (s.id === "build") {
    chips.push(["BOM", formatBom(spec.bomUSD)], ["DIFFICULTY", `${spec.difficulty} / 5`], ["LICENCE", spec.hardwareLicense.split(" (")[0]]);
  }
  if (s.id === "test") {
    const done = MISSIONS[robotId].levels.filter((l) => levelRec(robotId, l.id)?.passed).length;
    chips.push(["PASSED", `${done} / 3`]);
  }
  return chips;
}
function renderStaticLabels(stageId) {
  // no WebGL: the figure's labels as a plain list
  const pick = {
    assemble: overviewLabels,
    apart: partLabels,
    sensors: sensorLabels,
    brain: () => calloutLabels(["sensor", "brain", "actuator"]),
    move: () => [],
    test: () => [],
    build: overviewLabels,
  }[stageId];
  $("labels").replaceChildren(staticLabelList(pick()));
}

// ---------------------------------------------------------------- panel: Test and Build
function renderPanel(stageId) {
  runner?.destroy();
  runner = null;
  const panel = $("panel");
  const body = $("panelBody");
  document.querySelector(".bn-plate").classList.toggle("has-panel", stageId === "test" || stageId === "build");
  if (stageId === "test") {
    panel.hidden = false;
    $("panelTitle").textContent = "Lab missions";
    runner = createMissionRunner({
      robotId, view, scenes: scenesMod, getRig: () => rig, resetRig, isReduced: () => reduced, speak, phoneFrame: $("phoneFrame"), store, keyScope: $("figure"),
      onFinish: ({ demo }) => {
        if (demo) return;
        refreshShelf();
        renderChips(stageChips(stages[stageIdx]));
      },
    });
    body.replaceChildren(runner.element);
  } else if (stageId === "build") {
    panel.hidden = false;
    $("panelTitle").textContent = "Build the real one";
    body.replaceChildren(renderBuild());
  } else {
    panel.hidden = true;
    body.replaceChildren();
  }
}

function renderBuild() {
  const s = ROBOT_SPECS[robotId];
  const f = document.createDocumentFragment();
  const dl = el("dl", "bn-kv");
  const row = (k, v, node) => {
    dl.append(el("dt", null, k));
    const dd = el("dd");
    if (node) dd.append(node);
    else dd.textContent = v;
    if (v === TO_VERIFY) dd.classList.add("verify");
    dl.append(dd);
  };
  let up;
  if (s.upstream !== TO_VERIFY) {
    up = el("a", null, s.platform);
    up.href = s.upstream;
    up.rel = "noopener";
    up.target = "_blank";
    up.append(el("span", "sr-only", " (opens in a new tab)"));
  }
  row("Real-world platform", s.platform, up);
  if (s.upstreamNote) row("Guide", s.upstreamNote);
  row("Software licence", s.softwareLicense);
  row("Hardware licence", s.hardwareLicense);
  row("Use in CC0 OpenForge assets", s.cc0Compatible === "derive ok" ? "derive ok (keep the upstream notice; never relabel it CC0)" : s.cc0Compatible === "link only" ? "link only (we describe and link, we never copy)" : s.cc0Compatible);
  row("Bill of materials", Array.isArray(s.bomUSD) ? `${formatBom(s.bomUSD)} (without the phone)` : TO_VERIFY);
  row("Price note", s.bomNote);
  const diff = el("span", "bn-dots");
  diff.setAttribute("role", "img");
  diff.setAttribute("aria-label", `Build difficulty ${s.difficulty} of 5`);
  diff.textContent = "●".repeat(s.difficulty) + "○".repeat(5 - s.difficulty);
  row("Build difficulty (lab estimate)", null, diff);
  row("Build time (lab estimate)", Array.isArray(s.buildHours) ? `${s.buildHours[0]}–${s.buildHours[1]} hours` : TO_VERIFY);
  row("Actuators", s.actuators);
  row("Sensors", s.sensors);
  row("Brain", s.brain);
  f.append(dl);
  f.append(el("h3", null, "Parts"));
  const ul = el("ul", "bn-parts");
  s.parts.forEach((p) => ul.append(el("li", null, p)));
  f.append(ul);
  f.append(el("h3", null, "Your phone as the brain"));
  f.append(el("p", null, s.phoneBrain));
  if (s.alternatives?.length) {
    f.append(el("h3", null, "Also see"));
    const al = el("ul", "bn-parts");
    for (const a of s.alternatives) {
      const li = el("li");
      const link = el("a", null, a.name);
      link.href = a.url;
      link.rel = "noopener";
      link.target = "_blank";
      link.append(el("span", "sr-only", " (opens in a new tab)"));
      li.append(link);
      al.append(li);
    }
    f.append(al);
  }
  f.append(el("p", "bn-note", `Source: OpenForge research catalog (${RESEARCH_DATE}). List prices before shipping and tax; “to verify” means no source confirmed it yet. Not legal advice.`));
  return f;
}

// ---------------------------------------------------------------- motion toggle
const motionBtn = $("motionBtn");
function setMotion(on) {
  reduced = !on;
  motionBtn.setAttribute("aria-pressed", String(!on));
  view?.setReduced(reduced);
  if (stages[stageIdx] && !runner?.running) goStage(stageIdx, { first: true });
}
motionBtn.onclick = () => setMotion(reduced);
motionBtn.setAttribute("aria-pressed", String(reduced)); // label stays "Pause motion": pressed = paused

// ---------------------------------------------------------------- go
window.addEventListener("hashchange", () => {
  const h = parseHash();
  if (h.id !== robotId) selectRobot(h.id, h.stage);
  else {
    const i = stages.findIndex((s) => s.id === h.stage);
    if (i >= 0 && i !== stageIdx) goStage(i);
  }
});
const h0 = parseHash();
selectRobot(h0.id, h0.stage);
