// PianoSRS — main app entry point.
//
// Roadmap items shipped here:
//   1. Basic shell layout (sidebar + viewer + status bar).
//   2. PDF upload via file input + PDF.js rendering (continuous scroll).
//   3. IndexedDB persistence — pieces survive a refresh.
//   4. Section definition UI — create/edit/delete named sections per piece,
//      each with a 1-based PDF page number and a free-text measure range
//      (e.g. "mm. 17–32"). Click a section to scroll to its page.
//   5. Review rep counter — for a chosen section, a big "Successful
//      repetition" button increments toward a daily goal of 10. The count
//      persists across refreshes (per local-calendar-day, per section) so
//      a mid-practice reload doesn't lose progress. Each section row in the
//      sections panel shows today's "X / 10" badge so the user can see
//      progress at a glance.
//   6. SRS scheduling (SM-2). When today's count crosses from <10 to >=10
//      for the first time, fire the SM-2 algorithm with a default-Good
//      rating (item 8 will replace the default with a real prompt). Persist
//      `repetitions` / `interval` / `ease` / `nextDue` / `lastReviewedDate`
//      onto the section record and surface the new "Next review" date
//      both in the practice panel and as a small pill on the section row.
//   7. Daily review queue. On app open (and after any rep-log change), walk
//      every section across every piece, filter to those whose `nextDue` is
//      today or earlier AND haven't already met today's rep goal, and render
//      them in a "Due today" panel inside the welcome placeholder. Clicking
//      a queue item selects its piece, opens the practice panel for that
//      section, and scrolls to the section's page — one click from "what do
//      I need to practice?" to "I'm practising it now".
//   8. Post-session rating. Once a section reaches today's rep goal, replace
//      the auto-Good fire of SM-2 with a real Again/Hard/Good/Easy prompt
//      inside the practice panel. Each rating button shows its projected
//      next-review distance ("Again → tomorrow / Good → in 6d") so the user
//      sees what they're committing to. Until the user picks a rating, the
//      schedule isn't persisted — closing the panel without rating leaves
//      the section unscheduled (the next open re-shows the prompt).
//   9. Progress stats. A "Progress" panel above the daily-review queue on
//      the welcome placeholder. Three tiles (daily streak, sections
//      mastered, sections in rotation) plus a header line summarising
//      today's done-of-due count, plus a per-piece retention bar list. The
//      panel hydrates once on app open from `listDistinctPracticeDates` and
//      then mutates incrementally as the user logs reps / picks ratings —
//      no extra IDB walks per click.
//  10. Export/import. Export the full library (pieces with base64-encoded
//      PDFs, sections with SRS state, rep logs) as a single JSON file the
//      user downloads. Import reads that file back in, using a 'rename'
//      collision policy: imported items get fresh IDs if they collide with
//      existing data, so no data is silently destroyed.
//  11. Polish — keyboard shortcuts (first slice). Global keydown listener
//      with an input-focus guard. Space = log rep, 1-4 = pick rating,
//      ArrowLeft/Right = prev/next PDF page, Escape = close practice
//      panel or section form. Dark mode and mobile layout are next slices.
//
// Architecture notes:
//   - Pieces are hydrated as metadata only on app open; the PDF Blob loads
//     lazily on first selection (item 3).
//   - Sections live in their own IDB store with a byPieceId index. They're
//     loaded the first time a piece is selected and then cached on the
//     in-memory piece object so re-selection doesn't re-hit IDB.
//   - The section form is a single in-place form that swaps between "add"
//     and "edit" modes — simpler than per-row inline forms while still
//     keeping the UI compact.
//   - Rep logs live in their own IDB store, keyed by `${sectionId}|${dateISO}`.
//     The practice panel keeps an in-memory mirror of today's count for the
//     active section so successive button clicks don't have to await IDB
//     reads — IDB writes still happen, but the UI updates optimistically.
//   - SRS state lives directly on the section record (optional fields that
//     are only written once a section has been rated at least once). Reset /
//     Undo on the rep counter intentionally do NOT roll back the schedule —
//     once the user has self-confirmed 10 clean reps, the SM-2 update stands
//     for the day. The `lastReviewedDate` guard prevents double-firing if
//     the user goes 10 → 9 → 10 in the same day.

// Dependencies loaded via classic <script> tags in index.html (db.js,
// srs.js, metronome.js) — all symbols are available as globals.

const APP_VERSION = '0.22.0'; // Home dashboard: forecast, goal ring, guided review

const els = {
  status: document.getElementById('app-status'),
  addPieceBtn: document.getElementById('add-piece-btn'),
  fileInput: document.getElementById('midi-file-input'),
  loadSampleBtn: document.getElementById('load-sample-btn'),
  pieceList: document.getElementById('piece-list'),
  viewerPlaceholder: document.getElementById('viewer-placeholder'),
  viewerMidi: document.getElementById('viewer-midi'),
  viewerMidiTitle: document.getElementById('viewer-midi-title'),
  viewerMidiMeta: document.getElementById('viewer-midi-meta'),
  // Sections panel
  sectionsPanel: document.getElementById('sections-panel'),
  resplitBtn: document.getElementById('resplit-sections-btn'),
  sectionForm: document.getElementById('section-form'),
  sectionFormTitle: document.getElementById('section-form-title'),
  sectionNameInput: document.getElementById('section-name-input'),
  sectionNotesInput: document.getElementById('section-notes-input'),
  sectionFormError: document.getElementById('section-form-error'),
  sectionFormCancel: document.getElementById('section-form-cancel'),
  sectionFormSubmit: document.getElementById('section-form-submit'),
  sectionList: document.getElementById('section-list'),
  // Practice panel
  practicePanel: document.getElementById('practice-panel'),
  practiceSectionName: document.getElementById('practice-section-name'),
  practiceSectionMeta: document.getElementById('practice-section-meta'),
  practiceSectionNotes: document.getElementById('practice-section-notes'),
  practiceCount: document.getElementById('practice-count'),
  practiceGoal: document.getElementById('practice-goal'),
  practiceProgressTrack: document.getElementById('practice-progress-track'),
  practiceProgressFill: document.getElementById('practice-progress-fill'),
  playerHost: document.getElementById('player-host'),
  practiceStatus: document.getElementById('practice-status'),
  practiceNextReview: document.getElementById('practice-next-review'),
  practiceRatingPrompt: document.getElementById('practice-rating-prompt'),
  practiceRatingButtons: document.getElementById('practice-rating-buttons'),
  practiceResetBtn: document.getElementById('practice-reset-btn'),
  practiceCloseBtn: document.getElementById('practice-close-btn'),
  practiceTimer: document.getElementById('practice-timer'),
  practiceTimerPauseBtn: document.getElementById('practice-timer-pause-btn'),
  practiceTotalTime: document.getElementById('practice-total-time'),
  // Review queue (item 7)
  reviewQueuePanel: document.getElementById('review-queue-panel'),
  reviewQueueList: document.getElementById('review-queue-list'),
  reviewQueueCount: document.getElementById('review-queue-count'),
  // Export/import (item 10)
  exportBtn: document.getElementById('export-btn'),
  importBtn: document.getElementById('import-btn'),
  importFileInput: document.getElementById('import-file-input'),
  // Mobile sidebar toggle (item 11c)
  sidebarToggle: document.getElementById('sidebar-toggle'),
  sidebarBackdrop: document.getElementById('sidebar-backdrop'),
  sidebar: document.getElementById('sidebar'),
  // Dark mode toggle (item 11b)
  themeToggle: document.getElementById('theme-toggle'),
  themeToggleIcon: null, // populated after DOM query
  themeToggleLabel: null,
  // Stats panel (item 9)
  statsPanel: document.getElementById('stats-panel'),
  statsPanelToday: document.getElementById('stats-panel-today'),
  statsStreakValue: document.getElementById('stats-streak-value'),
  statsStreakDetail: document.getElementById('stats-streak-detail'),
  statsMasteredValue: document.getElementById('stats-mastered-value'),
  statsMasteredDetail: document.getElementById('stats-mastered-detail'),
  statsRatedValue: document.getElementById('stats-rated-value'),
  statsRatedDetail: document.getElementById('stats-rated-detail'),
  statsPerPiece: document.getElementById('stats-per-piece'),
  statsPerPieceList: document.getElementById('stats-per-piece-list'),
  // Time-invested tile (home dashboard)
  statsTimeValue: document.getElementById('stats-time-value'),
  statsTimeDetail: document.getElementById('stats-time-detail'),
  // Daily-goal ring (home dashboard)
  statsGoal: document.getElementById('stats-goal'),
  statsGoalRingFill: document.getElementById('stats-goal-ring-fill'),
  statsGoalRingLabel: document.getElementById('stats-goal-ring-label'),
  statsGoalDone: document.getElementById('stats-goal-done'),
  statsGoalTarget: document.getElementById('stats-goal-target'),
  statsGoalValue: document.getElementById('stats-goal-value'),
  statsGoalDec: document.getElementById('stats-goal-dec'),
  statsGoalInc: document.getElementById('stats-goal-inc'),
  // Recall-maturity distribution (home dashboard)
  statsMemory: document.getElementById('stats-memory'),
  statsMemoryBar: document.getElementById('stats-memory-bar'),
  statsMemoryLegend: document.getElementById('stats-memory-legend'),
  // Due-soon forecast (home dashboard)
  statsForecast: document.getElementById('stats-forecast'),
  statsForecastBars: document.getElementById('stats-forecast-bars'),
  // Start-daily-review + overdue callout (home dashboard)
  startReviewBtn: document.getElementById('start-review-btn'),
  reviewQueueOverdue: document.getElementById('review-queue-overdue'),
  // Continue-practicing panel (home dashboard)
  continuePanel: document.getElementById('continue-panel'),
  continueList: document.getElementById('continue-list'),
  // Guided review-session bar (practice panel)
  reviewSessionBar: document.getElementById('review-session-bar'),
  reviewSessionProgress: document.getElementById('review-session-progress'),
  reviewSessionSkip: document.getElementById('review-session-skip'),
  // Practice history chart (item 12c)
  statsHistoryChart: document.getElementById('stats-history-chart'),
  statsHistoryChartContainer: document.getElementById('stats-history-chart-container'),
  // Metronome (item 12b)
  metronomeWidget: document.getElementById('metronome-widget'),
  metronomeBpmInput: document.getElementById('metronome-bpm-input'),
  metronomeDecBtn: document.getElementById('metronome-dec-btn'),
  metronomeIncBtn: document.getElementById('metronome-inc-btn'),
  metronomeToggleBtn: document.getElementById('metronome-toggle-btn'),
  metronomeToggleLabel: document.getElementById('metronome-toggle-label'),
  metronomeTapBtn: document.getElementById('metronome-tap-btn'),
  metronomeBeatIndicator: document.getElementById('metronome-beat-indicator'),
  metronomeCollapseBtn: document.getElementById('metronome-collapse-btn'),
  metronomeBody: document.getElementById('metronome-body'),
};

/**
 * In-memory piece library. Each entry:
 *   {
 *     id: string,
 *     title: string,
 *     durationSec: number,
 *     ticksPerQuarter: number,
 *     noteCount: number,
 *     addedAt: number,
 *     notes?: Array<NoteEvent>,    // parsed MIDI notes; lazy on first selection
 *     sections?: Array<SectionRecord>, // populated lazily on first selection
 *   }
 */
const pieces = [];
let activePieceId = null;

/**
 * The Synthesia player/engine (player.js), lazily created on first practice
 * and mounted into #player-host. Reused across sections.
 * @type {ReturnType<typeof createPlayer> | null}
 */
let player = null;

/**
 * Section form state. `null` = closed; the form is edit-only now
 * (sections are auto-split), so this is `{ mode: 'edit', id: 's_xxx' }`.
 */
let sectionFormState = null;

/**
 * Practice state. `null` = no active practice; otherwise:
 *   {
 *     sectionId: string,
 *     dateISO: string,
 *     count: number,
 *     saving: boolean,
 *     ratingInFlight: boolean,
 *     timerStartedAt: number,  // Date.now() when session opened
 *     timerElapsed: number,    // accumulated ms (for pause/resume)
 *     timerPaused: boolean,    // true when timer is paused
 *   }
 *
 * `count` is the in-memory mirror of today's persisted count for the active
 * section. We update it optimistically on each rep click so the UI stays
 * responsive; a parallel IDB write keeps the persisted state in sync.
 * `saving` is true while a write is in flight — used to disable the rep
 * button briefly to avoid double-fire on jittery clicks.
 * `ratingInFlight` is true while the user's chosen rating is being persisted
 * to IDB — disables the rating buttons so a second click can't fire SM-2
 * twice for the same session.
 */
let practiceState = null;

/** Interval handle for the practice timer tick. */
let practiceTimerInterval = null;

/**
 * Metronome controller (item 12b). Lazily created on first use so the
 * AudioContext isn't allocated until the user actually interacts with it.
 * @type {ReturnType<typeof createMetronome> | null}
 */
let metronome = null;

/** Flash timeout handle for the beat indicator. */
let beatFlashTimeout = null;

/**
 * Rep counts for the active piece's sections, keyed by sectionId. Populated
 * once the piece is hydrated, kept in sync as the user logs reps. Powers the
 * "X / 10" badge on each section row without re-querying IDB on every render.
 */
const repCountsToday = new Map();

/**
 * Cross-piece queue state (item 7). We keep raw section + piece + rep-count
 * snapshots so the queue can be re-rendered without an extra IDB walk on
 * every increment — only the actively-changed section's count needs to
 * update for the filter to recompute.
 *
 *   queueState = {
 *     dateISO: 'YYYY-MM-DD',
 *     sections: Array<SectionRecord>,    // every section across every piece
 *     pieceTitleById: Map<string,{id,title,pageCount}>,
 *     countsByDate: Map<string,number>,  // sectionId → count today
 *   }
 *
 * Set to null while the very first hydration is in flight.
 */
let queueState = null;
let queueClickInFlight = false;

/**
 * Stats snapshot (item 9). Holds the distinct set of dates the user has
 * practiced on (used for the daily-streak computation) plus the most
 * recently-rendered summary shape so re-renders triggered by an in-session
 * rep-click can recompute without re-walking IDB.
 *
 *   statsState = {
 *     practiceDates: Set<string>,   // YYYY-MM-DD strings
 *     dateISO: string,              // todayISO at the time of last refresh
 *   }
 */
let statsState = null;

/**
 * Most recent progress summary from `summariseProgress`, stashed so the
 * daily-goal +/- controls can recompute the ring against today's numbers
 * without re-walking the section list.
 */
let lastStatsSummary = null;

/**
 * Guided "daily review" session (home dashboard). `null` when not running;
 * otherwise `{ items: Array<queueItem>, index: number }`. The items are the
 * due-queue snapshot captured when the session started — we walk them by
 * index so completing or skipping a section never re-opens it, and sections
 * that become due mid-session don't extend the run.
 */
let reviewSession = null;

/** localStorage key for the user's daily-review goal (sections/day). */
const DAILY_GOAL_KEY = 'pianoSrsDailyGoal';

/**
 * The user's daily goal: a positive integer, or `null` for "Auto" (track
 * whatever is due today). Read once at startup; mutated by the +/- controls.
 */
let dailyGoal = readDailyGoal();

/** Set the small status line in the footer. */
function setStatus(message) {
  if (els.status) {
    els.status.textContent = message;
  }
}

// --- Piece sidebar -------------------------------------------------------

/**
 * Render the piece list in the sidebar.
 * @param {Array<{id: string, title: string, pageCount: number}>} list
 */
