-- ════════════════════════════════════════════════════════════════════════
--  A phone that has not refreshed is a client you cannot reach
-- ════════════════════════════════════════════════════════════════════════
--  Run this whole file in the Supabase SQL editor. Safe to re-run.
--
--  THE PROBLEM
--  The coach's app and the parent's app are installed to a home screen
--  and served by a service worker, which means a phone can keep running
--  a build from three weeks ago indefinitely. Nothing makes it check.
--
--  That is fine while the database only ever adds things. It stops being
--  fine the moment a function it calls changes shape. mark_attendance
--  went from two arguments to three and survived only because the third
--  has a default — an accident, not a design. Remove or reorder an
--  argument and every unrefreshed phone fails at the poolside, mid
--  lesson, with an error nobody can act on.
--
--  THE FIX
--  The database says what it still supports, and the app asks before it
--  trusts its own code. One row per app, one number: the oldest build
--  that still works against what is deployed now.
--
--  WHEN A SIGNATURE CHANGES INCOMPATIBLY
--    1. ship the new client build
--    2. raise min_build here to that build
--  Anything older then stops and offers to update itself, rather than
--  failing one call at a time.
--
--  FAILING OPEN, ON PURPOSE
--  If this cannot be reached — no signal at the pool, which is the norm
--  rather than the exception — the app carries on. A coach locked out of
--  attendance by a version check that could not run would be a worse
--  outcome than the problem it guards against. It blocks only on a
--  clear, successful "you are too old".
-- ════════════════════════════════════════════════════════════════════════


-- ─── 1. What each app must be at ────────────────────────────────────────
create table if not exists app_clients (
  app         text primary key check (app in ('attendance','parent','admin')),
  min_build   integer not null default 1 check (min_build >= 1),
  -- Shown to whoever is holding the phone, so it says what changed
  -- rather than "please update".
  message     text,
  updated_at  timestamptz not null default now(),
  updated_by  text
);

insert into app_clients (app, min_build, message) values
  ('attendance', 1, 'The attendance app has been updated.'),
  ('parent',     1, 'The app has been updated.'),
  ('admin',      1, 'The scheduler has been updated.')
on conflict (app) do nothing;

comment on table app_clients is
  'The oldest build of each app that still works against what is '
  'deployed. Raise min_build when a function signature changes in a way '
  'an older build cannot survive.';


-- ─── 2. What the app asks on waking ─────────────────────────────────────
-- Deliberately tells an unknown app that it is fine. A new front door
-- that nobody has registered here should not be dead on arrival.
create or replace function client_gate(p_app text, p_build integer)
returns jsonb
language sql stable security definer set search_path = public as $$
  select case
    when c.app is null then jsonb_build_object('ok', true, 'known', false)
    when coalesce(p_build, 0) >= c.min_build
      then jsonb_build_object('ok', true, 'known', true, 'min_build', c.min_build)
    else jsonb_build_object(
      'ok', false, 'known', true,
      'min_build', c.min_build,
      'your_build', coalesce(p_build, 0),
      'message', coalesce(nullif(btrim(c.message), ''), 'This app has been updated.'))
  end
    from (select 1) z
    left join app_clients c on c.app = p_app;
$$;

comment on function client_gate(text, integer) is
  'Is this build still supported? Answers ok:false only when it is '
  'certainly too old — the apps carry on when this cannot be reached.';


-- ─── 3. Raising the bar ─────────────────────────────────────────────────
-- Used after shipping a build that an older one cannot interoperate
-- with. Separate from a plain update so it reads as the deliberate act
-- it is: everybody below this number is stopped.
create or replace function require_client_build(
  p_app text, p_build integer, p_message text default null)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_who text; v_was int;
begin
  if not can_write_office() then
    return jsonb_build_object('ok', false, 'error', 'Not yours to set.');
  end if;
  select min_build into v_was from app_clients where app = p_app;
  if v_was is null then
    return jsonb_build_object('ok', false, 'error', 'No such app: ' || coalesce(p_app, '(null)'));
  end if;

  select coalesce(nullif(btrim(coalesce(
           (select e.full_name from admin_employees e
             where e.id = attendance_my_crew_id()), '')), ''), 'the office')
    into v_who;

  update app_clients
     set min_build = p_build,
         message = coalesce(nullif(btrim(coalesce(p_message, '')), ''), message),
         updated_at = now(), updated_by = v_who
   where app = p_app;

  return jsonb_build_object('ok', true, 'app', p_app, 'was', v_was, 'now', p_build);
end $$;


-- ─── 4. Locks ───────────────────────────────────────────────────────────
alter table app_clients enable row level security;
drop policy if exists app_clients_read on app_clients;
-- Readable by anyone signed in to any of the three doors: a build number
-- is not a secret, and the gate has to answer before anything else does.
create policy app_clients_read on app_clients for select using (true);
revoke all on app_clients from anon;
grant select on app_clients to authenticated;

revoke all on function client_gate(text, integer) from public;
grant execute on function client_gate(text, integer) to anon, authenticated;
revoke all on function require_client_build(text, integer, text) from public, anon;
grant execute on function require_client_build(text, integer, text) to authenticated;


-- ─── 5. Where each app stands ───────────────────────────────────────────
select app                                  as thing,
       'build ' || min_build || ' or newer' as n,
       coalesce(to_char(updated_at, 'DD Mon YYYY'), '—') as set_on,
       coalesce(updated_by, '—')            as set_by
  from app_clients
 order by app;
