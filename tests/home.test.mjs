// Tests for the home-dashboard pure helpers in srs.js:
//   computeLongestStreak, dueForecast, memoryStageDistribution.
//
// Run from the project root:
//   node tests/home.test.mjs

import assert from 'node:assert/strict';

const mod = await import('../srs.js');
const { computeLongestStreak, dueForecast, memoryStageDistribution } = mod;

// --- computeLongestStreak -------------------------------------------------
{
  assert.equal(computeLongestStreak(null), 0, 'null → 0');
  assert.equal(computeLongestStreak([]), 0, 'empty → 0');
  assert.equal(computeLongestStreak(['2026-06-10']), 1, 'single day → 1');

  // A clean 3-day run.
  assert.equal(
    computeLongestStreak(['2026-06-08', '2026-06-09', '2026-06-10']),
    3,
    'three consecutive → 3',
  );

  // Two runs split by a gap: longest wins (4 vs 2).
  assert.equal(
    computeLongestStreak([
      '2026-06-01', '2026-06-02', // run of 2
      '2026-06-10', '2026-06-11', '2026-06-12', '2026-06-13', // run of 4
    ]),
    4,
    'longest of two runs',
  );

  // Order of input must not matter (Set + first-day detection).
  assert.equal(
    computeLongestStreak(['2026-06-12', '2026-06-10', '2026-06-11']),
    3,
    'unordered input still 3',
  );

  // Duplicates collapse; invalid dates are ignored.
  assert.equal(
    computeLongestStreak(['2026-06-10', '2026-06-10', 'nope', '', null]),
    1,
    'dupes + junk → 1',
  );

  // Month boundary (May 31 → Jun 1) counts as consecutive.
  assert.equal(
    computeLongestStreak(['2026-05-31', '2026-06-01']),
    2,
    'crosses month boundary',
  );
}

// --- dueForecast ----------------------------------------------------------
{
  assert.throws(
    () => dueForecast({ sections: [], todayISO: 'bad' }),
    /invalid todayISO/,
    'invalid todayISO throws',
  );

  const today = '2026-06-10';

  // Empty library → all-zero buckets, correct length + shape.
  const empty = dueForecast({ sections: [], todayISO: today, days: 7 });
  assert.equal(empty.length, 7, 'default window length honoured');
  assert.equal(empty[0].dateISO, today, 'bucket 0 is today');
  assert.equal(empty[0].daysFromToday, 0);
  assert.equal(empty[6].dateISO, '2026-06-16', 'bucket 6 is today+6');
  assert.ok(empty.every((b) => b.count === 0), 'no sections → all zero');

  const sections = [
    { id: 'a', nextDue: '2026-06-10' }, // today → bucket 0
    { id: 'b', nextDue: '2026-06-05' }, // overdue → folds into bucket 0
    { id: 'c', nextDue: '2026-06-11' }, // tomorrow → bucket 1
    { id: 'd', nextDue: '2026-06-11' }, // tomorrow → bucket 1
    { id: 'e', nextDue: '2026-06-16' }, // +6 → bucket 6 (in window)
    { id: 'f', nextDue: '2026-06-17' }, // +7 → beyond a 7-day window, dropped
    { id: 'g' }, // unscheduled → ignored
  ];
  const fc = dueForecast({ sections, todayISO: today, days: 7 });
  assert.equal(fc[0].count, 2, 'today bucket counts due-today + overdue');
  assert.equal(fc[1].count, 2, 'tomorrow bucket counts both');
  assert.equal(fc[6].count, 1, '+6 day counted');
  const total = fc.reduce((s, b) => s + b.count, 0);
  assert.equal(total, 5, 'beyond-window + unscheduled excluded');

  // Custom window length.
  const fc14 = dueForecast({ sections, todayISO: today, days: 14 });
  assert.equal(fc14.length, 14, 'custom window length');
  assert.equal(fc14[7].count, 1, '+7 now falls inside a 14-day window');
}

// --- memoryStageDistribution ----------------------------------------------
{
  const empty = memoryStageDistribution([]);
  assert.equal(empty.total, 0, 'empty → total 0');
  assert.equal(empty.stages.length, 4, 'always four stages');
  assert.deepEqual(
    empty.stages.map((s) => s.count),
    [0, 0, 0, 0],
    'empty → all zero counts',
  );
  assert.deepEqual(
    empty.stages.map((s) => s.label),
    ['Watch', 'Find', 'Glance', 'From memory'],
    'stage labels in ramp order',
  );

  const sections = [
    {}, // unrated → repetitions 0 → Watch (0)
    { repetitions: 0 }, // Watch (0)
    { repetitions: 1 }, // Find (1)
    { repetitions: 2 }, // Glance (2)
    { repetitions: 3 }, // From memory (3)
    { repetitions: 9 }, // clamps to From memory (3)
    null, // skipped
  ];
  const dist = memoryStageDistribution(sections);
  assert.equal(dist.total, 6, 'null skipped; six valid sections');
  assert.deepEqual(
    dist.stages.map((s) => s.count),
    [2, 1, 1, 2],
    'counts bucketed by baseline stage with clamping',
  );
  // Stage objects expose stage/key/label/hint/count for the legend.
  assert.equal(dist.stages[0].key, 'watch');
  assert.equal(dist.stages[3].stage, 3);
  assert.equal(typeof dist.stages[2].hint, 'string');
}

console.log('home dashboard helpers: all assertions passed');
