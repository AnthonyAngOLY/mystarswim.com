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

// table path -> the last PATCH body seen for it.
const PATCHES = {};

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const p = url.pathname;

  if (req.method === 'OPTIONS') return send(res, 204, '');

  if (p === '/__fail') { STATE.failTerms = url.searchParams.get('on') === '1'; return json(res, 200, STATE); }
  if (p === '/__terms') return json(res, 200, { body: DB_TERMS });

  // The last PATCH sent to each table, readable over HTTP. Without it a
  // save can only be checked by what the screen does afterwards, and a
  // screen that closes its panel looks identical whether it sent the
  // right columns, the wrong ones, or none.
  if (p === '/__patches') return json(res, 200, PATCHES);
  if (req.method === 'PATCH') {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    return req.on('end', () => {
      try { PATCHES[p] = { query: url.search, body: JSON.parse(raw || '{}') }; }
      catch (_e) { PATCHES[p] = { query: url.search, body: raw }; }
      return json(res, 200, []);
    });
  }

  if (p === '/config.js') {
    return send(res, 200,
      `window.APP_CONFIG = { supabaseUrl: "http://127.0.0.1:${PORT}", supabaseAnonKey: "test-anon-key" };`,
      TYPES['.js']);
  }

  if (p === '/rest/v1/terms_defaults') {
    if (STATE.failTerms) return json(res, 500, { message: 'terms_defaults does not exist' });
    return json(res, 200, [{ body: DB_TERMS }]);
  }

  // Two days of sign-in spend, so the arithmetic on that screen has
  // something to be wrong about. 12 sent and 1 failed is 13 chargeable
  // at the rate the screen is set to; the refusals cost nothing and must
  // not be counted.
  // The syllabus, three levels deep, so the grading screen has a ladder
  // to draw. Swim Passport level 2 deliberately has no tasks: a level
  // that awards itself to everyone is the fault worth seeing on screen.
  if (p === '/rest/v1/grading_programs') {
    return json(res, 200, [
      { id: 'pr1', name: 'Swim Passport', subtitle: 'Learn to Swim', sort_order: 1,
        is_active: true, syllabus_body: 'Malaysia Aquatics',
        syllabus_name: 'BADGES \u2014 Swimming Proficiency Test',
        syllabus_version: '1.0' },
      { id: 'pr2', name: 'Water Discovery', subtitle: 'Toddlers', sort_order: 2, is_active: true }
    ]);
  }
  if (p === '/rest/v1/grading_milestones') {
    return json(res, 200, [
      { id: 'ms1', program_id: 'pr1', level_no: 1, name: 'Guppy', certificate: false, is_active: true },
      { id: 'ms2', program_id: 'pr1', level_no: 2, name: 'Tortoise', certificate: true, is_active: true },
      { id: 'ms3', program_id: 'pr2', level_no: 1, name: 'Droplet', certificate: false, is_active: true }
    ]);
  }
  if (p === '/rest/v1/grading_tasks') {
    return json(res, 200, [
      { id: 't1', milestone_id: 'ms1', name: 'Submerges whole head', sort_order: 1, is_active: true },
      { id: 't2', milestone_id: 'ms1', name: 'Blows bubbles', sort_order: 2, is_active: true },
      { id: 't3', milestone_id: 'ms3', name: 'Enters without distress', sort_order: 1, is_active: true }
    ]);
  }

  // Two earned certificates: one waiting since March, one already given.
  if (p === '/rest/v1/rpc/certificates_pending') {
    return json(res, 200, [
      { student_id: 's1', student_name: 'Mira Kwan', account_name: 'Kwan Suk Lee',
        program_name: 'Swim Passport', milestone_id: 'ms2', level_no: 2, milestone: 'Tortoise',
        achieved_at: '2026-03-04T02:00:00Z', claimed_at: null, claimed_by: null },
      { student_id: 's2', student_name: 'Kobe Kwan', account_name: 'Kwan Suk Lee',
        program_name: 'Swim Passport', milestone_id: 'ms2', level_no: 2, milestone: 'Tortoise',
        achieved_at: '2026-10-01T02:00:00Z', claimed_at: '2026-10-02T02:00:00Z',
        claimed_by: 'Coach Sally' }
    ]);
  }
  if (p === '/rest/v1/rpc/claim_certificate') return json(res, 200, { ok: true, claimed: true });

  if (p === '/rest/v1/rpc/parent_otp_spend') {
    return json(res, 200, [
      { day: '2026-11-24', sent: 9, failed: 1, cooldown: 4, capped: 2,
        unknown: 31, archived: 1, numbers: 7 },
      { day: '2026-11-23', sent: 3, failed: 0, cooldown: 0, capped: 0,
        unknown: 0, archived: 0, numbers: 3 }
    ]);
  }
  if (p === '/rest/v1/rpc/parent_password_uptake') {
    return json(res, 200, { ok: true, accounts_live: 269, signed_in_ever: 40,
      passwords_set: 30, codes_30d: 12, passwords_30d: 36 });
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
