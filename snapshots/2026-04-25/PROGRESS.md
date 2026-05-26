# Progress log

## 2026-04-25 — Roadmap item 3 (IndexedDB persistence)

**Built today**

- New `db.js` ES module wraps an IndexedDB v1 with one object store, `pieces`, keyed by `id`. Records are `{ id, title, pageCount, addedAt, pdfBlob }`. PDFs go in as `Blob` (not `ArrayBuffer`) so the browser can keep the bytes off the JS heap.
- Public surface: `openDb`, `listPieceMetadata` (drops blob), `getPieceBlob(id)`, `savePiece(record)`, `deletePiece(id)`. Plus two pure helpers exported for testing: `metadataFromRecord` and `pieceToRecord`.
- App init now calls `hydrateFromStorage()` — opens the DB, fetches metadata only, populates the in-memory `pieces` array (without `pdfDoc`/`pdfData`), and renders the sidebar. The status line distinguishes "Loaded N saved pieces" vs "Ready" vs "storage unavailable".
- Lazy PDF loading: `selectPiece` now `await ensurePdfLoaded(piece)` before rendering. If the in-memory piece doesn't already have a `pdfDoc`, we pull its Blob from IDB, instantiate a `PDFDocumentProxy`, cache it on the piece, then reconcile `pageCount` against the live doc.
- Upload flow persists to IDB *before* updating the in-memory list (`savePiece(pieceToRecord(piece, blob))`). Save failure is non-fatal — the piece still appears in memory with a clear "couldn't save it — refresh will lose it" status message, so the UI never lies.
- Welcome card copy updated to mention local persistence; bumped version to 0.3.0.
- Added `tests/db.test.mjs` with assertions covering both pure helpers (round-trip, blob-stripping, addedAt auto-fill, explicit `0` preservation, null-safety, full export surface).

**Files changed**

- `db.js` — new.
- `app.js` — refactored upload + select + init around the persistence layer; bumped `APP_VERSION` to 0.3.0.
- `index.html` — welcome card copy + footer version bumped to v0.3.0.
- `tests/db.test.mjs` — new.
- `ROADMAP.md` — item 3 checked off.
- `PROGRESS.md` — this entry.

**Design decisions**

- Lazy load on selection rather than eager hydrate. Pieces can each be tens of MB; instantiating every `pdfDoc` upfront would balloon memory for users with large libraries. Trade-off: the first click after refresh has a brief "Loading…" delay. Acceptable.
- `openDb()` caches its promise but clears it on rejection so a transient failure (private mode, quota prompt) can be retried by the next call.
- Storage failures degrade gracefully into in-memory mode rather than blocking upload. A piano practice session shouldn't stall because the browser is being weird about IDB.
- `pdfData` (the raw `ArrayBuffer`) is kept on the in-memory piece even after rendering, so future re-renders (zoom, repagination) won't re-hit IDB. We can drop this if memory becomes a concern in item 11.

**Verification**

- `node --check app.js` → exit 0.
- `node --check db.js` → exit 0.
- `node tests/db.test.mjs` → "db helpers: all assertions passed".
- `node tests/titleFromFilename.test.mjs` → all assertions passed (verified via a mirrored copy after a sandbox-mount staleness issue with the canonical project path; same code, same result).
- Manually traced the persistence path: upload → `pieceToRecord` → `savePiece(put)` → on next init, `listPieceMetadata(getAll)` → sidebar populated → click → `getPieceBlob(get)` → `loadPdfDocument` → render.

**Next suggested step**

- Roadmap item 4: section-definition UI. Each section attached to a piece, with `name`, `pageNumber` (PDF page index, per the open question), and a free-text measure range like "mm. 17–32". Add a `sections` object store to the IDB (key on `id`, index on `pieceId`) and a sidebar/sub-panel within the viewer showing the active piece's sections, with create/edit/delete affordances. The IDB schema can grow via a v2 upgrade — `db.js` already centralizes the version constant for that.

**Open design questions**

