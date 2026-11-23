// ─────────────────────────────────────────────────────────────────────────
// The onboarding kit: the QR, the landing page, and the two manuals.
//
//   node tests/guides.test.js        (browser + tests/guidesmock.js)
//
// Printed material fails differently from code. A QR that encodes the
// wrong string looks exactly like one that does not, and the failure is
// found by a parent at the counter whose phone went somewhere else. A
// manual that names a screen which has since been renamed is worse than
// no manual, because staff read it aloud to customers.
//
// So two kinds of assertion here. The ones that decode and measure —
// does the committed QR really resolve to a page that exists, does
// anything overflow a phone, does the print view keep the card. And the
// ones that tie prose back to the code it describes: the six tabs the
// manual names are read out of parent/index.html, and the sign-in URL is
// checked against _redirects. Those are the lines that rot in silence.
// ─────────────────────────────────────────────────────────────────────────
'use strict';

const fs   = require('fs');
const path = require('path');
const B    = require('./browser');

const ROOT = path.resolve(__dirname, '..');
const BASE = 'http://127.0.0.1:' + (process.env.PORT || 8908);
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const URL_GET = 'https://www.mystarswim.com/get';

let fail = 0;
const step = (n, f) => Promise.resolve().then(f)
  .then(() => console.log('PASS  ' + n))
  .catch(e => { console.log('FAIL  ' + n + ' -> ' + String(e.message).split('\n')[0]); fail++; });
const ok = (c, m) => { if (!c) throw new Error(m); };
const eq = (a, b, m) => { if (a !== b) throw new Error(m + ' — got ' + a + ', wanted ' + b); };

