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

  await step('no JS errors', async () => { if (errs.length) throw new Error(errs[0]); });

  console.log(fail ? fail + ' FAILED' : 'all green');
  await b.close();
  process.exit(fail ? 1 : 0);
})();
