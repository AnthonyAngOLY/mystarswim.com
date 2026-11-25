-- ════════════════════════════════════════════════════════════════════════
--  Certificates: who has one waiting, and recording that it was handed over
-- ════════════════════════════════════════════════════════════════════════
--  Run this whole file in the Supabase SQL editor. Safe to re-run.
--  It creates no table, so no row-security guard is needed with it.
--
--  RUN supabase_grading_programs.sql AND supabase_grading_coach.sql
--  FIRST. This builds on both.
--
--  WHY
--  The parent app already tells a family a certificate is waiting, and
--  nothing anywhere could record it being handed over. So the app would
--  go on saying it for ever, a parent would ask twice, and the only
--  defence against printing one a second time would be somebody's
--  memory of a Saturday morning.
--
--  WHO MAY MARK IT
--  The same people who may tick a task: the office, or a coach rostered
--  to that child's water. can_note_on_student() again, deliberately --
--  handing a certificate over usually happens at the poolside, by
--  whoever is standing there, and a rule that sent it to the office
--  would mean nobody records it at all.
--
--  IT CAN BE UNDONE
--  Marked in error, the claim comes off and the row says who removed it
--  by leaving claimed_by as the last person to touch it. A certificate
--  the family never received is worse than one recorded twice.
--
--  WHAT IT WILL NOT DO
--  It refuses a milestone the child has not earned, and a milestone that
--  carries no certificate. Either would put a claim on a row the parent
--  app has never offered anything for -- a record of handing over
--  something that does not exist.
-- ════════════════════════════════════════════════════════════════════════


-- ─── 1. Marking it given ────────────────────────────────────────────────
create or replace function claim_certificate(
  p_student uuid, p_milestone uuid, p_claimed boolean default true)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_me    uuid := attendance_my_crew_id();
  v_name  text;
  v_cert  boolean;
  v_live  boolean;
begin
  if not can_note_on_student(p_student) then
    return jsonb_build_object('ok', false,
      'error', 'You are not rostered to this swimmer.');
  end if;

  select m.certificate into v_cert from grading_milestones m where m.id = p_milestone;
  if v_cert is not true then
    return jsonb_build_object('ok', false,
      'error', 'That level does not come with a certificate.');
  end if;

  select (sm.revoked_at is null) into v_live
    from student_milestones sm
   where sm.student_id = p_student and sm.milestone_id = p_milestone;

  if v_live is not true then
    -- Nothing has been offered, so nothing can have been handed over.
    return jsonb_build_object('ok', false,
      'error', 'This swimmer has not earned that level yet.');
  end if;

  -- The name as it stands today. A coach who leaves is still the person
  -- who handed it over.
  select coalesce(nullif(btrim(e.full_name), ''), 'the office')
    into v_name from admin_employees e where e.id = v_me;
  v_name := coalesce(v_name, 'the office');

  update student_milestones
     set certificate_claimed_at = case when p_claimed then now() else null end,
         -- Kept either way: this is the last person who touched it, and
         -- "nobody knows who un-marked it" is the worse record.
         certificate_claimed_by = v_name
   where student_id = p_student and milestone_id = p_milestone;

  return jsonb_build_object('ok', true, 'claimed', p_claimed, 'by', v_name);
end $$;

revoke all on function claim_certificate(uuid, uuid, boolean) from public, anon;
grant execute on function claim_certificate(uuid, uuid, boolean) to authenticated;

comment on function claim_certificate(uuid, uuid, boolean) is
  'Record a certificate handed over, or take the record off. Office or a '
  'coach rostered to the swimmer -- the same rule as ticking a task, '
  'because it happens at the poolside.';


-- ─── 2. Who is owed one ─────────────────────────────────────────────────
-- The office's list: every child who has earned a certificate milestone
-- and not yet been given the certificate. Oldest first, because the one
-- earned in March is the one somebody has been waiting for.
create or replace function certificates_pending()
returns table (
  student_id   uuid,
  student_name text,
  account_name text,
  program_name text,
  milestone_id uuid,
  level_no     integer,
  milestone    text,
  achieved_at  timestamptz,
  claimed_at   timestamptz,
  claimed_by   text
)
language sql stable security definer set search_path = public as $$
  select s.id, s.name::text,
         coalesce(pa.display_name, '—')::text,
         g.name::text, m.id, m.level_no, m.name::text,
         sm.achieved_at, sm.certificate_claimed_at, sm.certificate_claimed_by
    from student_milestones sm
    join grading_milestones m on m.id = sm.milestone_id
    join grading_programs g on g.id = m.program_id
    join students s on s.id = sm.student_id
    left join parent_accounts pa on pa.id = s.account_id
   where can_write_office()
     and m.certificate
     and sm.revoked_at is null
     -- An archived swimmer is not standing at the counter. Their
     -- certificate is not lost -- the office can still see the milestone
     -- on their record -- but a list of who to hand one to should be a
     -- list of people who will be here.
     and s.is_active is not false
   order by (sm.certificate_claimed_at is not null), sm.achieved_at;
$$;

revoke all on function certificates_pending() from public, anon;
grant execute on function certificates_pending() to authenticated;

comment on function certificates_pending() is
  'Every earned certificate, waiting ones first and oldest first within '
  'them. Office only.';


-- ─── 3. What is now in place ────────────────────────────────────────────
select z.k as "#", z.thing, z.detail
  from (
  select 1 k, 'waiting to be handed over' as thing,
         (select count(*)::text from student_milestones sm
            join grading_milestones m on m.id = sm.milestone_id
            join students s on s.id = sm.student_id
           where m.certificate and sm.revoked_at is null
             and sm.certificate_claimed_at is null
             and s.is_active is not false)
      || ' certificate(s). Admin → Settings → Grading lists them.' as detail
  union all
  select 2, 'already given',
         (select count(*)::text from student_milestones
           where certificate_claimed_at is not null)
  union all
  select 3, 'who may mark one',
         'The office, or a coach rostered to that swimmer — the same rule '
      || 'as ticking a task, because it happens at the poolside and a '
      || 'rule that sent it to the office would mean nobody records it.'
  union all
  select 4, 'levels that carry one',
         coalesce((select string_agg(g.name || ' L' || m.level_no || ' ' || m.name, ' · '
                          order by g.sort_order, m.level_no)
                     from grading_milestones m
                     join grading_programs g on g.id = m.program_id
                    where m.certificate and m.is_active),
                  'none yet — set "Offers a certificate" on a level in Admin → Settings → Grading')
  union all
  select 5, 'next',
         'Deploy the attendance app (BUILD 20). The office list is live '
      || 'as soon as the admin app is refreshed.'
  ) z
 order by z.k;
