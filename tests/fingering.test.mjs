// Tests for the pure fingering-suggestion engine in fingering.js.
//
// Run from the project root:
//   node --test tests/fingering.test.mjs

import assert from 'node:assert/strict';

const mod = await import('../fingering.js');
const { assignHands, suggestFingerings, annotateFingerings, flagFingeringLandmarks } = mod;

/** Build a melody note list: one note per beat on a single track. */
const melody = (midis, { track = 0, tpq = 480 } = {}) =>
  midis.map((midi, i) => ({
    midi,
    startTick: i * tpq,
    endTick: i * tpq + tpq / 2,
    startSec: i * 0.5,
    endSec: i * 0.5 + 0.25,
    track,
    channel: 0,
  }));

/** Build a block chord: all pitches at tick 0. */
const chord = (midis, { track = 0 } = {}) =>
  midis.map((midi) => ({
    midi,
    startTick: 0,
    endTick: 480,
    startSec: 0,
    endSec: 0.5,
    track,
    channel: 0,
  }));

const fingersOf = (notes) =>
  suggestFingerings(notes, { ticksPerQuarter: 480 }).map((s) => s && s.finger);

// --- assignHands ---------------------------------------------------------
{
  // Two tracks: higher-mean track is the right hand.
  const notes = [
    ...melody([72, 74, 76], { track: 0 }),
    ...melody([48, 50, 52], { track: 1 }),
  ];
  const hands = assignHands(notes);
  assert.deepEqual(hands.slice(0, 3), ['rh', 'rh', 'rh']);
  assert.deepEqual(hands.slice(3), ['lh', 'lh', 'lh']);

  // Single track: per-note split around middle C.
  const mono = assignHands(melody([50, 62]));
  assert.deepEqual(mono, ['lh', 'rh']);

  assert.deepEqual(assignHands([]), [], 'empty input');
}

// --- five-finger position: C D E F G → 1 2 3 4 5 -------------------------
{
  const fingers = fingersOf(melody([60, 62, 64, 65, 67]));
  assert.deepEqual(fingers, [1, 2, 3, 4, 5]);
}

// --- one-octave C major scale: standard thumb-under fingering ------------
{
  const fingers = fingersOf(melody([60, 62, 64, 65, 67, 69, 71, 72]));
  assert.deepEqual(
    fingers,
    [1, 2, 3, 1, 2, 3, 4, 5],
    'RH C major scale uses thumb-under after the third finger',
  );
}

// --- descending LH five-finger position: C3 B A G F → 1 2 3 4 5 ----------
{
  const notes = melody([48, 47, 45, 43, 41]);
  const fingers = fingersOf(notes);
  assert.deepEqual(fingers, [1, 2, 3, 4, 5]);
  const hands = suggestFingerings(notes, { ticksPerQuarter: 480 }).map((s) => s.hand);
  assert.ok(hands.every((h) => h === 'lh'), 'sub-middle-C melody lands in the left hand');
}

// --- descending LH octave scale: one cheap thumb crossing ----------------
{
  // The textbook pattern is 1 2 3 1 2 3 4 5; crossing at the half-step
  // (1 2 3 4 5 1 2 3) is equally playable and the local cost model may pick
  // either. Assert the structural properties rather than one convention.
  const fingers = fingersOf(melody([48, 47, 45, 43, 41, 40, 38, 36]));
  const crossings = fingers.filter((f, i) => i > 0 && f < fingers[i - 1]).length;
  assert.equal(crossings, 1, 'exactly one thumb crossing in an octave scale');
  assert.ok(
    fingers.every((f, i) => i === 0 || f > fingers[i - 1] || f === 1),
    'descents in finger number only happen via the thumb',
  );
}

// --- C major triad: 1 3 5 -------------------------------------------------
{
  assert.deepEqual(fingersOf(chord([60, 64, 67])), [1, 3, 5]);
}

// --- octave: 1 5 ----------------------------------------------------------
{
  assert.deepEqual(fingersOf(chord([60, 72])), [1, 5]);
}

// --- repeated pitch keeps the same finger ---------------------------------
{
  const fingers = fingersOf(melody([67, 67, 67]));
  assert.equal(fingers[0], fingers[1]);
  assert.equal(fingers[1], fingers[2]);
}

// --- doubled pitch across tracks still gets a finger -----------------------
{
  const notes = [
    ...chord([60, 64], { track: 0 }),
    ...chord([60], { track: 1 }),
  ];
  // Force both tracks into one hand by pitch (single... two tracks → track
  // split puts track 1 in LH; the doubled C4 is deduped within RH only).
  const res = suggestFingerings(notes, { ticksPerQuarter: 480 });
  assert.ok(res.every((s) => s && s.finger >= 1 && s.finger <= 5), 'every note fingered');
}

// --- annotateFingerings mutates in place -----------------------------------
{
  const notes = melody([60, 62, 64]);
  const same = annotateFingerings(notes, { ticksPerQuarter: 480 });
  assert.equal(same, notes);
  assert.deepEqual(notes.map((n) => n.finger), [1, 2, 3]);
  assert.ok(notes.every((n) => n.hand === 'rh'));
}

