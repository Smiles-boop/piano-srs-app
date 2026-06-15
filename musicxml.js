// PianoSRS — MusicXML measure parsing + section alignment (pure, no DOM).
//
// Goal: given a piece's MusicXML score, work out which MEASURES correspond to
// each practice section. Sections are defined as MIDI tick windows
// (`startTick`/`endTick`); MusicXML is measures with durations in
// "divisions". The bridge is a neutral axis — the QUARTER NOTE:
//
//   - every measure gets a `startQuarter` + `durationQuarter` (pure function
//     of the score's divisions, no MIDI knowledge), and
//   - a section's tick window converts to quarters via `tick / ticksPerQuarter`.
//
// Then "which measures does this section cover?" is a plain interval overlap
// in quarter space. This keeps the module decoupled: it parses notation, it
// does not know what a MIDI tick is.
//
// Parsing is done with a small self-contained string scanner rather than
// DOMParser, so the exact same code runs in the browser (classic <script>
// global) and under Node for the tests — mirroring how midi.js hand-reads
// binary. MusicXML from notation software (MuseScore, Finale, Sibelius) is
// well-formed and regular enough that a lenient SAX-style pass is robust;
// the one assumption is that attribute values don't contain a raw '>',
// which real exports never do.
//
// Timing model (the subtle part):
//   - A measure's length is the furthest point its content reaches — we run
//     a time cursor through the first part's notes, honouring <chord/> (no
//     advance), <backup>/<forward> (multi-voice piano), and grace notes
//     (no duration). Summing note durations would double-count voices; the
//     max-extent cursor is correct.
//   - Only the FIRST <part> defines the measure grid (score-partwise lists
//     every measure of part 1, then part 2, …; all parts share the grid).
//
// Exports (browser globals + CJS shim like midi.js):
//   parseMusicXml(xml) → { measures, notes, divisions, ticksPerQuarter, durationSec }
//   measuresInQuarterRange(measures, qStart, qEnd) → measures overlapping [qStart,qEnd)
//   measuresForSection(parsed, section, ticksPerQuarter) → { measures, count, firstNumber, lastNumber }

/** Read an attribute value out of a raw tag-attribute string. */
function xmlAttr(raw, name) {
  if (!raw) return null;
  const dq = new RegExp(`${name}\\s*=\\s*"([^"]*)"`).exec(raw);
  if (dq) return dq[1];
  const sq = new RegExp(`${name}\\s*=\\s*'([^']*)'`).exec(raw);
  return sq ? sq[1] : null;
}

/**
 * Stream a MusicXML string into open/close/text tokens. Skips XML
 * declarations, DOCTYPEs, comments, and unwraps CDATA as text. Self-closing
 * tags (`<chord/>`) emit an open (with selfClose:true) immediately followed
 * by a close, so the consumer's element stack stays balanced.
 */
function* tokenizeXml(xml) {
  let i = 0;
  const n = xml.length;
  while (i < n) {
    const lt = xml.indexOf('<', i);
    if (lt === -1) break;
    if (lt > i) yield { type: 'text', value: xml.slice(i, lt) };

    if (xml.startsWith('<!--', lt)) {
      const end = xml.indexOf('-->', lt + 4);
      i = end === -1 ? n : end + 3;
      continue;
    }
    if (xml.startsWith('<?', lt)) {
      const end = xml.indexOf('?>', lt + 2);
      i = end === -1 ? n : end + 2;
      continue;
    }
    if (xml.startsWith('<![CDATA[', lt)) {
      const end = xml.indexOf(']]>', lt + 9);
      yield { type: 'text', value: xml.slice(lt + 9, end === -1 ? n : end) };
      i = end === -1 ? n : end + 3;
      continue;
    }
    if (xml.startsWith('<!', lt)) {
      const end = xml.indexOf('>', lt + 2);
      i = end === -1 ? n : end + 1;
      continue;
    }
    const gt = xml.indexOf('>', lt + 1);
    if (gt === -1) break;
    let raw = xml.slice(lt + 1, gt);
    let selfClose = false;
    if (raw.endsWith('/')) {
      selfClose = true;
      raw = raw.slice(0, -1);
    }
    raw = raw.trim();
    if (raw.startsWith('/')) {
      // `start` is the index of this close tag's '<', i.e. a safe point to
      // splice content in just before it (used for fingering injection).
      yield { type: 'close', name: raw.slice(1).trim(), start: lt };
    } else {
      const sp = raw.search(/\s/);
      const name = sp === -1 ? raw : raw.slice(0, sp);
      const attrs = sp === -1 ? '' : raw.slice(sp);
      yield { type: 'open', name, attrs, selfClose };
      if (selfClose) yield { type: 'close', name, start: lt };
    }
    i = gt + 1;
  }
}