function renderPieceList(list) {
  if (!els.pieceList) return;
  els.pieceList.innerHTML = '';
  if (!list || list.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'piece-list-empty';
    empty.innerHTML =
      'No pieces yet. Click <strong>+ Add piece</strong> to load a MIDI file.';
    els.pieceList.appendChild(empty);
    return;
  }
  for (const piece of list) {
    const li = document.createElement('li');
    li.className = 'piece-list-item';
    if (piece.id === activePieceId) li.classList.add('active');
    li.dataset.pieceId = piece.id;
    li.tabIndex = 0;
    li.setAttribute('role', 'button');

    const infoWrap = document.createElement('div');
    infoWrap.className = 'piece-list-item-info';

    const title = document.createElement('span');
    title.className = 'piece-list-item-title';
    title.textContent = piece.title;
    infoWrap.appendChild(title);

    const meta = document.createElement('span');
    meta.className = 'piece-list-item-meta';
    meta.textContent = formatPieceMeta(piece);
    infoWrap.appendChild(meta);

    li.appendChild(infoWrap);

    const renameBtn = document.createElement('button');
    renameBtn.className = 'piece-list-item-rename';
    renameBtn.type = 'button';
    renameBtn.title = 'Rename piece';
    renameBtn.setAttribute('aria-label', `Rename ${piece.title}`);
    renameBtn.textContent = '✎';
    renameBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      startInlineRename(li, piece);
    });
    li.appendChild(renameBtn);

    const delBtn = document.createElement('button');
    delBtn.className = 'piece-list-item-delete';
    delBtn.type = 'button';
    delBtn.title = 'Delete piece';
    delBtn.setAttribute('aria-label', `Delete ${piece.title}`);
    delBtn.textContent = '×'; // × symbol
    delBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      handleDeletePiece(piece.id, piece.title);
    });
    li.appendChild(delBtn);

    infoWrap.addEventListener('click', () => selectPiece(piece.id));
    li.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        selectPiece(piece.id);
      }
    });
    els.pieceList.appendChild(li);
  }
}

/**
 * Delete a piece after confirmation: cascade-delete its sections and rep logs,
 * remove the piece record from IDB, remove from in-memory array, and refresh
 * the UI (sidebar, review queue, stats).
 */
async function handleDeletePiece(pieceId, title) {
  const ok = window.confirm(
    `Delete "${title}" and all its sections, practice history, and SRS data?\n\nThis cannot be undone.`,
  );
  if (!ok) return;

  try {
    // Gather section IDs for rep-log cascade before deleting sections.
    const sections = await listSectionsForPiece(pieceId);
    const sectionIds = sections.map((s) => s.id);

    // Cascade: rep logs → sections → piece.
    if (sectionIds.length > 0) {
      await deleteRepLogsForSections(sectionIds);
    }
    await deleteSectionsForPiece(pieceId);
    await deletePiece(pieceId);

    // Remove from in-memory array.
    const idx = pieces.findIndex((p) => p.id === pieceId);
    if (idx !== -1) pieces.splice(idx, 1);

    // If the deleted piece was active, clear the viewer back to the welcome
    // placeholder.
    if (activePieceId === pieceId) {
      activePieceId = null;
      closePracticeView({ silent: true });
      closeSectionForm();
      if (els.viewerMidi) els.viewerMidi.hidden = true;
      if (els.viewerPlaceholder) els.viewerPlaceholder.hidden = false;
    }

    renderPieceList(pieces);
    // Refresh the review queue and stats since sections may have been removed
    // from the due-today queue.
    await refreshReviewQueue();
    await refreshStats();
    setStatus(`Deleted "${title}".`);
  } catch (err) {
    console.error('Failed to delete piece', err);
    setStatus(`Failed to delete "${title}": ${err.message || err}`);
  }
}

/**
 * Inline-rename: replace the piece's info area with an input field.
 * Commit on Enter/blur, cancel on Escape.
 */
function startInlineRename(li, piece) {
  // Prevent double-activation.
  if (li.querySelector('.piece-rename-input')) return;

  const infoWrap = li.querySelector('.piece-list-item-info');
  const originalHTML = infoWrap.innerHTML;

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'piece-rename-input';
  input.value = piece.title;
  input.setAttribute('aria-label', 'New name for piece');

  infoWrap.innerHTML = '';
  infoWrap.appendChild(input);
  input.focus();
  input.select();

  let committed = false;

  async function commit() {
    if (committed) return;
    committed = true;
    const newTitle = input.value.trim();
    if (!newTitle || newTitle === piece.title) {
      // Revert — no change.
      infoWrap.innerHTML = originalHTML;
      return;
    }
    try {
      await renamePiece(piece.id, newTitle);
      piece.title = newTitle;
      renderPieceList(pieces);
      // Also update the viewer header if this piece is active.
      if (activePieceId === piece.id && els.viewerMidiTitle) {
        els.viewerMidiTitle.textContent = newTitle;
      }
      setStatus(`Renamed to "${newTitle}".`);
    } catch (err) {
      console.error('Rename failed', err);
      infoWrap.innerHTML = originalHTML;
      setStatus(`Rename failed: ${err.message || err}`);
    }
  }

  function cancel() {
    if (committed) return;
    committed = true;
    infoWrap.innerHTML = originalHTML;
  }

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); commit(); }
    if (e.key === 'Escape') { e.preventDefault(); cancel(); }
  });
  input.addEventListener('blur', () => commit());
}

/**
 * Derive a human-readable piece title from a filename.
 * Strips the extension and replaces underscores/dashes with spaces.
 * Exported for unit testing.
 */
function titleFromFilename(filename) {
  if (!filename) return 'Untitled';
  const noExt = filename.replace(/\.[^.]+$/, '');
  const cleaned = noExt.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
  return cleaned || 'Untitled';
}

/** Format seconds as m:ss for the piece/section meta lines. */
function formatClock(totalSec) {
  const s = Math.max(0, Math.round(totalSec || 0));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

/** Sidebar meta line for a piece: note count + duration. */
function formatPieceMeta(piece) {
  const n = piece.noteCount || 0;
  const noteStr = n === 1 ? '1 note' : `${n} notes`;
  return `${noteStr} · ${formatClock(piece.durationSec)}`;
}

/** Section meta line: note count + its time window within the piece. */
function formatSectionMeta(section) {
  const n = section.noteCount || 0;
  const noteStr = n === 1 ? '1 note' : `${n} notes`;
  return `${noteStr} · ${formatClock(section.startSec)}–${formatClock(section.endSec)}`;
}

/** Generate a short, sortable id for a new piece. */
function newPieceId() {
  return `p_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

/** Generate a short, sortable id for a new section. */
function newSectionId() {
  return `s_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

/** Read a File (or Blob) as an ArrayBuffer. */
function readBlobAsArrayBuffer(blob) {
  if (blob && typeof blob.arrayBuffer === 'function') {
    return blob.arrayBuffer();
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error('Blob read failed'));
    reader.readAsArrayBuffer(blob);
  });
}

// --- Upload --------------------------------------------------------------

/**
 * Build auto-split section records for a parsed piece and persist them.
 * Returns the in-memory section records. Shared by import and "Re-split".
 */
async function buildSectionsForPiece(piece) {
  const ranges = sectionizeByPhrase(piece.notes, piece.ticksPerQuarter);
  // Append the derived joins so the seams between sections get reviewed for
  // fluency too: overlapping transition pairs for every boundary, then
  // doubling run-throughs up to the full piece.
  ranges.push(...makeDerivedRanges(ranges));
  const now = Date.now();
  const records = [];
  ranges.forEach((range, i) => {
    const record = sectionToRecord({
      id: newSectionId(),
      pieceId: piece.id,
      name: range.name,
      startTick: range.startTick,
      endTick: range.endTick,
      startSec: range.startSec,
      endSec: range.endSec,
      noteCount: range.noteCount,
      notes: range.notes || '',
      kind: range.kind,
      addedAt: now + i, // slight offset keeps order deterministic
      order: i,
    });
    records.push(record);
  });
  for (const record of records) {
    try { await saveSection(record); } catch (_) { /* best-effort */ }
  }
  return records;
}

/** Handle a chosen MIDI file: parse, persist to IDB, auto-split, then select. */
async function handleMidiFile(file) {
  if (!file) return;
  if (!/\.midi?$/i.test(file.name) && !/midi/i.test(file.type || '')) {
    setStatus(`"${file.name}" doesn't look like a MIDI file — ignored.`);
    return;
  }
  setStatus(`Loading "${file.name}"…`);
  try {
    const arrayBuffer = await readBlobAsArrayBuffer(file);
    let parsed;
    try {
      parsed = parseMidi(arrayBuffer);
    } catch (err) {
      setStatus(`Couldn't read "${file.name}": ${err.message || err}`);
      return;
    }
    if (!parsed.notes.length) {
      setStatus(`"${file.name}" has no playable notes — ignored.`);
      return;
    }
    // Suggest a hand + finger for every note (drawn on the falling notes).
    annotateFingerings(parsed.notes, { ticksPerQuarter: parsed.ticksPerQuarter });

    const piece = {
      id: newPieceId(),
      title: titleFromFilename(file.name),
      durationSec: parsed.durationSec,
      ticksPerQuarter: parsed.ticksPerQuarter,
      noteCount: parsed.notes.length,
      addedAt: Date.now(),
      notes: parsed.notes,
      sections: [],
    };

    // Persist the raw MIDI bytes BEFORE updating the UI so a refresh always
    // sees exactly what was imported.
    const blob = new Blob([arrayBuffer], { type: 'audio/midi' });
    try {
      await savePiece(pieceToRecord(piece, blob));
    } catch (err) {
      console.warn('IndexedDB save failed; piece will live in memory only', err);
      setStatus(
        `Added "${piece.title}" but couldn't save it — refresh will lose it.`,
      );
    }

    // Auto-split into phrase-based practice sections.
    piece.sections = await buildSectionsForPiece(piece);

    pieces.push(piece);
    renderPieceList(pieces);
    setStatus(
      `Added "${piece.title}" (${piece.noteCount} notes, ${piece.sections.length} sections).`,
    );
    selectPiece(piece.id);
  } catch (err) {
    console.error('Failed to load MIDI', err);
    setStatus(`Failed to load MIDI: ${err.message || err}`);
  }
}

/**
 * One-click loader for the bundled demo piece (`samples/twinkle.mid`). Fetched
 * at runtime and run through the normal import path. If a Twinkle piece is
 * already in the library, just select it instead of importing a duplicate.
 */
async function handleLoadSample() {
  const existing = pieces.find((p) => p.title === 'Twinkle Twinkle');
  if (existing) {
    selectPiece(existing.id);
    return;
  }
  setStatus('Loading sample piece…');
  let buf;
  try {
    const res = await fetch('samples/twinkle.mid');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    buf = await res.arrayBuffer();
  } catch (err) {
    console.warn('Could not fetch sample', err);
    setStatus(
      'Could not load the sample — open the app over http://localhost (not by double-clicking index.html).',
    );
    return;
  }
  await handleMidiFile(
    new File([buf], 'Twinkle Twinkle.mid', { type: 'audio/midi' }),
  );
}

// --- Selection -----------------------------------------------------------

/** Switch the viewer to the given piece, lazy-loading MIDI + sections if needed. */
async function selectPiece(pieceId) {
  const piece = pieces.find((p) => p.id === pieceId);
  if (!piece) return;
  // On mobile, close the sidebar drawer so the viewer is visible.
  if (isMobileViewport()) closeSidebar();
  // Switching pieces always exits practice mode — practice is per-section
  // and a section only belongs to one piece.
  closePracticeView({ silent: true });
  activePieceId = pieceId;
  // Re-render the sidebar so the active highlight moves.
  renderPieceList(pieces);
  // Close any in-flight section form when switching pieces.
  closeSectionForm();
  repCountsToday.clear();

  try {
    await ensureMidiLoaded(piece);
  } catch (err) {
    console.error('Failed to load MIDI from storage', err);
    setStatus(`Failed to load "${piece.title}": ${err.message || err}`);
    return;
  }

  // Load sections (and today's rep counts) in the background.
  ensureSectionsLoaded(piece)
    .then(() => refreshRepCountsForActivePiece())
    .then(() => {
      if (activePieceId === piece.id) renderSectionsPanel();
    })
    .catch((err) => {
      console.warn('Could not load sections for piece', err);
      if (activePieceId === piece.id) {
        renderSectionsPanel();
      }
    });

  showMidiViewer(piece);
}

/**
 * If the piece doesn't have parsed `notes` in memory yet, fetch its MIDI Blob
 * from IDB and parse it. Mutates the piece in place.
 */
async function ensureMidiLoaded(piece) {
  if (Array.isArray(piece.notes)) return;
  setStatus(`Loading "${piece.title}"…`);
  const blob = await getPieceBlob(piece.id);
  if (!blob) {
    throw new Error('MIDI data is missing from local storage');
  }
  const arrayBuffer = await readBlobAsArrayBuffer(blob);
  const parsed = parseMidi(arrayBuffer);
  annotateFingerings(parsed.notes, { ticksPerQuarter: parsed.ticksPerQuarter });
  piece.notes = parsed.notes;
  piece.ticksPerQuarter = parsed.ticksPerQuarter;
  piece.durationSec = parsed.durationSec;
  piece.noteCount = parsed.notes.length;
}

/** Lazy-load a piece's sections from IDB, caching them on the piece. */
async function ensureSectionsLoaded(piece) {
  if (Array.isArray(piece.sections)) return;
  try {
    piece.sections = await listSectionsForPiece(piece.id);
  } catch (err) {
    piece.sections = [];
    throw err;
  }
}

// --- MIDI viewer ---------------------------------------------------------

/** Reveal the MIDI viewer surface and stamp the piece's title/meta. */
function showMidiViewer(piece) {
  if (!els.viewerMidi || !els.viewerPlaceholder) return;
  els.viewerPlaceholder.hidden = true;
  els.viewerMidi.hidden = false;
  if (els.viewerMidiTitle) els.viewerMidiTitle.textContent = piece.title;
  if (els.viewerMidiMeta) els.viewerMidiMeta.textContent = formatPieceMeta(piece);
  setStatus(`Showing "${piece.title}" — pick a section to practice.`);
}

// --- Sections panel ------------------------------------------------------

/** Find the active piece object, or null if none. */
function getActivePiece() {
  return pieces.find((p) => p.id === activePieceId) || null;
}

// ─── Section drag-to-reorder (item 17) ──────────────────────────────────────

let draggedSectionLi = null;

/**
 * Wire up drag-and-drop event listeners on the section list <ul>.
 * Each <li> is draggable; reordering is persisted to IndexedDB on drop.
 */
