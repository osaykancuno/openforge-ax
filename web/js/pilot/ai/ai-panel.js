// AI Pilot panel: the chat transcript, the plan cards, the model settings. DOM only; the pilot logic is in ai-pilot.js.
// Every piece of text that comes from the model or the user goes through textContent (the el() helper), never through
// markup: no innerHTML, no links, no eval. The transcript is a live region; a plan card is updated in place so the
// keyboard focus never jumps while a plan runs.
import { $ as byId, chip, el } from "../ui.js";
import { describeStep } from "./tools.js";
import { clientFromSettings, loadSettings, modelLabel, saveSettings } from "./settings.js";
import { parseModelUrl } from "./model-client.js";

const WHO = { user: "You", model: "Model says", pilot: "Built-in parser", notice: "Note" };
const END_TEXT = { done: "Done.", interrupted: "Interrupted.", stopped: "Stopped.", discarded: "Discarded." };

/**
 * mountAiPanel({ ai, storage, setModel, get, origin })
 * ai: the orchestrator. storage: where settings live (localStorage or null). setModel(client | null, settings) is called
 * at start and after each save. get(id) finds an element (the page's ids, see pilot.html).
 */
export function mountAiPanel({ ai, storage, setModel, get = byId, origin = "" }) {
  const log = get("aiLog");
  const status = get("aiStatus");
  const form = get("aiForm");
  const input = get("aiInput");
  const modelChip = get("aiModelChip");
  const urlIn = get("aiUrl");
  const nameIn = get("aiModelName");
  const otherIn = get("aiOther");
  const otherNote = get("aiOtherNote");
  const settingsMsg = get("aiSettingsMsg");
  const saveBtn = get("aiSave");
  const testBtn = get("aiTest");
  const originEl = get("aiOrigin");

  let settings = loadSettings(storage);
  let probing = null;
  const nodes = new Map(); // message id -> { node, update(plan, view) }

  // ---------------------------------------------------------------- transcript

  function bubble(m) {
    const node = el("div", { class: "pl-ai-msg" }, el("span", { class: "pl-ai-who", text: WHO[m.role] || "" }), el("p", { class: "pl-ai-text", text: m.text }));
    node.dataset.role = m.role;
    return { node, update() {} };
  }

  function card(m) {
    const plan = m.plan;
    const noteId = `aiNote${m.id}`;
    const title = el("p", { class: "pl-ai-who", text: `Plan from the ${plan.source}` });
    const list = el("ol", { class: "pl-ai-steps" }, ...plan.steps.map((s) => el("li", { text: describeStep(s) })));
    const dropped = plan.rejected && plan.rejected.length ? el("p", { class: "pl-ai-note", text: `Left out: ${plan.rejected.slice(0, 3).map((r) => r.reason).join("; ")}` }) : null;
    const note = el("p", { class: "pl-ai-note", id: noteId });
    const run = el("button", { class: "pl-btn pl-primary sm", type: "button", text: "Run", "aria-describedby": noteId, onclick: () => ai.run(plan.id) });
    const discard = el("button", { class: "pl-btn sm", type: "button", text: "Discard", onclick: () => ai.discard() });
    const actions = el("div", { class: "pl-row pl-wrap" }, run, discard);
    const node = el("div", { class: "pl-ai-plan", role: "group", "aria-label": `Plan from the ${plan.source}` }, title, list, dropped, note, actions);
    const items = [...list.children];
    return {
      node,
      update(p, view) {
        const mineRunning = view.plan === p && view.state === "running" && view.progress;
        node.dataset.status = p.status;
        items.forEach((li, i) => {
          const now = !!mineRunning && view.progress.index === i;
          li.dataset.now = now ? "true" : "false";
          if (now) li.setAttribute("aria-current", "step");
          else li.removeAttribute("aria-current");
        });
        const ready = p.status === "ready";
        note.textContent = ready ? p.note || "" : p.status === "running" ? (mineRunning ? `Running step ${view.progress.index + 1} of ${p.steps.length}.` : "Running.") : END_TEXT[p.status] || "";
        run.disabled = !(ready && p.canRun);
        actions.hidden = !ready;
      },
    };
  }

  function renderStatus(view) {
    let text = "";
    if (view.state === "thinking") text = "Thinking…";
    else if (view.state === "running" && view.progress) text = `Running step ${view.progress.index + 1} of ${view.progress.total}: ${describeStep(view.progress.step)}`;
    status.textContent = text;
  }

  function render(view) {
    const live = new Set();
    for (const m of view.messages) {
      live.add(m.id);
      let n = nodes.get(m.id);
      if (!n) {
        n = m.role === "plan" ? card(m) : bubble(m);
        nodes.set(m.id, n);
        log.append(n.node);
        log.scrollTop = log.scrollHeight;
      }
      if (m.role === "plan") n.update(m.plan, view);
    }
    for (const [id, n] of nodes)
      if (!live.has(id)) {
        n.node.remove();
        nodes.delete(id);
      }
    renderStatus(view);
  }

  // ---------------------------------------------------------------- chat input

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const text = input.value;
    if (!text.trim()) return;
    input.value = "";
    ai.submit(text);
  });

  // ---------------------------------------------------------------- model settings

  const say = (text, tone) => {
    settingsMsg.textContent = text;
    settingsMsg.dataset.tone = tone || "";
  };
  const showOtherNote = () => {
    otherNote.hidden = !otherIn.checked;
  };
  function applyModel() {
    let client = null;
    try {
      client = clientFromSettings(settings);
    } catch {
      client = null;
    }
    setModel(client, settings);
    chip(modelChip, modelLabel(settings), settings.model ? "ok" : "");
  }
  function fillFields() {
    urlIn.value = settings.url;
    nameIn.value = settings.model;
    otherIn.checked = settings.allowOtherHosts;
    showOtherNote();
  }
  const formSettings = () => ({ url: urlIn.value, model: nameIn.value, allowOtherHosts: otherIn.checked });

  otherIn.addEventListener("change", showOtherNote);
  saveBtn.addEventListener("click", () => {
    const r = saveSettings(storage, formSettings());
    if (!r.ok) {
      say(r.error, "bad");
      return;
    }
    settings = r.settings;
    fillFields();
    applyModel();
    say(settings.model ? "Saved. The next message goes to your model." : "Saved. No model name, so the built-in parser answers.", "ok");
  });
  testBtn.addEventListener("click", async () => {
    const f = formSettings();
    const p = parseModelUrl(f.url, { allowOtherHosts: f.allowOtherHosts });
    if (!p.ok) return say(p.error, "bad");
    let client = null;
    try {
      client = clientFromSettings({ ...f, url: p.url, model: f.model.trim() || "model" });
    } catch (e) {
      return say(e && e.message ? e.message : "That address cannot be used.", "bad");
    }
    if (probing) probing.abort();
    const mine = (probing = new AbortController());
    say("Testing…", "");
    const r = await client.probe(mine.signal);
    if (probing !== mine) return;
    probing = null;
    if (!r.ok) return say(r.error, "bad");
    const name = f.model.trim();
    if (!name) return say(r.models.length ? `The server answers. Models it lists: ${r.models.slice(0, 6).join(", ")}.` : "The server answers, but lists no models.", "ok");
    say(r.hasModel ? "The server answers and lists that model." : `The server answers, but it does not list "${name}". It lists: ${r.models.slice(0, 6).join(", ") || "nothing"}.`, r.hasModel ? "ok" : "warn");
  });

  if (originEl) originEl.textContent = origin;
  fillFields();
  applyModel();
  render(ai.view);

  return { render, focus: () => input.focus(), get settings() { return settings; } };
}
