# 2026-05-05-c — Section drag-to-reorder (item 17)

## Summary
Added drag-and-drop reordering for sections. Each section row has a grip handle;
dragging reorders in the DOM and persists atomically to IndexedDB.

## Files changed
- `db.js` — `reorderSections()` batch update function
- `app.js` — `setupSectionDragAndDrop()`, drag handle in render, wired in init
- `styles.css` — drag handle, dragging, drag-over styles
- `index.html` — version bump to 0.16.0
