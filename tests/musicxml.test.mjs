// Tests for the pure MusicXML measure-alignment helpers in musicxml.js.
//
// Like midi.test.mjs hand-builds binary MIDI, these hand-build small but
// valid MusicXML strings so the parse + timing model is exercised with no
// fixture files and no DOM.
//
// Run from the project root:
//   node --test tests/musicxml.test.mjs

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const mod = await import('../musicxml.js');
const { parseMusicXml, measuresInQuarterRange, measuresForSection, injectFingerings } = mod;

/** Wrap measure XML in a one-part score-partwise document. */
const score = (measuresXml, partId = 'P1') => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 4.0 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">
<score-partwise version="4.0">
  <part-list><score-part id="${partId}"><part-name>Piano</part-name></score-part></part-list>
  <part id="${partId}">${measuresXml}</part>
</score-partwise>`;

const note = (dur, { chord = false, grace = false } = {}) =>
  `<note>${grace ? '<grace/>' : ''}${chord ? '<chord/>' : ''}<pitch><step>C</step><octave>4</octave></pitch>${grace ? '' : `<duration>${dur}</duration>`}<type>quarter</type></note>`;

const attributes = (divisions, beats = 4, beatType = 4) =>
  `<attributes><divisions>${divisions}</divisions><time><beats>${beats}</beats><beat-type>${beatType}</beat-type></time></attributes>`;

// --- two plain 4/4 measures, divisions=1 ---------------------------------
{
  const xml = score(
    `<measure number="1">${attributes(1)}${note(1)}${note(1)}${note(1)}${note(1)}</measure>` +
    `<measure number="2">${note(4)}</measure>`,
  );
  const { measures, divisions } = parseMusicXml(xml);
  assert.equal(divisions, 1);
  assert.equal(measures.length, 2);
  assert.deepEqual(measures.map((m) => m.startQuarter), [0, 4]);
  assert.deepEqual(measures.map((m) => m.durationQuarter), [4, 4]);
  assert.deepEqual(measures.map((m) => m.number), ['1', '2']);
  assert.deepEqual(measures.map((m) => m.index), [0, 1]);
}

// --- divisions scaling: durations are in divisions-per-quarter -----------
{
  // divisions=4 ⇒ a quarter note has <duration>4</duration>.
  const xml = score(
    `<measure number="1">${attributes(4)}${note(4)}${note(4)}${note(4)}${note(4)}</measure>`,
  );
  const { measures } = parseMusicXml(xml);
  assert.equal(measures[0].durationQuarter, 4, '16 divisions / 4 = 4 quarters');
}

// --- chords count once, not per note -------------------------------------
{
  // A C-major triad (1 lead note + 2 <chord/> notes) then three more quarters.
  const xml = score(
    `<measure number="1">${attributes(1)}` +
      note(1) + note(1, { chord: true }) + note(1, { chord: true }) +
      note(1) + note(1) + note(1) +
    `</measure>`,
  );
  const { measures } = parseMusicXml(xml);
  assert.equal(measures[0].durationQuarter, 4, 'chord notes share an onset; bar is 4 quarters');
}

// --- grace notes add no duration -----------------------------------------
{
  const xml = score(
    `<measure number="1">${attributes(1)}${note(0, { grace: true })}${note(1)}${note(1)}${note(1)}${note(1)}</measure>`,
  );
  const { measures } = parseMusicXml(xml);
  assert.equal(measures[0].durationQuarter, 4, 'grace note does not extend the bar');
}

// --- multi-voice via backup: bar length = one voice, not the sum ---------
{
  // Voice 1: four quarters. <backup> to bar start. Voice 2: four quarters.
  const xml = score(
    `<measure number="1">${attributes(1)}` +
      note(1) + note(1) + note(1) + note(1) +
      `<backup><duration>4</duration></backup>` +
      note(1) + note(1) + note(1) + note(1) +
    `</measure>`,
  );
  const { measures } = parseMusicXml(xml);
  assert.equal(measures[0].durationQuarter, 4, 'two voices overlap; bar is still 4 quarters');
}

// --- forward fills time (un-notated rest) --------------------------------
{
  const xml = score(
    `<measure number="1">${attributes(1)}${note(1)}<forward><duration>2</duration></forward>${note(1)}</measure>`,
  );
  const { measures } = parseMusicXml(xml);
  assert.equal(measures[0].durationQuarter, 4, '1 + forward 2 + 1 = 4 quarters');
}

// --- pickup (anacrusis) measure: shorter first bar shifts the grid -------
{
  const xml = score(
    `<measure number="0" implicit="yes">${attributes(1)}${note(1)}</measure>` +
    `<measure number="1">${note(1)}${note(1)}${note(1)}${note(1)}</measure>` +
    `<measure number="2">${note(4)}</measure>`,
  );
  const { measures } = parseMusicXml(xml);
  assert.deepEqual(measures.map((m) => m.startQuarter), [0, 1, 5], 'pickup offsets later bars');
  assert.deepEqual(measures.map((m) => m.number), ['0', '1', '2']);
}

// --- only the first part defines the grid --------------------------------
{
  // score-partwise lists ALL of part 1, then part 2. Both have 2 measures;
  // the grid must not double-count.
  const xml = `<?xml version="1.0"?>
