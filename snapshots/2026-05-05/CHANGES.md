# Snapshot 2026-05-05 — Delete Piece UI

## Files changed
- `db.js` — added `deleteRepLogsForSections()` export (lines 237–262)
- `app.js` — imported `deletePiece`, `deleteSectionsForPiece`, `deleteRepLogsForSections`; restructured `renderPieceList()` with info wrapper + delete button; added `handleDeletePiece()` function; bumped APP_VERSION to 0.13.0
- `styles.css` — restructured `.piece-list-item` layout, added `.piece-list-item-info` and `.piece-list-item-delete` styles
- `index.html` — bumped footer version to v0.13.0

## Key additions

### db.js — deleteRepLogsForSections()
```js
export async function deleteRepLogsForSections(sectionIds) {
  if (!sectionIds || sectionIds.length === 0) return;
  const db = await openDb();
  const tx = db.transaction(STORE_REP_LOGS, 'readwrite');
  const idx = tx.objectStore(STORE_REP_LOGS).index(INDEX_REP_LOGS_BY_SECTION);
  for (const sid of sectionIds) {
    await new Promise((resolve, reject) => {
      const req = idx.openCursor(IDBKeyRange.only(sid));
      req.onsuccess = (e) => {
        const cursor = e.target.result;
        if (cursor) { cursor.delete(); cursor.continue(); }
        else { resolve(); }
      };
      req.onerror = () => reject(req.error || new Error('IDB cursor failed'));
    });
  }
}
```

### app.js — handleDeletePiece()
Full cascade: gather section IDs → delete rep logs → delete sections → delete piece → update in-memory state → refresh UI.
