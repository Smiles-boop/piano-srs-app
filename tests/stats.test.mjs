// Tests for the progress-stats helpers in srs.js (roadmap item 9).
//
// Pure helpers under test:
//   - MASTERY_INTERVAL_DAYS (constant)
//   - isSectionMastered(section)
//   - computeDailyStreak(practiceDates, todayISO)
//   - summariseProgress({ sections, pieces, practiceDates, repCountsToday,
//                         todayISO, repGoal })
//
// All functions take an explicit `todayISO` so the tests are deterministic
// regardless of machine time / timezone. None of them touch IDB or DOM.
//
// Run from the project root:
//   node tests/stats.test.mjs

import assert from 'node:assert/strict';

const mod = await import('../srs.js');

// --- Constant ------------------------------------------------------------
assert.equal(
  mod.MASTERY_INTERVAL_DAYS,
  21,
  'mastery threshold lives at 21 days',
);

// --- isSectionMastered ---------------------------------------------------
{
  // Null / undefined / non-object → not mastered.
  assert.equal(mod.isSectionMastered(null), false);
  assert.equal(mod.isSectionMastered(undefined), false);
  assert.equal(mod.isSectionMastered('not an object'), false);

  // Fresh section (no SRS state) → not mastered.
  assert.equal(
    mod.isSectionMastered({ id: 's_1', name: 'Intro' }),
    false,
    'fresh section is not mastered',
  );

  // Rated section, but interval below the floor → not mastered.
  assert.equal(
    mod.isSectionMastered({
      id: 's_1',
      interval: 6,
      ease: 2.5,
      lastReviewedDate: '2026-04-22',
      nextDue: '2026-04-28',
    }),
    false,
    '6-day interval is not mastered',
  );
  assert.equal(
    mod.isSectionMastered({
      id: 's_1',
      interval: 20,
      ease: 2.5,
      lastReviewedDate: '2026-04-08',
      nextDue: '2026-04-28',
    }),
    false,
    '20-day interval is just below the floor',
  );

  // Exactly at the floor → mastered (>= comparison, not >).
  assert.equal(
    mod.isSectionMastered({
      id: 's_1',
      interval: 21,
      ease: 2.5,
      lastReviewedDate: '2026-04-07',
      nextDue: '2026-04-28',
    }),
    true,
    '21-day interval is mastered',
  );

  // Comfortable mastery — interval well above the floor.
  assert.equal(
    mod.isSectionMastered({
      id: 's_1',
      interval: 60,
      ease: 2.5,
      lastReviewedDate: '2026-02-27',
      nextDue: '2026-04-28',
    }),
    true,
  );

  // Edge case: interval clears the floor but no `lastReviewedDate` set —
  // shouldn't happen in practice (SM-2 always stamps it), but guard anyway.
  assert.equal(
    mod.isSectionMastered({ id: 's_1', interval: 30 }),
    false,
    'interval without lastReviewedDate is not mastered',
  );

  // Garbage interval value.
  assert.equal(
    mod.isSectionMastered({
      id: 's_1',
      interval: 'thirty',
      lastReviewedDate: '2026-01-01',
    }),
    false,
  );
  assert.equal(
    mod.isSectionMastered({
      id: 's_1',
      interval: NaN,
      lastReviewedDate: '2026-01-01',
    }),
    false,
  );
}

