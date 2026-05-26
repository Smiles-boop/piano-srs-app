# PianoSRS Roadmap

Ordered incremental roadmap. Check items off as they ship.

- [x] 1. Basic page layout: sidebar (piece library) + main viewer area, with placeholder content.
- [x] 2. PDF upload via file input + PDF.js rendering of the selected piece (paginated).
- [x] 3. IndexedDB persistence: save uploaded PDFs and piece metadata; reload on app open.
- [x] 4. Section definition UI: create/edit/delete named sections attached to a piece, each with page number and a free-text measure range (e.g. "mm. 17–32").
- [x] 5. Review rep counter: for a selected section, a big "Successful repetition" button that increments toward a goal of 10 for today.
- [x] 6. SRS scheduling with SM-2: once a section reaches 10 reps for the day, compute and store its next-due date.
- [x] 7. Daily review queue: on app open, show all sections across all pieces that are due today; clicking one opens that piece to that section.
- [x] 8. Post-session rating: after 10 reps, prompt "Again / Hard / Good / Easy" and feed it into the SM-2 ease/interval update.
- [x] 9. Progress stats: daily streak, sections mastered, per-piece retention percentage.
- [x] 10. Export/import full library to JSON (user-managed backup).
- [x] 11a. Polish — keyboard shortcuts: space = log rep, 1-4 = pick rating, arrow keys = prev/next page, Esc = close practice/form.
- [x] 11b. Polish — dark mode toggle (CSS custom properties + localStorage preference).
- [x] 11c. Polish — mobile-friendly layout (hamburger sidebar toggle, responsive tweaks).
- [x] 12a. Optional extras — per-section notes / fingerings: free-text notes field on each section, visible in the section list and practice panel.
- [x] 12b. Optional extras — metronome widget.
- [x] 12c. Optional extras — practice-history chart.
- [x] 13. Delete piece UI: delete button on each sidebar entry with cascade cleanup (sections + rep logs + SRS data) and confirmation dialog.
- [x] 14. Auto-section by page: when a PDF is uploaded, automatically create one section per page so the user has something to practice immediately.
- [x] 15. Section-scoped crop view: users can define a vertical crop region on a PDF page per section. In practice mode, only the cropped portion of the page is shown, and non-relevant pages are hidden.
- [x] 16. Piece rename UI: inline rename via pencil button on sidebar entries; commit on Enter/blur, cancel on Escape.
- [x] 17. Section reorder via drag-and-drop: drag handle on each section row; drop to reorder; persisted via the existing `order` field in IndexedDB.
- [x] 18. Practice session timer: elapsed time display (m:ss / h:mm:ss) in the practice panel header with pause/resume button and `T` keyboard shortcut.
- [x] 19. Persist cumulative practice time per section: on session close, elapsed time is saved to IDB; total time shown as a badge on each section row.
- [x] 20. Cumulative time display: show total practice time in the practice panel header (next to the live timer) and per-piece total time in the stats panel retention list.
