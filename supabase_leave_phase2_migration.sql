-- ============================================================================
-- Star Swim — Leave management, part 2: the rules
-- ----------------------------------------------------------------------------
-- Applying, cancelling, deciding — and what an approved day of leave does to
-- a session the worker was rostered for.
--
-- Workers never write leave_requests directly. Everything goes through
-- apply_for_leave() and cancel_my_leave(), because the rules (a document where
-- one is required, no two applications over the same day, no applying for a
-- day already gone) have to hold whatever the app happens to send.
--
-- Over-allowance is NOT blocked. A hospital stay does not stop at fourteen
-- days because the allowance did, and unpaid leave has no ceiling at all. The
-- app warns, the application goes through, and HR decides — which is the
-- decision a person should be making anyway.
--
-- Run supabase_leave_phase1_migration.sql first.
-- ============================================================================

begin;

set local search_path = public, extensions;

-- ── A rostered session on an approved day of leave ──────────────────────────
-- Kept on the roster, not voided: somebody still has to cover that pool, and
-- a session that vanishes on approval takes the cover gap with it.
alter table shifts drop constraint if exists shifts_status_valid;
alter table shifts add constraint shifts_status_valid check (status in
  ('scheduled','on_time','late','early_leave','incomplete','absent','geofence_flag','on_leave'));

-- ── Does approved leave cover this person on this day? ──────────────────────
create or replace function leave_covers(p_crew uuid, p_date date)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from leave_requests r
     where r.crew_id = p_crew
       and r.status  = 'approved'
       and p_date between r.start_date and r.end_date
  );
$$;

-- ── What the worker's app asks for ──────────────────────────────────────────
-- Every active kind, whether or not an allowance has been entered. Driving
-- this off the entitlements table alone meant a worker could not even apply
-- for unpaid leave until somebody had typed a zero against it, which is a
-- setup step nobody would remember and an error nobody could diagnose.
-- The return type gains a column, which CREATE OR REPLACE cannot do, so this
-- file stays re-runnable only with the drop.
drop function if exists get_my_leave_balances(integer);
create or replace function get_my_leave_balances(p_year integer default null)
returns table (code text, label text, requires_document boolean, is_paid boolean,
               cap_days numeric, days_given numeric, days_used numeric,
               days_available numeric, sort_order integer)
language sql stable security definer set search_path = public
as $$
  with yr as (select coalesce(p_year, extract(year from current_date)::integer) as y),
       me as (select attendance_my_crew_id() as crew)
  select t.code, t.label, t.requires_document, t.is_paid,
         t.default_cap_days,
         coalesce(e.days_given, 0)::numeric as days_given,
         coalesce((
           select sum(r.days) from leave_requests r
            where r.crew_id = (select crew from me)
              and r.leave_type_id = t.id
              and r.status = 'approved'
              and extract(year from r.start_date) = (select y from yr)
         ), 0)::numeric as days_used,
         (coalesce(e.days_given, 0) - coalesce((
           select sum(r.days) from leave_requests r
            where r.crew_id = (select crew from me)
              and r.leave_type_id = t.id
              and r.status = 'approved'
              and extract(year from r.start_date) = (select y from yr)
         ), 0))::numeric as days_available,
         t.sort_order
    from leave_types t
    left join leave_entitlements e
      on e.leave_type_id = t.id
     and e.crew_id = (select crew from me)
     and e.year = (select y from yr)
   where t.is_active
   order by t.sort_order;
$$;

-- ── Applying ────────────────────────────────────────────────────────────────
create or replace function apply_for_leave(
  p_type_code     text,
  p_start         date,
  p_end           date,
  p_reason        text default null,
  p_document_path text default null
)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  v_me   uuid := attendance_my_crew_id();
  v_type leave_types%rowtype;
  v_days numeric(4,1);
  v_id   uuid;
begin
  if v_me is null then
    raise exception 'Your login is not linked to a worker record.';
  end if;

  select * into v_type from leave_types where code = p_type_code and is_active;
  if not found then raise exception 'Unknown kind of leave.'; end if;

  if p_start is null or p_end is null then
    raise exception 'Choose the dates.';
  end if;
  if p_end < p_start then
    raise exception 'The last day cannot be before the first.';
  end if;
  -- Backdating is allowed — an MC arrives after the illness, not before — but
  -- only so far. Beyond that it is a correction for an admin to make, with a
  -- note saying why.
  if p_start < current_date - 60 then
    raise exception 'That is more than 60 days ago. Ask your admin to record it.';
  end if;
  if p_end > current_date + 365 then
    raise exception 'That is more than a year away.';
  end if;

  v_days := (p_end - p_start) + 1;

  if v_type.requires_document and nullif(btrim(coalesce(p_document_path,'')),'') is null then
    raise exception 'A photo of your % is required for this.',
      case v_type.code when 'death' then 'certificate' else 'MC' end;
  end if;

  -- One application per day. Without this a worker can stack two overlapping
  -- requests and have both approved, and the balance quietly double-counts.
  if exists (
    select 1 from leave_requests r
     where r.crew_id = v_me
       and r.status in ('pending','approved')
       and daterange(r.start_date, r.end_date, '[]') && daterange(p_start, p_end, '[]')
  ) then
    raise exception 'You already have leave applied for on one of those days.';
  end if;

  insert into leave_requests (crew_id, leave_type_id, start_date, end_date, days,
                              reason, document_path, status)
  values (v_me, v_type.id, p_start, p_end, v_days,
          nullif(btrim(coalesce(p_reason,'')),''),
          nullif(btrim(coalesce(p_document_path,'')),''), 'pending')
  returning id into v_id;

  return v_id;
