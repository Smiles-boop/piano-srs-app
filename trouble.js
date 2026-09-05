/* trouble.js — turn recorded wrong notes into "trouble spots", and turn those
 * into short drill ranges.
 *
 * The practice loop already resets a run on any wrong note; every one of those
 * carries the tick it happened at (see `handleMistake` in player.js). Tallied
 * per (piece, tick) and clustered, that history answers the question a player
 * can't answer honestly about their own playing: *where do I actually keep
 * failing?* — which is reliably not where they'd guess.
 *
 * Pure module: no DOM, no IDB. The app supplies the tallies and the piece's
 * notes, and gets back ranges it can turn into ordinary practice sections.
 */

// Mistakes within this distance of each other are the same trouble spot. Two
// quarters is about a beat or two — wide enough that fluffing either side of a
// leap counts once, tight enough not to swallow a whole phrase.
const TROUBLE_CLUSTER_QUARTERS = 2;

// Run-up and follow-through added around a spot when building a drill. You
// can't practise a hard note in isolation — the approach to it is usually the
// actual problem, and stopping on it teaches you to stop.
const TROUBLE_CONTEXT_QUARTERS = 2;

// Below this many total wrong notes a spot is a slip, not a weakness. Drilling
// one-off fumbles would just add noise to the review queue.
const TROUBLE_MIN_COUNT = 3;

// A drill shorter than this isn't worth a section of its own.
const TROUBLE_MIN_NOTES = 4;

// How many spots to surface. Past a handful this stops being "here's what to
// fix" and becomes another wall of list to feel behind on.
const TROUBLE_MAX_SPOTS = 5;

/**
 * Group mistake tallies into spots.
 *
 * @param {Array<{tick:number, count:number}>} records
 * @param {{ticksPerQuarter?:number, clusterQuarters?:number, minCount?:number}} [opts]
 * @returns {Array<{startTick:number, endTick:number, peakTick:number,
 *   count:number, ticks:number[]}>} sorted worst-first, then earliest-first
 */
function clusterMistakes(records, opts = {}) {
  const tpq = Number(opts.ticksPerQuarter) > 0 ? Number(opts.ticksPerQuarter) : 480;
  const gap = (opts.clusterQuarters ?? TROUBLE_CLUSTER_QUARTERS) * tpq;
  const minCount = opts.minCount ?? TROUBLE_MIN_COUNT;

  const rows = (Array.isArray(records) ? records : [])
    .filter((r) => r && Number.isFinite(r.tick) && (r.count || 0) > 0)
    .sort((a, b) => a.tick - b.tick);
  if (!rows.length) return [];

  const clusters = [];
  let cur = null;
  for (const r of rows) {
    // A new cluster starts when this mistake is more than `gap` past the end
    // of the current one — measured from the last tick in it, so a long messy
    // passage stays one spot rather than fragmenting.
    if (!cur || r.tick - cur.endTick > gap) {
      cur = { startTick: r.tick, endTick: r.tick, count: 0, ticks: [], peakTick: r.tick, peak: 0 };
      clusters.push(cur);
    }
    cur.endTick = r.tick;
    cur.count += r.count;
    cur.ticks.push(r.tick);
    if (r.count > cur.peak) { cur.peak = r.count; cur.peakTick = r.tick; }
  }

  return clusters
    .filter((c) => c.count >= minCount)
    .map(({ peak, ...c }) => c) // `peak` was bookkeeping for peakTick
    .sort((a, b) => b.count - a.count || a.startTick - b.startTick);
}

/**
 * A drillable tick range around a spot: the spot plus context either side,
 * snapped outward to real note onsets so the drill starts and ends on a note.
 *
 * Returns null when the piece has no notes anywhere near the spot, or when the
 * resulting range is too short to be worth practising.
 *
 * @param {{startTick:number, endTick:number}} spot
 * @param {Array<{startTick:number, endTick:number}>} notes the piece's notes
 * @param {{ticksPerQuarter?:number, contextQuarters?:number, minNotes?:number}} [opts]
 * @returns {{startTick:number, endTick:number, noteCount:number}|null}
 */