function setupSectionDragAndDrop(listEl) {
  listEl.addEventListener('dragstart', (e) => {
    const li = e.target.closest('.section-list-item');
    if (!li) return;
    draggedSectionLi = li;
    li.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', li.dataset.sectionId);
  });

  listEl.addEventListener('dragend', (e) => {
    const li = e.target.closest('.section-list-item');
    if (li) li.classList.remove('dragging');
    draggedSectionLi = null;
    // Remove any lingering drop indicator
    listEl.querySelectorAll('.drag-over').forEach((el) => el.classList.remove('drag-over'));
  });

  listEl.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const target = e.target.closest('.section-list-item');
    if (!target || target === draggedSectionLi) return;
    // Visual indicator
    listEl.querySelectorAll('.drag-over').forEach((el) => el.classList.remove('drag-over'));
    target.classList.add('drag-over');
  });

  listEl.addEventListener('dragleave', (e) => {
    const target = e.target.closest('.section-list-item');
    if (target) target.classList.remove('drag-over');
  });

  listEl.addEventListener('drop', async (e) => {
    e.preventDefault();
    listEl.querySelectorAll('.drag-over').forEach((el) => el.classList.remove('drag-over'));
    const target = e.target.closest('.section-list-item');
    if (!target || !draggedSectionLi || target === draggedSectionLi) return;

    // Determine new ordering by DOM position
    const items = [...listEl.querySelectorAll('.section-list-item')];
    const fromIdx = items.indexOf(draggedSectionLi);
    const toIdx = items.indexOf(target);
    if (fromIdx === -1 || toIdx === -1) return;

    // Move dragged item in DOM
    if (fromIdx < toIdx) {
      target.after(draggedSectionLi);
    } else {
      target.before(draggedSectionLi);
    }

    // Persist new order
    const reorderedItems = [...listEl.querySelectorAll('.section-list-item')];
    const updates = reorderedItems.map((li, idx) => ({
      id: li.dataset.sectionId,
      order: idx,
    }));

    try {
      await reorderSections(updates);
      // Update in-memory sections array on the active piece
      const piece = getActivePiece();
      if (piece && Array.isArray(piece.sections)) {
        const orderMap = new Map(updates.map((u) => [u.id, u.order]));
        piece.sections.sort(
          (a, b) => (orderMap.get(a.id) ?? 0) - (orderMap.get(b.id) ?? 0),
        );
        // Sync the order field on in-memory objects
        for (const s of piece.sections) {
          s.order = orderMap.get(s.id) ?? s.order;
        }
      }
      setStatus('Section order updated.');
    } catch (err) {
      console.error('Failed to persist section reorder:', err);
      setStatus('Error saving section order.');
      // Re-render to restore correct order from DB
      renderSectionsPanel();
    }
  });
}

/** Render the sections panel for the currently-active piece. */
function renderSectionsPanel() {
  if (!els.sectionsPanel || !els.sectionList) return;
  const piece = getActivePiece();
  if (!piece) {
    els.sectionsPanel.hidden = true;
    return;
  }
  els.sectionsPanel.hidden = false;

  const sections = Array.isArray(piece.sections) ? piece.sections : [];
  els.sectionList.innerHTML = '';

  if (sections.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'section-list-empty';
    empty.textContent =
      'No sections yet. Use “Re-split” to break this piece into practice phrases.';
    els.sectionList.appendChild(empty);
    return;
  }

  for (const sec of sections) {
    const li = document.createElement('li');
    li.className = 'section-list-item';
    li.dataset.sectionId = sec.id;
    li.draggable = true;
    const isActivePractice =
      practiceState && practiceState.sectionId === sec.id;
    if (isActivePractice) li.classList.add('practicing');

    // Drag handle grip
    const grip = document.createElement('span');
    grip.className = 'section-drag-handle';
    grip.textContent = '≡'; // ≡ hamburger-style icon
    grip.title = 'Drag to reorder';
    li.appendChild(grip);

    const main = document.createElement('button');
    main.type = 'button';
    main.className = 'section-list-main';
    main.title = `Practice "${sec.name}"`;
    main.addEventListener('click', () => openPracticeView(sec.id));

    const name = document.createElement('span');
    name.className = 'section-list-name';
    name.textContent = sec.name;
    main.appendChild(name);

    // Derived join sections get a small kind badge so they're visually
    // distinct from the per-phrase sections they combine.
    if (sec.kind === 'transition' || sec.kind === 'fluency') {
      li.classList.add(`section-kind-${sec.kind}`);
      const kindBadge = document.createElement('span');
      kindBadge.className = 'section-list-kind-badge';
      kindBadge.textContent =
        sec.kind === 'transition' ? 'Transition' : 'Fluency';
      kindBadge.title =
        sec.kind === 'transition'
          ? 'Joins two adjacent sections — practice the seam between them'
          : 'Combined run-through — review the transitions between sections';
      main.appendChild(kindBadge);
    }

    const meta = document.createElement('span');
    meta.className = 'section-list-meta';
    meta.textContent = formatSectionMeta(sec);
    main.appendChild(meta);

    // Per-section notes snippet (item 12a). Truncated via CSS to 2 lines.
    if (sec.notes) {
      const notesEl = document.createElement('span');
      notesEl.className = 'section-list-notes';
      notesEl.textContent = sec.notes;
      main.appendChild(notesEl);
    }

    // Per-section total practice time badge (item 19).
    if (sec.totalPracticeMs && sec.totalPracticeMs > 0) {
      const timeEl = document.createElement('span');
      timeEl.className = 'section-list-time-badge';
      timeEl.textContent = `⏱ ${formatTotalPracticeTime(sec.totalPracticeMs)}`;
      timeEl.title = `Total practice time: ${formatTotalPracticeTime(sec.totalPracticeMs)}`;
      main.appendChild(timeEl);
    }

    // Per-section "X / 10 today" badge. Hidden until the user has logged
    // at least one rep so the panel isn't visually noisy on a fresh piece.
    const repCount = repCountsToday.get(sec.id) || 0;
    if (repCount > 0) {
      const badge = document.createElement('span');
      badge.className = 'section-list-rep-badge';
      if (isRepGoalMet(repCount)) badge.classList.add('section-list-rep-badge-done');
      badge.textContent = isRepGoalMet(repCount)
        ? `Done · ${repCount}/${REP_GOAL}`
        : `${repCount}/${REP_GOAL} today`;
      main.appendChild(badge);
    }

    // SM-2 next-due pill (item 6). Surfaced once a section has been rated
    // at least once. We highlight overdue / due-today sections so the eye
    // is drawn to what needs work first — feeds directly into item 7's
    // daily review queue once that lands.
    if (typeof sec.nextDue === 'string' && sec.nextDue) {
      const todayISO = localDateISO();
      let daysOff;
      try {
        daysOff = daysBetweenISO(todayISO, sec.nextDue);
      } catch {
        daysOff = null;
      }
      if (daysOff !== null) {
        const pill = document.createElement('span');
        pill.className = 'section-list-next-due';
        if (daysOff <= 0) pill.classList.add('is-due');
        pill.textContent =
          daysOff < 0
            ? `Due ${Math.abs(daysOff)}d ago`
            : daysOff === 0
            ? 'Due today'
            : daysOff === 1
            ? 'Next: tomorrow'
            : `Next: ${daysOff}d`;
        pill.title = `Next review: ${sec.nextDue}`;
        main.appendChild(pill);
      }
    }

    li.appendChild(main);

    const actions = document.createElement('div');
    actions.className = 'section-list-actions';

    const practiceBtn = document.createElement('button');
    practiceBtn.type = 'button';
    practiceBtn.className = 'btn btn-sm btn-practice';
    practiceBtn.textContent = isActivePractice ? 'Practicing…' : 'Practice';
    practiceBtn.disabled = isActivePractice;
    practiceBtn.addEventListener('click', () => openPracticeView(sec.id));
    actions.appendChild(practiceBtn);

    const editBtn = document.createElement('button');
    editBtn.type = 'button';
    editBtn.className = 'btn btn-sm';
    editBtn.textContent = 'Edit';
    editBtn.addEventListener('click', () =>
      openSectionForm({ mode: 'edit', id: sec.id }),
    );
    actions.appendChild(editBtn);

    const deleteBtn = document.createElement('button');
    deleteBtn.type = 'button';
    deleteBtn.className = 'btn btn-sm btn-danger';
    deleteBtn.textContent = 'Delete';
    deleteBtn.addEventListener('click', () => handleDeleteSection(sec.id));
    actions.appendChild(deleteBtn);

    li.appendChild(actions);
    els.sectionList.appendChild(li);
  }
}

/**
 * Refresh today's rep counts for every section of the active piece.
 * Mirrors them into `repCountsToday`. Errors are swallowed — the badge is
 * non-critical eye-candy and the practice panel can still operate.
 */
async function refreshRepCountsForActivePiece() {
  const piece = getActivePiece();
  if (!piece || !Array.isArray(piece.sections) || piece.sections.length === 0) {
    return;
  }
  const dateISO = localDateISO();
  const ids = piece.sections.map((s) => s.id);
  try {
    const counts = await getRepCountsForSections(ids, dateISO);
    repCountsToday.clear();
    for (const [k, v] of counts) repCountsToday.set(k, v);
  } catch (err) {
    console.warn('Could not load rep counts', err);
  }
}

function openSectionForm(state) {
  const piece = getActivePiece();
  if (!piece || !els.sectionForm) return;
  sectionFormState = state;

  let nameVal = '';
  let notesVal = '';

  // The form is edit-only — section ranges are auto-assigned.
  const existing = (piece.sections || []).find((s) => s.id === state.id);
  if (!existing) {
    sectionFormState = null;
    return;
  }
  nameVal = existing.name;
  notesVal = existing.notes || '';

  if (els.sectionFormTitle) els.sectionFormTitle.textContent = 'Edit section';
  if (els.sectionNameInput) els.sectionNameInput.value = nameVal;
  if (els.sectionNotesInput) els.sectionNotesInput.value = notesVal;
  if (els.sectionFormError) {
    els.sectionFormError.textContent = '';
    els.sectionFormError.hidden = true;
  }

  els.sectionForm.hidden = false;
  if (els.sectionNameInput) {
    els.sectionNameInput.focus();
    els.sectionNameInput.select();
  }
}

function closeSectionForm() {
  sectionFormState = null;
  if (!els.sectionForm) return;
  els.sectionForm.hidden = true;
  if (els.sectionFormError) {
    els.sectionFormError.textContent = '';
    els.sectionFormError.hidden = true;
  }
}

async function handleSectionFormSubmit(e) {
  e.preventDefault();
  if (!sectionFormState) return;
  const piece = getActivePiece();
  if (!piece) return;

  const raw = {
    name: els.sectionNameInput ? els.sectionNameInput.value : '',
    notes: els.sectionNotesInput ? els.sectionNotesInput.value : '',
  };
  const result = validateSectionInput(raw);
  if (!result.ok) {
    const messages = Object.values(result.errors);
    if (els.sectionFormError) {
      els.sectionFormError.textContent = messages.join(' ');
      els.sectionFormError.hidden = false;
    }
    return;
  }

  const sections = Array.isArray(piece.sections) ? piece.sections : [];

  const existing = sections.find((s) => s.id === sectionFormState.id);
  if (!existing) {
    setStatus("That section was already removed — couldn't save changes.");
    closeSectionForm();
    renderSectionsPanel();
    return;
  }
  const record = sectionToRecord({
    ...existing,
    name: result.value.name,
    notes: result.value.notes,
  });

  try {
    await saveSection(record);
  } catch (err) {
    console.error('Failed to save section', err);
    if (els.sectionFormError) {
      els.sectionFormError.textContent =
        `Couldn't save section: ${err.message || err}`;
      els.sectionFormError.hidden = false;
    }
    return;
  }

  // Update the in-memory cache.
  const i = sections.findIndex((s) => s.id === record.id);
  if (i >= 0) sections[i] = record;
  else sections.push(record);
  setStatus(`Updated section "${record.name}".`);
  // Mirror the updated section into the queue snapshot so an edit is
  // reflected the next time the welcome card is shown.
  upsertQueueSection(record);
  // Re-sort by order then addedAt to match the persistence layer.
  sections.sort(
    (a, b) =>
      (a.order || 0) - (b.order || 0) ||
      (a.addedAt || 0) - (b.addedAt || 0),
  );
  piece.sections = sections;

  closeSectionForm();
  renderSectionsPanel();
  renderReviewQueue();
  renderStats();
}

async function handleDeleteSection(sectionId) {
  const piece = getActivePiece();
  if (!piece) return;
  const sections = Array.isArray(piece.sections) ? piece.sections : [];
  const target = sections.find((s) => s.id === sectionId);
  if (!target) return;

  const ok = window.confirm(
    `Delete section "${target.name}"? This can't be undone.`,
  );
  if (!ok) return;

  try {
    await deleteSection(sectionId);
  } catch (err) {
    console.error('Failed to delete section', err);
    setStatus(`Couldn't delete section: ${err.message || err}`);
    return;
  }
  piece.sections = sections.filter((s) => s.id !== sectionId);
  // If the form was editing this exact section, close it.
  if (
    sectionFormState &&
    sectionFormState.mode === 'edit' &&
    sectionFormState.id === sectionId
  ) {
    closeSectionForm();
  }
  // If we were practicing this exact section, exit practice mode.
  if (practiceState && practiceState.sectionId === sectionId) {
    closePracticeView({ silent: true });
  }
  repCountsToday.delete(sectionId);
  removeQueueSection(sectionId);
  setStatus(`Deleted section "${target.name}".`);
  renderSectionsPanel();
  renderReviewQueue();
  renderStats();
}

// --- Re-split sections ---------------------------------------------------

/**
 * Re-run the phrase-sectioning algorithm on the active piece, replacing all
 * existing sections. Per-section practice progress (rep logs) and SRS state
 * are discarded along with the old section ids, so confirm first.
 */
async function handleResplitSections() {
  const piece = getActivePiece();
  if (!piece || !Array.isArray(piece.notes)) return;
  const ok = window.confirm(
    'Re-split this piece into fresh phrase sections? This discards the current ' +
      'sections along with their practice progress and review schedule.',
  );
  if (!ok) return;

  closePracticeView({ silent: true });
  const old = Array.isArray(piece.sections) ? piece.sections : [];
  try {
    for (const s of old) await deleteSection(s.id);
    if (old.length) await deleteRepLogsForSections(old.map((s) => s.id));
  } catch (err) {
    console.warn('Could not fully clear old sections', err);
  }
  piece.sections = await buildSectionsForPiece(piece);
  repCountsToday.clear();
  setStatus(`Re-split "${piece.title}" into ${piece.sections.length} sections.`);
  renderSectionsPanel();
  await refreshReviewQueue();
  renderReviewQueue();
  await refreshStats();
  renderStats();
}

// --- Practice panel ------------------------------------------------------

/** Open the practice panel for the given section. */
async function openPracticeView(sectionId) {
  const piece = getActivePiece();
  if (!piece || !Array.isArray(piece.sections)) return;
  const section = piece.sections.find((s) => s.id === sectionId);
  if (!section) return;

  const dateISO = localDateISO();
  // Seed the in-memory count from the cache; we'll reconcile against IDB
  // below in case the cache is stale (e.g. user was here this morning).
  const cachedCount = repCountsToday.get(sectionId) || 0;
  practiceState = {
    sectionId,
    dateISO,
    count: cachedCount,
    saving: false,
    ratingInFlight: false,
    pendingHalfRep: false,
    timerStartedAt: Date.now(),
    timerElapsed: 0,
    timerPaused: false,
  };
  startPracticeTimer();

  // Re-render the section list so the active row highlights + the Practice
  // button on this section disables.
  renderSectionsPanel();
  // Reveal the practice panel and paint the initial state.
  showPracticePanel(section);
  renderPracticePanel();
  // Add the practicing layout class to reorder DOM visually.
  if (els.viewerMidi) els.viewerMidi.classList.add('is-practicing');
  // Mount + arm the Synthesia engine for this section.
  mountPlayer(piece, section);

  // Reconcile with IDB in case another tab / yesterday's count is stale.
  try {
    const counts = await getRepCountsForSections([sectionId], dateISO);
    const fresh = counts.get(sectionId) || 0;
    if (
      practiceState &&
      practiceState.sectionId === sectionId &&
      practiceState.dateISO === dateISO
    ) {
      practiceState.count = fresh;
      repCountsToday.set(sectionId, fresh);
      // Continue the within-session memory ramp from the reconciled count.
      if (player) player.setRunIndex(fresh);
      // If the user crossed the goal in another tab / earlier today, the
      // rating prompt will show automatically inside renderPracticePanel
      // (when goal-met AND lastReviewedDate !== today). We deliberately do
      // NOT auto-fire SM-2 here any more — that's the user's choice now.
      renderPracticePanel();
      // Update the section row badge to match.
      renderSectionsPanel();
    }
  } catch (err) {
    console.warn('Could not reconcile rep count from storage', err);
  }
}

