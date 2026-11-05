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

  // ── declare: the catch-up health declaration ──────────────────────
  // Every family who joined before the intake form asked the six
  // questions has nothing on file, while the terms they signed declare
  // on their behalf that there is nothing to tell. This is how they
  // discharge that without enrolling anybody again.
  const MINE = [{ id: 'stu-1', name: 'Aaryan' }, { id: 'stu-2', name: 'Mira' }];
  const NO_TO_ALL = { supervision: false, chestPain: false, boneJoint: false,
                      medication: false, learning: false, other: false };

  const declareClient = (opts) => stubClient(Object.assign({
    rpc: { find_account: async () => ({ data: FOUND, error: null }) },
    rows: { students: { data: MINE, error: null } }
  }, opts || {}));

  const declare = (client, body) => post(load(client, ENV), Object.assign({
    action: 'declare', accountNo: 'LEE-2394', accountPhone: '0123456001',
    signatureName: 'Lee Oy Yin'
  }, body));

  await step('a declaration is recorded against the children on the account', async () => {
    const c = declareClient();
    const r = await declare(c, { children: [{ id: 'stu-1', health: NO_TO_ALL }] });
    if (r.body.ok !== true) throw new Error('refused: ' + JSON.stringify(r.body));
    const w = c.calls.insert.filter(x => x[0] === 'student_health_declarations');
    if (w.length !== 1) throw new Error('wrote ' + w.length + ' declarations');
    if (w[0][1].student_id !== 'stu-1') throw new Error('filed against ' + w[0][1].student_id);
    if (w[0][1].q_chest_pain !== false) throw new Error('the answers did not travel');
  });

  // The one that matters. A browser can send any id it likes; the only
  // thing standing between that and a health record on another family's
  // child is this intersection.
  await step("a child who is not on the account is never written", async () => {
    const c = declareClient();
    const r = await declare(c, { children: [
      { id: 'stu-1', health: NO_TO_ALL },
      { id: 'someone-elses-child', health: NO_TO_ALL }
    ] });
    if (r.body.ok !== true) throw new Error('refused: ' + JSON.stringify(r.body));
    const w = c.calls.insert.filter(x => x[0] === 'student_health_declarations');
    if (w.length !== 1) throw new Error('wrote ' + w.length + ', should have dropped the stranger');
    if (w.some(x => x[1].student_id === 'someone-elses-child'))
      throw new Error('a declaration was filed against another family');
  });

  await step('the account number and phone are proved again on this call', async () => {
    const c = stubClient({
      rpc: { find_account: async () => ({ data: { ok: false, error: 'That account number and phone number do not go together.' }, error: null }) },
      rows: { students: { data: MINE, error: null } }
    });
    const r = await declare(c, { children: [{ id: 'stu-1', health: NO_TO_ALL }] });
    if (r.status !== 403) throw new Error('status ' + r.status);
    if (c.calls.insert.length) throw new Error('it wrote anyway');
  });

  // Unanswered is not no. A declaration stored with nulls reads as asked
  // and answered, which is worse than no declaration at all.
  await step('an unanswered question is refused, not stored as no', async () => {
    const c = declareClient();
    const half = Object.assign({}, NO_TO_ALL); delete half.learning;
    const r = await declare(c, { children: [{ id: 'stu-1', health: half }] });
    if (r.body.ok === true) throw new Error('a half-answered declaration was accepted');
    if (c.calls.insert.length) throw new Error('it wrote a partial declaration');
  });

  await step('a yes with nothing written is refused', async () => {
    const c = declareClient();
    const r = await declare(c, { children: [{ id: 'stu-1',
      health: Object.assign({}, NO_TO_ALL, { learning: true }) }] });
    if (r.body.ok === true) throw new Error('a bare yes was accepted');
    if (c.calls.insert.length) throw new Error('it wrote a yes with no detail');
  });

  await step('a yes with a detail is recorded', async () => {
    const c = declareClient();
    const r = await declare(c, { children: [{ id: 'stu-1',
      health: Object.assign({}, NO_TO_ALL, { learning: true, details: 'Mild ADHD; needs instructions one at a time.' }) }] });
    if (r.body.ok !== true) throw new Error('refused: ' + JSON.stringify(r.body));
    const w = c.calls.insert.filter(x => x[0] === 'student_health_declarations')[0][1];
    if (w.q_learning !== true) throw new Error('the yes did not travel');
    if (!/one at a time/.test(w.details || '')) throw new Error('the detail did not travel');
  });

  await step('one signing covers the children in it, under one reference', async () => {
    const c = declareClient();
    const r = await declare(c, { children: [
      { id: 'stu-1', health: NO_TO_ALL }, { id: 'stu-2', health: NO_TO_ALL }] });
    if (!/^HD-/.test(r.body.reference || '')) throw new Error('no reference: ' + JSON.stringify(r.body));
    const w = c.calls.insert.filter(x => x[0] === 'student_health_declarations');
    if (w.length !== 2) throw new Error('wrote ' + w.length);
    if (w[0][1].acceptance_id !== w[1][1].acceptance_id)
      throw new Error('two children in one signing got two references');
    if (w[0][1].declared_by !== 'Lee Oy Yin') throw new Error('the signature was not recorded');
  });

  await step('a declaration will not be signed without a name', async () => {
    const c = declareClient();
    const r = await declare(c, { signatureName: '', children: [{ id: 'stu-1', health: NO_TO_ALL }] });
    if (r.status !== 400) throw new Error('status ' + r.status);
    if (c.calls.insert.length) throw new Error('it wrote an unsigned declaration');
  });

  await step('the lookup hands back the children with their ids', async () => {
    const c = declareClient();
    const r = await post(load(c, ENV), { action: 'lookup', accountNo: 'LEE-2394', accountPhone: '0123456001' });
    if (!Array.isArray(r.body.childList)) throw new Error('no childList: ' + JSON.stringify(r.body));
    if (r.body.childList.length !== 2) throw new Error('got ' + r.body.childList.length);
    if (r.body.childList[0].id !== 'stu-1') throw new Error('no id on the child');
    // The old key has to survive unchanged: the intake form deployed
    // right now reads it as an array of names.
    if (!Array.isArray(r.body.children) || typeof r.body.children[0] !== 'string')
      throw new Error('the children key changed shape and would break the intake form');
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
