// ─────────────────────────────────────────────────────────────────────────
// A stand-in Supabase for the public intake form.
//
//   node tests/intakemock.js            then open http://127.0.0.1:8903/intake.html
//
// WHY THIS IS IN THE REPO
// Its predecessor was not. Thirty test files and two mock servers lived in
// a scratch directory, and when the machine was rebuilt they went with it.
// They had caught a run of real faults — tiles rendering as NaN, a set
// returning RPC collapsed to its first row, a version gate that let a
// stale build sign in — and none of that was recoverable.
//
// A test that only exists on one machine is a test you do not have.
//
// WHAT IT SERVES
// The repo's own files, unmodified, plus the three things the form talks
// to: the branches list, the terms_for function, and the public-intake
// Edge Function. config.js is overridden so the page points here.
//
// It is deliberately small. It is not a Supabase, it is enough of one to
// let a browser drive the real form.
// ─────────────────────────────────────────────────────────────────────────
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.PORT || 8903);

const DEFAULT_TERMS = [
  '1. Introduction',
  'These Terms and Conditions ("Agreement") govern the enrolment and participation of swimmers in swimming lessons offered by Star Swim Sdn Bhd.',
  '7. Fees & Payment',
  '7.1 All fees are due in accordance with the payment schedule indicated in your enrolment confirmation.'
].join('\n\n');

const BRANCH_TERMS = [
  'SJKC BANDAR SERI BOTANI — SCHOOL SWIM PROGRAMME',
  '1. General Agreement',
  'This branch has terms of its own, and they stand alone.'
].join('\n\n');

const PROGRAMME_TERMS = 'A missed session is an absence. It is not replaced.';

const STATE = {
  branches: [
    { id: 'br-ssgt', name: 'SSGT', code: 'SSGT', is_active: true, sort_order: 1, terms_content: null },
    { id: 'br-sjkc', name: 'SJKC BSB', code: 'SJKCBSB', is_active: true, sort_order: 2,
      terms_content: BRANCH_TERMS }
  ],
  // Programmes, branch-scoped, as public_lesson_types returns them.
  lessonTypes: [
    { id: 'lt-squad', name: 'ASC Squad',     branch: 'br-sjkc' },
    { id: 'lt-lts',   name: 'Learn to Swim', branch: 'br-ssgt' },
    { id: 'lt-p1',    name: 'Personal 1',    branch: 'br-ssgt' }
  ],
  // An existing family, for the returning-parent route and for the
  // health declaration page. childList carries the ids the declaration
  // posts back; children stays an array of names, which is what the
  // deployed intake form reads.
  accounts: [
    { account_no: 'LEE-2394', phones: ['+60123456001', '+60198887777'],
      display_name: 'Lee Oy Yin', children: ['Aaryan', 'Mira'],
      childList: [{ id: 'stu-aaryan', name: 'Aaryan' }, { id: 'stu-mira', name: 'Mira' }] },
    // A family with nobody on the account, so the page can be made to
    // say so rather than show an empty list that reads as a fault.
    { account_no: 'NEW-0001', phones: ['+60111111111'],
      display_name: 'Tan Wei Ling', children: [], childList: [] }
  ],
  // Health declarations this mock has been sent.
  declarations: [],
  // What public-intake received, so a test can assert on the submission
  // rather than on the screen that produced it.
  submissions: []
};

// terms_for, as the database implements it: a branch replaces the
// default, a programme adds beneath it.
function termsFor(branchId, lessonTypeIds) {
  const b = STATE.branches.find(x => x.id === branchId);
  let out = (b && b.terms_content && b.terms_content.trim()) ? b.terms_content : DEFAULT_TERMS;
  const ids = Array.from(new Set(lessonTypeIds || []));
  if (ids.includes('lt-squad')) {
    out += '\n\nASC Squad — additional terms\n' + PROGRAMME_TERMS;
  }
  return out.trim();
}

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.json': 'application/json'
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

