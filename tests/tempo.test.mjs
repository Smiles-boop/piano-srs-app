// Tests for the pure tempo-goal helpers in tempo.js.
//
// All helpers are pure (no DOM, no audio, no clock). Run from the project root:
//   node tests/tempo.test.mjs

import assert from 'node:assert/strict';

const mod = await import('../tempo.js');
const {
  TEMPO_MIN,
  TEMPO_MAX,
  TEMPO_STEP,
  clampTempo,
  isValidTempo,
  tempoGoalReached,
  tempoGoalProgressPct,
  nextWorkingTempo,
  suggestStartTempo,
  tempoGoalSummary,
} = mod;

// --- constants -------------------------------------------------------------
assert.equal(TEMPO_MIN, 30);
assert.equal(TEMPO_MAX, 300);
assert.equal(TEMPO_STEP, 5);

// --- clampTempo ------------------------------------------------------------
assert.equal(clampTempo(120), 120, 'in-range passes through');
assert.equal(clampTempo(10), 30, 'below min clamps up');
assert.equal(clampTempo(999), 300, 'above max clamps down');
assert.equal(clampTempo(120.6), 121, 'rounds to whole BPM');
assert.equal(clampTempo('90'), 90, 'numeric strings coerce');
assert.equal(clampTempo('abc'), null, 'garbage → null');
assert.equal(clampTempo(undefined), null, 'undefined → null');
assert.equal(clampTempo(NaN), null, 'NaN → null');

// --- isValidTempo ----------------------------------------------------------
assert.equal(isValidTempo(120), true);
assert.equal(isValidTempo(29), false, 'below min is invalid');
assert.equal(isValidTempo(301), false, 'above max is invalid');
assert.equal(isValidTempo('x'), false);

// --- tempoGoalReached ------------------------------------------------------
assert.equal(tempoGoalReached(120, 120), true, 'exactly at goal counts');
assert.equal(tempoGoalReached(130, 120), true, 'past goal counts');
assert.equal(tempoGoalReached(119, 120), false, 'below goal does not');
assert.equal(tempoGoalReached(0, 120), false, 'no best yet');
assert.equal(tempoGoalReached(120, null), false, 'no goal → not reached');

// --- tempoGoalProgressPct --------------------------------------------------
assert.equal(tempoGoalProgressPct(60, 120), 50, 'half way');
assert.equal(tempoGoalProgressPct(120, 120), 100, 'at goal = 100%');
assert.equal(tempoGoalProgressPct(200, 120), 100, 'capped at 100%');
assert.equal(tempoGoalProgressPct(0, 120), 0, 'no best = 0%');
assert.equal(tempoGoalProgressPct(60, null), 0, 'no goal = 0%');

// --- nextWorkingTempo ------------------------------------------------------
assert.equal(nextWorkingTempo(90, 120), 95, 'default step is +5');
assert.equal(nextWorkingTempo(90, 120, 10), 100, 'custom step honoured');
assert.equal(nextWorkingTempo(118, 120), 120, 'never overshoots target');
assert.equal(nextWorkingTempo(120, 120), 120, 'at target stays put');
assert.equal(nextWorkingTempo(130, 120), 120, 'past target snaps back to target');
assert.equal(nextWorkingTempo(298, null), 300, 'no target → bump clamps to max');

// --- suggestStartTempo -----------------------------------------------------
assert.equal(suggestStartTempo(120), 70, '60% of 120 = 72 → snap down to 70');
assert.equal(suggestStartTempo(100), 60, '60% of 100 = 60');
assert.equal(suggestStartTempo(40), TEMPO_MIN, 'tiny goals floor at the minimum');
assert.equal(suggestStartTempo(null), TEMPO_MIN, 'no goal → minimum');

// --- tempoGoalSummary ------------------------------------------------------
{
  const none = tempoGoalSummary({});
  assert.equal(none.hasGoal, false);
  assert.equal(none.target, null);
  assert.equal(none.best, 0);
  assert.equal(none.pct, 0);
  assert.equal(none.reached, false);
  assert.equal(none.remaining, 0);
}
{
  const s = tempoGoalSummary({ targetTempo: 120, bestCleanTempo: 90, workingTempo: 100 });
  assert.equal(s.hasGoal, true);
  assert.equal(s.target, 120);
  assert.equal(s.best, 90);
  assert.equal(s.working, 100);
  assert.equal(s.pct, 75);
  assert.equal(s.reached, false);
  assert.equal(s.remaining, 30);
}
{
  const done = tempoGoalSummary({ targetTempo: 100, bestCleanTempo: 110 });
  assert.equal(done.reached, true);
  assert.equal(done.pct, 100);
  assert.equal(done.remaining, 0);
}

// --- exports present -------------------------------------------------------
for (const name of [
  'clampTempo', 'isValidTempo', 'tempoGoalReached', 'tempoGoalProgressPct',
  'nextWorkingTempo', 'suggestStartTempo', 'tempoGoalSummary',
]) {
  assert.ok(name in mod, `tempo.js exports ${name}`);
}

console.log('tempo helpers: all assertions passed');
