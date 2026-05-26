// PianoSRS — IndexedDB persistence layer.
//
// Roadmap items:
//   3. Pieces store (id-keyed records of {title, pageCount, addedAt, pdfBlob}).
//   4. Sections store (id-keyed, with a `byPieceId` index for fast per-piece
//      lookups). Each section: {id, pieceId, name, pageNumber, measures,
//      addedAt, order}.
//
// Schema (DB version 2):
//   Database: "pianosrs"
//   - Object store "pieces", keyPath "id"
//       Records: { id, title, pageCount, addedAt, pdfBlob }
//   - Object store "sections", keyPath "id"
//       Records: { id, pieceId, name, pageNumber, measures, addedAt, order }
//       Index "byPieceId" on `pieceId` (non-unique).
//
// PDFs are stored as Blob (not ArrayBuffer). Both Chrome and Firefox handle
// large Blobs in IDB efficiently — the browser keeps them out of the JS heap.
//
// Sections live in their own object store rather than as an array embedded in
// the piece record. That keeps section edits cheap (no PDF blob rewrite per
// edit) and makes "all due sections across all pieces" (roadmap item 7)
// straightforward — we'll just walk the sections store.

const DB_NAME = 'pianosrs';
const DB_VERSION = 2;
const STORE_PIECES = 'pieces';
const STORE_SECTIONS = 'sections';
const INDEX_SECTIONS_BY_PIECE = 'byPieceId';

let _dbPromise = null;

/**
 * Open (or upgrade) the PianoSRS IndexedDB. Returns a cached promise so
 * callers don't open the DB twice.
 */
export function openDb() {
  if (_dbPromise) return _dbPromise;
  if (typeof indexedDB === 'undefined') {
    return Promise.reject(new Error('IndexedDB is not available in this browser'));
  }
  _dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      // v1 → ensure pieces store exists.
      if (!db.objectStoreNames.contains(STORE_PIECES)) {
        db.createObjectStore(STORE_PIECES, { keyPath: 'id' });
      }
      // v2 → add sections store with a byPieceId index.
      if (!db.objectStoreNames.contains(STORE_SECTIONS)) {
        const sections = db.createObjectStore(STORE_SECTIONS, { keyPath: 'id' });
        sections.createIndex(INDEX_SECTIONS_BY_PIECE, 'pieceId', { unique: false });
      }
    };
    req.onsuccess = (e) => resolve(e.target.result);
    req.onerror = (e) =>
      reject(e.target.error || new Error('IndexedDB open failed'));
    req.onblocked = () =>
      reject(new Error('IndexedDB upgrade blocked by another tab'));
  });
  // If something goes wrong, allow retries on next call.
  _dbPromise.catch(() => {
    _dbPromise = null;
  });
  return _dbPromise;
}

/** Promise wrapper for a single IDBRequest. */
function awaitRequest(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('IDB request failed'));
  });
}

function piecesStore(db, mode) {
  return db.transaction(STORE_PIECES, mode).objectStore(STORE_PIECES);
}

function sectionsStore(db, mode) {
  return db.transaction(STORE_SECTIONS, mode).objectStore(STORE_SECTIONS);
}

// --- Pieces ---------------------------------------------------------------

/**
 * Return metadata for every saved piece, sorted by addedAt ascending.
 * The pdfBlob is NOT included — keep it out of memory until a piece is
 * actually selected (lazy-load).
 */
export async function listPieceMetadata() {
  const db = await openDb();
  const records = await awaitRequest(piecesStore(db, 'readonly').getAll());
  return records
    .map(metadataFromRecord)
    .sort((a, b) => (a.addedAt || 0) - (b.addedAt || 0));
}

/** Fetch the stored Blob for a piece, or null if it isn't in the DB. */
export async function getPieceBlob(id) {
  const db = await openDb();
  const rec = await awaitRequest(piecesStore(db, 'readonly').get(id));
  return rec ? rec.pdfBlob : null;
}

/** Persist a single piece record. Overwrites by id. */
export async function savePiece(record) {
  const db = await openDb();
  await awaitRequest(piecesStore(db, 'readwrite').put(record));
}

/**
 * Remove a piece by id. Defined now even though there's no UI for it yet —
 * keeps the persistence surface complete and testable.
 */
export async function deletePiece(id) {
  const db = await openDb();
  await awaitRequest(piecesStore(db, 'readwrite').delete(id));
}

// --- Sections -------------------------------------------------------------

/**
 * Return all sections belonging to a piece, sorted by `order` then `addedAt`.
 * The store is small (a piece typically has tens of sections, not thousands),
 * so a single getAll over the byPieceId index is cheap.
 */
