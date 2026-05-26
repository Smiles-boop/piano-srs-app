// Tests for the SM-2 helpers in srs.js.
//
// All helpers are pure (no IDB, no DOM, no implicit time reads) so the
// tests below take explicit `today` strings and never call `Date.now()`.
//
// Run from the project root:
//   node tests/srs.test.mjs

import assert from 'node:assert/strict';

const mod = await import('../srs.js');

// --- Constants -----------------------------------------------------------
assert.equal(mod.EASE_DEFAULT, 2.5, 'SM-2 starts ease at 2.5');
assert.equal(mod.EASE_MIN, 1.3, 'SM-2 floors ease at 1.3');
assert.equal(mod.RATING_AGAIN, 0);
assert.equal(mod.RATING_HARD, 3);
assert.equal(mod.RATING_GOOD, 4);
assert.equal(mod.RATING_EASY, 5);

// --- defaultSrsState -----------------------------------------------------
{
  const d = mod.defaultSrsState();
  assert.deepEqual(d, {
    repetitions: 0,
    interval: 0,
    ease: 2.5,
    nextDue: null,
    lastReviewedDate: null,
  });
  // Returns a fresh object every time (no shared mutation hazards).
  d.repetitions = 99;
  assert.equal(mod.defaultSrsState().repetitions, 0);
}

// --- srsStateForSection: defaults & passthrough --------------------------
{
  // Null / undefined / non-object → defaults.
  assert.deepEqual(mod.srsStateForSection(null), mod.defaultSrsState());
  assert.deepEqual(mod.srsStateForSection(undefined), mod.defaultSrsState());
  assert.deepEqual(mod.srsStateForSection('not an object'), mod.defaultSrsState());

  // Empty section → defaults (legacy section from before item 6).
  assert.deepEqual(
    mod.srsStateForSection({ id: 's_1', name: 'A' }),
    mod.defaultSrsState(),
    'legacy section reads as default state',
  );

  // Full passthrough.
  const sec = {
    id: 's_1',
    repetitions: 3,
    interval: 15,
    ease: 2.36,
    nextDue: '2026-05-13',
    lastReviewedDate: '2026-04-28',
  };
  const s = mod.srsStateForSection(sec);
  assert.equal(s.repetitions, 3);
  assert.equal(s.interval, 15);
  assert.equal(s.ease, 2.36);
  assert.equal(s.nextDue, '2026-05-13');
  assert.equal(s.lastReviewedDate, '2026-04-28');

  // Bad types → fall back to defaults per-field.
  const bad = mod.srsStateForSection({
    repetitions: 'three',
    interval: NaN,
    ease: Infinity,
    nextDue: '',
    lastReviewedDate: 42,
  });
  assert.equal(bad.repetitions, 0);
  assert.equal(bad.interval, 0);
  assert.equal(bad.ease, 2.5);
  assert.equal(bad.nextDue, null);
  assert.equal(bad.lastReviewedDate, null);
}

// --- updateEase ----------------------------------------------------------
{
  // Standard SM-2 deltas at default ease 2.5:
  //   q=0: -0.80   q=3: -0.14   q=4:  0.00   q=5: +0.10
  assert.equal(mod.updateEase(2.5, 4), 2.5, 'Good leaves ease unchanged');
  assert.equal(mod.updateEase(2.5, 5), 2.6, 'Easy bumps ease by 0.10');

  const hard = mod.updateEase(2.5, 3);
  assert.ok(
    Math.abs(hard - 2.36) < 1e-9,
    `Hard reduces ease by 0.14 (got ${hard})`,
  );

  const again = mod.updateEase(2.5, 0);
  assert.ok(
    Math.abs(again - 1.7) < 1e-9,
    `Again reduces ease by 0.80 (got ${again})`,
  );

  // Floor at EASE_MIN (1.3).
  assert.equal(mod.updateEase(1.3, 0), 1.3, 'ease never drops below floor');
  assert.equal(mod.updateEase(1.4, 0), 1.3, 'big drop clamps at floor');
  assert.equal(mod.updateEase(2.0, 0), 1.3, 'still clamps');

  // Quality clamps to 0–5.
  assert.equal(mod.updateEase(2.5, -3), mod.updateEase(2.5, 0));
  assert.equal(mod.updateEase(2.5, 99), mod.updateEase(2.5, 5));

  // Bad ease falls back to default before applying the delta.
  assert.equal(mod.updateEase(NaN, 4), 2.5);
  assert.equal(mod.updateEase('not a number', 4), 2.5);
}

