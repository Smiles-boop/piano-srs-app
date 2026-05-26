// PianoSRS — IndexedDB persistence layer.
// (Snapshot at 2026-04-29 after item 9. Only the new helper for item 9 is
// the listDistinctPracticeDates function added below; everything else is
// the canonical db.js as of v0.9.0.)
//
// Schema (DB version 3):
//   - "pieces" / "sections" (with byPieceId index) / "repLogs" (with
//     bySectionId + byDateISO indexes).
//
// Item 9 didn't bump the schema. The new query — "every distinct date the
// user has logged a rep on" — rides on the existing byDateISO index using
// `openKeyCursor(null, 'nextunique')`, which gives unique keys natively.

const DB_NAME = 'pianosrs';
const DB_VERSION = 3;
const STORE_PIECES = 'pieces';
const STORE_SECTIONS = 'sections';
const STORE_REP_LOGS = 'repLogs';
const INDEX_SECTIONS_BY_PIECE = 'byPieceId';
const INDEX_REP_LOGS_BY_SECTION = 'bySectionId';
const INDEX_REP_LOGS_BY_DATE = 'byDateISO';

export const REP_GOAL = 10;

let _dbPromise = null;

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
      if (!db.objectStoreNames.contains(STORE_SECTIONS)) {
        const sections = db.createObjectStore(STORE_SECTIONS, { keyPath: 'id' });
        sections.createIndex(INDEX_SECTIONS_BY_PIECE, 'pieceId', { unique: false });
      }
      if (!db.objectStoreNames.contains(STORE_REP_LOGS)) {
        const repLogs = db.createObjectStore(STORE_REP_LOGS, { keyPath: 'id' });
        repLogs.createIndex(INDEX_REP_LOGS_BY_SECTION, 'sectionId', { unique: false });
        repLogs.createIndex(INDEX_REP_LOGS_BY_DATE, 'dateISO', { unique: false });
      }
    };
    req.onsuccess = (e) => resolve(e.target.result);
    req.onerror = (e) => reject(e.target.error || new Error('IndexedDB open failed'));
    req.onblocked = () => reject(new Error('IndexedDB upgrade blocked by another tab'));
  });
  _dbPromise.catch(() => { _dbPromise = null; });
  return _dbPromise;
}

function awaitRequest(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('IDB request failed'));
  });
}

function piecesStore(db, mode) { return db.transaction(STORE_PIECES, mode).objectStore(STORE_PIECES); }
function sectionsStore(db, mode) { return db.transaction(STORE_SECTIONS, mode).objectStore(STORE_SECTIONS); }
function repLogsStore(db, mode) { return db.transaction(STORE_REP_LOGS, mode).objectStore(STORE_REP_LOGS); }

