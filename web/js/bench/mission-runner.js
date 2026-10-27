// Lab mission runner: level picker, controls (sliders, pads, toggles, pulses, keys), live session, scoring.
// Shared by the Workbench Test stage and the Proving Grounds lab trials. One runner on the page at a time; its
// element ids (levels, goal, startBtn, controls, readout, result, ctl-*, mode-*) take `idPrefix`. Missions are pure (missions/*), so a finished
// run is a trace { level, seed, actions } that anyone can replay; the page decides what to do with it (onFinish).
import { MISSIONS } from "./missions/index.js";
import { el } from "./shared.js";

/** Level progress shared by the Workbench and the Proving Grounds (localStorage is optional). */
export function createProgressStore(key = "ofx-bench-v1") {
  let data = {};
  try {
    data = JSON.parse(localStorage.getItem(key) || "{}") || {};
  } catch {
    data = {};
  }
  const rec = (robot, level) => data[robot]?.[level] || null;
  return {
    rec,
    unlocked(robot, i) {
      return i === 0 || !!rec(robot, MISSIONS[robot].levels[i - 1].id)?.passed;
    },
    record(robot, level, { pass, score, seed, steps }) {
      try {
        data = JSON.parse(localStorage.getItem(key) || "{}") || data; // another tab may have saved since
      } catch {}
      const r = (data[robot] ||= {});
      const old = r[level] || { best: 0, passed: false };
      r[level] = { best: Math.max(old.best, pass ? score : 0), passed: old.passed || pass, seed, at: steps };
      try {
        localStorage.setItem(key, JSON.stringify(data));
      } catch {
        /* private mode or blocked storage: progress lasts for this visit */
      }
    },
  };
}

/**
 * createMissionRunner({ robotId, view, scenes, getRig, resetRig, isReduced, speak, phoneFrame, store, onFinish,
 *                       beforeStart, note, idPrefix })
 * view/scenes are optional (no WebGL: text only). beforeStart(levelId) may resolve { seed } (a server challenge)
 * or null for a local run; onFinish({ robot, level, seed, actions, result, demo }) gets every finished run.
 * Returns { element, stop(announce), destroy(), get running() }.
 */