// --- computeDailyStreak --------------------------------------------------
{
  // Empty input → streak 0.
  assert.equal(mod.computeDailyStreak([], '2026-04-29'), 0);
  assert.equal(mod.computeDailyStreak(null, '2026-04-29'), 0);
  assert.equal(mod.computeDailyStreak(undefined, '2026-04-29'), 0);
  assert.equal(mod.computeDailyStreak(new Set(), '2026-04-29'), 0);

  // Today only → streak 1.
  assert.equal(
    mod.computeDailyStreak(['2026-04-29'], '2026-04-29'),
    1,
    'practiced today only → streak 1',
  );

  // Today + yesterday → 2.
  assert.equal(
    mod.computeDailyStreak(['2026-04-28', '2026-04-29'], '2026-04-29'),
    2,
  );

  // Five-day streak ending today.
  assert.equal(
    mod.computeDailyStreak(
      ['2026-04-25', '2026-04-26', '2026-04-27', '2026-04-28', '2026-04-29'],
      '2026-04-29',
    ),
    5,
  );

  // Streak that ends yesterday but not today — still counted from yesterday.
  // Lets a user open the app in the morning without panicking that their
  // streak just broke at midnight.
  assert.equal(
    mod.computeDailyStreak(['2026-04-27', '2026-04-28'], '2026-04-29'),
    2,
    'unbroken streak ending yesterday counts from yesterday backwards',
  );

  // Gap two days back breaks the streak from yesterday onward.
  assert.equal(
    mod.computeDailyStreak(['2026-04-26', '2026-04-28'], '2026-04-29'),
    1,
    'a gap breaks the streak — yesterday is the only counted day',
  );

  // No practice today AND no practice yesterday → broken.
  assert.equal(
    mod.computeDailyStreak(['2026-04-25', '2026-04-26'], '2026-04-29'),
    0,
    'streak broken when there’s no rep today or yesterday',
  );

  // Old practice with no recent activity — broken.
  assert.equal(
    mod.computeDailyStreak(['2025-12-01'], '2026-04-29'),
    0,
  );

  // Set inputs work.
  assert.equal(
    mod.computeDailyStreak(
      new Set(['2026-04-27', '2026-04-28', '2026-04-29']),
      '2026-04-29',
    ),
    3,
  );

  // Duplicate dates in the input dedupe correctly.
  assert.equal(
    mod.computeDailyStreak(
      ['2026-04-29', '2026-04-29', '2026-04-28', '2026-04-28'],
      '2026-04-29',
    ),
    2,
  );

  // Bad ISO entries silently dropped (don't break the streak walk).
  assert.equal(
    mod.computeDailyStreak(
      ['2026-04-29', 'not-a-date', '2026-04-28', null, '2026-04-27'],
      '2026-04-29',
    ),
    3,
    'malformed entries are ignored, not stream-breaking',
  );

  // A streak that walks across a month boundary.
  assert.equal(
    mod.computeDailyStreak(
      ['2026-03-30', '2026-03-31', '2026-04-01', '2026-04-02'],
      '2026-04-02',
    ),
    4,
  );

  // A streak that walks across a year boundary.
  assert.equal(
    mod.computeDailyStreak(
      ['2025-12-30', '2025-12-31', '2026-01-01'],
      '2026-01-01',
    ),
    3,
  );

  // todayISO validation.
  assert.throws(
    () => mod.computeDailyStreak(['2026-04-29'], 'bad'),
    /invalid todayISO/,
  );
  assert.throws(
    () => mod.computeDailyStreak(['2026-04-29'], null),
    /invalid todayISO/,
  );
}

// --- summariseProgress: shape + zero state -------------------------------
{
  const out = mod.summariseProgress({
    sections: [],
    pieces: [],
    practiceDates: [],
    repCountsToday: new Map(),
    todayISO: '2026-04-29',
  });
  assert.equal(out.sectionsTotal, 0);
  assert.equal(out.sectionsRated, 0);
  assert.equal(out.sectionsMastered, 0);
  assert.equal(out.dailyStreak, 0);
  assert.equal(out.todayDoneCount, 0);
  assert.equal(out.todayDueCount, 0);
  assert.equal(out.piecesTotal, 0);
  assert.deepEqual(out.perPiece, []);

  // todayISO validation.
  assert.throws(
    () =>
      mod.summariseProgress({
        sections: [],
        pieces: [],
        practiceDates: [],
        repCountsToday: new Map(),
        todayISO: 'bad',
      }),
    /invalid todayISO/,
  );
}

