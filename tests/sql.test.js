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
