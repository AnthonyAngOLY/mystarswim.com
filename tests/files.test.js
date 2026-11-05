// ─────────────────────────────────────────────────────────────────────────
// What has to be on disk for the deploy to be the deploy.
//
//   node tests/files.test.js        (no browser, no mock, no server)
//
// These are facts about the repository, not about any code path, and each
// one is here because getting it wrong fails somewhere far from the edit.
// ─────────────────────────────────────────────────────────────────────────
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const exists = (p) => fs.existsSync(path.join(ROOT, p));

let fail = 0;
const step = (n, f) => {
  try { f(); console.log('PASS  ' + n); }
  catch (e) { console.log('FAIL  ' + n + ' -> ' + String(e.message).split('\n')[0]); fail++; }
};

// ── The attendance PWA ──────────────────────────────────────────────────
// Its service worker pre-caches a fixed list with caches.addAll, and
// addAll rejects as a whole if any single entry 404s. One missing file
// there does not degrade the app, it stops the worker installing, and the
// app stops being installable with no error anybody sees.
step('every file the attendance shell pre-caches exists', () => {
  const sw = read('attendance/sw.js');
  const block = sw.match(/var SHELL = \[([\s\S]*?)\];/);
  if (!block) throw new Error('could not find SHELL in attendance/sw.js');
  const items = block[1].match(/'([^']+)'/g).map(s => s.slice(1, -1));
  if (items.length < 5) throw new Error('only found ' + items.length + ' shell entries');
  const missing = items
    .filter(x => x !== './')                 // the directory itself
    .map(x => 'attendance/' + x.replace(/^\.\//, ''))
    .filter(p => !exists(p));
  if (missing.length) throw new Error('missing: ' + missing.join(', '));
});

// attendance/config.js is a byte-for-byte copy of the root one. It has to
// be: the directory is served both as its own origin and as a path, and
// './config.js' has to resolve either way. A copy that is allowed to
// drift is how the admin app and the intake form ended up showing two
// different sets of terms, so this asserts they are the same file rather
// than hoping.
step('the attendance config is the same config as the root', () => {
  const a = read('config.js').trim();
  const b = read('attendance/config.js').trim();
  if (a !== b) throw new Error('attendance/config.js has drifted from config.js');
});

// BUILD names the cache and is checked by the database through
// require_client_build. If the two disagree, a phone can be running one
// build while caching under another's name.
step('BUILD matches between the attendance app and its worker', () => {
  const app = read('attendance/app.js').match(/BUILD\s*=\s*(\d+)/);
  const sw = read('attendance/sw.js').match(/BUILD\s*=\s*(\d+)/);
  if (!app || !sw) throw new Error('could not read BUILD from both files');
  if (app[1] !== sw[1]) throw new Error('app.js says ' + app[1] + ', sw.js says ' + sw[1]);
});

// ── The parent app ──────────────────────────────────────────────────────
// Added the day it became installable. Everything here is the same trap
// the attendance app walked into: a shell that pre-caches a file it does
// not have, and a manifest whose paths are right from one URL and wrong
// from the other.
step('every file the parent shell pre-caches exists', () => {
  const sw = read('parent/sw.js');
  const block = sw.match(/var SHELL = \[([\s\S]*?)\];/);
  if (!block) throw new Error('could not find SHELL in parent/sw.js');
  const items = block[1].match(/'([^']+)'/g).map(s => s.slice(1, -1));
  const missing = items
    .filter(x => x !== './')
    .map(x => 'parent/' + x.replace(/^\.\//, ''))
    .filter(p => !exists(p));
  if (missing.length) throw new Error('missing: ' + missing.join(', '));
});

// The attendance manifest declares start_url, scope and icons as "/",
// which is right while it owns a hostname and wrong from the path form:
// installing from mystarswim.com/attendance would install the public
// WEBSITE under the Attendance name. The parent app is served from two
// places from day one, so its paths are relative and must stay that way.
step('the parent manifest works from both the hostname and the path', () => {
  const m = JSON.parse(read('parent/manifest.json'));
  for (const k of ['start_url', 'scope']) {
    if (!String(m[k] || '').startsWith('.'))
      throw new Error(k + ' is "' + m[k] + '" — absolute, so it means the site root '
        + 'when installed from mystarswim.com/parent');
  }
  for (const ic of m.icons || []) {
    if (!String(ic.src).startsWith('.'))
      throw new Error('icon ' + ic.src + ' is absolute');
    if (!exists('parent/' + ic.src.replace(/^\.\//, '')))
      throw new Error('icon ' + ic.src + ' does not exist');
  }
});

step('BUILD matches between the parent app and its worker', () => {
  const app = read('parent/app.js').match(/BUILD\s*=\s*(\d+)/);
  const sw = read('parent/sw.js').match(/BUILD\s*=\s*(\d+)/);
  if (!app || !sw) throw new Error('could not read BUILD from both files');
  if (app[1] !== sw[1]) throw new Error('app.js says ' + app[1] + ', sw.js says ' + sw[1]);
});

// ── The deploy ──────────────────────────────────────────────────────────
// attendance.mystarswim.com is served by this site's /attendance folder,
// through a rewrite. Netlify prefers a matching static file over a
// redirect rule unless the rule is forced, and "/" matches the public
// website's index.html — so without the !, a coach opening the attendance
// hostname is shown the home page instead.
// Both app hostnames, held to the same two rules: a rewrite and not a
// redirect, because a 301 sends an installed PWA outside its own scope;
// and forced, because /index.html exists at the publish root and an
// unforced rule loses to it, serving the public website instead.
for (const [host, path] of [['attendance', 'attendance'], ['app', 'parent']]) {
  step(`${host}.mystarswim.com is rewritten, forced, and not redirected`, () => {
    if (!exists('_redirects')) throw new Error('no _redirects at the publish root');
    const lines = read('_redirects').split('\n')
      .map(l => l.trim()).filter(l => l && !l.startsWith('#'));
    const rule = lines.find(l => l.startsWith('https://' + host + '.mystarswim.com'));
    if (!rule) throw new Error('nothing routes ' + host + '.mystarswim.com');
    if (!new RegExp('/' + path + '/:splat').test(rule))
      throw new Error('does not carry the path: ' + rule);
    if (/\b30[12]\b/.test(rule))
      throw new Error('a redirect, not a rewrite — this breaks installed PWAs: ' + rule);
    if (!/\b200!/.test(rule))
      throw new Error('not forced, so index.html wins and the website is served: ' + rule);
  });
}

// ── No second copies ────────────────────────────────────────────────────
// Netlify deploys every file in the functions directory as its own
// endpoint. A duplicate is a second live endpoint nothing calls, which
// will be found later and believed.
step('there is one scan function, not two', () => {
  const dir = path.join(ROOT, 'netlify', 'functions');
  if (!fs.existsSync(dir)) return;
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.js'));
  const seen = new Map();
  for (const f of files) {
    const body = fs.readFileSync(path.join(dir, f), 'utf8');
    if (seen.has(body)) throw new Error(f + ' is byte-identical to ' + seen.get(body));
    seen.set(body, f);
  }
});

// ── The ledger ──────────────────────────────────────────────────────────
// A source-level check, which is crude, and here because the thing it
// guards is not reachable from the UI any more — the Void button refuses
// a paid invoice, and that refusal is covered in the admin suite. This
// covers the floor beneath it: if somebody removes the guard later, the
// function behind it must still not erase receipts.
step('voiding an invoice does not delete its payments', () => {
  const src = read('app.js');
  const i = src.indexOf('async function voidInvoice(');
  if (i < 0) throw new Error('voidInvoice is gone');
  const body = src.slice(i, src.indexOf('\n  }', i));
  if (/deleteRows\(\s*['"]payments['"]/.test(body))
    throw new Error('voidInvoice deletes payments — a receipt is a document the parent holds');
  if (!/kind:\s*['"]reversal['"]/.test(body))
    throw new Error('voidInvoice no longer writes a reversing entry');
});

// The one place that may remove payments is the explicit, settings-gated
// delete, which says so and asks first. Anywhere else is a bug.
step('payments are deleted in one place only, and it is the gated one', () => {
  const src = read('app.js');
  const hits = [...src.matchAll(/deleteRows\(\s*['"]payments['"]/g)].map(m => {
    const before = src.slice(0, m.index);
    const fn = [...before.matchAll(/(?:async )?function (\w+)\(/g)].pop();
    return fn ? fn[1] : '(top level)';
  });
  const unexpected = hits.filter(f => f !== 'deleteInvoice');
  if (unexpected.length)
    throw new Error('payments deleted in: ' + unexpected.join(', '));
});

console.log(fail ? fail + ' FAILED' : 'all green');
process.exit(fail ? 1 : 0);
