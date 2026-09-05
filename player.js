// PianoSRS — Synthesia-style player + wait-mode note-detection engine.
//
// `createPlayer(host, opts)` builds its own UI inside `host`:
//   - a falling-note <canvas> (notes scroll down toward a hit line),
//   - a clickable on-screen piano keyboard,
//   - a controls bar (MIDI status, hand toggle, Listen, Restart, computer-keys
//     toggle).
//
// It detects played notes from FOUR input sources, all funnelled through one
// `pressPitch`/`releasePitch` path:
//   1. Web MIDI (a connected keyboard) — the primary input,
//   2. the microphone (micpitch.js — polyphonic pitch detection, so an
//      acoustic piano works with no cable; opt-in toggle),
//   3. clicking/tapping the on-screen keys,
//   4. the computer keyboard (opt-in toggle to avoid clashing with the app's
//      single-letter shortcuts).
//
// Grading is WAIT MODE + STRICT CLEAN RUN (the two product decisions):
//   - the score waits for you; you advance by pressing the correct next
//     note(s) — rhythm is not graded,
//   - one wrong note restarts the current attempt; only a start-to-finish run
//     with zero wrong notes counts as a rep (fires `onRepComplete`).
//
// `load(piece, section, { strict: false })` relaxes the second rule for a
// free play-through (the whole-piece "Play" from the piece page): a wrong note
// is flashed + tallied but the run carries on from where it is, and reaching
// the end reports the slip count instead of banking a rep.
//
// Depends on midi.js globals: `notesInSection`, `groupNotesIntoSteps`, and
// playback.js: `createPiecePlayback` (Listen).

// ---- Visual + timing constants ------------------------------------------
const NOTE_AREA_HEIGHT = 240;      // canvas height (CSS px)
const KEY_AREA_HEIGHT = 96;        // on-screen keyboard height (CSS px)
const LOOKAHEAD_BEATS = 4;         // how many beats are visible above the hit line
const PLAYHEAD_EASING = 0.22;      // per-frame lerp toward the active step
const FLASH_MS = 220;              // key flash duration
const LISTEN_FLASH_MS = 320;       // key light-up per sounding step during Listen

// ---- Memory mode (cue fading) -------------------------------------------
const GLANCE_BEATS = 0.75;         // stage 2: notes only appear this close to the line
const ASSIST_THRESHOLD = 3;        // consecutive run-resets before easing one stage
const REVEAL_MS = 700;             // how long the corrective "you missed this" flash lasts
const HINT_DELAY_MS = 3000;        // stall this long at a hidden step → ghost the next note
const HINT_SHOW_MS = 1600;         // how long the hint ghost stays on the canvas

// White-key pitch classes (C D E F G A B).
const WHITE_PC = { 0: 1, 2: 1, 4: 1, 5: 1, 7: 1, 9: 1, 11: 1 };
const isWhite = (midi) => !!WHITE_PC[((midi % 12) + 12) % 12];

// Pitch-class → name for each notation system (settings menu). German swaps
// the top two: A♯/B♭ is "B" and B-natural is "H". Solfège is fixed-Do.
const NOTE_NAME_SETS = {
  letters: ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'],
  german:  ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'B', 'H'],
  solfege: ['Do', 'Do♯', 'Re', 'Re♯', 'Mi', 'Fa', 'Fa♯', 'Sol', 'Sol♯', 'La', 'La♯', 'Si'],
};

/** Human note name for a MIDI pitch (C4 = 60), honoring the chosen notation. */
function noteLabel(midi, notation, withOctave) {
  const set = NOTE_NAME_SETS[notation] || NOTE_NAME_SETS.letters;
  const name = set[((midi % 12) + 12) % 12];
  return withOctave ? `${name}${Math.floor(midi / 12) - 1}` : name;
}

// Computer-keyboard → semitone-offset map (one+ octave, piano-roll style).
const COMPUTER_KEYS = {
  a: 0, w: 1, s: 2, e: 3, d: 4, f: 5, t: 6, g: 7, y: 8, h: 9, u: 10, j: 11,
  k: 12, o: 13, l: 14, p: 15, ';': 16, "'": 17,
};

// ---- Shared Web MIDI access ----------------------------------------------
// One requestMIDIAccess() per page load, shared by every player start().
// Requesting per-section re-prompted for permission on origins that don't
// persist the grant (file://, "Allow this time") and stacked up multiple
// MIDIAccess objects whose inputs each delivered the same key press — the
// strict grader saw the duplicate as a wrong note. A rejection (denied or
// dismissed prompt) clears the cache so the next section can ask again.
let sharedMidiAccessPromise = null;
function getSharedMidiAccess() {
  if (!sharedMidiAccessPromise) {
    sharedMidiAccessPromise = navigator.requestMIDIAccess({ sysex: false });
    sharedMidiAccessPromise.catch(() => { sharedMidiAccessPromise = null; });
  }
  return sharedMidiAccessPromise;
}

/**
 * @param {HTMLElement} host
 * @param {{onRepComplete?:Function, onMistake?:Function, onProgress?:Function}} opts
 */
