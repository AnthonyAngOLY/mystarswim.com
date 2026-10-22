-- ════════════════════════════════════════════════════════════════════════
--  A crew record with history is archived, not deleted
-- ════════════════════════════════════════════════════════════════════════
--  Run this whole file in the Supabase SQL editor. It is safe to re-run.
--  Deploy the site update alongside it.
--
--  WHAT HAPPENED
--  Deleting a crew member came back as a database error:
--
--    violates foreign key constraint "shifts_crew_id_fkey"
--    Key (id)=(…) is still referenced from table "shifts"
--
--  That is the database refusing to shred attendance history, which is
--  the right answer given badly. Nobody should have to read a constraint
--  name to find out that somebody has worked shifts.
--
--  WHAT THIS DOES
--  The delete button now asks first. The answer comes back as plain
--  counts — "48 rostered sessions, 31 clock-ins, 4 leave requests" — and
--  the screen offers Archive, which keeps every one of them and takes
--  the person off the roster.
--
--  Delete still works, and only works, where there is genuinely nothing
--  to lose: a row typed in wrong this morning, an import run twice. That
--  is the only case it was ever safe for.
--
--  WHY IT COUNTS BY ASKING THE CATALOGUE
--  The tables that point at a crew record are not all created in one
--  place — several are added by a DO block that looks up whatever the
--  crew table is called. A hand-written list would be a list that goes
--  stale the next time one is added, and going stale here means a delete
--  that takes something with it. So the function reads pg_constraint and
--  counts whatever actually points at the row, today.
--
--  TWO THINGS THAT DO NOT COUNT AS HISTORY
--  attendance_consents and attendance_password_state exist only because
--  the crew row exists — one records that they tapped "I agree", the
--  other whether their issued password is still unused. Neither means
--  anything without the person, and counting them would make every crew
--  record that has ever had a login undeletable. They go with the record.
--
--  A LOGIN IS CHECKED SEPARATELY
--  A crew record that can still sign in is refused outright, before any
--  counting. Deleting the row leaves the sign-in account behind with
--  nothing to attach to, and we have already paid for one of those: a
--  removed crew login took the Auth account a scheduler login was also
--  pointing at, and that scheduler could not sign in again until the
--  dead pointer was cleared by hand.
-- ════════════════════════════════════════════════════════════════════════

create or replace function crew_delete_or_explain(p_crew_id uuid)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_tbl   text;
  v_oid   oid;
  v_row   jsonb;
  v_name  text;
  v_auth  uuid;
  v_sid   text;
  v_found jsonb := '[]'::jsonb;
  v_keep  jsonb := '[]'::jsonb;
  v_total bigint := 0;
  v_label text;
  n       bigint;
  r       record;
  -- Rows that exist only because the crew row exists. See the header.
  v_bookkeeping constant text[] := array['attendance_consents',
                                         'attendance_password_state'];
