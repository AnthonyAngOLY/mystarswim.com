-- ════════════════════════════════════════════════════════════════════════
--  An alert you have already dealt with stays dealt with
-- ════════════════════════════════════════════════════════════════════════
--  Run this whole file in the Supabase SQL editor. It is safe to re-run.
--
--  THE BUG
--  Resolve an absence, and minutes later the same session raises the
--  same alert again. Resolve it again, and it comes back again. One
--  session in testing collected three identical "Absent" rows.
--
--  The scan deduped with `on conflict do nothing`, which leans on this
--  index:
--
--      alerts_open_unique unique (shift_id, type) where status = 'open'
--
--  It is a PARTIAL index. The moment you resolve an alert its status
--  stops being 'open' and the row drops out of the index — so the next
--  scan finds nothing to conflict with and raises a fresh one. The
--  dedupe only ever prevented two alerts being open at once. It was
--  never able to prevent the one thing that actually happens, which is
--  the same alert coming back after somebody has dealt with it.
--
--  THE FIX
--  Ask the question that matters: has this session ever raised this kind
--  of alert? An alert is a record that something was noticed. Noticing
--  it again every five minutes is not new information, and asking an
--  administrator to decide the same absence three times teaches them to
--  stop reading the list.
--
--  The index stays — it is still a correct backstop against two open at
--  once, and against two scans overlapping.
--
--  This does not touch alerts already standing. Resolve the duplicates
--  once more after running it and they will stay resolved; the query at
--  the bottom shows how many are waiting.
-- ════════════════════════════════════════════════════════════════════════

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

      -- Raised once per session, ever. `on conflict do nothing` only
      -- stopped a second OPEN one, so resolving the first let the next
      -- scan raise another.
      insert into alerts (shift_id, crew_id, type, worker_reason, worker_reason_at)
      select r.id, r.crew_id, 'absent', v_reason, v_reason_at
       where not exists (select 1 from alerts a
                          where a.shift_id = r.id and a.type = 'absent')
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
      select r.id, r.crew_id, 'no_checkin'
       where not exists (select 1 from alerts a
                          where a.shift_id = r.id and a.type = 'no_checkin')
      on conflict do nothing;
      get diagnostics v_ins = row_count;
      v_count := v_count + v_ins;
    end if;

    if r.has_in and not r.has_out
       and now() > r.ends_at + make_interval(mins => v_set.no_checkout_alert_min) then
      insert into alerts (shift_id, crew_id, type)
      select r.id, r.crew_id, 'no_checkout'
       where not exists (select 1 from alerts a
                          where a.shift_id = r.id and a.type = 'no_checkout')
      on conflict do nothing;
      get diagnostics v_ins = row_count;
      v_count := v_count + v_ins;
      update shifts set status = 'incomplete', updated_at = now()
        where id = r.id and status in ('scheduled','late','geofence_flag');
    end if;
  end loop;

  return v_count;
end $$;

-- ── How many duplicates are standing right now ──────────────────────────
-- More than one alert of the same kind on the same session means the old
-- scan got there first. Resolve them once more; they will stay resolved.
select s.shift_date, s.start_time, a.type, count(*) as copies,
       count(*) filter (where a.status = 'open') as still_open
  from alerts a join shifts s on s.id = a.shift_id
 group by s.shift_date, s.start_time, a.shift_id, a.type
having count(*) > 1
 order by s.shift_date desc, s.start_time;
