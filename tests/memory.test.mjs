// Tests for the pure memory-mode (cue-fading) helpers in srs.js.
//
// Run from the project root:
//   node tests/memory.test.mjs

import assert from 'node:assert/strict';

const mod = await import('../srs.js');
const {
  MEMORY_MAX_STAGE,
  memoryBaselineStage,
  effectiveMemoryStage,
  describeMemoryStage,
} = mod;

assert.equal(MEMORY_MAX_STAGE, 3, 'four stages: 0..3');

// --- memoryBaselineStage: derived from repetitions, clamped 0..3 ----------
{
  assert.equal(memoryBaselineStage(null), 0, 'null section → Watch');
  assert.equal(memoryBaselineStage({}), 0, 'unrated section → Watch');
  assert.equal(memoryBaselineStage({ repetitions: 0 }), 0);
  assert.equal(memoryBaselineStage({ repetitions: 1 }), 1);
  assert.equal(memoryBaselineStage({ repetitions: 2 }), 2);
  assert.equal(memoryBaselineStage({ repetitions: 3 }), 3, 'reps 3 → From memory');
  assert.equal(memoryBaselineStage({ repetitions: 9 }), 3, 'clamped at max');
}

// --- effectiveMemoryStage: baseline + within-session ramp - assist --------
{
  // Brand-new section (base 0): ramps +0,+0,+0,+1,+1,+1,+2,+2,+2,+3 over runs.
  const ramp = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((i) =>
    effectiveMemoryStage(0, i, 0),
  );
  assert.deepEqual(ramp, [0, 0, 0, 1, 1, 1, 2, 2, 2, 3],
    'new section ramps to From-memory by the 10th run');

  // Mature section (base 3): always From memory, ramp clamps.
  assert.equal(effectiveMemoryStage(3, 0, 0), 3);
  assert.equal(effectiveMemoryStage(3, 9, 0), 3);

  // Mid maturity (base 1): starts at Find, reaches max partway.
  assert.equal(effectiveMemoryStage(1, 0, 0), 1);
  assert.equal(effectiveMemoryStage(1, 6, 0), 3, 'base 1 + ramp 2 = 3');

  // Assist pulls the stage back toward more help, floored at 0.
  assert.equal(effectiveMemoryStage(3, 9, 1), 2, 'one assist notch → easier');
  assert.equal(effectiveMemoryStage(3, 9, 3), 0, 'lots of assist → Watch');
  assert.equal(effectiveMemoryStage(0, 0, 5), 0, 'never below 0');

  // Defensive: bad inputs don't blow up.
  assert.equal(effectiveMemoryStage(0, -2, 0), 0);
  assert.equal(effectiveMemoryStage(NaN, NaN, NaN), 0);
}

// --- describeMemoryStage --------------------------------------------------
{
  assert.deepEqual(describeMemoryStage(0),
    { stage: 0, total: 3, key: 'watch', label: 'Watch', hint: 'Full notes + key guides' });
  assert.equal(describeMemoryStage(3).label, 'From memory');
  assert.equal(describeMemoryStage(99).key, 'memory', 'clamps out-of-range');
  assert.equal(describeMemoryStage(-1).key, 'watch');
}

console.log('memory helpers: all assertions passed');
