// ─────────────────────────────────────────────────────────────────────────
// The admin bundle: that it still boots, and that the Terms screen shows
// the document from the database rather than the copy inside itself.
//
//   node tests/adminmock.js &         (or let run.sh do it)
//   node tests/admin.test.js
//
// WHY
// app.compiled.js had no test of any kind. "node build.js" reporting
// success means Babel parsed the source; it says nothing about whether the
// source still refers to things that exist. Removing a dead screen from
// this file took defaultTermsText, TC_CONTENT and the whole Terms editor
// with it, and every check in the repo stayed green.
//
// So the first two assertions here are deliberately dull: the page boots,
// and the pieces the Terms screen is built from are still defined. They
// are the ones that would have caught it.
// ─────────────────────────────────────────────────────────────────────────
'use strict';

const { launch, offline } = require('./browser');

const BASE = process.env.BASE || 'http://127.0.0.1:8904';

(async () => {
  const b = await launch();
  const page = await (await b.newContext({ viewport: { width: 1280, height: 1000 } })).newPage();
  const errs = [];
  let fail = 0;
  page.on('pageerror', e => errs.push('PAGEERROR: ' + e.message));
  await offline(page);

  const step = async (n, f) => {
    try { await f(); console.log('PASS  ' + n); }
    catch (e) { console.log('FAIL  ' + n + ' -> ' + String(e.message).split('\n')[0]); fail++; }
  };

  await page.request.get(BASE + '/__fail?on=0');
  await page.goto(BASE + '/app.html', { waitUntil: 'networkidle' });

  await step('the bundle boots as far as the sign-in screen', async () => {
    await page.waitForSelector('input', { timeout: 10000 });
    const t = await page.locator('#root').textContent();
    if (!/Sign in/i.test(t)) throw new Error('no sign-in screen: ' + t.slice(0, 160));
  });

  await step('the Terms screen is built from things that exist', async () => {
    const missing = await page.evaluate(() => {
      const want = { TermsAdminView: 'function', defaultTermsText: 'function', TC_CONTENT: 'object' };
      const bad = [];
      for (const [name, kind] of Object.entries(want)) {
        let got;
        try { got = typeof eval(name); } catch (e) { got = 'missing'; }
        if (got !== kind) bad.push(name + ' is ' + got + ', expected ' + kind);
      }
      return bad;
    });
    if (missing.length) throw new Error(missing.join('; '));
  });

  await step('the bundled fallback is still the whole agreement', async () => {
    const t = await page.evaluate(() => defaultTermsText());
    for (const h of ['1. Introduction', '7. Fees & Payment', '11. Acceptance & Governing Law'])
      if (!t.includes(h)) throw new Error('fallback is missing "' + h + '"');
  });

  // From here the Terms editor is mounted on its own, with props supplied
  // by hand. Driving it through a sign-in would need the whole of the rest
  // of the admin mocked; this tests the screen, which is the change.
  const mount = (props) => page.evaluate((p) => {
    let host = document.getElementById('t-host');
    if (!host) { host = document.createElement('div'); host.id = 't-host'; document.body.appendChild(host); }
    window.__reloads = 0;
    const root = window.__tRoot || (window.__tRoot = ReactDOM.createRoot(host));
    // Built once and reused, because the real app passes the same array
    // object until the branches themselves are reloaded. A fresh array on
    // every render makes the editor's effect re-run whatever its
    // dependencies say, which quietly tests nothing.
    const BRANCHES = [
      { id: 'br-ssgt', name: 'SSGT', code: 'SSGT', is_active: true, terms_content: null },
      { id: 'br-sjkc', name: 'SJKC BSB', code: 'SJKCBSB', is_active: true,
        terms_content: 'SJKC BANDAR SERI BOTANI\n\n1. General\nThis branch stands alone.' }
    ];
    // Programmes, as scheduler_lesson_types rows reach the screen.
    const TYPES = [
      { id: 'lt-squad', name: 'ASC Squad', branch_id: 'br-sjkc', is_active: true, sort_order: 1,
        terms_content: 'A missed session is an absence. It is not replaced.' },
      { id: 'lt-lts', name: 'Learn to Swim', branch_id: 'br-ssgt', is_active: true, sort_order: 1,
        terms_content: null },
      { id: 'lt-p1', name: 'Personal 1', branch_id: 'br-ssgt', is_active: true, sort_order: 2,
        terms_content: 'Sessions are arranged directly with the instructor.' },
      { id: 'lt-old', name: 'Retired Programme', branch_id: 'br-ssgt', is_active: false, sort_order: 3,
        terms_content: 'Wording nobody can reach.' }
    ];
    window.__saved = [];
    window.__render = (q) => root.render(React.createElement(TermsAdminView, {
      branches: BRANCHES,
      currentBranchId: q.branchId || 'br-ssgt',
      lessonTypes: TYPES,
      defaultTerms: q.defaultTerms,
      fromDb: q.fromDb,
      onReload: () => { window.__reloads++; },
      onSave: () => Promise.resolve(),
      onSaveProgramme: (id, body) => { window.__saved.push([id, body]); return Promise.resolve(); }
    }));
    window.__render(p);
  }, props);

  const rerender = (props) => page.evaluate((p) => window.__render(p), props);
  const editor = () => page.locator('#t-host textarea').first();
  const banner = () => page.locator('#t-host').getByText('This is not the shared default');

  const DB = 'STAR SWIM SDN BHD\n\n1. Introduction\nThis copy lives in the database and is the one parents sign.';

  await step('it shows the database copy, not its own', async () => {
    await mount({ defaultTerms: DB, fromDb: true });
    await page.waitForTimeout(300);
    const v = await editor().inputValue();
    if (!/lives in the database/.test(v)) throw new Error('not the database copy: ' + v.slice(0, 120));
    if (/aquatic programmes offered by/.test(v)) throw new Error('still showing the bundled copy');
  });

  await step('opening the screen re-reads the shared default', async () => {
    const n = await page.evaluate(() => window.__reloads);
    if (n < 1) throw new Error('onReload was never called');
  });

  await step('no banner while the database copy is what is shown', async () => {
    if (await banner().count()) throw new Error('banner shown over a good read');
  });

  await step('a failed read says so rather than passing the old copy off', async () => {
    await rerender({ defaultTerms: 'THE BUNDLED COPY\n\n1. Introduction\nFrom inside the app.', fromDb: false });
    await page.waitForTimeout(300);
    if (!(await banner().count())) throw new Error('no banner over the bundled fallback');
    const v = await editor().inputValue();
    if (!/From inside the app/.test(v)) throw new Error('fallback text not shown: ' + v.slice(0, 120));
  });

  await step('nothing is claimed before the read has been tried', async () => {
    await rerender({ defaultTerms: DB, fromDb: null });
    await page.waitForTimeout(300);
    if (await banner().count()) throw new Error('banner flashed before the read resolved');
  });

  await step('the default arriving late reaches a branch on the default wording', async () => {
    await rerender({ defaultTerms: 'WAITING', fromDb: null });
    await page.waitForTimeout(200);
    await rerender({ defaultTerms: DB, fromDb: true });
    await page.waitForTimeout(300);
    const v = await editor().inputValue();
    if (!/lives in the database/.test(v))
      throw new Error('editor kept the copy it opened with: ' + v.slice(0, 120));
  });

  // Picked from the dropdown rather than passed in: currentBranchId only
  // seeds the initial state, so re-rendering with a different one changes
  // nothing — which is how a test can pass while testing nothing.
  await step("a branch with its own terms is not overwritten by the default", async () => {
    await page.locator('#t-host select').first().selectOption('br-sjkc');
    await page.waitForTimeout(300);
    const v = await editor().inputValue();
    if (!/This branch stands alone/.test(v)) throw new Error('branch terms lost: ' + v.slice(0, 120));
    if (/lives in the database/.test(v)) throw new Error('the default overwrote the branch terms');
  });

  // ── Programme clauses ──────────────────────────────────────────────
  // The column these edit was reachable only through the SQL editor
  // until now, which is the whole point of the tab.
  const tab = (name) => page.locator('#t-host button', { hasText: name }).first().click();

  await step('the programme tab lists the branch\'s own programmes', async () => {
    // Through the dropdown, for the same reason as above: currentBranchId
    // only seeds the initial state.
    await page.locator('#t-host select').first().selectOption('br-ssgt');
    await page.waitForTimeout(300);
    await tab('Programme clauses');
    await page.waitForTimeout(300);
    const t = await page.locator('#t-host').textContent();
    if (!/Learn to Swim/.test(t) || !/Personal 1/.test(t)) throw new Error('branch programmes missing');
    if (/ASC Squad/.test(t)) throw new Error("another branch's programme is listed");
  });

  await step('a hidden programme is not offered, because nobody can reach it', async () => {
    const t = await page.locator('#t-host').textContent();
    if (/Retired Programme/.test(t)) throw new Error('an inactive programme is listed');
  });

  await step('picking a programme shows its clauses and nothing else', async () => {
    await page.locator('#t-host button', { hasText: 'Personal 1' }).first().click();
    await page.waitForTimeout(300);
    const v = await editor().inputValue();
    if (!/arranged directly with the instructor/.test(v)) throw new Error('clauses not loaded: ' + v.slice(0, 120));
    if (/lives in the database/.test(v)) throw new Error('the branch terms are in the programme box');
  });

  await step('the preview is the whole document, branch terms and clauses together', async () => {
    const t = await page.locator('#t-host .tc-doc-scroll').last().textContent();
    if (!/lives in the database/.test(t)) throw new Error('branch terms missing from the preview');
    if (!/Personal 1 — additional terms/.test(t)) throw new Error('the programme heading terms_for adds is missing');
    if (!/arranged directly with the instructor/.test(t)) throw new Error('clauses missing from the preview');
    if (t.indexOf('lives in the database') > t.indexOf('arranged directly'))
      throw new Error('the clauses are above the branch terms, not under them');
    const heads = await page.locator('#t-host .tc-doc-scroll h3').allTextContents();
    if (!heads.some(h => /Personal 1 . additional terms/.test(h)))
      throw new Error('the programme heading is set as body text: ' + JSON.stringify(heads.slice(0, 4)));
  });

  await step('a programme with no clauses opens empty, not on the last one', async () => {
    await page.locator('#t-host button', { hasText: 'Learn to Swim' }).first().click();
    await page.waitForTimeout(300);
    const v = await editor().inputValue();
    if (v.trim()) throw new Error('showing another programme\'s clauses: ' + v.slice(0, 120));
  });

  // Saved against the programme that is open, which is deliberately not
  // the first in the list: saving against whichever came first would have
  // passed every assertion here if this used Learn to Swim.
  await step('saving sends the clauses against the programme that is open', async () => {
    await page.locator('#t-host button', { hasText: 'Personal 1' }).first().click();
    await page.waitForTimeout(300);
    await editor().fill('1. Sessions\nOnce a week through the school term.');
    await page.waitForTimeout(200);
    await page.locator('#t-host button', { hasText: 'Save clauses' }).click();
    await page.waitForTimeout(400);
    const saved = await page.evaluate(() => window.__saved);
    if (!saved.length) throw new Error('nothing was saved');
    if (saved[saved.length - 1][0] !== 'lt-p1') throw new Error('saved against ' + saved[saved.length - 1][0]);
    if (!/through the school term/.test(saved[saved.length - 1][1])) throw new Error('the text did not travel');
  });

  await step('removing clauses sends blank, which the database stores as none', async () => {
    page.once('dialog', d => d.accept());
    await page.locator('#t-host button', { hasText: 'Remove clauses' }).click();
    await page.waitForTimeout(400);
    const saved = await page.evaluate(() => window.__saved);
    const last = saved[saved.length - 1];
    if (last[0] !== 'lt-p1') throw new Error('removed from ' + last[0]);
    if (String(last[1]).trim()) throw new Error('not a blank: ' + JSON.stringify(last[1]));
  });

  await step('switching back to the branch tab still shows the branch terms', async () => {
    await tab('Branch terms');
    await page.waitForTimeout(300);
    const v = await editor().inputValue();
    if (!/lives in the database/.test(v)) throw new Error('branch editor lost its document: ' + v.slice(0, 120));
  });

  await step('no JS errors', async () => { if (errs.length) throw new Error(errs[0]); });

  console.log(fail ? fail + ' FAILED' : 'all green');
  await b.close();
  process.exit(fail ? 1 : 0);
})();
