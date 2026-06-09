// PianoSRS — SM-2 spaced-repetition scheduling.
//
// Roadmap item 6 lands here: when a section reaches its daily rep goal, we
// apply the SM-2 algorithm with a default-Good rating (item 8 will replace
// the default with a real "Again / Hard / Good / Easy" prompt) to compute
// the next interval and next-due date. The resulting fields
// (`repetitions`, `interval`, `ease`, `nextDue`, `lastReviewedDate`) are
// persisted onto the section record — they're optional, so legacy section
// records from before item 6 are unchanged on disk until they're rated for
// the first time.
//
// SM-2 reference (Wozniak 1990):
//   EF' = EF + (0.1 - (5 - q) * (0.08 + (5 - q) * 0.02))
//   EF clamped to a floor of 1.3.
//   If q < 3 (lapse): repetitions = 0, interval = 1.
//   If q >= 3:
//     repetitions += 1
//     if repetitions == 1: interval = 1
//     elif repetitions == 2: interval = 6
//     else: interval = ceil(prevInterval * EF)
//
// All helpers in this module are pure: no IDB, no DOM, no `Date.now()` reads
// in the hot path. `applySm2` takes an explicit `todayISO` so unit tests are
// fully deterministic regardless of machine time or timezone. `addDaysISO`
// uses local-component Date arithmetic on YYYY-MM-DD strings — we never read
// a wall-clock time, so DST transitions can't shift the result.

/** Starting ease factor for a brand-new section. */
const EASE_DEFAULT = 2.5;

/** SM-2's hard floor on ease. Below this, intervals collapse and reviews
 * pile up — the floor keeps the schedule recoverable. */
const EASE_MIN = 1.3;

// Quality ratings on SM-2's 0–5 scale. Item 8 wires a real prompt; item 6
// uses RATING_GOOD as the default when a section first hits its rep goal.
const RATING_AGAIN = 0;
const RATING_HARD = 3;
const RATING_GOOD = 4;
const RATING_EASY = 5;

/**
 * Default SRS state for a section that has never been reviewed.
 * `interval: 0` is the sentinel for "never reviewed" — distinct from
 * `interval: 1` ("first review just happened, due tomorrow").
 */
function defaultSrsState() {
  return {
    repetitions: 0,
    interval: 0,
    ease: EASE_DEFAULT,
    nextDue: null,
    lastReviewedDate: null,
  };
}

/**
 * Read the SRS state off a (possibly-old) section record. Sections created
 * before item 6 won't have these fields; we paper over them with defaults so
 * the caller doesn't have to special-case "fresh section vs upgraded section".
 *
 * @param {object|null|undefined} section
 */
function srsStateForSection(section) {
  const d = defaultSrsState();
  if (!section || typeof section !== 'object') return d;
  return {
    repetitions:
      typeof section.repetitions === 'number' && Number.isFinite(section.repetitions)
        ? section.repetitions
        : d.repetitions,
    interval:
      typeof section.interval === 'number' && Number.isFinite(section.interval)
        ? section.interval
        : d.interval,
    ease:
      typeof section.ease === 'number' && Number.isFinite(section.ease)
        ? section.ease
        : d.ease,
    nextDue:
      typeof section.nextDue === 'string' && section.nextDue
        ? section.nextDue
        : d.nextDue,
    lastReviewedDate:
      typeof section.lastReviewedDate === 'string' && section.lastReviewedDate
        ? section.lastReviewedDate
        : d.lastReviewedDate,
  };
}

/**
 * Update ease per SM-2: EF' = EF + (0.1 - (5 - q) * (0.08 + (5 - q) * 0.02)).
 * Clamped at EASE_MIN. Pure.
 *
 * Spot-checks for the curve (starting from EF = 2.5):
 *   q = 0 (Again): EF -= 0.80   →  1.7
 *   q = 3 (Hard):  EF -= 0.14   →  2.36
 *   q = 4 (Good):  EF unchanged →  2.5
 *   q = 5 (Easy):  EF += 0.10   →  2.6
 */
