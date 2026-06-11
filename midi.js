// PianoSRS — MIDI parsing + algorithmic sectioning (pure, no DOM/audio).
//
// This module replaces the PDF subsystem's source-of-truth. A piece is now a
// Standard MIDI File (SMF). We parse the raw bytes into a flat list of note
// events (with both tick and second timing), then split the piece into short
// practice sections at natural musical gaps.
//
// Everything here is PURE — no IndexedDB, no DOM, no AudioContext, no
// `Date.now()` — so it runs identically in the browser (classic <script>
// global) and under Node for unit tests (see the export shim at the bottom).
//
// Public API:
//   parseMidi(arrayBuffer)            → { format, ticksPerQuarter, durationSec, notes }
//   sectionizeByPhrase(notes, tpq, o) → [{ startTick, endTick, startSec, endSec, name, order }]
//   groupNotesIntoSteps(notes, opts)  → [{ tick, sec, pitches:[...] }]  (wait-mode chords)

// ---- Tunable constants --------------------------------------------------

/** Default tempo when a file declares none: 120 BPM = 500 000 µs/quarter. */
const DEFAULT_TEMPO_US = 500000;

/** Phrase split threshold, as a fraction of a quarter note. A silence of at
 *  least this long between "everything has stopped sounding" and the next
 *  onset is treated as a phrase boundary. 1.0 ≈ a quarter rest. */
const PHRASE_GAP_QUARTERS = 1.0;

/** Target section sizing (in note count). Tiny phrases merge forward until
 *  they reach MIN_SECTION_NOTES; long gap-free runs split at MAX_SECTION_NOTES. */
const MIN_SECTION_NOTES = 6;
const MAX_SECTION_NOTES = 24;

/** Two onsets within this fraction of a quarter note are treated as one
 *  chord/step for wait-mode (so a rolled or slightly-uneven chord still counts
 *  as a single "press these keys" step). */
const CHORD_EPSILON_QUARTERS = 1 / 16;

// ---- Low-level byte reader ----------------------------------------------

/**
 * Minimal big-endian byte cursor over a Uint8Array. SMF is big-endian.
 */
function makeReader(bytes) {
  let pos = 0;
  return {
    get pos() {
      return pos;
    },
    set pos(p) {
      pos = p;
    },
    get length() {
      return bytes.length;
    },
    eof() {
      return pos >= bytes.length;
    },
    u8() {
      return bytes[pos++];
    },
    u16() {
      const v = (bytes[pos] << 8) | bytes[pos + 1];
      pos += 2;
      return v;
    },
    u32() {
      const v =
        (bytes[pos] * 0x1000000) +
        (bytes[pos + 1] << 16) +
        (bytes[pos + 2] << 8) +
        bytes[pos + 3];
      pos += 4;
      return v >>> 0;
    },
    /** 4-char ASCII chunk id, e.g. "MThd" / "MTrk". */
    chunkId() {
      const s = String.fromCharCode(
        bytes[pos],
        bytes[pos + 1],
        bytes[pos + 2],
        bytes[pos + 3],
      );
      pos += 4;
      return s;
    },
    /** Read `n` raw bytes as a subarray and advance. */
    bytes(n) {
      const out = bytes.subarray(pos, pos + n);
      pos += n;
      return out;
    },
    /** Variable-length quantity (7 bits per byte, high bit = continue). */
    varint() {
      let value = 0;
      let b;
      do {
        b = bytes[pos++];
        value = (value << 7) | (b & 0x7f);
      } while (b & 0x80);
      return value >>> 0;
    },
  };
}

// ---- SMF parser ---------------------------------------------------------

/**
 * Parse a Standard MIDI File from an ArrayBuffer (or Uint8Array).
 *
 * Returns a flat, time-sorted note list. Each note carries both tick and
 * second timing; seconds are derived from a global tempo map so a file with
 * mid-piece tempo changes still lands on the right wall-clock times.
 *
 * @param {ArrayBuffer|Uint8Array} input
 * @returns {{format:number, ticksPerQuarter:number, trackCount:number,
 *            durationSec:number, notes:Array<object>}}
 */
