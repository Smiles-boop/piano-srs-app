// Tests for playback.js — the synth "Listen" engine behind the whole-piece
// player and the practice panel's Listen button.
//
// The pure timeline builder is tested directly; the engine is driven through
// a minimal AudioContext mock (no real audio in Node) with a controllable
// clock so onStep / onTime / onEnd ordering can be asserted deterministically.
//
// Run from the project root:
//   node tests/playback.test.mjs

import assert from 'node:assert/strict';

// playback.js reads midi.js's groupNotesIntoSteps as a global in the browser.
const midi = await import('../midi.js');
globalThis.groupNotesIntoSteps = midi.groupNotesIntoSteps;

// --- Minimal Web Audio mock ------------------------------------------------
class MockAudioContext {
  constructor() {
    this.state = 'running';
    this.currentTime = 0;
    this.destination = { kind: 'destination' };
    this.oscillators = [];
    this.closed = false;
  }
  resume() { this.state = 'running'; return Promise.resolve(); }
  close() { this.closed = true; return Promise.resolve(); }
  createOscillator() {
    const osc = {
      type: 'sine',
      frequency: { value: 0 },
      started: null,
      stopped: null,
      connect(n) { return n; },
      start(t) { this.started = t; },
      stop(t) { this.stopped = t; },
    };
    this.oscillators.push(osc);
    return osc;
  }
  createGain() {
    return {
      gain: {
        value: 1,
        setValueAtTime() {},
        exponentialRampToValueAtTime() {},
      },
      connect(n) { return n; },
    };
  }
  createDynamicsCompressor() {
    return { connect(n) { return n; } };
  }
}
globalThis.AudioContext = MockAudioContext;

const mod = await import('../playback.js');
const {
  createPiecePlayback,
  buildPlaybackTimeline,
  PLAYBACK_LEAD_SEC,
  PLAYBACK_MIN_NOTE_SEC,
} = mod;

const TPQ = 480;
/** Quick note factory: quarter-note grid at 120 BPM (0.5 s per quarter). */
const note = (midi, q, lenQ = 1, extra = {}) => ({
  midi,
  startTick: q * TPQ,
  endTick: (q + lenQ) * TPQ,
  startSec: q * 0.5,
  endSec: (q + lenQ) * 0.5,
  track: 0,
  ...extra,
});

// --- buildPlaybackTimeline -------------------------------------------------
{
  const empty = buildPlaybackTimeline([]);
  assert.deepEqual(empty, { base: 0, total: 0, events: [], steps: [] }, 'empty in → empty timeline');
  assert.deepEqual(buildPlaybackTimeline(null).events, [], 'null tolerated');
}
{
  // Piece with a two-quarter lead-in rest: base defaults to the first onset.
  const notes = [note(60, 2), note(64, 2), note(67, 3, 2)];
  const tl = buildPlaybackTimeline(notes, { ticksPerQuarter: TPQ });
  assert.equal(tl.base, 1.0, 'base = first onset (t=1.0s)');
  assert.equal(tl.events.length, 3, 'one event per note');
  assert.equal(tl.events[0].at, 0, 'first note at t=0 relative');
  assert.equal(tl.events[2].at, 0.5, 'third note 0.5s after base');
  assert.equal(tl.events[2].dur, 1.0, 'half-note lasts 1.0s');
  assert.equal(tl.total, 1.5, 'total = last onset + its duration');
  // Steps: the chord (60+64) is one step, then 67.
  assert.equal(tl.steps.length, 2, 'chord grouped into one step');
  assert.deepEqual(tl.steps[0].pitches, [60, 64], 'chord pitches');
  assert.equal(tl.steps[0].tick, 2 * TPQ, 'step tick is absolute');
  assert.equal(tl.steps[0].at, 0, 'first step at t=0');
  assert.equal(tl.steps[1].at, 0.5, 'second step at 0.5');
  assert.equal(tl.steps[0].index, 0);
  assert.equal(tl.steps[1].total, 2, 'each step knows the step count');
}
{
  // fromSec anchors t=0 earlier than the first onset (a hand's lead-in rest
  // inside a section is preserved) …
  const tl = buildPlaybackTimeline([note(60, 2)], { fromSec: 0.5 });
  assert.equal(tl.base, 0.5, 'fromSec honoured when earlier than first onset');
  assert.equal(tl.events[0].at, 0.5, 'note scheduled after the rest');
  // … but a fromSec AFTER the first onset is clamped so nothing is scheduled
  // in the past.
  const tl2 = buildPlaybackTimeline([note(60, 2)], { fromSec: 5 });
  assert.equal(tl2.base, 1.0, 'late fromSec clamped to first onset');
  assert.equal(tl2.events[0].at, 0);
}
{
  // Very short / zero-length notes get a floor so they're audible.
  const n = note(60, 0, 0);
  n.endSec = n.startSec;
  const tl = buildPlaybackTimeline([n]);
  assert.equal(tl.events[0].dur, PLAYBACK_MIN_NOTE_SEC, 'zero-length note floored');
  // Malformed entries are skipped rather than throwing.
  const tl2 = buildPlaybackTimeline([null, { midi: 60 }, note(62, 0)]);
  assert.equal(tl2.events.length, 1, 'entries without timing dropped');
}

// --- createPiecePlayback: schedule + follow + end ---------------------------
// The follow clock is a 30 ms timer; wait a little longer than one period.
const tickAsync = (ms = 45) => new Promise((r) => setTimeout(r, ms));

