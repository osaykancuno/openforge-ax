import { loadConfig, renderChrome, agents, isDeployed } from "./chain.js";
import { TRAITS, FACTIONS } from "./traits-data.js";

// The 3D lab's code (and three.js with it) starts downloading right now, in parallel with the config fetch and the
// page set-up below; nothing waits for it: the panels, FAQ, pause button and hash links work before the scene exists.
const reducedPref = matchMedia("(prefers-reduced-motion: reduce)").matches;
// 400% zoom, tiny or very short screens: a plain scrolling list instead of the 3D lab (WCAG reflow)
const reflow = () => matchMedia("(max-width: 340px), (max-height: 480px)").matches;
// phones with large text: when the HUD leaves the ring less room than this, the list is clearer than a crowded ring
const RING_MIN = 200;
const tooTight = () => {
  if (innerWidth > 760) return false;
  // the HUD is measured as it sits over the ring (64 px from the top); the hint, pause and footer take 96 px below
  const list = document.body.classList.contains("lab-list");
  if (list) document.body.classList.remove("lab-list");
  const h = document.querySelector(".lab-hud").offsetHeight;
  if (list) document.body.classList.add("lab-list");
  return innerHeight - (64 + h) - 96 < RING_MIN;
};
let listMode = reflow() || tooTight();
const glOk = (() => {
  try {
    return Boolean(document.createElement("canvas").getContext("webgl2"));
  } catch {
    return false;
  }
})();
let labModule = glOk && !listMode ? import("./lab/lab-view.js") : null;
labModule?.catch(() => {}); // the real handler is in startLab(); this only keeps a slow config fetch from reporting it as unhandled

