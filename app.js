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

const APP_VERSION = '0.23.0'; // Whole-piece Listen + Play through on the piece page

const els = {
  status: document.getElementById('app-status'),
  addPieceBtn: document.getElementById('add-piece-btn'),
  fileInput: document.getElementById('midi-file-input'),
  loadSampleBtn: document.getElementById('load-sample-btn'),
  loadLibraryBtn: document.getElementById('load-library-btn'),
  pieceList: document.getElementById('piece-list'),
  viewerPlaceholder: document.getElementById('viewer-placeholder'),
  viewerMidi: document.getElementById('viewer-midi'),
  viewerMidiTitle: document.getElementById('viewer-midi-title'),
  viewerMidiMeta: document.getElementById('viewer-midi-meta'),
  // Sheet-music view + [Sheet | Synthesia] toggle
  viewerSheet: document.getElementById('viewer-sheet'),
  viewToggle: document.getElementById('viewer-view-toggle'),
  viewSheetBtn: document.getElementById('view-sheet-btn'),
  viewSynthesiaBtn: document.getElementById('view-synthesia-btn'),
  // Whole-piece actions (Listen / Play through) in the piece header
  pieceActions: document.getElementById('piece-actions'),
  pieceListenBtn: document.getElementById('piece-listen-btn'),
  piecePlayBtn: document.getElementById('piece-play-btn'),
  pieceListenProgress: document.getElementById('piece-listen-progress'),
  pieceListenTime: document.getElementById('piece-listen-time'),
  pieceListenFill: document.getElementById('piece-listen-fill'),
  // Sections panel
  sectionsPanel: document.getElementById('sections-panel'),
  resplitBtn: document.getElementById('resplit-sections-btn'),
  startPathBtn: document.getElementById('start-path-btn'),
  troublePanel: document.getElementById('trouble-panel'),
  troubleList: document.getElementById('trouble-list'),
  troubleSummary: document.getElementById('trouble-panel-summary'),
  troubleClearBtn: document.getElementById('trouble-clear-btn'),
  techniqueBtn: document.getElementById('technique-btn'),
  techniqueForm: document.getElementById('technique-form'),
  techniqueFormHint: document.getElementById('technique-form-hint'),
  techniqueTonicInput: document.getElementById('technique-tonic-input'),
  techniqueModeInput: document.getElementById('technique-mode-input'),
  techniqueFormPreview: document.getElementById('technique-form-preview'),
  techniqueFormSubmit: document.getElementById('technique-form-submit'),
  techniqueFormCancel: document.getElementById('technique-form-cancel'),
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
  practiceEyebrow: document.getElementById('practice-eyebrow'),
  practiceSectionName: document.getElementById('practice-section-name'),
  practiceSectionMeta: document.getElementById('practice-section-meta'),
  practiceSectionNotes: document.getElementById('practice-section-notes'),
  practiceFingering: document.getElementById('practice-fingering'),
  practiceUpNext: document.getElementById('practice-up-next'),
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
  homeBtn: document.getElementById('home-btn'),
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
  // Plan-a-session panel (home dashboard)
  sessionPlanPanel: document.getElementById('session-plan-panel'),
  sessionPlanSummary: document.getElementById('session-plan-summary'),
  sessionPlanMinutes: document.getElementById('session-plan-minutes'),
  sessionPlanList: document.getElementById('session-plan-list'),
  sessionPlanNote: document.getElementById('session-plan-note'),
  startSessionPlanBtn: document.getElementById('start-session-plan-btn'),
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
  // Tempo goals
  tempoGoal: document.getElementById('practice-tempo-goal'),
  tempoGoalStatus: document.getElementById('tempo-goal-status'),
  tempoGoalSet: document.getElementById('tempo-goal-set'),
  tempoGoalInput: document.getElementById('tempo-goal-input'),
  tempoGoalSetBtn: document.getElementById('tempo-goal-set-btn'),
  tempoGoalCancelBtn: document.getElementById('tempo-goal-cancel-btn'),
  tempoGoalActive: document.getElementById('tempo-goal-active'),
  tempoGoalWorking: document.getElementById('tempo-goal-working'),
  tempoGoalBest: document.getElementById('tempo-goal-best'),
  tempoGoalTarget: document.getElementById('tempo-goal-target'),
  tempoGoalTrack: document.getElementById('tempo-goal-track'),
  tempoGoalFill: document.getElementById('tempo-goal-fill'),
  tempoGoalBumpBtn: document.getElementById('tempo-goal-bump-btn'),
  tempoGoalEditBtn: document.getElementById('tempo-goal-edit-btn'),
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
 * The engraved sheet-music view (OpenSheetMusicDisplay wrapper), created
 * lazily on first score render and reused across pieces. Null until a score
 * piece is opened. @type {ReturnType<typeof createSheetView> | null}
 */
let sheetView = null;

/**
 * Which display the viewer is showing: 'sheet' (engraved score, default for
 * score-backed pieces) or 'synthesia' (falling notes). Mirrored onto
 * #viewer-midi as a `view-sheet` / `view-synthesia` class.
 */
let pieceView = 'synthesia';

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
 *     mode?: 'piece',          // whole-piece play-through (see openPieceRun)
 *     section?: object,        // the synthetic whole-piece section (mode 'piece')
 *     runs?: number,           // play-throughs completed this session (mode 'piece')
 *     bestSlips?: number|null, // fewest wrong notes in one play-through (mode 'piece')
 *   }
 *
 * A whole-piece play-through reuses the panel + engine but banks nothing: no
 * rep logs, no SM-2, no practice-time / tempo writes (its `sectionId` is the
 * sentinel PIECE_RUN_ID, which matches no stored section).
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

/** Sentinel sectionId for a whole-piece play-through (never a stored id). */
const PIECE_RUN_ID = '__piece_run__';

/**
 * Whole-piece "Listen" from the piece page — a playback.js engine that walks
 * the score cursor along while it plays. Lazily created; independent of the
 * practice player so it doesn't need the practice panel to be open.
 * @type {ReturnType<typeof createPiecePlayback> | null}
 */
let piecePlayback = null;

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
 * When true, the tempo-goal card shows its "set target" input even though a
 * goal already exists (the user tapped "Edit goal"). Reset whenever a new
 * section's practice view opens.
 */
let tempoGoalEditing = false;

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

/** localStorage key for the planned-session length (minutes). */
const SESSION_MINUTES_KEY = 'pianoSrsSessionMinutes';

/** Bounds + default for the "I have N minutes" input. */
const SESSION_MINUTES_MIN = 5;
const SESSION_MINUTES_MAX = 240;
const SESSION_MINUTES_DEFAULT = 30;

/** The user's chosen session length, persisted across visits. */
let sessionPlanMinutes = readSessionPlanMinutes();

/**
 * Lifetime rep totals by sectionId — feeds the per-section time estimates in
 * the session planner (avg ms/rep × rep goal). Hydrated alongside the review
 * queue; empty until then, which just means the planner uses its flat
 * fallback estimates.
 */
