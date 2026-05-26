// Tests for the pure helpers in db.js (pieceToRecord, metadataFromRecord).
//
// db.js only touches `indexedDB` lazily inside `openDb()`, so importing it in
// Node is safe without any DOM stub. Run from the project root:
//   node tests/db.test.mjs

import assert from 'node:assert/strict';

const mod = await import('../db.js');

// --- pieceToRecord ---
{
  const piece = { id: 'p_abc', title: 'Test Piece', pageCount: 4, addedAt: 1000 };
  const blob = { _fakeBlob: true };
  const rec = mod.pieceToRecord(piece, blob);
  assert.equal(rec.id, 'p_abc');
  assert.equal(rec.title, 'Test Piece');
  assert.equal(rec.pageCount, 4);
  assert.equal(rec.addedAt, 1000, 'preserves provided addedAt');
  assert.strictEqual(rec.pdfBlob, blob, 'attaches the blob unchanged');
}

// pieceToRecord auto-fills addedAt when missing
{
  const before = Date.now();
  const rec = mod.pieceToRecord({ id: 'x', title: 'y', pageCount: 1 }, null);
  const after = Date.now();
  assert.equal(typeof rec.addedAt, 'number');
  assert.ok(rec.addedAt >= before && rec.addedAt <= after,
    'auto-filled addedAt is within the call window');
}

// pieceToRecord doesn't auto-fill when addedAt is explicitly 0 — but does when
// it's undefined. Verify both branches.
{
  const recExplicit = mod.pieceToRecord(
    { id: 'a', title: 'b', pageCount: 1, addedAt: 0 }, null);
  assert.equal(recExplicit.addedAt, 0,
    'explicit addedAt: 0 is preserved (not overwritten)');
}

// --- metadataFromRecord ---
{
  const meta = mod.metadataFromRecord({
    id: 'a', title: 'b', pageCount: 7, addedAt: 42, pdfBlob: { fake: true },
  });
  assert.deepEqual(meta, { id: 'a', title: 'b', pageCount: 7, addedAt: 42 },
    'drops pdfBlob from metadata view');
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
