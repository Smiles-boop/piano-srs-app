// PianoSRS — microphone note detection (play your real, acoustic piano — no
// MIDI cable needed).
//
// `createMicPitch(opts)` opens the microphone and converts what it hears into
// the same integer-MIDI press/release events a MIDI keyboard produces, so the
// player's wait-mode grader, visuals, and SRS pipeline work unchanged:
//
//   createMicPitch({
//     onNoteOn:  (midi) => player.pressPitch(midi),
//     onNoteOff: (midi) => player.releasePitch(midi),
//     onStatus:  (text, level) => ...,        // 'ok' | 'warn' | 'error'
//     getExpected: () => Set<midi> | null,    // notes the current step needs
//   })
//
// How it works (all plain Web Audio + DSP, no ML model, fully offline):
//
//   mic → AnalyserNode FFT → linear magnitude spectrum, every HOP_MS
//     1. ONSET DETECTION — spectral flux (sum of positive per-bin magnitude
//        increases). A key strike spikes the flux; sustained ringing doesn't.
//     2. shortly after an onset, POLYPHONIC PITCH ESTIMATION — find spectral
//        peaks, then iteratively pick the best-scoring harmonic series
//        (fundamental + partials), subtract its estimated energy from the
//        peaks, and repeat. This resolves chords, including octaves: the
//        upper octave survives subtraction because the shared partials hold
//        MORE energy than the lower note alone explains.
//     3. SCORE-INFORMED GRADING — the player tells us which notes the current
//        step expects. Expected notes are accepted on modest evidence (they
//        must still actually sound); unexpected notes need strong evidence
//        AND must persist across extra frames before they count. This keeps
//        chord detection reliable while stopping transients (metronome
//        clicks, key thuds, coughs) from triggering false "wrong note" run
//        resets — the strict grader makes false positives expensive.
//
// Known limits (inherent to mic detection, called out honestly):
//   - Very low bass (below ~A1) has a weak fundamental on most mics and may
//     not register; most practice material sits comfortably above that.
//   - An octave above a played note can be masked by the lower note's own
//     2nd partial; when the octave is expected we lean permissive.
//   - Room noise / speaker bleed: the player mutes its own key-press synth
//     while the mic is on, and suppresses detection during Listen playback.
//
// No dependencies. The pure DSP functions are exported for Node tests.

// ---- Tuning constants -----------------------------------------------------
const MICPITCH_VERSION = 5;       // bump on changes — lets devtools verify the loaded build
const MIC_FFT_SIZE = 8192;        // ~5.9 Hz bins @ 48 kHz, ~170 ms window
const MIC_HOP_MS = 40;            // analysis cadence (25 fps)
const MIC_MIN_MIDI = 24;          // C1 — below this the fundamental is unusable
const MIC_MAX_MIDI = 108;         // C8
const MIC_MAX_POLYPHONY = 8;      // most a two-hand chord realistically needs

// Onset detection (spectral flux).
const FLUX_HISTORY = 43;          // ~1.7 s of flux values for the adaptive floor
const FLUX_MULT = 2.8;            // onset when flux > median × this
const FLUX_ABS_MIN = 1.5e-4;      // ...and above this absolute floor (silence guard)
const ONSET_REFRACTORY_MS = 100;  // ignore re-triggers inside this window
const ANALYSIS_DELAY_FRAMES = 2;  // let the attack start filling the FFT window
// Analyse a RUN of frames after each onset, not a single one. The ~170 ms FFT
// window fills gradually, so any single frame races the attack; re-analysing
// is idempotent (already-active notes are skipped) and catches notes whose
// evidence only firms up once the window is full.
const ANALYSIS_RUN_FRAMES = 5;

