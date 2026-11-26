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
  step('one tick on a high level activates nothing', () => {
    q(`insert into student_task_marks (student_id, task_id, marked_by_name)
         select s.id, t.id, 'Coach Sally' from students s, grading_tasks t
         join grading_milestones m on m.id = t.milestone_id
         join grading_programs p on p.id = m.program_id
        where p.name='Swim Passport' and m.level_no=3 and t.sort_order=1`);
    const n = q(`select count(*) from student_milestones where revoked_at is null`);
    if (n !== '0') throw new Error('a single tick promoted somebody: ' + n);
  });

  step('completing every task on a level activates it', () => {
    q(`insert into student_task_marks (student_id, task_id, marked_by_name)
         select s.id, t.id, 'Coach Sally' from students s, grading_tasks t
         join grading_milestones m on m.id = t.milestone_id
         join grading_programs p on p.id = m.program_id
        where p.name='Swim Passport' and m.level_no=1
        on conflict do nothing`);
    const lvl = q(`select student_grading((select id from students limit 1))->>'level'`);
    if (lvl !== '1') throw new Error('level is ' + JSON.stringify(lvl) + ', expected 1');
  });

  step('the bars are tasks done over tasks on that level', () => {
    const bars = q(`select string_agg((m->>'done')||'/'||(m->>'total'), ' ' order by (m->>'level_no')::int)
                      from jsonb_array_elements(
                        student_grading((select id from students limit 1))->'milestones') m`);
    if (!/^6\/6 0\/5 1\/5$/.test(bars))
      throw new Error('expected "6/6 0/5 1/5", got ' + JSON.stringify(bars));
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
        where p.name='Swim Passport' and m.level_no=1`);
    const after = q(`select count(*) from student_milestones where revoked_at is null`);
    if (before !== '1') throw new Error('level 1 was not restored before the test');
    if (after !== '0')
      throw new Error('a level kept its holders after a task was added to it, so it '
        + 'means whatever it meant on the day each child climbed it');
  });

  // ── Certificates ──────────────────────────────────────────────────────
  step('a certificate cannot be claimed on a level that carries none', () => {
    const e = q(`select claim_certificate((select id from students limit 1),
                   (select m.id from grading_milestones m join grading_programs p on p.id=m.program_id
                     where p.name='Swim Passport' and m.level_no=1), true)->>'error'`);
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