/**
 * Parse a MusicXML string into a measure grid. Returns the measures of the
 * first part, each with a cumulative `startQuarter` and `durationQuarter`.
 * Pure — no DOM, no clock.
 *
 * Also derives a parseMidi-compatible `notes` array from the same single
 * pass (pitch, absolute ticks, hand via staff, ties merged, chords sharing an
 * onset), so a score can drive the practice engine with no MIDI file.
 *
 * @param {string} xml  raw MusicXML (score-partwise) text
 * @returns {{
 *   measures: Array<{number:string, index:number, startQuarter:number, durationQuarter:number}>,
 *   notes: Array<{midi:number, startTick:number, endTick:number, startSec:number, endSec:number, track:number, velocity:number, channel:number}>,
 *   divisions:number, ticksPerQuarter:number, durationSec:number,
 * }}
 */
/** Canonical MIDI ticks-per-quarter for derived notes (matches parseMidi). */
const DERIVED_TPQ = 480;

/** Diatonic step → semitone offset within an octave. */
const STEP_SEMITONE = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

function parseMusicXml(xml) {
  if (typeof xml !== 'string' || !xml) {
    return {
      measures: [],
      notes: [],
      divisions: 1,
      ticksPerQuarter: DERIVED_TPQ,
      durationSec: 0,
    };
  }

  let divisions = 1;            // divisions per quarter (updates on <divisions>)
  let beats = null;            // time-signature numerator
  let beatType = null;         // time-signature denominator
  let firstPartId = null;
  let ignoreRest = false;      // true once a SECOND part starts
  let tempo = 120;             // quarter-notes per minute (first <sound tempo>)
  let sawTempo = false;

  const measures = [];
  const notes = [];            // derived parseMidi-compatible note objects
  const openTies = new Map();  // `${midi}:${track}` → note awaiting a tie-stop
  let cumulativeQuarter = 0;
  let prevDurationQuarter = 0;

  // Per-measure cursor state.
  let inMeasure = false;
  let cursor = 0;              // current position within the measure (divisions)
  let maxCursor = 0;           // furthest extent reached (= measure length)
  let lastOnsetCursor = 0;     // onset of the most recent non-chord note
  let measureNumber = '';

  // Per-note / per-backup-forward state.
  let inNote = false;
  let noteChord = false;
  let noteGrace = false;
  let noteRest = false;
  let noteDuration = 0;
  let noteStep = null;
  let noteAlter = 0;
  let noteOctave = null;
  let noteStaff = 1;
  let noteTieStart = false;
  let noteTieStop = false;
  let noteScoreFinger = null;  // human fingering from <technical><fingering>
  let bfKind = null;           // 'backup' | 'forward' | null
  let bfDuration = 0;

  const stack = [];

  for (const tok of tokenizeXml(xml)) {
    if (tok.type === 'open') {
      stack.push(tok.name);
      switch (tok.name) {
        case 'part': {
          const id = xmlAttr(tok.attrs, 'id');
          if (firstPartId === null) firstPartId = id;
          else if (id !== firstPartId) ignoreRest = true;
          break;
        }
        case 'measure':
          if (!ignoreRest) {
            inMeasure = true;
            cursor = 0;
            maxCursor = 0;
            lastOnsetCursor = 0;
            measureNumber = xmlAttr(tok.attrs, 'number') || String(measures.length + 1);
          }
          break;
        case 'note':
          if (inMeasure) {
            inNote = true;
            noteChord = false;
            noteGrace = false;
            noteRest = false;
            noteDuration = 0;
            noteStep = null;
            noteAlter = 0;
            noteOctave = null;
            noteStaff = 1;
            noteTieStart = false;
            noteTieStop = false;
            noteScoreFinger = null;
          }
          break;
        case 'chord':
          if (inNote) noteChord = true;
          break;
        case 'grace':
          if (inNote) noteGrace = true;
          break;
        case 'rest':
          if (inNote) noteRest = true;
          break;
        case 'tie':
          if (inNote) {
            const t = xmlAttr(tok.attrs, 'type');
            if (t === 'start') noteTieStart = true;
            else if (t === 'stop') noteTieStop = true;
          }
          break;
        case 'sound': {
          const t = xmlAttr(tok.attrs, 'tempo');
          if (t && !sawTempo) {
            const bpm = parseFloat(t);
            if (bpm > 0) { tempo = bpm; sawTempo = true; }
          }
          break;
        }
        case 'backup':
          if (inMeasure) { bfKind = 'backup'; bfDuration = 0; }
          break;
        case 'forward':
          if (inMeasure) { bfKind = 'forward'; bfDuration = 0; }
          break;
        default:
          break;
      }
    } else if (tok.type === 'text') {
      const top = stack[stack.length - 1];
      const parent = stack[stack.length - 2];
      const v = tok.value.trim();
      if (!v) continue;
      if (top === 'divisions') {
        const d = parseInt(v, 10);
        if (Number.isFinite(d) && d > 0) divisions = d;
      } else if (top === 'beats') {
        beats = parseInt(v, 10) || beats;
      } else if (top === 'beat-type') {
        beatType = parseInt(v, 10) || beatType;
      } else if (top === 'duration') {
        const d = parseFloat(v) || 0;
        if (parent === 'note' && inNote) noteDuration = d;
        else if (parent === 'backup' || parent === 'forward') bfDuration = d;
      } else if (inNote && top === 'step') {
        noteStep = v;
      } else if (inNote && top === 'alter') {
        noteAlter = parseInt(v, 10) || 0;
      } else if (inNote && top === 'octave') {
        noteOctave = parseInt(v, 10);
      } else if (inNote && top === 'staff') {
        noteStaff = parseInt(v, 10) || 1;
      } else if (inNote && top === 'fingering' && noteScoreFinger == null) {
        // Human fingering from the score (<technical><fingering>). Keep the
        // first value if a substitution lists several.
        const f = parseInt(v, 10);
        if (Number.isFinite(f) && f >= 1 && f <= 5) noteScoreFinger = f;
      }
    } else if (tok.type === 'close') {
      // Pop the matching element off the stack.
      for (let k = stack.length - 1; k >= 0; k--) {
        if (stack[k] === tok.name) { stack.splice(k, 1); break; }
      }
      switch (tok.name) {
        case 'note':
          if (inMeasure && inNote) {
            // Emit a pitched, non-grace, non-rest note. Onset is the cursor for
            // a normal note, or the lead note's onset for a <chord/> member.
            if (noteStep && noteOctave !== null && !noteGrace && !noteRest) {
              const onsetCursor = noteChord ? lastOnsetCursor : cursor;
              const onsetQ = cumulativeQuarter + onsetCursor / divisions;
              const endQ = onsetQ + noteDuration / divisions;
              const midi =
                (noteOctave + 1) * 12 + (STEP_SEMITONE[noteStep] || 0) + noteAlter;
              const track = Math.max(0, noteStaff - 1);
              const spq = 60 / tempo;
              const key = `${midi}:${track}`;
              if (noteTieStop && openTies.has(key)) {
                // Continuation of a tie — extend the held note, don't re-emit,
                // so wait-mode practice asks for the key once, not again.
                const prev = openTies.get(key);
                prev.endTick = Math.round(endQ * DERIVED_TPQ);
                prev.endSec = endQ * spq;
                if (!noteTieStart) openTies.delete(key);
              } else {
                const note = {
                  midi,
                  startTick: Math.round(onsetQ * DERIVED_TPQ),
                  endTick: Math.round(endQ * DERIVED_TPQ),
                  startSec: onsetQ * spq,
                  endSec: endQ * spq,
                  track,
                  velocity: 80,
                  channel: 0,
                  // Character index of this note's `</note>` in the source XML,
                  // so fingerings can be spliced back in for the score view.
                  injectAt: tok.start,
                };
                // Preserve the score's own fingering when it provides one.
                if (noteScoreFinger != null) note.scoreFinger = noteScoreFinger;
                notes.push(note);
                if (noteTieStart) openTies.set(key, note);
              }
            }
            // Advance the measure cursor (time) for non-chord, non-grace notes.
            if (!noteGrace && !noteChord) {
              lastOnsetCursor = cursor;
              cursor += noteDuration;
              if (cursor > maxCursor) maxCursor = cursor;
            }
            inNote = false;
          }
          break;
        case 'backup':
          if (inMeasure && bfKind === 'backup') {
            cursor = Math.max(0, cursor - bfDuration);
            bfKind = null;
          }
          break;
        case 'forward':
          if (inMeasure && bfKind === 'forward') {
            cursor += bfDuration;
            if (cursor > maxCursor) maxCursor = cursor;
            bfKind = null;
          }
          break;
        case 'measure':
          if (inMeasure) {
            let durationQuarter = maxCursor / divisions;
            if (!(durationQuarter > 0)) {
              // Empty measure → fall back to the time signature, then to the
              // previous measure's length, so the grid never collapses.
              durationQuarter =
                beats && beatType ? (beats * 4) / beatType : prevDurationQuarter;
            }
            measures.push({
              number: measureNumber,
              index: measures.length,
              startQuarter: cumulativeQuarter,
              durationQuarter,
            });
            cumulativeQuarter += durationQuarter;
            prevDurationQuarter = durationQuarter;
            inMeasure = false;
          }
          break;
        default:
          break;
      }
    }
  }

  // Sort by onset then pitch so consumers that assume start-ordered notes
  // (the player's step grouping, sectionizeByPhrase) behave exactly as with
  // parseMidi output.
  notes.sort((a, b) => a.startTick - b.startTick || a.midi - b.midi);
  let durationSec = 0;
  for (const n of notes) if (n.endSec > durationSec) durationSec = n.endSec;

  return { measures, notes, divisions, ticksPerQuarter: DERIVED_TPQ, durationSec };
}

