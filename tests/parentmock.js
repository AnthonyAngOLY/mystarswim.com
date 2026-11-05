// ─────────────────────────────────────────────────────────────────────────
// A stand-in Supabase for the parent app.
//
//   node tests/parentmock.js       then open http://127.0.0.1:8906/parent/
//
// Serves the repo's own parent/ unmodified, points config.js here, and
// answers the handful of RPCs the app reads. A fixed session token is
// planted so it opens signed in — the sign-in screen is reachable by
// clearing site data.
//
// It exists so the parent app can be looked at, and photographed, at
// all. Until now it could only be seen by a parent holding a phone that
// is on an account and waiting for a WhatsApp code, which is no way to
// check whether a message reads properly before it goes to 42 families.
// ─────────────────────────────────────────────────────────────────────────
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.PORT || 8906);

const BODY = [
  'Dear Kwan Suk Lee,', '',
  'Kobe Kwan has a Toddler Group session scheduled on Saturday 5:00 PM.', '',
  'Kindly inform us ahead of time, at least 24 hours before the class, if you are '
  + 'unable to attend, and let us assist you in finding a replacement session. A '
  + 'replacement session must be scheduled within 14 days of the missed class.', '',
  'Thank you.', '', 'Star Swim'
].join('\n');

const ago = (h) => new Date(Date.now() - h * 3600e3).toISOString();

const RPC = {
  my_family: () => ({
    ok: true, account_id: 'acct-1', display_name: 'Kwan Suk Lee',
    phone: '+60123456001',
    children: [{ id: 'stu-1', name: 'Kobe Kwan', age: 4, lesson_type: 'Toddler Group' }]
  }),
  my_messages: () => ([
    { id: 'm1', kind: 'reminder', title: 'Class reminder', body: BODY,
      created_at: ago(2), read_at: null },
    { id: 'm2', kind: 'payment', title: 'Payment received — thank you',
      body: 'Dear Kwan Suk Lee,\n\nThank you — we have received your payment of RM 480.00.\n\n'
          + 'Your receipt RCT-202611-0810 is in your account under Payments, together with the '
          + 'invoice it settles.\n\nWe appreciate you keeping your account up to date, and we '
          + 'look forward to seeing you at the pool.\n\nStar Swim',
      created_at: ago(28), read_at: ago(27) },
    { id: 'm3', kind: 'announcement', title: 'Pool closed — Deepavali',
      body: 'The centre is closed on Monday for the public holiday. All Monday classes that '
          + 'week are moved to the Saturday.',
      created_at: ago(70), read_at: null }
  ]),
  my_schedule: () => ([]),
  my_payments: () => ([]),
  my_credits: () => ([]),
  my_attendance: () => ([]),
  mark_message_read: () => true
};

const TYPES = { '.html':'text/html; charset=utf-8', '.js':'application/javascript; charset=utf-8',
  '.css':'text/css; charset=utf-8', '.png':'image/png', '.json':'application/json',
  '.jpg':'image/jpeg', '.webp':'image/webp', '.svg':'image/svg+xml' };

function send(res, code, body, type) {
  res.writeHead(code, { 'Content-Type': type || 'application/json',
    'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*',
    'Access-Control-Allow-Methods': 'GET,POST,PATCH,OPTIONS', 'Cache-Control': 'no-store' });
  res.end(body);
}

http.createServer((req, res) => {
  const p = new URL(req.url, 'http://127.0.0.1').pathname;
  if (req.method === 'OPTIONS') return send(res, 204, '');

  if (p === '/parent/config.js' || p === '/config.js') {
    // The planted session is what makes this open signed in.
    return send(res, 200,
      `window.APP_CONFIG = { supabaseUrl: "http://127.0.0.1:${PORT}", supabaseAnonKey: "test-anon-key" };\n`
      + `try{ localStorage.setItem('ssb.parent.session', JSON.stringify(`
      + `{access_token:'demo',refresh_token:'demo'})); }catch(e){}\n`,
      TYPES['.js']);
  }

  if (p.startsWith('/rest/v1/rpc/')) {
    const fn = RPC[p.slice('/rest/v1/rpc/'.length)];
    return send(res, 200, JSON.stringify(fn ? fn() : []));
  }
  if (p.startsWith('/auth/')) return send(res, 200, JSON.stringify({ access_token: 'demo' }));

  const rel = p === '/' ? '/parent/index.html' : p;
  const file = path.join(ROOT, rel.replace(/^\/+/, ''));
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    const idx = path.join(file, 'index.html');
    if (fs.existsSync(idx)) return send(res, 200, fs.readFileSync(idx), TYPES['.html']);
    return send(res, 404, 'not found', 'text/plain');
  }
  return send(res, 200, fs.readFileSync(file), TYPES[path.extname(file)] || 'text/plain');
}).listen(PORT, '127.0.0.1', () => console.log('parent mock on ' + PORT));