// Pitch estimation / acceptance.
const HARMONICS = 16;             // partials considered per candidate
const INHARMONICITY = 0.0001;     // piano partial stretch: f_h ≈ h·f0·(1 + B·h²)
const PEAK_LOCAL_RADIUS = 24;     // bins of local baseline for peak picking
const PEAK_OVER_LOCAL = 3.5;      // peak must exceed local baseline × this
const PEAK_OVER_GLOBAL = 0.002;   // ...and this fraction of the frame's max
const SOFT_SCORE = 0.28;          // expected-note acceptance score
const HARD_SCORE = 0.85;          // unexpected-note acceptance score
const FUND_SOFT = 0.03;           // expected: fundamental ≥ this × frame max
const FUND_HARD = 0.10;           // unexpected: fundamental ≥ this × frame max
const MIN_SUPPORT = 3;            // supported partials required (2 above MIDI 96)
const OCTAVE_GUARD = 0.35;        // +12 of an accepted note needs this much residual
const SUBTRACT_ENV = 1.7;         // subtraction envelope: fund × SUBTRACT_ENV / h

// Unexpected (possibly wrong) notes must accumulate confirmations before they
// are reported — the strict grader makes a false positive expensive. The
// horizon must OUTLIVE the FFT window: a 60 ms metronome click stays visible
// in the ~170 ms sliding window until ~230 ms after onset, which allows at
// most ~3 passing confirm frames — below CONFIRM_PASSES, so it never fires.
// A real note (even staccato) keeps passing until it accumulates enough.
// Passes are cumulative (the attack filling the window can fail an early
// check); a stretch of consecutive misses means the sound is gone — drop it.
const CONFIRM_PASSES = 4;         // cumulative passing frames to report
const CONFIRM_MAX_MISSES = 3;     // consecutive failing frames → transient, drop

// Note lifetime tracking.
const RESTRIKE_RATIO = 2.3;       // energy jump (vs pre-onset) that means "hit again"
const RELEASE_RATIO = 0.06;       // note off when energy < this × its peak
const RELEASE_FRAMES = 3;         // ...for this many consecutive frames
const SILENCE_FLOOR = 3e-5;       // linear magnitude regarded as silence

// ---- Pure helpers ----------------------------------------------------------

/** Frequency in Hz for a MIDI note (A4 = 69 = 440 Hz). */
function midiToHz(midi) {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

/** Fractional MIDI number for a frequency in Hz. */
function hzToMidi(hz) {
  return 69 + 12 * Math.log2(hz / 440);
}

/**
 * Spectral flux between two linear-magnitude frames: the mean positive
 * per-bin increase. Rises sharply on a note attack, stays near zero while
 * notes merely ring or decay.
 */
function computeSpectralFlux(mags, prevMags, loBin, hiBin) {
  let sum = 0;
  for (let i = loBin; i < hiBin; i++) {
    const d = mags[i] - prevMags[i];
    if (d > 0) sum += d;
  }
  return sum / Math.max(1, hiBin - loBin);
}

/**
 * Pick spectral peaks: local maxima that clear both a local moving-average
 * baseline and a global floor. Frequencies are refined by parabolic
 * interpolation on log-magnitude, so a 5.9 Hz bin grid still yields
 * sub-Hz-accurate partials.
 *
 * @param {Float32Array|number[]} mags linear magnitudes (length fftSize/2)
 * @returns {{freq:number, mag:number, res:number}[]} sorted by frequency;
 *   `res` is the residual magnitude consumed by iterative subtraction.
 */
function findSpectralPeaks(mags, sampleRate, fftSize) {
  const binHz = sampleRate / fftSize;
  const n = mags.length;
  const lo = Math.max(2, Math.floor(40 / binHz));
  const hi = Math.min(n - 3, Math.ceil(9000 / binHz));

  // Running-sum local baseline.
  const prefix = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) prefix[i + 1] = prefix[i] + mags[i];
  const localAvg = (i) => {
    const a = Math.max(0, i - PEAK_LOCAL_RADIUS);
    const b = Math.min(n, i + PEAK_LOCAL_RADIUS + 1);
    return (prefix[b] - prefix[a]) / (b - a);
  };

  let globalMax = 0;
  for (let i = lo; i < hi; i++) if (mags[i] > globalMax) globalMax = mags[i];
  if (globalMax <= 0) return [];

  const peaks = [];
  for (let i = lo; i < hi; i++) {
    const m = mags[i];
    if (m <= mags[i - 1] || m < mags[i + 1]) continue;
    if (m < mags[i - 2] || m < mags[i + 2]) continue;
    if (m < globalMax * PEAK_OVER_GLOBAL) continue;
    if (m < localAvg(i) * PEAK_OVER_LOCAL) continue;
    // Parabolic interpolation on log magnitude for the true peak position.
    const eps = 1e-12;
    const a = Math.log(mags[i - 1] + eps);
    const b = Math.log(m + eps);
    const c = Math.log(mags[i + 1] + eps);
    const denom = a - 2 * b + c;
    const delta = denom !== 0 ? Math.max(-0.5, Math.min(0.5, 0.5 * (a - c) / denom)) : 0;
    peaks.push({ freq: (i + delta) * binHz, mag: m, res: m });
  }
  return peaks;
}

