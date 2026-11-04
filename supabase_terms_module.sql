-- ════════════════════════════════════════════════════════════════════════
--  Terms & Conditions, per branch and per programme
-- ════════════════════════════════════════════════════════════════════════
--  Run this whole file in the Supabase SQL editor. Safe to re-run: the
--  default wording is seeded only if it is not already there, so an
--  edited default is never overwritten by running this again.
--
--  Then run supabase_rls_guard.sql. This creates a table.
--
--  WHAT WAS WRONG
--  The default wording lived in two browser bundles — app.js, which the
--  office reads in Settings, and intake.js, which parents actually sign.
--  They drifted. The office copy grew a Fees & Payment clause and the
--  parents' copy did not, so for weeks every parent signed an agreement
--  with no fees clause in it while the office read one that had it.
--
--  Two copies of a legal document is not a tidiness problem. It is a
--  question nobody can answer about what a family agreed to.
--
--  So the text lives here, once, and both front doors read it. The
--  eleven-section version is the base — the one with the fees clause.
--
--  HOW A DOCUMENT IS PUT TOGETHER
--  Three layers, assembled by terms_for():
--
--    the default          these eleven sections
--    the branch           branches.terms_content, replacing the default
--                         entirely where a branch has its own, as SJKC
--                         Bandar Seri Botani does
--    the programme        scheduler_lesson_types.terms_content, appended
--                         for each programme a child is enrolling in
--
--  A branch replaces; a programme adds. That is the shape the centre
--  described: one set of terms for the place, with the clauses that are
--  particular to a squad or a school course added underneath, and one
--  signature at the end covering all of it.
-- ════════════════════════════════════════════════════════════════════════


-- ─── 1. The default, in one place ───────────────────────────────────────
create table if not exists terms_defaults (
  id         boolean primary key default true check (id),
  body       text not null,
  updated_at timestamptz not null default now(),
  updated_by text
);

comment on table terms_defaults is
  'The base Terms & Conditions, shown where a branch has none of its '
  'own. One row. Previously a copy in each of two browser bundles, '
  'which drifted apart and left parents signing a document the office '
  'was not reading.';

