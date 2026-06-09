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
    addedAt: 42,
  }, 'drops midiBlob from metadata view');
}
assert.equal(mod.metadataFromRecord(null), null, 'null-safe');
assert.equal(mod.metadataFromRecord(undefined), null, 'undefined-safe');

// --- exported surface ---
for (const name of ['openDb', 'listPieceMetadata', 'getPieceBlob',
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