end $$;

-- ── Withdrawing ─────────────────────────────────────────────────────────────
-- Theirs to withdraw while it is still ahead of them. A day already taken is
-- a matter of record and only an admin can change it.
create or replace function cancel_my_leave(p_request_id uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_me  uuid := attendance_my_crew_id();
  v_row leave_requests%rowtype;
begin
  if v_me is null then
    raise exception 'Your login is not linked to a worker record.';
  end if;

  select * into v_row from leave_requests where id = p_request_id and crew_id = v_me;
  if not found then raise exception 'That application is not yours.'; end if;

  if v_row.status = 'cancelled' then raise exception 'Already withdrawn.'; end if;
  if v_row.status = 'rejected'  then raise exception 'That one was not approved.'; end if;
  if v_row.status = 'approved' and v_row.start_date <= current_date then
    raise exception 'That leave has already started. Ask your admin.';
  end if;

  update leave_requests
     set status = 'cancelled', cancelled_at = now(), updated_at = now()
   where id = p_request_id;

  -- Hand the sessions back to the roster.
  update shifts set status = 'scheduled', updated_at = now()
   where crew_id = v_me and status = 'on_leave'
     and shift_date between v_row.start_date and v_row.end_date;
end $$;

-- ── Deciding ────────────────────────────────────────────────────────────────
create or replace function decide_leave(
  p_request_id uuid,
  p_status     text,
  p_note       text default null
)
returns void
language plpgsql security definer set search_path = public
as $$
declare v_row leave_requests%rowtype;
begin
  if not attendance_is_hr() then
    raise exception 'Only HR can decide leave.';
  end if;
  if p_status not in ('approved','rejected') then
    raise exception 'A decision is approved or rejected.';
  end if;

  select * into v_row from leave_requests where id = p_request_id;
  if not found then raise exception 'No such application.'; end if;
  if v_row.status <> 'pending' then
    raise exception 'That application has already been settled.';
  end if;

  update leave_requests
     set status        = p_status,
         decided_at    = now(),
         decision_note = nullif(btrim(coalesce(p_note,'')),''),
         updated_at    = now()
   where id = p_request_id;

  if p_status = 'approved' then
    -- The session stays on the roster, marked. Only sessions nobody has
    -- punched for: a day already worked is not retrospectively leave.
    update shifts s
       set status = 'on_leave', updated_at = now()
     where s.crew_id = v_row.crew_id
       and not s.is_void
       and s.shift_date between v_row.start_date and v_row.end_date
       and s.status in ('scheduled','absent','geofence_flag')
       and not exists (select 1 from punches p where p.shift_id = s.id and p.accepted);

    -- Leave approved after the fact closes the alerts the absence raised.
    -- They stay in the log, showing what was noticed and what explained it.
    update alerts a
       set status            = 'resolved',
           resolution_action = 'on_approved_leave',
           resolved_at       = now()
      from shifts s
     where a.shift_id = s.id
       and a.status = 'open'
       and a.type in ('absent','no_checkin','no_checkout')
       and s.crew_id = v_row.crew_id
       and s.shift_date between v_row.start_date and v_row.end_date;
  end if;
end $$;

-- ── The scan leaves approved leave alone ────────────────────────────────────
-- Replaces the phase 4b version. Only the WHERE clause changes: a session on
-- an approved day of leave is not a no-show, and raising an alert for it would
-- ask a worker to explain a day everybody had already agreed about.
create or replace function attendance_scan_alerts()
returns integer
language plpgsql security definer set search_path = public
as $$
declare
  v_set       attendance_settings%rowtype;
  v_count     integer := 0;
  v_ins       integer := 0;
  v_reason    text;
  v_reason_at timestamptz;
  r           record;
begin
  select * into v_set from attendance_settings;

  for r in
    select s.id, s.crew_id, s.status,
           (s.shift_date + s.start_time) at time zone v_set.timezone as starts_at,
           (s.shift_date + s.end_time)   at time zone v_set.timezone as ends_at,
           exists (select 1 from punches p where p.shift_id = s.id and p.type = 'in'  and p.accepted) as has_in,
           exists (select 1 from punches p where p.shift_id = s.id and p.type = 'out' and p.accepted) as has_out
    from shifts s
    where not s.is_void
      and s.status <> 'on_leave'
      and not leave_covers(s.crew_id, s.shift_date)
      and s.shift_date between (now() at time zone v_set.timezone)::date - 1
                           and (now() at time zone v_set.timezone)::date
  loop
    if now() > r.ends_at and not r.has_in then
      select worker_reason, worker_reason_at
        into v_reason, v_reason_at
        from alerts
       where shift_id = r.id and type = 'no_checkin' and worker_reason is not null
       order by raised_at
       limit 1;

      insert into alerts (shift_id, crew_id, type, worker_reason, worker_reason_at)
      values (r.id, r.crew_id, 'absent', v_reason, v_reason_at)
      on conflict do nothing;
      get diagnostics v_ins = row_count;
      v_count := v_count + v_ins;

      update alerts
         set status            = 'resolved',
             resolution_action = 'superseded_by_absence',
             resolved_at       = now()
       where shift_id = r.id and type = 'no_checkin' and status = 'open';

      update shifts set status = 'absent', updated_at = now()
        where id = r.id and status in ('scheduled','geofence_flag');

    elsif now() > r.starts_at + make_interval(mins => v_set.no_checkin_alert_min)
          and not r.has_in then
      insert into alerts (shift_id, crew_id, type)
      values (r.id, r.crew_id, 'no_checkin')
      on conflict do nothing;
      get diagnostics v_ins = row_count;
      v_count := v_count + v_ins;
    end if;

    if r.has_in and not r.has_out
       and now() > r.ends_at + make_interval(mins => v_set.no_checkout_alert_min) then
      insert into alerts (shift_id, crew_id, type)
      values (r.id, r.crew_id, 'no_checkout')
      on conflict do nothing;
      get diagnostics v_ins = row_count;
      v_count := v_count + v_ins;
      update shifts set status = 'incomplete', updated_at = now()
        where id = r.id and status in ('scheduled','late','geofence_flag');
    end if;
  end loop;

  return v_count;
end $$;

-- ── Grants ──────────────────────────────────────────────────────────────────
revoke all on function apply_for_leave(text, date, date, text, text) from public;
revoke all on function cancel_my_leave(uuid) from public;
revoke all on function get_my_leave_balances(integer) from public;
revoke all on function decide_leave(uuid, text, text) from public;
revoke all on function leave_covers(uuid, date) from public;

grant execute on function apply_for_leave(text, date, date, text, text) to authenticated;
grant execute on function cancel_my_leave(uuid) to authenticated;
grant execute on function get_my_leave_balances(integer) to authenticated;
grant execute on function decide_leave(uuid, text, text) to authenticated;
grant execute on function leave_covers(uuid, date) to authenticated;

-- ── Where the MCs live ──────────────────────────────────────────────────────
-- A private bucket. These are medical certificates and death certificates —
-- sensitive personal data under the PDPA, and nothing about them should be
-- reachable by guessing a URL. The app reads them through a signed link that
-- expires. Guarded so this file still applies on a plain Postgres.
do $$
begin
  if to_regclass('storage.buckets') is null then
    raise notice 'No storage schema here — skipping the bucket (expected outside Supabase).';
    return;
  end if;

  insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  values ('leave-docs', 'leave-docs', false, 5242880,
          array['image/jpeg','image/png','image/webp','application/pdf'])
  on conflict (id) do update
    set public = false,
        file_size_limit = excluded.file_size_limit,
        allowed_mime_types = excluded.allowed_mime_types;

  -- A worker writes only into their own folder, named by their crew id.
  execute $p$ drop policy if exists leave_docs_own_insert on storage.objects $p$;
  execute $p$
    create policy leave_docs_own_insert on storage.objects for insert to authenticated
    with check (bucket_id = 'leave-docs'
                and (storage.foldername(name))[1] = attendance_my_crew_id()::text) $p$;

  execute $p$ drop policy if exists leave_docs_own_read on storage.objects $p$;
  execute $p$
    create policy leave_docs_own_read on storage.objects for select to authenticated
    using (bucket_id = 'leave-docs'
           and ((storage.foldername(name))[1] = attendance_my_crew_id()::text
                or attendance_is_hr())) $p$;

  -- Nobody overwrites or removes a submitted certificate from the app.
  execute $p$ drop policy if exists leave_docs_hr_delete on storage.objects $p$;
  execute $p$
    create policy leave_docs_hr_delete on storage.objects for delete to authenticated
    using (bucket_id = 'leave-docs' and attendance_is_hr()) $p$;

  raise notice 'Leave: private bucket leave-docs ready.';
end $$;

commit;

-- ============================================================================
-- §VERIFY
--   select proname from pg_proc where proname in
--     ('apply_for_leave','cancel_my_leave','decide_leave','get_my_leave_balances',
--      'leave_covers');                                           -- 5 rows
--   select id, public from storage.buckets where id='leave-docs'; -- public = false
--
-- RETENTION — MCs and certificates are sensitive personal data. Decide how
-- long they are kept and delete on that schedule; the records of the leave
-- itself can outlive the documents.
--
-- ROLLBACK
--   -- re-run supabase_attendance_phase4b_absence_supersedes.sql to restore the scan
--   drop function if exists apply_for_leave(text, date, date, text, text);
--   drop function if exists cancel_my_leave(uuid);
--   drop function if exists decide_leave(uuid, text, text);
--   drop function if exists get_my_leave_balances(integer);
--   drop function if exists leave_covers(uuid, date);
-- ============================================================================