/** Reveal the practice panel and stamp the section's title/meta. */
function showPracticePanel(section) {
  if (!els.practicePanel) return;
  els.practicePanel.hidden = false;
  if (els.practiceSectionName) {
    els.practiceSectionName.textContent = section.name;
  }
  if (els.practiceSectionMeta) {
    els.practiceSectionMeta.textContent = formatSectionMeta(section);
  }
  if (els.practiceSectionNotes) {
    if (section.notes) {
      els.practiceSectionNotes.textContent = section.notes;
      els.practiceSectionNotes.hidden = false;
    } else {
      els.practiceSectionNotes.textContent = '';
      els.practiceSectionNotes.hidden = true;
    }
  }
  // Item 20 — show cumulative practice time for this section.
  updatePracticeTotalTime(section);

  if (els.practiceGoal) els.practiceGoal.textContent = String(REP_GOAL);
  if (els.practiceProgressTrack) {
    els.practiceProgressTrack.setAttribute('aria-valuemax', String(REP_GOAL));
  }
}

/** Update the cumulative practice time badge in the practice panel header. */
function updatePracticeTotalTime(section) {
  if (!els.practiceTotalTime) return;
  const totalMs = section && section.totalPracticeMs;
  if (totalMs && totalMs > 0) {
    els.practiceTotalTime.textContent = `Total: ${formatTotalPracticeTime(totalMs)}`;
    els.practiceTotalTime.hidden = false;
  } else {
    els.practiceTotalTime.textContent = '';
    els.practiceTotalTime.hidden = true;
  }
}

// --- Synthesia engine integration ----------------------------------------

/** Lazily create the player and load+arm it for the given section. */
function mountPlayer(piece, section) {
  if (!els.playerHost || typeof createPlayer !== 'function') return;
  if (!player) {
    player = createPlayer(els.playerHost, {
      onRepComplete: recordCleanRun,
      onMistake: () => {
        setStatus('Wrong note — run reset. Play the section again from the top.');
      },
      onStageChange: (info) => {
        // Memory mode surfaces its level in the player's own chip; mirror big
        // transitions to the status line so the user notices the shift.
        if (info && info.stage >= MEMORY_MAX_STAGE) {
          setStatus('From memory now — no on-screen guides. You’ve got this.');
        }
      },
    });
  }
  player.resetCleanRunCount();
  // Memory mode: maturity sets the starting fade stage; runIndex continues the
  // within-session ramp from today's already-completed clean runs.
  const baseStage = memoryBaselineStage(section);
  const runIndex = practiceState ? practiceState.count : 0;
  player.load(piece, section, { baseStage, runIndex });
  player.start();
}

/**
 * A clean run-through was detected by the engine — this is the MIDI-era
 * replacement for the old self-reported "Rep done" button. Persist one
 * repetition toward today's goal of 10, reusing the exact same rep-log /
 * queue / stats / SM-2 pipeline the button used.
 */
async function recordCleanRun(info = {}) {
  if (!practiceState) return;
  const { sectionId, dateISO, count } = practiceState;
  if (isRepGoalMet(count)) return;

  // Hesitation-hinted runs count as HALF a rep: the first one banks a half
  // (no persisted increment — rep logs stay integers), the second completes
  // it and falls through to the normal one-rep path. Session-scoped: a
  // banked half doesn't survive a refresh, which errs on the strict side.
  if (info.hinted) {
    if (!practiceState.pendingHalfRep) {
      practiceState.pendingHalfRep = true;
      setStatus(
        `Run done with ${info.hints} hint${info.hints === 1 ? '' : 's'} — that's half a rep. One more run to bank it.`,
      );
      return;
    }
    practiceState.pendingHalfRep = false;
  }

  // Optimistic update so the counter ticks immediately.
  practiceState.count = count + 1;
  practiceState.saving = true;
  repCountsToday.set(sectionId, practiceState.count);
  renderPracticePanel();

  try {
    const persisted = await incrementRepLog(sectionId, dateISO);
    if (
      practiceState &&
      practiceState.sectionId === sectionId &&
      practiceState.dateISO === dateISO
    ) {
      practiceState.count = persisted.count;
      repCountsToday.set(sectionId, persisted.count);
    }
    setQueueRepCount(sectionId, persisted.count);
    noteRepLogActivity(dateISO);
    // Advance the within-session memory-fade ramp to match the new count.
    if (player) player.setRunIndex(persisted.count);
    if (isRepGoalMet(persisted.count)) {
      setStatus(`All ${persisted.count} clean runs done — pick a rating to schedule the next review.`);
    } else {
      setStatus(`Clean run ${persisted.count} of ${REP_GOAL}.`);
    }
  } catch (err) {
    console.error('Failed to log clean run', err);
    if (
      practiceState &&
      practiceState.sectionId === sectionId &&
      practiceState.dateISO === dateISO
    ) {
      practiceState.count = count;
      repCountsToday.set(sectionId, count);
    }
    setStatus(`Couldn't save that run: ${err.message || err}`);
  } finally {
    if (practiceState) practiceState.saving = false;
    renderPracticePanel();
    renderSectionsPanel();
    renderReviewQueue();
    renderStats();
  }
}

// ── Practice session timer (item 18) ────────────────────────────────

