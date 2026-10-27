const { expect } = require("chai");

// Voice requests (web/js/pilot/ai/voice.js) with a fake SpeechRecognition: one final sentence becomes one text request,
// errors and silence send nothing, and a browser without the API keeps the button hidden.
describe("AI Pilot voice input (web/js/pilot/ai/voice.js)", () => {
  let V;
  before(async () => (V = await import("../web/js/pilot/ai/voice.js")));

  const fake = (script) =>
    class {
      start() {
        this.started = true;
        queueMicrotask(() => script(this));
      }
      stop() {
        this.onend?.();
      }
    };
  const result = (text, isFinal = true) => ({ results: [Object.assign([{ transcript: text }], { isFinal })] });
  const run = (Ctor) =>
    new Promise((ok) => {
      const states = [], texts = [];
      const v = V.createVoiceInput({ Ctor, lang: "it-IT" });
      v.start((t) => texts.push(t), (s) => (states.push(s), s === "idle" && ok({ states, texts, v })));
    });

  it("is unsupported without the API", () => {
    expect(V.createVoiceInput({ Ctor: null }).supported).to.equal(false);
    expect(V.createVoiceInput({ Ctor: null }).start(() => {})).to.equal(false);
    expect(V.recognitionCtor({})).to.equal(null);
  });
  it("hands over one final, trimmed, length-capped sentence", async () => {
    const { states, texts, v } = await run(fake((r) => (r.onresult(result("  wave, then look left ")), r.onend())));
    expect(texts).to.deep.equal(["wave, then look left"]);
    expect(states).to.deep.equal(["listening", "idle"]);
    expect(v.listening).to.equal(false);
    const long = await run(fake((r) => (r.onresult(result("x".repeat(900))), r.onend())));
    expect(long.texts[0]).to.have.length(500);
  });
  it("sends nothing on an error or on silence", async () => {
    const err = await run(fake((r) => (r.onerror({ error: "not-allowed" }), r.onend())));
    expect(err.texts).to.deep.equal([]);
    expect(err.states).to.include("error:not-allowed");
    expect((await run(fake((r) => r.onend()))).texts).to.deep.equal([]);
  });
});
