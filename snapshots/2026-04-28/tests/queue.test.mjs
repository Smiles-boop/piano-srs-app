// Tests for buildReviewQueue (the daily-review-queue helper in srs.js).
// Pure function — no IDB, no DOM. Run from the project root:
//   node tests/queue.test.mjs

import assert from 'node:assert/strict';

const mod = await import('../srs.js');

// Helper to build a section quickly. Sections that have never been rated
// don't carry SRS fields — we only set them when the test calls for it.
function mkSection(id, pieceId, name, opts = {}) {
  return {
    id,
    pieceId,
    name,
    pageNumber: opts.pageNumber || 1,
    measures: opts.measures || '',
    addedAt: opts.addedAt || 0,
    order: opts.order || 0,
    ...(opts.nextDue ? { nextDue: opts.nextDue } : {}),
    ...(opts.repetitions !== undefined ? { repetitions: opts.repetitions } : {}),
    ...(opts.interval !== undefined ? { interval: opts.interval } : {}),
    ...(opts.ease !== undefined ? { ease: opts.ease } : {}),
    ...(opts.lastReviewedDate
      ? { lastReviewedDate: opts.lastReviewedDate }
      : {}),
  };
}

const today = '2026-04-28';
const piecesArr = [
  { id: 'pA', title: 'A — Aria' },
  { id: 'pB', title: 'B — Ballade' },
  { id: 'pC', title: 'C — Caprice' },
];

// --- empty inputs ---------------------------------------------------------
{
  const q = mod.buildReviewQueue({
    sections: [],
    piecesById: piecesArr,
    repCountsToday: new Map(),
    todayISO: today,
  });
  assert.deepEqual(q, [], 'empty sections → empty queue');
}

{
  const q = mod.buildReviewQueue({
    sections: undefined,
    piecesById: piecesArr,
    repCountsToday: new Map(),
    todayISO: today,
  });
  assert.deepEqual(q, [], 'undefined sections → empty queue');
}

// --- bad todayISO throws ---------------------------------------------------
{
  assert.throws(
    () =>
      mod.buildReviewQueue({
        sections: [],
        piecesById: piecesArr,
        repCountsToday: new Map(),
        todayISO: 'not-a-date',
      }),
    /invalid todayISO/,
    'bogus todayISO throws',
  );
}

// --- unscheduled sections are excluded -------------------------------------
{
  const q = mod.buildReviewQueue({
    sections: [
      mkSection('s1', 'pA', 'never rated'),
      mkSection('s2', 'pA', 'also never rated'),
    ],
    piecesById: piecesArr,
    repCountsToday: new Map(),
    todayISO: today,
  });
  assert.deepEqual(q, [], 'sections without nextDue never appear in the queue');
}

// --- only future-due sections are excluded --------------------------------
{
  const q = mod.buildReviewQueue({
    sections: [
      mkSection('s1', 'pA', 'far future', { nextDue: '2026-05-15' }),
      mkSection('s2', 'pA', 'tomorrow', { nextDue: '2026-04-29' }),
    ],
    piecesById: piecesArr,
    repCountsToday: new Map(),
    todayISO: today,
  });
  assert.deepEqual(q, [], 'sections due strictly in the future are excluded');
}

// --- due-today and overdue sections are included --------------------------
{
  const q = mod.buildReviewQueue({
    sections: [
      mkSection('s1', 'pA', 'due today', { nextDue: today, addedAt: 1 }),
      mkSection('s2', 'pA', 'one day overdue', {
        nextDue: '2026-04-27',
        addedAt: 2,
      }),
      mkSection('s3', 'pA', 'three days overdue', {
        nextDue: '2026-04-25',
        addedAt: 3,
      }),
    ],
    piecesById: piecesArr,
    repCountsToday: new Map(),
    todayISO: today,
  });
  assert.equal(q.length, 3, 'all three sections appear in the queue');
  assert.equal(q[0].section.id, 's3', 'most-overdue section sorts first');
  assert.equal(q[0].daysOff, -3);
  assert.equal(q[1].section.id, 's2', 'one-day-overdue section sorts second');
  assert.equal(q[1].daysOff, -1);
  assert.equal(q[2].section.id, 's1', 'due-today section sorts last');
  assert.equal(q[2].daysOff, 0);
}

