// Tests for the pure MIDI parser + sectioning helpers in midi.js.
//
// All helpers are pure (no DOM, no audio, no Date.now). We hand-build a tiny
// Standard MIDI File in memory so the parse path is exercised without any
// fixture files.
//
// Run from the project root:
//   node tests/midi.test.mjs

import assert from 'node:assert/strict';

const mod = await import('../midi.js');
const {
  parseMidi,
  sectionizeByPhrase,
  makeDerivedRanges,
  groupNotesIntoSteps,
  notesInSection,
} = mod;

// --- tiny SMF encoder ----------------------------------------------------

/** Variable-length quantity encoder (MSB-first, continuation bits). */
function vlq(value) {
  const out = [value & 0x7f];
  value = Math.floor(value / 128);
  while (value > 0) {
    out.unshift((value & 0x7f) | 0x80);
    value = Math.floor(value / 128);
  }
  return out;
}

function u16(v) {
  return [(v >> 8) & 0xff, v & 0xff];
}
function u32(v) {
  return [(v >> 24) & 0xff, (v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff];
}

/** Build a single-track format-0 file: tempo 500000 (120 BPM, 0.5s/quarter),
 *  TPQ 480, three quarter notes C4, D4, then (after a quarter rest) E4. */
function buildSampleMidi() {
  const track = [];
  const push = (...b) => b.forEach((x) => track.push(x));

  // delta 0: set tempo 500000 us = 0x07A120
  push(0x00, 0xff, 0x51, 0x03, 0x07, 0xa1, 0x20);
  // C4 (60) on @0, off @480
  push(0x00, 0x90, 60, 80);
  push(...vlq(480), 0x80, 60, 64);
  // D4 (62) on immediately @480, off @960
  push(0x00, 0x90, 62, 80);
  push(...vlq(480), 0x80, 62, 64);
  // quarter rest, then E4 (64) on @1440, off @1920
  push(...vlq(480), 0x90, 64, 80);
  push(...vlq(480), 0x80, 64, 64);
  // end of track
  push(0x00, 0xff, 0x2f, 0x00);

  const header = [
    0x4d, 0x54, 0x68, 0x64, // "MThd"
    ...u32(6),
    ...u16(0), // format 0
    ...u16(1), // 1 track
    ...u16(480), // division (TPQ)
  ];
  const trackChunk = [0x4d, 0x54, 0x72, 0x6b, ...u32(track.length), ...track];
  return new Uint8Array([...header, ...trackChunk]);
}

// --- parseMidi -----------------------------------------------------------
{
  const parsed = parseMidi(buildSampleMidi());
  assert.equal(parsed.ticksPerQuarter, 480, 'reads TPQ from header');
  assert.equal(parsed.format, 0, 'reads format');
  assert.equal(parsed.notes.length, 3, 'three notes parsed');

  const [c4, d4, e4] = parsed.notes;
  assert.equal(c4.midi, 60);
  assert.equal(d4.midi, 62);
  assert.equal(e4.midi, 64);

  // Ticks
  assert.equal(c4.startTick, 0);
  assert.equal(c4.endTick, 480);
  assert.equal(e4.startTick, 1440);

  // Tempo → seconds: 480 ticks = one quarter = 0.5 s at 120 BPM.
  assert.equal(c4.startSec, 0);
  assert.ok(Math.abs(c4.endSec - 0.5) < 1e-9, 'C4 ends at 0.5s');
  assert.ok(Math.abs(d4.startSec - 0.5) < 1e-9, 'D4 starts at 0.5s');
  assert.ok(Math.abs(e4.startSec - 1.5) < 1e-9, 'E4 starts at 1.5s (after rest)');
  assert.ok(Math.abs(parsed.durationSec - 2.0) < 1e-9, 'duration 2.0s');
}

// --- parseMidi: rejects non-MIDI ----------------------------------------
{
  assert.throws(
    () => parseMidi(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14])),
    /MThd/,
    'rejects a buffer without the MThd header',
  );
}

// --- sectionizeByPhrase: splits on a silence gap ------------------------
{
  const parsed = parseMidi(buildSampleMidi());
  // gapThreshold 480, allow tiny sections so we isolate the gap behavior.
  const secs = sectionizeByPhrase(parsed.notes, 480, {
    gapThreshold: 480,
    minNotes: 1,
    maxNotes: 100,
  });
  assert.equal(secs.length, 2, 'rest between D4 and E4 creates a boundary');
  assert.equal(secs[0].noteCount, 2, 'first section = C4 + D4');
  assert.equal(secs[1].noteCount, 1, 'second section = E4');
  assert.equal(secs[0].startTick, 0);
  assert.equal(secs[0].endTick, 960);
  assert.equal(secs[1].startTick, 1440);
  assert.equal(secs[0].name, 'Section 1');
  assert.equal(secs[1].order, 1);
}

