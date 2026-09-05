// Tests for the timed-session planner in srs.js
// (estimateSectionSessionMs + buildSessionPlan).
//
// Run from the project root:
//   node tests/session-plan.test.mjs

import assert from 'node:assert/strict';

const mod = await import('../srs.js');
const { estimateSectionSessionMs, buildSessionPlan } = mod;

const TODAY = '2026-07-13';

// --- estimateSectionSessionMs ---------------------------------------------

// No history → flat defaults, new sections cost more than reviews.
assert.equal(
  estimateSectionSessionMs({}, { isNew: false }),
  mod.SESSION_DEFAULT_REVIEW_MS,
);
assert.equal(
  estimateSectionSessionMs({}, { isNew: true }),
  mod.SESSION_DEFAULT_NEW_MS,
);
assert.ok(mod.SESSION_DEFAULT_NEW_MS > mod.SESSION_DEFAULT_REVIEW_MS);

// History → avg ms/rep × goal. 30 reps in 15 min → 30s/rep → 10 reps = 5 min.
assert.equal(
  estimateSectionSessionMs(
    { totalPracticeMs: 15 * 60000 },
    { repGoal: 10, lifetimeReps: 30 },
  ),
  5 * 60000,
);

// Per-rep clamp: absurdly slow history (timer left running) is capped at
// 2 min/rep → 20 min for a 10-rep goal.
assert.equal(
  estimateSectionSessionMs(
    { totalPracticeMs: 100 * 3600000 },
    { repGoal: 10, lifetimeReps: 10 },
  ),
  20 * 60000,
);

// Per-rep floor: click-through reps can't shrink a session below 90s.
assert.equal(
  estimateSectionSessionMs(
    { totalPracticeMs: 10000 },
    { repGoal: 10, lifetimeReps: 100 },
  ),
  90000,
);

// --- buildSessionPlan ------------------------------------------------------

const pieces = new Map([
  ['p1', { id: 'p1', title: 'Nocturne' }],
  ['p2', { id: 'p2', title: 'Gymnopédie' }],
]);

/** A due review section (rated before, nextDue in the past/today). */
function dueSection(id, pieceId, nextDue, extra = {}) {
  return {
    id,
    pieceId,
    name: `sec ${id}`,
    repetitions: 2,
    interval: 6,
    ease: 2.5,
    nextDue,
    lastReviewedDate: '2026-07-01',
    addedAt: 1,
    ...extra,
  };
}

/** A never-rated section (a "learn" candidate). */
function newSection(id, pieceId, extra = {}) {
  return { id, pieceId, name: `sec ${id}`, addedAt: 1, ...extra };
}

// Empty library → empty plan.
{
  const plan = buildSessionPlan({
    sections: [],
    piecesById: pieces,
    repCountsToday: new Map(),
    todayISO: TODAY,
    minutes: 30,
  });
  assert.deepEqual(plan.items, []);
  assert.equal(plan.budgetMs, 30 * 60000);
}

// Reviews first, then new sections, all within budget.
{
  const sections = [
    newSection('n1', 'p2'),
    dueSection('r1', 'p1', TODAY),
    dueSection('r2', 'p1', '2026-07-10'), // overdue → highest priority
    newSection('n2', 'p2'),
  ];
  // Defaults: reviews 4m each, new 6m each → 30m fits r2, r1 (8m) + n1, n2 (12m) = 20m.
  const plan = buildSessionPlan({
    sections,
    piecesById: pieces,
    repCountsToday: new Map(),
    todayISO: TODAY,
    minutes: 30,
  });
  assert.deepEqual(
    plan.items.map((it) => [it.type, it.section.id]),
    [
      ['review', 'r2'], // most overdue first
      ['review', 'r1'],
      ['new', 'n1'],
      ['new', 'n2'],
    ],
  );
  assert.equal(plan.totalMs, (4 + 4 + 6 + 6) * 60000);
  assert.equal(plan.dueTotal, 2);
  assert.equal(plan.dueIncluded, 2);
  assert.equal(plan.newAvailable, 2);
  assert.equal(plan.newIncluded, 2);
  assert.ok(plan.totalMs <= plan.budgetMs);
}

