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
 */
export function updateEase(ease, quality) {
  const baseEase =
    typeof ease === 'number' && Number.isFinite(ease) ? ease : EASE_DEFAULT;
  const q = clampQuality(quality);
  const next = baseEase + (0.1 - (5 - q) * (0.08 + (5 - q) * 0.02));
  const rounded = Math.round(next * 10000) / 10000;
  return Math.max(EASE_MIN, rounded);
}

export function applySm2(state, quality, todayISO) {
  if (!isISODate(todayISO)) {
    throw new Error(`applySm2: invalid todayISO "${todayISO}"`);
  }
  const cur = state && typeof state === 'object' ? state : defaultSrsState();
  const q = clampQuality(quality);
  const ease = updateEase(
    typeof cur.ease === 'number' && Number.isFinite(cur.ease) ? cur.ease : EASE_DEFAULT,
    q,
  );
  let repetitions;
  let interval;
  if (q < 3) {
    repetitions = 0;
    interval = 1;
  } else {
    const prevReps =
      typeof cur.repetitions === 'number' && Number.isFinite(cur.repetitions)
        ? cur.repetitions
        : 0;
    repetitions = prevReps + 1;
    if (repetitions === 1) interval = 1;
    else if (repetitions === 2) interval = 6;
    else {
      const prevInterval =
        typeof cur.interval === 'number' && Number.isFinite(cur.interval) && cur.interval > 0
          ? cur.interval
          : 6;
      interval = Math.ceil(prevInterval * ease);
    }
  }
  return {
    repetitions, interval, ease,
    nextDue: addDaysISO(todayISO, interval),
    lastReviewedDate: todayISO,
  };
}

export function addDaysISO(dateISO, days) {
  if (!isISODate(dateISO)) throw new Error(`addDaysISO: invalid date "${dateISO}"`);
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateISO);
  const y = Number(m[1]), mo = Number(m[2]) - 1, d = Number(m[3]);
  const dt = new Date(y, mo, d);
  const delta = Math.floor(Number(days) || 0);
  dt.setDate(dt.getDate() + delta);
  const ny = dt.getFullYear();
  const nm = String(dt.getMonth() + 1).padStart(2, '0');
  const nd = String(dt.getDate()).padStart(2, '0');
  return `${ny}-${nm}-${nd}`;
}

export function daysBetweenISO(a, b) {
  if (!isISODate(a) || !isISODate(b)) throw new Error('daysBetweenISO: invalid date input');
  const ma = /^(\d{4})-(\d{2})-(\d{2})$/.exec(a);
  const mb = /^(\d{4})-(\d{2})-(\d{2})$/.exec(b);
  const da = new Date(Number(ma[1]), Number(ma[2]) - 1, Number(ma[3]));
  const db = new Date(Number(mb[1]), Number(mb[2]) - 1, Number(mb[3]));
  return Math.round((db.getTime() - da.getTime()) / 86400000);
}

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

export function previewSm2Outcomes(state, todayISO) {
  if (!isISODate(todayISO)) throw new Error(`previewSm2Outcomes: invalid todayISO "${todayISO}"`);
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
      rating, label, nextDue: next.nextDue, interval: next.interval,
      daysOff: daysBetweenISO(todayISO, next.nextDue),
    };
  });
}

