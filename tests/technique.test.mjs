/* tests/technique.test.mjs — key detection, drill generation and, most
 * importantly, a mechanical audit of the fingering tables. */

import assert from 'node:assert/strict';

const mod = await import('../technique.js');
const {
  TECHNIQUE_TPQ,
  TECHNIQUE_DRILLS,
  MAJOR_SCALE_FINGERING,
  MINOR_SCALE_FINGERING,
  MAJOR_STEPS,
  HARMONIC_MINOR_STEPS,
  isBlackPitch,
  pitchClassHistogram,
  detectKey,
  keyFromFifths,
  resolveKey,
  keyLabel,
  buildScaleNotes,
  buildArpeggioNotes,
  buildCadenceNotes,
  buildTechniqueNotes,
  normaliseTechniqueSpec,
  techniqueSpecsForKey,
  techniquePieceForSpec,
} = mod;

/* -- Fingering tables ----------------------------------------------------
 *
 * The tables are hand-entered, so audit them against the rules the standard
 * fingerings are actually built from rather than trusting the transcription.
 */

for (const [modeName, table, steps] of [
  ['major', MAJOR_SCALE_FINGERING, MAJOR_STEPS],
  ['minor', MINOR_SCALE_FINGERING, HARMONIC_MINOR_STEPS],
]) {
  for (let tonic = 0; tonic < 12; tonic++) {
    const entry = table[tonic];
    const where = `${keyLabel(tonic, modeName)} (${modeName})`;
    assert.ok(entry, `${where}: missing fingering entry`);

    for (const hand of ['rh', 'lh']) {
      const pattern = entry[hand];
      assert.equal(
        pattern.length, 8,
        `${where} ${hand}: expected 8 values, got ${pattern.length}`,
      );
      for (const f of pattern) {
        assert.ok(
          Number.isInteger(f) && f >= 1 && f <= 5,
          `${where} ${hand}: finger ${f} out of range`,
        );
      }
      // The tonic-to-tonic pattern must be usable cyclically: repeating the
      // first seven values must not put the same finger on two adjacent notes.
      const cyc = [...pattern.slice(0, 7), pattern[0]];
      for (let i = 1; i < cyc.length; i++) {
        assert.notEqual(
          cyc[i], cyc[i - 1],
          `${where} ${hand}: finger ${cyc[i]} repeats on adjacent notes at ${i}`,
        );
      }

      // THE rule: the thumb never lands on a black key. This is what makes a
      // scale playable at speed, and it's the invariant that catches a
      // mistyped table entry.
      pattern.forEach((finger, i) => {
        if (finger !== 1) return;
        // Index 7 is the closing tonic an octave up; the rest are degrees.
        const semitone = i === 7 ? 12 : steps[i];
        const midi = 60 + tonic + semitone;
        assert.ok(
          !isBlackPitch(midi),
          `${where} ${hand}: thumb on a black key at degree ${i + 1}`,
        );
      });
    }
  }
}

/* -- Key detection ------------------------------------------------------- */

const n = (midi, startTick, len = 480) => ({
  midi, startTick, endTick: startTick + len,
});

// A plain C major scale should read as C major.
{
  const cMajor = [0, 2, 4, 5, 7, 9, 11, 12].map((s, i) => n(60 + s, i * 480));
  const key = detectKey(cMajor);
  assert.equal(key.mode, 'major');
  assert.equal(key.tonic, 0, `expected C major, got ${keyLabel(key.tonic, key.mode)}`);
}

// A harmonic minor: a weighted tonic arpeggio, a scale run with the raised
// 7th, and a long closing tonic — the shape that makes a key unambiguous.
const A_MINOR_NOTES = [
  n(57, 0, 960), n(60, 960, 960), n(64, 1920, 960), n(69, 2880, 960),
  ...[57, 59, 60, 62, 64, 65, 68, 69].map((m, i) => n(m, 3840 + i * 240, 240)),
  n(57, 5760, 1920),
];
{
  const key = detectKey(A_MINOR_NOTES);
  assert.equal(key.mode, 'minor');
  assert.equal(key.tonic, 9, `expected A minor, got ${keyLabel(key.tonic, key.mode)}`);
  assert.ok(key.confidence > 0, 'a clear key should carry some confidence');
}

// Duration weighting: one very long D outweighs a flurry of passing notes.
{
  const hist = pitchClassHistogram([n(62, 0, 9600), n(61, 0, 60), n(63, 60, 60)]);
  assert.ok(hist[2] > hist[1] + hist[3], 'long note should dominate the histogram');
}