// Tight budget: reviews claim it first; new sections only fill leftovers.
{
  const sections = [
    newSection('n1', 'p2'),
    dueSection('r1', 'p1', TODAY),
    dueSection('r2', 'p1', '2026-07-10'),
  ];
  // 10m budget: r2 (4m) + r1 (4m) = 8m; n1 needs 6m → doesn't fit.
  const plan = buildSessionPlan({
    sections,
    piecesById: pieces,
    repCountsToday: new Map(),
    todayISO: TODAY,
    minutes: 10,
  });
  assert.deepEqual(
    plan.items.map((it) => it.section.id),
    ['r2', 'r1'],
  );
  assert.equal(plan.newIncluded, 0);
  assert.equal(plan.newAvailable, 1);
}

// Budget too small for anything → still returns the single top-priority item.
{
  const sections = [dueSection('r1', 'p1', '2026-07-10'), newSection('n1', 'p2')];
  const plan = buildSessionPlan({
    sections,
    piecesById: pieces,
    repCountsToday: new Map(),
    todayISO: TODAY,
    minutes: 1,
  });
  assert.equal(plan.items.length, 1);
  assert.equal(plan.items[0].section.id, 'r1');
  assert.ok(plan.totalMs > plan.budgetMs, 'single item may overflow the box');
}

// Sections already finished today are excluded (reviews and new alike).
{
  const sections = [
    dueSection('r1', 'p1', TODAY),
    newSection('n1', 'p2'),
    newSection('n2', 'p2'),
  ];
  const plan = buildSessionPlan({
    sections,
    piecesById: pieces,
    repCountsToday: new Map([
      ['r1', 10],
      ['n1', 10],
    ]),
    todayISO: TODAY,
    minutes: 60,
  });
  assert.deepEqual(
    plan.items.map((it) => it.section.id),
    ['n2'],
  );
}

// Sections in rotation but not due yet are neither reviews nor "new".
{
  const sections = [dueSection('r1', 'p1', '2026-08-01')]; // due in the future
  const plan = buildSessionPlan({
    sections,
    piecesById: pieces,
    repCountsToday: new Map(),
    todayISO: TODAY,
    minutes: 60,
  });
  assert.deepEqual(plan.items, []);
  assert.equal(plan.newAvailable, 0);
}

// Lifetime history sharpens estimates: 30s/rep → 5m per review.
{
  const sections = [
    dueSection('r1', 'p1', TODAY, { totalPracticeMs: 10 * 60000 }),
  ];
  const plan = buildSessionPlan({
    sections,
    piecesById: pieces,
    repCountsToday: new Map(),
    lifetimeRepCounts: new Map([['r1', 20]]),
    todayISO: TODAY,
    minutes: 30,
  });
  assert.equal(plan.items[0].estimateMs, 5 * 60000);
}

// orderNewSections hook controls learn order.
{
  const sections = [newSection('n1', 'p2'), newSection('n2', 'p2')];
  const plan = buildSessionPlan({
    sections,
    piecesById: pieces,
    repCountsToday: new Map(),
    todayISO: TODAY,
    minutes: 60,
    orderNewSections: (cands) => cands.slice().reverse(),
  });
  assert.deepEqual(
    plan.items.map((it) => it.section.id),
    ['n2', 'n1'],
  );
}

// Invalid date throws (same contract as the other planners).
assert.throws(() =>
  buildSessionPlan({
    sections: [],
    piecesById: pieces,
    repCountsToday: new Map(),
    todayISO: 'nope',
    minutes: 30,
  }),
);

console.log('All session-plan tests passed.');