/** Format milliseconds as m:ss or h:mm:ss. */
function formatElapsed(ms) {
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/**
 * Format cumulative practice milliseconds as a human-readable string.
 * e.g. "3m", "1h 12m", "45s" for very short sessions.
 */
function formatTotalPracticeTime(ms) {
  if (!ms || ms <= 0) return '';
  const totalSec = Math.floor(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  if (h === 0) return `${m}m`;
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

/** Get current elapsed ms for the active practice session. */
function getPracticeElapsed() {
  if (!practiceState) return 0;
  if (practiceState.timerPaused) return practiceState.timerElapsed;
  return practiceState.timerElapsed + (Date.now() - practiceState.timerStartedAt);
}

/** Update the timer display element. */
function tickPracticeTimer() {
  if (els.practiceTimer) {
    els.practiceTimer.textContent = formatElapsed(getPracticeElapsed());
  }
}

/** Start the 1-second timer interval. */
function startPracticeTimer() {
  stopPracticeTimer(); // clear any stale interval
  tickPracticeTimer(); // immediate first paint
  practiceTimerInterval = setInterval(tickPracticeTimer, 1000);
  if (els.practiceTimerPauseBtn) {
    els.practiceTimerPauseBtn.textContent = 'Pause';
    els.practiceTimerPauseBtn.setAttribute('aria-label', 'Pause session timer');
  }
}

/** Stop the timer interval (does not clear practiceState timer fields). */
function stopPracticeTimer() {
  if (practiceTimerInterval !== null) {
    clearInterval(practiceTimerInterval);
    practiceTimerInterval = null;
  }
}

/** Toggle pause/resume on the practice timer. */
function togglePracticeTimer() {
  if (!practiceState) return;
  if (practiceState.timerPaused) {
    // Resume: set a new startedAt, keep accumulated elapsed
    practiceState.timerStartedAt = Date.now();
    practiceState.timerPaused = false;
    practiceTimerInterval = setInterval(tickPracticeTimer, 1000);
    if (els.practiceTimerPauseBtn) {
      els.practiceTimerPauseBtn.textContent = 'Pause';
      els.practiceTimerPauseBtn.setAttribute('aria-label', 'Pause session timer');
    }
  } else {
    // Pause: accumulate elapsed, stop ticking
    practiceState.timerElapsed += Date.now() - practiceState.timerStartedAt;
    practiceState.timerPaused = true;
    stopPracticeTimer();
    tickPracticeTimer(); // paint the frozen time
    if (els.practiceTimerPauseBtn) {
      els.practiceTimerPauseBtn.textContent = 'Resume';
      els.practiceTimerPauseBtn.setAttribute('aria-label', 'Resume session timer');
    }
  }
}

/**
 * Hide the practice panel and clear practice state.
 *
 * @param {{silent?: boolean, keepReviewSession?: boolean}} [opts]
 *   `keepReviewSession` is set by the guided-review auto-advance so tearing
 *   down one section doesn't end the run; any other close (user Stop / Esc /
 *   piece switch) ends a running review and returns to the dashboard.
 */
function closePracticeView({ silent, keepReviewSession } = {}) {
  stopPracticeTimer(); // item 18 — stop session timer
  // Item 19 — persist cumulative practice time before clearing state.
  if (practiceState) {
    const elapsed = getPracticeElapsed();
    if (elapsed > 0) {
      const sid = practiceState.sectionId;
      addPracticeTime(sid, elapsed).then((newTotal) => {
        const now = Date.now();
        // Update in-memory caches so the sections panel + dashboard reflect
        // the new total / recency without a full IDB reload.
        const piece = getActivePiece();
        if (piece && Array.isArray(piece.sections)) {
          const sec = piece.sections.find((s) => s.id === sid);
          if (sec) { sec.totalPracticeMs = newTotal; sec.lastPracticedAt = now; }
        }
        if (queueState && Array.isArray(queueState.sections)) {
          const qsec = queueState.sections.find((s) => s.id === sid);
          if (qsec) { qsec.totalPracticeMs = newTotal; qsec.lastPracticedAt = now; }
        }
        renderSectionsPanel();
        renderStats(); // item 20 — refresh per-piece totals + time tile
        renderContinuePanel(); // refresh "Continue practicing" recency
      }).catch((err) => console.warn('Failed to persist practice time', err));
    }
  }
  stopMetronome(); // item 12b — silence metronome when leaving practice
  if (player) player.stop(); // stop the Synthesia engine + release MIDI input
  if (els.viewerMidi) els.viewerMidi.classList.remove('is-practicing');
  const wasActive = !!practiceState;
  practiceState = null;
  if (els.practicePanel) els.practicePanel.hidden = true;
  if (els.practiceStatus) {
    els.practiceStatus.textContent = '';
    els.practiceStatus.hidden = true;
  }
  if (els.practiceNextReview) {
    els.practiceNextReview.innerHTML = '';
    els.practiceNextReview.hidden = true;
  }
  if (els.practiceRatingPrompt) {
    els.practiceRatingPrompt.hidden = true;
  }
  if (els.practiceRatingButtons) {
    els.practiceRatingButtons.innerHTML = '';
  }
  if (wasActive && !silent) {
    setStatus('Stopped practicing.');
  }
  // Re-render the sections panel so the practicing row drops its highlight
  // and the Practice button re-enables.
  renderSectionsPanel();

  // If a guided review was running and this is a real interruption (the user
  // pressed Stop/Esc while practising — not an internal auto-advance), end the
  // run and drop back to the dashboard. `wasActive` distinguishes the
  // selectPiece-internal close (practiceState already null) from a live stop.
  if (reviewSession && !keepReviewSession && wasActive) {
    endReviewSession({ completed: false });
  }
}

/**
 * Paint the practice panel from `practiceState`. Called after every state
 * change (open, increment, undo, reset, SM-2 fire, IDB reconcile).
 */
function renderPracticePanel() {
  if (!practiceState || !els.practicePanel) return;
  const { count, saving } = practiceState;
  const goalMet = isRepGoalMet(count);
  const section = getActiveSection();
  const scheduledToday =
    !!section && section.lastReviewedDate === practiceState.dateISO;
  const needsRating = goalMet && !scheduledToday;

  if (els.practiceCount) els.practiceCount.textContent = String(count);
  if (els.practiceProgressTrack) {
    els.practiceProgressTrack.setAttribute('aria-valuenow', String(count));
  }
  if (els.practiceProgressFill) {
    const pct = Math.min(100, (count / REP_GOAL) * 100);
    els.practiceProgressFill.style.width = `${pct}%`;
    els.practiceProgressFill.classList.toggle('is-complete', goalMet);
  }

  // Status copy. Once the goal is met, the rating prompt / next-review card
  // carries the message, so keep the status line quiet there.
  if (els.practiceStatus) {
    if (goalMet) {
      els.practiceStatus.hidden = true;
      els.practiceStatus.textContent = '';
    } else if (count === 0) {
      els.practiceStatus.textContent =
        'Play the highlighted notes. Reach the end with zero wrong notes for a clean run — 10 clean runs completes the review.';
      els.practiceStatus.hidden = false;
    } else {
      els.practiceStatus.hidden = true;
      els.practiceStatus.textContent = '';
    }
  }

  // Either the rating prompt OR the next-review card is visible, never both.
  if (needsRating) {
    renderNextReview(null); // hide
    renderRatingPrompt(section);
  } else {
    renderRatingPrompt(null); // hide
    renderNextReview(section);
  }

  if (els.practiceResetBtn) els.practiceResetBtn.disabled = saving || count <= 0;

  // Guided-review banner (shown only during a "Start daily review" run).
  updateReviewSessionBar();
}

/** Find the currently-being-practiced section, or null. */
function getActiveSection() {
  if (!practiceState) return null;
  const piece = getActivePiece();
  if (!piece || !Array.isArray(piece.sections)) return null;
  return piece.sections.find((s) => s.id === practiceState.sectionId) || null;
}

/** Render the SM-2 next-review card inside the practice panel. */
function renderNextReview(section) {
  const el = els.practiceNextReview;
  if (!el) return;
  if (!section || !practiceState) {
    el.hidden = true;
    el.innerHTML = '';
    return;
  }
  const srs = srsStateForSection(section);
  if (!srs.nextDue) {
    el.hidden = true;
    el.innerHTML = '';
    return;
  }
  const todayISO = practiceState.dateISO || localDateISO();
  let daysOff;
  try {
    daysOff = daysBetweenISO(todayISO, srs.nextDue);
  } catch {
    daysOff = null;
  }
  const detail =
    daysOff === null
      ? ''
      : daysOff < 0
      ? `${Math.abs(daysOff)} day${Math.abs(daysOff) === 1 ? '' : 's'} overdue`
      : daysOff === 0
      ? 'due today'
      : daysOff === 1
      ? 'tomorrow'
      : `in ${daysOff} days`;
  const ratedToday = srs.lastReviewedDate === todayISO;
  const label = ratedToday ? 'Scheduled today' : 'Next review';
  // Build the inner DOM by hand (rather than innerHTML with interpolated
  // strings) so a stray section name in `srs` can never inject markup.
  el.innerHTML = '';
  el.hidden = false;
  const labelEl = document.createElement('span');
  labelEl.className = 'practice-next-review-label';
  labelEl.textContent = label;
  el.appendChild(labelEl);
  const dateEl = document.createElement('span');
  dateEl.className = 'practice-next-review-date';
  dateEl.textContent = srs.nextDue;
  el.appendChild(dateEl);
  if (detail) {
    const detailEl = document.createElement('span');
    detailEl.className = 'practice-next-review-detail';
    detailEl.textContent = detail;
    el.appendChild(detailEl);
  }
}

/**
 * Render the post-session rating prompt (item 8). Surfaces the four SM-2
 * ratings (Again / Hard / Good / Easy) once the user has logged 10 reps for
 * the day. Each button shows its projected next-review distance so the user
 * knows what they're committing to ("Again → tomorrow", "Good → in 6d").
 *
 * Pass `null` to hide the prompt. Re-rendered on every panel paint so the
 * disabled state stays in sync with `practiceState.ratingInFlight`.
 */
function renderRatingPrompt(section) {
  const panel = els.practiceRatingPrompt;
  const buttonsHost = els.practiceRatingButtons;
  if (!panel || !buttonsHost) return;
  if (!section || !practiceState) {
    panel.hidden = true;
    buttonsHost.innerHTML = '';
    return;
  }

  const todayISO = practiceState.dateISO || localDateISO();
  const cur = srsStateForSection(section);
  let outcomes;
  try {
    outcomes = previewSm2Outcomes(cur, todayISO);
  } catch (err) {
    // If the projection blows up (shouldn't, but defensive), hide the prompt
    // rather than render a broken UI.
    console.warn('Could not project SM-2 outcomes for rating prompt', err);
    panel.hidden = true;
    buttonsHost.innerHTML = '';
    return;
  }

  panel.hidden = false;
  buttonsHost.innerHTML = '';
  const inFlight = !!practiceState.ratingInFlight;

  for (const outcome of outcomes) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `practice-rating-btn practice-rating-btn-${outcome.label.toLowerCase()}`;
    btn.dataset.rating = String(outcome.rating);
    if (outcome.rating === RATING_GOOD) {
      btn.classList.add('is-default');
      btn.autofocus = true;
    }
    btn.disabled = inFlight;

    const name = document.createElement('span');
    name.className = 'practice-rating-btn-name';
    name.textContent = outcome.label;
    btn.appendChild(name);

    const detail = document.createElement('span');
    detail.className = 'practice-rating-btn-detail';
    detail.textContent = formatRatingDetail(outcome);
    btn.appendChild(detail);

    btn.title = `${outcome.label} — next review ${outcome.nextDue}`;
    btn.addEventListener('click', () =>
      handleRatingClick(outcome.rating, outcome.label),
    );
    buttonsHost.appendChild(btn);
  }
}

/**
 * Glanceable next-review distance for a rating button.
 * "tomorrow" / "in 6d" / "today" — never the raw ISO date (that's in the
 * tooltip). Pure-ish: depends only on the outcome's `daysOff`.
 */
function formatRatingDetail(outcome) {
  if (!outcome || typeof outcome.daysOff !== 'number') return '';
  if (outcome.daysOff <= 0) return 'today';
  if (outcome.daysOff === 1) return 'tomorrow';
  return `in ${outcome.daysOff}d`;
}

/**
 * Click a rating button: persist the chosen quality through SM-2 and update
 * the section. Disables the rating buttons while in flight so a second click
 * can't double-fire. The rating itself is final — there's no undo for it
 * (matches the design rule that Reset/Undo on rep counts don't roll back the
 * SRS schedule).
 */
async function handleRatingClick(quality, label) {
  if (!practiceState) return;
  if (practiceState.ratingInFlight) return;
  if (!isRepGoalMet(practiceState.count)) return; // belt-and-braces guard

  const { sectionId, dateISO } = practiceState;
  practiceState.ratingInFlight = true;
  // Re-render so all four buttons disable immediately (visual feedback).
  renderPracticePanel();

  try {
    await fireSm2WithRating(sectionId, dateISO, quality, label);
  } finally {
    if (practiceState && practiceState.sectionId === sectionId) {
      practiceState.ratingInFlight = false;
    }
    renderPracticePanel();
    renderSectionsPanel();
    renderReviewQueue();
    // Sections-mastered may have just ticked up if the rating bumped the
    // section's interval over the 21-day mastery floor.
    renderStats();
  }

  // Guided review: once the rating is committed (the section is scheduled for
  // today), roll on to the next due section automatically.
  if (reviewSession) {
    const sec = getActiveSection();
    if (sec && sec.lastReviewedDate === dateISO) {
      await advanceReviewSession();
    }
  }
}

/** Handle a click of the big "Successful repetition" button. */
/**
 * Apply SM-2 with the user-chosen rating and persist the updated schedule
 * onto the section record. Called from the post-session rating prompt
 * (item 8) — no longer auto-fired with a hard-coded Good.
 *
 * Idempotent across same-day re-fires thanks to the `lastReviewedDate`
 * guard: clicking another rating after a successful save is a no-op. (The
 * rating prompt UI hides itself after a successful click anyway, so the
 * guard is mostly belt-and-braces against a stale call.)
 *
 * Failures are non-fatal — the rep itself is already logged; the status
 * line surfaces the schedule-save error and the rating prompt stays up so
 * the user can retry.
 */
async function fireSm2WithRating(sectionId, dateISO, quality, label) {
  const piece = getActivePiece();
  if (!piece || !Array.isArray(piece.sections)) return;
  const section = piece.sections.find((s) => s.id === sectionId);
  if (!section) return;

  const cur = srsStateForSection(section);
  if (cur.lastReviewedDate === dateISO) {
    // Already scheduled today — keep the existing schedule. Surfacing the
    // existing `nextDue` is handled by renderNextReview off the section.
    return;
  }

  const next = applySm2(cur, quality, dateISO);
  const updated = {
    ...section,
    repetitions: next.repetitions,
    interval: next.interval,
    ease: next.ease,
    nextDue: next.nextDue,
    lastReviewedDate: next.lastReviewedDate,
  };

  try {
    await saveSection(sectionToRecord(updated));
  } catch (err) {
    console.error('Failed to save SM-2 schedule', err);
    setStatus(`Logged reps, but couldn't save next-review date: ${err.message || err}`);
    return;
  }

  // Mutate the in-memory section in place so renderPracticePanel /
  // renderSectionsPanel pick up the new fields without an extra round-trip.
  const i = piece.sections.findIndex((s) => s.id === sectionId);
  if (i >= 0) piece.sections[i] = updated;
  // Mirror the schedule update into the queue snapshot so subsequent
  // renders see the freshly-scheduled section without an IDB walk.
  upsertQueueSection(updated);

  // Surface the result. "Again" specifically schedules tomorrow even though
  // it's a lapse — surface that explicitly so the user understands the
  // section will reappear in tomorrow's queue.
  const ratingLabel = label || ratingLabelFor(quality);
  setStatus(
    `Rated "${section.name}" as ${ratingLabel} — ${describeNextDue(next.nextDue, dateISO)}.`,
  );
}

/** Lookup table for human-readable rating labels (fallback path). */
function ratingLabelFor(quality) {
  if (quality === RATING_AGAIN) return 'Again';
  if (quality === RATING_HARD) return 'Hard';
  if (quality === RATING_GOOD) return 'Good';
  if (quality === RATING_EASY) return 'Easy';
  return 'rated';
}

/** Reset today's clean-run count to zero (after a confirm prompt). */
async function handleResetReps() {
  if (!practiceState) return;
  const { sectionId, dateISO, count } = practiceState;
  if (count <= 0) return;
  const ok = window.confirm(
    `Reset today's clean-run count for this section back to 0? You'll have to re-play them.`,
  );
  if (!ok) return;

  practiceState.saving = true;
  practiceState.count = 0;
  repCountsToday.set(sectionId, 0);
  if (player) { player.resetCleanRunCount(); player.setRunIndex(0); player.restartRun(true); }
  renderPracticePanel();

  try {
    await setRepLogCount(sectionId, dateISO, 0);
    setQueueRepCount(sectionId, 0);
    setStatus('Reset today’s rep count.');
  } catch (err) {
    console.error('Failed to reset reps', err);
    if (
      practiceState &&
      practiceState.sectionId === sectionId &&
      practiceState.dateISO === dateISO
    ) {
      practiceState.count = count;
      repCountsToday.set(sectionId, count);
    }
    setStatus(`Couldn't reset reps: ${err.message || err}`);
  } finally {
    if (practiceState) practiceState.saving = false;
    renderPracticePanel();
    renderSectionsPanel();
    renderReviewQueue();
    renderStats();
  }
}

// --- Daily review queue (item 7) ----------------------------------------

/**
 * Hydrate the cross-piece review queue from IDB. Walks every section in the
 * sections store and joins against today's rep logs. Cheap because both
 * stores are tiny — sections are small records, today's rep logs are at
 * most one record per section the user has touched today.
 *
 * Failures are non-fatal: the welcome card still works, and the queue panel
 * just stays hidden. The review queue is a productivity affordance — not a
 * showstopper if storage is being weird.
 */
async function refreshReviewQueue() {
  const dateISO = localDateISO();
  try {
    const [allSections, countsByDate] = await Promise.all([
      listAllSections(),
      getRepCountsForDate(dateISO),
    ]);
    const pieceTitleById = new Map();
    for (const p of pieces) {
      pieceTitleById.set(p.id, {
        id: p.id,
        title: p.title,
        noteCount: p.noteCount,
      });
    }
    queueState = {
      dateISO,
      sections: allSections,
      pieceTitleById,
      countsByDate,
    };
  } catch (err) {
    console.warn('Could not hydrate review queue', err);
    queueState = {
      dateISO,
      sections: [],
      pieceTitleById: new Map(),
      countsByDate: new Map(),
    };
  }
  renderReviewQueue();
}

/**
 * Apply a local rep-count delta to the queue's in-memory snapshot so the
 * queue can re-render without a fresh IDB walk on every increment.
 */
function setQueueRepCount(sectionId, count) {
  if (!queueState) return;
  if (typeof count === 'number' && count > 0) {
    queueState.countsByDate.set(sectionId, count);
  } else {
    queueState.countsByDate.delete(sectionId);
  }
}

/**
 * Replace the in-memory snapshot of a section inside `queueState.sections`
 * (or append it). Used so that an in-session SM-2 update or an Edit-section
 * save shows up in the queue immediately, without re-walking IDB.
 */
function upsertQueueSection(updatedSection) {
  if (!queueState || !updatedSection || !updatedSection.id) return;
  const i = queueState.sections.findIndex((s) => s.id === updatedSection.id);
  if (i >= 0) queueState.sections[i] = { ...updatedSection };
  else queueState.sections.push({ ...updatedSection });
}

/** Drop a section from the queue snapshot (e.g. on delete). */
function removeQueueSection(sectionId) {
  if (!queueState || !sectionId) return;
  queueState.sections = queueState.sections.filter((s) => s.id !== sectionId);
  queueState.countsByDate.delete(sectionId);
}

/** Render the queue panel from `queueState`. Hides the panel if empty. */
function renderReviewQueue() {
  const panel = els.reviewQueuePanel;
  const list = els.reviewQueueList;
  const countEl = els.reviewQueueCount;
  if (!panel || !list) return;

  if (!queueState) {
    panel.hidden = true;
    list.innerHTML = '';
    if (countEl) countEl.textContent = '';
    return;
  }

  // `currentQueueItems` refreshes the piece-title map from the live `pieces`
  // array, so a newly-uploaded or renamed piece doesn't show "(unknown piece)".
  const items = currentQueueItems();

  list.innerHTML = '';
  if (items.length === 0) {
    panel.hidden = true;
    if (countEl) countEl.textContent = '';
    return;
  }

  panel.hidden = false;
  if (countEl) {
    countEl.textContent =
      items.length === 1 ? '1 section' : `${items.length} sections`;
  }

  // Overdue callout — sections past their scheduled date, surfaced distinctly
  // from "due today" so a backlog reads as urgent rather than blending in.
  if (els.reviewQueueOverdue) {
    const overdue = items.filter((it) => it.daysOff < 0).length;
    if (overdue > 0) {
      els.reviewQueueOverdue.hidden = false;
      els.reviewQueueOverdue.textContent = `⚠ ${overdue} overdue`;
      els.reviewQueueOverdue.title = `${overdue} section${
        overdue === 1 ? '' : 's'
      } past the scheduled review date`;
    } else {
      els.reviewQueueOverdue.hidden = true;
      els.reviewQueueOverdue.textContent = '';
    }
  }
  // Start-review button: enabled whenever there's something to review.
  if (els.startReviewBtn) {
    els.startReviewBtn.disabled = queueClickInFlight;
    els.startReviewBtn.textContent = `▶ Start daily review (${items.length})`;
  }

  for (const item of items) {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'review-queue-item';
    btn.dataset.sectionId = item.section.id;
    btn.dataset.pieceId = item.piece.id || '';
    btn.disabled = queueClickInFlight;

    const top = document.createElement('div');
    top.className = 'review-queue-item-top';

    const name = document.createElement('span');
    name.className = 'review-queue-item-name';
    name.textContent = item.section.name || '(unnamed section)';
    top.appendChild(name);

    const due = document.createElement('span');
    due.className = 'review-queue-item-due';
    if (item.daysOff < 0) {
      due.classList.add('is-overdue');
      const n = Math.abs(item.daysOff);
      due.textContent = `${n}d overdue`;
    } else if (item.daysOff === 0) {
      due.classList.add('is-due-today');
      due.textContent = 'Due today';
    } else {
      // shouldn't appear (queue filters to daysOff <= 0) but guarded anyway
      due.textContent = `In ${item.daysOff}d`;
    }
    due.title = `Next review: ${item.nextDue}`;
    top.appendChild(due);

    btn.appendChild(top);

    const meta = document.createElement('div');
    meta.className = 'review-queue-item-meta';

    const pieceTitle = document.createElement('span');
    pieceTitle.textContent = item.piece.title || '(unknown piece)';
    meta.appendChild(pieceTitle);

    const loc = document.createElement('span');
    loc.textContent = formatSectionMeta(item.section);
    meta.appendChild(loc);

    if (item.repCount > 0) {
      const progress = document.createElement('span');
      progress.className = 'review-queue-item-progress';
      progress.textContent = `${item.repCount}/${REP_GOAL} today`;
      meta.appendChild(progress);
    }

    btn.appendChild(meta);

    btn.addEventListener('click', () => handleReviewQueueClick(item));

    li.appendChild(btn);
    list.appendChild(li);
  }
}

/**
 * Click a queue item: bring the corresponding piece into view, open the
 * practice panel for the section, and scroll to its page. Idempotent — if
 * the user clicks twice while the PDF is loading, the second click is
 * suppressed by `queueClickInFlight`.
 */
async function handleReviewQueueClick(item) {
  if (queueClickInFlight) return;
  if (!item || !item.section || !item.piece) return;
  queueClickInFlight = true;
  renderReviewQueue(); // re-paint disabled state on the buttons

  try {
    if (activePieceId !== item.piece.id) {
      // selectPiece does its own ensurePdfLoaded + section hydration in the
      // background; we then poll briefly until the section is in memory.
      await selectPiece(item.piece.id);
    }
    // Wait up to ~2.5s for the lazy section list to populate (selectPiece
    // kicks off ensureSectionsLoaded asynchronously). In practice it
    // resolves in <100ms for any realistic library.
    const target = await waitForSection(item.piece.id, item.section.id, 2500);
    if (!target) {
      setStatus(
        `Couldn't open "${item.section.name}" — its piece may be missing.`,
      );
      return;
    }
    await openPracticeView(item.section.id);
  } catch (err) {
    console.error('Failed to jump from review queue', err);
    setStatus(`Couldn't open section: ${err.message || err}`);
  } finally {
    queueClickInFlight = false;
    renderReviewQueue();
  }
}

// --- Progress stats (item 9) --------------------------------------------

/**
 * Hydrate the cross-library stats snapshot. Reads the distinct set of
 * practice dates (powering the daily-streak count) and stamps `dateISO` so
 * the render can re-run later in the day without an extra IDB walk.
 *
 * Failures are non-fatal — the stats panel just stays hidden. The progress
 * panel is a motivational affordance, not a showstopper.
 */
async function refreshStats() {
  const dateISO = localDateISO();
  try {
    const dates = await listDistinctPracticeDates();
    statsState = {
      practiceDates: new Set(dates),
      dateISO,
    };
  } catch (err) {
    console.warn('Could not hydrate practice-date history for stats', err);
    statsState = {
      practiceDates: new Set(),
      dateISO,
    };
  }
  renderStats();
  // Non-blocking: load and render the practice-history heatmap.
  refreshHistoryChart().catch((err) =>
    console.warn('History chart refresh failed', err),
  );
}

/**
 * Mark today as a practice day in the in-memory stats snapshot. Keeps the
 * daily-streak count fresh after a rep click without an extra IDB walk —
 * the only "new fact" a rep introduces to the streak math is "we now have
 * a rep on `dateISO`".
 */
function noteRepLogActivity(dateISO) {
  if (!statsState) return;
  if (typeof dateISO === 'string' && dateISO) {
    statsState.practiceDates.add(dateISO);
  }
}

/** Render the stats panel from `statsState` + the live queue + piece data. */
/**
 * Compute total practice time (ms) for a piece by summing its sections'
 * totalPracticeMs. Uses the in-memory piece.sections cache.
 */
function computePieceTotalTime(pieceId) {
  const piece = pieces.find((p) => p.id === pieceId);
  if (!piece || !Array.isArray(piece.sections)) return 0;
  let total = 0;
  for (const sec of piece.sections) {
    if (sec.totalPracticeMs) total += sec.totalPracticeMs;
  }
  return total;
}

function renderStats() {
  const panel = els.statsPanel;
  if (!panel) return;

  // We need queue data too — sections (across the library), today's rep
  // counts. If the queue hasn't hydrated yet (rare race on cold start),
  // hide the stats panel entirely so we don't briefly show a wall of zeros.
  if (!queueState || !statsState) {
    panel.hidden = true;
    return;
  }
  const sections = Array.isArray(queueState.sections) ? queueState.sections : [];
  if (sections.length === 0) {
    // Brand-new library — stats are all zero. Hiding here matches the
    // empty-state policy of the queue panel: don't show a misleading panel
    // until the user has something to be proud of.
    panel.hidden = true;
    return;
  }

  const todayISO = statsState.dateISO || localDateISO();
  let summary;
  try {
    summary = summariseProgress({
      sections,
      pieces,
      practiceDates: statsState.practiceDates,
      repCountsToday: queueState.countsByDate,
      todayISO,
      repGoal: REP_GOAL,
    });
  } catch (err) {
    console.warn('Could not compute progress summary', err);
    panel.hidden = true;
    return;
  }

  panel.hidden = false;
  // Stash for the daily-goal controls so they can recompute without a re-walk.
  lastStatsSummary = summary;

  // Today's done-of-due line in the panel header.
  if (els.statsPanelToday) {
    if (summary.todayDueCount > 0) {
      els.statsPanelToday.textContent =
        `${summary.todayDoneCount} / ${summary.todayDueCount} done today`;
      els.statsPanelToday.classList.toggle(
        'is-complete',
        summary.todayDoneCount >= summary.todayDueCount,
      );
    } else if (summary.todayDoneCount > 0) {
      // Nothing was due today, but the user practiced anyway. Surface that
      // explicitly so a "0 / 0 done" header doesn't read as "I did nothing".
      els.statsPanelToday.textContent = `${summary.todayDoneCount} done today`;
      els.statsPanelToday.classList.add('is-complete');
    } else {
      els.statsPanelToday.textContent = 'Nothing due today';
      els.statsPanelToday.classList.remove('is-complete');
    }
  }

  // Streak tile.
  if (els.statsStreakValue) {
    els.statsStreakValue.textContent = String(summary.dailyStreak);
  }
  if (els.statsStreakDetail) {
    // Personal best (longest streak ever) shown alongside the live streak so a
    // broken streak still displays the high-water mark to chase.
    let longest = 0;
    try {
      longest = computeLongestStreak(statsState.practiceDates);
    } catch (_) {
      longest = 0;
    }
    const best = longest > 1 ? ` Best: ${longest}.` : '';
    if (summary.dailyStreak === 0) {
      els.statsStreakDetail.textContent =
        sections.length > 0
          ? `Start a session to begin a streak.${best}`
          : '';
    } else if (summary.dailyStreak === 1) {
      els.statsStreakDetail.textContent = `Day one — keep it going.${best}`;
    } else {
      els.statsStreakDetail.textContent =
        `${summary.dailyStreak} days in a row.${best}`;
    }
  }

  // Sections-mastered tile.
  if (els.statsMasteredValue) {
    els.statsMasteredValue.textContent = String(summary.sectionsMastered);
  }
  if (els.statsMasteredDetail) {
    if (summary.sectionsTotal === 0) {
      els.statsMasteredDetail.textContent = '';
    } else {
      const pct = Math.round(
        (summary.sectionsMastered / summary.sectionsTotal) * 100,
      );
      els.statsMasteredDetail.textContent =
        `${pct}% of ${summary.sectionsTotal} section${summary.sectionsTotal === 1 ? '' : 's'}.`;
    }
  }

  // Sections-rated tile (sections with at least one SM-2 rating recorded).
  if (els.statsRatedValue) {
    els.statsRatedValue.textContent = String(summary.sectionsRated);
  }
  if (els.statsRatedDetail) {
    const unrated = Math.max(0, summary.sectionsTotal - summary.sectionsRated);
    if (unrated === 0 && summary.sectionsRated === 0) {
      els.statsRatedDetail.textContent = '';
    } else if (unrated === 0) {
      els.statsRatedDetail.textContent = 'Every section has a schedule.';
    } else {
      els.statsRatedDetail.textContent =
        `${unrated} unrated waiting in the wings.`;
    }
  }

  // Time-invested tile — total practice time across the whole library. Summed
  // from the cross-library section snapshot (not the lazily-loaded per-piece
  // caches) so it's accurate even for pieces not opened this session.
  if (els.statsTimeValue) {
    let totalMs = 0;
    let practiced = 0;
    for (const s of sections) {
      const ms = s && typeof s.totalPracticeMs === 'number' ? s.totalPracticeMs : 0;
      if (ms > 0) {
        totalMs += ms;
        practiced += 1;
      }
    }
    els.statsTimeValue.textContent =
      totalMs > 0 ? formatTotalPracticeTime(totalMs) : '0m';
    if (els.statsTimeDetail) {
      els.statsTimeDetail.textContent =
        practiced > 0
          ? `Across ${practiced} section${practiced === 1 ? '' : 's'}.`
          : 'Practice to start the clock.';
    }
  }

  // Home-dashboard extras: goal ring, recall-maturity bar, due-soon forecast.
  renderGoalRing(summary);
  renderMemoryDistribution(sections);
  renderForecast(sections, todayISO);

  // Per-piece retention list.
  if (els.statsPerPiece && els.statsPerPieceList) {
    const list = els.statsPerPieceList;
    list.innerHTML = '';
    const visible = summary.perPiece.filter((p) => p.sectionsTotal > 0);
    if (visible.length === 0) {
      els.statsPerPiece.hidden = true;
    } else {
      els.statsPerPiece.hidden = false;
      for (const p of visible) {
        const li = document.createElement('li');
        li.className = 'stats-per-piece-row';
        li.dataset.pieceId = p.pieceId;

        const titleEl = document.createElement('span');
        titleEl.className = 'stats-per-piece-title-cell';
        titleEl.textContent = p.title;
        titleEl.title =
          `${p.sectionsMastered} of ${p.sectionsTotal} sections mastered`;
        li.appendChild(titleEl);

        const bar = document.createElement('span');
        bar.className = 'stats-per-piece-bar';
        bar.setAttribute('role', 'progressbar');
        bar.setAttribute('aria-valuemin', '0');
        bar.setAttribute('aria-valuemax', '100');
        bar.setAttribute('aria-valuenow', String(p.masteryPct));
        const fill = document.createElement('span');
        fill.className = 'stats-per-piece-bar-fill';
        fill.style.width = `${p.masteryPct}%`;
        bar.appendChild(fill);
        li.appendChild(bar);

        const pct = document.createElement('span');
        pct.className = 'stats-per-piece-pct';
        pct.textContent = `${p.masteryPct}%`;
        li.appendChild(pct);

        // Item 20 — per-piece total practice time.
        const pieceTime = document.createElement('span');
        pieceTime.className = 'stats-per-piece-time';
        const pieceTotalMs = computePieceTotalTime(p.pieceId);
        pieceTime.textContent = pieceTotalMs > 0
          ? formatTotalPracticeTime(pieceTotalMs)
          : '—';
        pieceTime.title = pieceTotalMs > 0
          ? `Total practice time: ${formatTotalPracticeTime(pieceTotalMs)}`
          : 'No practice time recorded';
        li.appendChild(pieceTime);

        list.appendChild(li);
      }
    }
  }
}

// --- Daily goal ring (home dashboard) ------------------------------------

/** Read the persisted daily goal: a positive int, or null for "Auto". */
function readDailyGoal() {
  try {
    const v = localStorage.getItem(DAILY_GOAL_KEY);
    if (v === null || v === 'auto') return null;
    const n = parseInt(v, 10);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch (_) {
    return null;
  }
}

/** Persist the daily goal (null → "auto"). Best-effort. */
function writeDailyGoal(goal) {
  try {
    localStorage.setItem(DAILY_GOAL_KEY, goal == null ? 'auto' : String(goal));
  } catch (_) {
    // localStorage unavailable — the goal just won't persist.
  }
}

/**
 * Effective ring denominator for today: the explicit goal if set, otherwise
 * "Auto" tracks whatever is due today (floored at 1 so the ring is sensible).
 */
function effectiveGoalTarget(summary) {
  if (dailyGoal != null) return dailyGoal;
  const due =
    summary && typeof summary.todayDueCount === 'number'
      ? summary.todayDueCount
      : 0;
  return Math.max(due, 1);
}

/** Nudge the daily goal up/down. Dropping below 1 reverts to "Auto". */
function adjustDailyGoal(delta) {
  const base =
    dailyGoal != null
      ? dailyGoal
      : effectiveGoalTarget(lastStatsSummary || {});
  let next = base + delta;
  if (next < 1) next = null; // back to Auto
  if (next != null && next > 99) next = 99;
  dailyGoal = next;
  writeDailyGoal(next);
  renderStats();
}

/** Ring circumference (r=20): 2π·20 — matches the CSS stroke-dasharray. */
const GOAL_RING_CIRCUMFERENCE = 2 * Math.PI * 20;

/** Paint the daily-goal completion ring from today's done / target. */
function renderGoalRing(summary) {
  if (!els.statsGoal) return;
  els.statsGoal.hidden = false;
  const done =
    summary && typeof summary.todayDoneCount === 'number'
      ? summary.todayDoneCount
      : 0;
  const target = effectiveGoalTarget(summary);
  const frac = target > 0 ? Math.min(1, done / target) : 0;
  const complete = target > 0 && done >= target;

  if (els.statsGoalRingFill) {
    els.statsGoalRingFill.style.strokeDashoffset = String(
      GOAL_RING_CIRCUMFERENCE * (1 - frac),
    );
    els.statsGoalRingFill.classList.toggle('is-complete', complete);
  }
  if (els.statsGoalRingLabel) {
    els.statsGoalRingLabel.textContent = `${Math.round(frac * 100)}%`;
  }
  if (els.statsGoalDone) els.statsGoalDone.textContent = String(done);
  if (els.statsGoalTarget) els.statsGoalTarget.textContent = String(target);
  if (els.statsGoalValue) {
    els.statsGoalValue.textContent =
      dailyGoal == null ? 'Auto' : String(dailyGoal);
  }
}

// --- Recall-maturity distribution (home dashboard) -----------------------

/** Paint the memory-stage distribution bar + legend from the section set. */
function renderMemoryDistribution(sections) {
  const wrap = els.statsMemory;
  if (!wrap) return;
  let dist;
  try {
    dist = memoryStageDistribution(sections);
  } catch (err) {
    console.warn('Could not compute memory distribution', err);
    wrap.hidden = true;
    return;
  }
  if (!dist || dist.total === 0) {
    wrap.hidden = true;
    return;
  }
  wrap.hidden = false;

  if (els.statsMemoryBar) {
    els.statsMemoryBar.innerHTML = '';
    els.statsMemoryBar.setAttribute(
      'aria-label',
      'Recall maturity: ' +
        dist.stages.map((s) => `${s.label} ${s.count}`).join(', '),
    );
    for (const s of dist.stages) {
      if (s.count <= 0) continue;
      const seg = document.createElement('div');
      seg.className = 'stats-memory-seg';
      seg.dataset.stage = String(s.stage);
      seg.style.flexGrow = String(s.count);
      seg.title = `${s.label}: ${s.count} section${s.count === 1 ? '' : 's'}`;
      els.statsMemoryBar.appendChild(seg);
    }
  }

  if (els.statsMemoryLegend) {
    els.statsMemoryLegend.innerHTML = '';
    for (const s of dist.stages) {
      const li = document.createElement('li');
      li.title = s.hint;
      const sw = document.createElement('span');
      sw.className = 'stats-memory-swatch';
      sw.dataset.stage = String(s.stage);
      li.appendChild(sw);
      const txt = document.createElement('span');
      const b = document.createElement('b');
      b.textContent = String(s.count);
      txt.appendChild(b);
      txt.appendChild(document.createTextNode(` ${s.label}`));
      li.appendChild(txt);
      els.statsMemoryLegend.appendChild(li);
    }
  }
}

// --- Due-soon forecast (home dashboard) ----------------------------------

/** Days shown in the due-soon forecast strip. */
const FORECAST_DAYS = 7;

/** Short weekday label ("Mon".."Sun") for a YYYY-MM-DD date (local). */
function weekdayLabel(dateISO) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateISO);
  if (!m) return '';
  const dt = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][dt.getDay()];
}

