# PianoSRS

A spaced-repetition review app for piano practice — think Anki, but for pieces being learned from sheet music PDFs. Upload a PDF of a piece, break it into named sections (by page + measure range), and each day the app surfaces the sections that are due for review. For each due section, your goal is to play it perfectly 10 times; you self-report each successful repetition via a button (no audio detection — you authenticate your own practice). Once 10 reps are logged, the section's next review date is scheduled further out via an SM-2 style algorithm.

## How to open

Double-click `index.html` — the app runs entirely in the browser with no build step. Data is stored locally in IndexedDB. PDF.js is loaded from a CDN, so an internet connection is required on first load.