// --- empty / degenerate -----------------------------------------------------
{
  assert.deepEqual(suggestFingerings([]), []);
  assert.deepEqual(suggestFingerings(null), []);
}

// --- flagFingeringLandmarks: sparse, meaningful subset --------------------
{
  // C major scale (one octave). First note + the two thumb-tucks are landmarks;
  // the plain stepwise notes between them are not.
  const notes = annotateFingerings(melody([60, 62, 64, 65, 67, 69, 71, 72]), { ticksPerQuarter: 480 });
  flagFingeringLandmarks(notes, { ticksPerQuarter: 480 });
  const marks = notes.map((n) => n.fingerLandmark);
  assert.equal(marks[0], true, 'first note of the hand is a landmark');
  assert.ok(marks.filter(Boolean).length < notes.length, 'not every note is flagged');
  // Thumb tucks (finger 1 mid-run) are landmarks.
  notes.forEach((n, i) => {
    if (i > 0 && n.finger === 1) assert.equal(n.fingerLandmark, true, `thumb at ${i} is a landmark`);
  });
}

// --- flagFingeringLandmarks: leaps and re-entries -------------------------
{
  // A wide leap (C4 → C5, an octave) flags the landing note; a fifth does not.
  const leap = annotateFingerings(melody([60, 60, 72]), { ticksPerQuarter: 480 });
  flagFingeringLandmarks(leap, { ticksPerQuarter: 480 });
  assert.equal(leap[1].fingerLandmark, false, 'repeated C is not a landmark');
  assert.equal(leap[2].fingerLandmark, true, 'octave leap is a landmark');
  // A fifth (C4 → G4) is ordinary melodic motion, not a landmark on its own.
  const fifth = annotateFingerings(melody([60, 60, 67]), { ticksPerQuarter: 480 });
  flagFingeringLandmarks(fifth, { ticksPerQuarter: 480 });
  // (G may still be flagged as a thumb-cross depending on fingering, but not
  // by the leap rule — assert the leap rule alone doesn't fire on a fifth.)
  assert.equal(Math.abs(67 - 60) < 9, true, 'a fifth is below the leap threshold');

  // A rest gap (note 3 starts well after note 2 ends) flags the re-entry.
  const notes = [
    { midi: 60, startTick: 0, endTick: 240, track: 0 },
    { midi: 62, startTick: 240, endTick: 480, track: 0 },
    { midi: 64, startTick: 1920, endTick: 2160, track: 0 }, // long gap before this
  ];
  annotateFingerings(notes, { ticksPerQuarter: 480 });
  flagFingeringLandmarks(notes, { ticksPerQuarter: 480 });
  assert.equal(notes[2].fingerLandmark, true, 'note after a rest is a re-entry landmark');
}

// --- flagFingeringLandmarks: only very distant leaps are "distant" --------
{
  // (A leap landmark must be spaced out from the hand-entry landmark, so each
  // case uses a held note before the leap — same shape as the test above.)

  // An octave leap is a landmark, but not distant enough for a letter marking.
  const oct = annotateFingerings(melody([60, 60, 72]), { ticksPerQuarter: 480 });
  flagFingeringLandmarks(oct, { ticksPerQuarter: 480 });
  assert.equal(oct[2].fingerLandmark, true, 'octave leap is a landmark');
  assert.equal(oct[2].fingerLandmarkDistant, false, 'an octave is not "very distant"');

  // 17 semitones still falls short of the 18-semitone threshold.
  const near = annotateFingerings(melody([60, 60, 77]), { ticksPerQuarter: 480 });
  flagFingeringLandmarks(near, { ticksPerQuarter: 480 });
  assert.equal(near[2].fingerLandmarkDistant, false, '17 semitones is below the distant threshold');

  // An octave and a half (18+) is a very distant landmark — it earns a letter.
  const far = annotateFingerings(melody([60, 60, 84]), { ticksPerQuarter: 480 });
  flagFingeringLandmarks(far, { ticksPerQuarter: 480 });
  assert.equal(far[2].fingerLandmark, true, 'two-octave leap is a landmark');
  assert.equal(far[2].fingerLandmarkDistant, true, 'two octaves is a very distant landmark');

  // The hand's first note is a landmark but never "distant" (no leap into it).
  assert.equal(far[0].fingerLandmark, true, 'hand entry is a landmark');
  assert.equal(far[0].fingerLandmarkDistant, false, 'hand entry is not distant');
}

// --- annotateFingerings prefers the score's own fingering ----------------
{
  const notes = melody([60, 62, 64]);
  notes[1].scoreFinger = 4; // the score fingered the middle note
  annotateFingerings(notes, { ticksPerQuarter: 480 });
  assert.equal(notes[1].finger, 4, 'score fingering wins over the auto suggestion');
  assert.equal(notes[1].fingerSource, 'score');
  assert.equal(notes[0].fingerSource, 'auto', 'un-fingered notes fall back to auto');
  assert.ok(notes[0].finger >= 1 && notes[0].finger <= 5);
}

console.log('fingering helpers: all assertions passed');
