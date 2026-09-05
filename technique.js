/* technique.js — per-piece technique drills: scale, arpeggio and cadence in
 * the piece's own key.
 *
 * Two independent jobs, both pure:
 *
 *   1. KEY DETECTION. Nothing else in the app knows about tonality, so we work
 *      it out from the notes themselves (Krumhansl-Schmuckler profile
 *      correlation over a duration-weighted pitch-class histogram). When a
 *      MusicXML score or a MIDI key-signature meta event is available, that's a
 *      stronger signal and wins — see `resolveKey`.
 *
 *   2. DRILL GENERATION. Each drill is emitted as a plain note array in exactly
 *      the shape `parseMidi` produces, so `player.load()` grades a generated
 *      scale with the same wait-mode engine it uses for real music. Notes are
 *      never persisted: the section record stores only a small spec (see
 *      `techniqueSpecsForKey`) and the notes are regenerated on mount.
 *
 * Fingerings are stamped onto each note as `scoreFinger`, which
 * `annotateFingerings` (fingering.js) treats as authoritative — so the
 * ergonomic solver never overrides the textbook pattern.
 */

// Generated drills get their own tick grid; nothing ties them to the piece's.
const TECHNIQUE_TPQ = 480;
// Nominal tempo used only to fill in startSec/endSec (the player is wait-mode,
// so these feed the duration readout, not the grading).
const TECHNIQUE_NOMINAL_BPM = 90;
const TECHNIQUE_OCTAVES = 2;

// Krumhansl-Kessler key profiles: the average relative prominence of each
// scale degree in major and minor tonal music.
const MAJOR_PROFILE = [
  6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88,
];
const MINOR_PROFILE = [
  6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17,
];

// Conventional spelling per tonic. Majors lean flat (E♭ major, not D♯ major);
// minors lean sharp (C♯ minor, not D♭ minor) — matching how keys are named in
// practice.
const MAJOR_KEY_NAMES = [
  'C', 'D♭', 'D', 'E♭', 'E', 'F', 'G♭', 'G', 'A♭', 'A', 'B♭', 'B',
];
const MINOR_KEY_NAMES = [
  'C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'B♭', 'B',
];

// Semitones above the tonic. Minor uses the HARMONIC form — the raised 7th is
// what makes the dominant major, so it's the form that actually matches the
// cadence drill and the leading tones in most repertoire.
const MAJOR_STEPS = [0, 2, 4, 5, 7, 9, 11];
const HARMONIC_MINOR_STEPS = [0, 2, 3, 5, 7, 8, 11];

const BLACK_PITCH_CLASSES = new Set([1, 3, 6, 8, 10]);

/** True when a MIDI note number lands on a black key. */
function isBlackPitch(midi) {
  return BLACK_PITCH_CLASSES.has(((midi % 12) + 12) % 12);
}

/* -------------------------------------------------------------------------
 * Fingerings
 *
 * One entry per key, ascending, tonic-to-tonic (8 values). The first 7 repeat
 * for each further octave; the 8th is the final tonic. Descending is the
 * ascending pattern reversed.
 *
 * The invariant every one of these obeys — and which tests/technique.test.mjs
 * enforces mechanically — is that the thumb never lands on a black key. That
 * is the rule the standard fingerings are built around, and it's what makes a
 * scale playable at speed.
 * ------------------------------------------------------------------------- */

const MAJOR_SCALE_FINGERING = {
  //        tonic ....................... tonic
  0:  { rh: [1, 2, 3, 1, 2, 3, 4, 5], lh: [5, 4, 3, 2, 1, 3, 2, 1] }, // C
  1:  { rh: [2, 3, 1, 2, 3, 4, 1, 2], lh: [3, 2, 1, 4, 3, 2, 1, 3] }, // D♭
  2:  { rh: [1, 2, 3, 1, 2, 3, 4, 5], lh: [5, 4, 3, 2, 1, 3, 2, 1] }, // D
  3:  { rh: [3, 1, 2, 3, 4, 1, 2, 3], lh: [3, 2, 1, 4, 3, 2, 1, 3] }, // E♭
  4:  { rh: [1, 2, 3, 1, 2, 3, 4, 5], lh: [5, 4, 3, 2, 1, 3, 2, 1] }, // E
  5:  { rh: [1, 2, 3, 4, 1, 2, 3, 4], lh: [5, 4, 3, 2, 1, 3, 2, 1] }, // F
  6:  { rh: [2, 3, 4, 1, 2, 3, 1, 2], lh: [4, 3, 2, 1, 3, 2, 1, 4] }, // G♭
  7:  { rh: [1, 2, 3, 1, 2, 3, 4, 5], lh: [5, 4, 3, 2, 1, 3, 2, 1] }, // G
  8:  { rh: [3, 4, 1, 2, 3, 1, 2, 3], lh: [3, 2, 1, 4, 3, 2, 1, 3] }, // A♭
  9:  { rh: [1, 2, 3, 1, 2, 3, 4, 5], lh: [5, 4, 3, 2, 1, 3, 2, 1] }, // A
  10: { rh: [4, 1, 2, 3, 1, 2, 3, 4], lh: [3, 2, 1, 4, 3, 2, 1, 3] }, // B♭
  11: { rh: [1, 2, 3, 1, 2, 3, 4, 5], lh: [4, 3, 2, 1, 4, 3, 2, 1] }, // B
};

