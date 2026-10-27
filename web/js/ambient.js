// Lab ambient: a soft looping soundtrack made live with Web Audio (no audio files, nothing downloaded, CC0).
//   * a composed 16-bar loop at 72 BPM (about 53 s) that repeats seamlessly: warm pads on four chords, a light arpeggio,
//     a two-phrase "glass" melody (a question, then an answer that comes home to C) and a soft lab-clock pulse;
//   * now and then, over the loop, a lab sound: a small robot chirp, a servo's soft whirr, a bubble;
//   * one track for the whole site: the position in the loop comes from a clock shared by every page of this browser
//     (localStorage), so changing page continues the same music from where it was, like a radio left on;
//   * off by default (user decision, 2026-10-27): the site opens silent, with only the soft interface sounds of
//     ui-sounds.js; the ♪ button turns the music on, and "on" is remembered in this browser, so the next pages continue
//     it (at once if the browser allows sound there, otherwise at the visitor's first click, tap or key);
//   * quiet and soft: nothing bright or sharp (everything under a 2.4 kHz low-pass), silent while the page is hidden.
const KEY = "ofx-music";
const VOLUME = 0.42; // low on purpose: background, never in the way (about -36 dBFS RMS)

// ---------------------------------------------------------------- composition (pure: no audio, testable)
const A4 = 440;
export const freq = (midi) => A4 * 2 ** ((midi - 69) / 12);
export const BPM = 72;
export const BEAT_S = 60 / BPM;
export const BARS = 16;
export const LOOP_BEATS = BARS * 4;
/** Four chords (MIDI notes), two bars each, twice per loop: Cmaj9, Am9, Fmaj9, G6/9. Bright, unhurried, never tense. */
export const CHORDS = [
  [48, 55, 59, 62, 64],
  [45, 52, 55, 59, 60],
  [41, 48, 52, 55, 57],
  [43, 50, 52, 57, 59],
];
/** C major pentatonic from C5: every melody note comes from here. */
export const SCALE = [72, 74, 76, 79, 81, 84, 86, 88];
/** The melody: [beat, MIDI, length in beats]. Bars 1-8 ask, bars 9-16 answer and land on C. */
export const MELODY = [
  [0, 76, 2], [2, 79, 1], [3, 81, 1], [4, 79, 3], [7, 76, 1],
  [8, 72, 2], [10, 74, 1], [11, 76, 1], [12, 74, 4],
  [16, 81, 2], [18, 79, 1], [19, 76, 1], [20, 79, 2], [22, 81, 2],
  [24, 74, 2], [26, 76, 1], [27, 79, 1], [28, 74, 4],
  [32, 79, 2], [34, 81, 1], [35, 84, 1], [36, 81, 3], [39, 79, 1],
  [40, 76, 2], [42, 79, 2], [44, 76, 2], [46, 74, 2],
  [48, 79, 2], [50, 81, 1], [51, 84, 1], [52, 81, 2], [54, 79, 1], [55, 76, 1],
  [56, 74, 2], [58, 76, 2], [60, 72, 4],
];
/** The chord under a beat of the loop. */
export const chordAt = (beat) => CHORDS[Math.floor((((beat % LOOP_BEATS) + LOOP_BEATS) % LOOP_BEATS) / 8) % CHORDS.length];
/** Everything that sounds on one beat of the loop: [{ kind, notes?, beats? }]. Pure, so the loop can be checked. */
export function eventsAt(beat) {
  const b = ((beat % LOOP_BEATS) + LOOP_BEATS) % LOOP_BEATS;
  const chord = chordAt(b);
  const out = [];
  if (b % 8 === 0) out.push({ kind: "pad", notes: chord, beats: 8 });
  out.push({ kind: "arp", notes: [chord[[2, 3, 4, 3][b % 4]] + 12] }); // one soft note a beat, up the chord and back
  for (const [at, n, len] of MELODY) if (at === b) out.push({ kind: "melody", notes: [n], beats: len });
  if (b % 4 === 0) out.push({ kind: "thump" });
  else if (b % 2 === 1) out.push({ kind: "tick" }); // the lab clock: off-beats, very quiet
  return out;
}

