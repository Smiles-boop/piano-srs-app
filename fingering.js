// PianoSRS — automatic fingering suggestions (pure, no DOM/audio).
//
// Given the parsed note list of a piece, suggest a finger (1=thumb … 5=pinky)
// and hand for every note. The approach is a small cost-based dynamic
// program per hand, in the spirit of Parncutt et al.'s ergonomic models but
// deliberately simplified:
//
//   1. Notes are split into hands — by track mean pitch when the file has
//      two or more tracks (same heuristic the player uses for its hand
//      toggle), otherwise per note around middle C.
//   2. Each hand's notes are grouped into "events" (single notes or chords
//      by near-simultaneous onset).
//   3. Every event gets candidate finger assignments (chords use strictly
//      ascending fingers on ascending pitches), and a Viterbi pass picks the
//      assignment sequence with the lowest total ergonomic cost: finger
//      stretches are compared against each finger pair's natural span,
//      same-finger repeats on new pitches and non-thumb crossings are
//      penalised, thumb-under/over passes are cheap, and the thumb dislikes
//      black keys.
//
// The left hand is handled by mirroring pitches (negating them) so the same
// "ascending pitch ↔ ascending finger" rules apply to both hands.
//
// Exports (browser globals + CJS shim like midi.js):
//   suggestFingerings(notes, o) → Array<{hand:'lh'|'rh', finger:1..5}|null>
//   annotateFingerings(notes, o) → notes (mutated: n.hand, n.finger)
//   assignHands(notes) → Array<'lh'|'rh'>

/** Onsets closer than this fraction of a quarter note form one chord event. */
const FINGERING_CHORD_EPSILON_QUARTERS = 0.08;

/** Single-track pieces split hands around this pitch (middle C). */
const HAND_SPLIT_MIDI = 60;

/** Natural (relaxed-hand) span in semitones for each finger pair. */
const NATURAL_SPAN = {
  '1:2': 2, '1:3': 3.5, '1:4': 5, '1:5': 7,
  '2:3': 2, '2:4': 3.5, '2:5': 5,
  '3:4': 2, '3:5': 3.5,
  '4:5': 2,
};

/** Tiny per-finger bias so cost ties resolve toward thumb-side fingers. */
const FINGER_BIAS = { 1: 0, 2: 0.005, 3: 0.01, 4: 0.02, 5: 0.03 };

const isBlackKey = (midi) => {
  const pc = ((midi % 12) + 12) % 12;
  return pc === 1 || pc === 3 || pc === 6 || pc === 8 || pc === 10;
};

/**
 * Assign each note to a hand. With ≥2 tracks the split is by track mean
 * pitch (higher half → right hand), mirroring the player's hand toggle so
 * the suggestion matches what the RH/LH filter shows. Single-track files
 * fall back to a per-note split around middle C.
 *
 * @param {Array<object>} notes  parseMidi() note list
 * @returns {Array<'lh'|'rh'>} aligned with `notes`
 */
function assignHands(notes) {
  if (!Array.isArray(notes) || notes.length === 0) return [];
  const tracks = [...new Set(notes.map((n) => n.track))];
  if (tracks.length < 2) {
    return notes.map((n) => (n.midi < HAND_SPLIT_MIDI ? 'lh' : 'rh'));
  }
  const meanByTrack = tracks.map((t) => {
    const ns = notes.filter((n) => n.track === t);
    const mean = ns.reduce((s, n) => s + n.midi, 0) / ns.length;
    return { t, mean };
  });
  meanByTrack.sort((a, b) => b.mean - a.mean);
  const half = Math.ceil(meanByTrack.length / 2);
  const rhTracks = new Set(meanByTrack.slice(0, half).map((x) => x.t));
  return notes.map((n) => (rhTracks.has(n.track) ? 'rh' : 'lh'));
}

/** Cost of spanning `span` semitones between fingers fa<fb (same hand). */
function stretchCost(span, fa, fb) {
  const nat = NATURAL_SPAN[`${fa}:${fb}`];
  const thumb = fa === 1;
  const maxComf = nat + (thumb ? 4 : 1.5);
  const minComf = Math.max(0, nat - (thumb ? 3 : 1));
  let cost = Math.abs(span - nat) * 0.3;
  if (span > maxComf) cost += (span - maxComf) ** 2;
  if (span < minComf) cost += (minComf - span) ** 2;
  return cost;
}

/**
 * Ergonomic cost of moving from (q1,f1) to (q2,f2), where q is the
 * hand-mirrored pitch (real midi for RH, negated for LH) so ascending q
 * always means "away from the thumb side".
 */
