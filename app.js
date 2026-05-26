// PianoSRS — main app entry point.
//
// Roadmap items shipped here:
//   1. Basic shell layout (sidebar + viewer + status bar).
//   2. PDF upload via file input + PDF.js rendering (continuous scroll).
//   3. IndexedDB persistence — pieces survive a refresh.
//   4. Section definition UI — create/edit/delete named sections per piece,
//      each with a 1-based PDF page number and a free-text measure range
//      (e.g. "mm. 17–32"). Click a section to scroll to its page.
//   5. Review rep counter — for a chosen section, a big "Successful
//      repetition" button increments toward a daily goal of 10. The count
//      persists across refreshes (per local-calendar-day, per section) so
//      a mid-practice reload doesn't lose progress. Each section row in the
//      sections panel shows today's "X / 10" badge so the user can see
//      progress at a glance.
//   6. SRS scheduling (SM-2). When today's count crosses from <10 to >=10
//      for the first time, fire the SM-2 algorithm with a default-Good
//      rating (item 8 will replace the default with a real prompt). Persist
//      `repetitions` / `interval` / `ease` / `nextDue` / `lastReviewedDate`
//      onto the section record and surface the new "Next review" date
//      both in the practice panel and as a small pill on the section row.
//   7. Daily review queue. On app open (and after any rep-log change), walk
//      every section across every piece, filter to those whose `nextDue` is
//      today or earlier AND haven't already met today's rep goal, and render
//      them in a "Due today" panel inside the welcome placeholder. Clicking
//      a queue item selects its piece, opens the practice panel for that
//      section, and scrolls to the section's page — one click from "what do
//      I need to practice?" to "I'm practising it now".
//   8. Post-session rating. Once a section reaches today's rep goal, replace
//      the auto-Good fire of SM-2 with a real Again/Hard/Good/Easy prompt
//      inside the practice panel. Each rating button shows its projected
//      next-review distance ("Again → tomorrow / Good → in 6d") so the user
//      sees what they're committing to. Until the user picks a rating, the
//      schedule isn't persisted — closing the panel without rating leaves
//      the section unscheduled (the next open re-shows the prompt).
//   9. Progress stats. A "Progress" panel above the daily-review queue on
//      the welcome placeholder. Three tiles (daily streak, sections
//      mastered, sections in rotation) plus a header line summarising
//      today's done-of-due count, plus a per-piece retention bar list. The
//      panel hydrates once on app open from `listDistinctPracticeDates` and
//      then mutates incrementally as the user logs reps / picks ratings —
//      no extra IDB walks per click.
//  10. Export/import. Export the full library (pieces with base64-encoded
//      PDFs, sections with SRS state, rep logs) as a single JSON file the
//      user downloads. Import reads that file back in, using a 'rename'
//      collision policy: imported items get fresh IDs if they collide with
//      existing data, so no data is silently destroyed.
//  11. Polish — keyboard shortcuts (first slice). Global keydown listener
//      with an input-focus guard. Space = log rep, 1-4 = pick rating,
//      ArrowLeft/Right = prev/next PDF page, Escape = close practice
//      panel or section form. Dark mode and mobile layout are next slices.
//
// Architecture notes:
//   - Pieces are hydrated as metadata only on app open; the PDF Blob loads
//     lazily on first selection (item 3).
//   - Sections live in their own IDB store with a byPieceId index. They're
//     loaded the first time a piece is selected and then cached on the
//     in-memory piece object so re-selection doesn't re-hit IDB.
//   - The section form is a single in-place form that swaps between "add"
//     and "edit" modes — simpler than per-row inline forms while still
//     keeping the UI compact.
//   - Rep logs live in their own IDB store, keyed by `${sectionId}|${dateISO}`.
//     The practice panel keeps an in-memory mirror of today's count for the
//     active section so successive button clicks don't have to await IDB
//     reads — IDB writes still happen, but the UI updates optimistically.
//   - SRS state lives directly on the section record (optional fields that
//     are only written once a section has been rated at least once). Reset /
//     Undo on the rep counter intentionally do NOT roll back the schedule —
//     once the user has self-confirmed 10 clean reps, the SM-2 update stands
//     for the day. The `lastReviewedDate` guard prevents double-firing if
//     the user goes 10 → 9 → 10 in the same day.

// Dependencies loaded via classic <script> tags in index.html (db.js,
// srs.js, metronome.js) — all symbols are available as globals.

const APP_VERSION = '0.19.0'; // cumulative time in practice header + per-piece stats

const PDFJS_VERSION = '3.11.174';
const PDFJS_WORKER_URL =
  `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${PDFJS_VERSION}/pdf.worker.min.js`;

// Render scale for PDF pages. 1.5 looks sharp on most displays without
// blowing memory up on multi-page scores. Tweak in roadmap item 11 polish.
const PDF_RENDER_SCALE = 1.5;

const els = {
  status: document.getElementById('app-status'),
  addPieceBtn: document.getElementById('add-piece-btn'),
  fileInput: document.getElementById('pdf-file-input'),
  pieceList: document.getElementById('piece-list'),
  viewerPlaceholder: document.getElementById('viewer-placeholder'),
  viewerPdf: document.getElementById('viewer-pdf'),
  viewerPdfTitle: document.getElementById('viewer-pdf-title'),
  viewerPdfMeta: document.getElementById('viewer-pdf-meta'),
  pdfPages: document.getElementById('pdf-pages'),
  // Sections panel (item 4)
  sectionsPanel: document.getElementById('sections-panel'),
  addSectionBtn: document.getElementById('add-section-btn'),
  sectionForm: document.getElementById('section-form'),
  sectionFormTitle: document.getElementById('section-form-title'),
  sectionNameInput: document.getElementById('section-name-input'),
  sectionPageInput: document.getElementById('section-page-input'),
  sectionMeasuresInput: document.getElementById('section-measures-input'),
  sectionNotesInput: document.getElementById('section-notes-input'),
  sectionFormError: document.getElementById('section-form-error'),
  sectionFormCancel: document.getElementById('section-form-cancel'),
  sectionFormSubmit: document.getElementById('section-form-submit'),
  sectionList: document.getElementById('section-list'),
  // Practice panel (item 5)
  practicePanel: document.getElementById('practice-panel'),
  practiceSectionName: document.getElementById('practice-section-name'),
  practiceSectionMeta: document.getElementById('practice-section-meta'),
  practiceSectionNotes: document.getElementById('practice-section-notes'),
  practiceCount: document.getElementById('practice-count'),
  practiceGoal: document.getElementById('practice-goal'),
  practiceProgressTrack: document.getElementById('practice-progress-track'),
  practiceProgressFill: document.getElementById('practice-progress-fill'),
  practiceRepBtn: document.getElementById('practice-rep-btn'),
  practiceStatus: document.getElementById('practice-status'),
  practiceNextReview: document.getElementById('practice-next-review'),
  practiceRatingPrompt: document.getElementById('practice-rating-prompt'),
  practiceRatingButtons: document.getElementById('practice-rating-buttons'),
  practiceUndoBtn: document.getElementById('practice-undo-btn'),
  practiceResetBtn: document.getElementById('practice-reset-btn'),
  practiceCloseBtn: document.getElementById('practice-close-btn'),
  practiceTimer: document.getElementById('practice-timer'),
  practiceTimerPauseBtn: document.getElementById('practice-timer-pause-btn'),
  practiceTotalTime: document.getElementById('practice-total-time'),
  // Review queue (item 7)
  reviewQueuePanel: document.getElementById('review-queue-panel'),
  reviewQueueList: document.getElementById('review-queue-list'),
  reviewQueueCount: document.getElementById('review-queue-count'),
  // Export/import (item 10)
  exportBtn: document.getElementById('export-btn'),
  importBtn: document.getElementById('import-btn'),
  importFileInput: document.getElementById('import-file-input'),
  // Mobile sidebar toggle (item 11c)
  sidebarToggle: document.getElementById('sidebar-toggle'),
  sidebarBackdrop: document.getElementById('sidebar-backdrop'),
  sidebar: document.getElementById('sidebar'),
  // Dark mode toggle (item 11b)
  themeToggle: document.getElementById('theme-toggle'),
  themeToggleIcon: null, // populated after DOM query
  themeToggleLabel: null,
  // Stats panel (item 9)
  statsPanel: document.getElementById('stats-panel'),
  statsPanelToday: document.getElementById('stats-panel-today'),
  statsStreakValue: document.getElementById('stats-streak-value'),
  statsStreakDetail: document.getElementById('stats-streak-detail'),
  statsMasteredValue: document.getElementById('stats-mastered-value'),
  statsMasteredDetail: document.getElementById('stats-mastered-detail'),
  statsRatedValue: document.getElementById('stats-rated-value'),
  statsRatedDetail: document.getElementById('stats-rated-detail'),
  statsPerPiece: document.getElementById('stats-per-piece'),
  statsPerPieceList: document.getElementById('stats-per-piece-list'),
  // Practice history chart (item 12c)
  statsHistoryChart: document.getElementById('stats-history-chart'),
  statsHistoryChartContainer: document.getElementById('stats-history-chart-container'),
  // Metronome (item 12b)
  metronomeWidget: document.getElementById('metronome-widget'),
  metronomeBpmInput: document.getElementById('metronome-bpm-input'),
  metronomeDecBtn: document.getElementById('metronome-dec-btn'),
  metronomeIncBtn: document.getElementById('metronome-inc-btn'),
  metronomeToggleBtn: document.getElementById('metronome-toggle-btn'),
  metronomeToggleLabel: document.getElementById('metronome-toggle-label'),
  metronomeTapBtn: document.getElementById('metronome-tap-btn'),
  metronomeBeatIndicator: document.getElementById('metronome-beat-indicator'),
  metronomeCollapseBtn: document.getElementById('metronome-collapse-btn'),
  metronomeBody: document.getElementById('metronome-body'),
  // Crop region (section-scoped view)
  sectionCropBtn: document.getElementById('section-crop-btn'),
  sectionCropClearBtn: document.getElementById('section-crop-clear-btn'),
  sectionCropStatus: document.getElementById('section-crop-status'),
};

/**
 * In-memory piece library. Each entry:
 *   {
 *     id: string,
 *     title: string,
 *     pageCount: number,
 *     addedAt: number,
 *     pdfDoc?: PDFDocumentProxy,    // populated lazily on first selection
 *     pdfData?: ArrayBuffer,        // bytes backing pdfDoc (kept for re-render)
 *     sections?: Array<SectionRecord>, // populated lazily on first selection
 *   }
 */
const pieces = [];
let activePieceId = null;
// Monotonically incrementing token so a slow render of an old PDF can't
// clobber the viewer when the user has already clicked another piece.
let renderToken = 0;

/**
 * Section form state. `null` = closed; `{ mode: 'add' }` = creating;
 * `{ mode: 'edit', id: 's_xxx' }` = editing existing section.
 */
let sectionFormState = null;

/**
 * Crop selection state. When the user clicks "Select on page" in the section
 * form, we enter crop-selection mode. The user drags vertically on the target
 * PDF page to define the crop region. The result (normalised 0–1 fractions)
 * is stored here until the section form is submitted.
 */
let pendingCrop = null;   // { y1: number, y2: number } or null
let cropOverlayCleanup = null; // function to tear down the overlay

/**
 * Practice state. `null` = no active practice; otherwise:
 *   {
 *     sectionId: string,
 *     dateISO: string,
 *     count: number,
 *     saving: boolean,
 *     ratingInFlight: boolean,
 *     timerStartedAt: number,  // Date.now() when session opened
 *     timerElapsed: number,    // accumulated ms (for pause/resume)
 *     timerPaused: boolean,    // true when timer is paused
 *   }
 *
 * `count` is the in-memory mirror of today's persisted count for the active
 * section. We update it optimistically on each rep click so the UI stays
 * responsive; a parallel IDB write keeps the persisted state in sync.
 * `saving` is true while a write is in flight — used to disable the rep
 * button briefly to avoid double-fire on jittery clicks.
 * `ratingInFlight` is true while the user's chosen rating is being persisted
 * to IDB — disables the rating buttons so a second click can't fire SM-2
 * twice for the same session.
 */
let practiceState = null;

/** Interval handle for the practice timer tick. */
let practiceTimerInterval = null;

/**
 * Metronome controller (item 12b). Lazily created on first use so the
 * AudioContext isn't allocated until the user actually interacts with it.
 * @type {ReturnType<typeof createMetronome> | null}
 */
let metronome = null;

/** Flash timeout handle for the beat indicator. */
let beatFlashTimeout = null;

/**
 * Rep counts for the active piece's sections, keyed by sectionId. Populated
 * once the piece is hydrated, kept in sync as the user logs reps. Powers the
 * "X / 10" badge on each section row without re-querying IDB on every render.
 */
const repCountsToday = new Map();

/**
 * Cross-piece queue state (item 7). We keep raw section + piece + rep-count
 * snapshots so the queue can be re-rendered without an extra IDB walk on
 * every increment — only the actively-changed section's count needs to
 * update for the filter to recompute.
 *
 *   queueState = {
 *     dateISO: 'YYYY-MM-DD',
 *     sections: Array<SectionRecord>,    // every section across every piece
 *     pieceTitleById: Map<string,{id,title,pageCount}>,
 *     countsByDate: Map<string,number>,  // sectionId → count today
 *   }
 *
 * Set to null while the very first hydration is in flight.
 */
let queueState = null;
let queueClickInFlight = false;

/**
 * Stats snapshot (item 9). Holds the distinct set of dates the user has
 * practiced on (used for the daily-streak computation) plus the most
 * recently-rendered summary shape so re-renders triggered by an in-session
 * rep-click can recompute without re-walking IDB.
 *
 *   statsState = {
 *     practiceDates: Set<string>,   // YYYY-MM-DD strings
 *     dateISO: string,              // todayISO at the time of last refresh
 *   }
 */
let statsState = null;

/** Set the small status line in the footer. */
function setStatus(message) {
  if (els.status) {
    els.status.textContent = message;
  }
}

// --- Piece sidebar -------------------------------------------------------

/**
 * Render the piece list in the sidebar.
 * @param {Array<{id: string, title: string, pageCount: number}>} list
 */