function parseMidi(input) {
  const bytes =
    input instanceof Uint8Array ? input : new Uint8Array(input);
  const r = makeReader(bytes);

  if (r.length < 14 || r.chunkId() !== 'MThd') {
    throw new Error('Not a MIDI file (missing MThd header).');
  }
  const headerLen = r.u32();
  const format = r.u16();
  const trackCount = r.u16();
  const division = r.u16();
  // Skip any extra header bytes (spec says length is 6, but be defensive).
  r.pos = 8 + headerLen;

  if (division & 0x8000) {
    // SMPTE timecode division — rare for piano scores. We don't support the
    // frames-based timing model; fall back to a sane PPQ so the file still
    // loads rather than throwing.
    throw new Error('SMPTE-timed MIDI files are not supported.');
  }
  const ticksPerQuarter = division || 480;

  // Pass 1: read every track into events with ABSOLUTE ticks. We also collect
  // tempo changes globally (they may live in any track, usually track 0).
  /** @type {Array<{tick:number, type:'on'|'off', midi:number, velocity:number, channel:number, track:number}>} */
  const rawNoteEvents = [];
  /** @type {Array<{tick:number, usPerQuarter:number}>} */
  const tempoEvents = [];
  /** @type {Array<{tick:number, numerator:number, denominator:number}>} */
  const timeSignatures = [];

  for (let t = 0; t < trackCount && !r.eof(); t++) {
    if (r.chunkId() !== 'MTrk') break; // malformed / trailing junk — stop.
    const trackLen = r.u32();
    const trackEnd = r.pos + trackLen;
    let absTick = 0;
    let runningStatus = 0;

    while (r.pos < trackEnd) {
      absTick += r.varint();
      let status = bytes[r.pos];
      if (status & 0x80) {
        r.pos++;
        runningStatus = status;
      } else {
        // Running status: reuse the previous status byte.
        status = runningStatus;
      }

      const hi = status & 0xf0;
      const channel = status & 0x0f;

      if (status === 0xff) {
        // Meta event.
        const metaType = r.u8();
        const len = r.varint();
        const data = r.bytes(len);
        if (metaType === 0x51 && len === 3) {
          const us = (data[0] << 16) | (data[1] << 8) | data[2];
          tempoEvents.push({ tick: absTick, usPerQuarter: us });
        } else if (metaType === 0x58 && len >= 2) {
          timeSignatures.push({
            tick: absTick,
            numerator: data[0],
            denominator: Math.pow(2, data[1]),
          });
        } else if (metaType === 0x2f) {
          break; // End of track.
        }
        // All other meta events ignored.
      } else if (status === 0xf0 || status === 0xf7) {
        // SysEx — skip its payload.
        const len = r.varint();
        r.bytes(len);
      } else if (hi === 0x90) {
        const note = r.u8();
        const velocity = r.u8();
        rawNoteEvents.push({
          tick: absTick,
          type: velocity > 0 ? 'on' : 'off',
          midi: note,
          velocity,
          channel,
          track: t,
        });
      } else if (hi === 0x80) {
        const note = r.u8();
        const velocity = r.u8();
        rawNoteEvents.push({
          tick: absTick,
          type: 'off',
          midi: note,
          velocity,
          channel,
          track: t,
        });
      } else if (hi === 0xa0 || hi === 0xb0 || hi === 0xe0) {
        r.u8();
        r.u8(); // 2 data bytes, ignored.
      } else if (hi === 0xc0 || hi === 0xd0) {
        r.u8(); // 1 data byte, ignored.
      } else {
        // Unknown status — bail out of this track to avoid desyncing.
        break;
      }
    }
    r.pos = trackEnd; // Resync to the declared chunk end regardless.
  }

  const tempoMap = buildTempoMap(tempoEvents, ticksPerQuarter);
  const notes = pairNotes(rawNoteEvents, tempoMap);

  const durationSec = notes.reduce((m, n) => Math.max(m, n.endSec), 0);

  return {
    format,
    ticksPerQuarter,
    trackCount,
    timeSignatures,
    durationSec,
    notes,
  };
}

/**
 * Build a tick→seconds converter from a list of tempo changes. Returns a
 * function `tickToSec(tick)`. Piecewise-linear across tempo segments. Pure.
 */
