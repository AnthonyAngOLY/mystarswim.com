// ─────────────────────────────────────────────────────────────────────────
// An alerts row keeps one bottom edge, and a name keeps one line.
//
//   node tests/tablerow.test.js        (browser, no mock, no server)
//
// Two faults, both visible in the same screenshot and neither obvious
// from reading the source.
//
// ONE. The "Reason given" column is clamped to two lines. Written as
// display:-webkit-box on the <td>, that stops the element being a
// table-cell: it leaves the row's height and draws its own border-bottom
// wherever its own content ends. While every column is one line this is
// invisible. The moment the first column wraps, the row grows, that cell
// does not, and its rule sits at a different level from the rest.
//
// TWO. The fix for the wrapping name looked like widening the column.
// It is not. Under auto table-layout a width on a cell is a MINIMUM, and
// a squeezed table ignores it: measured at a 620px table, a cell asking
// for 150px was handed 78px and the name broke in half. white-space:
// nowrap is what actually holds it, which is what the three columns
// after it already do.
//
// The assertions are geometric because that is where both faults live. A
// test that reads the source can be satisfied by markup that looks right
// and lays out wrong, which is exactly how these shipped.
//
// Each fix is paired with its own sabotage — the broken markup, measured,
// at a width where it really does break. A sabotage that passes means the
// measurement cannot see the fault and the test proves nothing.
// ─────────────────────────────────────────────────────────────────────────
'use strict';

const fs   = require('fs');
const path = require('path');
const B    = require('./browser');

const ROOT = path.resolve(__dirname, '..');

// The real rule from app.html, verbatim. Measuring against a stylesheet
// the app does not serve would prove nothing about the app.
const CELL_RULE = (fs.readFileSync(path.join(ROOT, 'app.html'), 'utf8')
                     .match(/th,td\{[^}]*\}/) || [])[0];

const LONG   = "Mohd Fakhri bin Ma'amon";   // the name in the report
const CLAMP  = 'display:-webkit-box;-webkit-line-clamp:2;'
             + '-webkit-box-orient:vertical;overflow:hidden;line-height:1.35';
const REASON = 'Today 2:15 at Sbis So I leave GT at 1:30pm and more text to '
             + 'fill this cell up well past two lines of wrapping';

// The five columns of the alerts table, with the three that are already
// nowrap kept nowrap, so the squeeze falls where it really falls.
function doc(o) {
  const nameStyle = 'width:' + o.width + 'px;font-weight:600'
                  + (o.nowrap ? ';white-space:nowrap' : '');
  const reasonCell = o.clampOnCell
    ? '<td class="r" style="' + CLAMP + '">' + REASON + '</td>'
    : '<td class="r"><div style="' + CLAMP + '">' + REASON + '</div></td>';
  return '<!doctype html><meta charset="utf-8"><style>'
       + 'body{margin:0;font-family:Inter,sans-serif}'
       + 'table{width:' + o.table + 'px;border-collapse:collapse}' + CELL_RULE
       + '</style><table><tbody><tr>'
       + '<td class="w" style="' + nameStyle + '">' + LONG + '</td>'
       + '<td class="a" style="width:130px;white-space:nowrap">Late check-in 14m/2m</td>'
       + '<td class="s" style="width:235px;white-space:nowrap">11-04 · 12:00–15:00 · SSGT</td>'
       + reasonCell
       + '<td class="o" style="width:200px;white-space:nowrap">✓ Time entered · Full deduction</td>'
       + '</tr></tbody></table>';
}

let page;
async function cells(o) {
  await page.setContent(doc(o));
  return page.$$eval('td', tds => tds.map(td => {
    const r = td.getBoundingClientRect();
    return { cls: td.className, width: Math.round(r.width),
             height: Math.round(r.height), bottom: Math.round(r.bottom) };
  }));
}
const spread = (cs) => Math.max(...cs.map(c => c.bottom))
                     - Math.min(...cs.map(c => c.bottom));
const nameCell = (cs) => cs.find(c => c.cls === 'w');

// Every width the table is plausibly laid out at, narrow enough to squeeze
// through wide enough not to.
const WIDTHS = [620, 720, 820, 900, 1100];

