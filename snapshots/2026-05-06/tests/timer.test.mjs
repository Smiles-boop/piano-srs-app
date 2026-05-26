// Tests for the practice session timer formatting (item 18).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

// Inline the formatElapsed function for testing (it's defined in app.js which
// relies on DOM globals, so we can't import it directly).
function formatElapsed(ms) {
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

describe('formatElapsed', () => {
  it('formats 0 ms as 0:00', () => {
    assert.equal(formatElapsed(0), '0:00');
  });

  it('formats sub-minute durations', () => {
    assert.equal(formatElapsed(5000), '0:05');
    assert.equal(formatElapsed(59000), '0:59');
    assert.equal(formatElapsed(999), '0:00'); // rounds down
  });

  it('formats minute durations', () => {
    assert.equal(formatElapsed(60000), '1:00');
    assert.equal(formatElapsed(90000), '1:30');
    assert.equal(formatElapsed(600000), '10:00');
    assert.equal(formatElapsed(3599000), '59:59');
  });

  it('formats hour durations with h:mm:ss', () => {
    assert.equal(formatElapsed(3600000), '1:00:00');
    assert.equal(formatElapsed(3661000), '1:01:01');
    assert.equal(formatElapsed(7200000), '2:00:00');
    assert.equal(formatElapsed(36000000), '10:00:00');
  });

  it('handles fractional milliseconds by flooring', () => {
    assert.equal(formatElapsed(61500), '1:01');
    assert.equal(formatElapsed(3600500), '1:00:00');
  });
});
