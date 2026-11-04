// ─────────────────────────────────────────────────────────────────────────
// The public intake form: what a parent is shown, and what they sign.
//
//   node tests/intakemock.js &        (or let run.sh do it)
//   node tests/intake.test.js
//
// This drives the real intake.html and intake.compiled.js. It is a legal
// document with a signature box at the bottom; "it parses" is not a
// standard worth shipping it on.
// ─────────────────────────────────────────────────────────────────────────
'use strict';

const { launch, offline } = require('./browser');

const BASE = process.env.BASE || 'http://127.0.0.1:8903';

(async () => {
  const b = await launch();
  const page = await (await b.newContext({ viewport: { width: 900, height: 1200 } })).newPage();
  const errs = [];
  let fail = 0;
  page.on('pageerror', e => errs.push('PAGEERROR: ' + e.message));
  await offline(page);

  const step = async (n, f) => {
    try { await f(); console.log('PASS  ' + n); }
    catch (e) { console.log('FAIL  ' + n + ' -> ' + String(e.message).split('\n')[0]); fail++; }
  };

  await page.request.get(BASE + '/__reset');
  await page.goto(BASE + '/intake.html', { waitUntil: 'networkidle' });
  await page.waitForSelector('.card', { timeout: 10000 });

  // By value, not by label: selectOption takes a string label and the
  // visible text carries the branch code in brackets. The id is what the
  // form actually submits anyway.
  const pickBranch = async (id) => {
    await page.locator('select').first().selectOption(id);
    await page.waitForTimeout(800);
  };

  const openTerms = async () => {
    const t = page.locator('.tc-toggle');
    if (await t.count() && /Read full/.test(await t.textContent())) await t.click();
    await page.waitForTimeout(500);
  };

  await step('the form loads and offers the branches', async () => {
    const opts = await page.locator('select').first().locator('option').allTextContents();
    if (!opts.some(o => /SSGT/.test(o))) throw new Error('no SSGT: ' + JSON.stringify(opts));
    if (!opts.some(o => /SJKC/.test(o))) throw new Error('no SJKC: ' + JSON.stringify(opts));
  });

  await step('the terms come from the server, not from this bundle', async () => {
    await pickBranch('br-ssgt');
    await openTerms();
    const t = await page.locator('.tc-doc').textContent();
    // The server's default carries a fees clause. The copy inside
    // intake.js, which this replaces, does not.
    if (!/7\. Fees & Payment/.test(t))
      throw new Error('showing the bundled copy, which has no fees clause');
  });

  await step('a branch with its own terms replaces the default outright', async () => {
    await pickBranch('br-sjkc');
    const t = await page.locator('.tc-doc').textContent();
    if (!/SCHOOL SWIM PROGRAMME/.test(t)) throw new Error('branch terms not shown: ' + t.slice(0, 160));
    if (/7\. Fees & Payment/.test(t)) throw new Error('the default is still underneath the branch terms');
  });

  await step('and switching back brings the default back', async () => {
    await pickBranch('br-ssgt');
    const t = await page.locator('.tc-doc').textContent();
    if (!/7\. Fees & Payment/.test(t)) throw new Error('did not return to the default');
    if (/SCHOOL SWIM PROGRAMME/.test(t)) throw new Error('still showing the other branch');
  });

  await step('the document is typeset, not a wall of identical paragraphs', async () => {
    if (!await page.locator('.tc-doc h3').count())
      throw new Error('no section headings — terms-render.js is not being applied');
    if (!await page.locator('.tc-doc strong').count())
      throw new Error('no clause numbers in bold');
    if (/\*\*/.test(await page.locator('.tc-doc').textContent()))
      throw new Error('asterisks left on the page');
  });

  await step('a failed terms call leaves the box readable, never blank', async () => {
    await page.route('**/rpc/terms_for', r => r.abort());
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForSelector('.card', { timeout: 10000 });
    await pickBranch('br-ssgt');
    await openTerms();
    const t = await page.locator('.tc-doc').textContent();
    if (!/Introduction/.test(t))
      throw new Error('a parent was asked to accept an empty box: ' + JSON.stringify(t.slice(0, 80)));
    await page.unroute('**/rpc/terms_for');
  });

  await step('each swimmer is asked which programme, filtered by branch', async () => {
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForSelector('.card', { timeout: 10000 });
    await pickBranch('br-ssgt');
    const sel = page.locator('.swimmer-card select, .child select, select').nth(1);
    const opts = await sel.locator('option').allTextContents();
    if (!opts.some(o => /Learn to Swim/.test(o))) throw new Error('SSGT programmes missing: ' + JSON.stringify(opts));
    if (opts.some(o => /ASC Squad/.test(o)))
      throw new Error('an SJKC programme is offered at SSGT: ' + JSON.stringify(opts));
  });

  await step('choosing one brings its clauses into the terms', async () => {
    await pickBranch('br-sjkc');
    await page.locator('select').nth(1).selectOption('lt-squad');
    await page.waitForTimeout(900);
    await openTerms();
    const t = await page.locator('.tc-doc').textContent();
    if (!/ASC Squad/.test(t)) throw new Error('no programme heading in the terms');
    if (!/not replaced/.test(t)) throw new Error('the programme clauses are not there: ' + t.slice(0, 200));
  });

  await step('changing branch clears a pick that does not belong to it', async () => {
    await pickBranch('br-ssgt');
    const v = await page.locator('select').nth(1).inputValue();
    if (v === 'lt-squad') throw new Error('an SJKC programme survived the move to SSGT');
    const t = await page.locator('.tc-doc').textContent();
    if (/not replaced/.test(t)) throw new Error('its clauses are still in the terms');
  });

  await step('the form will not submit without a programme', async () => {
    // Everything else filled, so the programme is the only thing left to
    // object to. The first version of this clicked Submit on an empty
    // form and got "please enter the parent name", which proves nothing
    // about the check it was meant to be testing.
    const byLabel = async (label, value) => {
      await page.locator('.field', { hasText: label }).first()
        .locator('input, select').first().fill(value);
    };
    await byLabel('Full Name', 'Lee Oy Yin');
    await byLabel('Email', 'parent@example.com');
    await byLabel('Phone', '0123456789');
    // The guardian's field and the child's are both labelled Full Name,
    // so the first one is the parent's. Filling that twice left the
    // swimmer nameless and the form objected to that instead.
    await page.locator('.field', { hasText: 'Full Name' }).nth(1)
      .locator('input').first().fill('Mira Lee');
    await page.locator('input[type="date"]').first().fill('2017-04-02');
    await page.locator('button:has-text("\u2640 F")').first().click();
    await page.locator('.check-row').first().click();            // same as guardian
    await page.locator('.field', { hasText: 'Digital Signature' })
      .locator('input').first().fill('Lee Oy Yin');
    await page.locator('.check-row').last().click();             // accept the terms
    await page.waitForTimeout(300);

    page.once('dialog', d => d.accept());
    await page.locator('button:has-text("Submit Registration")').click();
    await page.waitForTimeout(900);
    const body = await page.locator('body').textContent();
    if (!/programme for swimmer/i.test(body))
      throw new Error('submitted, or objected to something else, with no programme chosen');
    const sent = await (await page.request.get(BASE + '/__submissions')).json();
    if (sent.length) throw new Error('it went through anyway');
  });

  await step('and it carries the programme when one is chosen', async () => {
    await page.locator('select').nth(1).selectOption('lt-lts');
    await page.waitForTimeout(400);
    page.once('dialog', d => d.accept());
    await page.locator('button:has-text("Submit Registration")').click();
    await page.waitForTimeout(1500);
    const sent = await (await page.request.get(BASE + '/__submissions')).json();
    if (!sent.length) throw new Error('nothing reached the server');
    const kid = sent[0].children && sent[0].children[0];
    if (!kid || kid.lessonTypeId !== 'lt-lts')
      throw new Error('the programme did not travel: ' + JSON.stringify(kid));
  });

  await step('no JS errors', async () => { if (errs.length) throw new Error(errs[0]); });

  console.log(fail ? fail + ' FAILED' : 'all green');
  await b.close();
  process.exit(fail ? 1 : 0);
})();