assert.deepEqual(pitchClassHistogram([]), new Array(12).fill(0));
assert.equal(detectKey([]), null, 'no notes → no key');
assert.equal(detectKey(null), null);

/* -- Relative-key disambiguation ----------------------------------------- */
//
// A key and its relative share all seven notes, so profile correlation alone
// separates them poorly. The closing bass note is the tie-breaker.
{
  const { finalBassPitchClass } = mod;
  // Lowest note of the final chord, not the last note in the array.
  assert.equal(finalBassPitchClass([n(60, 0), n(71, 480), n(50, 480)]), 2);
  assert.equal(finalBassPitchClass([]), null);
  assert.equal(finalBassPitchClass(null), null);

  // A bass note HELD under a later-starting upper voice is still the bass.
  // This is the Chopin B-minor-Prélude shape: a tonic pedal ringing beneath a
  // repeated figure that starts after it.
  assert.equal(
    finalBassPitchClass([
      n(47, 0, 4000),    // held B, starts first and rings to the end
      n(66, 2000, 500),
      n(66, 3000, 1000), // last ONSET, but not the lowest sounding note
    ]),
    11,
    'held bass wins over a later, higher onset',
  );

  // Notes that stopped well before the end aren't part of the final sonority.
  assert.equal(
    finalBassPitchClass([n(36, 0, 100), n(64, 3000, 1000), n(59, 3000, 1000)]),
    11,
  );
}

// D-major note content that lands decisively on B: B minor, not D major.
{
  const body = [62, 66, 69, 74, 71, 69, 66, 62, 64, 66, 69, 71]
    .map((m, i) => n(m, i * 480, 480));
  const asBMinor = resolveKey({
    notes: [...body, n(47, 5760, 1920), n(71, 5760, 1920)],
    keySignature: { fifths: 2 },
  });
  assert.equal(keyLabel(asBMinor.tonic, asBMinor.mode), 'B minor');

  // Identical content closing on D instead reads as the relative major.
  const asDMajor = resolveKey({
    notes: [...body, n(38, 5760, 1920), n(74, 5760, 1920)],
    keySignature: { fifths: 2 },
  });
  assert.equal(keyLabel(asDMajor.tonic, asDMajor.mode), 'D major');

  // Notation software often writes <mode>major</mode> as a blind default, so
  // an unambiguous closing bass outranks the declared mode.
  const declaredWrong = resolveKey({
    notes: [...body, n(47, 5760, 1920), n(71, 5760, 1920)],
    keySignature: { fifths: 2, mode: 'major' },
  });
  assert.equal(
    keyLabel(declaredWrong.tonic, declaredWrong.mode), 'B minor',
    'closing bass overrides a contradicted <mode>',
  );

  // But a declared mode still decides when the bass gives no signal — here the
  // piece ends on A, which is neither candidate tonic.
  const bassSaysNothing = [...body, n(45, 5760, 1920), n(69, 5760, 1920)];
  const declared = (mode) => {
    const k = resolveKey({ notes: bassSaysNothing, keySignature: { fifths: 2, mode } });
    return keyLabel(k.tonic, k.mode);
  };
  assert.equal(declared('minor'), 'B minor');
  assert.equal(declared('major'), 'D major');
}

/* -- Key signatures ------------------------------------------------------ */

assert.deepEqual(keyFromFifths(0, 'major'), { tonic: 0, mode: 'major' });   // C
assert.deepEqual(keyFromFifths(2, 'major'), { tonic: 2, mode: 'major' });   // D
assert.deepEqual(keyFromFifths(-3, 'major'), { tonic: 3, mode: 'major' });  // E♭
assert.deepEqual(keyFromFifths(0, 'minor'), { tonic: 9, mode: 'minor' });   // A
assert.deepEqual(keyFromFifths(1, 'minor'), { tonic: 4, mode: 'minor' });   // E
assert.deepEqual(keyFromFifths(-1, 'minor'), { tonic: 2, mode: 'minor' });  // D
assert.equal(keyFromFifths(9, 'major'), null, 'out-of-range fifths rejected');
assert.equal(keyFromFifths('x', 'major'), null);

// A notated signature beats the histogram.
{
  const cMajorNotes = [0, 2, 4, 5, 7, 9, 11].map((s, i) => n(60 + s, i * 480));
  const k = resolveKey({ notes: cMajorNotes, keySignature: { fifths: 3, mode: 'major' } });
  assert.equal(k.source, 'signature');
  assert.equal(k.tonic, 9);
  assert.equal(k.confidence, 1);
}