// --- applySm2: new-card progression with Good ----------------------------
{
  const today = '2026-04-28';
  // First review (repetitions 0 → 1) with Good → interval 1, due tomorrow.
  const r1 = mod.applySm2(mod.defaultSrsState(), mod.RATING_GOOD, today);
  assert.equal(r1.repetitions, 1);
  assert.equal(r1.interval, 1);
  assert.equal(r1.ease, 2.5, 'Good leaves ease at 2.5 on first review');
  assert.equal(r1.nextDue, '2026-04-29', 'next due = today + 1 day');
  assert.equal(r1.lastReviewedDate, today);

  // Second review with Good → interval 6.
  const r2 = mod.applySm2(r1, mod.RATING_GOOD, '2026-04-29');
  assert.equal(r2.repetitions, 2);
  assert.equal(r2.interval, 6);
  assert.equal(r2.ease, 2.5);
  assert.equal(r2.nextDue, '2026-05-05');

  // Third review with Good → interval = ceil(6 * 2.5) = 15.
  const r3 = mod.applySm2(r2, mod.RATING_GOOD, '2026-05-05');
  assert.equal(r3.repetitions, 3);
  assert.equal(r3.interval, 15);
  assert.equal(r3.ease, 2.5);
  assert.equal(r3.nextDue, '2026-05-20');

  // Fourth: ceil(15 * 2.5) = 38.
  const r4 = mod.applySm2(r3, mod.RATING_GOOD, '2026-05-20');
  assert.equal(r4.interval, 38);
}

// --- applySm2: lapse (Again) resets streak --------------------------------
{
  const today = '2026-05-05';
  const matured = {
    repetitions: 3,
    interval: 15,
    ease: 2.5,
    nextDue: '2026-05-20',
    lastReviewedDate: '2026-04-28',
  };
  const r = mod.applySm2(matured, mod.RATING_AGAIN, today);
  assert.equal(r.repetitions, 0, 'Again resets the rep streak');
  assert.equal(r.interval, 1, 'Again schedules for tomorrow');
  assert.equal(r.nextDue, '2026-05-06');
  // Ease drops by 0.80 with Again.
  assert.ok(Math.abs(r.ease - 1.7) < 1e-9, `ease dropped to ~1.7 (got ${r.ease})`);
}

// --- applySm2: Hard reduces ease but keeps streak -------------------------
{
  const today = '2026-04-28';
  const after2nd = {
    repetitions: 2,
    interval: 6,
    ease: 2.5,
    nextDue: '2026-04-28',
    lastReviewedDate: '2026-04-22',
  };
  const r = mod.applySm2(after2nd, mod.RATING_HARD, today);
  assert.equal(r.repetitions, 3, 'Hard still counts as a successful rep');
  assert.ok(Math.abs(r.ease - 2.36) < 1e-9);
  // ceil(6 * 2.36) = 15
  assert.equal(r.interval, 15);
  assert.equal(r.nextDue, '2026-05-13');
}

// --- applySm2: Easy bumps ease + extends interval -------------------------
{
  const today = '2026-04-28';
  const after2nd = {
    repetitions: 2,
    interval: 6,
    ease: 2.5,
    nextDue: '2026-04-28',
    lastReviewedDate: '2026-04-22',
  };
  const r = mod.applySm2(after2nd, mod.RATING_EASY, today);
  assert.equal(r.repetitions, 3);
  assert.equal(r.ease, 2.6);
  // ceil(6 * 2.6) = 16
  assert.equal(r.interval, 16);
  assert.equal(r.nextDue, '2026-05-14');
}

// --- applySm2: validates todayISO ----------------------------------------
{
  assert.throws(
    () => mod.applySm2(mod.defaultSrsState(), mod.RATING_GOOD, '04/28/2026'),
    /invalid todayISO/,
  );
  assert.throws(
    () => mod.applySm2(mod.defaultSrsState(), mod.RATING_GOOD, ''),
    /invalid todayISO/,
  );
  assert.throws(
    () => mod.applySm2(mod.defaultSrsState(), mod.RATING_GOOD, null),
    /invalid todayISO/,
  );
}

// --- applySm2: tolerates a null/legacy state -----------------------------
{
  const r = mod.applySm2(null, mod.RATING_GOOD, '2026-04-28');
  assert.equal(r.repetitions, 1);
  assert.equal(r.interval, 1);
  assert.equal(r.nextDue, '2026-04-29');
}

