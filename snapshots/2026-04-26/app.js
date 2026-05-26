// PianoSRS — main app entry point.
//
// Roadmap items shipped here:
//   1. Basic shell layout (sidebar + viewer + status bar).
//   2. PDF upload via file input + PDF.js rendering (continuous scroll).
//   3. IndexedDB persistence — pieces survive a refresh.
//   4. Section definition UI — create/edit/delete named sections per piece,
//      each with a 1-based PDF page number and a free-text measure range
//      (e.g. "mm. 17–32"). Click a section to scroll to its page.
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
} from './db.js';

const APP_VERSION = '0.4.0'; // roadmap item 4 — section definition UI

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
  activePieceId = pieceId;
  // Re-render the sidebar so the active highlight moves.
  renderPieceList(pieces);
  // Close any in-flight section form when switching pieces.
  closeSectionForm();

  try {
    await ensurePdfLoaded(piece);
  } catch (err) {
    console.error('Failed to load PDF from storage', err);
    setStatus(`Failed to load "${piece.title}": ${err.message || err}`);
    return;
  }

  // Load sections in the background — they don't block PDF render.
  ensureSectionsLoaded(piece).then(() => {
    if (activePieceId === piece.id) renderSectionsPanel();
  }).catch((err) => {
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

    li.appendChild(main);

    const actions = document.createElement('div');
    actions.className = 'section-list-actions';

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
  setStatus(`Deleted section "${target.name}".`);
  renderSectionsPanel();
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

  renderPieceList(pieces);
  // Sections panel starts hidden — only shown when a piece is active.
  if (els.sectionsPanel) els.sectionsPanel.hidden = true;
  hydrateFromStorage();
}

document.addEventListener('DOMContentLoaded', init);
