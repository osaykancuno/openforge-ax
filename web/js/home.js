import { CONFIG } from "./config.js";
import { loadConfig, renderChrome, agents, isDeployed } from "./chain.js";
import { TRAITS, FACTIONS } from "./traits-data.js";

// The 3D lab's code (and three.js with it) starts downloading right now, in parallel with the config fetch and the
// page set-up below; nothing waits for it: the panels, FAQ, pause button and hash links work before the scene exists.
const reducedPref = matchMedia("(prefers-reduced-motion: reduce)").matches;
// 400% zoom, tiny or very short screens: a plain scrolling list instead of the 3D lab (WCAG reflow)
const listMode = matchMedia("(max-width: 340px), (max-height: 480px)").matches;
const glOk = (() => {
  try {
    return Boolean(document.createElement("canvas").getContext("webgl2"));
  } catch {
    return false;
  }
})();
const labModule = glOk && !listMode ? import("./lab/lab-view.js") : null;
labModule?.catch(() => {}); // the real handler is in startLab(); this only keeps a slow config fetch from reporting it as unhandled

await loadConfig();
renderChrome("home");
const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------- stations (what each one does lives here)
const STATIONS = [
  { id: "bench", title: "Workbench", line: "Take 11 robots apart, then test them", color: 0x4f7ea8, model: "bench", href: "bench.html" },
  { id: "pilot", title: "Phone Brain", line: "Your phone becomes AX-1's brain", color: 0xc8553d, model: "pilot", href: "pilot.html" },
  { id: "arena", title: "Proving Grounds", line: "Fly scored missions. Agent holders keep a record", color: 0x5f8a6e, model: "arena", href: "arena.html" },
  { id: "robot", title: "Robot Link", line: "Replay a run on a real SO-101", color: 0xe2b04a, model: "robot", href: "robot.html" },
  { id: "codex", title: "The Codex", line: "Start here: a 3D book in 8 pages", color: 0x5f8a6e, model: "codex", href: "codex.html" },
  { id: "gallery", title: "Gallery", line: "All 1,024 agents, read from Ethereum", color: 0x8a6a9e, model: "gallery", href: "gallery.html" },
  { id: "agents", title: "My agents", line: "Your agents: wallet, settings, record", color: 0x4f7ea8, model: "agents", href: "agents.html" },
  { id: "mint", title: "Mint", line: "On OpenSea · 1,024 agents", color: 0xe2b04a, model: "mint", href: CONFIG.openseaDropUrl, external: true },
  { id: "lore", title: "Collection", line: "Classes, traits and rarity", color: 0x8a6a9e, model: "lore", panel: "lore" },
];
const PANEL_TITLES = { guide: "Guide & FAQ", lore: "What an agent (NFT) is" };

let view = null; // the 3D lab, once started
let navigating = false;
let opener = null; // where focus goes back when the panel closes

// labels are real links (pages) or buttons (panels): keyboard, screen readers and the list/no-WebGL layouts all use
// them; a link also opens in a new tab, can be copied, and works before this script has loaded the 3D lab
const nav = $("stations");
for (const s of STATIONS) {
  const b = document.createElement(s.panel ? "button" : "a");
  if (s.panel) b.type = "button";
  else {
    b.href = s.href;
    if (s.external) (b.target = "_blank"), (b.rel = "noopener");
  }
  b.className = "lab-label";
  b.dataset.id = s.id;
  b.style.setProperty("--c", "#" + s.color.toString(16).padStart(6, "0"));
  b.innerHTML = `<i></i><b></b><span></span>`;
  b.querySelector("i").textContent = `FIG. ${String(STATIONS.indexOf(s) + 1).padStart(2, "0")}`;
  b.querySelector("i").setAttribute("aria-hidden", "true");
  b.querySelector("b").textContent = s.title + (s.external ? " ↗" : "");
  const desc = b.querySelector("span");
  desc.id = `st-${s.id}-desc`;
  desc.textContent = s.line;
  b.setAttribute("aria-label", s.title + (s.external ? " (opens OpenSea in a new tab)" : ""));
  b.setAttribute("aria-describedby", desc.id);
  if (s.panel) b.setAttribute("aria-haspopup", "dialog"), b.setAttribute("aria-controls", "panel"), b.setAttribute("aria-expanded", "false");
  b.addEventListener("mouseenter", () => view?.hover(s.id));
  b.addEventListener("mouseleave", () => view?.hover(null));
  b.addEventListener("click", (e) => {
    if (s.external) return; // the browser opens OpenSea in a new tab
    // a plain click flies into the station; Ctrl/Cmd/Shift/middle click keep the browser's own behaviour
    if (!s.panel && (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey)) return;
    e.preventDefault();
    select(s.id, b);
  });
  nav.append(b);
}
const label = (id) => nav.querySelector(`[data-id="${id}"]`);
const labels = [...nav.querySelectorAll(".lab-label")];
let halfWidths = new Map(); // measured on resize, not per frame
const measure = () => (halfWidths = new Map(labels.map((b) => [b.dataset.id, b.offsetWidth / 2])));
new ResizeObserver(measure).observe(nav);
measure();

