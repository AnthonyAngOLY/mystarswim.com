-- ============================================================================
-- Star Swim Attendance — Phase 3b: a short window to correct a reason
-- ----------------------------------------------------------------------------
-- A worker types their reason on a phone, often one-handed at a poolside,
-- sometimes in a hurry. Typos and half-finished sentences are normal. But a
-- reason that can be rewritten at any time is not evidence — an admin could
-- read one thing on Monday and find another on Friday.
--
-- So: a short window to fix a mistake, then it stands.
--
-- The window is anchored to the FIRST save and never extended by a later
-- edit, otherwise someone could keep it open indefinitely by revising every
-- couple of minutes.
--
-- Additive. Safe to apply while the app is running.
-- ============================================================================

begin;

set local search_path = public, extensions;

-- Tunable like every other threshold in this module.
alter table attendance_settings
  add column if not exists reason_edit_window_min integer not null default 2;

create or replace function set_my_alert_reason(p_alert_id uuid, p_reason text)
returns timestamptz
language plpgsql security definer set search_path = public
as $$
declare
  v_me     uuid := attendance_my_crew_id();
  v_row    alerts%rowtype;
  v_window integer;
  v_at     timestamptz;
begin
  if v_me is null then
    raise exception 'Your login is not linked to a worker record.';
  end if;
  if coalesce(btrim(p_reason), '') = '' then
    raise exception 'Enter a reason.';
  end if;

  select * into v_row from alerts where id = p_alert_id and crew_id = v_me;
  if not found then
    raise exception 'That alert is not yours.';
  end if;
  if v_row.status <> 'open' then
    raise exception 'Your admin has already reviewed this.';
  end if;

  select reason_edit_window_min into v_window from attendance_settings;

  -- Each failure says which one it was, so the app can show the worker
  -- something true rather than a catch-all.
  if v_row.worker_reason_at is not null
     and v_row.worker_reason_at <= now() - make_interval(mins => coalesce(v_window, 2)) then
    raise exception 'The % minutes to change your reason have passed.', coalesce(v_window, 2);
  end if;

  update alerts
     set worker_reason    = btrim(p_reason),
         -- Anchored to the first save: revising does not buy more time.
         worker_reason_at = coalesce(worker_reason_at, now())
   where id = p_alert_id
  returning worker_reason_at into v_at;

  return v_at;
end $$;

revoke all on function set_my_alert_reason(uuid, text) from public;
grant execute on function set_my_alert_reason(uuid, text) to authenticated;

commit;

-- ============================================================================
-- §VERIFY
--   select reason_edit_window_min from attendance_settings;   -- 2
--
-- TO CHANGE THE WINDOW
--   update attendance_settings set reason_edit_window_min = 5;
--
-- ROLLBACK
--   alter table attendance_settings drop column if exists reason_edit_window_min;
--   -- then re-run the Phase 3 migration to restore the previous function
-- ============================================================================
