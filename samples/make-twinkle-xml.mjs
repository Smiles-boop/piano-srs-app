// Generates samples/twinkle.musicxml — a small, public-domain grand-staff
// score (RH melody + simple LH harmony) so the bundled sample demonstrates
// the engraved sheet-music view. Run: node samples/make-twinkle-xml.mjs
//
// Pure text generation; no dependencies. The result parses cleanly through
// musicxml.js (verified in tests/musicxml-sample.test.mjs).

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const DIV = 4; // divisions per quarter note
const TYPE = { 1: 'quarter', 2: 'half', 4: 'whole' };

// Twinkle Twinkle Little Star, C major, 4/4. Each measure lists the right-hand
// melody and a simple left-hand accompaniment as [step, octave, beats].
const MEASURES = [
  { rh: [['C', 4, 1], ['C', 4, 1], ['G', 4, 1], ['G', 4, 1]], lh: [['C', 3, 4]] },
  { rh: [['A', 4, 1], ['A', 4, 1], ['G', 4, 2]], lh: [['F', 2, 2], ['C', 3, 2]] },
  { rh: [['F', 4, 1], ['F', 4, 1], ['E', 4, 1], ['E', 4, 1]], lh: [['F', 2, 2], ['C', 3, 2]] },
  { rh: [['D', 4, 1], ['D', 4, 1], ['C', 4, 2]], lh: [['G', 2, 2], ['G', 2, 2]] },
  { rh: [['G', 4, 1], ['G', 4, 1], ['F', 4, 1], ['F', 4, 1]], lh: [['C', 3, 2], ['G', 2, 2]] },
  { rh: [['E', 4, 1], ['E', 4, 1], ['D', 4, 2]], lh: [['C', 3, 2], ['G', 2, 2]] },
  { rh: [['G', 4, 1], ['G', 4, 1], ['F', 4, 1], ['F', 4, 1]], lh: [['C', 3, 2], ['G', 2, 2]] },
  { rh: [['E', 4, 1], ['E', 4, 1], ['D', 4, 2]], lh: [['C', 3, 2], ['G', 2, 2]] },
  { rh: [['C', 4, 1], ['C', 4, 1], ['G', 4, 1], ['G', 4, 1]], lh: [['C', 3, 4]] },
  { rh: [['A', 4, 1], ['A', 4, 1], ['G', 4, 2]], lh: [['F', 2, 2], ['C', 3, 2]] },
  { rh: [['F', 4, 1], ['F', 4, 1], ['E', 4, 1], ['E', 4, 1]], lh: [['F', 2, 2], ['C', 3, 2]] },
  { rh: [['D', 4, 1], ['D', 4, 1], ['C', 4, 2]], lh: [['G', 2, 2], ['C', 3, 2]] },
];

const note = ([step, octave, beats], staff) =>
  `<note><pitch><step>${step}</step><octave>${octave}</octave></pitch>` +
  `<duration>${beats * DIV}</duration><type>${TYPE[beats] || 'quarter'}</type>` +
  `<staff>${staff}</staff></note>`;

const measureXml = (m, i) => {
  const attrs = i === 0
    ? `<attributes><divisions>${DIV}</divisions><key><fifths>0</fifths></key>` +
      `<time><beats>4</beats><beat-type>4</beat-type></time><staves>2</staves>` +
      `<clef number="1"><sign>G</sign><line>2</line></clef>` +
      `<clef number="2"><sign>F</sign><line>4</line></clef></attributes>`
    : '';
  const rh = m.rh.map((n) => note(n, 1)).join('');
  const lh = m.lh.map((n) => note(n, 2)).join('');
  // RH voice, then backup a full measure, then LH voice on staff 2.
  return `  <measure number="${i + 1}">${attrs}${rh}` +
    `<backup><duration>${4 * DIV}</duration></backup>${lh}</measure>`;
};

const xml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 4.0 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">
<score-partwise version="4.0">
  <work><work-title>Twinkle Twinkle Little Star</work-title></work>
  <part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>
  <part id="P1">
${MEASURES.map(measureXml).join('\n')}
  </part>
</score-partwise>
`;

const outPath = join(dirname(fileURLToPath(import.meta.url)), 'twinkle.musicxml');
writeFileSync(outPath, xml);
console.log(`Wrote ${outPath} (${MEASURES.length} measures)`);