// ---------------------------------------------------------------- 3D lab (falls back to the list of stations)
// startLab() runs at the end of this file, once every handler below is attached.
async function startLab() {
  if (labModule) {
    try {
      const { createLabView } = await labModule;
      const small = matchMedia("(max-width: 760px)").matches;
      view = createLabView($("lab"), STATIONS, {
        maxFps: small ? 30 : 0, // phones: half the frames is plenty for a slow turntable, and cooler
        adaptiveDpr: true, // a slow first second drops to pixel ratio 1
        onHover: (id) => labels.forEach((b) => b.classList.toggle("hot", b.dataset.id === id)),
        onSelect: (id) => select(id),
        // the HUD's footprint: the lab is framed in the space it leaves free
        safeArea: () => {
          const r = document.querySelector(".lab-hud").getBoundingClientRect();
          return { left: r.right, top: r.bottom };
        },
        onFrame: (pts) => {
          const W = innerWidth;
          for (const p of pts) {
            const b = label(p.id);
            const half = halfWidths.get(p.id) || 60;
            const x = Math.round(Math.max(half + 6, Math.min(W - half - 6, p.x))); // labels never leave the screen
            const y = Math.round(p.y);
            if (b._x !== x || b._y !== y) (b.style.transform = `translate(${x}px, ${y}px) translate(-50%, -100%)`), (b._x = x), (b._y = y);
            const v = p.visible ? "" : "hidden";
            if (b.style.visibility !== v) b.style.visibility = v;
          }
        },
      });
    } catch (e) {
      console.error(e);
      view = null;
    }
  }
  document.body.classList.toggle("no-gl", !view);
  document.body.classList.toggle("lab-list", listMode || !view); // no 3D lab: the scrolling list never overlaps the HUD
  pauseBtn.hidden = !view;
  applyMotion();
  // a panel opened from the URL before the scene existed: fly to its station now
  const station = open && STATIONS.find((s) => s.panel === open);
  if (view && station) view.focus(station.id);
}

// ---------------------------------------------------------------- motion: a visible pause (WCAG 2.2.2), default from the OS setting
const pauseBtn = $("pauseBtn");
let paused = reducedPref;
const applyMotion = () => {
  view?.setMotion(!paused);
  pauseBtn.setAttribute("aria-pressed", String(paused));
  pauseBtn.querySelector("[aria-hidden]").textContent = paused ? "▶" : "❚❚"; // constant label, state in aria-pressed
  document.body.classList.toggle("still", paused);
};
pauseBtn.hidden = !view;
pauseBtn.onclick = () => ((paused = !paused), applyMotion());
applyMotion();