/** Largest-magnitude (residual) peak within ±tol of freq, or -1. */
function matchPeak(peaks, freq, tol) {
  let best = -1;
  for (let i = 0; i < peaks.length; i++) {
    const p = peaks[i];
    if (p.freq < freq - tol) continue;
    if (p.freq > freq + tol) break;
    if (best < 0 || p.res > peaks[best].res) best = i;
  }
  return best;
}

/**
 * Score one MIDI candidate against the (residual) peak list: how much
 * harmonic-series energy it explains, weighted 1/h and normalised by the
 * frame's loudest peak.
 */
function scoreCandidate(peaks, midi, opts) {
  const { binHz, nyquist, maxMag } = opts;
  const f0 = midiToHz(midi);
  if (f0 * 2 > nyquist) return null;
  let score = 0;
  let supported = 0;
  let fund = 0;
  const matches = [];
  for (let h = 1; h <= HARMONICS; h++) {
    const fh = h * f0 * (1 + INHARMONICITY * h * h);
    if (fh > Math.min(nyquist * 0.95, 9000)) break;
    const tol = Math.max(binHz * 1.2, fh * 0.02);
    const idx = matchPeak(peaks, fh, tol);
    if (idx < 0) continue;
    const m = peaks[idx].res;
    if (h === 1) fund = m;
    // Support = "is this partial physically present in the frame?" — judged on
    // the ORIGINAL magnitude, not the residual. In stacked voicings (e.g.
    // C3-G3-E4-G4-C5) every partial of the root coincides with another chord
    // tone, so residual support would starve real notes; ghost octaves are
    // rejected by the residual fundamental/score checks instead.
    if (h <= 10 && peaks[idx].mag > maxMag * 0.02) supported++;
    score += (m / maxMag) / h;
    matches.push({ idx, h });
  }
  return { score, supported, fund, matches };
}

/**
 * Polyphonic pitch estimation with score-informed acceptance.
 *
 * Iteratively: score every candidate note on the residual peaks, take the
 * best one that clears its acceptance bar (soft for expected notes, hard for
 * everything else), subtract its estimated partial energy, repeat. Chords of
 * any size up to MIC_MAX_POLYPHONY fall out naturally; each accepted note
 * only consumes the energy IT explains, so simultaneous notes — including
 * octaves — keep their own evidence.
 *
 * @param {Float32Array|number[]} mags linear magnitude spectrum (fftSize/2)
 * @param {{sampleRate:number, fftSize:number, expected?:Set<number>|null,
 *          maxNotes?:number}} opts
 * @returns {{midi:number, score:number, supported:number, fund:number,
 *            expected:boolean}[]} accepted notes, strongest first
 */
