// ─────────────────────────────────────────────────────────────────────────
// The SQL, installed and called.
//
//   node tests/sqlmock.js &       (or let run.sh do it)
//   node tests/sql.test.js
//
// WHY
// Every other suite executes the thing it tests. The SQL was reviewed by
// reading, and in one afternoon reading let three faults through to a
// live database, each of which fails on the first call:
//
//   min(pa.id) on a uuid column. There is no min(uuid). plpgsql resolves
//   function names when the body RUNS, so the file installed cleanly,
//   every confirm block reported success, and the first parent to ask
//   for a sign-in code got "we could not check that just now" with the
//   real reason buried in an Edge Function log.
//
//   REVOKE ... FROM PUBLIC on the gate functions, which also removed
//   them from service_role, the role the Edge Functions run as. Nothing
//   about the file looks wrong; the Edge Function simply got "permission
//   denied" and could report only that it could not check.
//
// Neither is visible by reading. Both fail the moment the file is
// installed and called by the role that will call it. So the first
// assertion here is deliberately dull -- every file installs -- and the
// ones after it call what the file created and ask who may call it,
// because installing is the half that was never in doubt.
//
// ADDING A FILE TO `FILES` IS THE POINT. A migration not in that list is
// a migration still being checked by reading.
//
// EACH FILE IS PROBED THE MOMENT IT IS INSTALLED, not at the end. The
// first version of this suite installed everything and then asserted,
// and it did not catch min(uuid) at all -- because a later file
// re-creates parent_signin_check and the broken definition was
// overwritten before anything called it. Testing the end state tests
// only the last definition of each function. Every file here has to
// work on its own, on top of its stated prerequisites, which is also
// how Anthony runs them: one at a time, with the app in between.
// ─────────────────────────────────────────────────────────────────────────
'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const BASE = process.env.SSB_PGDIR || '/var/tmp/ssb-sqltest';
const PORT = process.env.SSB_PGPORT || '55433';
const DB = 'ssbtest';

