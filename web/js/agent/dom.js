// Tiny DOM helpers for the agent page. Text is always added as text nodes (never as HTML), so chain data, file names and
// anything a stranger can write can only ever be shown, not run.

/** h("div", { class: "x", onclick: fn, hidden: true }, "text", child, [more]) -> element. */
export function h(tag, props = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === false || v === null || v === undefined) continue;
    if (k === "class") e.className = v;
    else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v === true ? "" : String(v));
  }
  e.append(...kids.flat(2).filter((k) => k !== null && k !== undefined && k !== false));
  return e;
}

/** Offers `text` as a file download (the browser saves it; nothing is uploaded). */
export function download(filename, text) {
  const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  const a = h("a", { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/**
 * True while the holder is in the middle of something in `pane`: focus is inside it, or a field holds something they typed
 * or chose (a passphrase, a file, an address, another daily limit). The console re-reads the chain every minute; it must not
 * rebuild the pane under them and wipe what they were typing.
 */
export function paneBusy(pane, doc = globalThis.document) {
  if (!pane) return false;
  const focus = doc?.activeElement;
  if (focus && focus !== pane && pane.contains(focus)) return true;
  return [...pane.querySelectorAll("input, textarea, select")].some((el) => {
    if (el.type === "file") return Boolean(el.files?.length);
    if (el.tagName === "SELECT" || el.options) return [...el.options].some((o) => o.selected !== o.defaultSelected);
    return String(el.value ?? "") !== String(el.defaultValue ?? "");
  });
}
