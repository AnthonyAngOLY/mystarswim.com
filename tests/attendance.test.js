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
    // The passport's own label, not the rung number: this swimmer holds
    // a sticker that says A.
    if (!/^A/.test(t)) throw new Error('the badge does not show the stage: ' + JSON.stringify(t));
    if (/L1/.test(t)) throw new Error('it printed the rung number over the badge label: ' + t);
    if (!/3/.test(t)) throw new Error('the badge does not show how many levels there are');
  });

  // A database with no grading module and a grading module that is
  // broken look identical to this screen unless it is told to tell them
  // apart. One is a shrug; the other cost a day of looking.
  await step('a syllabus module that is not installed changes nothing', async () => {
    await page.request.get(BASE + '/__drop?fn=my_roster_grading');
    await openClasses();
    if (await page.locator('#clsBody .lvlbtn').count() !== 0)
      throw new Error('badges drawn from a function that is not there');
    if (await page.locator('#clsBody .note.warn').count() !== 0)
      throw new Error('a database without the grading module is not a fault, '
        + 'and must not put a warning on a coach\u2019s class list');
    if (!await page.locator('#clsBody .stu').count())
      throw new Error('the class list itself did not survive');
    await page.request.get(BASE + '/__drop?reset=1');
  });

  await step('but a syllabus module that raises says so, and attendance still works', async () => {
    await page.request.get(BASE + '/__break?fn=my_roster_grading');
    try {
    await openClasses();
    const warn = page.locator('#clsBody .note.warn');
    if (await warn.count() !== 1)
      throw new Error('the badges failed and the class list said nothing — '
        + 'this is the whole fault, repeated');
    const t = await warn.innerText();
    if (!/badges/i.test(t))
      throw new Error('it does not say what is not working: ' + JSON.stringify(t));
    if (!/session_date/.test(t))
      throw new Error('it does not pass on the database\u2019s own words, which are '
        + 'the only thing that makes this findable: ' + JSON.stringify(t));
    // The coach can still do the job they opened the app for.
    if (!await page.locator('#clsBody .stu').count())
      throw new Error('a failed badge took the class list with it');
    if (!await page.locator('#clsBody .mk').count())
      throw new Error('attendance can no longer be marked');
    } finally {
      // Put it back whatever happened above. The first run of this left
      // the RPC broken for every test after it, and ten of them failed
      // for a reason none of them named.
      await page.request.get(BASE + '/__break?reset=1');
    }
    await openClasses();
    if (await page.locator('#clsBody .note.warn').count() !== 0)
      throw new Error('the warning outlived the fault');
  });

  await step('tapping it opens every level, not just the next one', async () => {
    await page.locator('#clsBody .lvlbtn').first().click();
    await page.waitForTimeout(700);
    const n = await page.locator('#gradePad .gms').count();
    if (n !== 3) throw new Error('expected all 3 levels, drew ' + n);
  });

  // A coach hands the certificate over at the poolside. If the sentence
  // about what a level here is NOT lives only in a SQL comment, the
  // person saying it out loud has never read it.
  await step('the pad names the band the swimmer is in', async () => {
    const t = await page.locator('#gradePad').innerText();
    if (!/Swim Starters/.test(t))
      throw new Error('the pad does not name the band: ' + JSON.stringify(t.slice(0, 160)));
    if (!/0 of 2/.test(t))
      throw new Error('the pad counts across the ladder, not within the band: '
        + JSON.stringify(t.slice(0, 160)));
    // And the stage is still there: the band must not cost the one fact
    // the pad was opened to establish.
    if (!/no stage yet/.test(t))
      throw new Error('the band line swallowed the stage: ' + JSON.stringify(t.slice(0, 160)));
  });

  await step('the pad says which syllabus this ladder is', async () => {
    const t = await page.locator('#gradePad .gsyl').innerText();
    if (!/Malaysia Aquatics/.test(t) || !/BADGES/.test(t) || !/v1\.0/.test(t))
      throw new Error('no credit line in the pad: ' + JSON.stringify(t));
    if (await page.locator('#gradePad .gsylnote').count())
      throw new Error('the paragraph is open before anybody asked for it');
    await page.locator('#gradePad .gsyl').click();
    await page.waitForTimeout(250);
    if (!/separate assessment/i.test(await page.locator('#gradePad .gsylnote').innerText()))
      throw new Error('the note does not say a MAS award is separate');
    await page.locator('#gradePad .gsyl').click();
    await page.waitForTimeout(250);
    if (await page.locator('#gradePad .gsylnote').count())
      throw new Error('it will not fold away again');
  });

  await step('a level with a roundel shows it, round, in place of the pill', async () => {
    const lvl = page.locator('#gradePad .gms').first().locator('.gms-lvl');
    if (!(await lvl.evaluate(el => el.classList.contains('has-img'))))
      throw new Error('the level with artwork still draws the L1 pill');
    const bg = await lvl.evaluate(el => getComputedStyle(el).backgroundColor);
    if (!/rgba\(0, 0, 0, 0\)|transparent/.test(bg))
      throw new Error('a transparent roundel sits on a filled pill: ' + bg);
    if (!(await lvl.locator('img').evaluate(el => el.naturalWidth) > 0))
      throw new Error('the roundel did not load — the path is wrong');
    // The one without artwork keeps its pill, so the fallback is alive.
    const plain = page.locator('#gradePad .gms').nth(1).locator('.gms-lvl');
    if (await plain.evaluate(el => el.classList.contains('has-img')))
      throw new Error('a level with no artwork was given the image treatment');
    if ((await plain.innerText()).trim() !== 'B')
      throw new Error('the lettered pill stopped saying which rung it is');
  });

  await step('the pad names each rung the way its badge does', async () => {
    const pills = await page.locator('#gradePad .gms .gms-lvl')
      .evaluateAll(els => els.map(e => (e.getAttribute('title') || e.textContent).trim()));
    if (pills.length !== 3) throw new Error('expected 3 rungs, read ' + pills.length);
    // Rung 1 carries artwork, so its label lives in the title; rungs 2
    // and 3 are lettered pills. Either way the badge's own name wins.
    if (!/Stage A/.test(pills[0])) throw new Error('rung 1 is not Stage A: ' + pills[0]);
    if (pills[1] !== 'B') throw new Error('rung 2 pill is not B: ' + JSON.stringify(pills[1]));
    if (pills[2] !== '1') throw new Error('rung 3 pill is not 1: ' + JSON.stringify(pills[2]));
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
    // The band leads, then the stage, then the count within the band.
    if (!/Swim Starters . Stage A . 1 of 2/.test(t))
      throw new Error('the header does not show band, stage and band count: '
        + JSON.stringify(t.slice(0, 140)));
  });

  await step('a level with no certificate offers no button', async () => {
    // Guppy was completed above and carries no certificate.
    const n = await page.locator('#gradePad .gms').first().locator('.gcert:not(.gaward)').count();
    if (n) throw new Error('it offers a certificate on a level that has none');
  });

  await step('an unearned certificate level offers no button either', async () => {
    const n = await page.locator('#gradePad .gms').nth(1).locator('.gcert:not(.gaward)').count();
    if (n) throw new Error('it offers a certificate before the level is earned');
  });

  await step('earning a certificate level offers it, and tapping records it', async () => {
    let said = '';
    page.once('dialog', d => { said = d.message(); d.accept(); });
    await page.locator('#gradePad .gms').nth(1).locator('.gtask').first().click();
    await page.waitForTimeout(900);
    void said;
    const btn = page.locator('#gradePad .gms').nth(1).locator('.gcert:not(.gaward)');
    if (!(await btn.count())) throw new Error('an earned certificate level offers nothing');
    if (!/waiting/i.test(await btn.innerText()))
      throw new Error('it does not say one is waiting: ' + JSON.stringify(await btn.innerText()));
    await btn.click();
    await page.waitForTimeout(900);
    const after = await page.locator('#gradePad .gms').nth(1).locator('.gcert:not(.gaward)').innerText();
    if (!/given/i.test(after))
      throw new Error('tapping it did not record the hand-over: ' + JSON.stringify(after));
    if (!/Lee Mei Ling/.test(after))
      throw new Error('it does not name who handed it over: ' + JSON.stringify(after));
  });

  // Three stages carry a second, named certificate. They are two
  // separate pieces of paper and the office needs to know which of them
  // actually reached the family, so they are two separate buttons.
  await step('a milestone award is handed over on its own', async () => {
    const row = page.locator('#gradePad .gms').nth(1);
    const cert = row.locator('.gcert:not(.gaward)');
    const award = row.locator('.gcert.gaward');
    if (await award.count() !== 1)
      throw new Error('no award button on the stage that carries one');
    if (await cert.count() !== 1)
      throw new Error('the award button replaced the certificate button');
    if (!/Self Rescue/.test(await award.innerText()))
      throw new Error('the award is not named on its button');
    if (!(await award.locator('img').evaluate(el => el.naturalWidth) > 0))
      throw new Error('the award badge did not load');

    // Whatever the certificate's state is by now, the award must not
    // change it: an earlier step already handed that one over.
    const before = await cert.innerText();
    await award.click();
    await page.waitForTimeout(700);
    const after = page.locator('#gradePad .gms').nth(1);
    if (!/Self Rescue given/.test(await after.locator('.gcert.gaward').innerText()))
      throw new Error('handing the award over was not recorded');
    if (await after.locator('.gcert:not(.gaward)').innerText() !== before)
      throw new Error('handing the award over also changed the stage certificate');
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
