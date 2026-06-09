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
// v4: the app moved from PDF sheet music to MIDI. Piece records now hold a
// `midiBlob` (not `pdfBlob`) and section records carry tick/second ranges
// instead of page + measure text. The shapes are incompatible, so the v4
// upgrade clears the old stores (see onupgradeneeded).
const DB_VERSION = 4;
const STORE_PIECES = 'pieces';
const STORE_SECTIONS = 'sections';
const STORE_REP_LOGS = 'repLogs';
const INDEX_SECTIONS_BY_PIECE = 'byPieceId';
const INDEX_REP_LOGS_BY_SECTION = 'bySectionId';
const INDEX_REP_LOGS_BY_DATE = 'byDateISO';

/** Hard daily goal for a section's successful repetitions. */
const REP_GOAL = 10;

let _dbPromise = null;

/**
 * Open (or upgrade) the PianoSRS IndexedDB. Returns a cached promise so
 * callers don't open the DB twice.
 */
function openDb() {
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
      // v4 → MIDI migration. The old PDF pieces and page/measure sections are
      // structurally incompatible with the new MIDI flow, so wipe them when
      // upgrading from any earlier version. A fresh install (oldVersion 0)
      // starts empty and skips this.
      if (e.oldVersion > 0 && e.oldVersion < 4) {
        const tx = e.target.transaction;
        tx.objectStore(STORE_PIECES).clear();
        tx.objectStore(STORE_SECTIONS).clear();
        tx.objectStore(STORE_REP_LOGS).clear();
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
 * The midiBlob is NOT included — keep it out of memory until a piece is
 * actually selected (lazy-load).
 */
async function listPieceMetadata() {
  const db = await openDb();
  const records = await awaitRequest(piecesStore(db, 'readonly').getAll());
  return records
    .map(metadataFromRecord)
    .sort((a, b) => (a.addedAt || 0) - (b.addedAt || 0));
}

/** Fetch the stored MIDI Blob for a piece, or null if it isn't in the DB. */
async function getPieceBlob(id) {
  const db = await openDb();
  const rec = await awaitRequest(piecesStore(db, 'readonly').get(id));
  return rec ? rec.midiBlob : null;
}

/** Persist a single piece record. Overwrites by id. */
async function savePiece(record) {
  const db = await openDb();
  await awaitRequest(piecesStore(db, 'readwrite').put(record));
}

/**
 * Remove a piece by id. Defined now even though there's no UI for it yet —
 * keeps the persistence surface complete and testable.
 */
async function deletePiece(id) {
  const db = await openDb();
  await awaitRequest(piecesStore(db, 'readwrite').delete(id));
}

/**
 * Rename a piece by updating its title in the IDB record.
 * Uses get-then-put so the large pdfBlob stays intact.
 */
async function renamePiece(id, newTitle) {
  const db = await openDb();
  const store = piecesStore(db, 'readwrite');
  const rec = await awaitRequest(store.get(id));
  if (!rec) throw new Error(`Piece ${id} not found`);
  rec.title = newTitle;
  await awaitRequest(store.put(rec));
}

// --- Sections -------------------------------------------------------------

/**
 * Return all sections belonging to a piece, sorted by `order` then `addedAt`.
 * The store is small (a piece typically has tens of sections, not thousands),
 * so a single getAll over the byPieceId index is cheap.
 */
async function listSectionsForPiece(pieceId) {
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
async function saveSection(record) {
  const db = await openDb();
  await awaitRequest(sectionsStore(db, 'readwrite').put(record));
}

/** Remove a section by id. */
async function deleteSection(id) {
  const db = await openDb();
  await awaitRequest(sectionsStore(db, 'readwrite').delete(id));
}

/**
 * Batch-update the `order` field on multiple section records.
 * Accepts an array of { id, order } objects. Uses a single readwrite
 * transaction so the reorder is atomic.
 */
async function reorderSections(updates) {
  const db = await openDb();
  const store = sectionsStore(db, 'readwrite');
  for (const { id, order } of updates) {
    const record = await awaitRequest(store.get(id));
    if (record) {
      record.order = order;
      store.put(record);
    }
  }
  // Transaction auto-commits when all requests finish.
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
async function listAllSections() {
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
async function deleteSectionsForPiece(pieceId) {
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

/**
 * Cascade: remove every rep log attached to any of the given section IDs.
 * Walks the bySectionId index for each sectionId and deletes every matching
 * record. Used by delete-piece to fully clean up.
 */
async function deleteRepLogsForSections(sectionIds) {
  if (!sectionIds || sectionIds.length === 0) return;
  const db = await openDb();
  const tx = db.transaction(STORE_REP_LOGS, 'readwrite');
  const idx = tx.objectStore(STORE_REP_LOGS).index(INDEX_REP_LOGS_BY_SECTION);
  for (const sid of sectionIds) {
    await new Promise((resolve, reject) => {
      const req = idx.openCursor(IDBKeyRange.only(sid));
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
}

// --- Rep logs -------------------------------------------------------------

/**
 * Get the rep log record for a given (section, calendar-day), or null if no
 * reps have been logged that day.
 */
async function getRepLog(sectionId, dateISO) {
  const db = await openDb();
  const id = repLogId(sectionId, dateISO);
  const rec = await awaitRequest(repLogsStore(db, 'readonly').get(id));
  return rec || null;
}

/** Persist a rep log record. Overwrites by id (acts as upsert). */
async function saveRepLog(record) {
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
async function incrementRepLog(sectionId, dateISO) {
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
async function setRepLogCount(sectionId, dateISO, count) {
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
async function getRepCountsForSections(sectionIds, dateISO) {
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
async function getRepCountsForDate(dateISO) {
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
 * Return the sorted, deduplicated list of YYYY-MM-DD dates the user has
 * logged at least one rep on (across every section). Powers the daily-streak
 * computation in the stats panel (item 9).
 *
 * Implementation: a key cursor over the byDateISO index in `nextunique`
 * direction yields each distinct index key exactly once — IDB does the
 * dedupe natively, so we don't pay to materialise one record per
 * (section, day) pair just to read the date back out.
 */
async function listDistinctPracticeDates() {
  const db = await openDb();
  const idx = repLogsStore(db, 'readonly').index(INDEX_REP_LOGS_BY_DATE);
  return new Promise((resolve, reject) => {
    const dates = [];
    const req = idx.openKeyCursor(null, 'nextunique');
    req.onsuccess = (e) => {
      const cursor = e.target.result;
      if (cursor) {
        const k = cursor.key;
        if (typeof k === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(k)) dates.push(k);
        cursor.continue();
      } else {
        // Cursor walked the index in ascending order, so `dates` is already sorted.
        resolve(dates);
      }
    };
    req.onerror = () =>
      reject(req.error || new Error('IDB practice-dates cursor failed'));
  });
}

/**
 * Walk every rep log for a section (across all days). Useful for the future
 * stats view (item 9). Defined now so the shape is locked in and tested.
 */
async function listRepLogsForSection(sectionId) {
  const db = await openDb();
  const idx = repLogsStore(db, 'readonly').index(INDEX_REP_LOGS_BY_SECTION);
  const records = await awaitRequest(idx.getAll(IDBKeyRange.only(sectionId)));
  return records.sort((a, b) => (a.dateISO || '').localeCompare(b.dateISO || ''));
}

/**
 * Walk ALL rep logs across every section and date. Returns an array of
 * { sectionId, dateISO, count } objects sorted by dateISO ascending.
 * Powers the practice-history chart (item 12c).
 *
 * Single readonly getAll over the repLogs store — for a personal practice
 * library this is at most a few hundred records.
 */
async function listAllRepLogs() {
  const db = await openDb();
  const records = await awaitRequest(repLogsStore(db, 'readonly').getAll());
  return records
    .filter((r) => r && typeof r.dateISO === 'string' && (r.count || 0) > 0)
    .sort((a, b) => (a.dateISO || '').localeCompare(b.dateISO || ''));
}

// --- Practice time persistence (item 19) ---------------------------------

/**
 * Atomically add elapsed practice milliseconds to a section's
 * `totalPracticeMs` field. Uses get-then-put in a single readwrite
 * transaction so concurrent tabs can't lose an increment.
 *
 * Resolves with the new total.
 */
async function addPracticeTime(sectionId, elapsedMs) {
  if (!sectionId || !elapsedMs || elapsedMs <= 0) return 0;
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_SECTIONS, 'readwrite');
    const store = tx.objectStore(STORE_SECTIONS);
    const getReq = store.get(sectionId);
    getReq.onsuccess = () => {
      const rec = getReq.result;
      if (!rec) { resolve(0); return; }
      const prev = typeof rec.totalPracticeMs === 'number' ? rec.totalPracticeMs : 0;
      rec.totalPracticeMs = prev + Math.round(elapsedMs);
      const putReq = store.put(rec);
      putReq.onsuccess = () => resolve(rec.totalPracticeMs);
      putReq.onerror = () => reject(putReq.error || new Error('IDB practice-time put failed'));
    };
    getReq.onerror = () => reject(getReq.error || new Error('IDB practice-time get failed'));
  });
}

// --- Pure helpers (importable + testable in Node) ------------------------

/**
 * Extract metadata fields from a stored piece record. Drops `midiBlob`.
 * @param {{id:string,title:string,durationSec:number,ticksPerQuarter:number,
 *          noteCount:number,addedAt:number,midiBlob:Blob}|null} record
 */
function metadataFromRecord(record) {
  if (!record) return null;
  return {
    id: record.id,
    title: record.title,
    durationSec: record.durationSec,
    ticksPerQuarter: record.ticksPerQuarter,
    noteCount: record.noteCount,
    addedAt: record.addedAt,
  };
}

/**
 * Build a piece storage record from an in-memory piece plus its MIDI Blob.
 * `addedAt` is auto-filled if missing so that re-saves from older records
 * (which never had the field) still get a stable timestamp.
 */
function pieceToRecord(piece, midiBlob) {
  return {
    id: piece.id,
    title: piece.title,
    durationSec:
      typeof piece.durationSec === 'number' ? piece.durationSec : 0,
    ticksPerQuarter:
      typeof piece.ticksPerQuarter === 'number' ? piece.ticksPerQuarter : 480,
    noteCount: typeof piece.noteCount === 'number' ? piece.noteCount : 0,
    addedAt: typeof piece.addedAt === 'number' ? piece.addedAt : Date.now(),
    midiBlob,
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
function sectionToRecord(section) {
  const addedAt =
    typeof section.addedAt === 'number' ? section.addedAt : Date.now();
  const record = {
    id: section.id,
    pieceId: section.pieceId,
    name: section.name,
    // MIDI tick/second window this section covers. Auto-assigned by the
    // phrase-sectioning pass on import; a note belongs to the section if it
    // starts within [startTick, endTick).
    startTick: typeof section.startTick === 'number' ? section.startTick : 0,
    endTick: typeof section.endTick === 'number' ? section.endTick : 0,
    startSec: typeof section.startSec === 'number' ? section.startSec : 0,
    endSec: typeof section.endSec === 'number' ? section.endSec : 0,
    noteCount: typeof section.noteCount === 'number' ? section.noteCount : 0,
    notes: typeof section.notes === 'string' ? section.notes : '',
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
  // Item 19 — cumulative practice time (ms).
  if (
    typeof section.totalPracticeMs === 'number' &&
    Number.isFinite(section.totalPracticeMs) &&
    section.totalPracticeMs > 0
  ) {
    record.totalPracticeMs = section.totalPracticeMs;
  }
  return record;
}

/**
 * Validate raw section input from the UI. With MIDI, a section's tick range is
 * assigned automatically by the phrase-sectioning pass on import — the manual
 * form only edits the section's `name` and free-text `notes` (fingerings).
 *
 * Returns either
 *   { ok: true, value: { name, notes } }
 * or
 *   { ok: false, errors: { name?, notes? } }.
 *
 * Pure — no DOM access, no IDB access — so it's directly unit-testable.
 *
 * @param {{name?: string, notes?: string}} raw
 */
function validateSectionInput(raw, ctx = {}) {
  const errors = {};

  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  if (!name) {
    errors.name = 'Name is required.';
  } else if (name.length > 100) {
    errors.name = 'Name must be 100 characters or fewer.';
  }

  const notes = typeof raw.notes === 'string' ? raw.notes.trim() : '';
  if (notes.length > 2000) {
    errors.notes = 'Notes must be 2000 characters or fewer.';
  }

  if (Object.keys(errors).length > 0) {
    return { ok: false, errors };
  }
  return { ok: true, value: { name, notes } };
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
function localDateISO(date = new Date()) {
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
function repLogId(sectionId, dateISO) {
  return `${sectionId}|${dateISO}`;
}

/**
 * Build a fresh rep log record. Used both by `incrementRepLog` (when no
 * record exists for today yet) and by import/restore flows (item 10) to
 * keep the schema in one place.
 */
function newRepLogRecord(sectionId, dateISO, count = 0, now = Date.now()) {
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
function bumpRepLog(existing, sectionId, dateISO, now = Date.now()) {
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
function isRepGoalMet(count) {
  return (Number(count) || 0) >= REP_GOAL;
}

// --- Export / Import (item 10) -------------------------------------------

/**
 * Export the entire library to a plain object suitable for JSON serialisation.
 * Structure:
 *   {
 *     version: 1,
 *     exportedAt: ISO timestamp,
 *     pieces: [ { ...metadata, pdfBase64 } ],
 *     sections: [ ...all section records ],
 *     repLogs: [ ...all rep log records ],
 *   }
 *
 * PDFs are base64-encoded inside the JSON. This bloats size ~33% vs raw bytes
 * but keeps the format self-contained and round-trippable without a ZIP
 * library. For a typical personal library (a handful of multi-MB PDFs) this is
 * acceptable; a future v2 format could use JSZip for larger libraries.
 */
async function exportLibrary() {
  const db = await openDb();

  // Walk all three stores in a single readonly transaction for consistency.
  const tx = db.transaction(
    [STORE_PIECES, STORE_SECTIONS, STORE_REP_LOGS],
    'readonly',
  );
  const [pieceRecords, sectionRecords, repLogRecords] = await Promise.all([
    awaitRequest(tx.objectStore(STORE_PIECES).getAll()),
    awaitRequest(tx.objectStore(STORE_SECTIONS).getAll()),
    awaitRequest(tx.objectStore(STORE_REP_LOGS).getAll()),
  ]);

  // Convert piece MIDI Blobs to base64 strings.
  const piecesOut = [];
  for (const rec of pieceRecords) {
    const entry = {
      id: rec.id,
      title: rec.title,
      durationSec: rec.durationSec,
      ticksPerQuarter: rec.ticksPerQuarter,
      noteCount: rec.noteCount,
      addedAt: rec.addedAt,
    };
    if (rec.midiBlob) {
      const buf = await blobToArrayBuffer(rec.midiBlob);
      entry.midiBase64 = arrayBufferToBase64(buf);
    }
    piecesOut.push(entry);
  }

  return {
    // v2 = MIDI-era format. v1 (PDF) backups are not importable here.
    version: 2,
    exportedAt: new Date().toISOString(),
    pieces: piecesOut,
    sections: sectionRecords,
    repLogs: repLogRecords,
  };
}

/**
 * Import a library export into the current database. Returns a summary object:
 *   { piecesImported, sectionsImported, repLogsImported, skipped }
 *
 * Collision policy (mode):
 *   - 'rename' (default): imported records get fresh IDs so they never
 *     overwrite existing data. Piece titles are prefixed with "(imported) "
 *     if a piece with the same original ID already exists.
 *   - 'skip': skip any record whose ID already exists in the DB.
 *   - 'overwrite': overwrite existing records with imported data.
 *
 * @param {object} data  The parsed JSON export object.
 * @param {{mode?: 'rename'|'skip'|'overwrite'}} [opts]
 */
async function importLibrary(data, opts = {}) {
  if (!data || typeof data !== 'object') {
    throw new Error('Invalid backup data — expected an object.');
  }
  if (data.version === 1) {
    throw new Error(
      'This backup is from the old PDF version of PianoSRS and cannot be imported into the MIDI version.',
    );
  }
  if (data.version !== 2) {
    throw new Error(
      `Unsupported backup version "${data.version}" — this app reads version 2.`,
    );
  }

  const mode = opts.mode || 'rename';
  const db = await openDb();

  const importedPieces = Array.isArray(data.pieces) ? data.pieces : [];
  const importedSections = Array.isArray(data.sections) ? data.sections : [];
  const importedRepLogs = Array.isArray(data.repLogs) ? data.repLogs : [];

  // Build a set of existing IDs for collision detection.
  const existingPieceIds = new Set(
    (await awaitRequest(db.transaction(STORE_PIECES, 'readonly').objectStore(STORE_PIECES).getAllKeys())),
  );
  const existingSectionIds = new Set(
    (await awaitRequest(db.transaction(STORE_SECTIONS, 'readonly').objectStore(STORE_SECTIONS).getAllKeys())),
  );
  const existingRepLogIds = new Set(
    (await awaitRequest(db.transaction(STORE_REP_LOGS, 'readonly').objectStore(STORE_REP_LOGS).getAllKeys())),
  );

  // ID remapping table (old → new) for rename mode.
  const pieceIdMap = new Map();
  const sectionIdMap = new Map();

  let piecesImported = 0;
  let sectionsImported = 0;
  let repLogsImported = 0;
  let skipped = 0;

  // --- Import pieces ---
  for (const p of importedPieces) {
    if (!p || !p.id) { skipped++; continue; }
    const collision = existingPieceIds.has(p.id);

    if (collision && mode === 'skip') { skipped++; continue; }

    let newId = p.id;
    let title = p.title || 'Untitled';
    if (collision && mode === 'rename') {
      newId = `p_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
      title = `(imported) ${title}`;
    }
    pieceIdMap.set(p.id, newId);

    // Reconstruct the MIDI Blob from base64.
    let midiBlob = null;
    if (typeof p.midiBase64 === 'string' && p.midiBase64.length > 0) {
      const buf = base64ToArrayBuffer(p.midiBase64);
      midiBlob = new Blob([buf], { type: 'audio/midi' });
    }

    const record = {
      id: newId,
      title,
      durationSec: typeof p.durationSec === 'number' ? p.durationSec : 0,
      ticksPerQuarter:
        typeof p.ticksPerQuarter === 'number' ? p.ticksPerQuarter : 480,
      noteCount: typeof p.noteCount === 'number' ? p.noteCount : 0,
      addedAt: typeof p.addedAt === 'number' ? p.addedAt : Date.now(),
      midiBlob,
    };
    await awaitRequest(
      db.transaction(STORE_PIECES, 'readwrite').objectStore(STORE_PIECES).put(record),
    );
    piecesImported++;
  }

  // --- Import sections ---
  for (const s of importedSections) {
    if (!s || !s.id) { skipped++; continue; }
    const collision = existingSectionIds.has(s.id);
    if (collision && mode === 'skip') { skipped++; continue; }

    let newId = s.id;
    if (collision && mode === 'rename') {
      newId = `s_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
    }
    sectionIdMap.set(s.id, newId);

    // Remap pieceId if the piece was renamed.
    const newPieceId = pieceIdMap.get(s.pieceId) || s.pieceId;

    const record = sectionToRecord({
      ...s,
      id: newId,
      pieceId: newPieceId,
    });
    await awaitRequest(
      db.transaction(STORE_SECTIONS, 'readwrite').objectStore(STORE_SECTIONS).put(record),
    );
    sectionsImported++;
  }

  // --- Import rep logs ---
  for (const r of importedRepLogs) {
    if (!r || !r.id) { skipped++; continue; }
    const collision = existingRepLogIds.has(r.id);
    if (collision && mode === 'skip') { skipped++; continue; }

    // Remap sectionId if the section was renamed; recompute composite id.
    const newSectionId = sectionIdMap.get(r.sectionId) || r.sectionId;
    const newRepId = repLogId(newSectionId, r.dateISO);

    // In overwrite mode, keep original id; in rename mode, use remapped.
    const finalId = (mode === 'rename' && sectionIdMap.has(r.sectionId))
      ? newRepId
      : (mode === 'overwrite' ? r.id : newRepId);

    const record = {
      id: finalId,
      sectionId: newSectionId,
      dateISO: r.dateISO,
      count: typeof r.count === 'number' ? r.count : 0,
      createdAt: r.createdAt || Date.now(),
      updatedAt: r.updatedAt || Date.now(),
    };
    await awaitRequest(
      db.transaction(STORE_REP_LOGS, 'readwrite').objectStore(STORE_REP_LOGS).put(record),
    );
    repLogsImported++;
  }

  return { piecesImported, sectionsImported, repLogsImported, skipped };
}

// --- Base64 / Blob utilities (item 10) -----------------------------------

/** Convert a Blob to an ArrayBuffer. */
function blobToArrayBuffer(blob) {
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
 * Encode an ArrayBuffer as a base64 string. Works in all modern browsers.
 * Pure helper — exported for testing.
 */
function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/**
 * Decode a base64 string back to an ArrayBuffer.
 * Pure helper — exported for testing.
 */
function base64ToArrayBuffer(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

// ---- Node export shim (browser-safe) ------------------------------------
// In the browser these are plain globals (classic <script>). Under Node the
// object-literal assignment is picked up by the CJS→ESM interop so the test
// files can `import` them. `module` is undefined in the browser, so this is
// skipped there with no error.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    REP_GOAL,
    openDb,
    listPieceMetadata,
    getPieceBlob,
    savePiece,
    deletePiece,
    renamePiece,
    pieceToRecord,
    metadataFromRecord,
    listSectionsForPiece,
    listAllSections,
    saveSection,
    deleteSection,
    reorderSections,
    deleteSectionsForPiece,
    deleteRepLogsForSections,
    sectionToRecord,
    validateSectionInput,
    localDateISO,
    repLogId,
    newRepLogRecord,
    bumpRepLog,
    getRepLog,
    saveRepLog,
    incrementRepLog,
    setRepLogCount,
    getRepCountsForSections,
    getRepCountsForDate,
    isRepGoalMet,
    listDistinctPracticeDates,
    listRepLogsForSection,
    listAllRepLogs,
    addPracticeTime,
    exportLibrary,
    importLibrary,
    arrayBufferToBase64,
    base64ToArrayBuffer,
  };
}
