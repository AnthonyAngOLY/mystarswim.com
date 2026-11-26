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

// ── The company's registration number ───────────────────────────────────
// SSM reissued every company a 12-digit number in 2019, and LHDN
// e-invoicing works off that one. A document going out with only
// 1602674-U on it is a document with the number most registries cannot
// find — which is exactly how the Twilio verification failed twice.
step('every printed document carries the current SSM number', () => {
  for (const f of ['app.js', 'app.compiled.js', 'welcome.html', 'guide.html',
                   'staff-guide.html', 'coach-guide.html']) {
    const src = read(f);
    // The old number is fine beside the new one — that is the convention.
    // What must not appear is the old number on its own.
    const bare = (src.match(/1602674-U/g) || []).length
               - (src.match(/202501001260 \(1602674-U\)/g) || []).length;
    if (bare > 0) throw new Error(f + ' prints the pre-2019 number alone, ' +
      bare + ' time' + (bare === 1 ? '' : 's'));
  }
  if (!read('app.js').includes('202501001260'))
    throw new Error('app.js never prints the current registration number');
});

// ── The MAS badge artwork ───────────────────────────────────────────────
// supabase_grading_mas_badges.sql points every level at one of these,
// and the apps draw them with no tile behind. A roundel saved without
// transparency is a circle on a white square on a tinted card, which is
// the thing it was redrawn to stop being -- and nothing about the file
// name says which it is.
step('every roundel is on disk, transparent, and web-sized', () => {
  const want = ['mas-1-starfish', 'mas-2-sea-turtle', 'mas-3-guppy', 'mas-4-octopus',
                'mas-5-frog', 'mas-6-swordfish', 'mas-7-dolphin', 'mas-badges-mark',
                'ss-a-water-discovery', 'ss-b-water-exploration', 'ss-1-water-acclimation',
                'ss-2-water-movement', 'ss-3-water-stamina', 'ss-4-stroke-introduction',
                'ss-5-stroke-development', 'ss-6-stroke-mechanics', 'star-swim-mark'];
  for (const n of want) {
    const rel = 'badges/' + n + '.png';
    if (!exists(rel)) throw new Error('missing: ' + rel);
    const buf = fs.readFileSync(path.join(ROOT, rel));
    if (buf.slice(1, 4).toString() !== 'PNG') throw new Error(rel + ' is not a PNG');
    // IHDR: width, height, bit depth, then the colour type at byte 25.
    // 4 and 6 carry an alpha channel; 3 is a palette, transparent only
    // if a tRNS chunk says which entries are.
    const type = buf[25];
    const alpha = type === 4 || type === 6
               || (type === 3 && buf.includes(Buffer.from('tRNS')));
    if (!alpha) throw new Error(rel + ' has no transparency — it will draw as a square');
    // A 3334px original dropped in here is 175 KB down a phone line, for
    // a picture drawn at 40.
    if (buf.length > 60 * 1024)
      throw new Error(rel + ' is ' + Math.round(buf.length / 1024) + ' KB — resize it');
  }
});

// A roundel must BE the circle, not a circle sitting somewhere inside a
// square. Both sets shipped cut to the artboard they were drawn on
// rather than to their own outline -- the MAS ones 11px off centre, the
// passport ones inset by 3 on every side and cut 37px too tall, because
// the sticker sheet they came off is not level. It reads as a badge
// that has been cropped, and nothing in the file name says so.
step('every roundel is the circle, centred, filling its frame', () => {
  const magick = (args) => require('child_process')
    .execFileSync('convert', args, { encoding: 'utf8' }).trim();
  for (const f of fs.readdirSync(path.join(ROOT, 'badges')).filter(f => !/-mark\.png$/.test(f))) {
    const rel = path.join(ROOT, 'badges', f);
    // The opaque part of the image, measured. Must fill the canvas
    // corner to corner: anything less is margin, and margin off-centre
    // is the fault this catches.
    const box = magick([rel, '-alpha', 'extract', '-fuzz', '50%', '-trim',
                        '-format', '%w %h %X %Y', 'info:']);
    const [w, h, x, y] = box.split(/\s+/).map(v => parseInt(v, 10));
    const size = parseInt(magick([rel, '-format', '%w', 'info:']), 10);
    if (Math.abs(w - size) > 1 || Math.abs(h - size) > 1)
      throw new Error(f + ': the circle is ' + w + 'x' + h + ' inside a ' + size
        + 'px frame — it was cut to its artboard, not to its outline');
    if (Math.abs(x) > 1 || Math.abs(y) > 1)
      throw new Error(f + ': the circle sits at +' + x + '+' + y + ', not centred');
  }
});

// And the migrations point at exactly these, by the path the apps use.
for (const [file, n] of [['supabase_grading_mas_badges.sql', 8],
                         ['supabase_swim_passport_syllabus.sql', 9]]) {
  step(file + ' and the artwork agree on the paths', () => {
    const sql = read(file);
    // The confirm blocks' `like '/badges/%'` is not one of them.
    const paths = [...new Set([...sql.matchAll(/'(\/badges\/[^']+\.png)'/g)].map(m => m[1]))];
    if (paths.length !== n)
      throw new Error('expected ' + n + ' artwork paths, found ' + paths.length
                      + ': ' + paths.join(' '));
    for (const p of paths)
      if (!exists(p.replace(/^\//, '')))
        throw new Error(p + ' is in the migration and not in the repository');
  });
}

// The stickers came off a KuRenang passport. Removing that mark was the
// job, and "it looked right in the montage" is not a check that survives
// somebody re-cutting the artwork later.
step('no sticker still carries the old academy mark', () => {
  for (const f of fs.readdirSync(path.join(ROOT, 'badges'))) {
    const buf = fs.readFileSync(path.join(ROOT, 'badges', f));
    if (/kurenang/i.test(buf.toString('latin1')))
      throw new Error(f + ' still names the previous academy');
  }
  // And the SQL that installs them credits us, not them.
  const sql = read('supabase_swim_passport_syllabus.sql');
  if (/kurenang/i.test(sql.replace(/^--.*$/gm, '')))
    throw new Error('the migration still names the previous academy outside its comments');
});

console.log(fail ? fail + ' FAILED' : 'all green');
process.exit(fail ? 1 : 0);
