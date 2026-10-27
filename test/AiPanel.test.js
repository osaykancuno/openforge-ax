const { expect } = require("chai");

// AI Pilot panel (web/js/pilot/ai/ai-panel.js) on a tiny fake DOM: what the user sees for model text, how plan cards
// follow the run gate, the settings form. No browser needed; a real-browser pass is still the lead's check.
describe("AI Pilot panel (web/js/pilot/ai/ai-panel.js)", () => {
  let Panel, S;
  before(async () => {
    Panel = await import("../web/js/pilot/ai/ai-panel.js");
    S = await import("../web/js/pilot/ai/settings.js");
  });

  // ---- a minimal DOM: just what ui.js el()/chip() and the panel use
  class Node {
    constructor(tag) {
      this.tagName = String(tag).toUpperCase();
      this.children = [];
      this.attrs = {};
      this.dataset = {};
      this.listeners = {};
      this.parent = null;
      this._text = "";
      this.hidden = false;
      this.disabled = false;
      this.value = "";
      this.checked = false;
      this.scrollTop = 0;
      this.scrollHeight = 0;
      this.className = "";
    }
    setAttribute(k, v) {
      this.attrs[k] = String(v);
      if (k === "disabled") this.disabled = true;
    }
    getAttribute(k) {
      return k in this.attrs ? this.attrs[k] : null;
    }
    removeAttribute(k) {
      delete this.attrs[k];
    }
    append(...c) {
      for (const x of c) {
        const n = typeof x === "string" ? Object.assign(new Node("#text"), { _text: x }) : x;
        n.parent = this;
        this.children.push(n);
      }
    }
    remove() {
      if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this);
      this.parent = null;
    }
    addEventListener(t, fn) {
      (this.listeners[t] = this.listeners[t] || []).push(fn);
    }
    fire(type, ev = {}) {
      return Promise.all((this.listeners[type] || []).map((fn) => fn({ preventDefault() {}, target: this, ...ev })));
    }
    set textContent(v) {
      this.children = [];
      this._text = String(v);
    }
    get textContent() {
      return this._text + this.children.map((c) => c.textContent).join("");
    }
    focus() {}
    walk(fn) {
      fn(this);
      this.children.forEach((c) => c.walk(fn));
    }
    find(pred) {
      let out = null;
      this.walk((n) => out || (pred(n) && (out = n)));
      return out;
    }
    all(pred) {
      const out = [];
      this.walk((n) => pred(n) && out.push(n));
      return out;
    }
  }

  const IDS = ["aiLog", "aiStatus", "aiForm", "aiInput", "aiModelChip", "aiUrl", "aiModelName", "aiOther", "aiOtherNote", "aiSettingsMsg", "aiSave", "aiTest", "aiOrigin"];
  let created;
  let saved;
  function setup({ stored = null } = {}) {
    created = [];
    saved = { document: globalThis.document, fetch: globalThis.fetch };
    globalThis.document = {
      createElement: (t) => (created.push(t), new Node(t)),
      createTextNode: (t) => Object.assign(new Node("#text"), { _text: t }),
    };
    const els = Object.fromEntries(IDS.map((id) => [id, new Node(id === "aiForm" ? "form" : "div")]));
    const mem = new Map(stored ? [[S.STORAGE_KEY, JSON.stringify(stored)]] : []);
    const storage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)) };
    const calls = { submit: [], run: 0, discard: 0, models: [] };
    const ai = {
      view: { state: "idle", messages: [], plan: null, progress: null },
      submit: (t) => calls.submit.push(t),
      run: () => calls.run++,
      discard: () => calls.discard++,
    };
    const panel = Panel.mountAiPanel({ ai, storage, setModel: (c, s) => calls.models.push({ client: c, settings: s }), get: (id) => els[id], origin: "https://example.test" });
    return { els, ai, panel, calls, storage, mem };
  }
  afterEach(() => {
    globalThis.document = saved.document;
    globalThis.fetch = saved.fetch;
  });

  const planRec = (over = {}) => ({ id: 7, role: "plan", source: "model", steps: [{ tool: "drive", direction: "forward", seconds: 2, speed: 100 }, { tool: "turn", degrees: -90, speed: 100 }], rejected: [], status: "ready", blocked: null, confirm: false, canRun: true, note: "", ...over });
  const view = (messages, extra = {}) => ({ state: "ready", messages, plan: null, progress: null, ...extra });

  it("starts with the built-in parser label, the page origin in the help, and no model", () => {
    const t = setup();
    expect(t.els.aiModelChip.textContent).to.equal("No model: built-in parser");
    expect(t.els.aiOrigin.textContent).to.equal("https://example.test");
    expect(t.calls.models).to.have.length(1);
    expect(t.calls.models[0].client).to.equal(null);
    expect(t.els.aiUrl.value).to.equal("http://localhost:11434");
  });

  it("model and user text is only ever text: no element is created from it", () => {
    const t = setup();
    const evil = '<img src=x onerror="alert(1)"><script>boom()</script><a href="https://evil.test">click</a>';
    const before = created.length;
    t.panel.render(
      view([
        { id: 1, role: "user", text: evil },
        { id: 2, role: "model", text: evil },
        { id: 3, role: "pilot", text: evil },
        { id: 4, role: "notice", text: evil },
        { id: 5, role: "plan", plan: planRec({ steps: [{ tool: "say", text: evil }], rejected: [{ index: 1, reason: evil }] }) },
      ]),
    );
    const tags = created.slice(before);
    for (const bad of ["img", "script", "a", "iframe", "style", "svg", "object", "embed", "link", "form"]) expect(tags, bad).to.not.include(bad);
    expect(t.els.aiLog.textContent).to.contain('<img src=x onerror="alert(1)">');
    expect(t.els.aiLog.textContent).to.contain("<script>boom()</script>");
  });

  it("labels who is speaking: You, Model says, Built-in parser, Note; plans name their source", () => {
    const t = setup();
    t.panel.render(
      view([
        { id: 1, role: "user", text: "hi" },
        { id: 2, role: "model", text: "Sure." },
        { id: 3, role: "pilot", text: "The Rover has no arms." },
        { id: 4, role: "notice", text: "Stopped." },
        { id: 5, role: "plan", plan: planRec() },
        { id: 6, role: "plan", plan: planRec({ id: 8, source: "built-in parser" }) },
      ]),
    );
    const whos = t.els.aiLog.all((n) => n.className === "pl-ai-who").map((n) => n.textContent);
    expect(whos).to.deep.equal(["You", "Model says", "Built-in parser", "Note", "Plan from the model", "Plan from the built-in parser"]);
    const roles = t.els.aiLog.all((n) => n.dataset.role).map((n) => n.dataset.role);
    expect(roles).to.deep.equal(["user", "model", "pilot", "notice"]);
    const steps = t.els.aiLog.all((n) => n.tagName === "LI").map((n) => n.textContent);
    expect(steps.slice(0, 2)).to.deep.equal(["drive forward 2 s", "turn right about 90°"]);
  });

  it("a plan card follows the run gate in place: inactive Run with the honest line, then active once armed, same nodes", () => {
    const t = setup();
    const blocked = planRec({ canRun: false, blocked: "arm", note: "Press ARM to let me move. I can't arm the robot." });
    t.panel.render(view([{ id: 5, role: "plan", plan: blocked }], { plan: blocked }));
    const card = t.els.aiLog.find((n) => n.className === "pl-ai-plan");
    const run = card.find((n) => n.tagName === "BUTTON" && n.textContent === "Run");
    expect(run.disabled).to.equal(true);
    expect(card.find((n) => n.className === "pl-ai-note").textContent).to.equal("Press ARM to let me move. I can't arm the robot.");
    expect(run.attrs["aria-describedby"]).to.equal(card.find((n) => n.className === "pl-ai-note").attrs.id);

    Object.assign(blocked, { canRun: true, blocked: null, note: "" });
    t.panel.render(view([{ id: 5, role: "plan", plan: blocked }], { plan: blocked }));
    expect(t.els.aiLog.find((n) => n.className === "pl-ai-plan")).to.equal(card); // updated in place: focus never jumps
    expect(card.find((n) => n.textContent === "Run")).to.equal(run);
    expect(run.disabled).to.equal(false);
  });

  it("Run and Discard call the pilot; once running the actions go away and the current step is marked", async () => {
    const t = setup();
    const p = planRec();
    t.panel.render(view([{ id: 5, role: "plan", plan: p }], { plan: p }));
    const card = t.els.aiLog.find((n) => n.className === "pl-ai-plan");
    await card.find((n) => n.textContent === "Run").fire("click");
    await card.find((n) => n.textContent === "Discard").fire("click");
    expect(t.calls.run).to.equal(1);
    expect(t.calls.discard).to.equal(1);
    p.status = "running";
    t.panel.render(view([{ id: 5, role: "plan", plan: p }], { state: "running", plan: p, progress: { index: 1, total: 2, step: p.steps[1] } }));
    const items = card.all((n) => n.tagName === "LI");
    expect(items.map((n) => n.dataset.now)).to.deep.equal(["false", "true"]);
    expect(items[1].attrs["aria-current"]).to.equal("step");
    expect(items[0].attrs["aria-current"]).to.equal(undefined);
    expect(card.find((n) => n.className === "pl-row pl-wrap").hidden).to.equal(true);
    expect(card.find((n) => n.className === "pl-ai-note").textContent).to.equal("Running step 2 of 2.");
    expect(t.els.aiStatus.textContent).to.equal("Running step 2 of 2: turn right about 90°");
    p.status = "stopped";
    t.panel.render(view([{ id: 5, role: "plan", plan: p }], { state: "stopped", plan: p }));
    expect(card.find((n) => n.className === "pl-ai-note").textContent).to.equal("Stopped.");
    expect(t.els.aiStatus.textContent).to.equal("");
  });

  it("thinking is shown; old messages that left the transcript leave the page", () => {
    const t = setup();
    t.panel.render(view([{ id: 1, role: "user", text: "a" }, { id: 2, role: "user", text: "b" }], { state: "thinking" }));
    expect(t.els.aiStatus.textContent).to.equal("Thinking…");
    expect(t.els.aiLog.children).to.have.length(2);
    t.panel.render(view([{ id: 2, role: "user", text: "b" }]));
    expect(t.els.aiLog.children).to.have.length(1);
    expect(t.els.aiLog.textContent).to.equal("Youb");
  });

  it("Enter / Send submits the text and clears the box; blank text does nothing", async () => {
    const t = setup();
    t.els.aiInput.value = "  wave, then look left ";
    await t.els.aiForm.fire("submit");
    expect(t.calls.submit).to.deep.equal(["  wave, then look left "]);
    expect(t.els.aiInput.value).to.equal("");
    t.els.aiInput.value = "   ";
    await t.els.aiForm.fire("submit");
    expect(t.calls.submit).to.have.length(1);
  });

  it("settings: a bad address is refused with a message; a good one is saved, labelled and handed over as a client", async () => {
    const t = setup();
    t.els.aiUrl.value = "http://example.com";
    t.els.aiModelName.value = "qwen2.5:3b";
    await t.els.aiSave.fire("click");
    expect(t.els.aiSettingsMsg.dataset.tone).to.equal("bad");
    expect(t.els.aiSettingsMsg.textContent).to.match(/this computer/i);
    expect(t.calls.models).to.have.length(1);
    expect(t.mem.size).to.equal(0);

    t.els.aiUrl.value = "http://localhost:11434/";
    await t.els.aiSave.fire("click");
    expect(t.els.aiSettingsMsg.dataset.tone).to.equal("ok");
    expect(t.els.aiModelChip.textContent).to.equal("Model: qwen2.5:3b at localhost:11434 (this computer)");
    expect(t.calls.models).to.have.length(2);
    expect(t.calls.models[1].client).to.have.property("plan");
    expect(JSON.parse(t.mem.get(S.STORAGE_KEY))).to.deep.equal({ url: "http://localhost:11434", model: "qwen2.5:3b", allowOtherHosts: false });
    expect(t.els.aiUrl.value).to.equal("http://localhost:11434");

    t.els.aiModelName.value = "";
    await t.els.aiSave.fire("click");
    expect(t.els.aiModelChip.textContent).to.equal("No model: built-in parser");
    expect(t.calls.models[2].client).to.equal(null);
  });

  it("settings are loaded from storage at start", () => {
    const t = setup({ stored: { url: "http://127.0.0.1:1234", model: "llama3.2:3b", allowOtherHosts: false } });
    expect(t.els.aiModelChip.textContent).to.equal("Model: llama3.2:3b at 127.0.0.1:1234 (this computer)");
    expect(t.els.aiModelName.value).to.equal("llama3.2:3b");
    expect(t.calls.models[0].client).to.have.property("plan");
  });

  it("the other-hosts note shows only while the box is ticked", async () => {
    const t = setup();
    expect(t.els.aiOtherNote.hidden).to.equal(true);
    t.els.aiOther.checked = true;
    await t.els.aiOther.fire("change");
    expect(t.els.aiOtherNote.hidden).to.equal(false);
  });

  it("Test connection says what it found, and refuses a bad address without any request", async () => {
    const t = setup();
    let hits = 0;
    globalThis.fetch = async () => (hits++, new Response(JSON.stringify({ data: [{ id: "qwen2.5:3b" }] }), { status: 200 }));
    t.els.aiUrl.value = "http://example.com";
    await t.els.aiTest.fire("click");
    expect(t.els.aiSettingsMsg.dataset.tone).to.equal("bad");
    expect(hits).to.equal(0);

    t.els.aiUrl.value = "http://localhost:11434";
    t.els.aiModelName.value = "qwen2.5:3b";
    await t.els.aiTest.fire("click");
    expect(hits).to.equal(1);
    expect(t.els.aiSettingsMsg.textContent).to.match(/lists that model/);
    expect(t.els.aiSettingsMsg.dataset.tone).to.equal("ok");

    t.els.aiModelName.value = "other:7b";
    await t.els.aiTest.fire("click");
    expect(t.els.aiSettingsMsg.textContent).to.contain('does not list "other:7b"');
    expect(t.els.aiSettingsMsg.dataset.tone).to.equal("warn");

    globalThis.fetch = async () => {
      throw new TypeError("Failed to fetch");
    };
    await t.els.aiTest.fire("click");
    expect(t.els.aiSettingsMsg.dataset.tone).to.equal("bad");
    expect(t.els.aiSettingsMsg.textContent).to.match(/Could not reach the model/);
  });
});
