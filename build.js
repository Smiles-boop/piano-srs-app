#!/usr/bin/env node
// PianoSRS build script.
//
// Concatenates db.js, srs.js, midi.js, metronome.js, player.js, and app.js
// into a single bundle.js that runs as a classic (non-module) script. This is
// needed because Chrome blocks ES module imports over file:// due to CORS.
// (index.html loads the individual files directly; this bundle is optional.)
//
// Usage:  node build.js
//
// The script strips `import` and `export` statements and wraps each
// source file in an IIFE that communicates through a shared `PianoSRS`
// namespace on `window`.

const fs = require('fs');
const path = require('path');

const DIR = __dirname;

function read(name) {
  return fs.readFileSync(path.join(DIR, name), 'utf8');
}

/**
 * Strip ES module syntax:
 * - `export function ...`   → `function ...`
 * - `export async function` → `async function`
 * - `export const ...`      → `const ...`
 * - `export { ... };`       → removed
 * - `import { ... } from '...'` → removed (we'll wire via globals)
 */
function stripModuleSyntax(src) {
  return src
    // Remove import lines
    .replace(/^import\s+\{[^}]*\}\s+from\s+['"][^'"]+['"];?\s*$/gm, '')
    .replace(/^import\s+\{[^}]*\}\s+from\s*\n\s*['"][^'"]+['"];?\s*$/gm, '')
    // Handle multi-line imports (import { \n ... \n } from '...')
    .replace(/^import\s*\{[\s\S]*?\}\s*from\s*['"][^'"]+['"];?\s*$/gm, '')
    // Remove `export {` blocks
    .replace(/^export\s*\{[^}]*\};?\s*$/gm, '')
    // `export function` → `function`
    .replace(/^export\s+(async\s+)?function\s/gm, '$1function ')
    // `export const` → `const`
    .replace(/^export\s+const\s/gm, 'const ')
    // `export class` → `class`
    .replace(/^export\s+class\s/gm, 'class ');
}

// --- db.js exports ---
const dbExports = [
  'REP_GOAL', 'openDb', 'listPieceMetadata', 'getPieceBlob', 'savePiece',
  'deletePiece', 'pieceToRecord', 'listSectionsForPiece', 'listAllSections',
  'saveSection', 'deleteSection', 'deleteSectionsForPiece',
  'deleteRepLogsForSections', 'sectionToRecord', 'validateSectionInput',
  'localDateISO', 'incrementRepLog', 'setRepLogCount',
  'getRepCountsForSections', 'getRepCountsForDate', 'isRepGoalMet',
  'listDistinctPracticeDates', 'exportLibrary', 'importLibrary',
  'listAllRepLogs', 'metadataFromRecord', 'repLogId', 'newRepLogRecord',
  'bumpRepLog', 'arrayBufferToBase64', 'base64ToArrayBuffer',
  'listRepLogsForSection', 'getRepLog', 'saveRepLog',
];

// --- srs.js exports ---
const srsExports = [
  'EASE_DEFAULT', 'EASE_MIN', 'RATING_AGAIN', 'RATING_HARD', 'RATING_GOOD',
  'RATING_EASY', 'defaultSrsState', 'srsStateForSection', 'updateEase',
  'applySm2', 'addDaysISO', 'daysBetweenISO', 'describeNextDue',
  'previewSm2Outcomes', 'buildReviewQueue', 'MASTERY_INTERVAL_DAYS',
  'isSectionMastered', 'computeDailyStreak', 'summariseProgress',
];

// --- midi.js exports ---
const midiExports = [
  'parseMidi', 'sectionizeByPhrase', 'groupNotesIntoSteps', 'notesInSection',
  'buildTempoMap', 'pairNotes',
];

// --- metronome.js exports ---
const metronomeExports = [
  'createMetronome', 'MIN_BPM', 'MAX_BPM', 'DEFAULT_BPM',
];

// --- player.js exports ---
const playerExports = ['createPlayer'];

function buildExportBlock(names, ns) {
  return names.map(n => `  window.PianoSRS.${n} = ${n};`).join('\n');
}

function buildImportBlock(names) {
  return names.map(n => `  const ${n} = window.PianoSRS.${n};`).join('\n');
}

// Build output
let out = `// PianoSRS — auto-generated bundle. Do not edit directly.
// Built by build.js from db.js + srs.js + midi.js + metronome.js + player.js + app.js.
// This file runs as a classic (non-module) script so the app works
// when opened via file:// without a local server.

window.PianoSRS = window.PianoSRS || {};

`;

// db.js
out += `// ===== db.js =====\n(function() {\n`;
out += stripModuleSyntax(read('db.js'));
out += `\n${buildExportBlock(dbExports)}\n})();\n\n`;

// srs.js
out += `// ===== srs.js =====\n(function() {\n`;
out += stripModuleSyntax(read('srs.js'));
out += `\n${buildExportBlock(srsExports)}\n})();\n\n`;

// midi.js
out += `// ===== midi.js =====\n(function() {\n`;
out += stripModuleSyntax(read('midi.js'));
out += `\n${buildExportBlock(midiExports)}\n})();\n\n`;

// metronome.js
out += `// ===== metronome.js =====\n(function() {\n`;
out += stripModuleSyntax(read('metronome.js'));
out += `\n${buildExportBlock(metronomeExports)}\n})();\n\n`;

// player.js — needs midi.js globals
out += `// ===== player.js =====\n(function() {\n`;
out += buildImportBlock(midiExports) + '\n\n';
out += stripModuleSyntax(read('player.js'));
out += `\n${buildExportBlock(playerExports)}\n})();\n\n`;

// app.js — needs imports from the other modules
const appImports = [
  ...dbExports, ...srsExports, ...midiExports, ...metronomeExports,
  ...playerExports,
];
out += `// ===== app.js =====\n(function() {\n`;
out += buildImportBlock(appImports) + '\n\n';
out += stripModuleSyntax(read('app.js'));
out += `\n})();\n`;

fs.writeFileSync(path.join(DIR, 'bundle.js'), out, 'utf8');
console.log(`bundle.js written (${(out.length / 1024).toFixed(1)} KB)`);