export function createMissionRunner({ robotId, view = null, scenes = null, getRig = () => null, resetRig = () => {}, isReduced = () => false, speak = () => {}, phoneFrame = null, store, onFinish = () => {}, beforeStart = null, note = null, idPrefix = "", keyScope = null }) {
  const m = MISSIONS[robotId];
  const pid = (id) => `${idPrefix}${id}`;
  // every slider gets a key pair (lower row −, upper row +) unless the mission names its own; letters already taken
  // by the mission's pads, toggles and pulses are skipped. The mission data itself is never changed.
  const taken = new Set(m.controls.flatMap((c) => [c.key, c.keys?.dec, c.keys?.inc, ...(c.buttons || []).map((b) => b.key)]).filter(Boolean));
  const PAIRS = [["a", "q"], ["s", "w"], ["d", "e"], ["f", "r"], ["g", "t"], ["h", "y"], ["j", "u"], ["k", "i"], ["l", "o"], ["z", "x"], ["c", "v"], ["b", "n"]].filter(([d, i]) => !taken.has(d) && !taken.has(i));
  const autoKeys = new Map();
  for (const c of m.controls) if (c.type === "slider" && !c.keys && PAIRS.length) { const [dec, inc] = PAIRS.shift(); autoKeys.set(c.id, { dec, inc }); }
  const keysOf = (c) => c.keys || autoKeys.get(c.id);
  let selLevel = 0, seed = 1, testScene = null, session = null, destroyed = false;
  let busy = false; // waiting for beforeStart (a server mission): the other buttons wait too
  let ui = { held: {}, pulse: {} };

  function firstOpenLevel() {
    const i = m.levels.findIndex((l, k) => store.unlocked(robotId, k) && !store.rec(robotId, l.id)?.passed);
    return i < 0 ? 0 : i;
  }

  // ---------------------------------------------------------------- panel
  const wrap = el("div", "bn-missions");
  wrap.append(el("p", "bn-note", note || "Lab sim: simple, deterministic physics written for learning. Scores are not real-robot verification."));
  const levels = el("ol", "bn-levels");
  levels.id = pid("levels");
  m.levels.forEach((lv, i) => {
    const li = el("li");
    const b = el("button", "bn-level");
    b.type = "button";
    b.dataset.i = i;
    b.onclick = () => {
      if (busy) return;
      if (!store.unlocked(robotId, i)) return speak("Pass the previous level to unlock this one.");
      selLevel = i;
      stop();
      refreshLevels();
      previewTest(i);
    };
    li.append(b);
    levels.append(li);
  });
  wrap.append(levels);
  const goal = el("p", "bn-goal");
  goal.id = pid("goal");
  wrap.append(goal);
  const row = el("div", "bn-row");
  const start = el("button", "btn sm primary", "Start");
  start.id = pid("startBtn");
  start.type = "button";
  start.onclick = () => (busy ? null : session && !session.done ? stop(true) : startSession());
  const fresh = el("button", "btn sm", "New layout");
  fresh.type = "button";
  fresh.onclick = () => {
    if (busy) return;
    seed = (seed % 9999) + 1;
    stop();
    previewTest(selLevel);
    speak(`Layout ${seed}`);
  };
  const demo = el("button", "btn sm ghost", "Show me");
  demo.type = "button";
  demo.title = "Play the scripted solution (not counted)";
  demo.onclick = () => (busy ? null : startSession({ demo: true }));
  row.append(start, fresh, demo);
  wrap.append(row);
  const controls = el("div", "bn-controls");
  controls.id = pid("controls");
  controls.setAttribute("role", "group");
  controls.setAttribute("aria-label", "Robot controls");
  wrap.append(controls);
  const readout = el("p", "bn-readout");
  readout.id = pid("readout");
  wrap.append(readout);
  const result = el("p", "bn-result");
  result.id = pid("result");
  wrap.append(result);

  function refreshLevels() {
    wrap.querySelectorAll(".bn-level").forEach((b) => {
      const i = +b.dataset.i;
      const lv = m.levels[i];
      const rec = store.rec(robotId, lv.id);
      const open = store.unlocked(robotId, i);
      b.replaceChildren(el("span", "bn-level-n", `L${i + 1}`), el("span", "bn-level-t", lv.title), el("span", "bn-level-s", rec?.passed ? `best ${rec.best}` : open ? "" : "locked"));
      b.setAttribute("aria-pressed", String(i === selLevel));
      b.setAttribute("aria-disabled", String(!open));
      b.classList.toggle("passed", !!rec?.passed);
      b.setAttribute("aria-label", `L${i + 1}, level ${i + 1}: ${lv.title}${rec?.passed ? `, passed, best score ${rec.best}` : open ? "" : ", locked"}`);
    });
    goal.textContent = `Goal: ${m.levels[selLevel].goal}`;
  }

  /** Build the level's scene at its initial state (and the controls), without running. */
  function previewTest(i) {
    selLevel = i;
    const lv = m.levels[i];
    const state = m.init(lv.id, seed);
    renderControls(lv, state, true);
    readout.textContent = m.readout(state);
    result.textContent = "";
    if (!view || !scenes) return;
    resetRig();
    testScene = scenes.makeTestScene(robotId, view, getRig(), m, state);
    view.setLabels(testScene.labels);
    view.moveCamera(testScene.camera, isReduced() ? 0 : 800);
    if (lv.phoneView && testScene.phoneCam && phoneFrame) {
      phoneFrame.hidden = false;
      view.setPhoneView(testScene.phoneCam, phoneFrame);
    }
    view.invalidate();
  }

  // ---------------------------------------------------------------- controls
  function renderControls(lv, state, disabled) {
    const defaults = m.uiDefaults(state);
    ui = { held: {}, pulse: {}, mode: m.controls.find((c) => c.type === "mode")?.value };
    for (const c of m.controls) if (c.type === "slider") ui[c.id] = defaults[c.id] ?? c.value ?? c.min;
    for (const c of m.controls) if (c.type === "toggle") ui[c.id] = !!defaults[c.id];
    Object.assign(ui, defaults);
    const parts = [];
    const visible = (c) => (!c.levels || c.levels.includes(lv.id)) && (!c.group || c.group === ui.mode);
    for (const c of m.controls) {
      if (c.levels && !c.levels.includes(lv.id)) continue;
      if (c.type === "mode") {
        const fs = el("fieldset", "bn-mode");
        fs.append(el("legend", null, c.label));
        c.options.forEach((o) => {
          const id = pid(`mode-${o.id}`);
          const lab = el("label");
          const r = el("input");
          r.type = "radio";
          r.name = pid("bn-mode");
          r.id = id;
          r.value = o.id;
          r.checked = ui.mode === o.id;
          r.onchange = () => {
            ui.mode = o.id;
            // keep the arm where it is when switching: refresh slider values from the current state
            const st = session?.state || m.init(lv.id, seed);
            Object.assign(ui, m.uiDefaults(st));
            controls.querySelectorAll("[data-group]").forEach((n) => (n.hidden = n.dataset.group !== ui.mode));
            controls.querySelectorAll("input[type=range]").forEach((s) => syncSlider(s));
          };
          lab.append(r, document.createTextNode(` ${o.label}`));
          fs.append(lab);
        });
        parts.push(fs);
      } else if (c.type === "slider") {
        const w = el("div", "bn-slider");
        if (c.group) (w.dataset.group = c.group), (w.hidden = !visible(c));
        const id = pid(`ctl-${c.id}`);
        const lab = el("label", null, c.label);
        lab.htmlFor = id;
        const out = el("output");
        out.htmlFor = id;
        out.setAttribute("role", "none"); // the slider announces its own value; a live <output> would chatter
        out.setAttribute("aria-live", "off");
        const s = el("input");
        s.type = "range";
        s.id = id;
        s.min = c.min;
        s.max = c.max;
        s.step = c.step;
        s.value = ui[c.id];
        s.dataset.key = c.id;
        s.dataset.unit = c.unit || "";
        s.oninput = () => {
          ui[c.id] = +s.value;
          out.textContent = `${s.value}${c.unit ? ` ${c.unit}` : ""}`;
          s.setAttribute("aria-valuetext", out.textContent);
          if (!session || session.done) previewPose();
        };
        out.textContent = `${s.value}${c.unit ? ` ${c.unit}` : ""}`;
        s.setAttribute("aria-valuetext", out.textContent);
        const ks = keysOf(c);
        if (ks) lab.append(el("span", "bn-key", ` (${ks.dec.replace("Arrow", "").toUpperCase()} − / ${ks.inc.replace("Arrow", "").toUpperCase()} +)`));
        w.append(lab, s, out);
        parts.push(w);
      } else if (c.type === "toggle") {
        const b = el("button", "btn sm bn-toggle", c.label);
        b.type = "button";
        b.dataset.key = c.id;
        b.setAttribute("aria-pressed", String(!!ui[c.id]));
        b.onclick = () => {
          ui[c.id] = !ui[c.id];
          b.setAttribute("aria-pressed", String(ui[c.id]));
        };
        if (c.key) b.append(el("span", "bn-key", ` (${c.key.toUpperCase()})`));
        parts.push(b);
      } else if (c.type === "pulse") {
        const b = el("button", "btn sm", c.label);
        b.type = "button";
        b.onclick = () => (ui.pulse[c.id] = true);
        if (c.key) b.append(el("span", "bn-key", ` (${c.key})`));
        b.dataset.pulse = c.id;
        parts.push(b);
      } else if (c.type === "pad") {
        const fs = el("fieldset", "bn-pad");
        fs.append(el("legend", null, `${c.label} (${c.hint || "hold the button or the key"})`));
        for (const p of c.buttons) {
          const b = el("button", "btn sm", p.label);
          b.type = "button";
          b.dataset.held = p.id;
          b.setAttribute("aria-label", `${p.label} (${p.key.replace("Arrow", "arrow ")})`);
          const on = (e) => {
            e.preventDefault();
            ui.held[p.id] = true;
            b.classList.add("down");
          };
          const off = () => {
            ui.held[p.id] = false;
            b.classList.remove("down");
          };
          b.addEventListener("pointerdown", on);
          b.addEventListener("pointerup", off);
          b.addEventListener("pointerleave", off);
          b.addEventListener("pointercancel", off);
          let viaKey = false;
          b.addEventListener("keydown", (e) => (e.key === " " || e.key === "Enter") && ((viaKey = true), on(e)));
          b.addEventListener("keyup", (e) => (e.key === " " || e.key === "Enter") && off());
          b.addEventListener("blur", off);
          b.addEventListener("click", (e) => {
            if (viaKey) return void (viaKey = false); // the key handlers above already held it
            if (e.detail !== 0 || ui.held[p.id]) return; // a click with no pointer and no key: switch access, voice
            on(e);
            setTimeout(off, 500);
          });
          fs.append(b);
        }
        parts.push(fs);
      }
    }
    controls.replaceChildren(...parts);
    controls.querySelectorAll("button").forEach((n) => n.setAttribute("aria-disabled", String(!!disabled)));
    controls.classList.toggle("idle", !!disabled);
  }
  function syncSlider(s) {
    const k = s.dataset.key;
    if (ui[k] == null) return;
    s.value = ui[k];
    s.nextElementSibling.textContent = `${s.value}${s.dataset.unit ? ` ${s.dataset.unit}` : ""}`;
    s.setAttribute("aria-valuetext", s.nextElementSibling.textContent);
  }
  /** Before Start: moving joint sliders previews the pose by stepping a scratch state (not recorded). */
  function previewPose() {
    if (!view || !testScene) return;
    const lv = m.levels[selLevel];
    const s = m.init(lv.id, seed);
    const a = m.toAction(ui, s);
    if (!a) return;
    for (let k = 0; k < 90; k++) m.step(s, a, m.dt);
    if (!s.done) testScene.update(s), view.invalidate();
  }

  // ---------------------------------------------------------------- keys (sliders with keys, pads, toggles, pulses)
  const isField = (t) => t && (t.tagName === "INPUT" || t.tagName === "SELECT" || t.tagName === "TEXTAREA");
  function onKeyDown(e) {
    if (!session || session.done || session.demo || e.altKey || e.ctrlKey || e.metaKey) return;
    const lv = m.levels[selLevel];
    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    // single-letter keys only while the controls or the 3D view have focus (WCAG 2.1.4)
    if (k.length === 1 && !controls.contains(e.target) && !(keyScope && keyScope.contains(e.target))) return;
    const fieldFocus = isField(e.target);
    for (const c of m.controls) {
      if (c.levels && !c.levels.includes(lv.id)) continue;
      if (c.type === "pad") {
        const p = c.buttons.find((b) => b.key === k);
        if (p && !(fieldFocus && k.startsWith("Arrow"))) {
          ui.held[p.id] = true;
          controls.querySelector(`[data-held="${p.id}"]`)?.classList.add("down");
          e.preventDefault();
          return;
        }
      }
      const ks = c.type === "slider" && keysOf(c);
      if (ks && (k === ks.dec || k === ks.inc) && (!c.group || c.group === ui.mode) && !(fieldFocus && k.startsWith("Arrow"))) {
        const d = (k === ks.inc ? 1 : -1) * (c.keyStep || c.step * (c.max - c.min > 50 ? 4 : 2));
        ui[c.id] = Math.min(c.max, Math.max(c.min, +(ui[c.id] + d).toFixed(4)));
        const s = controls.querySelector(`input[data-key="${c.id}"]`);
        if (s) syncSlider(s);
        e.preventDefault();
        return;
      }
      if (c.type === "toggle" && c.key === k && !e.repeat) {
        ui[c.id] = !ui[c.id];
        controls.querySelector(`button[data-key="${c.id}"]`)?.setAttribute("aria-pressed", String(ui[c.id]));
        e.preventDefault();
        return;
      }
      if (c.type === "pulse" && c.key === k && !e.repeat) {
        ui.pulse[c.id] = true;
        e.preventDefault();
        return;
      }
    }
  }
  function onKeyUp(e) {
    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    for (const c of m.controls)
      if (c.type === "pad")
        for (const p of c.buttons)
          if (p.key === k) {
            ui.held[p.id] = false;
            controls.querySelector(`[data-held="${p.id}"]`)?.classList.remove("down");
          }
  }
  // a key released while the window was in the background never fires keyup
  function onBlur() {
    for (const id of Object.keys(ui.held || {})) ui.held[id] = false;
    controls.querySelectorAll("[data-held].down").forEach((b) => b.classList.remove("down"));
  }
  // disabled controls ignore input (aria-disabled keeps them focusable and readable); the visitor sees why, not only
  // a screen reader: a tap on a robot control before Start used to do nothing at all on screen
  function onClickGuard(e) {
    const b = e.target.closest?.("button[aria-disabled=true]");
    if (!b || !controls.contains(b)) return;
    e.stopImmediatePropagation(), e.preventDefault();
    speak("Press Start first.");
    if (session?.done) return void (start.classList.remove("nudge"), void start.offsetWidth, start.classList.add("nudge"));
    result.textContent = "Press Start first: the controls drive the robot during a run.";
    result.className = "bn-result";
    start.classList.remove("nudge");
    void start.offsetWidth; // restart the animation on every tap
    start.classList.add("nudge");
  }
  document.addEventListener("keydown", onKeyDown);
  document.addEventListener("keyup", onKeyUp);
  window.addEventListener("blur", onBlur);
  document.addEventListener("click", onClickGuard, true);

  // ---------------------------------------------------------------- session
  async function startSession({ demo = false } = {}) {
    stop();
    const lv = m.levels[selLevel];
    if (!store.unlocked(robotId, selLevel)) return;
    if (!demo && beforeStart) {
      busy = true;
      start.setAttribute("aria-disabled", "true");
      try {
        const got = await beforeStart(lv.id);
        if (got && Number.isInteger(got.seed)) seed = got.seed;
      } finally {
        busy = false;
        start.removeAttribute("aria-disabled");
      }
      if (destroyed) return;
    }
    const state = m.init(lv.id, seed);
    renderControls(lv, state, demo);
    if (view) previewTest(selLevel), renderControls(lv, state, demo);
    const script = demo ? m.solve(lv.id, seed) : null;
    session = { lv, state, actions: [], acc: 0, done: false, demo, script, last: null, lastRead: 0, seed };
    start.classList.remove("nudge");
    start.textContent = demo ? "Stop demo" : "Stop";
    result.textContent = demo ? "Demo: the scripted solution (not counted)." : "";
    result.className = "bn-result";
    speak(demo ? `Demo of level ${selLevel + 1}` : `Level ${selLevel + 1} started. ${lv.goal}`);
    const tick = (dt) => {
      if (!session || session.done) return;
      session.acc += Math.min(0.1, dt);
      let n = 0;
      while (session.acc >= m.dt && n < 6 && !session.done) {
        session.acc -= m.dt;
        n++;
        let a;
        if (demo) a = script[session.actions.length] ?? m.idle(session.state);
        else {
          a = m.toAction(ui, session.state) ?? session.last ?? m.idle(session.state);
          ui.pulse = {};
        }
        session.last = a;
        session.actions.push(a);
        m.step(session.state, a, m.dt);
        if (session.state.done || session.actions.length >= lv.maxSteps) finishSession();
      }
      testScene?.update(session.state);
      const now = session.actions.length;
      if (now - session.lastRead >= 3 || session.done) {
        session.lastRead = now;
        readout.textContent = `${(session.state.t ?? 0).toFixed(1)} s · ${m.readout(session.state)}`;
      }
    };
    if (view) {
      view.onTick = (dt) => tick(dt); // real time, also with reduced motion: verified runs must not run fast
      view.setLive(true);
    } else {
      let last = performance.now();
      session.timer = setInterval(() => {
        const now = performance.now();
        tick((now - last) / 1000);
        last = now;
      }, 33);
    }
  }

  function finishSession() {
    const s = session;
    s.done = true;
    const r = m.score({ level: s.lv.id, seed: s.seed, actions: s.actions });
    const why = String(r.reason || "").replace(/_/g, " ");
    if (s.demo) {
      result.textContent = `Demo finished: ${r.pass ? "pass" : "fail"}, score ${r.score} (${why}, ${r.seconds} s). Not counted.`;
    } else {
      result.textContent = r.pass ? `Pass. Score ${r.score} / 100 in ${r.seconds} s (${why}).` : `Not yet: ${why}. Score ${r.score} / 100. Try again or press “Show me”.`;
      result.className = `bn-result ${r.pass ? "ok" : "fail"}`;
      store.record(robotId, s.lv.id, { pass: r.pass, score: r.score, seed: s.seed, steps: s.actions.length });
      refreshLevels();
      if (r.pass && selLevel < 2) speak(`Passed with ${r.score}. Level ${selLevel + 2} unlocked.`);
      else speak(r.pass ? `Passed with ${r.score}. All three levels done.` : `Not passed: ${why}.`);
    }
    start.textContent = "Start again";
    controls.querySelectorAll("button").forEach((n) => n.setAttribute("aria-disabled", "true"));
    if (view) view.setLive(false), view.invalidate();
    clearInterval(s.timer);
    onFinish({ robot: robotId, level: s.lv.id, seed: s.seed, actions: s.actions, result: r, demo: s.demo });
  }

  function stop(announce = false) {
    if (!session) return;
    clearInterval(session.timer);
    if (view && !session.done) (view.onTick = null), view.setLive(false);
    const was = session;
    session = null;
    start.textContent = "Start";
    if (announce && !was.done) speak("Stopped.");
    controls.querySelectorAll("button").forEach((n) => n.setAttribute("aria-disabled", "true"));
  }

  selLevel = firstOpenLevel();
  queueMicrotask(() => {
    refreshLevels();
    if (!view) previewTest(selLevel);
  });

  return {
    element: wrap,
    /** Builds the first open level's scene (the Workbench calls it once the stage camera is in place). */
    preview: () => previewTest(firstOpenLevel()),
    stop,
    get running() {
      return !!session && !session.done;
    },
    destroy() {
      destroyed = true;
      stop();
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
      document.removeEventListener("click", onClickGuard, true);
    },
  };
}
