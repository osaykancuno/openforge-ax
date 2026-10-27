// Voice requests for the AI Pilot: the browser's own speech recognition turns one spoken sentence into text, which then
// goes through exactly the same path as a typed request (parser or model, plan card, the same safety rules: the AI
// never arms the robot, STOP and Esc always win). Nothing here moves anything by itself.
// Chrome and Edge provide it (on Android it can run on the phone); where it is missing the button stays hidden.

/** The SpeechRecognition constructor of this browser, or null. */
export const recognitionCtor = (g = globalThis) => g.SpeechRecognition || g.webkitSpeechRecognition || null;

/**
 * createVoiceInput({ Ctor, lang }) -> { supported, listening, start(onText, onState), stop() }
 * onText(text) gets the final transcript once; onState("listening" | "idle" | "error:<code>") follows the microphone.
 */
export function createVoiceInput({ Ctor = recognitionCtor(), lang = "en-US" } = {}) {
  let rec = null;
  const api = {
    supported: Boolean(Ctor),
    listening: false,
    start(onText, onState = () => {}) {
      if (!Ctor || api.listening) return false;
      rec = new Ctor();
      rec.lang = lang;
      rec.interimResults = false;
      rec.maxAlternatives = 1;
      rec.continuous = false; // one request at a time, like the text box
      let said = "";
      rec.onresult = (e) => {
        const r = e.results?.[e.results.length - 1];
        if (r?.isFinal !== false) said = String(r?.[0]?.transcript ?? "").trim().slice(0, 500); // the text box's own limit
      };
      rec.onerror = (e) => onState(`error:${e.error || "unknown"}`);
      rec.onend = () => {
        api.listening = false;
        rec = null;
        onState("idle");
        if (said) onText(said);
      };
      api.listening = true;
      onState("listening");
      try {
        rec.start();
      } catch {
        api.listening = false;
        rec = null;
        onState("error:start");
        return false;
      }
      return true;
    },
    stop() {
      rec?.stop();
    },
  };
  return api;
}
