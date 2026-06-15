// Tests for the pure helpers in db.js (pieceToRecord, metadataFromRecord).
//
// db.js only touches `indexedDB` lazily inside `openDb()`, so importing it in
// Node is safe without any DOM stub. Run from the project root:
//   node tests/db.test.mjs

import assert from 'node:assert/strict';

const mod = await import('../db.js');

// --- pieceToRecord ---
{
  const piece = {
    id: 'p_abc', title: 'Test Piece',
    durationSec: 120, ticksPerQuarter: 480, noteCount: 256, addedAt: 1000,
  };
  const blob = { _fakeBlob: true };
  const rec = mod.pieceToRecord(piece, blob);
  assert.equal(rec.id, 'p_abc');
  assert.equal(rec.title, 'Test Piece');
  assert.equal(rec.durationSec, 120);
  assert.equal(rec.ticksPerQuarter, 480);
  assert.equal(rec.noteCount, 256);
  assert.equal(rec.addedAt, 1000, 'preserves provided addedAt');
  assert.strictEqual(rec.midiBlob, blob, 'attaches the MIDI blob unchanged');
  assert.equal(rec.source, 'midi', 'defaults source to midi');
  assert.ok(!('musicXmlBlob' in rec), 'no musicXmlBlob field unless provided');
}

// pieceToRecord carries an optional MusicXML blob + score source
{
  const midi = { _midi: true };
  const xml = { _xml: true };
  const rec = mod.pieceToRecord(
    { id: 'p', title: 't', source: 'musicxml' }, midi, xml);
  assert.equal(rec.source, 'musicxml');
  assert.strictEqual(rec.musicXmlBlob, xml, 'attaches the MusicXML blob');
  // A score-only piece (no MIDI) records a null midiBlob.
  const scoreOnly = mod.pieceToRecord(
    { id: 'p2', title: 't2', source: 'musicxml' }, null, xml);
  assert.equal(scoreOnly.midiBlob, null, 'score-only piece has null midiBlob');
}

// pieceToRecord auto-fills addedAt + MIDI metadata defaults when missing
{
  const before = Date.now();
  const rec = mod.pieceToRecord({ id: 'x', title: 'y' }, null);
  const after = Date.now();
  assert.equal(typeof rec.addedAt, 'number');
  assert.ok(rec.addedAt >= before && rec.addedAt <= after,
    'auto-filled addedAt is within the call window');
  assert.equal(rec.ticksPerQuarter, 480, 'defaults TPQ to 480');
  assert.equal(rec.durationSec, 0);
  assert.equal(rec.noteCount, 0);
}

// pieceToRecord doesn't auto-fill when addedAt is explicitly 0 — but does when
// it's undefined. Verify both branches.
{
  const recExplicit = mod.pieceToRecord(
    { id: 'a', title: 'b', addedAt: 0 }, null);
  assert.equal(recExplicit.addedAt, 0,
    'explicit addedAt: 0 is preserved (not overwritten)');
}

// --- metadataFromRecord ---
{
  const meta = mod.metadataFromRecord({
    id: 'a', title: 'b', durationSec: 90, ticksPerQuarter: 384, noteCount: 42,
    addedAt: 42, midiBlob: { fake: true },
  });
  assert.deepEqual(meta, {
    id: 'a', title: 'b', durationSec: 90, ticksPerQuarter: 384, noteCount: 42,
    addedAt: 42, source: 'midi', hasScore: false,
  }, 'drops midiBlob; defaults source=midi, hasScore=false');

  // A score-backed record surfaces source + hasScore without leaking the blob.
  const scoreMeta = mod.metadataFromRecord({
    id: 'c', title: 'd', durationSec: 10, ticksPerQuarter: 480, noteCount: 5,
    addedAt: 7, source: 'musicxml', musicXmlBlob: { fake: true },
  });
  assert.equal(scoreMeta.source, 'musicxml');
  assert.equal(scoreMeta.hasScore, true);
  assert.ok(!('musicXmlBlob' in scoreMeta), 'metadata never carries the blob');
}
assert.equal(mod.metadataFromRecord(null), null, 'null-safe');
assert.equal(mod.metadataFromRecord(undefined), null, 'undefined-safe');

// --- exported surface ---
for (const name of ['openDb', 'listPieceMetadata', 'getPieceBlob',
    'getPieceMusicXmlBlob',
    'savePiece', 'deletePiece', 'metadataFromRecord', 'pieceToRecord',
    // Item 7 — cross-piece queue surface.
    'listAllSections', 'getRepCountsForDate',
    // Item 9 — progress-stats surface.
    'listDistinctPracticeDates',
    // Item 10 — export/import surface.
    'exportLibrary', 'importLibrary', 'arrayBufferToBase64', 'base64ToArrayBuffer']) {
  assert.equal(typeof mod[name], 'function', `db.js exports ${name}`);
}

console.log('db helpers: all assertions passed');
