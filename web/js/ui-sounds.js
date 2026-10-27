// Interface sounds: small, soft, wooden lab sounds for pointing, pressing and moving around the site (Web Audio, no
// files, CC0). The site opens with these only; the music (ambient.js) waits for the visitor's ♪ (user decision,
// 2026-10-27).
//   * hover: a faint tap when the mouse reaches a control; press: a soft wooden knock; move: a short airy glide when a
//     tab, a stage, a page or a book page changes; slide: a tiny detent while a slider moves;
//   * quiet and warm like the music: everything under a 2.4 kHz low-pass, peaks far below full scale, nothing bright;
//   * browsers allow sound only after a gesture: the first click, tap or key wakes the audio, and nothing plays before;
//   * the speaker button turns them off, and "off" is remembered in this browser (key ofx-sounds).
const KEY = "ofx-sounds";
const LEVEL = 0.5;

const CONTROL = 'a[href], button, summary, select, [role="tab"], [role="button"], label.btn, input[type="checkbox"], input[type="radio"]';
const MOVE = '[role="tab"], .bn-tab, .bn-stage, .nav a[href], .pl-top a[href], a[href]:not([href^="#"]):not([target])';

/** The sound graph on a given context: hover, press, move and slide, each a few dozen ms of soft sound. */
export function createUiSounds(ctx) {
  const out = ctx.createGain();
  out.gain.value = LEVEL;
  const warm = ctx.createBiquadFilter();
  warm.type = "lowpass";
  warm.frequency.value = 2400;
  warm.connect(out).connect(ctx.destination);
  let noise = null;
  const noiseBuffer = () => {
    if (noise) return noise;
    noise = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 0.4), ctx.sampleRate);
    const d = noise.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    return noise;
  };
  function tone(t, f0, f1, dur, peak) {
    const o = ctx.createOscillator();
    o.type = "sine";
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(f1, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(warm);
    o.start(t);
    o.stop(t + dur + 0.02);
  }
  function air(t, from, peakAt, to, dur, peak) {
    const s = ctx.createBufferSource();
    s.buffer = noiseBuffer();
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.Q.value = 2.2;
    bp.frequency.setValueAtTime(from, t);
    bp.frequency.linearRampToValueAtTime(peakAt, t + dur * 0.45);
    bp.frequency.linearRampToValueAtTime(to, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(peak, t + dur * 0.35);
    g.gain.linearRampToValueAtTime(0, t + dur);
    s.connect(bp).connect(g).connect(warm);
    s.start(t);
    s.stop(t + dur + 0.02);
  }
  return {
    ctx,
    out,
    hover(t = ctx.currentTime) { tone(t, 560, 500, 0.04, 0.02); },
    press(t = ctx.currentTime) {
      tone(t, 330, 200, 0.09, 0.09); // the knock's body
      air(t, 900, 900, 700, 0.03, 0.05); // and its wooden contact
    },
    move(t = ctx.currentTime) {
      air(t, 300, 700, 460, 0.26, 0.07); // low and airy: no hiss
      tone(t + 0.03, 392, 523, 0.16, 0.025); // G up to C: "somewhere new"
    },
    slide(t = ctx.currentTime, k = 0.5) { tone(t, 300 + 500 * k, 280 + 460 * k, 0.03, 0.02); },
  };
}

let sounds = null;
let on = (() => {
  try {
    return localStorage.getItem(KEY) !== "off"; // on unless the visitor turned them off
  } catch {
    return true;
  }
})();
const buttons = new Set();
const sync = () => buttons.forEach((b) => b.setAttribute("aria-pressed", String(on)));

/** The sounds, once the audio runs (after a gesture); null before, when off or without Web Audio. */
function ready() {
  return on && sounds?.ctx.state === "running" ? sounds : null;
}
/** Plays `fn` now, or right after the audio wakes up when this is the gesture that wakes it (the first tap or click). */
function playSoon(fn) {
  if (!on) return;
  wake();
  if (!sounds) return;
  if (sounds.ctx.state === "running") return fn(sounds);
  sounds.ctx.resume().then(() => sounds.ctx.state === "running" && fn(sounds)).catch(() => {});
}
function wake() {
  if (sounds || !on) return;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (AC) sounds = createUiSounds(new AC());
}

if (typeof document !== "undefined") {
  let lastHover = null, lastMove = 0, lastHoverAt = 0, lastPress = 0, lastSlide = 0, lastKey = 0, keyRepeat = false;
  const now = () => performance.now();
  // the gestures that allow audio (on touch only the end of a tap counts): create the context before the click runs
  for (const type of ["mousedown", "pointerup", "touchend", "keydown"]) addEventListener(type, wake, true);
  addEventListener("pointermove", () => (lastMove = now()), { capture: true, passive: true });
  addEventListener("keydown", (e) => ((lastKey = now()), (keyRepeat = e.repeat)), true);
  document.addEventListener("pointerover", (e) => {
    if (e.pointerType !== "mouse") return;
    const el = e.target.closest?.(CONTROL);
    if (el === lastHover) return;
    lastHover = el;
    // only a real mouse movement (not a 3D label sliding under a resting cursor), and never a rattle across a row
    if (!el || now() - lastMove > 120 || now() - lastHoverAt < 60) return;
    if (el.disabled || el.getAttribute("aria-disabled") === "true") return;
    lastHoverAt = now();
    ready()?.hover();
  });
  document.addEventListener("click", (e) => {
    const el = e.target.closest?.(CONTROL);
    if (!el || el.disabled || el.getAttribute("aria-disabled") === "true" || el.dataset.sound === "none") return;
    if ((e.detail === 0 && keyRepeat) || now() - lastPress < 80) return; // a held Enter does not machine-gun
    lastPress = now();
    playSoon((s) => (el.dataset.sound === "move" || el.matches(MOVE) ? s.move() : s.press()));
  });
  document.addEventListener("input", (e) => {
    const r = e.target;
    const gap = now() - lastKey < 300 ? 120 : 70; // arrow keys repeat fast: fewer detents
    if (r?.type !== "range" || now() - lastSlide < gap) return;
    lastSlide = now();
    const k = (Number(r.value) - Number(r.min || 0)) / (Number(r.max || 100) - Number(r.min || 0) || 1);
    ready()?.slide(undefined, Math.min(1, Math.max(0, k)));
  });
  document.addEventListener("visibilitychange", () => (document.hidden ? sounds?.ctx.suspend() : on && sounds?.ctx.resume().catch(() => {})));
}

const SPEAKER = '<svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 6h2.5l3.5-3v10l-3.5-3H2.5z"/><path class="snd-wave" d="M11 5.5a3.5 3.5 0 0 1 0 5M12.8 3.8a6 6 0 0 1 0 8.4"/><path class="snd-off" d="M11 6l3.5 4M14.5 6L11 10"/></svg>';

/** The interface-sounds toggle (aria-pressed = sounds on). `className` styles it for the page it sits in. */
export function soundsButton(className = "btn sm ghost sound-btn") {
  const b = document.createElement("button");
  b.type = "button";
  b.className = `${className}${className.includes("sound-btn") ? "" : " sound-btn"}`;
  b.innerHTML = `${SPEAKER}<span class="nav-txt">Sounds</span>`;
  b.title = "Interface sounds (turn off if you use a screen reader)";
  b.setAttribute("aria-label", "Interface sounds");
  b.dataset.sound = "none"; // it plays its own sound, after turning on
  b.onclick = () => {
    on = !on;
    try {
      if (on) localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, "off");
    } catch {} // storage blocked: the choice lasts for this page
    sync();
    if (on) playSoon((s) => s.press());
  };
  buttons.add(b);
  sync();
  if (!(window.AudioContext || window.webkitAudioContext)) b.hidden = true; // no Web Audio: nothing to offer
  return b;
}