// In dependency order. Each is the whole file, exactly as Anthony runs
// it in the Supabase SQL editor -- not an extract, because an extract is
// a different file and the one he runs would stay unchecked.
// `probe` runs immediately after that file installs, against whatever
// exists at that point and nothing later. It is what makes this suite
// able to catch a fault a subsequent file would paper over.
const FILES = [
  { file: 'supabase_parent_signin_guard.sql',
    probe: () => {
      // The exact fault that reached production: min(uuid) installs
      // cleanly and raises on the first call.
      const r = q(`select parent_signin_check('+60125243477')->>'ok'`);
      if (r !== 'true') throw new Error('the gate refuses a live family: ' + r);
      // And the other one. Checked HERE, per file, because a later file
      // grants it again -- so an end-of-run check passes while the file
      // Anthony actually ran leaves the app unable to send a code.
      mayCall('parent_signin_check(text)');
      mayCall('parent_signin_sent(uuid,boolean,text,text)');
    } },
  { file: 'supabase_parent_password.sql',
    probe: () => {
      const r = q(`select parent_login_check('+60125243477')->>'ok'`);
      if (r !== 'true') throw new Error('the password gate refuses a live family: ' + r);
      mayCall('parent_login_check(text)');
      mayCall('parent_login_record(text,boolean)');
    } },
  { file: 'supabase_parent_access_archived.sql',
    probe: () => {
      if (q(`select my_family()->>'ok'`) !== 'true')
        throw new Error('a live family cannot read their own app');
    } },
  { file: 'supabase_signin_reset_attempts.sql',
    probe: () => {
      // This file re-creates the gate. Its version has to answer too.
      if (q(`select parent_signin_check('+60125243477')->>'ok'`) !== 'true')
        throw new Error('the gate this file re-creates refuses a live family');
      // It re-creates the function, so it must re-grant it too.
      mayCall('parent_signin_check(text)');
      mayCall('parent_login_check(text)');
      if (!/^\{/.test(q(`select reset_signin_attempts('012-524 3477')::text`)))
        throw new Error('the reset does not answer');
    } },
  { file: 'supabase_grading_programs.sql',
    probe: () => {
      if (q(`select count(*) from grading_programs`) === '0')
        throw new Error('it seeded nothing');
      // The ladder read-back, which is what three screens draw from.
      q(`insert into scheduler_lesson_types (name, grading_program_id, sort_order)
           select 'Learn to Swim', id, 1 from grading_programs where name='Swim Passport';
         insert into student_enrollments (student_id, lesson_type_id)
           select (select id from students limit 1), (select id from scheduler_lesson_types limit 1)`);
      if (q(`select student_grading((select id from students limit 1))->>'graded'`) !== 'true')
        throw new Error('a child on a graded lesson type reads as ungraded');
    } },
  { file: 'supabase_grading_coach.sql',
    probe: () => {
      if (q(`select coach_student_grading((select id from students limit 1))->>'ok'`) !== 'true')
        throw new Error('a rostered coach cannot read the ladder');
      // The badge beside each swimmer on the class list. `label` goes
      // LAST: a phone reads these rows by key and ignores one it does
      // not know, but only because nothing before it moved.
      const cols = q(`select string_agg(t.n, ',' order by t.i)
                        from (select unnest(p.proargnames) n,
                                     generate_subscripts(p.proargnames,1) i
                                from pg_proc p
                               where p.proname='my_roster_grading') t
                       where t.n <> 'p_from' and t.n <> 'p_to'`);
      if (cols !== 'student_id,program_name,level_no,levels_total,label')
        throw new Error('the roster columns moved: ' + JSON.stringify(cols));
      // It reads grading_milestones.label, and plpgsql resolves column
      // names when the body RUNS. Without the column this file installs
      // cleanly and dies on the first class list, so: call it.
      q(`select count(*) from my_roster_grading(current_date, current_date + 6)`);
      // The coach app signs in as `authenticated`, and a drop-and-create
      // drops the grants along with the function.
      if (q(`select has_function_privilege('authenticated',
               'public.my_roster_grading(date,date)', 'execute')`) !== 't')
        throw new Error('re-creating it lost the grant the coach app signs in with');
      if (q(`select has_function_privilege('anon',
               'public.my_roster_grading(date,date)', 'execute')`) === 't')
        throw new Error('anon can read the roster, and the anon key is in every page');
    } },
  { file: 'supabase_grading_certificates.sql',
    probe: () => {
      // Office only, and can_write_office() is true in the fixture.
      q(`select count(*) from certificates_pending()`);
    } },
  { file: 'supabase_grading_colours.sql',
    probe: () => {
      if (!q(`select colour from grading_programs where name='Swim Passport'`).startsWith('#'))
        throw new Error('no colour was set on a seeded programme');
    } },
  { file: 'supabase_grading_syllabus.sql',
    probe: () => {
      const cols = q(`select string_agg(column_name, ',' order by column_name)
                        from information_schema.columns
                       where table_schema='public' and table_name='grading_programs'
                         and column_name like 'syllabus%'`);
      if (cols !== 'syllabus_body,syllabus_name,syllabus_note,syllabus_url,syllabus_version')
        throw new Error('the syllabus columns are not all there: ' + JSON.stringify(cols));

      // The box is drawn as a link in three apps, and the office types
      // into it. A javascript: URL there is script running in every
      // parent's browser.
      const bad = psql(`-d ${DB} -tAc "update grading_programs `
                     + `set syllabus_url='javascript:alert(1)'"`);
      if (bad.status === 0)
        throw new Error('a javascript: URL was stored, and it is rendered as a link');
      const good = psql(`-d ${DB} -tAc "update grading_programs `
                      + `set syllabus_url='https://malaysiaaquatics.org.my/'"`);
      if (good.status !== 0) throw new Error('an ordinary https link was refused');
      q(`update grading_programs set syllabus_url = null`);

      // Nothing set on the graded programme: the key must be absent
      // rather than an object of five nulls, because the apps ask one
      // question of it, not five.
      const prog = () => q(`select student_grading((select id from students limit 1))`
                         + `->'program'->>'syllabus'`);
      if (prog() !== '') throw new Error('an uncredited programme reports a syllabus');

      const graded = q(`select p.name from grading_programs p
                         where exists (select 1 from scheduler_lesson_types lt
                                        where lt.grading_program_id = p.id) limit 1`);
      q(`update grading_programs set syllabus_body='Test Body', syllabus_name='Test Std',
                syllabus_version='9.9' where name='${graded}'`);
      const got = q(`select student_grading((select id from students limit 1))`
                  + `->'program'->'syllabus'->>'body'`);
      if (got !== 'Test Body')
        throw new Error('the syllabus does not reach the apps: ' + JSON.stringify(got));

      // The colours file added the columns but nothing ever carried them
      // out to a phone. This function is where that happens.
      if (!q(`select student_grading((select id from students limit 1))`
           + `->'program'->>'colour'`).startsWith('#'))
        throw new Error('the programme colour does not reach the apps');

      q(`update grading_programs set syllabus_body=null, syllabus_name=null,
                syllabus_version=null where name='${graded}'`);
      if (prog() !== '') throw new Error('clearing the fields left a syllabus behind');
    } },
  { file: 'supabase_grading_stage_labels.sql',
    probe: () => {
      if (q(`select count(*) from information_schema.columns
              where table_schema='public' and table_name='grading_milestones'
                and column_name='label'`) !== '1')
        throw new Error('the label column is not there');
      // It must reach the apps, or it is a column nobody can read.
      if (!/"label"/.test(q(`select student_grading((select id from students limit 1))::text`)))
        throw new Error('student_grading does not carry the label');

    } },
  { file: 'supabase_grading_mas_badges.sql',
    probe: () => {
      const n = q(`select count(*) from grading_milestones m
                     join grading_programs p on p.id=m.program_id
                    where p.name='MAS BADGES'`);
      if (n !== '7') throw new Error('expected 7 levels, found ' + n);
      const c = q(`select count(*) from grading_tasks t
                     join grading_milestones m on m.id=t.milestone_id
                     join grading_programs p on p.id=m.program_id
                    where p.name='MAS BADGES'`);
      if (c !== '45') throw new Error('expected 45 criteria, found ' + c);

      // It is a FOURTH programme. An earlier draft of this file renamed
      // Swim Passport into MAS BADGES, which silently moved every lesson
      // type already graded on it onto a syllabus nobody had chosen.
      const all = q(`select string_agg(name, ', ' order by sort_order, name)
                       from grading_programs`);
      if (all !== 'Water Discovery, Swim Passport, Advanced Program, MAS BADGES')
        throw new Error('the four programmes are not all there: ' + JSON.stringify(all));
      if (q(`select count(*) from grading_milestones m join grading_programs p
               on p.id=m.program_id where p.name='Swim Passport'`) === '0')
        throw new Error('Swim Passport lost its levels');
      // And nothing moved onto it. Which lesson type is graded on which
      // ladder is an office decision, in Settings -> Lesson Types.
      if (q(`select count(*) from scheduler_lesson_types lt
               join grading_programs p on p.id=lt.grading_program_id
              where p.name='MAS BADGES'`) !== '0')
        throw new Error('a lesson type was moved onto MAS BADGES by a migration');
      if (q(`select count(*) from scheduler_lesson_types lt
               join grading_programs p on p.id=lt.grading_program_id
              where p.name='Swim Passport'`) !== '1')
        throw new Error('the lesson type lost the programme it was pointed at');

      // Every level offers a certificate, as the Syllabus has it.
      if (q(`select count(*) from grading_milestones m join grading_programs p on p.id=m.program_id
              where p.name='MAS BADGES' and m.certificate`) !== '7')
        throw new Error('not every level offers a certificate');

      // The attribution, which is the whole point of the layer above.
      const cred = q(`select syllabus_body || ' / ' || syllabus_name || ' v' || syllabus_version
                        from grading_programs where name='MAS BADGES'`);
      if (!/^Malaysia Aquatics \/ BADGES/.test(cred))
        throw new Error('MAS BADGES credits nobody: ' + JSON.stringify(cred));
      if (!/not a MAS assessment|separate assessment/i.test(
            q(`select syllabus_note from grading_programs where name='MAS BADGES'`)))
        throw new Error('the note does not say what a badge here is NOT');

      // The artwork. A path typed wrong here is a broken image in three
      // apps and a confirm block that still says "installed", so the
      // files are checked on disk rather than taken on trust.
      const icons = q(`select string_agg(m.icon_path, ' ' order by m.level_no)
                         from grading_milestones m join grading_programs p
                           on p.id = m.program_id where p.name='MAS BADGES'`).split(' ')
                    .concat(q(`select icon_path from grading_programs where name='MAS BADGES'`));
      if (icons.length !== 8)
        throw new Error('expected 7 level roundels and a programme mark, got ' + icons.length);
      for (const ic of icons) {
        if (!ic.startsWith('/badges/'))
          throw new Error('an icon is not served from this site: ' + JSON.stringify(ic));
        if (!fs.existsSync(path.join(ROOT, ic.slice(1))))
          throw new Error(ic + ' is in the database and not in the repository');
      }
    } },
  { file: 'supabase_swim_passport_syllabus.sql',
    probe: () => {
      const n = q(`select count(*) from grading_milestones m
                     join grading_programs p on p.id=m.program_id
                    where p.name='Swim Passport'`);
      if (n !== '8') throw new Error('expected 8 stages, found ' + n);
      const c = q(`select count(*) from grading_tasks t
                     join grading_milestones m on m.id=t.milestone_id
                     join grading_programs p on p.id=m.program_id
                    where p.name='Swim Passport'`);
      if (c !== '68') throw new Error('expected 68 skills, found ' + c);

      // The placeholders are gone. They shipped as something to look at
      // while the module was built, and a ladder that still has Guppy on
      // it is one this file did not actually replace.
      if (q(`select count(*) from grading_milestones m
               join grading_programs p on p.id=m.program_id
              where p.name='Swim Passport'
                and m.name in ('Guppy','Tortoise','Crab')`) !== '0')
        throw new Error('a placeholder level survived');

      // The id is kept, so nothing has to be re-chosen in Settings.
      if (q(`select count(*) from scheduler_lesson_types lt
               join grading_programs p on p.id=lt.grading_program_id
              where p.name='Swim Passport'`) !== '1')
        throw new Error('the lesson type lost its programme');

      // The labels are what the child's sticker says, and the ordinal is
      // NOT the same thing: stage 1 is the third rung.
      const labs = q(`select string_agg(m.label, ',' order by m.level_no)
                        from grading_milestones m join grading_programs p
                          on p.id=m.program_id where p.name='Swim Passport'`);
      if (labs !== 'A,B,1,2,3,4,5,6')
        throw new Error('the stage labels are wrong: ' + JSON.stringify(labs));
      if (q(`select m.level_no from grading_milestones m join grading_programs p
               on p.id=m.program_id where p.name='Swim Passport' and m.label='1'`) !== '3')
        throw new Error('stage 1 is not the third rung, so the label buys nothing');

      // Attribution. The stage names are the YMCA framework's, and the
      // note is where that is said -- not in a SQL comment nobody reads.
      const body = q(`select syllabus_body from grading_programs where name='Swim Passport'`);
      if (body !== 'Star Swim') throw new Error('the syllabus is not credited to us: ' + body);
      if (!/YMCA/.test(q(`select syllabus_note from grading_programs where name='Swim Passport'`)))
        throw new Error('the note does not say where the stage structure came from');

      // The artwork, checked against the repository rather than trusted.
      const icons = q(`select string_agg(m.icon_path, ' ' order by m.level_no)
                         from grading_milestones m join grading_programs p
                           on p.id = m.program_id where p.name='Swim Passport'`).split(' ');
      if (icons.length !== 8) throw new Error('expected 8 stickers, got ' + icons.length);
      for (const ic of icons) {
        if (!ic.startsWith('/badges/ss-'))
          throw new Error('a sticker is not served from this site: ' + JSON.stringify(ic));
        if (!fs.existsSync(path.join(ROOT, ic.slice(1))))
          throw new Error(ic + ' is in the database and not in the repository');
      }
    } },
  { file: 'supabase_swim_passport_split.sql',
    probe: () => {
      // Ticks and earned stages must survive the move. Counted before
      // the file runs is not possible from here, so count what is on the
      // two halves together: the stages carry their ids across, so the
      // join still reaches every mark that existed.
      const starters = q(`select string_agg(m.label || ' ' || m.name, ',' order by m.level_no)
                            from grading_milestones m join grading_programs p
                              on p.id = m.program_id where p.name='Swim Starters'`);
      if (starters !== 'A Water Discovery,B Water Explorer')
        throw new Error('Swim Starters is not A and B: ' + JSON.stringify(starters));
      // The sticker reads "Water Explorer", so the level must too.
      if (q(`select count(*) from grading_milestones where name='Water Exploration'`) !== '0')
        throw new Error('a level still says Water Exploration, which no sticker says');

      const pass = q(`select string_agg(m.label || ':' || m.level_no, ',' order by m.level_no)
                        from grading_milestones m join grading_programs p
                          on p.id = m.program_id where p.name='Swim Passport'`);
      // Renumbered 1..6 with the labels unchanged: the gap A and B left
      // is closed, so the bar reads "3 of 6" and not "3 of 8".
      if (pass !== '1:1,2:2,3:3,4:4,5:5,6:6')
        throw new Error('the Passport did not close the gap: ' + JSON.stringify(pass));
      if (q(`select count(*) from grading_milestones m join grading_programs p
               on p.id=m.program_id where p.name='Swim Passport'`) !== '6')
        throw new Error('Swim Passport is not six stages');

      // Same book, said in both places, which is what tells a parent the
      // two ladders are halves of one passport.
      const credit = q(`select string_agg(p.syllabus_body || '/' || p.syllabus_name, '|'
                                 order by p.name)
                          from grading_programs p
                         where p.name in ('Swim Starters','Swim Passport')`);
      if (credit !== 'Star Swim/Swim Passport|Star Swim/Swim Passport')
        throw new Error('the two halves credit different things: ' + JSON.stringify(credit));

      // And a child's history survives a move between them.
      if (!/"also_earned"/.test(q(`select student_grading((select id from students limit 1))::text`)))
        throw new Error('student_grading dropped also_earned');
    } },
  { file: 'supabase_grading_bands.sql',
    probe: () => {
      // One ladder again, eight stages, in the printed chart's own three
      // groups. The split file ran first, so this also proves the fold
      // back in works on top of it.
      const lad = q(`select string_agg(m.band || '/' || m.label, ',' order by m.level_no)
                       from grading_milestones m join grading_programs p
                         on p.id = m.program_id where p.name='Swim Passport'`);
      if (lad !== 'Swim Starters/A,Swim Starters/B,Swim Basics/1,Swim Basics/2,'
                + 'Swim Basics/3,Swim Strokes/4,Swim Strokes/5,Swim Strokes/6')
        throw new Error('the banded ladder is wrong: ' + JSON.stringify(lad));

      // Swim Starters is empty and turned off, not deleted.
      if (q(`select count(*) from grading_milestones m join grading_programs p
               on p.id=m.program_id where p.name='Swim Starters'`) !== '0')
        throw new Error('Swim Starters still holds levels');
      if (q(`select coalesce(is_active::text,'?') from grading_programs
              where name='Swim Starters'`) !== 'false')
        throw new Error('the emptied programme was deleted or left on');

      // MAS BADGES keeps no bands, and must still count across its ladder.
      if (q(`select count(*) from grading_milestones m join grading_programs p
               on p.id=m.program_id where p.name='MAS BADGES' and m.band is not null`) !== '0')
        throw new Error('a programme with no bands was given some');

      // The count a parent reads is the BAND's. The fixture child holds
      // level 1 only, so Swim Starters reads 1 of 2 — not 1 of 8, which
      // is the number this whole change exists to stop showing.
      q(`update scheduler_lesson_types set grading_program_id =
           (select id from grading_programs where name='Swim Passport')`);
      const g = JSON.parse(q(`select student_grading((select id from students limit 1))`));
      if (!g.band) throw new Error('no band came back for a banded programme');
      if (g.band.total !== 2)
        throw new Error('the band total is the whole ladder: ' + JSON.stringify(g.band));
      if (g.band.total === g.levels_total)
        throw new Error('band and ladder totals are the same, so banding bought nothing');
      if (g.levels_total !== 8) throw new Error('the ladder is not eight stages');
      // The band is the one they are CLIMBING, not the one they finished.
      if (g.band.name !== 'Swim Starters')
        throw new Error('wrong band for a child part-way through the first: ' + g.band.name);
      if (g.milestones.some(m => !m.band))
        throw new Error('a stage came back with no band');
    } },
  { file: 'supabase_grading_awards.sql',
    probe: () => {
      // Eleven certificates on paper: eight stages and three awards.
      const awards = q(`select string_agg(m.label || '=' || m.award_name, ',' order by m.level_no)
                          from grading_milestones m join grading_programs p
                            on p.id = m.program_id
                         where p.name='Swim Passport' and m.award_name is not null`);
      if (awards !== '3=Self Rescue,4=Novice Swimmer,6=Competent Swimmer')
        throw new Error('the awards are not on 3, 4 and 6: ' + JSON.stringify(awards));
      if (q(`select count(*) from grading_milestones m join grading_programs p
               on p.id=m.program_id where p.name='Swim Passport'
                 and m.icon_path like '/badges/ss-%'`) !== '8')
        throw new Error('the stages do not all point at the redrawn roundels');

      // THE PUBLISHED CONTRACT. A phone still running the old build
      // calls claim_certificate with three arguments. That call must
      // still resolve, and must still mean the stage certificate.
      // There must be exactly ONE claim_certificate. `create or replace`
      // cannot change a signature -- it adds an overload -- and with two
      // of them a three-argument call is ambiguous and every installed
      // phone gets "could not choose a best candidate function".
      const n = q(`select count(*) from pg_proc where proname = 'claim_certificate'`);
      const args = q(`select string_agg(pronargs::text, ',' order by pronargs)
                        from pg_proc where proname = 'claim_certificate'`);
      if (n !== '1' || args !== '4')
        throw new Error('expected one 4-argument claim_certificate, found ' + n
          + ' with arities ' + args + ' — a 3-argument call from an installed '
          + 'phone is now ambiguous');

      // Earn stage 3 outright, then both pieces of paper.
      const st = q(`select id from students limit 1`);
      const ms3 = q(`select m.id from grading_milestones m join grading_programs p
                       on p.id=m.program_id where p.name='Swim Passport' and m.label='3'`);
      q(`insert into student_task_marks (student_id, task_id, marked_by_name)
           select '${st}', t.id, 'Coach Sally' from grading_tasks t
            where t.milestone_id = '${ms3}' on conflict do nothing`);
      if (q(`select count(*) from student_milestones
              where student_id='${st}' and milestone_id='${ms3}' and revoked_at is null`) !== '1')
        throw new Error('ticking every task did not activate the stage');

      // Three arguments: the stage certificate, as it has always meant.
      if (q(`select claim_certificate('${st}','${ms3}',true)->>'kind'`) !== 'certificate')
        throw new Error('a three-argument call no longer means the certificate');
      if (q(`select certificate_claimed_at is not null from student_milestones
              where student_id='${st}' and milestone_id='${ms3}'`) !== 't')
        throw new Error('the certificate was not recorded');
      if (q(`select award_claimed_at is null from student_milestones
              where student_id='${st}' and milestone_id='${ms3}'`) !== 't')
        throw new Error('handing over the certificate also marked the award given');

      // Four arguments: the award, recorded separately.
      if (q(`select claim_certificate('${st}','${ms3}',true,'award')->>'kind'`) !== 'award')
        throw new Error('the award could not be handed over');
      if (q(`select award_claimed_at is not null from student_milestones
              where student_id='${st}' and milestone_id='${ms3}'`) !== 't')
        throw new Error('the award was not recorded');

      // And a stage with no award refuses one.
      const ms1 = q(`select m.id from grading_milestones m join grading_programs p
                       on p.id=m.program_id where p.name='Swim Passport' and m.label='1'`);
      if (!/does not come with an award/i.test(
            q(`select claim_certificate('${st}','${ms1}',true,'award')->>'error'`)))
        throw new Error('a stage with no award handed one over anyway');

      // It reaches the apps.
      const g = JSON.parse(q(`select student_grading('${st}')`));
      const m3 = g.milestones.find(m => m.label === '3');
      if (!m3 || m3.award !== 'Self Rescue' || !m3.award_icon)
        throw new Error('the award does not reach the apps: ' + JSON.stringify(m3 && m3.award));
      if (!m3.award_claimed_at) throw new Error('the claim does not reach the apps');

      // Put the child back as they were. This probe had to earn a stage
      // outright to have anything to hand over, and the ladder steps
      // further down assume nobody has climbed anything yet — a probe
      // that leaves a child mid-ladder breaks six tests that are not
      // about awards at all.
      q(`delete from student_task_marks where student_id='${st}'
           and task_id in (select id from grading_tasks where milestone_id='${ms3}')`);
      q(`delete from student_milestones where student_id='${st}' and milestone_id='${ms3}'`);
      if (q(`select count(*) from student_milestones where student_id='${st}'`) !== '0')
        throw new Error('the probe left the child holding a stage');
    } },
  { file: 'supabase_grading_friendly_names.sql',
    probe: () => {
      const lad = q(`select string_agg(m.label || '=' || m.name, ',' order by m.level_no)
                       from grading_milestones m join grading_programs p
                         on p.id = m.program_id where p.name='Swim Passport'`);
      if (lad !== 'A=Water Discovery,B=Water Explorer,1=Starfish,2=Crab,3=Octopus,'
                + '4=Turtle,5=Whale,6=Ray')
        throw new Error('the ladder does not read as the certificates do: '
          + JSON.stringify(lad));
      // The syllabus name is kept, not thrown away — the chart still uses it.
      const formal = q(`select string_agg(m.label || '=' || m.formal_name, ',' order by m.level_no)
                          from grading_milestones m join grading_programs p
                            on p.id = m.program_id
                           where p.name='Swim Passport' and m.formal_name is not null`);
      if (formal !== '1=Water Acclimation,2=Water Movement,3=Water Stamina,'
                   + '4=Stroke Introduction,5=Stroke Development,6=Stroke Mechanics')
        throw new Error('the syllabus names were lost: ' + JSON.stringify(formal));
      // A and B already agree, so they must carry one name, not a duplicate.
      if (q(`select count(*) from grading_milestones m join grading_programs p
               on p.id=m.program_id where p.name='Swim Passport'
                 and m.label in ('A','B') and m.formal_name is not null`) !== '0')
        throw new Error('A or B was given a second name it does not have in print');
      // A rename must not disturb the awards, which hang off the same rows.
      if (q(`select count(*) from grading_milestones m join grading_programs p
               on p.id=m.program_id where p.name='Swim Passport'
                 and m.award_name is not null`) !== '3')
        throw new Error('the rename cost an award');
      // The band prefix is gone from the descriptions; band is its own column.
      if (q(`select count(*) from grading_milestones m join grading_programs p
               on p.id=m.program_id where p.name='Swim Passport'
                 and m.description like 'Swim %'`) !== '0')
        throw new Error('a description still repeats its band');

      // And both names reach the apps on the same stage.
      const g = JSON.parse(q(`select student_grading((select id from students limit 1))`));
      const m3 = g.milestones.find(m => m.label === '3');
      if (!m3 || m3.name !== 'Octopus' || m3.formal_name !== 'Water Stamina')
        throw new Error('stage 3 does not carry both names: '
          + JSON.stringify(m3 && [m3.name, m3.formal_name]));
    } },
  { file: 'supabase_swim_passport_wording.sql',
    probe: () => {
      // The printed passport is the authority. These are the lines that
      // were wrong, taken from the PDF Anthony sent, not from the seed.
      const line = (label, n) =>
        q(`select t.name from grading_tasks t
             join grading_milestones m on m.id = t.milestone_id
             join grading_programs p on p.id = m.program_id
            where p.name='Swim Passport' and m.label='${label}' and t.sort_order=${n}`);
      for (const [label, n, want] of [
        ['A', 8, 'Water exit assisted'],
        ['1', 2, 'Front glide assisted, to wall, 2 meters'],
        ['2', 2, 'Front glide 5 meters'],
        ['3', 2, 'Swim on front 15 meters'],
        ['3', 7, 'Jump, swim, turn, swim, grab 10 meters'],
        ['3', 8, 'Swim, float, swim 25 meters'],
        ['4', 4, 'Back crawl swim 15 meters'],
        ['6', 4, 'Back crawl pull & flip turn, 2 x 25 meters']]) {
        const got = line(label, n);
        if (got !== want)
          throw new Error(`stage ${label} line ${n} reads ${JSON.stringify(got)}, `
            + `the passport prints ${JSON.stringify(want)}`);
      }
      // Level 2's missing line, in the position the book puts it.
      if (line('2', 6) !== 'Water exit independently')
        throw new Error('Level 2 still has no "Water exit independently" at 6: '
          + JSON.stringify(line('2', 6)));
      if (line('2', 10) !== 'Swim, float, swim 5 meters')
        throw new Error('the four lines below it did not move down: '
          + JSON.stringify(line('2', 10)));
      const counts = q(`select string_agg(x.label || ':' || x.n, ' ' order by x.level_no)
                          from (select m.label, m.level_no,
                                       (select count(*) from grading_tasks t
                                         where t.milestone_id = m.id and t.is_active)::text n
                                  from grading_milestones m
                                  join grading_programs p on p.id = m.program_id
                                 where p.name='Swim Passport' and m.is_active) x`);
      if (counts !== 'A:9 B:9 1:9 2:10 3:8 4:8 5:8 6:8')
        throw new Error('the stages do not hold what the passport prints: ' + counts);
      // Nothing left in two spellings, nothing left calling it Backstroke.
      if (q(`select count(*) from grading_tasks t
               join grading_milestones m on m.id=t.milestone_id
               join grading_programs p on p.id=m.program_id
              where p.name='Swim Passport' and t.name like '%metres%'`) !== '0')
        throw new Error('a task still spells it "metres" while the book says "meters"');
      if (q(`select count(*) from grading_tasks t
               join grading_milestones m on m.id=t.milestone_id
               join grading_programs p on p.id=m.program_id
              where p.name='Swim Passport' and t.name ~ '^Backstroke'`) !== '0')
        throw new Error('a stroke is still called Backstroke; the chart says Back crawl');

      // Running it twice must not insert the line twice or shift again.
      // This is the fault the guard exists for and it is cheap to prove
      // here, where the failure names the file, rather than at the end.
      psql(`-d ${DB} -v ON_ERROR_STOP=1 -q -f `
         + path.join(WORK, 'supabase_swim_passport_wording.sql'));
      if (q(`select count(*) from grading_tasks t
               join grading_milestones m on m.id=t.milestone_id
               join grading_programs p on p.id=m.program_id
              where p.name='Swim Passport' and m.label='2'`) !== '10')
        throw new Error('a second run changed Level 2 — the file is not re-runnable');
    } },
  { file: 'supabase_syllabus_switch.sql',
    probe: () => {
      // grading_ladder is SECURITY DEFINER and takes a student id with
      // no ownership check of its own. Left executable by PUBLIC it
      // would be a way to read any child's ticks with the anon key,
      // which is printed in every page we serve.
      for (const role of ['anon', 'authenticated']) {
        if (q(`select has_function_privilege('${role}', 'public.grading_ladder(uuid,uuid)', 'execute')`) !== 'f')
          throw new Error(role + ' can call grading_ladder directly, which reads any '
            + 'child’s progress without asking whose child it is');
      }
      // And the wrappers still work, which is what proves the revoke did
      // not simply break the feature.
      if (q(`select has_function_privilege('authenticated', 'public.student_grading(uuid)', 'execute')`) !== 't')
        throw new Error('the revoke took student_grading with it');

      const sp  = q(`select id from grading_programs where name='Swim Passport'`);
      const mas = q(`select id from grading_programs where name='MAS BADGES'`);
      const stu = q(`select id from students limit 1`);
      const was = q(`select grading_program_id from scheduler_lesson_types limit 1`);
      q(`update scheduler_lesson_types set grading_program_id='${sp}'`);

      // ── 1. The word, and nothing but the word ──────────────────────
      // Aimed at an id that does not exist, deliberately. The first
      // draft of this pointed the capitals-and-spaces case at the real
      // Swim Passport, which at that moment had no ticks on it -- so the
      // assertion passed by DELETING THE SYLLABUS, and every step after
      // it failed. A test for a confirmation has to be written so that
      // the confirmation succeeding is not a catastrophe.
      const ghost = q(`select gen_random_uuid()`);
      if (q(`select delete_grading_program('${sp}','yes')->>'error'`)
            !== 'Type the word delete to confirm.')
        throw new Error('a syllabus was deletable without typing the word');
      if (q(`select delete_grading_program('${sp}','')->>'error'`)
            !== 'Type the word delete to confirm.')
        throw new Error('an empty confirmation got past the guard');
      // Typed in a hurry is still typed. " Delete " is the word, and
      // getting as far as "no such syllabus" is how we know it was read.
      if (q(`select delete_grading_program('${ghost}',' Delete ')->>'error'`)
            !== 'No such syllabus.')
        throw new Error('the word was rejected over capitals and spaces, '
          + 'which teaches people the confirmation is broken');
      if (q(`select count(*) from grading_programs where id='${sp}'`) !== '1')
        throw new Error('the word tests deleted the syllabus they were testing');

      // ── 2. Usage names what is pointed at it, and does not gate ────
      let u = JSON.parse(q(`select grading_program_usage('${sp}')`));
      if (!Array.isArray(u.lesson_types) || u.lesson_types.length < 1)
        throw new Error('usage did not name the lesson type using this syllabus: '
          + JSON.stringify(u));
      if (u.swimmers !== 0 || u.deletable !== true)
        throw new Error('an untaught syllabus is reported as in use: '
          + JSON.stringify([u.swimmers, u.deletable]));

      // ── 3. One tick and it is a record, not a draft ────────────────
      q(`insert into student_task_marks (student_id, task_id, marked_by_name)
           select '${stu}', t.id, 'Coach Sally' from grading_tasks t
            join grading_milestones m on m.id = t.milestone_id
           where m.program_id='${sp}' and m.label='A' and t.sort_order=1`);
      u = JSON.parse(q(`select grading_program_usage('${sp}')`));
      if (u.swimmers !== 1 || u.deletable !== false)
        throw new Error('a syllabus a child has been assessed on is still deletable');
      const refused = q(`select delete_grading_program('${sp}','delete')->>'error'`);
      if (!/1 swimmer\(s\) have progress/.test(refused || ''))
        throw new Error('the refusal does not say who it is protecting: '
          + JSON.stringify(refused));
      if (q(`select count(*) from grading_programs where id='${sp}'`) !== '1')
        throw new Error('it refused and deleted it anyway');

      // ── 4. Moving syllabus keeps the old one, in full ──────────────
      q(`update scheduler_lesson_types set grading_program_id='${mas}'`);
      const moved = JSON.parse(q(`select student_grading('${stu}')`));
      if (moved.program.name !== 'MAS BADGES')
        throw new Error('the swimmer did not move: ' + moved.program.name);
      if (!Array.isArray(moved.previous) || moved.previous.length !== 1)
        throw new Error('the syllabus they came off is not carried: '
          + JSON.stringify(moved.previous && moved.previous.length));
      const prev = moved.previous[0];
      if (prev.name !== 'Swim Passport')
        throw new Error('the wrong syllabus is remembered: ' + prev.name);
      if (!prev.last_seen)
        throw new Error('no date on the previous syllabus, so the app cannot say when');
      const pa = (prev.milestones || []).find(m => m.label === 'A');
      if (!pa || pa.done !== 1 || pa.total !== 9)
        throw new Error('the previous ladder lost its ticks: '
          + JSON.stringify(pa && [pa.done, pa.total]));
      if (!(pa.tasks || []).some(t => t.done))
        throw new Error('the tick is not readable on the stage it was made against');
      // Printed order, not done-first: a parent follows the book.
      if (pa.tasks[0].name !== 'Blow bubbles on surface, assisted')
        throw new Error('the previous ladder is not in printed order: '
          + pa.tasks[0].name);

      // ── 5. Reinstating it removes the remark, with nothing to undo ──
      q(`update scheduler_lesson_types set grading_program_id='${sp}'`);
      const back = JSON.parse(q(`select student_grading('${stu}')`));
      if (back.program.name !== 'Swim Passport')
        throw new Error('the swimmer did not come back');
      if ((back.previous || []).length !== 0)
        throw new Error('the old syllabus is still announced after it was reinstated: '
          + JSON.stringify(back.previous.map(p => p.name)));
      // And the current ladder is in printed order too.
      const cur = back.milestones.find(m => m.label === 'A');
      if (cur.tasks[0].name !== 'Blow bubbles on surface, assisted')
        throw new Error('the current ladder reorders itself around what is done');

      // ── 6. A syllabus nobody has used does delete ──────────────────
      q(`insert into grading_programs (name, sort_order) values ('Scratch Syllabus', 99);
         insert into grading_milestones (program_id, level_no, name)
           select id, 1, 'Scratch Stage' from grading_programs where name='Scratch Syllabus';
         insert into grading_tasks (milestone_id, name, sort_order)
           select m.id, 'Scratch Task', 1 from grading_milestones m
            join grading_programs p on p.id = m.program_id
           where p.name='Scratch Syllabus'`);
      const scr = q(`select id from grading_programs where name='Scratch Syllabus'`);
      const gone = JSON.parse(q(`select delete_grading_program('${scr}','delete')`));
      if (gone.ok !== true || gone.stages !== 1 || gone.tasks !== 1)
        throw new Error('deleting an unused syllabus did not work: ' + JSON.stringify(gone));
      if (q(`select count(*) from grading_programs where name='Scratch Syllabus'`) !== '0')
        throw new Error('it reported success and left the row');
      if (q(`select count(*) from grading_milestones where program_id='${scr}'`) !== '0')
        throw new Error('the stages outlived the syllabus');

      // ── put the fixture back the way the later steps expect it ─────
      q(`delete from student_task_marks where student_id='${stu}'`);
      q(`update scheduler_lesson_types set grading_program_id='${was}'`);
      if (q(`select count(*) from student_task_marks where removed_at is null`) !== '0')
        throw new Error('this probe left ticks behind and the steps after it '
          + 'will assert against a dirty fixture');
    } }
];

function pgBin() {
  const r = '/usr/lib/postgresql';
  if (fs.existsSync(r)) {
    for (const v of fs.readdirSync(r).sort().reverse()) {
      const b = path.join(r, v, 'bin');
      if (fs.existsSync(path.join(b, 'psql'))) return b;
    }
  }
  const w = spawnSync('which', ['psql'], { encoding: 'utf8' });
  return (w.status === 0 && w.stdout.trim()) ? path.dirname(w.stdout.trim()) : null;
}
const BIN = pgBin();
const asPostgres = spawnSync('id', ['-u', 'postgres']).status === 0;

// psql runs as the postgres user, so every file it reads has to be
// readable by it. Copied rather than chmod'ed in place: a test run must
// not change the permissions of the repository it is testing.
const WORK = path.join(BASE, 'files');

function psql(args, opts) {
  const cmd = `psql -h ${BASE} -p ${PORT} -U postgres ${args}`;
  const full = asPostgres ? ['su', 'postgres', '-c', `PATH=${BIN}:$PATH ${cmd}`]
                          : ['sh', '-c', `PATH=${BIN}:$PATH ${cmd}`];
  return spawnSync(full[0], full.slice(1),
    Object.assign({ encoding: 'utf8', timeout: 60000 }, opts || {}));
}

// Can the role the Edge Functions run as actually call this? The thing
// a REVOKE ... FROM PUBLIC quietly takes away.
function mayCall(sig) {
  if (q(`select has_function_privilege('service_role', 'public.${sig}', 'execute')`) !== 't')
    throw new Error(sig + ' cannot be called by service_role — the Edge Function '
      + 'would answer "we could not check that just now"');
}

// One scalar back, trimmed. -tA so there is no table drawing to parse.
function q(sql) {
  const f = path.join(WORK, 'q.sql');
  fs.writeFileSync(f, sql);
  fs.chmodSync(f, 0o644);
  const r = psql(`-d ${DB} -v ON_ERROR_STOP=1 -tAq -f ${f}`);
  if (r.status !== 0) throw new Error((r.stderr || r.stdout || '').trim().split('\n').slice(-3).join(' | '));
  return (r.stdout || '').trim();
}

(async () => {
  let fail = 0;
  const step = (n, f) => {
    try { f(); console.log('PASS  ' + n); }
    catch (e) { console.log('FAIL  ' + n + ' -> ' + String(e.message).split('\n')[0]); fail++; }
  };

  // ── Is there a database to test against? ──────────────────────────────
  // run.sh waits one second after starting a mock, which is plenty for a
  // node HTTP server and nowhere near enough for initdb. Waiting here
  // rather than there: the first run of this suite skipped itself and
  // reported all green, which is the worst of both -- no coverage and no
  // sign that there was none.
  const until = Date.now() + 90000;
  while (Date.now() < until
         && !fs.existsSync(path.join(BASE, 'READY'))
         && !fs.existsSync(path.join(BASE, 'SKIP'))) {
    await new Promise(r => setTimeout(r, 500));
  }

  if (!BIN || fs.existsSync(path.join(BASE, 'SKIP')) || !fs.existsSync(path.join(BASE, 'READY'))) {
    // Deliberately not a failure. A machine without a local Postgres is
    // not a broken checkout, and a suite that fails there is a suite
    // people learn to ignore.
    console.log('SKIP  no local Postgres — the SQL was not executed on this machine');
    console.log('all green');
    process.exit(0);
  }

  fs.mkdirSync(WORK, { recursive: true });
  fs.chmodSync(WORK, 0o755);
  for (const f of ['sqlfixture.sql'].map(x => path.join(__dirname, x)).concat(
                   FILES.map(x => path.join(ROOT, x.file)))) {
    if (!fs.existsSync(f)) continue;
    const to = path.join(WORK, path.basename(f));
    fs.copyFileSync(f, to);
    fs.chmodSync(to, 0o644);
  }

  psql(`-c "drop database if exists ${DB}"`);
  const mk = psql(`-c "create database ${DB}"`);
  if (mk.status !== 0) {
    console.log('SKIP  could not create a test database: ' + (mk.stderr || '').trim());
    console.log('all green');
    process.exit(0);
  }

  // ── Dull on purpose: it all installs ──────────────────────────────────
  step('the fixture schema loads', () => {
    const r = psql(`-d ${DB} -v ON_ERROR_STOP=1 -q -f ${path.join(WORK, 'sqlfixture.sql')}`);
    if (r.status !== 0) throw new Error((r.stderr || '').trim().split('\n').slice(-3).join(' | '));
  });

  // The family goes in before any migration, so the very first file can
  // be called the moment it lands.
  step('a family to call them with', () => {
    q(`insert into admin_employees (full_name) values ('Coach Sally'), ('Coach Yong');
       update _test_state set crew = (select id from admin_employees where full_name='Coach Sally');
       insert into parent_accounts (display_name, phone_primary)
         values ('Lee Oy Yin','+60125243477');
       insert into students (account_id, name, is_active)
         select id, 'Mira', true from parent_accounts limit 1`);
    if (q(`select count(*) from students`) !== '1') throw new Error('the fixture did not take');
  });

  for (const entry of FILES) {
    const file = entry.file;
    step('installs: ' + file, () => {
      const f = path.join(WORK, file);
      if (!fs.existsSync(f)) throw new Error('missing from the repository');
      const r = psql(`-d ${DB} -v ON_ERROR_STOP=1 -q -f ${f}`);
      if (r.status !== 0) {
        throw new Error((r.stderr || r.stdout || '').trim().split('\n')
          .filter(l => /ERROR|DETAIL|LINE/.test(l)).slice(0, 3).join(' | ')
          || 'psql exited ' + r.status);
      }
    });
    // Immediately, before any later file can redefine what it created.
    if (entry.probe) step('  ↳ and answers: ' + file, entry.probe);
  }

  // Re-running a migration is the normal case: Anthony runs them more
  // than once, and a file that only works on an empty database is a file
  // that works once.
  step('and installs again on top of itself', () => {
    for (const { file } of FILES) {
      const r = psql(`-d ${DB} -v ON_ERROR_STOP=1 -q -f ${path.join(WORK, file)}`);
      if (r.status !== 0) {
        throw new Error(file + ': ' + (r.stderr || '').trim().split('\n')
          .filter(l => /ERROR/.test(l)).slice(0, 2).join(' | '));
      }
    }
  });

  step('refuses a number we do not hold, in the same words as an archived one', () => {
    const unknown = q(`select parent_signin_check('+60100000000')->>'error'`);
    q(`update students set is_active = false`);
    const archived = q(`select parent_signin_check('+60125243477')->>'error'`);
    q(`update students set is_active = true`);
    if (!unknown) throw new Error('an unknown number was not refused');
    if (unknown !== archived)
      throw new Error('the two refusals can be told apart, which tells somebody '
        + 'trying numbers which are real: ' + JSON.stringify([unknown, archived]));
  });

  step('an archived family is told so, and un-archiving undoes it', () => {
    q(`update students set is_active = false`);
    const off = q(`select my_family()->>'ok'`);
    const msg = q(`select my_family()->>'error'`);
    q(`update students set is_active = true`);
    const on = q(`select my_family()->>'ok'`);
    if (off !== 'false') throw new Error('an archived family still gets the app');
    if (!/no longer active/i.test(msg)) throw new Error('it does not say why: ' + msg);
    if (on !== 'true') throw new Error('un-archiving did not restore access');
  });

  // ── The ladder ────────────────────────────────────────────────────────
  // PROG is read from the database rather than written here. These steps
  // matched on name='Swim Passport', the file that loads the real
  // syllabus renames it, and the tick then matched no rows at all -- so
  // "a single tick promoted nobody" passed by ticking nothing. A test
  // that asserts on an empty set passes for ever and guards nothing.
  const PROG = () => q(`select name from grading_programs p
                         where exists (select 1 from scheduler_lesson_types lt
                                        where lt.grading_program_id = p.id) limit 1`);

  step('one tick on a high level activates nothing', () => {
    const before = q(`select count(*) from student_task_marks where removed_at is null`);
    q(`insert into student_task_marks (student_id, task_id, marked_by_name)
         select s.id, t.id, 'Coach Sally' from students s, grading_tasks t
         join grading_milestones m on m.id = t.milestone_id
         join grading_programs p on p.id = m.program_id
        where p.name='${PROG()}' and m.level_no=3 and t.sort_order=1`);
    const after = q(`select count(*) from student_task_marks where removed_at is null`);
    if (Number(after) !== Number(before) + 1)
      throw new Error('the tick matched nothing, so this asserts on an empty set');
    const n = q(`select count(*) from student_milestones where revoked_at is null`);
    if (n !== '0') throw new Error('a single tick promoted somebody: ' + n);
  });

  step('completing every task on a level activates it', () => {
    q(`insert into student_task_marks (student_id, task_id, marked_by_name)
         select s.id, t.id, 'Coach Sally' from students s, grading_tasks t
         join grading_milestones m on m.id = t.milestone_id
         join grading_programs p on p.id = m.program_id
        where p.name='${PROG()}' and m.level_no=1
        on conflict do nothing`);
    const lvl = q(`select student_grading((select id from students limit 1))->>'level'`);
    if (lvl !== '1') throw new Error('level is ' + JSON.stringify(lvl) + ', expected 1');
  });

  // The office is about to move its Learn to Swim lesson type off the
  // placeholder ladder and onto MAS BADGES. Which ladder is drawn is a
  // choice about a dropdown; a tick is a coach saying they watched a
  // child do something. Changing the first must never be a way to lose
  // the second.
  step('repointing a lesson type to another ladder keeps every tick', () => {
    const before = q(`select count(*) from student_task_marks where removed_at is null`);
    if (before === '0') throw new Error('nothing is ticked, so this proves nothing');
    const was = q(`select grading_program_id from scheduler_lesson_types limit 1`);
    const mas = q(`select id from grading_programs where name='MAS BADGES'`);
    q(`update scheduler_lesson_types set grading_program_id='${mas}'`);

    const moved = JSON.parse(q(`select student_grading((select id from students limit 1))`));
    if (moved.program.name !== 'MAS BADGES')
      throw new Error('the ladder did not change: ' + moved.program.name);
    // Nothing carries across, and it should not: a Starfish criterion is
    // not the same claim as a Guppy one, and pretending otherwise would
    // hand out levels nobody watched.
    if (moved.level !== null)
      throw new Error('a level was awarded on a ladder nothing was ticked against: '
        + moved.level);
    const after = q(`select count(*) from student_task_marks where removed_at is null`);
    if (after !== before)
      throw new Error('repointing cost ' + (Number(before) - Number(after)) + ' tick(s)');

    q(`update scheduler_lesson_types set grading_program_id='${was}'`);
    const back = JSON.parse(q(`select student_grading((select id from students limit 1))`));
    if (back.level !== 1)
      throw new Error('moving back did not give the child their level again: ' + back.level);
  });

  step('the bars are tasks done over tasks on that level', () => {
    // Read the shape out of the syllabus rather than writing the numbers
    // here, so loading a different syllabus is not a test to rewrite.
    const want = q(`select string_agg(
                        case when m.level_no = 1 then c.n::text
                             when m.level_no = 3 then '1'
                             else '0' end || '/' || c.n::text, ' ' order by m.level_no)
                      from grading_milestones m
                      join grading_programs p on p.id = m.program_id
                      join lateral (select count(*) n from grading_tasks t
                                     where t.milestone_id = m.id and t.is_active) c on true
                     where p.name='${PROG()}' and m.is_active`);
    const got = q(`select string_agg((m->>'done')||'/'||(m->>'total'), ' ' order by (m->>'level_no')::int)
                     from jsonb_array_elements(
                       student_grading((select id from students limit 1))->'milestones') m`);
    if (got !== want) throw new Error('expected ' + JSON.stringify(want) + ', got ' + JSON.stringify(got));
  });

  step('removing one tick withdraws the level and keeps the row', () => {
    q(`update student_task_marks set removed_at = now(), removed_by_name = 'Coach Yong'
        where id = (select m.id from student_task_marks m
                      join grading_tasks t on t.id = m.task_id
                      join grading_milestones ms on ms.id = t.milestone_id
                     where ms.level_no = 1 and m.removed_at is null limit 1)`);
    const live = q(`select count(*) from student_milestones where revoked_at is null`);
    const kept = q(`select count(*) from student_milestones where revoked_at is not null`);
    if (live !== '0') throw new Error('the level survived a removed tick');
    if (kept !== '1') throw new Error('the achievement row was deleted rather than withdrawn');
    const trail = q(`select marked_by_name||' / '||removed_by_name from student_task_marks
                      where removed_at is not null`);
    if (trail !== 'Coach Sally / Coach Yong')
      throw new Error('the trail does not name both: ' + JSON.stringify(trail));
  });

  step('adding a task to a held level withdraws it until the new one is ticked', () => {
    // Put level 1 back, then add a task to it.
    q(`update student_task_marks set removed_at = null, removed_by_name = null
        where removed_at is not null`);
    const before = q(`select count(*) from student_milestones where revoked_at is null`);
    q(`insert into grading_tasks (milestone_id, name, sort_order)
         select m.id, 'A newly added thing', 99 from grading_milestones m
         join grading_programs p on p.id = m.program_id
        where p.name='${PROG()}' and m.level_no=1`);
    const after = q(`select count(*) from student_milestones where revoked_at is null`);
    if (before !== '1') throw new Error('level 1 was not restored before the test');
    if (after !== '0')
      throw new Error('a level kept its holders after a task was added to it, so it '
        + 'means whatever it meant on the day each child climbed it');
  });

  // ── Certificates ──────────────────────────────────────────────────────
  step('a certificate cannot be claimed on a level that carries none', () => {
    // Water Discovery level 1 carries none, and is untouched by the
    // syllabus file -- so this stays true whatever is loaded.
    const e = q(`select claim_certificate((select id from students limit 1),
                   (select m.id from grading_milestones m join grading_programs p on p.id=m.program_id
                     where p.name='Water Discovery' and m.level_no=1), true)->>'error'`);
    if (!/does not come with a certificate/i.test(e || ''))
      throw new Error('it allowed one: ' + JSON.stringify(e));
  });

  step('nor on a level the child has not earned', () => {
    const e = q(`select claim_certificate((select id from students limit 1),
                   (select m.id from grading_milestones m join grading_programs p on p.id=m.program_id
                     where p.name='Water Discovery' and m.level_no=2), true)->>'error'`);
    if (!/not earned/i.test(e || '')) throw new Error('it allowed one: ' + JSON.stringify(e));
  });

  step('and a coach who is not rostered is refused outright', () => {
    q(`update _test_state set may_note = false`);
    const e = q(`select mark_grading_task((select id from students limit 1),
                   (select id from grading_tasks limit 1), true, null)->>'error'`);
    q(`update _test_state set may_note = true`);
    if (!/not rostered/i.test(e || '')) throw new Error('it let them tick: ' + JSON.stringify(e));
  });

  // ── The things only a database can refuse ─────────────────────────────
  // By now a coach has ticked real criteria. Re-running the syllabus
  // file must refuse rather than delete them: a tick is somebody saying
  // they watched a child do something, and no file is entitled to throw
  // that away to make room for a better syllabus.
  //
  // Tested HERE rather than beside the install, where there is nothing
  // to protect and the guard cannot fire either way.
  step('the syllabus refuses to overwrite ticks a coach has made', () => {
    // A coach ticks a MAS criterion, as they would the day a lesson type
    // is pointed at this ladder.
    q(`insert into student_task_marks (student_id, task_id, marked_by_name)
         select s.id, t.id, 'Coach Sally' from students s, grading_tasks t
         join grading_milestones m on m.id = t.milestone_id
         join grading_programs p on p.id = m.program_id
        where p.name='MAS BADGES' and m.level_no=1 and t.sort_order=1
        on conflict do nothing`);
    const mine = q(`select count(*) from student_task_marks k
                      join grading_tasks t on t.id = k.task_id
                      join grading_milestones m on m.id = t.milestone_id
                      join grading_programs p on p.id = m.program_id
                     where p.name='MAS BADGES' and k.removed_at is null`);
    if (mine === '0')
      throw new Error('nothing is ticked on MAS BADGES, so this proves nothing');

    // Left alone the file sees Dolphin at level 7 and stops before it
    // would delete anything, which is correct and also means the guard
    // never fires. One rename in Settings -> Grading -- the ordinary way
    // a ladder drifts from the file that wrote it -- takes it past that
    // short circuit and into the delete-and-reseed the guard is for.
    q(`update grading_milestones set name='Dolphin (2026)'
        where level_no=7 and program_id=(select id from grading_programs
                                          where name='MAS BADGES')`);
    const r = psql(`-d ${DB} -v ON_ERROR_STOP=1 -q -f `
                   + path.join(WORK, 'supabase_grading_mas_badges.sql'));
    q(`update grading_milestones set name='Dolphin' where name='Dolphin (2026)'`);

    if (r.status === 0)
      throw new Error('it re-seeded over ' + mine + ' tick(s) rather than refusing');
    if (!/already recorded against its levels/i.test(r.stderr || ''))
      throw new Error('it failed for some other reason: '
        + (r.stderr || '').trim().split('\n').slice(-2).join(' | '));
    const still = q(`select count(*) from student_task_marks k
                       join grading_tasks t on t.id = k.task_id
                       join grading_milestones m on m.id = t.milestone_id
                       join grading_programs p on p.id = m.program_id
                      where p.name='MAS BADGES' and k.removed_at is null`);
    if (still !== mine)
      throw new Error('the refusal still cost ' + (Number(mine) - Number(still)) + ' tick(s)');
  });

  // Anthony runs these by hand, one at a time, and the grading chain is
  // now long enough to skip a link. Each file that re-creates
  // student_grading reads columns an earlier file adds -- and plpgsql
  // resolves column names when the query RUNS. Out of order they install
  // perfectly and the apps go blank.
  //
  // So every one of them is checked here against a database that has
  // only what comes BEFORE its prerequisite. It must refuse, in the SQL
  // editor, naming the file to run first.
  step('a grading file run out of order refuses instead of installing', () => {
    const DB2 = 'ssbooo';
    psql(`-c "drop database if exists ${DB2}"`);
    if (psql(`-c "create database ${DB2}"`).status !== 0)
      throw new Error('could not make a scratch database');
    const load = (f) => psql(`-d ${DB2} -v ON_ERROR_STOP=1 -q -f ` + path.join(WORK, f));
    for (const f of ['sqlfixture.sql', 'supabase_grading_programs.sql'])
      if (load(f).status !== 0) throw new Error('the base would not install: ' + f);

    // Up to here nothing has added `colour`, `label`, `band` or
    // `award_name`, so every one of these is out of order.
    // What each file must say when it is run too early. A file that
    // refuses for some other reason has not been shown to have a guard.
    const col = (c) => ({ why: c, says: new RegExp(c + ' does not exist') });
    for (const [f, wants] of [
        ['supabase_grading_syllabus.sql',       col('colour')],
        ['supabase_grading_stage_labels.sql',   col('syllabus_body')],
        ['supabase_grading_bands.sql',          col('label')],
        ['supabase_grading_awards.sql',         col('band')],
        ['supabase_grading_friendly_names.sql', col('band')],
        ['supabase_syllabus_switch.sql',        col('band')],
        ['supabase_swim_passport_wording.sql',  col('formal_name')]]) {
      const r = load(f);
      if (r.status === 0)
        throw new Error(f + ' installed without ' + wants.why + ' — it will fail on '
          + 'its first call instead, which shows as a blank ladder');
      if (!wants.says.test(r.stderr || ''))
        throw new Error(f + ' refused for some other reason: '
          + (r.stderr || '').trim().split('\n').slice(-2).join(' | '));
    }
    psql(`-c "drop database if exists ${DB2}"`);
  });

  step('a colour that is not a colour is refused', () => {
    const r = psql(`-d ${DB} -tAc "update grading_programs set colour='bright blue'"`);
    if (r.status === 0)
      throw new Error('a typo was stored, and an unparseable colour is a chip that '
        + 'silently vanishes — which reads as a broken screen');
  });

  step('the Edge Functions can call the gates they depend on', () => {
    // The exact fault that produced "we could not check that just now":
    // REVOKE ... FROM PUBLIC also took these from service_role.
    for (const fn of ['parent_signin_check(text)', 'parent_login_check(text)',
                      'parent_signin_sent(uuid,boolean,text,text)',
                      'parent_login_record(text,boolean)']) {
      const ok = q(`select has_function_privilege('service_role', 'public.${fn}', 'execute')`);
      if (ok !== 't') throw new Error(fn + ' cannot be called by service_role');
    }
  });

  step('and the anon key cannot', () => {
    const ok = q(`select has_function_privilege('anon', 'public.parent_signin_check(text)', 'execute')`);
    if (ok === 't')
      throw new Error('anon can call the gate, and the anon key is printed in every page we serve');
  });

  console.log(fail ? fail + ' FAILED' : 'all green');
  process.exit(fail ? 1 : 0);
})();
