# Progress log

## 2026-04-24 — Project scaffolded + roadmap item 1 (basic layout)

**Built today**

- Scaffolded the project directory with `README.md`, `ROADMAP.md`, `PROGRESS.md`, `snapshots/`, and `tests/`.
- Implemented roadmap item 1: a three-part shell — header, main area (sidebar "Piece Library" + viewer), and footer status bar. The sidebar shows an empty-state message; the viewer shows a welcome placeholder. The "+ Add piece" button is rendered but disabled, with a hover tooltip pointing to the next roadmap step.
- `app.js` is a small ES module with `setStatus()` and `renderPieceList()` exported so the next steps can compose against a stable surface instead of shoving DOM code into global scope.

**Files changed**

- `README.md` (new)
- `ROADMAP.md` (new, item 1 now checked)
- `PROGRESS.md` (this entry)
- `index.html` (new)
- `styles.css` (new)
- `app.js` (new)

**Design decisions**

- Layout uses CSS grid with a fixed 280px sidebar and a fluid viewer column — simple and robust, and it collapses to a stacked layout on narrow viewports as a placeholder until roadmap item 11 does proper mobile polish.
- Neutral warm-paper color palette (`#f7f7f5` background, `#6a4b2a` accent) — calm on the eyes during long practice sessions. Dark mode is explicitly deferred to item 11.
- JS is a `type="module"` script so later steps can import helpers cleanly; no bundler needed.
- The "Add piece" button is disabled rather than hidden so the affordance is visible and the upload flow in the next step has an obvious home.

**Verification**

- `node --check app.js` → OK.
- Manually cross-checked that every `getElementById` in `app.js` matches an `id="…"` in `index.html`.

**Next suggested step**

- Roadmap item 2: wire up PDF upload via the "Add piece" button + a file input, and render the selected PDF page-by-page with PDF.js from cdnjs. Keep the PDF in memory for now — persistence to IndexedDB is a separate step (item 3).

**Open design questions**

- Should the viewer render one page at a time with prev/next controls, or continuously scroll all pages? Continuous scroll feels closer to how pianists flip through sheet music. Decide during item 2 implementation.
- For section targeting (item 4), will "page number" mean the PDF page index or the printed page number on the sheet? Needs a decision before item 4.
