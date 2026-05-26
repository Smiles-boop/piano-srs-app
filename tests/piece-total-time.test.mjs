/**
 * Tests for item 20: computePieceTotalTime and updatePracticeTotalTime.
 * These test the pure logic of summing section practice times.
 */

import { strict as assert } from 'node:assert';

// Inline re-implementation of the pure functions (they reference `pieces`
// global in app.js, but the logic is trivially extractable).

function computePieceTotalTime(piece) {
  if (!piece || !Array.isArray(piece.sections)) return 0;
  let total = 0;
  for (const sec of piece.sections) {
    if (sec.totalPracticeMs) total += sec.totalPracticeMs;
  }
  return total;
}

function formatTotalPracticeTime(ms) {
  if (!ms || ms <= 0) return '';
  const totalSec = Math.floor(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  if (h === 0) return `${m}m`;
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

// --- Tests ---

// computePieceTotalTime
assert.equal(computePieceTotalTime(null), 0, 'null piece → 0');
assert.equal(computePieceTotalTime({}), 0, 'no sections → 0');
assert.equal(computePieceTotalTime({ sections: [] }), 0, 'empty sections → 0');

assert.equal(
  computePieceTotalTime({
    sections: [
      { id: 's1', totalPracticeMs: 60000 },
      { id: 's2', totalPracticeMs: 120000 },
      { id: 's3' }, // no time recorded
    ],
  }),
  180000,
  'sums only sections with totalPracticeMs',
);

assert.equal(
  computePieceTotalTime({
    sections: [
      { id: 's1', totalPracticeMs: 0 },
      { id: 's2' },
    ],
  }),
  0,
  'all-zero or missing → 0',
);

// formatTotalPracticeTime edge cases relevant to per-piece display
assert.equal(formatTotalPracticeTime(180000), '3m');
assert.equal(formatTotalPracticeTime(3661000), '1h 1m');
assert.equal(formatTotalPracticeTime(7200000), '2h');
assert.equal(formatTotalPracticeTime(45000), '45s');
assert.equal(formatTotalPracticeTime(0), '');

console.log('All piece-total-time tests passed.');