let lifetimeRepTotals = new Map();

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

    // Cascade: rep logs → mistake tallies → sections → piece.
    if (sectionIds.length > 0) {
      await deleteRepLogsForSections(sectionIds);
    }
    try {
      await deleteMistakesForPiece(pieceId);
    } catch (err) {
      console.warn('Could not clear mistake history for deleted piece', err);
    }
    await deleteSectionsForPiece(pieceId);
    await deletePiece(pieceId);

    // Remove from in-memory array.
    const idx = pieces.findIndex((p) => p.id === pieceId);
    if (idx !== -1) pieces.splice(idx, 1);
    if (activePieceId === pieceId) mistakeRecords = [];

    // If the deleted piece was active, clear the viewer back to the welcome
    // placeholder.
    if (activePieceId === pieceId) {
      activePieceId = null;
      closePracticeView({ silent: true });
      closeSectionForm();
      if (els.viewerMidi) els.viewerMidi.hidden = true;
      if (els.viewerPlaceholder) els.viewerPlaceholder.hidden = false;
      if (els.homeBtn) els.homeBtn.hidden = true;
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
  // A technique drill isn't located anywhere in the piece, so a timestamp
  // range would be actively misleading — describe the drill instead.
  if (section.kind === 'technique' && section.technique) {
    const t = section.technique;
    const shape = t.drill === 'cadence'
      ? 'both hands'
      : `${t.octaves || TECHNIQUE_OCTAVES} octaves · hands together`;
    return `${noteStr} · ${shape}`;
  }
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
  // Then the technique drills — scale, arpeggio and cadence in the piece's own
  // key. These carry a generated note set rather than a window into the piece,
  // so they sit outside the tick-range scheme entirely (see technique.js).
  //
  // They go at the FRONT: they're the warm-up, and the practice path opens with
  // them. `order` below is the array index, so position here is the stored
  // order — the user can still drag them elsewhere afterwards.
  const key = resolveKey({
    notes: piece.notes,
    keySignature: piece.keySignature || null,
    ticksPerQuarter: piece.ticksPerQuarter,
  });
  if (key) {
    piece.key = key;
    ranges.unshift(...techniqueSpecsForKey(key, 0));
  }
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
      technique: range.technique,
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
      // Best-effort — most MIDI exports omit the key-signature meta event, in
      // which case the technique drills fall back to detecting the key.
      keySignature: (parsed.keySignatures || [])[0] || null,
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

/** Inflate a raw-DEFLATE byte array via the browser's DecompressionStream. */
async function inflateRaw(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(
    new DecompressionStream('deflate-raw'),
  );
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * Extract the score XML text from a compressed MusicXML container (.mxl — a
 * ZIP). Reads the central directory (robust to data-descriptor headers),
 * resolves the score path from META-INF/container.xml (falling back to the
 * first non-META-INF .xml), and inflates it. Browser-only (DecompressionStream
 * + DataView) — matches the app's existing "best in Chromium" stance.
 */
async function extractMxl(arrayBuffer) {
  const dv = new DataView(arrayBuffer);
  const bytes = new Uint8Array(arrayBuffer);
  const decode = (u8) => new TextDecoder().decode(u8);
  // Find the End Of Central Directory record (sig 0x06054b50) from the back.
  let eocd = -1;
  for (let i = bytes.length - 22; i >= 0; i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a valid .mxl (no ZIP end record)');
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const entries = [];
  for (let e = 0; e < count; e++) {
    if (dv.getUint32(p, true) !== 0x02014b50) break;
    entries.push({
      method: dv.getUint16(p + 10, true),
      compSize: dv.getUint32(p + 20, true),
      localOff: dv.getUint32(p + 42, true),
      name: decode(bytes.subarray(p + 46, p + 46 + dv.getUint16(p + 28, true))),
    });
    p += 46 + dv.getUint16(p + 28, true) + dv.getUint16(p + 30, true) + dv.getUint16(p + 32, true);
  }
  const dataOf = async (entry) => {
    const lh = entry.localOff;
    const start = lh + 30 + dv.getUint16(lh + 26, true) + dv.getUint16(lh + 28, true);
    const comp = bytes.subarray(start, start + entry.compSize);
    if (entry.method === 0) return comp;
    if (entry.method === 8) return inflateRaw(comp);
    throw new Error(`unsupported .mxl compression method ${entry.method}`);
  };
  let scoreName = null;
  const container = entries.find((x) => x.name === 'META-INF/container.xml');
  if (container) {
    const m = /full-path="([^"]+)"/.exec(decode(await dataOf(container)));
    if (m) scoreName = m[1];
  }
  if (!scoreName) {
    const cand = entries.find(
      (x) => !/^META-INF\//.test(x.name) && /\.(musicxml|xml)$/i.test(x.name),
    );
    scoreName = cand && cand.name;
  }
  const entry = scoreName && entries.find((x) => x.name === scoreName);
  if (!entry) throw new Error('no score found inside the .mxl');
  return decode(await dataOf(entry));
}

/** Read a chosen score file to its raw MusicXML text (.mxl is unzipped). */
async function readScoreText(file) {
  if (/\.mxl$/i.test(file.name)) {
    return extractMxl(await readBlobAsArrayBuffer(file));
  }
  return file.text();
}

/**
 * Handle a chosen MusicXML file: derive notes, persist score, auto-split.
 *
 * `opts` lets the curated-library loader override behaviour:
 *   - `title`   : use this exact title instead of deriving it from the filename
 *                 (so pieces can carry a level prefix like "L1 · …").
 *   - `addedAt` : force the stored timestamp, so a batch import keeps a stable
 *                 sidebar order (the list sorts by `addedAt` ascending).
 *   - `select`  : pass `false` to import without switching the viewer to it.
 * Returns `'added' | 'skipped' | 'failed'` so a batch caller can tally results.
 */
async function handleScoreFile(file, opts = {}) {
  if (!file) return 'failed';
  const desiredTitle =
    typeof opts.title === 'string' && opts.title
      ? opts.title
      : titleFromFilename(file.name);
  // Skip a piece that's already in the library (by title) so re-running the
  // curated import doesn't create duplicates.
  if (pieces.some((p) => p.title === desiredTitle)) {
    return 'skipped';
  }
  setStatus(`Loading "${desiredTitle}"…`);
  try {
    let xml;
    try {
      xml = await readScoreText(file);
    } catch (err) {
      setStatus(`Couldn't read "${file.name}": ${err.message || err}`);
      return 'failed';
    }
    const parsed = parseMusicXml(xml);
    if (!parsed.notes.length) {
      setStatus(`"${file.name}" has no playable notes — ignored.`);
      return 'failed';
    }
    annotateFingerings(parsed.notes, { ticksPerQuarter: parsed.ticksPerQuarter });

    const piece = {
      id: newPieceId(),
      title: desiredTitle,
      durationSec: parsed.durationSec,
      ticksPerQuarter: parsed.ticksPerQuarter,
      noteCount: parsed.notes.length,
      addedAt: typeof opts.addedAt === 'number' ? opts.addedAt : Date.now(),
      notes: parsed.notes,
      sections: [],
      source: 'musicxml',
      hasScore: true,
      // Kept in memory so the sheet view + measure mapping need no reparse.
      musicXml: xml,
      scoreMeasures: parsed.measures,
      // Notated key signature — the strongest signal for the technique drills.
      keySignature: parsed.keySignature || null,
    };

    // Persist the extracted score.xml text (so both the parser and OSMD can
    // read it directly without re-unzipping).
    const blob = new Blob([xml], { type: 'application/xml' });
    try {
      await savePiece(pieceToRecord(piece, null, blob));
    } catch (err) {
      console.warn('IndexedDB save failed; piece will live in memory only', err);
      setStatus(`Added "${piece.title}" but couldn't save it — refresh will lose it.`);
    }

    piece.sections = await buildSectionsForPiece(piece);
    pieces.push(piece);
    renderPieceList(pieces);
    setStatus(
      `Added "${piece.title}" (${piece.noteCount} notes, ${piece.sections.length} sections).`,
    );
    if (opts.select !== false) selectPiece(piece.id);
    return 'added';
  } catch (err) {
    console.error('Failed to load score', err);
    setStatus(`Failed to load score: ${err.message || err}`);
    return 'failed';
  }
}

/**
 * Curated starter library — the downloaded MusicXML scores, ordered by level.
 * Each title carries a level prefix so the sidebar (which sorts by import
 * order / `addedAt`) groups the pieces by level. Files live in `library/`.
 */
const CURATED_LIBRARY = [
  // Level 1 — Rebuild Fundamentals
  { file: 'prelude-opus-28-no-4-in-e-minor-chopin.mxl', title: 'L1 · Prélude in E minor, Op. 28 No. 4 — Chopin' },
  { file: 'prelude-opus-28-no-6-in-b-minor.mxl', title: 'L1 · Prélude in B minor, Op. 28 No. 6 — Chopin' },
  { file: 'waltz-in-a-minorchopin.mxl', title: 'L1 · Waltz in A minor, B. 150 (posth.) — Chopin' },
  { file: 'gymnopedie-no-1-satie.mxl', title: 'L1 · Gymnopédie No. 1 — Satie' },
  { file: 'burgmuller-arabesque-op-100-no-2.mxl', title: 'L1 · Arabesque, Op. 100 No. 2 — Burgmüller' },
  { file: 'prelude-i-in-c-major-bwv-846-well-tempered-clavier-first-book.mxl', title: 'L1 · Prelude No. 1 in C, BWV 846 — Bach' },
  // Level 2 — Early Chopin
  { file: 'nocturne-in-c-sharp-minor.mxl', title: 'L2 · Nocturne in C-sharp minor (posth.) — Chopin' },
  { file: 'waltz-no7-in-c-sharp-minor-op64-no2-frederic-chopin.mxl', title: 'L2 · Waltz in C-sharp minor, Op. 64 No. 2 — Chopin' },
  { file: 'frederic-chopin-prelude-in-d-flat-major-op28-no15-raindrop.mxl', title: 'L2 · Prélude in D-flat “Raindrop”, Op. 28 No. 15 — Chopin' },
  { file: 'arabesque-l-66-no-1-in-e-major.mxl', title: 'L2 · Arabesque No. 1, L. 66 — Debussy' },
  { file: 'waltz-op64-no1-valse-du-petit-chien-minute-waltz.mxl', title: 'L2 · Waltz in D-flat “Minute”, Op. 64 No. 1 — Chopin' },
  { file: 'chopin-nocturne-op-9-no-2-e-flat-major.mxl', title: 'L2 · Nocturne in E-flat, Op. 9 No. 2 — Chopin' },
  { file: 'traumerei.mxl', title: 'L2 · Träumerei (Kinderszenen No. 7) — Schumann' },
  // Level 3 — Intermediate Virtuosity
  { file: 'fantaisie-impromptu-in-c-minor-chopin.mxl', title: 'L3 · Fantaisie-Impromptu, Op. 66 — Chopin' },
  { file: 'etude-opus-10-no-3-in-e-major.mxl', title: 'L3 · Étude “Tristesse”, Op. 10 No. 3 — Chopin' },
  { file: 'etude-op25-no1-in-ab-major-aeolian-harp-f-chopin.mxl', title: 'L3 · Étude “Aeolian Harp”, Op. 25 No. 1 — Chopin' },
  { file: 'chopin-nocturne-in-d-flat-major-op-27-no-2.mxl', title: 'L3 · Nocturne in D-flat, Op. 27 No. 2 — Chopin' },
  { file: 'clair-de-lune-debussy.mxl', title: 'L3 · Clair de Lune — Debussy' },
  { file: 'liebestraum-s-541-no-3-in-a-major-liszt.mxl', title: 'L3 · Liebestraum No. 3, S. 541 — Liszt' },
  { file: 'moszkowski-etude-in-g-minor-op72-no2.mxl', title: 'L3 · Étude in G minor, Op. 72 No. 2 — Moszkowski' },
  // Level 4 — Pre-Ballade Training
  { file: 'scherzo-no-2-opus-31-in-b-minor.mxl', title: 'L4 · Scherzo No. 2, Op. 31 — Chopin' },
  { file: 'polonaise-in-a-major-heroic-polonaise.mxl', title: 'L4 · Polonaise “Héroïque”, Op. 53 — Chopin' },
  { file: 'chopin-etude-op10-no12-in-c-minor-revolutionary.mxl', title: 'L4 · Étude “Revolutionary”, Op. 10 No. 12 — Chopin' },
  { file: 'etude-opus-25-no-12-ocean-frederic-chopin.mxl', title: 'L4 · Étude “Ocean”, Op. 25 No. 12 — Chopin' },
  { file: 'etude-op25-no11-in-a-minor-winter-wind-f-chopin.mxl', title: 'L4 · Étude “Winter Wind”, Op. 25 No. 11 — Chopin' },
  // Final Boss
  { file: 'chopins-ballade-no-1-in-g-minor.mxl', title: '★ Final Boss · Ballade No. 1 in G minor, Op. 23 — Chopin' },
  { file: 'frederic-chopin-ballade-no3-in-a-flat-major-op47.mxl', title: '★ Final Boss · Ballade No. 3 in A-flat, Op. 47 — Chopin' },
];

/**
 * One-time title migrations for libraries seeded by an earlier manifest. Maps
 * an old stored title → its current title. Applied on startup so an already
 * imported piece is updated in place (keeping its sections + SRS history)
 * instead of being re-imported as a duplicate under the new title.
 */
const LIBRARY_TITLE_MIGRATIONS = {
  'Bonus · Prelude No. 1 in C, BWV 846 — Bach':
    'L1 · Prelude No. 1 in C, BWV 846 — Bach',
  'Bonus · Träumerei (Kinderszenen No. 7) — Schumann':
    'L2 · Träumerei (Kinderszenen No. 7) — Schumann',
  'Bonus · Nocturne in E-flat, Op. 9 No. 2 — Chopin':
    'L2 · Nocturne in E-flat, Op. 9 No. 2 — Chopin',
};

/** Rename any stored pieces that still carry a superseded title. */
async function migrateLibraryTitles() {
  for (const p of pieces) {
    const newTitle = LIBRARY_TITLE_MIGRATIONS[p.title];
    // Skip if there's nothing to do, or the target title already exists
    // (don't create a collision).
    if (!newTitle || pieces.some((q) => q !== p && q.title === newTitle)) {
      continue;
    }
    try {
      await renamePiece(p.id, newTitle);
      p.title = newTitle;
    } catch (err) {
      console.warn('Library title migration failed for', p.title, err);
    }
  }
}

// Set once the one-time technique-hoist pass below has run.
const TECHNIQUE_HOIST_FLAG = 'pianoSrsTechniqueHoisted';

/**
 * Move technique drills to the top of every piece that still has them at the
 * bottom.
 *
 * The drills originally shipped appended after the piece's own sections. They
 * belong at the front — they're the warm-up, and the practice path opens with
 * them — but changing where they're *created* only helps newly imported
 * pieces. Anything already in IndexedDB keeps its stored `order`, so an
 * existing library would show them at the bottom forever.
 *
 * Only `order` changes: rep logs, SRS schedules and tempo goals are untouched,
 * unlike "Re-split" (which rebuilds everything) or re-keying (which replaces
 * the drills). Runs at most once — guarded by a localStorage flag — so that
 * afterwards the user is free to drag drills wherever they like without this
 * yanking them back on the next reload.
 */
async function migrateTechniqueToTop() {
  let done = null;
  try { done = localStorage.getItem(TECHNIQUE_HOIST_FLAG); } catch (_) { /* private mode */ }
  if (done) return;
  try {
    const all = await listAllSections();
    const byPiece = new Map();
    for (const s of all) {
      if (!byPiece.has(s.pieceId)) byPiece.set(s.pieceId, []);
      byPiece.get(s.pieceId).push(s);
    }
    const updates = [];
    for (const secs of byPiece.values()) {
      if (!secs.some((s) => s.kind === 'technique')) continue;
      secs.sort(
        (a, b) => (a.order || 0) - (b.order || 0) || (a.addedAt || 0) - (b.addedAt || 0),
      );
      // Drills first, everything else after — both keeping their relative
      // order, so any arrangement the user already made survives.
      const desired = [
        ...secs.filter((s) => s.kind === 'technique'),
        ...secs.filter((s) => s.kind !== 'technique'),
      ];
      desired.forEach((s, i) => {
        if ((s.order || 0) !== i) updates.push({ id: s.id, order: i });
      });
    }
    if (updates.length) {
      await reorderSections(updates);
      // Drop any cached section lists so the new order is picked up on select.
      for (const p of pieces) p.sections = undefined;
    }
    try { localStorage.setItem(TECHNIQUE_HOIST_FLAG, '1'); } catch (_) { /* ignore */ }
  } catch (err) {
    // Non-fatal: the drills still work, they're just in the old position, and
    // the flag stays unset so the next open retries.
    console.warn('Could not move technique drills to the top', err);
  }
}

/**
 * Order the in-memory piece list to match the curated manifest (so pieces
 * group by level), with any non-curated pieces falling to the end by addedAt.
 * Applied after hydrate; ordering is by title, so it's stable across reloads
 * even though the stored `addedAt` of migrated pieces hasn't changed.
 */
function sortPiecesByCuratedOrder() {
  const orderByTitle = new Map(
    CURATED_LIBRARY.map((item, i) => [item.title, i]),
  );
  pieces.sort((a, b) => {
    const ia = orderByTitle.has(a.title) ? orderByTitle.get(a.title) : Infinity;
    const ib = orderByTitle.has(b.title) ? orderByTitle.get(b.title) : Infinity;
    if (ia !== ib) return ia - ib;
    return (a.addedAt || 0) - (b.addedAt || 0);
  });
}

/** Decode a base64 string to a Uint8Array (for the embedded library bytes). */
function base64ToBytes(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/**
 * Fetch the raw `.mxl` bytes for a curated item. Prefers the base64 embedded in
 * `library-data.js` (works over file://, where fetch is blocked); falls back to
 * fetching `library/<file>` when the app is served over http://.
 */
async function curatedPieceBytes(file) {
  const data =
    typeof window !== 'undefined' &&
    window.CURATED_LIBRARY_DATA &&
    window.CURATED_LIBRARY_DATA[file];
  if (typeof data === 'string') {
    return base64ToBytes(data);
  }
  const res = await fetch(`library/${file}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

/**
 * One-click loader for the curated starter library. For each bundled `.mxl`,
 * decodes the embedded copy (or fetches it), runs it through the normal
 * score-import path with a level-prefixed title, and tallies the result.
 * Already-present pieces are skipped, so it's safe to run more than once.
 */
async function handleLoadCuratedLibrary() {
  setStatus('Loading curated library…');
  const base = Date.now();
  let added = 0;
  let skipped = 0;
  let failed = 0;
  for (let i = 0; i < CURATED_LIBRARY.length; i++) {
    const item = CURATED_LIBRARY[i];
    // Quick skip before any decode/parse work if it's already in the library.
    if (pieces.some((p) => p.title === item.title)) {
      skipped++;
      continue;
    }
    let bytes;
    try {
      bytes = await curatedPieceBytes(item.file);
    } catch (err) {
      console.warn('Could not load curated piece', item.file, err);
      failed++;
      continue;
    }
    const result = await handleScoreFile(
      new File([bytes], item.file, { type: 'application/vnd.recordare.musicxml' }),
      // `base + i` keeps the level order stable in the sidebar.
      { title: item.title, addedAt: base + i, select: false },
    );
    if (result === 'added') added++;
    else if (result === 'skipped') skipped++;
    else failed++;
    // Yield to the event loop between pieces so the UI can paint progress.
    await new Promise((r) => setTimeout(r, 0));
  }
  renderPieceList(pieces);
  if (added === 0 && skipped > 0 && failed === 0) {
    setStatus(`Curated library already loaded (${skipped} pieces).`);
  } else if (failed > 0) {
    setStatus(
      `Curated library: ${added} added, ${skipped} skipped, ${failed} failed.`,
    );
  } else {
    setStatus(`Curated library: ${added} added, ${skipped} already present.`);
  }
}

/**
 * One-click loader for the bundled demo piece (`samples/twinkle.musicxml`).
 * Fetched at runtime and run through the score-import path so the sample shows
 * off the engraved sheet view. If a Twinkle piece is already in the library,
 * just select it instead of importing a duplicate.
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
    const res = await fetch('samples/twinkle.musicxml');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    buf = await res.arrayBuffer();
  } catch (err) {
    console.warn('Could not fetch sample', err);
    setStatus(
      'Could not load the sample — open the app over http://localhost (not by double-clicking index.html).',
    );
    return;
  }
  await handleScoreFile(
    new File([buf], 'Twinkle Twinkle.musicxml', { type: 'application/xml' }),
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
  // and a section only belongs to one piece. Same for a whole-piece Listen.
  closePracticeView({ silent: true });
  stopPieceListen();
  activePieceId = pieceId;
  // Re-render the sidebar so the active highlight moves.
  renderPieceList(pieces);
  // Close any in-flight section form when switching pieces.
  closeSectionForm();
  repCountsToday.clear();

  try {
    await ensureNotesLoaded(piece);
  } catch (err) {
    console.error('Failed to load notes from storage', err);
    setStatus(`Failed to load "${piece.title}": ${err.message || err}`);
    return;
  }

  // Load sections (and today's rep counts + mistake history) in the background.
  ensureSectionsLoaded(piece)
    .then(() => refreshRepCountsForActivePiece())
    .then(() => refreshMistakesForActivePiece())
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
 * If the piece doesn't have parsed `notes` in memory yet, fetch its source
 * blob from IDB and parse it. Branches on `piece.source`: a 'musicxml' piece
 * derives its timeline (and keeps the score XML + measures for the sheet view)
 * from the stored score; a 'midi' piece parses its MIDI bytes. Mutates the
 * piece in place.
 */
async function ensureNotesLoaded(piece) {
  if (Array.isArray(piece.notes)) return;
  setStatus(`Loading "${piece.title}"…`);
  if (piece.source === 'musicxml') {
    const blob = await getPieceMusicXmlBlob(piece.id);
    if (!blob) {
      throw new Error('Score data is missing from local storage');
    }
    const xml = await blob.text();
    const parsed = parseMusicXml(xml);
    annotateFingerings(parsed.notes, { ticksPerQuarter: parsed.ticksPerQuarter });
    piece.notes = parsed.notes;
    piece.ticksPerQuarter = parsed.ticksPerQuarter;
    piece.durationSec = parsed.durationSec;
    piece.noteCount = parsed.notes.length;
    piece.musicXml = xml;
    piece.scoreMeasures = parsed.measures;
    piece.keySignature = parsed.keySignature || null;
    return;
  }
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
  piece.keySignature = (parsed.keySignatures || [])[0] || null;
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
  if (els.homeBtn) els.homeBtn.hidden = false; // a piece is open → offer Home
  if (els.viewerMidiTitle) els.viewerMidiTitle.textContent = piece.title;
  if (els.viewerMidiMeta) els.viewerMidiMeta.textContent = formatPieceMeta(piece);
  // The technique form is per-piece; don't carry one piece's key into another.
  closeTechniqueForm();
  setupPieceView(piece);
  renderPieceActions(piece);
  setStatus(`Showing "${piece.title}" — pick a section to practice, or listen to / play the whole piece.`);
}

// --- Whole piece: Listen + Play through -----------------------------------

/**
 * Enable the whole-piece row for a piece with notes; reset its Listen state.
 * (The row is hidden by CSS while a section is being practised.)
 */
function renderPieceActions(piece) {
  const hasNotes = !!(piece && Array.isArray(piece.notes) && piece.notes.length);
  if (els.pieceListenBtn) els.pieceListenBtn.disabled = !hasNotes;
  if (els.piecePlayBtn) els.piecePlayBtn.disabled = !hasNotes;
  renderPieceListenUI(false);
}

/**
 * A synthetic section spanning every note of the piece, for the whole-piece
 * play-through. Shaped like a stored section so the practice panel, player,
 * sheet sync and mistake tally can all take it unchanged; its `id` is the
 * PIECE_RUN_ID sentinel so nothing is ever persisted against it.
 */
function wholePieceSection(piece) {
  const notes = Array.isArray(piece.notes) ? piece.notes : [];
  let startTick = Infinity;
  let startSec = Infinity;
  let endTick = 0;
  let endSec = 0;
  for (const n of notes) {
    if (n.startTick < startTick) startTick = n.startTick;
    if (n.startSec < startSec) startSec = n.startSec;
    if (n.endTick > endTick) endTick = n.endTick;
    if (n.endSec > endSec) endSec = n.endSec;
  }
  if (!notes.length) { startTick = 0; startSec = 0; }
  return {
    id: PIECE_RUN_ID,
    pieceId: piece.id,
    name: piece.title,
    kind: 'piece',
    startTick,
    endTick: endTick + 1, // notesInSection is start-inclusive / end-exclusive
    startSec,
    endSec,
    noteCount: notes.length,
    notes: '',
    order: -1,
  };
}

/** Is the current practice session a whole-piece play-through? */
function isPieceRun() {
  return !!(practiceState && practiceState.mode === 'piece');
}

/** Lazily build the whole-piece Listen engine (score cursor follows along). */
function ensurePiecePlayback() {
  if (piecePlayback || typeof createPiecePlayback !== 'function') return piecePlayback;
  piecePlayback = createPiecePlayback({
    onStep: (step) => {
      if (sheetCursorReady()) sheetView.moveCursorToTick(step.tick);
    },
    onTime: (elapsed, total) => renderPieceListenProgress(elapsed, total),
    onEnd: ({ completed }) => {
      renderPieceListenUI(false);
      // Park the cursor again unless a practice run owns it now.
      if (!practiceState && sheetView && sheetView.isReady()) sheetView.clearCursor();
      if (completed) setStatus('That’s the whole piece.');
    },
  });
  return piecePlayback;
}

function togglePieceListen() {
  if (piecePlayback && piecePlayback.isPlaying()) stopPieceListen();
  else startPieceListen();
}

function startPieceListen() {
  const piece = getActivePiece();
  if (!piece || !Array.isArray(piece.notes) || !piece.notes.length) return;
  const pb = ensurePiecePlayback();
  if (!pb) {
    setStatus('Playback isn’t available in this browser.');
    return;
  }
  const started = pb.play(piece.notes, { ticksPerQuarter: piece.ticksPerQuarter });
  if (!started) return;
  renderPieceListenUI(true);
  setStatus(`Listening to "${piece.title}" — press L or ■ Stop to stop.`);
}

function stopPieceListen() {
  if (piecePlayback && piecePlayback.isPlaying()) piecePlayback.stop(); // → onEnd resets the UI
  else renderPieceListenUI(false);
}

function isPieceListening() {
  return !!(piecePlayback && piecePlayback.isPlaying());
}

function renderPieceListenUI(playing) {
  if (els.pieceListenBtn) {
    els.pieceListenBtn.textContent = playing ? '■ Stop' : '▶ Listen';
    els.pieceListenBtn.classList.toggle('is-active', playing);
    els.pieceListenBtn.setAttribute('aria-pressed', String(playing));
  }
  if (els.pieceListenProgress) els.pieceListenProgress.hidden = !playing;
  if (!playing) renderPieceListenProgress(0, 0);
}

function renderPieceListenProgress(elapsed, total) {
  if (els.pieceListenTime) {
    els.pieceListenTime.textContent =
      `${formatClock(Math.floor(elapsed))} / ${formatClock(Math.ceil(total))}`;
  }
  if (els.pieceListenFill) {
    const pct = total > 0 ? Math.min(100, (elapsed / total) * 100) : 0;
    els.pieceListenFill.style.width = `${pct}%`;
  }
}

/**
 * Play the whole piece through, start to finish, in the practice panel — a
 * free run: wait mode still waits for each correct note, but a wrong note is
 * counted (and logged as a trouble spot) instead of resetting the run, and
 * nothing is banked toward the section reviews. Any section practice already
 * open is closed first.
 */
function openPieceRun() {
  const piece = getActivePiece();
  if (!piece || !Array.isArray(piece.notes) || !piece.notes.length) return;
  stopPieceListen();
  if (practiceState) closePracticeView({ silent: true });

  const section = wholePieceSection(piece);
  practiceState = {
    sectionId: PIECE_RUN_ID,
    mode: 'piece',
    section,
    dateISO: localDateISO(),
    count: 0,
    saving: false,
    ratingInFlight: false,
    pendingHalfRep: false,
    timerStartedAt: Date.now(),
    timerElapsed: 0,
    timerPaused: false,
    runs: 0,
    bestSlips: null,
  };
  startPracticeTimer();
  renderSectionsPanel();
  showPracticePanel(section);
  tempoGoalEditing = false;
  renderPracticePanel();
  if (els.viewerMidi) els.viewerMidi.classList.add('is-practicing');
  mountPlayer(piece, section);
  setStatus(`Playing "${piece.title}" through — wrong notes are counted, not punished. Esc to stop.`);
}

/**
 * Configure the [Sheet | Synthesia] view for the selected piece. A score-backed
 * piece renders the engraved score and defaults to the Sheet view; a MIDI-only
 * piece hides the toggle/sheet and stays on Synthesia.
 */
function setupPieceView(piece) {
  const canSheet = !!(
    piece.hasScore &&
    piece.musicXml &&
    typeof createSheetView === 'function' &&
    window.opensheetmusicdisplay
  );
  if (els.viewToggle) els.viewToggle.hidden = !canSheet;
  if (els.viewerSheet) els.viewerSheet.hidden = !canSheet;
  if (!canSheet) {
    if (sheetView) sheetView.clearHighlight();
    setPieceView('synthesia');
    return;
  }
  setPieceView('sheet');
  if (!sheetView) sheetView = createSheetView(els.viewerSheet);
  // Engrave suggested fingerings on the landmark notes (sparse) by splicing
  // them into the score XML before OSMD renders it.
  let xml = piece.musicXml;
  try {
    flagFingeringLandmarks(piece.notes, { ticksPerQuarter: piece.ticksPerQuarter });
    xml = injectFingerings(piece.musicXml, piece.notes);
  } catch (err) {
    console.warn('Could not add fingerings to the score', err);
  }
  // Render the score (async; the view guards overlapping loads internally).
  sheetView.load(xml, piece.ticksPerQuarter).catch((err) => {
    console.error('Failed to render score', err);
    setStatus(`Couldn't render the score: ${err.message || err}`);
    if (els.viewToggle) els.viewToggle.hidden = true;
    if (els.viewerSheet) els.viewerSheet.hidden = true;
    setPieceView('synthesia');
  });
}

/** Switch the active display, reflecting it on the toggle + #viewer-midi class. */
function setPieceView(view) {
  pieceView = view === 'sheet' ? 'sheet' : 'synthesia';
  if (els.viewerMidi) {
    els.viewerMidi.classList.toggle('view-sheet', pieceView === 'sheet');
    els.viewerMidi.classList.toggle('view-synthesia', pieceView === 'synthesia');
  }
  if (els.viewSheetBtn) {
    els.viewSheetBtn.classList.toggle('is-active', pieceView === 'sheet');
  }
  if (els.viewSynthesiaBtn) {
    els.viewSynthesiaBtn.classList.toggle('is-active', pieceView === 'synthesia');
  }
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
      // Repaint so the technique group header follows its block — dragging a
      // phrase above the drills would otherwise strand it at the top.
      renderSectionsPanel();
    } catch (err) {
      console.error('Failed to persist section reorder:', err);
      setStatus('Error saving section order.');
      // Re-render to restore correct order from DB
      renderSectionsPanel();
    }
  });
}

