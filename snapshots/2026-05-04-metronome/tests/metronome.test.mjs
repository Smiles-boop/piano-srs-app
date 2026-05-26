// Metronome module tests (item 12b).
//
// The metronome uses Web Audio API which isn't available in Node, so we test
// the pure-logic parts: BPM clamping, tap-tempo averaging, and state
// transitions. We mock AudioContext minimally so start/stop don't throw.

import { strict as assert } from 'node:assert';

// Minimal AudioContext shim so createMetronome() can instantiate one.
globalThis.AudioContext = class MockAudioContext {
  constructor() {
    this.state = 'running';
    this.currentTime = 0;
    this.destination = {};
  }
  resume() { return Promise.resolve(); }
  close() { return Promise.resolve(); }
  createOscillator() {
    return {
      type: 'triangle',
      frequency: { value: 440 },
      connect() {},
      start() {},
      stop() {},
    };
  }
  createGain() {
    return {
      gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} },
      connect() {},
    };
  }
};

// Provide performance.now for tap-tempo.
if (typeof performance === 'undefined') {
  globalThis.performance = { now: () => Date.now() };
}

const { createMetronome, MIN_BPM, MAX_BPM, DEFAULT_BPM } = await import('../metronome.js');

// --- Exports ---
assert.equal(MIN_BPM, 30, 'MIN_BPM should be 30');
assert.equal(MAX_BPM, 300, 'MAX_BPM should be 300');
assert.equal(DEFAULT_BPM, 100, 'DEFAULT_BPM should be 100');

// --- Default state ---
{
  const m = createMetronome();
  assert.equal(m.getBpm(), 100, 'default BPM is 100');
  assert.equal(m.isRunning(), false, 'not running initially');
  m.dispose();
}

// --- setBpm clamping ---
{
  const m = createMetronome();
  m.setBpm(60);
  assert.equal(m.getBpm(), 60, 'setBpm(60)');
  m.setBpm(10);
  assert.equal(m.getBpm(), MIN_BPM, 'clamped to MIN_BPM');
  m.setBpm(999);
  assert.equal(m.getBpm(), MAX_BPM, 'clamped to MAX_BPM');
  m.setBpm(72.6);
  assert.equal(m.getBpm(), 73, 'rounds to nearest integer');
  m.setBpm(NaN);
  assert.equal(m.getBpm(), 73, 'NaN is ignored');
  m.setBpm('120');
  assert.equal(m.getBpm(), 120, 'string coercion');
  m.dispose();
}

// --- start / stop ---
{
  const m = createMetronome();
  m.start();
  assert.equal(m.isRunning(), true, 'running after start');
  m.stop();
  assert.equal(m.isRunning(), false, 'stopped after stop');
  m.dispose();
}

// --- onTick registration ---
{
  const m = createMetronome();
  let called = false;
  m.onTick(() => { called = true; });
  // We can't easily trigger the scheduler in Node, but verify the listener
  // was registered without throwing.
  assert.equal(called, false, 'tick not fired until scheduler runs');
  m.dispose();
}

// --- tap-tempo (simulated) ---
{
  const m = createMetronome();
  // Simulate taps at 120 BPM = 500ms apart.
  const origNow = performance.now;
  let fakeTime = 1000;
  performance.now = () => fakeTime;

  m.tap(); // first tap
  fakeTime += 500;
  const bpm2 = m.tap(); // second tap → should compute ~120
  assert.equal(bpm2, 120, 'tap-tempo 2 taps at 500ms → 120 BPM');
  assert.equal(m.getBpm(), 120, 'getBpm reflects tap result');

  fakeTime += 500;
  m.tap(); // third tap
  assert.equal(m.getBpm(), 120, '3 taps at 500ms still 120 BPM');

  performance.now = origNow;
  m.dispose();
}

console.log('All metronome tests passed.');
