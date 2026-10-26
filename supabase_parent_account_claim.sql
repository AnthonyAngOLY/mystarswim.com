-- ════════════════════════════════════════════════════════════════════════
--  Linking a signed-in person to their family
-- ════════════════════════════════════════════════════════════════════════
--  Safe to re-run. Replaces one function and writes only
--  parent_accounts.auth_user_id, and only where it is empty.
--
--  THE GAP THIS FILLS
--  parent_accounts.auth_user_id is what every read in the parent app
--  turns on: my_parent_account_id() finds the account whose
--  auth_user_id is the caller. Nothing ever set it. A parent could sign
--  in to Supabase perfectly well and then be told they are not linked to
--  a family, for ever, because nothing was going to link them.
--
--  WHAT MAKES THE LINK SAFE
--  Supabase puts the phone it verified into the token. The holder proved
--  possession of that handset by reading a code off it — that is the
--  whole point of the code. So matching the token's phone against the
--  account's own numbers is not a guess; it is the strongest fact in the
--  system.
--
--  What it will not do:
--    - take a phone number as an argument. The only number it will look
--      at is the verified one in the token.
--    - move an account from one person to another. An account already
--      claimed stays claimed; a second person presenting the same number
--      is refused and the office has to look at it.
--    - let one person hold two families. Somebody who already claims an
--      account cannot claim another.
-- ════════════════════════════════════════════════════════════════════════

create or replace function claim_parent_account()
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_uid   uuid;
  v_phone text;
  v_acct  uuid;
  v_owner uuid;
  v_n     int;
begin
  v_uid := auth.uid();
  if v_uid is null then
    return jsonb_build_object('ok', false, 'error', 'Not signed in.');
  end if;

  -- Already linked: the ordinary case on every sign-in after the first.
  select id into v_acct from parent_accounts where auth_user_id = v_uid;
  if v_acct is not null then
    return jsonb_build_object('ok', true, 'account_id', v_acct, 'claimed', false);
  end if;

  -- The phone Supabase verified, not one the caller hands us.
  begin
    v_phone := nullif(btrim(coalesce(auth.jwt() ->> 'phone', '')), '');
  exception when others then
    v_phone := null;
  end;
  if v_phone is null then
    return jsonb_build_object('ok', false,
      'error', 'This sign-in has no verified phone number on it.');
  end if;
  -- Supabase stores it without the plus; the accounts hold E.164.
  if left(v_phone, 1) <> '+' then v_phone := '+' || regexp_replace(v_phone, '\D', '', 'g'); end if;

  select count(*) into v_n
    from parent_accounts pa
   where pa.phone_primary = v_phone or pa.phone_secondary = v_phone;

  if v_n = 0 then
    return jsonb_build_object('ok', false,
      'error', 'That number is not on any family account.');
  end if;
  -- One number, two families: a data fault. Picking one would be a guess
  -- about whose children to show, so neither is picked.
  if v_n > 1 then
    return jsonb_build_object('ok', false,
      'error', 'That number is on more than one account. Call the centre and we will sort it out.');
  end if;

  select pa.id, pa.auth_user_id into v_acct, v_owner
    from parent_accounts pa
   where pa.phone_primary = v_phone or pa.phone_secondary = v_phone;

  if v_owner is not null and v_owner <> v_uid then
    -- Somebody else already holds this family. Usually a number reissued
    -- by the telco to a new person. Never resolved here.
    return jsonb_build_object('ok', false,
      'error', 'That number is already linked to a different sign-in. Call the centre.');
  end if;

  -- The unique index on auth_user_id is the real guard: two sessions
  -- racing to claim the same account, or one person reaching for a
  -- second family, lose here rather than in the if above.
  begin
    update parent_accounts
       set auth_user_id = v_uid, last_login_at = now()
     where id = v_acct and auth_user_id is null;
  exception when unique_violation then
    return jsonb_build_object('ok', false,
      'error', 'This sign-in is already linked to another family. Call the centre.');
  end;

  return jsonb_build_object('ok', true, 'account_id', v_acct, 'claimed', true);
end $$;

comment on function claim_parent_account() is
  'Links the signed-in user to the family whose number they proved they '
  'hold. Takes no argument: the only number it reads is the verified one '
  'in the token. Refuses an account somebody else already holds.';

-- Every sign-in after the first should still say so, so the office can
-- see who is actually using the app.
create or replace function touch_parent_login()
returns void
language sql security definer set search_path = public as $$
  update parent_accounts set last_login_at = now() where auth_user_id = auth.uid();
$$;


-- ─── The link follows the number ────────────────────────────────────────
-- A claim is only as good as the fact behind it: this person proved they
-- hold that number. Change the number and the proof is gone, so the link
-- goes with it and whoever actually holds the new number claims it on
-- their next sign-in.
--
-- This matters most right now. The office is working through a list of
-- wrong and missing numbers. If one of those wrong numbers had already
-- let somebody in, correcting it without this would leave them inside.
--
-- Clearing auth_user_id does not delete anything or lock anybody out
-- permanently — it puts the account back to unclaimed.
create or replace function parent_phone_changed()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.auth_user_id is not null
     and (new.phone_primary   is distinct from old.phone_primary
       or new.phone_secondary is distinct from old.phone_secondary)
  then
    -- Unless the number they are actually signed in on is still one of
    -- the account's: adding a second number should not sign anybody out.
    if not (coalesce(old.phone_primary, '')   in (coalesce(new.phone_primary, '#'),
                                                  coalesce(new.phone_secondary, '#'))
         or coalesce(old.phone_secondary, '') in (coalesce(new.phone_primary, '#'),
                                                  coalesce(new.phone_secondary, '#')))
    then
      new.auth_user_id := null;
    end if;
  end if;
  return new;
end $$;

drop trigger if exists parent_phone_changed_trg on parent_accounts;
create trigger parent_phone_changed_trg
  before update of phone_primary, phone_secondary on parent_accounts
  for each row execute function parent_phone_changed();

comment on function parent_phone_changed() is
  'Unclaims an account when every number on it has changed. The claim '
  'rests on having proved possession of a number; change them all and '
  'the proof is gone. Adding a second number changes nothing.';
