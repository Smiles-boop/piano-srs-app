// Tests for the pure helper `titleFromFilename` in app.js.
//
// app.js is built to be loaded by a browser (it touches `document` at the
// bottom). To run a tiny Node-side unit test, we stub the DOM globals it
// reaches for at import time, then exercise the exported function.
//
// Run from the project root:
//   node tests/titleFromFilename.test.mjs

import assert from 'node:assert/strict';

// Minimal DOM stubs — just enough that `app.js` can import without throwing.
class FakeEl {
  constructor() {
    this.children = [];
    this.dataset = {};
    this.classList = {
      add() {},
      remove() {},
      toggle() {},
      contains() { return false; },
    };
    this.hidden = false;
    this.textContent = '';
    this.innerHTML = '';
  }
  appendChild(c) { this.children.push(c); return c; }
  setAttribute() {}
  addEventListener() {}
}

const fakeDoc = {
  getElementById() { return new FakeEl(); },
  addEventListener() {},
  createElement() { return new FakeEl(); },
};

globalThis.document = fakeDoc;
globalThis.window = {};

const mod = await import('../app.js');

// --- titleFromFilename ---
assert.equal(mod.titleFromFilename('beethoven_op27_no2.mid'), 'beethoven op27 no2');
assert.equal(mod.titleFromFilename('Chopin-Nocturne-Op9-No2.midi'), 'Chopin Nocturne Op9 No2');
assert.equal(mod.titleFromFilename('  spaced   name .MID'), 'spaced name');
assert.equal(mod.titleFromFilename('NoExtension'), 'NoExtension');
assert.equal(mod.titleFromFilename('multiple.dots.in.name.mid'), 'multiple.dots.in.name');
assert.equal(mod.titleFromFilename(''), 'Untitled');
assert.equal(mod.titleFromFilename(null), 'Untitled');
assert.equal(mod.titleFromFilename('___.mid'), 'Untitled');

// --- formatClock / meta helpers ---
assert.equal(mod.formatClock(0), '0:00');
assert.equal(mod.formatClock(5), '0:05');
assert.equal(mod.formatClock(65), '1:05');
assert.equal(mod.formatClock(125.7), '2:06');
assert.equal(
  mod.formatPieceMeta({ noteCount: 48, durationSec: 26.5 }),
  '48 notes · 0:27',
);
assert.equal(
  mod.formatSectionMeta({ noteCount: 1, startSec: 4.5, endSec: 8.5 }),
  '1 note · 0:05–0:09',
);

console.log('titleFromFilename: all assertions passed');
