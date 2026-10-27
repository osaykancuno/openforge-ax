// The Codex page: chapter text and controls (HTML), the book and dioramas (codex/codex-view.js).
import { loadConfig, renderChrome } from "./chain.js";
import { CHAPTERS } from "./codex/chapters.js";

/** CSS matrix3d that maps a w x h box onto a screen quad [top-left, top-right, bottom-left, bottom-right] (a homography). */
function onto(w, h, [p0, p1, p3, p2]) {
  const dx1 = p1.x - p2.x, dx2 = p3.x - p2.x, dy1 = p1.y - p2.y, dy2 = p3.y - p2.y;
  const sx = p0.x - p1.x + p2.x - p3.x, sy = p0.y - p1.y + p2.y - p3.y;
  let g = 0, k = 0;
  if (Math.abs(sx) > 1e-9 || Math.abs(sy) > 1e-9) {
    const det = dx1 * dy2 - dx2 * dy1;
    g = (sx * dy2 - dx2 * sy) / det;
    k = (dx1 * sy - sx * dy1) / det;
  }
  const a = p1.x - p0.x + g * p1.x, b = p3.x - p0.x + k * p3.x, d = p1.y - p0.y + g * p1.y, e = p3.y - p0.y + k * p3.y;
  return `matrix3d(${a / w},${d / w},0,${g / w},${b / h},${e / h},0,${k / h},0,0,1,0,${p0.x},${p0.y},0,1)`;
}

await loadConfig();
renderChrome("codex");
const $ = (id) => document.getElementById(id);

const page = $("page");
const phoneQuery = matchMedia("(max-width: 760px)");
// 400% zoom, tiny or very short screens: a plain readable page instead of the 3D book (WCAG reflow)
const listMode = matchMedia("(max-width: 340px), (max-height: 480px)").matches;
let view = null, dio = null, index = -1, busy = false, pending = null;
let paused = matchMedia("(prefers-reduced-motion: reduce)").matches;

// chapter index (real buttons, 24px targets) + a "3 / 8" readout
CHAPTERS.forEach((c, i) => {
  const b = document.createElement("button");
  b.className = "codex-dot";
  b.setAttribute("aria-label", `Page ${i + 1}: ${c.title}`);
  b.onclick = () => go(i);
  $("dots").append(b);
});
const dots = [...$("dots").children];
// clear, then write a moment later: repeated messages are announced again (a timer, not rAF, which may be throttled)
const speak = (id) => (text) => {
  $(id).textContent = "";
  setTimeout(() => ($(id).textContent = text), 60);
};
const announce = speak("pageStatus");
const setStatus = speak("chStatus");

/** Printed on the book: the text shrinks until the chapter and its buttons fit the page (no scrollbar on paper); when
 *  that leaves it small on screen, the magnifier (below) reads it. */
function fitPage() {
  const el = $("page");
  el.style.setProperty("--fit", "1");
  if (!el.classList.contains("on-paper")) return lens.update();
  for (let f = 1; f > 0.5 && el.scrollHeight > el.clientHeight + 1; ) el.style.setProperty("--fit", String((f -= 0.03).toFixed(2)));
  lens.update();
}

