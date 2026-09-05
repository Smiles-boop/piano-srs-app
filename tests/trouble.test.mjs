/* tests/trouble.test.mjs — clustering recorded mistakes into trouble spots
 * and turning those into drillable ranges. */

import assert from 'node:assert/strict';

const mod = await import('../trouble.js');
const {
  TROUBLE_MIN_COUNT,
  clusterMistakes,
  troubleDrillRange,
  mistakesInSection,
  troubleSpots,
  troubleHeat,
} = mod;

const TPQ = 480;
const m = (tick, count) => ({ tick, count });
/** A note every eighth from tick 0 up to (but not including) `until`. */
const evenNotes = (until, step = TPQ / 2) => {
  const out = [];
  for (let t = 0; t < until; t += step) out.push({ startTick: t, endTick: t + step, midi: 60 });
  return out;
};

/* -- Clustering ---------------------------------------------------------- */

// Mistakes within 2 quarters merge; a wider gap starts a new spot.
{
  const spots = clusterMistakes(
    [m(0, 2), m(240, 3), m(9600, 7)],
    { ticksPerQuarter: TPQ },
  );
  assert.equal(spots.length, 2);
  // Worst-first: the lone 7 outranks the 2+3 pair.
  assert.equal(spots[0].count, 7);
  assert.equal(spots[0].startTick, 9600);
  assert.equal(spots[1].count, 5);
  assert.equal(spots[1].startTick, 0);
  assert.equal(spots[1].endTick, 240);
  assert.deepEqual(spots[1].ticks, [0, 240]);
}

// Equal-severity spots fall back to earliest-first, so the order is stable.
{
  const spots = clusterMistakes([m(0, 5), m(9600, 5)], { ticksPerQuarter: TPQ });
  assert.deepEqual(spots.map((s) => s.startTick), [0, 9600]);
}

// A long messy passage stays ONE spot: each mistake is within the gap of the
// previous one, so the cluster extends rather than fragmenting.
{
  const chain = [0, 480, 960, 1440, 1920].map((t) => m(t, 1));
  const spots = clusterMistakes(chain, { ticksPerQuarter: TPQ });
  assert.equal(spots.length, 1);
  assert.equal(spots[0].startTick, 0);
  assert.equal(spots[0].endTick, 1920);
  assert.equal(spots[0].count, 5);
}

// peakTick points at the single worst tick, not the cluster's midpoint.
{
  const [spot] = clusterMistakes([m(0, 1), m(240, 9), m(480, 2)], { ticksPerQuarter: TPQ });
  assert.equal(spot.peakTick, 240);
  assert.equal(spot.count, 12);
  assert.equal('peak' in spot, false, 'internal bookkeeping should not leak');
}

// One-off slips are below the threshold and dropped.
{
  assert.deepEqual(clusterMistakes([m(0, 1)], { ticksPerQuarter: TPQ }), []);
  assert.deepEqual(clusterMistakes([m(0, 2)], { ticksPerQuarter: TPQ }), []);
  assert.equal(clusterMistakes([m(0, TROUBLE_MIN_COUNT)], { ticksPerQuarter: TPQ }).length, 1);
  // ...unless the caller lowers the bar.
  assert.equal(clusterMistakes([m(0, 1)], { ticksPerQuarter: TPQ, minCount: 1 }).length, 1);
}

// Junk in, empty out.
assert.deepEqual(clusterMistakes(null), []);
assert.deepEqual(clusterMistakes([]), []);
assert.deepEqual(clusterMistakes([{ tick: NaN, count: 5 }, { tick: 0, count: 0 }]), []);

// Unsorted input still clusters correctly.
{
  const spots = clusterMistakes([m(9600, 5), m(240, 3), m(0, 2)], { ticksPerQuarter: TPQ });
  assert.equal(spots.length, 2);
  assert.equal(spots.find((s) => s.startTick === 0).endTick, 240);
}

/* -- Drill ranges -------------------------------------------------------- */