begin
  if not attendance_is_admin() then
    raise exception 'Only an administrator can delete a crew record.';
  end if;

  select c.relname into v_tbl
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relname in ('crew', 'admin_employees')
   order by case c.relname when 'crew' then 1 else 2 end
   limit 1;
  if v_tbl is null then
    return jsonb_build_object('ok', false, 'reason', 'error',
      'error', 'No crew table found.');
  end if;
  v_oid := format('public.%I', v_tbl)::regclass;

  -- to_jsonb rather than named columns: the name column is full_name here
  -- and display_name in another install, and archived_at only exists once
  -- the archive migration has run.
  execute format('select to_jsonb(e) from public.%I e where e.id = $1', v_tbl)
     into v_row using p_crew_id;
  if v_row is null then
    return jsonb_build_object('ok', false, 'reason', 'gone',
      'error', 'That record has already been removed.');
  end if;

  v_name := coalesce(nullif(btrim(coalesce(v_row->>'full_name',
                                           v_row->>'display_name',
                                           v_row->>'name', '')), ''),
                     'This person');
  v_auth := nullif(v_row->>'auth_user_id', '')::uuid;
  v_sid  := nullif(btrim(coalesce(v_row->>'staff_id', '')), '');

  if v_auth is not null then
    return jsonb_build_object('ok', false, 'reason', 'login',
      'name', v_name, 'staff_id', v_sid);
  end if;

  for r in
    select cl.relname::text as tbl,
           a.attname::text  as col
      from pg_constraint c
      join pg_class     cl on cl.oid = c.conrelid
      join pg_namespace ns on ns.oid = cl.relnamespace
      join pg_attribute a  on a.attrelid = c.conrelid
                          and a.attnum   = c.conkey[1]
     where c.contype  = 'f'
       and c.confrelid = v_oid
       and ns.nspname  = 'public'
       and array_length(c.conkey, 1) = 1
     order by 1
  loop
    if r.tbl = any(v_bookkeeping) then
      -- Deleted with the record, so remember where from. Taking the
      -- column off the constraint rather than assuming "crew_id" keeps
      -- this honest if one of them is ever renamed.
      v_keep := v_keep || jsonb_build_object('tbl', r.tbl, 'col', r.col);
      continue;
    end if;

    execute format('select count(*) from public.%I where %I = $1', r.tbl, r.col)
       into n using p_crew_id;
    if n = 0 then
      continue;
    end if;

    -- Said the way Anthony would say it. An unknown table falls back to
    -- its own name with the underscores taken out, which is ugly and
    -- still more use than a constraint name.
    v_label := case r.tbl
      when 'shifts'              then 'rostered session'
      when 'punches'             then 'clock-in'
      when 'alerts'              then 'attendance alert'
      when 'leave_requests'      then 'leave request'
      when 'leave_entitlements'  then 'leave allowance'
      when 'crew_documents'      then 'file'
      when 'crew_probation_log'  then 'probation record'
      when 'shift_patterns'      then 'repeating roster entry'
      when 'pay_rates'           then 'pay rate'
      when 'pay_settings'        then 'pay setting'
      else replace(r.tbl, '_', ' ')
    end;

    v_total := v_total + n;
    v_found := v_found || jsonb_build_object('label', v_label, 'n', n);
  end loop;

  if v_total > 0 then
    return jsonb_build_object('ok', false, 'reason', 'history',
      'name', v_name, 'found', v_found, 'total', v_total);
  end if;

  begin
    for r in select x->>'tbl' as tbl, x->>'col' as col
               from jsonb_array_elements(v_keep) x
    loop
      execute format('delete from public.%I where %I = $1', r.tbl, r.col)
        using p_crew_id;
    end loop;
    execute format('delete from public.%I where id = $1', v_tbl) using p_crew_id;
  exception when foreign_key_violation then
    -- Something points at the row that the loop above did not see — a
    -- constraint outside public, or one added while this was running.
    -- Better a sentence than a rollback nobody can read.
    return jsonb_build_object('ok', false, 'reason', 'history',
      'name', v_name, 'total', 1,
      'found', jsonb_build_array(
        jsonb_build_object('label', 'linked record', 'n', 1)));
  end;

  return jsonb_build_object('ok', true, 'name', v_name);
end $$;

comment on function crew_delete_or_explain(uuid) is
  'Deletes a crew record only when nothing references it. Otherwise says '
  'what is there, in counts, so the screen can offer Archive instead.';

revoke all on function crew_delete_or_explain(uuid) from public, anon;
grant execute on function crew_delete_or_explain(uuid) to authenticated;

-- ── What the button would say about each crew member today ──────────────
-- A dry run of the same question, for every record at once. Anyone with a
-- count is archive-only from now on; the rest can still be deleted.
select e.full_name,
       (select count(*) from shifts s where s.crew_id = e.id)          as sessions,
       (select count(*) from punches p where p.crew_id = e.id)         as clock_ins,
       (select count(*) from leave_requests l where l.crew_id = e.id)  as leave_requests,
       (select count(*) from crew_documents d where d.crew_id = e.id)  as files,
       case when e.auth_user_id is not null then 'has a login — remove it first'
            when exists (select 1 from shifts s where s.crew_id = e.id)
              or exists (select 1 from punches p where p.crew_id = e.id)
              or exists (select 1 from leave_requests l where l.crew_id = e.id)
              or exists (select 1 from crew_documents d where d.crew_id = e.id)
            then 'archive only'
            else 'can be deleted' end as delete_button_says
  from admin_employees e
 order by 6, 1;