function estimatePitches(mags, opts) {
  const sampleRate = opts.sampleRate;
  const fftSize = opts.fftSize;
  const expected = opts.expected || null;
  const maxNotes = opts.maxNotes || MIC_MAX_POLYPHONY;
  const binHz = sampleRate / fftSize;
  const nyquist = sampleRate / 2;

  const peaks = findSpectralPeaks(mags, sampleRate, fftSize);
  if (!peaks.length) return [];
  let maxMag = 0;
  for (const p of peaks) if (p.mag > maxMag) maxMag = p.mag;
  const sopts = { binHz, nyquist, maxMag };

  const results = [];
  for (let round = 0; round < maxNotes; round++) {
    // Rank all candidates on the current residual.
    const ranked = [];
    for (let m = MIC_MIN_MIDI; m <= MIC_MAX_MIDI; m++) {
      const s = scoreCandidate(peaks, m, sopts);
      if (s && s.fund > 0) ranked.push({ midi: m, ...s });
    }
    ranked.sort((a, b) => b.score - a.score);

    let picked = null;
    for (const cand of ranked) {
      const isExp = !!(expected && expected.has(cand.midi));
      // Never re-accept a note (or its immediate semitone neighbours, which
      // share its fundamental peak at low pitches).
      if (results.some((r) => Math.abs(r.midi - cand.midi) <= 1)) continue;
      if (cand.score < (isExp ? SOFT_SCORE : HARD_SCORE)) continue;
      if (cand.fund < maxMag * (isExp ? FUND_SOFT : FUND_HARD)) continue;
      if (cand.supported < (cand.midi >= 96 ? 2 : MIN_SUPPORT)) continue;
      // Octave guard: a note one octave above an accepted note shares ALL its
      // partials with the lower note's even partials — require real leftover
      // fundamental energy unless the score says the octave is expected.
      const below = results.find((r) => r.midi === cand.midi - 12);
      if (below && !isExp && cand.fund < below.fund * OCTAVE_GUARD) continue;
      picked = { ...cand, expected: isExp };
      break;
    }
    if (!picked) break;
    results.push(picked);

    // Subtract the picked note's estimated partial envelope from the residual
    // so the next round only sees energy this note does NOT explain.
    for (const { idx, h } of picked.matches) {
      const est = h === 1 ? picked.fund : (picked.fund * SUBTRACT_ENV) / h;
      peaks[idx].res = Math.max(0, peaks[idx].res - est);
    }
  }
  return results;
}

// ---- Browser controller -----------------------------------------------------

/**
 * @param {{onNoteOn?:Function, onNoteOff?:Function, onStatus?:Function,
 *          getExpected?:Function}} opts
 */
