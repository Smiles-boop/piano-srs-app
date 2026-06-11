// Tests for the pure memory-mode (cue-fading) helpers in srs.js.
//
// Run from the project root:
//   node tests/memory.test.mjs

import assert from 'node:assert/strict';

const mod = await import('../srs.js');
const {
  MEMORY_MAX_STAGE,
  clozeFractionForStage,
  memoryBaselineStage,
  effectiveMemoryStage,
  describeMemoryStage,
} = mod;

assert.equal(MEMORY_MAX_STAGE, 5, 'six stages: 0..5');

// --- memoryBaselineStage: derived from repetitions, clamped 0..5 ----------
{
  assert.equal(memoryBaselineStage(null), 0, 'null section → Watch');
  assert.equal(memoryBaselineStage({}), 0, 'unrated section → Watch');
  assert.equal(memoryBaselineStage({ repetitions: 0 }), 0);
  assert.equal(memoryBaselineStage({ repetitions: 1 }), 1);
  assert.equal(memoryBaselineStage({ repetitions: 2 }), 2);
  assert.equal(memoryBaselineStage({ repetitions: 3 }), 3, 'reps 3 → Recall 40%');
  assert.equal(memoryBaselineStage({ repetitions: 4 }), 4, 'reps 4 → Recall 75%');
  assert.equal(memoryBaselineStage({ repetitions: 5 }), 5, 'reps 5 → From memory');
  assert.equal(memoryBaselineStage({ repetitions: 9 }), 5, 'clamped at max');
}

// --- clozeFractionForStage: how much of the note stream is hidden ----------
{
  assert.equal(clozeFractionForStage(0), 0, 'Watch hides nothing');
  assert.equal(clozeFractionForStage(1), 0, 'Find hides nothing');
  assert.equal(clozeFractionForStage(2), 0, 'Glance gates by time, not cloze');
  assert.equal(clozeFractionForStage(3), 0.4);
  assert.equal(clozeFractionForStage(4), 0.75);
  assert.equal(clozeFractionForStage(5), 1, 'From memory hides everything');
  assert.equal(clozeFractionForStage(99), 1, 'clamps out-of-range');
  assert.equal(clozeFractionForStage(-1), 0);
}

// --- effectiveMemoryStage: baseline + within-session ramp - assist --------
{
  // Brand-new section (base 0): +1 stage every 3 clean runs.
  const ramp = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((i) =>
    effectiveMemoryStage(0, i, 0),
  );
  assert.deepEqual(ramp, [0, 0, 0, 1, 1, 1, 2, 2, 2, 3],
    'new section reaches the first cloze stage by the 10th run');

  // Mature section (base 5): always From memory, ramp clamps.
  assert.equal(effectiveMemoryStage(5, 0, 0), 5);
  assert.equal(effectiveMemoryStage(5, 9, 0), 5);

  // Mid maturity (base 3, Recall 40%): ramps through Recall 75% to memory.
  assert.equal(effectiveMemoryStage(3, 0, 0), 3);
  assert.equal(effectiveMemoryStage(3, 3, 0), 4, 'base 3 + ramp 1 = Recall 75%');
  assert.equal(effectiveMemoryStage(3, 6, 0), 5, 'base 3 + ramp 2 = From memory');

  // Assist pulls the stage back toward more help, floored at 0.
  assert.equal(effectiveMemoryStage(5, 9, 1), 4, 'one assist notch → easier');
  assert.equal(effectiveMemoryStage(5, 9, 5), 0, 'lots of assist → Watch');
  assert.equal(effectiveMemoryStage(0, 0, 5), 0, 'never below 0');

  // Defensive: bad inputs don't blow up.
  assert.equal(effectiveMemoryStage(0, -2, 0), 0);
  assert.equal(effectiveMemoryStage(NaN, NaN, NaN), 0);
}

// --- describeMemoryStage --------------------------------------------------
{
  assert.deepEqual(describeMemoryStage(0),
    { stage: 0, total: 5, key: 'watch', label: 'Watch', hint: 'Full notes + key guides' });
  assert.equal(describeMemoryStage(3).label, 'Recall 40%');
  assert.equal(describeMemoryStage(4).label, 'Recall 75%');
  assert.equal(describeMemoryStage(5).label, 'From memory');
  assert.equal(describeMemoryStage(99).key, 'memory', 'clamps out-of-range');
  assert.equal(describeMemoryStage(-1).key, 'watch');
}

console.log('memory helpers: all assertions passed');
