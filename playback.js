// PianoSRS — synth playback engine ("Listen").
//
// `createPiecePlayback(opts)` schedules a set of note events on the Web Audio
// API (a simple triangle-wave voice per note, through a master gain + a
// compressor so dense chords don't clip) and runs a clock alongside the audio
// so the UI can follow along — the engraved score's cursor, the falling-note
// playhead, key flashes on the on-screen keyboard, a time readout.
//
//   const pb = createPiecePlayback({ onStep, onTime, onEnd });
//   pb.play(notes, { ticksPerQuarter, fromSec });   // → true if it started
//   pb.stop();  pb.isPlaying();  pb.getPosition();  pb.dispose();
//
// Callbacks (all optional):
//   onStep({ tick, sec, at, pitches, index, total })
//       fired as each onset group (a chord / single note) starts sounding, in
//       order — the same "steps" wait-mode grades, so a follower can snap to
//       exactly the positions the practice cursor uses,
//   onTime(elapsedSec, totalSec)
//       every animation frame while playing (elapsed clamps to [0, total]),
//   onEnd({ completed })
//       once, when playback runs to the end (completed: true) or is stopped /
//       superseded by a new play() (completed: false).
//
// The engine can own its AudioContext (default) or borrow one via
// `opts.audioContext` — a function returning the context to use — so the
// practice player can route Listen through the same context as its key pings.
//
// Depends on midi.js: `groupNotesIntoSteps` (global in the browser).

const PLAYBACK_LEAD_SEC = 0.2;   // silence before the first onset
const PLAYBACK_MIN_NOTE_SEC = 0.12;
const PLAYBACK_NOTE_GAIN = 0.2;
const PLAYBACK_MASTER_GAIN = 0.7;
const PLAYBACK_END_TAIL_SEC = 0.15;
// Follow-clock period. A timer rather than requestAnimationFrame so the
// cursor / readout keep tracking the (unpausable) audio when the tab is in
// the background — rAF simply stops there. Steps only need to fire on time,
// any easing is the follower's own business.
const PLAYBACK_TICK_MS = 30;

/**
 * Pure: turn note events into a playback timeline relative to a base time.
 *
 * `fromSec` anchors t=0 (e.g. the section's start, so a hand's lead-in rest
 * is kept); it defaults to the first onset. A `fromSec` later than the first
 * onset is clamped back so nothing is scheduled in the past.
 *
 * @param {Array<{midi:number,startSec:number,endSec:number,startTick:number}>} notes
 * @param {{ticksPerQuarter?:number, fromSec?:number}} [opts]
 * @returns {{base:number, total:number,
 *   events:Array<{midi:number, at:number, dur:number}>,
 *   steps:Array<{tick:number, sec:number, at:number, pitches:number[], index:number, total:number}>}}
 */
function buildPlaybackTimeline(notes, opts = {}) {
  const list = Array.isArray(notes)
    ? notes.filter((n) => n && Number.isFinite(n.startSec) && Number.isFinite(n.midi))
    : [];
  if (!list.length) return { base: 0, total: 0, events: [], steps: [] };

  let firstSec = Infinity;
  for (const n of list) if (n.startSec < firstSec) firstSec = n.startSec;
  const base = Number.isFinite(opts.fromSec) ? Math.min(opts.fromSec, firstSec) : firstSec;

  let total = 0;
  const events = list.map((n) => {
    const at = n.startSec - base;
    const rawDur = Number.isFinite(n.endSec) ? n.endSec - n.startSec : 0;
    const dur = Math.max(PLAYBACK_MIN_NOTE_SEC, rawDur);
    if (at + dur > total) total = at + dur;
    return { midi: n.midi, at, dur };
  });

  const grouped = typeof groupNotesIntoSteps === 'function'
    ? groupNotesIntoSteps(list, { ticksPerQuarter: opts.ticksPerQuarter })
    : [];
  const steps = grouped.map((s, i) => ({
    tick: s.tick,
    sec: s.sec,
    at: s.sec - base,
    pitches: s.pitches,
    index: i,
    total: grouped.length,
  }));

  return { base, total, events, steps };
}

/**
 * @param {{audioContext?:Function, onStep?:Function, onTime?:Function, onEnd?:Function}} [opts]
 */