function createPlayer(host, opts = {}) {
  const onRepComplete = opts.onRepComplete || (() => {});
  const onMistake = opts.onMistake || (() => {});
  const onProgress = opts.onProgress || (() => {});
  const onStageChange = opts.onStageChange || (() => {});

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
    b.title = val === 'both'
      ? 'Both hands together — clean runs here bank toward your daily reps'
      : 'Warm-up hand — practise freely; only Both-hands runs bank reps';
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

  // Microphone input: hear the notes from an acoustic (or any) piano instead
  // of requiring a MIDI cable. Opt-in per session — it asks for mic permission.
  const micToggle = document.createElement('button');
  micToggle.type = 'button';
  micToggle.className = 'btn btn-sm player-mic-toggle';
  micToggle.setAttribute('aria-pressed', 'false');
  micToggle.textContent = '🎤 Mic: off';
  micToggle.title = 'Detect notes through your microphone — no MIDI cable needed';
  micToggle.addEventListener('click', () => setMic(!micWanted));

  // Suggested fingerings (computed at import by fingering.js) drawn as
  // digits on the falling notes. On by default; toggleable since they're
  // heuristic and the user may prefer their own.
  let showFingers = true;
  const fingersToggle = document.createElement('button');
  fingersToggle.type = 'button';
  fingersToggle.className = 'btn btn-sm player-fingers-toggle is-active';
  fingersToggle.setAttribute('aria-pressed', 'true');
  fingersToggle.textContent = '🖐 Fingers';
  fingersToggle.title = 'Show suggested fingering (1=thumb … 5=pinky)';
  fingersToggle.addEventListener('click', () => {
    showFingers = !showFingers;
    fingersToggle.classList.toggle('is-active', showFingers);
    fingersToggle.setAttribute('aria-pressed', String(showFingers));
    draw();
  });

  // Guide keys: light up the next note(s) on the on-screen keyboard at any
  // memory stage. Beyond stage 0 that's real help, so guided runs count as
  // half reps (same rule as hesitation hints).
  let guideKeys = false;
  const guideToggle = document.createElement('button');
  guideToggle.type = 'button';
  guideToggle.className = 'btn btn-sm player-guide-toggle';
  guideToggle.setAttribute('aria-pressed', 'false');
  guideToggle.textContent = '💡 Guide keys';
  guideToggle.title = 'Light up the next notes on the keyboard';
  guideToggle.addEventListener('click', () => setGuideKeys(!guideKeys));

  // Hold-to-reveal: temporarily forces full visuals while held.
  const peekBtn = document.createElement('button');
  peekBtn.type = 'button';
  peekBtn.className = 'btn btn-sm player-peek-btn';
  peekBtn.textContent = '👁 Peek';
  peekBtn.title = 'Hold to reveal the notes';
  const peekOn = (e) => { if (e) e.preventDefault(); setPeek(true); };
  const peekOff = () => setPeek(false);
  peekBtn.addEventListener('pointerdown', peekOn);
  peekBtn.addEventListener('pointerup', peekOff);
  peekBtn.addEventListener('pointerleave', peekOff);
  peekBtn.addEventListener('pointercancel', peekOff);

  // Memory-level chip (Watch → Find → Glance → From memory).
  const memoryChip = document.createElement('span');
  memoryChip.className = 'player-memory';
  memoryChip.setAttribute('aria-live', 'polite');

  controls.append(midiStatus, memoryChip, handGroup, listenBtn, restartBtn, peekBtn, guideToggle, fingersToggle, keysToggle, micToggle);

  const feedback = document.createElement('p');
  feedback.className = 'player-feedback';
  feedback.setAttribute('aria-live', 'polite');

  // Per-run progress: how far through the section the current attempt is.
  // Resets with the run (mistake or completion), unlike the reps counter.
  const runProgress = document.createElement('div');
  runProgress.className = 'player-run-progress';
  runProgress.hidden = true; // shown once a section with notes is loaded
  const runProgressLabel = document.createElement('span');
  runProgressLabel.className = 'player-run-progress-label';
  const runProgressTrack = document.createElement('div');
  runProgressTrack.className = 'player-run-progress-track';
  runProgressTrack.setAttribute('role', 'progressbar');
  runProgressTrack.setAttribute('aria-label', 'Progress through this run');
  runProgressTrack.setAttribute('aria-valuemin', '0');
  const runProgressFill = document.createElement('div');
  runProgressFill.className = 'player-run-progress-fill';
  runProgressTrack.appendChild(runProgressFill);
  runProgress.append(runProgressLabel, runProgressTrack);

  const canvas = document.createElement('canvas');
  canvas.className = 'player-canvas';

  const keyboard = document.createElement('div');
  keyboard.className = 'player-keyboard';

  host.append(controls, feedback, runProgress, canvas, keyboard);

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
  // Strict (default): a wrong note resets the run. Lenient (play-through): it
  // is flashed + counted and the run carries on.
  let strictRuns = true;
  let slipsThisRun = 0;       // wrong notes so far in a lenient run

  // Display prefs from the settings menu (app pushes these via applySettings).
  // Defaults mirror settings.js so the player is sane if never configured.
  let ui = {
    keyNoteNames: 'c',
    notation: 'letters',
    octaveNumbers: false,
    fallingNoteNames: false,
    highlightC: false,
    reduceMotion: false,
    noteSound: true,
  };

  // ---- Memory mode (cue fading) ----
  let baseStage = 0;          // maturity baseline (set by app from SRS state)
  let runIndex = 0;           // today's completed clean runs (set by app)
  let assist = 0;             // session help notches from the auto-assist
  let consecutiveResets = 0;  // run-resets in a row without a clean run
  let peeking = false;        // hold-to-reveal active
  let lastStage = -1;         // last notified effective stage

  let keyRange = { lo: 60, hi: 72 };
  let whiteMidis = [];
  let whiteWidth = 0;
  const keyEls = new Map();   // midi → key element

  const heldPitches = new Set();
  const flashTimers = new Map();

  let playheadTick = 0;
  let rafId = null;
  let running = false;

  // Cloze stages (Recall 40% / 75%): the randomly-hidden subset of notes,
  // re-rolled every run so the user memorises the music, not the gaps.
  let clozeHidden = new Set();   // note object refs hidden this run
  let anchorNotes = new Set();   // first-step notes — always visible
  // Hint on hesitation: stall at a hidden step → ghost the next note.
  let lastProgressAt = 0;        // performance.now() of the last run progress
  let hintsThisRun = 0;
  let hintShownAt = 0;           // performance.now() when the ghost appeared
  let guidedThisRun = false;     // key guides used beyond stage 0 this run

  // Web MIDI
  let midiAccess = null;
  let midiConnectToken = 0; // invalidates stale connectMidi resolutions
  const midiInputs = new Set();

  // Computer keyboard
  let computerKeysOn = false;
  let computerBase = 60;
  const computerHeld = new Set();

  // Microphone (micpitch.js)
  let micWanted = false;  // user's toggle intent — survives stop()/start()
  let micInput = null;    // createMicPitch controller (lazy)
  let micStartToken = 0;  // invalidates stale async start() resolutions

  // Synth (Listen) — playback.js engine sharing this player's AudioContext.
  // While it plays, `listenTick` is the onset the playhead / sheet cursor
  // follow (null when not listening).
  let audioCtx = null;
  let synthPlaying = false;
  let preview = null;
  let listenTick = null;

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
  function load(piece, sec, loadOpts = {}) {
    stopListen(); // never carry a previous section's playback across a load
    section = sec;
    ticksPerQuarter = piece.ticksPerQuarter || 480;
    allSectionNotes = notesInSection(piece.notes || [], sec);
    // Reset memory-mode session state; baseStage comes from the section's
    // SRS maturity (app passes it in).
    baseStage = typeof loadOpts.baseStage === 'number' ? loadOpts.baseStage : 0;
    runIndex = typeof loadOpts.runIndex === 'number' ? loadOpts.runIndex : 0;
    strictRuns = loadOpts.strict !== false;
    assist = 0;
    consecutiveResets = 0;
    peeking = false;
    feedback.textContent = ''; // let restartRun() write the opening prompt
    computeHands(allSectionNotes);
    syncHandButtons();
    rebuild();
    notifyStage();
  }

  // ---- Memory mode: effective fade stage ----
  // currentStage() reuses the pure srs.js helper effectiveMemoryStage(); a
  // peek forces full visuals (stage 0).
  function currentStage() {
    if (peeking) return 0;
    return effectiveMemoryStage(baseStage, runIndex, assist);
  }

  function notifyStage() {
    const stage = currentStage();
    const info = describeMemoryStage(stage);
    // ●●○○ dots + label.
    const dots = Array.from({ length: info.total + 1 }, (_, i) =>
      i <= stage ? '●' : '○',
    ).join('');
    memoryChip.textContent = `${dots} ${peeking ? 'Peek' : info.label}`;
    memoryChip.title = info.hint;
    memoryChip.dataset.stage = String(stage);
    if (stage !== lastStage) {
      lastStage = stage;
      onStageChange(info);
    }
    refreshKeyClasses();
  }

  function setMemoryBase(n) {
    baseStage = typeof n === 'number' ? n : 0;
    notifyStage();
    rollCloze(); // stage may have changed → hidden fraction changes
  }

  function setRunIndex(n) {
    runIndex = typeof n === 'number' && n > 0 ? n : 0;
    notifyStage();
    rollCloze(); // stage may have changed → hidden fraction changes
  }

  function setPeek(on) {
    if (peeking === !!on) return;
    peeking = !!on;
    peekBtn.classList.toggle('is-active', peeking);
    notifyStage();
    draw();
  }

  function getStage() {
    return currentStage();
  }

  /**
   * Push a settings-menu snapshot into the player and re-render everything it
   * can touch: keyboard labels / hover titles / C-highlight, the fingering
   * layer, and the falling-note names. Safe to call whenever a section is
   * loaded — the app calls it on mount and on every settings change.
   */
  function applySettings(s) {
    s = s || {};
    ui = {
      keyNoteNames: s.keyNoteNames || 'c',
      notation: s.notation || 'letters',
      octaveNumbers: !!s.octaveNumbers,
      fallingNoteNames: !!s.fallingNoteNames,
      highlightC: !!s.highlightC,
      reduceMotion: !!s.reduceMotion,
      noteSound: s.noteSound !== false,
    };
    // Fingerings keep their live toggle button — mirror the saved setting onto
    // it so the two never disagree on mount.
    if (typeof s.showFingerings === 'boolean') {
      showFingers = s.showFingerings;
      fingersToggle.classList.toggle('is-active', showFingers);
      fingersToggle.setAttribute('aria-pressed', String(showFingers));
    }
    if (section) {
      buildKeyboard();     // re-render key labels / titles / C-highlight
      refreshKeyClasses(); // restore is-expected / is-held after the rebuild
    }
    draw();
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
    // First-step notes are the entry anchor: cold starts are the hardest
    // recall, so these stay visible at every fade stage.
    const eps = ticksPerQuarter * 0.1;
    anchorNotes = new Set(
      steps.length
        ? activeNotes.filter((n) => Math.abs(n.startTick - steps[0].tick) <= eps)
        : [],
    );
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
      // Hover any key for its full note name (always on, independent of labels).
      key.title = noteLabel(midi, ui.notation, true);
      if (ui.highlightC && midi % 12 === 0) key.classList.add('is-c');
      const wantLabel =
        ui.keyNoteNames === 'all' ||
        (ui.keyNoteNames === 'c' && midi % 12 === 0);
      if (wantLabel) {
        const lbl = document.createElement('span');
        lbl.className = 'player-key-label';
        // C-only labels always carry the octave (that landmark is the point);
        // "all keys" labels follow the octave-number toggle.
        const withOct = ui.octaveNumbers || ui.keyNoteNames === 'c';
        lbl.textContent = noteLabel(midi, ui.notation, withOct);
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
      key.title = noteLabel(m, ui.notation, true); // hover shows the note name
      key.style.left = `calc(${((leftWhiteIdx + 1) / whiteMidis.length) * 100}% - var(--black-half))`;
      attachKeyPointer(key, m);
      blackLayer.appendChild(key);
      keyEls.set(m, key);
    }

    keyboard.append(whiteLayer, blackLayer);
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

  function setGuideKeys(on) {
    guideKeys = !!on;
    guideToggle.classList.toggle('is-active', guideKeys);
    guideToggle.setAttribute('aria-pressed', String(guideKeys));
    if (guideKeys && currentStage() > 0) {
      feedback.textContent =
        '💡 Key guides on — at memory stages, guided runs count as half reps.';
      feedback.classList.remove('is-error', 'is-success');
    }
    refreshKeyClasses();
  }

  function refreshKeyClasses() {
    const cur = steps[stepIndex];
    // Key guides only at stage 0 (Watch), unless the user opts in via the
    // Guide-keys toggle. Higher stages otherwise hide them so you must find
    // the keys / play from memory; correct/wrong flashes still fire.
    const showGuides = guideKeys || currentStage() === 0;
    for (const [midi, el] of keyEls) {
      el.classList.toggle('is-held', heldPitches.has(midi));
      const expected =
        showGuides && !!cur && cur.need.has(midi) && !cur.got.has(midi);
      el.classList.toggle('is-expected', expected);
    }
  }

  function flashKey(midi, cls, ms = FLASH_MS) {
    const el = keyEls.get(midi);
    if (!el) return;
    el.classList.add(cls);
    const prev = flashTimers.get(`${midi}:${cls}`);
    if (prev) clearTimeout(prev);
    flashTimers.set(
      `${midi}:${cls}`,
      setTimeout(() => el.classList.remove(cls), ms),
    );
  }

  /** Paint the per-run progress bar from stepIndex / steps.length. */
  function updateRunProgress() {
    const total = steps.length;
    runProgress.hidden = total === 0;
    if (!total) return;
    const done = Math.min(stepIndex, total);
    runProgressLabel.textContent = `Note ${Math.min(stepIndex + 1, total)} of ${total}`;
    runProgressTrack.setAttribute('aria-valuemax', String(total));
    runProgressTrack.setAttribute('aria-valuenow', String(done));
    runProgressFill.style.width = `${(done / total) * 100}%`;
  }

  /** Brief color pulse on the run bar (run complete / run reset). */
  function pulseRunProgress(cls) {
    runProgress.classList.add(cls);
    const prev = flashTimers.get(`runbar:${cls}`);
    if (prev) clearTimeout(prev);
    flashTimers.set(
      `runbar:${cls}`,
      setTimeout(() => runProgress.classList.remove(cls), 700),
    );
  }

  // ---- The wait-mode state machine ----
  function pressPitch(midi) {
    // Audible feedback for on-screen/computer input — but never while the mic
    // listens: the speaker's ping would be picked up as another (wrong) note.
    if (audioCtx && ui.noteSound && !micWanted) ping(midi);
    heldPitches.add(midi);
    if (!steps.length) { refreshKeyClasses(); return; }

    const cur = steps[stepIndex];
    if (cur.need.has(midi)) {
      runStarted = true;
      lastProgressAt = performance.now();
      if (guideKeys && currentStage() > 0) guidedThisRun = true;
      cur.got.add(midi);
      flashKey(midi, 'is-correct');
      if (cur.got.size >= cur.need.size) advanceStep();
    } else {
      // Wrong note → strict reset of the whole attempt (or, in a lenient
      // play-through, a tallied slip that leaves the run where it is).
      flashKey(midi, 'is-wrong');
      if (strictRuns) handleMistake(midi);
      else handleSlip(midi);
    }
    refreshKeyClasses();
  }

  function releasePitch(midi) {
    heldPitches.delete(midi);
    refreshKeyClasses();
  }

  function advanceStep() {
    stepIndex++;
    if (stepIndex >= steps.length && !strictRuns) {
      // Lenient play-through reached the end: report the slip tally rather
      // than banking a rep, then reset to the top for another go.
      const slips = slipsThisRun;
      feedback.textContent = slips
        ? `✓ Played to the end — ${slips} wrong note${slips === 1 ? '' : 's'} along the way.`
        : '✓ Played to the end — not a single wrong note!';
      feedback.classList.remove('is-error');
      feedback.classList.add('is-success');
      pulseRunProgress('is-complete');
      onRepComplete({ strict: false, mistakes: slips, hand, hinted: false, hints: 0, guided: false });
      restartRun(false);
      return;
    }
    if (stepIndex >= steps.length) {
      // Clean run complete. Runs that needed hesitation hints (or key guides
      // beyond stage 0) still finish, but the app counts them as half reps.
      const hints = hintsThisRun;
      const guided = guidedThisRun;
      // A two-handed section only banks a rep when you play hands together —
      // hands-separate runs are free warm-up. Mono sections have no separate
      // hands (RH/LH are disabled), so they always count.
      const counts = hand === 'both' || !hasHands;
      consecutiveResets = 0; // got all the way through → no longer struggling
      if (counts) cleanRunCount++;
      feedback.textContent = !counts
        ? `✓ Clean ${hand === 'rh' ? 'right' : 'left'}-hand run — warm-up. Switch to Both hands to bank a rep.`
        : hints > 0
          ? `✓ Run complete — with ${hints} hint${hints === 1 ? '' : 's'}.`
          : guided
            ? '✓ Run complete — with key guides.'
            : '✓ Clean run!';
      feedback.classList.remove('is-error');
      feedback.classList.add('is-success');
      pulseRunProgress('is-complete');
      // Only hands-together (or mono) runs feed the rep goal / SRS pipeline.
      if (counts) onRepComplete({ strict: true, hinted: hints > 0 || guided, hints, guided });
      // Reset for the next rep. We deliberately do NOT auto-satisfy held keys:
      // each step is advanced only by a fresh key press, which keeps repeated
      // notes (e.g. "C C") honest and matches how wait-mode trainers behave.
      // Sustained notes from earlier steps are harmless — only a NEW press is
      // ever judged, so a held note can neither complete nor fail a later step.
      restartRun(false);
    } else {
      updateRunProgress();
      // `tick` is the absolute MIDI tick of the now-current step, so a sheet
      // cursor can snap to the matching onset in the score.
      onProgress({
        stepIndex,
        total: steps.length,
        tick: steps[stepIndex] ? steps[stepIndex].tick : null,
      });
    }
  }

  function handleMistake(midi) {
    const wasAt = stepIndex;
    const stageNow = currentStage();
    // Corrective feedback when cues were hidden: briefly reveal the note(s) you
    // should have played. Errorful retrieval + immediate correction is strong
    // for learning — and it stops a blind run from feeling like a guessing wall.
    const cur = steps[wasAt];
    if (stageNow >= 2 && cur) {
      for (const p of cur.need) flashKey(p, 'is-reveal', REVEAL_MS);
    }
    pulseRunProgress('is-reset');
    restartRun(false);
    // Auto-assist: too many resets in a row → ease one stage (more help).
    consecutiveResets++;
    if (consecutiveResets >= ASSIST_THRESHOLD && currentStage() > 0) {
      assist++;
      consecutiveResets = 0;
      notifyStage();
      feedback.textContent = '✗ Wrong note — showing a little more help. Keep going!';
    } else {
      feedback.textContent = '✗ Wrong note — run reset. Start from the top.';
    }
    feedback.classList.add('is-error');
    feedback.classList.remove('is-success');
    // `tick` is what makes a mistake locatable in the piece rather than just
    // in this run — the app aggregates by it to find recurring trouble spots.
    onMistake({
      midi,
      atStep: wasAt,
      tick: cur ? cur.tick : null,
      expected: cur ? [...cur.need] : [],
      reset: true,
    });
  }

  /**
   * Lenient counterpart of handleMistake for a play-through: flash, tally,
   * tell the app (so trouble spots still learn from it) — but stay put. The
   * step still waits for its correct note(s), so the run can't drift.
   */
  function handleSlip(midi) {
    const cur = steps[stepIndex];
    slipsThisRun++;
    pulseRunProgress('is-reset');
    feedback.textContent = `✗ Wrong note — keep going. (${slipsThisRun} so far this run)`;
    feedback.classList.add('is-error');
    feedback.classList.remove('is-success');
    onMistake({
      midi,
      atStep: stepIndex,
      tick: cur ? cur.tick : null,
      expected: cur ? [...cur.need] : [],
      reset: false,
    });
  }

  /**
   * Re-roll which notes the cloze stages hide this run. Anchor (first-step)
   * notes are never hidden. At non-cloze stages the set is simply empty.
   */
  function rollCloze() {
    clozeHidden = new Set();
    const stage = currentStage();
    if (stage >= MEMORY_MAX_STAGE) return; // memory stage blanks everything itself
    const fraction = clozeFractionForStage(stage);
    if (fraction <= 0) return;
    for (const n of activeNotes) {
      if (anchorNotes.has(n)) continue;
      if (Math.random() < fraction) clozeHidden.add(n);
    }
  }

  function restartRun(announce) {
    stepIndex = 0;
    runStarted = false;
    hintsThisRun = 0;
    hintShownAt = 0;
    guidedThisRun = false;
    slipsThisRun = 0;
    lastProgressAt = performance.now();
    rollCloze();
    for (const s of steps) s.got = new Set();
    updateRunProgress();
    if (announce) {
      feedback.textContent = strictRuns
        ? 'Run reset — play the highlighted notes.'
        : 'Back to the top — play it through.';
      feedback.classList.remove('is-error', 'is-success');
    } else if (!feedback.textContent) {
      feedback.textContent = !steps.length
        ? 'No notes in this section.'
        : strictRuns
          ? 'Play the highlighted notes.'
          : 'Play it through from the top — wrong notes are counted, not punished.';
    }
    refreshKeyClasses();
    // Re-sync any follow-cursor (engraved score) to the reset: the current step
    // is the first one again, so snap the cursor back to the top. Without this,
    // an explicit Restart (button / R key / reset-reps) left the sheet cursor
    // parked mid-section even though the engine reset — making the button look
    // like a no-op. The Synthesia playhead already eases back on its own.
    onProgress({
      stepIndex,
      total: steps.length,
      tick: steps[stepIndex] ? steps[stepIndex].tick : null,
    });
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
    const token = ++midiConnectToken;
    try {
      const access = await getSharedMidiAccess();
      // A newer start()/stop() superseded this connection attempt while the
      // permission prompt was up — leave the newer one's bindings alone.
      if (token !== midiConnectToken || !running) return;
      midiAccess = access;
      bindMidiInputs();
      midiAccess.onstatechange = bindMidiInputs;
    } catch (err) {
      if (token !== midiConnectToken) return;
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

  // ---- Microphone input (micpitch.js) ----
  // The detector emits the same integer-MIDI press/release events as Web MIDI,
  // so everything downstream (grader, visuals, SRS) is shared. It is
  // score-informed: we hand it the current step's needed pitches so real
  // playing is detected reliably while stray sounds must clear a high bar
  // before they can reset a strict run.
  async function setMic(on) {
    micWanted = on;
    micToggle.setAttribute('aria-pressed', String(on));
    micToggle.classList.toggle('is-active', on);
    micToggle.textContent = `🎤 Mic: ${on ? 'on' : 'off'}`;
    const token = ++micStartToken;
    if (!on) {
      if (micInput) micInput.stop();
      return;
    }
    if (typeof createMicPitch !== 'function') {
      feedback.textContent = 'Mic input unavailable (micpitch.js not loaded).';
      feedback.classList.add('is-error');
      setMicOff();
      return;
    }
    if (!micInput) {
      micInput = createMicPitch({
        onNoteOn: (m) => pressPitch(m),
        onNoteOff: (m) => releasePitch(m),
        onStatus: (text, level) => {
          feedback.textContent = text;
          feedback.classList.toggle('is-error', level === 'error');
          if (level !== 'error') feedback.classList.remove('is-success');
        },
        // Score-informed detection: the pitches the current step still needs.
        getExpected: () => (steps[stepIndex] ? steps[stepIndex].need : null),
      });
    }
    const ok = await micInput.start();
    // The toggle changed again (or the session stopped) while permission was
    // pending — respect the newer state.
    if (token !== micStartToken) { if (!micWanted && micInput) micInput.stop(); return; }
    if (!ok) setMicOff();
    else if (synthPlaying) micInput.setSuppressed(true);
  }

  /** Reset the toggle UI without touching feedback (used on start failure). */
  function setMicOff() {
    micWanted = false;
    micToggle.setAttribute('aria-pressed', 'false');
    micToggle.classList.remove('is-active');
    micToggle.textContent = '🎤 Mic: off';
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

  /**
   * Play the loaded notes (current hand filter) through the shared playback
   * engine. While it plays, each sounding step lights its keys, scrolls the
   * falling-note playhead, and is reported through `onProgress` with
   * `listening: true` so the app can walk the sheet cursor along with it.
   */
  function listen() {
    const c = ensureAudio();
    if (!c || !activeNotes.length) return;
    if (typeof createPiecePlayback !== 'function') return;
    if (!preview) {
      preview = createPiecePlayback({
        audioContext: () => audioCtx,
        onStep: onListenStep,
        onEnd: onListenEnd,
      });
    }
    // Anchor t=0 at the section start so a hand's lead-in rest is kept.
    const started = preview.play(activeNotes, {
      ticksPerQuarter,
      fromSec: section ? section.startSec : undefined,
    });
    if (!started) return;
    synthPlaying = true;
    // Don't let the mic hear our own playback as played notes.
    if (micInput) micInput.setSuppressed(true);
    listenBtn.textContent = '■ Stop';
    listenBtn.classList.add('is-active');
    listenBtn.setAttribute('aria-pressed', 'true');
  }

  function onListenStep(step) {
    listenTick = step.tick;
    for (const p of step.pitches) flashKey(p, 'is-playing', LISTEN_FLASH_MS);
    onProgress({
      stepIndex,
      total: steps.length,
      tick: step.tick,
      listening: true,
      listenIndex: step.index,
      listenTotal: step.total,
    });
  }

  function onListenEnd() {
    const wasListening = synthPlaying;
    synthPlaying = false;
    listenTick = null;
    if (micInput) micInput.setSuppressed(false);
    listenBtn.textContent = '▶ Listen';
    listenBtn.classList.remove('is-active');
    listenBtn.setAttribute('aria-pressed', 'false');
    if (wasListening) {
      // Hand the follow-cursor back to the run in progress.
      onProgress({
        stepIndex,
        total: steps.length,
        tick: steps[stepIndex] ? steps[stepIndex].tick : null,
        listening: false,
      });
    }
  }

  function stopListen() {
    if (preview) preview.stop(); // → onListenEnd if it was playing
    onListenEnd();               // idempotent: also resets the button if idle
  }

  function isListening() {
    return synthPlaying;
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

    // Memory mode gates how much of the falling-note stream is drawn.
    const stage = currentStage();
    // While Listen plays, the sounding step is the "current" one so passed
    // notes dim and the chord at the hit line is outlined, as in a live run.
    const curTick = listenTick !== null
      ? listenTick
      : steps[stepIndex] ? steps[stepIndex].tick : playheadTick;
    const hintActive =
      hintShownAt > 0 && performance.now() - hintShownAt < HINT_SHOW_MS;

    if (stage >= MEMORY_MAX_STAGE) {
      // From memory — blank canvas (post-press key flashes still show),
      // except the entry anchor before the run starts and any active hint.
      ctx2d.fillStyle = 'rgba(148,163,184,0.5)';
      ctx2d.font = '13px system-ui, sans-serif';
      ctx2d.textAlign = 'center';
      ctx2d.fillText('Playing from memory', cssWidth / 2, NOTE_AREA_HEIGHT / 2);
      ctx2d.textAlign = 'start';
      if (stepIndex === 0) {
        drawGhostNotes(anchorNotes, hitY, pxPerTick, 0.5);
      }
      if (hintActive) drawHintGhost(hitY, pxPerTick);
      return;
    }
    // Stage 2 (Glance): only reveal notes once they're close to the hit line.
    const glanceTicks = GLANCE_BEATS * ticksPerQuarter;

    for (const n of activeNotes) {
      if (stage === 2 && n.startTick - playheadTick > glanceTicks) continue;
      // Cloze stages: skip this run's hidden subset (anchor never hidden).
      if (clozeHidden.has(n)) continue;
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
      // Suggested fingering digit near the note's onset end.
      if (showFingers && n.finger && h >= 13 && w >= 11) {
        ctx2d.fillStyle = '#f8fafc';
        ctx2d.font = 'bold 10px system-ui, sans-serif';
        ctx2d.textAlign = 'center';
        ctx2d.fillText(String(n.finger), cx, yOnset - 4);
      }
      // Note-name letter near the top of the note (settings menu).
      if (ui.fallingNoteNames && h >= 13 && w >= 11) {
        ctx2d.globalAlpha = 1;
        ctx2d.fillStyle = '#f8fafc';
        ctx2d.font = 'bold 9px system-ui, sans-serif';
        ctx2d.textAlign = 'center';
        ctx2d.fillText(noteLabel(n.midi, ui.notation, ui.octaveNumbers), cx, yTop + 10);
      }
    }
    if (hintActive) drawHintGhost(hitY, pxPerTick);
    ctx2d.globalAlpha = 1;
    ctx2d.textAlign = 'start';
  }

  /** Draw a set of notes as dim outlined ghosts (anchor cue / hint). */
  function drawGhostNotes(notes, hitY, pxPerTick, alpha) {
    for (const n of notes) {
      const yOnset = hitY - (n.startTick - playheadTick) * pxPerTick;
      const h = Math.max(6, (n.endTick - n.startTick) * pxPerTick);
      const yTop = yOnset - h;
      if (yTop > NOTE_AREA_HEIGHT || yOnset < 0) continue;
      const cx = keyCenterX(n.midi);
      const w = isWhite(n.midi) ? whiteWidth * 0.8 : whiteWidth * 0.5;
      ctx2d.globalAlpha = alpha;
      ctx2d.fillStyle = handColor(n, false);
      roundRect(ctx2d, cx - w / 2, yTop, w, h, 4);
      ctx2d.fill();
      ctx2d.strokeStyle = 'rgba(248,250,252,0.7)';
      ctx2d.lineWidth = 1;
      ctx2d.setLineDash([3, 3]);
      roundRect(ctx2d, cx - w / 2, yTop, w, h, 4);
      ctx2d.stroke();
      ctx2d.setLineDash([]);
      if (showFingers && n.finger && h >= 13 && w >= 11) {
        ctx2d.fillStyle = '#f8fafc';
        ctx2d.font = 'bold 10px system-ui, sans-serif';
        ctx2d.textAlign = 'center';
        ctx2d.fillText(String(n.finger), cx, yOnset - 4);
        ctx2d.textAlign = 'start';
      }
    }
    ctx2d.globalAlpha = 1;
  }

  /** Ghost the CURRENT step's notes after a hesitation hint fires. */
  function drawHintGhost(hitY, pxPerTick) {
    const cur = steps[stepIndex];
    if (!cur) return;
    const eps = ticksPerQuarter * 0.1;
    const hintNotes = activeNotes.filter(
      (n) => cur.need.has(n.midi) && Math.abs(n.startTick - cur.tick) <= eps,
    );
    drawGhostNotes(hintNotes, hitY, pxPerTick, 0.45);
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

  /**
   * Hint on hesitation: at the cloze/memory stages, stalling at a step whose
   * notes are hidden ghosts in just that step (no full Peek needed). Each
   * hint marks the run, and the app counts hinted runs as half reps.
   */
  function maybeHint() {
    const cur = steps[stepIndex];
    if (!cur || peeking) return;
    const stage = currentStage();
    if (stage < 3) return; // everything relevant is already visible
    const now = performance.now();
    if (now - lastProgressAt < HINT_DELAY_MS) return;
    // Is the current step actually hidden from the user?
    let hidden;
    if (stage >= MEMORY_MAX_STAGE) {
      hidden = stepIndex > 0; // step 0 shows the anchor ghost
    } else {
      const eps = ticksPerQuarter * 0.1;
      hidden = activeNotes.some(
        (n) =>
          cur.need.has(n.midi) &&
          Math.abs(n.startTick - cur.tick) <= eps &&
          clozeHidden.has(n),
      );
    }
    if (!hidden) return;
    hintsThisRun++;
    hintShownAt = now;
    lastProgressAt = now; // next hint only after another full stall
    feedback.textContent = `💡 Hint — runs with hints count as half a rep (${hintsThisRun} this run).`;
    feedback.classList.remove('is-error', 'is-success');
  }

  function frame() {
    if (!running) return;
    // Listen drives the playhead through the notes; otherwise it parks on the
    // step the run is waiting for.
    const target = listenTick !== null ? listenTick
      : steps[stepIndex] ? steps[stepIndex].tick
      : (section ? section.endTick : playheadTick);
    if (ui.reduceMotion) {
      playheadTick = target; // snap — no eased scroll
    } else {
      playheadTick += (target - playheadTick) * PLAYHEAD_EASING;
      if (Math.abs(target - playheadTick) < 0.5) playheadTick = target;
    }
    maybeHint();
    draw();
    rafId = requestAnimationFrame(frame);
  }

  // ---- Lifecycle ----
  const onResize = () => resize();

  function start() {
    // "Practice next" re-starts the same player without closing the panel in
    // between — tear the old session down first so we never stack duplicate
    // window listeners, RAF loops, or MIDI bindings.
    if (running) stop();
    running = true;
    playheadTick = steps[0] ? steps[0].tick : 0;
    connectMidi();
    // Mic was on when the previous section stopped → re-arm it (permission is
    // already granted, so this reconnects silently).
    if (micWanted) setMic(true);
    window.addEventListener('keydown', onComputerKeyDown, true);
    window.addEventListener('keyup', onComputerKeyUp, true);
    window.addEventListener('resize', onResize);
    resize();
    notifyStage();
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
    // Release the microphone while practice is closed (privacy); keep
    // micWanted so the next start() re-arms it.
    micStartToken++;
    if (micInput) micInput.stop();
    heldPitches.clear();
    computerHeld.clear();
  }

  function dispose() {
    stop();
    if (micInput) { micInput.dispose(); micInput = null; }
    micWanted = false;
    if (preview) { preview.dispose(); preview = null; }
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
    stopListen,
    isListening,
    pressPitch,
    releasePitch,
    getCleanRunCount,
    resetCleanRunCount,
    setComputerKeys: (on) => setComputerKeys(on),
    setMic: (on) => setMic(on),
    setGuideKeys: (on) => setGuideKeys(on),
    applySettings,
    setMemoryBase,
    setRunIndex,
    setPeek,
    getStage,
    // Absolute tick of a step (default: the current step) — lets the sheet
    // cursor sync to the section's first onset when practice opens.
    getStepTick: (i) => {
      const idx = typeof i === 'number' ? i : stepIndex;
      return steps[idx] ? steps[idx].tick : null;
    },
  };
}

// ---- Node export shim (browser-safe) ------------------------------------
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { createPlayer, COMPUTER_KEYS, isWhite };
}