/**
 * Measures overlapping the half-open quarter-note range [qStart, qEnd).
 * A measure overlaps when it starts before the range ends and ends after the
 * range starts — so a section that begins exactly on a barline includes that
 * measure, and one that ends exactly on a barline excludes the next. Pure.
 */
function measuresInQuarterRange(measures, qStart, qEnd) {
  if (!Array.isArray(measures)) return [];
  return measures.filter(
    (m) =>
      m.startQuarter < qEnd && m.startQuarter + m.durationQuarter > qStart,
  );
}

/**
 * Map a practice section (MIDI tick window) to the score measures it covers.
 * This is the one function that bridges tick-space and quarter-space, so it's
 * the only place `ticksPerQuarter` is needed.
 *
 * @param {{measures:Array}} parsed  output of parseMusicXml()
 * @param {{startTick:number, endTick:number}} section
 * @param {number} ticksPerQuarter  the piece's MIDI division (e.g. 480)
 * @returns {{ measures:Array, count:number, firstNumber:string|null, lastNumber:string|null }}
 */
function measuresForSection(parsed, section, ticksPerQuarter) {
  const measures = parsed && Array.isArray(parsed.measures) ? parsed.measures : [];
  const tpq = ticksPerQuarter > 0 ? ticksPerQuarter : 480;
  const qStart = (section.startTick || 0) / tpq;
  const qEnd = (section.endTick || 0) / tpq;
  const hit = measuresInQuarterRange(measures, qStart, qEnd);
  return {
    measures: hit,
    count: hit.length,
    firstNumber: hit.length ? hit[0].number : null,
    lastNumber: hit.length ? hit[hit.length - 1].number : null,
  };
}

