# How to run PianoSRS

PianoSRS is a static web app — no build step, no install, no toolchain. The whole thing runs in your browser. Total setup time: under 30 seconds.

## The 30-second path

1. Open File Explorer to `C:\Users\adria\Documents\Claude\piano-srs-app\`.
2. Double-click `index.html`.
3. Your default browser opens the app. Done.

That's the whole thing. The app is a single-page app made of plain HTML + JS + CSS, with IndexedDB doing the persistence and PDF.js loaded from a CDN to render sheet music.

## What you need

- A modern browser (Chrome, Edge, Firefox 100+, Safari 16+). Must support IndexedDB and ES modules — basically anything from the last 5 years.
- An internet connection on **first load only**, so PDF.js can be fetched from `cdnjs.cloudflare.com`. Subsequent loads use the browser's HTTP cache and work offline.

## What you do *not* need

- No `npm install`.
- No `node_modules`.
- No bundler, no transpiler, no dev server.
- No backend. No login. No account. Your data never leaves your machine.

## First-run walkthrough

1. **Add a piece.** Click the *+ Piece* button in the sidebar. Give it a title, drag a PDF of the sheet music in. The PDF is stored as a blob in IndexedDB.
2. **Section it.** Open the piece. Click *+ Section* and define a span by page + measure range, plus a name (e.g. "Exposition", "Bridge bar 33–48"). Sections are the unit of practice.
3. **Practice.** When a section is due, the daily review queue surfaces it. Open the section, play it through, and tap the rep button each time you nail it. Goal is **10 reps** per session.
4. **Rate.** When you hit 10 reps the rating prompt appears: *Again / Hard / Good / Easy*. The default is Good (autofocused). Each button shows the next-review date it'll produce — so you can see you're scheduling the section for "tomorrow" vs "in 6d" vs "in 15d" before you click.
5. **Stats panel** at the top shows today's progress (X/Y done), your daily streak, sections mastered, sections in rotation, and a per-piece retention bar.

## Where your data lives

- **IndexedDB** in your browser, under the origin `file:///` (or whatever origin you're serving from). Your pieces, sections, rep logs, and SRS state all live there.
- The PDF blobs are stored alongside, so opening the app on another machine won't see them — IndexedDB is per-browser-per-origin. Backup is on the roadmap (item 10: JSON export/import, in TODO.md).

## Optional: serve over HTTP for nicer behavior

Some browsers (Safari notably) restrict certain APIs on `file:///` origins. If you hit weirdness, serve the folder over a tiny local HTTP server instead of opening `index.html` directly:

```powershell
# Python (already installed if you did the Python projects)
cd C:\Users\adria\Documents\Claude\piano-srs-app
python -m http.server 8080
```

Then open `http://localhost:8080` in your browser.

Or, if you have Node installed:

```powershell
npx serve C:\Users\adria\Documents\Claude\piano-srs-app
```

Both serve the folder on `localhost`. The benefit is you get a "real" origin, so IndexedDB scoping and the PDF.js worker behave more predictably.

## Daily workflow

The `piano-srs-daily-dev` scheduled task (4× daily) writes incremental improvements into `app.js`, `srs.js`, `db.js`, `index.html`, `styles.css`, and `tests/`. Just refresh the browser tab (`Ctrl+R`) and you'll see today's roadmap item land — usually a small new feature or a quality-of-life tweak with tests passing in the `tests/` folder.

`PROGRESS.md` has a verbatim log of every change the agent made, including design decisions and the open questions it surfaced.

## Running the test suite

The tests are pure Node, no deps:

```powershell
cd C:\Users\adria\Documents\Claude\piano-srs-app
node tests/srs.test.mjs
node tests/db.test.mjs
node tests/queue.test.mjs
node tests/stats.test.mjs
```

Each prints `... helpers: all assertions passed` on success.

Or all at once:

```powershell
for /f %f in ('dir /b tests\*.mjs') do node tests\%f
```

## Common issues

- **PDF won't render** — PDF.js is loading from `cdnjs.cloudflare.com`. Check the browser console (`F12`) for a 4xx/5xx fetch error. Most likely your network is blocking that CDN; serve over `http://localhost:8080` or whitelist the domain.
- **Lost my progress** — IndexedDB is scoped per-browser-per-origin. If you opened the app from a different folder path, that's a different origin and your data is in a different IDB instance. Always open the app from the same path.
- **App opens but layout looks wrong** — hard refresh: `Ctrl+Shift+R`. The agent's daily runs sometimes ship CSS/JS together; a stale cache can show old layout against new markup.
- **"IndexedDB blocked"** — incognito / private mode disables persistent IDB on some browsers. Run in a normal window.

## Next steps

The next features are queued in `TODO.md`. Item 10 (JSON library export/import) is what unlocks moving your library between machines.