/** Paint the due-soon forecast bar strip from the section schedule. */
function renderForecast(sections, todayISO) {
  const wrap = els.statsForecast;
  const host = els.statsForecastBars;
  if (!wrap || !host) return;
  let buckets;
  try {
    buckets = dueForecast({ sections, todayISO, days: FORECAST_DAYS });
  } catch (err) {
    console.warn('Could not compute due forecast', err);
    wrap.hidden = true;
    return;
  }
  const totalDue = buckets.reduce((sum, b) => sum + b.count, 0);
  if (totalDue === 0) {
    // Nothing scheduled in the window — hide rather than show an empty strip.
    wrap.hidden = true;
    return;
  }
  wrap.hidden = false;
  const max = Math.max(1, ...buckets.map((b) => b.count));

  host.innerHTML = '';
  buckets.forEach((b, i) => {
    const col = document.createElement('div');
    col.className = 'stats-forecast-col';
    if (i === 0) col.classList.add('is-today');
    if (b.count === 0) col.classList.add('is-empty');

    const count = document.createElement('span');
    count.className = 'stats-forecast-count';
    count.textContent = b.count > 0 ? String(b.count) : '';
    col.appendChild(count);

    const track = document.createElement('div');
    track.className = 'stats-forecast-track';
    const bar = document.createElement('div');
    bar.className = 'stats-forecast-bar';
    // Bars scale to the busiest day; a floor keeps small bars visible.
    const pct = b.count > 0 ? Math.max(8, Math.round((b.count / max) * 100)) : 0;
    bar.style.height = b.count > 0 ? `${pct}%` : '3px';
    track.appendChild(bar);
    col.appendChild(track);

    const day = document.createElement('span');
    day.className = 'stats-forecast-day';
    day.textContent = i === 0 ? 'Today' : weekdayLabel(b.dateISO);
    col.appendChild(day);

    col.title = `${b.count} section${b.count === 1 ? '' : 's'} due ${
      i === 0 ? 'today' : `on ${b.dateISO}`
    }`;
    host.appendChild(col);
  });
}

// --- Continue practicing (home dashboard) --------------------------------

/** How many recently-practiced sections to surface for one-tap resume. */
const CONTINUE_LIMIT = 4;

/**
 * Render the "Continue practicing" list — the most recently practiced
 * sections (by `lastPracticedAt`), each a one-tap resume into practice.
 * Reads the cross-library section snapshot so it spans every piece.
 */