// --- addDaysISO ----------------------------------------------------------
{
  assert.equal(mod.addDaysISO('2026-04-28', 1), '2026-04-29');
  assert.equal(mod.addDaysISO('2026-04-28', 0), '2026-04-28');
  assert.equal(mod.addDaysISO('2026-04-28', 7), '2026-05-05');
  // Month boundary
  assert.equal(mod.addDaysISO('2026-04-30', 1), '2026-05-01');
  // Year boundary
  assert.equal(mod.addDaysISO('2026-12-31', 1), '2027-01-01');
  // Leap year — 2024 was a leap year
  assert.equal(mod.addDaysISO('2024-02-28', 1), '2024-02-29');
  assert.equal(mod.addDaysISO('2024-02-29', 1), '2024-03-01');
  // Non-leap
  assert.equal(mod.addDaysISO('2026-02-28', 1), '2026-03-01');
  // Negative days (pre-roll the date)
  assert.equal(mod.addDaysISO('2026-05-01', -1), '2026-04-30');
  assert.equal(mod.addDaysISO('2027-01-01', -1), '2026-12-31');
  // Big jumps
  assert.equal(mod.addDaysISO('2026-04-28', 365), '2027-04-28');
  // Floor for non-integer days
  assert.equal(mod.addDaysISO('2026-04-28', 2.7), '2026-04-30');

  // Bad input throws.
  assert.throws(() => mod.addDaysISO('not-a-date', 1), /invalid date/);
  assert.throws(() => mod.addDaysISO('2026-4-28', 1), /invalid date/);
  assert.throws(() => mod.addDaysISO('', 1), /invalid date/);
  assert.throws(() => mod.addDaysISO(null, 1), /invalid date/);
}

// --- daysBetweenISO ------------------------------------------------------
{
  assert.equal(mod.daysBetweenISO('2026-04-28', '2026-04-29'), 1);
  assert.equal(mod.daysBetweenISO('2026-04-28', '2026-04-28'), 0);
  assert.equal(mod.daysBetweenISO('2026-04-28', '2026-04-27'), -1, 'negative when b is before a');
  assert.equal(mod.daysBetweenISO('2026-04-28', '2026-05-05'), 7);
  assert.equal(mod.daysBetweenISO('2026-04-28', '2027-04-28'), 365);
  // Across DST transitions in NY/EU — Math.round() absorbs the ±1h drift.
  assert.equal(mod.daysBetweenISO('2026-03-01', '2026-04-01'), 31);
  assert.equal(mod.daysBetweenISO('2026-10-01', '2026-11-01'), 31);

  assert.throws(() => mod.daysBetweenISO('bad', '2026-01-01'), /invalid date/);
  assert.throws(() => mod.daysBetweenISO('2026-01-01', 'bad'), /invalid date/);
}

// --- describeNextDue -----------------------------------------------------
{
  assert.equal(mod.describeNextDue(null, '2026-04-28'), '');
  assert.equal(mod.describeNextDue('', '2026-04-28'), '');
  assert.equal(mod.describeNextDue('2026-04-28', '2026-04-28'), '2026-04-28 (due today)');
  assert.equal(mod.describeNextDue('2026-04-29', '2026-04-28'), '2026-04-29 (tomorrow)');
  assert.equal(mod.describeNextDue('2026-05-05', '2026-04-28'), '2026-05-05 (in 7 days)');
  assert.equal(mod.describeNextDue('2026-04-27', '2026-04-28'), '2026-04-27 (1 day overdue)');
  assert.equal(mod.describeNextDue('2026-04-25', '2026-04-28'), '2026-04-25 (3 days overdue)');
  // No today → just return the date.
  assert.equal(mod.describeNextDue('2026-04-29', null), '2026-04-29');
  assert.equal(mod.describeNextDue('2026-04-29', 'bad'), '2026-04-29');
}

// --- exported surface check ----------------------------------------------
{
  const expected = [
    'EASE_DEFAULT',
    'EASE_MIN',
    'RATING_AGAIN',
    'RATING_HARD',
    'RATING_GOOD',
    'RATING_EASY',
    'defaultSrsState',
    'srsStateForSection',
    'updateEase',
    'applySm2',
    'addDaysISO',
    'daysBetweenISO',
    'describeNextDue',
    // Item 7 — daily review queue helper.
    'buildReviewQueue',
  ];
  for (const name of expected) {
    assert.ok(name in mod, `srs.js exports ${name}`);
  }
}

console.log('srs helpers: all assertions passed');
