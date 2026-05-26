// PianoSRS — IndexedDB persistence layer.
//
// Roadmap item 3. Keeps the in-memory app code in `app.js` decoupled from the
// IDB plumbing so we can test the pure helpers (`metadataFromRecord`,
// `pieceToRecord`) under Node without touching the browser API.
//
// Schema (DB version 1):
//   Database: "pianosrs"
//   Object store: "pieces", keyPath "id"
//   Records: { id, title, pageCount, addedAt, pdfBlob }
//
// PDFs are stored as Blob (not ArrayBuffer). Both Chrome and Firefox handle
// large Blobs in IDB efficiently — the browser keeps them out of the JS heap.

const DB_NAME = 'pianosrs';
const DB_VERSION = 1;
const STORE_PIECES = 'pieces';

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
      if (!db.objectStoreNames.contains(STORE_PIECES)) {
        db.createObjectStore(STORE_PIECES, { keyPath: 'id' });
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

function store(db, mode) {
  return db.transaction(STORE_PIECES, mode).objectStore(STORE_PIECES);
}

/**
 * Return metadata for every saved piece, sorted by addedAt ascending.
 * The pdfBlob is NOT included — keep it out of memory until a piece is
 * actually selected (lazy-load).
 */
export async function listPieceMetadata() {
  const db = await openDb();
  const records = await awaitRequest(store(db, 'readonly').getAll());
  return records
    .map(metadataFromRecord)
    .sort((a, b) => (a.addedAt || 0) - (b.addedAt || 0));
}

/** Fetch the stored Blob for a piece, or null if it isn't in the DB. */
export async function getPieceBlob(id) {
  const db = await openDb();
  const rec = await awaitRequest(store(db, 'readonly').get(id));
  return rec ? rec.pdfBlob : null;
}

/** Persist a single piece record. Overwrites by id. */
export async function savePiece(record) {
  const db = await openDb();
  await awaitRequest(store(db, 'readwrite').put(record));
}

/**
 * Remove a piece by id. Defined now even though there's no UI for it yet —
 * keeps the persistence surface complete and testable.
 */
export async function deletePiece(id) {
  const db = await openDb();
  await awaitRequest(store(db, 'readwrite').delete(id));
}

// --- Pure helpers (importable + testable in Node) ------------------------

/**
 * Extract metadata fields from a stored record. Drops `pdfBlob`.
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
 * Build a storage record from an in-memory piece plus its PDF Blob.
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