function updateEase(ease, quality) {
  const baseEase =
    typeof ease === 'number' && Number.isFinite(ease) ? ease : EASE_DEFAULT;
  const q = clampQuality(quality);
  const next = baseEase + (0.1 - (5 - q) * (0.08 + (5 - q) * 0.02));
  // Round to 4dp so persisted ease values don't drift in the float-noise
  // last digits across many reviews.
  const rounded = Math.round(next * 10000) / 10000;
  return Math.max(EASE_MIN, rounded);
}

/**
 * Apply the SM-2 algorithm to an existing SRS state given a quality rating.
 * Returns a NEW state object — the input is not mutated. Pure.
 *
 * @param {ReturnType<typeof defaultSrsState>|null|undefined} state
 * @param {number} quality 0–5 (use the RATING_* constants)
 * @param {string} todayISO YYYY-MM-DD (the day the rating was given)
 */
function applySm2(state, quality, todayISO) {
  if (!isISODate(todayISO)) {
    throw new Error(`applySm2: invalid todayISO "${todayISO}"`);
  }
  const cur = state && typeof state === 'object' ? state : defaultSrsState();
  const q = clampQuality(quality);
  const ease = updateEase(
    typeof cur.ease === 'number' && Number.isFinite(cur.ease)
      ? cur.ease
      : EASE_DEFAULT,
    q,
  );

  let repetitions;
  let interval;
  if (q < 3) {
    // Lapse: SM-2 resets the rep streak and schedules the section for
    // tomorrow so the user can recover quickly.
    repetitions = 0;
    interval = 1;
  } else {
    const prevReps =
      typeof cur.repetitions === 'number' && Number.isFinite(cur.repetitions)
        ? cur.repetitions
        : 0;
    repetitions = prevReps + 1;
    if (repetitions === 1) {
      interval = 1;
    } else if (repetitions === 2) {
      interval = 6;
    } else {
      const prevInterval =
        typeof cur.interval === 'number' &&
        Number.isFinite(cur.interval) &&
        cur.interval > 0
          ? cur.interval
          : 6;
      interval = Math.ceil(prevInterval * ease);
    }
  }

  return {
    repetitions,
    interval,
    ease,
    nextDue: addDaysISO(todayISO, interval),
    lastReviewedDate: todayISO,
  };
}

/**
 * Add `days` whole days to a YYYY-MM-DD date string, returning a new
 * YYYY-MM-DD. Handles month/year/leap-year boundaries correctly. Pure.
 *
 * Implementation note: we build a Date from explicit (y, m, d) components and
 * then call setDate() — JavaScript's Date object normalises overflow (e.g.
 * Apr 31 → May 1) for us, and we only ever read y/m/d back out, never a
 * wall-clock time, so DST has no effect on the result.
 */
function addDaysISO(dateISO, days) {
  if (!isISODate(dateISO)) {
    throw new Error(`addDaysISO: invalid date "${dateISO}"`);
  }
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateISO);
  const y = Number(m[1]);
  const mo = Number(m[2]) - 1;
  const d = Number(m[3]);
  const dt = new Date(y, mo, d);
  const delta = Math.floor(Number(days) || 0);
  dt.setDate(dt.getDate() + delta);
  const ny = dt.getFullYear();
  const nm = String(dt.getMonth() + 1).padStart(2, '0');
  const nd = String(dt.getDate()).padStart(2, '0');
  return `${ny}-${nm}-${nd}`;
}

/**
 * Number of whole days between two YYYY-MM-DD dates (b - a). Negative if
 * `b` is before `a`. Pure.
 */
function daysBetweenISO(a, b) {
  if (!isISODate(a) || !isISODate(b)) {
    throw new Error('daysBetweenISO: invalid date input');
  }
  const ma = /^(\d{4})-(\d{2})-(\d{2})$/.exec(a);
  const mb = /^(\d{4})-(\d{2})-(\d{2})$/.exec(b);
  const da = new Date(Number(ma[1]), Number(ma[2]) - 1, Number(ma[3]));
  const db = new Date(Number(mb[1]), Number(mb[2]) - 1, Number(mb[3]));
  return Math.round((db.getTime() - da.getTime()) / 86400000);
}