(async () => {

  // ── The QR, decoded ──────────────────────────────────────────────────
  await step('the committed QR decodes to the printed URL', () => {
    const jsQR = require('jsqr');
    const { PNG } = require('pngjs');
    const img = PNG.sync.read(fs.readFileSync(path.join(ROOT, 'qr-app.png')));
    const got = jsQR(new Uint8ClampedArray(img.data), img.width, img.height);
    ok(got, 'the committed qr-app.png does not decode at all');
    eq(got.data, URL_GET, 'the QR points somewhere else');
  });

  await step('that URL is the one the staff guide prints beside it', () => {
    const g = read('staff-guide.html');
    ok(g.includes('mystarswim.com/get'), 'the staff guide does not show the short URL');
    ok(g.includes('qr-app.png'), 'the staff guide does not show the QR');
  });

  await step('/get is actually served, and as a rewrite not a redirect', () => {
    const r = read('_redirects');
    const line = r.split('\n').filter(l => /^\/get\s/.test(l))[0];
    ok(line, 'nothing in _redirects answers /get');
    ok(/\/welcome\.html/.test(line), '/get does not reach welcome.html');
    ok(/\s200\b/.test(line), '/get is not a 200 rewrite — the printed address would change in the bar');
  });

  // ── The manual against the app it describes ──────────────────────────
  await step('the six tabs the manual names are the six the app has', () => {
    const shell = read('parent/index.html');
    const tabs = [...shell.matchAll(/<button data-v="[a-z]+"[^>]*><b>([^<]+)<\/b>([A-Za-z]+)/g)]
      .map(m => ({ icon: m[1], name: m[2] }));
    eq(tabs.length, 6, 'the parent app no longer has six tabs');

    const guide = read('guide.html');
    for (const t of tabs) {
      ok(guide.includes(t.name), 'the manual never mentions the "' + t.name + '" tab');
      ok(guide.includes(t.icon), 'the manual does not show the ' + t.name + ' icon (' + t.icon + ')');
    }
  });

  await step('the staff guide names a dispute screen that exists', () => {
    // It tells staff to look under Parents → Sent → Disputed. If that tab
    // is renamed, the guide sends them somewhere that is not there.
    const app = read('app.js');
    ok(/\['sent','📨 Sent'\]/.test(app), 'the Parents module no longer has a Sent tab');
    ok(/Disputed \(/.test(app), 'the Sent tab no longer has a Disputed segment');
    ok(read('staff-guide.html').includes('Sent'), 'the staff guide no longer points at it');
  });

  await step('the manual promises the button the parent app actually has', () => {
    ok(read('parent/app.js').includes('data-flag'),
       'the parent app has no dispute button');
    ok(read('guide.html').includes('This isn’t right'),
       'the manual does not mention it');
  });

  await step('no guide promises a channel the system does not send on', () => {
    // The guides said the code arrives on WhatsApp. It does not: WhatsApp
    // needs an approved Meta business sender, which takes weeks, so
    // parent-signin falls back to SMS and SMS is what every parent will
    // actually receive. Prose that describes a different system from the
    // one running is worse than no prose — staff read it to customers.
    //
    // If WhatsApp is ever approved, this assertion is what reminds whoever
    // flips the channel that three pages describe the old one.
    for (const f of ['welcome.html', 'guide.html']) {
      const text = read(f);
      ok(!/arrives? (on|by) <b>WhatsApp/i.test(text),
         f + ' still says the code arrives on WhatsApp');
      ok(!/code on WhatsApp/i.test(text),
         f + ' still promises a WhatsApp code');
    }
    const staff = read('staff-guide.html');
    ok(!/code on WhatsApp/i.test(staff),
       'staff-guide.html still promises a WhatsApp code');
    ok(!/arrives on WhatsApp/i.test(staff),
       'staff-guide.html still says the code arrives on WhatsApp');
    // The one legitimate mention: staff send the invite over WhatsApp.
    ok(/For WhatsApp, or anywhere else/.test(staff),
       'the staff guide lost the note about sending the invite by WhatsApp');
  });

  await step('the coach guide names the buttons the coach app has', () => {
    const app = read('attendance/app.js');
    // The register's two buttons, read out of the app rather than
    // remembered. A coach reading "tap Present" for a button that says
    // "Here" is a coach who thinks the app is broken.
    const marks = [...app.matchAll(/data-mk="(\w+)"[\s\S]{0,160}?>([A-Za-z]+)<\/button>/g)]
      .map(m => m[2]);
    eq(marks.length, 2, 'the register no longer has exactly two mark buttons');
    const coach = read('coach-guide.html');
    for (const label of marks) {
      ok(new RegExp('>' + label + '<').test(coach),
         'the coach guide never shows the "' + label + '" button');
    }
  });

  await step('the coach guide is right that parents see notes at once', () => {
    // The guide tells coaches, in a red box, that a note reaches the
    // parent immediately. That claim has to keep matching the app's own
    // wording, or we are telling staff something about the system that
    // stopped being true.
    ok(/They see it straight away/.test(read('attendance/app.js')),
       'the note pad no longer promises parents see notes straight away');
    ok(/reads it\. Straight away\.|straight away/i.test(read('coach-guide.html')),
       'the coach guide no longer warns that parents read notes immediately');
  });

  await step('the staff guide points at both manuals', () => {
    const staff = read('staff-guide.html');
    ok(staff.includes('/guide.html'), 'no link to the parent manual');
    ok(staff.includes('/coach-guide.html'), 'no link to the coach guide');
  });

  await step('every way in actually leads somewhere', () => {
    // Three doors, and until now the site had none of them. A parent
    // looking for a login was landing on the staff scheduler.
    const home = read('index.html');
    ok(/href="\.\/get"/.test(home), 'the homepage does not link the parent app');

    // Eight flat links became five top-level items. The regrouping is only
    // worth having if nothing fell out of it, so every destination the nav
    // used to offer must still be reachable from inside it.
    const nav = home.slice(home.indexOf('<nav class="hd-nav"'),
                           home.indexOf('</nav>', home.indexOf('<nav class="hd-nav"')));
    for (const href of ['#programmes', './schedule.html', '#pricing', '#pathways',
                        '#why', '#how', '#faq', '#contact', './get', './app.html']) {
      ok(nav.includes('href="' + href + '"'),
         'the nav lost ' + href + ' in the regrouping');
    }
    const topLevel = (nav.match(/class="hd-link"/g) || []).length
                   + (nav.match(/class="hd-link hd-top"/g) || []).length * 0;
    ok(topLevel <= 5, 'the nav is back up to ' + topLevel + ' top-level items');
    ok(/Staff Login/.test(home), 'the staff login is still labelled as if it were the only one');

    // The intake form creates the account, so the family can sign in the
    // moment they finish. The screen has to say so or the moment is lost.
    ok(/mystarswim\.com\/get/.test(read('intake.js')),
       'the registration success screen does not point at the app');
    ok(/mystarswim\.com\/get/.test(read('intake.compiled.js')),
       'intake.compiled.js was not rebuilt after that change');
  });

  await step('the manual and the setup page do not repeat each other', () => {
    const guide = read('guide.html');
    ok(!/<h2>Getting in<\/h2>/.test(guide),
       'guide.html still carries its own sign-in walkthrough');
    ok(!/Putting it on your home screen/.test(guide),
       'guide.html still carries its own install instructions');
    ok(/mystarswim\.com\/get/.test(guide),
       'guide.html does not send an unregistered reader to the setup page');
    // The illustration moved rather than being deleted.
    ok(/class="trio"/.test(read('welcome.html')),
       'the sign-in illustration did not land on the setup page');
  });

  // ── Rendered ─────────────────────────────────────────────────────────
  const browser = await B.launch({ args: ['--headless', '--no-sandbox'] });

  for (const [page, width] of [['welcome', 390], ['guide', 390], ['staff-guide', 390],
                               ['coach-guide', 390]]) {
    await step('nothing on ' + page + ' overflows a phone', async () => {
      const p = await browser.newPage();
      const errs = [];
      p.on('pageerror', e => errs.push(e.message));
      await p.setViewportSize({ width, height: 844 });
      await p.goto(BASE + '/' + page + '.html', { waitUntil: 'networkidle' });
      const over = await p.evaluate(() =>
        document.documentElement.scrollWidth - document.documentElement.clientWidth);
      await p.close();
      ok(!errs.length, 'script error: ' + errs[0]);
      ok(over <= 0, 'it scrolls sideways by ' + over + 'px');
    });
  }

  await step('/get reaches the landing page, not a 404', async () => {
    const p = await browser.newPage();
    const res = await p.goto(BASE + '/get', { waitUntil: 'networkidle' });
    const h1 = await p.locator('h1').first().innerText();
    await p.close();
    eq(res.status(), 200, '/get did not resolve');
    ok(/phone/i.test(h1), '/get landed somewhere unexpected: "' + h1 + '"');
  });

  await step('the landing page offers both iPhone and Android, whichever it guessed', async () => {
    const p = await browser.newPage();
    await p.goto(BASE + '/welcome.html', { waitUntil: 'networkidle' });
    const before = await p.evaluate(() => ({
      ios: !document.getElementById('ios').hidden,
      and: !document.getElementById('and').hidden
    }));
    ok(before.ios !== before.and, 'both platforms are showing at once, or neither is');
    await p.click('#bIos');
    const afterIos = await p.evaluate(() => !document.getElementById('ios').hidden);
    await p.click('#bAnd');
    const afterAnd = await p.evaluate(() => !document.getElementById('and').hidden);
    await p.close();
    ok(afterIos, 'tapping iPhone does not show the iPhone steps');
    ok(afterAnd, 'tapping Android does not show the Android steps');
  });

  await step('Copy puts the message on the clipboard, not its own label', async () => {
    const p = await browser.newPage();
    await p.goto(BASE + '/staff-guide.html', { waitUntil: 'networkidle' });
    const txt = await p.evaluate(() => {
      const box = document.getElementById('msg1');
      return Array.prototype.filter.call(box.childNodes, n => n.nodeType === 3)
        .map(n => n.nodeValue).join('').trim();
    });
    await p.close();
    ok(!/(^|\s)Copy(\s|$)/.test(txt), 'the word "Copy" is in the copied message');
    ok(txt.startsWith('Hi {name}'), 'the message does not start where it should: ' + txt.slice(0,30));
    ok(txt.includes(URL_GET), 'the copied message does not contain the sign-up link');
  });

  await step('printing keeps the card and opens every answer', async () => {
    const p = await browser.newPage();
    await p.goto(BASE + '/staff-guide.html', { waitUntil: 'networkidle' });
    await p.emulateMedia({ media: 'print' });
    const out = await p.evaluate(() => ({
      card: getComputedStyle(document.querySelector('.qrcard')).display !== 'none',
      copy: getComputedStyle(document.querySelector('.copy')).display,
      // Collapsed <details> would otherwise print as six headings and no
      // answers — the half a person at the counter actually needs.
      answers: Array.from(document.querySelectorAll('.qa .body'))
        .every(e => getComputedStyle(e).display !== 'none')
    }));
    await p.close();
    ok(out.card, 'the QR card is hidden when printing');
    eq(out.copy, 'none', 'the Copy button prints');
    ok(out.answers, 'collapsed answers do not print');
  });

  await browser.close();
  console.log(fail ? fail + ' failed' : 'all green');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