// No signature → fall back to detection.
{
  const cMajorNotes = [0, 2, 4, 5, 7, 9, 11].map((s, i) => n(60 + s, i * 480));
  const k = resolveKey({ notes: cMajorNotes });
  assert.equal(k.source, 'detected');
  assert.equal(k.tonic, 0);
}

// A signature with no mode lets the notes break the relative-key tie.
{
  const k = resolveKey({ notes: A_MINOR_NOTES, keySignature: { fifths: 0 } });
  assert.equal(k.mode, 'minor');
  assert.equal(k.tonic, 9);
  assert.equal(k.source, 'signature');
}

/* -- Labels -------------------------------------------------------------- */

assert.equal(keyLabel(0, 'major'), 'C major');
assert.equal(keyLabel(3, 'major'), 'E♭ major');
assert.equal(keyLabel(1, 'minor'), 'C♯ minor');
assert.equal(keyLabel(6, 'major'), 'G♭ major');
assert.equal(keyLabel(6, 'minor'), 'F♯ minor');

/* -- Scale spelling ------------------------------------------------------ */
{
  const { scaleNoteNames } = mod;
  const spell = (t, m) => scaleNoteNames(t, m).join(' ');
  assert.equal(spell(0, 'major'), 'C D E F G A B');
  assert.equal(spell(3, 'major'), 'E♭ F G A♭ B♭ C D');
  assert.equal(spell(6, 'major'), 'G♭ A♭ B♭ C♭ D♭ E♭ F', 'G♭ major needs C♭, not B');
  assert.equal(spell(9, 'minor'), 'A B C D E F G♯');
  assert.equal(spell(4, 'minor'), 'E F♯ G A B C D♯');
  assert.equal(spell(3, 'minor'), 'E♭ F G♭ A♭ B♭ C♭ D');
  assert.equal(spell(8, 'minor'), 'G♯ A♯ B C♯ D♯ E F𝄪', 'raised 7th of G♯ minor is a double sharp');

  // Every scale uses each letter exactly once — the property that makes the
  // spelling correct rather than merely enharmonic.
  for (let t = 0; t < 12; t++) {
    for (const m of ['major', 'minor']) {
      const letters = scaleNoteNames(t, m).map((n) => n[0]);
      assert.equal(
        new Set(letters).size, 7,
        `${keyLabel(t, m)}: letters repeat (${letters.join('')})`,
      );
    }
  }
}

/* -- Drill generation ---------------------------------------------------- */

// C major scale, 2 octaves, both hands: 29 notes each way.
{
  const notes = buildScaleNotes({ tonic: 0, mode: 'major' });
  const rh = notes.filter((x) => x.track === 0);
  const lh = notes.filter((x) => x.track === 1);
  assert.equal(rh.length, 29, 'RH scale: 15 up + 14 down');
  assert.equal(lh.length, 29);

  // Ascending run is the C major scale from C4 up two octaves.
  const up = rh.slice(0, 15).map((x) => x.midi);
  assert.deepEqual(up, [60, 62, 64, 65, 67, 69, 71, 72, 74, 76, 77, 79, 81, 83, 84]);
  // and it comes back down symmetrically.
  assert.deepEqual(rh.slice(15).map((x) => x.midi), up.slice(0, -1).reverse());

  // Textbook fingering, including the closing 5.
  assert.deepEqual(
    rh.slice(0, 15).map((x) => x.scoreFinger),
    [1, 2, 3, 1, 2, 3, 4, 1, 2, 3, 1, 2, 3, 4, 5],
  );
  // LH mirrors it: the 5 opens the run and the thumb lands on each tonic.
  assert.deepEqual(
    lh.slice(0, 15).map((x) => x.scoreFinger),
    [5, 4, 3, 2, 1, 3, 2, 1, 4, 3, 2, 1, 3, 2, 1],
  );

  // LH is two octaves below RH so the hands don't collide.
  assert.equal(lh[0].midi, 36);
  // Every note carries a hand and a fingering the solver will honour.
  for (const x of notes) {
    assert.ok(x.scoreFinger >= 1 && x.scoreFinger <= 5);
    assert.equal(x.fingerSource, 'technique');
    assert.ok(x.hand === 'right' || x.hand === 'left');
    assert.ok(x.endTick > x.startTick);
    assert.ok(x.endSec > x.startSec);
  }
}