const MINOR_SCALE_FINGERING = {
  0:  { rh: [1, 2, 3, 1, 2, 3, 4, 5], lh: [5, 4, 3, 2, 1, 3, 2, 1] }, // C
  1:  { rh: [3, 4, 1, 2, 3, 1, 2, 3], lh: [3, 2, 1, 4, 3, 2, 1, 3] }, // C♯
  2:  { rh: [1, 2, 3, 1, 2, 3, 4, 5], lh: [5, 4, 3, 2, 1, 3, 2, 1] }, // D
  3:  { rh: [3, 1, 2, 3, 4, 1, 2, 3], lh: [2, 1, 4, 3, 2, 1, 3, 2] }, // E♭
  4:  { rh: [1, 2, 3, 1, 2, 3, 4, 5], lh: [5, 4, 3, 2, 1, 3, 2, 1] }, // E
  5:  { rh: [1, 2, 3, 4, 1, 2, 3, 4], lh: [5, 4, 3, 2, 1, 3, 2, 1] }, // F
  6:  { rh: [3, 4, 1, 2, 3, 1, 2, 3], lh: [4, 3, 2, 1, 3, 2, 1, 4] }, // F♯
  7:  { rh: [1, 2, 3, 1, 2, 3, 4, 5], lh: [5, 4, 3, 2, 1, 3, 2, 1] }, // G
  8:  { rh: [3, 4, 1, 2, 3, 1, 2, 3], lh: [3, 2, 1, 4, 3, 2, 1, 3] }, // G♯
  9:  { rh: [1, 2, 3, 1, 2, 3, 4, 5], lh: [5, 4, 3, 2, 1, 3, 2, 1] }, // A
  10: { rh: [4, 1, 2, 3, 1, 2, 3, 4], lh: [2, 1, 3, 2, 1, 4, 3, 2] }, // B♭
  11: { rh: [1, 2, 3, 1, 2, 3, 4, 5], lh: [4, 3, 2, 1, 4, 3, 2, 1] }, // B
};

// Root-position triad arpeggios take the same fingering in every key — unlike
// scales, a thumb on a black root is normal here because there's no
// thumb-under to negotiate. Pattern is per octave (3 notes) plus the top tonic.
const ARPEGGIO_FINGERING = { rh: [1, 2, 3, 5], lh: [5, 3, 2, 1] };

/* -------------------------------------------------------------------------
 * Key detection
 * ------------------------------------------------------------------------- */

/**
 * Duration-weighted pitch-class histogram. Weighting by sounding length rather
 * than note count keeps a flurry of passing sixteenths from outvoting the
 * structural long notes.
 *
 * @param {Array<{midi:number,startTick:number,endTick:number}>} notes
 * @returns {number[]} 12 weights, index = pitch class
 */
function pitchClassHistogram(notes) {
  const hist = new Array(12).fill(0);
  if (!Array.isArray(notes)) return hist;
  for (const n of notes) {
    if (!n || typeof n.midi !== 'number' || !Number.isFinite(n.midi)) continue;
    const span = (n.endTick || 0) - (n.startTick || 0);
    // Fall back to a flat weight when a note has no usable duration.
    const weight = Number.isFinite(span) && span > 0 ? span : 1;
    hist[((n.midi % 12) + 12) % 12] += weight;
  }
  return hist;
}

/** Pearson correlation of two equal-length vectors; 0 when either is flat. */
function correlate(a, b) {
  const n = a.length;
  let meanA = 0;
  let meanB = 0;
  for (let i = 0; i < n; i++) { meanA += a[i]; meanB += b[i]; }
  meanA /= n;
  meanB /= n;
  let num = 0;
  let denA = 0;
  let denB = 0;
  for (let i = 0; i < n; i++) {
    const da = a[i] - meanA;
    const db = b[i] - meanB;
    num += da * db;
    denA += da * da;
    denB += db * db;
  }
  const den = Math.sqrt(denA * denB);
  return den > 0 ? num / den : 0;
}