function createPiecePlayback(opts = {}) {
  const onStep = opts.onStep || (() => {});
  const onTime = opts.onTime || (() => {});
  const onEnd = opts.onEnd || (() => {});
  const borrowContext = typeof opts.audioContext === 'function' ? opts.audioContext : null;

  let ownCtx = null;      // context we created (and will close on dispose)
  let busCtx = null;      // context the master bus below is wired to
  let bus = null;         // master GainNode → compressor → destination

  let playing = false;
  let timeline = null;
  let startAt = 0;        // AudioContext time of t=0 on the timeline
  let nextStep = 0;
  let nodes = [];         // scheduled oscillators (stopped early on stop())
  let endTimer = null;
  let tickTimer = null;

  function getContext() {
    if (borrowContext) return borrowContext() || null;
    if (!ownCtx) {
      const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
      if (!AC) return null;
      ownCtx = new AC();
    }
    if (ownCtx.state === 'suspended') ownCtx.resume();
    return ownCtx;
  }

  /** Master gain + compressor, (re)built if the context changed. */
  function ensureBus(c) {
    if (bus && busCtx === c) return bus;
    const master = c.createGain();
    master.gain.value = PLAYBACK_MASTER_GAIN;
    let tail = master;
    if (typeof c.createDynamicsCompressor === 'function') {
      const comp = c.createDynamicsCompressor();
      master.connect(comp);
      tail = comp;
    }
    tail.connect(c.destination);
    bus = master;
    busCtx = c;
    return bus;
  }

  function midiToFreq(midi) {
    return 440 * Math.pow(2, (midi - 69) / 12);
  }

  function scheduleNote(c, out, ev, t0) {
    const start = t0 + ev.at;
    const osc = c.createOscillator();
    const gain = c.createGain();
    osc.type = 'triangle';
    osc.frequency.value = midiToFreq(ev.midi);
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(PLAYBACK_NOTE_GAIN, start + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + ev.dur);
    osc.connect(gain).connect(out);
    osc.start(start);
    osc.stop(start + ev.dur + 0.05);
    nodes.push(osc);
  }

  function scheduleFrame() {
    tickTimer = setTimeout(tick, PLAYBACK_TICK_MS);
  }

  function cancelFrame() {
    if (tickTimer === null) return;
    clearTimeout(tickTimer);
    tickTimer = null;
  }

  function tick() {
    tickTimer = null;
    if (!playing || !timeline) return;
    const c = getContext();
    const elapsed = c ? c.currentTime - startAt : 0;
    const steps = timeline.steps;
    while (nextStep < steps.length && steps[nextStep].at <= elapsed) {
      onStep(steps[nextStep]);
      nextStep++;
    }
    onTime(Math.max(0, Math.min(elapsed, timeline.total)), timeline.total);
    if (playing) scheduleFrame();
  }

  function finish(completed) {
    if (!playing) return;
    playing = false;
    cancelFrame();
    if (endTimer) { clearTimeout(endTimer); endTimer = null; }
    if (!completed) {
      nodes.forEach((o) => { try { o.stop(); } catch (_) { /* already stopped */ } });
    }
    nodes = [];
    const tl = timeline;
    timeline = null;
    nextStep = 0;
    if (completed && tl) onTime(tl.total, tl.total);
    onEnd({ completed: !!completed });
  }

  /**
   * Schedule + start playing `notes`. Any playback already running is stopped
   * first (its onEnd fires with completed:false).
   * @returns {boolean} true if playback started
   */
  function play(notes, playOpts = {}) {
    finish(false);
    const c = getContext();
    if (!c) return false;
    const tl = buildPlaybackTimeline(notes, playOpts);
    if (!tl.events.length) return false;
    const out = ensureBus(c);
    const t0 = c.currentTime + PLAYBACK_LEAD_SEC;
    for (const ev of tl.events) scheduleNote(c, out, ev, t0);
    timeline = tl;
    startAt = t0;
    nextStep = 0;
    playing = true;
    endTimer = setTimeout(
      () => finish(true),
      (PLAYBACK_LEAD_SEC + tl.total + PLAYBACK_END_TAIL_SEC) * 1000,
    );
    onTime(0, tl.total);
    scheduleFrame();
    return true;
  }

  function stop() {
    finish(false);
  }

  function isPlaying() {
    return playing;
  }

  /** {elapsed, total} in seconds (both 0 when idle). */
  function getPosition() {
    if (!playing || !timeline) return { elapsed: 0, total: 0 };
    const c = getContext();
    const elapsed = c ? c.currentTime - startAt : 0;
    return {
      elapsed: Math.max(0, Math.min(elapsed, timeline.total)),
      total: timeline.total,
    };
  }

  function dispose() {
    finish(false);
    bus = null;
    busCtx = null;
    if (ownCtx) {
      try { ownCtx.close(); } catch (_) { /* ignore */ }
      ownCtx = null;
    }
  }

  return { play, stop, isPlaying, getPosition, dispose };
}

// ---- Node export shim (browser-safe) ------------------------------------
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    createPiecePlayback,
    buildPlaybackTimeline,
    PLAYBACK_LEAD_SEC,
    PLAYBACK_MIN_NOTE_SEC,
  };
}
