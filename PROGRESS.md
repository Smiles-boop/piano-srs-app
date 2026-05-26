# Progress log

## 2026-05-08 — Item 20 (Cumulative time display)

**Built today**

- Practice panel header now shows "Total: Xm" (or Xh Ym) next to the live session timer, displaying the section's cumulative practice time across all previous sessions. Hidden when no time has been recorded yet.
- Stats panel per-piece retention list now includes a fourth column showing total practice time for each piece (summed from all its sections' `totalPracticeMs`). Shows "—" if no time recorded.
- Added `updatePracticeTotalTime(section)` helper called from `showPracticePanel()`.
- Added `computePieceTotalTime(pieceId)` helper used in `renderStats()`.
- After practice time is persisted on session close, `renderStats()` is now called to refresh per-piece totals immediately.

**Files changed**

- `index.html` — Added `<span id="practice-total-time">` in the practice timer group. Bumped footer to v0.19.0.
- `app.js` — Added `updatePracticeTotalTime()`, `computePieceTotalTime()`. Updated `showPracticePanel()`, `closePracticeView()`, `renderStats()`. Bumped `APP_VERSION` to 0.19.0.
- `styles.css` — Added `.practice-total-time` style. Extended `.stats-per-piece-row` grid to 4 columns. Added `.stats-per-piece-time` style. Updated mobile responsive grid.
- `tests/piece-total-time.test.mjs` — Unit tests for `computePieceTotalTime` and `formatTotalPracticeTime` edge cases.

**Next suggested step**

- Add a "total practice time across all pieces" summary tile in the stats panel header area, so users see their overall investment at a glance. Or consider a sort-by-time option in the piece library sidebar.

**Design decisions**

- Total time is shown left of the live timer with a subtle separator, so the user sees "Total: 1h 12m | 3:45 [Pause]" — cumulative context alongside the live session.
- Per-piece time is computed by summing in-memory section objects (no extra IDB query), keeping the stats render fast.
- The per-piece grid gains a 4th column (time) — uses a narrow 50px slot to avoid cramping the title or bar on small screens.

## 2026-05-06 — Item 19 (Persist cumulative practice time)

**Built today**

- When a practice session closes, the elapsed time (from the item-18 timer) is atomically added to the section's `totalPracticeMs` field in IndexedDB via a new `addPracticeTime()` function.
- Each section row in the sections panel now shows a "⏱ Xm" or "⏱ Xh Ym" badge displaying total time invested, visible once any time has been recorded.
- Added `formatTotalPracticeTime(ms)` helper for human-friendly time display (seconds/minutes/hours).
- In-memory section objects are updated after the IDB write resolves so the UI reflects new totals without a page reload.

**Files changed**

- `db.js` — Added `addPracticeTime(sectionId, elapsedMs)` function. Added `totalPracticeMs` passthrough in `sectionToRecord`.
- `app.js` — Added `formatTotalPracticeTime()`. Modified `closePracticeView()` to persist elapsed time before clearing state. Added time badge rendering in `renderSectionsPanel()`. Bumped `APP_VERSION` to 0.18.0.
- `styles.css` — Added `.section-list-time-badge` style.
- `index.html` — Bumped footer to v0.18.0.
- `tests/practice-time.test.mjs` — Unit tests for `formatTotalPracticeTime`.

**Next suggested step**

- Show total practice time in the practice panel header (next to the live timer) so users can see cumulative investment while practicing. Also consider a per-piece total time in the stats panel.

**Design decisions**

- Time is persisted on session close (not on every tick) to minimize IDB writes. A single atomic read-modify-write on the section record keeps it simple.
- `totalPracticeMs` lives directly on the section record (no schema bump needed — just an optional field). This avoids a new object store for what's a single counter per section.
- The in-memory section is updated after the async write resolves; if the write fails, the badge just won't update until next page load (graceful degradation).

## 2026-05-06 — Item 18 (Practice session timer)

**Built today**

- Elapsed-time display in the practice panel header showing mm:ss (or h:mm:ss for long sessions). Starts automatically when a practice session opens, resets on close.
- Pause/Resume button next to the timer — accumulates elapsed time correctly across pause cycles.
- `T` keyboard shortcut to toggle pause/resume while practicing.
- Timer uses a 1-second `setInterval` tick with a start-timestamp + accumulated-elapsed architecture, so pause/resume is accurate without drift.

**Files changed**

- `app.js` — Added `practiceTimerInterval` state, `formatElapsed()`, `getPracticeElapsed()`, `tickPracticeTimer()`, `startPracticeTimer()`, `stopPracticeTimer()`, `togglePracticeTimer()` functions. Timer state fields added to `practiceState`. `T` key added to keyboard handler. Bumped `APP_VERSION` to 0.17.0.
- `index.html` — Added `.practice-timer-group` with timer display and pause button in the practice panel header. Updated shortcuts hint. Bumped footer to v0.17.0.
- `styles.css` — Added `.practice-timer-group`, `.practice-timer`, `.practice-timer-pause-btn` styles.
- `tests/timer.test.mjs` — Unit tests for `formatElapsed` covering seconds, minutes, hours, and edge cases.

**Next suggested step**

- Persist cumulative practice time per section in IndexedDB so users can see total time invested in each section over days/weeks.

**Design decisions**

- Timer is purely in-memory (no IDB persistence yet) — keeps this slice small and reviewable. Persistence is a natural follow-on.
- Uses start-timestamp + accumulated-elapsed rather than incrementing a counter, so pausing doesn't lose sub-second precision and the display stays accurate even if the interval drifts slightly.
- Placed in the header row next to the Stop button — visible but unobtrusive.

## 2026-05-05 — Item 17 (Section drag-to-reorder)

**Built today**

- Drag-and-drop reordering for sections in the sections panel. Each section row now has a grip handle (≡) on the left that reveals on hover.
- Dragging a section over another highlights the drop target with an accent border. On drop, the DOM is reordered immediately and the new order is persisted atomically to IndexedDB via a new `reorderSections()` batch function.
- In-memory section array on the active piece is kept in sync so subsequent renders/practice-queue calculations respect the new order without a page reload.
- Visual feedback: dragged item goes semi-transparent with a dashed accent border; drop target gets a subtle accent background.

**Files changed**

- `db.js` — Added `reorderSections(updates)` function (batch `order` field update in a single transaction).
- `app.js` — Added `setupSectionDragAndDrop()` function, `draggedSectionLi` state, drag handle element in `renderSectionsPanel()`, wired in `init()`. Bumped `APP_VERSION` to 0.16.0.
- `styles.css` — Added `.section-drag-handle`, `.dragging`, `.drag-over` styles.
- `index.html` — Bumped footer to v0.16.0.

**Next suggested step**

- Touch/mobile drag support (HTML5 drag-and-drop doesn't fire on touch devices; consider a touch-move polyfill or move-up/move-down buttons as a mobile fallback).

**Design decisions**

- Used native HTML5 drag-and-drop API — zero dependencies, works well for mouse-based desktop use which is the primary target.
- Persists atomically in a single IDB transaction so a crash mid-reorder can't produce a half-updated state.
- The grip handle uses ≡ as a universally-recognised drag affordance; it's subtle (low opacity) until hovered to keep the UI clean.

## 2026-05-05 — Item 16 (Piece rename UI)

**Built today**

- Inline rename for pieces: a pencil (✎) button appears on hover/focus next to each piece in the sidebar. Clicking it replaces the title with an editable text input.
- Commit on Enter or blur; cancel on Escape. Empty/unchanged input reverts silently.
- New `renamePiece(id, newTitle)` function in `db.js` — does a get-then-put so the large PDF blob stays intact.
- If the renamed piece is currently active, the viewer header title updates immediately.
- Rename button styled with accent color on hover, matching the app's existing interactive palette.

**Files changed**

- `db.js` — Added `renamePiece()` function.
- `app.js` — Added `startInlineRename()` function, added rename button in `renderPieceList()`. Bumped `APP_VERSION` to 0.15.0.
- `styles.css` — Merged rename + delete button base styles, added `.piece-list-item-rename` hover state and `.piece-rename-input` styles.
- `index.html` — Bumped footer to v0.15.0.

**Next suggested step**

- Section reordering via drag-and-drop (the `order` field already exists on section records but there's no UI to change it).

**Design decisions**

- Used inline input replacement rather than a modal or prompt() — feels native and low-friction for a quick rename.
- Commit on blur ensures no accidental data loss if the user clicks away.
- The rename button is styled identically to the delete button (opacity-reveal on hover) but with accent color rather than danger color to differentiate intent.

## 2026-05-05 — Items 14–15 (Auto-sections + Section-scoped crop view)

**Built today**

- **Auto-section by page (item 14):** When uploading a PDF, one section per page is automatically created (named "Page 1", "Page 2", etc.) so the user can start practicing immediately without manually defining sections.
- **Section crop regions (item 15):** The section form now includes a "Select on page" button that lets the user drag vertically on a PDF page to define a crop region. The crop coordinates (normalised 0–1 fractions of page height) are stored on the section record via new `cropY1`/`cropY2` fields in `sectionToRecord()`. A "Clear crop" button removes the region.
- **Section-scoped practice view (item 15):** When entering practice mode for a section with crop data, only the cropped vertical band of the page is shown (other pages hidden). Exiting practice mode restores the full page view.

**Files changed**

- `db.js` — Added `cropY1`/`cropY2` optional fields to `sectionToRecord()`.
- `app.js` — Added auto-sectioning loop in `handlePdfFile()`. Added crop overlay system (`startCropSelection`, `teardownCropOverlay`, `updateCropStatusUI`), crop state variables (`pendingCrop`, `cropOverlayCleanup`), section-scoped view functions (`applySectionCrop`, `clearSectionCrop`). Wired crop data into section form open/submit/close. Added crop button listeners in `init()`. Bumped `APP_VERSION` to 0.14.0.
- `index.html` — Added crop region controls (button, clear button, status text) to the section form. Bumped footer to v0.14.0.
- `styles.css` — Added styles for crop controls, crop overlay, crop selection band, dim regions, crop highlight, and practice-mode crop clipping.
- `ROADMAP.md` — Added items 14 and 15, checked off.

## 2026-05-05 — Post-roadmap item 13 (Delete piece UI)

**Built today**

- Delete button on each piece in the sidebar, visible on hover/focus. Styled as a subtle × that turns red on hover, following the app's existing danger-color palette.
- Full cascade deletion: when confirmed, the handler gathers all section IDs for the piece, deletes their rep logs via a new `deleteRepLogsForSections()` cursor walk, then deletes the sections via `deleteSectionsForPiece()`, then the piece record via `deletePiece()`.
- `window.confirm` dialog warns that all sections, practice history, and SRS data will be permanently removed.
- If the deleted piece was the active piece, the viewer resets to the welcome/placeholder screen.
- After deletion, the review queue and stats panels refresh to reflect the removed sections.
- New `deleteRepLogsForSections(sectionIds)` function in `db.js`: walks the `bySectionId` index for each section and cursor-deletes all matching rep log records. This was the missing cascade piece — `deletePiece` and `deleteSectionsForPiece` already existed but had no UI, and rep logs were never cleaned up.
- Piece list items restructured: title+meta wrapped in a `.piece-list-item-info` div so the delete button can sit beside them in a row layout.
- Bumped `APP_VERSION` to 0.13.0 and footer to v0.13.0.

**Files changed**

- `db.js` — added `deleteRepLogsForSections()` export.
- `app.js` — imported `deletePiece`, `deleteSectionsForPiece`, `deleteRepLogsForSections`; added `handleDeletePiece()` function; restructured `renderPieceList()` to include info wrapper and delete button. Bumped `APP_VERSION`.
- `styles.css` — restructured `.piece-list-item` to row layout, added `.piece-list-item-info` and `.piece-list-item-delete` styles with hover reveal and danger-color hover state.
- `index.html` — bumped footer version to v0.13.0.

**Next suggested step**

- Piece renaming UI (inline edit on double-click or a rename button). Another quality-of-life gap now that pieces can be deleted but not renamed.

**Design decisions**

- Used `window.confirm` for consistency with existing destructive actions (reset reps, delete section). A custom modal would be prettier but adds complexity for no functional gain.
- Delete button only appears on hover/focus-within to keep the sidebar clean. On touch devices the button is always reachable via focus.
- Cascade order (rep logs → sections → piece) ensures no orphaned records if the operation is interrupted partway. Each step is independent so a partial failure leaves a recoverable state.

## 2026-05-04 — Roadmap item 12c (Practice-history chart)

**Built today**

- GitHub-style contribution heatmap showing the last 13 weeks (~91 days) of practice activity, rendered as inline SVG in the stats panel.
- New `listAllRepLogs()` function in `db.js`: walks the entire repLogs store and returns all records with count > 0, sorted by date. Powers the chart data aggregation.
- Heatmap uses adaptive intensity bucketing: rep counts are aggregated per day across all sections, then quartiles of the nonzero distribution determine the 5 fill levels (0=none, 1–4=Q1/Q2/Q3/above). This means the chart auto-scales to the user's practice volume — someone doing 5 reps/day and someone doing 50 reps/day both get meaningful color differentiation.
- Day-of-week labels (Mon/Wed/Fri) on the left, month labels above the grid, native SVG `<title>` tooltips on hover showing "X reps on May 4, 2026".
- Warm brown palette matching the app's accent color scheme, with dark-mode overrides.
- Legend bar ("Less → More") with colored swatches below the chart.
- Chart container scrolls horizontally on narrow viewports for mobile friendliness.
- Added `tests/history-chart.test.mjs` covering quantile computation, date formatting, and level bucketing — all passing.
- Bumped `APP_VERSION` to 0.12.2 and footer to v0.12.2.

**Files changed**

- `db.js` — added `listAllRepLogs()` export.
- `index.html` — added `#stats-history-chart` section with container and legend inside the stats panel, bumped footer version.
- `styles.css` — added `.stats-history-chart-*` styles, heatmap cell/label classes, legend layout, dark-mode overrides.
- `app.js` — imported `listAllRepLogs`, added chart element refs, added `refreshHistoryChart()` / `renderHeatmap()` / `formatLocalISO()` / `formatReadableDate()` / `quantile()` functions, wired chart refresh into `refreshStats()`. Bumped `APP_VERSION`.
- `tests/history-chart.test.mjs` — new test file covering pure helpers.

**Next suggested step**

- All 12 roadmap items are now complete. Consider: UX polish pass (hover interactions on heatmap cells, click-to-filter by day), accessibility audit, or expanding the chart to show per-piece breakdowns.

**Design decisions**

- Used SVG `<rect>` elements rather than Canvas for the heatmap — SVG gives us native tooltips, CSS-driven theming (dark mode works via CSS attribute selectors), and accessibility via `role="img"` + `aria-label`.
- Quartile-based bucketing adapts to the user's actual practice volume, unlike fixed thresholds which would look washed out for light practitioners or all-dark for heavy ones.
- Chart shows 13 weeks (one quarter) rather than a full year — a quarter is enough to see trends and momentum, and keeps the SVG compact enough to fit without scrolling on most screens.
- The chart refreshes once on app open (via `refreshStats`) and doesn't live-update per rep click — the history view is a "how has my week/month been?" affordance, not a per-click feedback loop. The daily stats tiles already handle immediate feedback.

## 2026-05-04 — Roadmap item 12b (Metronome widget)

**Built today**

- New `metronome.js` module: self-contained Web Audio API metronome. Uses OscillatorNode for synthesised click tones scheduled ahead via AudioContext.currentTime for drift-free timing. Downbeat (beat 1 of a 4-beat bar) plays at 1000 Hz, other beats at 700 Hz. Supports BPM range 30–300.
- Tap-tempo: tap the "Tap" button 2+ times within 3 seconds and BPM auto-updates to the average inter-tap interval. Auto-starts the metronome on first tap for convenience.
- Metronome widget UI in the practice panel: BPM input with −/+ adjustment buttons (±5), Start/Stop toggle, Tap button, and a beat indicator dot that flashes on each click (green for downbeat, accent for other beats).
- Keyboard shortcut: `M` toggles the metronome on/off when the practice panel is open.
- Metronome auto-stops when the user closes the practice panel, so it doesn't keep ticking in the background.
- Added `tests/metronome.test.mjs` covering BPM clamping, start/stop state, tap-tempo averaging, and onTick registration — all passing.
- Bumped `APP_VERSION` to 0.12.1 and footer to v0.12.1.

**Files changed**

- `metronome.js` — new module (Web Audio metronome with tap-tempo).
- `index.html` — added metronome widget section in practice panel, updated shortcuts hint to include `M`, bumped footer version.
- `styles.css` — added `.metronome-*` styles (widget container, BPM controls, beat indicator flash, toggle button running state).
- `app.js` — imported `createMetronome`, added metronome element refs, added metronome helper functions (ensure/sync/toggle/tap/stop), wired event listeners in `init()`, added `M` keyboard shortcut, calls `stopMetronome()` in `closePracticeView()`. Bumped `APP_VERSION`.
- `tests/metronome.test.mjs` — new test file with AudioContext mock and 5 test suites.

**Next suggested step**

- Roadmap item 12c: practice-history chart — a visual chart (e.g. bar chart or heatmap) showing practice activity over time, built with vanilla SVG or Canvas.

**Design decisions**

- Used Web Audio API with look-ahead scheduling (100ms buffer, 25ms timer loop) for precision — setTimeout alone would drift due to JS event-loop jitter.
- Triangle wave for a softer "click" than a square wave; 60ms decay envelope keeps it short and percussive.
- Metronome state is in-memory only (no IndexedDB persistence). Users typically set tempo per practice session, not per section, so persisting seemed like over-engineering.
- The `globalThis.AudioContext` lookup (instead of `window.AudioContext`) makes the module testable in Node with a simple mock.

## 2026-05-04 — Roadmap item 12a (Per-section notes / fingerings)

**Built today**

- Added an optional `notes` field to section records in `db.js` (`sectionToRecord`). The field defaults to `''` for sections that don't have notes, so existing data is unaffected — no IDB schema bump needed.
- Added a "Notes / fingerings" `<textarea>` to the section create/edit form. Maxlength 2000, 3-row default, with a placeholder showing example fingering notation.
- Section list rows now display a 2-line truncated italic snippet of the notes below the page/measures meta line (CSS `-webkit-line-clamp: 2`).
- Practice panel header now shows the full notes text in a dashed-border box below the section meta, scrollable if notes exceed 120px. Hidden when the section has no notes.
- Updated existing `sectionToRecord` tests for the new `notes` field and added three new test cases (passthrough, missing, non-string).
- Bumped `APP_VERSION` to 0.12.0 and footer to v0.12.0.

**Files changed**

- `db.js` — added `notes` field to `sectionToRecord`.
- `index.html` — added `#section-notes-input` textarea in section form, `#practice-section-notes` paragraph in practice panel, bumped footer version.
- `styles.css` — added `.section-form-field-notes` textarea styles, `.section-list-notes` 2-line clamp snippet, `.practice-section-notes` display box.
- `app.js` — wired `sectionNotesInput` and `practiceSectionNotes` in `els`; updated `openSectionForm`, `handleSectionFormSubmit`, `renderSectionsPanel`, `showPracticePanel` to handle notes; bumped `APP_VERSION`.
- `tests/sections.test.mjs` — updated `deepEqual` expectation for `notes: ''`; added 3 new notes test cases.

**Next suggested step**

- Roadmap item 12b: metronome widget — a simple tap-tempo or BPM-input metronome that plays a click sound, useful during practice sessions.

**Design decisions**

- Notes are a simple free-text field (not structured fingering notation) because pianists have wildly different notation preferences. The placeholder guides them but doesn't constrain.
- Notes are shown in the practice panel so they're visible during a session without needing to open the edit form.
- No IDB schema bump required — `notes` is just an optional string field on the section record, defaulting to `''`.

## 2026-04-30 — Roadmap item 11c (Mobile-friendly layout)

**Built today**

- Hamburger sidebar toggle: a `☰` button in the header, visible only at ≤720px via CSS `display: none` on desktop. Toggles `body.sidebar-open` class.
- Sidebar becomes a fixed-position slide-out drawer on mobile: `position: fixed; transform: translateX(-100%)` when closed, `translateX(0)` when open, with a 0.25s CSS transition. Width is `min(300px, 85vw)` so it doesn't exceed the viewport on very small screens.
- Semi-transparent backdrop (`rgba(0,0,0,0.35)`) sits behind the drawer at z-index 199 (drawer is 200). Clicking the backdrop closes the sidebar.
- Selecting a piece auto-closes the sidebar on mobile so the viewer is immediately visible.
- Responsive tweaks: header height reduced to 52px, tagline hidden, theme toggle icon-only, keyboard shortcuts hint hidden (no physical keyboard on mobile), tighter padding throughout, larger touch targets on piece list items and review queue items.
- Extra-small breakpoint (≤400px): review queue item top stacks vertically, practice counter/goal font sizes shrink, sidebar footer buttons stack vertically.
- Consolidated all mobile `@media` queries into a single block at the bottom of styles.css (removed duplicates from earlier roadmap items).
- Bumped `APP_VERSION` to 0.11.2 and footer to v0.11.2.

**Files changed**

- `index.html` — added `#sidebar-toggle` button in header, `#sidebar-backdrop` div, `id="sidebar"` on aside, bumped footer version.
- `styles.css` — added `.sidebar-toggle`, `.sidebar-backdrop` desktop-hidden rules; consolidated `@media (max-width: 720px)` block with drawer, backdrop, and responsive tweaks; added `@media (max-width: 400px)` extra-small breakpoint.
- `app.js` — added `isMobileViewport()`, `openSidebar()`, `closeSidebar()`, `toggleSidebar()` functions; wired toggle + backdrop click in `init()`; added `closeSidebar()` call in `selectPiece()` for mobile; added element refs for sidebar, backdrop, toggle.

**Design decisions**

- **Fixed-position drawer, not a collapsible in-flow panel.** A drawer overlaying the content is the standard mobile pattern — the user's mental model is "swipe to browse, tap to select, drawer goes away." An in-flow panel would push the viewer down and waste vertical space.
- **Backdrop click to close, not swipe-to-dismiss.** Swipe gestures conflict with PDF scrolling and are fragile to implement without a gesture library. Backdrop tap is universally understood and zero-dependency.
- **CSS transition, not JS animation.** `transform: translateX` is GPU-composited and buttery smooth. No need for requestAnimationFrame or a library.
- **Keyboard shortcuts hint hidden on mobile.** No physical keyboard on phones/tablets — showing the hint wastes space and confuses users.

**Next suggested step**

- Item 12: optional extras — per-section notes/fingerings, metronome widget, practice-history chart.

---

## 2026-04-30 — Roadmap item 11b (Dark mode)

**Built today**

- Full dark mode support via CSS custom properties. All ~30 hard-coded semantic colors (error, success, warning, due-today, overdue, rating buttons, practice highlights, next-review card, page labels) extracted into `--var` custom properties in `:root` and overridden in `html.dark`.
- Dark palette: warm-neutral dark backgrounds (`#1a1a1e` / `#242428` / `#2c2c31`), muted gold accent (`#c9a87a`), and desaturated semantic colors that maintain the same hue relationships as light mode without being harsh on the eyes.
- Toggle button in the header: moon/sun icon + "Dark"/"Light" label. Positioned `margin-left: auto` so it sits at the far right of the header without disturbing existing layout.
- Persistence via `localStorage` key `pianoSrsTheme`. Falls back gracefully if localStorage is unavailable (file:// with strict settings).
- OS preference detection: if no saved preference exists, respects `prefers-color-scheme: dark` media query. Otherwise defaults to light.
- Theme applied in `init()` before any rendering, so there's no flash of wrong theme on load.
- `D` keyboard shortcut added to the global keydown handler (same input-focus guard as other shortcuts). Hint added to the practice panel shortcuts line.
- Bumped `APP_VERSION` to 0.11.1 and footer to v0.11.1.

**Files changed**

- `styles.css` — extracted all hard-coded colors into CSS custom properties in `:root`; added full `html.dark` override block; added `.theme-toggle` button styles.
- `index.html` — added `#theme-toggle` button in the header; updated shortcuts hint to include `D`; bumped footer version.
- `app.js` — added `applyTheme`, `getInitialTheme`, `toggleTheme` functions; wired toggle button click in `init()`; added `D`/`d` case to `handleGlobalKeydown`; bumped `APP_VERSION`.
- `ROADMAP.md` — item 11b checked off.
- `PROGRESS.md` — this entry.

**Design decisions**

- **All colors via custom properties, not `filter: invert()` or a CSS `color-scheme` hack.** Custom properties give precise control over every surface. `filter: invert()` mangles images (PDF pages would go negative). `color-scheme: dark` only affects browser chrome and form controls, not custom UI.
- **Gold accent (`#c9a87a`) in dark mode rather than keeping the brown.** The light-mode brown (`#6a4b2a`) disappears against dark backgrounds. A warm gold keeps the same warm-wood-piano feel but with enough luminance contrast (≈5:1 against `#1a1a1e`).
- **Toggle in header, not a floating button or system tray.** The header has stable space at the right edge. A floating button would overlap PDF pages or the practice panel. System tray isn't available in a file:// web app.
- **`D` shortcut, not `T` for "theme".** `T` is too close to common text-entry keys and might be wanted for future features (timer, tempo). `D` for "dark" is mnemonic and unlikely to conflict.

**Next suggested step**

- Item 11c: mobile-friendly layout (hamburger sidebar toggle, responsive tweaks).

---

## 2026-04-29 — Roadmap item 11a (Keyboard shortcuts)

**Built today**

- Global `keydown` handler wired up in `init()` with an input-focus guard: shortcuts are suppressed when the active element is an `<input>`, `<textarea>`, or `contentEditable` — so typing a section name or measure range can't accidentally log reps or flip pages.
- **Space** = log a successful repetition. Only fires when the practice panel is visible AND the rep button is enabled (count < goal, no save in flight). `e.preventDefault()` suppresses the default scroll-down behavior.
- **1 / 2 / 3 / 4** = pick Again / Hard / Good / Easy when the rating prompt is visible. Maps directly to the existing `handleRatingClick` with the corresponding `RATING_*` constant and label. Only fires when `practiceState.ratingInFlight` is false (same guard as the button click handler).
- **ArrowLeft / ArrowRight** = scroll to the previous / next PDF page. New `scrollByPage(direction)` helper finds the page element closest to the viewport top via `getBoundingClientRect`, then steps one page in the requested direction and calls `scrollIntoView({ behavior: 'smooth' })`. Clamped at first/last page. Only fires when the PDF viewer is visible.
- **Escape** = close the practice panel if open; otherwise close the section form if open. Matches the existing Esc-on-form behavior but extends it to the practice panel.
- Keyboard shortcuts hint rendered below the secondary actions in the practice panel: `Space log rep · 1-4 rate · ←→ page · Esc stop`. Uses `<kbd>` elements styled as small key caps (border + shadow + mono-weight font) so the hint is visually discoverable but subdued.
- Bumped `APP_VERSION` to 0.11.0 and the footer version badge to v0.11.0.
- Split roadmap item 11 into three sub-items (11a keyboard shortcuts, 11b dark mode, 11c mobile layout) so each slice is independently trackable.

**Files changed**

- `app.js` — added `handleGlobalKeydown` and `scrollByPage` functions. Wired `document.addEventListener('keydown', handleGlobalKeydown)` in `init()`. Updated architecture comment to document item 11. Bumped `APP_VERSION` to 0.11.0.
- `index.html` — added `.practice-shortcuts-hint` paragraph with `<kbd>` elements inside the practice panel, below secondary actions. Bumped footer version to v0.11.0.
- `styles.css` — new `.practice-shortcuts-hint` block (centered, subdued, 11px) and global `kbd` style (inline-block key cap with border + shadow).
- `ROADMAP.md` — item 11 split into 11a/11b/11c; 11a checked off.
- `PROGRESS.md` — this entry.

**Design decisions**

- **Input-focus guard via `tagName` check, not a class or data-attribute.** The guard fires on every keydown, so it has to be cheap. Checking `document.activeElement.tagName === 'INPUT'` is a single property lookup — no DOM traversal, no class list scan. The `isContentEditable` check is belt-and-braces for future rich-text inputs (we don't have any today, but it's zero-cost to include).
- **Space-to-log fires `handleRepClick` directly, not a synthetic click on the button.** Synthetic clicks can trigger unexpected focus/blur side effects and don't behave identically across browsers. Calling the handler directly means the keyboard path and the mouse path share exactly the same code — no divergence risk.
- **1-4 for ratings, not letter keys (A/H/G/E).** Number keys are positional (left-to-right on the keyboard matches left-to-right on the prompt), discoverable (the hint says "1-4"), and won't conflict with future text-entry shortcuts. Letter keys risk confusion when the user has a different mental model of the button order.
- **`scrollByPage` finds the nearest page by `getBoundingClientRect` distance from viewport top, not by tracking a "current page" index.** Eliminates a piece of state to maintain and is always correct regardless of how the user arrived at their current scroll position (mouse wheel, scroll bar, click-to-scroll from section list, resize).
- **Escape priority: practice panel > section form.** If the user is practicing, Esc stops practice (the more "active" state). If not practicing, Esc closes the form. This matches the visual hierarchy — the practice panel is the most prominent surface when open.
- **Shortcuts hint is static HTML, not dynamically rendered.** The hint text never changes (it's the same shortcuts regardless of state), so there's no reason to rebuild it on every render cycle. Static markup is simpler and cheaper.

**Verification**

- `node --check` on the new keyboard shortcut code (isolated extract) → OK.
- `node imports_smoke.mjs` (mirrored) → "imports smoke: all 32 symbols resolve" — every named symbol app.js imports from db.js + srs.js still resolves cleanly.
- `node tests/db.test.mjs` → "db helpers: all assertions passed" (no regressions).
- `node tests/backup.test.mjs` → "backup helpers: all assertions passed" (no regressions).
- Cross-checked every `getElementById('…')` in app.js (51 unique ids) against `id="…"` in index.html — all match (no new IDs were added; keyboard shortcuts work through existing DOM references).
- Read the `handleGlobalKeydown` and `scrollByPage` functions directly — brace balance, switch cases, guard conditions all check out.

**Next suggested step**

- Roadmap item 11b: dark mode. The CSS already uses custom properties for all colors (`--bg`, `--surface`, `--text`, etc.), so dark mode is a matter of defining a `[data-theme="dark"]` override block on `:root` with inverted colors, plus a toggle button in the header. Persist the preference in `localStorage` (not IDB — it's a UI preference). Use `prefers-color-scheme: dark` as the initial default, with the manual toggle overriding the system preference.

**Open design questions**

- For item 11b dark mode: should the toggle be a button in the header, a toggle in the sidebar footer (next to export/import), or a settings gear icon? Lean header — it's the most discoverable spot and dark mode is a global preference, not a library operation.
- For item 11c mobile layout: the sidebar currently collapses to a stacked layout at <720px with a 40vh max-height. A hamburger toggle would let it collapse to zero height by default, with a tap to expand. Worth considering whether the practice panel should also get a sticky bottom-bar treatment on mobile (the rep button is the primary interaction during a session).

## 2026-04-29 — Roadmap item 10 (Export/import library to JSON)

**Built today**

- Export button in the sidebar footer. Clicking it walks all three IDB stores (pieces, sections, repLogs) in a single readonly transaction for consistency, converts each piece's PDF Blob to a base64 string, and downloads a timestamped `pianosrs-backup-YYYYMMDD.json` file via a temporary `<a>` element.
- Import button in the sidebar footer. Clicking it opens a file picker (`.json` only), parses the file, shows a confirm dialog summarising what will be imported (N pieces, M sections), then writes everything into IDB using the 'rename' collision policy. After import, the entire in-memory state (pieces array, active piece, practice state, queue, stats) is flushed and re-hydrated from storage so the sidebar, queue, and stats all reflect the imported data.
- Collision policy resolved: **rename** (default). When an imported record's ID collides with an existing one, the import generates a fresh ID and prefixes the piece title with "(imported)". This ensures the user never silently loses data by importing a backup over their live library. The `importLibrary` function also supports `skip` and `overwrite` modes for future UI if needed, but the default is always rename.
- Export format: `{ version: 1, exportedAt, pieces: [...], sections: [...], repLogs: [...] }`. PDFs are base64-encoded inside the JSON. This bloats size ~33% vs raw bytes but keeps the format completely self-contained and round-trippable without a ZIP library dependency. Acceptable for a personal library of a handful of PDFs; a future v2 could use JSZip.
- New pure helpers `arrayBufferToBase64(buffer)` and `base64ToArrayBuffer(base64)` in `db.js`, exported for testing. Both use the standard `btoa`/`atob` path available in all modern browsers.
- Import remaps IDs consistently across all three stores: if a piece gets a new ID, all its sections' `pieceId` fields are updated to match; if a section gets a new ID, all its rep logs' `sectionId` and composite `id` fields are recomputed. This keeps referential integrity intact across the entire import.
- New `exportLibrary()` async function in `db.js`. Walks pieces/sections/repLogs in a single readonly transaction, converts PDF blobs to base64, returns a plain object ready for `JSON.stringify`.
- New `importLibrary(data, opts)` async function in `db.js`. Validates the version field, reads existing IDs for collision detection, applies the chosen mode (rename/skip/overwrite), and writes records one-by-one with proper ID remapping.
- `handleExport()` and `handleImportFile(file)` in `app.js` wire the buttons to the `db.js` surface. Import flushes and re-hydrates the full in-memory state after writing to IDB.
- Sidebar footer with export/import buttons, styled to match the sidebar's visual language (border-top separator, compact buttons).
- Bumped `APP_VERSION` to 0.10.0 and the footer version badge to v0.10.0.
- Added `tests/backup.test.mjs` with assertion blocks covering: base64 round-trip for various byte patterns (empty, ASCII "Hello" known vector, all 256 byte values, 1024-byte large buffer), padding variants (0/1/2 padding chars), and an exported-surface check for the four new names.
- Extended `tests/db.test.mjs` exported-surface list to include `exportLibrary`, `importLibrary`, `arrayBufferToBase64`, `base64ToArrayBuffer`.

**Files changed**

- `db.js` — added `exportLibrary`, `importLibrary`, `blobToArrayBuffer` (private), `arrayBufferToBase64`, `base64ToArrayBuffer`. No schema bump (still v3).
- `app.js` — added `exportLibrary` and `importLibrary` to the `db.js` import block. Added `els.exportBtn`, `els.importBtn`, `els.importFileInput`. New `handleExport` and `handleImportFile` functions. Button wiring in `init`. Updated architecture comment to document item 10. Bumped `APP_VERSION` to 0.10.0.
- `index.html` — added `.sidebar-footer` with export/import buttons and a hidden file input for JSON import. Bumped footer version to v0.10.0.
- `styles.css` — new `.sidebar-footer` block (border-top, flex row, compact buttons).
- `tests/backup.test.mjs` — new (~15 assertion blocks).
- `tests/db.test.mjs` — added the four item-10 names to the exported-surface check.
- `ROADMAP.md` — item 10 checked off.
- `PROGRESS.md` — this entry.

**Design decisions**

- **Base64-in-JSON, not ZIP**. Resolves the open question from item 9. Base64 bloats size 33% but keeps the format completely self-contained — one `.json` file, no external library needed. For a personal piano library (typically 3–10 PDFs, each 1–5 MB), the exported JSON will be 4–65 MB — large but manageable. A future v2 format with JSZip can reduce this if users report real-world issues. The `version: 1` field in the export allows the importer to detect and handle format upgrades.
- **Rename collision policy by default**. The user's live library is sacred — importing a backup should never silently destroy data. Fresh IDs + "(imported)" prefix makes collisions obvious and harmless. The `skip` and `overwrite` modes exist in the function signature for future UI (e.g. a "restore" flow that intentionally overwrites), but the button always uses `rename`.
- **Full state flush on import**. After import, `pieces.length = 0` + `hydrateFromStorage()` is simpler and more correct than trying to incrementally merge the imported records into the live in-memory state. The cost is a brief visual reset (sidebar re-renders, queue re-hydrates), but for an import operation that happens rarely, this is the right trade-off.
- **Single readonly transaction for export**. Walking all three stores inside one transaction ensures the export is a consistent snapshot — no risk of a section appearing without its piece, or a rep log appearing without its section. The transaction is readonly so it doesn't block other tabs.
- **ID remapping cascades across all three stores**. If a piece gets a new ID, its sections' `pieceId` fields are remapped; if a section gets a new ID, its rep logs' `sectionId` and composite `id` are recomputed. This keeps referential integrity intact even under rename mode. Without this, an imported section would point at a piece ID that doesn't exist in the current library.
- **Confirm dialog before import**. Shows the user "Import N pieces and M sections from this backup? Existing data won't be overwritten." One click to proceed, one click to cancel. Prevents accidental imports.
- **No "restore" mode yet**. A true "restore from backup" flow (wipe existing data, then import) is a destructive operation that deserves its own UI (e.g. a modal with a big red "this will delete everything" warning). Out of scope for item 10; can be added as item 12 polish if needed.

**Verification**

- `node /tmp/piano/tests/backup.test.mjs` → "backup helpers: all assertions passed" (~15 assertion blocks covering base64 round-trips, known vectors, all 256 byte values, large buffers, padding variants, exported-surface check).
- `node /tmp/piano/tests/db.test.mjs` → "db helpers: all assertions passed" (now includes the four item-10 names in the exported-surface check).
- `node /tmp/piano/imports.smoke.mjs` → "imports smoke: all 32 symbols resolve" (every named symbol app.js imports from db.js + srs.js resolves cleanly).
- Cross-checked every `getElementById('…')` in `app.js` (51 unique ids, including the 3 new `export-btn`, `import-btn`, `import-file-input`) against `id="…"` in `index.html` — all match.
- Verification was run by mirroring source files into `/tmp/piano/` and running Node there, since the canonical project path under `C:\Users\adria\Documents\` isn't directly mounted in the workspace shell.

**Next suggested step**

- Roadmap item 11: polish. Keyboard shortcuts (space = log rep, arrow keys = next/prev page, 1–4 = rating buttons), dark mode toggle, mobile-friendly layout improvements. The keyboard shortcuts are the highest-value sub-item — space-to-log is the main practice interaction and saves the user from reaching for the mouse on every rep. Dark mode is a CSS-only change (CSS custom properties are already in place for all colors). Mobile layout mostly works from the existing breakpoints but could use a hamburger sidebar toggle.

**Open design questions**

- For item 11 keyboard shortcuts: should space-to-log work globally (anywhere on the page) or only when the practice panel is focused? Global is more convenient for a piano practice session (hands on the keyboard), but could interfere with typing in the section form. Lean toward global with a guard: only fire if the practice panel is visible AND no text input is focused.
- For item 11 dark mode: persist the preference in localStorage (not IDB — it's a UI preference, not library data). Use `prefers-color-scheme: dark` as the default, with a manual toggle that overrides the system preference.
- For a potential item 12 extra: a "restore from backup" mode that wipes and replaces the entire library. This would use `importLibrary(data, { mode: 'overwrite' })` after a `deletePiece` + `deleteSectionsForPiece` + delete-all-repLogs sweep. Worth building only if users request it — the current rename-import is non-destructive and covers the main use case (transferring a library to a new browser).

## 2026-04-29 — Roadmap item 9 (Progress stats panel)

**Built today**

- New "Progress" panel at the top of the welcome placeholder. Three big tiles (daily streak, sections mastered, sections in rotation) sit above a per-piece retention list, with a header line that reads "X / Y done today" so the first thing the user sees on app open is "what's the state of my practice right now?". The panel hides itself if the library is empty so a fresh app doesn't show a wall of zeros.
- `MASTERY_INTERVAL_DAYS = 21` constant in `srs.js` plus `isSectionMastered(section)` — a section counts as mastered once SM-2 has stretched its interval to three weeks or more (one Good past the third review at default ease). The threshold lives in `srs.js` so every surface that asks "is this mastered?" agrees, and so the rule is unit-testable.
- New pure helper `computeDailyStreak(practiceDates, todayISO)` in `srs.js`. Walks back from `todayISO` (or yesterday if today has no reps yet) and counts consecutive days with at least one rep. Resolves the open question from yesterday with the looser of the two leans: a "consecutive practice days" streak is the MVP, with the strictest "due-AND-skipped" version flagged in the docstring as a future schema-bump refinement (we don't currently persist a per-day snapshot of due dates, which is what the strict version needs).
- New pure helper `summariseProgress({ sections, pieces, practiceDates, repCountsToday, todayISO, repGoal })` in `srs.js`. Returns the bundle the panel renders: `sectionsTotal`, `sectionsRated`, `sectionsMastered`, `dailyStreak`, `todayDoneCount`, `todayDueCount`, `piecesTotal`, plus a `perPiece` array sorted by mastery percentage descending (strongest pieces first; alphabetical title tie-break). Pure — no IDB, no DOM, takes an explicit `todayISO`. Accepts `repCountsToday` as a Map or plain object.
- New IDB helper `listDistinctPracticeDates()` in `db.js`. Walks the `byDateISO` index on the rep-logs store with `openKeyCursor(null, 'nextunique')` so IDB does the dedupe natively — we don't pay to materialise one record per (section, day) pair just to read the date back out. No schema bump (the index has been there since item 5 specifically anticipating this).
- `app.js` wires everything together: a new `statsState = { practiceDates: Set, dateISO }` snapshot, hydrated once via `refreshStats()` on app open. Subsequent rep-log changes mutate the snapshot in place via `noteRepLogActivity(dateISO)` so the streak counter ticks up the moment the user logs their first rep of the day, without an extra IDB walk per click. New `renderStats()` is hooked into the same call-sites that already re-render the queue (`handleSectionFormSubmit`, `handleDeleteSection`, `handleRepClick` finally, `handleUndoRep` finally, `handleResetReps` finally, `handleRatingClick` finally) so the panel stays in sync as the user practices.
- DOM constructed by hand with `createElement` + `textContent` — no `innerHTML` template-string concatenation, even though the only user-supplied text is piece titles. Defense in depth.
- Per-piece retention rows render a horizontal mastery bar (with `role="progressbar"` + `aria-valuenow` for accessibility) plus a `Mastered/Total` tooltip. The bar fill is the warm accent color so the visual hierarchy reads "X% mastered" at a glance.
- Today's-progress header line is rating-explicit: "3 / 5 done today" while in flight, "5 / 5 done today" with a green tint once everything due is finished, "Nothing due today" if the queue is empty, "X done today" if the user practiced sections that weren't due (so a power-practice doesn't read as "0 done").
- New CSS for `.stats-panel` (warm-paper card matching the queue panel's visual language) plus `-header`, `-today` (with `is-complete` green variant), `.stats-tiles` (3-col grid that stacks on mobile), `.stats-tile` (with `-value` / `-label` / `-detail`), `.stats-per-piece` (with `-title`, `-list`, `-row`, `-title-cell`, `-bar`, `-bar-fill`, `-pct`).
- Bumped `APP_VERSION` to 0.9.0 and the footer version badge to v0.9.0.
- Added `tests/stats.test.mjs` with ~50 assertion blocks covering every new pure helper: `MASTERY_INTERVAL_DAYS` constant; `isSectionMastered` (null/undefined/non-object → false; fresh section → false; 6d / 20d intervals → false; 21d / 60d intervals → true; interval-without-lastReviewedDate → false; garbage interval values → false); `computeDailyStreak` (empty/null/undefined → 0; today-only → 1; today+yesterday → 2; five-day streak; ends-yesterday-but-not-today → counts from yesterday backwards; gap two days back → 1; no recent activity → 0; Set input; deduplication; bad ISO entries dropped silently; month boundary; year boundary; todayISO validation throws); `summariseProgress` (empty → all zeros; todayISO validation; realistic mixed-library scenario with 2 pieces × 5 sections, 1 mastered, 4 rated, 3 due today, 1 done today, 3-day streak; rep-counts as plain object; missing-piece passthrough; custom rep goal; sort tie-break by piece title; malformed sections silently dropped; exported-surface check). Extended `tests/srs.test.mjs` exported-surface list to include the four new names.
- Extended `tests/db.test.mjs` exported-surface list to include `listDistinctPracticeDates`.

**Files changed**

- `srs.js` — added `MASTERY_INTERVAL_DAYS`, `isSectionMastered`, `computeDailyStreak`, `summariseProgress`. No other changes (everything else still pure).
- `db.js` — added `listDistinctPracticeDates`.
- `app.js` — added `listDistinctPracticeDates` to the `db.js` import block, added `summariseProgress` to the `srs.js` import block. Added 10 new `els.stats*` references. New `statsState` + `refreshStats` + `renderStats` + `noteRepLogActivity`. Hooks into `hydrateFromStorage` (refresh after queue), `handleRepClick` (`noteRepLogActivity` + `renderStats` in the finally), `handleUndoRep` (`renderStats` in the finally), `handleResetReps` (`renderStats` in the finally), `handleRatingClick` (`renderStats` in the finally), `handleSectionFormSubmit` + `handleDeleteSection` (`renderStats` after the queue re-render). Bumped `APP_VERSION` to 0.9.0. Extended the top-of-file architecture comment to document item 9.
- `index.html` — added `#stats-panel` (with `#stats-panel-today` header line, three `.stats-tile` cards each with value+label+detail spans, and `#stats-per-piece` containing `#stats-per-piece-list`) at the top of `#viewer-placeholder`, above `#review-queue-panel`. Bumped footer version to v0.9.0.
- `styles.css` — new `.stats-panel` block plus `-header`, `-today` (+ `is-complete` variant). New `.stats-tiles` 3-column grid (collapses to 1-col below 720px). New `.stats-tile` (+ `-value` / `-label` / `-detail`). New `.stats-per-piece` (+ `-title`, `-list`, `-row`, `-title-cell`, `-bar`, `-bar-fill`, `-pct`).
- `tests/stats.test.mjs` — new (~50 assertion blocks).
- `tests/srs.test.mjs` — added the four item-9 names to the exported-surface check.
- `tests/db.test.mjs` — added `listDistinctPracticeDates` to the exported-surface check.
- `ROADMAP.md` — item 9 checked off.
- `PROGRESS.md` — this entry.

**Design decisions**

- **Mastery floor at 21 days, not 7 or 30**. One week (the second SM-2 review's interval) is too easy a bar — that's a section the user has only just learned, not one they've internalised. Three weeks corresponds to roughly the third Good-rated review at default ease (1 → 6 → 15 → ~38d cadence), which is when the section is starting to live in long-term memory. Bigger intervals (months) would set the bar so high that very few sections would ever earn the badge in a real practice routine. The constant lives in `srs.js` so a future tuning pass touches one place.
- **Daily-streak: "consecutive practice days" not "consecutive due-AND-not-skipped"**. The strictest version (resolves the open question with a hostile-to-quiet-cadence stance) requires per-day snapshot of due dates we don't currently persist. The looser version is friendly to a pianist whose weekly cadence varies, and it's what the user can actually act on day-to-day. Documented in the docstring as a future schema-bump refinement so we don't lose the intent.
- **Streak doesn't break at midnight**. If today has no reps yet, `computeDailyStreak` looks back from yesterday — only once a *full* day passes with no practice does the streak break. Lets a user open the app first thing in the morning without panicking.
- **`summariseProgress` is one big helper, not three small ones**. Considered splitting into `summariseSections`, `summarisePieces`, `summariseToday` — but they all share the same single walk over `sections`, and splitting would mean three walks. The function is still pure and unit-testable as a single bundle.
- **Per-piece sort: mastery percentage DESCENDING (strongest first)**. Anki shows weakest cards first to nudge the user toward struggle; here, the panel is a "celebrate progress" surface (the queue is the "what to fix next" surface), so showing the user's strongest pieces first reads as a reward.
- **Today's-done line is sections, not reps**. "3 / 5 done today" reads as "I've finished 3 sections of the 5 I owe today", which matches the practice mental model. We considered "30 / 50 reps logged today" but that loses the unit of work (a section); the queue panel already shows per-section progress chips for users who want the rep-level view.
- **Stats panel hidden on a fresh library**. `sections.length === 0` → panel doesn't render. Avoids showing a wall of zeros to a user who hasn't done anything yet, matching the empty-state policy of the queue panel. Once they've added their first section, the panel becomes useful immediately (even if all the stats are still 0/0).
- **Per-piece retention defined as `mastered / total sections in piece`, not `(Good+Easy)/(Again+Hard+Good+Easy)`**. The Anki-style retention math requires storing per-rating history, which we don't (we only persist `lastReviewedDate` + the resulting interval). The mastery-based denominator is meaningful with the data we have today — it tells the user "how much of this piece has settled into long-term memory?" — and a future schema bump for a `ratings` event log can refine the denominator without rewriting the panel.
- **`noteRepLogActivity` is a one-liner that mutates `statsState.practiceDates` in place**. Avoids an IDB walk per rep click. The only "new fact" a rep introduces to the streak is "we now have a rep on `dateISO`" — `Set.add` is idempotent so calling it on every rep is fine.

**Verification**

- `node --check srs.js` → ok (mirrored copy).
- `node --check db.js` → ok (mirrored copy).
- `node tests/srs.test.mjs` → "srs helpers: all assertions passed" (now includes the four item-9 names in the exported-surface check).
- `node tests/queue.test.mjs` → "queue helpers: all assertions passed" (no regressions from the new srs.js exports).
- `node tests/stats.test.mjs` → "stats helpers: all assertions passed" (~50 assertion blocks).
- Wrote `imports.smoke.mjs` mirroring app.js's import surface against `db.js` + `srs.js` and ran it: every named symbol app.js imports resolves cleanly (30 symbols).
- Cross-checked every `getElementById('…')` in `app.js` (48 unique ids, including the 10 new `stats-*` ones) against `id="…"` in `index.html` — `comm -23` returned the empty set, so every id app.js looks up exists.
- Verification was run by mirroring source files into `/tmp/piano/` and running Node there, since the canonical project path under `C:\Users\adria\Documents\` isn't directly mounted in the workspace shell.

**Next suggested step**

- Roadmap item 10: export/import full library to JSON (user-managed backup). The shape: walk `pieces` (metadata + base64-encoded PDF bytes? or a separate `.json` + `.pdf` archive?), `sections` (full records including SRS state), and `repLogs` (full history) into one JSON document the user downloads. Import is the inverse with collision handling (skip / overwrite / rename). Implementation note: PDFs as base64 inside JSON would balloon backup size 33% over raw bytes — worth considering a `.zip` (via JSZip from a CDN) or a `.tar`-like custom archive instead. The export/import surface should land in `db.js` (pure data shaping) + a new `backup.js` module (JSON serialisation, compression hooks). The Stats panel from item 9 makes a particularly nice canary for verifying a round-trip backup landed correctly: an exported-then-imported library should produce the exact same Progress numbers.

**Open design questions**

- For item 10: PDF blob serialisation — base64 in JSON (simplest, 33% bloat) vs. a `.zip` archive (JSZip from CDN; structured manifest + raw blobs). Lean ZIP for any real piano library, since multi-MB PDFs add up; but base64-JSON wins for round-trip simplicity and is fine as a v1 if the user's library is small.
- For item 10: import collision policy — when a piece with the same id already exists, do we skip, overwrite, or generate a new id? Lean "prompt the user once at import time" with a default of "rename" (generate a new id, prefix the title with "(imported)"), since importing a backup over your live library by accident shouldn't silently destroy data.
- For item 9 follow-up: the per-piece retention math could be enriched if we add a tiny `ratings` event log to the schema (timestamp + sectionId + quality). That would let the panel show Anki-style "73% retention (Good+Easy / total)" alongside the current mastery-based view. That's likely a schema bump and a separate roadmap item — but flagging now while it's fresh.

## 2026-04-29 — Roadmap item 8 (Post-session rating prompt)

**Built today**

- Replaced the auto-Good fire of SM-2 with a real Again / Hard / Good / Easy prompt that lands inline in the practice panel the moment the user logs rep #10. Until the user picks a rating, the schedule stays unwritten — closing the practice panel without rating leaves the section in its "needs-rating" state, and re-opening it brings the prompt back. Resolves the carry-over open question from item 7 ("block until pick" wins over "dismiss = implicit Good"; clearer SRS data is worth one extra click).
- New pure helper `previewSm2Outcomes(state, todayISO)` in `srs.js`. Walks the four ratings (Again/Hard/Good/Easy) through `applySm2` against the current state and returns `[{ rating, label, nextDue, interval, daysOff }]` in on-screen order. Powers the per-button "Again → tomorrow / Good → in 6d" labels so the user sees what they're committing to *before* they click. Pure — same input → same output, never mutates the state, takes an explicit `todayISO`.
- `app.js` refactor of the SM-2 firing path. The old `maybeFireSm2(sectionId, dateISO)` (hard-coded to RATING_GOOD) is replaced by `fireSm2WithRating(sectionId, dateISO, quality, label)` — the same idempotency guard via `lastReviewedDate`, but the quality is the user's choice rather than a default. The "fires-on-the-10th-click" call site in `handleRepClick` is gone; firing now happens from `handleRatingClick` after the user picks a button. Also dropped the auto-fire from the `openPracticeView` reconcile path — if the user crossed the goal in another tab and hasn't rated yet, the rating prompt simply shows up when they open the panel.
- New `renderRatingPrompt(section)` in `app.js` builds the four buttons by hand with `createElement` + `textContent` (no `innerHTML` template-string concatenation, even though `outcome.label` is internal — defense in depth). Buttons are auto-rendered every panel paint; the existing renderer logic decides between rating-prompt and next-review card via a single `needsRating = goalMet && !scheduledToday` derived flag, so the two surfaces are mutually exclusive at all times.
- Each rating button shows a name (Again / Hard / Good / Easy) and a glanceable detail line ("tomorrow", "in 6d", etc.) sourced from `previewSm2Outcomes(...).daysOff`. Full ISO date sits in the `title` attribute for hover. The Good button is default-highlighted (`is-default` class + autofocus) so a one-click confirm flow is fast — matches the "lean toward `Good` is the default" decision from yesterday's open question.
- Click handler `handleRatingClick(quality, label)` sets `practiceState.ratingInFlight = true`, re-renders so all four buttons disable (visual feedback while the SM-2 update saves), then awaits `fireSm2WithRating`. The `finally` block clears the in-flight flag and re-renders all three surfaces (practice panel, sections panel, review queue) so the section's freshly-scheduled `nextDue` lands everywhere at once.
- Status copy now reflects the chosen rating: `Rated "Exposition" as Hard — 2026-05-13 (in 15 days).` The "Again" rating specifically schedules for tomorrow even though it's a lapse, so the status copy is honest about the trade-off ("Again" → next-day re-review, schedule reset). New `ratingLabelFor(quality)` is a fallback path so the status string still works if a future caller forgets to pass an explicit `label` — the click handler always passes one.
- The progress-bar / "Saving today's review…" interim status is gone now that there's no auto-fire window. While the prompt is up the practice-status line stays quiet because the prompt itself carries the cue.
- New CSS for `.practice-rating-prompt` (warm-paper card matching the practice panel's visual language) plus header (`-eyebrow`, `-title`, `-hint`), `.practice-rating-buttons` (4-column grid that collapses to 2×2 below 720px), and `.practice-rating-btn` (with `-again` / `-hard` / `-good` / `-easy` color variants and an `.is-default` highlight on Good — solid border + soft 2px-rgba shadow). The four colors are subtle but signal "Again is bad / Easy is great" at a glance.
- `closePracticeView` now also clears the rating prompt — a Stop → re-open cycle on a section that's already met-but-not-rated cleanly re-shows the prompt rather than briefly flashing a stale set of buttons.
- Bumped `APP_VERSION` to 0.8.0 and the footer version badge to v0.8.0.
- Added ~50 assertion blocks for `previewSm2Outcomes` in `tests/srs.test.mjs`: fresh-section projection (all four ratings → tomorrow, interval 1), seasoned (after 2 reviews) projection diverges into 1 / 15 / 15 / 16 days, veteran (after 3 reviews) projection 1 / 36 / 38 / 39 days, no-mutation guarantee across repeated calls, null/undefined-state fallback to defaults, todayISO validation (throws on bad shapes), recently-lapsed state still returns sensible projections. Updated the exported-surface check to include `previewSm2Outcomes`.

**Files changed**

- `srs.js` — added `previewSm2Outcomes`. No other changes (everything else still pure).
- `app.js` — added the four imports `RATING_AGAIN/HARD/GOOD/EASY` + `previewSm2Outcomes`. Added `els.practiceRatingPrompt` and `els.practiceRatingButtons`. Added `practiceState.ratingInFlight`. New functions: `renderRatingPrompt`, `formatRatingDetail`, `handleRatingClick`, `fireSm2WithRating`, `ratingLabelFor`. Removed `maybeFireSm2` (replaced by the explicit-quality path). `renderPracticePanel` now branches on a `needsRating` derived flag and renders either the rating prompt or the next-review card. `closePracticeView` clears the rating prompt on close. `openPracticeView` no longer auto-fires SM-2 in the reconcile path. `handleRepClick`'s status copy on goal-met now reads "Pick a rating to schedule the next review." Bumped `APP_VERSION` to 0.8.0.
- `index.html` — added `#practice-rating-prompt` (with header + `#practice-rating-buttons`) inside the practice panel, between status and next-review. Bumped footer version to v0.8.0.
- `styles.css` — new `.practice-rating-prompt` block + `-header` / `-eyebrow` / `-title` / `-hint`. New `.practice-rating-buttons` grid (4-col → 2-col mobile). New `.practice-rating-btn` (+ `-name` / `-detail` / `:hover` / `:focus-visible` / `:disabled`) and per-rating `.practice-rating-btn-again / -hard / -good / -easy` color variants. `.practice-rating-btn-good.is-default` highlight (solid border + soft glow shadow).
- `tests/srs.test.mjs` — ~50 new assertion blocks covering `previewSm2Outcomes`. Added `previewSm2Outcomes` to the exported-surface list.
- `ROADMAP.md` — item 8 checked off.
- `PROGRESS.md` — this entry.

**Design decisions**

- **Block until pick** (resolves yesterday's open question). The rep button is disabled the moment count hits 10, the prompt appears, and there's no "skip rating" affordance. The user owes us a rating to advance the schedule. The Good default + autofocus + soft glow makes "I just want to confirm and move on" essentially one click — the friction is entirely on Again/Hard/Easy where it should be.
- **No persistence until a rating is picked**. Closing the practice panel before rating leaves `lastReviewedDate` unset, so re-opening shows the prompt again. This is intentional — a half-finished rating shouldn't ghost-schedule the section. The reps themselves are persisted (via the existing rep-log store) so the goal-met state survives the close, but the SRS state stays untouched until the user makes a real choice.
- **Rating-prompt mutually exclusive with next-review card**. Both render into adjacent space inside the practice panel, but only one shows at a time — the `needsRating` derived flag in `renderPracticePanel` swaps them. Avoids visual clutter (two stacked cards saying related things) and makes the next state of the panel obvious from one glance: prompt = your move, card = scheduled.
- **`previewSm2Outcomes` lives in srs.js** and projects via the same `applySm2` the click handler eventually uses. So the projection labels can never disagree with the actual fired schedule — same code path, same arithmetic, always.
- **Per-rating color cues are subtle, not screaming**. Again gets a soft red, Hard amber, Good green, Easy teal-green. Strong enough that the visual hierarchy is clear at a glance, but understated enough that the user isn't punished by aggressive red on a "Again" they had to pick honestly.
- **Status copy is rating-explicit**. `Rated "Exposition" as Again — 2026-04-30 (tomorrow).` The "as Again" makes it crystal-clear that an Again still produces a next-review date — yesterday's PROGRESS open question worried this might confuse the user. Calling out the rating in the status line is the right place to do it without crowding the inline prompt UI.
- **Rating is final — no undo**. Once `fireSm2WithRating` saves successfully, the section is scheduled. This matches the existing rule that Reset/Undo on the rep counter doesn't roll back the SM-2 schedule. If a user genuinely mis-clicks, they can wait until tomorrow when the section reappears in the queue and re-rate then. Adding a "change rating" affordance is item-9-or-later polish.
- **Buttons are dynamically created on every render** (rather than statically in HTML) so the per-rating projection labels can update if the section's SRS state changes between renders. Cheap (4 buttons, no measurable cost) and means the prompt is always showing fresh days-off numbers.

**Verification**

- `node --check` on the bash-mirrored `srs.js` → OK (the canonical file uses the same path-mapping issue as previous runs; the mirrored copy validates the new module).
- `node tests/srs.test.mjs` (against the mirrored `srs.js`) → "srs helpers: all assertions passed" — covers `previewSm2Outcomes` for fresh + seasoned + veteran + null + undefined + lapsed states, no-mutation invariant, and the exported-surface list (now 15 names).
- Spot-checked the SM-2 cadence end-to-end inline via Node: first review → 2026-04-29, second review → 2026-05-05, preview after 2 reviews lays out Again/Hard/Good/Easy → 1/15/15/16 days exactly as the test asserts. Sanity-checks the projector against the canonical `applySm2` arithmetic.
- Cross-checked every `getElementById('…')` call in `app.js` against `id="…"` attributes in `index.html` — 38 unique ids, every one matches (including the two new `practice-rating-prompt` and `practice-rating-buttons` ids).
- Read the new `renderRatingPrompt` / `handleRatingClick` / `fireSm2WithRating` / `ratingLabelFor` blocks in `app.js` directly — brace balance, error paths, and state transitions all check out. The old `maybeFireSm2` symbol is fully gone (`grep maybeFireSm2 app.js` → no matches).
- Verification was run by mirroring the new module into `/tmp/piano/` and running Node there, since the canonical project path under C:\Users\adria\Documents\ isn't directly mounted in the workspace shell and Read/Write file-tool paths under C:\Users\adria\AppData\…\outputs sync inconsistently with the bash-side mount in this run.

**Next suggested step**

- Roadmap item 9: progress stats. Surface a daily-streak counter, sections-mastered count, and per-piece retention percentage. The data is already in IDB — `listRepLogsForSection` (defined in item 5 specifically anticipating this) walks a section's full practice history; `getRepCountsForDate` over each of the past N days gives streak data; `listAllSections` over all pieces with `nextDue` set is enough for retention math. Likely lands as a new "Stats" panel inside the welcome placeholder, sitting alongside (above? below?) the daily review queue. Worth surfacing a small "X / Y sections done today" mini-progress line in the queue panel header as a precursor — that's a 5-minute win that smooths the run-up to the bigger stats panel.

**Open design questions**

- For item 9: should the daily-streak counter break on a day with zero practice or just a day where nothing was *due* and the user practiced nothing? Lean "break only on days where something was due AND skipped" — punishing the user for a quiet weekly cadence would be hostile.
- For item 9: per-piece retention math — Anki uses (correct reps / total reviews). For PianoSRS, where every "review" is 10 self-reported reps (no objective right/wrong), the closest equivalent is (Good+Easy) / (Again+Hard+Good+Easy). Worth surfacing per-piece since pianists likely have a few "weak link" sections within an otherwise-mastered piece.
- For item 11 polish (keyboard shortcuts): the rating prompt is a natural fit for 1-4 number keys (Again=1, Hard=2, Good=3, Easy=4). Worth picking shortcuts that don't conflict with the rep-button space-to-log shortcut. Item 11 territory; flagging it now while it's fresh.

## 2026-04-28 — Roadmap item 7 (Daily review queue)

**Built today**

- New "Due today" panel inside `#viewer-placeholder`. On app open, the welcome card now shows every section across every piece whose `nextDue` is today-or-earlier AND that hasn't already met today's rep goal. Clicking a queue item selects that section's piece, opens the practice panel for that section, and scrolls the PDF to its page — one click from "what do I need to practice?" to "I'm practising it now".
- Two new IDB helpers in `db.js`. `listAllSections()` does a single `getAll` over the sections store and sorts by `nextDue` (ascending, with un-rated sections last) so the queue can be hydrated without per-piece round-trips. `getRepCountsForDate(dateISO)` walks the `byDateISO` index on the rep-logs store and returns a `Map<sectionId, count>` for the day — so the "drop sections that already hit 10 today" filter is one tx-scoped read of just today's records, not a per-section probe. No schema bump (the `byDateISO` index has been there since item 5 specifically anticipating this query).
- New pure helper `buildReviewQueue({ sections, piecesById, repCountsToday, todayISO, repGoal })` in `srs.js`. Filters to sections with `nextDue && daysOff <= 0 && repCount < repGoal`, attaches the piece title, returns `{ section, piece, nextDue, daysOff, repCount }` per item, and sorts most-overdue-first then alphabetical-by-piece-title then by `addedAt`. Pure — no IDB, no DOM, takes an explicit `todayISO`. Accepts `piecesById` as either a `Map`, an `Array<{id,title}>`, or a plain `Object`; same for `repCountsToday` (`Map` or plain object) so callers don't have to reshape data.
- Sort order: most-overdue first → due-today next → ties by piece title (a–z, case-insensitive) → final tie-break by `addedAt`. The user's eye lands on the stalest review first; ties are stable so the queue doesn't reshuffle randomly between renders.
- Cross-piece queue state in `app.js`. `queueState = { dateISO, sections, pieceTitleById, countsByDate }` is a single in-memory snapshot, hydrated once on app open by `refreshReviewQueue()`. Subsequent rep-log changes (rep click, undo, reset) only need to mutate the local `countsByDate` — they don't trigger a fresh IDB walk. Three small mutator helpers (`setQueueRepCount`, `upsertQueueSection`, `removeQueueSection`) keep the snapshot honest as the user edits/deletes/practices sections in this session.
- `renderReviewQueue()` builds the queue DOM by hand with `createElement` + `textContent` (no `innerHTML` template-string concatenation, even though section names are user-supplied) — defense in depth against any future code path that might inject user text. Each row shows the section name, an "Xd overdue" / "Due today" pill (red for overdue, amber for due-today), the piece title, the page+measures, and (if any reps logged today) a "X/10 today" progress chip in the warm-paper accent color. Hidden when the queue is empty so a fresh library doesn't show a misleading panel.
- `handleReviewQueueClick(item)` routes the click. If the target piece is already active, it just `openPracticeView(sectionId)` + `scrollToPage`. If the user is on a different piece, it `selectPiece(pieceId)` first, then waits up to ~2.5s (poll @50ms) for the lazy section list to populate before opening practice. `queueClickInFlight` makes the operation idempotent — a second click while the first is in flight is silently dropped, and the queue items disable themselves while waiting so the user gets visual feedback.
- New `pieceTitleById` lookup is refreshed from the live `pieces` array on every render, so a freshly-uploaded piece (or one renamed in a future build) doesn't show as "(unknown piece)" — important for the import flow in item 10.
- App-open status copy is now queue-aware. If the queue has items, the footer reads e.g. "3 sections due for review today · v0.7.0" instead of just "Loaded N saved pieces". Empty queue → fall back to the existing "Loaded …" / "Ready" copy.
- Layout: the welcome placeholder is now a `flex-column` container holding the queue panel above the existing welcome card. The card got its own `.viewer-placeholder-welcome` class (the queue and welcome card both sit inside the placeholder, but only the welcome bit gets the centered "card" treatment). Max width bumped from 560 → 720 to accommodate the queue's 2-line item layout.
- New CSS for `.review-queue-panel` (accent-bordered card matching the practice panel's visual language) plus `-header`, `-count`, `-hint`, `-list`, `-item`, `-item-top`, `-item-name`, `-item-due` (with `is-overdue` red / `is-due-today` amber variants), `-item-meta`, `-item-progress`. The disabled-while-loading state is a `:disabled { opacity: 0.6; cursor: progress; }` pair so the user gets clear feedback during a piece-switch.
- Bumped `APP_VERSION` to 0.7.0 and the footer version badge to v0.7.0.
- Added `tests/queue.test.mjs` with ~20 assertion blocks covering: empty/undefined sections (returns `[]`), bad `todayISO` throws, unscheduled sections excluded, future-only sections excluded, due-today + overdue both included with correct sort order, sections that already hit the goal today drop off, custom `repGoal` honored, piece title attached to each item, `piecesById` as Map / Array / plain Object, missing pieces fall back to `(unknown piece)` placeholder, `repCountsToday` as Map or plain object, realistic mixed-library scenario (overdue + done-today + partial + future + never-rated all in one input), addedAt tie-break within a piece, malformed sections silently dropped, `repCount` surfaces on the queue item, and a final exported-surface check.
- Extended `tests/srs.test.mjs` to include `buildReviewQueue` in the exported-surface list. Extended `tests/db.test.mjs` to include `listAllSections` and `getRepCountsForDate` in the exported-surface list.

**Files changed**

- `srs.js` — added `buildReviewQueue` (and a small docstring above the `internal helpers` section).
- `db.js` — added `listAllSections` and `getRepCountsForDate`. Updated the schema-doc preamble to note item 7 didn't need a schema bump and to point at `getRepCountsForDate` as the daily-queue join path.
- `app.js` — added `listAllSections` + `getRepCountsForDate` to the `db.js` import block, added `buildReviewQueue` to the `srs.js` import block. New `queueState` + `queueClickInFlight` state. New `refreshReviewQueue` / `setQueueRepCount` / `upsertQueueSection` / `removeQueueSection` / `renderReviewQueue` / `handleReviewQueueClick` / `waitForSection` functions. `hydrateFromStorage` now hydrates the queue + reads queue size into the status copy. Hooks into `handleSectionFormSubmit` (upsert + re-render), `handleDeleteSection` (remove + re-render), `handleRepClick` (`setQueueRepCount` + re-render in the `finally`), `handleUndoRep` (same), `handleResetReps` (same), `maybeFireSm2` (`upsertQueueSection`). Added the three new `els.reviewQueue*` references. Bumped `APP_VERSION` to 0.7.0.
- `index.html` — wrapped the welcome message in `#viewer-placeholder-welcome` and added the new `#review-queue-panel` (with `#review-queue-count` + `#review-queue-list`) above it inside `#viewer-placeholder`. Bumped footer version to v0.7.0.
- `styles.css` — `.viewer-placeholder` is now a flex column (max-width 720), with its own `.viewer-placeholder-welcome` carrying the centered-card treatment. New `.review-queue-panel` block with `-header`, `-count`, `-hint`, `-list`, `-item` (+ `:hover` / `:focus-visible` / `:disabled`), `-item-top`, `-item-name`, `-item-due` (+ `is-overdue` / `is-due-today`), `-item-meta`, `-item-progress`.
- `tests/queue.test.mjs` — new (~20 assertion blocks).
- `tests/srs.test.mjs` — added `buildReviewQueue` to the exported-surface check.
- `tests/db.test.mjs` — added `listAllSections` + `getRepCountsForDate` to the exported-surface check.
- `ROADMAP.md` — item 7 checked off.
- `PROGRESS.md` — this entry.

**Design decisions**

- **Drop-off-on-completion** (resolves the open question carried into this run): once a section's rep count hits 10 for today, it leaves the queue. Showing finished items risks the user re-practising the same section twice in a day, which the SM-2 guard (`lastReviewedDate === today`) already silently ignores anyway. The progress chip on the section row in the per-piece view (and the "Done · 10/10" badge) gives the user the in-piece feedback they need to know it's done. A future "Done today" sub-section with a quiet treatment is item 9 polish, not item 7.
- **No `byNextDue` index on the sections store**. Considered adding one for the daily-queue range scan, but a personal library is bounded at low thousands of sections (likely ≤200 for a real practice routine), and `getAll` over the whole store followed by an in-memory filter is simpler, doesn't bump the schema version, and finishes well under a frame at any realistic scale. If the queue ever feels slow, that's an item-9-polish fix.
- **Pure queue helper, impure shell**. `buildReviewQueue` is parameterised on (`sections`, `piecesById`, `repCountsToday`, `todayISO`) so it's directly unit-testable without IDB or `Date.now()`. The impure side — IDB hydration, snapshot maintenance, click routing — lives in `app.js`. Means the filter+sort logic itself is well covered without leaning on a browser shim.
- **Queue snapshot, not on-demand walks**. We hydrate the queue once on app open and then mutate the in-memory snapshot incrementally as the user logs reps. Avoids an IDB round-trip per click and makes the queue cheap to re-render. The trade-off is consistency with another tab that's also editing — but the rep-log layer is already optimistic-with-reconcile, so a stale queue would self-correct on the next refresh.
- **Click routing through `selectPiece` + `waitForSection`**. The lazy hydration of section data (`ensureSectionsLoaded`) is async and runs in the background of `selectPiece`. Polling for the section to land in memory (50ms × ~50 iterations) is uglier than awaiting `ensureSectionsLoaded` directly, but it isolates the queue click handler from internal piece-selection plumbing — the queue doesn't know that selectPiece's section hydration is fire-and-forget. If a future refactor makes section hydration awaitable from the outside, this can collapse into one `await`.
- **`queueClickInFlight` not per-item**. A single global flag rather than per-item is intentional. The user can only meaningfully click one queue item at a time (you switch pieces and start practising), so the simpler "global lock" matches the actual workflow and disables every queue button while one is loading — visual feedback for free.
- **Status copy hierarchy on app open**. If the queue has items, the status reads "N sections due for review today · v0.7.0"; otherwise "Loaded N saved pieces · v0.7.0" or "Ready · v0.7.0". The queue state always wins because it's the most actionable information — user knows what they need to do next.
- **`pieceTitleById` re-derived from the live `pieces` array on every render** rather than incrementally maintained. Cheap (≤ a few hundred entries) and means a freshly-uploaded piece is never missing its title. The `queueState.pieceTitleById` Map is more of a stable handle than a snapshot — it gets rebuilt-in-place each render.

**Verification**

- `node --check srs.js` → ok.
- `node --check db.js` → ok.
- `node tests/db.test.mjs` → "db helpers: all assertions passed" (now includes `listAllSections` + `getRepCountsForDate` surface).
- `node tests/sections.test.mjs` → "section helpers: all assertions passed".
- `node tests/repLogs.test.mjs` → "rep-log helpers: all assertions passed".
- `node tests/srs.test.mjs` → "srs helpers: all assertions passed" (now includes `buildReviewQueue` surface).
- `node tests/queue.test.mjs` → "queue helpers: all assertions passed" (~20 assertion blocks).
- Wrote `imports.smoke.mjs` mirroring app.js's import surface against `db.js` + `srs.js` and ran it: every named symbol app.js imports resolves cleanly. (Stand-in for `node --check app.js`, since app.js touches `document` at import time.)
- Cross-checked every `getElementById('…')` call in `app.js` against `id="…"` in `index.html` — 36 unique ids, including the 3 new `review-queue-*` ones; every one matches.
- Verification was run by mirroring source files into the sandbox-mounted outputs folder and running Node there, since the canonical project path under C:\Users\adria\Documents\ isn't directly mounted in the workspace shell.

**Next suggested step**

- Roadmap item 8: post-session rating prompt. The `maybeFireSm2(sectionId, dateISO)` path currently hard-codes `RATING_GOOD` as the quality value. Replace that default with a real "Again / Hard / Good / Easy" prompt that fires inline (likely as an in-place replacement of the green next-review card, not a modal — modal feels heavy at a 10-click cadence). The rating prompt should land on the 10th rep click. Implementation note: SRS algorithm and storage shape are already in place from item 6 — this is purely a UI + state shape change, no schema bump. The four rating constants are already exported as `RATING_AGAIN/HARD/GOOD/EASY`.

**Open design questions**

- For item 8: should the rating prompt block further rep clicks until the user picks a rating, or should "Stop" / dismiss-the-prompt also count as an implicit Good? Lean toward "block until pick", with a clear default-highlighted Good button so a one-click-confirm flow is fast.
- For item 8: when the user has just rated a section as "Again" (lapse), the queue's drop-off behaviour means the section leaves today's queue. But "Again" specifically schedules the section for tomorrow — which means the user is asked to practise it again sooner. Item 7 already handles this correctly (the `nextDue` becomes tomorrow, so the section won't appear in today's queue but will appear tomorrow's), but item 8 should surface this in the rating-prompt UI so the user understands "Again" → "you'll see this back tomorrow".
- For item 9 (stats): the queue's `repCount` field is exactly the data point a "today's progress" mini-chart would want. Worth surfacing a small "X / Y sections done today" line in the queue panel header before item 9 lands.

## 2026-04-28 — Roadmap item 6 (SM-2 scheduling)

**Built today**

- New `srs.js` module with the SM-2 algorithm and supporting pure helpers. Public surface: `EASE_DEFAULT` (2.5), `EASE_MIN` (1.3), the four rating constants `RATING_AGAIN/HARD/GOOD/EASY` (0/3/4/5), `defaultSrsState()`, `srsStateForSection(section)`, `updateEase(ease, q)`, `applySm2(state, quality, todayISO)`, `addDaysISO(dateISO, days)`, `daysBetweenISO(a, b)`, `describeNextDue(nextDueISO, todayISO)`. Everything in the module is pure (no IDB, no DOM, no `Date.now()` in the hot path) and `applySm2` takes an explicit `todayISO` so the tests are fully deterministic.
- SM-2 implementation matches Wozniak 1990: `EF' = EF + (0.1 - (5 - q) * (0.08 + (5 - q) * 0.02))` with EF clamped at 1.3; on a lapse (q < 3) repetitions reset to 0 and interval to 1; otherwise repetitions increment and the interval cycles `1 → 6 → ceil(prev * EF)`. Ease is rounded to 4dp on each update so persisted values don't drift in the float-noise last digits across many reviews.
- `addDaysISO` works from local-component Date arithmetic on YYYY-MM-DD strings. We never read a wall-clock time off the constructed Date, so DST transitions can't shift the result. Month/year/leap-year boundaries handled correctly (2024-02-28 → 2024-02-29 → 2024-03-01; 2026-12-31 + 1d → 2027-01-01; 2026-04-28 + 365d → 2027-04-28).
- Section record gains five optional fields: `repetitions`, `interval`, `ease`, `nextDue`, `lastReviewedDate`. They're written through `sectionToRecord` only when present and well-formed — legacy section records remain untouched on edit, so the on-disk shape pre-item-6 stays exactly as it was. No DB schema bump (still v3).
- New `maybeFireSm2(sectionId, dateISO)` in `app.js`. Called from inside `handleRepClick` whenever the persisted post-increment count is `>= REP_GOAL` (and also from inside `openPracticeView`'s IDB-reconcile path, in case the user crossed the goal in another tab earlier today). Idempotent: a `lastReviewedDate === today` check inside means going 10 → 9 → 10 in the same day won't double-advance the schedule. Resolves the open question from yesterday — fires-on-10th-click, with reset/undo intentionally NOT rolling back the schedule.
- Practice panel gains a green "Next review" card, slotted between the status line and the secondary actions. Built node-by-node with `createElement` + `textContent` (no string-concat innerHTML) so a stray section name can't inject markup. Three lines: small uppercase label ("Next review" or "Scheduled today"), the YYYY-MM-DD date in a tabular-numerals heavy weight, and a small "in N days / tomorrow / due today / N days overdue" detail. Re-painted on every state change.
- Section-list rows pick up a small "Next: 6d" / "Due today" / "Due 3d ago" pill once a section has been rated. Highlighted (solid border, warm background) when overdue or due today so the eye is drawn to what needs work first. Hidden until SM-2 has fired at least once.
- Status copy in the practice panel rewritten now that scheduling is real. The old "SRS scheduling lands in step 6." line is gone; once SM-2 has fired the green next-review card carries the goal-met message and the status line stays quiet. The interim "Saving today's review…" copy only appears in the rare window between rep #10 landing in IDB and the section save returning.
- `closePracticeView` clears the next-review element on close so a Stop → re-open cycle doesn't briefly flash the previous section's date.
- Bumped `APP_VERSION` to 0.6.0 and the footer version badge to v0.6.0.
- Added `tests/srs.test.mjs` with ~60 assertions covering: every constant, `defaultSrsState` (shape + freshness), `srsStateForSection` (null/undefined/non-object → defaults; legacy section → defaults; full passthrough; per-field bad-type fallbacks), `updateEase` (Good/Hard/Easy/Again deltas at default ease, EASE_MIN floor, quality clamp 0–5, bad-ease fallback to default), `applySm2` (new card → first / second / third / fourth review with Good showing the 1 → 6 → 15 → 38 cadence; Again resetting streak + dropping ease to 1.7; Hard preserving streak with ease 2.36 and interval 15; Easy bumping ease to 2.6 and interval to 16; todayISO validation; null-state tolerance), `addDaysISO` (1/7/365 days, month boundary, year boundary, leap year both directions, non-leap, negative days, fractional-day floor, bad-input throws), `daysBetweenISO` (basic, equality, negative, year span, both DST transitions), `describeNextDue` (today/tomorrow/N days/overdue/no-today), and an exported-surface check covering all 13 names.
- Extended `tests/sections.test.mjs` with 4 new assertion blocks: SRS fields are passed through when present; SRS keys are OMITTED from the record when absent (legacy compatibility); malformed SRS fields are dropped; explicit zeros for `repetitions` and `interval` are preserved (so an "Again" rating's reset-state survives a round-trip).

**Files changed**

- `srs.js` — new.
- `db.js` — `sectionToRecord` extended to passthrough the 5 optional SRS fields.
- `app.js` — added SRS imports, `practiceNextReview` el reference, section-list "Next: …" pill, `maybeFireSm2`, `getActiveSection`, `renderNextReview`, SM-2 trigger inside `handleRepClick` + `openPracticeView`-reconcile path, status-copy update, `closePracticeView` clears next-review element. Bumped `APP_VERSION` to 0.6.0.
- `index.html` — added `<p id="practice-next-review">` between status and secondary actions. Bumped footer version to v0.6.0.
- `styles.css` — new `.practice-next-review` (+ `-label` / `-date` / `-detail`) and `.section-list-next-due` (+ `.is-due` variant) blocks.
- `tests/srs.test.mjs` — new (~60 assertions).
- `tests/sections.test.mjs` — 4 new assertion blocks for SRS-field passthrough.
- `ROADMAP.md` — item 6 checked off.
- `PROGRESS.md` — this entry.

**Design decisions**

- SRS state lives directly on the section record, NOT in a new `srsState` object store. The fields are tiny (5 scalars), the write rate is low (once per goal-met day per section), and embedding them avoids a join on every section render. The optional-field write logic in `sectionToRecord` keeps legacy records pristine until they're rated.
- Fire SM-2 on the 10th rep click, not on practice-panel close. Resolves yesterday's open question — the user gets an instant green "Next review: 2026-04-29 (tomorrow)" reward in the same session, which is more motivating than a delayed dialog.
- Default rating = `RATING_GOOD` (q=4) for the item-6 default. Item 8 will replace this default with a real Again/Hard/Good/Easy prompt by hooking the same `maybeFireSm2` path with the user-chosen rating instead of the hard-coded constant.
- `lastReviewedDate` guard inside `maybeFireSm2` rather than at the call site. Means every entry path (rep-click, reconcile, future item-7 daily-queue) gets the same idempotency for free, and the math itself never has to special-case "is this a re-fire?".
- Reset / Undo do NOT roll back the SM-2 schedule. They're for typo-correction on the rep counter, not "undo my SRS update". Once the user has self-confirmed 10 clean reps, that day's SRS update stands. The practicality: rolling back the schedule would also mean resurrecting the prior `nextDue` / `interval` / `ease` / `repetitions` / `lastReviewedDate` snapshot, which we don't currently store. Not worth the complexity for a typo case.
- Ease rounded to 4dp on every update. Across many reviews `EF + 0.1 + 0.1 + …` accumulates float noise in the last digits. Rounding stops persisted values from drifting into long ugly decimals like `2.5000000000000004` on disk.
- `interval = 0` is the sentinel for "never reviewed", not `null`. Keeps the type uniform (always a number) and lets `applySm2`'s `prevInterval` fallback (`> 0 ? prev : 6`) work without a null-check special case for the q ≥ 3 / repetitions ≥ 3 branch.
- Built `practiceNextReview` DOM with `createElement` + `textContent` instead of `innerHTML` template-string concatenation. `srsStateForSection` is well-typed but the section's `name` flows through a different path; defense in depth against any future code that might inject user text into the panel.
- Section-row pill phrasing — "Next: 6d", "Due today", "Due 3d ago" — chosen to be glanceable. The full ISO date sits in the `title` attribute for hover. The color/border treatment switches from dashed-neutral to solid-amber once the date is at-or-before today, so a busy section list shows due work first.

**Verification**

- `node --check srs.js` → ok.
- `node --check db.js` → ok.
- `node --check app.js` → ok.
- `node tests/db.test.mjs` → "db helpers: all assertions passed".
- `node tests/sections.test.mjs` → "section helpers: all assertions passed" (now ~40 assertions including the 4 new SRS-field blocks).
- `node tests/repLogs.test.mjs` → "rep-log helpers: all assertions passed".
- `node tests/srs.test.mjs` → "srs helpers: all assertions passed" (~60 assertions).
- `node tests/titleFromFilename.test.mjs` → "titleFromFilename: all assertions passed".
- Cross-checked every `getElementById('…')` in `app.js` (33 unique ids) against `id="…"` in `index.html` — `comm -23` returned the empty set, so every id app.js looks up exists.
- Verification was run by mirroring source files into the sandbox-mounted outputs folder and running Node there, since the canonical project path under C:\Users\adria\Documents\ isn't directly mounted in the workspace shell.

**Next suggested step**

- Roadmap item 7: daily review queue. On app open, walk every section in IDB, filter to `nextDue && nextDue <= todayISO && (no rep-log today OR repCountToday < REP_GOAL)`, and render them in a new "Due today" panel above the piece library or in the viewer's empty-state. Clicking one selects its piece, opens the practice panel for that section, and scrolls to its page. Implementation note: the schema already has everything we need — no schema bump. We can decide during implementation whether to add a `byNextDue` index on `sections` (cheap if useful) or just walk the store; for personal libraries up to a few hundred sections, walking is fine.

**Open design questions**

- For item 7: should sections that are due-but-already-completed-today (rep count >= 10 today AND lastReviewedDate === today) drop off the queue entirely, or stay visible with a "Done · 10/10" treatment? Lean toward dropping off — the queue is for "what still needs practice today" and showing completed items risks the user re-practicing the same section twice in a day, which the SM-2 guard already ignores anyway.
- For item 7: when a section's `nextDue` is days into the future, should we surface "review-ahead" sections at all (e.g. "you can practice these early")? Anki has this as a separate "preview" mode. Probably out of scope for item 7 and easier to add as item 9 polish once stats land.
- For item 8 (rating prompt): where does it appear — replacing the green next-review card, or as a modal that the user has to dismiss before seeing the new schedule? Modal feels heavy for a 10-click cadence; a "Pick a rating" inline replacement of the next-review card is probably the right move, with the chosen rating then fed into `maybeFireSm2(..., quality)`.

## 2026-04-27 — Roadmap item 5 (Review rep counter)

**Built today**

- Bumped the IndexedDB schema to v3: added a `repLogs` object store keyed on a composite-string `id` (`${sectionId}|${dateISO}`) so a single get-by-id is enough to find today's count for a section. Two non-unique indexes — `bySectionId` (for future per-section history in item 9) and `byDateISO` (for the "due today" cross-piece queue in item 7) — set up the future-facing query paths without an extra schema bump.
- Section record shape: `{ id, sectionId, dateISO, count, createdAt, updatedAt }`. `count` is a plain integer; the cap at 10 lives in the UI, not the persistence layer (kept reusable for an eventual import flow + the item-8 "rate after goal" branch that may want >10 reps logged).
- New persistence surface in `db.js`: `getRepLog`, `saveRepLog`, `incrementRepLog` (atomic get+put inside a single readwrite tx so jittery double-clicks can't drop an increment), `setRepLogCount` (used by Undo / Reset; updates an existing record to the target count, no-ops if zeroing a non-existent record), `getRepCountsForSections` (single-tx batch get across the active piece's sections — powers the "X / 10" badges without N round-trips), and `listRepLogsForSection` (defined now for item 9 stats).
- Six new pure helpers exported for testing: `REP_GOAL` (constant, 10), `localDateISO(date)` (formats a Date as YYYY-MM-DD in the user's local tz — settles the open design question from yesterday), `repLogId(sectionId, dateISO)`, `newRepLogRecord`, `bumpRepLog` (pure projection mirroring `incrementRepLog`'s state machine), and `isRepGoalMet`.
- New "Practice panel" surface inside the viewer, between the sections panel and the PDF page column. Header shows "Practicing · [section name] · Page N · measures" plus a Stop button. Below: a giant tabular-numerals counter ("3 / 10 reps today"), a thin progress bar that fills toward the goal, and a big chunky "✓ Successful repetition" button. Below the button: a small status line + Undo / Reset secondary actions.
- Each section row in the sections panel now has a "Practice" button (alongside Edit/Delete). Clicking Practice opens the practice panel for that section, scrolls the PDF viewer to the section's page, highlights the row in the list, and reconciles the count against IDB to handle the case where the in-memory cache is stale.
- Each section row also shows a "X / 10 today" pill when `count > 0`, switching to a green "Done · 10/10" pill once the goal is met. Hidden until the user has at least one rep so the panel stays calm on a fresh piece.
- Click handler is optimistic: the in-memory count and badge update immediately, then `incrementRepLog` writes through and reconciles. On IDB failure the count rolls back and the status bar surfaces the error.
- Goal-met UI: the rep button disables, recolors green, and relabels to "Practiced 10× today". A status line surfaces: "Nice — 10 clean reps today. SRS scheduling lands in step 6." Undo / Reset stay enabled.
- Switching pieces, deleting the section being practiced, or hitting Stop all close the practice panel cleanly. Switching pieces also clears the per-piece rep-count cache so badges repaint.
- Bumped `APP_VERSION` to 0.5.0 and the footer version badge to v0.5.0.
- Added `tests/repLogs.test.mjs` with ~25 assertions covering every pure helper: REP_GOAL constant, isRepGoalMet across edge inputs, localDateISO with explicit Dates (2026-04-27, 2026-01-01, 2099-12-31, no-arg shape), repLogId composite format, newRepLogRecord (full passthrough, auto-fill timestamps, count coercion for negative/NaN/string/fractional), bumpRepLog (new-day path, existing-record path with non-mutation guarantee, missing-count defensive path, no-cap-at-goal), and an exported-surface check covering every new symbol.

**Files changed**

- `db.js` — bumped to DB v3; added repLogs store + two indexes, `REP_GOAL` constant, six new IDB functions, six new pure helpers.
- `app.js` — added practice state + per-piece rep-count cache, `openPracticeView` / `closePracticeView` / `renderPracticePanel`, optimistic `handleRepClick` with rollback, `handleUndoRep`, `handleResetReps`, section-list "Practice" button + "X / 10" badge, init wiring for the four new buttons. Cleared practice state on piece-switch and on deletion of the practicing section. Bumped `APP_VERSION` to 0.5.0.
- `index.html` — inserted the practice-panel markup (header with section name + Stop, big counter, progress track, big rep button, status line, Undo/Reset row) into `#viewer-pdf` between `#sections-panel` and `#pdf-pages`. Bumped footer version to v0.5.0.
- `styles.css` — new styles for `.practice-panel`, `.practice-counter`, `.practice-progress-track/-fill`, `.practice-rep-btn` (large + chunky + complete-state), `.practice-status`, `.practice-secondary-actions`, plus `.section-list-rep-badge` (with done variant), `.btn-practice`, and a `.section-list-item.practicing` highlight. Mobile breakpoint stacks the practice panel header.
- `tests/repLogs.test.mjs` — new.
- `ROADMAP.md` — item 5 checked off.
- `PROGRESS.md` — this entry.

**Design decisions**

- "Today" = local-calendar-day boundary (resolves the open question carried into this run). `localDateISO` is implemented via `getFullYear/getMonth/getDate` rather than `toISOString` so the date is always in the user's local tz — matches the pianist's mental model of a practice day. Future SM-2 work (item 6) will use the same helper.
- 10-rep goal hard-coded as `REP_GOAL` for now (also resolved from yesterday's open question). Putting it in db.js means the UI, the persistence layer, and any future stats view all reference the same constant. If item 9 (per-piece retention) wants per-section goals, we add an optional `goal` field to the section record without touching this code.
- Rep logs in their own store, not embedded on the section record. Reasons: writes are very high-frequency (one per button click) and we don't want to rewrite the whole section row on each one; the `byDateISO` index makes "everything touched today" a single range scan for item 7; and the row is small enough that the get+put in a single readwrite tx finishes well under a frame at any realistic rep count.
- Composite-string id (`${sectionId}|${dateISO}`) over a compound `[sectionId, dateISO]` keyPath. Same lookup uniqueness either way, but `getRepLog(sectionId, dateISO)` is one `get(stringId)` instead of an `IDBKeyRange.only([…])` dance — matches the simplicity of pieces/sections.
- Optimistic UI updates with rollback on failure. A piano practice session has to feel snappy — the user's already self-reporting reps; making them wait for an IDB round-trip per click would actively discourage the behaviour. The cap-at-goal logic lives only in the UI layer; the persistence helper happily accepts higher counts so item 8 (post-session rating) can let the user log an "Again" warm-up before a clean attempt.
- One global practice panel rather than expanding each section row in place. The user can only be practising one section at a time, the active row is already highlighted with a `.practicing` class + disabled-button affordance, and a single panel is much less DOM churn than swap-in-place per row.
- Disable rep button at goal (instead of letting it tick to 11+). Anki's flow is "ten clean reps → done"; encouraging more on the same calendar day muddies the SM-2 input that lands in item 6/8. Undo + Reset are always available for mis-clicks.
- Per-section "X / 10" badge hidden until count > 0. Keeps the section panel visually quiet on a freshly-created piece — the badges become useful precisely when there's something to track.

**Verification**

- `node --check db.js` → ok.
- `node --check app.js` → ok.
- `node tests/db.test.mjs` → "db helpers: all assertions passed".
- `node tests/sections.test.mjs` → "section helpers: all assertions passed".
- `node tests/repLogs.test.mjs` → "rep-log helpers: all assertions passed" (~25 assertions).
- `node tests/titleFromFilename.test.mjs` → all assertions passed.
- Manually traced every `getElementById` in `app.js` (32 ids) to a matching `id="…"` in `index.html` — including the 12 new practice-panel ids.
- Verification was run by mirroring the source files into the sandbox-mounted outputs folder and running Node there, since the canonical project path under C:\Users\adria\Documents\Claude\ isn't directly mounted in the workspace shell.

**Next suggested step**

- Roadmap item 6: SRS scheduling with SM-2. Once a section reaches 10 reps for a day, compute and store its next-due date. The section record already has room for `interval`, `ease`, and `nextDue` fields — they can be added on the next save without a schema bump. The rating prompt itself ("Again / Hard / Good / Easy") is item 8; for item 6 a default rating of "Good" is fine, with the prompt layered on later. The math: SM-2 starts ease=2.5, interval (days) cycles `1 → 6 → ceil(prev * ease)`, ease updates on each rating. Trigger point: a transition from `count < REP_GOAL` to `count >= REP_GOAL` inside `handleRepClick` — feed it a default-Good rating, persist `interval` / `ease` / `nextDue` onto the section record, and surface the result in the practice panel ("Next review: 2026-05-04").

**Open design questions**

- For item 6: should the SM-2 update fire immediately on the 10th rep click, or only when the user dismisses the practice panel? Leaning fire-on-10th-click — that gives an instant "Next review: …" reward in the same session. The rating prompt in item 8 can later replace the default-Good fire with a real rating choice.
- For item 6: what happens if the user resets the count from 10 back to a lower number (Reset / Undo) AFTER SM-2 has already fired? Probably leave the schedule alone — Reset is for typo correction, not "undo my SRS update". But worth surfacing this in the UI ("Resetting won't change the next-review date").
- For item 7: the badge already shows "Done · 10/10" for goal-met sections. The daily review queue likely wants the inverse view — sections with `nextDue <= today` and either no count today or count < goal. The `byDateISO` index isn't quite right for that query; we may want a `byNextDue` index on sections in item 6's schema work.

## 2026-04-26 — Roadmap item 4 (Section definition UI)

**Built today**

- Bumped the IndexedDB schema to v2: added a `sections` object store keyPath'd on `id`, with a non-unique `byPieceId` index. The v1→v2 upgrade is idempotent (only creates the store if missing) so existing libraries from yesterday keep their pieces.
- New persistence surface in `db.js`: `listSectionsForPiece(pieceId)`, `saveSection(record)`, `deleteSection(id)`, `deleteSectionsForPiece(pieceId)` (cursor-based cascade — defined now even though no delete-piece UI exists, so it's ready for whichever roadmap item adds one).
- Section record shape: `{ id, pieceId, name, pageNumber, measures, addedAt, order }`. Page numbers are 1-based PDF page indices (resolves the open question carried forward from 2026-04-24/25). Sort order is `order ASC, addedAt ASC` so reordering can ride on top of `order` without rewriting the rest.
- Two pure helpers exported for testing: `sectionToRecord` (auto-fills `addedAt` and `order`, preserves explicit `0`s, normalises `measures` to a string) and `validateSectionInput(raw, { maxPage })` which returns `{ ok, value }` or `{ ok: false, errors }`. Validation is shared between the form-submit path and (eventually) any import flow in roadmap item 10.
- New sections panel in the viewer (between the title and the PDF pages) with: an `+ Add section` button, a single in-place form that swaps between "add" and "edit" modes, and a per-piece list of sections. Each row shows name + `Page N · measures`, with `Edit` and `Delete` buttons. Clicking the row body smooth-scrolls the PDF viewer to that page (uses `scrollIntoView` against the existing `data-page-number` attributes on page hosts).
- Section data is lazy-loaded on first piece selection (mirrors the lazy-PDF pattern) and cached on the in-memory piece object as `piece.sections`. Form errors render inline in a small red banner; saves degrade gracefully if IDB is unavailable (the form keeps the user's input and surfaces the error).
- Esc closes the form; Delete prompts a `window.confirm` before removing.
- Bumped `APP_VERSION` to 0.4.0 and the footer version badge to v0.4.0.
- Added `tests/sections.test.mjs` with ~30 assertions covering validateSectionInput (happy path, trim semantics, missing/zero/negative/fractional/string/null/NaN page numbers, maxPage upper bound including the friendlier "only 1 page" message, name length cap, measures length cap, multiple errors at once) and sectionToRecord (full passthrough, addedAt+order auto-fill, explicit `0` preservation for both fields, non-string measures coercion, exported-surface check).

**Files changed**

- `db.js` — bumped to DB v2; added sections store + index, four new IDB functions, and two new pure helpers.
- `app.js` — added section state, panel rendering, form open/submit/cancel/delete handlers, page-scroll, and lazy section hydration. Bumped `APP_VERSION` to 0.4.0.
- `index.html` — inserted the sections panel markup (header, form, list) into `#viewer-pdf`. Bumped footer version to v0.4.0.
- `styles.css` — new styles for `.sections-panel`, `.section-form*`, `.section-list*`, `.btn-sm`, `.btn-danger`, plus a mobile-friendly grid stack at <720px.
- `tests/sections.test.mjs` — new.
- `ROADMAP.md` — item 4 checked off.
- `PROGRESS.md` — this entry.

**Design decisions**

- Page numbers = 1-based PDF page index (matches the rendered "Page N" badge and the `data-page-number` attribute already on each page host). Avoids forcing the user to type the printed page number, which can differ on prefixed scores (front matter, dedications, etc.). Re-evaluate when the daily review queue lands in item 7 if pianists prefer the printed number — the schema supports a future `printedPage` field without disruption.
- Sections in their own object store (not embedded in the piece record). Reasons: editing a section shouldn't rewrite a multi-MB PDF blob; "all due sections across all pieces" (item 7) maps to a single store walk; section deletion can be cascaded via a cursor without touching pieces. Confirmed the leaning from the previous run.
- One in-place form for add+edit instead of per-row inline forms. Less DOM churn, less duplicate state, and the user can only be editing one thing at a time anyway.
- The form has a `maxPage` ceiling derived from the active piece's `pageCount`, surfaced both as the `<input type="number" max="…">` attribute and inside `validateSectionInput`. Belt-and-braces against bad input.
- `order` is initialised to `maxOrder + 1` for new sections so they append. A future drag-to-reorder UI can rewrite `order` values without touching `addedAt`.
- Delete uses `window.confirm`. A custom modal is overkill at this stage; if a future polish pass wants undo, that's a more interesting design conversation than confirm-vs-modal.

**Verification**

- `node --check db.js` → ok.
- `node --check app.js` → ok.
- `node tests/db.test.mjs` → "db helpers: all assertions passed" (existing tests still pass after the schema bump and new exports).
- `node tests/sections.test.mjs` → "section helpers: all assertions passed" (~30 assertions).
- Manually traced every `getElementById` in `app.js` to a matching `id="…"` in `index.html` (all 21 ids are present, including the 11 new section-panel ids).
- Verification was run by mirroring the source files into the sandbox-mounted outputs folder and running Node there, since the canonical project path under C:\Users\adria\Documents\Claude\ isn't directly mounted in the workspace shell.

**Next suggested step**

- Roadmap item 5: review rep counter. When a section is selected (or "active for review"), show a big "Successful repetition" button that increments toward a per-day goal of 10. Persist the daily count under a new `repLogs` (or `sessionLogs`) IDB store keyed by `{ sectionId, dateISO }` so the counter survives a refresh mid-practice. Wire the UI into the existing sections panel — probably as a "Practice" affordance on the active section row, expanding into a counter view in the main viewer.

**Open design questions**

- For item 5: do we treat "today" as a calendar day in the user's local timezone (boundary at local midnight) or use a sliding 24h window? Default to local-midnight — matches the user's mental model for "today's practice". Also: should the goal be hard-coded at 10 reps, or per-section configurable? Stick with 10 globally for now; revisit when item 9 (per-piece retention) lands.
- For item 7 (review queue): should the section list in the viewer show due-status badges? Probably yes once SM-2 is wired in (item 6) — the schema already has space for `nextDue`, `interval`, `ease` fields on the section record without a v3 upgrade (we can just write the new fields on the next save).

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
