// PianoSRS — Synthesia-style player + wait-mode note-detection engine.
//
// `createPlayer(host, opts)` builds its own UI inside `host`:
//   - a falling-note <canvas> (notes scroll down toward a hit line),
//   - a clickable on-screen piano keyboard,
//   - a controls bar (MIDI status, hand toggle, Listen, Restart, computer-keys
//     toggle).
//
// It detects played notes from THREE input sources, all funnelled through one
// `pressPitch`/`releasePitch` path:
//   1. Web MIDI (a connected keyboard) — the primary input,
//   2. clicking/tapping the on-screen keys,
//   3. the computer keyboard (opt-in toggle to avoid clashing with the app's
//      single-letter shortcuts).
//
// Grading is WAIT MODE + STRICT CLEAN RUN (the two product decisions):
//   - the score waits for you; you advance by pressing the correct next
//     note(s) — rhythm is not graded,
//   - one wrong note restarts the current attempt; only a start-to-finish run
//     with zero wrong notes counts as a rep (fires `onRepComplete`).
//
// Depends on midi.js globals: `notesInSection`, `groupNotesIntoSteps`.

// ---- Visual + timing constants ------------------------------------------
const NOTE_AREA_HEIGHT = 240;      // canvas height (CSS px)
const KEY_AREA_HEIGHT = 96;        // on-screen keyboard height (CSS px)
const LOOKAHEAD_BEATS = 4;         // how many beats are visible above the hit line
const PLAYHEAD_EASING = 0.22;      // per-frame lerp toward the active step
const FLASH_MS = 220;              // key flash duration

// White-key pitch classes (C D E F G A B).
const WHITE_PC = { 0: 1, 2: 1, 4: 1, 5: 1, 7: 1, 9: 1, 11: 1 };
const isWhite = (midi) => !!WHITE_PC[((midi % 12) + 12) % 12];

// Computer-keyboard → semitone-offset map (one+ octave, piano-roll style).
const COMPUTER_KEYS = {
  a: 0, w: 1, s: 2, e: 3, d: 4, f: 5, t: 6, g: 7, y: 8, h: 9, u: 10, j: 11,
  k: 12, o: 13, l: 14, p: 15, ';': 16, "'": 17,
};

/**
 * @param {HTMLElement} host
 * @param {{onRepComplete?:Function, onMistake?:Function, onProgress?:Function}} opts
 */