export async function listPieceMetadata() {
  const db = await openDb();
  const records = await awaitRequest(piecesStore(db, 'readonly').getAll());
  return records.map(metadataFromRecord).sort((a, b) => (a.addedAt || 0) - (b.addedAt || 0));
}
export async function getPieceBlob(id) {
  const db = await openDb();
  const rec = await awaitRequest(piecesStore(db, 'readonly').get(id));
  return rec ? rec.pdfBlob : null;
}
export async function savePiece(record) {
  const db = await openDb();
  await awaitRequest(piecesStore(db, 'readwrite').put(record));
}
export async function deletePiece(id) {
  const db = await openDb();
  await awaitRequest(piecesStore(db, 'readwrite').delete(id));
}
export async function listSectionsForPiece(pieceId) {
  const db = await openDb();
  const idx = sectionsStore(db, 'readonly').index(INDEX_SECTIONS_BY_PIECE);
  const records = await awaitRequest(idx.getAll(IDBKeyRange.only(pieceId)));
  return records.sort((a, b) => (a.order || 0) - (b.order || 0) || (a.addedAt || 0) - (b.addedAt || 0));
}
export async function saveSection(record) {
  const db = await openDb();
  await awaitRequest(sectionsStore(db, 'readwrite').put(record));
}
export async function deleteSection(id) {
  const db = await openDb();
  await awaitRequest(sectionsStore(db, 'readwrite').delete(id));
}
export async function listAllSections() {
  const db = await openDb();
  const records = await awaitRequest(sectionsStore(db, 'readonly').getAll());
  return records.sort((a, b) => {
    const an = typeof a.nextDue === 'string' ? a.nextDue : '';
    const bn = typeof b.nextDue === 'string' ? b.nextDue : '';
    if (an && !bn) return -1;
    if (!an && bn) return 1;
    if (an !== bn) return an.localeCompare(bn);
    return (a.addedAt || 0) - (b.addedAt || 0);
  });
}
export async function deleteSectionsForPiece(pieceId) {
  const db = await openDb();
  const tx = db.transaction(STORE_SECTIONS, 'readwrite');
  const idx = tx.objectStore(STORE_SECTIONS).index(INDEX_SECTIONS_BY_PIECE);
  return new Promise((resolve, reject) => {
    const req = idx.openCursor(IDBKeyRange.only(pieceId));
    req.onsuccess = (e) => {
      const cursor = e.target.result;
      if (cursor) { cursor.delete(); cursor.continue(); } else { resolve(); }
    };
    req.onerror = () => reject(req.error || new Error('IDB cursor failed'));
  });
}
export async function getRepLog(sectionId, dateISO) {
  const db = await openDb();
  const id = repLogId(sectionId, dateISO);
  const rec = await awaitRequest(repLogsStore(db, 'readonly').get(id));
  return rec || null;
}
export async function saveRepLog(record) {
  const db = await openDb();
  await awaitRequest(repLogsStore(db, 'readwrite').put(record));
}
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
        : { id, sectionId, dateISO, count: 1, createdAt: now, updatedAt: now };
      const putReq = store.put(next);
      putReq.onsuccess = () => resolve(next);
      putReq.onerror = () => reject(putReq.error || new Error('IDB rep-log put failed'));
    };
    getReq.onerror = () => reject(getReq.error || new Error('IDB rep-log get failed'));
  });
}
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
      if (!existing && safeCount === 0) { resolve(null); return; }
      const next = existing
        ? { ...existing, count: safeCount, updatedAt: now }
        : { id, sectionId, dateISO, count: safeCount, createdAt: now, updatedAt: now };
      const putReq = store.put(next);
      putReq.onsuccess = () => resolve(next);
      putReq.onerror = () => reject(putReq.error || new Error('IDB rep-log put failed'));
    };
    getReq.onerror = () => reject(getReq.error || new Error('IDB rep-log get failed'));
  });
}
export async function getRepCountsForSections(sectionIds, dateISO) {
  const counts = new Map();
  if (!sectionIds || sectionIds.length === 0) return counts;
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_REP_LOGS, 'readonly');
    const store = tx.objectStore(STORE_REP_LOGS);
    let pending = sectionIds.length;
    let done = false;
    const fail = (err) => { if (done) return; done = true; reject(err || new Error('IDB rep-log batch get failed')); };
    for (const sectionId of sectionIds) {
      const id = repLogId(sectionId, dateISO);
      const req = store.get(id);
      req.onsuccess = () => {
        const rec = req.result;
        counts.set(sectionId, rec ? rec.count || 0 : 0);
        pending -= 1;
        if (pending === 0 && !done) { done = true; resolve(counts); }
      };
      req.onerror = () => fail(req.error);
    }
  });
}
export async function getRepCountsForDate(dateISO) {
  const counts = new Map();
  if (!dateISO) return counts;
  const db = await openDb();
  const idx = repLogsStore(db, 'readonly').index(INDEX_REP_LOGS_BY_DATE);
  const records = await awaitRequest(idx.getAll(IDBKeyRange.only(dateISO)));
  for (const rec of records) {
    if (rec && typeof rec.sectionId === 'string') counts.set(rec.sectionId, (rec.count || 0));
  }
  return counts;
}