/** How well one candidate key explains a histogram (-1..1). */
function keyScore(hist, tonic, mode) {
  const rotated = hist.map((_, i) => hist[(i + tonic) % 12]);
  return correlate(rotated, mode === 'minor' ? MINOR_PROFILE : MAJOR_PROFILE);
}

/**
 * Pitch class of the bass note of a piece's final sonority, or null.
 *
 * Profile correlation is weakest at exactly one distinction — a key versus its
 * relative — because the two share all seven notes and differ only in
 * emphasis. The closing bass breaks that tie almost infallibly: tonal pieces
 * land on the tonic, in the bass, at the end.
 *
 * "Final sonority" means the notes still SOUNDING when the piece stops, not
 * the ones that started last. A held bass under a moving upper voice is
 * everywhere in this repertoire — Chopin's B minor Prélude ends on exactly
 * that, a tonic B ringing beneath a repeated F♯ — and reading the last onset
 * would pick the decoration over the root.
 *
 * @param {Array} notes
 * @param {{ticksPerQuarter?: number}} [opts]
 */
function finalBassPitchClass(notes, opts = {}) {
  if (!Array.isArray(notes) || !notes.length) return null;
  let end = -Infinity;
  for (const n of notes) {
    if (n && Number.isFinite(n.endTick) && n.endTick > end) end = n.endTick;
  }
  if (!Number.isFinite(end)) return null;
  // Releases are rarely sample-aligned, so accept anything ending within a
  // sixteenth of the final release as part of the same closing chord.
  const tpq = Number(opts.ticksPerQuarter) > 0
    ? Number(opts.ticksPerQuarter)
    : TECHNIQUE_TPQ;
  const epsilon = tpq / 4;
  let lowest = null;
  for (const n of notes) {
    if (!n || !Number.isFinite(n.midi) || !Number.isFinite(n.endTick)) continue;
    if (n.endTick < end - epsilon) continue;
    if (lowest === null || n.midi < lowest) lowest = n.midi;
  }
  return lowest === null ? null : ((lowest % 12) + 12) % 12;
}

/**
 * Choose between a key and its relative (e.g. D major vs B minor) — the pair a
 * key signature alone can't separate.
 *
 * Evidence order:
 *   1. the closing bass note, when it names one of the two tonics
 *   2. `preferred`, a declared mode from the file's metadata
 *   3. profile correlation between the two candidates
 *
 * A declared mode ranks *below* the closing bass on purpose. Notation software
 * frequently writes `<mode>major</mode>` as an unconditional default, so a
 * minor piece can arrive labelled major; a piece that ends on B under a
 * two-sharp signature is in B minor whatever the metadata claims.
 */
function pickRelative(notes, majorKey, minorKey, preferred, opts) {
  const bass = finalBassPitchClass(notes, opts);
  if (bass !== null) {
    if (bass === minorKey.tonic && bass !== majorKey.tonic) return minorKey;
    if (bass === majorKey.tonic && bass !== minorKey.tonic) return majorKey;
  }
  if (preferred === 'minor') return minorKey;
  if (preferred === 'major') return majorKey;
  const hist = pitchClassHistogram(notes);
  return keyScore(hist, minorKey.tonic, 'minor') > keyScore(hist, majorKey.tonic, 'major')
    ? minorKey
    : majorKey;
}

/**
 * Best-matching key for a note array, by correlating the piece's pitch-class
 * histogram against all 24 rotated Krumhansl-Kessler profiles.
 *
 * `confidence` is the margin between the winner and the runner-up (0..1-ish).
 * A low margin usually means a modal or chromatic piece where the tonic is
 * genuinely ambiguous — the UI surfaces this so the user can override.
 *
 * @returns {{tonic:number, mode:'major'|'minor', confidence:number}|null}
 */
function detectKey(notes, opts) {
  const hist = pitchClassHistogram(notes);
  const total = hist.reduce((s, v) => s + v, 0);
  if (total <= 0) return null;

  const scored = [];
  for (let tonic = 0; tonic < 12; tonic++) {
    // Rotate the histogram so the candidate tonic sits at index 0, then
    // compare against the un-rotated profile.
    const rotated = hist.map((_, i) => hist[(i + tonic) % 12]);
    scored.push({ tonic, mode: 'major', score: correlate(rotated, MAJOR_PROFILE) });
    scored.push({ tonic, mode: 'minor', score: correlate(rotated, MINOR_PROFILE) });
  }
  scored.sort((a, b) => b.score - a.score);
  let best = scored[0];
  const runnerUp = scored[1];
  const confidence = runnerUp
    ? Math.max(0, Math.min(1, best.score - runnerUp.score))
    : 0;

  // When the top two are a relative pair, the profiles are near-useless at
  // separating them (identical note content) — defer to the closing bass.
  if (runnerUp && best.mode !== runnerUp.mode) {
    const major = best.mode === 'major' ? best : runnerUp;
    const minor = best.mode === 'minor' ? best : runnerUp;
    if ((major.tonic + 9) % 12 === minor.tonic) {
      best = pickRelative(notes, major, minor, undefined, opts);
    }
  }
  return { tonic: best.tonic, mode: best.mode, confidence };
}

