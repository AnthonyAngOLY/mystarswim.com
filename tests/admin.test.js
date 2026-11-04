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
    window.__render = (q) => root.render(React.createElement(TermsAdminView, {
      branches: BRANCHES,
      currentBranchId: q.branchId || 'br-ssgt',
      defaultTerms: q.defaultTerms,
      fromDb: q.fromDb,
      onReload: () => { window.__reloads++; },
      onSave: () => Promise.resolve()
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

  await step('no JS errors', async () => { if (errs.length) throw new Error(errs[0]); });

  console.log(fail ? fail + ' FAILED' : 'all green');
  await b.close();
  process.exit(fail ? 1 : 0);
})();