/** The lab sound on a beat of the shared timeline, or null: three slots per loop, varied per pass but fixed in time. */
export const LAB_SLOTS = [12, 36, 54];
export function labAt(globalBeat) {
  const b = ((globalBeat % LOOP_BEATS) + LOOP_BEATS) % LOOP_BEATS;
  const slot = LAB_SLOTS.indexOf(b);
  if (slot < 0) return null;
  const pass = Math.floor(globalBeat / LOOP_BEATS);
  const k = rng(pass * 7919 + slot * 104729 + 1)();
  return k < 0.35 ? "chirp" : k < 0.6 ? "whirr" : k < 0.85 ? "bubble" : null;
}

/** Small seeded random (mulberry32): the lab sounds vary, tests stay reproducible. */
export function rng(seed = Date.now()) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------- the engine
/** The audio graph and its scheduler. `ctx` defaults to a live AudioContext (an OfflineAudioContext works for checks). */
export function createEngine(ctx = null) {
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!ctx && !AC) return null;
  ctx ??= new AC();
  const master = ctx.createGain();
  master.gain.value = 0;
  const tone = ctx.createBiquadFilter(); // everything a little warm: no harsh highs
  tone.type = "lowpass";
  tone.frequency.value = 2400; // warm: no bright highs
  tone.connect(master).connect(ctx.destination);

  // a small room: a generated impulse (decaying noise), mixed in quietly
  const room = ctx.createConvolver();
  const len = ctx.sampleRate * 3.2;
  const ir = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const d = ir.getChannelData(ch);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len) ** 2.6;
  }
  room.buffer = ir;
  const wet = ctx.createGain();
  wet.gain.value = 0.55;
  room.connect(wet).connect(tone);
  // a soft echo for the glass notes
  const echo = ctx.createDelay(1.5);
  echo.delayTime.value = 0.42;
  const fb = ctx.createGain();
  fb.gain.value = 0.32;
  echo.connect(fb).connect(echo);
  echo.connect(room);
  const bus = (dry = 1) => {
    const g = ctx.createGain();
    g.gain.value = dry;
    g.connect(tone);
    g.connect(room);
    return g;
  };
  const padBus = bus(0.5);
  const glassBus = bus(0.6);
  glassBus.connect(echo);
  const labBus = bus(0.45);

  function pad(notes, t, dur) {
    for (const n of notes) {
      for (const detune of [-6, 5]) {
        const o = ctx.createOscillator();
        o.type = n < 50 ? "sine" : "triangle";
        o.frequency.value = freq(n);
        o.detune.value = detune;
        const g = ctx.createGain();
        const peak = n < 50 ? 0.07 : 0.028;
        g.gain.setValueAtTime(0, t);
        g.gain.linearRampToValueAtTime(peak, t + 3);
        g.gain.setValueAtTime(peak, t + dur - 1);
        g.gain.linearRampToValueAtTime(0, t + dur + 3.5); // overlaps the next chord: no gaps
        o.connect(g).connect(padBus);
        o.start(t);
        o.stop(t + dur + 4);
      }
    }
  }
  function glass(n, t, beats = 1) {
    const ring = Math.min(4, 1.2 + beats * BEAT_S); // longer notes ring longer
    const o = ctx.createOscillator();
    o.type = "sine";
    o.frequency.value = freq(n);
    const mod = ctx.createOscillator(); // a touch of FM for a glassy shimmer
    mod.frequency.value = freq(n) * 2.01;
    const modGain = ctx.createGain();
    modGain.gain.setValueAtTime(freq(n) * 0.12, t); // a hint of shimmer, not a bell
    modGain.gain.exponentialRampToValueAtTime(1, t + 1.2);
    mod.connect(modGain).connect(o.frequency);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.055, t + 0.04); // a soft onset, no click
    g.gain.exponentialRampToValueAtTime(0.0001, t + ring);
    o.connect(g).connect(glassBus);
    for (const x of [o, mod]) x.start(t), x.stop(t + ring + 0.2);
  }
  function pluck(n, t) { // the arpeggio: a short, round note under the melody
    const o = ctx.createOscillator();
    o.type = "triangle";
    o.frequency.value = freq(n);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.022, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.9);
    o.connect(g).connect(padBus);
    o.start(t);
    o.stop(t + 1);
  }
  function thump(t) { // a felt mallet on a wooden bench, once a bar
    const o = ctx.createOscillator();
    o.type = "sine";
    o.frequency.setValueAtTime(110, t);
    o.frequency.exponentialRampToValueAtTime(52, t + 0.18);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.06, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.4);
    o.connect(g).connect(tone); // dry: a pulse, not a wash
    o.start(t);
    o.stop(t + 0.45);
  }
  function tick(t) { // the lab clock: a soft, low wooden tock (no high tick)
    const o = ctx.createOscillator();
    o.type = "sine";
    o.frequency.value = 420;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.006, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.07);
    o.connect(g).connect(labBus);
    o.start(t);
    o.stop(t + 0.05);
  }
  function chirp(t) { // a small robot saying "hm?": two quick rising blips
    for (const [k, f0] of [[0, 620], [0.16, 780]]) { // low and round: a murmur, not a beep
      const o = ctx.createOscillator();
      o.type = "sine";
      o.frequency.setValueAtTime(f0, t + k);
      o.frequency.exponentialRampToValueAtTime(f0 * 1.35, t + k + 0.08);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t + k);
      g.gain.exponentialRampToValueAtTime(0.016, t + k + 0.03);
      g.gain.exponentialRampToValueAtTime(0.0001, t + k + 0.14);
      o.connect(g).connect(labBus);
      o.start(t + k);
      o.stop(t + k + 0.14);
    }
  }
  function whirr(t) { // a servo moving far away: band-passed noise sweeping up and back
    const dur = 1.1;
    const b = ctx.createBuffer(1, ctx.sampleRate * dur, ctx.sampleRate);
    const d = b.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    const s = ctx.createBufferSource();
    s.buffer = b;
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.Q.value = 9;
    bp.frequency.setValueAtTime(260, t);
    bp.frequency.linearRampToValueAtTime(520, t + dur * 0.5);
    bp.frequency.linearRampToValueAtTime(340, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.028, t + 0.3);
    g.gain.linearRampToValueAtTime(0, t + dur);
    s.connect(bp).connect(g).connect(labBus);
    s.start(t);
  }
  function bubble(t) { // a soft drop in a beaker
    const o = ctx.createOscillator();
    o.type = "sine";
    o.frequency.setValueAtTime(240, t);
    o.frequency.exponentialRampToValueAtTime(470, t + 0.18);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.028, t + 0.03);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.26);
    o.connect(g).connect(labBus);
    o.start(t);
    o.stop(t + 0.25);
  }

  // ---------------------------------------------------------------- scheduler: plays the shared timeline, 2 s ahead
  let g = 0, beatAt = 0, timer = null; // g = beat number on the shared timeline (every page agrees on it)
  function play(e, t) {
    if (e.kind === "pad") pad(e.notes, t, e.beats * BEAT_S);
    else if (e.kind === "arp") pluck(e.notes[0], t);
    else if (e.kind === "melody") glass(e.notes[0], t, e.beats);
    else if (e.kind === "thump") thump(t);
    else if (e.kind === "tick") tick(t);
  }
  const LAB = { chirp, whirr, bubble };
  function schedule() {
    const now = ctx.currentTime;
    const until = now + (ctx.length ? ctx.length / ctx.sampleRate : 2); // an offline render plans its whole length
    while (beatAt < until) {
      const t = Math.max(beatAt, now);
      for (const e of eventsAt(g)) play(e, t);
      const lab = labAt(g);
      if (lab) LAB[lab](t);
      g++;
      beatAt += BEAT_S;
    }
  }
  return {
    ctx,
    /** Starts (or re-syncs) at `elapsed` seconds into the shared timeline; the chord already sounding comes in at once. */
    start(elapsed = 0) {
      const now = ctx.currentTime;
      clearInterval(timer);
      g = Math.ceil(elapsed / BEAT_S - 1e-6);
      beatAt = now + Math.max(0.05, g * BEAT_S - elapsed);
      const left = (8 - (((g % 8) + 8) % 8)) % 8; // beats until the next chord change
      if (left) pad(chordAt(g - 1), now, left * BEAT_S + 0.5);
      schedule();
      timer = setInterval(schedule, 500);
      master.gain.cancelScheduledValues(now);
      master.gain.setValueAtTime(master.gain.value, now);
      master.gain.linearRampToValueAtTime(VOLUME, now + 1.5); // a short fade: it continues, it does not begin
    },
    stop() {
      const now = ctx.currentTime;
      master.gain.cancelScheduledValues(now);
      master.gain.setValueAtTime(master.gain.value, now);
      master.gain.linearRampToValueAtTime(0, now + 0.6);
      clearInterval(timer);
      timer = null;
      setTimeout(() => !timer && ctx.suspend(), 700);
    },
  };
}