// Tonic pitch class for each key-signature accidental count, -7..+7.
const MAJOR_TONIC_BY_FIFTHS = {
  '-7': 11, '-6': 6, '-5': 1, '-4': 8, '-3': 3, '-2': 10, '-1': 5,
  0: 0, 1: 7, 2: 2, 3: 9, 4: 4, 5: 11, 6: 6, 7: 1,
};

/**
 * Key from a notated key signature. `fifths` is the signed accidental count
 * (-7..+7) as it appears in MusicXML `<fifths>` and the MIDI 0x59 meta event.
 *
 * A key signature alone can't distinguish a major key from its relative minor,
 * so `mode` must come from elsewhere: MusicXML `<mode>` states it outright, and
 * MIDI 0x59 carries a minor flag in its second byte.
 *
 * @returns {{tonic:number, mode:'major'|'minor'}|null}
 */
function keyFromFifths(fifths, mode) {
  const f = Math.round(Number(fifths));
  if (!Number.isFinite(f) || f < -7 || f > 7) return null;
  const majorTonic = MAJOR_TONIC_BY_FIFTHS[String(f)];
  if (typeof majorTonic !== 'number') return null;
  if (mode === 'minor') {
    return { tonic: (majorTonic + 9) % 12, mode: 'minor' };
  }
  return { tonic: majorTonic, mode: 'major' };
}

/**
 * Settle on a key for a piece. A notated signature is authoritative when we
 * have one; otherwise fall back to detecting it from the notes.
 *
 * @param {object} opts
 * @param {Array} opts.notes                parsed notes
 * @param {{fifths:number, mode?:string}} [opts.keySignature] from score/MIDI
 * @returns {{tonic:number, mode:string, confidence:number, source:string}|null}
 */
function resolveKey({ notes, keySignature, ticksPerQuarter } = {}) {
  const opts = { ticksPerQuarter };
  if (keySignature && typeof keySignature.fifths === 'number') {
    // The signature narrows the field to exactly two candidates — the major
    // key and its relative minor. Compare those directly rather than trusting
    // an unconstrained argmax that's free to wander to an unrelated key.
    const major = keyFromFifths(keySignature.fifths, 'major');
    const minor = keyFromFifths(keySignature.fifths, 'minor');
    if (major && minor) {
      const picked = pickRelative(notes, major, minor, keySignature.mode, opts);
      return { ...picked, confidence: 1, source: 'signature' };
    }
  }
  const detected = detectKey(notes, opts);
  return detected ? { ...detected, source: 'detected' } : null;
}

/**
 * The tonic's name on its own, e.g. "E♭" or "C♯". Spelling depends on the
 * mode — the same pitch class is D♯ in one context and E♭ in another.
 */
function keyTonicName(tonic, mode) {
  const t = ((Math.round(tonic) % 12) + 12) % 12;
  return (mode === 'minor' ? MINOR_KEY_NAMES : MAJOR_KEY_NAMES)[t];
}

/** Human-readable key name, e.g. "E♭ major" or "C♯ minor". */
function keyLabel(tonic, mode) {
  return `${keyTonicName(tonic, mode)} ${mode === 'minor' ? 'minor' : 'major'}`;
}

const LETTERS = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];
const LETTER_SEMITONES = [0, 2, 4, 5, 7, 9, 11];
const ACCIDENTALS = { '-2': '♭♭', '-1': '♭', 0: '', 1: '♯', 2: '𝄪' };

/**
 * Correctly spelled note names for one octave of the scale, e.g.
 * `['E','F♯','G','A','B','C','D♯']` for E harmonic minor.
 *
 * A scale uses each letter A–G exactly once, so the letter is fixed by
 * position and only the accidental is computed. That's what produces the
 * spellings a player expects — C♭ in E♭ minor rather than B, and the double
 * sharp F𝄪 for the raised 7th of G♯ minor.
 */
