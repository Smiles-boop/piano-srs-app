# Snapshot — 2026-04-29-stats (roadmap item 9: Progress stats panel)

This is the *second* snapshot folder for 2026-04-29 — the earlier
`snapshots/2026-04-29/` holds today's item-8 work (post-session rating prompt).
This folder holds the item-9 work (progress stats panel) that landed later
the same day. Splitting the slices into separate snapshot folders preserves
traceability for both pieces of work.

## What changed in this slice

- **`srs.js`**: added `MASTERY_INTERVAL_DAYS = 21`, `isSectionMastered`,
  `computeDailyStreak`, `summariseProgress`. All pure.
- **`db.js`**: added `listDistinctPracticeDates()` — a key-cursor walk
  over the `byDateISO` index in `nextunique` direction. No schema bump.
- **`app.js`**: new `statsState` snapshot, `refreshStats` /
  `noteRepLogActivity` / `renderStats`, all the new `els.stats*`
  references, hooks into the rep-click / undo / reset / rating /
  add-section / delete-section finally blocks. `APP_VERSION` bumped
  0.8.0 → 0.9.0. (The `app.js.diff` here is a summary of the additions;
  the canonical `app.js` carries the full source.)
- **`index.html`**: new `#stats-panel` block at the top of
  `#viewer-placeholder`, above the queue. Footer version bumped to 0.9.0.
- **`styles.css`**: new `.stats-panel` / `.stats-tiles` / `.stats-tile` /
  `.stats-per-piece*` blocks, with a 720px mobile breakpoint.
- **`tests/stats.test.mjs`**: new (~50 assertion blocks for the four pure
  helpers). The snapshot copy is a small subset; the canonical file is
  longer and exhaustively covers edge cases.
- `tests/srs.test.mjs` and `tests/db.test.mjs` exported-surface checks
  extended to include the four new srs.js names and the new
  `listDistinctPracticeDates` from db.js.

## Verification

- `node --check srs.js` → ok
- `node --check db.js` → ok
- `node tests/srs.test.mjs` → all assertions passed
- `node tests/queue.test.mjs` → all assertions passed (no regression)
- `node tests/stats.test.mjs` → all assertions passed
- imports.smoke.mjs (mirrors app.js's import surface) → 30 symbols resolved
- 48 `getElementById` ids in app.js all match `id=` in index.html
