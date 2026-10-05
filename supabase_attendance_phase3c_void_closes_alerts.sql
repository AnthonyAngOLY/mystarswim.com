-- ============================================================================
-- Star Swim Attendance — Phase 3c: removing a session closes its alerts
-- ----------------------------------------------------------------------------
-- A voided session is invisible to the worker, by design. But its alerts
-- stayed open, so the admin panel said "No reason given yet — they can add one
-- from their app" about a session that is not in their app, and the worker's
-- own screen told them something earlier needed a reason while showing nothing
-- to explain. A dead end on both sides.
--
-- Removing a session IS the decision: there is nothing left to adjudicate. So
-- its open alerts resolve themselves and become log entries.
--
-- Done as a trigger rather than in the app so it holds however a session is
-- voided — the roster, a future bulk tool, or a hand-written UPDATE.
--
-- Additive. Safe to apply while the app is running.
-- ============================================================================

begin;

set local search_path = public, extensions;

create or replace function attendance_close_alerts_on_void()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  -- Only on the transition into voided, so re-saving a voided session does
  -- not keep rewriting resolved_at.
  if new.is_void and not coalesce(old.is_void, false) then
    update alerts
       set status            = 'resolved',
           resolution_action = 'session_removed',
           resolved_at       = now()
     where shift_id = new.id
       and status = 'open';
  end if;
  return new;
end $$;

drop trigger if exists shifts_void_closes_alerts on shifts;
create trigger shifts_void_closes_alerts
  after update of is_void on shifts
  for each row execute function attendance_close_alerts_on_void();

-- Close anything already orphaned by a session removed before this shipped.
update alerts a
   set status            = 'resolved',
       resolution_action = 'session_removed',
       resolved_at       = now()
  from shifts s
 where s.id = a.shift_id
   and s.is_void
   and a.status = 'open';

commit;

-- ============================================================================
-- §VERIFY  — should return 0
--   select count(*) as orphaned_open_alerts
--   from alerts a join shifts s on s.id = a.shift_id
--   where s.is_void and a.status = 'open';
--
-- ROLLBACK
--   drop trigger if exists shifts_void_closes_alerts on shifts;
--   drop function if exists attendance_close_alerts_on_void();
--   -- alerts already closed stay closed; reopen individually if ever needed:
--   -- update alerts set status='open', resolution_action=null, resolved_at=null
--   --  where resolution_action='session_removed';
-- ============================================================================