/**
 * Human-readable next-review summary, e.g. "2026-05-04 (in 6 days)" or
 * "2026-04-29 (tomorrow)" or "2026-04-28 (due today)".
 */
function describeNextDue(nextDueISO, todayISO) {
  if (!nextDueISO) return '';
  if (!isISODate(todayISO)) return nextDueISO;
  const days = daysBetweenISO(todayISO, nextDueISO);
  if (days < 0) {
    const overdue = Math.abs(days);
    return `${nextDueISO} (${overdue} day${overdue === 1 ? '' : 's'} overdue)`;
  }
  if (days === 0) return `${nextDueISO} (due today)`;
  if (days === 1) return `${nextDueISO} (tomorrow)`;
  return `${nextDueISO} (in ${days} days)`;
}

/**
 * Pure: project the four SM-2 ratings (Again / Hard / Good / Easy) from a
 * starting state, returning the next-due date + interval each rating would
 * yield. Powers the post-session rating prompt (item 8) — the UI labels each
 * button with its projected next-review distance ("Again → tomorrow",
 * "Good → in 6d") so the user knows what they're committing to.
 *
 * Output is in the order Again, Hard, Good, Easy (the on-screen order). Each
 * entry is `{ rating, label, nextDue, interval, daysOff }`. `daysOff` is the
 * number of days from `todayISO` to `nextDue` — useful for "in N days" copy
 * without re-running daysBetweenISO at the call site.
 *
 * @param {ReturnType<typeof defaultSrsState>|null|undefined} state
 * @param {string} todayISO YYYY-MM-DD
 */
function previewSm2Outcomes(state, todayISO) {
  if (!isISODate(todayISO)) {
    throw new Error(`previewSm2Outcomes: invalid todayISO "${todayISO}"`);
  }
  const cur = state && typeof state === 'object' ? state : defaultSrsState();
  const ratings = [
    { rating: RATING_AGAIN, label: 'Again' },
    { rating: RATING_HARD, label: 'Hard' },
    { rating: RATING_GOOD, label: 'Good' },
    { rating: RATING_EASY, label: 'Easy' },
  ];
  return ratings.map(({ rating, label }) => {
    const next = applySm2(cur, rating, todayISO);
    return {
      rating,
      label,
      nextDue: next.nextDue,
      interval: next.interval,
      daysOff: daysBetweenISO(todayISO, next.nextDue),
    };
  });
}

/**
 * Pure: filter + sort sections into a "due today" review queue.
 *
 * A section is in the queue when:
 *   - it has been rated at least once (so `nextDue` is set), AND
 *   - `nextDue` is on or before `todayISO`, AND
 *   - it hasn't already met the rep goal today.
 *
 * The third condition is what keeps a section that the user just finished
 * from re-appearing in the queue immediately — once the goal is met for the
 * day, the section drops off until tomorrow (or whatever its next-due date
 * works out to). This is the "drop-off-on-completion" behaviour resolved as
 * the design choice for item 7.
 *
 * Sort order: most-overdue first (smallest nextDue), then by piece title
 * alphabetically, then by section addedAt — so the user's eye lands on the
 * stalest review first, with stable tie-breaks.
 *
 * @param {object} args
 * @param {Array<object>} args.sections   raw section records (may include
 *     unscheduled sections; they'll be filtered out)
 * @param {Map<string,{id:string,title:string}>|Array<{id:string,title:string}>} args.piecesById
 *     a way to look up piece title by piece id; either a Map or an Array
 * @param {Map<string,number>|Object<string,number>} args.repCountsToday
 *     today's rep counts keyed by sectionId; missing → treated as 0
 * @param {string} args.todayISO          YYYY-MM-DD
 * @param {number} [args.repGoal=10]      hard goal to consider a section done
 * @returns {Array<{
 *   section: object,
 *   piece: { id: string, title: string },
 *   nextDue: string,
 *   daysOff: number,
 *   repCount: number,
 * }>}
 */
