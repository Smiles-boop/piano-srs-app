// Tests for the practice-path sequencer in midi.js
// (buildPracticeSequence + nextInPracticeSequence).
//
// The helpers are pure — they read each derived section's phrase coverage from
// its tick window, so we hand-build section records with explicit tick ranges
// (no MIDI parse needed) and assert the resulting order.
//
// Run from the project root:
//   node tests/sequence.test.mjs

import assert from 'node:assert/strict';

const { buildPracticeSequence, nextInPracticeSequence } = await import(
  '../midi.js'
);

/** Build a 4-phrase piece with the derived sections makeDerivedRanges emits. */
function fourPhrasePiece() {
  // 4 phrases, each a 100-tick window back to back.
  const phrases = [
    { id: 'S1', name: 'Section 1', startTick: 0, endTick: 100, order: 0 },
    { id: 'S2', name: 'Section 2', startTick: 100, endTick: 200, order: 1 },
    { id: 'S3', name: 'Section 3', startTick: 200, endTick: 300, order: 2 },
    { id: 'S4', name: 'Section 4', startTick: 300, endTick: 400, order: 3 },
  ];
  // Overlapping transition pairs, one per boundary.
  const transitions = [
    { id: 'T12', name: 'Transition (Sections 1+2)', kind: 'transition', startTick: 0, endTick: 200, order: 4 },
    { id: 'T23', name: 'Transition (Sections 2+3)', kind: 'transition', startTick: 100, endTick: 300, order: 5 },
    { id: 'T34', name: 'Transition (Sections 3+4)', kind: 'transition', startTick: 200, endTick: 400, order: 6 },
  ];
  // For n=4, makeDerivedRanges emits only the full-piece run-through.
  const fluency = [
    { id: 'F14', name: 'Run-through (Sections 1–4)', kind: 'fluency', startTick: 0, endTick: 400, order: 7 },
  ];
  return [...phrases, ...transitions, ...fluency];
}

// --- buildPracticeSequence: interleaving -----------------------------------
{
  const sections = fourPhrasePiece();
  const seq = buildPracticeSequence(sections).map((s) => s.id);
  // Each transition lands right after the second phrase it joins; the
  // run-through comes last.
  assert.deepEqual(
    seq,
    ['S1', 'S2', 'T12', 'S3', 'T23', 'S4', 'T34', 'F14'],
    'transitions interleave after their second phrase; fluency trails',
  );
}

// --- order independence: shuffled input → same path ------------------------
{
  const sections = fourPhrasePiece();
  const shuffled = [
    sections[7], sections[2], sections[5], sections[0],
    sections[6], sections[3], sections[4], sections[1],
  ];
  const seq = buildPracticeSequence(shuffled).map((s) => s.id);
  assert.deepEqual(
    seq,
    ['S1', 'S2', 'T12', 'S3', 'T23', 'S4', 'T34', 'F14'],
    'sequence is derived from tick coverage, not input order',
  );
}

// --- every input section appears exactly once ------------------------------
{
  const sections = fourPhrasePiece();
  const seq = buildPracticeSequence(sections);
  assert.equal(seq.length, sections.length, 'no sections dropped or duplicated');
  assert.equal(new Set(seq).size, sections.length, 'each section appears once');
}

// --- technique drills open the path ----------------------------------------
//
// Technique sections sit on their own generated tick grid starting at 0. If
// they leaked into the phrase list they'd shift every phrase index that the
// transition anchoring depends on, so this guards both the warm-up placement
// AND the untouched ordering of the piece's own sections.
{
  const technique = [
    { id: 'TQ1', name: 'Scale · D major', kind: 'technique', startTick: 0, endTick: 6960, order: 8 },
    { id: 'TQ2', name: 'Arpeggio · D major', kind: 'technique', startTick: 0, endTick: 3120, order: 9 },
    { id: 'TQ3', name: 'Cadence · D major', kind: 'technique', startTick: 0, endTick: 4800, order: 10 },
  ];
  const sections = [...fourPhrasePiece(), ...technique];
  const seq = buildPracticeSequence(sections).map((s) => s.id);
  assert.deepEqual(
    seq,
    ['TQ1', 'TQ2', 'TQ3', 'S1', 'S2', 'T12', 'S3', 'T23', 'S4', 'T34', 'F14'],
    'drills warm up first, then the piece path is unchanged',
  );
  assert.equal(new Set(seq).size, sections.length, 'each section appears once');

  // Storage order decides the drill order, not their (identical) tick windows.
  const reordered = buildPracticeSequence([
    ...fourPhrasePiece(), technique[2], technique[0], technique[1],
  ]).map((s) => s.id);
  assert.deepEqual(reordered.slice(0, 3), ['TQ1', 'TQ2', 'TQ3']);

  // And the step after the last drill is the piece's first phrase.
  assert.equal(nextInPracticeSequence(sections, 'TQ3').id, 'S1');
}