function body(req) {
  return new Promise(resolve => {
    let b = '';
    req.on('data', c => { b += c; });
    req.on('end', () => resolve(b));
  });
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const p = url.pathname;

  if (req.method === 'OPTIONS') return send(res, 204, '');

  // Lets a test put the form into a known state between runs.
  if (p === '/__reset') { STATE.submissions = []; STATE.declarations = []; return json(res, 200, { ok: true }); }
  if (p === '/__submissions') return json(res, 200, STATE.submissions);
  if (p === '/__declarations') return json(res, 200, STATE.declarations);

  // The page asks for its own config; point it at this server.
  if (p === '/config.js') {
    return send(res, 200,
      `window.APP_CONFIG = { supabaseUrl: "http://127.0.0.1:${PORT}", supabaseAnonKey: "test-anon-key" };`,
      TYPES['.js']);
  }

  if (p === '/rest/v1/branches') {
    return json(res, 200, STATE.branches.filter(b => b.is_active));
  }

  if (p === '/rest/v1/rpc/public_lesson_types') {
    const b = JSON.parse((await body(req)) || '{}');
    return json(res, 200, STATE.lessonTypes
      .filter(t => !b.p_branch_id || t.branch === b.p_branch_id)
      .map(t => ({ id: t.id, name: t.name })));
  }

  if (p === '/rest/v1/rpc/terms_for') {
    const b = JSON.parse((await body(req)) || '{}');
    // PostgREST returns a scalar function's result as a bare JSON value.
    return json(res, 200, termsFor(b.p_branch_id, b.p_lesson_type_ids));
  }

  if (p === '/functions/v1/public-intake') {
    const b = JSON.parse((await body(req)) || '{}');

    // find_account, as the database implements it: the number AND a
    // phone on the account, with one sentence for both failures.
    if (b.action === 'lookup') {
      const tail = x => String(x || '').replace(/[^0-9]/g, '').slice(-9);
      const a = STATE.accounts.find(x =>
        x.account_no === String(b.accountNo || '').toUpperCase() &&
        x.phones.some(ph => tail(ph) === tail(b.accountPhone)));
      if (!a) return json(res, 200, { ok: false,
        error: 'That account number and phone number do not go together.' });
      return json(res, 200, { ok: true, displayName: a.display_name,
        accountNo: a.account_no, children: a.children, childList: a.childList });
    }

    // The catch-up declaration, with the function's own guards: the pair
    // is proved again, and a child not on the account is dropped rather
    // than written.
    if (b.action === 'declare') {
      const tail = x => String(x || '').replace(/[^0-9]/g, '').slice(-9);
      const a = STATE.accounts.find(x =>
        x.account_no === String(b.accountNo || '').toUpperCase() &&
        x.phones.some(ph => tail(ph) === tail(b.accountPhone)));
      if (!a) return json(res, 200, { ok: false,
        error: 'That account number and phone number do not go together.' });
      if (!String(b.signatureName || '').trim())
        return json(res, 200, { ok: false, error: 'Type your name to sign.' });
      const mine = new Map(a.childList.map(k => [k.id, k.name]));
      const reference = 'HD-TEST001';
      const declared = [];
      for (const k of (b.children || [])) {
        const name = mine.get(k && k.id);
        if (!name) continue;
        STATE.declarations.push({ reference, id: k.id, name,
                                  signedBy: b.signatureName, health: k.health });
        declared.push({ name });
      }
      if (!declared.length) return json(res, 200, { ok: false,
        error: 'None of those children are on this account.' });
      return json(res, 200, { ok: true, reference, declared, refused: [] });
    }
    STATE.submissions.push(b);
    return json(res, 200, {
      ok: true,
      registered: (b.children || []).map(c => ({ name: c.name, id: 'stu-' + STATE.submissions.length })),
      acceptanceId: 'TC-TEST-0001'
    });
  }

  // Everything else is a file from the repo, served as it is.
  const rel = p === '/' ? '/intake.html' : p;
  const file = path.join(ROOT, rel.replace(/^\/+/, ''));
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    return send(res, 404, 'not found', 'text/plain');
  }
  return send(res, 200, fs.readFileSync(file), TYPES[path.extname(file)] || 'text/plain');
}).listen(PORT, '127.0.0.1', () => {
  console.log('intake mock on ' + PORT);
});
