-- ════════════════════════════════════════════════════════════════════════
--  What the parent actually told us about the child
-- ════════════════════════════════════════════════════════════════════════
--  Run this whole file in the Supabase SQL editor. Safe to re-run.
--
--  Then run supabase_rls_guard.sql. This creates a table.
--
--  WHY
--  The hardcopy form asks six questions — the PAR-Q — about heart
--  conditions, dizziness, joints, medication, learning and behavioural
--  needs, and anything else. The digital form asked none of them. It
--  collected a name, a date of birth, a gender and a signature, and the
--  terms the parent signed then declared on their behalf that the child
--  "does not have any known medical, physical or psychological condition
--  that would prevent safe participation".
--
--  So a parent whose child has epilepsy signed a statement saying
--  otherwise, because the form gave them nowhere to say it. And clause
--  9.4 of those same terms says non-disclosure may mean withdrawal
--  without refund. We were holding families to a disclosure obligation
--  through a form with no disclosure in it.
--
--  WHAT THIS HOLDS
--  One row per child per signing. Not updated in place: a declaration is
--  what was said on a date, and a parent telling us something new in
--  March does not change what they told us in November. The newest row
--  is the current picture; the older ones are why nobody has to take
--  anybody's word for what was known when.
--
--  WHO READS IT
--  The office, and the parent for their own children. Deliberately NOT
--  the public key, and deliberately not written from the browser: the
--  intake form posts to public-intake, which holds the service role.
-- ════════════════════════════════════════════════════════════════════════


-- ─── 1. The declaration ─────────────────────────────────────────────────
create table if not exists student_health_declarations (
  id              uuid primary key default gen_random_uuid(),
  student_id      uuid not null references students(id) on delete cascade,

  -- Ties this to the signature it was given under, so the answers and
  -- the agreement they were attached to can be shown together.
  acceptance_id   text,
  declared_at     timestamptz not null default now(),
  declared_by     text,

  -- The six, in the order the hardcopy asks them. Null means not
  -- answered, which is not the same as no and must not read as one.
  q_supervision   boolean,   -- advised to exercise only under supervision
  q_chest_pain    boolean,   -- chest pain, dizziness, fainting, balance
  q_bone_joint    boolean,   -- a bone or joint condition exercise worsens
  q_medication    boolean,   -- heart, blood pressure, chronic medication
  q_learning      boolean,   -- learning difficulty or behavioural need
  q_other         boolean,   -- any other reason

  -- What they wrote. Required where any answer is yes, which the form
  -- and the Edge Function both enforce; the constraint below is the
  -- backstop rather than the only guard.
  details         text,

  -- The wording these answers were given against, so a later rewording
  -- does not quietly re-interpret an old declaration.
  questions_version integer not null default 1,

  created_at      timestamptz not null default now(),

  constraint health_details_when_yes check (
    not (coalesce(q_supervision,false) or coalesce(q_chest_pain,false)
      or coalesce(q_bone_joint,false)  or coalesce(q_medication,false)
      or coalesce(q_learning,false)    or coalesce(q_other,false))
    or nullif(btrim(coalesce(details,'')),'') is not null
  )
);

create index if not exists health_decl_student_idx
  on student_health_declarations (student_id, declared_at desc);

comment on table student_health_declarations is
  'What a parent answered to the six health questions, per child, per '
  'signing. Never updated in place: a declaration is what was said on a '
  'date.';


-- ─── 2. Does this child have anything disclosed ─────────────────────────
-- The newest declaration only. Used by the office screens and, next, by
-- the coach's class list — somebody standing in the water with twenty
-- children ought to know which of them has something on file, without
-- being shown what it is in front of other parents.
create or replace function student_health_flag(p_student uuid)
returns jsonb
language sql stable security definer set search_path = public as $$
  select case when h.id is null then jsonb_build_object('known', false)
         else jsonb_build_object(
           'known', true,
           'any', (coalesce(h.q_supervision,false) or coalesce(h.q_chest_pain,false)
                or coalesce(h.q_bone_joint,false)  or coalesce(h.q_medication,false)
                or coalesce(h.q_learning,false)    or coalesce(h.q_other,false)),
           'declared_at', h.declared_at)
         end
    from (select 1) z
    left join lateral (
      select * from student_health_declarations d
       where d.student_id = p_student
       order by d.declared_at desc limit 1
    ) h on true
   where is_website_login() or my_parent_account_id() is not null;