function createPlayer(host, opts = {}) {
  const onRepComplete = opts.onRepComplete || (() => {});
  const onMistake = opts.onMistake || (() => {});
  const onProgress = opts.onProgress || (() => {});

  // ---- Build DOM ----
  host.innerHTML = '';
  host.classList.add('player');

  const controls = document.createElement('div');
  controls.className = 'player-controls';

  const midiStatus = document.createElement('span');
  midiStatus.className = 'player-midi-status';
  midiStatus.textContent = 'MIDI: connecting…';

  const handGroup = document.createElement('div');
  handGroup.className = 'player-hand-toggle';
  handGroup.setAttribute('role', 'group');
  handGroup.setAttribute('aria-label', 'Which hand to practise');
  const handButtons = {};
  for (const [val, label] of [['both', 'Both'], ['rh', 'Right'], ['lh', 'Left']]) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'player-hand-btn';
    b.dataset.hand = val;
    b.textContent = label;
    b.addEventListener('click', () => setHand(val));
    handGroup.appendChild(b);
    handButtons[val] = b;
  }

  const listenBtn = document.createElement('button');
  listenBtn.type = 'button';
  listenBtn.className = 'btn btn-sm player-listen-btn';
  listenBtn.textContent = '▶ Listen';
  listenBtn.addEventListener('click', () => (synthPlaying ? stopListen() : listen()));

  const restartBtn = document.createElement('button');
  restartBtn.type = 'button';
  restartBtn.className = 'btn btn-sm player-restart-btn';
  restartBtn.textContent = '↻ Restart run';
  restartBtn.addEventListener('click', () => restartRun(true));

  const keysToggle = document.createElement('button');
  keysToggle.type = 'button';
  keysToggle.className = 'btn btn-sm player-keys-toggle';
  keysToggle.setAttribute('aria-pressed', 'false');
  keysToggle.textContent = '⌨ Computer keys: off';
  keysToggle.addEventListener('click', () => setComputerKeys(!computerKeysOn));

  controls.append(midiStatus, handGroup, listenBtn, restartBtn, keysToggle);

  const feedback = document.createElement('p');
  feedback.className = 'player-feedback';
  feedback.setAttribute('aria-live', 'polite');

  const canvas = document.createElement('canvas');
  canvas.className = 'player-canvas';

  const keyboard = document.createElement('div');
  keyboard.className = 'player-keyboard';

  host.append(controls, feedback, canvas, keyboard);

  // ---- State ----
  const ctx2d = canvas.getContext('2d');
  let dpr = 1;
  let cssWidth = 0;

  let ticksPerQuarter = 480;
  let section = null;
  let allSectionNotes = [];   // notes in the section (all hands)
  let hand = 'both';
  let hasHands = false;
  let rhTracks = new Set();
  let lhTracks = new Set();

  let activeNotes = [];       // notes after hand filter (for drawing)
  let steps = [];             // [{ tick, pitches:[...], need:Set, got:Set }]
  let stepIndex = 0;
  let runStarted = false;
  let cleanRunCount = 0;      // reps completed this session (display only)

  let keyRange = { lo: 60, hi: 72 };
  let whiteMidis = [];
  let whiteWidth = 0;
  const keyEls = new Map();   // midi → key element

  const heldPitches = new Set();
  const flashTimers = new Map();

  let playheadTick = 0;
  let rafId = null;
  let running = false;

  // Web MIDI
  let midiAccess = null;
  const midiInputs = new Set();

  // Computer keyboard
  let computerKeysOn = false;
  let computerBase = 60;
  const computerHeld = new Set();

  // Synth (Listen)
  let audioCtx = null;
  let synthPlaying = false;
  let synthTimers = [];
  let synthNodes = [];

  // ---- Hand filtering ----
  function computeHands(notes) {
    const tracks = [...new Set(notes.map((n) => n.track))];
    if (tracks.length < 2) {
      hasHands = false;
      rhTracks = new Set(tracks);
      lhTracks = new Set(tracks);
      return;
    }
    const meanByTrack = tracks.map((t) => {
      const ns = notes.filter((n) => n.track === t);
      const mean = ns.reduce((s, n) => s + n.midi, 0) / ns.length;
      return { t, mean };
    });
    meanByTrack.sort((a, b) => b.mean - a.mean);
    const half = Math.ceil(meanByTrack.length / 2);
    rhTracks = new Set(meanByTrack.slice(0, half).map((x) => x.t));
    lhTracks = new Set(meanByTrack.slice(half).map((x) => x.t));
    hasHands = true;
  }

  function notesForHand() {
    if (hand === 'rh') return allSectionNotes.filter((n) => rhTracks.has(n.track));
    if (hand === 'lh') return allSectionNotes.filter((n) => lhTracks.has(n.track));
    return allSectionNotes;
  }

  // ---- Load a section ----
  function load(piece, sec) {
    section = sec;
    ticksPerQuarter = piece.ticksPerQuarter || 480;
    allSectionNotes = notesInSection(piece.notes || [], sec);
    computeHands(allSectionNotes);
    syncHandButtons();
    rebuild();
  }

  function setHand(h) {
    if (h === hand) return;
    if ((h === 'rh' || h === 'lh') && !hasHands) return;
    hand = h;
    syncHandButtons();
    rebuild();
  }

  function syncHandButtons() {
    for (const [val, btn] of Object.entries(handButtons)) {
      btn.classList.toggle('is-active', val === hand);
      const disabled = (val === 'rh' || val === 'lh') && !hasHands;
      btn.disabled = disabled;
      btn.classList.toggle('is-disabled', disabled);
    }
    handGroup.hidden = !hasHands && false; // always show; RH/LH disabled if mono
  }

  // Rebuild steps + keyboard from the current hand filter.
  function rebuild() {
    activeNotes = notesForHand();
    steps = groupNotesIntoSteps(activeNotes, { ticksPerQuarter }).map((s) => ({
      tick: s.tick,
      pitches: s.pitches,
      need: new Set(s.pitches),
      got: new Set(),
    }));
    computeKeyRange();
    buildKeyboard();
    restartRun(false);
    resize();
  }

  function computeKeyRange() {
    const pitches = activeNotes.map((n) => n.midi);
    let lo = pitches.length ? Math.min(...pitches) : 60;
    let hi = pitches.length ? Math.max(...pitches) : 72;
    // Expand to whole octaves (start on a C, end on a B) with a little pad.
    lo = Math.max(21, lo - 2);
    hi = Math.min(108, hi + 2);
    while (((lo % 12) + 12) % 12 !== 0 && lo > 21) lo--;
    while (((hi % 12) + 12) % 12 !== 11 && hi < 108) hi++;
    keyRange = { lo, hi };
    whiteMidis = [];
    for (let m = lo; m <= hi; m++) if (isWhite(m)) whiteMidis.push(m);
  }

  // ---- On-screen keyboard ----
  function buildKeyboard() {
    keyboard.innerHTML = '';
    keyEls.clear();
    const whiteLayer = document.createElement('div');
    whiteLayer.className = 'player-keys-white';
    const blackLayer = document.createElement('div');
    blackLayer.className = 'player-keys-black';

    whiteMidis.forEach((midi) => {
      const key = document.createElement('button');
      key.type = 'button';
      key.className = 'player-key player-key-white';
      key.dataset.midi = String(midi);
      if (midi % 12 === 0) {
        const lbl = document.createElement('span');
        lbl_set(lbl, midi);
        key.appendChild(lbl);
      }
      attachKeyPointer(key, midi);
      whiteLayer.appendChild(key);
      keyEls.set(midi, key);
    });

    // Black keys positioned over the boundary to the right of their left white.
    for (let m = keyRange.lo; m <= keyRange.hi; m++) {
      if (isWhite(m)) continue;
      const leftWhiteIdx = whiteMidis.indexOf(m - 1);
      if (leftWhiteIdx < 0) continue;
      const key = document.createElement('button');
      key.type = 'button';
      key.className = 'player-key player-key-black';
      key.dataset.midi = String(m);
      key.style.left = `calc(${((leftWhiteIdx + 1) / whiteMidis.length) * 100}% - var(--black-half))`;
      attachKeyPointer(key, m);
      blackLayer.appendChild(key);
      keyEls.set(m, key);
    }

    keyboard.append(whiteLayer, blackLayer);
  }

  function lbl_set(span, midi) {
    span.className = 'player-key-label';
    span.textContent = `C${Math.floor(midi / 12) - 1}`;
  }

  function attachKeyPointer(key, midi) {
    key.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      pressPitch(midi);
      try { key.setPointerCapture(e.pointerId); } catch (_) {}
    });
    const up = () => releasePitch(midi);
    key.addEventListener('pointerup', up);
    key.addEventListener('pointercancel', up);
    key.addEventListener('pointerleave', (e) => {
      if (e.buttons) up();
    });
  }

  function refreshKeyClasses() {
    const cur = steps[stepIndex];
    for (const [midi, el] of keyEls) {
      el.classList.toggle('is-held', heldPitches.has(midi));
      const expected = !!cur && cur.need.has(midi) && !cur.got.has(midi);
      el.classList.toggle('is-expected', expected);
    }
  }

  function flashKey(midi, cls) {
    const el = keyEls.get(midi);
    if (!el) return;
    el.classList.add(cls);
    const prev = flashTimers.get(`${midi}:${cls}`);
    if (prev) clearTimeout(prev);
    flashTimers.set(
      `${midi}:${cls}`,
      setTimeout(() => el.classList.remove(cls), FLASH_MS),
    );
  }

  // ---- The wait-mode state machine ----
  function pressPitch(midi) {
    if (audioCtx) ping(midi); // audible feedback for on-screen/computer input
    heldPitches.add(midi);
    if (!steps.length) { refreshKeyClasses(); return; }

    const cur = steps[stepIndex];
    if (cur.need.has(midi)) {
      runStarted = true;
      cur.got.add(midi);
      flashKey(midi, 'is-correct');
      if (cur.got.size >= cur.need.size) advanceStep();
    } else {
      // Wrong note → strict reset of the whole attempt.
      flashKey(midi, 'is-wrong');
      handleMistake(midi);
    }
    refreshKeyClasses();
  }

  function releasePitch(midi) {
    heldPitches.delete(midi);
    refreshKeyClasses();
  }

  function advanceStep() {
    stepIndex++;
    if (stepIndex >= steps.length) {
      // Clean run complete.
      cleanRunCount++;
      feedback.textContent = '✓ Clean run!';
      feedback.classList.remove('is-error');
      feedback.classList.add('is-success');
      onRepComplete();
      // Reset for the next rep. We deliberately do NOT auto-satisfy held keys:
      // each step is advanced only by a fresh key press, which keeps repeated
      // notes (e.g. "C C") honest and matches how wait-mode trainers behave.
      // Sustained notes from earlier steps are harmless — only a NEW press is
      // ever judged, so a held note can neither complete nor fail a later step.
      restartRun(false);
    } else {
      onProgress({ stepIndex, total: steps.length });
    }
  }

  function handleMistake(midi) {
    const wasAt = stepIndex;
    restartRun(false);
    feedback.textContent = '✗ Wrong note — run reset. Start from the top.';
    feedback.classList.add('is-error');
    feedback.classList.remove('is-success');
    onMistake({ midi, atStep: wasAt });
  }

  function restartRun(announce) {
    stepIndex = 0;
    runStarted = false;
    for (const s of steps) s.got = new Set();
    if (announce) {
      feedback.textContent = 'Run reset — play the highlighted notes.';
      feedback.classList.remove('is-error', 'is-success');
    } else if (!feedback.textContent) {
      feedback.textContent = steps.length
        ? 'Play the highlighted notes.'
        : 'No notes in this section.';
    }
    refreshKeyClasses();
  }

  function getCleanRunCount() {
    return cleanRunCount;
  }
  function resetCleanRunCount() {
    cleanRunCount = 0;
  }

  // ---- Web MIDI input ----
  async function connectMidi() {
    if (!navigator.requestMIDIAccess) {
      midiStatus.textContent = 'MIDI: not supported (use on-screen / computer keys)';
      midiStatus.classList.add('is-warn');
      return;
    }
    try {
      midiAccess = await navigator.requestMIDIAccess({ sysex: false });
      bindMidiInputs();
      midiAccess.onstatechange = bindMidiInputs;
    } catch (err) {
      midiStatus.textContent = 'MIDI: permission denied (use on-screen / computer keys)';
      midiStatus.classList.add('is-warn');
    }
  }

  function bindMidiInputs() {
    if (!midiAccess) return;
    midiInputs.clear();
    const names = [];
    midiAccess.inputs.forEach((input) => {
      midiInputs.add(input);
      input.onmidimessage = onMidiMessage;
      names.push(input.name || 'device');
    });
    if (names.length) {
      midiStatus.textContent = `MIDI: ${names.join(', ')}`;
      midiStatus.classList.remove('is-warn');
      midiStatus.classList.add('is-ok');
    } else {
      midiStatus.textContent = 'MIDI: no device — plug one in, or use the keys below';
      midiStatus.classList.remove('is-ok');
      midiStatus.classList.add('is-warn');
    }
  }

  function onMidiMessage(e) {
    const [status, note, velocity] = e.data;
    const cmd = status & 0xf0;
    if (cmd === 0x90 && velocity > 0) pressPitch(note);
    else if (cmd === 0x80 || (cmd === 0x90 && velocity === 0)) releasePitch(note);
  }

  // ---- Computer-keyboard input (opt-in) ----
  function setComputerKeys(on) {
    computerKeysOn = on;
    keysToggle.setAttribute('aria-pressed', String(on));
    keysToggle.textContent = `⌨ Computer keys: ${on ? 'on' : 'off'}`;
    keysToggle.classList.toggle('is-active', on);
    if (on) {
      // Base the mapping on the lowest C at or below the section's low note.
      computerBase = keyRange.lo - (((keyRange.lo % 12) + 12) % 12);
      feedback.textContent = 'Computer keys on: A…\' play notes, Z/X shift octave.';
    }
  }

  function onComputerKeyDown(e) {
    if (!computerKeysOn || e.repeat || e.metaKey || e.ctrlKey || e.altKey) return;
    const k = e.key.toLowerCase();
    if (k === 'z' || k === 'x') {
      computerBase += (k === 'x' ? 12 : -12);
      computerBase = Math.max(21, Math.min(96, computerBase));
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    if (!(k in COMPUTER_KEYS)) return;
    e.preventDefault();
    e.stopPropagation(); // don't let it reach the app's letter shortcuts
    const midi = computerBase + COMPUTER_KEYS[k];
    if (computerHeld.has(k)) return;
    computerHeld.add(k);
    pressPitch(midi);
  }

  function onComputerKeyUp(e) {
    if (!computerKeysOn) return;
    const k = e.key.toLowerCase();
    if (!(k in COMPUTER_KEYS)) return;
    computerHeld.delete(k);
    e.stopPropagation();
    releasePitch(computerBase + COMPUTER_KEYS[k]);
  }

  // ---- Synth (Listen) ----
  function ensureAudio() {
    if (!audioCtx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (AC) audioCtx = new AC();
    }
    if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
    return audioCtx;
  }

  function midiToFreq(midi) {
    return 440 * Math.pow(2, (midi - 69) / 12);
  }

  // A short pluck for live input feedback.
  function ping(midi) {
    const c = ensureAudio();
    if (!c) return;
    const t = c.currentTime;
    const osc = c.createOscillator();
    const gain = c.createGain();
    osc.type = 'triangle';
    osc.frequency.value = midiToFreq(midi);
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.18, t + 0.005);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.4);
    osc.connect(gain).connect(c.destination);
    osc.start(t);
    osc.stop(t + 0.45);
  }

  function listen() {
    const c = ensureAudio();
    if (!c || !activeNotes.length) return;
    stopListen();
    synthPlaying = true;
    listenBtn.textContent = '■ Stop';
    const base = section.startSec;
    const lead = 0.2;
    let lastEnd = 0;
    for (const n of activeNotes) {
      const start = c.currentTime + lead + (n.startSec - base);
      const dur = Math.max(0.12, n.endSec - n.startSec);
      lastEnd = Math.max(lastEnd, start + dur);
      const osc = c.createOscillator();
      const gain = c.createGain();
      osc.type = 'triangle';
      osc.frequency.value = midiToFreq(n.midi);
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(0.22, start + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + dur);
      osc.connect(gain).connect(c.destination);
      osc.start(start);
      osc.stop(start + dur + 0.05);
      synthNodes.push(osc);
    }
    const stopAt = (lastEnd - c.currentTime) * 1000 + 100;
    synthTimers.push(setTimeout(stopListen, stopAt));
  }

  function stopListen() {
    synthPlaying = false;
    listenBtn.textContent = '▶ Listen';
    synthTimers.forEach(clearTimeout);
    synthTimers = [];
    synthNodes.forEach((o) => { try { o.stop(); } catch (_) {} });
    synthNodes = [];
  }

  // ---- Rendering ----
  function resize() {
    cssWidth = host.clientWidth || canvas.clientWidth || 600;
    dpr = window.devicePixelRatio || 1;
    canvas.style.height = `${NOTE_AREA_HEIGHT}px`;
    canvas.width = Math.floor(cssWidth * dpr);
    canvas.height = Math.floor(NOTE_AREA_HEIGHT * dpr);
    whiteWidth = whiteMidis.length ? cssWidth / whiteMidis.length : cssWidth;
    keyboard.style.height = `${KEY_AREA_HEIGHT}px`;
    keyboard.style.setProperty('--black-half', `${whiteWidth * 0.32}px`);
    draw();
  }

  // Pixel x-center for a pitch, aligned with the on-screen keyboard.
  function keyCenterX(midi) {
    if (isWhite(midi)) {
      const idx = whiteMidis.indexOf(midi);
      return (idx + 0.5) * whiteWidth;
    }
    const leftIdx = whiteMidis.indexOf(midi - 1);
    return (leftIdx + 1) * whiteWidth;
  }

  function handColor(n, active) {
    const rh = rhTracks.has(n.track);
    if (active) return rh ? '#34d399' : '#22d3ee';
    return rh ? '#0ea5e9' : '#6366f1';
  }

  function draw() {
    if (!ctx2d) return;
    ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx2d.clearRect(0, 0, cssWidth, NOTE_AREA_HEIGHT);

    const pxPerTick = NOTE_AREA_HEIGHT / (LOOKAHEAD_BEATS * ticksPerQuarter);
    const hitY = NOTE_AREA_HEIGHT - 2;

    // Hit line.
    ctx2d.strokeStyle = 'rgba(148,163,184,0.9)';
    ctx2d.lineWidth = 2;
    ctx2d.beginPath();
    ctx2d.moveTo(0, hitY);
    ctx2d.lineTo(cssWidth, hitY);
    ctx2d.stroke();

    const curTick = steps[stepIndex] ? steps[stepIndex].tick : playheadTick;

    for (const n of activeNotes) {
      const yOnset = hitY - (n.startTick - playheadTick) * pxPerTick;
      const h = Math.max(6, (n.endTick - n.startTick) * pxPerTick);
      const yTop = yOnset - h;
      if (yTop > NOTE_AREA_HEIGHT || yOnset < 0) continue;
      const cx = keyCenterX(n.midi);
      const w = isWhite(n.midi) ? whiteWidth * 0.8 : whiteWidth * 0.5;
      const isActiveStep = Math.abs(n.startTick - curTick) < 1;
      ctx2d.fillStyle = handColor(n, isActiveStep);
      ctx2d.globalAlpha = n.startTick < curTick ? 0.35 : 1;
      roundRect(ctx2d, cx - w / 2, yTop, w, h, 4);
      ctx2d.fill();
      if (isActiveStep) {
        ctx2d.globalAlpha = 1;
        ctx2d.strokeStyle = '#f8fafc';
        ctx2d.lineWidth = 2;
        roundRect(ctx2d, cx - w / 2, yTop, w, h, 4);
        ctx2d.stroke();
      }
    }
    ctx2d.globalAlpha = 1;
  }

  function roundRect(c, x, y, w, h, r) {
    const rr = Math.min(r, w / 2, h / 2);
    c.beginPath();
    c.moveTo(x + rr, y);
    c.arcTo(x + w, y, x + w, y + h, rr);
    c.arcTo(x + w, y + h, x, y + h, rr);
    c.arcTo(x, y + h, x, y, rr);
    c.arcTo(x, y, x + w, y, rr);
    c.closePath();
  }

  function frame() {
    if (!running) return;
    const target = steps[stepIndex] ? steps[stepIndex].tick
      : (section ? section.endTick : playheadTick);
    playheadTick += (target - playheadTick) * PLAYHEAD_EASING;
    if (Math.abs(target - playheadTick) < 0.5) playheadTick = target;
    draw();
    rafId = requestAnimationFrame(frame);
  }

  // ---- Lifecycle ----
  const onResize = () => resize();

  function start() {
    running = true;
    playheadTick = steps[0] ? steps[0].tick : 0;
    connectMidi();
    window.addEventListener('keydown', onComputerKeyDown, true);
    window.addEventListener('keyup', onComputerKeyUp, true);
    window.addEventListener('resize', onResize);
    resize();
    refreshKeyClasses();
    rafId = requestAnimationFrame(frame);
  }

  function stop() {
    running = false;
    if (rafId) cancelAnimationFrame(rafId);
    rafId = null;
    stopListen();
    setComputerKeys(false);
    window.removeEventListener('keydown', onComputerKeyDown, true);
    window.removeEventListener('keyup', onComputerKeyUp, true);
    window.removeEventListener('resize', onResize);
    midiInputs.forEach((i) => { i.onmidimessage = null; });
    midiInputs.clear();
    if (midiAccess) midiAccess.onstatechange = null;
    heldPitches.clear();
    computerHeld.clear();
  }

  function dispose() {
    stop();
    if (audioCtx) { audioCtx.close().catch(() => {}); audioCtx = null; }
    for (const t of flashTimers.values()) clearTimeout(t);
    flashTimers.clear();
    host.innerHTML = '';
  }

  return {
    load,
    setHand,
    start,
    stop,
    dispose,
    restartRun,
    listen,
    pressPitch,
    releasePitch,
    getCleanRunCount,
    resetCleanRunCount,
    setComputerKeys: (on) => setComputerKeys(on),
  };
}

// ---- Node export shim (browser-safe) ------------------------------------
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { createPlayer, COMPUTER_KEYS, isWhite };
}