function buildTempoMap(tempoEvents, ticksPerQuarter) {
  const sorted = tempoEvents
    .slice()
    .sort((a, b) => a.tick - b.tick);
  // Ensure a segment starting at tick 0.
  if (sorted.length === 0 || sorted[0].tick > 0) {
    sorted.unshift({ tick: 0, usPerQuarter: DEFAULT_TEMPO_US });
  }
  // Precompute the cumulative seconds at the start of each segment.
  const segs = [];
  let accSec = 0;
  for (let i = 0; i < sorted.length; i++) {
    const seg = sorted[i];
    segs.push({ tick: seg.tick, sec: accSec, usPerQuarter: seg.usPerQuarter });
    const nextTick = i + 1 < sorted.length ? sorted[i + 1].tick : null;
    if (nextTick !== null) {
      const dTicks = nextTick - seg.tick;
      accSec += (dTicks / ticksPerQuarter) * (seg.usPerQuarter / 1e6);
    }
  }
  return function tickToSec(tick) {
    // Find the last segment whose tick <= the query.
    let lo = 0;
    let hi = segs.length - 1;
    let idx = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (segs[mid].tick <= tick) {
        idx = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    const seg = segs[idx];
    const dTicks = tick - seg.tick;
    return seg.sec + (dTicks / ticksPerQuarter) * (seg.usPerQuarter / 1e6);
  };
}

/**
 * Pair note-on/note-off events into notes with start/end timing. Pure.
 * Pairing is per (track, channel, midi) using a FIFO stack so overlapping
 * repeats of the same pitch nest correctly.
 */
function pairNotes(rawNoteEvents, tickToSec) {
  // Stable sort by tick, with note-offs before note-ons at the same tick so a
  // zero-length retrigger closes before reopening.
  const events = rawNoteEvents
    .map((e, i) => ({ ...e, _i: i }))
    .sort((a, b) => {
      if (a.tick !== b.tick) return a.tick - b.tick;
      if (a.type !== b.type) return a.type === 'off' ? -1 : 1;
      return a._i - b._i;
    });

  /** @type {Map<string, Array<object>>} key = `${track}:${channel}:${midi}` */
  const open = new Map();
  const notes = [];

  for (const e of events) {
    const key = `${e.track}:${e.channel}:${e.midi}`;
    if (e.type === 'on') {
      if (!open.has(key)) open.set(key, []);
      open.get(key).push(e);
    } else {
      const stack = open.get(key);
      if (stack && stack.length) {
        const on = stack.shift();
        notes.push({
          midi: e.midi,
          startTick: on.tick,
          endTick: e.tick,
          startSec: tickToSec(on.tick),
          endSec: tickToSec(e.tick),
          velocity: on.velocity,
          channel: e.channel,
          track: e.track,
        });
      }
    }
  }

  // Close any dangling note-ons (missing note-off) at their own start tick +
  // a small default so they still render.
  for (const [, stack] of open) {
    for (const on of stack) {
      const endTick = on.tick + 1;
      notes.push({
        midi: on.midi,
        startTick: on.tick,
        endTick,
        startSec: tickToSec(on.tick),
        endSec: tickToSec(endTick),
        velocity: on.velocity,
        channel: on.channel,
        track: on.track,
      });
    }
  }

  notes.sort((a, b) => a.startTick - b.startTick || a.midi - b.midi);
  return notes;
}

// ---- Algorithmic sectioning ---------------------------------------------

/**
 * Split a note list into short practice sections at musical phrase
 * boundaries. Boundaries are silences (gaps where nothing is sounding) at
 * least `gapThreshold` ticks long; tiny phrases are merged forward and long
 * gap-free runs are hard-split so sections stay roughly even in size. Pure.
 *
 * @param {Array<object>} notes  output of parseMidi().notes (start-sorted)
 * @param {number} ticksPerQuarter
 * @param {object} [opts] {gapThreshold, minNotes, maxNotes}
 * @returns {Array<{startTick,endTick,startSec,endSec,name,order}>}
 */
function sectionizeByPhrase(notes, ticksPerQuarter, opts = {}) {
  if (!Array.isArray(notes) || notes.length === 0) return [];

  const gapThreshold =
    typeof opts.gapThreshold === 'number'
      ? opts.gapThreshold
      : Math.round(ticksPerQuarter * PHRASE_GAP_QUARTERS);
  const minNotes = opts.minNotes || MIN_SECTION_NOTES;
  const maxNotes = opts.maxNotes || MAX_SECTION_NOTES;

  // Start-sorted copy (parseMidi already sorts, but don't assume).
  const ns = notes.slice().sort((a, b) => a.startTick - b.startTick);

  // Pass 1: raw phrases at silence gaps. `soundingUntil` tracks the furthest
  // endTick of any note started so far — a gap exists when the next onset is
  // far enough past it.
  /** @type {Array<[number, number]>} inclusive [startIdx, endIdx] */
  const phrases = [];
  let runStart = 0;
  let soundingUntil = ns[0].endTick;
  for (let i = 1; i < ns.length; i++) {
    if (ns[i].startTick - soundingUntil >= gapThreshold) {
      phrases.push([runStart, i - 1]);
      runStart = i;
    }
    soundingUntil = Math.max(soundingUntil, ns[i].endTick);
  }
  phrases.push([runStart, ns.length - 1]);

  // Pass 2: merge phrases shorter than minNotes into the following phrase
  // (and a too-small trailing phrase backward into the previous).
  const merged = [];
  for (const ph of phrases) {
    const count = ph[1] - ph[0] + 1;
    if (merged.length && count < minNotes) {
      // Fold into the previous accumulated group if that group is itself
      // still under target; otherwise start a new group that may grow.
      const prev = merged[merged.length - 1];
      const prevCount = prev[1] - prev[0] + 1;
      if (prevCount < minNotes) {
        prev[1] = ph[1];
        continue;
      }
    }
    merged.push([ph[0], ph[1]]);
  }
  // If the final group is still tiny, fold it back.
  if (merged.length >= 2) {
    const last = merged[merged.length - 1];
    if (last[1] - last[0] + 1 < minNotes) {
      merged[merged.length - 2][1] = last[1];
      merged.pop();
    }
  }

  // Pass 3: hard-split any group longer than maxNotes into even chunks.
  const finalRuns = [];
  for (const [a, b] of merged) {
    const count = b - a + 1;
    if (count <= maxNotes) {
      finalRuns.push([a, b]);
    } else {
      const chunks = Math.ceil(count / maxNotes);
      const size = Math.ceil(count / chunks);
      for (let s = a; s <= b; s += size) {
        finalRuns.push([s, Math.min(b, s + size - 1)]);
      }
    }
  }

  // Emit sections.
  return finalRuns.map(([a, b], idx) => {
    let endTick = ns[a].endTick;
    let endSec = ns[a].endSec;
    for (let i = a; i <= b; i++) {
      if (ns[i].endTick > endTick) endTick = ns[i].endTick;
      if (ns[i].endSec > endSec) endSec = ns[i].endSec;
    }
    return {
      startTick: ns[a].startTick,
      endTick,
      startSec: ns[a].startSec,
      endSec,
      noteCount: b - a + 1,
      name: `Section ${idx + 1}`,
      order: idx,
    };
  });
}

/**
 * Combine a contiguous slice of phrase ranges into one tick/second window.
 * Internal helper for makeDerivedRanges. Pure.
 */
function combineRanges(slice) {
  let startTick = Infinity;
  let startSec = Infinity;
  let endTick = -Infinity;
  let endSec = -Infinity;
  let noteCount = 0;
  for (const r of slice) {
    if (r.startTick < startTick) startTick = r.startTick;
    if (r.startSec < startSec) startSec = r.startSec;
    if (r.endTick > endTick) endTick = r.endTick;
    if (r.endSec > endSec) endSec = r.endSec;
    noteCount += r.noteCount || 0;
  }
  return { startTick, endTick, startSec, endSec, noteCount };
}

/**
 * Build the derived practice sections that join phrase sections together so
 * the seams between them get reviewed for fluency, not just the phrases
 * themselves:
 *
 *   1. Transitions — every overlapping adjacent pair (1+2, 2+3, …), so each
 *      boundary gets drilled at the smallest scale. `kind: 'transition'`.
 *   2. Run-throughs — combined spans that double in size (sections 1–4,
 *      5–8, then 1–8, …) up to one full-piece run-through, so fluency is
 *      built up progressively. `kind: 'fluency'`.
 *
 * Spans that duplicate an earlier-emitted span (e.g. a trailing group of two
 * that equals a transition pair, or a full run-through of a two-section
 * piece) are skipped. Returns [] when there are fewer than two ranges.
 * `order` continues sequentially after the phrase ranges. Pure.
 *
 * @param {Array<object>} ranges  output of sectionizeByPhrase()
 * @returns {Array<object>} ranges shaped like sectionizeByPhrase's entries,
 *   plus `kind` and a prefilled `notes` string
 */
function makeDerivedRanges(ranges) {
  if (!Array.isArray(ranges) || ranges.length < 2) return [];
  const n = ranges.length;
  const out = [];
  const seen = new Set();
  let order = n;

  /** Emit the span covering ranges[s..e) unless that span already exists. */
  const emit = (s, e, kind, name, notes) => {
    const key = `${s}:${e}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({
      ...combineRanges(ranges.slice(s, e)),
      name,
      order: order++,
      kind,
      notes,
    });
  };

  // 1. Overlapping transition pairs — one per boundary.
  for (let i = 0; i + 1 < n; i++) {
    emit(
      i,
      i + 2,
      'transition',
      `Transition (Sections ${i + 1}+${i + 2})`,
      `Link Sections ${i + 1} and ${i + 2} — practice the seam between them.`,
    );
  }

  // 2. Doubling run-throughs: groups of 4, 8, … then the full piece.
  for (let size = 4; size < n; size *= 2) {
    for (let s = 0; s < n; s += size) {
      const e = Math.min(n, s + size);
      if (e - s < 2) continue; // lone trailing section — already a phrase
      emit(
        s,
        e,
        'fluency',
        `Run-through (Sections ${s + 1}–${e})`,
        `Play Sections ${s + 1}–${e} back to back — focus on the transitions.`,
      );
    }
  }
  emit(
    0,
    n,
    'fluency',
    `Run-through (Sections 1–${n})`,
    'Play all sections back to back — focus on the transitions.',
  );

  return out;
}

/**
 * Filter a piece's notes down to a single section's tick window.
 * A note belongs to the section if it starts within [startTick, endTick).
 * Pure helper shared by the player and tests.
 */
function notesInSection(notes, section) {
  return notes.filter(
    (n) => n.startTick >= section.startTick && n.startTick < section.endTick,
  );
}

/**
 * Group near-simultaneous note onsets into ordered "steps" for wait-mode.
 * Each step is the set of pitches the player must press to advance. Pure.
 *
 * @param {Array<object>} notes  (any subset, e.g. one section / one hand)
 * @param {object} [opts] {ticksPerQuarter, epsilon}
 * @returns {Array<{tick:number, sec:number, pitches:number[]}>}
 */
function groupNotesIntoSteps(notes, opts = {}) {
  if (!Array.isArray(notes) || notes.length === 0) return [];
  const tpq = opts.ticksPerQuarter || 480;
  const epsilon =
    typeof opts.epsilon === 'number'
      ? opts.epsilon
      : Math.max(1, Math.round(tpq * CHORD_EPSILON_QUARTERS));

  const sorted = notes
    .slice()
    .sort((a, b) => a.startTick - b.startTick || a.midi - b.midi);

  const steps = [];
  let cur = null;
  for (const n of sorted) {
    if (cur && n.startTick - cur.tick <= epsilon) {
      if (!cur.pitches.includes(n.midi)) cur.pitches.push(n.midi);
    } else {
      cur = { tick: n.startTick, sec: n.startSec, pitches: [n.midi] };
      steps.push(cur);
    }
  }
  for (const s of steps) s.pitches.sort((a, b) => a - b);
  return steps;
}

// ---- Node export shim (browser-safe) ------------------------------------
// In the browser these are plain globals (classic <script>). Under Node the
// object-literal assignment is picked up by the CJS→ESM interop so the test
// files can `import` them. `module` is undefined in the browser, so this is
// skipped there with no error.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    DEFAULT_TEMPO_US,
    PHRASE_GAP_QUARTERS,
    MIN_SECTION_NOTES,
    MAX_SECTION_NOTES,
    CHORD_EPSILON_QUARTERS,
    parseMidi,
    buildTempoMap,
    pairNotes,
    sectionizeByPhrase,
    makeDerivedRanges,
    notesInSection,
    groupNotesIntoSteps,
  };
}