// --- summariseProgress: a realistic mixed library ------------------------
{
  // Library: 2 pieces. Sonata has 3 sections (1 mastered, 1 in rotation, 1
  // unrated). Étude has 2 sections (both rated, 0 mastered). Today: user
  // has logged reps on all three Sonata sections (one done, one mid-way,
  // one unrated which they're warming up on).
  const pieces = [
    { id: 'p_sonata', title: 'Sonata in C' },
    { id: 'p_etude', title: 'Étude Op. 25 No. 1' },
  ];
  const sections = [
    {
      id: 's_son_1', pieceId: 'p_sonata', name: 'Exposition',
      // mastered (interval >= 21)
      repetitions: 4, interval: 38, ease: 2.5,
      lastReviewedDate: '2026-04-22', nextDue: '2026-05-30',
      addedAt: 1,
    },
    {
      id: 's_son_2', pieceId: 'p_sonata', name: 'Development',
      // in rotation (rated, interval < 21)
      repetitions: 2, interval: 6, ease: 2.5,
      lastReviewedDate: '2026-04-23', nextDue: '2026-04-29',
      addedAt: 2,
    },
    {
      id: 's_son_3', pieceId: 'p_sonata', name: 'Recapitulation',
      // unrated (no SM-2 fields)
      addedAt: 3,
    },
    {
      id: 's_et_1', pieceId: 'p_etude', name: 'Right hand only',
      // in rotation
      repetitions: 1, interval: 1, ease: 2.5,
      lastReviewedDate: '2026-04-28', nextDue: '2026-04-29',
      addedAt: 4,
    },
    {
      id: 's_et_2', pieceId: 'p_etude', name: 'Hands together',
      // in rotation (overdue)
      repetitions: 1, interval: 1, ease: 2.5,
      lastReviewedDate: '2026-04-27', nextDue: '2026-04-28',
      addedAt: 5,
    },
  ];
  // Today's reps: Sonata Exposition done (10), Sonata Development at 4,
  // Recapitulation at 2, Étude sections untouched.
  const repCountsToday = new Map([
    ['s_son_1', 10],
    ['s_son_2', 4],
    ['s_son_3', 2],
  ]);
  const practiceDates = ['2026-04-27', '2026-04-28', '2026-04-29'];

  const out = mod.summariseProgress({
    sections,
    pieces,
    practiceDates,
    repCountsToday,
    todayISO: '2026-04-29',
    repGoal: 10,
  });

  assert.equal(out.sectionsTotal, 5);
  assert.equal(out.sectionsRated, 4, '4 of 5 sections have been rated');
  assert.equal(out.sectionsMastered, 1, 'only Exposition has interval >= 21');
  assert.equal(out.dailyStreak, 3, '3 consecutive days of practice');
  assert.equal(
    out.todayDoneCount,
    1,
    'only Exposition crossed the 10-rep goal today',
  );
  // Due today: Sonata Development (nextDue 2026-04-29), Étude RH-only
  // (nextDue 2026-04-29), Étude hands-together (nextDue 2026-04-28, overdue
  // by 1). Recap is unscheduled. Exposition's nextDue 2026-05-30 is in the
  // future.
  assert.equal(out.todayDueCount, 3, '3 sections were due today');
  assert.equal(out.piecesTotal, 2);

  // Per-piece sort: Sonata first (1/3 = 33% mastered) > Étude (0/2 = 0%).
  assert.equal(out.perPiece.length, 2);
  assert.equal(out.perPiece[0].pieceId, 'p_sonata');
  assert.equal(out.perPiece[0].sectionsTotal, 3);
  assert.equal(out.perPiece[0].sectionsRated, 2);
  assert.equal(out.perPiece[0].sectionsMastered, 1);
  assert.equal(out.perPiece[0].masteryPct, 33);
  assert.equal(out.perPiece[1].pieceId, 'p_etude');
  assert.equal(out.perPiece[1].sectionsTotal, 2);
  assert.equal(out.perPiece[1].sectionsRated, 2);
  assert.equal(out.perPiece[1].sectionsMastered, 0);
  assert.equal(out.perPiece[1].masteryPct, 0);
}

