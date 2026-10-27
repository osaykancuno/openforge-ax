const { expect } = require("chai");

// Lab ambient (web/js/ambient.js): the composed loop is pure, so it is checked here; the audio graph is checked in a
// browser with an OfflineAudioContext (level and no clipping), since Node has no Web Audio.
describe("Lab ambient music loop (web/js/ambient.js)", () => {
  let A;
  before(async () => {
    A = await import("../web/js/ambient.js");
  });
  const C_MAJOR = new Set([0, 2, 4, 5, 7, 9, 11]);
  const PENTA = new Set([0, 2, 4, 7, 9]);

  it("a slow 16-bar loop: 72 BPM, about 53 s, chords every two bars", () => {
    expect(A.BPM).to.equal(72);
    expect(A.LOOP_BEATS).to.equal(64);
    expect(A.LOOP_BEATS * A.BEAT_S).to.be.closeTo(53.33, 0.01);
    const pads = [];
    for (let b = 0; b < A.LOOP_BEATS; b++) for (const e of A.eventsAt(b)) if (e.kind === "pad") pads.push(b);
    expect(pads).to.deep.equal([0, 8, 16, 24, 32, 40, 48, 56]);
    expect(A.freq(69)).to.equal(440);
  });

  it("calm harmony: every chord and arpeggio note is in C major, every melody note in C pentatonic", () => {
    for (const chord of A.CHORDS) for (const n of chord) expect(C_MAJOR.has(n % 12), `chord ${n}`).to.equal(true);
    for (let b = 0; b < A.LOOP_BEATS; b++)
      for (const e of A.eventsAt(b)) {
        if (e.kind === "arp") expect(C_MAJOR.has(e.notes[0] % 12)).to.equal(true);
        if (e.kind === "melody") {
          expect(PENTA.has(e.notes[0] % 12), `melody ${e.notes[0]}`).to.equal(true);
          expect(A.SCALE).to.include(e.notes[0]);
        }
      }
  });

  it("the melody never overlaps itself, fits the loop, moves by small leaps and comes home to C", () => {
    let end = 0;
    for (const [at, n, len] of A.MELODY) {
      expect(at, `note at ${at}`).to.be.at.least(end);
      end = at + len;
    }
    expect(end).to.equal(A.LOOP_BEATS); // the last note ends exactly where the loop starts again
    for (let i = 1; i < A.MELODY.length; i++) expect(Math.abs(A.MELODY[i][1] - A.MELODY[i - 1][1]), `leap at ${A.MELODY[i][0]}`).to.be.at.most(7);
    expect(A.MELODY.at(-1)[1] % 12).to.equal(0);
  });

  it("seamless: the beat after the last one is beat 0 again", () => {
    expect(A.eventsAt(A.LOOP_BEATS)).to.deep.equal(A.eventsAt(0));
    expect(A.eventsAt(-1)).to.deep.equal(A.eventsAt(A.LOOP_BEATS - 1));
    const a = A.rng(42), b = A.rng(42);
    for (let k = 0; k < 10; k++) expect(a()).to.equal(b());
  });

  it("one track for the site: the lab sounds sit at fixed beats of the shared timeline, the same on every page", () => {
    for (let g = 0; g < A.LOOP_BEATS * 6; g++) {
      const k = A.labAt(g);
      expect(k, `beat ${g}`).to.equal(A.labAt(g)); // pure: two pages compute the same sound for the same beat
      if (k) expect(A.LAB_SLOTS).to.include(g % A.LOOP_BEATS);
      if (k) expect(["chirp", "whirr", "bubble"]).to.include(k);
    }
    const passes = new Set();
    for (let pass = 0; pass < 6; pass++) passes.add(A.LAB_SLOTS.map((b) => A.labAt(pass * A.LOOP_BEATS + b)).join());
    expect(passes.size).to.be.greaterThan(1); // varied from one loop to the next
  });
});