function createMicPitch(opts = {}) {
  const onNoteOn = opts.onNoteOn || (() => {});
  const onNoteOff = opts.onNoteOff || (() => {});
  const onStatus = opts.onStatus || (() => {});
  const getExpected = opts.getExpected || (() => null);

  let audioCtx = null;
  let stream = null;
  let source = null;
  let analyser = null;
  let timer = null;
  let running = false;
  let suppressed = false;   // true while the app plays its own audio (Listen)

  let dbBuf = null;         // analyser output (dB)
  let mags = null;          // current linear magnitudes
  let prevMags = null;      // previous frame (for flux)
  let binHz = 0;
  let fluxLoBin = 0;
  let fluxHiBin = 0;

  const fluxHist = [];
  let lastOnsetAt = 0;
  let pendingAnalysis = 0;  // frames until the post-onset analysis run starts
  let analysisRun = 0;      // remaining frames of the current analysis run

  // midi → { peak, releaseCount } for notes we've reported as pressed.
  const active = new Map();
  // Energy of each active note on the frame BEFORE the latest onset — the
  // baseline for re-strike detection (same key hit again while ringing).
  const preOnsetEnergy = new Map();
  // midi → { passes, misses } for unexpected notes awaiting confirmation.
  const pendingUnexpected = new Map();
  // midi → recent fundamental energies for expected-but-not-yet-played notes.
  // Backup trigger: when the pitch we're WAITING for jumps in energy, start an
  // analysis run even if the global flux gate missed the attack (which can
  // happen when louder previous notes are still ringing). A mere ringing
  // harmonic never JUMPS, so this can't silently auto-advance steps.
  const expectedEnergyHist = new Map();
  const EXPECTED_JUMP_RATIO = 3;
  const EXPECTED_JUMP_LAG = 4;    // compare against the energy ~4 frames ago

  /** Linear energy near a note's fundamental (h2 as fallback for low notes). */
  function noteEnergy(midi) {
    const f0 = midiToHz(midi);
    const probe = (f) => {
      const tol = Math.max(binHz * 1.2, f * 0.02);
      const a = Math.max(1, Math.round((f - tol) / binHz));
      const b = Math.min(mags.length - 1, Math.round((f + tol) / binHz));
      let m = 0;
      for (let i = a; i <= b; i++) if (mags[i] > m) m = mags[i];
      return m;
    };
    return Math.max(probe(f0), 0.8 * probe(f0 * 2));
  }

  function toExpectedSet() {
    const e = getExpected();
    if (!e) return null;
    return e instanceof Set ? e : new Set(e);
  }

  function activate(midi) {
    active.set(midi, { peak: Math.max(noteEnergy(midi), SILENCE_FLOOR), releaseCount: 0 });
    onNoteOn(midi);
  }

  function release(midi) {
    active.delete(midi);
    preOnsetEnergy.delete(midi);
    onNoteOff(midi);
  }

  /** Post-onset polyphonic analysis of the current spectrum. */
  function analyze() {
    const expected = toExpectedSet();
    const found = estimatePitches(mags, {
      sampleRate: audioCtx.sampleRate,
      fftSize: MIC_FFT_SIZE,
      expected,
    });
    // Set `window.__micDebug = true` in the console to trace detection.
    if (typeof window !== 'undefined' && window.__micDebug) {
      console.debug('[micpitch] analyze ' + JSON.stringify({
        expected: expected ? [...expected] : null,
        found: found.map((f) => `${f.midi} s=${f.score.toFixed(2)} sup=${f.supported} f=${f.fund.toExponential(1)} exp=${f.expected}`),
        active: [...active.keys()],
      }));
    }
    for (const f of found) {
      if (active.has(f.midi)) {
        // Already ringing. A repeated strike shows as an energy jump versus
        // the frame just before the onset; mere sustain/pedal ring does not.
        // The snapshot is consumed on use so one strike can't fire twice
        // across the analysis run.
        const isExp = !!(expected && expected.has(f.midi));
        if (
          isExp &&
          preOnsetEnergy.has(f.midi) &&
          noteEnergy(f.midi) > preOnsetEnergy.get(f.midi) * RESTRIKE_RATIO
        ) {
          preOnsetEnergy.delete(f.midi);
          onNoteOff(f.midi);
          activate(f.midi); // fresh press so repeated-note steps stay honest
        }
      } else if (f.expected) {
        activate(f.midi);
      } else {
        // Unexpected (possibly wrong) note: demand persistence before we make
        // the strict grader reset the run. Transients don't survive this.
        if (!pendingUnexpected.has(f.midi)) {
          pendingUnexpected.set(f.midi, { passes: 0, misses: 0 });
        }
      }
    }
  }

  /** Re-verify staged unexpected notes on a fresh frame; emit or drop. */
  function confirmPending() {
    if (!pendingUnexpected.size) return;
    const peaks = findSpectralPeaks(mags, audioCtx.sampleRate, MIC_FFT_SIZE);
    let maxMag = 0;
    for (const p of peaks) if (p.mag > maxMag) maxMag = p.mag;
    const sopts = { binHz, nyquist: audioCtx.sampleRate / 2, maxMag: maxMag || 1 };
    for (const [midi, st] of [...pendingUnexpected]) {
      const s = peaks.length ? scoreCandidate(peaks, midi, sopts) : null;
      const stillThere =
        s &&
        s.score >= HARD_SCORE &&
        s.fund >= maxMag * FUND_HARD &&
        s.supported >= (midi >= 96 ? 2 : MIN_SUPPORT);
      if (typeof window !== 'undefined' && window.__micDebug) {
        console.debug(`[micpitch] confirm midi=${midi} p=${st.passes} m=${st.misses} still=${!!stillThere}` +
          (s ? ` s=${s.score.toFixed(2)} sup=${s.supported}` : ''));
      }
      if (stillThere) {
        st.misses = 0;
        st.passes++;
        if (st.passes >= CONFIRM_PASSES) {
          pendingUnexpected.delete(midi);
          if (!active.has(midi)) activate(midi);
        }
      } else {
        st.misses++;
        if (st.misses >= CONFIRM_MAX_MISSES) pendingUnexpected.delete(midi);
      }
    }
  }

  /** Track ringing notes' decay; release them when they fade out. */
  function updateActive() {
    if (!active.size) return;
    let frameMax = 0;
    for (let i = 0; i < mags.length; i++) if (mags[i] > frameMax) frameMax = mags[i];
    const silent = frameMax < SILENCE_FLOOR;
    for (const [midi, st] of [...active]) {
      const e = noteEnergy(midi);
      if (e > st.peak) st.peak = e;
      if (silent || e < Math.max(SILENCE_FLOOR, st.peak * RELEASE_RATIO)) {
        st.releaseCount++;
        if (st.releaseCount >= RELEASE_FRAMES) release(midi);
      } else {
        st.releaseCount = 0;
      }
    }
  }

  function frame() {
    analyser.getFloatFrequencyData(dbBuf);
    for (let i = 0; i < dbBuf.length; i++) {
      const db = dbBuf[i];
      mags[i] = db <= -180 || !isFinite(db) ? 0 : Math.pow(10, db / 20);
    }

    const flux = computeSpectralFlux(mags, prevMags, fluxLoBin, fluxHiBin);
    if (!suppressed) {
      // Count down toward the analysis run BEFORE onset detection so a fresh
      // onset waits the full ANALYSIS_DELAY_FRAMES (attack fills the window).
      if (pendingAnalysis > 0 && --pendingAnalysis === 0) {
        analysisRun = ANALYSIS_RUN_FRAMES;
      }
      if (analysisRun > 0) {
        analysisRun--;
        analyze();
      }
      const sorted = [...fluxHist].sort((a, b) => a - b);
      const median = sorted.length ? sorted[sorted.length >> 1] : 0;
      const now = performance.now();
      if (
        flux > Math.max(FLUX_ABS_MIN, median * FLUX_MULT) &&
        now - lastOnsetAt > ONSET_REFRACTORY_MS
      ) {
        if (typeof window !== 'undefined' && window.__micDebug) {
          console.debug(`[micpitch] onset flux=${flux.toExponential(2)} median=${median.toExponential(2)}`);
        }
        lastOnsetAt = now;
        pendingAnalysis = ANALYSIS_DELAY_FRAMES;
        // Snapshot ringing notes' pre-onset energy for re-strike detection.
        // prevMags is the last pre-onset frame; probe it, not the attack frame.
        preOnsetEnergy.clear();
        const swap = mags;
        mags = prevMags;
        for (const midi of active.keys()) preOnsetEnergy.set(midi, noteEnergy(midi));
        mags = swap;
      }
      // Score-informed backup trigger (see expectedEnergyHist above).
      const exp = toExpectedSet();
      if (exp) {
        for (const midi of exp) {
          if (active.has(midi)) { expectedEnergyHist.delete(midi); continue; }
          const e = noteEnergy(midi);
          let h = expectedEnergyHist.get(midi);
          if (!h) { h = []; expectedEnergyHist.set(midi, h); }
          if (
            h.length >= EXPECTED_JUMP_LAG &&
            e > Math.max(SILENCE_FLOOR * 6, h[h.length - EXPECTED_JUMP_LAG] * EXPECTED_JUMP_RATIO) &&
            pendingAnalysis === 0 &&
            analysisRun === 0
          ) {
            if (typeof window !== 'undefined' && window.__micDebug) {
              console.debug(`[micpitch] expected-jump midi=${midi} e=${e.toExponential(2)}`);
            }
            analysisRun = ANALYSIS_RUN_FRAMES;
          }
          h.push(e);
          if (h.length > EXPECTED_JUMP_LAG + 2) h.shift();
        }
        for (const k of [...expectedEnergyHist.keys()]) {
          if (!exp.has(k)) expectedEnergyHist.delete(k);
        }
      } else {
        expectedEnergyHist.clear();
      }
      confirmPending();
    } else {
      pendingAnalysis = 0;
      analysisRun = 0;
      pendingUnexpected.clear();
      expectedEnergyHist.clear();
    }
    fluxHist.push(flux);
    if (fluxHist.length > FLUX_HISTORY) fluxHist.shift();

    updateActive();

    // Swap buffers: current becomes previous.
    const t = prevMags;
    prevMags = mags;
    mags = t;
  }

  async function start() {
    if (running) return true;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      onStatus('Mic: not supported in this browser.', 'error');
      return false;
    }
    try {
      // Music-friendly capture: browser voice processing (echo cancellation,
      // noise suppression, auto gain) mangles piano harmonics — turn it off.
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
      });
    } catch (err) {
      onStatus('Mic: permission denied — allow microphone access to use it.', 'error');
      return false;
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    audioCtx = new AC();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    source = audioCtx.createMediaStreamSource(stream);
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = MIC_FFT_SIZE;
    analyser.smoothingTimeConstant = 0; // raw frames — smoothing blurs onsets
    source.connect(analyser);

    const bins = analyser.frequencyBinCount;
    dbBuf = new Float32Array(bins);
    mags = new Float32Array(bins);
    prevMags = new Float32Array(bins);
    binHz = audioCtx.sampleRate / MIC_FFT_SIZE;
    fluxLoBin = Math.max(2, Math.floor(40 / binHz));
    fluxHiBin = Math.min(bins, Math.ceil(5000 / binHz));
    fluxHist.length = 0;
    lastOnsetAt = 0;
    pendingAnalysis = 0;
    analysisRun = 0;

    timer = setInterval(frame, MIC_HOP_MS);
    running = true;
    onStatus('🎤 Mic listening — play a note on your piano.', 'ok');
    return true;
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
    for (const midi of [...active.keys()]) release(midi);
    pendingUnexpected.clear();
    preOnsetEnergy.clear();
    expectedEnergyHist.clear();
    if (source) { try { source.disconnect(); } catch (_) {} source = null; }
    analyser = null;
    if (stream) {
      stream.getTracks().forEach((t) => t.stop()); // free the mic (privacy)
      stream = null;
    }
    if (audioCtx) { audioCtx.close().catch(() => {}); audioCtx = null; }
    running = false;
  }

  return {
    start,
    stop,
    dispose: stop,
    isRunning: () => running,
    setSuppressed: (b) => { suppressed = !!b; },
  };
}

// Expose the build number so devtools can verify which version is loaded.
if (typeof window !== 'undefined') window.__micpitchVersion = MICPITCH_VERSION;

// ---- Node export shim (browser-safe) ------------------------------------
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    midiToHz,
    hzToMidi,
    computeSpectralFlux,
    findSpectralPeaks,
    scoreCandidate,
    estimatePitches,
    createMicPitch,
    MIC_FFT_SIZE,
    MIC_MIN_MIDI,
    MIC_MAX_MIDI,
  };
}