- Resolve the page-number question on the next run: lean PDF page index (1-based, matches the rendered "Page N" badges), but worth re-checking against how user prefers to navigate sheet music.
- For the sections store, do we want `pieceId` → `sections[]` aggregated under each piece record, or a separate `sections` object store with a `pieceId` index? Separate store is cleaner for "all due sections across all pieces" (item 7) and edits-without-rewriting-the-blob; expect to go with that.

## 2026-04-25 — Roadmap item 2 (PDF upload + PDF.js rendering)

**Built today**

- Wired the "+ Add piece" button to a hidden `<input type="file" accept="application/pdf">`; enabled the button and removed the "coming in step 2" tooltip.
- Loaded PDF.js v3.11.174 from cdnjs as a global script (non-module build) and configured its worker URL. Non-module build chosen deliberately so the app still works when `index.html` is opened via `file://` (ES-module CDN imports are blocked by CORS in that mode).
- On upload: read file → `pdfjsLib.getDocument({ data })` → stash piece (id, title, pageCount, raw ArrayBuffer, live `pdfDoc`) in an in-memory `pieces` array → auto-select it.
- Sidebar now renders real pieces with title + page-count meta, supports click/Enter/Space to select, and shows an `active` highlight on the current piece.
- Viewer renders every page as its own `<canvas>` in a continuous-scroll column (decided in favor of continuous scroll per the open question from 2026-04-24 — it matches how pianists flip through sheet music). Each page has a small "Page N" badge. Render scale is 1.5.
- Added `renderToken` guard so a slow render of an old PDF can't clobber the viewer if the user clicks another piece mid-render.
- Added pure helper `titleFromFilename(name)` with Node-side unit tests under `tests/`.

**Files changed**

- `index.html` — added PDF.js `<script>`, hidden file input, `#viewer-pdf` panel with `#pdf-pages` container. Bumped version to 0.2.0.
- `styles.css` — new styles for `.viewer-pdf`, `.pdf-pages`, `.pdf-page`, `.pdf-page-label`, `.visually-hidden`, piece-list meta row, and mobile viewer padding tweak.
- `app.js` — full rewrite of the upload/render pipeline around the stub `setStatus` / `renderPieceList` surface from day 1; added `titleFromFilename` (exported).
- `tests/titleFromFilename.test.mjs` — new.
- `ROADMAP.md` — item 2 checked off.
- `PROGRESS.md` — this entry.

**Design decisions**

- Continuous scroll, one canvas per page — resolves the 2026-04-24 open question. Prev/next nav, if wanted, can layer on in polish (item 11).
- PDFs stored as raw `ArrayBuffer` on the in-memory piece object. Keeping the bytes (not just the `pdfDoc`) makes next step's IndexedDB persistence a trivial blob-store call.
- Render scale fixed at 1.5 for now. Zoom controls are item 11 polish.
- Non-module PDF.js (global `pdfjsLib`) over module PDF.js. The app must run from `file://`, and ES-module CDN imports fail under that origin in most browsers.
- `titleFromFilename` is exported even though nothing outside `app.js` consumes it yet — having a pure, tested surface makes further title logic (e.g. user rename UI in item 4 or later) easier.

**Verification**

- `node --check app.js` → OK.
- `node tests/titleFromFilename.test.mjs` → all assertions passed.
- Manually traced every `getElementById` in `app.js` to a matching `id` in `index.html`.

**Next suggested step**

- Roadmap item 3: IndexedDB persistence. Open a DB (`pianosrs`) with an object store `pieces` keyed by id, storing `{ id, title, pageCount, pdfBlob }`. On app init, load all pieces and render them. On upload, write the piece to IDB before adding to the in-memory array. Defer a "delete piece" button to a later polish pass unless it falls out naturally.

**Open design questions**

- For section targeting (item 4), will "page number" mean the PDF page index or the printed page number on the sheet? Still undecided — leaning toward PDF page index (1-based, matches what's shown in the page badges).
- When a PDF is re-selected, we currently re-render every page from scratch. At ~20+ pages that could get slow. Worth considering a per-piece canvas cache in item 3 once we also have a persistence boundary to anchor it on.

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