// Harmonic minor raises the 7th.
{
  const notes = buildScaleNotes({ tonic: 9, mode: 'minor' });
  const up = notes.filter((x) => x.track === 0).slice(0, 8).map((x) => x.midi);
  //            A   B   C   D   E   F   G♯  A
  assert.deepEqual(up, [69, 71, 72, 74, 76, 77, 80, 81]);
}

// Arpeggio: root-position triad, minor lowers the third.
{
  const maj = buildArpeggioNotes({ tonic: 0, mode: 'major' })
    .filter((x) => x.track === 0);
  assert.equal(maj.length, 13, 'arpeggio: 7 up + 6 down');
  assert.deepEqual(maj.slice(0, 7).map((x) => x.midi), [60, 64, 67, 72, 76, 79, 84]);
  assert.deepEqual(maj.slice(0, 7).map((x) => x.scoreFinger), [1, 2, 3, 1, 2, 3, 5]);
  const majLh = buildArpeggioNotes({ tonic: 0, mode: 'major' })
    .filter((x) => x.track === 1);
  assert.deepEqual(majLh.slice(0, 7).map((x) => x.scoreFinger), [5, 3, 2, 1, 3, 2, 1]);

  const min = buildArpeggioNotes({ tonic: 0, mode: 'minor' })
    .filter((x) => x.track === 0);
  assert.deepEqual(min.slice(0, 4).map((x) => x.midi), [60, 63, 67, 72]);
}

// Cadence: five chords, RH triad + LH root, chords sound together.
{
  const notes = buildCadenceNotes({ tonic: 0, mode: 'major' });
  assert.equal(notes.length, 20, '5 chords × (3 RH + 1 LH)');
  const onsets = [...new Set(notes.map((x) => x.startTick))].sort((a, b) => a - b);
  assert.equal(onsets.length, 5);
  // I – IV(6/4) – I – V(6) – I, tonic on top of every RH chord bar the V.
  const chordAt = (t) => notes.filter((x) => x.startTick === t && x.track === 0)
    .map((x) => x.midi).sort((a, b) => a - b);
  assert.deepEqual(chordAt(onsets[0]), [60, 64, 67], 'I = C E G');
  assert.deepEqual(chordAt(onsets[1]), [60, 65, 69], 'IV6/4 = C F A');
  assert.deepEqual(chordAt(onsets[3]), [59, 62, 67], 'V6 = B D G');
  // LH roots: C – F – C – G – C
  const bass = onsets.map((t) => notes.find((x) => x.startTick === t && x.track === 1).midi);
  assert.deepEqual(bass, [36, 41, 36, 43, 36]);

  // RH chord fingerings follow the triad rule: a fourth at the bottom (IV in
  // 6/4: C-F-A) opens 1-3-5 like root position; a fourth at the top (V in
  // first inversion: B-D-G) takes 1-2-5.
  const fingersAt = (t) => notes.filter((x) => x.startTick === t && x.track === 0)
    .sort((a, b) => a.midi - b.midi).map((x) => x.scoreFinger);
  assert.deepEqual(fingersAt(onsets[0]), [1, 3, 5], 'I');
  assert.deepEqual(fingersAt(onsets[1]), [1, 3, 5], 'IV6/4');
  assert.deepEqual(fingersAt(onsets[3]), [1, 2, 5], 'V6');
  for (const t of onsets) {
    assert.equal(notes.find((x) => x.startTick === t && x.track === 1).scoreFinger, 5, 'LH root with 5');
  }
}

// Minor cadence keeps the major dominant (the raised leading tone).
{
  const notes = buildCadenceNotes({ tonic: 9, mode: 'minor' });
  const onsets = [...new Set(notes.map((x) => x.startTick))].sort((a, b) => a - b);
  const v = notes.filter((x) => x.startTick === onsets[3] && x.track === 0)
    .map((x) => x.midi).sort((a, b) => a - b);
  //                 G♯   B   E   → E major triad, G♯ is the raised 7th
  assert.deepEqual(v, [68, 71, 76]);
}

/* -- Specs and dispatch -------------------------------------------------- */

assert.deepEqual(buildTechniqueNotes(null), []);
assert.deepEqual(buildTechniqueNotes({ drill: 'nope', tonic: 0 }), []);
assert.ok(buildTechniqueNotes({ drill: 'scale', tonic: 0, mode: 'major' }).length > 0);

