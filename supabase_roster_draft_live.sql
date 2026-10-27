-- ════════════════════════════════════════════════════════════════════════
--  A roster you are still writing is not a roster anybody is held to
-- ════════════════════════════════════════════════════════════════════════
--  Safe to re-run. Creates one table, replaces the alert scanner, narrows
--  one policy, and closes the alerts that were raised against a roster
--  nobody had agreed to yet. Nothing is deleted.
--
--  WHAT WENT WRONG
--  A shift existed or it did not, and the moment it existed the system
--  began holding somebody to it: fifteen minutes past the hour it raised
--  "no check-in", and at the end of the session "absent". That is right
--  for a roster in force. It is wrong for a roster being drafted, which
--  is what the centre is doing now — laying out next week while the old
--  paper method is still the one in use. Every line typed fired an
--  accusation at a member of staff who was never told to be there.
--
--  A WEEK IS DRAFT UNTIL SOMEBODY SAYS OTHERWISE
--  Publication belongs to the week, not to the shift. A roster is read a
--  week at a time, agreed a week at a time, and a per-shift switch would
--  mean remembering to flip every line. One toggle per week, and a shift
--  added to a live week is live the moment it is saved.
--
--  A week with no row here is a draft. That is deliberate: the default
--  has to be the quiet one. Forgetting to publish means nobody is
--  chased, which somebody notices by Tuesday. Forgetting to un-publish
--  means a fortnight of false absences in everybody's record, which is
--  much harder to undo than to prevent.
--
--  WHAT DRAFT MEANS, EXACTLY
--    - No alerts. Not raised, not queued, not raised later.
--    - Invisible to the worker. It is not on their phone, so they cannot
--      act on a plan that may still change.
--    - Cannot be punched against, even by somebody who kept the link.
--    - Invisible to the coach's class screen, which finds classes
--      through the shift standing beside them.
--    - Fully visible to the office, marked as draft on every screen.
-- ════════════════════════════════════════════════════════════════════════


-- ─── 1. The week, and whether it is in force ────────────────────────────
create table if not exists roster_weeks (
  -- Always a Monday: the roster screens draw Monday to Sunday, and two
  -- rows for one week would be two answers to one question.
  week_start   date primary key,
  published_at timestamptz,
  published_by text,
  created_at   timestamptz not null default now(),
  constraint roster_weeks_is_monday check (extract(isodow from week_start) = 1)
);

comment on table roster_weeks is
  'One row per rostered week. published_at null, or no row at all, means '
  'the week is a draft: no alerts, invisible to staff, cannot be punched.';

-- The Monday a date belongs to. Written once so every caller agrees.
create or replace function roster_week_of(p_date date)
returns date language sql immutable as $$
  select p_date - (extract(isodow from p_date)::int - 1);
$$;

create or replace function roster_week_is_live(p_date date)
returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from roster_weeks w
     where w.week_start = roster_week_of(p_date)
       and w.published_at is not null);
$$;

comment on function roster_week_is_live(date) is
  'Is the roster for the week containing this date in force? No row means '
  'no — the quiet answer is the default on purpose.';


-- ─── 2. The toggle ──────────────────────────────────────────────────────
-- Returns what it did and what it is about to mean, so the screen can
-- say something truthful before and after rather than just "done".
create or replace function set_roster_week(p_week_start date, p_live boolean)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_mon     date;
  v_who     text;
  v_shifts  int;
  v_past    int;
  v_punches int;
  v_today   date;
begin
  if not can_write_office() then
    return jsonb_build_object('ok', false, 'error', 'Not yours to publish.');
  end if;
  if p_week_start is null then
    return jsonb_build_object('ok', false, 'error', 'Which week?');
  end if;

  v_mon := roster_week_of(p_week_start);
  v_today := (now() at time zone 'Asia/Kuala_Lumpur')::date;

  select count(*),
         count(*) filter (where s.shift_date < v_today),
         coalesce(sum((select count(*) from punches p where p.shift_id = s.id)), 0)
    into v_shifts, v_past, v_punches
    from shifts s
   where not s.is_void
     and s.shift_date between v_mon and v_mon + 6;

  select coalesce(nullif(btrim(coalesce(
           (select e.full_name from admin_employees e
             where e.id = attendance_my_crew_id()), '')), ''), 'the office')
    into v_who;

  if p_live then
    insert into roster_weeks (week_start, published_at, published_by)
    values (v_mon, now(), v_who)
    on conflict (week_start) do update
      set published_at = now(), published_by = v_who;
  else
    -- Kept as a row rather than deleted, so the screen can say when it
    -- was last live and who pulled it back.
    insert into roster_weeks (week_start, published_at, published_by)
    values (v_mon, null, v_who)
    on conflict (week_start) do update
      set published_at = null, published_by = v_who;

    -- Alerts raised while it was live are about a roster that no longer
    -- stands. Closed, never deleted, and labelled with the reason so
    -- nobody reads them later as a record of somebody not turning up.
    update alerts a
       set status = 'resolved',
           resolution_action = 'roster_returned_to_draft',
           resolved_at = now()
     where a.status = 'open'
       and exists (select 1 from shifts s
                    where s.id = a.shift_id
                      and s.shift_date between v_mon and v_mon + 6);

    -- And the mark the scanner left on the shift itself. Closing the
    -- alert without this leaves the week showing red absences on a
    -- roster that is back to being a draft — the very thing the toggle
    -- was pulled for. A shift somebody actually punched against keeps
    -- its status: that happened, whatever the roster says now.
    update shifts s
       set status = 'scheduled', updated_at = now()
     where s.status in ('absent','incomplete')
       and not s.is_void
       and s.shift_date between v_mon and v_mon + 6
       and not exists (select 1 from punches p where p.shift_id = s.id);
  end if;

  return jsonb_build_object(
    'ok', true, 'week_start', v_mon, 'live', p_live,
    'shifts', v_shifts, 'past_shifts', v_past, 'punches', v_punches,
    'by', v_who);
