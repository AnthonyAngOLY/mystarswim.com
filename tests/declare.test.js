// ─────────────────────────────────────────────────────────────────────────
// The health declaration page, driven in a browser.
//
//   node tests/declaremock.js &       (or let run.sh do it)
//   node tests/declare.test.js
//
// 377 active swimmers have no health declaration on file, while the terms
// their parents signed declare on their behalf that there is nothing to
// tell. This is the page that closes that, so "it renders" is not the
// standard it ships on.
// ─────────────────────────────────────────────────────────────────────────
'use strict';

const { launch, offline } = require('./browser');

const BASE = process.env.BASE || 'http://127.0.0.1:8905';

(async () => {
  const b = await launch();
  const page = await (await b.newContext({ viewport: { width: 900, height: 1400 } })).newPage();
  const errs = [];
  let fail = 0;
  page.on('pageerror', e => errs.push('PAGEERROR: ' + e.message));
  await offline(page);

  const step = async (n, f) => {
    try { await f(); console.log('PASS  ' + n); }
    catch (e) { console.log('FAIL  ' + n + ' -> ' + String(e.message).split('\n')[0]); fail++; }
  };

  const reload = async () => {
    await page.request.get(BASE + '/__reset');
    await page.goto(BASE + '/declare.html', { waitUntil: 'networkidle' });
    await page.waitForSelector('.card', { timeout: 10000 });
  };
  const field = (label) => page.locator('.field', { hasText: label }).locator('input,textarea').first();
  const lookUp = async (no, phone) => {
    await field('Account number').fill(no);
    await field('Phone number').fill(phone);
    await page.locator('button:has-text("Find my family")').click();
    await page.waitForTimeout(600);
  };
  // Answer every question for one child's card.
  const answerAll = async (name, which) => {
    const card = page.locator('.card', { has: page.locator('.section-title', { hasText: new RegExp('^' + name + '$') }) });
    for (const q of await card.locator('.health-q').all()) {
      await q.locator(`button:has-text("${which}")`).click();
    }
    return card;
  };

  await reload();

  await step('the shared stylesheet is loaded, not just referenced', async () => {
    const bg = await page.evaluate(() => {
      const el = document.createElement('button');
      el.className = 'submit-btn'; el.style.display = 'none';
      document.body.appendChild(el);
      const c = getComputedStyle(el).backgroundColor; el.remove(); return c;
    });
    if (!/109,\s*91,\s*208/.test(bg)) throw new Error('public.css did not load: ' + bg);
  });

  await step('it asks for the account number and a phone, and nothing else', async () => {
    const t = await page.locator('.page').textContent();
    if (!/account number/i.test(t)) throw new Error('no account number field');
    if (/date of birth/i.test(t)) throw new Error('this is not an enrolment form');
    if (await page.locator('.health-q').count()) throw new Error('questions shown before the family is known');
  });

  await step('a wrong pair is refused in one sentence', async () => {
    await lookUp('ZZZZ-0000', '0100000000');
    const t = await page.locator('.err-banner').textContent();
    if (!/do not go together/.test(t)) throw new Error('unexpected: ' + t);
    if (await page.locator('.child-pick').count()) throw new Error('it showed children anyway');
  });

  await step('an account with no swimmers says so, rather than showing nothing', async () => {
    await reload();
    await lookUp('NEW-0001', '0111111111');
    const t = await page.locator('.err-banner').textContent();
    if (!/no swimmers/i.test(t)) throw new Error('unexpected: ' + t);
  });

  await step('the right pair names the family and lists the children', async () => {
    await reload();
    await lookUp('LEE-2394', '0123456001');
    const t = await page.locator('.found-note').textContent();
    if (!/Lee Oy Yin/.test(t)) throw new Error('family not named: ' + t);
    const names = await page.locator('.child-pick-name').allTextContents();
    if (names.join(',') !== 'Aaryan,Mira') throw new Error('children: ' + names.join(','));
  });

  await step('every child gets their own six questions', async () => {
    const n = await page.locator('.health-q').count();
    if (n !== 12) throw new Error('expected 12 questions for two children, got ' + n);
  });

  await step('unticking a child takes their questions away', async () => {
    await page.locator('.child-pick', { hasText: 'Mira' }).locator('input').uncheck();
    await page.waitForTimeout(250);
    const n = await page.locator('.health-q').count();
    if (n !== 6) throw new Error('expected 6, got ' + n);
    await page.locator('.child-pick', { hasText: 'Mira' }).locator('input').check();
    await page.waitForTimeout(250);
  });


  // Geometry, not text. Every assertion in this file passed while the
  // question text was nought pixels wide and the Yes/No toggle had the
  // whole row — .gender-toggle is width:100% and sits on the same
  // element as .health-yn, so flex-basis:auto resolved to the full row
  // and .health-q-text, min-width:0, collapsed to nothing. The six
  // questions rendered as columns of single letters on a live form and
  // nothing here noticed, because the words were all present.
  await step('the health questions are readable, not a column of letters', async () => {
    const m = await page.evaluate(() => {
      const q = document.querySelector('.health-q');
      if (!q) return null;
      const t = q.querySelector('.health-q-text').getBoundingClientRect();
      const y = q.querySelector('.health-yn').getBoundingClientRect();
      return { row: q.getBoundingClientRect().width, text: t.width, yn: y.width, lines: t.height };
    });
    if (!m) throw new Error('no health question on screen');
    if (m.text < m.row * 0.5)
      throw new Error(`the question has ${Math.round(m.text)}px of ${Math.round(m.row)}px`);
    if (m.yn > 200) throw new Error('the Yes/No toggle is ' + Math.round(m.yn) + 'px wide');
    // A question that wraps past six lines at this width is not wrapping,
    // it is stacking one word at a time.
    if (m.lines > 140) throw new Error('the question is ' + Math.round(m.lines) + 'px tall — it is stacking');
  });

  await step('a yes asks what we should know; a no does not', async () => {
    const card = await answerAll('Aaryan', 'No');
    if (await card.locator('.health-details').count()) throw new Error('asked after all-no');
    await card.locator('.health-q').nth(4).locator('button:has-text("Yes")').click();
    await page.waitForTimeout(250);
    if (!(await card.locator('.health-details').count())) throw new Error('not asked after a yes');
  });

  const blocked = async (why) => {
    if (!(await page.locator('.submit-btn:has-text("Submit declaration")').isDisabled()))
      throw new Error('submit was enabled while ' + why);
  };

  // One outstanding item at a time, in the order they appear on the
  // page, so a parent on a phone is given a next action rather than a
  // list. These three steps walk that queue down: each fix should make
  // the message move on, not go quiet.
  await step('a yes with nothing written blocks the signature, and says so', async () => {
    const t = await page.locator('.page').textContent();
    if (!/tell us what we should know about Aaryan/.test(t))
      throw new Error('it did not ask for the detail: ' + t.slice(-240));
    await blocked('a yes had no detail');
  });

  await step('filling that detail moves the message on to the next child', async () => {
    const card = page.locator('.card', { has: page.locator('.section-title', { hasText: /^Aaryan$/ }) });
    await card.locator('.health-details').fill('Mild ADHD; needs instructions one at a time.');
    await page.waitForTimeout(300);
    const t = await page.locator('.page').textContent();
    if (!/answer all six questions for Mira/.test(t))
      throw new Error('it went quiet with Mira unanswered: ' + t.slice(-240));
    await blocked('Mira was unanswered');
  });

  await step('answering the second child leaves only the signature', async () => {
    await answerAll('Mira', 'No');
    await page.waitForTimeout(300);
    const t = await page.locator('.page').textContent();
    if (!/confirm the declaration/.test(t))
      throw new Error('expected it to ask for the tick: ' + t.slice(-240));
    await blocked('nothing was signed');
  });

  await step('ticking and signing releases it', async () => {
    await page.locator('.check-row').click();
    await page.waitForTimeout(200);
    await blocked('no name was typed');
    await field('Type your full name').fill('Lee Oy Yin');
    await page.waitForTimeout(300);
    if (await page.locator('.submit-btn:has-text("Submit declaration")').isDisabled())
      throw new Error('still disabled with everything answered and signed');
  });

  await step('what reaches the server is what was on the screen', async () => {
    await page.locator('.submit-btn:has-text("Submit declaration")').click();
    await page.waitForTimeout(900);
    const sent = await (await page.request.get(BASE + '/__declarations')).json();
    if (sent.length !== 2) throw new Error('got ' + sent.length + ' declarations');
    const a = sent.find(x => x.name === 'Aaryan');
    const m = sent.find(x => x.name === 'Mira');
    if (!a || !m) throw new Error('names: ' + sent.map(x => x.name).join(','));
    if (a.health.learning !== true) throw new Error("Aaryan's yes did not travel");
    if (!/one at a time/.test(a.health.details || '')) throw new Error('the detail did not travel');
    if (m.health.learning !== false) throw new Error("Mira's no did not travel");
    if (m.health.details) throw new Error("Aaryan's detail was attached to Mira");
    if (a.signedBy !== 'Lee Oy Yin') throw new Error('signature: ' + a.signedBy);
    if (a.reference !== m.reference) throw new Error('one signing produced two references');
  });

  await step('it never sends an account id, only the pair it was given', async () => {
    const sent = await (await page.request.get(BASE + '/__declarations')).json();
    const s = JSON.stringify(sent);
    if (/account_?[Ii]d/.test(s)) throw new Error('an account id travelled');
  });

  await step('the parent is told it worked, and given a reference', async () => {
    const t = await page.locator('.done-card').textContent();
    if (!/Thank you/.test(t)) throw new Error('no confirmation: ' + t.slice(0, 160));
    if (!/Aaryan/.test(t) || !/Mira/.test(t)) throw new Error('it did not say who: ' + t.slice(0, 200));
    const ref = await page.locator('.done-ref').textContent();
    if (!/^HD-/.test(ref.trim())) throw new Error('no reference: ' + ref);
  });

  await step('no JS errors', async () => { if (errs.length) throw new Error(errs[0]); });

  console.log(fail ? fail + ' FAILED' : 'all green');
  await b.close();
  process.exit(fail ? 1 : 0);
})();
