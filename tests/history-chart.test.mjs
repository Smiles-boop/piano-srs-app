// Tests for practice-history chart helpers (item 12c).
//
// The chart rendering itself needs a DOM, but we can test:
//   1. That `listAllRepLogs` is exported from db.js (async function surface).
//   2. The pure quantile, formatLocalISO, formatReadableDate helpers are
//      duplicated here as unit-testable standalone copies (since they live
//      inside app.js's module scope and aren't exported).
//
// Run: node tests/history-chart.test.mjs

import assert from 'node:assert/strict';

// --- db.js surface check ---
const db = await import('../db.js');
assert.equal(typeof db.listAllRepLogs, 'function',
  'listAllRepLogs should be exported from db.js');

// --- Quantile helper (copy of the in-app logic) ---
function quantile(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = p * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

// Empty array
assert.equal(quantile([], 0.5), 0, 'quantile of empty array is 0');

// Single element
assert.equal(quantile([5], 0.5), 5, 'quantile of single-element array');

// Two elements
assert.equal(quantile([2, 8], 0.5), 5, 'median of [2,8] is 5');
assert.equal(quantile([2, 8], 0.25), 3.5, 'Q1 of [2,8] is 3.5');
assert.equal(quantile([2, 8], 0.75), 6.5, 'Q3 of [2,8] is 6.5');

// Larger array
assert.equal(quantile([1, 2, 3, 4, 5], 0), 1, 'Q0 = min');
assert.equal(quantile([1, 2, 3, 4, 5], 1), 5, 'Q1.0 = max');
assert.equal(quantile([1, 2, 3, 4, 5], 0.5), 3, 'median of 1..5 is 3');

// --- formatLocalISO (copy) ---
function formatLocalISO(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

assert.equal(formatLocalISO(new Date(2026, 0, 1)), '2026-01-01');
assert.equal(formatLocalISO(new Date(2026, 11, 31)), '2026-12-31');
assert.equal(formatLocalISO(new Date(2026, 4, 4)), '2026-05-04');

// --- formatReadableDate (copy) ---
function formatReadableDate(iso) {
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return iso;
  const month = months[Number(m[2]) - 1] || m[2];
  return `${month} ${Number(m[3])}, ${m[1]}`;
}

assert.equal(formatReadableDate('2026-05-04'), 'May 4, 2026');
assert.equal(formatReadableDate('2026-01-01'), 'Jan 1, 2026');
assert.equal(formatReadableDate('2026-12-25'), 'Dec 25, 2026');
assert.equal(formatReadableDate('bad'), 'bad', 'invalid input returned as-is');

// --- Level bucketing logic (copy) ---
function computeLevel(count, q1, q2, q3) {
  if (count === 0) return 0;
  if (count <= q1) return 1;
  if (count <= q2) return 2;
  if (count <= q3) return 3;
  return 4;
}

assert.equal(computeLevel(0, 5, 10, 15), 0, 'zero is always level 0');
assert.equal(computeLevel(3, 5, 10, 15), 1, 'below Q1 is level 1');
assert.equal(computeLevel(5, 5, 10, 15), 1, 'at Q1 is level 1');
assert.equal(computeLevel(7, 5, 10, 15), 2, 'between Q1 and Q2 is level 2');
assert.equal(computeLevel(10, 5, 10, 15), 2, 'at Q2 is level 2');
assert.equal(computeLevel(12, 5, 10, 15), 3, 'between Q2 and Q3 is level 3');
assert.equal(computeLevel(15, 5, 10, 15), 3, 'at Q3 is level 3');
assert.equal(computeLevel(20, 5, 10, 15), 4, 'above Q3 is level 4');

// --- All assertions passed ---
console.log('history-chart helpers: all assertions passed');