// ---------------------------------------------------------------- navigation inside the one-screen app
const status = (text) => ($("labStatus").textContent = text);
function select(id, from = label(id)) {
  const s = STATIONS.find((x) => x.id === id);
  if (!s || navigating) return;
  if (s.panel) return openPanel(s.panel, from);
  if (s.external) return window.open(s.href, "_blank", "noopener");
  navigating = true;
  status(`Opening ${s.title}…`);
  view?.focus(id);
  $("fade").classList.add("on"); // fly in, then fade into the page
  setTimeout(() => (location.href = s.href), view && !paused ? 650 : 0);
}
let open = null;
function openPanel(name, from = document.activeElement) {
  const station = STATIONS.find((s) => s.panel === name); // the guide panel has no station: it opens from the nav FAQ / "Guide" button
  open = name;
  opener = from instanceof HTMLElement && from !== document.body ? from : station ? label(station.id) : label("codex");
  if (station) view?.focus(station.id);
  $("panelTitle").textContent = PANEL_TITLES[name];
  document.querySelectorAll("[data-panel]").forEach((p) => (p.hidden = p.dataset.panel !== name));
  labels.forEach((b) => b.hasAttribute("aria-expanded") && b.setAttribute("aria-expanded", String(b.dataset.id === station?.id)));
  document.querySelectorAll("[data-open]").forEach((b) => b.setAttribute("aria-expanded", String(b.dataset.open === name)));
  $("panel").hidden = false;
  $("backBtn").hidden = false;
  document.querySelector(".lab-hud").inert = true; // dimmed behind the panel: not reachable either
  $("stations").inert = true; // nor the station labels under it (focus must not land behind the panel)
  document.body.classList.add("panel-open");
  $("panelBody").scrollTop = 0;
  $("panelClose").focus();
  if (location.hash !== `#${name}` && !(name === "guide" && location.hash === "#faq")) history.replaceState(null, "", `#${name}`);
}
function closePanel() {
  if (!open) return;
  open = null;
  $("panel").hidden = true;
  $("backBtn").hidden = true;
  document.querySelector(".lab-hud").inert = false;
  $("stations").inert = false;
  document.body.classList.remove("panel-open");
  labels.forEach((b) => b.hasAttribute("aria-expanded") && b.setAttribute("aria-expanded", "false"));
  document.querySelectorAll("[data-open]").forEach((b) => b.setAttribute("aria-expanded", "false"));
  view?.reset();
  history.replaceState(null, "", location.pathname + location.search);
  (opener?.isConnected ? opener : label("codex"))?.focus();
}
$("panelClose").onclick = closePanel;
$("backBtn").onclick = closePanel;
document.querySelectorAll("[data-open]").forEach((b) => (b.onclick = () => openPanel(b.dataset.open, b)));
addEventListener("keydown", (e) => {
  if (e.key !== "Escape" || !open) return;
  if (document.querySelector("dialog[open]")) return; // the servers dialog handles its own Esc
  closePanel();
});
// deep links: index.html#guide, #lore, and the nav's #faq; an empty hash (Back) closes the panel
const fromHash = () => {
  const h = location.hash.slice(1);
  if (h === "faq") openPanel("guide"), requestAnimationFrame(() => $("faq").scrollIntoView({ block: "start" }));
  else if (PANEL_TITLES[h]) openPanel(h);
  else if (open) closePanel();
};
addEventListener("hashchange", fromHash);
fromHash();
// coming back with the browser's Back button restores a clean, running lab
addEventListener("pageshow", () => {
  navigating = false;
  $("fade").classList.remove("on");
  status("");
  view?.resume();
});

// ---------------------------------------------------------------- panel content (from the generated trait data)
$("traitTables").innerHTML = Object.entries(TRAITS)
  .map(([cat, rows]) => `<div class="card"><h4>${cat}</h4><table class="trait-table">${rows.map(([n, pct]) => `<tr><td>${n}</td><td>${pct}</td></tr>`).join("")}</table></div>`)
  .join("");
$("factions").innerHTML = FACTIONS.map(([n, lore, pct]) => `<div class="card"><span class="tag" style="color:var(--accent-ink)">${pct}</span><h4>${n}</h4><p class="muted">${lore}</p></div>`).join("");

// ---------------------------------------------------------------- live stats
async function refresh() {
  if (!isDeployed()) {
    $("sState").textContent = "Soon";
    $("sState").title = "The mint opens on OpenSea";
    return;
  }
  try {
    const c = await agents(); // the first call loads ethers (only when a deployment exists)
    const [minted, cap, seed, rb] = await Promise.all([c.totalSupply(), c.MAX_SUPPLY_CAP(), c.seed(), c.revealBlock()]);
    $("sMinted").textContent = Number(minted).toLocaleString("en-US");
    $("sSupply").textContent = Number(cap).toLocaleString("en-US");
    $("sBar").style.width = `${(Number(minted) / Number(cap)) * 100}%`;
    const revealed = seed !== "0x" + "0".repeat(64);
    $("sState").textContent = revealed ? "Revealed" : rb > 0n ? "Revealing" : "Mint open";
    if (revealed) {
      $("sLegend").textContent = Math.min(10, Math.floor(Number(minted) / 50)); // one per 50 minted, capped at 10
      $("sLegendLabel").textContent = "Prime Constructs (1/1)";
    }
  } catch {
    $("sState").textContent = "Can't reach Ethereum"; // expected now and then: calm text, the next poll tries again
  }
}
startLab(); // every handler is attached: now build the scene
refresh();
setInterval(() => !document.hidden && refresh(), 30000);