function renderPieceList(list) {
  if (!els.pieceList) return;
  els.pieceList.innerHTML = '';
  if (!list || list.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'piece-list-empty';
    empty.innerHTML =
      'No pieces yet. Click <strong>+ Add piece</strong> to upload a PDF.';
    els.pieceList.appendChild(empty);
    return;
  }
  for (const piece of list) {
    const li = document.createElement('li');
    li.className = 'piece-list-item';
    if (piece.id === activePieceId) li.classList.add('active');
    li.dataset.pieceId = piece.id;
    li.tabIndex = 0;
    li.setAttribute('role', 'button');

    const infoWrap = document.createElement('div');
    infoWrap.className = 'piece-list-item-info';

    const title = document.createElement('span');
    title.className = 'piece-list-item-title';
    title.textContent = piece.title;
    infoWrap.appendChild(title);

    const meta = document.createElement('span');
    meta.className = 'piece-list-item-meta';
    meta.textContent =
      piece.pageCount === 1 ? '1 page' : `${piece.pageCount} pages`;
    infoWrap.appendChild(meta);

    li.appendChild(infoWrap);

    const renameBtn = document.createElement('button');
    renameBtn.className = 'piece-list-item-rename';
    renameBtn.type = 'button';
    renameBtn.title = 'Rename piece';
    renameBtn.setAttribute('aria-label', `Rename ${piece.title}`);
    renameBtn.textContent = '✎';
    renameBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      startInlineRename(li, piece);
    });
    li.appendChild(renameBtn);

    const delBtn = document.createElement('button');
    delBtn.className = 'piece-list-item-delete';
    delBtn.type = 'button';
    delBtn.title = 'Delete piece';
    delBtn.setAttribute('aria-label', `Delete ${piece.title}`);
    delBtn.textContent = '×'; // × symbol
    delBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      handleDeletePiece(piece.id, piece.title);
    });
    li.appendChild(delBtn);

    infoWrap.addEventListener('click', () => selectPiece(piece.id));
    li.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        selectPiece(piece.id);
      }
    });
    els.pieceList.appendChild(li);
  }
}

/**
 * Delete a piece after confirmation: cascade-delete its sections and rep logs,
 * remove the piece record from IDB, remove from in-memory array, and refresh
 * the UI (sidebar, review queue, stats).
 */
async function handleDeletePiece(pieceId, title) {
  const ok = window.confirm(
    `Delete "${title}" and all its sections, practice history, and SRS data?\n\nThis cannot be undone.`,
  );
  if (!ok) return;

  try {
    // Gather section IDs for rep-log cascade before deleting sections.
    const sections = await listSectionsForPiece(pieceId);
    const sectionIds = sections.map((s) => s.id);

    // Cascade: rep logs → sections → piece.
    if (sectionIds.length > 0) {
      await deleteRepLogsForSections(sectionIds);
    }
    await deleteSectionsForPiece(pieceId);
    await deletePiece(pieceId);

    // Remove from in-memory array.
    const idx = pieces.findIndex((p) => p.id === pieceId);
    if (idx !== -1) pieces.splice(idx, 1);

    // If the deleted piece was active, clear the viewer back to the welcome
    // placeholder.
    if (activePieceId === pieceId) {
      activePieceId = null;
      closePracticeView({ silent: true });
      closeSectionForm();
      if (els.viewerPdf) els.viewerPdf.hidden = true;
      if (els.viewerPlaceholder) els.viewerPlaceholder.hidden = false;
    }

    renderPieceList(pieces);
    // Refresh the review queue and stats since sections may have been removed
    // from the due-today queue.
    await refreshReviewQueue();
    await refreshStats();
    setStatus(`Deleted "${title}".`);
  } catch (err) {
    console.error('Failed to delete piece', err);
    setStatus(`Failed to delete "${title}": ${err.message || err}`);
  }
}

/**
 * Inline-rename: replace the piece's info area with an input field.
 * Commit on Enter/blur, cancel on Escape.
 */
function startInlineRename(li, piece) {
  // Prevent double-activation.
  if (li.querySelector('.piece-rename-input')) return;

  const infoWrap = li.querySelector('.piece-list-item-info');
  const originalHTML = infoWrap.innerHTML;

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'piece-rename-input';
  input.value = piece.title;
  input.setAttribute('aria-label', 'New name for piece');

  infoWrap.innerHTML = '';
  infoWrap.appendChild(input);
  input.focus();
  input.select();

  let committed = false;

  async function commit() {
    if (committed) return;
    committed = true;
    const newTitle = input.value.trim();
    if (!newTitle || newTitle === piece.title) {
      // Revert — no change.
      infoWrap.innerHTML = originalHTML;
      return;
    }
    try {
      await renamePiece(piece.id, newTitle);
      piece.title = newTitle;
      renderPieceList(pieces);
      // Also update the viewer header if this piece is active.
      if (activePieceId === piece.id && els.viewerPdfTitle) {
        els.viewerPdfTitle.textContent = newTitle;
      }
      setStatus(`Renamed to "${newTitle}".`);
    } catch (err) {
      console.error('Rename failed', err);
      infoWrap.innerHTML = originalHTML;
      setStatus(`Rename failed: ${err.message || err}`);
    }
  }

  function cancel() {
    if (committed) return;
    committed = true;
    infoWrap.innerHTML = originalHTML;
  }

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); commit(); }
    if (e.key === 'Escape') { e.preventDefault(); cancel(); }
  });
  input.addEventListener('blur', () => commit());
}

/**
 * Derive a human-readable piece title from a filename.
 * Strips the extension and replaces underscores/dashes with spaces.
 * Exported for unit testing.
 */
function titleFromFilename(filename) {
  if (!filename) return 'Untitled';
  const noExt = filename.replace(/\.[^.]+$/, '');
  const cleaned = noExt.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
  return cleaned || 'Untitled';
}

/** Generate a short, sortable id for a new piece. */
function newPieceId() {
  return `p_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

/** Generate a short, sortable id for a new section. */
function newSectionId() {
  return `s_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

/** Read a File (or Blob) as an ArrayBuffer. */
function readBlobAsArrayBuffer(blob) {
  if (blob && typeof blob.arrayBuffer === 'function') {
    return blob.arrayBuffer();
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error('Blob read failed'));
    reader.readAsArrayBuffer(blob);
  });
}

/**
 * Load a PDF (given its raw bytes) via PDF.js. Returns a PDFDocumentProxy.
 * We pass a fresh Uint8Array each time — PDF.js consumes the buffer.
 */
async function loadPdfDocument(arrayBuffer) {
  if (!window.pdfjsLib) {
    throw new Error('PDF.js failed to load from CDN');
  }
  const bytes = new Uint8Array(arrayBuffer.slice(0));
  const loadingTask = window.pdfjsLib.getDocument({ data: bytes });
  return loadingTask.promise;
}

// --- Upload --------------------------------------------------------------

/** Handle a chosen file: parse, persist to IDB, then add to the in-memory list. */
async function handlePdfFile(file) {
  if (!file) return;
  if (file.type && file.type !== 'application/pdf' &&
      !/\.pdf$/i.test(file.name)) {
    setStatus(`"${file.name}" doesn't look like a PDF — ignored.`);
    return;
  }
  setStatus(`Loading "${file.name}"…`);
  try {
    const arrayBuffer = await readBlobAsArrayBuffer(file);
    const pdfDoc = await loadPdfDocument(arrayBuffer);
    const piece = {
      id: newPieceId(),
      title: titleFromFilename(file.name),
      pageCount: pdfDoc.numPages,
      addedAt: Date.now(),
      pdfData: arrayBuffer,
      pdfDoc,
      sections: [], // freshly uploaded — no sections yet
    };

    // Persist BEFORE updating the UI so a refresh after upload always sees
    // exactly what was rendered.
    const blob = new Blob([arrayBuffer], { type: 'application/pdf' });
    try {
      await savePiece(pieceToRecord(piece, blob));
    } catch (err) {
      console.warn('IndexedDB save failed; piece will live in memory only', err);
      setStatus(
        `Added "${piece.title}" but couldn't save it — refresh will lose it.`,
      );
    }

    // Auto-create one section per page so the user has something to
    // practice immediately after uploading.
    const now = Date.now();
    for (let p = 1; p <= piece.pageCount; p++) {
      const sec = {
        id: newSectionId(),
        pieceId: piece.id,
        name: `Page ${p}`,
        pageNumber: p,
        measures: '',
        notes: '',
        addedAt: now + p,   // slight offset keeps order deterministic
        order: p,
      };
      const record = sectionToRecord(sec);
      try { await saveSection(record); } catch (_) { /* best-effort */ }
      piece.sections.push(record);
    }

    pieces.push(piece);
    renderPieceList(pieces);
    setStatus(`Added "${piece.title}" (${piece.pageCount} pages, ${piece.pageCount} sections created).`);
    selectPiece(piece.id);
  } catch (err) {
    console.error('Failed to load PDF', err);
    setStatus(`Failed to load PDF: ${err.message || err}`);
  }
}

// --- Selection -----------------------------------------------------------

/** Switch the viewer to the given piece, lazy-loading PDF + sections if needed. */
async function selectPiece(pieceId) {
  const piece = pieces.find((p) => p.id === pieceId);
  if (!piece) return;
  // On mobile, close the sidebar drawer so the viewer is visible.
  if (isMobileViewport()) closeSidebar();
  // Switching pieces always exits practice mode — practice is per-section
  // and a section only belongs to one piece.
  closePracticeView({ silent: true });
  activePieceId = pieceId;
  // Re-render the sidebar so the active highlight moves.
  renderPieceList(pieces);
  // Close any in-flight section form when switching pieces.
  closeSectionForm();
  repCountsToday.clear();

  try {
    await ensurePdfLoaded(piece);
  } catch (err) {
    console.error('Failed to load PDF from storage', err);
    setStatus(`Failed to load "${piece.title}": ${err.message || err}`);
    return;
  }

  // Load sections (and today's rep counts) in the background — they don't
  // block PDF render.
  ensureSectionsLoaded(piece)
    .then(() => refreshRepCountsForActivePiece())
    .then(() => {
      if (activePieceId === piece.id) renderSectionsPanel();
    })
    .catch((err) => {
      console.warn('Could not load sections for piece', err);
      if (activePieceId === piece.id) {
        // Fall back to whatever's already in memory; don't block the viewer.
        renderSectionsPanel();
      }
    });

  showPdfViewer(piece);
}

/**
 * If the piece doesn't have a `pdfDoc` in memory yet, fetch its Blob from IDB
 * and instantiate one. Mutates the piece in place.
 */
async function ensurePdfLoaded(piece) {
  if (piece.pdfDoc) return;
  setStatus(`Loading "${piece.title}"…`);
  const blob = await getPieceBlob(piece.id);
  if (!blob) {
    throw new Error('PDF data is missing from local storage');
  }
  const arrayBuffer = await readBlobAsArrayBuffer(blob);
  piece.pdfData = arrayBuffer;
  piece.pdfDoc = await loadPdfDocument(arrayBuffer);
  if (piece.pdfDoc.numPages !== piece.pageCount) {
    piece.pageCount = piece.pdfDoc.numPages;
  }
}

/** Lazy-load a piece's sections from IDB, caching them on the piece. */
async function ensureSectionsLoaded(piece) {
  if (Array.isArray(piece.sections)) return;
  try {
    piece.sections = await listSectionsForPiece(piece.id);
  } catch (err) {
    piece.sections = [];
    throw err;
  }
}

// --- PDF viewer ----------------------------------------------------------

/** Reveal the PDF viewer surface and (re-)render all pages of a piece. */
async function showPdfViewer(piece) {
  if (!els.viewerPdf || !els.viewerPlaceholder || !els.pdfPages) return;
  els.viewerPlaceholder.hidden = true;
  els.viewerPdf.hidden = false;
  if (els.viewerPdfTitle) els.viewerPdfTitle.textContent = piece.title;
  if (els.viewerPdfMeta) {
    els.viewerPdfMeta.textContent =
      piece.pageCount === 1 ? '1 page' : `${piece.pageCount} pages`;
  }

  const myToken = ++renderToken;
  els.pdfPages.innerHTML = '';
  const loading = document.createElement('div');
  loading.className = 'pdf-page-loading';
  loading.textContent = 'Rendering pages…';
  els.pdfPages.appendChild(loading);

  try {
    const pageHosts = [];
    els.pdfPages.innerHTML = '';
    for (let i = 1; i <= piece.pageCount; i++) {
      const host = document.createElement('div');
      host.className = 'pdf-page';
      host.dataset.pageNumber = String(i);

      const label = document.createElement('span');
      label.className = 'pdf-page-label';
      label.textContent = `Page ${i}`;
      host.appendChild(label);

      els.pdfPages.appendChild(host);
      pageHosts.push(host);
    }

    for (let i = 1; i <= piece.pageCount; i++) {
      if (myToken !== renderToken) return;
      const page = await piece.pdfDoc.getPage(i);
      const viewport = page.getViewport({ scale: PDF_RENDER_SCALE });
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      pageHosts[i - 1].appendChild(canvas);
      await page.render({ canvasContext: ctx, viewport }).promise;
      if (myToken !== renderToken) return;
      setStatus(`Rendered page ${i} of ${piece.pageCount} — "${piece.title}"`);
    }
    if (myToken === renderToken) {
      setStatus(`Showing "${piece.title}" (${piece.pageCount} pages).`);
    }
  } catch (err) {
    console.error('Failed to render PDF', err);
    if (myToken === renderToken) {
      setStatus(`Failed to render PDF: ${err.message || err}`);
    }
  }
}

/** Smoothly scroll the viewer to a given (1-based) PDF page. */
function scrollToPage(pageNumber) {
  if (!els.pdfPages) return;
  const host = els.pdfPages.querySelector(
    `.pdf-page[data-page-number="${pageNumber}"]`,
  );
  if (host) {
    host.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}

// --- Sections panel ------------------------------------------------------

/** Find the active piece object, or null if none. */
function getActivePiece() {
  return pieces.find((p) => p.id === activePieceId) || null;
}

// ─── Section drag-to-reorder (item 17) ──────────────────────────────────────

let draggedSectionLi = null;

/**
 * Wire up drag-and-drop event listeners on the section list <ul>.
 * Each <li> is draggable; reordering is persisted to IndexedDB on drop.
 */
function setupSectionDragAndDrop(listEl) {
  listEl.addEventListener('dragstart', (e) => {
    const li = e.target.closest('.section-list-item');
    if (!li) return;
    draggedSectionLi = li;
    li.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', li.dataset.sectionId);
  });

  listEl.addEventListener('dragend', (e) => {
    const li = e.target.closest('.section-list-item');
    if (li) li.classList.remove('dragging');
    draggedSectionLi = null;
    // Remove any lingering drop indicator
    listEl.querySelectorAll('.drag-over').forEach((el) => el.classList.remove('drag-over'));
  });

  listEl.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const target = e.target.closest('.section-list-item');
    if (!target || target === draggedSectionLi) return;
    // Visual indicator
    listEl.querySelectorAll('.drag-over').forEach((el) => el.classList.remove('drag-over'));
    target.classList.add('drag-over');
  });

  listEl.addEventListener('dragleave', (e) => {
    const target = e.target.closest('.section-list-item');
    if (target) target.classList.remove('drag-over');
  });

  listEl.addEventListener('drop', async (e) => {
    e.preventDefault();
    listEl.querySelectorAll('.drag-over').forEach((el) => el.classList.remove('drag-over'));
    const target = e.target.closest('.section-list-item');
    if (!target || !draggedSectionLi || target === draggedSectionLi) return;

    // Determine new ordering by DOM position
    const items = [...listEl.querySelectorAll('.section-list-item')];
    const fromIdx = items.indexOf(draggedSectionLi);
    const toIdx = items.indexOf(target);
    if (fromIdx === -1 || toIdx === -1) return;

    // Move dragged item in DOM
    if (fromIdx < toIdx) {
      target.after(draggedSectionLi);
    } else {
      target.before(draggedSectionLi);
    }

    // Persist new order
    const reorderedItems = [...listEl.querySelectorAll('.section-list-item')];
    const updates = reorderedItems.map((li, idx) => ({
      id: li.dataset.sectionId,
      order: idx,
    }));

    try {
      await reorderSections(updates);
      // Update in-memory sections array on the active piece
      const piece = getActivePiece();
      if (piece && Array.isArray(piece.sections)) {
        const orderMap = new Map(updates.map((u) => [u.id, u.order]));
        piece.sections.sort(
          (a, b) => (orderMap.get(a.id) ?? 0) - (orderMap.get(b.id) ?? 0),
        );
        // Sync the order field on in-memory objects
        for (const s of piece.sections) {
          s.order = orderMap.get(s.id) ?? s.order;
        }
      }
      setStatus('Section order updated.');
    } catch (err) {
      console.error('Failed to persist section reorder:', err);
      setStatus('Error saving section order.');
      // Re-render to restore correct order from DB
      renderSectionsPanel();
    }
  });
}

