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

import {
  openDb,
  listPieceMetadata,
  getPieceBlob,
  savePiece,
  pieceToRecord,
  listSectionsForPiece,
  saveSection,
  deleteSection,
  sectionToRecord,
  validateSectionInput,
  // Rep-log surface (item 5)
  REP_GOAL,
  localDateISO,
  incrementRepLog,
  setRepLogCount,
  getRepCountsForSections,
  isRepGoalMet,
} from './db.js';
import {
  // SM-2 surface (item 6)
  applySm2,
  srsStateForSection,
  describeNextDue,
  daysBetweenISO,
  RATING_GOOD,
} from './srs.js';

const APP_VERSION = '0.6.0'; // roadmap item 6 — SM-2 scheduling

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
  sectionFormError: document.getElementById('section-form-error'),
  sectionFormCancel: document.getElementById('section-form-cancel'),
  sectionFormSubmit: document.getElementById('section-form-submit'),
  sectionList: document.getElementById('section-list'),
  // Practice panel (item 5)
  practicePanel: document.getElementById('practice-panel'),
  practiceSectionName: document.getElementById('practice-section-name'),
  practiceSectionMeta: document.getElementById('practice-section-meta'),
  practiceCount: document.getElementById('practice-count'),
  practiceGoal: document.getElementById('practice-goal'),
  practiceProgressTrack: document.getElementById('practice-progress-track'),
  practiceProgressFill: document.getElementById('practice-progress-fill'),
  practiceRepBtn: document.getElementById('practice-rep-btn'),
  practiceStatus: document.getElementById('practice-status'),
  practiceNextReview: document.getElementById('practice-next-review'),
  practiceUndoBtn: document.getElementById('practice-undo-btn'),
  practiceResetBtn: document.getElementById('practice-reset-btn'),
  practiceCloseBtn: document.getElementById('practice-close-btn'),
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
 * Practice state. `null` = no active practice; otherwise:
 *   { sectionId: string, dateISO: string, count: number, saving: boolean }
 *
 * `count` is the in-memory mirror of today's persisted count for the active
 * section. We update it optimistically on each rep click so the UI stays
 * responsive; a parallel IDB write keeps the persisted state in sync.
 * `saving` is true while a write is in flight — used to disable the rep
 * button briefly to avoid double-fire on jittery clicks.
 */
let practiceState = null;

/**
 * Rep counts for the active piece's sections, keyed by sectionId. Populated
 * once the piece is hydrated, kept in sync as the user logs reps. Powers the
 * "X / 10" badge on each section row without re-querying IDB on every render.
 */
const repCountsToday = new Map();

/** Set the small status line in the footer. */
export function setStatus(message) {
  if (els.status) {
    els.status.textContent = message;
  }
}

// --- Piece sidebar -------------------------------------------------------

/**
 * Render the piece list in the sidebar.
 * @param {Array<{id: string, title: string, pageCount: number}>} list
 */