end $$;

comment on function set_roster_week(date, boolean) is
  'Publishes a week of the roster, or returns it to draft. Returning it '
  'to draft also closes the alerts it raised while it stood.';

-- What the screens ask before they draw the week.
create or replace function roster_week_state(p_week_start date)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_mon date; w roster_weeks; v_shifts int; v_past int; v_today date;
begin
  v_mon := roster_week_of(p_week_start);
  v_today := (now() at time zone 'Asia/Kuala_Lumpur')::date;
  select * into w from roster_weeks where week_start = v_mon;
  select count(*), count(*) filter (where s.shift_date < v_today)
    into v_shifts, v_past
    from shifts s
   where not s.is_void and s.shift_date between v_mon and v_mon + 6;
  return jsonb_build_object(
    'week_start', v_mon,
    'live', (w.published_at is not null),
    'published_at', w.published_at,
    'published_by', w.published_by,
    'shifts', v_shifts,
    'past_shifts', v_past);
end $$;


-- ─── 3. The alert scanner stops at the draft line ───────────────────────
-- The whole body is restated rather than patched, because this function
-- has been replaced three times already and a reader needs to see what
-- it does now, not reconstruct it from a chain of files. The only change
-- from Phase 4b is the roster_week_is_live condition on the loop.
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
      -- A draft week holds nobody to anything.
      and roster_week_is_live(s.shift_date)
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


-- ─── 4. A draft shift is not on anybody's phone ─────────────────────────
-- Narrowed rather than added to: a second policy would be OR'd with this
-- one and would hand back exactly what this is meant to withhold.
drop policy if exists shifts_worker_read on shifts;
create policy shifts_worker_read on shifts for select
  using (crew_id = attendance_my_crew_id()
         and not is_void
         and roster_week_is_live(shift_date));


-- ─── 5. Nor on the coach's class screen ─────────────────────────────────
-- get_my_session_roster finds a coach's classes through the shift they
-- are standing in. A draft shift is not one they have been asked to
-- stand in, so it finds nothing through it.
create or replace function roster_shift_is_live(p_shift uuid)
returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from shifts s
                  where s.id = p_shift and not s.is_void
                    and roster_week_is_live(s.shift_date));
$$;


-- ─── 6. Close what was raised against a draft ───────────────────────────
-- Every week is a draft the moment this file runs, because no week has a
-- row yet. The alerts already standing were raised against a roster
-- nobody had published. They are closed and labelled, not deleted: the
-- row stays, and reads as what it was rather than as an absence.
update alerts a
   set status = 'resolved',
       resolution_action = 'raised_before_roster_was_published',
       resolved_at = now()
 where a.status = 'open'
   and exists (select 1 from shifts s
                where s.id = a.shift_id
                  and not roster_week_is_live(s.shift_date));

-- A shift marked absent by the old scanner is put back to scheduled for
-- the same reason: nobody failed to turn up to a plan they were never
-- shown.
update shifts s
   set status = 'scheduled', updated_at = now()
 where s.status in ('absent','incomplete')
   and not s.is_void
   and not roster_week_is_live(s.shift_date)
   and not exists (select 1 from punches p where p.shift_id = s.id);


-- ─── 7. What this just did ──────────────────────────────────────────────
select 'weeks with shifts, all now draft' as thing,
       count(distinct roster_week_of(shift_date))::text as n
  from shifts where not is_void
union all
select 'shifts now invisible to staff', count(*)::text
  from shifts where not is_void and not roster_week_is_live(shift_date)
union all
select 'alerts closed as raised-before-publishing', count(*)::text
  from alerts where resolution_action = 'raised_before_roster_was_published'
union all
select 'alerts still open', count(*)::text
  from alerts where status = 'open';