$$;


-- ─── 3. The declaration itself, for whoever may see it ──────────────────
-- The office sees any child's. A parent sees their own children's and
-- nobody else's. There is no third case: a coach gets the flag above,
-- not the text, because a medical note is not something to put on a
-- screen held at a poolside.
create or replace function health_for_student(p_student uuid)
returns table (
  id              uuid,
  declared_at     timestamptz,
  declared_by     text,
  acceptance_id   text,
  q_supervision   boolean,
  q_chest_pain    boolean,
  q_bone_joint    boolean,
  q_medication    boolean,
  q_learning      boolean,
  q_other         boolean,
  details         text,
  is_current      boolean
)
language sql stable security definer set search_path = public as $$
  select d.id::uuid, d.declared_at, d.declared_by::text, d.acceptance_id::text,
         d.q_supervision, d.q_chest_pain, d.q_bone_joint,
         d.q_medication, d.q_learning, d.q_other,
         d.details::text,
         (d.id = first_value(d.id) over (order by d.declared_at desc))::boolean
    from student_health_declarations d
   where d.student_id = p_student
     and (
       can_write_office()
       or exists (select 1 from students s
                   where s.id = p_student
                     and s.account_id is not null
                     and s.account_id = my_parent_account_id())
     )
   order by d.declared_at desc;
$$;


-- ─── 4. Who has told us something ───────────────────────────────────────
-- The office list. Only that there is something and when, plus the text,
-- because the office is who acts on it.
create or replace function health_disclosures()
returns table (
  student_id   uuid,
  child        text,
  parent       text,
  declared_at  timestamptz,
  details      text
)
language sql stable security definer set search_path = public as $$
  select s.id::uuid, s.name::text,
         coalesce(nullif(btrim(pa.display_name), ''), '—')::text,
         d.declared_at,
         d.details::text
    from students s
    join lateral (
      select * from student_health_declarations x
       where x.student_id = s.id order by x.declared_at desc limit 1
    ) d on true
    left join parent_accounts pa on pa.id = s.account_id
   where can_write_office()
     and s.is_active is not false
     and (coalesce(d.q_supervision,false) or coalesce(d.q_chest_pain,false)
       or coalesce(d.q_bone_joint,false)  or coalesce(d.q_medication,false)
       or coalesce(d.q_learning,false)    or coalesce(d.q_other,false))
   order by d.declared_at desc, s.name;
$$;


-- ─── 5. Locks ───────────────────────────────────────────────────────────
alter table student_health_declarations enable row level security;
drop policy if exists health_decl_office on student_health_declarations;
-- Office only, and through the table. Parents read theirs through
-- health_for_student, which is a definer function and checks the account.
-- The public key gets nothing: the intake form writes through
-- public-intake, which holds the service role.
create policy health_decl_office on student_health_declarations for all
  using (can_write_office()) with check (can_write_office());
revoke all on student_health_declarations from anon;

revoke all on function student_health_flag(uuid)  from public, anon;
revoke all on function health_for_student(uuid)   from public, anon;
revoke all on function health_disclosures()       from public, anon;
grant execute on function student_health_flag(uuid) to authenticated;
grant execute on function health_for_student(uuid)  to authenticated;
grant execute on function health_disclosures()      to authenticated;


-- ─── 6. What is on file ─────────────────────────────────────────────────
select 'declarations on file'            as thing, count(*)::text as n
  from student_health_declarations
union all
select 'children they cover',
       count(distinct student_id)::text from student_health_declarations
union all
select 'children with something disclosed',
       count(*)::text from (
         select d.student_id
           from student_health_declarations d
           join lateral (select max(declared_at) m
                           from student_health_declarations x
                          where x.student_id = d.student_id) l
             on l.m = d.declared_at
          where coalesce(d.q_supervision,false) or coalesce(d.q_chest_pain,false)
             or coalesce(d.q_bone_joint,false)  or coalesce(d.q_medication,false)
             or coalesce(d.q_learning,false)    or coalesce(d.q_other,false)) z
union all
select 'active swimmers with no declaration at all',
       count(*)::text from students s
 where s.is_active is not false
   and not exists (select 1 from student_health_declarations d
                    where d.student_id = s.id);