function transitionCost(q1, f1, q2, f2) {
  const d = q2 - q1;
  if (d === 0) return f1 === f2 ? 0 : 0.6; // repeat / finger substitution
  if (f1 === f2) return 2.6 + Math.abs(d) * 0.05; // same finger, new pitch
  const fingersAscend = f2 > f1;
  if ((d > 0) === fingersAscend) {
    // Fingers move the same way as pitch — plain stretch/contraction.
    const [fa, fb] = fingersAscend ? [f1, f2] : [f2, f1];
    return stretchCost(Math.abs(d), fa, fb);
  }
  // Crossing. Cheap when the thumb passes under (new note on thumb) or a
  // finger passes over the thumb; expensive between long fingers.
  if (f2 === 1 || f1 === 1) {
    return 1.2 + Math.max(0, Math.abs(d) - 2) * 0.8;
  }
  return 8 + Math.abs(d) * 0.1;
}

/** Per-note placement cost (thumb on a black key is awkward). */
function placementCost(midi, finger) {
  let cost = FINGER_BIAS[finger] || 0;
  if (finger === 1 && isBlackKey(midi)) cost += 0.7;
  return cost;
}

/** All strictly-ascending finger combinations of length k from 1..5. */
function fingerCombos(k) {
  const out = [];
  const walk = (start, acc) => {
    if (acc.length === k) {
      out.push(acc.slice());
      return;
    }
    for (let f = start; f <= 5; f++) {
      acc.push(f);
      walk(f + 1, acc);
      acc.pop();
    }
  };
  walk(1, []);
  return out;
}

/** Group one hand's notes into chord events of {idx, midi, q} sorted by q. */
function groupHandEvents(handNotes, epsilonTicks, mirror) {
  const sorted = handNotes
    .slice()
    .sort((a, b) => a.note.startTick - b.note.startTick || a.note.midi - b.note.midi);
  const events = [];
  let cur = null;
  for (const item of sorted) {
    if (cur && item.note.startTick - cur.tick <= epsilonTicks) {
      cur.items.push(item);
    } else {
      cur = { tick: item.note.startTick, items: [item] };
      events.push(cur);
    }
  }
  for (const ev of events) {
    // Dedupe doubled pitches (two tracks hitting the same key) so chord
    // combos don't have to assign two fingers to one key.
    const byMidi = new Map();
    for (const it of ev.items) byMidi.set(it.note.midi, it);
    ev.items = [...byMidi.values()].sort(
      (a, b) => (mirror ? b.note.midi - a.note.midi : a.note.midi - b.note.midi),
    );
    ev.q = ev.items.map((it) => (mirror ? -it.note.midi : it.note.midi));
  }
  return events;
}

/** Internal cost of a chord assignment (adjacent finger-pair stretches). */
function chordCost(ev, fingers) {
  let cost = 0;
  for (let i = 0; i < ev.items.length; i++) {
    cost += placementCost(ev.items[i].note.midi, fingers[i]);
  }
  for (let i = 0; i + 1 < ev.items.length; i++) {
    cost += stretchCost(ev.q[i + 1] - ev.q[i], fingers[i], fingers[i + 1]);
  }
  return cost;
}

/** Cost of moving between two consecutive events under given assignments. */
function eventTransitionCost(prev, prevFingers, next, nextFingers) {
  // Compare the thumb-side extremes and the pinky-side extremes; for two
  // single notes both pairs coincide and this is just transitionCost once.
  const last = (arr) => arr.length - 1;
  const pairs =
    prev.items.length === 1 && next.items.length === 1
      ? [[0, 0]]
      : [
          [0, 0],
          [last(prev.items), last(next.items)],
        ];
  let cost = 0;
  for (const [a, b] of pairs) {
    cost += transitionCost(prev.q[a], prevFingers[a], next.q[b], nextFingers[b]);
  }
  return cost / pairs.length;
}

/** Viterbi over one hand's events; writes results into `out` by note index. */
function solveHand(handNotes, epsilonTicks, mirror, hand, out) {
  if (handNotes.length === 0) return;
  const events = groupHandEvents(handNotes, epsilonTicks, mirror);

  // Candidate assignments per event. Chords wider than the hand (rare) get
  // a single capped 1..5 assignment instead of combinatorics.
  const candidates = events.map((ev) => {
    const k = ev.items.length;
    if (k > 5) {
      return [ev.items.map((_, i) => Math.min(5, i + 1))];
    }
    return fingerCombos(k);
  });

  // DP forward pass.
  let layer = candidates[0].map((fingers) => ({
    cost: chordCost(events[0], fingers),
    fingers,
    prev: null,
  }));
  for (let e = 1; e < events.length; e++) {
    layer = candidates[e].map((fingers) => {
      const own = chordCost(events[e], fingers);
      let best = null;
      for (const prevState of layer) {
        const total =
          prevState.cost +
          own +
          eventTransitionCost(events[e - 1], prevState.fingers, events[e], fingers);
        if (!best || total < best.cost) {
          best = { cost: total, fingers, prev: prevState };
        }
      }
      return best;
    });
  }

  // Backtrack the cheapest path and write fingers onto the note indices.
  let state = layer.reduce((a, b) => (a.cost <= b.cost ? a : b));
  for (let e = events.length - 1; e >= 0; e--) {
    const ev = events[e];
    for (let i = 0; i < ev.items.length; i++) {
      out[ev.items[i].idx] = { hand, finger: state.fingers[i] };
    }
    state = state.prev;
  }
}

