/* Tiny static server for PianoSRS. No dependencies — just `node serve.js`.
 *
 * The one thing this does that `python -m http.server` doesn't is send
 * `Cache-Control: no-store`. Python sends only Last-Modified, so Chrome
 * applies heuristic caching and can serve a stale app.js for hours after the
 * file changes — the app looks like it simply ignored an update. Serving the
 * files fresh every time is worth more here than any caching win, since this
 * only ever serves localhost.
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = __dirname;
const PORT = Number(process.env.PORT) || 8080;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.musicxml': 'application/xml; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.mxl': 'application/vnd.recordare.musicxml',
  '.mid': 'audio/midi',
  '.midi': 'audio/midi',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
};

const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const file = path.resolve(ROOT, rel);
  // Never serve anything outside the app folder.
  if (file !== ROOT && !file.startsWith(ROOT + path.sep)) {
    res.writeHead(403, { 'content-type': 'text/plain' }).end('forbidden');
    return;
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
      return;
    }
    res.writeHead(200, {
      'content-type': TYPES[path.extname(file).toLowerCase()]
        || 'application/octet-stream',
      'cache-control': 'no-store, must-revalidate',
    }).end(data);
  });
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n  Port ${PORT} is already in use — PianoSRS may already be`);
    console.error('  running in another window. Try that one first.\n');
    process.exit(1);
  }
  throw err;
});

server.listen(PORT, () => {
  console.log(`\n  PianoSRS  ->  http://localhost:${PORT}`);
  console.log('  Leave this window open while you practise. Ctrl+C to stop.\n');
});