await loadConfig();
renderChrome("home");
const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------- stations (what each one does lives here)
const STATIONS = [
  { id: "bench", title: "Workbench", line: "Take 11 robots apart, then test them", color: 0x4f7ea8, model: "bench", href: "bench.html" },
  { id: "pilot", title: "Phone Brain", line: "Your phone becomes AX-1's brain", color: 0xc8553d, model: "pilot", href: "pilot.html" },
  { id: "ar", title: "In your room", line: "AX-1's twin on your floor, in AR on a phone", color: 0xe2b04a, model: "ar", href: "ar.html" },
  { id: "arena", title: "Proving Grounds", line: "Fly scored missions. Agent holders keep a record", color: 0x5f8a6e, model: "arena", href: "arena.html" },
  { id: "robot", title: "Robot Link", line: "Replay a run on a real SO-101", color: 0xe2b04a, model: "robot", href: "robot.html" },
  { id: "codex", title: "The Codex", line: "Start here: a 3D book in 8 pages", color: 0x5f8a6e, model: "codex", href: "codex.html" },
  { id: "gallery", title: "Gallery", line: "All 1,024 agents, read from Ethereum", color: 0x8a6a9e, model: "gallery", href: "gallery.html" },
  { id: "agents", title: "My agents", line: "Your agents: wallet, settings, record", color: 0x4f7ea8, model: "agents", href: "agents.html" },
  { id: "market", title: "Market", line: "Floor, sales, holders and rarity", color: 0xe2b04a, model: "mint", href: "market.html" },
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
const labels = [...nav.querySelectorAll(".lab-label")];
const byId = new Map(labels.map((b) => [b.dataset.id, b])); // no selector query per label per frame
const label = (id) => byId.get(id);
const hudEl = document.querySelector(".lab-hud");
// One slot per label, reused every frame: nothing is allocated while the ring turns.
const slots = labels.map((b) => ({ b, id: b.dataset.id, half: 60, x: 0, y: 0, visible: true }));
const slotById = new Map(slots.map((sl) => [sl.id, sl]));
let labelH = 30;
let hudBox = null; // wide screens: the title block on the left, which labels never slide under
// All the layout reads happen together, and in a ResizeObserver callback (layout is already clean there): reading a
// width right after the DOM writes above forced a ~160 ms reflow of the whole page.
const measure = () => {
  for (const sl of slots) sl.half = sl.b.offsetWidth / 2;
  labelH = labels[0]?.offsetHeight || 30;
  hudBox = innerWidth > 760 ? hudEl.getBoundingClientRect() : null;
};
const measurer = new ResizeObserver(measure); // fires once on observe(), after the first layout, then on every size change
measurer.observe(nav);
measurer.observe(hudEl);

// ---------------------------------------------------------------- 3D lab (falls back to the list of stations)
// startLab() runs at the end of this file, once every handler below is attached.
async function startLab() {
  // web fonts change the HUD's height: measure again once they are in (never wait long for them)
  await Promise.race([document.fonts?.ready, new Promise((r) => setTimeout(r, 400))]);
  listMode = reflow() || tooTight();
  if (!listMode && glOk) labModule ??= import("./lab/lab-view.js");
  if (labModule && !listMode && !view) {
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
          const r = hudEl.getBoundingClientRect();
          return { left: r.right, top: r.bottom };
        },
        onFrame: (pts) => {
          const W = innerWidth;
          const placed = slots;
          for (let i = 0; i < pts.length; i++) {
            const p = pts[i], sl = slotById.get(p.id);
            if (!sl) continue;
            sl.p = p;
            let x = Math.max(sl.half + 6, Math.min(W - sl.half - 6, p.x)); // labels never leave the screen
            if (hudBox && p.y > hudBox.top && p.y - labelH < hudBox.bottom) x = Math.max(x, hudBox.right + sl.half + 6); // nor go under the title
            sl.x = x;
            sl.y = p.y;
          }
          // small screens crowd the ring: labels that would overlap are pushed apart vertically, a few cheap passes
          const gap = labelH + 4;
          for (let pass = 0; pass < 4; pass++) {
            for (let i = 0; i < placed.length; i++) {
              for (let j = i + 1; j < placed.length; j++) {
                const a = placed[i], c = placed[j];
                if (!a.p || !c.p || !a.p.visible || !c.p.visible || Math.abs(a.x - c.x) >= a.half + c.half + 4) continue;
                const dy = c.y - a.y, push = (gap - Math.abs(dy)) / 2;
                if (push <= 0) continue;
                const s = dy < 0 ? -1 : 1;
                (a.y -= s * push), (c.y += s * push);
              }
            }
          }
          for (const sl of placed) {
            const p = sl.p, b = sl.b;
            if (!p) continue;
            const x = Math.round(sl.x);
            const y = Math.round(sl.y);
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
  pauseBtn.hidden = !view || listMode;
  applyMotion();
  // a panel opened from the URL before the scene existed: fly to its station now
  const station = open && STATIONS.find((s) => s.panel === open);
  if (view && station) (view.focus(station.id), panelCovers() && view.pause());
}

// ---------------------------------------------------------------- motion: a visible pause (WCAG 2.2.2), default from the OS setting
const pauseBtn = $("pauseBtn");
let paused = reducedPref;
const applyMotion = () => {
  view?.setMotion(!paused && !listMode);
  pauseBtn.setAttribute("aria-pressed", String(paused));
  pauseBtn.querySelector("[aria-hidden]").textContent = paused ? "▶" : "❚❚"; // constant label, state in aria-pressed
  document.body.classList.toggle("still", paused);
};
pauseBtn.hidden = !view;
pauseBtn.onclick = () => ((paused = !paused), applyMotion());
applyMotion();
// turning the phone (or resizing the window) can switch between the ring and the list; a height-only change is the
// mobile address bar sliding while the list scrolls, and must not flip the layout under the reader's finger
let lastW = innerWidth, lastH = innerHeight;
addEventListener("resize", () => {
  const dw = innerWidth - lastW, dh = innerHeight - lastH;
  if (!dw && Math.abs(dh) < 150) return;
  (lastW = innerWidth), (lastH = innerHeight);
  const next = reflow() || tooTight();
  if (next === listMode) return;
  listMode = next;
  if (!listMode && !view && glOk) {
    labModule ??= import("./lab/lab-view.js");
    return startLab();
  }
  document.body.classList.toggle("lab-list", listMode || !view);
  pauseBtn.hidden = !view || listMode;
  applyMotion();
});

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
// on a narrow screen the panel covers the whole canvas: nothing to draw, so the render loop stops until it closes
const panelCovers = () => open && innerWidth <= 560;
addEventListener("resize", () => open && (panelCovers() ? view?.pause() : view?.resume())); // a rotation across 560 px with the panel open
function openPanel(name, from = document.activeElement) {
  const station = STATIONS.find((s) => s.panel === name); // the guide panel has no station: it opens from the nav FAQ / "Guide" button
  open = name;
  opener = from instanceof HTMLElement && from !== document.body ? from : station ? label(station.id) : label("codex");
  if (station) view?.focus(station.id);
  if (panelCovers()) view?.pause();
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
  view?.resume();
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
// coming back with the browser's Back button restores a clean, running lab: the page comes back from the
// back/forward cache exactly as it left, camera still flown into the station, so put the whole ring back in view
addEventListener("pageshow", () => {
  navigating = false;
  $("fade").classList.remove("on");
  status("");
  view?.hover(null); // a tap on a phone sends mouseenter but never mouseleave: drop the lifted station
  if (!open) view?.reset(0);
  if (!panelCovers()) view?.resume();
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
// the stats are not what the page is for: the first read waits for an idle moment (the scene builds first), then once a minute
(window.requestIdleCallback ? requestIdleCallback(refresh, { timeout: 3000 }) : setTimeout(refresh, 1500));
setInterval(() => !document.hidden && refresh(), 60000);