export function buildReviewQueue({ sections, piecesById, repCountsToday, todayISO, repGoal = 10 }) {
  if (!isISODate(todayISO)) throw new Error(`buildReviewQueue: invalid todayISO "${todayISO}"`);
  if (!Array.isArray(sections) || sections.length === 0) return [];
  const pieceLookup = (() => {
    if (piecesById instanceof Map) return (id) => piecesById.get(id) || null;
    if (Array.isArray(piecesById)) {
      const m = new Map();
      for (const p of piecesById) if (p && typeof p.id === 'string') m.set(p.id, p);
      return (id) => m.get(id) || null;
    }
    if (piecesById && typeof piecesById === 'object') return (id) => piecesById[id] || null;
    return () => null;
  })();
  const repLookup = (() => {
    if (repCountsToday instanceof Map) return (id) => Number(repCountsToday.get(id) || 0) || 0;
    if (repCountsToday && typeof repCountsToday === 'object') return (id) => Number(repCountsToday[id] || 0) || 0;
    return () => 0;
  })();
  const goal = Number.isFinite(repGoal) && repGoal > 0 ? Math.floor(repGoal) : 10;
  const items = [];
  for (const section of sections) {
    if (!section || typeof section !== 'object') continue;
    const srs = srsStateForSection(section);
    if (!srs.nextDue) continue;
    let daysOff;
    try { daysOff = daysBetweenISO(todayISO, srs.nextDue); } catch { continue; }
    if (daysOff > 0) continue;
    const repCount = repLookup(section.id);
    if (repCount >= goal) continue;
    const piece = pieceLookup(section.pieceId) || { id: section.pieceId || '', title: '(unknown piece)' };
    items.push({ section, piece, nextDue: srs.nextDue, daysOff, repCount });
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

// --- Item 9: progress stats helpers --------------------------------------

/**
 * A section is "mastered" once its scheduled interval has stretched out to
 * three weeks or more.
 */
export const MASTERY_INTERVAL_DAYS = 21;

export function isSectionMastered(section) {
  if (!section || typeof section !== 'object') return false;
  const srs = srsStateForSection(section);
  if (!srs.lastReviewedDate) return false;
  if (typeof srs.interval !== 'number' || !Number.isFinite(srs.interval)) return false;
  return srs.interval >= MASTERY_INTERVAL_DAYS;
}

export function computeDailyStreak(practiceDates, todayISO) {
  if (!isISODate(todayISO)) throw new Error(`computeDailyStreak: invalid todayISO "${todayISO}"`);
  const set = new Set();
  if (practiceDates) for (const d of practiceDates) if (isISODate(d)) set.add(d);
  if (set.size === 0) return 0;
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

export function summariseProgress({ sections, pieces, practiceDates, repCountsToday, todayISO, repGoal = 10 }) {
  if (!isISODate(todayISO)) throw new Error(`summariseProgress: invalid todayISO "${todayISO}"`);
  const goal = Number.isFinite(repGoal) && repGoal > 0 ? Math.floor(repGoal) : 10;
  const allSections = Array.isArray(sections) ? sections : [];
  const allPieces = Array.isArray(pieces) ? pieces : [];
  const repLookup = (() => {
    if (repCountsToday instanceof Map) return (id) => Number(repCountsToday.get(id) || 0) || 0;
    if (repCountsToday && typeof repCountsToday === 'object') return (id) => Number(repCountsToday[id] || 0) || 0;
    return () => 0;
  })();
  const perPieceById = new Map();
  for (const p of allPieces) {
    if (p && typeof p.id === 'string') {
      perPieceById.set(p.id, {
        pieceId: p.id, title: p.title || '(unknown piece)',
        sectionsTotal: 0, sectionsRated: 0, sectionsMastered: 0, masteryPct: 0,
      });
    }
  }
  let sectionsTotal = 0, sectionsRated = 0, sectionsMastered = 0;
  let todayDoneCount = 0, todayDueCount = 0;
  for (const section of allSections) {
    if (!section || typeof section !== 'object') continue;
    sectionsTotal += 1;
    const srs = srsStateForSection(section);
    const rated = !!srs.lastReviewedDate;
    const mastered = isSectionMastered(section);
    if (rated) sectionsRated += 1;
    if (mastered) sectionsMastered += 1;
    if (srs.nextDue) {
      let daysOff;
      try { daysOff = daysBetweenISO(todayISO, srs.nextDue); } catch { daysOff = null; }
      if (daysOff !== null && daysOff <= 0) todayDueCount += 1;
    }
    if (repLookup(section.id) >= goal) todayDoneCount += 1;
    if (typeof section.pieceId === 'string') {
      let bucket = perPieceById.get(section.pieceId);
      if (!bucket) {
        bucket = {
          pieceId: section.pieceId, title: '(unknown piece)',
          sectionsTotal: 0, sectionsRated: 0, sectionsMastered: 0, masteryPct: 0,
        };
        perPieceById.set(section.pieceId, bucket);
      }
      bucket.sectionsTotal += 1;
      if (rated) bucket.sectionsRated += 1;
      if (mastered) bucket.sectionsMastered += 1;
    }
  }
  const perPiece = Array.from(perPieceById.values()).map((b) => ({
    ...b,
    masteryPct: b.sectionsTotal > 0 ? Math.round((b.sectionsMastered / b.sectionsTotal) * 100) : 0,
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
    sectionsTotal, sectionsRated, sectionsMastered,
    dailyStreak, todayDoneCount, todayDueCount,
    piecesTotal: allPieces.length, perPiece,
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
