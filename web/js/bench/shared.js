// Small helpers shared by the Workbench (bench.js), the mission runner and the Proving Grounds lab trials.
// Pure DOM: no three.js import, so pages without WebGL use them too.

export const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

/** A status line for screen readers: cleared first, so the same text twice is announced twice. */
export const createSpeaker = (node) => (text) => {
  node.textContent = "";
  setTimeout(() => (node.textContent = text), 60);
};

/** Puts a rig and its 3D view back to rest: no animation, tick, effects, props or phone view. No-op without a view. */
export function resetRig(view, rig, phoneFrame) {
  if (!view || !rig) return;
  view.cancelAnims();
  view.onTick = null;
  view.setLive(false);
  view.clearFx();
  view.clearProps();
  view.setPhoneView(null, null);
  if (phoneFrame) phoneFrame.hidden = true;
  rig.home();
  rig.setExplode(0);
  rig.group.position.set(0, 0, 0);
  rig.group.rotation.set(0, 0, 0);
  rig.spinners.forEach((s) => (s.rate = 0));
  rig.face?.setMood?.("idle");
  rig.face?.setLook?.(0, 0);
}

export const KIND_ORDER = ["sensor", "brain", "actuator", "power"];

/** One callout of each kind, in KIND_ORDER: the overview labels of a rig. */
export function overviewLabels(rig) {
  const out = [];
  for (const k of KIND_ORDER) {
    const c = rig.callouts.find((x) => x.kind === k);
    if (c) out.push({ node: c.node, text: c.label, kind: k });
  }
  return out;
}

/** No WebGL: the figure's labels as a plain list (duplicates dropped). */
export function staticLabelList(labels) {
  const seen = new Set();
  const ul = el("ul", "bn-labels-list static");
  ul.setAttribute("aria-label", "Labels on the figure");
  for (const l of labels) {
    if (seen.has(l.text)) continue;
    seen.add(l.text);
    ul.append(el("li", `bn-label k-${l.kind}`, l.text));
  }
  return ul;
}