/**
 * Splice SUGGESTED fingerings into the score XML so OpenSheetMusicDisplay can
 * engrave them natively. Only notes flagged `fingerLandmark` get a number, so
 * the score stays readable — and notes that already carry the score's own
 * `scoreFinger` are skipped, since OSMD renders those straight from the source
 * (the human fingering always wins). Each note carries an `injectAt` index (the
 * offset of its `</note>` in the original XML, set by parseMusicXml); we insert
 * a `<notations><technical><fingering>` there, splicing from the end so earlier
 * offsets stay valid. Returns the original XML unchanged if there's nothing to
 * add. Pure.
 *
 * @param {string} xml    the same XML string parseMusicXml consumed
 * @param {Array<object>} notes  parseMusicXml notes, fingered + landmark-flagged
 */
function injectFingerings(xml, notes) {
  if (typeof xml !== 'string' || !Array.isArray(notes)) return xml;
  const points = [];
  for (const n of notes) {
    if (!n || !n.fingerLandmark) continue;
    if (n.scoreFinger != null) continue; // the score already shows its own
    if (typeof n.injectAt !== 'number') continue;
    if (!(n.finger >= 1 && n.finger <= 5)) continue;
    points.push({ at: n.injectAt, finger: n.finger });
  }
  if (!points.length) return xml;
  points.sort((a, b) => b.at - a.at); // splice back-to-front
  let out = xml;
  for (const p of points) {
    const tag =
      `<notations><technical><fingering>${p.finger}</fingering></technical></notations>`;
    out = out.slice(0, p.at) + tag + out.slice(p.at);
  }
  return out;
}

// ---- Node export shim (browser-safe) ------------------------------------
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    parseMusicXml,
    measuresInQuarterRange,
    measuresForSection,
    injectFingerings,
  };
}
