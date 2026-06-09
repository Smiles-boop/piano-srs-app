// Tests for the section pure helpers in db.js
// (sectionToRecord, validateSectionInput) — MIDI era.
//
// db.js only touches `indexedDB` lazily inside `openDb()`, so importing it in
// Node is safe without any DOM stub. Run from the project root:
//   node tests/sections.test.mjs

import assert from 'node:assert/strict';

const mod = await import('../db.js');

// --- validateSectionInput: happy path ----------------------------------------
{
  const r = mod.validateSectionInput({
    name: '  Exposition  ',
    notes: '  RH 1-2-3-5  ',
  });
  assert.equal(r.ok, true, 'valid input is accepted');
  assert.deepEqual(r.value, {
    name: 'Exposition',
    notes: 'RH 1-2-3-5',
  }, 'name and notes are trimmed');
}

// --- empty notes is allowed --------------------------------------------------
{
  const r = mod.validateSectionInput({ name: 'A', notes: '' });
  assert.equal(r.ok, true, 'empty notes is allowed');
  assert.equal(r.value.notes, '');
}

// --- missing notes is allowed (defaults to empty) ----------------------------
{
  const r = mod.validateSectionInput({ name: 'A' });
  assert.equal(r.ok, true);
  assert.equal(r.value.notes, '');
}

// --- missing name fails ------------------------------------------------------
{
  const r = mod.validateSectionInput({ name: '   ', notes: 'x' });
  assert.equal(r.ok, false);
  assert.ok(r.errors.name, 'reports a name error');
  assert.equal(r.errors.notes, undefined, 'notes is fine, not flagged');
}

// --- name length cap ---------------------------------------------------------
{
  const r = mod.validateSectionInput({ name: 'a'.repeat(101) });
  assert.equal(r.ok, false);
  assert.match(r.errors.name, /100/);
}

// --- notes length cap --------------------------------------------------------
{
  const r = mod.validateSectionInput({ name: 'X', notes: 'm'.repeat(2001) });
  assert.equal(r.ok, false);
  assert.match(r.errors.notes, /2000/);
}

// --- sectionToRecord: full MIDI passthrough ----------------------------------
{
  const rec = mod.sectionToRecord({
    id: 's_1',
    pieceId: 'p_a',
    name: 'A',
    startTick: 0,
    endTick: 960,
    startSec: 0,
    endSec: 2,
    noteCount: 8,
    notes: 'legato',
    addedAt: 1000,
    order: 5,
  });
  assert.deepEqual(rec, {
    id: 's_1',
    pieceId: 'p_a',
    name: 'A',
    startTick: 0,
    endTick: 960,
    startSec: 0,
    endSec: 2,
    noteCount: 8,
    notes: 'legato',
    addedAt: 1000,
    order: 5,
  });
}

// --- sectionToRecord: tick/second range defaults to 0 when absent ------------
{
  const rec = mod.sectionToRecord({ id: 's_r', pieceId: 'p_a', name: 'R' });
  assert.equal(rec.startTick, 0);
  assert.equal(rec.endTick, 0);
  assert.equal(rec.startSec, 0);
  assert.equal(rec.endSec, 0);
  assert.equal(rec.noteCount, 0);
}

// --- sectionToRecord: addedAt + order auto-fill, order defaults to addedAt ---
{
  const before = Date.now();
  const rec = mod.sectionToRecord({ id: 's_2', pieceId: 'p_a', name: 'B' });
  const after = Date.now();
  assert.equal(typeof rec.addedAt, 'number');
  assert.ok(rec.addedAt >= before && rec.addedAt <= after,
    'auto-filled addedAt is within the call window');
  assert.equal(rec.order, rec.addedAt,
    'auto-filled order matches addedAt by default');
}

// --- sectionToRecord: explicit addedAt: 0 / order: 0 preserved ---------------
{
  const rec = mod.sectionToRecord({
    id: 's_3', pieceId: 'p_a', name: 'C', addedAt: 0,
  });
  assert.equal(rec.addedAt, 0, 'explicit addedAt: 0 is preserved');
  assert.equal(rec.order, 0, 'order falls back to addedAt (0) when missing');

  const rec2 = mod.sectionToRecord({
    id: 's_4', pieceId: 'p_a', name: 'D', addedAt: 9999, order: 0,
  });
  assert.equal(rec2.order, 0, 'explicit order: 0 is preserved');
}

// --- sectionToRecord: notes field passthrough --------------------------------
{
  const rec = mod.sectionToRecord({
    id: 's_n1', pieceId: 'p_a', name: 'WithNotes',
    notes: 'RH 1-2-3-5 crossover',
  });
  assert.equal(rec.notes, 'RH 1-2-3-5 crossover');

  const rec2 = mod.sectionToRecord({ id: 's_n2', pieceId: 'p_a', name: 'NoNotes' });
  assert.equal(rec2.notes, '', 'missing notes defaults to empty string');

  const rec3 = mod.sectionToRecord({
    id: 's_n3', pieceId: 'p_a', name: 'BadNotes', notes: 42,
  });
  assert.equal(rec3.notes, '', 'non-string notes becomes empty string');
}

// --- sectionToRecord: SRS fields are passed through when present -------------
{
  const rec = mod.sectionToRecord({
    id: 's_6', pieceId: 'p_a', name: 'F',
    repetitions: 3, interval: 15, ease: 2.36,
    nextDue: '2026-05-13', lastReviewedDate: '2026-04-28',
  });
  assert.equal(rec.repetitions, 3);
  assert.equal(rec.interval, 15);
  assert.equal(rec.ease, 2.36);
  assert.equal(rec.nextDue, '2026-05-13');
  assert.equal(rec.lastReviewedDate, '2026-04-28');
}

// --- sectionToRecord: SRS fields are OMITTED when absent ---------------------
{
  const rec = mod.sectionToRecord({ id: 's_7', pieceId: 'p_a', name: 'G' });
  assert.equal('repetitions' in rec, false, 'no repetitions key when unrated');
  assert.equal('interval' in rec, false);
  assert.equal('ease' in rec, false);
  assert.equal('nextDue' in rec, false);
  assert.equal('lastReviewedDate' in rec, false);
}

// --- sectionToRecord: malformed SRS fields are dropped ----------------------
{
  const rec = mod.sectionToRecord({
    id: 's_8', pieceId: 'p_a', name: 'H',
    repetitions: 'three', interval: NaN, ease: Infinity,
    nextDue: '', lastReviewedDate: 42,
  });
  assert.equal('repetitions' in rec, false);
  assert.equal('interval' in rec, false);
  assert.equal('ease' in rec, false);
  assert.equal('nextDue' in rec, false);
  assert.equal('lastReviewedDate' in rec, false);
}

// --- sectionToRecord: explicit zeros for repetitions/interval are preserved -
{
  const rec = mod.sectionToRecord({
    id: 's_9', pieceId: 'p_a', name: 'I',
    repetitions: 0, interval: 1, ease: 1.7,
    nextDue: '2026-04-29', lastReviewedDate: '2026-04-28',
  });
  assert.equal(rec.repetitions, 0);
  assert.equal(rec.interval, 1);
  assert.equal(rec.ease, 1.7);
}

// --- exported surface --------------------------------------------------------
for (const name of [
  'listSectionsForPiece', 'saveSection', 'deleteSection',
  'deleteSectionsForPiece', 'sectionToRecord', 'validateSectionInput',
]) {
  assert.equal(typeof mod[name], 'function', `db.js exports ${name}`);
}

console.log('section helpers: all assertions passed');
