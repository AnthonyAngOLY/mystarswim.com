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

// Set by /__cool, spent by the next send. Lets a test drive the
// countdown without waiting the real sixty seconds.
const COOL = { sec: 0 };

const RPC = {
  my_family: () => ({
    ok: true, account_id: 'acct-1', display_name: 'Kwan Suk Lee',
    phone: '+60123456001',
    children: [{ id: 'stu-1', name: 'Kobe Kwan', age: 4, lesson_type: 'Toddler Group' },
               { id: 'stu-2', name: 'Mira Kwan', age: 6, lesson_type: 'Learn to Swim' }]
  }),
  my_messages: () => MESSAGES,
  // Two swimmers and a spread of dates, because the Progress view groups
  // by month and names the child only when there is more than one.
  // Honours p_student, as the database does. A mock that ignores an
  // argument cannot catch the app passing the wrong one — the Progress
  // view asking for a single swimmer would have looked identical here.
  my_child_notes: (a) => NOTES.filter(n => !a || !a.p_student || n.student_id === a.p_student),
  __notes: () => ([])
};

const NOTES = ([
    { student_id:'stu-1', child:'Kobe Kwan', id:'n1',
      body:'Kobe held a float-and-glide for a full width today without stopping. '
         + 'Breathing to the side is still catching him — we will work on turning '
         + 'the head rather than lifting it next week.',
      author:'Coach Sally', created_at:'2026-11-04T10:30:00Z' },
    { student_id:'stu-2', child:'Mira Kwan', id:'n2',
      body:'Mira jumped in unaided for the first time. Very pleased with herself, '
         + 'and rightly so.',
      author:'Coach Yong', created_at:'2026-11-01T09:10:00Z' },
    { student_id:'stu-1', child:'Kobe Kwan', id:'n3',
      body:'Covered for Sally today. Kobe is kicking from the knee — I have asked '
         + 'him to think about long legs. Worth keeping an eye on.',
      author:'Coach Yong', created_at:'2026-10-25T10:30:00Z' },
    { student_id:'stu-2', child:'Mira Kwan', id:'n4',
      body:'Settled much better this week. Stayed in the water the whole lesson.',
      author:'Coach Sally', created_at:'2026-10-18T09:10:00Z' }
  ]);

// Held as state, not rebuilt per call, so flag_message can actually change
// what the next my_messages returns. A mock that answers {ok:true} and
// forgets cannot tell the difference between the app sending the right
// argument and the app sending nothing at all — which is the exact way a
// dropped field has twice reached production here.
const MESSAGES = [
  { id: 'm1', kind: 'reminder', title: 'Class reminder', body: BODY,
    created_at: ago(2), read_at: null, flagged_at: null },
  { id: 'm2', kind: 'payment', title: 'Payment received — thank you',
    body: 'Thank you — we have received your payment of RM 480.00.',
    created_at: ago(28), read_at: ago(27), flagged_at: null },
  { id: 'm4', kind: 'absence', title: 'We missed you today',
    body: 'Hi Kwan Suk Lee, Kobe Kwan was marked absent from the 10:00 AM '
        + 'Toddler Group class today.',
    created_at: ago(5), read_at: null, flagged_at: null },
  { id: 'm3', kind: 'announcement', title: 'Pool closed — Deepavali',
    body: 'The centre is closed on Monday for the public holiday.',
    created_at: ago(70), read_at: null, flagged_at: null }
];

Object.assign(RPC, {
  my_schedule: () => ([]),
  my_payments: () => ([]),
  my_credits: () => ([]),
  my_attendance: () => ([]),
  mark_message_read: () => true,
  // Enough for a whole sign-in to complete, so the suite can drive the
  // loop a parent actually walks: out, number, code, back in. Without
  // these the verify succeeds and claim_parent_account answers nothing,
  // which the app correctly treats as being let in to no family.
  claim_parent_account: () => ({ ok: true }),
  touch_parent_login: () => true,
  // p_id is honoured. Pass the wrong key and nothing is flagged, which is
  // what the assertion is for.
  flag_message: (a) => {
    const m = MESSAGES.filter(x => x.id === (a && a.p_id))[0];
    if (!m) return { ok: false, error: 'No such message.' };
    m.flagged_at = new Date().toISOString();
    if (a && a.p_note) m.flag_note = a.p_note;
    return { ok: true };
  },
  unflag_message: (a) => {
    const m = MESSAGES.filter(x => x.id === (a && a.p_id))[0];
    if (!m) return { ok: false, error: 'No such message.' };
    m.flagged_at = null; m.flag_note = null;
    return { ok: true };
  }
});

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
    let body = '';
    req.on('data', c => { body += c; });
    return req.on('end', () => {
      let args = null;
      try { args = body ? JSON.parse(body) : null; } catch (_e) { args = null; }
      send(res, 200, JSON.stringify(fn ? fn(args) : []));
    });
  }
  // The gate in front of the code. Answers the way the deployed function
  // does now: known, and by SMS. channel is returned explicitly because
  // the screen prints it to the parent, and a mock that left it out would
  // let the app's own fallback answer instead of the server.
  // Makes the next sign-in send answer with a cooldown refusal, so the
  // countdown can be driven without a test that waits a real minute.
  if (p === '/__cool') {
    COOL.sec = Number(new URL(req.url, 'http://x').searchParams.get('sec') || 0);
    return send(res, 200, JSON.stringify(COOL));
  }

  if (p === '/functions/v1/parent-signin') {
    let body = '';
    req.on('data', c => { body += c; });
    return req.on('end', () => {
      let a = null;
      try { a = body ? JSON.parse(body) : null; } catch (_e) { a = null; }
      if (COOL.sec) {
        const sec = COOL.sec; COOL.sec = 0;   // one refusal, then normal
        return send(res, 429, JSON.stringify({ known: true, wait_sec: sec,
          error: 'We have just sent one. Give it ' + sec + ' more seconds.' }));
      }
      // Two seconds rather than sixty, so the countdown and the release
      // can both be driven inside a test run. The app must take this
      // figure from here, not from its own fallback.
      send(res, 200, JSON.stringify({ known: true, phone: (a && a.phone) || '',
                                      channel: 'sms', cooldown_sec: 2 }));
    });
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
