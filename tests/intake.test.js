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

  await step('no JS errors', async () => { if (errs.length) throw new Error(errs[0]); });

  console.log(fail ? fail + ' FAILED' : 'all green');
  await b.close();
  process.exit(fail ? 1 : 0);
})();
