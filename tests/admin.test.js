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
    catch (e) { console.log('FAIL  ' + n + ' -> ' + String(e.message).split('\n').slice(0,6).join(' | ')); fail++; }
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

  // ── Revenue ────────────────────────────────────────────────────────
  // Arithmetic, against figures worked out by hand. A revenue report
  // that is merely plausible is worse than none: nobody checks a number
  // that looks about right, and this one will be read as fact.
  //
  // The fixture is deliberately awkward — a refund, a payment on an
  // invoice with no branch, one against a voided invoice, and one with
  // no date at all — because each is a real row shape this database
  // produces and each one is a different way for a total to be wrong.
  const revenue = (props) => page.evaluate((q) => {
    let host = document.getElementById('r-host');
    if (!host) { host = document.createElement('div'); host.id = 'r-host'; document.body.appendChild(host); }
    const BRANCHES = [
      { id: 'br-ssgt', name: 'SSGT', code: 'SSGT', is_active: true },
      { id: 'br-sjkc', name: 'SJKC BSB', code: 'SJKCBSB', is_active: true }
    ];
    const INVOICES = [
      { id: 'i-1', branch_id: 'br-ssgt', status: 'paid' },
      { id: 'i-2', branch_id: 'br-sjkc', status: 'paid' },
      { id: 'i-3', branch_id: null,      status: 'paid' },   // raised on "All"
      { id: 'i-4', branch_id: 'br-ssgt', status: 'void' }
    ];
    const P = (id, inv, amt, date, method, kind) =>
      ({ id, invoice_id: inv, amount: amt, payment_date: date,
         payment_method: method || 'cash', kind: kind || 'payment' });
    const PAYMENTS = [
      // September — 400 at SSGT
      P('p1', 'i-1', 400, '2026-09-10'),
      // October — 1000 SSGT + 500 SJKC = 1500
      P('p2', 'i-1', 1000, '2026-10-05', 'transfer'),
      P('p3', 'i-2', 500,  '2026-10-20'),
      // November — 800 SSGT, 200 SJKC, 100 no-branch, less a 300 refund
      P('p4', 'i-1', 800,  '2026-11-03', 'transfer'),
      P('p5', 'i-2', 200,  '2026-11-11'),
      P('p6', 'i-3', 100,  '2026-11-12'),
      P('p7', 'i-1', -300, '2026-11-20', 'transfer', 'refund'),
      // Never revenue: a voided invoice, and a payment with no date
      P('p8', 'i-4', 9999, '2026-11-15'),
      // created_at is deliberately a DIFFERENT month from anything else.
      // If the report ever falls back to it when payment_date is empty,
      // this 55 lands in October and the figures move — which is the
      // whole danger of a fallback on a revenue report: money filed in
      // the month it was typed rather than the month it arrived.
      Object.assign(P('p9', 'i-1', 55, null), { created_at: '2026-10-01T02:00:00Z' })
    ];
    const root = window.__rRoot || (window.__rRoot = ReactDOM.createRoot(host));
    root.render(React.createElement(RevenueView, {
      payments: PAYMENTS, invoices: INVOICES, branches: BRANCHES, paymentMethods: []
    }));
  }, props);

  const rText = () => page.locator('#r-host').textContent();
  const setMonth = async (ym) => {
    await page.locator('#r-host input[type=month]').fill(ym);
    await page.waitForTimeout(300);
  };
  const setScope = async (v) => {
    await page.locator('#r-host select').first().selectOption(v);
    await page.waitForTimeout(300);
  };

  await step('the revenue screen renders from the live bundle', async () => {
    const missing = await page.evaluate(() => {
      try { return typeof eval('RevenueView') === 'function' ? [] : ['RevenueView is not a function']; }
      catch (e) { return ['RevenueView is missing']; }
    });
    if (missing.length) throw new Error(missing.join('; '));
    await revenue({});
    await page.waitForTimeout(400);
    if (!/Revenue/.test(await rText())) throw new Error('nothing rendered');
  });

  // 800 + 200 + 100 - 300 = 800. The voided 9999 and the undated 55 are
  // out; a report that included either would read 10799 or 855.
  // Read off the headline tile, not the page text: the excluded amounts
  // are printed further down on purpose, so searching the whole screen
  // for them finds the note that says they were left out.
  const headline = async () => (await page.locator('#r-host .card').nth(1).textContent()).trim();

  await step('the month nets refunds and leaves out void and undated', async () => {
    await setMonth('2026-11');
    const h = await headline();
    if (!/RM 800\.00/.test(h)) throw new Error('the headline is not 800: ' + h);
    if (/9999|10799|855/.test(h))
      throw new Error('a voided or undated payment reached the headline: ' + h);
  });

  await step('a payment with no date stays out, whatever else is on the row', async () => {
    await setMonth('2026-10');
    const h = await headline();
    if (!/RM 1500\.00/.test(h)) throw new Error('October is not 1500: ' + h);
    if (/1555/.test(h)) throw new Error('an undated payment was filed by created_at');
    await setMonth('2026-11');
  });

  await step('it shows takings and refunds separately, not just the net', async () => {
    const t = await rText();
    if (!/RM 1100\.00/.test(t)) throw new Error('gross before refunds is not 1100');
    if (!/RM -300\.00/.test(t)) throw new Error('refunds are not shown as -300');
  });

  await step('the branch split adds up to the month total', async () => {
    const rows = await page.locator('#r-host table').last().textContent();
    const t = await rText();
    // SSGT 800-300=500, SJKC 200, no branch 100 → 800
    if (!/RM 500\.00/.test(t)) throw new Error("SSGT's net is not 500");
    if (!/RM 200\.00/.test(t)) throw new Error("SJKC's net is not 200");
    if (!/RM 100\.00/.test(t)) throw new Error('the no-branch payment is not shown');
  });

  // The whole reason the bucket exists: an invoice raised while the
  // header said "All" stores no branch, and dropping it would make the
  // branch rows quietly disagree with the total.
  await step('an invoice with no branch is named, not dropped', async () => {
    const t = await rText();
    if (!/No branch recorded/.test(t)) throw new Error('the no-branch bucket is missing');
  });

  await step('filtering to one branch changes the figure', async () => {
    await setScope('br-sjkc');
    const t = await rText();
    if (!/SJKC BSB/.test(t)) throw new Error('scope label did not change');
    if (/RM 800\.00/.test(t)) throw new Error('still showing every branch');
    if (!/RM 200\.00/.test(t)) throw new Error("SJKC's November is not 200");
    await setScope('all');
  });

  // Sep 400, Oct 1500, Nov 800 = 2700 over three months, 900 a month.
  await step('the quarter totals and averages are right', async () => {
    const t = await rText();
    if (!/RM 2700\.00/.test(t)) throw new Error('the three-month total is not 2700');
    if (!/RM 900\.00/.test(t)) throw new Error('the monthly average is not 900');
  });

  // Q4 is Oct, Nov, Dec. December has nothing, so 1500+800+0 = 2300,
  // and the average still divides by three: 766.67, not 1150.
  await step('a calendar quarter divides by three, not by the months that have money', async () => {
    const t = await rText();
    if (!/RM 2300\.00/.test(t)) throw new Error('Q4 total is not 2300');
    if (!/RM 766\.67/.test(t)) throw new Error('Q4 average is not 766.67');
    if (/RM 1150\.00/.test(t)) throw new Error('it divided by the months with money, not by three');
  });

  // ── The printed statement ──────────────────────────────────────────
  // A summary is something you read; a statement is something an
  // accountant checks. So the thing to assert is that it foots: the
  // receipts listed on the page must add up to the total printed at the
  // bottom of it. A statement whose lines do not reach its own total is
  // worse than no statement.
  const printed = async () => {
    const html = await page.evaluate(() => {
      let captured = '';
      const realOpen = window.open;
      window.open = () => ({
        document: { write: (h) => { captured = h; }, close: () => {} }
      });
      try { document.querySelector('#r-host button.btn-primary').click(); }
      finally { window.open = realOpen; }
      return captured;
    });
    if (!html) throw new Error('the print window was never written to');
    return html;
  };
  const moneyIn = (html, re) => {
    const m = html.match(re);
    return m ? Number(m[1].replace(/,/g, '')) : null;
  };

  await step('the statement lists every receipt of the month', async () => {
    await setMonth('2026-11');
    const html = await printed();
    for (const r of ['p4', 'p5', 'p6', 'p7']) void r;   // ids are not printed
    // Four live November payments: 800, 200, 100 and the -300 refund.
    const rows = (html.match(/<tr[^>]*>\s*<td class="mono">/g) || []).length;
    if (rows !== 4) throw new Error('listed ' + rows + ' receipts, expected 4');
    if (!/Receipts issued — 4/.test(html)) throw new Error('the count in the heading is wrong');
  });

  await step('and the listed receipts add up to the total it prints', async () => {
    const html = await printed();
    const amounts = [...html.matchAll(/<td class="n">RM ([-\d,]+\.\d\d)<\/td>/g)]
      .map(m => Number(m[1].replace(/,/g, '')));
    // The last one is the total row; the rest are the listing.
    const total = amounts[amounts.length - 1];
    const lines = amounts.slice(0, -1).filter((_, i, a) => i < a.length);
    const sum = lines.reduce((a, n) => a + n, 0);
    // The by-branch block also prints amounts, so compare the total
    // against the sum of the receipt lines only.
    const receiptLines = [...html.matchAll(/<td class="mono">[^<]*<\/td>[\s\S]*?<td class="n">RM ([-\d,]+\.\d\d)<\/td>/g)]
      .map(m => Number(m[1].replace(/,/g, '')));
    const receiptSum = receiptLines.reduce((a, n) => a + n, 0);
    if (Math.abs(receiptSum - 800) > 0.005)
      throw new Error('the receipts list to ' + receiptSum + ', expected 800');
    if (Math.abs(total - 800) > 0.005)
      throw new Error('the printed total is ' + total + ', expected 800');
    void sum;
  });

  await step('a refund is listed as a receipt, negative, and marked', async () => {
    const html = await printed();
    if (!/RM -300\.00/.test(html)) throw new Error('the refund receipt is not listed');
    if (!/is-neg/.test(html)) throw new Error('the refund is not distinguished from a payment');
  });

  await step('it states the basis it was prepared on', async () => {
    const html = await printed();
    if (!/Basis\./.test(html)) throw new Error('no basis of preparation');
    if (!/voided invoices/.test(html)) throw new Error('it does not say what is excluded');
    if (!/November 2026/.test(html)) throw new Error('the month is not on the page');
  });

  await step('it prints the branch on the page when one is chosen', async () => {
    await setScope('br-sjkc');
    const html = await printed();
    if (!/SJKC BSB/.test(html)) throw new Error('the branch is not named on the statement');
    if (/RM 800\.00/.test(html)) throw new Error('it printed every branch while scoped to one');
    await setScope('all');
  });

  await step('a month with nothing in it reads as zero, not as an error', async () => {
    await setMonth('2026-07');
    const t = await rText();
    if (!/RM 0\.00/.test(t)) throw new Error('an empty month did not report zero');
    await setMonth('2026-11');
  });

  await step('it says what it has left out rather than swallowing it', async () => {
    const t = await rText();
    if (!/no payment date/i.test(t)) throw new Error('the undated payment is never mentioned');
    if (!/voided invoices/i.test(t)) throw new Error('the voided payment is never mentioned');
  });

  // ── Recording a payment on an invoice ──────────────────────────────
  // The form sent payment_date / payment_method / reference_number; the
  // handler destructures paymentDate / paymentMethod / referenceNumber.
  // Nothing threw. All three arrived undefined, the method fell to its
  // 'cash' default, the date fell to today and the reference was
  // dropped — so every invoice payment ever taken was filed as cash, on
  // the day it was keyed, with no bank reference. It was found when an
  // accountant asked where all the cash was.
  //
  // This drives the real form and reads back the object it hands over.
  const payForm = () => page.evaluate(() => {
    let host = document.getElementById('p-host');
    if (!host) { host = document.createElement('div'); host.id = 'p-host'; document.body.appendChild(host); }
    window.__sent = null;
    const INV = { id: 'inv-1', invoice_number: 1, account_name: 'Lee Oy Yin',
                  status: 'sent', total_amount: 300, amount_paid: 0, issue_date: '2026-11-01' };
    ReactDOM.createRoot(host).render(React.createElement(InvoiceDetailPanel, {
      invoice: INV, lines: [], pmts: [], pendingCredits: [], isOverdue: false,
      membersByGroup: {}, products: [],
      onVoid: () => {}, onDelete: null, onRefund: () => {},
      onEditVoidReason: null, onUpdateStatus: () => {},
      onRecordPayment: (d) => { window.__sent = d; return Promise.resolve({ receipt_number: 1 }); },
      onConfirmCredit: () => {}, onReverseCredit: () => {},
      onAddLine: () => {}, onUpdateLine: () => {}, onDeleteLine: () => {}
    }));
  });

  await step('the payment form hands over the method it was given', async () => {
    await payForm();
    await page.waitForTimeout(500);
    await page.locator('#p-host button:has-text("Record Payment")').first().click();
    await page.waitForTimeout(300);
    const amount = page.locator('#p-host .inv-pay-form input').first();
    await amount.fill('300');
    // The Method dropdown, whatever its options are called on this build.
    const method = page.locator('#p-host .inv-pay-form select').first();
    const opts = await method.locator('option').evaluateAll(os => os.map(o => o.value));
    const notCash = opts.find(v => v && v !== 'cash');
    if (!notCash) throw new Error('no non-cash method to choose: ' + JSON.stringify(opts));
    await method.selectOption(notCash);
    await page.waitForTimeout(200);
    await page.locator('#p-host .inv-pay-form button:has-text("Save Payment")').click();
    await page.waitForTimeout(400);
    const sent = await page.evaluate(() => window.__sent);
    if (!sent) throw new Error('the form handed over nothing');
    // The handler reads paymentMethod. Anything else and it defaults.
    const m = sent.paymentMethod !== undefined ? sent.paymentMethod : sent.payment_method;
    if (m !== notCash) throw new Error('chose ' + notCash + ', sent ' + JSON.stringify(m));
    if (sent.paymentMethod === undefined)
      throw new Error('sent under a key recordPayment does not read: ' + JSON.stringify(Object.keys(sent)));
  });

  await step('and the date and reference travel under readable keys too', async () => {
    const sent = await page.evaluate(() => window.__sent);
    if (sent.paymentDate === undefined)
      throw new Error('the payment date is under a key recordPayment does not read');
    if (!sent.paymentDate) throw new Error('no payment date was sent at all');
    if (!('referenceNumber' in sent))
      throw new Error('the bank reference is under a key recordPayment does not read');
  });

  // ── Void ───────────────────────────────────────────────────────────
  // Voiding used to delete the invoice's payments. On an unpaid invoice
  // that is a no-op; on a paid one it erased receipts the parent holds,
  // left an unexplained hole in a numbered sequence, and moved a past
  // month's revenue. Void is now only for an invoice nobody has paid.
  const detail = (invoice, pmts) => page.evaluate(([inv, ps]) => {
    let host = document.getElementById('v-host');
    if (!host) { host = document.createElement('div'); host.id = 'v-host'; document.body.appendChild(host); }
    window.__voided = false;
    const root = window.__vRoot || (window.__vRoot = ReactDOM.createRoot(host));
    root.render(React.createElement(InvoiceDetailPanel, {
      key: inv.id,                 // remount, as picking another invoice does
      invoice: inv, lines: [], pmts: ps, pendingCredits: [], isOverdue: false,
      membersByGroup: {}, products: [],
      onVoid: () => { window.__voided = true; return Promise.resolve(); },
      onDelete: null, onRefund: () => {}, onEditVoidReason: null,
      onUpdateStatus: () => {}, onRecordPayment: () => Promise.resolve({}),
      onConfirmCredit: () => {}, onReverseCredit: () => {},
      onAddLine: () => {}, onUpdateLine: () => {}, onDeleteLine: () => {}
    }));
  }, [invoice, pmts]);

  // "Void" is a prefix of "Confirm Void", so match the whole label.
  const voidBtn = () => page.locator('#v-host button').filter({ hasText: /^Void$/ });

  const UNPAID = { id:'v1', invoice_number:7, account_name:'Lee Oy Yin', status:'sent',
                   total_amount:300, amount_paid:0, issue_date:'2026-11-01' };
  const PAID   = { id:'v2', invoice_number:8, account_name:'Lee Oy Yin', status:'paid',
                   total_amount:300, amount_paid:300, issue_date:'2026-11-01' };
  const RECEIPT = [{ id:'pm1', invoice_id:'v2', receipt_number:'R-202611-0042',
                     amount:300, payment_date:'2026-11-03', payment_method:'transfer' }];

  await step('an invoice nobody has paid can still be voided', async () => {
    await detail(UNPAID, []);
    await page.waitForTimeout(400);
    await voidBtn().click();
    await page.waitForTimeout(300);
    const form = await page.locator('#v-host textarea').count();
    if (!form) throw new Error('the void form did not open on an unpaid invoice');
  });

  await step('an invoice with a receipt against it cannot be voided', async () => {
    await detail(PAID, RECEIPT);
    await page.waitForTimeout(400);
    let said = '';
    page.once('dialog', d => { said = d.message(); d.accept(); });
    await voidBtn().click();
    await page.waitForTimeout(400);
    if (await page.evaluate(() => window.__voided))
      throw new Error('it voided a paid invoice');
    if (!/refund/i.test(said))
      throw new Error('it refused without pointing at Refund: ' + JSON.stringify(said));
  });

  await step('and it says why, in terms of the document the parent holds', async () => {
    let said = '';
    page.once('dialog', d => { said = d.message(); d.accept(); });
    await voidBtn().click();
    await page.waitForTimeout(400);
    if (!/receipt/i.test(said)) throw new Error('no mention of the receipt: ' + JSON.stringify(said));
  });

  await step('no JS errors', async () => { if (errs.length) throw new Error(errs[0]); });

  console.log(fail ? fail + ' FAILED' : 'all green');
  await b.close();
  process.exit(fail ? 1 : 0);
})();
