// ─────────────────────────────────────────────────────────────────────────
// public-intake: the lookup route, run rather than read.
//
//   node tests/edgefn.test.js        (no mock server; it needs none)
//
// The first assertion is the one that matters. It does not check a
// message or a shape; it checks that a lookup answers at all. That is
// what was broken in a function that had been deployed.
// ─────────────────────────────────────────────────────────────────────────
'use strict';

const { load, post, stubClient } = require('./edgefn');

const ENV = { SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'service-role' };

const FOUND = {
  ok: true, account_id: 'acct-1', account_no: 'LEE-2394',
  display_name: 'Lee Oy Yin', children: ['Aaryan', 'Mira']
};

(async () => {
  let fail = 0;
  const step = async (n, f) => {
    try { await f(); console.log('PASS  ' + n); }
    catch (e) { console.log('FAIL  ' + n + ' -> ' + String(e.message).split('\n')[0]); fail++; }
  };

  const withFind = (answer) => stubClient({ rpc: { find_account: async () => answer } });

  await step('a lookup answers instead of throwing', async () => {
    const h = load(withFind({ data: FOUND, error: null }), ENV);
    const r = await post(h, { action: 'lookup', accountNo: 'LEE-2394', accountPhone: '0123456001' });
    if (r.status !== 200) throw new Error('status ' + r.status + ': ' + JSON.stringify(r.body));
    if (!r.body || r.body.ok !== true) throw new Error('not ok: ' + JSON.stringify(r.body));
  });

  await step('it names the family and their children', async () => {
    const h = load(withFind({ data: FOUND, error: null }), ENV);
    const r = await post(h, { action: 'lookup', accountNo: 'LEE-2394', accountPhone: '0123456001' });
    if (r.body.displayName !== 'Lee Oy Yin') throw new Error('no name: ' + JSON.stringify(r.body));
    if (!Array.isArray(r.body.children) || r.body.children.length !== 2)
      throw new Error('no children: ' + JSON.stringify(r.body));
  });

  await step('it never hands back the account id', async () => {
    const h = load(withFind({ data: FOUND, error: null }), ENV);
    const r = await post(h, { action: 'lookup', accountNo: 'LEE-2394', accountPhone: '0123456001' });
    const s = JSON.stringify(r.body);
    if (/acct-1/.test(s) || /account_?[Ii]d/.test(s))
      throw new Error('the account id escaped: ' + s);
  });

  await step('the account number is upper-cased before it is looked up', async () => {
    const client = withFind({ data: FOUND, error: null });
    const h = load(client, ENV);
    await post(h, { action: 'lookup', accountNo: '  lee-2394  ', accountPhone: '0123456001' });
    const args = client.calls.rpc.find(c => c[0] === 'find_account')[1];
    if (args.p_account_no !== 'LEE-2394') throw new Error('sent ' + JSON.stringify(args.p_account_no));
  });

  await step('a refusal comes back as the database worded it, in one sentence', async () => {
    const h = load(withFind({ data: { ok: false, error: 'That account number and phone number do not go together.' }, error: null }), ENV);
    const r = await post(h, { action: 'lookup', accountNo: 'ZZZZ-0000', accountPhone: '0100000000' });
    if (r.body.ok !== false) throw new Error('a wrong pair was accepted');
    if (!/do not go together/.test(r.body.error)) throw new Error('reworded: ' + r.body.error);
  });

  // A lookup must not be answerable with either half alone, and the two
  // failures must read the same. Enforced in the database; asserted here
  // because this function is what the open internet reaches.
  await step('the database decides, and this function does not second-guess it', async () => {
    const h = load(withFind({ data: { ok: false, error: 'Enter the account number and a phone number on the account.' }, error: null }), ENV);
    const r = await post(h, { action: 'lookup', accountNo: 'LEE-2394', accountPhone: '' });
    if (r.body.ok !== false) throw new Error('a half-pair was accepted');
  });

  await step('a lookup that errors says so without blaming the parent', async () => {
    const h = load(withFind({ data: null, error: { message: 'permission denied for function find_account' } }), ENV);
    const r = await post(h, { action: 'lookup', accountNo: 'LEE-2394', accountPhone: '0123456001' });
    if (r.body.ok !== false) throw new Error('an error read as a match');
    if (/permission denied/.test(r.body.error)) throw new Error('the database error reached the parent: ' + r.body.error);
  });

  // The lookup is asked before the parent has typed anything else, so it
  // must come before every required-field check. It sat below the
  // guardian-name one once, and answered "enter the parent's full name".
  await step('a lookup is answered before any field is demanded', async () => {
    const h = load(withFind({ data: FOUND, error: null }), ENV);
    const r = await post(h, { action: 'lookup', accountNo: 'LEE-2394', accountPhone: '0123456001' });
    if (r.body.ok !== true) throw new Error('refused: ' + JSON.stringify(r.body));
    if (r.body.error) throw new Error('asked for something else: ' + r.body.error);
  });

  await step('a registration with no swimmers is still refused', async () => {
    const h = load(stubClient({}), ENV);
    const r = await post(h, { guardianName: 'Lee Oy Yin', guardianPhone: '0123456001', children: [] });
    if (r.status !== 400) throw new Error('status ' + r.status);
    if (!/at least one swimmer/i.test(r.body.error || '')) throw new Error(r.body.error);
  });

  console.log(fail ? fail + ' FAILED' : 'all green');
  process.exit(fail ? 1 : 0);
})();