assert.equal(normaliseTechniqueSpec({ drill: 'bogus', tonic: 0 }), null);
assert.equal(normaliseTechniqueSpec({ drill: 'scale', tonic: 'x' }), null);
assert.deepEqual(
  normaliseTechniqueSpec({ drill: 'scale', tonic: 14, mode: 'weird' }),
  { drill: 'scale', tonic: 2, mode: 'major' },
);

// One section per drill, ordered from the given offset, each self-describing.
{
  const specs = techniqueSpecsForKey({ tonic: 2, mode: 'major' }, 40);
  assert.equal(specs.length, TECHNIQUE_DRILLS.length);
  assert.deepEqual(specs.map((s) => s.order), [40, 41, 42]);
  assert.deepEqual(
    specs.map((s) => s.name),
    ['Scale · D major', 'Arpeggio · D major', 'Cadence · D major'],
  );
  for (const s of specs) {
    assert.equal(s.kind, 'technique');
    assert.equal(s.startTick, 0);
    assert.ok(s.endTick > 0, `${s.name}: empty tick window`);
    assert.ok(s.noteCount > 0);
    assert.ok(s.technique && s.technique.tonic === 2);
    // The stored spec must round-trip through the persistence normaliser.
    assert.deepEqual(normaliseTechniqueSpec(s.technique), s.technique);
    // ...and regenerate exactly the notes the section was measured from.
    const regen = buildTechniqueNotes(s.technique);
    assert.equal(regen.length, s.noteCount, `${s.name}: regen count drifted`);
    assert.equal(Math.max(...regen.map((x) => x.endTick)), s.endTick);
  }
}

assert.deepEqual(techniqueSpecsForKey(null), []);

// "Harmonic minor" belongs on the scale alone — the arpeggio is just the
// triad and the cadence's chord qualities are already fixed.
{
  const minor = techniqueSpecsForKey({ tonic: 9, mode: 'minor' });
  const byDrill = Object.fromEntries(minor.map((s) => [s.technique.drill, s.notes]));
  assert.match(byDrill.scale, /harmonic minor/i);
  assert.doesNotMatch(byDrill.arpeggio, /harmonic|minor form/i);
  assert.doesNotMatch(byDrill.cadence, /harmonic|minor form/i);

  // Major keys never mention a minor form at all.
  for (const s of techniqueSpecsForKey({ tonic: 0, mode: 'major' })) {
    assert.doesNotMatch(s.notes, /harmonic|minor/i, `${s.name}: stray minor wording`);
  }
}

// The synthetic piece is shaped for player.load().
{
  const piece = techniquePieceForSpec({ drill: 'scale', tonic: 0, mode: 'major' });
  assert.equal(piece.ticksPerQuarter, TECHNIQUE_TPQ);
  assert.ok(Array.isArray(piece.notes) && piece.notes.length > 0);
}