export async function listSectionsForPiece(pieceId) {
  const db = await openDb();
  const idx = sectionsStore(db, 'readonly').index(INDEX_SECTIONS_BY_PIECE);
  const records = await awaitRequest(idx.getAll(IDBKeyRange.only(pieceId)));
  return records.sort(
    (a, b) =>
      (a.order || 0) - (b.order || 0) ||
      (a.addedAt || 0) - (b.addedAt || 0),
  );
}

/** Persist a single section record. Overwrites by id (i.e. acts as upsert). */
export async function saveSection(record) {
  const db = await openDb();
  await awaitRequest(sectionsStore(db, 'readwrite').put(record));
}

/** Remove a section by id. */
export async function deleteSection(id) {
  const db = await openDb();
  await awaitRequest(sectionsStore(db, 'readwrite').delete(id));
}

/**
 * Cascade: remove every section attached to a piece. Defined now so a
 * future delete-piece UI can clean up cleanly.
 */
export async function deleteSectionsForPiece(pieceId) {
  const db = await openDb();
  const tx = db.transaction(STORE_SECTIONS, 'readwrite');
  const idx = tx.objectStore(STORE_SECTIONS).index(INDEX_SECTIONS_BY_PIECE);
  return new Promise((resolve, reject) => {
    const req = idx.openCursor(IDBKeyRange.only(pieceId));
    req.onsuccess = (e) => {
      const cursor = e.target.result;
      if (cursor) {
        cursor.delete();
        cursor.continue();
      } else {
        resolve();
      }
    };
    req.onerror = () => reject(req.error || new Error('IDB cursor failed'));
  });
}

// --- Pure helpers (importable + testable in Node) ------------------------

/**
 * Extract metadata fields from a stored piece record. Drops `pdfBlob`.
 * @param {{id:string,title:string,pageCount:number,addedAt:number,pdfBlob:Blob}|null} record
 */
export function metadataFromRecord(record) {
  if (!record) return null;
  return {
    id: record.id,
    title: record.title,
    pageCount: record.pageCount,
    addedAt: record.addedAt,
  };
}

/**
 * Build a piece storage record from an in-memory piece plus its PDF Blob.
 * `addedAt` is auto-filled if missing so that re-saves from older records
 * (which never had the field) still get a stable timestamp.
 */
export function pieceToRecord(piece, pdfBlob) {
  return {
    id: piece.id,
    title: piece.title,
    pageCount: piece.pageCount,
    addedAt: typeof piece.addedAt === 'number' ? piece.addedAt : Date.now(),
    pdfBlob,
  };
}

/**
 * Build a section storage record from a (validated) in-memory section.
 * `addedAt` and `order` are auto-filled when missing — `order` defaults to
 * `addedAt` so newly-created sections sort to the end of the list by default,
 * but the field exists so a future drag-to-reorder UI can repurpose it.
 */
export function sectionToRecord(section) {
  const addedAt =
    typeof section.addedAt === 'number' ? section.addedAt : Date.now();
  return {
    id: section.id,
    pieceId: section.pieceId,
    name: section.name,
    pageNumber: section.pageNumber,
    measures: typeof section.measures === 'string' ? section.measures : '',
    addedAt,
    order: typeof section.order === 'number' ? section.order : addedAt,
  };
}

/**
 * Validate raw section input from the UI. Returns either
 *   { ok: true, value: { name, pageNumber, measures } }
 * or
 *   { ok: false, errors: { name?, pageNumber?, measures? } }.
 *
 * Pure — no DOM access, no IDB access — so it's directly unit-testable.
 *
 * @param {{name?: string, pageNumber?: number|string, measures?: string}} raw
 * @param {{maxPage?: number}} [ctx] optional bounds (e.g. piece.pageCount)
 */
export function validateSectionInput(raw, ctx = {}) {
  const errors = {};

  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  if (!name) {
    errors.name = 'Name is required.';
  } else if (name.length > 100) {
    errors.name = 'Name must be 100 characters or fewer.';
  }

  const rawPage = raw.pageNumber;
  const pageNumber =
    typeof rawPage === 'number' ? rawPage : Number(String(rawPage ?? '').trim());
  if (
    !Number.isFinite(pageNumber) ||
    !Number.isInteger(pageNumber) ||
    pageNumber < 1
  ) {
    errors.pageNumber = 'Page must be a positive whole number.';
  } else if (
    typeof ctx.maxPage === 'number' &&
    Number.isFinite(ctx.maxPage) &&
    pageNumber > ctx.maxPage
  ) {
    errors.pageNumber =
      ctx.maxPage === 1
        ? 'Page must be 1 (this piece has only 1 page).'
        : `Page must be between 1 and ${ctx.maxPage}.`;
  }

  const measures = typeof raw.measures === 'string' ? raw.measures.trim() : '';
  if (measures.length > 200) {
    errors.measures = 'Measures must be 200 characters or fewer.';
  }

  if (Object.keys(errors).length > 0) {
    return { ok: false, errors };
  }
  return { ok: true, value: { name, pageNumber, measures } };
}
