-- ============================================================================
-- Star Swim Attendance — Phase 4b: an absence supersedes its no-check-in
-- ----------------------------------------------------------------------------
-- A missed session raises two alerts: "no check-in" fifteen minutes after it
-- starts, then "absent" once it ends. Both stayed open, so the worker was
-- asked to explain the same thing twice, and the admin had two rows to clear
-- for one event.
--
-- An absence IS no check-in. The earlier alert is superseded.
--
-- If the worker already explained themselves on the no-check-in alert — "stuck
-- in traffic, won't make it" — that reason carries over to the absence rather
-- than being buried in a closed row. It is the same explanation for the same
-- event, and the admin should find it where they are making the decision.
--
-- Additive. Safe to apply while the app is running.
-- ============================================================================

begin;

set local search_path = public, extensions;

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
      and s.shift_date between (now() at time zone v_set.timezone)::date - 1
                           and (now() at time zone v_set.timezone)::date
  loop
    -- Absent: session ended, nothing at all.
    if now() > r.ends_at and not r.has_in then
      -- Whatever they already said about not turning up belongs on the
      -- absence too; it is the same explanation for the same event.
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

      -- The earlier alert is now redundant. Closed, not deleted: it stays in
      -- the log showing when the absence was first noticed.
      update alerts
         set status            = 'resolved',
             resolution_action = 'superseded_by_absence',
             resolved_at       = now()
       where shift_id = r.id and type = 'no_checkin' and status = 'open';

      update shifts set status = 'absent', updated_at = now()
        where id = r.id and status in ('scheduled','geofence_flag');

    -- No check-in: past the alert threshold but the session has not ended yet.
    elsif now() > r.starts_at + make_interval(mins => v_set.no_checkin_alert_min)
          and not r.has_in then
      insert into alerts (shift_id, crew_id, type)
      values (r.id, r.crew_id, 'no_checkin')
      on conflict do nothing;
      get diagnostics v_ins = row_count;
      v_count := v_count + v_ins;
    end if;

    -- No check-out: checked in, session over, still open.
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

-- ─── Clean up pairs already raised ──────────────────────────────────────────
-- Carry the reason across first, then close the superseded alert.
update alerts b
   set worker_reason    = a.worker_reason,
       worker_reason_at = a.worker_reason_at
  from alerts a
 where b.type = 'absent'
   and a.type = 'no_checkin'
   and a.shift_id = b.shift_id
   and b.worker_reason is null
   and a.worker_reason is not null;

update alerts a
   set status            = 'resolved',
       resolution_action = 'superseded_by_absence',
       resolved_at       = now()
 where a.type = 'no_checkin'
   and a.status = 'open'
   and exists (select 1 from alerts b
                where b.shift_id = a.shift_id and b.type = 'absent');

commit;

-- ============================================================================
-- §VERIFY — should return 0
--   select count(*) as duplicate_pairs
--   from alerts a
--   where a.type = 'no_checkin' and a.status = 'open'
--     and exists (select 1 from alerts b
--                  where b.shift_id = a.shift_id and b.type = 'absent');
--
-- ROLLBACK
--   -- re-run the Phase 1 migration to restore the previous scan function;
--   -- alerts already superseded stay closed, which is the desired state anyway.
-- ============================================================================
