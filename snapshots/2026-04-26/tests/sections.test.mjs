// Tests for the section pure helpers in db.js
// (sectionToRecord, validateSectionInput).
//
// db.js only touches `indexedDB` lazily inside `openDb()`, so importing it in
// Node is safe without any DOM stub. Run from the project root:
//   node tests/sections.test.mjs

import assert from 'node:assert/strict';

const mod = await import('../db.js');

// --- validateSectionInput: happy path ----------------------------------------
{
  const r = mod.validateSectionInput({
    name: '  Exposition  ',
    pageNumber: '3',
    measures: '  mm. 17–32  ',
  }, { maxPage: 10 });
  assert.equal(r.ok, true, 'valid input is accepted');
  assert.deepEqual(r.value, {
    name: 'Exposition',
    pageNumber: 3,
    measures: 'mm. 17–32',
  }, 'fields are trimmed and the page is coerced to a number');
}

// --- empty measures is allowed ----------------------------------------------
{
  const r = mod.validateSectionInput({
    name: 'A',
    pageNumber: 1,
    measures: '',
  }, { maxPage: 5 });
  assert.equal(r.ok, true, 'empty measures is allowed');
  assert.equal(r.value.measures, '');
}

// --- missing name fails -----------------------------------------------------
{
  const r = mod.validateSectionInput({ name: '   ', pageNumber: 1 });
  assert.equal(r.ok, false);
  assert.ok(r.errors.name, 'reports a name error');
  assert.equal(r.errors.pageNumber, undefined, 'page is fine, not flagged');
}

// --- bad page numbers -------------------------------------------------------
for (const bad of [0, -1, 1.5, 'abc', '', null, undefined, NaN]) {
  const r = mod.validateSectionInput({ name: 'X', pageNumber: bad });
  assert.equal(r.ok, false, `pageNumber=${JSON.stringify(bad)} is rejected`);
  assert.ok(r.errors.pageNumber, `pageNumber=${JSON.stringify(bad)} reports a page error`);
}

// --- page above maxPage is rejected -----------------------------------------
{
  const r = mod.validateSectionInput(
    { name: 'X', pageNumber: 11 },
    { maxPage: 10 },
  );
  assert.equal(r.ok, false);
  assert.match(r.errors.pageNumber, /1 and 10/);
}

// --- maxPage = 1 produces a friendlier message ------------------------------
{
  const r = mod.validateSectionInput(
    { name: 'X', pageNumber: 2 },
    { maxPage: 1 },
  );
  assert.equal(r.ok, false);
  assert.match(r.errors.pageNumber, /only 1 page/);
}

// --- maxPage absent => no upper bound check ---------------------------------
{
  const r = mod.validateSectionInput({ name: 'X', pageNumber: 9999 });
  assert.equal(r.ok, true, 'with no maxPage, large pages are allowed');
}

// --- name length cap --------------------------------------------------------
{
  const r = mod.validateSectionInput({
    name: 'a'.repeat(101),
    pageNumber: 1,
  });
  assert.equal(r.ok, false);
  assert.match(r.errors.name, /100/);
}

// --- measures length cap ----------------------------------------------------
{
  const r = mod.validateSectionInput({
    name: 'X',
    pageNumber: 1,
    measures: 'm'.repeat(201),
  });
  assert.equal(r.ok, false);
  assert.match(r.errors.measures, /200/);
}

// --- multiple errors are all reported --------------------------------------
{
  const r = mod.validateSectionInput({ name: '', pageNumber: 0 });
  assert.equal(r.ok, false);
  assert.ok(r.errors.name && r.errors.pageNumber,
    'both name and page errors are surfaced together');
}

// --- sectionToRecord: full passthrough --------------------------------------
{
  const rec = mod.sectionToRecord({
    id: 's_1',
    pieceId: 'p_a',
    name: 'A',
    pageNumber: 2,
    measures: 'mm. 1–8',
    addedAt: 1000,
    order: 5,
  });
  assert.deepEqual(rec, {
    id: 's_1',
    pieceId: 'p_a',
    name: 'A',
    pageNumber: 2,
    measures: 'mm. 1–8',
    addedAt: 1000,
    order: 5,
  });
}

// --- sectionToRecord: addedAt + order auto-fill, order defaults to addedAt --
{
  const before = Date.now();
  const rec = mod.sectionToRecord({
    id: 's_2', pieceId: 'p_a', name: 'B', pageNumber: 1,
  });
  const after = Date.now();
  assert.equal(typeof rec.addedAt, 'number');
  assert.ok(rec.addedAt >= before && rec.addedAt <= after,
    'auto-filled addedAt is within the call window');
  assert.equal(rec.order, rec.addedAt,
    'auto-filled order matches addedAt by default');
  assert.equal(rec.measures, '', 'missing measures becomes empty string');
}

// --- sectionToRecord: explicit addedAt: 0 is preserved ----------------------
{
  const rec = mod.sectionToRecord({
    id: 's_3', pieceId: 'p_a', name: 'C', pageNumber: 1, addedAt: 0,
  });
  assert.equal(rec.addedAt, 0, 'explicit addedAt: 0 is preserved');
  assert.equal(rec.order, 0, 'order falls back to addedAt (0) when missing');
}

// --- sectionToRecord: explicit order: 0 is preserved ------------------------
{
  const rec = mod.sectionToRecord({
    id: 's_4', pieceId: 'p_a', name: 'D', pageNumber: 1,
    addedAt: 9999, order: 0,
  });
  assert.equal(rec.order, 0, 'explicit order: 0 is preserved');
}

// --- sectionToRecord: non-string measures becomes empty string --------------
{
  const rec = mod.sectionToRecord({
    id: 's_5', pieceId: 'p_a', name: 'E', pageNumber: 1, measures: null,
  });
  assert.equal(rec.measures, '');
}

// --- exported surface --------------------------------------------------------
for (const name of [
  'listSectionsForPiece', 'saveSection', 'deleteSection',
  'deleteSectionsForPiece', 'sectionToRecord', 'validateSectionInput',
]) {
  assert.equal(typeof mod[name], 'function', `db.js exports ${name}`);
}

console.log('section helpers: all assertions passed');