// --- sections that have already met the goal today drop off ---------------
{
  const counts = new Map();
  counts.set('s1', 10); // hit the goal
  counts.set('s2', 11); // past the goal (defensive)
  counts.set('s3', 9); // not quite

  const q = mod.buildReviewQueue({
    sections: [
      mkSection('s1', 'pA', 'done', { nextDue: today, addedAt: 1 }),
      mkSection('s2', 'pA', 'over-done', { nextDue: today, addedAt: 2 }),
      mkSection('s3', 'pA', 'partial', { nextDue: today, addedAt: 3 }),
    ],
    piecesById: piecesArr,
    repCountsToday: counts,
    todayISO: today,
  });

  assert.equal(q.length, 1, 'only the partial section remains');
  assert.equal(q[0].section.id, 's3');
  assert.equal(q[0].repCount, 9, 'partial count surfaces on the queue item');
}

// --- custom repGoal honors the override -----------------------------------
{
  const counts = new Map();
  counts.set('s1', 5);
  counts.set('s2', 5);
  const q = mod.buildReviewQueue({
    sections: [
      mkSection('s1', 'pA', 'done at goal=5', { nextDue: today, addedAt: 1 }),
      mkSection('s2', 'pA', 'done at goal=10', { nextDue: today, addedAt: 2 }),
    ],
    piecesById: piecesArr,
    repCountsToday: counts,
    todayISO: today,
    repGoal: 5,
  });
  assert.equal(q.length, 0, 'goal override = 5 means both sections are done');
}

// --- piece title attaches to each queue item ------------------------------
{
  const q = mod.buildReviewQueue({
    sections: [
      mkSection('s1', 'pA', 'a section', { nextDue: today, addedAt: 1 }),
    ],
    piecesById: piecesArr,
    repCountsToday: new Map(),
    todayISO: today,
  });
  assert.equal(q[0].piece.id, 'pA');
  assert.equal(q[0].piece.title, 'A — Aria');
}

// --- piecesById accepts a Map -----------------------------------------
{
  const piecesMap = new Map();
  piecesMap.set('pA', { id: 'pA', title: 'A — Aria' });
  const q = mod.buildReviewQueue({
    sections: [
      mkSection('s1', 'pA', 'a section', { nextDue: today, addedAt: 1 }),
    ],
    piecesById: piecesMap,
    repCountsToday: new Map(),
    todayISO: today,
  });
  assert.equal(q[0].piece.title, 'A — Aria', 'Map shape works for piecesById');
}

// --- piecesById accepts a plain object --------------------------------
{
  const piecesObj = { pA: { id: 'pA', title: 'A — Aria' } };
  const q = mod.buildReviewQueue({
    sections: [
      mkSection('s1', 'pA', 'a section', { nextDue: today, addedAt: 1 }),
    ],
    piecesById: piecesObj,
    repCountsToday: new Map(),
    todayISO: today,
  });
  assert.equal(q[0].piece.title, 'A — Aria', 'object shape works for piecesById');
}

// --- missing piece falls back to a placeholder ----------------------------
{
  const q = mod.buildReviewQueue({
    sections: [
      mkSection('orphan', 'pZ', 'orphaned section', {
        nextDue: today,
        addedAt: 1,
      }),
    ],
    piecesById: piecesArr, // pZ isn't in the array
    repCountsToday: new Map(),
    todayISO: today,
  });
  assert.equal(q.length, 1);
  assert.equal(q[0].piece.id, 'pZ');
  assert.equal(
    q[0].piece.title,
    '(unknown piece)',
    'unknown pieces get a placeholder title rather than dropping off',
  );
}

