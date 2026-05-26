// Tests for the rep-log pure helpers in db.js (localDateISO, repLogId,
// newRepLogRecord, bumpRepLog, isRepGoalMet, REP_GOAL).
//
// Run from the project root:
//   node tests/repLogs.test.mjs

import assert from 'node:assert/strict';

const mod = await import('../db.js');

// --- REP_GOAL is a stable, expected constant -----------------------------
assert.equal(mod.REP_GOAL, 10, 'REP_GOAL is locked at 10 for now');

// --- isRepGoalMet --------------------------------------------------------
{
  assert.equal(mod.isRepGoalMet(0), false);
  assert.equal(mod.isRepGoalMet(9), false);
  assert.equal(mod.isRepGoalMet(10), true, 'exactly 10 is "met"');
  assert.equal(mod.isRepGoalMet(11), true, 'past goal still counts as met');
  assert.equal(mod.isRepGoalMet(undefined), false, 'undefined → 0 → not met');
  assert.equal(mod.isRepGoalMet(null), false);
  assert.equal(mod.isRepGoalMet('7'), false, 'numeric string coerced');
  assert.equal(mod.isRepGoalMet('11'), true, 'numeric string coerced');
}

// --- localDateISO: deterministic with explicit Date ----------------------
{
  // Use an explicit Date built from local components — testing this on the
  // raw-ms epoch would produce TZ-dependent output, which is exactly what
  // localDateISO is supposed to abstract away.
  const d = new Date(2026, 3, 27, 14, 30, 5); // 2026-04-27 14:30:05 local
  assert.equal(
    mod.localDateISO(d),
    '2026-04-27',
    'pads month + day to 2 digits in local time',
  );
}
{
  // Single-digit month + day → padded.
  const d = new Date(2026, 0, 1, 0, 0, 0); // 2026-01-01 local midnight
  assert.equal(mod.localDateISO(d), '2026-01-01');
}
{
  // Last day of December.
  const d = new Date(2099, 11, 31, 23, 59, 59);
  assert.equal(mod.localDateISO(d), '2099-12-31');
}
{
  // No-arg call returns *some* well-formed YYYY-MM-DD.
  const today = mod.localDateISO();
  assert.match(today, /^\d{4}-\d{2}-\d{2}$/, 'no-arg returns YYYY-MM-DD');
}

// --- repLogId ------------------------------------------------------------
{
  assert.equal(mod.repLogId('s_abc', '2026-04-27'), 's_abc|2026-04-27');
  assert.equal(mod.repLogId('s_x_y', '2026-01-01'), 's_x_y|2026-01-01');
  // The pipe char is the deliberate separator — make sure it's exactly one.
  const id = mod.repLogId('s_abc', '2026-04-27');
  assert.equal(id.split('|').length, 2, 'exactly one separator');
}

// --- newRepLogRecord -----------------------------------------------------
{
  const rec = mod.newRepLogRecord('s_abc', '2026-04-27', 0, 1000);
  assert.deepEqual(rec, {
    id: 's_abc|2026-04-27',
    sectionId: 's_abc',
    dateISO: '2026-04-27',
    count: 0,
    createdAt: 1000,
    updatedAt: 1000,
  });
}
{
  // Auto-fills createdAt/updatedAt when no explicit `now`.
  const before = Date.now();
  const rec = mod.newRepLogRecord('s_abc', '2026-04-27', 3);
  const after = Date.now();
  assert.equal(rec.count, 3);
  assert.ok(
    rec.createdAt >= before && rec.createdAt <= after,
    'createdAt within call window',
  );
  assert.equal(rec.updatedAt, rec.createdAt, 'fresh record: updated == created');
}
{
  // Negative or NaN counts coerce to 0.
  const a = mod.newRepLogRecord('s_a', '2026-04-27', -5, 1);
  assert.equal(a.count, 0, 'negative count clamped to 0');
  const b = mod.newRepLogRecord('s_a', '2026-04-27', NaN, 1);
  assert.equal(b.count, 0, 'NaN clamped to 0');
  const c = mod.newRepLogRecord('s_a', '2026-04-27', '4', 1);
  assert.equal(c.count, 4, 'numeric string coerced');
  const d = mod.newRepLogRecord('s_a', '2026-04-27', 2.7, 1);
  assert.equal(d.count, 2, 'fractional count floored');
}

// --- bumpRepLog: brand-new section/day path ------------------------------
{
  const rec = mod.bumpRepLog(null, 's_abc', '2026-04-27', 5000);
  assert.deepEqual(rec, {
    id: 's_abc|2026-04-27',
    sectionId: 's_abc',
    dateISO: '2026-04-27',
    count: 1,
    createdAt: 5000,
    updatedAt: 5000,
  }, 'first rep of the day creates a count-1 record');
}

// --- bumpRepLog: existing record path ------------------------------------
{
  const existing = mod.newRepLogRecord('s_abc', '2026-04-27', 4, 1000);
  const bumped = mod.bumpRepLog(existing, 's_abc', '2026-04-27', 9000);
  assert.equal(bumped.count, 5, 'existing count bumped by 1');
  assert.equal(bumped.createdAt, 1000, 'createdAt preserved across bumps');
  assert.equal(bumped.updatedAt, 9000, 'updatedAt advanced to current time');
  assert.equal(bumped.id, existing.id, 'id is stable');
  // The original existing record must NOT be mutated.
  assert.equal(existing.count, 4, 'bumpRepLog is non-mutating');
  assert.equal(existing.updatedAt, 1000, 'bumpRepLog is non-mutating');
}

// --- bumpRepLog: handles a missing/zero count on the existing record -----
{
  // Defensive: an existing record with count 0 still bumps to 1, not "0+1=1
  // but only if truthy". Using `(count || 0) + 1` is the implementation.
  const existing = { id: 's_a|2026-04-27', sectionId: 's_a', dateISO: '2026-04-27', count: 0, createdAt: 1, updatedAt: 1 };
  const bumped = mod.bumpRepLog(existing, 's_a', '2026-04-27', 2);
  assert.equal(bumped.count, 1);
}
{
  // Defensive: an existing record with no count field (legacy/imported)
  // should still bump to 1.
  const existing = { id: 's_a|2026-04-27', sectionId: 's_a', dateISO: '2026-04-27', createdAt: 1, updatedAt: 1 };
  const bumped = mod.bumpRepLog(existing, 's_a', '2026-04-27', 2);
  assert.equal(bumped.count, 1, 'missing count treated as 0');
}

// --- bumpRepLog: doesn't cap at REP_GOAL ---------------------------------
// The cap is enforced at the UI layer so the persistence helper stays
// trivial and reusable from import flows. A future "rate after goal" prompt
// (item 8) might want to allow >10 reps in a "warm-up + reattempt" flow.
{
  const existing = mod.newRepLogRecord('s_a', '2026-04-27', 10, 1);
  const bumped = mod.bumpRepLog(existing, 's_a', '2026-04-27', 2);
  assert.equal(bumped.count, 11, 'bumpRepLog does not cap at REP_GOAL');
}

// --- exported surface ----------------------------------------------------
for (const name of [
  'REP_GOAL',
  'localDateISO',
  'repLogId',
  'newRepLogRecord',
  'bumpRepLog',
  'isRepGoalMet',
  'getRepLog',
  'saveRepLog',
  'incrementRepLog',
  'setRepLogCount',
  'getRepCountsForSections',
  'listRepLogsForSection',
]) {
  assert.ok(name in mod, `export "${name}" is present`);
}

console.log('rep-log helpers: all assertions passed');