/** Render the sections panel for the currently-active piece. */
function renderSectionsPanel() {
  if (!els.sectionsPanel || !els.sectionList) return;
  const piece = getActivePiece();
  if (!piece) {
    els.sectionsPanel.hidden = true;
    return;
  }
  els.sectionsPanel.hidden = false;

  // The form's max-page hint should reflect the active piece.
  if (els.sectionPageInput) {
    els.sectionPageInput.max = String(piece.pageCount);
  }

  const sections = Array.isArray(piece.sections) ? piece.sections : [];
  els.sectionList.innerHTML = '';

  if (sections.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'section-list-empty';
    empty.textContent =
      'No sections yet. Break the piece into named chunks to track practice.';
    els.sectionList.appendChild(empty);
    return;
  }

  for (const sec of sections) {
    const li = document.createElement('li');
    li.className = 'section-list-item';
    li.dataset.sectionId = sec.id;
    li.draggable = true;
    const isActivePractice =
      practiceState && practiceState.sectionId === sec.id;
    if (isActivePractice) li.classList.add('practicing');

    // Drag handle grip
    const grip = document.createElement('span');
    grip.className = 'section-drag-handle';
    grip.textContent = '≡'; // ≡ hamburger-style icon
    grip.title = 'Drag to reorder';
    li.appendChild(grip);

    const main = document.createElement('button');
    main.type = 'button';
    main.className = 'section-list-main';
    main.title = `Jump to page ${sec.pageNumber}`;
    main.addEventListener('click', () => scrollToPage(sec.pageNumber));

    const name = document.createElement('span');
    name.className = 'section-list-name';
    name.textContent = sec.name;
    main.appendChild(name);

    const meta = document.createElement('span');
    meta.className = 'section-list-meta';
    const parts = [`Page ${sec.pageNumber}`];
    if (sec.measures) parts.push(sec.measures);
    meta.textContent = parts.join(' · ');
    main.appendChild(meta);

    // Per-section notes snippet (item 12a). Truncated via CSS to 2 lines.
    if (sec.notes) {
      const notesEl = document.createElement('span');
      notesEl.className = 'section-list-notes';
      notesEl.textContent = sec.notes;
      main.appendChild(notesEl);
    }

    // Per-section total practice time badge (item 19).
    if (sec.totalPracticeMs && sec.totalPracticeMs > 0) {
      const timeEl = document.createElement('span');
      timeEl.className = 'section-list-time-badge';
      timeEl.textContent = `⏱ ${formatTotalPracticeTime(sec.totalPracticeMs)}`;
      timeEl.title = `Total practice time: ${formatTotalPracticeTime(sec.totalPracticeMs)}`;
      main.appendChild(timeEl);
    }

    // Per-section "X / 10 today" badge. Hidden until the user has logged
    // at least one rep so the panel isn't visually noisy on a fresh piece.
    const repCount = repCountsToday.get(sec.id) || 0;
    if (repCount > 0) {
      const badge = document.createElement('span');
      badge.className = 'section-list-rep-badge';
      if (isRepGoalMet(repCount)) badge.classList.add('section-list-rep-badge-done');
      badge.textContent = isRepGoalMet(repCount)
        ? `Done · ${repCount}/${REP_GOAL}`
        : `${repCount}/${REP_GOAL} today`;
      main.appendChild(badge);
    }

    // SM-2 next-due pill (item 6). Surfaced once a section has been rated
    // at least once. We highlight overdue / due-today sections so the eye
    // is drawn to what needs work first — feeds directly into item 7's
    // daily review queue once that lands.
    if (typeof sec.nextDue === 'string' && sec.nextDue) {
      const todayISO = localDateISO();
      let daysOff;
      try {
        daysOff = daysBetweenISO(todayISO, sec.nextDue);
      } catch {
        daysOff = null;
      }
      if (daysOff !== null) {
        const pill = document.createElement('span');
        pill.className = 'section-list-next-due';
        if (daysOff <= 0) pill.classList.add('is-due');
        pill.textContent =
          daysOff < 0
            ? `Due ${Math.abs(daysOff)}d ago`
            : daysOff === 0
            ? 'Due today'
            : daysOff === 1
            ? 'Next: tomorrow'
            : `Next: ${daysOff}d`;
        pill.title = `Next review: ${sec.nextDue}`;
        main.appendChild(pill);
      }
    }

    li.appendChild(main);

    const actions = document.createElement('div');
    actions.className = 'section-list-actions';

    const practiceBtn = document.createElement('button');
    practiceBtn.type = 'button';
    practiceBtn.className = 'btn btn-sm btn-practice';
    practiceBtn.textContent = isActivePractice ? 'Practicing…' : 'Practice';
    practiceBtn.disabled = isActivePractice;
    practiceBtn.addEventListener('click', () => openPracticeView(sec.id));
    actions.appendChild(practiceBtn);

    const editBtn = document.createElement('button');
    editBtn.type = 'button';
    editBtn.className = 'btn btn-sm';
    editBtn.textContent = 'Edit';
    editBtn.addEventListener('click', () =>
      openSectionForm({ mode: 'edit', id: sec.id }),
    );
    actions.appendChild(editBtn);

    const deleteBtn = document.createElement('button');
    deleteBtn.type = 'button';
    deleteBtn.className = 'btn btn-sm btn-danger';
    deleteBtn.textContent = 'Delete';
    deleteBtn.addEventListener('click', () => handleDeleteSection(sec.id));
    actions.appendChild(deleteBtn);

    li.appendChild(actions);
    els.sectionList.appendChild(li);
  }
}

/**
 * Refresh today's rep counts for every section of the active piece.
 * Mirrors them into `repCountsToday`. Errors are swallowed — the badge is
 * non-critical eye-candy and the practice panel can still operate.
 */
async function refreshRepCountsForActivePiece() {
  const piece = getActivePiece();
  if (!piece || !Array.isArray(piece.sections) || piece.sections.length === 0) {
    return;
  }
  const dateISO = localDateISO();
  const ids = piece.sections.map((s) => s.id);
  try {
    const counts = await getRepCountsForSections(ids, dateISO);
    repCountsToday.clear();
    for (const [k, v] of counts) repCountsToday.set(k, v);
  } catch (err) {
    console.warn('Could not load rep counts', err);
  }
}

function openSectionForm(state) {
  const piece = getActivePiece();
  if (!piece || !els.sectionForm) return;
  sectionFormState = state;

  let nameVal = '';
  let pageVal = '';
  let measuresVal = '';
  let notesVal = '';
  let titleText = 'New section';
  pendingCrop = null;

  if (state.mode === 'edit') {
    const existing = (piece.sections || []).find((s) => s.id === state.id);
    if (!existing) {
      // Edited section vanished (e.g. concurrent delete) — fall back to add.
      sectionFormState = { mode: 'add' };
    } else {
      nameVal = existing.name;
      pageVal = String(existing.pageNumber);
      measuresVal = existing.measures || '';
      notesVal = existing.notes || '';
      titleText = 'Edit section';
      // Restore existing crop if present.
      if (
        typeof existing.cropY1 === 'number' &&
        typeof existing.cropY2 === 'number'
      ) {
        pendingCrop = { y1: existing.cropY1, y2: existing.cropY2 };
      }
    }
  }

  if (els.sectionFormTitle) els.sectionFormTitle.textContent = titleText;
  if (els.sectionNameInput) els.sectionNameInput.value = nameVal;
  if (els.sectionPageInput) {
    els.sectionPageInput.value = pageVal;
    els.sectionPageInput.max = String(piece.pageCount);
  }
  if (els.sectionMeasuresInput) els.sectionMeasuresInput.value = measuresVal;
  if (els.sectionNotesInput) els.sectionNotesInput.value = notesVal;
  if (els.sectionFormError) {
    els.sectionFormError.textContent = '';
    els.sectionFormError.hidden = true;
  }

  els.sectionForm.hidden = false;
  updateCropStatusUI();
  if (els.sectionNameInput) {
    els.sectionNameInput.focus();
    els.sectionNameInput.select();
  }
}

function closeSectionForm() {
  sectionFormState = null;
  teardownCropOverlay();
  pendingCrop = null;
  updateCropStatusUI();
  if (!els.sectionForm) return;
  els.sectionForm.hidden = true;
  if (els.sectionFormError) {
    els.sectionFormError.textContent = '';
    els.sectionFormError.hidden = true;
  }
}

// --- Crop region overlay ---------------------------------------------------

/** Update the crop status text and clear button visibility in the section form. */
function updateCropStatusUI() {
  if (!els.sectionCropStatus) return;
  if (pendingCrop) {
    const pct1 = Math.round(pendingCrop.y1 * 100);
    const pct2 = Math.round(pendingCrop.y2 * 100);
    els.sectionCropStatus.textContent = `Cropped: ${pct1}%–${pct2}% of page`;
    els.sectionCropStatus.classList.add('has-crop');
  } else {
    els.sectionCropStatus.textContent = 'No crop set';
    els.sectionCropStatus.classList.remove('has-crop');
  }
  if (els.sectionCropClearBtn) {
    els.sectionCropClearBtn.hidden = !pendingCrop;
  }
}

/** Remove any active crop overlay from the PDF pages area. */
function teardownCropOverlay() {
  if (cropOverlayCleanup) {
    cropOverlayCleanup();
    cropOverlayCleanup = null;
  }
}

/**
 * Enter crop-selection mode: place a transparent overlay on the target PDF page
 * and let the user drag vertically to define a crop region.
 */
function startCropSelection() {
  teardownCropOverlay();
  if (!els.pdfPages) return;

  // Determine which page to draw on. Use the page number from the section form
  // input, falling back to 1.
  const pageNum = parseInt(
    els.sectionPageInput ? els.sectionPageInput.value : '1',
    10,
  ) || 1;
  const host = els.pdfPages.querySelector(
    `.pdf-page[data-page-number="${pageNum}"]`,
  );
  if (!host) {
    setStatus('Scroll to the target page first, then try again.');
    return;
  }

  // Scroll the page into view so the user can see it.
  host.scrollIntoView({ behavior: 'smooth', block: 'center' });

  // Create overlay elements.
  const overlay = document.createElement('div');
  overlay.className = 'pdf-page-crop-overlay';

  const dimTop = document.createElement('div');
  dimTop.className = 'pdf-page-crop-dim';
  dimTop.style.top = '0';

  const selection = document.createElement('div');
  selection.className = 'pdf-page-crop-selection';
  selection.style.display = 'none';

  const dimBottom = document.createElement('div');
  dimBottom.className = 'pdf-page-crop-dim';

  host.appendChild(dimTop);
  host.appendChild(selection);
  host.appendChild(dimBottom);
  host.appendChild(overlay);

  // If there's already a pending crop, show it.
  if (pendingCrop) {
    const h = host.offsetHeight;
    const top = pendingCrop.y1 * h;
    const bottom = pendingCrop.y2 * h;
    selection.style.display = 'block';
    selection.style.top = `${top}px`;
    selection.style.height = `${bottom - top}px`;
    dimTop.style.height = `${top}px`;
    dimBottom.style.top = `${bottom}px`;
    dimBottom.style.height = `${h - bottom}px`;
  } else {
    dimTop.style.height = '0';
    dimBottom.style.height = '0';
  }

  let dragging = false;
  let startY = 0;

  function pointerToLocal(e) {
    const rect = host.getBoundingClientRect();
    return Math.max(0, Math.min(e.clientY - rect.top, rect.height));
  }

  function onDown(e) {
    e.preventDefault();
    dragging = true;
    startY = pointerToLocal(e);
    selection.style.display = 'block';
    overlay.setPointerCapture(e.pointerId);
  }

  function onMove(e) {
    if (!dragging) return;
    const curY = pointerToLocal(e);
    const top = Math.min(startY, curY);
    const bottom = Math.max(startY, curY);
    const h = host.offsetHeight;
    selection.style.top = `${top}px`;
    selection.style.height = `${bottom - top}px`;
    dimTop.style.height = `${top}px`;
    dimBottom.style.top = `${bottom}px`;
    dimBottom.style.height = `${h - bottom}px`;
  }

  function onUp(e) {
    if (!dragging) return;
    dragging = false;
    const curY = pointerToLocal(e);
    const h = host.offsetHeight;
    if (h === 0) return;
    let y1 = Math.min(startY, curY) / h;
    let y2 = Math.max(startY, curY) / h;
    // Require at least 3% of the page height to avoid accidental clicks.
    if (y2 - y1 < 0.03) return;
    pendingCrop = { y1, y2 };
    updateCropStatusUI();
    setStatus(`Crop region set: ${Math.round(y1 * 100)}%–${Math.round(y2 * 100)}% of page ${pageNum}.`);
    // Auto-close overlay after selection.
    teardownCropOverlay();
  }

  overlay.addEventListener('pointerdown', onDown);
  overlay.addEventListener('pointermove', onMove);
  overlay.addEventListener('pointerup', onUp);

  setStatus('Drag vertically on the page to select the crop region.');

  cropOverlayCleanup = () => {
    overlay.removeEventListener('pointerdown', onDown);
    overlay.removeEventListener('pointermove', onMove);
    overlay.removeEventListener('pointerup', onUp);
    overlay.remove();
    selection.remove();
    dimTop.remove();
    dimBottom.remove();
  };
}

