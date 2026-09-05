// Mic pitch-detection tests.
//
// The browser controller needs Web Audio + getUserMedia, so we test the pure
// DSP core: Hz↔MIDI conversion, spectral flux, peak picking, and — the heart
// of the feature — polyphonic pitch estimation on synthetic piano-like
// spectra (fundamental + partials decaying ~1/h^0.9, on a small noise floor).
//
// Note on transients: a triangle-wave metronome click IS a harmonically valid
// pitched sound, so the frame-level estimator alone cannot reject it — the
// browser controller kills it with the persistence check (unexpected notes
// must survive CONFIRM_FRAMES extra frames; a 60 ms click doesn't). Here we
// verify the estimator's own guards: pure tones, ghost octaves, ghost
// subharmonics, and wrong-note evidence.

import { strict as assert } from 'node:assert';

const {
  midiToHz,
  hzToMidi,
  computeSpectralFlux,
  findSpectralPeaks,
  estimatePitches,
  MIC_FFT_SIZE,
} = await import('../micpitch.js');

const SR = 48000;
const N = MIC_FFT_SIZE; // 8192
const BINS = N / 2;
const binHz = SR / N;

// ---- Synthetic spectra ----------------------------------------------------

/** Fresh magnitude frame with a small deterministic noise floor. */
function makeFrame() {
  const m = new Float32Array(BINS);
  for (let i = 0; i < BINS; i++) {
    m[i] = 1e-6 * (1 + ((i * 2654435761) >>> 16) % 97 / 97);
  }
  return m;
}

/** Add a narrow spectral peak (Gaussian, ~1 bin wide) at `freq`. */
function addPeak(m, freq, amp) {
  const c = freq / binHz;
  for (let i = Math.max(0, Math.floor(c) - 4); i <= Math.min(BINS - 1, Math.ceil(c) + 4); i++) {
    const d = i - c;
    m[i] += amp * Math.exp(-(d * d) / (2 * 0.6 * 0.6));
  }
}

/** Add a piano-like note: partials at h·f0 (slightly stretched), ~1/h^0.9. */
function addNote(m, midi, amp = 1) {
  const f0 = midiToHz(midi);
  for (let h = 1; h <= 12; h++) {
    const fh = h * f0 * (1 + 0.0001 * h * h);
    if (fh > 8800) break;
    addPeak(m, fh, amp / Math.pow(h, 0.9));
  }
}

function detect(m, expected = null) {
  return estimatePitches(m, {
    sampleRate: SR,
    fftSize: N,
    expected: expected ? new Set(expected) : null,
  }).map((r) => r.midi).sort((a, b) => a - b);
}

// ---- Hz ↔ MIDI --------------------------------------------------------------
assert.equal(hzToMidi(440), 69, 'A4 = 440 Hz = MIDI 69');
assert.ok(Math.abs(midiToHz(60) - 261.626) < 0.01, 'C4 ≈ 261.63 Hz');
for (const midi of [21, 48, 60, 72, 108]) {
  assert.ok(Math.abs(hzToMidi(midiToHz(midi)) - midi) < 1e-9, `round-trip ${midi}`);
}

// ---- Spectral flux ----------------------------------------------------------
{
  const a = makeFrame();
  const b = makeFrame();
  addNote(b, 60, 1);
  const rising = computeSpectralFlux(b, a, 2, BINS);
  const falling = computeSpectralFlux(a, b, 2, BINS);
  assert.ok(rising > falling * 10, 'attack spikes flux; decay does not');
  assert.ok(computeSpectralFlux(a, a, 2, BINS) === 0, 'identical frames → zero flux');
}

// ---- Peak picking -----------------------------------------------------------
{
  const m = makeFrame();
  addPeak(m, 440, 1);
  addPeak(m, 880, 0.5);
  const peaks = findSpectralPeaks(m, SR, N);
  assert.equal(peaks.length, 2, 'finds exactly the two injected peaks');
  assert.ok(Math.abs(peaks[0].freq - 440) < binHz / 2, 'interpolated freq near 440');
  assert.ok(Math.abs(peaks[1].freq - 880) < binHz / 2, 'interpolated freq near 880');
}

// ---- Single note ------------------------------------------------------------
{
  const m = makeFrame();
  addNote(m, 60);
  assert.deepEqual(detect(m), [60], 'lone C4 → exactly [C4], no ghost octaves');
  assert.deepEqual(detect(m, [60]), [60], 'same with C4 expected');
}

// ---- Triad chord ------------------------------------------------------------
{
  const m = makeFrame();
  addNote(m, 60);
  addNote(m, 64);
  addNote(m, 67);
  assert.deepEqual(detect(m, [60, 64, 67]), [60, 64, 67], 'C-major triad, score-informed');
  // Blind (no expected set) must also find all three — they're real notes.
  assert.deepEqual(detect(m), [60, 64, 67], 'C-major triad, blind');
}

// ---- Octave chord (the classic hard case) -----------------------------------
{
  const m = makeFrame();
  addNote(m, 60);
  addNote(m, 72);
  assert.deepEqual(detect(m, [60, 72]), [60, 72], 'C4+C5 octave both detected');
}

// ---- Larger chord across both hands ------------------------------------------
{
  const m = makeFrame();
  for (const n of [48, 55, 64, 67, 72]) addNote(m, n); // C3 G3 E4 G4 C5
  const got = detect(m, [48, 55, 64, 67, 72]);
  assert.deepEqual(got, [48, 55, 64, 67, 72], 'five-note two-hand voicing');
}

// ---- Wrong note has strong evidence ------------------------------------------
{
  const m = makeFrame();
  addNote(m, 62); // played D4...
  const got = detect(m, [60]); // ...while C4 was expected
  assert.ok(got.includes(62), 'wrong note (D4) is still detected');
  assert.ok(!got.includes(60), 'expected-but-unplayed C4 is NOT hallucinated');
}

// ---- Pure tone (no harmonics) is rejected -------------------------------------
{
  const m = makeFrame();
  addPeak(m, 1000, 1); // sine-ish beep
  assert.deepEqual(detect(m), [], 'a pure tone lacks harmonic support → no note');
  // Even when B5 (987.8 Hz, close to the tone) is the expected note, a bare
  // sine must not pass — real piano notes always carry partials.
  assert.deepEqual(detect(m, [83]), [], 'expected-note bias cannot rescue a pure tone');
}

// ---- No subharmonic ghosts ----------------------------------------------------
{
  const m = makeFrame();
  addNote(m, 60);
  addNote(m, 67);
  const got = detect(m);
  assert.ok(!got.includes(48), 'C4+G4 must not conjure a ghost C3 (subharmonic)');
  assert.deepEqual(got, [60, 67], 'exactly the two played notes');
}

// ---- Silence ------------------------------------------------------------------
{
  const m = makeFrame();
  assert.deepEqual(detect(m), [], 'noise floor alone → nothing');
}

console.log('micpitch tests passed');
