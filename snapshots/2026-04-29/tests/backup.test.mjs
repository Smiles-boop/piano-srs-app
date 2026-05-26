// Tests for the export/import pure helpers in db.js (item 10).
//
// Run from the project root:
//   node tests/backup.test.mjs

import assert from 'node:assert/strict';

const mod = await import('../db.js');

// --- arrayBufferToBase64 ---

// Round-trip: bytes → base64 → bytes
{
  const original = new Uint8Array([0, 1, 2, 127, 128, 255]);
  const b64 = mod.arrayBufferToBase64(original.buffer);
  assert.equal(typeof b64, 'string', 'returns a string');
  const back = new Uint8Array(mod.base64ToArrayBuffer(b64));
  assert.deepEqual([...back], [...original], 'round-trip preserves all bytes');
}

// Empty buffer round-trip
{
  const b64 = mod.arrayBufferToBase64(new ArrayBuffer(0));
  assert.equal(b64, '', 'empty buffer → empty string');
  const back = mod.base64ToArrayBuffer(b64);
  assert.equal(new Uint8Array(back).length, 0, 'empty string → empty buffer');
}

// Known vector (ASCII "Hello")
{
  const input = new Uint8Array([72, 101, 108, 108, 111]); // "Hello"
  const b64 = mod.arrayBufferToBase64(input.buffer);
  assert.equal(b64, 'SGVsbG8=', 'matches known base64 for "Hello"');
  const back = new Uint8Array(mod.base64ToArrayBuffer(b64));
  assert.deepEqual([...back], [72, 101, 108, 108, 111], 'decodes back correctly');
}

// Large buffer (1024 bytes of pseudo-random data)
{
  const large = new Uint8Array(1024);
  for (let i = 0; i < 1024; i++) large[i] = i % 256;
  const b64 = mod.arrayBufferToBase64(large.buffer);
  const back = new Uint8Array(mod.base64ToArrayBuffer(b64));
  assert.equal(back.length, 1024, 'large buffer length preserved');
  let match = true;
  for (let i = 0; i < 1024; i++) {
    if (large[i] !== back[i]) { match = false; break; }
  }
  assert.ok(match, 'large buffer round-trip matches byte-for-byte');
}

// Binary data with all 256 byte values
{
  const all = new Uint8Array(256);
  for (let i = 0; i < 256; i++) all[i] = i;
  const b64 = mod.arrayBufferToBase64(all.buffer);
  const back = new Uint8Array(mod.base64ToArrayBuffer(b64));
  assert.deepEqual([...back], [...all], 'all 256 byte values round-trip');
}

// --- base64ToArrayBuffer edge cases ---

// Padding variants
{
  // "a" → "YQ==" (2 padding chars)
  const back1 = new Uint8Array(mod.base64ToArrayBuffer('YQ=='));
  assert.deepEqual([...back1], [97], 'decodes "a" from base64 with 2 padding chars');
  // "ab" → "YWI=" (1 padding char)
  const back2 = new Uint8Array(mod.base64ToArrayBuffer('YWI='));
  assert.deepEqual([...back2], [97, 98], 'decodes "ab" from base64 with 1 padding char');
  // "abc" → "YWJj" (no padding)
  const back3 = new Uint8Array(mod.base64ToArrayBuffer('YWJj'));
  assert.deepEqual([...back3], [97, 98, 99], 'decodes "abc" from base64 with no padding');
}

// --- exported surface check ---
for (const name of [
  'arrayBufferToBase64',
  'base64ToArrayBuffer',
  'exportLibrary',
  'importLibrary',
]) {
  assert.equal(typeof mod[name], 'function', `db.js exports ${name}`);
}

console.log('backup helpers: all assertions passed');
