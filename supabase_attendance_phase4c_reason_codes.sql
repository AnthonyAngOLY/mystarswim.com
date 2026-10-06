-- ============================================================================
-- Star Swim Attendance — Phase 4c: reason codes
-- ----------------------------------------------------------------------------
-- Workers pick a category and may add detail. The category is stored as a code
-- so it can be counted — "four absences from illness this month" is a question
-- free text can never answer.
--
-- Codes, deliberately few and neutral. A long menu of excuses invites picking
-- the softest one; the pay decision stays with the admin either way.
--   sick       unwell
--   family     family emergency
--   transport  traffic, breakdown, no transport
--   venue      pool or venue problem
--   forgot     forgot to tap (a missed punch, not a missed session)
--   other      anything else — detail required
--
-- Additive. The function keeps working for callers that send no code, so the
-- currently deployed app does not break between this and the app shipping.
-- ============================================================================

begin;

set local search_path = public, extensions;

alter table alerts add column if not exists worker_reason_code text;

alter table alerts drop constraint if exists alerts_worker_reason_code_valid;
alter table alerts add constraint alerts_worker_reason_code_valid
  check (worker_reason_code is null or worker_reason_code in
         ('sick','family','transport','venue','forgot','other'));

-- Replaced rather than overloaded: the new argument has a default, so a
-- two-argument call still resolves here and nothing breaks mid-deploy.
drop function if exists set_my_alert_reason(uuid, text);

create or replace function set_my_alert_reason(
  p_alert_id uuid,
  p_reason   text,
  p_code     text default null
)
returns timestamptz
language plpgsql security definer set search_path = public
as $$
declare
  v_me     uuid := attendance_my_crew_id();
  v_row    alerts%rowtype;
  v_window integer;
  v_code   text := nullif(btrim(coalesce(p_code, '')), '');
  v_text   text := nullif(btrim(coalesce(p_reason, '')), '');
  v_at     timestamptz;
begin
  if v_me is null then
    raise exception 'Your login is not linked to a worker record.';
  end if;

  if v_code is not null and v_code not in
     ('sick','family','transport','venue','forgot','other') then
    raise exception 'Unknown reason.';
  end if;

  -- A category on its own is enough, except "other", which says nothing by
  -- itself. With no category at all there must be words.
  if v_code is null and v_text is null then
    raise exception 'Enter a reason.';
  end if;
  if v_code = 'other' and v_text is null then
    raise exception 'Tell us what happened.';
  end if;

  select * into v_row from alerts where id = p_alert_id and crew_id = v_me;
  if not found then
    raise exception 'That alert is not yours.';
  end if;
  if v_row.status <> 'open' then
    raise exception 'Your admin has already reviewed this.';
  end if;

  select reason_edit_window_min into v_window from attendance_settings;

  if v_row.worker_reason_at is not null
     and v_row.worker_reason_at <= now() - make_interval(mins => coalesce(v_window, 2)) then
    raise exception 'The % minutes to change your reason have passed.', coalesce(v_window, 2);
  end if;

  update alerts
     set worker_reason      = v_text,
         worker_reason_code = v_code,
         -- Anchored to the first save: revising does not buy more time.
         worker_reason_at   = coalesce(worker_reason_at, now())
   where id = p_alert_id
  returning worker_reason_at into v_at;

  return v_at;
end $$;

revoke all on function set_my_alert_reason(uuid, text, text) from public;
grant execute on function set_my_alert_reason(uuid, text, text) to authenticated;

commit;

-- ============================================================================
-- §VERIFY
--   select count(*) from information_schema.columns
--    where table_name='alerts' and column_name='worker_reason_code';   -- 1
--
-- ONCE THERE IS DATA — what people actually say
--   select worker_reason_code, count(*)
--     from alerts where worker_reason_code is not null
--    group by 1 order by 2 desc;
--
-- ROLLBACK
--   alter table alerts drop column if exists worker_reason_code;
--   -- then re-run phase3b to restore the two-argument function
-- ============================================================================