function renderContinuePanel() {
  const panel = els.continuePanel;
  const list = els.continueList;
  if (!panel || !list) return;
  if (!queueState || !Array.isArray(queueState.sections)) {
    panel.hidden = true;
    return;
  }
  // Keep the piece-title lookup fresh (renames / new pieces).
  for (const p of pieces) {
    queueState.pieceTitleById.set(p.id, { id: p.id, title: p.title });
  }
  const recent = queueState.sections
    .filter(
      (s) =>
        s && typeof s.lastPracticedAt === 'number' && s.lastPracticedAt > 0,
    )
    .sort((a, b) => b.lastPracticedAt - a.lastPracticedAt)
    .slice(0, CONTINUE_LIMIT);

  if (recent.length === 0) {
    panel.hidden = true;
    list.innerHTML = '';
    return;
  }
  panel.hidden = false;
  list.innerHTML = '';

  for (const section of recent) {
    const pieceMeta = queueState.pieceTitleById.get(section.pieceId) || {
      id: section.pieceId,
      title: '(unknown piece)',
    };
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'continue-item';
    btn.disabled = queueClickInFlight;

    const info = document.createElement('div');
    info.className = 'continue-item-info';
    const name = document.createElement('span');
    name.className = 'continue-item-name';
    name.textContent = section.name || '(unnamed section)';
    info.appendChild(name);
    const meta = document.createElement('span');
    meta.className = 'continue-item-meta';
    meta.textContent = pieceMeta.title || '(unknown piece)';
    info.appendChild(meta);
    btn.appendChild(info);

    const when = document.createElement('span');
    when.className = 'continue-item-when';
    when.textContent = formatRelativeTime(section.lastPracticedAt);
    btn.appendChild(when);

    btn.addEventListener('click', () =>
      handleReviewQueueClick({
        section,
        piece: { id: section.pieceId, title: pieceMeta.title },
      }),
    );
    li.appendChild(btn);
    list.appendChild(li);
  }
}