export function renderPieceList(list) {
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

    const title = document.createElement('span');
    title.className = 'piece-list-item-title';
    title.textContent = piece.title;
    li.appendChild(title);

    const meta = document.createElement('span');
    meta.className = 'piece-list-item-meta';
    meta.textContent =
      piece.pageCount === 1 ? '1 page' : `${piece.pageCount} pages`;
    li.appendChild(meta);

    li.addEventListener('click', () => selectPiece(piece.id));
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
 * Derive a human-readable piece title from a filename.
 * Strips the extension and replaces underscores/dashes with spaces.
 * Exported for unit testing.
 */
export function titleFromFilename(filename) {
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

    pieces.push(piece);
    renderPieceList(pieces);
    setStatus(`Added "${piece.title}" (${piece.pageCount} pages).`);
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
    const isActivePractice =
      practiceState && practiceState.sectionId === sec.id;
    if (isActivePractice) li.classList.add('practicing');

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
  let titleText = 'New section';

  if (state.mode === 'edit') {
    const existing = (piece.sections || []).find((s) => s.id === state.id);
    if (!existing) {
      // Edited section vanished (e.g. concurrent delete) — fall back to add.
      sectionFormState = { mode: 'add' };
    } else {
      nameVal = existing.name;
      pageVal = String(existing.pageNumber);
      measuresVal = existing.measures || '';
      titleText = 'Edit section';
    }
  }

  if (els.sectionFormTitle) els.sectionFormTitle.textContent = titleText;
  if (els.sectionNameInput) els.sectionNameInput.value = nameVal;
  if (els.sectionPageInput) {
    els.sectionPageInput.value = pageVal;
    els.sectionPageInput.max = String(piece.pageCount);
  }
  if (els.sectionMeasuresInput) els.sectionMeasuresInput.value = measuresVal;
  if (els.sectionFormError) {
    els.sectionFormError.textContent = '';
    els.sectionFormError.hidden = true;
  }

  els.sectionForm.hidden = false;
  if (els.sectionNameInput) {
    els.sectionNameInput.focus();
    els.sectionNameInput.select();
  }
}

function closeSectionForm() {
  sectionFormState = null;
  if (!els.sectionForm) return;
  els.sectionForm.hidden = true;
  if (els.sectionFormError) {
    els.sectionFormError.textContent = '';
    els.sectionFormError.hidden = true;
  }
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
    record = sectionToRecord({
      ...existing,
      name: result.value.name,
      pageNumber: result.value.pageNumber,
      measures: result.value.measures,
    });
  } else {
    // Append at the end of the current order range so new sections sort last
    // until a future drag-to-reorder UI exists.
    const maxOrder = sections.reduce(
      (m, s) => (typeof s.order === 'number' && s.order > m ? s.order : m),
      0,
    );
    record = sectionToRecord({
      id: newSectionId(),
      pieceId: piece.id,
      name: result.value.name,
      pageNumber: result.value.pageNumber,
      measures: result.value.measures,
      addedAt: Date.now(),
      order: maxOrder + 1,
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
  // Re-sort by order then addedAt to match the persistence layer.
  sections.sort(
    (a, b) =>
      (a.order || 0) - (b.order || 0) ||
      (a.addedAt || 0) - (b.addedAt || 0),
  );
  piece.sections = sections;

  closeSectionForm();
  renderSectionsPanel();
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
  setStatus(`Deleted section "${target.name}".`);
  renderSectionsPanel();
}

// --- Practice panel (item 5) --------------------------------------------

/** Open the practice panel for the given section. */
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
  };

  // Re-render the section list so the active row highlights + the Practice
  // button on this section disables.
  renderSectionsPanel();
  // Reveal the practice panel and paint the initial state.
  showPracticePanel(section);
  renderPracticePanel();
  // Scroll the PDF viewer to the section's page so the user can see what
  // they're practising.
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
      // If the user crossed the goal in another tab / earlier today and
      // SM-2 hasn't fired yet (e.g. they hit 10 reps before item 6 shipped),
      // fire it now so the next-review card has something to show. The
      // `lastReviewedDate` guard inside makes this idempotent.
      if (isRepGoalMet(fresh)) {
        await maybeFireSm2(sectionId, dateISO);
      }
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
  if (els.practiceGoal) els.practiceGoal.textContent = String(REP_GOAL);
  if (els.practiceProgressTrack) {
    els.practiceProgressTrack.setAttribute('aria-valuemax', String(REP_GOAL));
  }
}

/** Hide the practice panel and clear practice state. */
function closePracticeView({ silent } = {}) {
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
  // the goal-met message — keep the status line quiet so we don't double up.
  const scheduledToday =
    section && section.lastReviewedDate === practiceState.dateISO;
  if (els.practiceStatus) {
    if (goalMet && !scheduledToday) {
      // Goal met but SM-2 hasn't fired (e.g. transient save error). Stays
      // honest about what happened rather than pretending it's scheduled.
      els.practiceStatus.textContent =
        `Nice — ${count} clean reps today. Saving today's review…`;
      els.practiceStatus.hidden = false;
    } else if (count === 0) {
      els.practiceStatus.textContent =
        'Click after each clean run-through. You self-report — no audio detection.';
      els.practiceStatus.hidden = false;
    } else {
      els.practiceStatus.hidden = true;
      els.practiceStatus.textContent = '';
    }
  }

  // SM-2 next-review card (item 6). Surfaced as soon as a section has been
  // rated at least once. Re-painted on every state change so the user sees
  // it immediately after crossing the goal.
  renderNextReview(section);

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
    const nowGoalMet = isRepGoalMet(persisted.count);
    if (nowGoalMet) {
      setStatus(`Nice — ${persisted.count} reps logged today.`);
    } else {
      setStatus(`Logged rep ${persisted.count} of ${REP_GOAL}.`);
    }
    // SM-2 schedule update (item 6). Fires on the transition into
    // goal-met, but only once per local-calendar-day per section. The
    // `lastReviewedDate` guard inside maybeFireSm2 means hitting Reset →
    // 10 again won't double-advance the schedule. Default-Good rating;
    // item 8 will replace this with a real Again/Hard/Good/Easy prompt.
    if (nowGoalMet) {
      await maybeFireSm2(sectionId, dateISO);
    }
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
  }
}

/**
 * If the section hasn't already been reviewed today, apply SM-2 (default
 * Good rating) and persist the updated schedule onto the section record.
 * Idempotent across same-day re-fires thanks to the `lastReviewedDate`
 * guard. Failures are non-fatal — the rep itself is already logged; the
 * status line surfaces the schedule-save error.
 */
async function maybeFireSm2(sectionId, dateISO) {
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

  const next = applySm2(cur, RATING_GOOD, dateISO);
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

  setStatus(
    `Scheduled "${section.name}" — ${describeNextDue(next.nextDue, dateISO)}.`,
  );
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
  } catch (err) {
    console.warn('Could not hydrate library from IndexedDB', err);
    setStatus(
      `Ready (storage unavailable — pieces won't persist) · v${APP_VERSION}`,
    );
  }
}

function init() {
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

  renderPieceList(pieces);
  // Sections + practice panels start hidden — only shown when a piece is
  // active and (for practice) when the user clicks Practice on a section.
  if (els.sectionsPanel) els.sectionsPanel.hidden = true;
  if (els.practicePanel) els.practicePanel.hidden = true;
  hydrateFromStorage();
}

document.addEventListener('DOMContentLoaded', init);
