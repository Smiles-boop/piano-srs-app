# 2026-05-06 — Items 18 & 19

## Item 18: Practice Session Timer
- `app.js` — Added timer functions, timer state in practiceState, T keyboard shortcut, v0.17.0
- `index.html` — Timer display + pause button in practice header, updated shortcuts hint
- `styles.css` — Timer group, timer, pause button styles
- `tests/timer.test.mjs` — Unit tests for formatElapsed

## Item 19: Persist Cumulative Practice Time
- `db.js` — Added `addPracticeTime()`, `totalPracticeMs` passthrough in `sectionToRecord`
- `app.js` — Added `formatTotalPracticeTime()`, persist on close, time badge in section list, v0.18.0
- `styles.css` — `.section-list-time-badge` style
- `index.html` — Bumped footer to v0.18.0
- `tests/practice-time.test.mjs` — Unit tests for formatTotalPracticeTime

## Summary
Run 1: Elapsed-time display in practice panel header with pause/resume toggle and T shortcut.
Run 2: On session close, elapsed time is atomically persisted to the section's totalPracticeMs field in IDB. Each section row shows cumulative time as a badge.