// --- summariseProgress: rep-counts as a plain object ---------------------
{
  // Same data shape as before, but repCountsToday is a plain object — the
  // helper should accept either a Map or a plain object.
  const out = mod.summariseProgress({
    sections: [
      { id: 's_a', pieceId: 'p_a', addedAt: 1 },
      { id: 's_b', pieceId: 'p_a', addedAt: 2 },
    ],
    pieces: [{ id: 'p_a', title: 'Piece A' }],
    practiceDates: [],
    repCountsToday: { s_a: 10, s_b: 3 },
    todayISO: '2026-04-29',
  });
  assert.equal(out.todayDoneCount, 1, 's_a hit the goal');
}

// --- summariseProgress: missing-piece passthrough ------------------------
{
  // A section references a piece that isn't in the pieces list. The
  // per-piece bucket should still appear (so the stats are complete) with
  // the placeholder title.
  const out = mod.summariseProgress({
    sections: [
      { id: 's_orphan', pieceId: 'p_missing', addedAt: 1 },
    ],
    pieces: [],
    practiceDates: [],
    repCountsToday: new Map(),
    todayISO: '2026-04-29',
  });
  assert.equal(out.sectionsTotal, 1);
  assert.equal(out.perPiece.length, 1);
  assert.equal(out.perPiece[0].pieceId, 'p_missing');
  assert.equal(out.perPiece[0].title, '(unknown piece)');
}

// --- summariseProgress: custom rep goal ----------------------------------
{
  // A section at 5/5 with a custom rep goal of 5 should count as done.
  const out = mod.summariseProgress({
    sections: [
      { id: 's_a', pieceId: 'p_a', addedAt: 1 },
      { id: 's_b', pieceId: 'p_a', addedAt: 2 },
    ],
    pieces: [{ id: 'p_a', title: 'A' }],
    practiceDates: [],
    repCountsToday: new Map([['s_a', 5], ['s_b', 4]]),
    todayISO: '2026-04-29',
    repGoal: 5,
  });
  assert.equal(out.todayDoneCount, 1);
  assert.equal(out.sectionsTotal, 2);

  // A bogus repGoal falls back to 10.
  const fallback = mod.summariseProgress({
    sections: [
      { id: 's_a', pieceId: 'p_a', addedAt: 1 },
    ],
    pieces: [{ id: 'p_a', title: 'A' }],
    practiceDates: [],
    repCountsToday: new Map([['s_a', 10]]),
    todayISO: '2026-04-29',
    repGoal: -3,
  });
  assert.equal(fallback.todayDoneCount, 1);
}

// --- summariseProgress: sort order tie-break -----------------------------
{
  // Two pieces both at 0% mastered → sort by title alphabetically.
  const out = mod.summariseProgress({
    sections: [
      { id: 's_1', pieceId: 'p_b', addedAt: 1 },
      { id: 's_2', pieceId: 'p_a', addedAt: 2 },
    ],
    pieces: [
      { id: 'p_b', title: 'Banana' },
      { id: 'p_a', title: 'Apple' },
    ],
    practiceDates: [],
    repCountsToday: new Map(),
    todayISO: '2026-04-29',
  });
  assert.equal(out.perPiece[0].title, 'Apple');
  assert.equal(out.perPiece[1].title, 'Banana');
}

// --- summariseProgress: malformed sections silently dropped --------------
{
  const out = mod.summariseProgress({
    sections: [
      null,
      undefined,
      'not an object',
      { id: 's_real', pieceId: 'p_a', addedAt: 1 },
    ],
    pieces: [{ id: 'p_a', title: 'A' }],
    practiceDates: [],
    repCountsToday: new Map(),
    todayISO: '2026-04-29',
  });
  assert.equal(out.sectionsTotal, 1, 'only the well-formed section counts');
}

// --- exported surface check ---------------------------------------------
{
  const expected = [
    'MASTERY_INTERVAL_DAYS',
    'isSectionMastered',
    'computeDailyStreak',
    'summariseProgress',
  ];
  for (const name of expected) {
    assert.ok(name in mod, `srs.js exports ${name}`);
  }
}

console.log('stats helpers: all assertions passed');