function troubleDrillRange(spot, notes, opts = {}) {
  if (!spot || !Array.isArray(notes) || !notes.length) return null;
  const tpq = Number(opts.ticksPerQuarter) > 0 ? Number(opts.ticksPerQuarter) : 480;
  const minNotes = opts.minNotes ?? TROUBLE_MIN_NOTES;
  const onsets = [...new Set(notes.map((n) => n.startTick))].sort((a, b) => a - b);
  if (!onsets.length) return null;

  // Widen the context until the drill holds enough notes to be a real
  // exercise — a spot in a sparse, slow passage needs a longer window than one
  // in a run of semiquavers to contain the same amount of music.
  let context = (opts.contextQuarters ?? TROUBLE_CONTEXT_QUARTERS) * tpq;
  for (let attempt = 0; attempt < 4; attempt++) {
    const from = spot.startTick - context;
    const to = spot.endTick + context;
    // Snap outward to onsets so the range begins and ends on real notes.
    const startTick = onsets.filter((t) => t >= from)[0] ?? onsets[0];
    const inside = onsets.filter((t) => t >= startTick && t <= to);
    const lastOnset = inside.length ? inside[inside.length - 1] : startTick;
    // endTick is exclusive (notesInSection uses a half-open window), so push it
    // just past the final onset.
    const endTick = lastOnset + 1;
    const noteCount = notes.filter(
      (n) => n.startTick >= startTick && n.startTick < endTick,
    ).length;
    const spansWholePiece = startTick <= onsets[0] && lastOnset >= onsets[onsets.length - 1];
    if (noteCount >= minNotes || spansWholePiece) {
      return noteCount > 0 ? { startTick, endTick, noteCount } : null;
    }
    context *= 2;
  }
  return null;
}

/** Total recorded mistakes falling inside a section's tick window. */
function mistakesInSection(records, section) {
  if (!Array.isArray(records) || !section) return 0;
  const from = section.startTick || 0;
  const to = section.endTick || 0;
  let total = 0;
  for (const r of records) {
    if (!r || !Number.isFinite(r.tick)) continue;
    if (r.tick >= from && r.tick < to) total += r.count || 0;
  }
  return total;
}

/**
 * The full pipeline: tallies → ranked spots with drillable ranges attached.
 * Spots whose range can't be built (or is too short) are dropped.
 *
 * @param {Array<{tick:number,count:number}>} records
 * @param {Array<object>} notes
 * @param {{ticksPerQuarter?:number, maxSpots?:number, minCount?:number,
 *   clusterQuarters?:number, contextQuarters?:number, minNotes?:number}} [opts]
 */
function troubleSpots(records, notes, opts = {}) {
  const spots = clusterMistakes(records, opts);
  const out = [];
  for (const spot of spots) {
    const range = troubleDrillRange(spot, notes, opts);
    if (range) out.push({ ...spot, ...range });
    if (opts.maxSpots && out.length >= opts.maxSpots) break;
  }
  return out;
}

/**
 * Split a spot's severity into a coarse band, for colouring. Relative to the
 * worst spot in the piece rather than an absolute count, since what counts as
 * "a lot of mistakes" depends entirely on the piece and how long you've had it.
 *
 * @returns {'high'|'medium'|'low'}
 */
function troubleHeat(count, maxCount) {
  if (!(maxCount > 0)) return 'low';
  const ratio = count / maxCount;
  if (ratio >= 0.66) return 'high';
  if (ratio >= 0.33) return 'medium';
  return 'low';
}

// ---- Node export shim (browser-safe) ------------------------------------
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    TROUBLE_CLUSTER_QUARTERS,
    TROUBLE_CONTEXT_QUARTERS,
    TROUBLE_MIN_COUNT,
    TROUBLE_MIN_NOTES,
    TROUBLE_MAX_SPOTS,
    clusterMistakes,
    troubleDrillRange,
    mistakesInSection,
    troubleSpots,
    troubleHeat,
  };
}
