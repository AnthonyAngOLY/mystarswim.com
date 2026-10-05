-- ============================================================================
-- Star Swim Attendance — Phase 3: alerts become a log, not a queue
-- ----------------------------------------------------------------------------
-- Three changes, all additive. Safe to apply while the app is running; nothing
-- reads the new columns until the updated app ships.
--
-- 1. WORKERS EXPLAIN THEMSELVES.
--    Being late is something only the person who was late can explain. Until
--    now an admin had to chase the reason and type it in, which is why the
--    alerts list felt like reconciliation work. The worker now writes the
--    reason in their own app; the admin only judges it.
--
-- 2. ALERTS CARRY THEIR OWN FACTS.
--    An alert pointed at a session, so editing that session changed what the
--    alert was about — "late 12 min" against times that no longer existed.
--    Each alert now snapshots the session as it stood when raised, and reads
--    correctly forever, even if the session is later removed.
--
-- 3. SESSIONS STOP BEING REWRITABLE AFTER THE FACT.
--    Enforced in the app rather than here: a session can be edited only
--    before it starts. Afterwards it can be voided, never altered. Voiding
--    keeps the row (is_void), so the alert, the punches and the audit trail
--    all survive — which matters when the argument is about pay.
-- ============================================================================

begin;

set local search_path = public, extensions;

-- ─── 1. Worker-supplied reason ──────────────────────────────────────────────
alter table alerts add column if not exists worker_reason    text;
alter table alerts add column if not exists worker_reason_at timestamptz;

-- ─── 2. Snapshot of the session, as it was when the alert was raised ────────
alter table alerts add column if not exists shift_snapshot jsonb;

create or replace function attendance_snapshot_alert()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  -- Fired on INSERT only, so the snapshot records the session at the moment
  -- the alert was raised and never drifts afterwards.
  if new.shift_snapshot is null then
    select jsonb_build_object(
             'shift_date',    s.shift_date,
             'start_time',    s.start_time,
             'end_time',      s.end_time,
             'location_name', l.name,
             'category_name', c.name
           )
      into new.shift_snapshot
      from shifts s
      left join locations l        on l.id = s.location_id
      left join shift_categories c on c.id = s.category_id
     where s.id = new.shift_id;
  end if;
  return new;
end $$;

drop trigger if exists alerts_snapshot on alerts;
create trigger alerts_snapshot before insert on alerts
  for each row execute function attendance_snapshot_alert();

-- Backfill anything raised before this migration, so the log is complete.
update alerts a
   set shift_snapshot = jsonb_build_object(
         'shift_date',    s.shift_date,
         'start_time',    s.start_time,
         'end_time',      s.end_time,
         'location_name', l.name,
         'category_name', c.name)
  from shifts s
  left join locations l        on l.id = s.location_id
  left join shift_categories c on c.id = s.category_id
 where s.id = a.shift_id
   and a.shift_snapshot is null;

-- ─── 3. The worker's own reason, written safely ─────────────────────────────
-- A SECURITY DEFINER function rather than an UPDATE policy, so a worker can
-- write exactly two columns on exactly their own alert, and nothing else.
-- Locked once an admin has resolved it: the reason is evidence the decision
-- was made on, so it cannot change afterwards.
create or replace function set_my_alert_reason(p_alert_id uuid, p_reason text)
returns timestamptz
language plpgsql security definer set search_path = public
as $$
declare
  v_me uuid := attendance_my_crew_id();
  v_at timestamptz;
begin
  if v_me is null then
    raise exception 'Your login is not linked to a worker record.';
  end if;
  if coalesce(btrim(p_reason), '') = '' then
    raise exception 'Enter a reason.';
  end if;

  update alerts
     set worker_reason    = btrim(p_reason),
         worker_reason_at = now()
   where id = p_alert_id
     and crew_id = v_me
     and status = 'open'
  returning worker_reason_at into v_at;

  if v_at is null then
    raise exception 'That alert is not yours, or it has already been resolved.';
  end if;
  return v_at;
end $$;

revoke all on function set_my_alert_reason(uuid, text) from public;
grant execute on function set_my_alert_reason(uuid, text) to authenticated;

commit;

-- ============================================================================
-- §VERIFY
--   select count(*) as alerts, count(shift_snapshot) as with_snapshot from alerts;
--   -- the two numbers should match
--
--   select tgname from pg_trigger where tgname = 'alerts_snapshot';
--
-- ROLLBACK
--   drop trigger if exists alerts_snapshot on alerts;
--   drop function if exists attendance_snapshot_alert();
--   drop function if exists set_my_alert_reason(uuid, text);
--   alter table alerts drop column if exists worker_reason,
--                      drop column if exists worker_reason_at,
--                      drop column if exists shift_snapshot;
-- ============================================================================