insert into terms_defaults (id, body) values (true, $terms$
1. Introduction
These Terms and Conditions ("Agreement") govern the enrolment and participation of swimmers in swimming lessons and aquatic programmes offered by Star Swim Sdn Bhd ("the School", "we", "our"). By accepting this Agreement, the parent, legal guardian, or adult swimmer ("you") acknowledges having read, understood, and agreed to be bound by these terms. This Agreement constitutes a legally binding contract.

2. Safeguarding & Child Protection
Star Swim Sdn Bhd is committed to providing a safe, inclusive, and supportive aquatic environment for all participants.

2.1 The School adheres to the National Child Protection Principles and Malaysia's Child Act 2001. All instructors undergo background screening and hold current first aid and lifeguard certifications.

2.2 Parents and guardians are required to remain within the facility premises during all sessions involving participants under 12 years of age, unless otherwise agreed in writing.

2.3 Any concerns regarding the welfare of a child, safeguarding issues, or inappropriate conduct should be raised immediately with the School Administrator or reported to: Jabatan Kebajikan Masyarakat (Social Welfare Department) at 1-800-88-3900.

2.4 Photography and video recording of any swimmer — including your own child — are prohibited within pool areas without prior written consent from Star Swim Sdn Bhd and the relevant guardian of every swimmer present.

3. Class Cancellation & Attendance Policy
3.1 Advance Notice: Cancellations must be communicated to the School no less than twenty-four (24) hours before the scheduled class start time. Cancellations received within this 24-hour window will be treated as an Absence unless a valid emergency and accompanying proof are provided.

3.2 Medical Cancellation: Absences due to illness or medical conditions will be considered valid cancellations provided the School receives a copy of a certified Medical Certificate (MC) issued by a registered medical practitioner within 48 hours of the missed class. On receipt of a valid MC, the swimmer is entitled to one (1) replacement class.

3.3 Absence (No Replacement): Where a swimmer is absent without valid 24-hour prior notice or a valid MC, the class will be recorded as "provided," credits will be deducted where applicable, and no replacement lesson will be offered.

3.4 Last-Minute Emergencies: Genuine emergencies (e.g. hospitalisation, accident, bereavement) occurring within the 24-hour window may be considered at the School's discretion upon submission of appropriate supporting documentation.

4. School-Initiated Cancellations
4.1 Weather Conditions: Classes may be suspended or cancelled at the School's sole discretion during adverse weather — including lightning, heavy rainfall, or hazardous pool conditions. Participants will be notified as promptly as possible via WhatsApp or email. Any class cancelled due to weather entitles the swimmer to a full replacement lesson at no additional cost.

4.2 Instructor Cancellation: Should a class be cancelled by Star Swim Sdn Bhd or by an assigned instructor for reasons within the School's control, all affected swimmers are entitled to a replacement lesson. The replacement will be scheduled within the same billing cycle where possible, or carried forward.

5. Replacement Class Policy
5.1 Group Classes: Replacement sessions for group classes may be attended in any currently active class of the same lesson type, provided a slot is available. Replacements must be arranged through the School and are subject to availability. Replacement swimmers are marked as "drop-in replacement" and are not carried forward in subsequent weeks.

5.2 Personal & Private Classes (Personal 1, Personal 2, Personal Toddler, Stroke Lab, Premium Personal, Personal Clara): Replacement sessions for personal classes are to be arranged directly between the assigned instructor and the parent or guardian, subject to mutual time availability and pool space. The School will facilitate communication. Replacement credits will be applied and the rescheduled session logged.

5.3 Validity: Replacement lessons must be utilised within 14 calendar days of the missed class, unless otherwise agreed in writing. Unused replacement entitlements expire at the end of the month in which they were granted.

6. Credit System (Personal & Private Classes)
6.1 Students enrolled in personal or private lesson programmes are allocated a credit balance corresponding to the number of sessions purchased in their package.

6.2 One (1) credit is deducted for each scheduled and attended class. Credits are not deducted for classes cancelled by the School or for classes where a valid MC has been provided.

6.3 Credits are non-refundable and non-transferable to another swimmer. Unused credits at the end of a package cycle are forfeited unless otherwise agreed in writing.

6.4 The School reserves the right to apply a credit deduction when a replacement or rescheduled class is successfully attended.

7. Fees & Payment
7.1 All fees are due in accordance with the payment schedule indicated in your enrolment confirmation. Late payment may result in suspension from classes.

7.2 Fees are non-refundable once a billing cycle has commenced, except in extraordinary circumstances at the School's discretion.

7.3 The School reserves the right to revise fee structures with a minimum of 30 days' written notice.

8. Health, Safety & Medical Disclosure
8.1 Good Health Confirmation: You confirm that the swimmer is in good health and is medically fit to participate in aquatic activities.

8.2 Medical & Behavioural Declaration: You further declare that, to the best of your knowledge, the swimmer named in this registration:
  (a) does not have any known medical, physical, or psychological condition that would prevent safe participation in swimming lessons;
  (b) has not been advised by a medical professional to refrain from physical activity or aquatic programmes;
  (c) is not under any medication or treatment that would interfere with swim lesson participation;
  (d) does not require additional support unless previously disclosed.

8.3 Disclosure Obligation: Any pre-existing medical condition, allergy, behavioural consideration, or physical limitation must be disclosed to the School prior to the commencement of classes. If any such conditions exist, you confirm that you have disclosed them during registration or will inform the School's administrators before lessons commence.

8.4 Consequences of Non-Disclosure: You understand that failure to disclose relevant medical or behavioural information may affect the safety and quality of instruction and may result in withdrawal from the programme without refund.

8.5 Liability: The School is not liable for injuries or health events arising from undisclosed medical or behavioural conditions.

8.6 Emergency Authorisation: In the event of a medical emergency, the School is authorised to administer basic first aid and to contact emergency services. All reasonable effort will be made to contact the designated emergency contact immediately.

9. Liability Waiver
9.1 Participation in aquatic activities carries inherent risks. By accepting this Agreement, you acknowledge these risks and agree that Star Swim Sdn Bhd, its directors, instructors, and staff shall not be liable for any injury, loss, damage, or claim arising from participation in the School's programmes, except where caused by the School's gross negligence or wilful misconduct.

9.2 The School maintains appropriate public liability insurance.

10. Photography, Video & Marketing Consent
10.1 By accepting these Terms, you consent to Star Swim Sdn Bhd taking photographs and video recordings of the swimmer during lessons, classes, and events for the purposes of instructor training, social media, advertising, school newsletters, and other marketing activities undertaken by the School.

10.2 Opt-Out: If you wish to withhold consent for the use of your swimmer's images in marketing materials, please notify the School in writing at the time of registration or thereafter. The School will then take reasonable steps to exclude the swimmer from marketing photography going forward; this opt-out does not retroactively remove already-published materials.

10.3 This School-led photography consent is distinct from the third-party photography restrictions described in clause 2.4. Visitors and other guardians remain prohibited from photographing or recording any swimmer (including their own child within shared pool areas) without prior written consent from Star Swim Sdn Bhd and the relevant guardians of every swimmer present.

11. Acceptance & Governing Law
This Agreement is governed by the laws of Malaysia. Any dispute shall be subject to the jurisdiction of the courts of Malaysia. By electronically accepting, you confirm you have read and agree to all clauses above on behalf of yourself and/or the enrolled swimmer.
$terms$)
on conflict (id) do nothing;


-- ─── 2. What a programme adds ───────────────────────────────────────────
alter table scheduler_lesson_types
  add column if not exists terms_content text;