/**
 * Suggest a hand + finger for every note of a piece.
 *
 * @param {Array<object>} notes  parseMidi() note list
 * @param {{ticksPerQuarter?:number}} [opts]
 * @returns {Array<{hand:'lh'|'rh', finger:number}|null>} aligned with `notes`
 */
function suggestFingerings(notes, opts = {}) {
  if (!Array.isArray(notes) || notes.length === 0) return [];
  const tpq = opts.ticksPerQuarter || 480;
  const epsilonTicks = tpq * FINGERING_CHORD_EPSILON_QUARTERS;
  const hands = assignHands(notes);
  const out = new Array(notes.length).fill(null);
  for (const [hand, mirror] of [['rh', false], ['lh', true]]) {
    const handNotes = [];
    for (let i = 0; i < notes.length; i++) {
      if (hands[i] === hand) handNotes.push({ idx: i, note: notes[i] });
    }
    solveHand(handNotes, epsilonTicks, mirror, hand, out);
  }
  // Doubled pitches deduped inside a chord still need an answer — copy from
  // the surviving duplicate.
  for (let i = 0; i < notes.length; i++) {
    if (out[i]) continue;
    for (let j = 0; j < notes.length; j++) {
      if (
        out[j] &&
        notes[j].midi === notes[i].midi &&
        notes[j].startTick === notes[i].startTick
      ) {
        out[i] = out[j];
        break;
      }
    }
  }
  return out;
}

/**
 * Convenience wrapper: mutate each note with `hand` and `finger` fields.
 * Returns the same array. Used by the app right after parseMidi().
 */
function annotateFingerings(notes, opts = {}) {
  const suggestions = suggestFingerings(notes, opts);
  for (let i = 0; i < (notes || []).length; i++) {
    const n = notes[i];
    if (!n) continue;
    if (suggestions[i]) n.hand = suggestions[i].hand;
    // The score's own fingering always wins; auto-suggest only fills the gaps.
    if (typeof n.scoreFinger === 'number') {
      n.finger = n.scoreFinger;
      n.fingerSource = 'score';
    } else if (suggestions[i]) {
      n.finger = suggestions[i].finger;
      n.fingerSource = 'auto';
    }
  }
  return notes;
}

/** Leap (semitones) that counts as a real position jump — an octave. */
const LANDMARK_LEAP_SEMITONES = 12;

/**
 * Flag the "landmark" notes — the sparse subset where a fingering reminder is
 * genuinely useful, so the score isn't cluttered with a number on every note.
 *
 * Per hand, two kinds of signal:
 *   - STRONG (always a landmark): the first note of the hand, or a RE-ENTRY
 *     after a rest of ≥ a half note (a real break in the line).
 *   - POSITION SHIFT (a landmark only if spaced out): an octave+ LEAP, or a
 *     THUMB tuck/cross (finger 1 following another finger). These are common in
 *     scales/arpeggios, so they're rate-limited to at most one per `minSpacing`
 *     per hand — otherwise a busy passage would flag nearly every note.
 *
 * Sets `n.fingerLandmark` in place and returns the array. Pure.
 *
 * @param {Array<object>} notes  fingered notes (need `finger`, `hand`/`track`)
 * @param {{ticksPerQuarter?:number}} [opts]
 */
function flagFingeringLandmarks(notes, opts = {}) {
  if (!Array.isArray(notes)) return notes;
  const tpq = opts.ticksPerQuarter || 480;
  const restGap = 2 * tpq;     // a half note of silence ⇒ a fresh entry
  const minSpacing = 2 * tpq;  // ≤ one position-shift landmark per half note
  const byHand = new Map();
  for (const n of notes) {
    n.fingerLandmark = false;
    const key = n.hand || n.track || 0;
    if (!byHand.has(key)) byHand.set(key, []);
    byHand.get(key).push(n);
  }
  for (const arr of byHand.values()) {
    arr.sort((a, b) => a.startTick - b.startTick || a.midi - b.midi);
    let prev = null;
    let lastMark = -Infinity;
    for (const n of arr) {
      let strong = false;
      let shift = false;
      if (!prev) {
        strong = true; // hand entry
      } else {
        if (n.startTick - prev.endTick >= restGap) strong = true; // re-entry
        if (Math.abs(n.midi - prev.midi) >= LANDMARK_LEAP_SEMITONES) shift = true;
        if (n.finger === 1 && prev.finger && prev.finger !== 1 && n.midi !== prev.midi) {
          shift = true; // thumb tuck / cross
        }
      }
      const mark = strong || (shift && n.startTick - lastMark >= minSpacing);
      if (mark) {
        n.fingerLandmark = true;
        lastMark = n.startTick;
      }
      prev = n;
    }
  }
  return notes;
}

// ---- Node export shim (browser-safe) ------------------------------------
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    FINGERING_CHORD_EPSILON_QUARTERS,
    HAND_SPLIT_MIDI,
    assignHands,
    suggestFingerings,
    annotateFingerings,
    flagFingeringLandmarks,
  };
}