<score-partwise>
  <part-list><score-part id="P1"/><score-part id="P2"/></part-list>
  <part id="P1">
    <measure number="1">${attributes(1)}${note(4)}</measure>
    <measure number="2">${note(4)}</measure>
  </part>
  <part id="P2">
    <measure number="1">${attributes(1)}${note(4)}</measure>
    <measure number="2">${note(4)}</measure>
  </part>
</score-partwise>`;
  const { measures } = parseMusicXml(xml);
  assert.equal(measures.length, 2, 'second part is ignored for the grid');
}

// --- measuresInQuarterRange: half-open overlap ---------------------------
{
  const measures = [
    { number: '1', index: 0, startQuarter: 0, durationQuarter: 4 },
    { number: '2', index: 1, startQuarter: 4, durationQuarter: 4 },
    { number: '3', index: 2, startQuarter: 8, durationQuarter: 4 },
  ];
  assert.deepEqual(
    measuresInQuarterRange(measures, 0, 4).map((m) => m.number),
    ['1'],
    'section ending exactly on a barline excludes the next measure',
  );
  assert.deepEqual(
    measuresInQuarterRange(measures, 4, 8).map((m) => m.number),
    ['2'],
    'section starting exactly on a barline includes that measure',
  );
  assert.deepEqual(
    measuresInQuarterRange(measures, 2, 10).map((m) => m.number),
    ['1', '2', '3'],
    'a span touching all three returns all three',
  );
}

// --- measuresForSection: tick window → measures --------------------------
{
  const parsed = {
    measures: [
      { number: '1', index: 0, startQuarter: 0, durationQuarter: 4 },
      { number: '2', index: 1, startQuarter: 4, durationQuarter: 4 },
    ],
  };
  const tpq = 480;
  // Whole piece (a fluency-style section spanning everything).
  const all = measuresForSection(parsed, { startTick: 0, endTick: 8 * tpq }, tpq);
  assert.equal(all.count, 2);
  assert.equal(all.firstNumber, '1');
  assert.equal(all.lastNumber, '2');
  // Just the second bar.
  const second = measuresForSection(parsed, { startTick: 4 * tpq, endTick: 8 * tpq }, tpq);
  assert.deepEqual(second.measures.map((m) => m.number), ['2']);
  // Just the first bar.
  const first = measuresForSection(parsed, { startTick: 0, endTick: 4 * tpq }, tpq);
  assert.deepEqual(first.measures.map((m) => m.number), ['1']);
}

// --- degenerate inputs ----------------------------------------------------
{
  assert.deepEqual(parseMusicXml('').measures, [], 'empty string → no measures');
  assert.deepEqual(parseMusicXml('').notes, [], 'empty string → no notes');
  assert.deepEqual(parseMusicXml(null).measures, [], 'null → no measures');
  assert.deepEqual(measuresInQuarterRange(null, 0, 1), [], 'null measures → []');
  assert.equal(measuresForSection({ measures: [] }, { startTick: 0, endTick: 480 }, 480).count, 0);
}

// ===== Note derivation (parseMidi-compatible timeline) =====================

/** Pitched note with options for derivation tests. */
const pnote = (step, octave, dur, opts = {}) => {
  const { alter, chord, staff, tie } = opts;
  const ties = tie ? (Array.isArray(tie) ? tie : [tie]) : [];
  return (
    '<note>' +
    (chord ? '<chord/>' : '') +
    `<pitch><step>${step}</step>${alter != null ? `<alter>${alter}</alter>` : ''}<octave>${octave}</octave></pitch>` +
    `<duration>${dur}</duration>` +
    ties.map((t) => `<tie type="${t}"/>`).join('') +
    (staff != null ? `<staff>${staff}</staff>` : '') +
    '</note>'
  );
};
const rest = (dur) => `<note><rest/><duration>${dur}</duration></note>`;

// --- pitch + absolute tick math (TPQ 480) --------------------------------
{
  const { notes, ticksPerQuarter } = parseMusicXml(
    score(`<measure number="1">${attributes(1)}${pnote('C', 4, 1)}${pnote('D', 4, 1)}${pnote('E', 4, 1)}${pnote('F', 4, 1)}</measure>`),
  );
  assert.equal(ticksPerQuarter, 480);
  assert.deepEqual(notes.map((n) => n.midi), [60, 62, 64, 65], 'C4 D4 E4 F4');
  assert.deepEqual(notes.map((n) => n.startTick), [0, 480, 960, 1440]);
  assert.deepEqual(notes.map((n) => n.endTick), [480, 960, 1440, 1920]);
}

// --- divisions scaling: ticks independent of the score's divisions -------
{
  const { notes } = parseMusicXml(
    score(`<measure number="1">${attributes(4)}${pnote('C', 4, 4)}${pnote('D', 4, 4)}</measure>`),
  );
  assert.deepEqual(notes.map((n) => n.startTick), [0, 480], 'divisions=4 quarters still 480 ticks');
}

// --- accidentals: alter shifts the MIDI number ---------------------------
{
  const { notes } = parseMusicXml(
    score(`<measure number="1">${attributes(1)}${pnote('C', 4, 1, { alter: 1 })}${pnote('B', 3, 1, { alter: -1 })}</measure>`),
  );
  assert.deepEqual(notes.map((n) => n.midi), [61, 58], 'C#4=61, Bb3=58');
}

// --- chords share one onset ----------------------------------------------
{
  const { notes } = parseMusicXml(
    score(`<measure number="1">${attributes(1)}${pnote('C', 4, 1)}${pnote('E', 4, 1, { chord: true })}${pnote('G', 4, 1, { chord: true })}${pnote('D', 4, 1)}</measure>`),
  );
  const at0 = notes.filter((n) => n.startTick === 0).map((n) => n.midi).sort((a, b) => a - b);
  assert.deepEqual(at0, [60, 64, 67], 'triad all start at tick 0');
  assert.equal(notes.find((n) => n.midi === 62).startTick, 480, 'next note advances by one quarter only');
}

// --- ties merge into one sustained note ----------------------------------
{
  const { notes } = parseMusicXml(
    score(`<measure number="1">${attributes(1)}${pnote('C', 4, 1, { tie: 'start' })}${pnote('C', 4, 1, { tie: 'stop' })}${pnote('D', 4, 1)}${pnote('E', 4, 1)}</measure>`),
  );
  const cs = notes.filter((n) => n.midi === 60);
  assert.equal(cs.length, 1, 'tied C is a single note, not re-pressed');
  assert.equal(cs[0].startTick, 0);
  assert.equal(cs[0].endTick, 960, 'tie extends across both quarters');
  assert.deepEqual(notes.filter((n) => n.midi !== 60).map((n) => n.startTick), [960, 1440]);
}

// --- rests advance time but emit no note ----------------------------------
{
  const { notes } = parseMusicXml(
    score(`<measure number="1">${attributes(1)}${rest(1)}${pnote('C', 4, 1)}</measure>`),
  );
  assert.equal(notes.length, 1, 'rest emits nothing');
  assert.equal(notes[0].startTick, 480, 'rest still pushes the note to beat 2');
}

// --- staff → track (hands), backup overlays the second voice -------------
{
  const { notes } = parseMusicXml(
    score(`<measure number="1">${attributes(1)}${pnote('G', 4, 4, { staff: 1 })}<backup><duration>4</duration></backup>${pnote('C', 3, 4, { staff: 2 })}</measure>`),
  );
  const g = notes.find((n) => n.midi === 67);
  const c = notes.find((n) => n.midi === 48);
  assert.equal(g.track, 0, 'staff 1 → track 0 (RH)');
  assert.equal(c.track, 1, 'staff 2 → track 1 (LH)');
  assert.equal(g.startTick, 0);
  assert.equal(c.startTick, 0, 'backup puts the LH voice at the bar start');
}

// --- seconds: default 120 BPM, and <sound tempo> override ----------------
{
  const { notes, durationSec } = parseMusicXml(
    score(`<measure number="1">${attributes(1)}${pnote('C', 4, 1)}${pnote('D', 4, 1)}${pnote('E', 4, 1)}${pnote('F', 4, 1)}</measure>`),
  );
  assert.equal(notes[1].startSec, 0.5, '120 BPM → 0.5s per quarter');
  assert.equal(durationSec, 2, '4 quarters at 120 BPM = 2s');

  const slow = parseMusicXml(
    score(`<measure number="1">${attributes(1)}<direction><sound tempo="60"/></direction>${pnote('C', 4, 1)}${pnote('D', 4, 1)}</measure>`),
  );
  assert.equal(slow.notes[1].startSec, 1, '<sound tempo=60> → 1s per quarter');
}

// --- bundled sample (samples/twinkle.musicxml) stays valid ----------------
{
  const here = dirname(fileURLToPath(import.meta.url));
  const xml = readFileSync(join(here, '..', 'samples', 'twinkle.musicxml'), 'utf8');
  const { measures, notes } = parseMusicXml(xml);
  assert.equal(measures.length, 12, 'sample has 12 measures');
  assert.ok(notes.length > 0, 'sample derives notes');
  // Opening melody is C4 C4 G4 G4 on the right hand (staff 1 → track 0).
  assert.deepEqual(
    notes.filter((n) => n.track === 0).slice(0, 4).map((n) => n.midi),
    [60, 60, 67, 67],
    'sample opens with the Twinkle motif',
  );
  assert.ok(
    notes.some((n) => n.track === 1),
    'sample has a left-hand staff (two hands)',
  );
}

// --- injectFingerings: only landmark notes, parsing stays intact ----------
{
  const xml = score(
    `<measure number="1">${attributes(1)}${pnote('C', 4, 1)}${pnote('D', 4, 1)}${pnote('E', 4, 1)}${pnote('F', 4, 1)}</measure>`,
  );
  const parsed = parseMusicXml(xml);
  // Notes carry an injectAt offset from the parse.
  assert.ok(parsed.notes.every((n) => typeof n.injectAt === 'number'), 'notes record injectAt');
  // Flag the 1st (finger 1) and 3rd (finger 3) notes as landmarks.
  parsed.notes[0].finger = 1; parsed.notes[0].fingerLandmark = true;
  parsed.notes[2].finger = 3; parsed.notes[2].fingerLandmark = true;

  const out = injectFingerings(xml, parsed.notes);
  assert.equal((out.match(/<fingering>/g) || []).length, 2, 'only the 2 landmarks get a number');
  assert.ok(/<fingering>1<\/fingering>/.test(out));
  assert.ok(/<fingering>3<\/fingering>/.test(out));
  // The fingering sits inside a note element (before a </note>).
  assert.ok(/<fingering>1<\/fingering><\/technical><\/notations><\/note>/.test(out));

  // Re-parsing the injected XML yields the same notes — injection is safe.
  const reparsed = parseMusicXml(out);
  assert.deepEqual(
    reparsed.notes.map((n) => n.midi),
    parsed.notes.map((n) => n.midi),
    'injection does not change the parsed notes',
  );

  // No landmarks ⇒ XML returned unchanged.
  const plain = parseMusicXml(xml);
  assert.equal(injectFingerings(xml, plain.notes), xml, 'nothing flagged ⇒ unchanged');
  assert.equal(injectFingerings(xml, null), xml, 'null notes ⇒ unchanged');
}

// --- the score's own <fingering> is captured and preferred ---------------
{
  // First note carries a human fingering (4); the others don't.
  const fingered =
    `<note><pitch><step>C</step><octave>4</octave></pitch><duration>1</duration>` +
    `<notations><technical><fingering>4</fingering></technical></notations></note>`;
  const xml = score(
    `<measure number="1">${attributes(1)}${fingered}${pnote('D', 4, 1)}${pnote('E', 4, 1)}${pnote('F', 4, 1)}</measure>`,
  );
  const { notes } = parseMusicXml(xml);
  assert.equal(notes[0].scoreFinger, 4, 'human fingering captured from the score');
  assert.ok(notes.slice(1).every((n) => n.scoreFinger == null), 'others have no score fingering');

  // Flag every note a landmark and give them auto finger 2; injection must NOT
  // touch the score-fingered note (OSMD renders that one from the source).
  notes.forEach((n) => { n.fingerLandmark = true; n.finger = 2; });
  const out = injectFingerings(xml, notes);
  // The score's "4" on C stays untouched and unduplicated; D, E, F each get an
  // injected "2".
  assert.equal((out.match(/<fingering>/g) || []).length, 4, 'one score + three injected');
  assert.equal((out.match(/<fingering>4<\/fingering>/g) || []).length, 1, 'score fingering kept, not duplicated');
  assert.equal((out.match(/<fingering>2<\/fingering>/g) || []).length, 3, 'three auto fingerings injected');
}

// --- letter markings: only on very distant landmarks ----------------------
{
  const xml = score(
    `<measure number="1">${attributes(1)}${pnote('C', 4, 1)}${pnote('G', 6, 1)}${pnote('E', 4, 1)}</measure>`,
  );
  const { notes } = parseMusicXml(xml);
  assert.equal(notes[1].step, 'G', 'parse records the note letter');

  // Every note a landmark with a finger; only the middle one is "very distant".
  notes.forEach((n) => { n.fingerLandmark = true; n.finger = 3; });
  notes[1].fingerLandmarkDistant = true;

  const out = injectFingerings(xml, notes);
  // Exactly one letter marking, and it's the distant note's letter (G).
  assert.equal((out.match(/<lyric/g) || []).length, 1, 'only the distant landmark gets a letter');
  assert.ok(/<lyric number="1"><syllabic>single<\/syllabic><text>G<\/text><\/lyric>/.test(out));
  // The letter sits inside the note, after its fingering notations.
  assert.ok(/<fingering>3<\/fingering><\/technical><\/notations><lyric/.test(out));
  // Re-parsing the injected XML is still safe — same notes.
  assert.deepEqual(
    parseMusicXml(out).notes.map((n) => n.midi),
    notes.map((n) => n.midi),
    'lyric injection does not change the parsed notes',
  );
}

// --- a distant landmark gets its letter even when the score fingers it -----
{
  const fingered =
    `<note><pitch><step>A</step><octave>5</octave></pitch><duration>1</duration>` +
    `<notations><technical><fingering>2</fingering></technical></notations></note>`;
  const xml = score(`<measure number="1">${attributes(1)}${fingered}</measure>`);
  const { notes } = parseMusicXml(xml);
  assert.equal(notes[0].scoreFinger, 2, 'score fingering captured');

  notes[0].fingerLandmark = true;
  notes[0].finger = 2;
  notes[0].fingerLandmarkDistant = true;
  const out = injectFingerings(xml, notes);
  // No injected fingering (the score's own wins) but the letter is still added.
  assert.equal((out.match(/<fingering>/g) || []).length, 1, 'score fingering not duplicated');
  assert.ok(/<text>A<\/text>/.test(out), 'letter marking added alongside the score finger');
}

// --- key signature ---
//
// A notated key is the strongest signal the technique drills have, so the
// parser has to surface <key> from the opening <attributes>.
{
  const withKey = score(
    `<measure number="1"><attributes><divisions>1</divisions>`
    + `<key><fifths>-3</fifths><mode>major</mode></key>`
    + `<time><beats>4</beats><beat-type>4</beat-type></time></attributes>`
    + `${note(1)}</measure>`,
  );
  assert.deepEqual(parseMusicXml(withKey).keySignature, { fifths: -3, mode: 'major' });

  // <mode> is optional — relative-key ambiguity is resolved downstream.
  const noMode = score(
    `<measure number="1"><attributes><divisions>1</divisions>`
    + `<key><fifths>2</fifths></key></attributes>${note(1)}</measure>`,
  );
  assert.deepEqual(parseMusicXml(noMode).keySignature, { fifths: 2, mode: undefined });

  // A mid-piece key change doesn't overwrite the opening key.
  const modulates = score(
    `<measure number="1"><attributes><divisions>1</divisions>`
    + `<key><fifths>0</fifths><mode>major</mode></key></attributes>${note(1)}</measure>`
    + `<measure number="2"><attributes>`
    + `<key><fifths>4</fifths><mode>minor</mode></key></attributes>${note(1)}</measure>`,
  );
  assert.equal(parseMusicXml(modulates).keySignature.fifths, 0);

  // No <key> at all, and out-of-range values, yield null rather than nonsense.
  assert.equal(parseMusicXml(score(`<measure number="1">${attributes(1)}${note(1)}</measure>`)).keySignature, null);
  const bogus = score(
    `<measure number="1"><attributes><divisions>1</divisions>`
    + `<key><fifths>99</fifths></key></attributes>${note(1)}</measure>`,
  );
  assert.equal(parseMusicXml(bogus).keySignature, null);
  assert.equal(parseMusicXml('').keySignature, null);
}

console.log('musicxml helpers: all assertions passed');
