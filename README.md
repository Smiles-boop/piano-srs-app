# PianoSRS

A spaced-repetition review app for piano practice — think Anki, but for pieces you're learning from **sheet music or MIDI**. Load a **MusicXML score** (or a MIDI file) and PianoSRS splits it into short practice sections automatically. The **engraved score is the main view**: as you play, a cursor follows along and the section you're drilling is highlighted. Prefer falling notes? One toggle switches to the **Synthesia-style** view over an on-screen piano. Connect a MIDI keyboard (or use the on-screen / computer keys) and play each due section. The app **detects the notes you play**: a section counts as reviewed once you play it cleanly — every note correct, start to finish — **10 times in a row**. Once that's done, the section's next review date is scheduled further out via an SM-2 style algorithm.

## How it works

- **Load a score or a MIDI file.** Import a **MusicXML** file (`.musicxml` or compressed `.mxl`) — the app engraves it as the main view and derives the practice timeline straight from the score, so no MIDI is needed. A `.mid` file still works too (it just opens in the Synthesia view). Everything is stored locally (IndexedDB) and split into phrase-based sections automatically — no manual page/measure entry.
- **Sheet view with a follow cursor.** The score renders with [OpenSheetMusicDisplay](https://opensheetmusicdisplay.org/). Pick a section and its measures highlight; as you play the right notes a cursor advances note-by-note, and a wrong note snaps it back to the section start. The **[Sheet | Synthesia]** toggle switches between the engraved score and the falling-notes view at any time.
- **Fingerings — the score's own first, suggestions to fill the gaps.** If the MusicXML already contains fingerings (many published / MuseScore scores do), those human-authored numbers are always shown and always win. Where the score has none, PianoSRS engraves its own *suggested* finger (1–5) — but only on *landmark* notes (the start of each hand, re-entries after a rest, big leaps, thumb crossings), so you get orientation at the spots that matter without a number on every note. The suggestions are a heuristic starting point, not gospel. (The Synthesia view can show a finger on every falling note via its **🖐 Fingers** toggle.)
- **Practice in wait mode.** The score waits for you; you advance by pressing the correct next note(s) at your own pace. Rhythm isn't graded — note correctness is.
- **Clean runs.** One wrong note restarts the current attempt. Ten flawless run-throughs of a section completes its review; then you rate it (Again / Hard / Good / Easy) and SM-2 schedules the next due date.
- **Memory mode (built in).** Because reading falling notes is recognition, not recall, the visual cues **fade automatically** as a section matures and within each session: **Watch** (full notes + key guides) → **Find** (notes, no key guides) → **Glance** (notes appear only at the last moment) → **Recall 40%** / **Recall 75%** (cloze: a random subset of the notes is hidden, re-rolled every run, so you recall the gaps while the rest anchor you) → **From memory** (blank except the opening note — play from recall). A brand-new section starts at Watch and the last runs of the session push you toward memory; after a few spaced reviews it starts blind. Rating "Again" brings the guides back. An auto-assist eases the level if you keep stalling, **👁 Peek** reveals everything while held, and stalling a few seconds at a hidden note ghosts in **just that note** as a hint — hinted runs count as half a rep.
- **Daily queue + stats.** On open, every section that's due today surfaces in one list, with streak / mastery / retention stats — exactly as before; only the *source* of a rep changed (a detected clean run instead of a button click).

## How to open

The app runs entirely in the browser with no build step. For note detection (Web MIDI), serve it over `http://localhost` and open it in **Chrome or Edge**:

```sh
python3 -m http.server 8080
# then open http://localhost:8080
```

Double-clicking `index.html` (file://) works for everything except live MIDI-keyboard input, which browsers restrict on `file://`. You can still practice with the on-screen keyboard or the computer-keyboard input in that case. Data is stored locally in IndexedDB.
