-- ════════════════════════════════════════════════════════════════════════
--  The amendment log becomes write-once, and amending goes through it
-- ════════════════════════════════════════════════════════════════════════
--  Run this whole file in the Supabase SQL editor. It is safe to re-run.
--  Deploy the site update alongside it — the screen calls the new function
--  and falls back to the old path until this has run, saying so when it
--  does, so running them in either order is survivable.
--
--  WHAT WAS WRONG
--  voucher_amendments is the record of every change to a payment voucher.
--  Its own header says the trail cannot be silently rewritten. Its policy
--  said "for all using (true) with check (true)", which allows update and
--  delete to anybody holding a signed-in token. A log that can be edited
--  is not a log.
--
--  Worse, and the reason this file does more than swap a policy: the
--  screen wrote the voucher first and the log afterwards, in a try/catch
--  that swallowed the failure to a console warning. So the log failing was
--  already a silent outcome — an amended voucher with nothing recorded
--  against it, and nobody told. Tightening the policy without fixing that
--  would have made the silence more likely, not less.
--
--  WHAT HAPPENS NOW
--  One function does both halves in one transaction. Either the voucher
--  changes and the change is recorded, or neither happens. There is no
--  longer an order of operations to get wrong.
--
--  It also enforces the rule the screen's tooltip has always claimed:
--  amending a PAID voucher is sysadmin only. That was a hidden button, and
--  a hidden button is a rule for people who use the screen. This is a rule
--  for everyone.
--
--  A VOID VOUCHER IS NOT AMENDABLE AT ALL
--  Voiding is how a voucher is cancelled while its number stays in the
--  sequence. Editing one afterwards would make the void meaningless.
-- ════════════════════════════════════════════════════════════════════════

-- ── 1. Write-once, and not to anybody passing ───────────────────────────
-- No update policy and no delete policy: with RLS on, an action with no
-- policy is refused. The revokes say the same thing at the privilege
-- level, so neither alone is load-bearing.
alter table voucher_amendments enable row level security;

drop policy if exists voucher_amendments_all    on voucher_amendments;
drop policy if exists voucher_amendments_read   on voucher_amendments;
drop policy if exists voucher_amendments_insert on voucher_amendments;

create policy voucher_amendments_read on voucher_amendments
  for select to authenticated using (attendance_is_admin());

-- Inserting stays open to an admin rather than to the function alone: the
-- function is security definer and bypasses this, and leaving the door
-- open keeps yesterday's bundle able to record something rather than
-- nothing while the deploys catch up.
create policy voucher_amendments_insert on voucher_amendments
  for insert to authenticated with check (attendance_is_admin());

revoke all           on voucher_amendments from anon;
revoke update,delete on voucher_amendments from authenticated;
grant  select,insert on voucher_amendments to   authenticated;

comment on table voucher_amendments is
  'Write-once. No update or delete policy exists, deliberately. Rows are '
  'written by amend_voucher() in the same transaction as the change they '
  'describe.';

-- ── 2. Amend and record, or do neither ──────────────────────────────────
-- p_data carries only the columns the form edits. Anything in it that is
-- not a real column is ignored rather than erroring, so a newer screen
-- sending a field this database does not have yet still amends what it
-- can — and id, serial_no and status are never taken from it, because
-- those are not the form's to move.
create or replace function amend_voucher(p_id text, p_data jsonb)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_before jsonb;
  v_after  jsonb;
  v_status text;
  v_serial text;
  v_role   text;
  v_who    text;
  v_uid    text;
  v_cols   text;
begin
  if not attendance_is_admin() then
    return jsonb_build_object('ok', false,
      'error', 'Only the office can amend a voucher.');
  end if;

  select to_jsonb(v) into v_before
    from admin_payment_vouchers v where v.id::text = p_id;
  if v_before is null then
    return jsonb_build_object('ok', false, 'error', 'That voucher no longer exists.');
  end if;

  v_status := v_before->>'status';
  v_serial := v_before->>'serial_no';

  if v_status = 'Void' then
    return jsonb_build_object('ok', false,
      'error', 'A voided voucher cannot be amended. Its number stays in the '
            || 'sequence and the void is the record — raise a new voucher.');
  end if;

  begin
    v_role := auth.jwt() -> 'app_metadata' ->> 'ssb_role';
  exception when others then
    v_role := null;
  end;

  if v_status = 'Paid' and coalesce(v_role, '') <> 'sysadmin' then
    return jsonb_build_object('ok', false,
      'error', 'This voucher has been paid. Amending a paid voucher is the '
            || 'sysadmin''s to do. The amendment history is open to you either way.');
  end if;

  -- Who, from the token rather than from the browser. A field the caller
  -- fills in is a field the caller chooses.
  begin
    v_uid := auth.jwt() -> 'app_metadata' ->> 'app_user_id';
  exception when others then
    v_uid := null;
  end;
  if v_uid is not null and to_regclass('public.app_users') is not null then
    begin
      select coalesce(nullif(btrim(u.display_name), ''), u.username)
        into v_who from app_users u where u.id = v_uid::uuid;
    exception when others then
      v_who := null;
    end;
  end if;

  -- The columns to actually write: what was sent, minus what is not the
  -- form's business, intersected with what this table really has.
  select string_agg(format('%I', a.attname), ', ')
    into v_cols
    from pg_attribute a
   where a.attrelid = 'public.admin_payment_vouchers'::regclass
     and a.attnum > 0 and not a.attisdropped
     and a.attname not in ('id', 'serial_no', 'status', 'created_at')
     and jsonb_exists(p_data, a.attname);

  if v_cols is null then
    return jsonb_build_object('ok', false, 'error', 'Nothing to change.');
  end if;

  execute format(
    'update public.admin_payment_vouchers set (%s) = '
    '(select %s from jsonb_populate_record(null::public.admin_payment_vouchers, $1)) '
    'where id::text = $2', v_cols, v_cols)
    using p_data, p_id;

  select to_jsonb(v) into v_after
    from admin_payment_vouchers v where v.id::text = p_id;

  insert into voucher_amendments
    (voucher_id, voucher_no, status_at_edit, edited_by, before_data, after_data)
  values
    (p_id,
     case when v_serial is null then null else 'PV' || lpad(v_serial, 4, '0') end,
     v_status,
     coalesce(v_who, 'Office'),
     v_before,
     v_after);

  return jsonb_build_object('ok', true, 'status', v_status);
end $$;

revoke all on function amend_voucher(text, jsonb) from public, anon;
grant execute on function amend_voucher(text, jsonb) to authenticated;

-- ── What the log allows now ─────────────────────────────────────────────
select cmd as action,
       case cmd when 'SELECT' then 'admins may read'
                when 'INSERT' then 'admins may add'
                else 'unexpected — tell Claude' end as who
  from pg_policies
 where schemaname = 'public' and tablename = 'voucher_amendments'
 order by 1;

-- Nothing should come back: no policy means refused.
select 'update or delete is still possible' as problem
 where exists (select 1 from pg_policies
                where schemaname = 'public' and tablename = 'voucher_amendments'
                  and cmd in ('UPDATE', 'DELETE', 'ALL'));
