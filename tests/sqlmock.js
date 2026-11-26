// ─────────────────────────────────────────────────────────────────────────
// A Postgres for the SQL suite to run against.
//
//   node tests/sqlmock.js        (or let run.sh do it)
//
// WHY THIS EXISTS
// Every other suite in this repo executes the thing it is testing. The
// SQL did not. It was reviewed by reading, and reading let three faults
// through to a live database in one afternoon:
//
//   min(pa.id) on a uuid column. Postgres has no min(uuid), plpgsql
//   resolves function names when the body RUNS, so the file installed
//   cleanly, every confirm block reported success, and the first parent
//   to ask for a sign-in code got "we could not check that just now".
//
//   REVOKE ... FROM PUBLIC on the gate functions, which also took them
//   from service_role -- the role the Edge Functions run as.
//
//   auth.users referenced inside a has_table_privilege() guard, which
//   does not spare the statement from having to parse.
//
// None of those are visible by reading. All three fail the moment the
// file is installed and called. So: install it and call it.
//
// WHAT IT IS NOT
// Not a copy of the production database. tests/sqlfixture.sql is the
// smallest schema these files touch, and the assertions are about what
// the functions do with an answer, never about what the real data holds.
//
// IF POSTGRES IS NOT INSTALLED the suite skips itself rather than
// failing. A machine without a local Postgres is not a broken checkout.
// ─────────────────────────────────────────────────────────────────────────
'use strict';

const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
// Not the scratchpad and not /tmp inside the repo: initdb refuses a
// directory it cannot own, and Postgres refuses one whose permissions
// are not 0700.
const BASE = process.env.SSB_PGDIR || '/var/tmp/ssb-sqltest';
const DATA = path.join(BASE, 'data');
const PORT = process.env.SSB_PGPORT || '55433';

function pgBin() {
  // Ask the packaged layout first, then the PATH. Pinning a version
  // directory is how the Playwright helper broke when the image moved.
  const roots = ['/usr/lib/postgresql'];
  for (const r of roots) {
    if (!fs.existsSync(r)) continue;
    for (const v of fs.readdirSync(r).sort().reverse()) {
      const b = path.join(r, v, 'bin');
      if (fs.existsSync(path.join(b, 'initdb'))) return b;
    }
  }
  const which = spawnSync('which', ['initdb'], { encoding: 'utf8' });
  if (which.status === 0 && which.stdout.trim()) return path.dirname(which.stdout.trim());
  return null;
}

const BIN = pgBin();
if (!BIN) {
  console.log('SKIP: no local Postgres (initdb not found). The SQL suite will skip itself.');
  // Stay alive anyway so run.sh's start/kill dance behaves, and so the
  // suite can tell "no Postgres" from "mock crashed".
  fs.mkdirSync(BASE, { recursive: true });
  fs.writeFileSync(path.join(BASE, 'SKIP'), 'no postgres');
  setInterval(() => {}, 1 << 30);
  return;
}

// Running as root is normal in this container and initdb refuses it, so
// everything goes through the postgres user when there is one.
const asPostgres = spawnSync('id', ['-u', 'postgres']).status === 0;
function run(cmd) {
  const full = asPostgres
    ? ['su', 'postgres', '-c', `PATH=${BIN}:$PATH ${cmd}`]
    : ['sh', '-c', `PATH=${BIN}:$PATH ${cmd}`];
  return spawnSync(full[0], full.slice(1), { encoding: 'utf8' });
}

try { fs.rmSync(BASE, { recursive: true, force: true }); } catch (_e) {}
fs.mkdirSync(BASE, { recursive: true });
if (asPostgres) {
  try { execFileSync('chown', ['-R', 'postgres:postgres', BASE]); } catch (_e) {}
}

const init = run(`initdb -U postgres -A trust -D ${DATA}`);
if (init.status !== 0) {
  console.log('SKIP: initdb failed.\n' + (init.stderr || init.stdout || '').slice(-400));
  fs.writeFileSync(path.join(BASE, 'SKIP'), 'initdb failed');
  setInterval(() => {}, 1 << 30);
  return;
}

// listen_addresses empty: a unix socket only, so a test run can never
// reach anything but itself and never collides with a real server.
const start = run(`pg_ctl -D ${DATA} -o "-k ${BASE} -p ${PORT} -c listen_addresses=" `
               + `-l ${BASE}/pg.log start -w`);
if (start.status !== 0) {
  console.log('SKIP: Postgres would not start.\n'
    + (start.stderr || start.stdout || '').slice(-400));
  fs.writeFileSync(path.join(BASE, 'SKIP'), 'would not start');
  setInterval(() => {}, 1 << 30);
  return;
}

console.log(`postgres ready on ${BASE} port ${PORT}`);
fs.writeFileSync(path.join(BASE, 'READY'), String(PORT));

function stop() {
  try { run(`pg_ctl -D ${DATA} -m immediate stop`); } catch (_e) {}
  process.exit(0);
}
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
setInterval(() => {}, 1 << 30);
