// ─────────────────────────────────────────────────────────────────────────
// The attendance PWA — the Week screen, and who else is on.
//
//   node tests/attendancemock.js &    (or let run.sh do it)
//   node tests/attendance.test.js
//
// WHY
// attendance/app.js had no suite of any kind: files.test.js checks that
// its BUILD matches the worker's and that the shell pre-caches files that
// exist, which says nothing about what any screen draws. This covers the
// one thing an instructor now relies on — who they are working with
// tomorrow — and the rule around it, which is that a roster nobody has
// published answers with nothing.
//
// Four ways this can go quietly wrong, each with an assertion below:
//
//   The screen asks for the whole week instead of tomorrow onward, and
//   names appear under days already worked.
//   The list is keyed by date rather than by shift, so the people at the
//   morning pool turn up again under the afternoon one at a different
//   pool.
//   A session with nobody else on it draws nothing, which is exactly what
//   a feature that failed to load looks like.
//   An unpublished week reads as "no sessions", which to a worker means a
//   week off rather than a roster still being written.
// ─────────────────────────────────────────────────────────────────────────
'use strict';

const { launch } = require('./browser');

const BASE = process.env.BASE || 'http://127.0.0.1:8907';

(async () => {
  const b = await launch();
  const page = await (await b.newContext({
    viewport: { width: 412, height: 915 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true
  })).newPage();
  const errs = [];
  let fail = 0;
  page.on('pageerror', e => errs.push('PAGEERROR: ' + e.message));

  const step = async (n, f) => {
    try { await f(); console.log('PASS  ' + n); }
    catch (e) { console.log('FAIL  ' + n + ' -> ' + String(e.message).split('\n')[0]); fail++; }
  };

  const dates = await (await page.request.get(BASE + '/__dates')).json();
  const calls = () => page.request.get(BASE + '/__calls').then(r => r.json());

  await page.goto(BASE + '/attendance/', { waitUntil: 'networkidle' });
  // config.js plants the session, so the first load lands on the login
  // screen and the second is signed in.
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(900);

  await step('it opens signed in, on Today', async () => {
    if (await page.locator('#loginScreen').isVisible())
      throw new Error('still on the login screen');
    if (!(await page.locator('#viewToday').isVisible()))
      throw new Error('Today is not the screen it opens on');
  });

  const openWeek = async () => {
    await page.locator('#mainNav button[data-view="Week"]').click();
    await page.waitForTimeout(700);
  };
  const nextWeek = async () => {
    await page.locator('#wkmNext').click();
    await page.waitForTimeout(700);
  };

  await step('the Week screen draws this week', async () => {
    await openWeek();
    if (!(await page.locator('#viewWeek').isVisible())) throw new Error('Week did not open');
    const n = await page.locator('#weekList .wkday').count();
    if (n !== 7) throw new Error('expected 7 days, drew ' + n);
  });

  // ── Tomorrow onward, and not a day before it ──────────────────────────
  await step('it asks about tomorrow onward, never the days already worked', async () => {
    const c = await calls();
    const a = c.get_my_roster_buddies;
    if (!a) throw new Error('the Week screen never asked who else is on');
    const tomorrow = (() => {
      const d = new Date(dates.today + 'T12:00:00Z');
      d.setUTCDate(d.getUTCDate() + 1);
      return d.toISOString().slice(0, 10);
    })();
    if (a.p_from < tomorrow)
      throw new Error('asked from ' + a.p_from + ', which is ' + dates.today + ' or earlier');
  });

  await step('today and yesterday carry no "also here" line', async () => {
    const html = await page.locator('#weekList').innerHTML();
    if (/Should Not Appear/.test(html))
      throw new Error("today's session lists who else is on; that belongs on Today");
    if (/Also Not This One/.test(html))
      throw new Error('a day already worked lists who else was on');
  });

  // ── Next week: every day is in the future ─────────────────────────────
  await step('next week names who else is on, with their hours', async () => {
    await nextWeek();
    const html = await page.locator('#weekList').innerHTML();
    if (!/Siti Rahman/.test(html)) throw new Error('the colleague on the same shift is not named');
    if (!/Ahmad Faiz/.test(html))  throw new Error('the second colleague is not named');
    if (!/9:00 AM/.test(html))     throw new Error("the colleague's start time is not shown");
    if (!/1:00 PM/.test(html))     throw new Error("the colleague's end time is not shown");
  });

  await step('the names sit under the session they belong to, not the day', async () => {
    // Two sessions that Monday, at two different pools. Siti and Ahmad are
    // on the morning one only.
    const rows = page.locator('#weekList .wkday').nth(0).locator('.wkrow');
    const am = await rows.nth(0).innerHTML();
    const pm = await rows.nth(1).innerHTML();
    if (!/Siti Rahman/.test(am)) throw new Error('the morning session does not name its colleague');
    if (/Siti Rahman/.test(pm))
      throw new Error('the afternoon session at another pool inherited the morning list');
  });

  await step('a session with nobody else on it says so, rather than nothing', async () => {
    const pm = await page.locator('#weekList .wkday').nth(0).locator('.wkrow').nth(1).innerHTML();
    if (!/On your own/.test(pm))
      throw new Error('a lone session draws nothing, which is what a broken feature looks like');
  });

  // ── A roster nobody published ─────────────────────────────────────────
  await step('an unpublished week says so, rather than reading as a week off', async () => {
    await nextWeek();                       // the week after next: not published
    const t = await page.locator('#weekList').innerText();
    if (/No sessions this week/.test(t))
      throw new Error('an unpublished roster reads as "no sessions", which means a week off');
    if (!/not been published/i.test(t))
      throw new Error('it does not say the roster is unpublished: ' + JSON.stringify(t.slice(0, 120)));
  });

  await step('and it does not ask who is on in a week nobody has published', async () => {
    // Not an access rule — the function refuses anyway. It is that the
    // screen should not be drawing names it is about to be told it cannot
    // have.
    const html = await page.locator('#weekList').innerHTML();
    if (/Also here/.test(html)) throw new Error('it drew colleagues for an unpublished week');
  });

  // ── Before the SQL has been run ───────────────────────────────────────
  // The site deploys from main the moment the merge lands; the SQL is run
  // by hand afterwards. For those minutes the phone is calling a function
  // the database does not have. A week screen that breaks there is a week
  // screen that breaks for every instructor at once.
  await step('a database without the new function still draws the week', async () => {
    await page.request.get(BASE + '/__drop?fn=get_my_roster_buddies');
    errs.length = 0;
    // Back to this week and forward one, so this lands on next week --
    // the published one with sessions on it -- rather than wherever the
    // previous step left the screen.
    await page.locator('#wkmToday').click();
    await page.waitForTimeout(600);
    await nextWeek();
    const t = await page.locator('#weekList').innerText();
    if (/not been published/i.test(t) || !/\d/.test(t))
      throw new Error('the week came back empty when only the colleague list was missing');
    const html = await page.locator('#weekList').innerHTML();
    if (/Also here/.test(html)) throw new Error('it drew colleagues it could not have had');
    if (errs.length) throw new Error('it threw: ' + errs[0]);
  });

  await step('and the rest of the week still reads normally', async () => {
    const html = await page.locator('#weekList').innerHTML();
    if (!/Main Pool/.test(html)) throw new Error('the sessions themselves are gone too');
    if (!/On your own/.test(html))
      throw new Error('no answer at all is given, so a worker cannot tell the screen loaded');
    await page.request.get(BASE + '/__drop?reset=1');
  });

  // ── Ticking the syllabus from the poolside ────────────────────────────
  // The badge sits beside the swimmer's name on the class list, which is
  // where a coach is already looking when they have just watched the
  // child do the thing.
  const openClasses = async () => {
    await page.locator('#mainNav button[data-view="Classes"]').click();
    await page.waitForTimeout(900);
  };

  await step('a graded swimmer carries a level, an ungraded one carries none', async () => {
    await openClasses();
    const badges = await page.locator('#clsBody .lvlbtn').count();
    if (badges === 0) throw new Error('no level is shown beside any swimmer');
    if (badges !== 1)
      throw new Error('a swimmer on an ungraded lesson type was given a badge too: ' + badges);
    const t = await page.locator('#clsBody .lvlbtn').first().innerText();
    if (!/L1/.test(t)) throw new Error('the badge does not show the level: ' + JSON.stringify(t));
    if (!/3/.test(t)) throw new Error('the badge does not show how many levels there are');
  });

  await step('tapping it opens every level, not just the next one', async () => {
    await page.locator('#clsBody .lvlbtn').first().click();
    await page.waitForTimeout(700);
    const n = await page.locator('#gradePad .gms').count();
    if (n !== 3) throw new Error('expected all 3 levels, drew ' + n);
  });

  await step('each level has a bar that is its own tasks done over total', async () => {
    const t = await page.locator('#gradePad').innerText();
    if (!/0\/2/.test(t)) throw new Error('Guppy does not read 0/2: ' + JSON.stringify(t));
    if (!/0\/1/.test(t)) throw new Error('Tortoise does not read 0/1');
    // A level with no tasks must read 0/0 and an empty bar, not a full one.
    if (!/0\/0/.test(t)) throw new Error('a level with no tasks does not read 0/0');
    const w = await page.locator('#gradePad .gms').nth(2).locator('.gbar i')
      .evaluate(el => el.getBoundingClientRect().width);
    if (w > 1) throw new Error('a level with no tasks draws a full bar: ' + w + 'px');
  });

  await step('ticking a task fills the bar by one task', async () => {
    const bar = page.locator('#gradePad .gms').first().locator('.gbar i');
    const track = page.locator('#gradePad .gms').first().locator('.gbar');
    const before = await bar.evaluate(el => el.getBoundingClientRect().width);
    await page.locator('#gradePad .gms').first().locator('.gtask').first().click();
    await page.waitForTimeout(800);
    const after = await bar.evaluate(el => el.getBoundingClientRect().width);
    const full = await track.evaluate(el => el.getBoundingClientRect().width);
    if (!(after > before)) throw new Error('the bar did not move: ' + before + ' -> ' + after);
    // One of two tasks: half, not full and not a fixed step.
    if (Math.abs(after - full / 2) > full * 0.12)
      throw new Error('1 of 2 did not draw as half: ' + Math.round(after) + ' of ' + Math.round(full));
    const t = await page.locator('#gradePad').innerText();
    if (!/1\/2/.test(t)) throw new Error('the count does not read 1/2');
  });

  await step('completing a level says so out loud', async () => {
    let said = '';
    page.once('dialog', d => { said = d.message(); d.accept(); });
    await page.locator('#gradePad .gms').first().locator('.gtask').nth(1).click();
    await page.waitForTimeout(900);
    if (!said) throw new Error('a child finished a level and nothing said so');
    if (!/Guppy/.test(said)) throw new Error('it does not name the level: ' + JSON.stringify(said));
  });

  await step('and the badge beside the name moves with it', async () => {
    const t = await page.locator('#gradePad').innerText();
    if (!/2\/2/.test(t)) throw new Error('Guppy does not read 2/2 after both ticks');
    if (!/Level 1 of 3/.test(t))
      throw new Error('the header does not show the new level: ' + JSON.stringify(t.slice(0, 120)));
  });

  await step('a level with no certificate offers no button', async () => {
    // Guppy was completed above and carries no certificate.
    const n = await page.locator('#gradePad .gms').first().locator('.gcert').count();
    if (n) throw new Error('it offers a certificate on a level that has none');
  });

  await step('an unearned certificate level offers no button either', async () => {
    const n = await page.locator('#gradePad .gms').nth(1).locator('.gcert').count();
    if (n) throw new Error('it offers a certificate before the level is earned');
  });

  await step('earning a certificate level offers it, and tapping records it', async () => {
    let said = '';
    page.once('dialog', d => { said = d.message(); d.accept(); });
    await page.locator('#gradePad .gms').nth(1).locator('.gtask').first().click();
    await page.waitForTimeout(900);
    void said;
    const btn = page.locator('#gradePad .gms').nth(1).locator('.gcert');
    if (!(await btn.count())) throw new Error('an earned certificate level offers nothing');
    if (!/waiting/i.test(await btn.innerText()))
      throw new Error('it does not say one is waiting: ' + JSON.stringify(await btn.innerText()));
    await btn.click();
    await page.waitForTimeout(900);
    const after = await page.locator('#gradePad .gms').nth(1).locator('.gcert').innerText();
    if (!/given/i.test(after))
      throw new Error('tapping it did not record the hand-over: ' + JSON.stringify(after));
    if (!/Lee Mei Ling/.test(after))
      throw new Error('it does not name who handed it over: ' + JSON.stringify(after));
  });

  await step('a swimmer this coach is not rostered to is refused', async () => {
    const r = await page.evaluate(async () => {
      const res = await fetch('/rest/v1/rpc/coach_student_grading', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ p_student: 'stu-2' })
      });
      return res.json();
    });
    if (r.ok !== false) throw new Error('it answered for a swimmer not in their water');
    if (!/not rostered/i.test(r.error || '')) throw new Error('it did not say why: ' + JSON.stringify(r));
  });

  await step('no JS errors', async () => { if (errs.length) throw new Error(errs[0]); });

  console.log(fail ? fail + ' FAILED' : 'all green');
  await b.close();
  process.exit(fail ? 1 : 0);
})();