// ---------------------------------------------------------------- magnifier: a reading lens for small printed text
// With a mouse, over the page, the cursor becomes a round lens that shows the page twice as large. It is a live copy of
// the page drawn above it (clicks go straight through to the real buttons under the cursor). Off for touch, keyboard
// and phones (their text is a plain sheet), and whenever the text is large enough to read without it.
const lens = (() => {
  const R = 120, Z = 2; // lens radius (px) and zoom
  const box = document.createElement("div");
  box.className = "codex-lens";
  box.setAttribute("aria-hidden", "true");
  box.hidden = true;
  const inner = document.createElement("div");
  inner.className = "codex-lens-inner";
  box.append(inner);
  document.body.append(box);
  const finePointer = matchMedia("(hover: hover) and (pointer: fine)");
  let on = false, copy = null, x = 0, y = 0;
  const needed = () => {
    const el = $("page");
    if (!finePointer.matches || !el.classList.contains("on-paper")) return false;
    // the body text's size on screen: its CSS size × the fit × how much the page is scaled down on screen
    const r = el.getBoundingClientRect();
    const fit = Number(getComputedStyle(el).getPropertyValue("--fit")) || 1;
    return 14.5 * fit * (r.width / el.offsetWidth) < 14;
  };
  const refresh = () => {
    if (!on) return;
    copy = $("page").cloneNode(true);
    copy.removeAttribute("id");
    copy.querySelectorAll("[id]").forEach((n) => n.removeAttribute("id"));
    copy.classList.remove("turning");
    inner.replaceChildren(copy);
  };
  const place = () => {
    box.style.transform = `translate(${x - R}px, ${y - R}px)`;
    inner.style.transform = `translate(${R - Z * x}px, ${R - Z * y}px) scale(${Z})`;
  };
  const page = $("page");
  page.addEventListener("pointermove", (e) => {
    if (!on || e.pointerType !== "mouse") return;
    (x = e.clientX), (y = e.clientY);
    box.hidden = page.classList.contains("turning");
    place();
  });
  page.addEventListener("pointerleave", () => (box.hidden = true));
  new MutationObserver(() => refresh()).observe(page, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ["aria-disabled", "hidden"] });
  return {
    update() {
      on = needed();
      document.body.classList.toggle("codex-lensing", on);
      if (!on) return void (box.hidden = true);
      refresh();
    },
  };
})();

function render(i) {
  const c = CHAPTERS[i];
  $("chKicker").textContent = `FIG. ${c.number} · ${c.kicker}`;
  $("chTitle").textContent = c.title;
  $("chBody").innerHTML = c.body; // authored static text (chapters.js)
  $("chStatus").textContent = "";
  $("chActions").replaceChildren(
    ...c.actions.map((a) => {
      const b = document.createElement("button");
      b.className = "btn sm";
      b.textContent = a.label;
      b.onclick = () => act(a.id, b);
      return b;
    })
  );
  $("chEnd").hidden = i !== CHAPTERS.length - 1;
  dots.forEach((d, k) => (k === i ? d.setAttribute("aria-current", "page") : d.removeAttribute("aria-current")));
  $("pageCount").textContent = `${i + 1} / ${CHAPTERS.length}`;
  $("prevBtn").setAttribute("aria-disabled", String(i === 0));
  $("nextBtn").setAttribute("aria-disabled", String(i === CHAPTERS.length - 1));
  document.title = `${c.number} · ${c.title} — The Codex — OpenForge AX`;
  if (location.hash !== `#${i + 1}`) history.replaceState(null, "", `#${i + 1}`);
  fitPage();
}

const setActionsBusy = (on) => $("chActions").querySelectorAll("button").forEach((b) => b.setAttribute("aria-disabled", String(on)));

async function go(i, { first = false } = {}) {
  if (i < 0 || i >= CHAPTERS.length || (!first && i === index)) return;
  if (busy) return void (pending = i); // run after the current turn instead of dropping it
  busy = true;
  const direction = i >= index ? 1 : -1;
  let next = null;
  try {
    next = view ? CHAPTERS[i].build(view) : null; // build first: a failure leaves the current page intact
    // the printed text leaves with the old page and comes back when the new leaf has landed (view.show's onLanded)
    if (view && !first && page.classList.contains("on-paper")) {
      page.classList.add("turning");
      await new Promise((r) => setTimeout(r, view.reduced ? 0 : 180));
    }
    index = i;
    render(i);
    if (!first) {
      $("chTitle").focus({ preventScroll: true });
      announce(`Page ${i + 1} of ${CHAPTERS.length}: ${CHAPTERS[i].title}`);
    }
    setActionsBusy(true); // usable once the diorama has popped up
    if (view) {
      dio = next;
      await view.show(CHAPTERS[i], dio, { direction, first, onLanded: () => page.classList.remove("turning") });
    }
  } finally {
    page.classList.remove("turning");
    setActionsBusy(false);
    busy = false;
    if (pending !== null) {
      const p = pending;
      pending = null;
      go(p);
    }
  }
}

