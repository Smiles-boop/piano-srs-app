// PianoSRS — IndexedDB persistence layer.
//
// Roadmap items:
//   3. Pieces store (id-keyed records of {title, pageCount, addedAt, pdfBlob}).
//   4. Sections store (id-keyed, with a `byPieceId` index for fast per-piece
//      lookups). Each section: {id, pieceId, name, pageNumber, measures,
//      addedAt, order}.
//   5. Rep-logs store. One record per (section, calendar-day) pair, holding
//      the running count of self-reported successful repetitions for that
//      day. Composite-id key `${sectionId}|${dateISO}` so a get-by-id is
//      enough — no compound keyPath needed.
//
// Schema (DB version 3):
//   Database: "pianosrs"
//   - Object store "pieces", keyPath "id"
//       Records: { id, title, pageCount, addedAt, pdfBlob }
//   - Object store "sections", keyPath "id"
//       Records: { id, pieceId, name, pageNumber, measures, addedAt, order }
//       Index "byPieceId" on `pieceId` (non-unique).
//   - Object store "repLogs", keyPath "id" (where id = `${sectionId}|${dateISO}`)
//       Records: { id, sectionId, dateISO, count, createdAt, updatedAt }
//       Index "bySectionId" on `sectionId` (non-unique).
//       Index "byDateISO"   on `dateISO`   (non-unique).
//
// PDFs are stored as Blob (not ArrayBuffer). Both Chrome and Firefox handle
// large Blobs in IDB efficiently — the browser keeps them out of the JS heap.
//
// Sections live in their own object store rather than as an array embedded in
// the piece record. That keeps section edits cheap (no PDF blob rewrite per
// edit) and makes "all due sections across all pieces" (roadmap item 7)
// straightforward — we'll just walk the sections store.
//
// Rep logs live in their own store too — they're high-write (one increment
// per click of the rep button) and we want to scope writes to a tiny record
// rather than rewriting a section blob every click. The `bySectionId` index
// lets future stats (item 9) walk a section's full practice history; the
// `byDateISO` index lets the daily review queue (item 7) find every section
// touched today without scanning the whole store — see `getRepCountsForDate`.
//
// Item 7 (daily review queue) didn't need a schema bump: we walk all sections
// via `listAllSections` and join against `getRepCountsForDate(today)` in
// memory. A future `byNextDue` index on the sections store would let the
// queue range-scan instead of full-scan, but the working-set sizes here are
// tiny enough that the simpler shape wins.

const DB_NAME = 'pianosrs';
const DB_VERSION = 3;
const STORE_PIECES = 'pieces';
const STORE_SECTIONS = 'sections';
const STORE_REP_LOGS = 'repLogs';
const INDEX_SECTIONS_BY_PIECE = 'byPieceId';
const INDEX_REP_LOGS_BY_SECTION = 'bySectionId';
const INDEX_REP_LOGS_BY_DATE = 'byDateISO';