// --- trouble drills sit between the warm-up and the piece ------------------
//
// These are real tick windows that OVERLAP the phrases, so the important part
// is that they don't get counted as phrases — which would both duplicate
// positions and shift the indices the transitions anchor to.
{
  const trouble = [
    { id: 'X2', name: 'Trouble spot · bar 9', kind: 'trouble', startTick: 250, endTick: 330, order: 12 },
    { id: 'X1', name: 'Trouble spot · bar 3', kind: 'trouble', startTick: 120, endTick: 190, order: 11 },
  ];
  const technique = [
    { id: 'TQ1', name: 'Scale', kind: 'technique', startTick: 0, endTick: 6960, order: 8 },
  ];
  const sections = [...fourPhrasePiece(), ...technique, ...trouble];
  const seq = buildPracticeSequence(sections).map((s) => s.id);
  assert.deepEqual(
    seq,
    ['TQ1', 'X1', 'X2', 'S1', 'S2', 'T12', 'S3', 'T23', 'S4', 'T34', 'F14'],
    'warm up, repair weak spots, then play the piece',
  );
  assert.equal(new Set(seq).size, sections.length, 'each section appears once');
  assert.equal(nextInPracticeSequence(sections, 'X2').id, 'S1');
}

// A piece whose ONLY sections are drills still sequences in storage order.
{
  const only = [
    { id: 'TQ1', kind: 'technique', startTick: 0, endTick: 6960, order: 0 },
    { id: 'TQ2', kind: 'technique', startTick: 0, endTick: 3120, order: 1 },
  ];
  assert.deepEqual(
    buildPracticeSequence(only).map((s) => s.id), ['TQ1', 'TQ2'],
  );
}

// --- fluency ordering: shortest span first ---------------------------------
{
  // 4 phrases + two run-throughs of different sizes: a 1–2 span and the full
  // 1–4. The shorter span must come first.
  const sections = [
    { id: 'S1', name: 'Section 1', startTick: 0, endTick: 100, order: 0 },
    { id: 'S2', name: 'Section 2', startTick: 100, endTick: 200, order: 1 },
    { id: 'S3', name: 'Section 3', startTick: 200, endTick: 300, order: 2 },
    { id: 'S4', name: 'Section 4', startTick: 300, endTick: 400, order: 3 },
    { id: 'Rbig', name: 'Run-through (Sections 1–4)', kind: 'fluency', startTick: 0, endTick: 400, order: 4 },
    { id: 'Rsmall', name: 'Run-through (Sections 3–4)', kind: 'fluency', startTick: 200, endTick: 400, order: 5 },
  ];
  const seq = buildPracticeSequence(sections).map((s) => s.id);
  const iSmall = seq.indexOf('Rsmall');
  const iBig = seq.indexOf('Rbig');
  assert.ok(iSmall < iBig, 'shorter run-through is scheduled before the longer one');
}

// --- nextInPracticeSequence ------------------------------------------------
{
  const sections = fourPhrasePiece();
  assert.equal(
    nextInPracticeSequence(sections, 'S2').id,
    'T12',
    'after Section 2 comes the 1+2 transition',
  );
  assert.equal(
    nextInPracticeSequence(sections, 'T34').id,
    'F14',
    'after the last transition comes the full run-through',
  );
  assert.equal(
    nextInPracticeSequence(sections, 'F14'),
    null,
    'the last step has no next',
  );
  assert.equal(
    nextInPracticeSequence(sections, 'nope'),
    null,
    'an unknown id has no next',
  );
}

// --- edge cases ------------------------------------------------------------
{
  assert.deepEqual(buildPracticeSequence([]), [], 'empty in → empty out');
  assert.deepEqual(buildPracticeSequence(null), [], 'null is tolerated');
  const one = [{ id: 'S1', name: 'Section 1', startTick: 0, endTick: 100 }];
  assert.deepEqual(
    buildPracticeSequence(one).map((s) => s.id),
    ['S1'],
    'a single section is returned as-is',
  );
}

console.log('practice sequence: all assertions passed');