{
  const steps = [];
  const times = [];
  const ends = [];
  const pb = createPiecePlayback({
    onStep: (s) => steps.push(s.tick),
    onTime: (e, t) => times.push([e, t]),
    onEnd: (info) => ends.push(info.completed),
  });
  assert.equal(pb.isPlaying(), false, 'idle initially');
  assert.deepEqual(pb.getPosition(), { elapsed: 0, total: 0 }, 'idle position');
  assert.equal(pb.play([]), false, 'no notes → does not start');
  assert.equal(pb.isPlaying(), false);

  const notes = [note(60, 0), note(64, 0), note(67, 1)];
  const started = pb.play(notes, { ticksPerQuarter: TPQ });
  assert.equal(started, true, 'play() with notes starts');
  assert.equal(pb.isPlaying(), true, 'playing after play()');
  assert.equal(times.length, 1, 'onTime fired once immediately');
  assert.deepEqual(times[0], [0, 1.0], 'initial onTime(0, total)');
  assert.equal(steps.length, 0, 'no step before the lead-in has elapsed');

  pb.stop();
  assert.equal(pb.isPlaying(), false, 'stop() ends playback');
  assert.deepEqual(ends, [false], 'stop() → onEnd(completed:false)');
  pb.dispose();
}

// A borrowed context lets the test own the clock.
{
  const ctx = new MockAudioContext();
  const steps = [];
  const ends = [];
  let lastTime = null;
  const pb = createPiecePlayback({
    audioContext: () => ctx,
    onStep: (s) => steps.push(s),
    onTime: (e, t) => { lastTime = [e, t]; },
    onEnd: (info) => ends.push(info.completed),
  });

  const notes = [note(60, 0), note(64, 0), note(67, 1)]; // chord then note; total 1.0s
  ctx.currentTime = 10;
  assert.equal(pb.play(notes, { ticksPerQuarter: TPQ }), true);
  // Every note got an oscillator scheduled relative to t0 = now + lead.
  assert.equal(ctx.oscillators.length, 3, 'one oscillator per note');
  assert.ok(
    Math.abs(ctx.oscillators[0].started - (10 + PLAYBACK_LEAD_SEC)) < 1e-9,
    'first note scheduled at now + lead',
  );
  assert.ok(
    Math.abs(ctx.oscillators[2].started - (10 + PLAYBACK_LEAD_SEC + 0.5)) < 1e-9,
    'third note scheduled 0.5s later',
  );

  // Clock at the first onset → chord step fires once.
  ctx.currentTime = 10 + PLAYBACK_LEAD_SEC;
  await tickAsync();
  assert.equal(steps.length, 1, 'first step fired at its onset');
  assert.deepEqual(steps[0].pitches, [60, 64], 'chord step first');
  assert.equal(steps[0].tick, 0);
  await tickAsync();
  assert.equal(steps.length, 1, 'a step fires only once');
  assert.ok(lastTime && lastTime[1] === 1.0, 'onTime reports total 1.0');
  assert.ok(Math.abs(lastTime[0] - 0) < 1e-9, 'elapsed 0 at first onset');

  // Clock at the second onset.
  ctx.currentTime = 10 + PLAYBACK_LEAD_SEC + 0.5;
  await tickAsync();
  assert.equal(steps.length, 2, 'second step fired');
  assert.equal(steps[1].tick, TPQ);
  const pos = pb.getPosition();
  assert.ok(Math.abs(pos.elapsed - 0.5) < 1e-9 && pos.total === 1.0, 'getPosition tracks the clock');

  // Restarting play() while playing ends the first run (completed:false)
  // and starts fresh — the old oscillators are stopped early.
  ctx.currentTime = 20;
  assert.equal(pb.play([note(72, 0)], { ticksPerQuarter: TPQ }), true);
  assert.deepEqual(ends, [false], 'superseded run reported as not completed');
  assert.ok(ctx.oscillators.slice(0, 3).every((o) => o.stopped !== null), 'old oscillators stopped');
  assert.equal(pb.isPlaying(), true, 'new run is playing');

  // Let the new run finish via its end timer (0.2 lead + 0.5 dur + 0.15 tail).
  await tickAsync(950);
  assert.equal(pb.isPlaying(), false, 'run finished on its own');
  assert.deepEqual(ends, [false, true], 'natural end → onEnd(completed:true)');
  assert.deepEqual(lastTime, [0.5, 0.5], 'final onTime pins elapsed to total');
  assert.deepEqual(pb.getPosition(), { elapsed: 0, total: 0 }, 'position resets when idle');

  // stop() when idle is a no-op (no extra onEnd).
  pb.stop();
  assert.deepEqual(ends, [false, true], 'idle stop() does not fire onEnd');

  // A borrowed context is never closed by dispose().
  pb.dispose();
  assert.equal(ctx.closed, false, 'borrowed context left open on dispose');
}

// Own-context lifecycle: dispose() closes the context the engine created.
{
  let created = null;
  globalThis.AudioContext = class extends MockAudioContext {
    constructor() { super(); created = this; }
  };
  const pb = createPiecePlayback();
  pb.play([note(60, 0)]);
  assert.ok(created, 'engine created its own context lazily');
  pb.dispose();
  assert.equal(created.closed, true, 'own context closed on dispose');
  assert.equal(pb.isPlaying(), false);
  globalThis.AudioContext = MockAudioContext;
}

console.log('playback: all assertions passed');