function scaleNoteNames(tonic, mode) {
  const t = ((Math.round(tonic) % 12) + 12) % 12;
  const isMinor = mode === 'minor';
  const startIdx = LETTERS.indexOf(keyTonicName(t, isMinor ? 'minor' : 'major')[0]);
  const steps = isMinor ? HARMONIC_MINOR_STEPS : MAJOR_STEPS;
  return steps.map((semis, i) => {
    const li = (startIdx + i) % 7;
    const target = (t + semis) % 12;
    let diff = (((target - LETTER_SEMITONES[li]) % 12) + 12) % 12;
    if (diff > 6) diff -= 12; // fold into -2..+2 around the natural
    return LETTERS[li] + (ACCIDENTALS[String(diff)] ?? '');
  });
}

/* -------------------------------------------------------------------------
 * Drill generation
 * ------------------------------------------------------------------------- */

/** Build one note in the shape `parseMidi` emits, plus a stamped fingering. */
function makeNote(midi, startTick, durationTicks, track, finger) {
  const secPerTick = 60 / (TECHNIQUE_NOMINAL_BPM * TECHNIQUE_TPQ);
  const endTick = startTick + durationTicks;
  return {
    midi,
    startTick,
    endTick,
    startSec: startTick * secPerTick,
    endSec: endTick * secPerTick,
    velocity: 80,
    channel: 0,
    // The player derives its hand toggle from `track`, so RH/LH split here
    // gives generated drills hands-separate practice for free.
    track,
    hand: track === 0 ? 'right' : 'left',
    scoreFinger: finger,
    fingerSource: 'technique',
  };
}

/** Absolute MIDI pitches of one ascending octave of the scale, from `root`. */
function scaleDegrees(root, mode) {
  const steps = mode === 'minor' ? HARMONIC_MINOR_STEPS : MAJOR_STEPS;
  return steps.map((s) => root + s);
}

/**
 * Expand a tonic-to-tonic fingering across `octaves`. The two hands mirror
 * each other, so they expand differently:
 *
 *   RH ascending — the repeating cycle starts on the tonic and the run ends on
 *     the outer finger:   [1 2 3 1 2 3 4] [1 2 3 1 2 3 4] 5
 *   LH ascending — the outer finger starts the run and the cycle *ends* on the
 *     tonic:              5 [4 3 2 1 3 2 1] [4 3 2 1 3 2 1]
 *
 * Getting this backwards puts the thumb on the octave boundary in the wrong
 * hand, which is exactly the error the black-key audit in the tests catches.
 *
 * The repeating cycle is one shorter than the pattern (7 for a scale, 3 for an
 * arpeggio), so this serves both drills.
 *
 * @param {number[]} pattern tonic-to-tonic fingering
 * @param {number} octaves
 * @param {'rh'|'lh'} hand
 */
function expandFingering(pattern, octaves, hand) {
  const cycle = pattern.length - 1;
  const out = [];
  if (hand === 'lh') {
    out.push(pattern[0]);
    for (let o = 0; o < octaves; o++) out.push(...pattern.slice(1, cycle + 1));
  } else {
    for (let o = 0; o < octaves; o++) out.push(...pattern.slice(0, cycle));
    out.push(pattern[cycle]);
  }
  return out;
}

/**
 * A scale, ascending then descending, both hands two octaves apart.
 *
 * @param {{tonic:number, mode:string, octaves?:number}} spec
 * @returns {Array<object>} notes
 */
function buildScaleNotes(spec) {
  const tonic = ((Math.round(spec.tonic) % 12) + 12) % 12;
  const mode = spec.mode === 'minor' ? 'minor' : 'major';
  const octaves = spec.octaves || TECHNIQUE_OCTAVES;
  const table = mode === 'minor' ? MINOR_SCALE_FINGERING : MAJOR_SCALE_FINGERING;
  const fing = table[tonic];

  // Ascending pitches across all octaves, tonic to tonic.
  const pitchesFrom = (root) => {
    const out = [];
    for (let o = 0; o < octaves; o++) {
      out.push(...scaleDegrees(root + 12 * o, mode));
    }
    out.push(root + 12 * octaves);
    return out;
  };

  const notes = [];
  const dur = TECHNIQUE_TPQ / 2; // eighth notes
  // RH sits an octave above middle C's octave; LH two octaves below it.
  const hands = [
    { root: 60 + tonic, track: 0, fingers: expandFingering(fing.rh, octaves, 'rh') },
    { root: 36 + tonic, track: 1, fingers: expandFingering(fing.lh, octaves, 'lh') },
  ];

  for (const hand of hands) {
    const up = pitchesFrom(hand.root);
    // Down repeats the pattern in reverse, minus the shared top note.
    const down = up.slice(0, -1).reverse();
    const fingersDown = hand.fingers.slice(0, -1).reverse();
    const all = [...up, ...down];
    const allFingers = [...hand.fingers, ...fingersDown];
    all.forEach((midi, i) => {
      notes.push(makeNote(midi, i * dur, dur, hand.track, allFingers[i]));
    });
  }
  return notes;
}

