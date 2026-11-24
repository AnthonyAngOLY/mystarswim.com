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

// What parent_signin_check() answers. The gate, the caps and the words
// of every refusal are its business now; this function's job is to obey
// it and record what Twilio did.
const ALLOWED = { ok: true, known: true, phone: '+60125243477',
                  account_id: 'acct-1', log_id: 'log-1' };
const UNKNOWN = { ok: false, known: false,
                  error: 'We do not have that number on file. Call the centre and we will add it.' };
const COOLING = { ok: false, known: true, wait_sec: 41,
                  error: 'We have just sent one. Give it 41 more seconds.' };

(async () => {
  let fail = 0;
  const step = async (n, f) => {
    try { await f(); console.log('PASS  ' + n); }
    catch (e) { console.log('FAIL  ' + n + ' -> ' + String(e.message).split('\n')[0]); fail++; }
  };

  // Builds a handler whose outbound fetch is captured rather than sent.
  // `fail` makes the first send fail, so the fallback can be exercised.
  function signin(gate, env, failFirst) {
    const sent = [];
    const fetcher = async (url, init) => {
      let body = null;
      try { body = JSON.parse(init && init.body); } catch (_e) { body = null; }
      sent.push({ url: String(url), body: body });
      const ok = !(failFirst && sent.length === 1);
      return { ok: ok, status: ok ? 200 : 400, text: async () => ok ? '' : 'no sender' };
    };
    // The whole supabase-js envelope, as the public-intake suite does.
    const client = stubClient({ rpc: {
      parent_signin_check: async () => ({ data: gate, error: null }),
      parent_signin_sent: async () => ({ data: null, error: null })
    } });
    const handler = load(client, Object.assign({}, ENV, env || {}),
                         { fn: 'parent-signin', fetch: fetcher });
    return {
      sent: sent,
      rpc: client.calls.rpc,
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
    const s = signin(ALLOWED);
    const r = await s.call('012 524 3477');
    if (!s.sent.length) throw new Error('no send was attempted at all');
    const ch = s.sent[0].body && s.sent[0].body.channel;
    if (ch !== 'sms')
      throw new Error('asked Supabase for "' + ch + '", and there is no sender for it');
    if (r.body.channel !== 'sms')
      throw new Error('told the app it went by ' + JSON.stringify(r.body.channel));
  });

  await step('and it says SMS to the app, which is what the app shows the parent', async () => {
    const s = signin(ALLOWED);
    const r = await s.call('012 524 3477');
    if (r.body.known !== true) throw new Error('a number on file was not treated as known');
    if (r.status !== 200) throw new Error('status ' + r.status);
  });

  await step('the number it sends to is the one it looked up, in E.164', async () => {
    const s = signin(ALLOWED);
    await s.call('012-524 3477');
    if (s.sent[0].body.phone !== '+60125243477')
      throw new Error('sent to ' + JSON.stringify(s.sent[0].body.phone));
  });

  // ── Nothing is sent to a number that is not ours ──────────────────────
  await step('an unknown number costs nothing, because nothing is sent', async () => {
    const s = signin(UNKNOWN);
    const r = await s.call('012 999 0000');
    if (s.sent.length) throw new Error('it sent a message to a number not on file');
    if (r.body.known !== false) throw new Error('an unknown number was reported as known');
  });

  await step('a number on two accounts is refused rather than guessed at', async () => {
    const s = signin({ ok: false, known: false,
      error: 'That number is on two accounts, so we cannot tell which family it is.' });
    const r = await s.call('012 524 3477');
    if (s.sent.length) throw new Error('it sent a code without knowing whose family it was');
    if (!/two accounts/i.test(r.body.error || '')) throw new Error('it did not say why');
  });

  // ── The gate is the database's business, not this function's ──────────
  await step('it asks the database before it sends anything', async () => {
    const s = signin(ALLOWED);
    await s.call('012 524 3477');
    const asked = s.rpc.filter(c => c[0] === 'parent_signin_check');
    if (!asked.length) throw new Error('it decided for itself whether to send');
    if (asked[0][1].p_phone !== '+60125243477')
      throw new Error('it asked about a different number: ' + JSON.stringify(asked[0][1]));
  });

  await step('an archived account is refused in the same words as an unknown number', async () => {
    // Different answers would tell somebody trying numbers which are real.
    const arch = signin({ ok: false, known: false,
      error: 'We do not have that number on file. Call the centre and we will add it.' });
    const a = await arch.call('012 524 3477');
    const unk = signin(UNKNOWN);
    const u = await unk.call('012 999 0000');
    if (arch.sent.length) throw new Error('it sent a code to an archived account');
    if (a.body.error !== u.body.error)
      throw new Error('the two refusals can be told apart: ' + JSON.stringify([a.body.error, u.body.error]));
    if (a.status !== u.status) throw new Error('their statuses differ: ' + a.status + ' vs ' + u.status);
  });

  await step('a cooldown says how long to wait, and sends nothing', async () => {
    const s = signin(COOLING);
    const r = await s.call('012 524 3477');
    if (s.sent.length) throw new Error('it sent during the cooldown');
    if (r.status !== 429) throw new Error('a wait-and-retry answered ' + r.status);
    if (r.body.wait_sec !== 41)
      throw new Error('the app is not told how long to wait: ' + JSON.stringify(r.body.wait_sec));
  });

  await step('what Twilio did is recorded against the row the gate wrote', async () => {
    const s = signin(ALLOWED);
    await s.call('012 524 3477');
    const rec = s.rpc.filter(c => c[0] === 'parent_signin_sent')[0];
    if (!rec) throw new Error('nothing recorded whether the message went');
    if (rec[1].p_log !== 'log-1') throw new Error('recorded against the wrong row');
    if (rec[1].p_ok !== true) throw new Error('a send that worked was recorded as failed');
  });

  await step('and a send that failed is recorded as failed, not left blank', async () => {
    const s = signin(ALLOWED, {}, true);
    await s.call('012 524 3477');
    const rec = s.rpc.filter(c => c[0] === 'parent_signin_sent')[0];
    if (!rec) throw new Error('a failed send was not recorded at all');
    if (rec[1].p_ok !== false) throw new Error('a failed send was recorded as sent');
    if (!rec[1].p_error) throw new Error('the reason it failed was not kept');
  });

  await step('an auth user is only ever created after the lookup passed', async () => {
    const s = signin(ALLOWED);
    await s.call('012 524 3477');
    if (s.sent[0].body.create_user !== true)
      throw new Error('create_user was not set, so a first-time parent cannot sign in');
    const no = signin(UNKNOWN);
    await no.call('012 999 0000');
    if (no.sent.length) throw new Error('an account was created for a stranger');
  });

  // ── WhatsApp, if it is ever actually registered ───────────────────────
  await step('asking for WhatsApp still works, for the day there is a sender', async () => {
    const s = signin(ALLOWED, { PARENT_OTP_CHANNEL: 'whatsapp' });
    const r = await s.call('012 524 3477');
    if (s.sent[0].body.channel !== 'whatsapp')
      throw new Error('the override was ignored: ' + JSON.stringify(s.sent[0].body.channel));
    if (r.body.channel !== 'whatsapp') throw new Error('it reported the wrong channel');
  });

  await step('a failed WhatsApp send falls back to SMS and says so', async () => {
    const s = signin(ALLOWED, { PARENT_OTP_CHANNEL: 'whatsapp' }, true);
    const r = await s.call('012 524 3477');
    if (s.sent.length !== 2) throw new Error('it did not try again: ' + s.sent.length + ' send(s)');
    if (s.sent[1].body.channel !== 'sms') throw new Error('it fell back to the same channel');
    if (r.body.channel !== 'sms')
      throw new Error('it told the app WhatsApp when the message went by SMS');
  });

  await step('a failed SMS send is reported, not quietly retried as WhatsApp', async () => {
    // There is nowhere to fall back to from SMS. A second attempt on a
    // channel with no sender would turn one honest failure into two.
    const s = signin(ALLOWED, {}, true);
    const r = await s.call('012 524 3477');
    if (s.sent.length !== 1) throw new Error('it tried a second channel: ' + s.sent.length);
    if (r.status !== 502) throw new Error('a failed send answered ' + r.status);
  });

  console.log(fail ? fail + ' FAILED' : 'all green');
  process.exit(fail ? 1 : 0);
})();
