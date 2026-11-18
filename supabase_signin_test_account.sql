-- ════════════════════════════════════════════════════════════════════════
--  A number of your own that the sign-in will answer
-- ════════════════════════════════════════════════════════════════════════
--  PUT YOUR MOBILE NUMBER ON THE MARKED LINE BELOW, then run the whole
--  file in the Supabase SQL editor. Safe to re-run: it will not create a
--  second account for the same number.
--
--  WHY THIS IS NEEDED TO TEST ANYTHING
--  parent-signin checks a number against parent_accounts BEFORE asking
--  Supabase to send a code. That is deliberate — an ungated send endpoint
--  is somebody else's bill to run up — but it means testing the sign-in
--  with your own number fails at the lookup and never reaches WhatsApp at
--  all. You would see "We do not have that number on file" and conclude
--  delivery is broken, having never tested delivery.
--
--  So: one account, holding your number, belonging to no family. Signing
--  in to it proves the whole chain end to end — Twilio, the WhatsApp
--  message, the code, the verify, and claim_parent_account linking the
--  session. The app will open on an empty Home, because this account has
--  no children. That is the correct result. You are testing the door,
--  not the house.
--
--  IT WILL SHOW UP IN THE READINESS REPORT
--  supabase_parent_launch_readiness.sql counts accounts with no children
--  attached. After this there will be one more, and it is this. Not a
--  fault — just so the number is not a surprise.
--
--  REMOVING IT AFTERWARDS
--  The last part of the output gives you the one line that deletes it,
--  with its id filled in. Nothing is lost by leaving it, but nothing is
--  gained either, and an account nobody can explain is worse than no
--  account. Delete it once the test has told you what you need.
--
--  This is a test fixture, not a customer record, which is the one thing
--  in this database that is fine to delete outright.
-- ════════════════════════════════════════════════════════════════════════

with me as (
  -- ─────────────────────────────────────────────────────────────────────
  --  ↓↓↓  YOUR MOBILE NUMBER HERE. Any way you normally write it.  ↓↓↓
  select ss_normalise_phone('012-345 6789') as phone
  --  ↑↑↑  e.g. '0123456789', '+60 12-345 6789', '012-345 6789'    ↑↑↑
  -- ─────────────────────────────────────────────────────────────────────
),
already as (
  select pa.id, pa.display_name
    from parent_accounts pa, me
   where me.phone is not null
     and (pa.phone_primary = me.phone or pa.phone_secondary = me.phone)
),
made as (
  insert into parent_accounts (display_name, phone_primary)
  select 'Star Swim — sign-in test', me.phone
    from me
   where me.phone is not null
     and not exists (select 1 from already)
  returning id, phone_primary
)

select z.thing, z.detail
  from (
  select 1 k, 'the number, as the sign-in will read it' as thing,
         coalesce((select phone from me),
                  'NOT A MALAYSIAN MOBILE — nothing was created. '
               || 'ss_normalise_phone() only accepts 01x numbers; check for '
               || 'a typo, or a landline.') as detail

  union all
  select 2, 'what happened',
         case
           when (select phone from me) is null then
             'Nothing. Correct the number above and run the file again.'
           when exists (select 1 from made) then
             'Created an account holding that number, with no children on it.'
           when exists (select 1 from already) then
             'That number was already on an account ('
             || (select coalesce(display_name,'no name') from already limit 1)
             || '). Nothing was created — one number cannot be on two '
             || 'accounts, and a second would lock both out. You can sign '
             || 'in with it as it stands.'
           else 'Nothing, and nothing explains why. Tell me what this says.'
         end

  union all
  select 3, 'now do this',
         'Open mystarswim.com/get on the phone holding that number, tap '
      || 'Open the app, and enter it. A code should arrive on WhatsApp '
      || 'within seconds. If it does, the paid side is live and every '
      || 'family can sign in. If the app says it has no such number, this '
      || 'file did not do what it says. If it accepts the number and no '
      || 'code ever arrives, the gap is Twilio.'

  union all
  select 4, 'remove it afterwards',
         coalesce(
           (select 'delete from parent_accounts where id = ''' || id::text || ''';'
              from made),
           (select 'Nothing to remove — the number was already on '
                || coalesce(display_name,'an account') || ', which is a real '
                || 'record and should stay.' from already limit 1),
           'Nothing was created, so there is nothing to remove.')
  ) z
 order by z.k;