/**
 * A root-position triad arpeggio, ascending then descending, both hands.
 *
 * @param {{tonic:number, mode:string, octaves?:number}} spec
 */
function buildArpeggioNotes(spec) {
  const tonic = ((Math.round(spec.tonic) % 12) + 12) % 12;
  const mode = spec.mode === 'minor' ? 'minor' : 'major';
  const octaves = spec.octaves || TECHNIQUE_OCTAVES;
  const third = mode === 'minor' ? 3 : 4;
  const triad = [0, third, 7];

  const notes = [];
  const dur = TECHNIQUE_TPQ / 2;
  const hands = [
    { root: 60 + tonic, track: 0, hand: 'rh', pattern: ARPEGGIO_FINGERING.rh },
    { root: 36 + tonic, track: 1, hand: 'lh', pattern: ARPEGGIO_FINGERING.lh },
  ];

  for (const hand of hands) {
    const up = [];
    for (let o = 0; o < octaves; o++) {
      for (let i = 0; i < triad.length; i++) {
        up.push(hand.root + 12 * o + triad[i]);
      }
    }
    up.push(hand.root + 12 * octaves);
    const fingers = expandFingering(hand.pattern, octaves, hand.hand);

    const down = up.slice(0, -1).reverse();
    const fingersDown = fingers.slice(0, -1).reverse();
    const all = [...up, ...down];
    const allFingers = [...fingers, ...fingersDown];
    all.forEach((midi, i) => {
      notes.push(makeNote(midi, i * dur, dur, hand.track, allFingers[i]));
    });
  }
  return notes;
}

/**
 * The standard I–IV–I–V–I cadence: RH plays block triads voiced to share as
 * many common tones as possible, LH plays the chord roots.
 *
 * Offsets are semitones from the tonic. IV appears in second inversion so the
 * tonic stays on top of the RH chord throughout, and V in first inversion so
 * the leading tone sits under the tonic and resolves up into the final chord.
 * In minor, V keeps its major third — that's the raised 7th of the harmonic
 * minor scale drilled alongside it.
 *
 * `degrees` / `bassDegree` are 0-based indices into the scale (the same order
 * `scaleNoteNames` spells), so a chart can name the chord tones. `fingers` is
 * the RH fingering, bottom to top, following the textbook rule for triads: the
 * hand opens across the wider interval, so a fourth at the *bottom* of the
 * chord (IV in 6/4) takes 1-3-5 like root position, and a fourth at the *top*
 * (V in first inversion) takes 1-2-5.
 */
function cadenceChords(mode) {
  const isMinor = mode === 'minor';
  const third = isMinor ? 3 : 4;
  const I = {
    label: isMinor ? 'i' : 'I',
    rh: [0, third, 7],
    degrees: [0, 2, 4],
    fingers: [1, 3, 5],
    bass: -12,
    bassDegree: 0,
  };
  const IV = {
    label: isMinor ? 'iv' : 'IV',
    rh: isMinor ? [0, 5, 8] : [0, 5, 9],
    degrees: [0, 3, 5],
    fingers: [1, 3, 5],
    bass: -7,
    bassDegree: 3,
  };
  const V = {
    label: 'V',
    rh: [-1, 2, 7],
    degrees: [6, 1, 4],
    fingers: [1, 2, 5],
    bass: -5,
    bassDegree: 4,
  };
  return [I, IV, I, V, I];
}

// The LH plays each cadence chord's root as a single note, always with 5.
const CADENCE_LH_FINGER = 5;

/**
 * @param {{tonic:number, mode:string}} spec
 */
function buildCadenceNotes(spec) {
  const tonic = ((Math.round(spec.tonic) % 12) + 12) % 12;
  const mode = spec.mode === 'minor' ? 'minor' : 'major';
  const rhRoot = 60 + tonic;
  const lhRoot = 48 + tonic;
  const dur = TECHNIQUE_TPQ * 2; // half notes — chords want time to settle
  const notes = [];

  cadenceChords(mode).forEach((chord, i) => {
    const at = i * dur;
    // RH triad, low-to-high, each voice taking the chord's own fingering.
    chord.rh.forEach((offset, v) => {
      notes.push(makeNote(rhRoot + offset, at, dur, 0, chord.fingers[v]));
    });
    notes.push(makeNote(lhRoot + chord.bass, at, dur, 1, CADENCE_LH_FINGER));
  });
  return notes;
}

/** Total tick length of a generated note array. */
function techniqueEndTick(notes) {
  return notes.reduce((m, n) => Math.max(m, n.endTick), 0);
}

