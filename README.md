# PianoSRS

A spaced-repetition review app for piano practice — think Anki, but for pieces you're learning from **MIDI**. Load a MIDI file and PianoSRS splits it into short practice sections automatically, then shows the notes falling **Synthesia-style** over an on-screen piano. Connect a MIDI keyboard (or use the on-screen / computer keys) and play each due section. The app **detects the notes you play**: a section counts as reviewed once you play it cleanly — every note correct, start to finish — **10 times in a row**. Once that's done, the section's next review date is scheduled further out via an SM-2 style algorithm.

## How it works

- **Load a MIDI file.** It's stored locally (IndexedDB) and split into phrase-based sections automatically — no manual page/measure entry.
- **Practice in wait mode.** The score waits for you; you advance by pressing the correct next note(s) at your own pace. Rhythm isn't graded — note correctness is.
- **Clean runs.** One wrong note restarts the current attempt. Ten flawless run-throughs of a section completes its review; then you rate it (Again / Hard / Good / Easy) and SM-2 schedules the next due date.
- **Memory mode (built in).** Because reading falling notes is recognition, not recall, the visual cues **fade automatically** as a section matures and within each session: **Watch** (full notes + key guides) → **Find** (notes, no key guides) → **Glance** (notes appear only at the last moment) → **From memory** (blank — play from recall). A brand-new section starts at Watch and the last runs of the session push you toward memory; after a few spaced reviews it starts blind. Rating "Again" brings the guides back. An auto-assist eases the level if you keep stalling, and **👁 Peek** reveals the notes while held.
- **Daily queue + stats.** On open, every section that's due today surfaces in one list, with streak / mastery / retention stats — exactly as before; only the *source* of a rep changed (a detected clean run instead of a button click).

## How to open

The app runs entirely in the browser with no build step. For note detection (Web MIDI), serve it over `http://localhost` and open it in **Chrome or Edge**:

```sh
python3 -m http.server 8080
# then open http://localhost:8080
```

Double-clicking `index.html` (file://) works for everything except live MIDI-keyboard input, which browsers restrict on `file://`. You can still practice with the on-screen keyboard or the computer-keyboard input in that case. Data is stored locally in IndexedDB.
