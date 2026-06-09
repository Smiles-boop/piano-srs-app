// Generates samples/twinkle.mid — "Twinkle Twinkle Little Star", a format-1
// MIDI file with a right-hand melody track and a left-hand bass track. Used as
// a demo/fixture for the MIDI practice flow (clear phrase structure for the
// auto-sectioner, two tracks for the hand toggle).
//
//   node samples/make-twinkle.mjs

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const TPQ = 480;
const TEMPO_US = 500000; // 120 BPM

function vlq(value) {
  const out = [value & 0x7f];
  value = Math.floor(value / 128);
  while (value > 0) {
    out.unshift((value & 0x7f) | 0x80);
    value = Math.floor(value / 128);
  }
  return out;
}
const u16 = (v) => [(v >> 8) & 0xff, v & 0xff];
const u32 = (v) => [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff];

// Note names → MIDI numbers.
const C4 = 60, D4 = 62, E4 = 64, F4 = 65, G4 = 67, A4 = 69;
const C3 = 48, F3 = 53, G3 = 55;

// Right-hand melody: 6 phrases of 7 notes each (six quarters + one half),
// a quarter-rest between phrases so the auto-sectioner finds 6 phrases.
const Q = 1, H = 2;
const phrases = [
  [[C4, Q], [C4, Q], [G4, Q], [G4, Q], [A4, Q], [A4, Q], [G4, H]],
  [[F4, Q], [F4, Q], [E4, Q], [E4, Q], [D4, Q], [D4, Q], [C4, H]],
  [[G4, Q], [G4, Q], [F4, Q], [F4, Q], [E4, Q], [E4, Q], [D4, H]],
  [[G4, Q], [G4, Q], [F4, Q], [F4, Q], [E4, Q], [E4, Q], [D4, H]],
  [[C4, Q], [C4, Q], [G4, Q], [G4, Q], [A4, Q], [A4, Q], [G4, H]],
  [[F4, Q], [F4, Q], [E4, Q], [E4, Q], [D4, Q], [D4, Q], [C4, H]],
];
const bassRoots = [C3, F3, C3, C3, C3, F3]; // one held root per phrase
const PHRASE_BEATS = 8; // 6*Q + 1*H

function buildMelodyTrack() {
  const ev = [];
  phrases.forEach((phrase, pi) => {
    phrase.forEach(([midi, durBeats], ni) => {
      // A quarter rest before the first note of every phrase after the first.
      const gap = pi > 0 && ni === 0 ? TPQ : 0;
      ev.push({ delta: gap, data: [0x90, midi, 84] });
      ev.push({ delta: durBeats * TPQ, data: [0x80, midi, 64] });
    });
  });
  return ev;
}

function buildBassTrack() {
  const ev = [];
  bassRoots.forEach((midi, pi) => {
    const gap = pi > 0 ? TPQ : 0; // matching rest so phrases stay aligned
    ev.push({ delta: gap, data: [0x90 | 1, midi, 70] });
    ev.push({ delta: PHRASE_BEATS * TPQ, data: [0x80 | 1, midi, 64] });
  });
  return ev;
}

function encodeTrack(events, { tempo } = {}) {
  const bytes = [];
  const push = (...b) => b.forEach((x) => bytes.push(x));
  if (tempo) {
    push(0x00, 0xff, 0x51, 0x03, (tempo >> 16) & 0xff, (tempo >> 8) & 0xff, tempo & 0xff);
    push(0x00, 0xff, 0x58, 0x04, 4, 2, 24, 8); // 4/4 time signature
  }
  for (const e of events) push(...vlq(e.delta), ...e.data);
  push(0x00, 0xff, 0x2f, 0x00); // end of track
  return [0x4d, 0x54, 0x72, 0x6b, ...u32(bytes.length), ...bytes];
}

const header = [
  0x4d, 0x54, 0x68, 0x64, // "MThd"
  ...u32(6),
  ...u16(1), // format 1
  ...u16(3), // 3 tracks (tempo/meta + RH + LH)
  ...u16(TPQ),
];
const tempoTrack = encodeTrack([], { tempo: TEMPO_US });
const rhTrack = encodeTrack(buildMelodyTrack());
const lhTrack = encodeTrack(buildBassTrack());

const bytes = Uint8Array.from([...header, ...tempoTrack, ...rhTrack, ...lhTrack]);
const outPath = join(dirname(fileURLToPath(import.meta.url)), 'twinkle.mid');
writeFileSync(outPath, bytes);
console.log(`wrote ${outPath} (${bytes.length} bytes)`);
