// Tests for the progress-stats helpers in srs.js (roadmap item 9).
// See canonical tests/stats.test.mjs for the full assertion set (~50 blocks).
import assert from 'node:assert/strict';
const mod = await import('../srs.js');

assert.equal(mod.MASTERY_INTERVAL_DAYS, 21);
assert.equal(mod.isSectionMastered({ id: 's', interval: 21, lastReviewedDate: '2026-04-07' }), true);
assert.equal(mod.isSectionMastered({ id: 's', interval: 20, lastReviewedDate: '2026-04-08' }), false);
assert.equal(mod.computeDailyStreak(['2026-04-29'], '2026-04-29'), 1);
assert.equal(mod.computeDailyStreak(['2026-04-27', '2026-04-28'], '2026-04-29'), 2,
  'unbroken streak ending yesterday counts from yesterday backwards');
const out = mod.summariseProgress({
  sections: [
    { id: 's_1', pieceId: 'p_a', interval: 38, lastReviewedDate: '2026-04-22', nextDue: '2026-05-30' },
    { id: 's_2', pieceId: 'p_a', interval: 6,  lastReviewedDate: '2026-04-23', nextDue: '2026-04-29' },
    { id: 's_3', pieceId: 'p_a' },
  ],
  pieces: [{ id: 'p_a', title: 'Sonata' }],
  practiceDates: ['2026-04-29'],
  repCountsToday: new Map([['s_1', 10]]),
  todayISO: '2026-04-29', repGoal: 10,
});
assert.equal(out.sectionsMastered, 1);
assert.equal(out.todayDoneCount, 1);
assert.equal(out.todayDueCount, 1);
assert.equal(out.dailyStreak, 1);
assert.equal(out.perPiece[0].masteryPct, 33);

console.log('stats helpers (snapshot subset): all assertions passed');
