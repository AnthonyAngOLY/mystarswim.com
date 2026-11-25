// ─────────────────────────────────────────────────────────────────────────
// A stand-in Supabase for the attendance PWA.
//
//   node tests/attendancemock.js    then open http://127.0.0.1:8907/attendance/
//
// Serves the repo's own attendance/ unmodified, points config.js here, and
// answers the reads the app makes. A fixed session is planted so it opens
// signed in.
//
// The fixture is built relative to the real date, in Kuala Lumpur, because
// the screen under test is about "tomorrow and after" and a frozen date
// would stop being tomorrow the next morning.
//
// It honours p_from / p_to on get_my_roster_buddies and p_week_start on
// roster_week_state, and records the arguments it was called with. A mock
// that ignores an argument cannot catch the app sending the wrong one —
// asking for the whole week instead of tomorrow onward would look
// identical here otherwise, which is the exact fault this suite exists
// for.
// ─────────────────────────────────────────────────────────────────────────
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.PORT || 8907);
const TZ = 'Asia/Kuala_Lumpur';

const todayKL = () => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());
const addDays = (iso, n) => {
  const d = new Date(iso + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const mondayOf = (iso) => {
  const d = new Date(iso + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
};

const TODAY     = todayKL();
const THIS_MON  = mondayOf(TODAY);
const NEXT_MON  = addDays(THIS_MON, 7);
const AFTER_MON = addDays(THIS_MON, 14);

const ME = 'crew-me';

// Two pools on the same next-Monday, deliberately: the people at one are
// not the people at the other, and a buddy list keyed by date rather than
// by shift would spill one into the other.
const MAIN = { name: 'Main Pool' };
const KIDS = { name: 'Kids Pool' };

const SHIFTS = [
  { id: 'sh-yest', shift_date: addDays(TODAY, -1), start_time: '09:00:00', end_time: '11:00:00',
    status: 'attended', is_void: false, locations: MAIN, shift_categories: { name: 'Group' } },
  { id: 'sh-today', shift_date: TODAY, start_time: '09:00:00', end_time: '11:00:00',
    status: 'scheduled', is_void: false, locations: MAIN, shift_categories: { name: 'Group' } },
  { id: 'sh-mon-am', shift_date: NEXT_MON, start_time: '09:00:00', end_time: '11:00:00',
    status: 'scheduled', is_void: false, locations: MAIN, shift_categories: { name: 'Group' } },
  { id: 'sh-mon-pm', shift_date: NEXT_MON, start_time: '14:00:00', end_time: '16:00:00',
    status: 'scheduled', is_void: false, locations: KIDS, shift_categories: { name: 'Private' } },
  { id: 'sh-wed', shift_date: addDays(NEXT_MON, 2), start_time: '07:00:00', end_time: '09:00:00',
    status: 'scheduled', is_void: false, locations: MAIN, shift_categories: { name: 'Squad' } }
];

// Who is on with me, as the database would answer: one row per
// (my shift, other person). sh-mon-pm is deliberately absent — that is the
// session where the worker is on their own, and the screen has to say so
// rather than printing nothing.
const BUDDIES = [
  { shift_id: 'sh-mon-am', shift_date: NEXT_MON, buddy_name: 'Siti Rahman',
    buddy_start: '09:00:00', buddy_end: '11:00:00' },
  { shift_id: 'sh-mon-am', shift_date: NEXT_MON, buddy_name: 'Ahmad Faiz',
    buddy_start: '10:00:00', buddy_end: '13:00:00' },
  { shift_id: 'sh-wed', shift_date: addDays(NEXT_MON, 2), buddy_name: 'Coach Yong',
    buddy_start: '07:00:00', buddy_end: '09:00:00' },
  // Today and yesterday have company too. Nothing should draw it: today's
  // belongs on the Today screen, and yesterday's is a day already worked.
  { shift_id: 'sh-today', shift_date: TODAY, buddy_name: 'Should Not Appear',
    buddy_start: '09:00:00', buddy_end: '11:00:00' },
  { shift_id: 'sh-yest', shift_date: addDays(TODAY, -1), buddy_name: 'Also Not This One',
    buddy_start: '09:00:00', buddy_end: '11:00:00' }
];

// The last arguments each RPC was called with, readable over HTTP so the
// test can assert on the request rather than only on what was drawn.
// One child's ladder, mutated by ticks so the pad re-reads real changes.
const LADDER = {
  ok: true, graded: true,
  program: { id: 'pr1', name: 'Swim Passport', subtitle: 'Learn to Swim' },
  level: null, levels_total: 3,
  milestones: [
    { id: 'ms1', level_no: 1, name: 'Guppy', certificate: false, activated: false,
      total: 2, done: 0, tasks: [
        { id: 't1', name: 'Submerges whole head', done: false },
        { id: 't2', name: 'Blows bubbles', done: false } ] },
    { id: 'ms2', level_no: 2, name: 'Tortoise', certificate: true, activated: false,
      total: 1, done: 0, tasks: [
        { id: 't3', name: 'Glides from the wall', done: false } ] },
    { id: 'ms3', level_no: 3, name: 'Crab', certificate: false, activated: false,
      total: 0, done: 0, tasks: [] }
  ]
};

const CALLS = {};
// RPCs withdrawn for the length of a test, via /__drop.
const DROPPED = {};

const RPC = {
  client_gate:     () => ({ ok: true, known: true, min_build: 1 }),
  get_my_profile:  () => ([{ crew_id: ME, full_name: 'Lee Mei Ling', staff_id: 'SS021',
                             is_admin: false, is_hr: false, must_change_password: false,
                             consented_at: '2026-01-05T02:00:00Z' }]),
  get_my_shift_buddies: () => ([]),

  // The class list, with one swimmer who is graded.
  get_my_session_roster: () => ([
    { session_id: 'sess-1', session_date: TODAY, start_time: '09:00:00', end_time: '10:00:00',
      pool_name: 'Main Pool', lesson_type: 'Learn to Swim', coach_names: 'Lee Mei Ling',
      is_mine: true, is_cancelled: false, is_training: false,
      row_id: 'r1', student_id: 'stu-1', student_name: 'Mira Kwan',
      attendance_status: 'pending', credits_left: 4 },
    { session_id: 'sess-1', session_date: TODAY, start_time: '09:00:00', end_time: '10:00:00',
      pool_name: 'Main Pool', lesson_type: 'Learn to Swim', coach_names: 'Lee Mei Ling',
      is_mine: true, is_cancelled: false, is_training: false,
      row_id: 'r2', student_id: 'stu-2', student_name: 'Ungraded Child',
      attendance_status: 'pending', credits_left: 2 }
  ]),
  // Only stu-1 is on a graded lesson type. stu-2 must show no badge at
  // all rather than "Level 0", which would read as a child who has done
  // nothing instead of a lesson type nobody has set a programme on.
  my_roster_grading: () => ([
    { student_id: 'stu-1', program_name: 'Swim Passport', level_no: 1, levels_total: 3 }
  ]),

  coach_student_grading: (a) => {
    if (!a || a.p_student !== 'stu-1') return { ok: false, error: 'You are not rostered to this swimmer.' };
    return LADDER;
  },

  // Ticks into LADDER so the pad redraws from changed data, as it does
  // against the real thing. A mock that forgets cannot tell a screen
  // that re-reads from one that re-renders what it already had.
  mark_grading_task: (a) => {
    const ms = LADDER.milestones.find(m => m.tasks.some(t => t.id === a.p_task));
    if (!ms) return { ok: false, error: 'no such task' };
    const t = ms.tasks.find(x => x.id === a.p_task);
    t.done = !!a.p_on;
    t.marked_by = a.p_on ? 'Lee Mei Ling' : null;
    ms.done = ms.tasks.filter(x => x.done).length;
    ms.activated = ms.done === ms.total;
    LADDER.level = Math.max(0, ...LADDER.milestones.filter(m => m.activated).map(m => m.level_no)) || null;
    return { ok: true, task_id: a.p_task, milestone_id: ms.id, activated: ms.activated,
             milestone: ms.name, level_no: ms.level_no, certificate: !!ms.certificate };
  },

  get_my_roster_buddies: (a) => {
    CALLS.get_my_roster_buddies = a;
    if (!a || !a.p_from || !a.p_to) return [];
    return BUDDIES.filter(b => b.shift_date >= a.p_from && b.shift_date <= a.p_to);
  },

  // This week and next are published. The one after is not — which is the
  // difference between "you are off" and "it is not written yet".
  roster_week_state: (a) => {
    CALLS.roster_week_state = a;
    const wk = (a && a.p_week_start) || THIS_MON;
    const live = wk === THIS_MON || wk === NEXT_MON;
    return { week_start: wk, live: live,
             published_at: live ? '2026-11-20T02:00:00Z' : null,
             published_by: live ? 'the office' : null,
             shifts: 0, past_shifts: 0 };
  }
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

// The handful of PostgREST filters this app actually sends. Anything
// unrecognised is ignored rather than guessed at.
function filterShifts(params) {
  let rows = SHIFTS.slice();
  const crew = params.get('crew_id');
  if (crew && crew.startsWith('eq.') && crew.slice(3) !== ME) return [];
  for (const [k, v] of params) {
    if (k !== 'shift_date') continue;
    if (v.startsWith('gte.')) rows = rows.filter(s => s.shift_date >= v.slice(4));
    else if (v.startsWith('lte.')) rows = rows.filter(s => s.shift_date <= v.slice(4));
    else if (v.startsWith('lt.'))  rows = rows.filter(s => s.shift_date <  v.slice(3));
    else if (v.startsWith('eq.'))  rows = rows.filter(s => s.shift_date === v.slice(3));
  }
  return rows;
}

http.createServer((req, res) => {
  const u = new URL(req.url, 'http://127.0.0.1');
  const p = u.pathname;
  if (req.method === 'OPTIONS') return send(res, 204, '');

  // What the app asked for, so a test can assert on the request itself.
  if (p === '/__calls') return send(res, 200, JSON.stringify(CALLS));
  // Withdraw an RPC, so a test can drive the app against a database that
  // has not had the migration run yet. That window is real: the site
  // deploys from main the moment the merge lands, and the SQL is run by
  // hand afterwards.
  if (p === '/__drop') {
    const fn = u.searchParams.get('fn');
    if (fn) DROPPED[fn] = true;
    if (u.searchParams.get('reset')) for (const k of Object.keys(DROPPED)) delete DROPPED[k];
    return send(res, 200, JSON.stringify(DROPPED));
  }
  if (p === '/__dates') return send(res, 200, JSON.stringify(
    { today: TODAY, thisMon: THIS_MON, nextMon: NEXT_MON, afterMon: AFTER_MON }));

  if (p === '/attendance/config.js' || p === '/config.js') {
    return send(res, 200,
      `window.APP_CONFIG = { supabaseUrl: "http://127.0.0.1:${PORT}", supabaseAnonKey: "test-anon-key" };\n`
      + `try{ localStorage.setItem('ssb.attendance.session', JSON.stringify(`
      + `{access_token:'demo',refresh_token:'demo',persistent:true,saved_at:Date.now()})); }catch(e){}\n`,
      TYPES['.js']);
  }

  if (p.startsWith('/rest/v1/rpc/')) {
    const name = p.slice('/rest/v1/rpc/'.length);
    const fn = DROPPED[name] ? null : RPC[name];
    let body = '';
    req.on('data', c => { body += c; });
    return req.on('end', () => {
      let args = null;
      try { args = body ? JSON.parse(body) : null; } catch (_e) { args = null; }
      // An RPC this mock does not know answers 404, as a database without
      // the function would. The app must survive that.
      if (!fn) return send(res, 404, JSON.stringify({ message: 'function does not exist' }));
      send(res, 200, JSON.stringify(fn(args)));
    });
  }

  if (p === '/rest/v1/shifts')              return send(res, 200, JSON.stringify(filterShifts(u.searchParams)));
  if (p === '/rest/v1/attendance_settings') return send(res, 200, JSON.stringify(
    [{ grace_min: 5, reason_edit_window_min: 2, no_checkout_alert_min: 30, timezone: TZ }]));
  if (p === '/rest/v1/alerts')   return send(res, 200, '[]');
  if (p === '/rest/v1/punches')  return send(res, 200, '[]');
  if (p.startsWith('/rest/v1/')) return send(res, 200, '[]');
  if (p.startsWith('/auth/'))    return send(res, 200, JSON.stringify({ access_token: 'demo' }));

  const rel = p === '/' ? '/attendance/index.html' : p;
  const file = path.join(ROOT, rel.replace(/^\/+/, ''));
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    const idx = path.join(file, 'index.html');
    if (fs.existsSync(idx)) return send(res, 200, fs.readFileSync(idx), TYPES['.html']);
    return send(res, 404, 'not found', 'text/plain');
  }
  return send(res, 200, fs.readFileSync(file), TYPES[path.extname(file)] || 'text/plain');
}).listen(PORT, '127.0.0.1', () => console.log('attendance mock on ' + PORT));
