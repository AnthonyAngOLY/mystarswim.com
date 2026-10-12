-- ════════════════════════════════════════════════════════════════════════
--  A check-in from the wrong place stops being a to-do
-- ════════════════════════════════════════════════════════════════════════
--  Run this in the Supabase SQL editor AFTER redeploying the `punch`
--  function. Order matters only in that running it first would leave the
--  queue to refill; it is safe either way.
--
--  WHY
--  A check-in from outside a location's radius is refused at the moment
--  the worker taps. They are told the distance and the place, and nothing
--  is recorded as worked. Nobody is asked to explain it afterwards.
--
--  So the `geofence` alert it used to raise had no job. An alert is a
--  thing somebody must come and close; this one only ever got closed to
--  make it go away. Meanwhile the attempt itself was never in danger of
--  being lost: the punches table holds the time, the coordinates, the
--  distance, the GPS accuracy and the verdict, and the Live screen shows
--  it against the session with a map link.
--
--  `punch` no longer raises them. This closes the ones already standing.
--
--  WHAT THIS DOES NOT DO
--  It does not touch the punches. It does not touch the shift status —
--  a session with a refused attempt still reads "Flagged" in amber on the
--  roster and the report, which is information, not a task. And it does
--  not delete the alerts: they are closed, so the history of what was
--  raised and when stays readable.
-- ════════════════════════════════════════════════════════════════════════

begin;

-- What is about to change.
select count(*) as geofence_alerts_to_close
  from alerts
 where type = 'geofence' and status = 'open';

update alerts
   set status            = 'resolved',
       resolution_action = 'check_in_refused',
       resolved_at       = now(),
       -- resolved_by stays null on purpose: no person decided this.
       remark            = coalesce(remark,
                             'Closed in bulk: a refused check-in needs no resolution. '
                             || 'The attempt is on the punch log.')
 where type = 'geofence'
   and status = 'open';

-- Nothing should be left open.
select count(*) as geofence_alerts_still_open
  from alerts
 where type = 'geofence' and status = 'open';

commit;