// --- repCountsToday accepts a plain object too ----------------------------
{
  const q = mod.buildReviewQueue({
    sections: [
      mkSection('s1', 'pA', 'object counts', { nextDue: today, addedAt: 1 }),
    ],
    piecesById: piecesArr,
    repCountsToday: { s1: 4 },
    todayISO: today,
  });
  assert.equal(q.length, 1, 'object-shaped counts work');
  assert.equal(q[0].repCount, 4);
}

// --- mixed scenario: realistic library snapshot ---------------------------
{
  const sections = [
    mkSection('done-today', 'pA', 'Done already', {
      nextDue: today,
      addedAt: 1,
    }),
    mkSection('overdue-2', 'pB', 'Two days overdue', {
      nextDue: '2026-04-26',
      addedAt: 2,
    }),
    mkSection('due-today-A', 'pA', 'Due today (A)', {
      nextDue: today,
      addedAt: 3,
    }),
    mkSection('due-today-B', 'pB', 'Due today (B)', {
      nextDue: today,
      addedAt: 4,
    }),
    mkSection('future', 'pC', 'Future', {
      nextDue: '2026-06-01',
      addedAt: 5,
    }),
    mkSection('never-rated', 'pC', 'Never rated', { addedAt: 6 }),
  ];
  const counts = new Map();
  counts.set('done-today', 10);
  counts.set('due-today-A', 3); // partial — should still appear

  const q = mod.buildReviewQueue({
    sections,
    piecesById: piecesArr,
    repCountsToday: counts,
    todayISO: today,
  });

  assert.equal(q.length, 3, 'queue has overdue + 2 due-today (one of which is partial)');
  assert.equal(q[0].section.id, 'overdue-2', 'most-overdue first');
  // The two due-today sections tie on nextDue; they break ties by piece title.
  // pA (Aria) < pB (Ballade) → due-today-A comes before due-today-B.
  assert.equal(q[1].section.id, 'due-today-A', 'piece title alphabetical breaks the tie');
  assert.equal(q[2].section.id, 'due-today-B');
}

// --- ties broken by addedAt within the same piece -------------------------
{
  const sections = [
    mkSection('newer', 'pA', 'Newer', { nextDue: today, addedAt: 200 }),
    mkSection('older', 'pA', 'Older', { nextDue: today, addedAt: 100 }),
  ];
  const q = mod.buildReviewQueue({
    sections,
    piecesById: piecesArr,
    repCountsToday: new Map(),
    todayISO: today,
  });
  assert.equal(q[0].section.id, 'older', 'lower addedAt wins the final tie-break');
  assert.equal(q[1].section.id, 'newer');
}

// --- malformed sections don't crash the queue -----------------------------
{
  const sections = [
    null,
    undefined,
    {}, // no id, no nextDue → just dropped
    mkSection('ok', 'pA', 'ok', { nextDue: today, addedAt: 1 }),
    { ...mkSection('bad-date', 'pA', 'bad date', { addedAt: 2 }), nextDue: 'not-a-date' },
  ];
  const q = mod.buildReviewQueue({
    sections,
    piecesById: piecesArr,
    repCountsToday: new Map(),
    todayISO: today,
  });
  assert.equal(q.length, 1, 'malformed sections are silently dropped');
  assert.equal(q[0].section.id, 'ok');
}

// --- repCount surfaces correctly when present -----------------------------
{
  const counts = new Map();
  counts.set('s1', 7);
  const q = mod.buildReviewQueue({
    sections: [
      mkSection('s1', 'pA', 'partial today', { nextDue: today, addedAt: 1 }),
    ],
    piecesById: piecesArr,
    repCountsToday: counts,
    todayISO: today,
  });
  assert.equal(q[0].repCount, 7);
  assert.equal(q[0].daysOff, 0);
  assert.equal(q[0].nextDue, today);
}

// --- exported from srs.js ------------------------------------------------
{
  assert.equal(typeof mod.buildReviewQueue, 'function', 'buildReviewQueue is exported');
}

console.log('queue helpers: all assertions passed');