/** Human "time ago" for a past epoch-ms timestamp (coarse buckets). */
function formatRelativeTime(ms) {
  const diff = Date.now() - ms;
  if (!Number.isFinite(diff) || diff < 0) return 'just now';
  const min = Math.floor(diff / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const days = Math.floor(hr / 24);
  if (days < 7) return `${days}d ago`;
  const weeks = Math.floor(days / 7);
  if (weeks < 5) return `${weeks}w ago`;
  const months = Math.floor(days / 30);
  return `${months}mo ago`;
}

// --- Guided daily review session (home dashboard) ------------------------

/**
 * Build the current due-today queue items from the live snapshot. Shared by
 * the queue render, the overdue callout, and the guided-review launcher so
 * they always agree.
 */
function currentQueueItems() {
  if (!queueState) return [];
  for (const p of pieces) {
    queueState.pieceTitleById.set(p.id, {
      id: p.id,
      title: p.title,
      pageCount: p.pageCount,
    });
  }
  return buildReviewQueue({
    sections: queueState.sections,
    piecesById: queueState.pieceTitleById,
    repCountsToday: queueState.countsByDate,
    todayISO: queueState.dateISO,
    repGoal: REP_GOAL,
  });
}

/**
 * Start a guided run through everything due today: open the first due
 * section, and auto-advance to the next as each is rated (or skipped).
 */
function startDailyReview() {
  const items = currentQueueItems();
  if (items.length === 0) return;
  reviewSession = { items, index: 0 };
  setStatus(
    `Daily review — ${items.length} section${items.length === 1 ? '' : 's'} to go.`,
  );
  handleReviewQueueClick(items[reviewSession.index]);
}

/**
 * Advance the guided review to the next section. Persists the current
 * session's time (via closePracticeView, keeping review mode) then opens the
 * next item — or finishes if we've reached the end of the run.
 */
async function advanceReviewSession() {
  const sess = reviewSession;
  if (!sess) return;
  closePracticeView({ silent: true, keepReviewSession: true });
  sess.index += 1;
  if (sess.index >= sess.items.length) {
    endReviewSession({ completed: true });
    return;
  }
  await handleReviewQueueClick(sess.items[sess.index]);
}

/** End the guided review and return to the dashboard. */
function endReviewSession({ completed } = {}) {
  const wasRunning = !!reviewSession;
  reviewSession = null;
  if (els.reviewSessionBar) els.reviewSessionBar.hidden = true;
  if (wasRunning) showDashboard();
  if (completed) {
    setStatus('Daily review complete — every due section is done. 🎉');
  }
}

/** Return from a piece view to the home dashboard and refresh its panels. */
function showDashboard() {
  activePieceId = null;
  renderPieceList(pieces);
  if (els.viewerMidi) {
    els.viewerMidi.hidden = true;
    els.viewerMidi.classList.remove('is-practicing');
  }
  if (els.viewerPlaceholder) els.viewerPlaceholder.hidden = false;
  renderReviewQueue();
  renderStats();
  renderContinuePanel();
}

/** Paint the guided-review banner inside the practice panel. */
function updateReviewSessionBar() {
  const bar = els.reviewSessionBar;
  if (!bar) return;
  if (!reviewSession || !practiceState) {
    bar.hidden = true;
    return;
  }
  bar.hidden = false;
  if (els.reviewSessionProgress) {
    const pos = reviewSession.index + 1;
    const total = reviewSession.items.length;
    els.reviewSessionProgress.textContent = `Daily review · ${pos} of ${total}`;
  }
}

// --- Practice history chart (item 12c) -----------------------------------

/**
 * Build and render a GitHub-style contribution heatmap of the user's practice
 * activity over the last ~13 weeks (91 days). Each cell is one calendar day;
 * the fill intensity maps to total rep count that day (across all sections).
 *
 * Data source: `listAllRepLogs()` returns every rep log record in the DB.
 * We aggregate by dateISO → total count, then bucket into 5 intensity levels
 * (0 = no practice, 1–4 = quartiles of the observed distribution).
 *
 * The SVG is built with vanilla DOM createElement calls (no innerHTML) so it's
 * safe and fast. Month labels sit above the grid; day-of-week labels on the
 * left. The chart scrolls horizontally on narrow viewports.
 */
async function refreshHistoryChart() {
  const container = els.statsHistoryChartContainer;
  const wrapper = els.statsHistoryChart;
  if (!container || !wrapper) return;

  let repLogs;
  try {
    repLogs = await listAllRepLogs();
  } catch (err) {
    console.warn('Could not load rep logs for history chart', err);
    wrapper.hidden = true;
    return;
  }

  // If there are no rep logs at all, hide the chart.
  if (!repLogs || repLogs.length === 0) {
    wrapper.hidden = true;
    return;
  }

  // Aggregate rep counts per date.
  const countByDate = new Map();
  for (const log of repLogs) {
    const d = log.dateISO;
    countByDate.set(d, (countByDate.get(d) || 0) + (log.count || 0));
  }

  renderHeatmap(container, countByDate);
  wrapper.hidden = false;
}

/**
 * Pure-ish rendering: given a Map<dateISO, totalReps>, build the SVG heatmap
 * and replace the container's children.
 */
function renderHeatmap(container, countByDate) {
  const CELL = 13;
  const GAP = 3;
  const STEP = CELL + GAP;
  const WEEKS = 13; // ~91 days
  const ROWS = 7;   // Mon–Sun
  const LEFT_PAD = 28; // space for day labels
  const TOP_PAD = 16;  // space for month labels

  // Build the date grid: 13 weeks ending with the current week.
  const today = new Date();
  const todayDay = today.getDay(); // 0=Sun
  // Find the Monday of the current week (we use Mon-start weeks).
  const mondayOffset = todayDay === 0 ? -6 : 1 - todayDay;
  const currentMonday = new Date(today);
  currentMonday.setDate(today.getDate() + mondayOffset);
  // Go back (WEEKS-1) more weeks to get the start.
  const startDate = new Date(currentMonday);
  startDate.setDate(startDate.getDate() - (WEEKS - 1) * 7);

  // Collect all counts to compute intensity thresholds.
  const nonZeroCounts = [];
  const cells = []; // { col, row, dateISO, count }
  for (let w = 0; w < WEEKS; w++) {
    for (let d = 0; d < ROWS; d++) {
      const cellDate = new Date(startDate);
      cellDate.setDate(startDate.getDate() + w * 7 + d);
      // Don't render future dates.
      if (cellDate > today) continue;
      const iso = formatLocalISO(cellDate);
      const count = countByDate.get(iso) || 0;
      cells.push({ col: w, row: d, dateISO: iso, count });
      if (count > 0) nonZeroCounts.push(count);
    }
  }

  // Compute intensity levels via quartiles of nonzero counts.
  nonZeroCounts.sort((a, b) => a - b);
  const q1 = nonZeroCounts.length > 0 ? quantile(nonZeroCounts, 0.25) : 1;
  const q2 = nonZeroCounts.length > 0 ? quantile(nonZeroCounts, 0.50) : 2;
  const q3 = nonZeroCounts.length > 0 ? quantile(nonZeroCounts, 0.75) : 3;

  function level(count) {
    if (count === 0) return 0;
    if (count <= q1) return 1;
    if (count <= q2) return 2;
    if (count <= q3) return 3;
    return 4;
  }

  const svgWidth = LEFT_PAD + WEEKS * STEP;
  const svgHeight = TOP_PAD + ROWS * STEP;
  const NS = 'http://www.w3.org/2000/svg';

  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('width', String(svgWidth));
  svg.setAttribute('height', String(svgHeight));
  svg.setAttribute('viewBox', `0 0 ${svgWidth} ${svgHeight}`);
  svg.setAttribute('aria-label', 'Practice activity heatmap for the last 13 weeks');
  svg.setAttribute('role', 'img');

  // Day-of-week labels (Mon, Wed, Fri).
  const dayLabels = ['Mon', '', 'Wed', '', 'Fri', '', ''];
  for (let d = 0; d < ROWS; d++) {
    if (!dayLabels[d]) continue;
    const text = document.createElementNS(NS, 'text');
    text.setAttribute('x', String(LEFT_PAD - 4));
    text.setAttribute('y', String(TOP_PAD + d * STEP + CELL - 2));
    text.setAttribute('text-anchor', 'end');
    text.classList.add('heatmap-label');
    text.textContent = dayLabels[d];
    svg.appendChild(text);
  }

  // Month labels: detect when the first day of a column week falls in a new month.
  let lastMonth = -1;
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  for (let w = 0; w < WEEKS; w++) {
    const weekStart = new Date(startDate);
    weekStart.setDate(startDate.getDate() + w * 7);
    const m = weekStart.getMonth();
    if (m !== lastMonth) {
      lastMonth = m;
      const text = document.createElementNS(NS, 'text');
      text.setAttribute('x', String(LEFT_PAD + w * STEP));
      text.setAttribute('y', String(TOP_PAD - 4));
      text.classList.add('heatmap-label');
      text.textContent = months[m];
      svg.appendChild(text);
    }
  }

  // Render cells.
  for (const cell of cells) {
    const rect = document.createElementNS(NS, 'rect');
    rect.setAttribute('x', String(LEFT_PAD + cell.col * STEP));
    rect.setAttribute('y', String(TOP_PAD + cell.row * STEP));
    rect.setAttribute('width', String(CELL));
    rect.setAttribute('height', String(CELL));
    rect.setAttribute('data-level', String(level(cell.count)));
    rect.classList.add('heatmap-cell');

    // Accessible title on hover.
    const title = document.createElementNS(NS, 'title');
    const dateLabel = formatReadableDate(cell.dateISO);
    title.textContent = cell.count > 0
      ? `${cell.count} rep${cell.count === 1 ? '' : 's'} on ${dateLabel}`
      : `No practice on ${dateLabel}`;
    rect.appendChild(title);

    svg.appendChild(rect);
  }

  container.innerHTML = '';
  container.appendChild(svg);
}

/** Format a Date as YYYY-MM-DD in local time. */
function formatLocalISO(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** Turn "2026-05-04" into "May 4, 2026" for tooltip readability. */
function formatReadableDate(iso) {
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return iso;
  const month = months[Number(m[2]) - 1] || m[2];
  return `${month} ${Number(m[3])}, ${m[1]}`;
}

/** Simple quantile on a sorted array (linear interpolation). */
function quantile(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = p * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

/**
 * Poll for a section to land in the active piece's in-memory section list.
 * Returns the section, or null if the timeout elapses or the user has
 * navigated away in the meantime.
 */
async function waitForSection(pieceId, sectionId, timeoutMs) {
  const deadline = Date.now() + Math.max(0, timeoutMs || 0);
  while (Date.now() <= deadline) {
    if (activePieceId !== pieceId) return null;
    const piece = pieces.find((p) => p.id === pieceId);
    if (piece && Array.isArray(piece.sections)) {
      const sec = piece.sections.find((s) => s.id === sectionId);
      if (sec) return sec;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  // One last best-effort lookup against whatever's in memory.
  const piece = pieces.find((p) => p.id === pieceId);
  if (piece && Array.isArray(piece.sections)) {
    return piece.sections.find((s) => s.id === sectionId) || null;
  }
  return null;
}

// --- Export / Import (item 10) -------------------------------------------

/**
 * Export the full library to a JSON file and trigger a browser download.
 * The user gets a timestamped .json file containing all pieces (with PDFs
 * as base64), sections, and rep logs.
 */
async function handleExport() {
  setStatus('Exporting library…');
  try {
    const data = await exportLibrary();
    const json = JSON.stringify(data, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);

    const a = document.createElement('a');
    a.href = url;
    const dateStr = localDateISO().replace(/-/g, '');
    a.download = `pianosrs-backup-${dateStr}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    const pCount = data.pieces ? data.pieces.length : 0;
    const sCount = data.sections ? data.sections.length : 0;
    setStatus(
      `Exported ${pCount} piece${pCount === 1 ? '' : 's'}, ${sCount} section${sCount === 1 ? '' : 's'} to JSON.`,
    );
  } catch (err) {
    console.error('Export failed', err);
    setStatus(`Export failed: ${err.message || err}`);
  }
}

/**
 * Import a library backup from a user-selected JSON file. Uses the 'rename'
 * collision mode by default so existing data is never overwritten.
 */
async function handleImportFile(file) {
  if (!file) return;
  setStatus(`Reading backup file "${file.name}"…`);
  try {
    const text = await file.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch (parseErr) {
      setStatus(`Invalid JSON file — couldn't parse "${file.name}".`);
      return;
    }

    // Confirm before importing — the user should know what's about to happen.
    const pieceCount = Array.isArray(data.pieces) ? data.pieces.length : 0;
    const sectionCount = Array.isArray(data.sections) ? data.sections.length : 0;
    const ok = window.confirm(
      `Import ${pieceCount} piece${pieceCount === 1 ? '' : 's'} and ${sectionCount} section${sectionCount === 1 ? '' : 's'} from this backup?\n\nExisting data won't be overwritten — imported items get new IDs if they collide.`,
    );
    if (!ok) {
      setStatus('Import cancelled.');
      return;
    }

    setStatus('Importing…');
    const result = await importLibrary(data, { mode: 'rename' });

    // Refresh the entire in-memory state from IDB so the sidebar, queue, and
    // stats all reflect the imported data.
    pieces.length = 0;
    activePieceId = null;
    closePracticeView({ silent: true });
    repCountsToday.clear();
    queueState = null;
    statsState = null;

    await hydrateFromStorage();

    setStatus(
      `Imported ${result.piecesImported} piece${result.piecesImported === 1 ? '' : 's'}, ` +
      `${result.sectionsImported} section${result.sectionsImported === 1 ? '' : 's'}, ` +
      `${result.repLogsImported} rep log${result.repLogsImported === 1 ? '' : 's'}` +
      (result.skipped > 0 ? ` (${result.skipped} skipped).` : '.'),
    );
  } catch (err) {
    console.error('Import failed', err);
    setStatus(`Import failed: ${err.message || err}`);
  }
}

// --- Boot ----------------------------------------------------------------

/**
 * Hydrate the in-memory piece list from IndexedDB on app open.
 * Failures here are non-fatal — the app still runs as an in-memory-only
 * library with a status-line warning.
 */
async function hydrateFromStorage() {
  try {
    await openDb();
    const stored = await listPieceMetadata();
    for (const meta of stored) {
      pieces.push({ ...meta }); // notes/sections fill in on first select
    }
    renderPieceList(pieces);
    if (stored.length > 0) {
      setStatus(
        stored.length === 1
          ? `Loaded 1 saved piece · v${APP_VERSION}`
          : `Loaded ${stored.length} saved pieces · v${APP_VERSION}`,
      );
    } else {
      setStatus(`Ready · v${APP_VERSION}`);
    }
    // Build the daily review queue. Non-blocking — if it fails the rest of
    // the app keeps working; the queue panel just stays hidden.
    await refreshReviewQueue();
    // Hydrate the stats snapshot. Same non-blocking treatment as the queue.
    await refreshStats();
    // "Continue practicing" reads the same cross-library section snapshot.
    renderContinuePanel();
    if (queueState && queueState.sections.length > 0) {
      const dueCount = buildReviewQueue({
        sections: queueState.sections,
        piecesById: queueState.pieceTitleById,
        repCountsToday: queueState.countsByDate,
        todayISO: queueState.dateISO,
        repGoal: REP_GOAL,
      }).length;
      if (dueCount > 0) {
        setStatus(
          dueCount === 1
            ? `1 section due for review today · v${APP_VERSION}`
            : `${dueCount} sections due for review today · v${APP_VERSION}`,
        );
      }
    }
  } catch (err) {
    console.warn('Could not hydrate library from IndexedDB', err);
    setStatus(
      `Ready (storage unavailable — pieces won't persist) · v${APP_VERSION}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Dark mode (item 11b)
// ---------------------------------------------------------------------------
const THEME_STORAGE_KEY = 'pianoSrsTheme';

/**
 * Apply the given theme ('light' or 'dark') to the document and update the
 * toggle button's icon/label to reflect the current state. Persists the
 * choice to localStorage so it survives reloads.
 */
function applyTheme(theme) {
  const isDark = theme === 'dark';
  document.documentElement.classList.toggle('dark', isDark);
  // Update toggle button
  if (els.themeToggle) {
    const icon = els.themeToggle.querySelector('.theme-toggle-icon');
    const label = els.themeToggle.querySelector('.theme-toggle-label');
    if (icon) icon.textContent = isDark ? '☀' : '☾'; // ☀ or ☾
    if (label) label.textContent = isDark ? 'Light' : 'Dark';
    els.themeToggle.setAttribute(
      'aria-label',
      isDark ? 'Switch to light mode' : 'Switch to dark mode',
    );
  }
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch (_) {
    // localStorage unavailable — no big deal, preference just won't persist.
  }
}

/**
 * Determine the initial theme: saved preference > OS preference > light.
 */
function getInitialTheme() {
  try {
    const saved = localStorage.getItem(THEME_STORAGE_KEY);
    if (saved === 'dark' || saved === 'light') return saved;
  } catch (_) {
    // localStorage unavailable — fall through.
  }
  if (
    window.matchMedia &&
    window.matchMedia('(prefers-color-scheme: dark)').matches
  ) {
    return 'dark';
  }
  return 'light';
}

function toggleTheme() {
  const isDark = document.documentElement.classList.contains('dark');
  applyTheme(isDark ? 'light' : 'dark');
}

// --- Mobile sidebar drawer (item 11c) ------------------------------------

/** True when viewport matches the mobile breakpoint (≤720px). */
function isMobileViewport() {
  return window.matchMedia && window.matchMedia('(max-width: 720px)').matches;
}

function openSidebar() {
  document.body.classList.add('sidebar-open');
  if (els.sidebarBackdrop) els.sidebarBackdrop.hidden = false;
  if (els.sidebarToggle) els.sidebarToggle.setAttribute('aria-expanded', 'true');
}

function closeSidebar() {
  document.body.classList.remove('sidebar-open');
  if (els.sidebarBackdrop) els.sidebarBackdrop.hidden = true;
  if (els.sidebarToggle) els.sidebarToggle.setAttribute('aria-expanded', 'false');
}

function toggleSidebar() {
  if (document.body.classList.contains('sidebar-open')) {
    closeSidebar();
  } else {
    openSidebar();
  }
}

// ===== Metronome helpers (item 12b) ==========================================

/** Ensure the metronome singleton exists. */
function ensureMetronome() {
  if (metronome) return metronome;
  metronome = createMetronome();
  metronome.onTick((isDownbeat) => {
    if (!els.metronomeBeatIndicator) return;
    // Remove previous flash class and force reflow so re-adding triggers
    // the CSS transition even if the previous flash hasn't expired.
    els.metronomeBeatIndicator.classList.remove('flash', 'flash-downbeat');
    void els.metronomeBeatIndicator.offsetWidth; // force reflow
    els.metronomeBeatIndicator.classList.add(
      isDownbeat ? 'flash-downbeat' : 'flash',
    );
    clearTimeout(beatFlashTimeout);
    beatFlashTimeout = setTimeout(() => {
      els.metronomeBeatIndicator.classList.remove('flash', 'flash-downbeat');
    }, 120);
  });
  return metronome;
}

function syncMetronomeUI() {
  const m = metronome;
  if (!m) return;
  const running = m.isRunning();
  if (els.metronomeBpmInput) els.metronomeBpmInput.value = String(m.getBpm());
  if (els.metronomeToggleLabel) {
    els.metronomeToggleLabel.textContent = running ? 'Stop' : 'Start';
  }
  if (els.metronomeToggleBtn) {
    els.metronomeToggleBtn.classList.toggle('running', running);
  }
  if (!running && els.metronomeBeatIndicator) {
    els.metronomeBeatIndicator.classList.remove('flash', 'flash-downbeat');
  }
}

function handleMetronomeToggle() {
  const m = ensureMetronome();
  if (m.isRunning()) {
    m.stop();
  } else {
    m.start();
  }
  syncMetronomeUI();
}

function handleMetronomeBpmChange() {
  const m = ensureMetronome();
  const val = parseInt(els.metronomeBpmInput?.value, 10);
  if (Number.isFinite(val)) m.setBpm(val);
  syncMetronomeUI();
}

function handleMetronomeBpmAdjust(delta) {
  const m = ensureMetronome();
  m.setBpm(m.getBpm() + delta);
  syncMetronomeUI();
}

function handleMetronomeTap() {
  const m = ensureMetronome();
  m.tap();
  syncMetronomeUI();
  // Auto-start on first tap if not already running.
  if (!m.isRunning() && m.getBpm()) {
    m.start();
    syncMetronomeUI();
  }
}

/** Stop the metronome (called when closing the practice panel). */
function stopMetronome() {
  if (metronome && metronome.isRunning()) {
    metronome.stop();
    syncMetronomeUI();
  }
}

function init() {
  // --- Dark mode (item 11b) — apply before any rendering so no flash. ------
  applyTheme(getInitialTheme());
  if (els.themeToggle) {
    els.themeToggle.addEventListener('click', toggleTheme);
  }

  // --- Mobile sidebar (item 11c) ------------------------------------------
  if (els.sidebarToggle) {
    els.sidebarToggle.addEventListener('click', toggleSidebar);
  }
  if (els.sidebarBackdrop) {
    els.sidebarBackdrop.addEventListener('click', closeSidebar);
  }

  setStatus(`Loading library…`);

  if (els.addPieceBtn && els.fileInput) {
    els.addPieceBtn.addEventListener('click', () => els.fileInput.click());
    els.fileInput.addEventListener('change', async (e) => {
      const input = /** @type {HTMLInputElement} */ (e.target);
      const file = input.files && input.files[0];
      input.value = ''; // reset so picking the same file again retriggers
      await handleMidiFile(file);
    });
  }

  if (els.loadSampleBtn) {
    els.loadSampleBtn.addEventListener('click', () => handleLoadSample());
  }

  if (els.resplitBtn) {
    els.resplitBtn.addEventListener('click', () => handleResplitSections());
  }
  if (els.sectionFormCancel) {
    els.sectionFormCancel.addEventListener('click', () => closeSectionForm());
  }
  if (els.sectionForm) {
    els.sectionForm.addEventListener('submit', handleSectionFormSubmit);
    // Esc closes the form.
    els.sectionForm.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        closeSectionForm();
      }
    });
  }

  // Section drag-to-reorder wiring (item 17).
  if (els.sectionList) {
    setupSectionDragAndDrop(els.sectionList);
  }

  // Practice panel wiring.
  if (els.practiceResetBtn) {
    els.practiceResetBtn.addEventListener('click', handleResetReps);
  }
  if (els.practiceCloseBtn) {
    els.practiceCloseBtn.addEventListener('click', () => closePracticeView());
  }
  if (els.practiceTimerPauseBtn) {
    els.practiceTimerPauseBtn.addEventListener('click', togglePracticeTimer);
  }

  // Home-dashboard wiring: guided review + daily-goal controls.
  if (els.startReviewBtn) {
    els.startReviewBtn.addEventListener('click', startDailyReview);
  }
  if (els.reviewSessionSkip) {
    els.reviewSessionSkip.addEventListener('click', () => advanceReviewSession());
  }
  if (els.statsGoalDec) {
    els.statsGoalDec.addEventListener('click', () => adjustDailyGoal(-1));
  }
  if (els.statsGoalInc) {
    els.statsGoalInc.addEventListener('click', () => adjustDailyGoal(1));
  }

  // Export/import wiring (item 10).
  if (els.exportBtn) {
    els.exportBtn.addEventListener('click', handleExport);
  }
  if (els.importBtn && els.importFileInput) {
    els.importBtn.addEventListener('click', () => els.importFileInput.click());
    els.importFileInput.addEventListener('change', async (e) => {
      const input = /** @type {HTMLInputElement} */ (e.target);
      const file = input.files && input.files[0];
      input.value = '';
      await handleImportFile(file);
    });
  }

  // --- Metronome wiring (item 12b) -----------------------------------------
  if (els.metronomeToggleBtn) {
    els.metronomeToggleBtn.addEventListener('click', handleMetronomeToggle);
  }
  if (els.metronomeTapBtn) {
    els.metronomeTapBtn.addEventListener('click', handleMetronomeTap);
  }
  if (els.metronomeDecBtn) {
    els.metronomeDecBtn.addEventListener('click', () => handleMetronomeBpmAdjust(-5));
  }
  if (els.metronomeIncBtn) {
    els.metronomeIncBtn.addEventListener('click', () => handleMetronomeBpmAdjust(5));
  }
  if (els.metronomeBpmInput) {
    els.metronomeBpmInput.addEventListener('change', handleMetronomeBpmChange);
  }
  if (els.metronomeCollapseBtn) {
    els.metronomeCollapseBtn.addEventListener('click', () => {
      if (!els.metronomeBody) return;
      const isHidden = els.metronomeBody.hidden;
      els.metronomeBody.hidden = !isHidden;
      els.metronomeCollapseBtn.setAttribute('aria-expanded', String(isHidden));
      const icon = els.metronomeCollapseBtn.querySelector('.metronome-collapse-icon');
      if (icon) icon.textContent = isHidden ? '▼' : '▶';
    });
  }

  renderPieceList(pieces);
  // Sections + practice panels start hidden — only shown when a piece is
  // active and (for practice) when the user clicks Practice on a section.
  if (els.sectionsPanel) els.sectionsPanel.hidden = true;
  if (els.practicePanel) els.practicePanel.hidden = true;

  // --- Keyboard shortcuts (item 11 polish) --------------------------------
  // Global key handler — fires only when no text input / textarea is focused,
  // so typing in the section form doesn't accidentally log reps or flip pages.
  document.addEventListener('keydown', handleGlobalKeydown);

  hydrateFromStorage();
}

/**
 * Global keyboard shortcut handler (item 11 polish).
 *
 * Shortcuts:
 *   L           — listen to the current section (synth preview).
 *   R           — restart the current run from the top.
 *   1 / 2 / 3 / 4 — pick Again / Hard / Good / Easy when the rating prompt is
 *                 visible.
 *   Escape      — close practice panel (if open) or close section form.
 *
 * Guard: suppressed when a text input, textarea, or contenteditable element is
 * focused — the user might be typing a section name. (The player's opt-in
 * computer-keyboard mode handles its own letter keys at capture phase.)
 */
function handleGlobalKeydown(e) {
  // Don't hijack keys while the user is typing in an input field.
  const tag = document.activeElement && document.activeElement.tagName;
  if (
    tag === 'INPUT' ||
    tag === 'TEXTAREA' ||
    (document.activeElement && document.activeElement.isContentEditable)
  ) {
    return;
  }

  const practising =
    practiceState && els.practicePanel && !els.practicePanel.hidden;

  switch (e.key) {
    case 'l':
    case 'L': {
      if (practising && player) {
        e.preventDefault();
        player.listen();
      }
      break;
    }

    case 'r':
    case 'R': {
      if (practising && player) {
        e.preventDefault();
        player.restartRun(true);
      }
      break;
    }

    case '1':
    case '2':
    case '3':
    case '4': {
      // 1-4 = pick a rating when the rating prompt is visible.
      if (
        practiceState &&
        els.practiceRatingPrompt &&
        !els.practiceRatingPrompt.hidden &&
        !practiceState.ratingInFlight
      ) {
        const ratingMap = {
          '1': RATING_AGAIN,
          '2': RATING_HARD,
          '3': RATING_GOOD,
          '4': RATING_EASY,
        };
        const labelMap = { '1': 'Again', '2': 'Hard', '3': 'Good', '4': 'Easy' };
        e.preventDefault();
        handleRatingClick(ratingMap[e.key], labelMap[e.key]);
      }
      break;
    }

    case 'Escape': {
      // Esc = close practice panel if open; otherwise close section form.
      if (practiceState) {
        e.preventDefault();
        closePracticeView();
      } else if (sectionFormState && els.sectionForm && !els.sectionForm.hidden) {
        e.preventDefault();
        closeSectionForm();
      }
      break;
    }

    case 'm':
    case 'M': {
      // M = toggle metronome (item 12b) — only when practice panel is open.
      if (practiceState && els.practicePanel && !els.practicePanel.hidden) {
        e.preventDefault();
        // Auto-expand metronome body if collapsed.
        if (els.metronomeBody && els.metronomeBody.hidden) {
          els.metronomeBody.hidden = false;
          if (els.metronomeCollapseBtn) {
            els.metronomeCollapseBtn.setAttribute('aria-expanded', 'true');
            const icon = els.metronomeCollapseBtn.querySelector('.metronome-collapse-icon');
            if (icon) icon.textContent = '▼';
          }
        }
        handleMetronomeToggle();
      }
      break;
    }

    case 't':
    case 'T': {
      // T = pause/resume session timer (item 18).
      if (practiceState && els.practicePanel && !els.practicePanel.hidden) {
        e.preventDefault();
        togglePracticeTimer();
      }
      break;
    }

    case 'd':
    case 'D': {
      // D = toggle dark mode (item 11b).
      e.preventDefault();
      toggleTheme();
      break;
    }
  }
}

document.addEventListener('DOMContentLoaded', init);

// ---- Node export shim (browser-safe) ------------------------------------
// Lets the Node test suite import the pure helper(s) in this file. `module`
// is undefined in the browser (classic <script>), so this is skipped there.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    titleFromFilename,
    formatClock,
    formatPieceMeta,
    formatSectionMeta,
  };
}
