// PianoSRS — Tempo-goal helpers.
//
// The practice loop is a self-paced wait-mode trainer: you advance the falling
// notes by playing them, so there is no tempo the engine enforces. The
// metronome is the honest tempo reference — when you complete a clean run with
// it running, the metronome's BPM is the tempo you (self-reportedly) played at.
//
// Tempo goals layer onto that: each section can carry an optional
//   - `targetTempo`     the BPM you're working up to (user-set), and
//   - `bestCleanTempo`  the fastest BPM you've ever completed a clean run at
//                       (auto-tracked when the metronome is running), and
//   - `workingTempo`    the BPM you last practised this section at, so the
//                       metronome restores it when you reopen the section.
//
// All helpers here are pure (no DOM, no audio, no clock reads) so the tempo
// math is unit-testable in isolation. BPM bounds mirror the metronome's.

/** Tempo bounds — kept in lockstep with metronome.js (MIN_BPM / MAX_BPM). */
const TEMPO_MIN = 30;
const TEMPO_MAX = 300;
/** Default notch the "bump" control raises the working tempo by. */
const TEMPO_STEP = 5;

/**
 * Coerce a value to a whole-number BPM inside [TEMPO_MIN, TEMPO_MAX], or null
 * if it isn't a usable number. Pure.
 */
function clampTempo(n) {
  const v = Math.round(Number(n));
  // Non-finite or non-positive (incl. null/'' which coerce to 0) means
  // "absent" — return null rather than clamping a 0 up to the minimum.
  if (!Number.isFinite(v) || v <= 0) return null;
  if (v < TEMPO_MIN) return TEMPO_MIN;
  if (v > TEMPO_MAX) return TEMPO_MAX;
  return v;
}

/** True when `n` is a usable BPM (finite and within bounds after rounding). */
function isValidTempo(n) {
  const v = Math.round(Number(n));
  return Number.isFinite(v) && v >= TEMPO_MIN && v <= TEMPO_MAX;
}

/**
 * A clean run has reached the goal once its best clean tempo is at or past the
 * target. Pure. Returns false if either value is missing/invalid.
 */
function tempoGoalReached(bestClean, target) {
  const b = clampTempo(bestClean);
  const t = clampTempo(target);
  if (b === null || t === null) return false;
  return b >= t;
}

/**
 * Progress toward the tempo goal as an integer 0–100 (best / target, capped).
 * A missing/invalid target yields 0; a missing best is treated as 0 BPM. Pure.
 */
function tempoGoalProgressPct(bestClean, target) {
  const t = clampTempo(target);
  if (t === null || t <= 0) return 0;
  const b = clampTempo(bestClean) || 0;
  const pct = Math.round((b / t) * 100);
  return Math.max(0, Math.min(100, pct));
}

/**
 * The next working tempo when the user "bumps" toward the goal: raise `current`
 * by `step`, never overshooting `target`, clamped to the BPM bounds. If the
 * user is already at/past the target, the target is returned. Pure.
 */
function nextWorkingTempo(current, target, step = TEMPO_STEP) {
  const t = clampTempo(target);
  const c = clampTempo(current);
  const s = Number.isFinite(Number(step)) && Number(step) > 0 ? Math.round(Number(step)) : TEMPO_STEP;
  if (c === null) return t === null ? TEMPO_MIN : t;
  if (t === null) return clampTempo(c + s);
  if (c >= t) return t;
  return Math.min(t, clampTempo(c + s));
}

/**
 * A sensible starting tempo when a goal is first set: ~60% of the target,
 * snapped down to a multiple of TEMPO_STEP, floored at TEMPO_MIN. Lets the UI
 * suggest a slow practice tempo to ramp up from. Pure.
 */
function suggestStartTempo(target) {
  const t = clampTempo(target);
  if (t === null) return TEMPO_MIN;
  const raw = Math.max(TEMPO_MIN, Math.floor((t * 0.6) / TEMPO_STEP) * TEMPO_STEP);
  return clampTempo(raw);
}

/**
 * Roll a section's tempo fields into a render-ready summary. Pure — the UI
 * reads everything it needs off this rather than recomputing inline.
 *
 * @param {{targetTempo?:number, bestCleanTempo?:number, workingTempo?:number}} section
 * @returns {{
 *   hasGoal: boolean,
 *   target: number|null,
 *   best: number,           // 0 when never achieved
 *   working: number|null,
 *   pct: number,            // 0–100
 *   reached: boolean,
 *   remaining: number,      // BPM still to gain (0 once reached / no goal)
 * }}
 */
function tempoGoalSummary(section) {
  const s = section && typeof section === 'object' ? section : {};
  const target = clampTempo(s.targetTempo);
  const best = clampTempo(s.bestCleanTempo) || 0;
  const working = clampTempo(s.workingTempo);
  const hasGoal = target !== null;
  const reached = hasGoal && best >= target;
  return {
    hasGoal,
    target,
    best,
    working,
    pct: tempoGoalProgressPct(best, target),
    reached,
    remaining: hasGoal ? Math.max(0, target - best) : 0,
  };
}

// ---- Node export shim (browser-safe) ------------------------------------
// Plain globals in the browser (classic <script>); importable under Node so
// the test suite can exercise the pure helpers. `module` is undefined in the
// browser, so this is skipped there with no error.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
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
  };
}