// Badge text for the auto-generated section kinds. Ordinary phrase sections
// have no `kind` and get no badge.
const SECTION_KIND_LABELS = {
  transition: 'Transition',
  fluency: 'Fluency',
  technique: 'Technique',
  trouble: 'Trouble spot',
};
const SECTION_KIND_TITLES = {
  transition: 'Joins two adjacent sections — practice the seam between them',
  fluency: 'Combined run-through — review the transitions between sections',
  technique: 'Scale, arpeggio or cadence in this piece’s key — warm up with it',
  trouble: 'A passage you keep getting wrong — drilled on its own',
};

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
  // Offer the "Practice path" run only when there's a real path to walk.
  if (els.startPathBtn) els.startPathBtn.hidden = sections.length < 2;
  renderTechniqueButton();
  renderTroublePanel();
  els.sectionList.innerHTML = '';

  if (sections.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'section-list-empty';
    empty.textContent =
      'No sections yet. Use “Re-split” to break this piece into practice phrases.';
    els.sectionList.appendChild(empty);
    return;
  }

  // The technique block is introduced by a group header carrying the key. It's
  // emitted before the first drill wherever that lands, so the grouping
  // survives the user dragging sections around.
  const firstTechnique = sections.find((s) => s.kind === 'technique');
  const techniqueSpec = firstTechnique
    ? normaliseTechniqueSpec(firstTechnique.technique)
    : null;
  const techniqueKeyName = techniqueSpec
    ? keyLabel(techniqueSpec.tonic, techniqueSpec.mode)
    : null;

  for (const sec of sections) {
    if (sec === firstTechnique) {
      els.sectionList.appendChild(buildTechniqueGroupHeader(techniqueSpec));
    }

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
    // Under the group header the key is already stated, so "Scale · E minor"
    // reads as just "Scale". A section the user has renamed won't match the
    // generated pattern and is left exactly as they wrote it.
    const keySuffix = ` · ${techniqueKeyName}`;
    name.textContent =
      sec.kind === 'technique' && techniqueKeyName && sec.name.endsWith(keySuffix)
        ? sec.name.slice(0, -keySuffix.length)
        : sec.name;
    main.appendChild(name);

    // Derived join sections get a small kind badge so they're visually
    // distinct from the per-phrase sections they combine. Drills skip it —
    // the group header above them already says "Technique".
    if (SECTION_KIND_LABELS[sec.kind]) {
      li.classList.add(`section-kind-${sec.kind}`);
      if (sec.kind !== 'technique') {
        const kindBadge = document.createElement('span');
        kindBadge.className = 'section-list-kind-badge';
        kindBadge.textContent = SECTION_KIND_LABELS[sec.kind];
        kindBadge.title = SECTION_KIND_TITLES[sec.kind];
        main.appendChild(kindBadge);
      }
    }

    const meta = document.createElement('span');
    meta.className = 'section-list-meta';
    meta.textContent = formatSectionMeta(sec);
    main.appendChild(meta);

    // A drill's fingering, in the compact form a scale chart uses (tonic to
    // tonic — it extends cyclically). Derived from the stored spec, so it
    // stays right when the drills are re-keyed.
    if (sec.kind === 'technique') {
      const chart = techniqueFingering(sec.technique);
      if (chart) {
        const fingeringEl = document.createElement('span');
        fingeringEl.className = 'section-list-fingering';
        fingeringEl.textContent = chart.summary;
        fingeringEl.title = 'Fingering — 1 = thumb … 5 = little finger';
        main.appendChild(fingeringEl);
      }
    }

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

    // Wrong notes logged inside this section's window, so the list itself
    // shows where the piece is fighting back. Skipped for technique drills —
    // their ticks index a generated scale, not the piece.
    if (sec.kind !== 'technique' && mistakeRecords.length) {
      const misses = mistakesInSection(mistakeRecords, sec);
      if (misses > 0) {
        const missBadge = document.createElement('span');
        missBadge.className = 'section-list-miss-badge';
        missBadge.textContent = `✗ ${misses}`;
        missBadge.title =
          `${misses} wrong ${misses === 1 ? 'note' : 'notes'} logged in this passage`;
        main.appendChild(missBadge);
      }
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

    // Tempo-goal pill — shown once a target tempo is set for this section.
    const tempoSummary = tempoGoalSummary(sec);
    if (tempoSummary.hasGoal) {
      const tempoPill = document.createElement('span');
      tempoPill.className = 'section-list-tempo';
      if (tempoSummary.reached) tempoPill.classList.add('is-reached');
      tempoPill.textContent = `♩ ${tempoSummary.best || '–'}/${tempoSummary.target}`;
      tempoPill.title = tempoSummary.reached
        ? `Tempo goal reached — clean at ${tempoSummary.best} BPM (goal ${tempoSummary.target})`
        : `Best clean ${tempoSummary.best || 0} BPM of ${tempoSummary.target} BPM goal`;
      main.appendChild(tempoPill);
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

// --- Trouble spots -------------------------------------------------------

// Mistake tallies for the active piece, refreshed on select and after each
// wrong note. Shape: [{ tick, count, lastAt }] ascending by tick.
let mistakeRecords = [];

/** Reload the active piece's mistake history from IDB. */
async function refreshMistakesForActivePiece() {
  const piece = getActivePiece();
  if (!piece) { mistakeRecords = []; return; }
  try {
    const rows = await listMistakesForPiece(piece.id);
    if (getActivePiece() === piece) mistakeRecords = rows;
  } catch (err) {
    console.warn('Could not load mistake history', err);
    mistakeRecords = [];
  }
}

/**
 * Tally a wrong note against the piece.
 *
 * Technique drills are deliberately excluded: their ticks index a generated
 * scale on its own grid, so recording them would smear phantom trouble spots
 * across the opening bars of the actual piece.
 */
function noteMistake(section, info) {
  const piece = getActivePiece();
  if (!piece || !section || section.kind === 'technique') return;
  if (!info || !Number.isFinite(info.tick)) return;
  const tick = Math.round(info.tick);
  // Update the in-memory tally straight away so the UI reacts immediately;
  // the IDB write is best-effort behind it.
  const existing = mistakeRecords.find((r) => r.tick === tick);
  if (existing) existing.count += 1;
  else {
    mistakeRecords.push({ tick, count: 1, lastAt: Date.now() });
    mistakeRecords.sort((a, b) => a.tick - b.tick);
  }
  recordMistake(piece.id, tick).catch((err) => {
    console.warn('Could not record mistake', err);
  });
}

/** Ranked trouble spots for the active piece, each with a drillable range. */
function currentTroubleSpots() {
  const piece = getActivePiece();
  if (!piece || !Array.isArray(piece.notes)) return [];
  return troubleSpots(mistakeRecords, piece.notes, {
    ticksPerQuarter: piece.ticksPerQuarter,
    maxSpots: TROUBLE_MAX_SPOTS,
  });
}

/** How many trouble drills already exist for this piece. */
function troubleSectionsFor(piece) {
  const sections = piece && Array.isArray(piece.sections) ? piece.sections : [];
  return sections.filter((s) => s.kind === 'trouble');
}

/**
 * Describe where a spot is, preferring bar numbers — "bar 12" is how a player
 * thinks about a passage; a timestamp is how a file thinks about it.
 */
function troubleSpotLabel(piece, spot) {
  if (piece.scoreMeasures && piece.scoreMeasures.length) {
    const mr = measuresForSection(
      { measures: piece.scoreMeasures },
      { startTick: spot.startTick, endTick: spot.endTick },
      piece.ticksPerQuarter,
    );
    if (mr.count) {
      return mr.firstNumber === mr.lastNumber
        ? `bar ${mr.firstNumber}`
        : `bars ${mr.firstNumber}–${mr.lastNumber}`;
    }
  }
  // MIDI-only piece: fall back to where it sits on the clock.
  return formatClock(tickToSecForPiece(piece, spot.startTick));
}

/**
 * Turn a trouble spot into a real practice section, so it enters the SRS and
 * the daily queue like anything else. Unlike technique drills these are plain
 * tick windows into the piece — the notes are already there.
 */
async function drillTroubleSpot(spot) {
  const piece = getActivePiece();
  if (!piece || !Array.isArray(piece.sections) || !spot) return;

  // Don't stack duplicates: an existing drill covering the same peak is the
  // one to practise, not a second copy of it.
  const dupe = troubleSectionsFor(piece).find(
    (s) => spot.peakTick >= s.startTick && spot.peakTick < s.endTick,
  );
  if (dupe) {
    setStatus(`Already drilling ${dupe.name} — open it from the list.`);
    return;
  }

  const label = troubleSpotLabel(piece, spot);
  const maxOrder = piece.sections.reduce((m, s) => Math.max(m, s.order || 0), -1);
  const record = sectionToRecord({
    id: newSectionId(),
    pieceId: piece.id,
    name: `Trouble spot · ${label}`,
    startTick: spot.startTick,
    endTick: spot.endTick,
    startSec: tickToSecForPiece(piece, spot.startTick),
    endSec: tickToSecForPiece(piece, spot.endTick),
    noteCount: spot.noteCount,
    notes: `${spot.count} wrong notes logged here. Slow it right down until the `
      + 'approach is automatic, then bring it back up to tempo.',
    kind: 'trouble',
    addedAt: Date.now(),
    order: maxOrder + 1,
  });
  try {
    await saveSection(record);
  } catch (err) {
    console.error('Could not save trouble drill', err);
    setStatus('Could not create that drill.');
    return;
  }
  piece.sections.push(record);
  setStatus(`Added a drill for ${label} — ${spot.noteCount} notes.`);
  renderSectionsPanel();
  await refreshReviewQueue();
  renderReviewQueue();
  openPracticeView(record.id);
}

/** Seconds for a tick, using the piece's own notes as the reference. */
function tickToSecForPiece(piece, tick) {
  const notes = Array.isArray(piece.notes) ? piece.notes : [];
  // Find the note nearest this tick and interpolate from its own mapping —
  // avoids re-deriving the tempo map for a cosmetic timestamp.
  let best = null;
  for (const n of notes) {
    if (best === null || Math.abs(n.startTick - tick) < Math.abs(best.startTick - tick)) {
      best = n;
    }
  }
  if (!best) return 0;
  const tpq = piece.ticksPerQuarter || 480;
  const perTick = best.startTick > 0 ? best.startSec / best.startTick : 1 / (tpq * 2);
  return Math.max(0, tick * perTick);
}

/**
 * Render the trouble-spot panel above the section list. Stays hidden until the
 * history is worth acting on — a beginner's first pass through a piece is all
 * mistakes, and a heatmap of "everything" tells you nothing.
 */
function renderTroublePanel() {
  const host = els.troublePanel;
  if (!host || !els.troubleList) return;
  const piece = getActivePiece();
  const spots = piece ? currentTroubleSpots() : [];
  if (!spots.length) {
    host.hidden = true;
    els.troubleList.innerHTML = '';
    return;
  }
  host.hidden = false;

  const total = mistakeRecords.reduce((s, r) => s + (r.count || 0), 0);
  if (els.troubleSummary) {
    els.troubleSummary.textContent =
      `${total} wrong ${total === 1 ? 'note' : 'notes'} logged · worst ${spots.length} shown`;
  }

  const maxCount = spots[0].count;
  els.troubleList.innerHTML = '';
  const existing = troubleSectionsFor(piece);

  spots.forEach((spot) => {
    const li = document.createElement('li');
    li.className = `trouble-item is-${troubleHeat(spot.count, maxCount)}`;

    const bar = document.createElement('span');
    bar.className = 'trouble-item-bar';
    bar.style.width = `${Math.max(8, Math.round((spot.count / maxCount) * 100))}%`;
    li.appendChild(bar);

    const where = document.createElement('span');
    where.className = 'trouble-item-where';
    where.textContent = troubleSpotLabel(piece, spot);
    li.appendChild(where);

    const count = document.createElement('span');
    count.className = 'trouble-item-count';
    count.textContent = `${spot.count}×`;
    count.title = `${spot.count} wrong notes logged in this passage`;
    li.appendChild(count);

    const meta = document.createElement('span');
    meta.className = 'trouble-item-meta';
    meta.textContent = `${spot.noteCount} notes`;
    li.appendChild(meta);

    const drilled = existing.some(
      (s) => spot.peakTick >= s.startTick && spot.peakTick < s.endTick,
    );
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn btn-sm trouble-item-action';
    btn.textContent = drilled ? 'Drilling' : 'Drill it';
    btn.disabled = drilled;
    btn.title = drilled
      ? 'A drill for this passage is already in the section list'
      : 'Create a short practice section around this passage';
    btn.addEventListener('click', () => drillTroubleSpot(spot));
    li.appendChild(btn);

    els.troubleList.appendChild(li);
  });
}

/** Wipe the piece's mistake history (and offer to drop its drills with it). */
async function handleClearTroubleSpots() {
  const piece = getActivePiece();
  if (!piece) return;
  const drills = troubleSectionsFor(piece);
  const ok = window.confirm(
    'Clear this piece’s mistake history? The heatmap resets and trouble spots '
      + 'are recalculated from scratch.'
      + (drills.length
        ? `\n\nThe ${drills.length} trouble-spot section(s) you've already `
          + 'created stay put — delete them individually if you no longer want them.'
        : ''),
  );
  if (!ok) return;
  try {
    await deleteMistakesForPiece(piece.id);
  } catch (err) {
    console.warn('Could not clear mistake history', err);
  }
  mistakeRecords = [];
  setStatus('Mistake history cleared.');
  renderSectionsPanel();
}

// --- Technique drills ----------------------------------------------------

/** The active piece's technique sections, in stored order. */
function techniqueSectionsFor(piece) {
  const sections = piece && Array.isArray(piece.sections) ? piece.sections : [];
  return sections.filter((s) => s.kind === 'technique');
}

/**
 * Show the technique control in the sections header. Pieces imported before
 * this feature existed have no drills, so the button doubles as "add them" and
 * "these are in the wrong key" — a full Re-split would work too, but that
 * discards every section's practice history along with it.
 */
function renderTechniqueButton() {
  const btn = els.techniqueBtn;
  if (!btn) return;
  const piece = getActivePiece();
  if (!piece || !Array.isArray(piece.sections)) {
    btn.hidden = true;
    return;
  }
  // Once drills exist, the group header at the top of the list carries the
  // "Change key" control instead — it sits next to the key it changes. The
  // header button is only needed to offer drills that aren't there yet.
  btn.hidden = techniqueSectionsFor(piece).length > 0;
  btn.textContent = '♪ Add technique';
  btn.title = 'Add scale, arpeggio and cadence drills in this piece’s key';
}

/**
 * The banner that opens the technique block in the section list. Naming the
 * key once here lets the rows below read "Scale" / "Arpeggio" / "Cadence"
 * instead of repeating "· E minor" three times.
 */
function buildTechniqueGroupHeader(spec) {
  const li = document.createElement('li');
  li.className = 'section-group-header';

  const label = document.createElement('span');
  label.className = 'section-group-label';
  label.textContent = 'Technique';
  li.appendChild(label);

  if (spec) {
    const keyPill = document.createElement('span');
    keyPill.className = 'section-group-key';
    keyPill.textContent = keyLabel(spec.tonic, spec.mode);
    li.appendChild(keyPill);

    const notes = document.createElement('span');
    notes.className = 'section-group-scale';
    notes.textContent = scaleNoteNames(spec.tonic, spec.mode).join(' ');
    notes.title = spec.mode === 'minor'
      ? 'Harmonic minor — the raised 7th matches the dominant in the cadence'
      : `The notes of ${keyLabel(spec.tonic, spec.mode)}`;
    li.appendChild(notes);
  }

  const change = document.createElement('button');
  change.type = 'button';
  change.className = 'btn btn-sm section-group-action';
  change.textContent = 'Change key';
  change.title = 'Rebuild these drills in a different key';
  change.addEventListener('click', () => {
    if (els.techniqueForm && !els.techniqueForm.hidden) closeTechniqueForm();
    else openTechniqueForm();
  });
  li.appendChild(change);

  return li;
}

/** Fill the tonic dropdown, respelling the notes for the selected mode. */
function syncTechniqueTonicOptions(selected) {
  const sel = els.techniqueTonicInput;
  if (!sel) return;
  const mode = els.techniqueModeInput ? els.techniqueModeInput.value : 'major';
  const keep = typeof selected === 'number' ? selected : Number(sel.value) || 0;
  sel.innerHTML = '';
  for (let t = 0; t < 12; t++) {
    const opt = document.createElement('option');
    opt.value = String(t);
    opt.textContent = keyTonicName(t, mode);
    sel.appendChild(opt);
  }
  sel.value = String(keep);
  renderTechniquePreview();
}

/**
 * Spell out the scale the current selection would drill. Seeing "E F♯ G A B C
 * D♯" is a far faster check that the key is right than reading its name.
 */
function renderTechniquePreview() {
  const host = els.techniqueFormPreview;
  if (!host) return;
  const tonic = Number(els.techniqueTonicInput && els.techniqueTonicInput.value);
  const mode = els.techniqueModeInput && els.techniqueModeInput.value === 'minor'
    ? 'minor'
    : 'major';
  if (!Number.isFinite(tonic)) {
    host.textContent = '';
    return;
  }
  host.innerHTML = '';
  const notes = document.createElement('strong');
  notes.className = 'technique-form-preview-notes';
  notes.textContent = scaleNoteNames(tonic, mode).join(' ');
  host.appendChild(notes);

  const tail = document.createElement('span');
  tail.textContent = mode === 'minor'
    ? ' — harmonic minor, so the 7th is raised'
    : '';
  host.appendChild(tail);
}

/** Open the add/re-key form, prefilled with the piece's current key. */
function openTechniqueForm() {
  const piece = getActivePiece();
  if (!piece || !els.techniqueForm) return;
  const existing = techniqueSectionsFor(piece);

  // Prefer the key the existing drills were built in; otherwise resolve one
  // from the score's key signature or the notes themselves.
  let key = null;
  const spec = existing.length ? normaliseTechniqueSpec(existing[0].technique) : null;
  if (spec) {
    key = { tonic: spec.tonic, mode: spec.mode, source: 'existing' };
  } else if (Array.isArray(piece.notes)) {
    key = resolveKey({
      notes: piece.notes,
      keySignature: piece.keySignature || null,
      ticksPerQuarter: piece.ticksPerQuarter,
    });
  }
  if (!key) key = { tonic: 0, mode: 'major', source: 'detected', confidence: 0 };

  if (els.techniqueModeInput) els.techniqueModeInput.value = key.mode;
  syncTechniqueTonicOptions(key.tonic);

  if (els.techniqueFormHint) {
    // Say where the key came from — a low-confidence guess is worth checking
    // before drilling the wrong scale for a fortnight.
    let hint;
    if (key.source === 'existing') {
      hint = `Currently drilling ${keyLabel(key.tonic, key.mode)}. `
        + 'Re-keying replaces the drills and their practice history.';
    } else if (key.source === 'signature') {
      hint = `Read ${keyLabel(key.tonic, key.mode)} from the score’s key signature.`;
    } else if (key.confidence > 0.05) {
      hint = `Detected ${keyLabel(key.tonic, key.mode)} from the notes.`;
    } else {
      hint = `Best guess is ${keyLabel(key.tonic, key.mode)}, but this piece’s `
        + 'key is ambiguous — worth setting by hand.';
    }
    els.techniqueFormHint.textContent = hint;
  }
  if (els.techniqueFormSubmit) {
    els.techniqueFormSubmit.textContent = existing.length ? 'Rebuild drills' : 'Add drills';
  }
  els.techniqueForm.hidden = false;
}

/** Hide the technique form. */
function closeTechniqueForm() {
  if (els.techniqueForm) els.techniqueForm.hidden = true;
}

/**
 * Create (or replace) the piece's technique sections in the chosen key.
 * Only technique sections are touched — the piece's own phrase sections and
 * their schedules are left exactly as they are.
 */
async function handleTechniqueSubmit(event) {
  if (event) event.preventDefault();
  const piece = getActivePiece();
  if (!piece || !Array.isArray(piece.sections)) return;

  const tonic = Number(els.techniqueTonicInput && els.techniqueTonicInput.value);
  const mode = els.techniqueModeInput && els.techniqueModeInput.value === 'minor'
    ? 'minor'
    : 'major';
  if (!Number.isFinite(tonic)) return;

  const existing = techniqueSectionsFor(piece);
  if (existing.length) {
    const ok = window.confirm(
      `Rebuild the technique drills in ${keyLabel(tonic, mode)}? The current `
        + 'drills and their practice progress will be discarded.',
    );
    if (!ok) return;
    // The open section may be one we're about to delete.
    if (practiceState && existing.some((s) => s.id === practiceState.sectionId)) {
      closePracticeView({ silent: true });
    }
    try {
      for (const s of existing) await deleteSection(s.id);
      await deleteRepLogsForSections(existing.map((s) => s.id));
    } catch (err) {
      console.warn('Could not fully clear old technique sections', err);
    }
    piece.sections = piece.sections.filter((s) => s.kind !== 'technique');
  }

  // Drills lead the list, so they take orders 0..n-1 and everything already on
  // the piece shifts down to make room. Renumbering by current position keeps
  // any ordering the user has already dragged into place.
  const specs = techniqueSpecsForKey({ tonic, mode }, 0);
  const now = Date.now();
  const added = specs.map((range, i) => sectionToRecord({
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
    technique: range.technique,
    addedAt: now + i,
    order: i,
  }));
  for (const record of added) {
    try { await saveSection(record); } catch (_) { /* best-effort */ }
  }

  const shifted = piece.sections
    .slice()
    .sort((a, b) => (a.order || 0) - (b.order || 0) || (a.addedAt || 0) - (b.addedAt || 0))
    .map((s, i) => ({ id: s.id, order: specs.length + i }));
  try {
    if (shifted.length) await reorderSections(shifted);
    const orderMap = new Map(shifted.map((u) => [u.id, u.order]));
    for (const s of piece.sections) s.order = orderMap.get(s.id) ?? s.order;
  } catch (err) {
    console.warn('Could not renumber sections after adding drills', err);
  }

  piece.sections.unshift(...added);
  piece.sections.sort((a, b) => (a.order || 0) - (b.order || 0));
  piece.key = { tonic, mode };

  closeTechniqueForm();
  repCountsToday.clear();
  setStatus(`Technique drills ready in ${keyLabel(tonic, mode)}.`);
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

  // A whole-piece Listen / play-through gives way to section practice.
  stopPieceListen();
  if (isPieceRun()) closePracticeView({ silent: true });

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
  // Tempo goals: restore this section's working tempo onto the metronome so it
  // picks up where it left off, and paint a fresh (non-editing) tempo card.
  tempoGoalEditing = false;
  initSectionTempo(section);
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
  renderPracticeFingering(section);
  // Item 20 — show cumulative practice time for this section.
  updatePracticeTotalTime(section);

  if (els.practiceGoal) els.practiceGoal.textContent = String(REP_GOAL);
  if (els.practiceProgressTrack) {
    els.practiceProgressTrack.setAttribute('aria-valuemax', String(REP_GOAL));
  }
}

/**
 * The fingering chart shown above the player for a technique drill: note
 * names across the top, one row of finger numbers per hand — the line a scale
 * book prints over the stave. The falling notes carry the same digits one at
 * a time; this is the whole pattern at once, which is what you actually learn
 * a scale from. Hidden for ordinary sections, whose fingerings live on the
 * score and the falling notes.
 */
function renderPracticeFingering(section) {
  const host = els.practiceFingering;
  if (!host) return;
  host.innerHTML = '';
  const chart = section && section.kind === 'technique'
    ? techniqueFingering(section.technique)
    : null;
  if (!chart) {
    host.hidden = true;
    return;
  }

  const head = document.createElement('div');
  head.className = 'practice-fingering-head';
  const label = document.createElement('span');
  label.className = 'practice-fingering-label';
  label.textContent = 'Fingering';
  head.appendChild(label);
  const caption = document.createElement('span');
  caption.className = 'practice-fingering-caption';
  caption.textContent = chart.caption;
  head.appendChild(caption);
  host.appendChild(head);

  // The table scrolls sideways inside its own box on narrow screens rather
  // than wrapping — a fingering pattern split across lines is unreadable.
  const scroller = document.createElement('div');
  scroller.className = 'practice-fingering-scroll';
  const table = document.createElement('table');
  table.className = `practice-fingering-table is-${chart.layout}`;

  const cell = (tag, text, className) => {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (text !== undefined) el.textContent = text;
    return el;
  };
  const handHeader = (hand) => {
    const th = cell('th', hand, 'practice-fingering-hand');
    th.scope = 'row';
    th.title = hand === 'RH' ? 'Right hand' : 'Left hand';
    return th;
  };

  if (chart.layout === 'run') {
    // Header: the note names. Body: one row per hand, a finger per note.
    const thead = document.createElement('thead');
    const nameRow = document.createElement('tr');
    nameRow.appendChild(cell('th', '', 'practice-fingering-corner'));
    for (const name of chart.names) {
      const th = cell('th', name, 'practice-fingering-note');
      th.scope = 'col';
      nameRow.appendChild(th);
    }
    thead.appendChild(nameRow);
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    for (const h of chart.hands) {
      const tr = document.createElement('tr');
      tr.appendChild(handHeader(h.hand));
      h.fingers.forEach((f, i) => {
        const td = cell('td', String(f), 'practice-fingering-finger');
        // Mark the thumb so the crossing points jump out — that's the part of
        // a scale fingering you're really memorising.
        if (f === 1) td.classList.add('is-thumb');
        // The tonics frame each octave.
        if (i % chart.cycle === 0) td.classList.add('is-tonic');
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
  } else {
    // Chords: header row of Roman numerals; each hand's cell stacks the chord
    // tones over their fingers so finger sits under note.
    const thead = document.createElement('thead');
    const labelRow = document.createElement('tr');
    labelRow.appendChild(cell('th', '', 'practice-fingering-corner'));
    for (const c of chart.chords) {
      const th = cell('th', c.label, 'practice-fingering-chord-label');
      th.scope = 'col';
      labelRow.appendChild(th);
    }
    thead.appendChild(labelRow);
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    for (const hand of ['rh', 'lh']) {
      const tr = document.createElement('tr');
      tr.appendChild(handHeader(hand === 'rh' ? 'RH' : 'LH'));
      for (const c of chart.chords) {
        const voicing = c[hand];
        const td = cell('td', undefined, 'practice-fingering-chord');
        voicing.notes.forEach((note, i) => {
          const voice = cell('span', undefined, 'practice-fingering-voice');
          voice.appendChild(cell('span', note, 'practice-fingering-note'));
          const f = cell('span', String(voicing.fingers[i]), 'practice-fingering-finger');
          if (voicing.fingers[i] === 1) f.classList.add('is-thumb');
          voice.appendChild(f);
          td.appendChild(voice);
        });
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
  }

  scroller.appendChild(table);
  host.appendChild(scroller);
  host.hidden = false;
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
      onMistake: (info) => {
        const sec = getActiveSection();
        if (info && info.reset === false) {
          // Lenient play-through: the run carries on from where it is.
          setStatus('Wrong note — counted. Keep going.');
        } else {
          setStatus('Wrong note — run reset. Play the section again from the top.');
          // Snap the score cursor back to the section's start on a reset.
          if (sheetCursorReady() && sec) sheetView.moveCursorToTick(sec.startTick);
        }
        // Tally where it went wrong so the piece's weak spots surface later.
        noteMistake(sec, info);
      },
      // Follow-cursor: advance the engraved-score cursor to each new step.
      onProgress: (info) => {
        if (sheetCursorReady() && info && typeof info.tick === 'number') {
          sheetView.moveCursorToTick(info.tick);
        }
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
  // within-session ramp from today's already-completed clean runs. A
  // whole-piece play-through is a read-through, not a memory drill: full
  // cues, and wrong notes are counted rather than resetting the run.
  const pieceRun = section.kind === 'piece';
  const baseStage = pieceRun ? 0 : memoryBaselineStage(section);
  const runIndex = pieceRun ? 0 : practiceState ? practiceState.count : 0;
  // A technique drill's notes aren't in the piece — they're regenerated from
  // the section's stored spec onto their own tick grid. Handing the player a
  // stand-in piece lets the drill run through the unmodified load path, so it
  // gets the same wait-mode grading, hand toggle and memory fade as real music.
  player.load(techniquePieceFor(section) || piece, section, {
    baseStage,
    runIndex,
    strict: !pieceRun,
  });
  // Reading aids / display prefs from the settings menu, then the one-time
  // input defaults (hand, guide keys, computer keys) for this session.
  player.applySettings(getAllSettings());
  player.start();
  applySessionDefaultsToPlayer();
  // On the engraved score: highlight this section's measures and park the
  // cursor at its first onset.
  syncSheetToSection(piece, section);
}

/**
 * The stand-in piece for a technique drill — `{ticksPerQuarter, notes}` built
 * fresh from the section's stored spec. Null for ordinary sections, which read
 * their notes out of the real piece.
 */
function techniquePieceFor(section) {
  if (!section || section.kind !== 'technique') return null;
  const spec = normaliseTechniqueSpec(section.technique);
  if (!spec) return null;
  const built = techniquePieceForSpec(spec);
  // Fingerings are already stamped on generated notes as `scoreFinger`, which
  // annotateFingerings treats as authoritative — so this fills in `hand`
  // without overriding the textbook pattern.
  annotateFingerings(built.notes, { ticksPerQuarter: built.ticksPerQuarter });
  return built;
}

/**
 * True when the sheet view is rendered and the active piece has a score.
 *
 * A technique drill is deliberately excluded: its ticks index a generated
 * scale, not the engraved score, so following them would drag the cursor
 * through unrelated bars of the piece.
 */
function sheetCursorReady() {
  const piece = getActivePiece();
  const section = getActiveSection();
  if (section && section.kind === 'technique') return false;
  return !!(sheetView && sheetView.isReady() && piece && piece.hasScore);
}

/**
 * Highlight a section's measures on the engraved score and move the cursor to
 * its first onset. No-op for MIDI-only pieces or before the score has rendered.
 */
function syncSheetToSection(piece, section) {
  // Technique drills have no place on the score — drop any highlight left over
  // from the section practised before this one.
  if (section && section.kind === 'technique') {
    if (sheetView && sheetView.isReady()) {
      sheetView.clearHighlight();
      sheetView.clearCursor();
    }
    return;
  }
  if (!sheetCursorReady()) return;
  // The whole piece has no "section" to frame — just start the cursor at the
  // top and let it follow the run.
  if (section && section.kind === 'piece') {
    sheetView.clearHighlight();
    sheetView.moveCursorToTick(section.startTick);
    return;
  }
  if (!piece.scoreMeasures) return;
  const mr = measuresForSection(
    { measures: piece.scoreMeasures }, section, piece.ticksPerQuarter,
  );
  if (mr.count) {
    sheetView.highlightMeasures(mr.measures[0].index, mr.measures[mr.count - 1].index);
  } else {
    sheetView.clearHighlight();
  }
  sheetView.moveCursorToTick(section.startTick);
}

/**
 * A clean run-through was detected by the engine — this is the MIDI-era
 * replacement for the old self-reported "Rep done" button. Persist one
 * repetition toward today's goal of 10, reusing the exact same rep-log /
 * queue / stats / SM-2 pipeline the button used.
 */
async function recordCleanRun(info = {}) {
  if (!practiceState) return;
  // Whole-piece play-through: nothing is banked — just keep the session tally.
  if (isPieceRun()) {
    const slips = Number.isFinite(info.mistakes) ? info.mistakes : 0;
    practiceState.runs = (practiceState.runs || 0) + 1;
    if (practiceState.bestSlips === null || slips < practiceState.bestSlips) {
      practiceState.bestSlips = slips;
    }
    setStatus(
      slips === 0
        ? 'Whole piece, not a single wrong note. 🎉'
        : `Whole piece played through — ${slips} wrong note${slips === 1 ? '' : 's'}.`,
    );
    renderPracticePanel();
    return;
  }
  const { sectionId, dateISO, count } = practiceState;
  if (isRepGoalMet(count)) return;

  // Hesitation-hinted runs count as HALF a rep: the first one banks a half
  // (no persisted increment — rep logs stay integers), the second completes
  // it and falls through to the normal one-rep path. Session-scoped: a
  // banked half doesn't survive a refresh, which errs on the strict side.
  if (info.hinted) {
    if (!practiceState.pendingHalfRep) {
      practiceState.pendingHalfRep = true;
      const why = info.hints
        ? `${info.hints} hint${info.hints === 1 ? '' : 's'}`
        : 'key guides on';
      setStatus(
        `Run done with ${why} — that's half a rep. One more run to bank it.`,
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
    // Tempo goals: if the metronome was running, this clean run happened at its
    // BPM — bank a new best if it beats the section's record.
    const tempoBest = maybeRecordTempoAchievement(getActiveSection(), {
      hinted: info.hinted,
    });
    if (isRepGoalMet(persisted.count)) {
      setStatus(`All ${persisted.count} clean runs done — pick a rating to schedule the next review.`);
    } else if (tempoBest !== null) {
      setStatus(`Clean run ${persisted.count} of ${REP_GOAL} — new best tempo, ${tempoBest} BPM! 🎉`);
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
  // Item 19 — persist cumulative practice time before clearing state. A
  // whole-piece play-through has no stored section to credit, so it's skipped.
  if (practiceState && !isPieceRun()) {
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
  // Tempo goals — remember where the metronome was left for this section.
  persistWorkingTempo();
  stopMetronome(); // item 12b — silence metronome when leaving practice
  if (player) player.stop(); // stop the Synthesia engine + release MIDI input
  // Clear the score's section highlight + follow cursor when leaving practice.
  if (sheetView && sheetView.isReady()) {
    sheetView.clearHighlight();
    sheetView.clearCursor();
  }
  if (els.viewerMidi) {
    els.viewerMidi.classList.remove('is-practicing');
    els.viewerMidi.classList.remove('has-up-next');
  }
  if (els.practiceUpNext) {
    els.practiceUpNext.hidden = true;
    els.practiceUpNext.innerHTML = '';
  }
  tempoGoalEditing = false;
  if (els.tempoGoal) els.tempoGoal.hidden = true;
  const wasActive = !!practiceState;
  practiceState = null;
  if (els.practicePanel) {
    els.practicePanel.hidden = true;
    els.practicePanel.classList.remove('is-piece-run');
  }
  if (els.practiceEyebrow) els.practiceEyebrow.textContent = 'Practicing';
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
  const pieceRun = isPieceRun();
  els.practicePanel.classList.toggle('is-piece-run', pieceRun);
  if (els.practiceEyebrow) {
    els.practiceEyebrow.textContent = pieceRun ? 'Playing through' : 'Practicing';
  }
  if (pieceRun) {
    // No reps, ratings, tempo goal or up-next rail — just the run itself and
    // a session tally.
    if (els.practiceStatus) {
      const { runs, bestSlips } = practiceState;
      els.practiceStatus.textContent = runs > 0
        ? `${runs} play-through${runs === 1 ? '' : 's'} this session · best: `
          + `${bestSlips === 0 ? 'no wrong notes' : `${bestSlips} wrong note${bestSlips === 1 ? '' : 's'}`}.`
        : 'Play the whole piece from the top. Wrong notes are counted (and logged as trouble spots) but never reset the run — and nothing here counts toward the section reviews.';
      els.practiceStatus.hidden = false;
    }
    renderNextReview(null);
    renderRatingPrompt(null);
    if (els.practiceResetBtn) els.practiceResetBtn.disabled = true;
    updateReviewSessionBar();
    renderUpNext(null);
    renderTempoGoal(null);
    return;
  }
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

  // "Up next" side rail — the next section in this piece's practice path.
  renderUpNext(section);

  // Tempo-goal card (works the metronome).
  renderTempoGoal(section);
}

/**
 * Render the "Up next" side rail: the next section in this piece's practice
 * path (see buildPracticeSequence), so the user can see what's coming while
 * they play and jump straight to it when the current section is done.
 *
 * Hidden during a guided daily review — that run already drives its own
 * cross-piece navigation via the review bar, and two competing "next"
 * affordances would be confusing.
 */
function renderUpNext(section) {
  const host = els.practiceUpNext;
  if (!host) return;
  const piece = getActivePiece();
  const hide = () => {
    host.hidden = true;
    host.innerHTML = '';
    if (els.viewerMidi) els.viewerMidi.classList.remove('has-up-next');
  };
  if (
    !section ||
    !piece ||
    !Array.isArray(piece.sections) ||
    piece.sections.length <= 1 ||
    reviewSession ||
    isPieceRun() // the whole piece isn't a step on the path
  ) {
    hide();
    return;
  }

  const seq = buildPracticeSequence(piece.sections);
  const idx = seq.findIndex((s) => s.id === section.id);
  const total = seq.length;
  const next = idx >= 0 && idx + 1 < total ? seq[idx + 1] : null;

  host.innerHTML = '';
  host.hidden = false;
  if (els.viewerMidi) els.viewerMidi.classList.add('has-up-next');

  const eyebrow = document.createElement('span');
  eyebrow.className = 'practice-up-next-eyebrow';
  eyebrow.textContent = next ? 'Up next' : 'Practice path';
  host.appendChild(eyebrow);

  if (idx >= 0) {
    const pos = document.createElement('span');
    pos.className = 'practice-up-next-pos';
    pos.textContent = `Step ${idx + 1} of ${total}`;
    host.appendChild(pos);
  }

  if (!next) {
    const done = document.createElement('p');
    done.className = 'practice-up-next-done';
    done.textContent =
      'Last step in this piece — nice work finishing the path.';
    host.appendChild(done);
    return;
  }

  const card = document.createElement('div');
  card.className = 'practice-up-next-card';
  if (SECTION_KIND_LABELS[next.kind]) {
    card.classList.add(`section-kind-${next.kind}`);
  }

  const name = document.createElement('span');
  name.className = 'practice-up-next-name';
  name.textContent = next.name;
  card.appendChild(name);

  if (SECTION_KIND_LABELS[next.kind]) {
    const badge = document.createElement('span');
    badge.className = 'section-list-kind-badge';
    badge.textContent = SECTION_KIND_LABELS[next.kind];
    card.appendChild(badge);
  }

  const meta = document.createElement('span');
  meta.className = 'practice-up-next-meta';
  meta.textContent = formatSectionMeta(next);
  card.appendChild(meta);

  // Today's progress on the next section, if the user has already touched it.
  const nextCount = repCountsToday.get(next.id) || 0;
  if (nextCount > 0) {
    const prog = document.createElement('span');
    prog.className = 'practice-up-next-progress';
    prog.textContent = isRepGoalMet(nextCount)
      ? `Done today · ${nextCount}/${REP_GOAL}`
      : `${nextCount}/${REP_GOAL} today`;
    card.appendChild(prog);
  }

  host.appendChild(card);

  const goBtn = document.createElement('button');
  goBtn.type = 'button';
  goBtn.className = 'btn btn-sm btn-practice practice-up-next-go';
  goBtn.textContent = 'Practice next →';
  const goalMet = isRepGoalMet(practiceState ? practiceState.count : 0);
  if (goalMet) goBtn.classList.add('is-ready');
  goBtn.title = goalMet
    ? `Move on to "${next.name}"`
    : `Jump ahead to "${next.name}" — you can come back to this one`;
  goBtn.addEventListener('click', () => openPracticeView(next.id));
  host.appendChild(goBtn);

  // Start an auto-advancing run through the rest of the path from here. Only
  // worth offering when more than one step remains (next + at least one more).
  const seqLen = seq.length;
  if (idx >= 0 && seqLen - idx > 1) {
    const runBtn = document.createElement('button');
    runBtn.type = 'button';
    runBtn.className = 'btn btn-sm practice-up-next-run';
    runBtn.textContent = '▶ Run path from here';
    runBtn.title =
      'Auto-advance through the rest of the path — finish and rate each step to roll on';
    runBtn.addEventListener('click', () => startPathFromHere());
    host.appendChild(runBtn);
  }
}

/** Find the currently-being-practiced section, or null. */
function getActiveSection() {
  if (!practiceState) return null;
  // A whole-piece play-through practises a synthetic section that isn't in
  // the piece's stored list.
  if (practiceState.mode === 'piece') return practiceState.section || null;
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
    const [allSections, countsByDate, allRepLogs] = await Promise.all([
      listAllSections(),
      getRepCountsForDate(dateISO),
      listAllRepLogs(),
    ]);
    // Lifetime rep totals → per-section time estimates for the planner.
    const totals = new Map();
    for (const log of allRepLogs) {
      if (!log || typeof log.sectionId !== 'string') continue;
      const count = Number(log.count) || 0;
      if (count > 0) totals.set(log.sectionId, (totals.get(log.sectionId) || 0) + count);
    }
    lifetimeRepTotals = totals;
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
  // The session planner reads the same snapshot — keep it in lockstep with
  // every queue repaint (rep counts, ratings, deletes, in-flight clicks).
  renderSessionPlanner();
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
  reviewSession = { kind: 'review', items, index: 0 };
  setStatus(
    `Daily review — ${items.length} section${items.length === 1 ? '' : 's'} to go.`,
  );
  handleReviewQueueClick(items[reviewSession.index]);
}

// --- Plan-a-session (timed sessions, home dashboard) ----------------------
//
// "I have N minutes" → buildSessionPlan (srs.js) packs due reviews first,
// then new sections to learn, into the budget using per-section time
// estimates from real practice history. Starting the plan reuses the guided
// review-session machinery with kind 'planned'.

/** Read the persisted session length, clamped to the input's bounds. */
function readSessionPlanMinutes() {
  try {
    const n = parseInt(localStorage.getItem(SESSION_MINUTES_KEY), 10);
    if (Number.isFinite(n)) {
      return Math.min(SESSION_MINUTES_MAX, Math.max(SESSION_MINUTES_MIN, n));
    }
  } catch (_) {
    // localStorage unavailable — fall through to the default.
  }
  return SESSION_MINUTES_DEFAULT;
}

/** Persist the session length. Best-effort. */
function writeSessionPlanMinutes(minutes) {
  try {
    localStorage.setItem(SESSION_MINUTES_KEY, String(minutes));
  } catch (_) {
    // Unavailable — the value still applies this session.
  }
}

/** "~4m" copy for a plan estimate (rounded, floored at 1 minute). */
function formatPlanEstimate(ms) {
  return `~${Math.max(1, Math.round((Number(ms) || 0) / 60000))}m`;
}

/**
 * Order new-section candidates for the planner: pieces the user has already
 * started come first (most recently practiced first), and within a piece the
 * sections follow the pedagogical practice path — so "learn next" means the
 * next step on the path, not a random section.
 */
function orderNewSectionsForPlan(candidates) {
  if (!queueState || candidates.length === 0) return candidates;
  const wanted = new Set(candidates.map((s) => s.id));
  const byPiece = new Map();
  for (const s of queueState.sections) {
    if (!s || typeof s.pieceId !== 'string') continue;
    let group = byPiece.get(s.pieceId);
    if (!group) {
      group = { sections: [], started: false, lastPracticed: 0 };
      byPiece.set(s.pieceId, group);
    }
    group.sections.push(s);
    if (s.lastReviewedDate) group.started = true;
    if (typeof s.lastPracticedAt === 'number' && s.lastPracticedAt > group.lastPracticed) {
      group.lastPracticed = s.lastPracticedAt;
    }
  }
  const groups = Array.from(byPiece.values());
  groups.sort((a, b) => {
    if (a.started !== b.started) return a.started ? -1 : 1;
    return b.lastPracticed - a.lastPracticed;
  });
  const ordered = [];
  const seen = new Set();
  for (const g of groups) {
    let seq;
    try {
      seq = buildPracticeSequence(g.sections);
    } catch (_) {
      seq = g.sections;
    }
    for (const s of seq) {
      if (wanted.has(s.id) && !seen.has(s.id)) {
        ordered.push(s);
        seen.add(s.id);
      }
    }
  }
  // Any candidate the grouping missed (e.g. no pieceId) keeps its old spot
  // at the end rather than silently dropping out of the plan.
  for (const s of candidates) {
    if (!seen.has(s.id)) ordered.push(s);
  }
  return ordered;
}

/** Build the current session plan from the live queue snapshot. */
function currentSessionPlan() {
  if (!queueState) return null;
  for (const p of pieces) {
    queueState.pieceTitleById.set(p.id, {
      id: p.id,
      title: p.title,
      noteCount: p.noteCount,
    });
  }
  return buildSessionPlan({
    sections: queueState.sections,
    piecesById: queueState.pieceTitleById,
    repCountsToday: queueState.countsByDate,
    lifetimeRepCounts: lifetimeRepTotals,
    todayISO: queueState.dateISO,
    minutes: sessionPlanMinutes,
    repGoal: REP_GOAL,
    orderNewSections: orderNewSectionsForPlan,
  });
}

/** Paint the plan-a-session panel. Hidden when there's nothing to practice. */
function renderSessionPlanner() {
  const panel = els.sessionPlanPanel;
  const list = els.sessionPlanList;
  if (!panel || !list) return;

  const plan = currentSessionPlan();
  const hasWork = !!plan && (plan.dueTotal > 0 || plan.newAvailable > 0);
  if (!hasWork) {
    panel.hidden = true;
    list.innerHTML = '';
    return;
  }
  panel.hidden = false;

  // Minutes input + presets (don't clobber the field mid-edit).
  if (els.sessionPlanMinutes && document.activeElement !== els.sessionPlanMinutes) {
    els.sessionPlanMinutes.value = String(sessionPlanMinutes);
  }
  for (const btn of panel.querySelectorAll('.session-plan-preset')) {
    btn.classList.toggle(
      'is-active',
      Number(btn.dataset.minutes) === sessionPlanMinutes,
    );
  }

  // Summary: how much of the box the plan fills.
  if (els.sessionPlanSummary) {
    els.sessionPlanSummary.textContent =
      plan.items.length === 0
        ? ''
        : `${formatPlanEstimate(plan.totalMs)} planned · ${plan.budgetMs / 60000}m budget`;
  }

  // Plan list.
  list.innerHTML = '';
  for (const item of plan.items) {
    const li = document.createElement('li');
    li.className = 'session-plan-item';

    const info = document.createElement('div');
    info.className = 'session-plan-item-info';
    const name = document.createElement('span');
    name.className = 'session-plan-item-name';
    name.textContent = item.section.name || '(unnamed section)';
    info.appendChild(name);
    const piece = document.createElement('span');
    piece.className = 'session-plan-item-piece';
    piece.textContent = item.piece.title || '(unknown piece)';
    info.appendChild(piece);
    li.appendChild(info);

    const badge = document.createElement('span');
    badge.className = `session-plan-item-type ${
      item.type === 'review' ? 'is-review' : 'is-new'
    }`;
    badge.textContent =
      item.type === 'review'
        ? item.daysOff < 0
          ? 'Overdue'
          : 'Review'
        : 'Learn';
    li.appendChild(badge);

    const time = document.createElement('span');
    time.className = 'session-plan-item-time';
    time.textContent = formatPlanEstimate(item.estimateMs);
    li.appendChild(time);

    list.appendChild(li);
  }

  // Note line: what didn't fit (or that the single item overflows).
  if (els.sessionPlanNote) {
    const notes = [];
    const dueSkipped = plan.dueTotal - plan.dueIncluded;
    const newSkipped = plan.newAvailable - plan.newIncluded;
    if (plan.totalMs > plan.budgetMs) {
      notes.push('This runs slightly over your time — it’s the highest-priority item.');
    }
    if (dueSkipped > 0) {
      notes.push(
        `${dueSkipped} due review${dueSkipped === 1 ? '' : 's'} didn’t fit — add time to cover the backlog.`,
      );
    } else if (newSkipped > 0) {
      notes.push(
        `${newSkipped} more section${newSkipped === 1 ? '' : 's'} to learn when you have longer.`,
      );
    }
    els.sessionPlanNote.textContent = notes.join(' ');
    els.sessionPlanNote.hidden = notes.length === 0;
  }

  if (els.startSessionPlanBtn) {
    els.startSessionPlanBtn.disabled = queueClickInFlight || plan.items.length === 0;
    els.startSessionPlanBtn.textContent =
      plan.items.length === 0
        ? '▶ Start session'
        : `▶ Start session (${plan.items.length} · ${formatPlanEstimate(plan.totalMs)})`;
  }
}

/** Commit a new session length and repaint the plan. */
function setSessionPlanMinutes(minutes) {
  const n = Math.round(Number(minutes));
  if (!Number.isFinite(n)) return;
  sessionPlanMinutes = Math.min(SESSION_MINUTES_MAX, Math.max(SESSION_MINUTES_MIN, n));
  writeSessionPlanMinutes(sessionPlanMinutes);
  renderSessionPlanner();
}

/**
 * Start a guided run through the planned session — same auto-advance
 * machinery as the daily review, but over the plan's review+learn mix.
 */
function startPlannedSession() {
  const plan = currentSessionPlan();
  if (!plan || plan.items.length === 0) return;
  reviewSession = { kind: 'planned', items: plan.items, index: 0 };
  setStatus(
    `Timed session — ${plan.items.length} section${plan.items.length === 1 ? '' : 's'}, ` +
      `about ${Math.max(1, Math.round(plan.totalMs / 60000))} minutes. Go!`,
  );
  handleReviewQueueClick(plan.items[0]);
}

// --- Guided practice-path run (single piece) -----------------------------
//
// A path run reuses the same guided-session plumbing as the daily review
// (auto-advance after each rating, the session bar, Skip / Stop) but is scoped
// to ONE piece and walks its pedagogical practice path (buildPracticeSequence)
// instead of the cross-piece due queue. `reviewSession.kind` distinguishes the
// two so the shared advance/bar/teardown code can branch where they differ
// (the path run leaves you on the piece; the daily review returns to the
// dashboard).

/**
 * Build path-run items ({section, piece}) from a piece's practice sequence,
 * optionally starting partway through (from `fromSectionId` onward). Each item
 * is shaped like a review-queue item so handleReviewQueueClick can open it.
 */
function buildPathItems(piece, fromSectionId) {
  if (!piece || !Array.isArray(piece.sections)) return [];
  const seq = buildPracticeSequence(piece.sections);
  let start = 0;
  if (fromSectionId) {
    const idx = seq.findIndex((s) => s.id === fromSectionId);
    if (idx >= 0) start = idx;
  }
  const pieceRef = { id: piece.id, title: piece.title };
  return seq.slice(start).map((section) => ({ section, piece: pieceRef }));
}

/**
 * Enter a path run over `items`. When `openFirst` is true the first step is
 * opened (used when starting from the piece overview); otherwise the caller's
 * section is already open (used when continuing mid-practice) and we just paint
 * the session bar.
 */
function beginPathRun(items, openFirst) {
  if (!items || items.length === 0) return;
  reviewSession = { kind: 'path', items, index: 0 };
  setStatus(
    `Practice path — ${items.length} step${items.length === 1 ? '' : 's'}; ` +
      'finish and rate each to roll on.',
  );
  if (openFirst) {
    handleReviewQueueClick(items[0]);
  } else {
    // The current section is already open — refresh the panel so the path bar
    // shows and the "Up next" rail hides.
    renderPracticePanel();
  }
}

/** Start a path run from the top of the active piece's practice path. */
function startPathFromTop() {
  const piece = getActivePiece();
  const items = buildPathItems(piece, null);
  if (items.length < 2) {
    setStatus('This piece needs at least two practice steps to run a path.');
    return;
  }
  beginPathRun(items, true);
}

/**
 * Continue the path from the section being practised: auto-advance through the
 * remaining steps. Called from the "Up next" rail.
 */
function startPathFromHere() {
  const section = getActiveSection();
  const piece = getActivePiece();
  if (!section || !piece) return;
  const items = buildPathItems(piece, section.id);
  if (items.length < 2) {
    setStatus('You’re on the last step of the path.');
    return;
  }
  beginPathRun(items, false);
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

/** End the guided session. Daily review returns to the cross-piece dashboard;
 * a single-piece path run leaves the user on the piece they're working. */
function endReviewSession({ completed } = {}) {
  const kind = reviewSession ? reviewSession.kind : null;
  const wasRunning = !!reviewSession;
  reviewSession = null;
  if (els.reviewSessionBar) els.reviewSessionBar.hidden = true;
  if (wasRunning && kind !== 'path') showDashboard();
  if (completed) {
    setStatus(
      kind === 'path'
        ? 'Reached the end of the practice path — great run. 🎉'
        : kind === 'planned'
          ? 'Timed session complete — everything you planned is done. 🎉'
          : 'Daily review complete — every due section is done. 🎉',
    );
  } else if (kind === 'path') {
    setStatus('Stopped the practice path.');
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
  if (els.homeBtn) els.homeBtn.hidden = true; // home button is piece-view only
  renderReviewQueue();
  renderStats();
  renderContinuePanel();
}

/**
 * Home button handler: leave the current piece (closing any practice session /
 * open form first) and return to the dashboard. Safe to call from anywhere.
 */
function goHome() {
  closePracticeView({ silent: true });
  stopPieceListen();
  closeSectionForm();
  showDashboard();
  setStatus('Home — pick a section that’s due, or open a piece from the library.');
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
    const label =
      reviewSession.kind === 'path'
        ? 'Practice path'
        : reviewSession.kind === 'planned'
          ? 'Timed session'
          : 'Daily review';
    let text = `${label} · ${pos} of ${total}`;
    if (reviewSession.kind === 'planned') {
      // Estimated time left = the plan estimates for this step onward.
      let remainingMs = 0;
      for (let i = reviewSession.index; i < reviewSession.items.length; i++) {
        remainingMs += Number(reviewSession.items[i].estimateMs) || 0;
      }
      if (remainingMs > 0) text += ` · ${formatPlanEstimate(remainingMs)} left`;
    }
    els.reviewSessionProgress.textContent = text;
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
    // Bring older libraries up to date (e.g. Bonus → leveled titles, technique
    // drills moved to the top), then group the list by level to match the
    // curated manifest.
    await migrateLibraryTitles();
    await migrateTechniqueToTop();
    sortPiecesByCuratedOrder();
    renderPieceList(pieces);
    if (stored.length > 0) {
      setStatus(
        stored.length === 1
          ? `Loaded 1 saved piece · v${APP_VERSION}`
          : `Loaded ${stored.length} saved pieces · v${APP_VERSION}`,
      );
    } else if (
      typeof window !== 'undefined' &&
      window.CURATED_LIBRARY_DATA &&
      typeof handleLoadCuratedLibrary === 'function'
    ) {
      // First open with an empty library: auto-seed the curated pieces from the
      // embedded data so they're ready immediately (works over file://). Each
      // piece persists as it imports, and re-runs skip what's already there, so
      // closing mid-import and reopening just finishes the rest.
      setStatus('First run — loading curated library…');
      await handleLoadCuratedLibrary();
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
  noteWorkingTempoChange();
}

function handleMetronomeBpmAdjust(delta) {
  const m = ensureMetronome();
  m.setBpm(m.getBpm() + delta);
  syncMetronomeUI();
  noteWorkingTempoChange();
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
  noteWorkingTempoChange();
}

/** Stop the metronome (called when closing the practice panel). */
function stopMetronome() {
  if (metronome && metronome.isRunning()) {
    metronome.stop();
    syncMetronomeUI();
  }
}

// ===== Tempo goals ==========================================================

/**
 * On opening a section, restore the metronome to the tempo the user last
 * practised this section at (`workingTempo`). If there's no saved working
 * tempo but there IS a goal, seed a slow ramp-up start so the goal is
 * meaningful from the first session. Sections with neither leave the metronome
 * untouched (preserving the previous global behaviour). Creating the metronome
 * controller is cheap — the AudioContext isn't allocated until it actually
 * starts ticking — so this never makes noise.
 */
function initSectionTempo(section) {
  if (!section) return;
  const m = ensureMetronome();
  const working = clampTempo(section.workingTempo);
  if (working !== null) {
    m.setBpm(working);
  } else if (clampTempo(section.targetTempo) !== null) {
    m.setBpm(suggestStartTempo(section.targetTempo));
  }
  syncMetronomeUI();
}

/**
 * Mirror the metronome's current BPM onto the active section's in-memory
 * `workingTempo` so it can be persisted on close and surfaced live. Called
 * from the metronome change handlers. Cheap, no IDB write.
 */
function noteWorkingTempoChange() {
  const section = getActiveSection();
  if (!section || !metronome) return;
  const bpm = clampTempo(metronome.getBpm());
  if (bpm !== null) section.workingTempo = bpm;
  renderTempoGoal(section);
}

/**
 * When a clean run completes with the metronome running, the metronome's BPM
 * is the tempo the user just played at. If it beats this section's recorded
 * best, bank it (in memory + IDB) and return the new best so the caller can
 * celebrate. Hinted (assisted) runs don't count — they aren't clean-at-tempo.
 *
 * @returns {number|null} the new best BPM if it improved, else null
 */
function maybeRecordTempoAchievement(section, { hinted } = {}) {
  if (!section || hinted) return null;
  if (!metronome || !metronome.isRunning()) return null;
  const bpm = clampTempo(metronome.getBpm());
  if (bpm === null) return null;
  const prevBest = clampTempo(section.bestCleanTempo) || 0;
  if (bpm <= prevBest) return null;
  section.bestCleanTempo = bpm;
  updateSectionTempo(section.id, { bestCleanTempo: bpm }).catch((err) =>
    console.warn('Failed to persist best clean tempo', err),
  );
  return bpm;
}

/** Persist the active section's working tempo (called on close). */
function persistWorkingTempo() {
  const section = getActiveSection();
  if (!section || !metronome) return;
  if (isPieceRun()) return; // synthetic section — nothing stored to update
  const bpm = clampTempo(metronome.getBpm());
  if (bpm === null) return;
  section.workingTempo = bpm;
  updateSectionTempo(section.id, { workingTempo: bpm }).catch((err) =>
    console.warn('Failed to persist working tempo', err),
  );
}

/**
 * Paint the tempo-goal card from the active section. Two modes: a "set target"
 * input (no goal yet, or the user is editing) and the active progress view
 * (working / best / goal readouts + a best-vs-goal bar + a Bump control that
 * nudges the metronome toward the goal).
 */
function renderTempoGoal(section) {
  const card = els.tempoGoal;
  if (!card) return;
  // No tempo goal for a whole-piece play-through (nothing stored to hold it).
  if (!section || !practiceState || isPieceRun()) {
    card.hidden = true;
    return;
  }
  card.hidden = false;

  const summary = tempoGoalSummary(section);
  const working = metronome ? clampTempo(metronome.getBpm()) : summary.working;
  const showSet = !summary.hasGoal || tempoGoalEditing;

  if (els.tempoGoalSet) els.tempoGoalSet.hidden = !showSet;
  if (els.tempoGoalActive) els.tempoGoalActive.hidden = showSet;
  if (els.tempoGoalCancelBtn) els.tempoGoalCancelBtn.hidden = !summary.hasGoal;

  if (showSet) {
    // Prefill the input: existing goal when editing, else a suggestion based
    // on where the metronome sits now (or its default).
    if (els.tempoGoalInput && document.activeElement !== els.tempoGoalInput) {
      const prefill = tempoGoalEditing && summary.target
        ? summary.target
        : working || DEFAULT_TEMPO_PREFILL;
      els.tempoGoalInput.value = String(prefill);
    }
    if (els.tempoGoalStatus) {
      els.tempoGoalStatus.textContent = summary.hasGoal
        ? 'Editing goal'
        : 'Set a tempo to work up to';
    }
    return;
  }

  // Active (has-goal) view.
  if (els.tempoGoalWorking) els.tempoGoalWorking.textContent = working ? String(working) : '—';
  if (els.tempoGoalBest) els.tempoGoalBest.textContent = summary.best ? String(summary.best) : '—';
  if (els.tempoGoalTarget) els.tempoGoalTarget.textContent = String(summary.target);
  if (els.tempoGoalFill) els.tempoGoalFill.style.width = `${summary.pct}%`;
  if (els.tempoGoalTrack) {
    els.tempoGoalTrack.setAttribute('aria-valuenow', String(summary.pct));
    els.tempoGoalTrack.classList.toggle('is-complete', summary.reached);
  }
  if (els.tempoGoalStatus) {
    if (summary.reached) {
      els.tempoGoalStatus.textContent = 'Goal reached 🎉';
    } else if (summary.best > 0) {
      els.tempoGoalStatus.textContent = `${summary.remaining} BPM to go`;
    } else {
      els.tempoGoalStatus.textContent = 'Run the metronome to log a clean tempo';
    }
  }
  if (els.tempoGoalBumpBtn) {
    const atTarget = working !== null && summary.target !== null && working >= summary.target;
    els.tempoGoalBumpBtn.disabled = atTarget;
    els.tempoGoalBumpBtn.textContent = `Bump +${TEMPO_STEP}`;
    els.tempoGoalBumpBtn.title = atTarget
      ? 'Already at your goal tempo'
      : `Raise the metronome to ${nextWorkingTempo(working, summary.target)} BPM`;
  }
}

/** Default BPM to prefill the "set goal" input with when nothing else fits. */
const DEFAULT_TEMPO_PREFILL = 120;

/** "Set goal" / "Save goal" handler — read the input, validate, persist. */
function handleTempoGoalSet() {
  const section = getActiveSection();
  if (!section || !els.tempoGoalInput) return;
  const raw = parseInt(els.tempoGoalInput.value, 10);
  if (!isValidTempo(raw)) {
    setStatus(`Tempo goal must be between ${TEMPO_MIN} and ${TEMPO_MAX} BPM.`);
    return;
  }
  const target = clampTempo(raw);
  section.targetTempo = target;
  tempoGoalEditing = false;
  updateSectionTempo(section.id, { targetTempo: target }).catch((err) =>
    console.warn('Failed to persist tempo goal', err),
  );
  setStatus(`Tempo goal set to ${target} BPM for "${section.name}".`);
  renderTempoGoal(section);
  renderSectionsPanel();
}

/** "Edit goal" handler — flip the card into its input mode. */
function handleTempoGoalEdit() {
  if (!getActiveSection()) return;
  tempoGoalEditing = true;
  renderTempoGoal(getActiveSection());
  if (els.tempoGoalInput) {
    els.tempoGoalInput.focus();
    els.tempoGoalInput.select();
  }
}

/** "Cancel" (only shown while editing an existing goal). */
function handleTempoGoalCancel() {
  tempoGoalEditing = false;
  renderTempoGoal(getActiveSection());
}

/**
 * "Bump" handler — raise the metronome one notch toward the goal and remember
 * it as the section's working tempo. Starts the metronome if it isn't already
 * running so the next clean run is captured at the new tempo.
 */
function handleTempoGoalBump() {
  const section = getActiveSection();
  if (!section) return;
  const m = ensureMetronome();
  const summary = tempoGoalSummary(section);
  if (summary.target === null) return;
  const next = nextWorkingTempo(m.getBpm(), summary.target);
  m.setBpm(next);
  section.workingTempo = next;
  updateSectionTempo(section.id, { workingTempo: next }).catch(() => {});
  if (!m.isRunning()) m.start();
  syncMetronomeUI();
  renderTempoGoal(section);
  setStatus(`Metronome raised to ${next} BPM. Aim for a clean run.`);
}

// ---------------------------------------------------------------------------
// Settings (QOL menu)
// ---------------------------------------------------------------------------

/** Apply settings that live outside the player (document-level classes). */
function applyDocumentSettings() {
  document.documentElement.classList.toggle(
    'reduce-motion',
    !!getSetting('reduceMotion'),
  );
}

/** Hand the mounted player a fresh display-settings snapshot (no-op if none). */
function pushSettingsToPlayer() {
  if (player && typeof player.applySettings === 'function') {
    player.applySettings(getAllSettings());
  }
}

/**
 * One-time, on-mount session defaults that have side effects (hand / input
 * mode). Kept separate from applySettings so a live settings change never
 * yanks the user's mid-practice hand or input choice back to the default.
 */
function applySessionDefaultsToPlayer() {
  if (!player) return;
  const hand = getSetting('defaultHand');
  if (hand === 'rh' || hand === 'lh') player.setHand(hand);
  if (getSetting('guideKeysDefault') && typeof player.setGuideKeys === 'function') {
    player.setGuideKeys(true);
  }
  if (getSetting('computerKeysDefault')) player.setComputerKeys(true);
}

/**
 * Wire the settings dialog: open/close, per-control init + change handlers,
 * the dark-mode mirror, and reset-to-defaults. Each control's id is
 * `set-<settingKey>`, so the wiring is table-driven.
 */
function setupSettings() {
  const dialog = document.getElementById('settings-dialog');
  const openBtn = document.getElementById('settings-btn');
  if (!dialog || !openBtn) return;

  const checkboxKeys = [
    'octaveNumbers', 'fallingNoteNames', 'highlightC',
    'showFingerings', 'guideKeysDefault', 'reduceMotion',
    'computerKeysDefault', 'noteSound',
  ];
  const selectKeys = ['keyNoteNames', 'notation', 'defaultHand'];

  // Reflect the current settings into every control.
  function syncControls() {
    for (const key of checkboxKeys) {
      const el = document.getElementById(`set-${key}`);
      if (el) el.checked = !!getSetting(key);
    }
    for (const key of selectKeys) {
      const el = document.getElementById(`set-${key}`);
      if (el) el.value = String(getSetting(key));
    }
    const dark = document.getElementById('set-darkMode');
    if (dark) dark.checked = document.documentElement.classList.contains('dark');
  }

  // A control changed → persist, then re-apply to the document + live player.
  function onSettingChanged(key, value) {
    setSetting(key, value);
    applyDocumentSettings();
    pushSettingsToPlayer();
  }

  for (const key of checkboxKeys) {
    const el = document.getElementById(`set-${key}`);
    if (el) el.addEventListener('change', () => onSettingChanged(key, el.checked));
  }
  for (const key of selectKeys) {
    const el = document.getElementById(`set-${key}`);
    if (el) el.addEventListener('change', () => onSettingChanged(key, el.value));
  }

  // Dark mode mirrors the header theme toggle (its own storage key).
  const darkEl = document.getElementById('set-darkMode');
  if (darkEl) {
    darkEl.addEventListener('change', () =>
      applyTheme(darkEl.checked ? 'dark' : 'light'));
  }

  const close = () => { if (dialog.open) dialog.close(); };
  openBtn.addEventListener('click', () => {
    syncControls();
    if (!dialog.open) dialog.showModal();
  });
  const closeBtn = document.getElementById('settings-close-btn');
  const doneBtn = document.getElementById('settings-done-btn');
  if (closeBtn) closeBtn.addEventListener('click', close);
  if (doneBtn) doneBtn.addEventListener('click', close);
  // Backdrop click closes (native <dialog> reports the click on itself).
  dialog.addEventListener('click', (e) => { if (e.target === dialog) close(); });

  const resetBtn = document.getElementById('settings-reset-btn');
  if (resetBtn) {
    resetBtn.addEventListener('click', () => {
      for (const [key, val] of Object.entries(SETTINGS_DEFAULTS)) setSetting(key, val);
      syncControls();
      applyDocumentSettings();
      pushSettingsToPlayer();
      setStatus('Settings reset to defaults.');
    });
  }
}

function init() {
  // Load persisted QOL settings first so document-level prefs apply pre-render.
  loadSettings();
  applyDocumentSettings();
  setupSettings();
  // --- Dark mode (item 11b) — apply before any rendering so no flash. ------
  applyTheme(getInitialTheme());
  if (els.themeToggle) {
    els.themeToggle.addEventListener('click', toggleTheme);
  }

  if (els.homeBtn) {
    els.homeBtn.addEventListener('click', goHome);
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
      if (!file) return;
      // Route by extension: MusicXML scores derive their own timeline; MIDI
      // takes the existing path.
      if (/\.(musicxml|mxl|xml)$/i.test(file.name)) {
        await handleScoreFile(file);
      } else {
        await handleMidiFile(file);
      }
    });
  }

  if (els.loadSampleBtn) {
    els.loadSampleBtn.addEventListener('click', () => handleLoadSample());
  }

  if (els.loadLibraryBtn) {
    els.loadLibraryBtn.addEventListener('click', () => handleLoadCuratedLibrary());
  }

  // [Sheet | Synthesia] view toggle.
  if (els.viewSheetBtn) {
    els.viewSheetBtn.addEventListener('click', () => setPieceView('sheet'));
  }
  if (els.viewSynthesiaBtn) {
    els.viewSynthesiaBtn.addEventListener('click', () => setPieceView('synthesia'));
  }

  // Whole-piece Listen / Play through (piece header).
  if (els.pieceListenBtn) {
    els.pieceListenBtn.addEventListener('click', () => togglePieceListen());
  }
  if (els.piecePlayBtn) {
    els.piecePlayBtn.addEventListener('click', () => openPieceRun());
  }

  if (els.resplitBtn) {
    els.resplitBtn.addEventListener('click', () => handleResplitSections());
  }
  if (els.startPathBtn) {
    els.startPathBtn.addEventListener('click', () => startPathFromTop());
  }
  if (els.troubleClearBtn) {
    els.troubleClearBtn.addEventListener('click', () => handleClearTroubleSpots());
  }
  if (els.techniqueBtn) {
    els.techniqueBtn.addEventListener('click', () => {
      // Toggle, so a second click on the button closes the form again.
      if (els.techniqueForm && !els.techniqueForm.hidden) closeTechniqueForm();
      else openTechniqueForm();
    });
  }
  if (els.techniqueForm) {
    els.techniqueForm.addEventListener('submit', handleTechniqueSubmit);
  }
  if (els.techniqueFormCancel) {
    els.techniqueFormCancel.addEventListener('click', () => closeTechniqueForm());
  }
  if (els.techniqueModeInput) {
    // Major and minor spell the same pitch class differently (E♭ vs D♯), so
    // the tonic list is rebuilt whenever the mode changes.
    els.techniqueModeInput.addEventListener('change', () => syncTechniqueTonicOptions());
  }
  if (els.techniqueTonicInput) {
    els.techniqueTonicInput.addEventListener('change', () => renderTechniquePreview());
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

  // Plan-a-session wiring: minutes input, presets, start button.
  if (els.sessionPlanMinutes) {
    // Live re-plan while typing; clamp + snap the field on commit.
    els.sessionPlanMinutes.addEventListener('input', () => {
      const n = parseInt(els.sessionPlanMinutes.value, 10);
      if (Number.isFinite(n) && n >= SESSION_MINUTES_MIN && n <= SESSION_MINUTES_MAX) {
        setSessionPlanMinutes(n);
      }
    });
    els.sessionPlanMinutes.addEventListener('change', () => {
      const n = parseInt(els.sessionPlanMinutes.value, 10);
      setSessionPlanMinutes(Number.isFinite(n) ? n : sessionPlanMinutes);
      els.sessionPlanMinutes.value = String(sessionPlanMinutes);
    });
  }
  if (els.sessionPlanPanel) {
    for (const btn of els.sessionPlanPanel.querySelectorAll('.session-plan-preset')) {
      btn.addEventListener('click', () => setSessionPlanMinutes(Number(btn.dataset.minutes)));
    }
  }
  if (els.startSessionPlanBtn) {
    els.startSessionPlanBtn.addEventListener('click', startPlannedSession);
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

  // --- Tempo-goal wiring ---------------------------------------------------
  if (els.tempoGoalSetBtn) {
    els.tempoGoalSetBtn.addEventListener('click', handleTempoGoalSet);
  }
  if (els.tempoGoalInput) {
    els.tempoGoalInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); handleTempoGoalSet(); }
    });
  }
  if (els.tempoGoalEditBtn) {
    els.tempoGoalEditBtn.addEventListener('click', handleTempoGoalEdit);
  }
  if (els.tempoGoalCancelBtn) {
    els.tempoGoalCancelBtn.addEventListener('click', handleTempoGoalCancel);
  }
  if (els.tempoGoalBumpBtn) {
    els.tempoGoalBumpBtn.addEventListener('click', handleTempoGoalBump);
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
 *   L           — listen to the current section (synth preview); on the piece
 *                 page (no practice open) it plays / stops the whole piece.
 *   R           — restart the current run from the top.
 *   1 / 2 / 3 / 4 — pick Again / Hard / Good / Easy when the rating prompt is
 *                 visible.
 *   Escape      — close practice panel (if open), stop a whole-piece Listen,
 *                 or close the section form.
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
      } else if (
        !practiceState &&
        activePieceId &&
        els.viewerMidi &&
        !els.viewerMidi.hidden
      ) {
        // Piece page: hear the whole piece (again to stop).
        e.preventDefault();
        togglePieceListen();
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
      // Esc = close practice panel if open; else stop a whole-piece Listen;
      // otherwise close the section form.
      if (practiceState) {
        e.preventDefault();
        closePracticeView();
      } else if (isPieceListening()) {
        e.preventDefault();
        stopPieceListen();
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