/**
 * Item 9 — return distinct YYYY-MM-DD dates the user has logged at least
 * one rep on. Powers the daily-streak stat.
 */
export async function listDistinctPracticeDates() {
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
        resolve(dates);
      }
    };
    req.onerror = () => reject(req.error || new Error('IDB practice-dates cursor failed'));
  });
}

export async function listRepLogsForSection(sectionId) {
  const db = await openDb();
  const idx = repLogsStore(db, 'readonly').index(INDEX_REP_LOGS_BY_SECTION);
  const records = await awaitRequest(idx.getAll(IDBKeyRange.only(sectionId)));
  return records.sort((a, b) => (a.dateISO || '').localeCompare(b.dateISO || ''));
}

export function metadataFromRecord(record) {
  if (!record) return null;
  return { id: record.id, title: record.title, pageCount: record.pageCount, addedAt: record.addedAt };
}
export function pieceToRecord(piece, pdfBlob) {
  return {
    id: piece.id, title: piece.title, pageCount: piece.pageCount,
    addedAt: typeof piece.addedAt === 'number' ? piece.addedAt : Date.now(),
    pdfBlob,
  };
}
export function sectionToRecord(section) {
  const addedAt = typeof section.addedAt === 'number' ? section.addedAt : Date.now();
  const record = {
    id: section.id, pieceId: section.pieceId, name: section.name,
    pageNumber: section.pageNumber,
    measures: typeof section.measures === 'string' ? section.measures : '',
    addedAt,
    order: typeof section.order === 'number' ? section.order : addedAt,
  };
  if (typeof section.repetitions === 'number' && Number.isFinite(section.repetitions)) record.repetitions = section.repetitions;
  if (typeof section.interval === 'number' && Number.isFinite(section.interval)) record.interval = section.interval;
  if (typeof section.ease === 'number' && Number.isFinite(section.ease)) record.ease = section.ease;
  if (typeof section.nextDue === 'string' && section.nextDue) record.nextDue = section.nextDue;
  if (typeof section.lastReviewedDate === 'string' && section.lastReviewedDate) record.lastReviewedDate = section.lastReviewedDate;
  return record;
}
export function validateSectionInput(raw, ctx = {}) {
  const errors = {};
  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  if (!name) errors.name = 'Name is required.';
  else if (name.length > 100) errors.name = 'Name must be 100 characters or fewer.';
  const rawPage = raw.pageNumber;
  const pageNumber = typeof rawPage === 'number' ? rawPage : Number(String(rawPage ?? '').trim());
  if (!Number.isFinite(pageNumber) || !Number.isInteger(pageNumber) || pageNumber < 1) {
    errors.pageNumber = 'Page must be a positive whole number.';
  } else if (typeof ctx.maxPage === 'number' && Number.isFinite(ctx.maxPage) && pageNumber > ctx.maxPage) {
    errors.pageNumber = ctx.maxPage === 1 ? 'Page must be 1 (this piece has only 1 page).' : `Page must be between 1 and ${ctx.maxPage}.`;
  }
  const measures = typeof raw.measures === 'string' ? raw.measures.trim() : '';
  if (measures.length > 200) errors.measures = 'Measures must be 200 characters or fewer.';
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return { ok: true, value: { name, pageNumber, measures } };
}
export function localDateISO(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}
export function repLogId(sectionId, dateISO) { return `${sectionId}|${dateISO}`; }
export function newRepLogRecord(sectionId, dateISO, count = 0, now = Date.now()) {
  const safeCount = Math.max(0, Math.floor(Number(count) || 0));
  return { id: repLogId(sectionId, dateISO), sectionId, dateISO, count: safeCount, createdAt: now, updatedAt: now };
}
export function bumpRepLog(existing, sectionId, dateISO, now = Date.now()) {
  if (existing) return { ...existing, count: (existing.count || 0) + 1, updatedAt: now };
  return newRepLogRecord(sectionId, dateISO, 1, now);
}
export function isRepGoalMet(count) { return (Number(count) || 0) >= REP_GOAL; }
