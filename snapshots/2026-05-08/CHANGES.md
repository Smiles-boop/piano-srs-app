# Snapshot 2026-05-08 — Item 20: Cumulative time display

## Summary
- Practice panel header now shows "Total: Xm" next to the live session timer
- Stats panel per-piece list includes total practice time column
- New helpers: `updatePracticeTotalTime()`, `computePieceTotalTime()`

## Files changed
- `index.html` — Added `practice-total-time` element, bumped to v0.19.0
- `app.js` — New functions, updated rendering, bumped APP_VERSION
- `styles.css` — New styles for practice total time and per-piece time column
- `tests/piece-total-time.test.mjs` — New test file
