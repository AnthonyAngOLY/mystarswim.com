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
const fs = require('fs');
const path = require('path');

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

  // ── The messaging module ───────────────────────────────────────────
  // These screens write the words a parent reads. The assertion that
  // matters is that every field they edit is a field they save: a key
  // missing from the save list is a box somebody types into and then
  // watches revert, which reads as a database that ignored them.
  await step('every automatic message is editable and saveable', async () => {
    const r = await page.evaluate(() => {
      const src = ParentAutoMessages.toString();
      const edited = [...src.matchAll(/up\('([a-z_]+)'/g)].map(m => m[1]);
      const blocks = [...src.matchAll(/block\('([a-z]+)'/g)].map(m => m[1]);
      const keepLine = src.match(/const keep\s*=\s*\[([\s\S]*?)\]/);
      const keep = keepLine ? [...keepLine[1].matchAll(/'([a-z_]+)'/g)].map(m => m[1]) : [];
      return { edited, blocks, keep };
    });
    if (!r.blocks.length) throw new Error('no message blocks found');
    for (const b of r.blocks) {
      for (const suffix of ['_enabled', '_title', '_template']) {
        if (!r.keep.includes(b + suffix))
          throw new Error(b + suffix + ' is edited on screen but never saved');
      }
    }
  });

  await step('the reminder screen saves the days and the floor it edits', async () => {
    const keep = await page.evaluate(() => {
      const m = ParentReminders.toString().match(/const keep\s*=\s*\[([\s\S]*?)\]/);
      return m ? [...m[1].matchAll(/'([a-z_]+)'/g)].map(x => x[1]) : [];
    });
    for (const k of ['lead_days', 'min_hours_ahead', 'notice_hours', 'replacement_window_days'])
      if (!keep.includes(k)) throw new Error(k + ' is edited on screen but never saved');
  });

  // The chase must go to the accounts that are ticked and no others.
  // Sending a demand to a family who paid this morning is the one
  // mistake this screen can make that cannot be taken back.
  await step('the outstanding blast sends only to the accounts ticked', async () => {
    const sent = await page.evaluate(async () => {
      let host = document.getElementById('o-host');
      if (!host) { host = document.createElement('div'); host.id = 'o-host'; document.body.appendChild(host); }
      window.__rpc = null;
      const realRest = window.rest;
      // outstanding_accounts answers from here; send_outstanding_reminders
      // is captured rather than called.
      window.__patchRpc = true;
      ReactDOM.createRoot(host).render(React.createElement(ParentOutstanding));
      return null;
    });
    void sent;
    // Driving the real screen needs the two RPCs; the mock serves
    // /rest/v1/rpc/* as [] so the list is empty and Send is disabled,
    // which is the assertion worth making without a live database.
    await page.waitForTimeout(600);
    const disabled = await page.locator('#o-host button:has-text("Send to")').isDisabled();
    if (!disabled) throw new Error('Send was live with nobody selected');
  });

  // ── Refund documentation ───────────────────────────────────────────
  // A refund is three artefacts and they are not the same statement:
  // a refund receipt (money left the bank), a credit note (the sale was
  // reduced — what LHDN e-invoicing reads), and the transfer slip proving
  // it actually went back. The failure this guards against is the one the
  // payment form already had once: a form that collects a field and a
  // handler that destructures a different key, so the field is silently
  // dropped on every refund ever taken and nothing throws.
  const PAIDINV = { id:'r1', invoice_number:'INV-202611-010', account_name:'Lee Oy Yin',
                    status:'paid', total_amount:300, amount_paid:300, issue_date:'2026-11-01' };
  const ORIG = { id:'pm9', invoice_id:'r1', receipt_number:'RCT-202611-0099',
                 amount:300, payment_date:'2026-11-03', payment_method:'transfer' };

  const refundForm = () => page.evaluate(([inv, orig]) => {
    let host = document.getElementById('rf-host');
    if (!host) { host = document.createElement('div'); host.id = 'rf-host'; document.body.appendChild(host); }
    window.__refund = null;
    const root = window.__rfRoot || (window.__rfRoot = ReactDOM.createRoot(host));
    root.render(React.createElement(InvoiceDetailPanel, {
      key: 'rf', invoice: inv, lines: [], pmts: [orig], pendingCredits: [], isOverdue: false,
      membersByGroup: {}, products: [],
      onVoid: () => {}, onDelete: null, onEditVoidReason: null,
      onRefund: (d) => { window.__refund = Object.assign({}, d, { _proofName: d.proofFile && d.proofFile.name }); return Promise.resolve(); },
      onUpdateStatus: () => {}, onRecordPayment: () => Promise.resolve({}),
      onConfirmCredit: () => {}, onReverseCredit: () => {},
      onAddLine: () => {}, onUpdateLine: () => {}, onDeleteLine: () => {}
    }));
  }, [PAIDINV, ORIG]);

  await step('the refund form carries the reference and the proof file', async () => {
    await refundForm();
    await page.waitForTimeout(500);
    await page.locator('#rf-host button').filter({ hasText: /^Refund$/ }).first().click();
    await page.waitForTimeout(350);
    const form = page.locator('#rf-host .inv-pay-form').last();
    await form.locator('input[type="number"], input').first().fill('300');
    await form.locator('input[type="file"]').setInputFiles({
      name: 'transfer-slip.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 slip')
    });
    // The Reference box, by its placeholder — the only text input that has one.
    const ref = form.locator('input[placeholder*="reference" i], input[placeholder*="cheque" i]').first();
    if (!(await ref.count())) throw new Error('the refund form has no Reference field');
    await ref.fill('MBB-778899');
    await page.waitForTimeout(150);
    await form.locator('button').filter({ hasText: /Refund/i }).last().click();
    await page.waitForTimeout(500);
    const sent = await page.evaluate(() => window.__refund);
    if (!sent) throw new Error('the refund form handed over nothing');
    if (sent.reference !== 'MBB-778899')
      throw new Error('the reference is under a key refundInvoice does not read: ' + JSON.stringify(Object.keys(sent)));
    if (sent._proofName !== 'transfer-slip.pdf')
      throw new Error('the proof file was dropped on the way: ' + JSON.stringify(sent._proofName));
    if (!sent.method) throw new Error('no refund method was sent');
  });

  await step('a refund prints as a Refund, naming the receipt it reverses', async () => {
    const html = await page.evaluate(([inv, orig]) => {
      let out = '';
      const real = window.open;
      window.open = () => ({ document: { write: (h) => { out = h; }, close(){} } });
      try {
        printReceipt({ id:'pm10', invoice_id:'r1', receipt_number:'RCT-202611-0100', kind:'refund',
                       amount:-300, payment_date:'2026-11-20', payment_method:'transfer',
                       reference_number:'MBB-778899', notes:'Refund: withdrew' },
                     inv, { againstReceipt: orig.receipt_number });
      } finally { window.open = real; }
      return out;
    }, [PAIDINV, ORIG]);
    if (!html) throw new Error('nothing was printed');
    if (/RECEIPT<\/div>/.test(html)) throw new Error('a refund still prints headed RECEIPT');
    if (!/REFUND<\/div>/.test(html)) throw new Error('the document is not headed REFUND');
    if (!html.includes('RCT-202611-0099'))
      throw new Error('the refund does not name the receipt it reverses');
    if (!/RM 300\.00/.test(html)) throw new Error('the amount is not RM 300.00: a negative leaked into the print');
    if (/RM -300/.test(html)) throw new Error('the printed amount is negative');
    if (!/REFUNDED/.test(html)) throw new Error('it still stamps the refund PAID IN FULL');
    if (!/MBB-778899/.test(html)) throw new Error('the bank reference is not on the document');
  });

  await step('an ordinary receipt is untouched by all of that', async () => {
    const html = await page.evaluate(([inv, orig]) => {
      let out = ''; const real = window.open;
      window.open = () => ({ document: { write: (h) => { out = h; }, close(){} } });
      try { printReceipt(orig, inv); } finally { window.open = real; }
      return out;
    }, [PAIDINV, ORIG]);
    if (!/RECEIPT<\/div>/.test(html)) throw new Error('a payment no longer prints headed RECEIPT');
    if (!/PAID IN FULL/.test(html)) throw new Error('the paid stamp is gone');
    if (/Against receipt/.test(html)) throw new Error('a plain receipt reverses something');
  });

  await step('the credit note states the invoice it reduces and by how much', async () => {
    const html = await page.evaluate(([inv, orig]) => {
      let out = ''; const real = window.open;
      window.open = () => ({ document: { write: (h) => { out = h; }, close(){} } });
      try {
        printCreditNote({ credit_note_number:'CN-202611-001', invoice_id:'r1', amount:300,
                          reason:'Parent withdrew', issue_date:'2026-11-20' },
                        inv,
                        { receipt_number:'RCT-202611-0100', payment_method:'transfer', reference_number:'MBB-778899' },
                        orig.receipt_number);
      } finally { window.open = real; }
      return out;
    }, [PAIDINV, ORIG]);
    if (!/CREDIT NOTE/.test(html)) throw new Error('it is not headed CREDIT NOTE');
    if (!html.includes('CN-202611-001')) throw new Error('the credit note has no number on it');
    if (!html.includes('INV-202611-010')) throw new Error('it does not name the invoice it reduces');
    if (!html.includes('RCT-202611-0099')) throw new Error('it does not name the original receipt');
    if (!/RM 300\.00/.test(html)) throw new Error('the credited amount is not on it');
    if (!/Parent withdrew/.test(html)) throw new Error('the reason is not on the document');
  });

  await step('the original receipt is picked out of the invoice, not guessed', async () => {
    const r = await page.evaluate(() => {
      const refund = { id:'x2', kind:'refund', amount:-300, receipt_number:'RCT-0100' };
      const paid   = { id:'x1', amount:300, receipt_number:'RCT-0099' };
      return {
        found: originalReceiptNumber([paid, refund], refund),
        // Asked about the payment itself, it must not answer with it.
        self: originalReceiptNumber([paid], paid),
        none: originalReceiptNumber([], null)
      };
    });
    if (r.found !== 'RCT-0099') throw new Error('wrong original receipt: ' + JSON.stringify(r.found));
    if (r.self) throw new Error('a receipt was reported as reversing itself');
    if (r.none) throw new Error('an invoice with no payments produced a receipt number');
  });

  // ── Sign-in codes ─────────────────────────────────────────────────────
  // Every code is an SMS that Twilio charges for, and the screen's job is
  // to turn a count into ringgit. The arithmetic is the assertion: a
  // refusal costs nothing, and counting one would overstate the bill and
  // send somebody looking for a problem that is not there.
  const codesView = () => page.evaluate(() => {
    let host = document.getElementById('sc-host');
    if (!host) { host = document.createElement('div'); host.id = 'sc-host'; document.body.appendChild(host); }
    ReactDOM.createRoot(host).render(React.createElement(SigninCodesView));
  });

  await step('the sign-in screen reads the log and renders', async () => {
    await codesView();
    await page.waitForTimeout(900);
    const t = await page.locator('#sc-host').innerText();
    if (!/2026-11-24/.test(t)) throw new Error('the days are not listed: ' + t.slice(0, 160));
  });

  await step('it charges for what was sent, and not for what was refused', async () => {
    const t = await page.locator('#sc-host').innerText();
    // 9 + 3 sent, 1 failed = 13 chargeable at 0.35 = 4.55.
    if (!/RM\s*4\.55/.test(t))
      throw new Error('the cost is not 13 x 0.35: ' + JSON.stringify(t.slice(0, 300)));
    // 4 too-soon + 2 capped + 31 not-on-file + 1 archived cost nothing.
    if (/RM\s*17\.|RM\s*18\./.test(t))
      throw new Error('it billed the refusals, which never left the building');
  });

  await step('changing the rate changes the figure', async () => {
    const box = page.locator('#sc-host input[type="number"]');
    await box.fill('0.5');
    await page.waitForTimeout(400);
    const t = await page.locator('#sc-host').innerText();
    if (!/RM\s*6\.50/.test(t))
      throw new Error('13 x 0.50 is not 6.50 on screen: ' + JSON.stringify(t.slice(0, 300)));
  });

  await step('and it shows how much of the traffic is already free', async () => {
    const t = await page.locator('#sc-host').innerText();
    // 36 password sign-ins against 12 codes is 75%.
    if (!/75\s*%/.test(t))
      throw new Error('the password share is not shown, which is the whole point: '
                      + JSON.stringify(t.slice(0, 300)));
  });

  // ── Family groups, and what each is still attached to ─────────────────
  // Deleting an account deletes its SWIMMERS and nothing else. The
  // membership rows stay, pointing at swimmers that no longer exist, and
  // the screen skipped them silently -- so a group whose family was
  // deleted and a group nobody ever used both read "0 members" and were
  // cleaned under one button called Empty. Six accumulated that way.
  const groupsView = () => page.evaluate(() => {
    let host = document.getElementById('fg-host');
    if (!host) { host = document.createElement('div'); host.id = 'fg-host'; document.body.appendChild(host); }
    const S = (id, name, active, acct) => ({ id, name, isActive: active, accountId: acct,
                                             guardianName: acct ? 'Lee Oy Yin' : null });
    const live = S('s1', 'Mira', true, 'a1');
    const gone = S('s2', 'Kobe', false, 'a1');
    ReactDOM.createRoot(host).render(React.createElement(FamilyGroupsAdminView, {
      familyGroups: [
        { id: 'g-live',  name: 'Lee Family',     packageId: 'p1', groupType: 'discount' },
        { id: 'g-arch',  name: 'Tan Family',     packageId: 'p1', groupType: 'discount' },
        { id: 'g-orph',  name: 'Deleted Family', packageId: 'p1', groupType: 'discount' },
        { id: 'g-new',   name: 'Empty Shell',    packageId: 'p1', groupType: 'discount' }
      ],
      // Only swimmers that still exist. g-orph has none, because its
      // swimmers were deleted.
      membersByGroup: { 'g-live': [live], 'g-arch': [gone] },
      // The raw rows. g-orph still holds two, pointing at nobody.
      groupMemberships: [
        { familyGroupId: 'g-live', studentId: 's1' },
        { familyGroupId: 'g-arch', studentId: 's2' },
        { familyGroupId: 'g-orph', studentId: 'deleted-1' },
        { familyGroupId: 'g-orph', studentId: 'deleted-2' }
      ],
      lessonTypes: [], lessonTypeById: () => ({ name: 'LTS' }),
      packages: [], packageById: () => ({ name: 'FAM3', lesson_type_id: 'lt1' }),
      deleteGroup: () => {}, updateGroup: null
    }));
  });

  const cardFor = (name) => page.locator('#fg-host .fga-card').filter({ hasText: name });

  await step('a group whose family was deleted is not called empty', async () => {
    await groupsView();
    await page.waitForTimeout(700);
    const t = await cardFor('Deleted Family').innerText();
    if (!/Account deleted/i.test(t))
      throw new Error('it reads as something else: ' + JSON.stringify(t.replace(/\n/g, ' ')));
    if (!/2 deleted swimmers/i.test(t))
      throw new Error('it does not say how many swimmers went with it: ' + JSON.stringify(t.replace(/\n/g, ' ')));
  });

  await step('and a group nobody ever joined is told apart from it', async () => {
    const t = await cardFor('Empty Shell').innerText();
    if (/Account deleted/i.test(t))
      throw new Error('a group that never had anybody is blamed on a deletion');
    if (!/Never used/i.test(t))
      throw new Error('it is not marked as never used: ' + JSON.stringify(t.replace(/\n/g, ' ')));
  });

  await step('a group with only archived swimmers is archived, not live', async () => {
    const t = await cardFor('Tan Family').innerText();
    if (!/Archived/i.test(t))
      throw new Error('archived swimmers read as live: ' + JSON.stringify(t.replace(/\n/g, ' ')));
    const live = await cardFor('Lee Family').innerText();
    if (!/Live/i.test(live)) throw new Error('an active swimmer does not read as live');
    if (/Archived/i.test(live)) throw new Error('a live group is also marked archived');
  });

  await step('the two dead kinds are cleaned separately, never together', async () => {
    const btns = await page.locator('#fg-host button').allInnerTexts();
    const orphan = btns.filter(b => /orphan/i.test(b));
    const unused = btns.filter(b => /never used/i.test(b));
    if (!orphan.length || !unused.length)
      throw new Error('there is no way to clean one kind without the other: ' + JSON.stringify(btns));
    if (btns.some(b => /Clean \d+ empty/i.test(b)))
      throw new Error('the old one-button clean is still there, merging both kinds');
  });

  // ── The syllabus screen ───────────────────────────────────────────────
  // Three levels deep -- programme, level, task -- which is one more than
  // a table can show. The faults worth seeing are a level with no tasks
  // (it would award itself to every child in the programme) and a
  // programme no lesson type points at (it grades nobody).
  const gradingView = () => page.evaluate(() => {
    let host = document.getElementById('gr-host');
    if (!host) { host = document.createElement('div'); host.id = 'gr-host'; document.body.appendChild(host); }
    ReactDOM.createRoot(host).render(React.createElement(GradingAdminView, {
      programs: [
        { id: 'pr1', name: 'Swim Passport', subtitle: 'Learn to Swim', is_active: true,
          syllabus_body: 'Malaysia Aquatics',
          syllabus_name: 'BADGES \u2014 Swimming Proficiency Test',
          syllabus_version: '1.0', syllabus_note: 'A MAS award is separate.' },
        { id: 'pr2', name: 'Water Discovery', subtitle: 'Toddlers', is_active: true }
      ],
      milestones: [
        { id: 'ms1', program_id: 'pr1', level_no: 1, name: 'Guppy', certificate: false, is_active: true },
        { id: 'ms2', program_id: 'pr1', level_no: 2, name: 'Tortoise', certificate: true, is_active: true },
        // Water Discovery needs a level of its own, or the "no levels"
        // empty state fires and the assertion below passes on the wrong
        // sentence -- which is exactly what it did.
        { id: 'ms3', program_id: 'pr2', level_no: 1, name: 'Droplet', certificate: false, is_active: true }
      ],
      tasks: [
        { id: 't1', milestone_id: 'ms1', name: 'Submerges whole head', sort_order: 1, is_active: true },
        { id: 't2', milestone_id: 'ms1', name: 'Blows bubbles', sort_order: 2, is_active: true },
        { id: 't3', milestone_id: 'ms3', name: 'Enters without distress', sort_order: 1, is_active: true }
      ],
      // pr1 is graded by a lesson type; pr2 is pointed at by nothing.
      lessonTypes: [{ id: 'lt1', name: 'Learn to Swim', grading_program_id: 'pr1' }],
      onReload: () => Promise.resolve()
    }));
  });

  await step('the syllabus draws its ladder', async () => {
    await gradingView();
    await page.waitForTimeout(800);
    const t = await page.locator('#gr-host').innerText();
    if (!/Level 1/.test(t) || !/Guppy/.test(t)) throw new Error('no levels drawn: ' + t.slice(0, 200));
    if (!/2 tasks/.test(t)) throw new Error('it does not count the tasks on a level: ' + t.slice(0, 200));
  });

  // ── Which syllabus a programme follows ────────────────────────────────
  // Typed here, printed in the parent app and the coaches' app. The
  // field that needs guarding is the link: it becomes an href on three
  // screens, and `javascript:` in it would be script running in every
  // parent's browser. The column has a CHECK on it too -- but a refusal
  // arriving from PostgREST reads as "could not save" and names no box.
  await step('the programme says which syllabus it follows', async () => {
    const t = await page.locator('#gr-host').innerText();
    if (!/Syllabus: Malaysia Aquatics · BADGES — Swimming Proficiency Test v1\.0/.test(t))
      throw new Error('no credit line on the programme: ' + JSON.stringify(t.slice(0, 400)));
    // Folded away: five text boxes by default would bury the levels.
    if (await page.locator('#gr-host textarea').count())
      throw new Error('the editor is open before anybody asked for it');
  });

  await step('a link that is not a link is refused before it is saved', async () => {
    await page.evaluate(() => fetch('/__patches').then(r => r.json()));
    // "Source" since the screen itself became Syllabus: the panel is
    // where a syllabus comes FROM, and two things called Syllabus on one
    // card is how somebody edits the wrong one.
    await page.locator('#gr-host button').filter({ hasText: /^Source$/ }).first().click();
    await page.waitForTimeout(400);
    const boxes = await page.locator('#gr-host input.input, #gr-host textarea').count();
    if (boxes !== 5) throw new Error('expected five boxes, found ' + boxes);
    const link = page.locator('#gr-host input[placeholder^="https://"]');
    await link.fill('javascript:alert(1)');
    await page.locator('#gr-host button').filter({ hasText: 'Save' }).first().click();
    await page.waitForTimeout(500);
    const t = await page.locator('#gr-host').innerText();
    if (!/must start with http/i.test(t))
      throw new Error('it did not say which box is wrong: ' + JSON.stringify(t.slice(0, 300)));
    const sent = await page.evaluate(() => fetch('/__patches').then(r => r.json()));
    if (sent['/rest/v1/grading_programs'])
      throw new Error('it sent the javascript: URL to the database anyway');
  });

  await step('and a real one saves every column, the emptied ones as null', async () => {
    await page.locator('#gr-host input[placeholder^="https://"]').fill('https://example.org/x');
    // Clearing a box must store null, not the empty string: the apps ask
    // "is there a syllabus" by looking for a value.
    await page.locator('#gr-host textarea').fill('');
    await page.locator('#gr-host button').filter({ hasText: 'Save' }).first().click();
    await page.waitForTimeout(600);
    const sent = await page.evaluate(() => fetch('/__patches').then(r => r.json()));
    const body = sent['/rest/v1/grading_programs'] && sent['/rest/v1/grading_programs'].body;
    if (!body) throw new Error('nothing was sent');
    const want = ['syllabus_body','syllabus_name','syllabus_version','syllabus_url','syllabus_note'];
    for (const k of want)
      if (!(k in body)) throw new Error('the save left out ' + k);
    if (body.syllabus_url !== 'https://example.org/x')
      throw new Error('the link was not saved: ' + JSON.stringify(body.syllabus_url));
    if (body.syllabus_note !== null)
      throw new Error('an emptied box was stored as "" rather than null: '
        + JSON.stringify(body.syllabus_note));
    if (await page.locator('#gr-host textarea').count())
      throw new Error('the panel stayed open after saving');
  });

  // ── Deleting a syllabus ───────────────────────────────────────────────
  // Two stages, and the second one is a word somebody has to type. The
  // thing worth testing is not that the button exists -- it is that the
  // screen never supplies the word itself, and that a syllabus children
  // have been assessed on cannot be deleted at all.
  await step('a syllabus children are on says so before anything is changed', async () => {
    await page.locator('#gr-host button').filter({ hasText: 'Swim Passport' }).first().click();
    await page.waitForTimeout(600);
    const t = await page.locator('#gr-host').innerText();
    if (!/3 swimmers with\s+progress recorded/i.test(t.replace(/\n/g, ' ')))
      throw new Error('the screen does not say who is on it: '
        + JSON.stringify(t.replace(/\n/g, ' ').slice(0, 400)));
    // And it is a reminder, not a gate: everything stays editable.
    const rename = page.locator('#gr-host button').filter({ hasText: /^Rename$/ }).first();
    if (await rename.isDisabled())
      throw new Error('the notice disabled the editing it was only meant to flag');
  });

  await step('delete opens a warning rather than deleting', async () => {
    await page.evaluate(() => fetch('/__deletes').then(r => r.json()));
    await page.locator('#gr-host button').filter({ hasText: /^Delete$/ }).first().click();
    await page.waitForTimeout(400);
    const t = await page.locator('#gr-host').innerText();
    if (!/Delete .Swim Passport.\?/.test(t))
      throw new Error('no warning: ' + JSON.stringify(t.slice(0, 300)));
    const sent = await page.evaluate(() => fetch('/__deletes').then(r => r.json()));
    if (sent.length)
      throw new Error('pressing Delete once already called the database');
  });

  await step('and on a syllabus children are on, there is no way to confirm it', async () => {
    const t = await page.locator('#gr-host').innerText();
    if (!/cannot be deleted/i.test(t))
      throw new Error('it offers to delete a syllabus holding records: '
        + JSON.stringify(t.slice(0, 400)));
    if (!/Turn it off instead/i.test(t))
      throw new Error('it refuses without saying what to do instead');
    if (await page.locator('#gr-host input[placeholder="type delete"]').count())
      throw new Error('the confirmation box is offered for a syllabus that cannot be deleted');
  });

  await step('an unused one asks for the word, and will not act without it', async () => {
    await page.locator('#gr-host button').filter({ hasText: /^Cancel$/ }).first().click();
    await page.locator('#gr-host button').filter({ hasText: 'Water Discovery' }).first().click();
    await page.waitForTimeout(600);
    await page.locator('#gr-host button').filter({ hasText: /^Delete$/ }).first().click();
    await page.waitForTimeout(400);
    const box = page.locator('#gr-host input[placeholder="type delete"]');
    if (!await box.count()) throw new Error('no confirmation box on a deletable syllabus');
    const go = page.locator('#gr-host button').filter({ hasText: 'Delete for good' }).first();
    if (!await go.isDisabled())
      throw new Error('it would delete with nothing typed');
    await box.fill('yes');
    await page.waitForTimeout(200);
    if (!await go.isDisabled())
      throw new Error('the wrong word was accepted');
    const sent = await page.evaluate(() => fetch('/__deletes').then(r => r.json()));
    if (sent.length) throw new Error('it called the database while the word was wrong');
  });

  await step('and the word somebody typed is what reaches the database', async () => {
    await page.locator('#gr-host input[placeholder="type delete"]').fill('delete');
    await page.waitForTimeout(200);
    await page.locator('#gr-host button').filter({ hasText: 'Delete for good' }).first().click();
    await page.waitForTimeout(700);
    const sent = await page.evaluate(() => fetch('/__deletes').then(r => r.json()));
    if (sent.length !== 1)
      throw new Error('expected one call, saw ' + sent.length);
    if (sent[0].p_program !== 'pr2')
      throw new Error('it deleted the wrong syllabus: ' + JSON.stringify(sent[0]));
    // Passed through, not supplied. A screen that sends 'delete' of its
    // own accord has a confirmation that confirms nothing.
    if (sent[0].p_confirm !== 'delete')
      throw new Error('the typed word did not reach the database: ' + JSON.stringify(sent[0]));
  });

  await step('a level with no tasks says it awards nothing', async () => {
    const t = await page.locator('#gr-host').innerText();
    if (!/awards nothing/i.test(t))
      throw new Error('an empty level looks finished, and would be handed to every child: '
                      + JSON.stringify(t.slice(0, 300)));
  });

  await step('and a programme nothing points at says it grades nobody', async () => {
    await page.locator('#gr-host button').filter({ hasText: 'Water Discovery' }).first().click();
    await page.waitForTimeout(400);
    const t = await page.locator('#gr-host').innerText();
    // The exact phrase, not "grades nobody" -- the empty-state sentence
    // for a programme with no levels ends in those same two words.
    if (!/no lesson type points at this/i.test(t))
      throw new Error('an unused programme looks live: ' + JSON.stringify(t.slice(0, 300)));
  });

  await step('a level that offers a certificate is marked as one', async () => {
    await page.locator('#gr-host button').filter({ hasText: 'Swim Passport' }).first().click();
    await page.waitForTimeout(400);
    const t = await page.locator('#gr-host').innerText();
    if (!/CERTIFICATE/.test(t)) throw new Error('the certificate level is not marked');
  });

  // ── Certificates ──────────────────────────────────────────────────────
  // The parent app tells a family one is waiting. Until this existed
  // nothing could record it being handed over, so the app would say it
  // for ever and the only defence against printing a second one was
  // somebody's memory of a Saturday morning.
  const certPanel = () => page.evaluate(() => {
    let host = document.getElementById('ct-host');
    if (!host) { host = document.createElement('div'); host.id = 'ct-host'; document.body.appendChild(host); }
    ReactDOM.createRoot(host).render(React.createElement(CertificatesPanel));
  });

  await step('the office list shows who is owed one', async () => {
    await certPanel();
    await page.waitForTimeout(900);
    const t = await page.locator('#ct-host').innerText();
    if (!/Waiting \(1\)/.test(t)) throw new Error('the waiting count is wrong: ' + t.slice(0, 160));
    if (!/Given \(1\)/.test(t)) throw new Error('the given count is wrong: ' + t.slice(0, 160));
    if (!/Mira Kwan/.test(t)) throw new Error('the swimmer owed one is not listed');
  });

  await step('and a certificate already handed over is not in the waiting list', async () => {
    const t = await page.locator('#ct-host').innerText();
    if (/Kobe Kwan/.test(t))
      throw new Error('somebody who already has theirs is still being chased');
  });

  await step('the given tab names who handed it over', async () => {
    await page.locator('#ct-host button').filter({ hasText: /^Given/ }).click();
    await page.waitForTimeout(400);
    const t = await page.locator('#ct-host').innerText();
    if (!/Kobe Kwan/.test(t)) throw new Error('the given list is empty');
    if (!/Coach Sally/.test(t))
      throw new Error('it does not say who handed it over: ' + JSON.stringify(t.slice(0, 200)));
  });

  // ── Telling a dropdown from a text box ────────────────────────────────
  // The lesson-type form has six dropdowns among a dozen inputs and they
  // were drawn identically, so finding which offered a choice meant
  // clicking each one. Asserted on computed style rather than on the
  // stylesheet: a rule that exists and does not apply is the fault.
  await step('a dropdown does not look like a text box', async () => {
    const r = await page.evaluate(() => {
      const host = document.createElement('div');
      host.innerHTML = '<input class="input" id="probe-i">'
                     + '<select class="input" id="probe-s"><option>a</option></select>';
      document.body.appendChild(host);
      const g = (id) => {
        const c = getComputedStyle(document.getElementById(id));
        return { bg: c.backgroundColor, border: c.borderTopColor,
                 img: c.backgroundImage, pad: c.paddingRight };
      };
      const out = { input: g('probe-i'), select: g('probe-s') };
      host.remove();
      return out;
    });
    if (r.input.bg === r.select.bg && r.input.border === r.select.border)
      throw new Error('a select and a text input are drawn identically: '
                      + JSON.stringify(r.select));
    if (!/url\(/.test(r.select.img))
      throw new Error('the dropdown has no chevron of its own: ' + r.select.img);
    if (parseFloat(r.select.pad) <= parseFloat(r.input.pad))
      throw new Error('nothing is reserved for the chevron, so it will sit on the text');
  });

  // ── The lesson type's syllabus ────────────────────────────────────────
  // This is the connection that makes any of the grading work: a swimmer
  // follows whichever syllabus their lesson type points at. The dropdown
  // was there, the draft held the choice, and Apply Changes dropped it on
  // the floor -- so the panel looked like it had saved until it was
  // reopened, and every syllabus read "0 lesson type(s)".
  await step('choosing a syllabus on a lesson type actually saves it', async () => {
    await page.evaluate(() => {
      let host = document.getElementById('lt-host');
      if (!host) { host = document.createElement('div'); host.id = 'lt-host';
                   document.body.appendChild(host); }
      window.__saved = null;
      ReactDOM.createRoot(host).render(React.createElement(LessonTypeEditor, {
        row: { id: 'lt1', name: 'LTS Group', grading_program_id: null,
               billing_model: 'monthly', class_type: 'group',
               programme_type: 'lessons' },
        pools: [{ id: 'po1', name: 'SSGT Pool A' }],
        gradingPrograms: [
          { id: 'pr1', name: 'Swim Passport', subtitle: 'Learn to Swim', is_active: true },
          { id: 'pr2', name: 'MAS BADGES', is_active: true }
        ],
        onSave: (p) => { window.__saved = p; }
      }));
    });
    await page.waitForTimeout(700);
    const sel = page.locator('#lt-host select').filter({ hasText: 'Swim Passport' }).first();
    await sel.selectOption('pr1');
    await page.locator('#lt-host button').filter({ hasText: 'Apply Changes' }).first().click();
    await page.waitForTimeout(400);
    const saved = await page.evaluate(() => window.__saved);
    if (!saved) throw new Error('Apply Changes sent nothing at all');
    if (!('grading_program_id' in saved))
      throw new Error('the payload has no grading_program_id — the syllabus is dropped '
        + 'on save: ' + JSON.stringify(Object.keys(saved)));
    if (saved.grading_program_id !== 'pr1')
      throw new Error('it saved ' + JSON.stringify(saved.grading_program_id)
        + ' instead of the syllabus that was chosen');
  });

  await step('and clearing it back to no syllabus saves null, not ""', async () => {
    await page.locator('#lt-host select').filter({ hasText: 'Swim Passport' })
      .first().selectOption('');
    await page.locator('#lt-host button').filter({ hasText: 'Apply Changes' }).first().click();
    await page.waitForTimeout(400);
    const saved = await page.evaluate(() => window.__saved);
    // The column is a uuid foreign key. '' is not a uuid and PostgREST
    // rejects it, which reads as "could not save" and names no field.
    if (saved.grading_program_id !== null)
      throw new Error('clearing the syllabus sent '
        + JSON.stringify(saved.grading_program_id) + ', which the column will refuse');
  });

  // The general form of the same bug: a field with a control, a draft
  // entry, and no line in the payload. Checked against the source rather
  // than by clicking twenty-one controls.
  await step('every field the lesson-type panel edits is in what it saves', async () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
    const i = src.indexOf('function LessonTypeEditor(');
    if (i < 0) throw new Error('LessonTypeEditor is not in app.js any more');
    const body = src.slice(i, src.indexOf('\n}', src.indexOf('Apply Changes', i)));
    const edits = new Set([...body.matchAll(/setF\('([a-z_]+)'/g)].map(m => m[1]));
    if (edits.size < 15)
      throw new Error('only found ' + edits.size + ' edited fields, so this is '
        + 'reading the wrong part of the file and would pass whatever happened');
    const payload = body.slice(body.indexOf('onSave({'));
    const missing = [...edits].filter(k => !new RegExp('\\n\\s*' + k + ':').test(payload));
    if (missing.length)
      throw new Error('edited but never saved: ' + missing.join(', '));
  });

  // ── Grading from the scheduler ────────────────────────────────────────
  // An owner teaching a class could see the swimmers and had no way to
  // tick anything, so a level earned in their own lesson had to be
  // entered from a coach's phone. The database always allowed it --
  // can_note_on_student() returns true for any office seat before it
  // looks at rosters at all -- so this was a missing screen.
  const gradePanel = (studentId) => page.evaluate((id) => {
    let host = document.getElementById('gp-host');
    if (!host) { host = document.createElement('div'); host.id = 'gp-host';
                 document.body.appendChild(host); }
    ReactDOM.createRoot(host).render(React.createElement(StudentGradingPanel, {
      studentId: id, studentName: 'Mira Kwan', sessionId: 'se1', onClose: () => {}
    }));
  }, studentId);

  await step('the scheduler can draw a swimmer\u2019s ladder', async () => {
    await gradePanel('s1');
    await page.waitForTimeout(900);
    const t = await page.locator('#gp-host').innerText();
    if (!/Water Discovery/.test(t) || !/Water Explorer/.test(t))
      throw new Error('no ladder drawn: ' + JSON.stringify(t.slice(0, 200)));
    if (!/Ticks save immediately/.test(t))
      throw new Error('it does not say the ticks are not part of the modal\u2019s Save, '
        + 'which is how somebody cancels out of a class and thinks the grading went too');
  });

  await step('and a tick reaches the database, not just the screen', async () => {
    await page.locator('#gp-host .grade-ms-head').first().click();
    await page.waitForTimeout(400);
    const first = page.locator('#gp-host .grade-task').first();
    if (await first.evaluate(e => /is-done/.test(e.className)))
      throw new Error('the fixture starts with a tick already, so this proves nothing');
    await first.click();
    await page.waitForTimeout(700);
    const sent = await page.evaluate(() => fetch('/__marks').then(r => r.json()));
    if (sent.length !== 1) throw new Error('expected one call, saw ' + sent.length);
    if (sent[0].p_student !== 's1' || sent[0].p_on !== true)
      throw new Error('the wrong call was sent: ' + JSON.stringify(sent[0]));
    // The session is recorded with the mark, so a parent reading it later
    // can be told which lesson it was seen in.
    if (sent[0].p_session !== 'se1')
      throw new Error('the mark does not say which class it was made in: '
        + JSON.stringify(sent[0].p_session));
    // And the panel re-read the server rather than trusting itself.
    if (!await page.locator('#gp-host .grade-task.is-done').count())
      throw new Error('the tick did not come back from the reload');
  });

  await step('and unticking it sends the other direction', async () => {
    await page.locator('#gp-host .grade-task').first().click();
    await page.waitForTimeout(700);
    const sent = await page.evaluate(() => fetch('/__marks').then(r => r.json()));
    if (sent.length !== 2) throw new Error('the untick sent nothing');
    if (sent[1].p_on !== false)
      throw new Error('unticking sent p_on ' + JSON.stringify(sent[1].p_on));
    if (await page.locator('#gp-host .grade-task.is-done').count())
      throw new Error('it still reads as done after being unticked');
  });

  await step('a swimmer with no syllabus is told so, not shown an empty ladder', async () => {
    await gradePanel('ungraded');
    await page.waitForTimeout(900);
    const t = await page.locator('#gp-host').innerText();
    if (!/no syllabus/i.test(t))
      throw new Error('it does not say why there is nothing to tick: '
        + JSON.stringify(t.slice(0, 200)));
    if (!/Settings/.test(t))
      throw new Error('it does not say where to fix it');
  });

  await step('no JS errors', async () => { if (errs.length) throw new Error(errs[0]); });

  console.log(fail ? fail + ' FAILED' : 'all green');
  await b.close();
  process.exit(fail ? 1 : 0);
})();