async function handleSectionFormSubmit(e) {
  e.preventDefault();
  if (!sectionFormState) return;
  const piece = getActivePiece();
  if (!piece) return;

  const raw = {
    name: els.sectionNameInput ? els.sectionNameInput.value : '',
    pageNumber: els.sectionPageInput ? els.sectionPageInput.value : '',
    measures: els.sectionMeasuresInput ? els.sectionMeasuresInput.value : '',
  };
  const notesRaw = els.sectionNotesInput ? els.sectionNotesInput.value.trim() : '';
  const result = validateSectionInput(raw, { maxPage: piece.pageCount });
  if (!result.ok) {
    const messages = Object.values(result.errors);
    if (els.sectionFormError) {
      els.sectionFormError.textContent = messages.join(' ');
      els.sectionFormError.hidden = false;
    }
    return;
  }

  const sections = Array.isArray(piece.sections) ? piece.sections : [];
  let record;

  if (sectionFormState.mode === 'edit') {
    const existing = sections.find((s) => s.id === sectionFormState.id);
    if (!existing) {
      setStatus("That section was already removed — couldn't save changes.");
      closeSectionForm();
      renderSectionsPanel();
      return;
    }
    const cropFields = pendingCrop
      ? { cropY1: pendingCrop.y1, cropY2: pendingCrop.y2 }
      : {};
    record = sectionToRecord({
      ...existing,
      name: result.value.name,
      pageNumber: result.value.pageNumber,
      measures: result.value.measures,
      notes: notesRaw,
      ...cropFields,
    });
  } else {
    // Append at the end of the current order range so new sections sort last
    // until a future drag-to-reorder UI exists.
    const maxOrder = sections.reduce(
      (m, s) => (typeof s.order === 'number' && s.order > m ? s.order : m),
      0,
    );
    const cropFieldsNew = pendingCrop
      ? { cropY1: pendingCrop.y1, cropY2: pendingCrop.y2 }
      : {};
    record = sectionToRecord({
      id: newSectionId(),
      pieceId: piece.id,
      name: result.value.name,
      pageNumber: result.value.pageNumber,
      measures: result.value.measures,
      notes: notesRaw,
      addedAt: Date.now(),
      order: maxOrder + 1,
      ...cropFieldsNew,
    });
  }

  try {
    await saveSection(record);
  } catch (err) {
    console.error('Failed to save section', err);
    if (els.sectionFormError) {
      els.sectionFormError.textContent =
        `Couldn't save section: ${err.message || err}`;
      els.sectionFormError.hidden = false;
    }
    return;
  }

  // Update the in-memory cache.
  if (sectionFormState && sectionFormState.mode === 'edit') {
    const i = sections.findIndex((s) => s.id === record.id);
    if (i >= 0) sections[i] = record;
    else sections.push(record);
    setStatus(`Updated section "${record.name}".`);
  } else {
    sections.push(record);
    setStatus(`Added section "${record.name}" on page ${record.pageNumber}.`);
  }
  // Mirror the new/updated section into the queue snapshot so that an
  // edit (e.g. fixing a measure range) is reflected the next time the
  // welcome card is shown — and so a future imported section with SRS
  // fields would also appear immediately.
  upsertQueueSection(record);
  // Re-sort by order then addedAt to match the persistence layer.
  sections.sort(
    (a, b) =>
      (a.order || 0) - (b.order || 0) ||
      (a.addedAt || 0) - (b.addedAt || 0),
  );
  piece.sections = sections;

  closeSectionForm();
  renderSectionsPanel();
  renderReviewQueue();
  renderStats();
}

async function handleDeleteSection(sectionId) {
  const piece = getActivePiece();
  if (!piece) return;
  const sections = Array.isArray(piece.sections) ? piece.sections : [];
  const target = sections.find((s) => s.id === sectionId);
  if (!target) return;

  const ok = window.confirm(
    `Delete section "${target.name}"? This can't be undone.`,
  );
  if (!ok) return;

  try {
    await deleteSection(sectionId);
  } catch (err) {
    console.error('Failed to delete section', err);
    setStatus(`Couldn't delete section: ${err.message || err}`);
    return;
  }
  piece.sections = sections.filter((s) => s.id !== sectionId);
  // If the form was editing this exact section, close it.
  if (
    sectionFormState &&
    sectionFormState.mode === 'edit' &&
    sectionFormState.id === sectionId
  ) {
    closeSectionForm();
  }
  // If we were practicing this exact section, exit practice mode.
  if (practiceState && practiceState.sectionId === sectionId) {
    closePracticeView({ silent: true });
  }
  repCountsToday.delete(sectionId);
  removeQueueSection(sectionId);
  setStatus(`Deleted section "${target.name}".`);
  renderSectionsPanel();
  renderReviewQueue();
  renderStats();
}

// --- Practice panel (item 5) --------------------------------------------

/** Open the practice panel for the given section. */
// --- Section-scoped crop view ----------------------------------------------

/**
 * Apply CSS clipping to the PDF page so only the cropped region is visible.
 * Also hides all pages that don't belong to this section's page.
 */
function applySectionCrop(section) {
  clearSectionCrop(); // always start clean
  if (!els.pdfPages) return;

  const hasCrop =
    typeof section.cropY1 === 'number' &&
    typeof section.cropY2 === 'number';

  // Hide pages that aren't the section's page.
  const allPages = els.pdfPages.querySelectorAll('.pdf-page');
  for (const page of allPages) {
    const num = parseInt(page.dataset.pageNumber, 10);
    if (num !== section.pageNumber) {
      page.dataset.cropHidden = 'true';
      page.style.display = 'none';
    }
  }

  if (!hasCrop) return;

  // Find the target page host and its canvas.
  const host = els.pdfPages.querySelector(
    `.pdf-page[data-page-number="${section.pageNumber}"]`,
  );
  if (!host) return;
  const canvas = host.querySelector('canvas');
  if (!canvas) return;

  // Apply the crop-active class first so CSS `width: 100%` takes effect,
  // then measure the resulting canvas height to compute pixel offsets.
  host.classList.add('crop-active');
  // Force a layout reflow so offsetHeight reflects the new CSS.
  const displayHeight = canvas.offsetHeight;
  const cropTopPx = section.cropY1 * displayHeight;
  const cropBottomPx = section.cropY2 * displayHeight;
  const visibleHeight = cropBottomPx - cropTopPx;

  host.style.height = `${visibleHeight}px`;
  canvas.style.marginTop = `${-cropTopPx}px`;
}

/** Remove all crop clipping from PDF pages, restoring the full view. */
function clearSectionCrop() {
  if (!els.pdfPages) return;
  const allPages = els.pdfPages.querySelectorAll('.pdf-page');
  for (const page of allPages) {
    if (page.dataset.cropHidden) {
      delete page.dataset.cropHidden;
      page.style.display = '';
    }
    page.classList.remove('crop-active');
    page.style.height = '';
    const canvas = page.querySelector('canvas');
    if (canvas) canvas.style.marginTop = '';
  }
}

async function openPracticeView(sectionId) {
  const piece = getActivePiece();
  if (!piece || !Array.isArray(piece.sections)) return;
  const section = piece.sections.find((s) => s.id === sectionId);
  if (!section) return;

  const dateISO = localDateISO();
  // Seed the in-memory count from the cache; we'll reconcile against IDB
  // below in case the cache is stale (e.g. user was here this morning).
  const cachedCount = repCountsToday.get(sectionId) || 0;
  practiceState = {
    sectionId,
    dateISO,
    count: cachedCount,
    saving: false,
    ratingInFlight: false,
    timerStartedAt: Date.now(),
    timerElapsed: 0,
    timerPaused: false,
  };
  startPracticeTimer();

  // Re-render the section list so the active row highlights + the Practice
  // button on this section disables.
  renderSectionsPanel();
  // Reveal the practice panel and paint the initial state.
  showPracticePanel(section);
  renderPracticePanel();
  // Add the practicing layout class to reorder DOM visually.
  if (els.viewerPdf) els.viewerPdf.classList.add('is-practicing');
  // Apply crop clipping if the section has a crop region, then scroll.
  applySectionCrop(section);
  scrollToPage(section.pageNumber);

  // Reconcile with IDB in case another tab / yesterday's count is stale.
  try {
    const counts = await getRepCountsForSections([sectionId], dateISO);
    const fresh = counts.get(sectionId) || 0;
    if (
      practiceState &&
      practiceState.sectionId === sectionId &&
      practiceState.dateISO === dateISO
    ) {
      practiceState.count = fresh;
      repCountsToday.set(sectionId, fresh);
      // If the user crossed the goal in another tab / earlier today, the
      // rating prompt will show automatically inside renderPracticePanel
      // (when goal-met AND lastReviewedDate !== today). We deliberately do
      // NOT auto-fire SM-2 here any more — that's the user's choice now.
      renderPracticePanel();
      // Update the section row badge to match.
      renderSectionsPanel();
    }
  } catch (err) {
    console.warn('Could not reconcile rep count from storage', err);
  }
}

/** Reveal the practice panel and stamp the section's title/meta. */
function showPracticePanel(section) {
  if (!els.practicePanel) return;
  els.practicePanel.hidden = false;
  if (els.practiceSectionName) {
    els.practiceSectionName.textContent = section.name;
  }
  if (els.practiceSectionMeta) {
    const parts = [`Page ${section.pageNumber}`];
    if (section.measures) parts.push(section.measures);
    els.practiceSectionMeta.textContent = parts.join(' · ');
  }
  if (els.practiceSectionNotes) {
    if (section.notes) {
      els.practiceSectionNotes.textContent = section.notes;
      els.practiceSectionNotes.hidden = false;
    } else {
      els.practiceSectionNotes.textContent = '';
      els.practiceSectionNotes.hidden = true;
    }
  }
  // Item 20 — show cumulative practice time for this section.
  updatePracticeTotalTime(section);

  if (els.practiceGoal) els.practiceGoal.textContent = String(REP_GOAL);
  if (els.practiceProgressTrack) {
    els.practiceProgressTrack.setAttribute('aria-valuemax', String(REP_GOAL));
  }
}

/** Update the cumulative practice time badge in the practice panel header. */
function updatePracticeTotalTime(section) {
  if (!els.practiceTotalTime) return;
  const totalMs = section && section.totalPracticeMs;
  if (totalMs && totalMs > 0) {
    els.practiceTotalTime.textContent = `Total: ${formatTotalPracticeTime(totalMs)}`;
    els.practiceTotalTime.hidden = false;
  } else {
    els.practiceTotalTime.textContent = '';
    els.practiceTotalTime.hidden = true;
  }
}

// ── Practice session timer (item 18) ────────────────────────────────