function buildReviewQueue({
  sections,
  piecesById,
  repCountsToday,
  todayISO,
  repGoal = 10,
}) {
  if (!isISODate(todayISO)) {
    throw new Error(`buildReviewQueue: invalid todayISO "${todayISO}"`);
  }
  if (!Array.isArray(sections) || sections.length === 0) return [];

  // Normalise the piece lookup so callers can pass an array or a Map.
  const pieceLookup = (() => {
    if (piecesById instanceof Map) return (id) => piecesById.get(id) || null;
    if (Array.isArray(piecesById)) {
      const m = new Map();
      for (const p of piecesById) {
        if (p && typeof p.id === 'string') m.set(p.id, p);
      }
      return (id) => m.get(id) || null;
    }
    if (piecesById && typeof piecesById === 'object') {
      return (id) => piecesById[id] || null;
    }
    return () => null;
  })();

  // Same forgiving treatment for the rep-counts input.
  const repLookup = (() => {
    if (repCountsToday instanceof Map) {
      return (id) => Number(repCountsToday.get(id) || 0) || 0;
    }
    if (repCountsToday && typeof repCountsToday === 'object') {
      return (id) => Number(repCountsToday[id] || 0) || 0;
    }
    return () => 0;
  })();

  const goal = Number.isFinite(repGoal) && repGoal > 0 ? Math.floor(repGoal) : 10;
  const items = [];

  for (const section of sections) {
    if (!section || typeof section !== 'object') continue;
    const srs = srsStateForSection(section);
    if (!srs.nextDue) continue;
    let daysOff;
    try {
      daysOff = daysBetweenISO(todayISO, srs.nextDue);
    } catch {
      continue;
    }
    if (daysOff > 0) continue; // not due yet
    const repCount = repLookup(section.id);
    if (repCount >= goal) continue; // already done today
    const piece = pieceLookup(section.pieceId) || {
      id: section.pieceId || '',
      title: '(unknown piece)',
    };
    items.push({
      section,
      piece,
      nextDue: srs.nextDue,
      daysOff,
      repCount,
    });
  }

  items.sort((a, b) => {
    if (a.nextDue !== b.nextDue) return a.nextDue.localeCompare(b.nextDue);
    const ta = (a.piece.title || '').toLowerCase();
    const tb = (b.piece.title || '').toLowerCase();
    if (ta !== tb) return ta < tb ? -1 : 1;
    return (a.section.addedAt || 0) - (b.section.addedAt || 0);
  });

  return items;
}

/**
 * A section is "mastered" once its scheduled interval has stretched out to
 * three weeks or more. Three weeks is a deliberate floor:
 *   - one week corresponds to the second SM-2 review (interval = 6 → 7 days
 *     after the next rating bump), which is too easy a bar — that's a piece
 *     the user has only just learned, not one they've internalised.
 *   - three weeks is past the third Good-rated review (interval cycle goes
 *     1 → 6 → 15 → ~38 days at default ease), which is when the section is
 *     starting to live in the user's long-term memory.
 *   - bigger intervals (months) would set the bar so high that very few
 *     sections would ever earn the badge in a real practice routine.
 *
 * Surfaced via `isSectionMastered` and the per-piece retention summary in
 * `summariseProgress`. The threshold lives here (rather than in app.js) so
 * the rule is unit-testable and consistent across every surface that needs
 * to ask "is this section mastered?".
 */
const MASTERY_INTERVAL_DAYS = 21;

/**
 * Pure: a section is "mastered" once it has been rated at least once AND
 * its scheduled interval has stretched to MASTERY_INTERVAL_DAYS or more.
 *
 * The "rated at least once" guard is important: a fresh section has
 * `interval: 0` (the never-reviewed sentinel) but we don't want a 0-default
 * to ever count as mastered.
 *
 * @param {object|null|undefined} section
 */
function isSectionMastered(section) {
  if (!section || typeof section !== 'object') return false;
  const srs = srsStateForSection(section);
  if (!srs.lastReviewedDate) return false;
  if (typeof srs.interval !== 'number' || !Number.isFinite(srs.interval)) {
    return false;
  }
  return srs.interval >= MASTERY_INTERVAL_DAYS;
}