/** Hard daily goal for a section's successful repetitions. */
export const REP_GOAL = 10;

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
      // v3 → add repLogs store with bySectionId + byDateISO indexes.
      if (!db.objectStoreNames.contains(STORE_REP_LOGS)) {
        const repLogs = db.createObjectStore(STORE_REP_LOGS, { keyPath: 'id' });
        repLogs.createIndex(INDEX_REP_LOGS_BY_SECTION, 'sectionId', { unique: false });
        repLogs.createIndex(INDEX_REP_LOGS_BY_DATE, 'dateISO', { unique: false });
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

function repLogsStore(db, mode) {
  return db.transaction(STORE_REP_LOGS, mode).objectStore(STORE_REP_LOGS);
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
 * Walk every section across every piece in the DB. Sorted by `nextDue`
 * (ascending, with sections that have no `nextDue` sorted last) and then by
 * `addedAt` so the surface is stable for the daily review queue (item 7).
 *
 * The store is small enough (a personal library of pieces × tens of sections
 * each = at most low thousands of records) that a single getAll over the
 * whole store is the right shape — adding a `byNextDue` index would let us
 * range-scan, but the constant factor matters more for a one-off app-open
 * call than the asymptotic.
 */
export async function listAllSections() {
  const db = await openDb();
  const records = await awaitRequest(sectionsStore(db, 'readonly').getAll());
  return records.sort((a, b) => {
    const an = typeof a.nextDue === 'string' ? a.nextDue : '';
    const bn = typeof b.nextDue === 'string' ? b.nextDue : '';
    // Sections with no nextDue sort to the end (they're not in any queue).
    if (an && !bn) return -1;
    if (!an && bn) return 1;
    if (an !== bn) return an.localeCompare(bn);
    return (a.addedAt || 0) - (b.addedAt || 0);
  });
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

// --- Rep logs -------------------------------------------------------------

/**
 * Get the rep log record for a given (section, calendar-day), or null if no
 * reps have been logged that day.
 */
export async function getRepLog(sectionId, dateISO) {
  const db = await openDb();
  const id = repLogId(sectionId, dateISO);
  const rec = await awaitRequest(repLogsStore(db, 'readonly').get(id));
  return rec || null;
}

/** Persist a rep log record. Overwrites by id (acts as upsert). */
export async function saveRepLog(record) {
  const db = await openDb();
  await awaitRequest(repLogsStore(db, 'readwrite').put(record));
}

/**
 * Atomically increment (or initialise) a rep log for the given
 * (section, calendar-day). The get+put run inside a single readwrite
 * transaction so concurrent button mashing can't drop an increment.
 *
 * Resolves with the new record (including the incremented `count`).
 */
export async function incrementRepLog(sectionId, dateISO) {
  const db = await openDb();
  const id = repLogId(sectionId, dateISO);
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_REP_LOGS, 'readwrite');
    const store = tx.objectStore(STORE_REP_LOGS);
    const getReq = store.get(id);
    getReq.onsuccess = () => {
      const now = Date.now();
      const existing = getReq.result;
      const next = existing
        ? { ...existing, count: (existing.count || 0) + 1, updatedAt: now }
        : {
            id,
            sectionId,
            dateISO,
            count: 1,
            createdAt: now,
            updatedAt: now,
          };
      const putReq = store.put(next);
      putReq.onsuccess = () => resolve(next);
      putReq.onerror = () =>
        reject(putReq.error || new Error('IDB rep-log put failed'));
    };
    getReq.onerror = () =>
      reject(getReq.error || new Error('IDB rep-log get failed'));
  });
}

/**
 * Atomically set a rep log to a specific count. Used by the "undo" affordance
 * in the practice panel. If `count <= 0` and no record exists yet, this is a
 * no-op (we don't need to persist a zeroed record). If `count <= 0` and a
 * record DOES exist, we update it to 0 — keeping the row makes future stats
 * (item 9) able to tell "I started practising and reset" apart from "never
 * touched it today".
 */
export async function setRepLogCount(sectionId, dateISO, count) {
  const db = await openDb();
  const id = repLogId(sectionId, dateISO);
  const safeCount = Math.max(0, Math.floor(Number(count) || 0));
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_REP_LOGS, 'readwrite');
    const store = tx.objectStore(STORE_REP_LOGS);
    const getReq = store.get(id);
    getReq.onsuccess = () => {
      const now = Date.now();
      const existing = getReq.result;
      if (!existing && safeCount === 0) {
        resolve(null);
        return;
      }
      const next = existing
        ? { ...existing, count: safeCount, updatedAt: now }
        : {
            id,
            sectionId,
            dateISO,
            count: safeCount,
            createdAt: now,
            updatedAt: now,
          };
      const putReq = store.put(next);
      putReq.onsuccess = () => resolve(next);
      putReq.onerror = () =>
        reject(putReq.error || new Error('IDB rep-log put failed'));
    };
    getReq.onerror = () =>
      reject(getReq.error || new Error('IDB rep-log get failed'));
  });
}

/**
 * Get the rep counts for a list of sections on a given date in a single
 * readonly transaction. Returns a Map keyed by sectionId; missing sections
 * map to 0. The sections panel uses this to decorate each row with its
 * "X / 10 today" badge without N round-trips.
 */
export async function getRepCountsForSections(sectionIds, dateISO) {
  const counts = new Map();
  if (!sectionIds || sectionIds.length === 0) return counts;
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_REP_LOGS, 'readonly');
    const store = tx.objectStore(STORE_REP_LOGS);
    let pending = sectionIds.length;
    let done = false;
    const fail = (err) => {
      if (done) return;
      done = true;
      reject(err || new Error('IDB rep-log batch get failed'));
    };
    for (const sectionId of sectionIds) {
      const id = repLogId(sectionId, dateISO);
      const req = store.get(id);
      req.onsuccess = () => {
        const rec = req.result;
        counts.set(sectionId, rec ? rec.count || 0 : 0);
        pending -= 1;
        if (pending === 0 && !done) {
          done = true;
          resolve(counts);
        }
      };
      req.onerror = () => fail(req.error);
    }
  });
}

/**
 * Get every rep log for a given calendar day, returned as a Map keyed by
 * sectionId. Used by the daily review queue (item 7) to filter out sections
 * that are due-but-already-finished today without N round-trips.
 *
 * Single readonly transaction over the byDateISO index — for a typical
 * practice day this scans a handful of records.
 */