const TECHNIQUE_BUILDERS = {
  scale: buildScaleNotes,
  arpeggio: buildArpeggioNotes,
  cadence: buildCadenceNotes,
};

/**
 * Regenerate a drill's notes from its stored spec. This is the single entry
 * point the app uses at practice time — the notes themselves are never saved,
 * so generation must stay deterministic.
 *
 * @param {{drill:string, tonic:number, mode:string, octaves?:number}} spec
 * @returns {Array<object>} notes, empty when the spec is unrecognised
 */
function buildTechniqueNotes(spec) {
  if (!spec || typeof spec !== 'object') return [];
  const build = TECHNIQUE_BUILDERS[spec.drill];
  if (!build) return [];
  return build(spec);
}

/** Validate/normalise a persisted spec; returns null when unusable. */
function normaliseTechniqueSpec(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (!TECHNIQUE_BUILDERS[raw.drill]) return null;
  const tonic = Number(raw.tonic);
  if (!Number.isFinite(tonic)) return null;
  const spec = {
    drill: raw.drill,
    tonic: ((Math.round(tonic) % 12) + 12) % 12,
    mode: raw.mode === 'minor' ? 'minor' : 'major',
  };
  const octaves = Number(raw.octaves);
  if (Number.isFinite(octaves) && octaves >= 1 && octaves <= 4) {
    spec.octaves = Math.round(octaves);
  }
  return spec;
}

const TECHNIQUE_DRILLS = [
  {
    drill: 'scale',
    title: 'Scale',
    hint: 'Even tone, thumb under early.',
    // Only the scale has a choice of minor form — an arpeggio is just the
    // triad, and the cadence's chord qualities are already fixed. Saying
    // "harmonic minor" on those would be noise at best and wrong at worst.
    minorHint: 'Harmonic minor — the 7th is raised.',
  },
  {
    drill: 'arpeggio',
    title: 'Arpeggio',
    hint: 'Keep the wrist moving laterally; no reaching with the fingers.',
  },
  {
    drill: 'cadence',
    title: 'Cadence',
    hint: 'I–IV–I–V–I. Hold each chord; listen for the leading tone resolving.',
  },
];

/**
 * The technique sections to create for a piece in a given key — one per drill,
 * so each is scheduled, rated and tempo-tracked on its own.
 *
 * Returned objects match the shape `makeDerivedRanges` produces so
 * `buildSectionsForPiece` can persist them through the same path, with an
 * extra `technique` spec that regenerates the notes at practice time.
 *
 * @param {{tonic:number, mode:string}} key
 * @param {number} [startOrder] first `order` value to assign
 */
function techniqueSpecsForKey(key, startOrder = 0) {
  if (!key || typeof key.tonic !== 'number') return [];
  const tonic = ((Math.round(key.tonic) % 12) + 12) % 12;
  const mode = key.mode === 'minor' ? 'minor' : 'major';
  const label = keyLabel(tonic, mode);

  return TECHNIQUE_DRILLS.map((d, i) => {
    const spec = { drill: d.drill, tonic, mode };
    const notes = buildTechniqueNotes(spec);
    const endTick = techniqueEndTick(notes);
    const endSec = notes.reduce((m, n) => Math.max(m, n.endSec), 0);
    return {
      name: `${d.title} · ${label}`,
      kind: 'technique',
      technique: spec,
      startTick: 0,
      endTick,
      startSec: 0,
      endSec,
      noteCount: notes.length,
      notes: mode === 'minor' && d.minorHint ? `${d.hint} ${d.minorHint}` : d.hint,
      order: startOrder + i,
    };
  });
}

/**
 * A piece-shaped object for `player.load()`, standing in for the real piece so
 * a generated drill runs through the unmodified player path.
 *
 * @param {{drill:string, tonic:number, mode:string}} spec
 */
function techniquePieceForSpec(spec) {
  const notes = buildTechniqueNotes(spec);
  return { ticksPerQuarter: TECHNIQUE_TPQ, notes };
}

/* -------------------------------------------------------------------------
 * Fingering charts
 *
 * The falling notes carry a finger digit each, but that's only legible one
 * note at a time. A pianist learning a scale wants the whole pattern in front
 * of them — the line a scale book prints above the stave. These charts are
 * built from the same tables (and the same `expandFingering`) that stamp
 * `scoreFinger` on the generated notes, so the chart and the falling notes
 * can never disagree.
 * ------------------------------------------------------------------------- */

/** Join a finger sequence for a run ("1 2 3 1 2 3 4 5"). */
function joinRun(fingers) {
  return fingers.join(' ');
}

/** Join fingers played together as a chord ("1-3-5"). */
function joinChord(fingers) {
  return fingers.join('-');
}