/* -- Fingering charts ---------------------------------------------------- */
{
  const { techniqueFingering } = mod;

  // Scale: note names across the top, a finger per note per hand, and the
  // compact tonic-to-tonic summary a scale chart prints.
  const e = techniqueFingering({ drill: 'scale', tonic: 4, mode: 'major' });
  assert.equal(e.layout, 'run');
  assert.deepEqual(
    e.names,
    ['E', 'F♯', 'G♯', 'A', 'B', 'C♯', 'D♯', 'E', 'F♯', 'G♯', 'A', 'B', 'C♯', 'D♯', 'E'],
  );
  assert.equal(e.cycle, 7);
  assert.equal(e.octaves, 2);
  assert.deepEqual(e.hands.map((h) => h.hand), ['RH', 'LH']);
  assert.deepEqual(e.hands[0].fingers, [1, 2, 3, 1, 2, 3, 4, 1, 2, 3, 1, 2, 3, 4, 5]);
  assert.deepEqual(e.hands[1].fingers, [5, 4, 3, 2, 1, 3, 2, 1, 4, 3, 2, 1, 3, 2, 1]);
  assert.equal(e.summary, 'RH 1 2 3 1 2 3 4 5 · LH 5 4 3 2 1 3 2 1');
  assert.match(e.caption, /2 octaves/);

  // A black-key scale keeps its own pattern and spelling.
  const bf = techniqueFingering({ drill: 'scale', tonic: 10, mode: 'minor' });
  assert.equal(bf.summary, 'RH 4 1 2 3 1 2 3 4 · LH 2 1 3 2 1 4 3 2');
  assert.equal(bf.names[0], 'B♭');
  assert.equal(bf.names[5], 'G♭');

  // Arpeggio: triad tones only, 3 per octave.
  const arp = techniqueFingering({ drill: 'arpeggio', tonic: 4, mode: 'major' });
  assert.equal(arp.layout, 'run');
  assert.deepEqual(arp.names, ['E', 'G♯', 'B', 'E', 'G♯', 'B', 'E']);
  assert.equal(arp.cycle, 3);
  assert.deepEqual(arp.hands[0].fingers, [1, 2, 3, 1, 2, 3, 5]);
  assert.deepEqual(arp.hands[1].fingers, [5, 3, 2, 1, 3, 2, 1]);
  assert.equal(arp.summary, 'RH 1 2 3 5 · LH 5 3 2 1');

  // Cadence: one column per chord, tones stacked over fingers, LH root with 5.
  const cad = techniqueFingering({ drill: 'cadence', tonic: 4, mode: 'major' });
  assert.equal(cad.layout, 'chords');
  assert.deepEqual(cad.chords.map((c) => c.label), ['I', 'IV', 'I', 'V', 'I']);
  assert.deepEqual(cad.chords[0].rh, { notes: ['E', 'G♯', 'B'], fingers: [1, 3, 5] });
  assert.deepEqual(cad.chords[1].rh, { notes: ['E', 'A', 'C♯'], fingers: [1, 3, 5] });
  assert.deepEqual(cad.chords[3].rh, { notes: ['D♯', 'F♯', 'B'], fingers: [1, 2, 5] });
  assert.deepEqual(cad.chords.map((c) => c.lh.notes[0]), ['E', 'A', 'E', 'B', 'E']);
  assert.ok(cad.chords.every((c) => c.lh.fingers[0] === 5));
  assert.equal(cad.summary, 'RH I 1-3-5 · IV 1-3-5 · V 1-2-5 · LH 5 on each root');

  // Minor: lower-case numerals, raised leading tone in V.
  const am = techniqueFingering({ drill: 'cadence', tonic: 9, mode: 'minor' });
  assert.deepEqual(am.chords.map((c) => c.label), ['i', 'iv', 'i', 'V', 'i']);
  assert.deepEqual(am.chords[3].rh.notes, ['G♯', 'B', 'E']);
  assert.match(am.summary, /^RH i 1-3-5 · iv 1-3-5 · V 1-2-5/);

  // Every chart agrees with the fingers actually stamped on the notes — the
  // chart is what the user reads, the notes are what gets graded.
  for (let tonic = 0; tonic < 12; tonic++) {
    for (const mode of ['major', 'minor']) {
      for (const drill of ['scale', 'arpeggio']) {
        const spec = { drill, tonic, mode };
        const chart = techniqueFingering(spec);
        const notes = buildTechniqueNotes(spec);
        for (const [i, track] of [[0, 0], [1, 1]]) {
          const up = notes.filter((x) => x.track === track).slice(0, chart.names.length);
          assert.deepEqual(
            up.map((x) => x.scoreFinger), chart.hands[i].fingers,
            `${keyLabel(tonic, mode)} ${drill} ${chart.hands[i].hand}: chart drifted from notes`,
          );
        }
      }
      const cadSpec = { drill: 'cadence', tonic, mode };
      const chart = techniqueFingering(cadSpec);
      const notes = buildTechniqueNotes(cadSpec);
      const onsets = [...new Set(notes.map((x) => x.startTick))].sort((a, b) => a - b);
      chart.chords.forEach((c, i) => {
        const rh = notes.filter((x) => x.startTick === onsets[i] && x.track === 0)
          .sort((a, b) => a.midi - b.midi).map((x) => x.scoreFinger);
        assert.deepEqual(rh, c.rh.fingers, `${keyLabel(tonic, mode)} cadence chord ${i}`);
      });
    }
  }

  // Octave count flows through from the spec.
  const one = techniqueFingering({ drill: 'scale', tonic: 0, mode: 'major', octaves: 1 });
  assert.equal(one.names.length, 8);
  assert.deepEqual(one.hands[0].fingers, [1, 2, 3, 1, 2, 3, 4, 5]);
  assert.match(one.caption, /1 octave —/);

  assert.equal(techniqueFingering(null), null);
  assert.equal(techniqueFingering({ drill: 'nope', tonic: 0 }), null);
}

console.log('technique.test.mjs: all assertions passed');
