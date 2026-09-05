@echo off
REM Serve PianoSRS on a FIXED port so the bookmark and the browser's stored
REM library (IndexedDB is per-origin) stay stable between runs.
REM Double-click this, then open http://localhost:8080
cd /d "%~dp0"
start "" "http://localhost:8080"
node serve.js
pause