/**
 * A display-ready fingering chart for a drill, or null for an unusable spec.
 *
 * Two layouts, because a run and a chord progression read differently:
 *
 *   layout 'run'  (scale, arpeggio) — the ascending line, one column per note:
 *     { names: ['E','F♯',…,'E'],
 *       hands: [{ hand:'RH', fingers:[1,2,3,…,5] },
 *               { hand:'LH', fingers:[5,4,3,…,1] }] }
 *     Descending is the same fingers in reverse, so it isn't repeated.
 *
 *   layout 'chords' (cadence) — one column per chord:
 *     { chords: [{ label:'I', rh:{ notes:['E','G♯','B'], fingers:[1,3,5] },
 *                              lh:{ notes:['E'], fingers:[5] } }, …] }
 *
 * Both carry a one-line `summary` for compact lists — the tonic-to-tonic
 * pattern for a run, since that's the form every scale chart uses and it
 * extends cyclically to any number of octaves — and a short `caption` saying
 * how to read the table.
 *
 * @param {{drill:string, tonic:number, mode:string, octaves?:number}} rawSpec
 */
function techniqueFingering(rawSpec) {
  const spec = normaliseTechniqueSpec(rawSpec);
  if (!spec) return null;
  const { tonic, mode } = spec;
  const octaves = spec.octaves || TECHNIQUE_OCTAVES;
  const names = scaleNoteNames(tonic, mode);

  if (spec.drill === 'scale' || spec.drill === 'arpeggio') {
    const isScale = spec.drill === 'scale';
    const pattern = isScale
      ? (mode === 'minor' ? MINOR_SCALE_FINGERING : MAJOR_SCALE_FINGERING)[tonic]
      : ARPEGGIO_FINGERING;
    // Names of one cycle: the whole scale, or just the triad tones.
    const cycle = isScale ? names : [names[0], names[2], names[4]];
    const runNames = [];
    for (let o = 0; o < octaves; o++) runNames.push(...cycle);
    runNames.push(cycle[0]);

    return {
      drill: spec.drill,
      layout: 'run',
      names: runNames,
      // Notes per octave (7 for a scale, 3 for an arpeggio) — every `cycle`th
      // column is a tonic, which is how a chart frames the octaves.
      cycle: cycle.length,
      octaves,
      hands: [
        { hand: 'RH', fingers: expandFingering(pattern.rh, octaves, 'rh') },
        { hand: 'LH', fingers: expandFingering(pattern.lh, octaves, 'lh') },
      ],
      summary: `RH ${joinRun(pattern.rh)} · LH ${joinRun(pattern.lh)}`,
      caption: `Ascending, ${octaves} octave${octaves === 1 ? '' : 's'} — `
        + 'come back down with the same fingers in reverse.',
    };
  }

  const chords = cadenceChords(mode).map((c) => ({
    label: c.label,
    rh: { notes: c.degrees.map((d) => names[d]), fingers: c.fingers.slice() },
    lh: { notes: [names[c.bassDegree]], fingers: [CADENCE_LH_FINGER] },
  }));
  // Summarise each distinct chord once, in order of first appearance.
  const seen = new Set();
  const distinct = chords.filter((c) => !seen.has(c.label) && seen.add(c.label));
  return {
    drill: 'cadence',
    layout: 'chords',
    chords,
    summary: `RH ${distinct.map((c) => `${c.label} ${joinChord(c.rh.fingers)}`).join(' · ')}`
      + ` · LH ${CADENCE_LH_FINGER} on each root`,
    caption: 'RH block triads, bottom to top; LH the root of each chord.',
  };
}

// ---- Node export shim (browser-safe) ------------------------------------
// In the browser these are plain globals (classic <script>). Under Node the
// object-literal assignment is picked up by the CJS→ESM interop so the test
// files can `import` them.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    TECHNIQUE_TPQ,
    TECHNIQUE_OCTAVES,
    TECHNIQUE_DRILLS,
    MAJOR_SCALE_FINGERING,
    MINOR_SCALE_FINGERING,
    ARPEGGIO_FINGERING,
    MAJOR_STEPS,
    HARMONIC_MINOR_STEPS,
    isBlackPitch,
    pitchClassHistogram,
    keyScore,
    finalBassPitchClass,
    detectKey,
    keyFromFifths,
    resolveKey,
    keyLabel,
    keyTonicName,
    scaleNoteNames,
    scaleDegrees,
    buildScaleNotes,
    buildArpeggioNotes,
    buildCadenceNotes,
    buildTechniqueNotes,
    normaliseTechniqueSpec,
    techniqueSpecsForKey,
    techniquePieceForSpec,
    techniqueFingering,
    cadenceChords,
    techniqueEndTick,
  };
}