/**
 * Pure: count the user's current daily-practice streak.
 *
 * A "streak day" is any calendar day with at least one rep logged. The
 * streak is the run of consecutive streak-days ending at `todayISO`. If the
 * user hasn't practiced today YET, we look back from yesterday — so a
 * streak doesn't break the moment they wake up; it only breaks once they
 * sleep through a full day with no practice.
 *
 * Open design question (carried forward): the strictest version of this
 * would only break a streak on a day where something was *due* AND skipped
 * — but that requires a per-day snapshot of due-dates we don't currently
 * persist. This simpler "consecutive practice days" version is a fine MVP;
 * a future schema bump (or a derived "due history" view) can refine it.
 *
 * @param {Iterable<string>|Array<string>|Set<string>} practiceDates
 *     ISO YYYY-MM-DD dates the user has logged at least one rep on.
 * @param {string} todayISO YYYY-MM-DD
 * @returns {number} 0 if no streak; >= 1 otherwise.
 */
function computeDailyStreak(practiceDates, todayISO) {
  if (!isISODate(todayISO)) {
    throw new Error(`computeDailyStreak: invalid todayISO "${todayISO}"`);
  }
  const set = new Set();
  if (practiceDates) {
    for (const d of practiceDates) {
      if (isISODate(d)) set.add(d);
    }
  }
  if (set.size === 0) return 0;

  // If the user hasn't practiced today yet, start counting from yesterday —
  // the streak only breaks once a *whole* day passes without practice.
  let cursor = todayISO;
  if (!set.has(cursor)) {
    cursor = addDaysISO(cursor, -1);
    if (!set.has(cursor)) return 0;
  }
  let streak = 0;
  while (set.has(cursor)) {
    streak += 1;
    cursor = addDaysISO(cursor, -1);
  }
  return streak;
}

/**
 * Pure: roll the section + piece library + rep-history into a stats bundle
 * suitable for rendering the "Progress" panel.
 *
 * Returns:
 *   {
 *     sectionsTotal: number,           // every section in the library
 *     sectionsRated: number,           // sections rated at least once
 *     sectionsMastered: number,        // sections with interval >= 21d
 *     dailyStreak: number,             // see computeDailyStreak
 *     todayDoneCount: number,          // sections with goal met today
 *     todayDueCount: number,           // sections due today (incl. those done)
 *     piecesTotal: number,             // pieces in the library
 *     perPiece: Array<{
 *       pieceId, title,
 *       sectionsTotal, sectionsRated, sectionsMastered,
 *       masteryPct,                    // 0–100, integer
 *     }>,
 *   }
 *
 * `todayDoneCount` is sections-with-goal-met-today across the whole library
 * (independent of nextDue). `todayDueCount` is sections that were due today
 * or earlier — including the ones already finished. So the user-facing
 * "X / Y done today" line is `todayDoneCount-of-todayDue / todayDueCount`.
 *
 * The per-piece list is sorted by mastery percentage descending (the user's
 * strongest pieces first), with title alphabetical as the tie-break.
 */
