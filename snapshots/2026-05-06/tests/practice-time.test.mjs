// Unit tests for formatTotalPracticeTime (item 19).
import { strict as assert } from 'node:assert';

// Inline the function since app.js isn't an ES module we can import directly.
function formatTotalPracticeTime(ms) {
  if (!ms || ms <= 0) return '';
  const totalSec = Math.floor(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  if (h === 0) return `${m}m`;
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

// Zero / negative → empty string
assert.equal(formatTotalPracticeTime(0), '');
assert.equal(formatTotalPracticeTime(-1000), '');
assert.equal(formatTotalPracticeTime(null), '');
assert.equal(formatTotalPracticeTime(undefined), '');

// Under 1 minute → seconds
assert.equal(formatTotalPracticeTime(5000), '5s');
assert.equal(formatTotalPracticeTime(59999), '59s');

// Minutes only
assert.equal(formatTotalPracticeTime(60000), '1m');
assert.equal(formatTotalPracticeTime(300000), '5m');
assert.equal(formatTotalPracticeTime(3599999), '59m');

// Hours + minutes
assert.equal(formatTotalPracticeTime(3600000), '1h');
assert.equal(formatTotalPracticeTime(3660000), '1h 1m');
assert.equal(formatTotalPracticeTime(7200000 + 720000), '2h 12m');

console.log('All practice-time tests passed.');
