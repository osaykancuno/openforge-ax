// DOM helpers for the Phone Brain: capability list, sliders, hold-to-drive joystick and D-pad, chips.
// Every text that could come from outside (device names, messages) goes through textContent, never innerHTML.

export const $ = (id) => document.getElementById(id);

export function el(tag, props = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") e.className = v;
    else if (k === "text") e.textContent = v;
    else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null && v !== false) e.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of children) if (c !== null && c !== undefined) e.append(typeof c === "string" ? document.createTextNode(c) : c);
  return e;
}

/** Sets a chip's text and tone (ok | warn | live | bad | neutral). */
export function chip(node, text, tone = "") {
  node.textContent = text;
  if (tone) node.dataset.tone = tone;
  else delete node.dataset.tone;
}

/** Capability rows: [{ ok, title, why }]. */
export function renderCaps(list, rows) {
  list.replaceChildren(
    ...rows.map((r) =>
      el("li", { class: r.ok ? "yes" : "no" }, el("span", { class: "mark", "aria-hidden": "true", text: r.ok ? "✓" : "–" }), el("div", {}, el("b", { text: `${r.title}${r.ok ? "" : " · not available"}` }), el("span", { class: "why", text: r.why }))),
    ),
  );
}

/** Labelled range slider in degrees. Returns { input, set(v) }. */
export function slider(parent, { label, min, max, value = 0, step = 1, unit = "°", onInput }) {
  const id = `s-${Math.random().toString(36).slice(2, 8)}`;
  const spoken = (v) => `${v} ${unit === "°" ? "degrees" : unit === "%" ? "percent" : unit}`;
  const input = el("input", { type: "range", id, min, max, step, value, "aria-valuetext": spoken(value) });
  // not a live region: the slider itself announces its value, and syncSliders() moves it at frame rate
  const out = el("output", { for: id, role: "none", "aria-live": "off", text: `${value}${unit}` });
  input.addEventListener("input", () => {
    out.textContent = `${input.value}${unit}`;
    input.setAttribute("aria-valuetext", spoken(input.value));
    onInput(Number(input.value));
  });
  parent.append(el("div", { class: "pl-slider" }, el("label", { for: id }, el("span", { text: label })), input, out));
  return {
    input,
    set(v) {
      input.value = String(v);
      out.textContent = `${Math.round(v)}${unit}`;
      input.setAttribute("aria-valuetext", spoken(Math.round(v)));
    },
  };
}

/**
 * Hold-to-drive joystick. Pointer down = dead-man pressed; the knob follows the finger; release, cancel or a lost
 * capture = released (zero). handlers: onHold(bool), onMove(x, y) with x right, y forward, both -1..1.
 */
export function joystick(pad, knob, { onHold, onMove }) {
  let pid = null;
  const centre = () => (knob.style.transform = "translate(-50%, -50%)");
  const read = (e) => {
    const r = pad.getBoundingClientRect();
    const R = r.width / 2;
    let dx = (e.clientX - (r.left + R)) / (R * 0.72);
    let dy = (e.clientY - (r.top + R)) / (R * 0.72);
    const m = Math.hypot(dx, dy);
    if (m > 1) (dx /= m), (dy /= m);
    knob.style.transform = `translate(calc(-50% + ${dx * R * 0.72}px), calc(-50% + ${dy * R * 0.72}px))`;
    const dead = (v) => (Math.abs(v) < 0.08 ? 0 : v);
    onMove(dead(dx), dead(-dy));
  };
  const end = () => {
    if (pid === null) return;
    pid = null;
    pad.classList.remove("active");
    centre();
    onHold(false);
  };
  pad.addEventListener("pointerdown", (e) => {
    if (pid !== null || pad.getAttribute("aria-disabled") === "true") return;
    e.preventDefault();
    pid = e.pointerId;
    pad.setPointerCapture(pid);
    pad.classList.add("active");
    onHold(true);
    read(e);
  });
  pad.addEventListener("pointermove", (e) => e.pointerId === pid && read(e));
  for (const ev of ["pointerup", "pointercancel", "lostpointercapture"]) pad.addEventListener(ev, (e) => e.pointerId === pid && end());
  pad.addEventListener("contextmenu", (e) => e.preventDefault());
  return { release: end, get held() {
    return pid !== null;
  } };
}

/**
 * D-pad: each button is hold-to-drive. A click with no pointer (Enter, switch access, voice) drives for PULSE_MS.
 * onHold(bool), onMove(x, y).
 */
const PULSE_MS = 500;
export function dpad(root, { onHold, onMove }) {
  let active = null;
  let pulse = null;
  const end = () => {
    clearTimeout(pulse);
    pulse = null;
    if (!active) return;
    active.classList.remove("active");
    active = null;
    onMove(0, 0);
    onHold(false);
  };
  for (const b of root.querySelectorAll("button[data-dir]")) {
    const [x, y] = b.dataset.dir.split(",").map(Number);
    b.addEventListener("pointerdown", (e) => {
      if (active) return;
      e.preventDefault();
      b.setPointerCapture(e.pointerId);
      active = b;
      b.classList.add("active");
      onHold(true);
      onMove(x * 0.6, y);
    });
    for (const ev of ["pointerup", "pointercancel", "lostpointercapture"]) b.addEventListener(ev, end);
    b.addEventListener("click", (e) => {
      if (e.detail !== 0 || active) return; // pointer taps are handled above
      active = b;
      b.classList.add("active");
      onHold(true);
      onMove(x * 0.6, y);
      pulse = setTimeout(end, PULSE_MS);
    });
    b.addEventListener("contextmenu", (e) => e.preventDefault());
  }
  return { release: end };
}