function summariseProgress({
  sections,
  pieces,
  practiceDates,
  repCountsToday,
  todayISO,
  repGoal = 10,
}) {
  if (!isISODate(todayISO)) {
    throw new Error(`summariseProgress: invalid todayISO "${todayISO}"`);
  }
  const goal = Number.isFinite(repGoal) && repGoal > 0 ? Math.floor(repGoal) : 10;
  const allSections = Array.isArray(sections) ? sections : [];
  const allPieces = Array.isArray(pieces) ? pieces : [];

  // Normalise the rep-counts input (Map | plain object | undefined).
  const repLookup = (() => {
    if (repCountsToday instanceof Map) {
      return (id) => Number(repCountsToday.get(id) || 0) || 0;
    }
    if (repCountsToday && typeof repCountsToday === 'object') {
      return (id) => Number(repCountsToday[id] || 0) || 0;
    }
    return () => 0;
  })();

  // Per-piece bookkeeping.
  const perPieceById = new Map();
  for (const p of allPieces) {
    if (p && typeof p.id === 'string') {
      perPieceById.set(p.id, {
        pieceId: p.id,
        title: p.title || '(unknown piece)',
        sectionsTotal: 0,
        sectionsRated: 0,
        sectionsMastered: 0,
        masteryPct: 0,
      });
    }
  }

  let sectionsTotal = 0;
  let sectionsRated = 0;
  let sectionsMastered = 0;
  let todayDoneCount = 0;
  let todayDueCount = 0;

  for (const section of allSections) {
    if (!section || typeof section !== 'object') continue;
    sectionsTotal += 1;
    const srs = srsStateForSection(section);
    const rated = !!srs.lastReviewedDate;
    const mastered = isSectionMastered(section);
    if (rated) sectionsRated += 1;
    if (mastered) sectionsMastered += 1;

    // "Due today" = nextDue is today or earlier (whether or not it has been
    // already practised today). We DO count sections rated today as "due"
    // because they were the user's work for the day even after they're done.
    if (srs.nextDue) {
      let daysOff;
      try {
        daysOff = daysBetweenISO(todayISO, srs.nextDue);
      } catch {
        daysOff = null;
      }
      if (daysOff !== null && daysOff <= 0) todayDueCount += 1;
    }

    // "Done today" = today's rep count met the goal. We don't gate on
    // nextDue here so a user who power-practices a non-due section still
    // gets credit toward the daily-progress line.
    if (repLookup(section.id) >= goal) todayDoneCount += 1;

    // Per-piece accumulation.
    if (typeof section.pieceId === 'string') {
      let bucket = perPieceById.get(section.pieceId);
      if (!bucket) {
        // Section references a piece we don't know about — paper over so
        // the stats are still complete (the per-piece list will show
        // "(unknown piece)" until the next refresh).
        bucket = {
          pieceId: section.pieceId,
          title: '(unknown piece)',
          sectionsTotal: 0,
          sectionsRated: 0,
          sectionsMastered: 0,
          masteryPct: 0,
        };
        perPieceById.set(section.pieceId, bucket);
      }
      bucket.sectionsTotal += 1;
      if (rated) bucket.sectionsRated += 1;
      if (mastered) bucket.sectionsMastered += 1;
    }
  }

  // Finalise per-piece percentages and sort.
  const perPiece = Array.from(perPieceById.values()).map((b) => ({
    ...b,
    masteryPct:
      b.sectionsTotal > 0
        ? Math.round((b.sectionsMastered / b.sectionsTotal) * 100)
        : 0,
  }));
  perPiece.sort((a, b) => {
    if (a.masteryPct !== b.masteryPct) return b.masteryPct - a.masteryPct;
    const ta = (a.title || '').toLowerCase();
    const tb = (b.title || '').toLowerCase();
    if (ta !== tb) return ta < tb ? -1 : 1;
    return 0;
  });

  const dailyStreak = computeDailyStreak(practiceDates, todayISO);

  return {
    sectionsTotal,
    sectionsRated,
    sectionsMastered,
    dailyStreak,
    todayDoneCount,
    todayDueCount,
    piecesTotal: allPieces.length,
    perPiece,
  };
}

// --- internal helpers ----------------------------------------------------

function clampQuality(q) {
  const n = Math.floor(Number(q));
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 5) return 5;
  return n;
}

function isISODate(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

// ---- Node export shim (browser-safe) ------------------------------------
// In the browser these are plain globals (classic <script>). Under Node the
// object-literal assignment is picked up by the CJS→ESM interop so the test
// files can `import` them. `module` is undefined in the browser, so this is
// skipped there with no error.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    EASE_DEFAULT,
    EASE_MIN,
    RATING_AGAIN,
    RATING_HARD,
    RATING_GOOD,
    RATING_EASY,
    MASTERY_INTERVAL_DAYS,
    defaultSrsState,
    srsStateForSection,
    updateEase,
    applySm2,
    addDaysISO,
    daysBetweenISO,
    describeNextDue,
    previewSm2Outcomes,
    buildReviewQueue,
    isSectionMastered,
    computeDailyStreak,
    summariseProgress,
  };
}
