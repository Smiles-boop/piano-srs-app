# How to run PianoSRS

PianoSRS is a static web app — no build step, no install, no toolchain. The whole thing runs in your browser.

## The fast path

For full note detection (live MIDI keyboard via the Web MIDI API), serve the folder over a local HTTP server and open it in **Chrome or Edge**:

```sh
cd piano-srs-app
python3 -m http.server 8080
# open http://localhost:8080
```

Or with Node: `npx serve .`

Double-clicking `index.html` also works, but browsers restrict the Web MIDI API on `file://`, so a physical MIDI keyboard may not be detected there. The on-screen keyboard and computer-keyboard input work regardless.

## What you need

- A modern browser. **Web MIDI (physical keyboard input) needs Chromium — Chrome or Edge.** Safari and Firefox don't implement Web MIDI yet; in those, use the on-screen keyboard or the computer-keyboard input instead.
- IndexedDB + ES-class support — anything from the last few years.
- No internet connection is required — OpenSheetMusicDisplay is vendored under `vendor/`, no CDN.
- `.mxl` (compressed MusicXML) import uses the browser's `DecompressionStream`, so it needs Chromium (Chrome/Edge) — same as Web MIDI. Uncompressed `.musicxml` works everywhere.

## First-run walkthrough

1. **Add a piece.** Click *+ Add piece* and choose a **MusicXML** score (`.musicxml` / `.mxl`) or a `.mid` / `.midi` file. It's stored locally (IndexedDB) and parsed in-browser. A score renders as engraved sheet music and **derives its own practice timeline** — no MIDI needed.
2. **Sections appear automatically.** PianoSRS splits the piece into short phrases at natural rests. You can rename, reorder (drag), edit notes/fingerings, delete, or *Re-split* from scratch.
3. **Practice.** Click a section (or one from the "Due today" queue). On a score, the section's measures highlight and a cursor follows as you play; use the **[Sheet | Synthesia]** toggle to switch to falling notes. Connect a MIDI keyboard, or click the on-screen keys, or toggle *Computer keys* and use `A…'` (with `Z`/`X` to shift octave).
4. **Clean runs.** Play the highlighted notes. Reach the end with **zero wrong notes** for one clean run — a wrong note restarts the attempt. Ten clean runs completes the review.
5. **Rate.** The *Again / Hard / Good / Easy* prompt appears; each shows the next-review date it'll produce. SM-2 schedules the section.

**Memory mode is built into the loop.** The on-screen guides fade automatically — *Watch → Find → Glance → Recall 40% → Recall 75% → From memory* — as a section matures (across spaced reviews) and across the 10 runs of each session, so you're trained to recall rather than read. The Recall stages hide a random subset of the notes (re-rolled every run); From memory shows only the section's opening note as an entry cue. The level chip in the practice panel shows where you are; **👁 Peek** (hold) reveals the notes if you're stuck, stalling a few seconds at a hidden note ghosts in just that note as a hint (hinted runs count as half a rep), and the level eases itself if you keep resetting. A failed review ("Again") brings the full guides back.

Click **▶ Load sample piece** to import a bundled Twinkle Twinkle score (`samples/twinkle.musicxml`) and see the sheet view immediately. Regenerate the samples with `node samples/make-twinkle-xml.mjs` (score) or `node samples/make-twinkle.mjs` (MIDI).

**Sheet-view notes (v1).** Repeats / voltas / D.S. play once in document order (section practice is unaffected — measures map 1:1 — but a full single-take run-through won't repeat; import a MIDI if you need exact repeats). Grace notes are skipped in the practice timeline (still drawn on the score). Memory-mode cue-fading runs on the Synthesia view.

## Practice-panel shortcuts

`L` listen (synth preview) · `R` restart run · `1`–`4` rate · `Esc` stop · `M` metronome · `T` pause timer · `D` dark mode · hold **👁 Peek** to reveal notes. (The opt-in *Computer keys* mode owns the letter keys while it's on.)

## Where your data lives

IndexedDB, per-browser-per-origin. Pieces (MIDI blobs), sections, rep logs, and SRS state all live there. Use *Export library* / *Import backup* (JSON) to move between browsers.

## Running the test suite

Pure Node, no deps:

```sh
for f in tests/*.mjs; do node "$f"; done
```

Each prints `... all assertions passed` on success.

## Common issues

- **My MIDI keyboard isn't detected** — Web MIDI needs Chrome/Edge served over `http://localhost` (not `file://`). Grant the MIDI permission when prompted. Meanwhile the on-screen / computer keys still work.
- **"Couldn't read … MIDI"** — the file may be a SMPTE-timed or otherwise unusual MIDI. Most standard piano MIDI exports (format 0/1, PPQ timing) load fine.
- **Lost my progress** — IndexedDB is scoped per-origin; open the app from the same URL each time.
- **Layout looks wrong after an update** — hard refresh (`Ctrl/Cmd+Shift+R`) to clear a stale cache.
