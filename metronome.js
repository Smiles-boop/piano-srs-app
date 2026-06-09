// PianoSRS — Metronome module (roadmap item 12b).
//
// A minimal metronome powered by the Web Audio API. It generates short
// synthesised "click" tones via an OscillatorNode (no sample files needed),
// scheduled ahead using AudioContext.currentTime for rock-solid timing that
// doesn't drift even when the main thread is busy rendering PDF pages.
//
// Public API:
//   createMetronome()  → returns a controller object with start/stop/tap/etc.

/**
 * @typedef {Object} MetronomeController
 * @property {function(number): void} setBpm  — set tempo (30–300).
 * @property {function(): number}     getBpm  — current BPM.
 * @property {function(): void}       start   — begin clicking.
 * @property {function(): void}       stop    — silence.
 * @property {function(): boolean}    isRunning
 * @property {function(): void}       tap     — record a tap for tap-tempo.
 * @property {function(): void}       resetTap — clear tap history.
 * @property {function(function(boolean): void): void} onTick — register a
 *           callback fired on each audible click. The boolean arg is `true`
 *           for the downbeat (beat 1 of the bar) and `false` otherwise. Used
 *           to drive the visual flash indicator.
 * @property {function(): void}       dispose — tear down AudioContext.
 */

const MIN_BPM = 30;
const MAX_BPM = 300;
const DEFAULT_BPM = 100;

// How far ahead (seconds) we schedule oscillator nodes. A longer look-ahead
// tolerates GC pauses better; 100 ms is plenty for a UI metronome.
const SCHEDULE_AHEAD = 0.1;
// How often the scheduling loop runs (ms).
const LOOKAHEAD_MS = 25;

/**
 * Create a self-contained metronome instance.
 * @returns {MetronomeController}
 */
function createMetronome() {
  /** @type {AudioContext | null} */
  let ctx = null;
  let bpm = DEFAULT_BPM;
  let running = false;
  /** Time (AudioContext seconds) when the next click should fire. */
  let nextClickTime = 0;
  /** Current beat within a 4-beat bar (0-based). */
  let beatInBar = 0;
  /** setInterval handle for the scheduling loop. */
  let timerHandle = null;
  /** Registered tick callbacks. */
  const tickListeners = [];

  // --- Tap tempo state ---
  /** Timestamps (performance.now) of recent taps. */
  const taps = [];
  const TAP_WINDOW = 3000;   // ignore taps older than 3 s
  const MIN_TAPS = 2;        // need at least 2 taps to compute interval

  // ---- Internal helpers ----

  function ensureContext() {
    if (!ctx) {
      const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
      ctx = new AC();
    }
    // Safari requires a resume after user gesture.
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }

  /**
   * Schedule a single click tone at `time` (AudioContext seconds).
   * Downbeat (beat 0) gets a higher pitch so the user can hear bar structure.
   */
  function scheduleClick(time, isDownbeat) {
    const c = ensureContext();
    const osc = c.createOscillator();
    const gain = c.createGain();

    osc.type = 'triangle';
    osc.frequency.value = isDownbeat ? 1000 : 700;

    gain.gain.setValueAtTime(0.6, time);
    gain.gain.exponentialRampToValueAtTime(0.001, time + 0.06);

    osc.connect(gain);
    gain.connect(c.destination);

    osc.start(time);
    osc.stop(time + 0.07);

    // Fire visual callback roughly when the click is audible. We schedule a
    // setTimeout that fires at approximately the right wall-clock moment.
    const delay = Math.max(0, (time - c.currentTime) * 1000);
    setTimeout(() => {
      for (const fn of tickListeners) {
        try { fn(isDownbeat); } catch (_) { /* listener threw — ignore */ }
      }
    }, delay);
  }

  /** The scheduling loop: look ahead and schedule any clicks due soon. */
  function scheduler() {
    if (!ctx || !running) return;
    const secondsPerBeat = 60 / bpm;
    while (nextClickTime < ctx.currentTime + SCHEDULE_AHEAD) {
      const isDownbeat = beatInBar === 0;
      scheduleClick(nextClickTime, isDownbeat);
      nextClickTime += secondsPerBeat;
      beatInBar = (beatInBar + 1) % 4;
    }
  }

  // ---- Public API ----

  function start() {
    if (running) return;
    const c = ensureContext();
    running = true;
    beatInBar = 0;
    nextClickTime = c.currentTime + 0.05; // tiny lead-in
    timerHandle = setInterval(scheduler, LOOKAHEAD_MS);
    scheduler(); // kick off immediately
  }

  function stop() {
    running = false;
    if (timerHandle !== null) {
      clearInterval(timerHandle);
      timerHandle = null;
    }
  }

  function setBpm(v) {
    const n = Number(v);
    if (!Number.isFinite(n)) return;
    bpm = Math.round(Math.min(MAX_BPM, Math.max(MIN_BPM, n)));
  }

  function getBpm() {
    return bpm;
  }

  function isRunning() {
    return running;
  }

  /**
   * Record a tap for tap-tempo. After ≥2 taps within the tap window,
   * automatically updates BPM to the average inter-tap interval.
   * Returns the newly computed BPM (or current BPM if not enough taps yet).
   */
  function tap() {
    const now = performance.now();
    // Prune stale taps.
    while (taps.length > 0 && now - taps[0] > TAP_WINDOW) taps.shift();
    taps.push(now);
    if (taps.length >= MIN_TAPS) {
      const intervals = [];
      for (let i = 1; i < taps.length; i++) {
        intervals.push(taps[i] - taps[i - 1]);
      }
      const avgMs = intervals.reduce((a, b) => a + b, 0) / intervals.length;
      const computed = Math.round(60000 / avgMs);
      setBpm(computed);
    }
    return bpm;
  }

  function resetTap() {
    taps.length = 0;
  }

  function onTick(fn) {
    if (typeof fn === 'function') tickListeners.push(fn);
  }

  function dispose() {
    stop();
    if (ctx) {
      ctx.close().catch(() => {});
      ctx = null;
    }
    tickListeners.length = 0;
    taps.length = 0;
  }

  return {
    setBpm,
    getBpm,
    start,
    stop,
    isRunning,
    tap,
    resetTap,
    onTick,
    dispose,
    MIN_BPM,
    MAX_BPM,
    DEFAULT_BPM,
  };
}

// Exported via classic script global scope (no ES module export needed).

// ---- Node export shim (browser-safe) ------------------------------------
// Lets the Node test suite `import` these; skipped in the browser where
// `module` is undefined (classic <script>).
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { createMetronome, MIN_BPM, MAX_BPM, DEFAULT_BPM };
}