/** Format milliseconds as m:ss or h:mm:ss. */
function formatElapsed(ms) {
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/**
 * Format cumulative practice milliseconds as a human-readable string.
 * e.g. "3m", "1h 12m", "45s" for very short sessions.
 */
function formatTotalPracticeTime(ms) {
  if (!ms || ms <= 0) return '';
  const totalSec = Math.floor(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  if (h === 0) return `${m}m`;
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

/** Get current elapsed ms for the active practice session. */
function getPracticeElapsed() {
  if (!practiceState) return 0;
  if (practiceState.timerPaused) return practiceState.timerElapsed;
  return practiceState.timerElapsed + (Date.now() - practiceState.timerStartedAt);
}

/** Update the timer display element. */
function tickPracticeTimer() {
  if (els.practiceTimer) {
    els.practiceTimer.textContent = formatElapsed(getPracticeElapsed());
  }
}

/** Start the 1-second timer interval. */
function startPracticeTimer() {
  stopPracticeTimer(); // clear any stale interval
  tickPracticeTimer(); // immediate first paint
  practiceTimerInterval = setInterval(tickPracticeTimer, 1000);
  if (els.practiceTimerPauseBtn) {
    els.practiceTimerPauseBtn.textContent = 'Pause';
    els.practiceTimerPauseBtn.setAttribute('aria-label', 'Pause session timer');
  }
}

/** Stop the timer interval (does not clear practiceState timer fields). */
function stopPracticeTimer() {
  if (practiceTimerInterval !== null) {
    clearInterval(practiceTimerInterval);
    practiceTimerInterval = null;
  }
}

/** Toggle pause/resume on the practice timer. */
function togglePracticeTimer() {
  if (!practiceState) return;
  if (practiceState.timerPaused) {
    // Resume: set a new startedAt, keep accumulated elapsed
    practiceState.timerStartedAt = Date.now();
    practiceState.timerPaused = false;
    practiceTimerInterval = setInterval(tickPracticeTimer, 1000);
    if (els.practiceTimerPauseBtn) {
      els.practiceTimerPauseBtn.textContent = 'Pause';
      els.practiceTimerPauseBtn.setAttribute('aria-label', 'Pause session timer');
    }
  } else {
    // Pause: accumulate elapsed, stop ticking
    practiceState.timerElapsed += Date.now() - practiceState.timerStartedAt;
    practiceState.timerPaused = true;
    stopPracticeTimer();
    tickPracticeTimer(); // paint the frozen time
    if (els.practiceTimerPauseBtn) {
      els.practiceTimerPauseBtn.textContent = 'Resume';
      els.practiceTimerPauseBtn.setAttribute('aria-label', 'Resume session timer');
    }
  }
}

/** Hide the practice panel and clear practice state. */
function closePracticeView({ silent } = {}) {
  stopPracticeTimer(); // item 18 — stop session timer
  // Item 19 — persist cumulative practice time before clearing state.
  if (practiceState) {
    const elapsed = getPracticeElapsed();
    if (elapsed > 0) {
      const sid = practiceState.sectionId;
      addPracticeTime(sid, elapsed).then((newTotal) => {
        // Update in-memory section so the sections panel shows new total
        // without needing a full IDB reload.
        const piece = getActivePiece();
        if (piece && Array.isArray(piece.sections)) {
          const sec = piece.sections.find((s) => s.id === sid);
          if (sec) sec.totalPracticeMs = newTotal;
        }
        renderSectionsPanel();
        renderStats(); // item 20 — refresh per-piece totals
      }).catch((err) => console.warn('Failed to persist practice time', err));
    }
  }
  stopMetronome(); // item 12b — silence metronome when leaving practice
  clearSectionCrop(); // restore full page view
  if (els.viewerPdf) els.viewerPdf.classList.remove('is-practicing');
  const wasActive = !!practiceState;
  practiceState = null;
  if (els.practicePanel) els.practicePanel.hidden = true;
  if (els.practiceStatus) {
    els.practiceStatus.textContent = '';
    els.practiceStatus.hidden = true;
  }
  if (els.practiceNextReview) {
    els.practiceNextReview.innerHTML = '';
    els.practiceNextReview.hidden = true;
  }
  if (els.practiceRatingPrompt) {
    els.practiceRatingPrompt.hidden = true;
  }
  if (els.practiceRatingButtons) {
    els.practiceRatingButtons.innerHTML = '';
  }
  if (wasActive && !silent) {
    setStatus('Stopped practicing.');
  }
  // Re-render the sections panel so the practicing row drops its highlight
  // and the Practice button re-enables.
  renderSectionsPanel();
}

/**
 * Paint the practice panel from `practiceState`. Called after every state
 * change (open, increment, undo, reset, SM-2 fire, IDB reconcile).
 */
function renderPracticePanel() {
  if (!practiceState || !els.practicePanel) return;
  const { count, saving } = practiceState;
  const goalMet = isRepGoalMet(count);
  const section = getActiveSection();
  const scheduledToday =
    !!section && section.lastReviewedDate === practiceState.dateISO;
  const needsRating = goalMet && !scheduledToday;

  if (els.practiceCount) els.practiceCount.textContent = String(count);
  if (els.practiceProgressTrack) {
    els.practiceProgressTrack.setAttribute('aria-valuenow', String(count));
  }
  if (els.practiceProgressFill) {
    const pct = Math.min(100, (count / REP_GOAL) * 100);
    els.practiceProgressFill.style.width = `${pct}%`;
    els.practiceProgressFill.classList.toggle('is-complete', goalMet);
  }

  if (els.practiceRepBtn) {
    // Disable the button while a save is in flight, OR once the goal is met
    // (preventing accidental over-counting). The user can still hit Undo to
    // back off, or Reset, or Stop.
    els.practiceRepBtn.disabled = saving || goalMet;
    els.practiceRepBtn.classList.toggle('is-complete', goalMet);
    const label = els.practiceRepBtn.querySelector('.practice-rep-btn-label');
    if (label) {
      label.textContent = goalMet
        ? `Practiced ${count}× today`
        : 'Successful repetition';
    }
  }

  // Status copy. Once SM-2 has fired today, the "Next review" card carries
  // the goal-met message; while the rating prompt is up it carries the
  // "pick a rating" cue. We keep the status line quiet in those cases so we
  // don't double up.
  if (els.practiceStatus) {
    if (goalMet) {
      // The rating prompt OR the next-review card now carries the message.
      els.practiceStatus.hidden = true;
      els.practiceStatus.textContent = '';
    } else if (count === 0) {
      els.practiceStatus.textContent =
        'Click after each clean run-through. You self-report — no audio detection.';
      els.practiceStatus.hidden = false;
    } else {
      els.practiceStatus.hidden = true;
      els.practiceStatus.textContent = '';
    }
  }

  // Either the rating prompt (item 8) OR the next-review card (item 6) is
  // visible at any time, never both. The rating prompt only appears while
  // the user owes us a rating for today; once they pick one (or had picked
  // earlier today), the next-review card takes over.
  if (needsRating) {
    renderNextReview(null); // hide
    renderRatingPrompt(section);
  } else {
    renderRatingPrompt(null); // hide
    renderNextReview(section);
  }

  if (els.practiceUndoBtn) els.practiceUndoBtn.disabled = saving || count <= 0;
  if (els.practiceResetBtn) els.practiceResetBtn.disabled = saving || count <= 0;
}

/** Find the currently-being-practiced section, or null. */
function getActiveSection() {
  if (!practiceState) return null;
  const piece = getActivePiece();
  if (!piece || !Array.isArray(piece.sections)) return null;
  return piece.sections.find((s) => s.id === practiceState.sectionId) || null;
}

/** Render the SM-2 next-review card inside the practice panel. */
function renderNextReview(section) {
  const el = els.practiceNextReview;
  if (!el) return;
  if (!section || !practiceState) {
    el.hidden = true;
    el.innerHTML = '';
    return;
  }
  const srs = srsStateForSection(section);
  if (!srs.nextDue) {
    el.hidden = true;
    el.innerHTML = '';
    return;
  }
  const todayISO = practiceState.dateISO || localDateISO();
  let daysOff;
  try {
    daysOff = daysBetweenISO(todayISO, srs.nextDue);
  } catch {
    daysOff = null;
  }
  const detail =
    daysOff === null
      ? ''
      : daysOff < 0
      ? `${Math.abs(daysOff)} day${Math.abs(daysOff) === 1 ? '' : 's'} overdue`
      : daysOff === 0
      ? 'due today'
      : daysOff === 1
      ? 'tomorrow'
      : `in ${daysOff} days`;
  const ratedToday = srs.lastReviewedDate === todayISO;
  const label = ratedToday ? 'Scheduled today' : 'Next review';
  // Build the inner DOM by hand (rather than innerHTML with interpolated
  // strings) so a stray section name in `srs` can never inject markup.
  el.innerHTML = '';
  el.hidden = false;
  const labelEl = document.createElement('span');
  labelEl.className = 'practice-next-review-label';
  labelEl.textContent = label;
  el.appendChild(labelEl);
  const dateEl = document.createElement('span');
  dateEl.className = 'practice-next-review-date';
  dateEl.textContent = srs.nextDue;
  el.appendChild(dateEl);
  if (detail) {
    const detailEl = document.createElement('span');
    detailEl.className = 'practice-next-review-detail';
    detailEl.textContent = detail;
    el.appendChild(detailEl);
  }
}

/**
 * Render the post-session rating prompt (item 8). Surfaces the four SM-2
 * ratings (Again / Hard / Good / Easy) once the user has logged 10 reps for
 * the day. Each button shows its projected next-review distance so the user
 * knows what they're committing to ("Again → tomorrow", "Good → in 6d").
 *
 * Pass `null` to hide the prompt. Re-rendered on every panel paint so the
 * disabled state stays in sync with `practiceState.ratingInFlight`.
 */
function renderRatingPrompt(section) {
  const panel = els.practiceRatingPrompt;
  const buttonsHost = els.practiceRatingButtons;
  if (!panel || !buttonsHost) return;
  if (!section || !practiceState) {
    panel.hidden = true;
    buttonsHost.innerHTML = '';
    return;
  }

  const todayISO = practiceState.dateISO || localDateISO();
  const cur = srsStateForSection(section);
  let outcomes;
  try {
    outcomes = previewSm2Outcomes(cur, todayISO);
  } catch (err) {
    // If the projection blows up (shouldn't, but defensive), hide the prompt
    // rather than render a broken UI.
    console.warn('Could not project SM-2 outcomes for rating prompt', err);
    panel.hidden = true;
    buttonsHost.innerHTML = '';
    return;
  }

  panel.hidden = false;
  buttonsHost.innerHTML = '';
  const inFlight = !!practiceState.ratingInFlight;

  for (const outcome of outcomes) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `practice-rating-btn practice-rating-btn-${outcome.label.toLowerCase()}`;
    btn.dataset.rating = String(outcome.rating);
    if (outcome.rating === RATING_GOOD) {
      btn.classList.add('is-default');
      btn.autofocus = true;
    }
    btn.disabled = inFlight;

    const name = document.createElement('span');
    name.className = 'practice-rating-btn-name';
    name.textContent = outcome.label;
    btn.appendChild(name);

    const detail = document.createElement('span');
    detail.className = 'practice-rating-btn-detail';
    detail.textContent = formatRatingDetail(outcome);
    btn.appendChild(detail);

    btn.title = `${outcome.label} — next review ${outcome.nextDue}`;
    btn.addEventListener('click', () =>
      handleRatingClick(outcome.rating, outcome.label),
    );
    buttonsHost.appendChild(btn);
  }
}

/**
 * Glanceable next-review distance for a rating button.
 * "tomorrow" / "in 6d" / "today" — never the raw ISO date (that's in the
 * tooltip). Pure-ish: depends only on the outcome's `daysOff`.
 */
function formatRatingDetail(outcome) {
  if (!outcome || typeof outcome.daysOff !== 'number') return '';
  if (outcome.daysOff <= 0) return 'today';
  if (outcome.daysOff === 1) return 'tomorrow';
  return `in ${outcome.daysOff}d`;
}

/**
 * Click a rating button: persist the chosen quality through SM-2 and update
 * the section. Disables the rating buttons while in flight so a second click
 * can't double-fire. The rating itself is final — there's no undo for it
 * (matches the design rule that Reset/Undo on rep counts don't roll back the
 * SRS schedule).
 */
async function handleRatingClick(quality, label) {
  if (!practiceState) return;
  if (practiceState.ratingInFlight) return;
  if (!isRepGoalMet(practiceState.count)) return; // belt-and-braces guard

  const { sectionId, dateISO } = practiceState;
  practiceState.ratingInFlight = true;
  // Re-render so all four buttons disable immediately (visual feedback).
  renderPracticePanel();

  try {
    await fireSm2WithRating(sectionId, dateISO, quality, label);
  } finally {
    if (practiceState && practiceState.sectionId === sectionId) {
      practiceState.ratingInFlight = false;
    }
    renderPracticePanel();
    renderSectionsPanel();
    renderReviewQueue();
    // Sections-mastered may have just ticked up if the rating bumped the
    // section's interval over the 21-day mastery floor.
    renderStats();
  }
}

/** Handle a click of the big "Successful repetition" button. */
async function handleRepClick() {
  if (!practiceState) return;
  const { sectionId, dateISO, count } = practiceState;
  if (isRepGoalMet(count)) return;
  // Past the early-return, `count` is always strictly below the goal.
  // Whether the increment crosses the threshold is decided by the
  // reconciled persisted count below.

  // Optimistic update — the UI updates immediately so practice feels snappy.
  practiceState.count = count + 1;
  practiceState.saving = true;
  repCountsToday.set(sectionId, practiceState.count);
  renderPracticePanel();

  try {
    const persisted = await incrementRepLog(sectionId, dateISO);
    // Reconcile against the persisted record in case it diverged (e.g. a
    // background restore or another tab beat us to it).
    if (
      practiceState &&
      practiceState.sectionId === sectionId &&
      practiceState.dateISO === dateISO
    ) {
      practiceState.count = persisted.count;
      repCountsToday.set(sectionId, persisted.count);
    }
    setQueueRepCount(sectionId, persisted.count);
    // Note today as a practice day for the streak counter (idempotent).
    noteRepLogActivity(dateISO);
    const nowGoalMet = isRepGoalMet(persisted.count);
    if (nowGoalMet) {
      setStatus(`Nice — ${persisted.count} reps logged today. Pick a rating to schedule the next review.`);
    } else {
      setStatus(`Logged rep ${persisted.count} of ${REP_GOAL}.`);
    }
    // Item 8: SM-2 firing is no longer automatic. Once the rep count crosses
    // the goal, renderPracticePanel surfaces the rating prompt; the user
    // picks Again / Hard / Good / Easy and that handler calls
    // fireSm2WithRating directly. The `lastReviewedDate` guard inside still
    // exists so a same-day re-fire is a no-op.
  } catch (err) {
    console.error('Failed to log rep', err);
    // Roll back the optimistic increment.
    if (
      practiceState &&
      practiceState.sectionId === sectionId &&
      practiceState.dateISO === dateISO
    ) {
      practiceState.count = count;
      repCountsToday.set(sectionId, count);
    }
    setStatus(`Couldn't save rep: ${err.message || err}`);
  } finally {
    if (practiceState) practiceState.saving = false;
    renderPracticePanel();
    // Update the section row badge.
    renderSectionsPanel();
    // Repaint the queue — if this rep crossed the goal the section drops
    // out of "Due today"; otherwise its progress chip ticks up.
    renderReviewQueue();
    // Stats panel: today's done-of-due may have ticked up (a rep crossing
    // the goal counts as a section "done"), and the daily streak may have
    // started today if this was the user's first rep of the day.
    renderStats();
  }
}

/**
 * Apply SM-2 with the user-chosen rating and persist the updated schedule
 * onto the section record. Called from the post-session rating prompt
 * (item 8) — no longer auto-fired with a hard-coded Good.
 *
 * Idempotent across same-day re-fires thanks to the `lastReviewedDate`
 * guard: clicking another rating after a successful save is a no-op. (The
 * rating prompt UI hides itself after a successful click anyway, so the
 * guard is mostly belt-and-braces against a stale call.)
 *
 * Failures are non-fatal — the rep itself is already logged; the status
 * line surfaces the schedule-save error and the rating prompt stays up so
 * the user can retry.
 */
async function fireSm2WithRating(sectionId, dateISO, quality, label) {
  const piece = getActivePiece();
  if (!piece || !Array.isArray(piece.sections)) return;
  const section = piece.sections.find((s) => s.id === sectionId);
  if (!section) return;

  const cur = srsStateForSection(section);
  if (cur.lastReviewedDate === dateISO) {
    // Already scheduled today — keep the existing schedule. Surfacing the
    // existing `nextDue` is handled by renderNextReview off the section.
    return;
  }

  const next = applySm2(cur, quality, dateISO);
  const updated = {
    ...section,
    repetitions: next.repetitions,
    interval: next.interval,
    ease: next.ease,
    nextDue: next.nextDue,
    lastReviewedDate: next.lastReviewedDate,
  };

  try {
    await saveSection(sectionToRecord(updated));
  } catch (err) {
    console.error('Failed to save SM-2 schedule', err);
    setStatus(`Logged reps, but couldn't save next-review date: ${err.message || err}`);
    return;
  }

  // Mutate the in-memory section in place so renderPracticePanel /
  // renderSectionsPanel pick up the new fields without an extra round-trip.
  const i = piece.sections.findIndex((s) => s.id === sectionId);
  if (i >= 0) piece.sections[i] = updated;
  // Mirror the schedule update into the queue snapshot so subsequent
  // renders see the freshly-scheduled section without an IDB walk.
  upsertQueueSection(updated);

  // Surface the result. "Again" specifically schedules tomorrow even though
  // it's a lapse — surface that explicitly so the user understands the
  // section will reappear in tomorrow's queue.
  const ratingLabel = label || ratingLabelFor(quality);
  setStatus(
    `Rated "${section.name}" as ${ratingLabel} — ${describeNextDue(next.nextDue, dateISO)}.`,
  );
}

/** Lookup table for human-readable rating labels (fallback path). */
function ratingLabelFor(quality) {
  if (quality === RATING_AGAIN) return 'Again';
  if (quality === RATING_HARD) return 'Hard';
  if (quality === RATING_GOOD) return 'Good';
  if (quality === RATING_EASY) return 'Easy';
  return 'rated';
}

/** Decrement today's count by one (mistake-correction). */
async function handleUndoRep() {
  if (!practiceState) return;
  const { sectionId, dateISO, count } = practiceState;
  if (count <= 0) return;
  const target = count - 1;

  practiceState.saving = true;
  practiceState.count = target;
  repCountsToday.set(sectionId, target);
  renderPracticePanel();

  try {
    const rec = await setRepLogCount(sectionId, dateISO, target);
    const persisted = rec ? rec.count : 0;
    if (
      practiceState &&
      practiceState.sectionId === sectionId &&
      practiceState.dateISO === dateISO
    ) {
      practiceState.count = persisted;
      repCountsToday.set(sectionId, persisted);
    }
    setQueueRepCount(sectionId, persisted);
    setStatus(`Undid one rep — ${persisted} of ${REP_GOAL} today.`);
  } catch (err) {
    console.error('Failed to undo rep', err);
    if (
      practiceState &&
      practiceState.sectionId === sectionId &&
      practiceState.dateISO === dateISO
    ) {
      practiceState.count = count;
      repCountsToday.set(sectionId, count);
    }
    setStatus(`Couldn't undo rep: ${err.message || err}`);
  } finally {
    if (practiceState) practiceState.saving = false;
    renderPracticePanel();
    renderSectionsPanel();
    // The section may have just dropped back below the goal — re-evaluate
    // whether it should reappear in the queue. (Note: per the design notes
    // in the SM-2 entry, Undo / Reset DON'T roll back the SRS schedule, so
    // a section that's already scheduled stays scheduled and won't actually
    // re-appear in today's queue. The renderReviewQueue call is still safe
    // and keeps the snapshot honest.)
    renderReviewQueue();
    // Today's done-count may have decremented if this Undo crossed the
    // goal threshold downward; rerender the stats line to match.
    renderStats();
  }
}

/** Reset today's count to zero (after a confirm prompt). */
async function handleResetReps() {
  if (!practiceState) return;
  const { sectionId, dateISO, count } = practiceState;
  if (count <= 0) return;
  const ok = window.confirm(
    `Reset today's rep count for this section back to 0? You'll have to re-log them.`,
  );
  if (!ok) return;

  practiceState.saving = true;
  practiceState.count = 0;
  repCountsToday.set(sectionId, 0);
  renderPracticePanel();

  try {
    await setRepLogCount(sectionId, dateISO, 0);
    setQueueRepCount(sectionId, 0);
    setStatus('Reset today’s rep count.');
  } catch (err) {
    console.error('Failed to reset reps', err);
    if (
      practiceState &&
      practiceState.sectionId === sectionId &&
      practiceState.dateISO === dateISO
    ) {
      practiceState.count = count;
      repCountsToday.set(sectionId, count);
    }
    setStatus(`Couldn't reset reps: ${err.message || err}`);
  } finally {
    if (practiceState) practiceState.saving = false;
    renderPracticePanel();
    renderSectionsPanel();
    renderReviewQueue();
    renderStats();
  }
}

// --- Daily review queue (item 7) ----------------------------------------

/**
 * Hydrate the cross-piece review queue from IDB. Walks every section in the
 * sections store and joins against today's rep logs. Cheap because both
 * stores are tiny — sections are small records, today's rep logs are at
 * most one record per section the user has touched today.
 *
 * Failures are non-fatal: the welcome card still works, and the queue panel
 * just stays hidden. The review queue is a productivity affordance — not a
 * showstopper if storage is being weird.
 */
async function refreshReviewQueue() {
  const dateISO = localDateISO();
  try {
    const [allSections, countsByDate] = await Promise.all([
      listAllSections(),
      getRepCountsForDate(dateISO),
    ]);
    const pieceTitleById = new Map();
    for (const p of pieces) {
      pieceTitleById.set(p.id, {
        id: p.id,
        title: p.title,
        pageCount: p.pageCount,
      });
    }
    queueState = {
      dateISO,
      sections: allSections,
      pieceTitleById,
      countsByDate,
    };
  } catch (err) {
    console.warn('Could not hydrate review queue', err);
    queueState = {
      dateISO,
      sections: [],
      pieceTitleById: new Map(),
      countsByDate: new Map(),
    };
  }
  renderReviewQueue();
}

/**
 * Apply a local rep-count delta to the queue's in-memory snapshot so the
 * queue can re-render without a fresh IDB walk on every increment.
 */
function setQueueRepCount(sectionId, count) {
  if (!queueState) return;
  if (typeof count === 'number' && count > 0) {
    queueState.countsByDate.set(sectionId, count);
  } else {
    queueState.countsByDate.delete(sectionId);
  }
}

/**
 * Replace the in-memory snapshot of a section inside `queueState.sections`
 * (or append it). Used so that an in-session SM-2 update or an Edit-section
 * save shows up in the queue immediately, without re-walking IDB.
 */
function upsertQueueSection(updatedSection) {
  if (!queueState || !updatedSection || !updatedSection.id) return;
  const i = queueState.sections.findIndex((s) => s.id === updatedSection.id);
  if (i >= 0) queueState.sections[i] = { ...updatedSection };
  else queueState.sections.push({ ...updatedSection });
}

/** Drop a section from the queue snapshot (e.g. on delete). */
function removeQueueSection(sectionId) {
  if (!queueState || !sectionId) return;
  queueState.sections = queueState.sections.filter((s) => s.id !== sectionId);
  queueState.countsByDate.delete(sectionId);
}

/** Render the queue panel from `queueState`. Hides the panel if empty. */
function renderReviewQueue() {
  const panel = els.reviewQueuePanel;
  const list = els.reviewQueueList;
  const countEl = els.reviewQueueCount;
  if (!panel || !list) return;

  if (!queueState) {
    panel.hidden = true;
    list.innerHTML = '';
    if (countEl) countEl.textContent = '';
    return;
  }

  // Refresh the piece title map from the live `pieces` array so a newly-
  // uploaded or just-renamed piece doesn't show as "(unknown piece)".
  for (const p of pieces) {
    queueState.pieceTitleById.set(p.id, {
      id: p.id,
      title: p.title,
      pageCount: p.pageCount,
    });
  }

  const items = buildReviewQueue({
    sections: queueState.sections,
    piecesById: queueState.pieceTitleById,
    repCountsToday: queueState.countsByDate,
    todayISO: queueState.dateISO,
    repGoal: REP_GOAL,
  });

  list.innerHTML = '';
  if (items.length === 0) {
    panel.hidden = true;
    if (countEl) countEl.textContent = '';
    return;
  }

  panel.hidden = false;
  if (countEl) {
    countEl.textContent =
      items.length === 1 ? '1 section' : `${items.length} sections`;
  }

  for (const item of items) {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'review-queue-item';
    btn.dataset.sectionId = item.section.id;
    btn.dataset.pieceId = item.piece.id || '';
    btn.disabled = queueClickInFlight;

    const top = document.createElement('div');
    top.className = 'review-queue-item-top';

    const name = document.createElement('span');
    name.className = 'review-queue-item-name';
    name.textContent = item.section.name || '(unnamed section)';
    top.appendChild(name);

    const due = document.createElement('span');
    due.className = 'review-queue-item-due';
    if (item.daysOff < 0) {
      due.classList.add('is-overdue');
      const n = Math.abs(item.daysOff);
      due.textContent = `${n}d overdue`;
    } else if (item.daysOff === 0) {
      due.classList.add('is-due-today');
      due.textContent = 'Due today';
    } else {
      // shouldn't appear (queue filters to daysOff <= 0) but guarded anyway
      due.textContent = `In ${item.daysOff}d`;
    }
    due.title = `Next review: ${item.nextDue}`;
    top.appendChild(due);

    btn.appendChild(top);

    const meta = document.createElement('div');
    meta.className = 'review-queue-item-meta';

    const pieceTitle = document.createElement('span');
    pieceTitle.textContent = item.piece.title || '(unknown piece)';
    meta.appendChild(pieceTitle);

    const locParts = [`Page ${item.section.pageNumber}`];
    if (item.section.measures) locParts.push(item.section.measures);
    const loc = document.createElement('span');
    loc.textContent = locParts.join(' · ');
    meta.appendChild(loc);

    if (item.repCount > 0) {
      const progress = document.createElement('span');
      progress.className = 'review-queue-item-progress';
      progress.textContent = `${item.repCount}/${REP_GOAL} today`;
      meta.appendChild(progress);
    }

    btn.appendChild(meta);

    btn.addEventListener('click', () => handleReviewQueueClick(item));

    li.appendChild(btn);
    list.appendChild(li);
  }
}

/**
 * Click a queue item: bring the corresponding piece into view, open the
 * practice panel for the section, and scroll to its page. Idempotent — if
 * the user clicks twice while the PDF is loading, the second click is
 * suppressed by `queueClickInFlight`.
 */
async function handleReviewQueueClick(item) {
  if (queueClickInFlight) return;
  if (!item || !item.section || !item.piece) return;
  queueClickInFlight = true;
  renderReviewQueue(); // re-paint disabled state on the buttons

  try {
    if (activePieceId !== item.piece.id) {
      // selectPiece does its own ensurePdfLoaded + section hydration in the
      // background; we then poll briefly until the section is in memory.
      await selectPiece(item.piece.id);
    }
    // Wait up to ~2.5s for the lazy section list to populate (selectPiece
    // kicks off ensureSectionsLoaded asynchronously). In practice it
    // resolves in <100ms for any realistic library.
    const target = await waitForSection(item.piece.id, item.section.id, 2500);
    if (!target) {
      setStatus(
        `Couldn't open "${item.section.name}" — its piece may be missing.`,
      );
      return;
    }
    await openPracticeView(item.section.id);
    scrollToPage(target.pageNumber);
  } catch (err) {
    console.error('Failed to jump from review queue', err);
    setStatus(`Couldn't open section: ${err.message || err}`);
  } finally {
    queueClickInFlight = false;
    renderReviewQueue();
  }
}

// --- Progress stats (item 9) --------------------------------------------

/**
 * Hydrate the cross-library stats snapshot. Reads the distinct set of
 * practice dates (powering the daily-streak count) and stamps `dateISO` so
 * the render can re-run later in the day without an extra IDB walk.
 *
 * Failures are non-fatal — the stats panel just stays hidden. The progress
 * panel is a motivational affordance, not a showstopper.
 */
async function refreshStats() {
  const dateISO = localDateISO();
  try {
    const dates = await listDistinctPracticeDates();
    statsState = {
      practiceDates: new Set(dates),
      dateISO,
    };
  } catch (err) {
    console.warn('Could not hydrate practice-date history for stats', err);
    statsState = {
      practiceDates: new Set(),
      dateISO,
    };
  }
  renderStats();
  // Non-blocking: load and render the practice-history heatmap.
  refreshHistoryChart().catch((err) =>
    console.warn('History chart refresh failed', err),
  );
}

/**
 * Mark today as a practice day in the in-memory stats snapshot. Keeps the
 * daily-streak count fresh after a rep click without an extra IDB walk —
 * the only "new fact" a rep introduces to the streak math is "we now have
 * a rep on `dateISO`".
 */
function noteRepLogActivity(dateISO) {
  if (!statsState) return;
  if (typeof dateISO === 'string' && dateISO) {
    statsState.practiceDates.add(dateISO);
  }
}

/** Render the stats panel from `statsState` + the live queue + piece data. */
/**
 * Compute total practice time (ms) for a piece by summing its sections'
 * totalPracticeMs. Uses the in-memory piece.sections cache.
 */
function computePieceTotalTime(pieceId) {
  const piece = pieces.find((p) => p.id === pieceId);
  if (!piece || !Array.isArray(piece.sections)) return 0;
  let total = 0;
  for (const sec of piece.sections) {
    if (sec.totalPracticeMs) total += sec.totalPracticeMs;
  }
  return total;
}

function renderStats() {
  const panel = els.statsPanel;
  if (!panel) return;

  // We need queue data too — sections (across the library), today's rep
  // counts. If the queue hasn't hydrated yet (rare race on cold start),
  // hide the stats panel entirely so we don't briefly show a wall of zeros.
  if (!queueState || !statsState) {
    panel.hidden = true;
    return;
  }
  const sections = Array.isArray(queueState.sections) ? queueState.sections : [];
  if (sections.length === 0) {
    // Brand-new library — stats are all zero. Hiding here matches the
    // empty-state policy of the queue panel: don't show a misleading panel
    // until the user has something to be proud of.
    panel.hidden = true;
    return;
  }

  const todayISO = statsState.dateISO || localDateISO();
  let summary;
  try {
    summary = summariseProgress({
      sections,
      pieces,
      practiceDates: statsState.practiceDates,
      repCountsToday: queueState.countsByDate,
      todayISO,
      repGoal: REP_GOAL,
    });
  } catch (err) {
    console.warn('Could not compute progress summary', err);
    panel.hidden = true;
    return;
  }

  panel.hidden = false;

  // Today's done-of-due line in the panel header.
  if (els.statsPanelToday) {
    if (summary.todayDueCount > 0) {
      els.statsPanelToday.textContent =
        `${summary.todayDoneCount} / ${summary.todayDueCount} done today`;
      els.statsPanelToday.classList.toggle(
        'is-complete',
        summary.todayDoneCount >= summary.todayDueCount,
      );
    } else if (summary.todayDoneCount > 0) {
      // Nothing was due today, but the user practiced anyway. Surface that
      // explicitly so a "0 / 0 done" header doesn't read as "I did nothing".
      els.statsPanelToday.textContent = `${summary.todayDoneCount} done today`;
      els.statsPanelToday.classList.add('is-complete');
    } else {
      els.statsPanelToday.textContent = 'Nothing due today';
      els.statsPanelToday.classList.remove('is-complete');
    }
  }

  // Streak tile.
  if (els.statsStreakValue) {
    els.statsStreakValue.textContent = String(summary.dailyStreak);
  }
  if (els.statsStreakDetail) {
    if (summary.dailyStreak === 0) {
      els.statsStreakDetail.textContent =
        sections.length > 0 ? 'Start a session to begin a streak.' : '';
    } else if (summary.dailyStreak === 1) {
      els.statsStreakDetail.textContent = 'Day one — keep it going.';
    } else {
      els.statsStreakDetail.textContent = `${summary.dailyStreak} days in a row.`;
    }
  }

  // Sections-mastered tile.
  if (els.statsMasteredValue) {
    els.statsMasteredValue.textContent = String(summary.sectionsMastered);
  }
  if (els.statsMasteredDetail) {
    if (summary.sectionsTotal === 0) {
      els.statsMasteredDetail.textContent = '';
    } else {
      const pct = Math.round(
        (summary.sectionsMastered / summary.sectionsTotal) * 100,
      );
      els.statsMasteredDetail.textContent =
        `${pct}% of ${summary.sectionsTotal} section${summary.sectionsTotal === 1 ? '' : 's'}.`;
    }
  }

  // Sections-rated tile (sections with at least one SM-2 rating recorded).
  if (els.statsRatedValue) {
    els.statsRatedValue.textContent = String(summary.sectionsRated);
  }
  if (els.statsRatedDetail) {
    const unrated = Math.max(0, summary.sectionsTotal - summary.sectionsRated);
    if (unrated === 0 && summary.sectionsRated === 0) {
      els.statsRatedDetail.textContent = '';
    } else if (unrated === 0) {
      els.statsRatedDetail.textContent = 'Every section has a schedule.';
    } else {
      els.statsRatedDetail.textContent =
        `${unrated} unrated waiting in the wings.`;
    }
  }

  // Per-piece retention list.
  if (els.statsPerPiece && els.statsPerPieceList) {
    const list = els.statsPerPieceList;
    list.innerHTML = '';
    const visible = summary.perPiece.filter((p) => p.sectionsTotal > 0);
    if (visible.length === 0) {
      els.statsPerPiece.hidden = true;
    } else {
      els.statsPerPiece.hidden = false;
      for (const p of visible) {
        const li = document.createElement('li');
        li.className = 'stats-per-piece-row';
        li.dataset.pieceId = p.pieceId;

        const titleEl = document.createElement('span');
        titleEl.className = 'stats-per-piece-title-cell';
        titleEl.textContent = p.title;
        titleEl.title =
          `${p.sectionsMastered} of ${p.sectionsTotal} sections mastered`;
        li.appendChild(titleEl);

        const bar = document.createElement('span');
        bar.className = 'stats-per-piece-bar';
        bar.setAttribute('role', 'progressbar');
        bar.setAttribute('aria-valuemin', '0');
        bar.setAttribute('aria-valuemax', '100');
        bar.setAttribute('aria-valuenow', String(p.masteryPct));
        const fill = document.createElement('span');
        fill.className = 'stats-per-piece-bar-fill';
        fill.style.width = `${p.masteryPct}%`;
        bar.appendChild(fill);
        li.appendChild(bar);

        const pct = document.createElement('span');
        pct.className = 'stats-per-piece-pct';
        pct.textContent = `${p.masteryPct}%`;
        li.appendChild(pct);

        // Item 20 — per-piece total practice time.
        const pieceTime = document.createElement('span');
        pieceTime.className = 'stats-per-piece-time';
        const pieceTotalMs = computePieceTotalTime(p.pieceId);
        pieceTime.textContent = pieceTotalMs > 0
          ? formatTotalPracticeTime(pieceTotalMs)
          : '—';
        pieceTime.title = pieceTotalMs > 0
          ? `Total practice time: ${formatTotalPracticeTime(pieceTotalMs)}`
          : 'No practice time recorded';
        li.appendChild(pieceTime);

        list.appendChild(li);
      }
    }
  }
}

// --- Practice history chart (item 12c) -----------------------------------

/**
 * Build and render a GitHub-style contribution heatmap of the user's practice
 * activity over the last ~13 weeks (91 days). Each cell is one calendar day;
 * the fill intensity maps to total rep count that day (across all sections).
 *
 * Data source: `listAllRepLogs()` returns every rep log record in the DB.
 * We aggregate by dateISO → total count, then bucket into 5 intensity levels
 * (0 = no practice, 1–4 = quartiles of the observed distribution).
 *
 * The SVG is built with vanilla DOM createElement calls (no innerHTML) so it's
 * safe and fast. Month labels sit above the grid; day-of-week labels on the
 * left. The chart scrolls horizontally on narrow viewports.
 */
async function refreshHistoryChart() {
  const container = els.statsHistoryChartContainer;
  const wrapper = els.statsHistoryChart;
  if (!container || !wrapper) return;

  let repLogs;
  try {
    repLogs = await listAllRepLogs();
  } catch (err) {
    console.warn('Could not load rep logs for history chart', err);
    wrapper.hidden = true;
    return;
  }

  // If there are no rep logs at all, hide the chart.
  if (!repLogs || repLogs.length === 0) {
    wrapper.hidden = true;
    return;
  }

  // Aggregate rep counts per date.
  const countByDate = new Map();
  for (const log of repLogs) {
    const d = log.dateISO;
    countByDate.set(d, (countByDate.get(d) || 0) + (log.count || 0));
  }

  renderHeatmap(container, countByDate);
  wrapper.hidden = false;
}

/**
 * Pure-ish rendering: given a Map<dateISO, totalReps>, build the SVG heatmap
 * and replace the container's children.
 */
function renderHeatmap(container, countByDate) {
  const CELL = 13;
  const GAP = 3;
  const STEP = CELL + GAP;
  const WEEKS = 13; // ~91 days
  const ROWS = 7;   // Mon–Sun
  const LEFT_PAD = 28; // space for day labels
  const TOP_PAD = 16;  // space for month labels

  // Build the date grid: 13 weeks ending with the current week.
  const today = new Date();
  const todayDay = today.getDay(); // 0=Sun
  // Find the Monday of the current week (we use Mon-start weeks).
  const mondayOffset = todayDay === 0 ? -6 : 1 - todayDay;
  const currentMonday = new Date(today);
  currentMonday.setDate(today.getDate() + mondayOffset);
  // Go back (WEEKS-1) more weeks to get the start.
  const startDate = new Date(currentMonday);
  startDate.setDate(startDate.getDate() - (WEEKS - 1) * 7);

  // Collect all counts to compute intensity thresholds.
  const nonZeroCounts = [];
  const cells = []; // { col, row, dateISO, count }
  for (let w = 0; w < WEEKS; w++) {
    for (let d = 0; d < ROWS; d++) {
      const cellDate = new Date(startDate);
      cellDate.setDate(startDate.getDate() + w * 7 + d);
      // Don't render future dates.
      if (cellDate > today) continue;
      const iso = formatLocalISO(cellDate);
      const count = countByDate.get(iso) || 0;
      cells.push({ col: w, row: d, dateISO: iso, count });
      if (count > 0) nonZeroCounts.push(count);
    }
  }

  // Compute intensity levels via quartiles of nonzero counts.
  nonZeroCounts.sort((a, b) => a - b);
  const q1 = nonZeroCounts.length > 0 ? quantile(nonZeroCounts, 0.25) : 1;
  const q2 = nonZeroCounts.length > 0 ? quantile(nonZeroCounts, 0.50) : 2;
  const q3 = nonZeroCounts.length > 0 ? quantile(nonZeroCounts, 0.75) : 3;

  function level(count) {
    if (count === 0) return 0;
    if (count <= q1) return 1;
    if (count <= q2) return 2;
    if (count <= q3) return 3;
    return 4;
  }

  const svgWidth = LEFT_PAD + WEEKS * STEP;
  const svgHeight = TOP_PAD + ROWS * STEP;
  const NS = 'http://www.w3.org/2000/svg';

  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('width', String(svgWidth));
  svg.setAttribute('height', String(svgHeight));
  svg.setAttribute('viewBox', `0 0 ${svgWidth} ${svgHeight}`);
  svg.setAttribute('aria-label', 'Practice activity heatmap for the last 13 weeks');
  svg.setAttribute('role', 'img');

  // Day-of-week labels (Mon, Wed, Fri).
  const dayLabels = ['Mon', '', 'Wed', '', 'Fri', '', ''];
  for (let d = 0; d < ROWS; d++) {
    if (!dayLabels[d]) continue;
    const text = document.createElementNS(NS, 'text');
    text.setAttribute('x', String(LEFT_PAD - 4));
    text.setAttribute('y', String(TOP_PAD + d * STEP + CELL - 2));
    text.setAttribute('text-anchor', 'end');
    text.classList.add('heatmap-label');
    text.textContent = dayLabels[d];
    svg.appendChild(text);
  }

  // Month labels: detect when the first day of a column week falls in a new month.
  let lastMonth = -1;
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  for (let w = 0; w < WEEKS; w++) {
    const weekStart = new Date(startDate);
    weekStart.setDate(startDate.getDate() + w * 7);
    const m = weekStart.getMonth();
    if (m !== lastMonth) {
      lastMonth = m;
      const text = document.createElementNS(NS, 'text');
      text.setAttribute('x', String(LEFT_PAD + w * STEP));
      text.setAttribute('y', String(TOP_PAD - 4));
      text.classList.add('heatmap-label');
      text.textContent = months[m];
      svg.appendChild(text);
    }
  }

  // Render cells.
  for (const cell of cells) {
    const rect = document.createElementNS(NS, 'rect');
    rect.setAttribute('x', String(LEFT_PAD + cell.col * STEP));
    rect.setAttribute('y', String(TOP_PAD + cell.row * STEP));
    rect.setAttribute('width', String(CELL));
    rect.setAttribute('height', String(CELL));
    rect.setAttribute('data-level', String(level(cell.count)));
    rect.classList.add('heatmap-cell');

    // Accessible title on hover.
    const title = document.createElementNS(NS, 'title');
    const dateLabel = formatReadableDate(cell.dateISO);
    title.textContent = cell.count > 0
      ? `${cell.count} rep${cell.count === 1 ? '' : 's'} on ${dateLabel}`
      : `No practice on ${dateLabel}`;
    rect.appendChild(title);

    svg.appendChild(rect);
  }

  container.innerHTML = '';
  container.appendChild(svg);
}

/** Format a Date as YYYY-MM-DD in local time. */
function formatLocalISO(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** Turn "2026-05-04" into "May 4, 2026" for tooltip readability. */
function formatReadableDate(iso) {
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return iso;
  const month = months[Number(m[2]) - 1] || m[2];
  return `${month} ${Number(m[3])}, ${m[1]}`;
}

/** Simple quantile on a sorted array (linear interpolation). */
function quantile(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = p * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

/**
 * Poll for a section to land in the active piece's in-memory section list.
 * Returns the section, or null if the timeout elapses or the user has
 * navigated away in the meantime.
 */
async function waitForSection(pieceId, sectionId, timeoutMs) {
  const deadline = Date.now() + Math.max(0, timeoutMs || 0);
  while (Date.now() <= deadline) {
    if (activePieceId !== pieceId) return null;
    const piece = pieces.find((p) => p.id === pieceId);
    if (piece && Array.isArray(piece.sections)) {
      const sec = piece.sections.find((s) => s.id === sectionId);
      if (sec) return sec;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  // One last best-effort lookup against whatever's in memory.
  const piece = pieces.find((p) => p.id === pieceId);
  if (piece && Array.isArray(piece.sections)) {
    return piece.sections.find((s) => s.id === sectionId) || null;
  }
  return null;
}

// --- Export / Import (item 10) -------------------------------------------

/**
 * Export the full library to a JSON file and trigger a browser download.
 * The user gets a timestamped .json file containing all pieces (with PDFs
 * as base64), sections, and rep logs.
 */
async function handleExport() {
  setStatus('Exporting library…');
  try {
    const data = await exportLibrary();
    const json = JSON.stringify(data, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);

    const a = document.createElement('a');
    a.href = url;
    const dateStr = localDateISO().replace(/-/g, '');
    a.download = `pianosrs-backup-${dateStr}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    const pCount = data.pieces ? data.pieces.length : 0;
    const sCount = data.sections ? data.sections.length : 0;
    setStatus(
      `Exported ${pCount} piece${pCount === 1 ? '' : 's'}, ${sCount} section${sCount === 1 ? '' : 's'} to JSON.`,
    );
  } catch (err) {
    console.error('Export failed', err);
    setStatus(`Export failed: ${err.message || err}`);
  }
}

/**
 * Import a library backup from a user-selected JSON file. Uses the 'rename'
 * collision mode by default so existing data is never overwritten.
 */
async function handleImportFile(file) {
  if (!file) return;
  setStatus(`Reading backup file "${file.name}"…`);
  try {
    const text = await file.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch (parseErr) {
      setStatus(`Invalid JSON file — couldn't parse "${file.name}".`);
      return;
    }

    // Confirm before importing — the user should know what's about to happen.
    const pieceCount = Array.isArray(data.pieces) ? data.pieces.length : 0;
    const sectionCount = Array.isArray(data.sections) ? data.sections.length : 0;
    const ok = window.confirm(
      `Import ${pieceCount} piece${pieceCount === 1 ? '' : 's'} and ${sectionCount} section${sectionCount === 1 ? '' : 's'} from this backup?\n\nExisting data won't be overwritten — imported items get new IDs if they collide.`,
    );
    if (!ok) {
      setStatus('Import cancelled.');
      return;
    }

    setStatus('Importing…');
    const result = await importLibrary(data, { mode: 'rename' });

    // Refresh the entire in-memory state from IDB so the sidebar, queue, and
    // stats all reflect the imported data.
    pieces.length = 0;
    activePieceId = null;
    closePracticeView({ silent: true });
    repCountsToday.clear();
    queueState = null;
    statsState = null;

    await hydrateFromStorage();

    setStatus(
      `Imported ${result.piecesImported} piece${result.piecesImported === 1 ? '' : 's'}, ` +
      `${result.sectionsImported} section${result.sectionsImported === 1 ? '' : 's'}, ` +
      `${result.repLogsImported} rep log${result.repLogsImported === 1 ? '' : 's'}` +
      (result.skipped > 0 ? ` (${result.skipped} skipped).` : '.'),
    );
  } catch (err) {
    console.error('Import failed', err);
    setStatus(`Import failed: ${err.message || err}`);
  }
}

// --- Boot ----------------------------------------------------------------

function configurePdfJs() {
  if (window.pdfjsLib && window.pdfjsLib.GlobalWorkerOptions) {
    window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_URL;
  }
}

/**
 * Hydrate the in-memory piece list from IndexedDB on app open.
 * Failures here are non-fatal — the app still runs as an in-memory-only
 * library with a status-line warning.
 */
async function hydrateFromStorage() {
  try {
    await openDb();
    const stored = await listPieceMetadata();
    for (const meta of stored) {
      pieces.push({ ...meta }); // pdfDoc/pdfData/sections fill in on first select
    }
    renderPieceList(pieces);
    if (stored.length > 0) {
      setStatus(
        stored.length === 1
          ? `Loaded 1 saved piece · v${APP_VERSION}`
          : `Loaded ${stored.length} saved pieces · v${APP_VERSION}`,
      );
    } else {
      setStatus(`Ready · v${APP_VERSION}`);
    }
    // Build the daily review queue. Non-blocking — if it fails the rest of
    // the app keeps working; the queue panel just stays hidden.
    await refreshReviewQueue();
    // Hydrate the stats snapshot. Same non-blocking treatment as the queue.
    await refreshStats();
    if (queueState && queueState.sections.length > 0) {
      const dueCount = buildReviewQueue({
        sections: queueState.sections,
        piecesById: queueState.pieceTitleById,
        repCountsToday: queueState.countsByDate,
        todayISO: queueState.dateISO,
        repGoal: REP_GOAL,
      }).length;
      if (dueCount > 0) {
        setStatus(
          dueCount === 1
            ? `1 section due for review today · v${APP_VERSION}`
            : `${dueCount} sections due for review today · v${APP_VERSION}`,
        );
      }
    }
  } catch (err) {
    console.warn('Could not hydrate library from IndexedDB', err);
    setStatus(
      `Ready (storage unavailable — pieces won't persist) · v${APP_VERSION}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Dark mode (item 11b)
// ---------------------------------------------------------------------------
const THEME_STORAGE_KEY = 'pianoSrsTheme';

/**
 * Apply the given theme ('light' or 'dark') to the document and update the
 * toggle button's icon/label to reflect the current state. Persists the
 * choice to localStorage so it survives reloads.
 */
function applyTheme(theme) {
  const isDark = theme === 'dark';
  document.documentElement.classList.toggle('dark', isDark);
  // Update toggle button
  if (els.themeToggle) {
    const icon = els.themeToggle.querySelector('.theme-toggle-icon');
    const label = els.themeToggle.querySelector('.theme-toggle-label');
    if (icon) icon.textContent = isDark ? '☀' : '☾'; // ☀ or ☾
    if (label) label.textContent = isDark ? 'Light' : 'Dark';
    els.themeToggle.setAttribute(
      'aria-label',
      isDark ? 'Switch to light mode' : 'Switch to dark mode',
    );
  }
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch (_) {
    // localStorage unavailable — no big deal, preference just won't persist.
  }
}

/**
 * Determine the initial theme: saved preference > OS preference > light.
 */
function getInitialTheme() {
  try {
    const saved = localStorage.getItem(THEME_STORAGE_KEY);
    if (saved === 'dark' || saved === 'light') return saved;
  } catch (_) {
    // localStorage unavailable — fall through.
  }
  if (
    window.matchMedia &&
    window.matchMedia('(prefers-color-scheme: dark)').matches
  ) {
    return 'dark';
  }
  return 'light';
}

function toggleTheme() {
  const isDark = document.documentElement.classList.contains('dark');
  applyTheme(isDark ? 'light' : 'dark');
}

// --- Mobile sidebar drawer (item 11c) ------------------------------------

/** True when viewport matches the mobile breakpoint (≤720px). */
function isMobileViewport() {
  return window.matchMedia && window.matchMedia('(max-width: 720px)').matches;
}

function openSidebar() {
  document.body.classList.add('sidebar-open');
  if (els.sidebarBackdrop) els.sidebarBackdrop.hidden = false;
  if (els.sidebarToggle) els.sidebarToggle.setAttribute('aria-expanded', 'true');
}

function closeSidebar() {
  document.body.classList.remove('sidebar-open');
  if (els.sidebarBackdrop) els.sidebarBackdrop.hidden = true;
  if (els.sidebarToggle) els.sidebarToggle.setAttribute('aria-expanded', 'false');
}

function toggleSidebar() {
  if (document.body.classList.contains('sidebar-open')) {
    closeSidebar();
  } else {
    openSidebar();
  }
}

// ===== Metronome helpers (item 12b) ==========================================

/** Ensure the metronome singleton exists. */
function ensureMetronome() {
  if (metronome) return metronome;
  metronome = createMetronome();
  metronome.onTick((isDownbeat) => {
    if (!els.metronomeBeatIndicator) return;
    // Remove previous flash class and force reflow so re-adding triggers
    // the CSS transition even if the previous flash hasn't expired.
    els.metronomeBeatIndicator.classList.remove('flash', 'flash-downbeat');
    void els.metronomeBeatIndicator.offsetWidth; // force reflow
    els.metronomeBeatIndicator.classList.add(
      isDownbeat ? 'flash-downbeat' : 'flash',
    );
    clearTimeout(beatFlashTimeout);
    beatFlashTimeout = setTimeout(() => {
      els.metronomeBeatIndicator.classList.remove('flash', 'flash-downbeat');
    }, 120);
  });
  return metronome;
}

function syncMetronomeUI() {
  const m = metronome;
  if (!m) return;
  const running = m.isRunning();
  if (els.metronomeBpmInput) els.metronomeBpmInput.value = String(m.getBpm());
  if (els.metronomeToggleLabel) {
    els.metronomeToggleLabel.textContent = running ? 'Stop' : 'Start';
  }
  if (els.metronomeToggleBtn) {
    els.metronomeToggleBtn.classList.toggle('running', running);
  }
  if (!running && els.metronomeBeatIndicator) {
    els.metronomeBeatIndicator.classList.remove('flash', 'flash-downbeat');
  }
}

function handleMetronomeToggle() {
  const m = ensureMetronome();
  if (m.isRunning()) {
    m.stop();
  } else {
    m.start();
  }
  syncMetronomeUI();
}

function handleMetronomeBpmChange() {
  const m = ensureMetronome();
  const val = parseInt(els.metronomeBpmInput?.value, 10);
  if (Number.isFinite(val)) m.setBpm(val);
  syncMetronomeUI();
}

function handleMetronomeBpmAdjust(delta) {
  const m = ensureMetronome();
  m.setBpm(m.getBpm() + delta);
  syncMetronomeUI();
}

function handleMetronomeTap() {
  const m = ensureMetronome();
  m.tap();
  syncMetronomeUI();
  // Auto-start on first tap if not already running.
  if (!m.isRunning() && m.getBpm()) {
    m.start();
    syncMetronomeUI();
  }
}

/** Stop the metronome (called when closing the practice panel). */
function stopMetronome() {
  if (metronome && metronome.isRunning()) {
    metronome.stop();
    syncMetronomeUI();
  }
}

function init() {
  // --- Dark mode (item 11b) — apply before any rendering so no flash. ------
  applyTheme(getInitialTheme());
  if (els.themeToggle) {
    els.themeToggle.addEventListener('click', toggleTheme);
  }

  // --- Mobile sidebar (item 11c) ------------------------------------------
  if (els.sidebarToggle) {
    els.sidebarToggle.addEventListener('click', toggleSidebar);
  }
  if (els.sidebarBackdrop) {
    els.sidebarBackdrop.addEventListener('click', closeSidebar);
  }

  configurePdfJs();
  setStatus(`Loading library…`);

  if (els.addPieceBtn && els.fileInput) {
    els.addPieceBtn.addEventListener('click', () => els.fileInput.click());
    els.fileInput.addEventListener('change', async (e) => {
      const input = /** @type {HTMLInputElement} */ (e.target);
      const file = input.files && input.files[0];
      input.value = ''; // reset so picking the same file again retriggers
      await handlePdfFile(file);
    });
  }

  if (els.addSectionBtn) {
    els.addSectionBtn.addEventListener('click', () =>
      openSectionForm({ mode: 'add' }),
    );
  }
  if (els.sectionFormCancel) {
    els.sectionFormCancel.addEventListener('click', () => closeSectionForm());
  }
  if (els.sectionForm) {
    els.sectionForm.addEventListener('submit', handleSectionFormSubmit);
    // Esc closes the form.
    els.sectionForm.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        closeSectionForm();
      }
    });
  }

  // Crop region buttons (section-scoped view).
  if (els.sectionCropBtn) {
    els.sectionCropBtn.addEventListener('click', () => startCropSelection());
  }
  if (els.sectionCropClearBtn) {
    els.sectionCropClearBtn.addEventListener('click', () => {
      pendingCrop = null;
      teardownCropOverlay();
      updateCropStatusUI();
      setStatus('Crop region cleared.');
    });
  }

  // Section drag-to-reorder wiring (item 17).
  if (els.sectionList) {
    setupSectionDragAndDrop(els.sectionList);
  }

  // Practice panel wiring (item 5).
  if (els.practiceRepBtn) {
    els.practiceRepBtn.addEventListener('click', handleRepClick);
  }
  if (els.practiceUndoBtn) {
    els.practiceUndoBtn.addEventListener('click', handleUndoRep);
  }
  if (els.practiceResetBtn) {
    els.practiceResetBtn.addEventListener('click', handleResetReps);
  }
  if (els.practiceCloseBtn) {
    els.practiceCloseBtn.addEventListener('click', () => closePracticeView());
  }
  if (els.practiceTimerPauseBtn) {
    els.practiceTimerPauseBtn.addEventListener('click', togglePracticeTimer);
  }

  // Export/import wiring (item 10).
  if (els.exportBtn) {
    els.exportBtn.addEventListener('click', handleExport);
  }
  if (els.importBtn && els.importFileInput) {
    els.importBtn.addEventListener('click', () => els.importFileInput.click());
    els.importFileInput.addEventListener('change', async (e) => {
      const input = /** @type {HTMLInputElement} */ (e.target);
      const file = input.files && input.files[0];
      input.value = '';
      await handleImportFile(file);
    });
  }

  // --- Metronome wiring (item 12b) -----------------------------------------
  if (els.metronomeToggleBtn) {
    els.metronomeToggleBtn.addEventListener('click', handleMetronomeToggle);
  }
  if (els.metronomeTapBtn) {
    els.metronomeTapBtn.addEventListener('click', handleMetronomeTap);
  }
  if (els.metronomeDecBtn) {
    els.metronomeDecBtn.addEventListener('click', () => handleMetronomeBpmAdjust(-5));
  }
  if (els.metronomeIncBtn) {
    els.metronomeIncBtn.addEventListener('click', () => handleMetronomeBpmAdjust(5));
  }
  if (els.metronomeBpmInput) {
    els.metronomeBpmInput.addEventListener('change', handleMetronomeBpmChange);
  }
  if (els.metronomeCollapseBtn) {
    els.metronomeCollapseBtn.addEventListener('click', () => {
      if (!els.metronomeBody) return;
      const isHidden = els.metronomeBody.hidden;
      els.metronomeBody.hidden = !isHidden;
      els.metronomeCollapseBtn.setAttribute('aria-expanded', String(isHidden));
      const icon = els.metronomeCollapseBtn.querySelector('.metronome-collapse-icon');
      if (icon) icon.textContent = isHidden ? '▼' : '▶';
    });
  }

  renderPieceList(pieces);
  // Sections + practice panels start hidden — only shown when a piece is
  // active and (for practice) when the user clicks Practice on a section.
  if (els.sectionsPanel) els.sectionsPanel.hidden = true;
  if (els.practicePanel) els.practicePanel.hidden = true;

  // --- Keyboard shortcuts (item 11 polish) --------------------------------
  // Global key handler — fires only when no text input / textarea is focused,
  // so typing in the section form doesn't accidentally log reps or flip pages.
  document.addEventListener('keydown', handleGlobalKeydown);

  hydrateFromStorage();
}

/**
 * Global keyboard shortcut handler (item 11 polish).
 *
 * Shortcuts:
 *   Space       — log a successful repetition (when practice panel is visible
 *                 and the rep button is enabled).
 *   1 / 2 / 3 / 4 — pick Again / Hard / Good / Easy when the rating prompt is
 *                 visible.
 *   ArrowLeft / ArrowRight — previous / next PDF page (scroll to it).
 *   Escape      — close practice panel (if open) or close section form.
 *
 * Guard: suppressed when a text input, textarea, or contenteditable element is
 * focused — the user might be typing a section name or measure range.
 */
function handleGlobalKeydown(e) {
  // Don't hijack keys while the user is typing in an input field.
  const tag = document.activeElement && document.activeElement.tagName;
  if (
    tag === 'INPUT' ||
    tag === 'TEXTAREA' ||
    (document.activeElement && document.activeElement.isContentEditable)
  ) {
    return;
  }

  switch (e.key) {
    case ' ': {
      // Space = log rep (only when the practice panel is showing and the button
      // is enabled — i.e. count < goal and no save in flight).
      if (
        practiceState &&
        els.practicePanel &&
        !els.practicePanel.hidden &&
        els.practiceRepBtn &&
        !els.practiceRepBtn.disabled
      ) {
        e.preventDefault();
        handleRepClick();
      }
      break;
    }

    case '1':
    case '2':
    case '3':
    case '4': {
      // 1-4 = pick a rating when the rating prompt is visible.
      if (
        practiceState &&
        els.practiceRatingPrompt &&
        !els.practiceRatingPrompt.hidden &&
        !practiceState.ratingInFlight
      ) {
        const ratingMap = {
          '1': RATING_AGAIN,
          '2': RATING_HARD,
          '3': RATING_GOOD,
          '4': RATING_EASY,
        };
        const labelMap = { '1': 'Again', '2': 'Hard', '3': 'Good', '4': 'Easy' };
        e.preventDefault();
        handleRatingClick(ratingMap[e.key], labelMap[e.key]);
      }
      break;
    }

    case 'ArrowLeft':
    case 'ArrowRight': {
      // Left/Right = scroll to previous/next PDF page in the viewer.
      if (!els.viewerPdf || els.viewerPdf.hidden || !els.pdfPages) break;
      e.preventDefault();
      scrollByPage(e.key === 'ArrowLeft' ? -1 : 1);
      break;
    }

    case 'Escape': {
      // Esc = close practice panel if open; otherwise close section form.
      if (practiceState) {
        e.preventDefault();
        closePracticeView();
      } else if (sectionFormState && els.sectionForm && !els.sectionForm.hidden) {
        e.preventDefault();
        closeSectionForm();
      }
      break;
    }

    case 'm':
    case 'M': {
      // M = toggle metronome (item 12b) — only when practice panel is open.
      if (practiceState && els.practicePanel && !els.practicePanel.hidden) {
        e.preventDefault();
        // Auto-expand metronome body if collapsed.
        if (els.metronomeBody && els.metronomeBody.hidden) {
          els.metronomeBody.hidden = false;
          if (els.metronomeCollapseBtn) {
            els.metronomeCollapseBtn.setAttribute('aria-expanded', 'true');
            const icon = els.metronomeCollapseBtn.querySelector('.metronome-collapse-icon');
            if (icon) icon.textContent = '▼';
          }
        }
        handleMetronomeToggle();
      }
      break;
    }

    case 't':
    case 'T': {
      // T = pause/resume session timer (item 18).
      if (practiceState && els.practicePanel && !els.practicePanel.hidden) {
        e.preventDefault();
        togglePracticeTimer();
      }
      break;
    }

    case 'd':
    case 'D': {
      // D = toggle dark mode (item 11b).
      e.preventDefault();
      toggleTheme();
      break;
    }
  }
}

/**
 * Scroll to the next or previous PDF page relative to the one currently most
 * visible in the viewport. `direction` is -1 (previous) or +1 (next).
 */
function scrollByPage(direction) {
  if (!els.pdfPages) return;
  const pages = els.pdfPages.querySelectorAll('.pdf-page[data-page-number]');
  if (pages.length === 0) return;

  // Find the page closest to the top of the viewport.
  let bestIdx = 0;
  let bestDist = Infinity;
  for (let i = 0; i < pages.length; i++) {
    const rect = pages[i].getBoundingClientRect();
    const dist = Math.abs(rect.top);
    if (dist < bestDist) {
      bestDist = dist;
      bestIdx = i;
    }
  }

  const targetIdx = Math.max(0, Math.min(pages.length - 1, bestIdx + direction));
  pages[targetIdx].scrollIntoView({ behavior: 'smooth', block: 'start' });
}

document.addEventListener('DOMContentLoaded', init);
