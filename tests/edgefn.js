// ─────────────────────────────────────────────────────────────────────────
// Running the public-intake Edge Function on this machine.
//
// WHY
// It is the only thing that writes students, acceptances and health
// declarations from the public website, it runs on Deno in Supabase's
// cloud, and nothing here could execute a line of it. It was checked by
// reading. Reading did not notice that the lookup branch used `db` eleven
// lines before `const db` ran, which threw on every call — a function
// deployed, live, and dead on its newest route, reporting the same thing
// for a broken client as for a wrong account number.
//
// So: strip the types with Babel, swap the two things only Deno provides
// (Deno.env and Deno.serve) and the one import that goes over the network,
// and hand back the request handler as an ordinary JavaScript function.
// The logic under test is the deployed file, unedited.
//
// WHAT IT IS NOT
// Not a Supabase. The client is a stub a test programs per call, so the
// assertions are about what this function does with an answer, never
// about what Postgres would have answered.
// ─────────────────────────────────────────────────────────────────────────
'use strict';

const fs = require('fs');
const path = require('path');
const babel = require('@babel/core');
const vm = require('vm');

const SRC = path.join(__dirname, '..', 'supabase', 'functions', 'public-intake', 'index.ts');

// Builds a handler from the real file. `client` is what createClient
// returns; `env` fills Deno.env.get.
function load(client, env) {
  const ts = fs.readFileSync(SRC, 'utf8');

  const { code } = babel.transformSync(ts, {
    filename: 'index.ts',
    presets: [[require.resolve('@babel/preset-typescript'), { onlyRemoveTypeImports: false }]],
    babelrc: false, configFile: false, compact: false, comments: true,
    // The import is a URL Deno resolves and node cannot. Dropped here and
    // supplied as a plain binding below; nothing else about the file moves.
    plugins: [function stripRemoteImport() {
      return { visitor: { ImportDeclaration(p) {
        if (/^https?:/.test(p.node.source.value)) p.remove();
      } } };
    }]
  });

  let handler = null;
  const sandbox = {
    createClient: () => client,
    crypto,
    console,
    Response, Request, Headers, URL, JSON, Math, Date, Object, Array, String, Number, Boolean, Error,
    Deno: {
      env: { get: (k) => (env || {})[k] },
      serve: (fn) => { handler = fn; }
    }
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: 'public-intake/index.ts' });

  if (typeof handler !== 'function') throw new Error('the function never called Deno.serve');
  return handler;
}

// POST a JSON body and read the JSON back, the way the browser does.
async function post(handler, body) {
  const res = await handler(new Request('https://x/functions/v1/public-intake', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  }));
  let json = null;
  try { json = JSON.parse(await res.text()); } catch (_e) { json = null; }
  return { status: res.status, body: json };
}

// A supabase-js stand-in. `rpc` answers from a map of name -> function.
// `from(table)` records what was written and answers with what the test
// put in `rows`.
function stubClient(opts) {
  const o = opts || {};
  const calls = { rpc: [], insert: [], upsert: [], select: [] };
  const client = {
    calls,
    rpc: async (name, args) => {
      calls.rpc.push([name, args]);
      const f = (o.rpc || {})[name];
      if (!f) return { data: null, error: { message: 'no such function ' + name } };
      return f(args);
    },
    // The query builder, as much of it as this function uses. Every
    // filter returns the builder, and the builder is thenable, so a
    // chain ends wherever the code under test stops adding to it.
    //
    // It grows when the function grows. A missing method here reads as
    // a 500 from the handler, which is at least loud — the first run
    // after the lookup learned to read students said
    // "db.from(...).select(...).eq(...).neq is not a function".
    from: (table) => {
      const answer = () => ((o.rows || {})[table]) || { data: [], error: null };
      const q = {
        _table: table, _filters: {},
        select() { calls.select.push([table, q._filters]); return q; },
        eq(col, val) { q._filters[col] = val; return q; },
        neq(col, val) { q._filters['!' + col] = val; return q; },
        or(expr) { q._filters.or = expr; return q; },
        order() { return q; },
        limit() { return q; },
        single: async () => answer(),
        maybeSingle: async () => answer(),
        insert(rows) {
          calls.insert.push([table, rows]);
          const res = ((o.insert || {})[table]) || { data: rows, error: null };
          return {
            select: () => ({ single: async () => res, maybeSingle: async () => res }),
            then: (r) => r(res)
          };
        },
        upsert(rows) {
          calls.upsert.push([table, rows]);
          return Promise.resolve(((o.upsert || {})[table]) || { data: rows, error: null });
        },
        update(patch) { calls.insert.push([table + ':update', patch]); return q; },
        then(resolve) { return resolve(answer()); }
      };
      return q;
    }
  };
  return client;
}

module.exports = { load, post, stubClient };
