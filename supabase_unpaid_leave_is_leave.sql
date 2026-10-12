-- ════════════════════════════════════════════════════════════════════════
--  Unpaid leave is leave, not an attendance decision
-- ════════════════════════════════════════════════════════════════════════
--  Run this whole file in the Supabase SQL editor. It is safe to re-run.
--  Deploy the matching site update first or at the same time; running this
--  alone is harmless, it just means nothing writes the flag yet.
--
--  THE PROBLEM
--  shifts.is_unpaid_leave is the column the attendance report's "Unpaid
--  leave" figure comes from, and that figure is what payroll deducts. It
--  was being set in one place only: a checkbox on the absence alert, after
--  the day had already gone wrong.
--
--  That is the wrong place and the wrong moment. Unpaid leave is asked for
--  in advance — when somebody has no annual leave left — and approved. A
--  session that was rostered and not worked is an absence, and the decision
--  there is whether to deduct it, which is a different question with a
--  different answer.
--
--  Worse, approving actual unpaid leave never set the flag at all. It set
--  status = 'on_leave' and stopped. So the column that drives a deduction
--  has, until now, been measuring the wrong thing entirely.
--
--  THE FIX
--  decide_leave sets is_unpaid_leave from the leave type: true when the
--  type is not paid, false when it is. The checkbox is gone from the
--  alert, in the same change.
--
--  Set on approval and cleared on anything else, rather than only ever set
--  — a request approved as unpaid and later corrected to annual must not
--  leave a deduction behind it.
-- ════════════════════════════════════════════════════════════════════════

create or replace function decide_leave(
  p_request_id uuid,
  p_status     text,
  p_note       text default null
)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_row    leave_requests%rowtype;
  v_unpaid boolean;
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

  -- Whether this kind of leave is paid is a property of the type, set once
  -- in leave_types. Nobody decides it per application, which is the point.
  select not t.is_paid into v_unpaid
    from leave_types t where t.id = v_row.leave_type_id;
  v_unpaid := coalesce(v_unpaid, false);

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
       set status          = 'on_leave',
           is_unpaid_leave = v_unpaid,
           updated_at      = now()
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
       and s.crew_id = v_row.crew_id
       and s.shift_date between v_row.start_date and v_row.end_date;
  end if;
end $$;

-- ── Clear the flags the old checkbox left behind ────────────────────────
-- An absence is an absence. Where the old alert resolution marked one as
-- unpaid leave, the deduction decision now lives in the alert's
-- pay_treatment, not on the shift.
select count(*) as absences_wrongly_flagged_unpaid
  from shifts where is_unpaid_leave and status <> 'on_leave';

update shifts
   set is_unpaid_leave = false, updated_at = now()
 where is_unpaid_leave and status <> 'on_leave';

-- ── Clear the pay treatment nobody chose ────────────────────────────────
-- Resolving an absence wrote pay_treatment = 'none' although the control
-- was hidden for absences, so the record claimed a decision that was never
-- made. Left alone, it would read as "an administrator looked at this and
-- decided not to dock it" the moment pay rates are wired up.
select count(*) as absences_with_an_unchosen_pay_treatment
  from alerts where type = 'absent' and pay_treatment = 'none';

update alerts
   set pay_treatment = null
 where type = 'absent' and pay_treatment = 'none';

update shifts s
   set pay_treatment = null, updated_at = now()
 where s.status = 'absent' and s.pay_treatment = 'none'
   and exists (select 1 from alerts a
                where a.shift_id = s.id and a.type = 'absent');

-- ── What you should see ─────────────────────────────────────────────────
select 'shifts still flagged unpaid'   as check, count(*) as rows
  from shifts where is_unpaid_leave and status <> 'on_leave'
union all
select 'absences claiming no deduction', count(*)
  from alerts where type = 'absent' and pay_treatment = 'none';
