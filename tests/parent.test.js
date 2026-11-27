// ─────────────────────────────────────────────────────────────────────────
// The parent app.
//
//   node tests/parentmock.js &        (or let run.sh do it)
//   node tests/parent.test.js
//
// It had no tests at all until now, which is how its inbox came to label
// a receipt and a reminder identically for a day: the app could only be
// opened by somebody holding a phone that is on an account, waiting for
// a WhatsApp code.
// ─────────────────────────────────────────────────────────────────────────
'use strict';

const { launch, offline } = require('./browser');

const BASE = process.env.BASE || 'http://127.0.0.1:8906';

(async () => {
  const b = await launch();
  const page = await (await b.newContext({
    viewport: { width: 412, height: 915 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true
  })).newPage();
  const errs = [];
  let fail = 0;
  page.on('pageerror', e => errs.push('PAGEERROR: ' + e.message));
  await offline(page);

  const step = async (n, f) => {
    try { await f(); console.log('PASS  ' + n); }
    catch (e) { console.log('FAIL  ' + n + ' -> ' + String(e.message).split('\n')[0]); fail++; }
  };
  const tab = async (name) => {
    await page.locator('#tabs button', { hasText: name }).first().click();
    await page.waitForTimeout(500);
  };

  await page.goto(BASE + '/parent/', { waitUntil: 'networkidle' });
  await page.waitForTimeout(900);

  await step('the app opens on Home', async () => {
    if (await page.locator('#v-home').isHidden()) throw new Error('Home is not showing');
  });

  // ── Progress ───────────────────────────────────────────────────────
  await step('Progress collates every swimmer, not one at a time', async () => {
    await tab('Progress');
    const t = await page.locator('#progBody').textContent();
    if (!/Kobe/.test(t) || !/Mira/.test(t))
      throw new Error('only one swimmer is listed: ' + t.slice(0, 120));
    const cards = await page.locator('#progBody .pnote').count();
    if (cards !== 4) throw new Error('expected 4 notes, got ' + cards);
  });

  await step('newest first, grouped by month', async () => {
    const months = await page.locator('#progBody .progmonth').allTextContents();
    if (months.length < 2) throw new Error('not grouped: ' + JSON.stringify(months));
    if (!/November/i.test(months[0])) throw new Error('oldest month is first: ' + months[0]);
  });

  await step('a note names the coach who wrote it and the date', async () => {
    const by = await page.locator('#progBody .by').first().textContent();
    if (!/Coach/.test(by)) throw new Error('no coach named: ' + by);
    if (!/\d{4}/.test(by)) throw new Error('no year, so a note read later cannot be placed: ' + by);
  });

  // A coach covering somebody else's class writes under their own name,
  // and the parent has to be able to see that it was not their usual
  // coach — that is the whole reason the author is on the card.
  await step('a replacement coach appears under their own name', async () => {
    const t = await page.locator('#progBody').textContent();
    if (!/Coach Yong/.test(t) || !/Coach Sally/.test(t))
      throw new Error('both coaches are not represented');
  });

  await step('the filter narrows to one swimmer', async () => {
    await page.locator('#progFilter button', { hasText: 'Mira' }).click();
    await page.waitForTimeout(300);
    const t = await page.locator('#progBody').textContent();
    if (/Kobe/.test(t)) throw new Error("filtered to Mira and Kobe's notes are still shown");
    const cards = await page.locator('#progBody .pnote').count();
    if (cards !== 2) throw new Error('expected 2 of Mira\'s notes, got ' + cards);
  });

  // Inside one child's list the name on every card is noise.
  await step('and drops the name once there is only one swimmer in view', async () => {
    const who = await page.locator('#progBody .who').count();
    if (who !== 0) throw new Error('still naming the child on every card');
    await page.locator('#progFilter button', { hasText: 'Everyone' }).click();
    await page.waitForTimeout(300);
  });

  // The geometry assertion, which is the one that catches what reading
  // the markup does not: the remark must dominate, and the date must
  // recede. Twenty-two assertions once passed on a page whose question
  // text was nought pixels wide.
  await step('the remark leads and the date recedes', async () => {
    const m = await page.evaluate(() => {
      const card = document.querySelector('#progBody .pnote');
      const body = card.querySelector('.lead');
      const by = card.querySelector('.by');
      const px = el => parseFloat(getComputedStyle(el).fontSize);
      return { body: px(body), by: px(by), wide: body.getBoundingClientRect().width };
    });
    if (m.by >= m.body)
      throw new Error(`the date is ${m.by}px against a ${m.body}px remark — it does not recede`);
    if (m.body - m.by < 2)
      throw new Error('barely any hierarchy: ' + m.body + 'px vs ' + m.by + 'px');
    if (m.wide < 200) throw new Error('the remark is ' + Math.round(m.wide) + 'px wide on a phone');
  });

  await step('six tabs still fit across a phone', async () => {
    const bad = await page.evaluate(() => {
      const out = [];
      document.querySelectorAll('#tabs button').forEach(b => {
        const r = b.getBoundingClientRect();
        if (r.width < 40) out.push(b.textContent.trim() + ' is ' + Math.round(r.width) + 'px');
        if (b.scrollWidth > r.width + 1) out.push(b.textContent.trim() + ' is clipped');
      });
      return out;
    });
    if (bad.length) throw new Error(bad.join('; '));
  });

  // ── Disputing an absence ───────────────────────────────────────────
  // The notice used to be a statement with no reply to it. These check the
  // whole round trip rather than that a button exists: the mock honours
  // p_id and changes what my_messages returns next, so an app that sends
  // the wrong argument name — the failure that has twice reached
  // production here — leaves the message unflagged and fails below.
  await step('only an absence notice can be disputed', async () => {
    await tab('Inbox');
    const n = await page.evaluate(() => ({
      cards:  document.querySelectorAll('#msgBody .msg').length,
      flags:  document.querySelectorAll('#msgBody [data-flag]').length
    }));
    if (n.cards < 4) throw new Error('expected four messages, saw ' + n.cards);
    if (n.flags !== 1)
      throw new Error('expected exactly one message to offer a dispute, saw ' + n.flags);
  });

  await step('the button sits on the absence message and nowhere else', async () => {
    const kind = await page.evaluate(() => {
      const b = document.querySelector('#msgBody [data-flag]');
      return b ? b.closest('.msg').querySelector('.sub').textContent : '';
    });
    if (!/Attendance/.test(kind))
      throw new Error('the dispute button is on a "' + kind.trim() + '" message');
  });

  await step('tapping it records the dispute against that message', async () => {
    await page.click('#msgBody [data-flag]');
    await page.waitForTimeout(700);
    const after = await page.evaluate(() => ({
      flagged: document.querySelectorAll('#msgBody .msgflag.flagged').length,
      offer:   document.querySelectorAll('#msgBody [data-flag]').length,
      undo:    document.querySelectorAll('#msgBody [data-unflag]').length,
      text:    (document.querySelector('#msgBody .msgflag.flagged') || {}).textContent || ''
    }));
    if (after.flagged !== 1) throw new Error('the message does not show as disputed');
    if (after.offer !== 0)   throw new Error('it still offers to dispute an already-disputed message');
    if (after.undo !== 1)    throw new Error('no way to undo it');
    if (!/will check/.test(after.text))
      throw new Error('the parent is not told anything happened: ' + after.text.trim());
  });

  await step('disputing does not mark the message read (sabotage)', async () => {
    // The flag button sits inside the card, and the card marks itself read
    // on click. Without stopPropagation one tap would do both, and the
    // centre would lose the "not opened" signal on the very messages that
    // matter most.
    const stillUnread = await page.evaluate(() =>
      !!document.querySelector('#msgBody .msg.unread [data-unflag]'));
    if (!stillUnread)
      throw new Error('the dispute tap also marked it read — stopPropagation is missing');
  });

  await step('undo clears it again', async () => {
    await page.click('#msgBody [data-unflag]');
    await page.waitForTimeout(700);
    const n = await page.evaluate(() => ({
      flagged: document.querySelectorAll('#msgBody .msgflag.flagged').length,
      offer:   document.querySelectorAll('#msgBody [data-flag]').length
    }));
    if (n.flagged !== 0) throw new Error('still showing as disputed');
    if (n.offer !== 1)   throw new Error('the dispute button did not come back');
  });

  // ── Getting out ───────────────────────────────────────────────────────
  // The app had no sign-out at all. signOut() existed and nothing called
  // it, so a parent who wanted off a shared phone had to clear site data,
  // and anyone wanting to sign in as somebody else could not. Found by
  // the person testing it, not by anything here.
  await step('the signed-in family is a button, not just a label', async () => {
    const b = page.locator('#whoBtn');
    if (!(await b.count())) throw new Error('there is nothing to tap in the header');
    if (!(await b.isVisible())) throw new Error('the account button is not visible');
    if (!(await page.locator('#whoMenu').isHidden()))
      throw new Error('the menu is open before anybody opened it');
  });

  await step('it opens on the number signed in, which settles whose app it is', async () => {
    await page.locator('#whoBtn').click();
    await page.waitForTimeout(250);
    if (await page.locator('#whoMenu').isHidden()) throw new Error('the menu did not open');
    const t = await page.locator('#whoPhone').innerText();
    if (!/\d{6,}/.test(t)) throw new Error('it does not show the number: ' + JSON.stringify(t));
  });

  await step('tapping elsewhere shuts it', async () => {
    // Low on the screen, clear of the header and the menu under it.
    await page.mouse.click(60, 600);
    await page.waitForTimeout(250);
    if (!(await page.locator('#whoMenu').isHidden()))
      throw new Error('a menu that only closes by its own button is closed by reloading');
  });

  // One handler for the rest of the suite. Registering a fresh `once` per
  // step leaves the unfired one from a failed step behind, and the next
  // dialog is then answered twice.
  let answer = 'dismiss';
  let asked = '';
  page.on('dialog', d => {
    asked = d.message();
    if (answer === 'accept') d.accept(); else d.dismiss();
  });

  await step('signing out asks first, and a refusal keeps you in', async () => {
    await page.locator('#whoBtn').click();
    await page.waitForTimeout(200);
    answer = 'dismiss'; asked = '';
    await page.locator('#signOutBtn').click();
    await page.waitForTimeout(400);
    if (!asked) throw new Error('it signed out without asking');
    if (!/text message|sms|code/i.test(asked))
      throw new Error('it did not say getting back in costs a code: ' + JSON.stringify(asked));
    if (!(await page.locator('#s-app').isVisible()))
      throw new Error('saying no signed the parent out anyway');
  });

  await step('accepting signs out, and the typed number is not left behind', async () => {
    await page.locator('#whoBtn').click();
    await page.waitForTimeout(200);
    answer = 'accept';
    await page.locator('#signOutBtn').click();
    await page.waitForTimeout(500);
    if (!(await page.locator('#s-login').isVisible()))
      throw new Error('it did not return to the sign-in screen');
    const v = await page.locator('#phone').inputValue();
    if (v) throw new Error('the last number is still in the box for the next person: ' + v);
    const held = await page.evaluate(() => {
      try { return localStorage.getItem('ssb.parent.session'); } catch (e) { return 'unreadable'; }
    });
    if (held) throw new Error('the session is still on the device after signing out');
  });

  await step('and signing back in is the same code-by-text it always was', async () => {
    await page.locator('#toCode').click();
    await page.waitForTimeout(300);
    // The button used to sit below the password field and silently use
    // the number box two fields above it. Nothing on screen said so, and
    // it read as the start of a flow that would ask for a number.
    if (!(await page.locator('#s-askcode').isVisible()))
      throw new Error('asking for a code never showed a screen of its own');
    if (!(await page.locator('#askPhone').isVisible()))
      throw new Error('there is no number box on the screen that sends the code');
    await page.locator('#askPhone').fill('0123456001');
    await page.locator('#sendCode').click();
    await page.waitForTimeout(600);
    if (!(await page.locator('#s-otp').isVisible()))
      throw new Error('it did not ask for a code after signing out');
    const to = await page.locator('#otpSentTo').innerText();
    if (!/text|sms/i.test(to))
      throw new Error('it does not say the code comes by text: ' + JSON.stringify(to));
  });

  // ── Send it again, but not four times in ten seconds ──────────────────
  // Every tap is a message Twilio charges for, and a parent who does not
  // see the SMS in ten seconds taps it again. That, rather than anything
  // deliberate, is the ordinary way the bill grows.
  await step('the resend button is held, and says for how long', async () => {
    const btn = page.locator('#resendCode');
    if (!(await btn.isDisabled()))
      throw new Error('it can be tapped the instant the first code is sent');
    const t = await btn.innerText();
    if (!/\d+\s*s/.test(t))
      throw new Error('a dead button reads as broken, and broken is what people tap harder: '
                      + JSON.stringify(t));
  });

  await step('and the countdown actually counts', async () => {
    const read = async () => {
      const m = (await page.locator('#resendCode').innerText()).match(/(\d+)\s*s/);
      return m ? Number(m[1]) : null;
    };
    const first = await read();
    if (first === null) throw new Error('no number on the button');
    await page.waitForTimeout(1100);
    const later = await read();
    // Gone entirely is fine -- a two-second hold can finish inside the
    // wait. Still showing the same number is not.
    if (later !== null && later >= first) throw new Error('it is frozen at ' + first);
  });

  await step("the hold is the server's length, not a number in the app", async () => {
    // The mock says two seconds. Sixty is the app's fallback, and if the
    // button is still held after three seconds that fallback is what ran
    // -- which means the office changing the setting would change
    // nothing a parent experiences.
    await page.waitForTimeout(3000);
    if (await page.locator('#resendCode').isDisabled())
      throw new Error('still held after 3s, so it used its own 60 rather than the server\u2019s 2');
    const t = await page.locator('#resendCode').innerText();
    if (/\d+\s*s/.test(t)) throw new Error('it is still counting: ' + JSON.stringify(t));
  });

  await step('and leaving the code screen cancels the hold', async () => {
    await page.locator('#resendCode').click();     // starts another hold
    await page.waitForTimeout(400);
    await page.locator('#backToPhone').click();
    await page.waitForTimeout(300);
    if (!(await page.locator('#s-askcode').isVisible()))
      throw new Error('"use a different number" did not land on the screen that asks for one');
    if (await page.locator('#resendCode').isDisabled())
      throw new Error('a timer from the last attempt is still holding the button down');
  });

  await step("a server cooldown is passed on in the server's own words", async () => {
    // Refused on the FIRST send, which keeps the parent on the number
    // screen -- so the message has to land there, not on the code screen
    // they never reached.
    await page.request.get(BASE + '/__cool?sec=2');
    await page.locator('#askPhone').fill('0123456001');
    await page.locator('#sendCode').click();
    await page.waitForTimeout(800);
    if (await page.locator('#s-otp').isVisible())
      throw new Error('a refused send still moved them on to type a code that was never sent');
    const said = await page.locator('#askNote').innerText();
    if (!/2 more seconds/.test(said))
      throw new Error("it did not pass on the server's wait: " + JSON.stringify(said));
    const btn = await page.locator('#sendCode').isDisabled();
    if (btn) throw new Error('the send button was left disabled after a refusal');
  });

  // ── A code lands on the password screen, not in the app ───────────────
  // Every OTP sign-in is either a first time or a forgotten password, so
  // every one of them ends by choosing a password. That is what stops
  // the next sign-in costing a message.
  await step('a code lets you in only as far as choosing a password', async () => {
    // The refusal above spent the mock's one cooldown; this send goes.
    await page.locator('#sendCode').click();
    await page.waitForTimeout(900);
    await page.locator('#code').fill('123456');
    await page.locator('#verifyCode').click();
    await page.waitForTimeout(800);
    if (await page.locator('#s-app').isVisible())
      throw new Error('it went straight into the app, so nobody ever sets a password');
    if (!(await page.locator('#s-setpw').isVisible()))
      throw new Error('the password screen did not open');
  });

  await step('there is no way past it without choosing one', async () => {
    const skips = await page.locator('#s-setpw button').allInnerTexts();
    if (skips.some(t => /skip|later|not now/i.test(t)))
      throw new Error('it offers a way out, which is how most families never set one: '
                      + JSON.stringify(skips));
  });

  await step('a short one is refused before it reaches the server', async () => {
    await page.locator('#newpw').fill('swim');
    await page.locator('#savePw').click();
    await page.waitForTimeout(400);
    const said = await page.locator('#setpwNote').innerText();
    if (!/8 characters/i.test(said)) throw new Error('it did not say the length: ' + said);
    if (await page.locator('#s-app').isVisible()) throw new Error('a four-letter password got in');
  });

  await step('and a real one saves and opens the app', async () => {
    await page.locator('#newpw').fill('swimtime2026');
    await page.locator('#savePw').click();
    await page.waitForTimeout(900);
    if (!(await page.locator('#s-app').isVisible()))
      throw new Error('it saved the password and never opened the app');
  });

  // ── Signing in with it, which costs nothing ───────────────────────────
  await step('the password signs you in with no message sent', async () => {
    const before = await (await page.request.get(BASE + '/__calls')).json().catch(() => ({}));
    void before;
    await page.locator('#whoBtn').click();
    await page.waitForTimeout(200);
    answer = 'accept';
    await page.locator('#signOutBtn').click();
    await page.waitForTimeout(500);
    await page.locator('#phone').fill('0123456001');
    await page.locator('#pw').fill('swimtime2026');
    await page.locator('#signIn').click();
    await page.waitForTimeout(900);
    if (!(await page.locator('#s-app').isVisible()))
      throw new Error('the right password did not get in');
    if (await page.locator('#s-otp').isVisible())
      throw new Error('it asked for a code as well, which is the cost we are removing');
  });

  await step('a wrong one is refused without saying whether the number is ours', async () => {
    await page.locator('#whoBtn').click();
    await page.waitForTimeout(200);
    answer = 'accept';
    await page.locator('#signOutBtn').click();
    await page.waitForTimeout(500);
    await page.locator('#phone').fill('0123456001');
    await page.locator('#pw').fill('not-the-password');
    await page.locator('#signIn').click();
    await page.waitForTimeout(900);
    if (await page.locator('#s-app').isVisible()) throw new Error('a wrong password got in');
    const said = await page.locator('#loginNote').innerText();
    if (/no account|not on file|unknown|no such/i.test(said))
      throw new Error('the refusal tells you the number is not one of ours: ' + said);
    if (!/do not match/i.test(said)) throw new Error('it did not say what was wrong: ' + said);
  });

  await step('too many tries pushes that number back to a code', async () => {
    await page.request.get(BASE + '/__login?mustUseCode=1');
    await page.locator('#pw').fill('still-wrong');
    await page.locator('#signIn').click();
    await page.waitForTimeout(900);
    const said = await page.locator('#loginNote').innerText();
    if (!/code/i.test(said))
      throw new Error('it did not point at the code, so the parent is stranded: ' + said);
    if (await page.locator('#pw').inputValue())
      throw new Error('the password it just refused is still sitting in the box');
    await page.request.get(BASE + '/__login?reset=1');
  });

  await step('a database without the login function says so, not "wrong password"', async () => {
    await page.request.get(BASE + '/__login?off=1');
    await page.locator('#phone').fill('0123456001');
    await page.locator('#pw').fill('swimtime2026');
    await page.locator('#signIn').click();
    await page.waitForTimeout(900);
    const said = await page.locator('#loginNote').innerText();
    if (/do not match/i.test(said))
      throw new Error('a missing function reads as the parent getting it wrong: ' + said);
    if (!/code/i.test(said)) throw new Error('it did not point at the code path: ' + said);
    await page.request.get(BASE + '/__login?reset=1');
  });


  await step('and the second sign-out clears the number the first one left', async () => {
    await page.locator('#phone').fill('0123456001');
    await page.locator('#pw').fill('swimtime2026');
    await page.locator('#signIn').click();
    await page.waitForTimeout(900);
    // This is the assertion the first sign-out could not make: nothing
    // had been typed into the box yet, so an empty box proved nothing.
    // Now a number has been through it.
    const before = await page.evaluate(() => document.getElementById('phone').value);
    if (!before) throw new Error('the box was already empty, so this proves nothing again');
    await page.locator('#whoBtn').click();
    await page.waitForTimeout(200);
    answer = 'accept';
    await page.locator('#signOutBtn').click();
    await page.waitForTimeout(500);
    const after = await page.locator('#phone').inputValue();
    if (after) throw new Error('the last person\u2019s number is waiting for the next: ' + after);
  });

  // ── The collection ────────────────────────────────────────────────────
  // A badge beside the child's name, and the ladder on their page. The
  // bar under each level is that level's own tasks-done over tasks-total
  // -- five of ten is half, not "in progress".
  await step('back in, so there is an app to look at', async () => {
    // The step before this one signed out. Without this the tabs do not
    // exist and every assertion below fails on a timeout rather than on
    // what it is about.
    if (!(await page.locator('#s-app').isVisible())) {
      await page.locator('#phone').fill('0123456001');
      await page.locator('#pw').fill('swimtime2026');
      await page.locator('#signIn').click();
      await page.waitForTimeout(1200);
    }
    if (!(await page.locator('#s-app').isVisible()))
      throw new Error('could not get back into the app');
  });

  await step('a badge sits beside a graded child on the first screen', async () => {
    await page.locator('#tabs button[data-v="home"]').click();
    await page.waitForTimeout(1200);
    const chips = await page.locator('#homeKids .lvlchip').count();
    if (chips === 0) throw new Error('no level shown beside any child');
    if (chips !== 1)
      throw new Error('a child on an ungraded lesson type was given one too: ' + chips);
    const t = await page.locator('#homeKids .lvlchip').first().innerText();
    // The badge's own name for that rung. This ladder letters its first
    // stage A, so "Level 1" would contradict the sticker.
    if (!/Stage A/i.test(t)) throw new Error('the chip does not name the stage: ' + JSON.stringify(t));
    // Within the BAND. "1/3" would be the old behaviour, and for a
    // toddler on an eight-stage ladder that number is the problem.
    if (!/1\/2/.test(t)) throw new Error('the chip does not count within the band: ' + JSON.stringify(t));
    if (/Swim Passport/.test(t))
      throw new Error('the chip names the programme over the band: ' + JSON.stringify(t));
  });

  await step('opening the child draws every level, earned and not', async () => {
    await page.locator('#homeKids [data-kid]').first().click();
    await page.waitForTimeout(1000);
    const n = await page.locator('#childGrading .msrow').count();
    if (n !== 3) throw new Error('expected 3 levels, drew ' + n);
    const t = await page.locator('#childGrading').innerText();
    if (!/Guppy/.test(t) || !/Crab/.test(t))
      throw new Error('it only lists what is finished: ' + JSON.stringify(t.slice(0, 200)));
  });

  await step('the bubble reads 5/10, not a percentage', async () => {
    const t = await page.locator('#childGrading .msrow').nth(1).innerText();
    if (!/5\/10/.test(t)) throw new Error('the count is not 5/10: ' + JSON.stringify(t));
    if (/%/.test(t)) throw new Error('it shows a percentage: ' + JSON.stringify(t));
  });

  await step('and the bar is filled to match, measured not described', async () => {
    const row = page.locator('#childGrading .msrow').nth(1);
    const fill = await row.locator('.msbar i').evaluate(el => el.getBoundingClientRect().width);
    const track = await row.locator('.msbar').evaluate(el => el.getBoundingClientRect().width);
    if (Math.abs(fill - track / 2) > track * 0.08)
      throw new Error('5 of 10 did not draw as half: ' + Math.round(fill) + ' of ' + Math.round(track));
    // An earned level is full; an untouched one is empty.
    const full = await page.locator('#childGrading .msrow').nth(0).locator('.msbar i')
      .evaluate(el => el.getBoundingClientRect().width);
    const empty = await page.locator('#childGrading .msrow').nth(2).locator('.msbar i')
      .evaluate(el => el.getBoundingClientRect().width);
    if (full < track * 0.9) throw new Error('an earned level is not full: ' + Math.round(full));
    if (empty > 1) throw new Error('an untouched level is not empty: ' + Math.round(empty));
  });

  await step('tapping a level shows what is done, then what is next', async () => {
    await page.locator('#childGrading .msrow').nth(1).locator('.msrow-head').click();
    await page.waitForTimeout(400);
    const classes = await page.locator('#childGrading .msrow').nth(1)
      .locator('.mstask').evaluateAll(els => els.map(e => e.className));
    if (classes.length !== 10) throw new Error('expected 10 tasks, drew ' + classes.length);
    const firstTodo = classes.findIndex(c => /todo/.test(c));
    const lastDone = classes.map(c => /done/.test(c)).lastIndexOf(true);
    if (firstTodo === -1 || lastDone === -1) throw new Error('no mix of done and not done');
    if (lastDone > firstTodo)
      throw new Error('finished tasks are not all above the unfinished ones');
  });

  await step('a level with a certificate waiting says so', async () => {
    await page.locator('#childGrading .msrow').nth(0).locator('.msrow-head').click();
    await page.waitForTimeout(400);
    const t = await page.locator('#childGrading .msrow').nth(0).innerText();
    // Guppy carries no certificate, so it must NOT offer one.
    if (/certificate/i.test(t))
      throw new Error('a level with no certificate offers one: ' + JSON.stringify(t));
  });

  // ── The syllabus behind the ladder ────────────────────────────────────
  // Levels named Starfish and Dolphin are Malaysia Aquatics', not ours.
  // The credit has to be on the screen, and the sentence about what a
  // level here does NOT mean has to be reachable from it -- otherwise it
  // lives in a SQL comment nobody reads and a parent is told, by
  // omission, that MAS certified their child.
  await step('the programme credits the syllabus it follows', async () => {
    const t = await page.locator('#childGrading .syl').first().innerText();
    if (!/Malaysia Aquatics/.test(t) || !/BADGES/.test(t) || !/v1\.0/.test(t))
      throw new Error('the credit line does not name body, syllabus and edition: '
        + JSON.stringify(t));
    // Quiet: it must not be louder than the child's own level.
    const sz = await page.locator('#childGrading .syl').first()
      .evaluate(el => parseFloat(getComputedStyle(el).fontSize));
    const hd = await page.locator('#childGrading .h').first()
      .evaluate(el => parseFloat(getComputedStyle(el).fontSize));
    if (!(sz < hd)) throw new Error('the credit is set as large as the heading: '
      + sz + ' vs ' + hd);
  });

  await step('and one tap opens what a level here does not mean', async () => {
    if (await page.locator('#childGrading .sylnote').count())
      throw new Error('the paragraph is open before anybody asked for it');
    await page.locator('#childGrading .syl').first().click();
    await page.waitForTimeout(300);
    const t = await page.locator('#childGrading .sylnote').innerText();
    if (!/separate assessment/i.test(t))
      throw new Error('the note does not say a MAS award is separate: ' + JSON.stringify(t));
    const href = await page.locator('#childGrading .sylnote a').getAttribute('href');
    if (href !== 'https://example.org/badges')
      throw new Error('the link is not the one stored: ' + JSON.stringify(href));
    await page.locator('#childGrading .syl').first().click();
    await page.waitForTimeout(300);
    if (await page.locator('#childGrading .sylnote').count())
      throw new Error('it will not fold away again');
  });

  await step('the roundel is round — no grey tile behind it', async () => {
    const badge = page.locator('#childGrading .msrow').nth(0).locator('.msrow-badge');
    if (!(await badge.evaluate(el => el.classList.contains('has-img'))))
      throw new Error('a level with artwork still draws the lettered tile');
    const bg = await badge.evaluate(el => getComputedStyle(el).backgroundColor);
    if (!/rgba\(0, 0, 0, 0\)|transparent/.test(bg))
      throw new Error('a transparent roundel sits on a filled square: ' + bg);
    // And the file is really there. A path typed wrong in the migration
    // is a broken image in three apps and a confirm block that still
    // says "installed".
    const w = await badge.locator('img').evaluate(el => el.naturalWidth);
    if (!(w > 0)) throw new Error('the roundel did not load — the path is wrong');
    // A level with no artwork keeps the glyph, so the fallback is not
    // quietly dead code.
    const plain = page.locator('#childGrading .msrow').nth(1).locator('.msrow-badge');
    if (await plain.evaluate(el => el.classList.contains('has-img')))
      throw new Error('a level with no artwork was given the transparent treatment');
  });

  await step('each level is drawn in its own colour', async () => {
    const fill = (i) => page.locator('#childGrading .msrow').nth(i).locator('.msbar i')
      .evaluate(el => getComputedStyle(el).backgroundColor);
    const one = await fill(0), two = await fill(1);
    if (one === two)
      throw new Error('two levels with different colours drew the same bar: ' + one);
    if (!/240, 113, 60/.test(one))
      throw new Error('level 1 is not drawn in its own #F0713C: ' + one);
    // Level 3 has no colour of its own and inherits the programme's.
    const three = await fill(2);
    if (!/10, 67, 94/.test(three))
      throw new Error('a level with no colour did not inherit the programme’s: ' + three);
  });

  // The printed chart groups the ladder into bands, and the count a
  // parent reads is the band's. A two-year-old on Swim Starters is
  // "1 of 2" — telling them "1 of 8" is telling them their toddler has
  // six levels to climb, which is not what they bought.
  await step('the ladder is grouped into its printed bands', async () => {
    const heads = await page.locator('#childGrading .bandh')
      .evaluateAll(els => els.map(e => e.innerText.replace(/\s+/g, ' ').trim()));
    if (heads.length !== 2)
      throw new Error('expected 2 band headings, drew ' + heads.length
        + ': ' + JSON.stringify(heads));
    if (!/^Swim Starters 1\/2$/i.test(heads[0]))
      throw new Error('the first band does not read 1/2: ' + JSON.stringify(heads[0]));
    if (!/^Swim Basics 0\/1$/i.test(heads[1]))
      throw new Error('the second band is wrong: ' + JSON.stringify(heads[1]));
    // The band being climbed is marked out from the ones that follow.
    const here = await page.locator('#childGrading .bandh.is-here').count();
    if (here !== 1)
      throw new Error('expected exactly one band marked as current, found ' + here);
    // A heading must sit above the rungs it covers, not after them.
    const yHead = await page.locator('#childGrading .bandh').nth(1)
      .evaluate(el => el.getBoundingClientRect().top);
    const yRow = await page.locator('#childGrading .msrow').nth(2)
      .evaluate(el => el.getBoundingClientRect().top);
    if (!(yHead < yRow)) throw new Error('a band heading is drawn below its own rungs');
  });

  // The Swim Passport prints its stages A, B, 1 … 6, so the third rung
  // is stage 1. A child holding a sticker that says "Learn to Swim 1"
  // must not be told by the app that she is on level 3.
  await step('a level says what its badge says, not what number rung it is', async () => {
    const rows = await page.locator('#childGrading .msrow .msrow-nm span')
      .evaluateAll(els => els.map(e => e.textContent.trim()));
    if (rows.length !== 3) throw new Error('expected 3 levels, read ' + rows.length);
    if (!/^Stage A/.test(rows[0]) || !/^Stage B/.test(rows[1]) || !/^Stage 1/.test(rows[2]))
      throw new Error('the rungs are printed by number, not by badge: '
        + JSON.stringify(rows));
    if (rows.some(r => /Level/.test(r)))
      throw new Error('a labelled level still says "Level": ' + JSON.stringify(rows));
    // And the chip above them agrees.
    const chip = await page.locator('#childGrading .lvlchip').first().innerText();
    if (!/Stage A/i.test(chip))
      throw new Error('the heading chip disagrees with the rows: ' + JSON.stringify(chip));
  });

  // A four-year-old moves from Swim Starters to the Passport mid-year.
  // The ladder on screen is the one their lesson type points at, so
  // without this their first two badges simply disappear from their
  // parent's phone — and a parent reads that as "we lost them".
  await step('badges from an earlier ladder are still shown', async () => {
    const row = page.locator('#childGrading .earlier');
    if (!(await row.count())) throw new Error('nothing shows what was earned earlier');
    const t = await row.innerText();
    if (!/Water Discovery/.test(t) || !/Water Explorer/.test(t))
      throw new Error('the earlier badges are not named: ' + JSON.stringify(t));
    if (!/Swim Starters/.test(t))
      throw new Error('it does not say which ladder they came from: ' + JSON.stringify(t));
    const w = await row.locator('.earlier-b img').first().evaluate(el => el.naturalWidth);
    if (!(w > 0)) throw new Error('an earlier badge image did not load');
    // Below the current ladder, not above it: the rung she is on now is
    // what she came to see.
    const yEarlier = await row.evaluate(el => el.getBoundingClientRect().top);
    const yLast = await page.locator('#childGrading .msrow').last()
      .evaluate(el => el.getBoundingClientRect().top);
    if (!(yEarlier > yLast))
      throw new Error('history is drawn above the ladder it precedes');
    // And it must not inflate the count: 1/3 is the current ladder.
    const chip = await page.locator('#childGrading .lvlchip').first().innerText();
    if (!/1\/2/.test(chip))
      throw new Error('earlier badges were counted into the current band: ' + chip);
  });

  await step('an ungraded child shows no collection at all', async () => {
    await page.locator('#childBack').click();
    await page.waitForTimeout(600);
    const cards = page.locator('#homeKids [data-kid]');
    if (await cards.count() < 2) throw new Error('the fixture has only one child');
    await cards.nth(1).click();
    await page.waitForTimeout(900);
    const t = await page.locator('#childGrading').innerText();
    if (t.trim()) throw new Error('an ungraded child was given a ladder: ' + JSON.stringify(t));
  });

  // ── Archived while signed in ──────────────────────────────────────────
  // The sign-in gate refuses an archived family a code and a password.
  // Neither of those runs for a session that is already open: it renews
  // itself quietly and keeps working. What the parent saw after their
  // family was archived was their own name at the top and nothing
  // underneath -- which reads as the system having lost them rather than
  // as an account that has been closed.
  await step('signing back in first, so there is a session to archive', async () => {
    if (!(await page.locator('#s-app').isVisible())) {
      await page.locator('#phone').fill('0123456001');
      await page.locator('#pw').fill('swimtime2026');
      await page.locator('#signIn').click();
      await page.waitForTimeout(900);
    }
    if (!(await page.locator('#s-app').isVisible()))
      throw new Error('could not get back into the app to run this');
  });

  await step('archiving the family signs the open session out', async () => {
    await page.request.get(BASE + '/__archive?on=1');
    // What a phone does when it is picked up again.
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await page.waitForTimeout(900);
    if (await page.locator('#s-app').isVisible())
      throw new Error('it kept showing the app to a family that is no longer ours');
    if (!(await page.locator('#s-login').isVisible()))
      throw new Error('it did not return to the sign-in screen');
  });

  await step("and says the server's words, not that anything was lost", async () => {
    const said = await page.locator('#loginNote').innerText();
    if (!/no longer active/i.test(said))
      throw new Error('it does not say the account is closed: ' + JSON.stringify(said));
    if (!/call the centre/i.test(said))
      throw new Error('it does not tell them what to do next: ' + JSON.stringify(said));
    if (/deleted|lost|removed/i.test(said.replace(/nothing has been lost/i, '')))
      throw new Error('it suggests their records are gone, which they are not: ' + JSON.stringify(said));
    await page.request.get(BASE + '/__archive?on=0');
  });

  await step('no JS errors', async () => { if (errs.length) throw new Error(errs[0]); });

  console.log(fail ? fail + ' FAILED' : 'all green');
  await b.close();
  process.exit(fail ? 1 : 0);
})();
