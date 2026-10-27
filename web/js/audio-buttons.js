// The nav's two audio toggles (interface sounds, music), split from the audio code so a page does not download it
// before it is needed. The buttons themselves (markup, aria-pressed from the saved choice, hidden without Web Audio)
// need no audio engine; ui-sounds.js (3 KB gz) loads on the first pointer or key event, ambient.js (6 KB gz) on the
// first click of the ♪ button, or at once when the visitor left the music on (so it continues across pages).
// Browsers play nothing before a gesture anyway, so the visitor hears the same site.
export const SOUNDS_KEY = "ofx-sounds";
export const MUSIC_KEY = "ofx-music";

const webAudio = () => typeof window !== "undefined" && Boolean(window.AudioContext || window.webkitAudioContext);
const stored = (k) => {
  try {
    return localStorage.getItem(k);
  } catch {
    return null; // storage blocked: the defaults (sounds on, music off), for this page
  }
};
/** Interface sounds are on unless the visitor turned them off. */
export const soundsWanted = () => stored(SOUNDS_KEY) !== "off";
/** The music is off unless the visitor turned it on (and the browser has Web Audio). */
export const musicWanted = () => stored(MUSIC_KEY) === "on" && webAudio();

const SPEAKER = '<svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 6h2.5l3.5-3v10l-3.5-3H2.5z"/><path class="snd-wave" d="M11 5.5a3.5 3.5 0 0 1 0 5M12.8 3.8a6 6 0 0 1 0 8.4"/><path class="snd-off" d="M11 6l3.5 4M14.5 6L11 10"/></svg>';
const NOTE = '<svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 12V3.5l7-1.5v8.5"/><circle cx="4.3" cy="12" r="1.8"/><circle cx="11.3" cy="10.5" r="1.8"/><path class="mus-off" d="M2 2l12 12"/></svg>';

/** The interface-sounds toggle (aria-pressed = sounds on), not yet wired. `className` styles it for the page it sits in. */
export function soundsDom(className = "btn sm ghost sound-btn") {
  const b = document.createElement("button");
  b.type = "button";
  b.className = `${className}${className.includes("sound-btn") ? "" : " sound-btn"}`;
  b.innerHTML = `${SPEAKER}<span class="nav-txt">Sounds</span>`;
  b.title = "Interface sounds (turn off if you use a screen reader)";
  b.setAttribute("aria-label", "Interface sounds");
  b.dataset.sound = "none"; // it plays its own sound, after turning on
  b.setAttribute("aria-pressed", String(soundsWanted()));
  if (!webAudio()) b.hidden = true; // no Web Audio: nothing to offer
  return b;
}

/** The ♪ toggle (aria-pressed = music on), not yet wired. */
export function musicDom(className = "btn sm ghost music-btn") {
  const b = document.createElement("button");
  b.type = "button";
  b.className = `${className}${className.includes("music-btn") ? "" : " music-btn"}`;
  b.innerHTML = `${NOTE}<span class="nav-txt">Music</span>`;
  b.title = "Background music";
  b.setAttribute("aria-label", "Background music");
  b.setAttribute("aria-pressed", String(musicWanted()));
  if (!webAudio()) b.hidden = true;
  return b;
}

/**
 * Wires the two buttons built above to the audio modules, loaded on demand (`load` is for tests). A click on a button
 * that is still waiting for its module toggles once the module is in, exactly once per click.
 */
export function lazyAudio(soundsBtn, musicBtn, { load = (name) => (name === "ui-sounds" ? import("./ui-sounds.js") : import("./ambient.js")) } = {}) {
  let sounds = null, music = null;
  const loadSounds = () => (sounds ??= load("ui-sounds").then((m) => (m.adoptSoundsButton(soundsBtn), m)).catch((e) => ((sounds = null), Promise.reject(e))));
  const loadMusic = () => (music ??= load("ambient").then((m) => (m.adoptMusicButton(musicBtn), m)).catch((e) => ((music = null), Promise.reject(e))));
  // a failed download (offline, blocked) leaves the button as it was; the next click or gesture asks again
  soundsBtn.onclick = () => loadSounds().then((m) => m.toggleSounds()).catch(() => {});
  musicBtn.onclick = () => loadMusic().then((m) => m.toggleMusic()).catch(() => {});
  if (typeof addEventListener === "function") {
    const GESTURES = ["pointerdown", "pointermove", "touchstart", "keydown"]; // the first of them: the module is in before the click that follows
    const listen = () => GESTURES.forEach((t) => addEventListener(t, wake, { capture: true, passive: true }));
    const wake = () => (GESTURES.forEach((t) => removeEventListener(t, wake, true)), loadSounds().catch(listen)); // failed: the next gesture asks again
    listen();
    // a tap's pointerdown comes too late for its own click (the download is async), so the module also loads once the
    // page is idle: importing it only adds listeners, the AudioContext is still created by the first gesture
    if (soundsWanted()) (window.requestIdleCallback || ((f) => setTimeout(f, 1500)))(() => loadSounds().catch(() => {}), { timeout: 2000 });
  }
  if (musicWanted()) loadMusic().catch(() => {}); // left on in an earlier page: continue at once
  return { loadSounds, loadMusic };
}