// A spot mid-piece gets context either side, snapped to real onsets.
{
  const notes = evenNotes(9600);
  const range = troubleDrillRange(
    { startTick: 4800, endTick: 4800 }, notes, { ticksPerQuarter: TPQ },
  );
  // 2 quarters of context each way → [3840, 5760], end exclusive.
  assert.equal(range.startTick, 3840);
  assert.equal(range.endTick, 5761);
  assert.equal(range.noteCount, 9);
  // The range must actually contain the spot.
  assert.ok(range.startTick <= 4800 && 4800 < range.endTick);
}

// A spot at the very start clamps to the first note rather than going negative.
{
  const range = troubleDrillRange(
    { startTick: 0, endTick: 0 }, evenNotes(9600), { ticksPerQuarter: TPQ },
  );
  assert.equal(range.startTick, 0);
  assert.ok(range.noteCount >= 4);
}

// A sparse passage widens its context until the drill holds enough notes.
{
  // Notes every 4 quarters — the default ±2q window would catch only one.
  const sparse = evenNotes(9600 * 4, TPQ * 4);
  const range = troubleDrillRange(
    { startTick: TPQ * 20, endTick: TPQ * 20 }, sparse, { ticksPerQuarter: TPQ },
  );
  assert.ok(range, 'should widen rather than give up');
  assert.ok(range.noteCount >= 4, `expected ≥4 notes, got ${range.noteCount}`);
}

// No notes anywhere → nothing to drill.
assert.equal(troubleDrillRange({ startTick: 0, endTick: 0 }, [], { ticksPerQuarter: TPQ }), null);
assert.equal(troubleDrillRange(null, evenNotes(960)), null);

// A piece too short to reach the minimum still yields its whole self.
{
  const tiny = [{ startTick: 0, endTick: 240 }, { startTick: 240, endTick: 480 }];
  const range = troubleDrillRange({ startTick: 0, endTick: 0 }, tiny, { ticksPerQuarter: TPQ });
  assert.ok(range && range.noteCount === 2, 'short piece drills as a whole');
}

/* -- Section tallies ----------------------------------------------------- */
{
  const recs = [m(0, 2), m(500, 3), m(1000, 4)];
  assert.equal(mistakesInSection(recs, { startTick: 0, endTick: 1000 }), 5, 'end is exclusive');
  assert.equal(mistakesInSection(recs, { startTick: 1000, endTick: 2000 }), 4);
  assert.equal(mistakesInSection(recs, { startTick: 2000, endTick: 3000 }), 0);
  assert.equal(mistakesInSection(null, { startTick: 0, endTick: 10 }), 0);
  assert.equal(mistakesInSection(recs, null), 0);
}

/* -- Full pipeline ------------------------------------------------------- */
{
  const notes = evenNotes(19200);
  const spots = troubleSpots(
    [m(2400, 6), m(2640, 2), m(12000, 4), m(50, 1)],
    notes,
    { ticksPerQuarter: TPQ },
  );
  assert.equal(spots.length, 2, 'the single stray slip is below threshold');
  assert.equal(spots[0].count, 8);
  // Each spot carries a usable range.
  for (const s of spots) {
    assert.ok(s.endTick > s.startTick);
    assert.ok(s.noteCount >= 4);
    assert.ok(s.startTick <= s.peakTick && s.peakTick < s.endTick);
  }
  // maxSpots caps the output.
  assert.equal(
    troubleSpots([m(2400, 6), m(12000, 4)], notes, { ticksPerQuarter: TPQ, maxSpots: 1 }).length,
    1,
  );
}

assert.deepEqual(troubleSpots([], evenNotes(960)), []);
assert.deepEqual(troubleSpots([m(0, 9)], []), [], 'no notes → no drillable spot');

/* -- Heat banding -------------------------------------------------------- */
assert.equal(troubleHeat(10, 10), 'high');
assert.equal(troubleHeat(7, 10), 'high');
assert.equal(troubleHeat(5, 10), 'medium');
assert.equal(troubleHeat(2, 10), 'low');
assert.equal(troubleHeat(5, 0), 'low', 'no max → no crash');

console.log('trouble.test.mjs: all assertions passed');
