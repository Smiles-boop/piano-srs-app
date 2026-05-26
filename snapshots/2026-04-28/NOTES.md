# Snapshot notes — 2026-04-28

This folder accumulates files from BOTH 2026-04-28 runs:

- **Roadmap item 6** (SM-2 scheduling): the morning's run.
- **Roadmap item 7** (Daily review queue): the afternoon's run.

End-of-day state for each file:

| File | Reflects |
|------|----------|
| `index.html` | Item 7 — adds `#review-queue-panel` and `#viewer-placeholder-welcome`. Footer bumped to v0.7.0. |
| `srs.js` | Item 7 — adds `buildReviewQueue` helper. |
| `db.js` | Item 7 — adds `listAllSections` and `getRepCountsForDate`; updated schema-doc preamble (no schema bump). |
| `app.js` | Item 6 — was last touched by the morning run. The item-7 changes (cross-piece queue state, `refreshReviewQueue` / `renderReviewQueue` / `handleReviewQueueClick` / `waitForSection` / `setQueueRepCount` / `upsertQueueSection` / `removeQueueSection`, queue-aware status copy, hooks into `handleSectionFormSubmit` / `handleDeleteSection` / `handleRepClick` / `handleUndoRep` / `handleResetReps` / `maybeFireSm2`, `APP_VERSION` bumped to 0.7.0) live in the canonical project-root copy at `C:\Users\adria\Documents\Claude\piano-srs-app\app.js`. They were not mirrored here in this run for session-token reasons — the PROGRESS.md entry for item 7 is the source of truth for the diff. |
| `styles.css` | Item 6 — same caveat as app.js. The item-7 additions are: `.viewer-placeholder` is now a flex column (max-width 720), with its own `.viewer-placeholder-welcome` carrying the centered-card treatment. New `.review-queue-panel` block with `-header`, `-count`, `-hint`, `-list`, `-item`, `-item-top`, `-item-name`, `-item-due` (+ `is-overdue` red / `is-due-today` amber), `-item-meta`, `-item-progress`. The canonical post-item-7 copy lives at the project root. |
| `tests/srs.test.mjs` | Item 7 — adds `buildReviewQueue` to the exported-surface list. |
| `tests/sections.test.mjs` | Item 6 — unchanged this run. |
| `tests/db.test.mjs` | Item 7 — adds `listAllSections` and `getRepCountsForDate` to the exported-surface list. |
| `tests/queue.test.mjs` | Item 7 — new file, ~20 assertion blocks. |

For per-day diffs, check the per-day folders under `snapshots/`. The
`snapshots/2026-04-27/` folder has the end-of-item-5 state, and
`snapshots/2026-04-26/` has the end-of-item-4 state. Each is a self-
contained source mirror at that point in time.