// ---------------------------------------------------------------- the toggle
let engine = null;
let on = false;
const wanted = () => {
  try {
    return localStorage.getItem(KEY) === "on"; // off unless the visitor turned it on
  } catch {
    return false;
  }
};
const remember = (v) => {
  try {
    if (v) localStorage.setItem(KEY, "on");
    else localStorage.removeItem(KEY);
  } catch {} // storage blocked: the choice lasts for this page
};
const buttons = new Set();
const sync = () => buttons.forEach((b) => b.setAttribute("aria-pressed", String(on)));

/** Seconds since the site's music clock started in this browser (set once, shared by every page and tab). */
function elapsed() {
  let epoch = 0;
  try {
    epoch = Number(localStorage.getItem(EPOCH_KEY)) || 0;
    if (!epoch) localStorage.setItem(EPOCH_KEY, String((epoch = Date.now())));
  } catch {
    epoch = pageEpoch;
  }
  return Math.max(0, (Date.now() - epoch) / 1000);
}
const EPOCH_KEY = "ofx-music-clock";
const pageEpoch = Date.now();

/** Resumes the audio and plays from the shared position. false while the browser still waits for a gesture. */
let starting = null; // one start at a time: repeated gestures must not schedule the loop twice
function play() {
  return (starting ??= start().finally(() => (starting = null)));
}
async function start() {
  engine ??= createEngine();
  if (!engine) return false;
  await Promise.race([engine.ctx.resume().catch(() => {}), new Promise((r) => setTimeout(r, 300))]);
  if (!on) return false; // turned off while the audio was waking up
  if (engine.ctx.state !== "running") return (document.documentElement.dataset.music = "waiting"), false;
  engine.start(elapsed());
  document.documentElement.dataset.music = "playing"; // also read by tests: "playing" | "waiting" | "off"
  return true;
}