export async function getRepCountsForDate(dateISO) {
  const counts = new Map();
  if (!dateISO) return counts;
  const db = await openDb();
  const idx = repLogsStore(db, 'readonly').index(INDEX_REP_LOGS_BY_DATE);
  const records = await awaitRequest(idx.getAll(IDBKeyRange.only(dateISO)));
  for (const rec of records) {
    if (rec && typeof rec.sectionId === 'string') {
      counts.set(rec.sectionId, (rec.count || 0));
    }
  }
  return counts;
}

/**
 * Walk every rep log for a section (across all days). Useful for the future
 * stats view (item 9). Defined now so the shape is locked in and tested.
 */
export async function listRepLogsForSection(sectionId) {
  const db = await openDb();
  const idx = repLogsStore(db, 'readonly').index(INDEX_REP_LOGS_BY_SECTION);
  const records = await awaitRequest(idx.getAll(IDBKeyRange.only(sectionId)));
  return records.sort((a, b) => (a.dateISO || '').localeCompare(b.dateISO || ''));
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
 *
 * SRS scheduling fields (item 6) — `repetitions`, `interval`, `ease`,
 * `nextDue`, `lastReviewedDate` — are PASSED THROUGH only when present on
 * the input. Sections that have never been reviewed don't carry empty SRS
 * fields around, and a plain Edit-section save (which doesn't touch SRS
 * state) won't accidentally clobber an existing schedule.
 */
export function sectionToRecord(section) {
  const addedAt =
    typeof section.addedAt === 'number' ? section.addedAt : Date.now();
  const record = {
    id: section.id,
    pieceId: section.pieceId,
    name: section.name,
    pageNumber: section.pageNumber,
    measures: typeof section.measures === 'string' ? section.measures : '',
    addedAt,
    order: typeof section.order === 'number' ? section.order : addedAt,
  };
  // Optional SRS fields — only carried through when present + well-formed,
  // so legacy section records remain unchanged on edit.
  if (
    typeof section.repetitions === 'number' &&
    Number.isFinite(section.repetitions)
  ) {
    record.repetitions = section.repetitions;
  }
  if (
    typeof section.interval === 'number' &&
    Number.isFinite(section.interval)
  ) {
    record.interval = section.interval;
  }
  if (typeof section.ease === 'number' && Number.isFinite(section.ease)) {
    record.ease = section.ease;
  }
  if (typeof section.nextDue === 'string' && section.nextDue) {
    record.nextDue = section.nextDue;
  }
  if (
    typeof section.lastReviewedDate === 'string' &&
    section.lastReviewedDate
  ) {
    record.lastReviewedDate = section.lastReviewedDate;
  }
  return record;
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

// --- Rep-log pure helpers -------------------------------------------------

/**
 * Format a Date as a YYYY-MM-DD string in the LOCAL timezone (not UTC). The
 * SRS algorithm and the rep counter both treat "today" as the user's local
 * calendar day — boundary at local midnight — which matches a pianist's
 * mental model of a practice day. Resolved as the design choice for item 5.
 *
 * Pure — accepts an explicit Date so it's easy to unit-test deterministically.
 */
export function localDateISO(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * Composite id used as the IDB key for a rep log record.
 * Format: `${sectionId}|${dateISO}`. The pipe is safe because section ids
 * are generated from `Date.now()` + `Math.random()` (only `_`, alnum), and
 * dates are strict YYYY-MM-DD.
 */
export function repLogId(sectionId, dateISO) {
  return `${sectionId}|${dateISO}`;
}

/**
 * Build a fresh rep log record. Used both by `incrementRepLog` (when no
 * record exists for today yet) and by import/restore flows (item 10) to
 * keep the schema in one place.
 */
export function newRepLogRecord(sectionId, dateISO, count = 0, now = Date.now()) {
  const safeCount = Math.max(0, Math.floor(Number(count) || 0));
  return {
    id: repLogId(sectionId, dateISO),
    sectionId,
    dateISO,
    count: safeCount,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Pure projection: given a (possibly-null) existing rep log record, return
 * what it should look like after one more successful repetition. Mirrors
 * the persisted state machine in `incrementRepLog` so the increment math
 * itself is unit-testable without IDB.
 */
export function bumpRepLog(existing, sectionId, dateISO, now = Date.now()) {
  if (existing) {
    return {
      ...existing,
      count: (existing.count || 0) + 1,
      updatedAt: now,
    };
  }
  return newRepLogRecord(sectionId, dateISO, 1, now);
}

/** Convenience: count >= REP_GOAL. */
export function isRepGoalMet(count) {
  return (Number(count) || 0) >= REP_GOAL;
}