comment on column scheduler_lesson_types.terms_content is
  'Clauses particular to this programme, appended beneath the branch '
  'terms for any child enrolling in it. Null for a programme that needs '
  'nothing of its own, which is most of them.';


-- ─── 3. Putting one together ────────────────────────────────────────────
-- Returns the whole document a given parent should be shown and sign:
-- the branch''s terms, or the default where it has none, followed by the
-- clauses of each programme any of their children is joining.
--
-- Takes an array of lesson types because one submission can enrol two
-- children on different programmes, and they sign once. Each programme
-- appears at most once however many children are on it.
create or replace function terms_for(
  p_branch_id uuid,
  p_lesson_type_ids uuid[] default null)
returns text
language sql stable security definer set search_path = public as $$
  -- Trimmed because the seeded default carries the newline that
  -- followed its opening dollar-quote, and a document should not begin
  -- with a blank line in a box a parent scrolls.
  --
  -- With the whitespace spelled out: btrim(s) on its own strips spaces
  -- and nothing else, so it left the newline exactly where it was and
  -- looked like it had worked.
  select btrim(
    coalesce(
      nullif(btrim((select b.terms_content from branches b where b.id = p_branch_id),
                   E' \t\n\r'), ''),
      (select d.body from terms_defaults d where d.id)
    )
    || coalesce((
      select string_agg(
               E'\n\n' || lt.name || E' \u2014 additional terms\n'
                 || btrim(lt.terms_content, E' \t\n\r'),
               E'\n\n' order by lt.name)
        from scheduler_lesson_types lt
       where lt.id = any(coalesce(p_lesson_type_ids, '{}'::uuid[]))
         and nullif(btrim(coalesce(lt.terms_content, ''), E' \t\n\r'), '') is not null
    ), ''), E' \t\n\r');
$$;

comment on function terms_for(uuid, uuid[]) is
  'The document to show and record a signature against: branch terms, '
  'or the default, plus the clauses of each programme being joined. A '
  'branch replaces; a programme adds.';


-- ─── 3b. The programmes a parent may pick from ──────────────────────────
-- The intake form has to offer the programmes at the branch they chose,
-- and it is a public page holding only the anon key — which cannot read
-- scheduler_lesson_types, and should not be able to. Stage A closed that
-- table deliberately: it carries fees, ratios and margins.
--
-- So this returns the two columns a parent needs to choose, for active
-- programmes at one branch, and nothing else. No fee, no ratio, no
-- capacity. A function is the narrow door where a policy would have had
-- to be a wide one.
create or replace function public_lesson_types(p_branch_id uuid)
returns table (id uuid, name text)
language sql stable security definer set search_path = public as $$
  select lt.id::uuid, lt.name::text
    from scheduler_lesson_types lt
   where lt.is_active is not false
     and (p_branch_id is null or lt.branch_id = p_branch_id)
   order by coalesce(lt.sort_order, 999), lt.name;
$$;

comment on function public_lesson_types(uuid) is
  'Programme names and ids for the public intake form. Deliberately not '
  'a policy on scheduler_lesson_types, which holds fees and ratios the '
  'anon key has no business reading.';


-- ─── 4. Locks ───────────────────────────────────────────────────────────
alter table terms_defaults enable row level security;
drop policy if exists terms_defaults_read on terms_defaults;
-- Readable by anyone signed in; changed only by a seat that may change
-- things. The public intake form never touches the table — it asks
-- terms_for, which is a function and carries its own permission.
create policy terms_defaults_read on terms_defaults for all
  using (is_website_login()) with check (can_write_office());
revoke all on terms_defaults from anon;

-- The terms are shown on a public form before anybody has signed in, so
-- this one function is reachable with the public key. It returns the
-- document a parent is about to agree to and nothing else.
revoke all on function terms_for(uuid, uuid[]) from public;
grant execute on function terms_for(uuid, uuid[]) to anon, authenticated;
revoke all on function public_lesson_types(uuid) from public;
grant execute on function public_lesson_types(uuid) to anon, authenticated;


-- ─── 5. Where the terms stand ───────────────────────────────────────────
select 'sections in the default' as thing,
       -- Numbered headings at the start of a line. Counting paragraph
       -- breaks and halving them, which is what this did first, gave 34.
       (select count(*)::text
          from regexp_matches(d.body, '(?m)^[0-9]+\. ', 'g')) as n
  from terms_defaults d where d.id
union all
select 'does the default carry a fees clause',
       case when body like '%Fees & Payment%' then 'yes' else '>>> NO' end
  from terms_defaults where id
union all
select 'branches with terms of their own',
       count(*)::text from branches
 where nullif(btrim(coalesce(terms_content, '')), '') is not null
union all
select 'programmes with clauses of their own',
       count(*)::text from scheduler_lesson_types
 where nullif(btrim(coalesce(terms_content, '')), '') is not null;
