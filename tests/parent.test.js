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
    await page.locator('#phone').fill('0123456001');
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
    if (await page.locator('#resendCode').isDisabled())
      throw new Error('a timer from the last attempt is still holding the button down');
  });

  await step("a server cooldown is passed on in the server's own words", async () => {
    // Refused on the FIRST send, which keeps the parent on the number
    // screen -- so the message has to land there, not on the code screen
    // they never reached.
    await page.request.get(BASE + '/__cool?sec=2');
    await page.locator('#phone').fill('0123456001');
    await page.locator('#sendCode').click();
    await page.waitForTimeout(800);
    if (await page.locator('#s-otp').isVisible())
      throw new Error('a refused send still moved them on to type a code that was never sent');
    const said = await page.locator('#loginNote').innerText();
    if (!/2 more seconds/.test(said))
      throw new Error("it did not pass on the server's wait: " + JSON.stringify(said));
    const btn = await page.locator('#sendCode').isDisabled();
    if (btn) throw new Error('the send button was left disabled after a refusal');
  });

  await step('the code gets you back in, which is the whole loop', async () => {
    // The refusal above spent the mock's one cooldown; this send goes.
    await page.locator('#sendCode').click();
    await page.waitForTimeout(800);
    await page.locator('#code').fill('123456');
    await page.locator('#verifyCode').click();
    await page.waitForTimeout(800);
    if (!(await page.locator('#s-app').isVisible()))
      throw new Error('the code was accepted and the app did not open');
    if (!(await page.locator('#whoBtn').isVisible()))
      throw new Error('back in, but with no way out again');
  });

  await step('and the second sign-out clears the number the first one left', async () => {
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

  await step('no JS errors', async () => { if (errs.length) throw new Error(errs[0]); });

  console.log(fail ? fail + ' FAILED' : 'all green');
  await b.close();
  process.exit(fail ? 1 : 0);
})();