let fail = 0;
const step = (n, f) => Promise.resolve().then(f)
  .then(() => console.log('PASS  ' + n))
  .catch(e => { console.log('FAIL  ' + n + ' -> ' + String(e.message).split('\n')[0]); fail++; });
const eq = (a, b, m) => { if (a !== b) throw new Error(m + ' — got ' + a + ', wanted ' + b); };
const ok = (c, m) => { if (!c) throw new Error(m); };

(async () => {
  ok(CELL_RULE && /vertical-align/.test(CELL_RULE),
     'could not find the th,td rule in app.html');

  const browser = await B.launch({ args: ['--headless', '--no-sandbox'] });
  page = await browser.newPage();
  await page.setViewportSize({ width: 1400, height: 800 });

  // ── One: the row's bottom edge ────────────────────────────────────────
  await step('clamping the cell itself really does break the row (sabotage)', async () => {
    const bad = await cells({ table: 620, width: 150, clampOnCell: true, nowrap: false });
    ok(spread(bad) > 2,
       'the clamped cell lined up anyway, so this measurement cannot see the fault');
  });

  for (const table of WIDTHS) {
    await step('with the clamp on a div, every cell ends level at ' + table + 'px', async () => {
      const cs = await cells({ table, width: 200, clampOnCell: false, nowrap: true });
      eq(spread(cs), 0, 'cells ended at different heights');
    });
  }

  // ── Two: the name stays on one line ───────────────────────────────────
  // One line is whatever the cell measures when the table has room to
  // spare, rather than a pixel count that changes with the font.
  const oneLine = nameCell(await cells({ table: 1100, width: 200,
                                         clampOnCell: false, nowrap: true })).height;

  await step('a width alone does not hold the name, when squeezed (sabotage)', async () => {
    const cs = await cells({ table: 620, width: 200, clampOnCell: false, nowrap: false });
    ok(nameCell(cs).height > oneLine,
       'it stayed on one line without nowrap, so nowrap is not what is holding it');
    ok(nameCell(cs).width < 200,
       'the cell kept its 200px, so this table is not squeezed and proves nothing');
  });

  for (const table of WIDTHS) {
    await step('nowrap keeps "' + LONG + '" on one line at ' + table + 'px', async () => {
      const cs = await cells({ table, width: 200, clampOnCell: false, nowrap: true });
      eq(nameCell(cs).height, oneLine, 'the name wrapped');
    });
  }

  // ── The source, so neither fault can quietly return ───────────────────
  const src = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');

  await step('no <td> in app.js sets a display mode', () => {
    ok(!/<td[^>]*style=\{\{[^}]*display:\s*'-webkit-box'/.test(src),
       'a <td> carries display:-webkit-box again');
  });

  await step('the alerts worker cell is nowrap', () => {
    ok(/whiteSpace:'nowrap',\s*\n\s*borderLeft:`3px solid/.test(src),
       'the worker cell lost its nowrap');
  });

  await step('app.compiled.js carries both fixes', () => {
    const out = fs.readFileSync(path.join(ROOT, 'app.compiled.js'), 'utf8');
    ok(out.includes("whiteSpace: 'nowrap'"), 'nowrap is not in the built bundle');
    // Flattened, then read forward from the cell's own title prop: the
    // next element created has to be the div that carries the clamp. A
    // regex spanning the whole cell is a regex about Babel's whitespace.
    const flat = out.replace(/\s+/g, ' ');
    const at   = flat.indexOf("title: [reason, note && 'Note: ' + note]");
    ok(at !== -1, 'could not find the reason cell in the bundle');
    const after = flat.slice(at, at + 220);
    const from  = after.indexOf('React.createElement(');
    // Before the fix the cell carried the clamp as its own style object,
    // which is long enough that no element starts within 220 characters.
    ok(from !== -1, 'the reason cell creates no child element — the clamp is '
                  + 'still a style on the cell itself');
    const next  = after.slice(from);
    ok(next.startsWith('React.createElement("div"'),
       'the first thing inside the reason cell is ' +
       (next.slice(0, 40) || 'nothing') + ', not the div that carries the clamp');
  });

  await browser.close();
  console.log(fail ? fail + ' failed' : 'all green');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
