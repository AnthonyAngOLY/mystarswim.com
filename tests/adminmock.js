// ─────────────────────────────────────────────────────────────────────────
// A stand-in Supabase for the admin bundle.
//
//   node tests/adminmock.js          then open http://127.0.0.1:8904/app.html
//
// It serves the repo's own files unmodified, points config.js here, and
// answers the one table the Terms screen reads. It is not a Supabase; it
// is enough of one to let a browser load app.compiled.js and drive a
// screen out of it.
//
// WHY THE ADMIN BUNDLE NEEDS ONE AT ALL
// app.compiled.js is 1.3MB of committed build output. Nothing checked
// that it still worked beyond "Babel parsed it" — and Babel parses a file
// that calls a function somebody deleted perfectly happily. That is not a
// hypothetical: tidying a dead screen out of this file took three live
// things with it, and the build reported success.
// ─────────────────────────────────────────────────────────────────────────
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.PORT || 8904);

// What terms_defaults holds. Deliberately not the bundled wording, so a
// test can tell which of the two a screen is showing.
const DB_TERMS = [
  'STAR SWIM SDN BHD',
  '1. Introduction',
  'This copy lives in the database and is the one parents sign.',
  '7. Fees & Payment',
  '7.1 Fees are due as set out in your enrolment confirmation.'
].join('\n\n');

// Flipped by /__fail to make the terms_defaults read break, which is the
// only way to see the fallback banner.
const STATE = { failTerms: false };

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp',
  '.svg': 'image/svg+xml', '.json': 'application/json'
};

function send(res, code, body, type) {
  res.writeHead(code, {
    'Content-Type': type || 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Allow-Methods': 'GET,POST,PATCH,OPTIONS',
    'Cache-Control': 'no-store'
  });
  res.end(body);
}
const json = (res, code, obj) => send(res, code, JSON.stringify(obj));

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const p = url.pathname;

  if (req.method === 'OPTIONS') return send(res, 204, '');

  if (p === '/__fail') { STATE.failTerms = url.searchParams.get('on') === '1'; return json(res, 200, STATE); }
  if (p === '/__terms') return json(res, 200, { body: DB_TERMS });

  if (p === '/config.js') {
    return send(res, 200,
      `window.APP_CONFIG = { supabaseUrl: "http://127.0.0.1:${PORT}", supabaseAnonKey: "test-anon-key" };`,
      TYPES['.js']);
  }

  if (p === '/rest/v1/terms_defaults') {
    if (STATE.failTerms) return json(res, 500, { message: 'terms_defaults does not exist' });
    return json(res, 200, [{ body: DB_TERMS }]);
  }

  // Anything else the bundle asks for is an empty table rather than a 404,
  // so a stray read does not look like the failure under test.
  if (p.startsWith('/rest/v1/')) return json(res, 200, []);

  const rel = p === '/' ? '/app.html' : p;
  const file = path.join(ROOT, rel.replace(/^\/+/, ''));
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    return send(res, 404, 'not found', 'text/plain');
  }
  return send(res, 200, fs.readFileSync(file), TYPES[path.extname(file)] || 'text/plain');
}).listen(PORT, '127.0.0.1', () => {
  console.log('admin mock on ' + PORT);
});
