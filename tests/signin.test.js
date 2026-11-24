// ─────────────────────────────────────────────────────────────────────────
// parent-signin: which channel the code actually goes out on.
//
//   node tests/signin.test.js        (no mock server; it needs none)
//
// WHY
// This function asked Supabase for "whatsapp" for months. That was the
// intention when it was written and it never became true: what is
// registered is an international long code, a Twilio Messaging Service
// and a Supabase Phone provider — all SMS, no WhatsApp sender anywhere.
//
// It survived unnoticed because of how it fails. Asking Twilio for a
// channel it has no sender for is not refused cleanly; the request can be
// accepted and dropped afterwards. Supabase answers 200, this function
// reports success, the app tells a parent the code is on its way, and
// nothing arrives. The fault reads as "SMS is broken" when SMS was never
// tried — which is exactly the wrong place to go looking.
//
// Seventeen mentions of WhatsApp were corrected across the parent guides
// in the same week without anybody opening this file, which is the real
// lesson: prose describing a behaviour drifts from the behaviour unless
// something executes the behaviour. So these assertions read the body
// this function would have PUT ON THE WIRE, not the comment above it.
// ─────────────────────────────────────────────────────────────────────────
'use strict';

const { load, stubClient } = require('./edgefn');

const ENV = { SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'service-role',
              SUPABASE_ANON_KEY: 'anon' };

const ON_FILE = { data: [{ id: 'acct-1', phone_primary: '+60125243477',
                           phone_secondary: null, active_phone: 'primary' }], error: null };

(async () => {
  let fail = 0;
  const step = async (n, f) => {
    try { await f(); console.log('PASS  ' + n); }
    catch (e) { console.log('FAIL  ' + n + ' -> ' + String(e.message).split('\n')[0]); fail++; }
  };

  // Builds a handler whose outbound fetch is captured rather than sent.
  // `fail` makes the first send fail, so the fallback can be exercised.
  function signin(rows, env, failFirst) {
    const sent = [];
    const fetcher = async (url, init) => {
      let body = null;
      try { body = JSON.parse(init && init.body); } catch (_e) { body = null; }
      sent.push({ url: String(url), body: body });
      const ok = !(failFirst && sent.length === 1);
      return { ok: ok, status: ok ? 200 : 400, text: async () => ok ? '' : 'no sender' };
    };
    const handler = load(stubClient({ rows: { parent_accounts: rows } }),
                         Object.assign({}, ENV, env || {}),
                         { fn: 'parent-signin', fetch: fetcher });
    return {
      sent: sent,
      call: async (phone) => {
        const res = await handler(new Request('https://x/functions/v1/parent-signin', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ phone: phone })
        }));
        let json = null;
        try { json = JSON.parse(await res.text()); } catch (_e) { json = null; }
        return { status: res.status, body: json };
      }
    };
  }

  // ── The one that matters ──────────────────────────────────────────────
  await step('with nothing configured, the code goes out by SMS', async () => {
    const s = signin(ON_FILE);
    const r = await s.call('012 524 3477');
    if (!s.sent.length) throw new Error('no send was attempted at all');
    const ch = s.sent[0].body && s.sent[0].body.channel;
    if (ch !== 'sms')
      throw new Error('asked Supabase for "' + ch + '", and there is no sender for it');
    if (r.body.channel !== 'sms')
      throw new Error('told the app it went by ' + JSON.stringify(r.body.channel));
  });

  await step('and it says SMS to the app, which is what the app shows the parent', async () => {
    const s = signin(ON_FILE);
    const r = await s.call('012 524 3477');
    if (r.body.known !== true) throw new Error('a number on file was not treated as known');
    if (r.status !== 200) throw new Error('status ' + r.status);
  });

  await step('the number it sends to is the one it looked up, in E.164', async () => {
    const s = signin(ON_FILE);
    await s.call('012-524 3477');
    if (s.sent[0].body.phone !== '+60125243477')
      throw new Error('sent to ' + JSON.stringify(s.sent[0].body.phone));
  });

  // ── Nothing is sent to a number that is not ours ──────────────────────
  await step('an unknown number costs nothing, because nothing is sent', async () => {
    const s = signin({ data: [], error: null });
    const r = await s.call('012 999 0000');
    if (s.sent.length) throw new Error('it sent a message to a number not on file');
    if (r.body.known !== false) throw new Error('an unknown number was reported as known');
  });

  await step('a number on two accounts is refused rather than guessed at', async () => {
    const s = signin({ data: [{ id: 'a' }, { id: 'b' }], error: null });
    const r = await s.call('012 524 3477');
    if (s.sent.length) throw new Error('it sent a code without knowing whose family it was');
    if (!/two accounts/i.test(r.body.error || '')) throw new Error('it did not say why');
  });

  await step('an auth user is only ever created after the lookup passed', async () => {
    const s = signin(ON_FILE);
    await s.call('012 524 3477');
    if (s.sent[0].body.create_user !== true)
      throw new Error('create_user was not set, so a first-time parent cannot sign in');
    const no = signin({ data: [], error: null });
    await no.call('012 999 0000');
    if (no.sent.length) throw new Error('an account was created for a stranger');
  });

  // ── WhatsApp, if it is ever actually registered ───────────────────────
  await step('asking for WhatsApp still works, for the day there is a sender', async () => {
    const s = signin(ON_FILE, { PARENT_OTP_CHANNEL: 'whatsapp' });
    const r = await s.call('012 524 3477');
    if (s.sent[0].body.channel !== 'whatsapp')
      throw new Error('the override was ignored: ' + JSON.stringify(s.sent[0].body.channel));
    if (r.body.channel !== 'whatsapp') throw new Error('it reported the wrong channel');
  });

  await step('a failed WhatsApp send falls back to SMS and says so', async () => {
    const s = signin(ON_FILE, { PARENT_OTP_CHANNEL: 'whatsapp' }, true);
    const r = await s.call('012 524 3477');
    if (s.sent.length !== 2) throw new Error('it did not try again: ' + s.sent.length + ' send(s)');
    if (s.sent[1].body.channel !== 'sms') throw new Error('it fell back to the same channel');
    if (r.body.channel !== 'sms')
      throw new Error('it told the app WhatsApp when the message went by SMS');
  });

  await step('a failed SMS send is reported, not quietly retried as WhatsApp', async () => {
    // There is nowhere to fall back to from SMS. A second attempt on a
    // channel with no sender would turn one honest failure into two.
    const s = signin(ON_FILE, {}, true);
    const r = await s.call('012 524 3477');
    if (s.sent.length !== 1) throw new Error('it tried a second channel: ' + s.sent.length);
    if (r.status !== 502) throw new Error('a failed send answered ' + r.status);
  });

  console.log(fail ? fail + ' FAILED' : 'all green');
  process.exit(fail ? 1 : 0);
})();
