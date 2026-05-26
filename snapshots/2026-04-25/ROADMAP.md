# PianoSRS Roadmap

Ordered incremental roadmap. Check items off as they ship.

- [x] 1. Basic page layout: sidebar (piece library) + main viewer area, with placeholder content.
- [x] 2. PDF upload via file input + PDF.js rendering of the selected piece (paginated).
- [x] 3. IndexedDB persistence: save uploaded PDFs and piece metadata; reload on app open.
- [ ] 4. Section definition UI: create/edit/delete named sections attached to a piece, each with page number and a free-text measure range (e.g. "mm. 17–32").
- [ ] 5. Review rep counter: for a selected section, a big "Successful repetition" button that increments toward a goal of 10 for today.
- [ ] 6. SRS scheduling with SM-2: once a section reaches 10 reps for the day, compute and store its next-due date.
- [ ] 7. Daily review queue: on app open, show all sections across all pieces that are due today; clicking one opens that piece to that section.
- [ ] 8. Post-session rating: after 10 reps, prompt "Again / Hard / Good / Easy" and feed it into the SM-2 ease/interval update.
- [ ] 9. Progress stats: daily streak, sections mastered, per-piece retention percentage.
- [ ] 10. Export/import full library to JSON (user-managed backup).
- [ ] 11. Polish: keyboard shortcuts (space = log rep, arrow keys = next/prev page), dark mode, mobile-friendly layout.
- [ ] 12. Optional extras (only once 1–11 done): per-section notes / fingerings, metronome widget, practice-history chart.