async function setMusic(v) {
  on = v;
  remember(v);
  sync();
  if (v) await play();
  else engine?.stop(), (document.documentElement.dataset.music = "off");
}

if (typeof document !== "undefined") {
  // silent while the page is hidden; on return it re-joins the shared position
  document.addEventListener("visibilitychange", () => {
    if (!engine || !on) return;
    if (document.hidden) engine.ctx.suspend();
    else play();
  });
  // turned on by the visitor on an earlier page: continue at once where the last page left off if the browser allows sound
  // here, otherwise at the first click, tap or key
  if (wanted() && (window.AudioContext || window.webkitAudioContext)) {
    on = true;
    const kick = async (e) => {
      if (e.target?.closest?.(".music-btn")) return; // the button itself decides
      if (!on || (await play())) unkick();
    };
    const GESTURES = ["mousedown", "pointerup", "touchend", "keydown"]; // on touch only the end of a tap allows audio
    const unkick = () => GESTURES.forEach((t) => removeEventListener(t, kick, true));
    GESTURES.forEach((t) => addEventListener(t, kick, true));
    play().then((ok) => ok && unkick());
  }
}

/** The ♪ toggle (aria-pressed = music on). `className` styles it for the page it sits in. */
export function musicButton(className = "btn sm ghost music-btn") {
  const b = document.createElement("button");
  b.type = "button";
  b.className = `${className}${className.includes("music-btn") ? "" : " music-btn"}`;
  b.innerHTML = '<svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 12V3.5l7-1.5v8.5"/><circle cx="4.3" cy="12" r="1.8"/><circle cx="11.3" cy="10.5" r="1.8"/><path class="mus-off" d="M2 2l12 12"/></svg><span class="nav-txt">Music</span>';
  b.title = "Background music";
  b.setAttribute("aria-label", "Background music");
  b.onclick = () => setMusic(!on);
  buttons.add(b);
  sync();
  if (!(window.AudioContext || window.webkitAudioContext)) b.hidden = true; // no Web Audio: nothing to offer
  return b;
}