// --- sectionizeByPhrase: merges tiny phrases forward --------------------
{
  // Three 2-note phrases separated by gaps; minNotes 6 ⇒ all merge into one.
  const notes = [];
  const phraseStarts = [0, 250, 500];
  for (const base of phraseStarts) {
    notes.push({ midi: 60, startTick: base, endTick: base + 50, startSec: 0, endSec: 0 });
    notes.push({ midi: 62, startTick: base + 50, endTick: base + 100, startSec: 0, endSec: 0 });
  }
  const secs = sectionizeByPhrase(notes, 480, {
    gapThreshold: 100,
    minNotes: 6,
    maxNotes: 100,
  });
  assert.equal(secs.length, 1, 'six notes across tiny phrases merge into one section');
  assert.equal(secs[0].noteCount, 6);
}

// --- sectionizeByPhrase: hard-splits long gap-free runs -----------------
{
  const notes = [];
  for (let i = 0; i < 10; i++) {
    notes.push({ midi: 60 + i, startTick: i * 10, endTick: i * 10 + 5, startSec: 0, endSec: 0 });
  }
  const secs = sectionizeByPhrase(notes, 480, {
    gapThreshold: 1000, // no internal gaps
    minNotes: 1,
    maxNotes: 4,
  });
  assert.equal(secs.length, 3, '10 notes / max 4 ⇒ 3 chunks');
  assert.deepEqual(
    secs.map((s) => s.noteCount),
    [4, 4, 2],
    'chunks are evenly distributed',
  );
}

// --- makeDerivedRanges: transition pairs + doubling run-throughs --------
{
  /** Fabricate n contiguous phrase ranges of `noteCount` 1 for span tests. */
  const fakeRanges = (n) =>
    Array.from({ length: n }, (_, i) => ({
      startTick: i * 100,
      endTick: i * 100 + 100,
      startSec: i,
      endSec: i + 1,
      noteCount: 1,
      name: `Section ${i + 1}`,
      order: i,
    }));

  // n=6 (the sample-piece shape): 5 transitions, groups of 4, full piece.
  // The trailing group 5–6 duplicates transition 5+6 and is skipped.
  const derived = makeDerivedRanges(fakeRanges(6));
  assert.deepEqual(
    derived.map((r) => r.name),
    [
      'Transition (Sections 1+2)',
      'Transition (Sections 2+3)',
      'Transition (Sections 3+4)',
      'Transition (Sections 4+5)',
      'Transition (Sections 5+6)',
      'Run-through (Sections 1–4)',
      'Run-through (Sections 1–6)',
    ],
    'every boundary gets a transition; run-throughs double up to the piece',
  );
  assert.ok(
    derived.every((r, i) => r.order === 6 + i),
    'derived sections sort after the phrase sections, in emit order',
  );
  const t23 = derived[1];
  assert.equal(t23.kind, 'transition');
  assert.equal(t23.startTick, 100, 'transition spans from section 2…');
  assert.equal(t23.endTick, 300, '…to the end of section 3');
  assert.equal(t23.noteCount, 2);
  const full = derived[derived.length - 1];
  assert.equal(full.kind, 'fluency');
  assert.equal(full.startTick, 0);
  assert.equal(full.endTick, 600);
  assert.equal(full.noteCount, 6, 'full run-through covers every note');
  assert.ok(full.notes.length > 0, 'derived ranges carry a prefilled note');

  // n=2: the lone transition IS the full piece — no duplicate run-through.
  const pair = makeDerivedRanges(fakeRanges(2));
  assert.equal(pair.length, 1);
  assert.equal(pair[0].kind, 'transition');

  // n=8: two groups of 4, then the full piece (size-8 group deduped).
  assert.deepEqual(
    makeDerivedRanges(fakeRanges(8))
      .filter((r) => r.kind === 'fluency')
      .map((r) => r.name),
    ['Run-through (Sections 1–4)', 'Run-through (Sections 5–8)', 'Run-through (Sections 1–8)'],
  );

  assert.deepEqual(makeDerivedRanges(fakeRanges(1)), [], 'single section ⇒ nothing to join');
  assert.deepEqual(makeDerivedRanges([]), [], 'no sections ⇒ nothing');
}

// --- groupNotesIntoSteps: chords vs melody ------------------------------
{
  const notes = [
    { midi: 60, startTick: 0, startSec: 0, endTick: 240, endSec: 0.25 },
    { midi: 64, startTick: 5, startSec: 0.005, endTick: 240, endSec: 0.25 }, // within epsilon → same step
    { midi: 67, startTick: 480, startSec: 0.5, endTick: 720, endSec: 0.75 },
  ];
  const steps = groupNotesIntoSteps(notes, { ticksPerQuarter: 480 });
  assert.equal(steps.length, 2, 'near-simultaneous onsets collapse into one step');
  assert.deepEqual(steps[0].pitches, [60, 64], 'first step is the chord, pitch-sorted');
  assert.deepEqual(steps[1].pitches, [67], 'second step is the lone note');
}

// --- notesInSection ------------------------------------------------------
{
  const notes = [
    { midi: 60, startTick: 0, endTick: 100 },
    { midi: 62, startTick: 500, endTick: 600 },
    { midi: 64, startTick: 1000, endTick: 1100 },
  ];
  const inSec = notesInSection(notes, { startTick: 400, endTick: 900 });
  assert.equal(inSec.length, 1);
  assert.equal(inSec[0].midi, 62, 'only the note starting inside the window');
}

console.log('midi helpers: all assertions passed');
