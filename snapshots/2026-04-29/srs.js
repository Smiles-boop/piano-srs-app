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
export const EASE_DEFAULT = 2.5;

/** SM-2's hard floor on ease. Below this, intervals collapse and reviews
 * pile up — the floor keeps the schedule recoverable. */
export const EASE_MIN = 1.3;

// Quality ratings on SM-2's 0–5 scale. Item 8 wires a real prompt; item 6
// uses RATING_GOOD as the default when a section first hits its rep goal.
export const RATING_AGAIN = 0;
export const RATING_HARD = 3;
export const RATING_GOOD = 4;
export const RATING_EASY = 5;

/**
 * Default SRS state for a section that has never been reviewed.
 * `interval: 0` is the sentinel for "never reviewed" — distinct from
 * `interval: 1` ("first review just happened, due tomorrow").
 */
export function defaultSrsState() {
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
export function srsStateForSection(section) {
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
export function updateEase(ease, quality) {
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
export function applySm2(state, quality, todayISO) {
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
export function addDaysISO(dateISO, days) {
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
export function daysBetweenISO(a, b) {
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
export function describeNextDue(nextDueISO, todayISO) {
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
export function previewSm2Outcomes(state, todayISO) {
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
export function buildReviewQueue({
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