async function act(id, button) {
  if (!dio || busy) return;
  busy = true;
  setActionsBusy(true);
  try {
    const msg = await dio.act(id);
    if (msg) setStatus(msg);
  } finally {
    busy = false;
    setActionsBusy(false);
    button?.focus({ preventScroll: true });
  }
}

const guard = (fn) => (e) => e.currentTarget.getAttribute("aria-disabled") !== "true" && fn();
$("prevBtn").onclick = guard(() => go(index - 1));
$("nextBtn").onclick = guard(() => go(index + 1));
addEventListener("keydown", (e) => {
  if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return; // Alt+← is the browser's Back
  if (e.target.closest?.("input, textarea, select, dialog, [contenteditable]")) return;
  if (e.key === "ArrowRight") go(index + 1);
  if (e.key === "ArrowLeft") go(index - 1);
});
addEventListener("hashchange", () => {
  const n = Number(location.hash.slice(1)) - 1;
  if (Number.isInteger(n)) go(n);
});

// ---------------------------------------------------------------- the 3D book (a plain page without WebGL or at high zoom)
const glOk = (() => {
  try {
    const gl = document.createElement("canvas").getContext("webgl2");
    gl?.getExtension("WEBGL_lose_context")?.loseContext(); // only a probe: release it
    return Boolean(gl);
  } catch {
    return false;
  }
})();
if (glOk && !listMode) {
  try {
    const { createCodexView } = await import("./codex/codex-view.js");
    view = createCodexView($("codexCanvas"), {
      onPick: (a) => act(a),
      // the text sits on the left page (wide screens) or in a bottom sheet (phones, where the camera shows the diorama)
      onLayout: (r) => {
        if (phoneQuery.matches) {
          page.classList.add("sheet");
          page.classList.remove("on-paper"); // phones: a bottom sheet, the book is too small to print on
          page.style.cssText = "";
          return;
        }
        page.classList.remove("sheet");
        // printed on the left page: a flat box the size of the page, mapped onto its corners in perspective
        const [tl, tr, bl, br] = r.quad;
        const w = Math.max(tr.x - tl.x, br.x - bl.x), h = Math.max(bl.y - tl.y, br.y - tr.y);
        page.classList.add("on-paper");
        Object.assign(page.style, { left: "0px", top: "0px", width: `${w}px`, height: `${h}px`, maxHeight: "none", transformOrigin: "0 0", transform: onto(w, h, r.quad) });
        fitPage();
      },
    });
    phoneQuery.addEventListener("change", (e) => view.setFocusRight(e.matches)); // rotation / resize across 760px
  } catch (e) {
    console.error(e);
  }
}
document.body.classList.toggle("no-gl", !view);

// motion: one constant label, the state is aria-pressed (WCAG 2.2.2); default from the OS setting
const pauseBtn = $("pauseBtn");
const applyMotion = () => {
  view?.setMotion(!paused);
  pauseBtn.setAttribute("aria-pressed", String(paused));
  pauseBtn.querySelector("[aria-hidden]").textContent = paused ? "▶" : "❚❚";
};
pauseBtn.hidden = !view;
pauseBtn.onclick = () => ((paused = !paused), applyMotion());
matchMedia("(prefers-reduced-motion: reduce)").addEventListener("change", (e) => ((paused = e.matches), applyMotion()));
applyMotion();
addEventListener("pageshow", () => view?.resume());

const start = Math.min(CHAPTERS.length, Math.max(1, Number(location.hash.slice(1)) || 1)) - 1;
go(start, { first: true });
