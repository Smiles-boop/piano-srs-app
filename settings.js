// settings.js — central, persisted user preferences (the QOL settings menu).
//
// One localStorage key holds a JSON blob of every toggle; each read falls back
// to DEFAULTS, so a missing key, a corrupt blob, or an older build is always
// safe. Kept in its own classic-script global (loaded before app.js) so the app
// can read/write it; the player receives a snapshot via player.applySettings()
// rather than reaching for globals, keeping player.js self-contained.

const SETTINGS_STORAGE_KEY = 'pianoSrsSettings';

const SETTINGS_DEFAULTS = {
  // ---- Reading aids ----
  keyNoteNames: 'c',        // 'off' | 'c' | 'all' — letter labels on the keys
  notation: 'letters',      // 'letters' | 'solfege' | 'german'
  octaveNumbers: false,     // append the octave number, e.g. C4 / Do4
  fallingNoteNames: false,  // draw the letter on each falling note (Synthesia)
  highlightC: false,        // tint every C key on the keyboard for orientation
  // ---- Practice view ----
  showFingerings: true,     // suggested fingering digits on the falling notes
  guideKeysDefault: false,  // start each section with the key-guides lit
  reduceMotion: false,      // disable the falling-note easing + UI transitions
  // ---- Input & feedback ----
  defaultHand: 'both',      // 'both' | 'rh' | 'lh' — hand a section opens on
  computerKeysDefault: false, // arm A…' computer-keyboard input on open
  noteSound: true,          // audible click when you play an on-screen/typed key
};

let SETTINGS = { ...SETTINGS_DEFAULTS };

/** Read + merge the saved blob over the defaults. Call once at startup. */
function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        SETTINGS = { ...SETTINGS_DEFAULTS, ...parsed };
      }
    }
  } catch (_) {
    // Corrupt JSON or localStorage unavailable — keep the defaults.
  }
  return SETTINGS;
}

/** One setting, falling back to its default if somehow absent. */
function getSetting(key) {
  return key in SETTINGS ? SETTINGS[key] : SETTINGS_DEFAULTS[key];
}

/** A defensive copy of every current setting (what the player is handed). */
function getAllSettings() {
  return { ...SETTINGS };
}

/** Write one setting through to localStorage; returns the stored value. */
function setSetting(key, value) {
  SETTINGS[key] = value;
  try {
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(SETTINGS));
  } catch (_) {
    // Unavailable (e.g. private mode) — the value still applies this session.
  }
  return SETTINGS[key];
}

// ---- Node export shim (browser-safe) ------------------------------------
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    SETTINGS_STORAGE_KEY,
    SETTINGS_DEFAULTS,
    loadSettings,
    getSetting,
    getAllSettings,
    setSetting,
  };
}
