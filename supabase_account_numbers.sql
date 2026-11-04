-- ════════════════════════════════════════════════════════════════════════
--  An account number a parent can say over the phone
-- ════════════════════════════════════════════════════════════════════════
--  Run this whole file in the Supabase SQL editor. Safe to re-run. It
--  adds one column, three functions and a trigger, and gives every
--  existing account a number without touching anything else.
--
--  Then run supabase_rls_guard.sql — no new table here, but it is the
--  habit, and it costs nothing.
--
--  WHY NOT THE UUID
--  Every account already has one: 8f3c1a92-5b6d-4e07-… Nobody reads that
--  down a phone line, nobody writes it on a form, and a parent asked for
--  it will get it wrong. It is an excellent key and a hopeless name.
--
--  So: TAN-7391. Four letters of the name they gave, and four digits.
--  Short enough to say, specific enough that a parent reading it back
--  wrong is obvious rather than silently finding somebody else's family.
--
--  WHY THE NAME IS IN IT
--  Because the failure it prevents is the quiet one. A bare number
--  mistyped is another valid number. TAN-7391 typed when the family is
--  Lee does not resolve, and the office sees why immediately.
--
--  IT IS NOT A PASSWORD
--  An account number is written on receipts and said out loud in a
--  noisy reception. It identifies, it does not authenticate. Attaching a
--  child to an existing account takes the number AND a phone already on
--  that account — which is why find_account refuses to answer on either
--  one alone, and why it is not reachable with the public key at all.
-- ════════════════════════════════════════════════════════════════════════


-- ─── 1. The column ──────────────────────────────────────────────────────
alter table parent_accounts
  add column if not exists account_no text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'parent_accounts_account_no_key') then
    alter table parent_accounts add constraint parent_accounts_account_no_key unique (account_no);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'parent_accounts_account_no_ck') then
    alter table parent_accounts add constraint parent_accounts_account_no_ck
      check (account_no is null or account_no ~ '^[A-Z]{2,4}-[0-9]{4}$');
  end if;
end $$;

comment on column parent_accounts.account_no is
  'What a parent is told to quote: TAN-7391. Identifies the family, '
  'never authenticates it — attaching a child needs this and a phone '
  'already on the account.';


-- ─── 2. The letters ─────────────────────────────────────────────────────
-- The first word of the name they gave, up to four letters. That lands
-- on the surname for a Chinese name, where it comes first, and on the
-- given name for a Malay one, where it does — and it reads as theirs
-- either way, which is the whole job. It is not trying to be a
-- taxonomy of names.
create or replace function account_slug(p_name text)
returns text
language sql immutable as $$
  select coalesce(
    nullif(
      left(
        upper(regexp_replace(split_part(btrim(coalesce(p_name, '')), ' ', 1),
                             '[^A-Za-z]', '', 'g')),
        4),
      ''),
    'SSB');   -- no usable letters at all: an account with no name yet
$$;


-- ─── 3. Giving one out ──────────────────────────────────────────────────
-- Random digits rather than the next number up. Sequential would say how
-- many families the centre has and would let anybody walk the list; the
-- number is not a secret but it need not be an index either.
create or replace function assign_account_no(p_account_id uuid)
returns text
language plpgsql security definer set search_path = public as $$
declare v_slug text; v_try text; i int := 0;
begin
  select account_no into v_try from parent_accounts where id = p_account_id;
  if v_try is not null then return v_try; end if;          -- never reissued

  select account_slug(display_name) into v_slug
    from parent_accounts where id = p_account_id;
  if v_slug is null then return null; end if;              -- no such account

  loop
    i := i + 1;
    v_try := v_slug || '-' || lpad((floor(random() * 10000))::int::text, 4, '0');
    begin
      update parent_accounts set account_no = v_try where id = p_account_id;
      return v_try;
    exception when unique_violation then
      -- Ten thousand per name prefix. A clash is rare and cheap; giving
      -- up after a hundred is only so this cannot spin forever.
      if i >= 100 then
        raise exception 'Could not find a free account number for %', v_slug;
      end if;
    end;
  end loop;
end $$;

-- Every new account gets one at birth, so nothing downstream has to
-- remember to ask. Runs after insert because the name has to be there.
create or replace function parent_account_number_on_insert()
returns trigger
language plpgsql security definer set search_path = public as $$
begin
  perform assign_account_no(new.id);
  return null;
end $$;

drop trigger if exists parent_account_number_trg on parent_accounts;
create trigger parent_account_number_trg
  after insert on parent_accounts
  for each row when (new.account_no is null)
  execute function parent_account_number_on_insert();


-- ─── 3b. The part of a phone number that is the phone number ───────────
-- 012-345 6001, 0123456001 and +60123456001 are one phone. The last
-- nine digits are the same in all three; everything before them is how
-- it was written down.
create or replace function phone_tail(p_phone text)
returns text
language sql immutable as $$
  select case when length(d) >= 9 then right(d, 9) else nullif(d, '') end
    from (select regexp_replace(coalesce(p_phone, ''), '[^0-9]', '', 'g') as d) z;
$$;


-- ─── 4. Finding a family, carefully ─────────────────────────────────────
-- For the intake form's second visit: a parent adding another child
-- quotes the account number, and proves it is theirs with a phone
-- already on the account.
--
-- Refuses on either alone, and says the same thing both ways. "No such
-- account" and "that is not the phone we have" are two different
-- sentences to somebody guessing, and one sentence to somebody who has
-- genuinely mistyped.
--
-- Not granted to anon. The intake form reaches it through the
-- public-intake Edge Function, which holds the service role and is the
-- only thing between this and the open internet.
create or replace function find_account(p_account_no text, p_phone text)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare a parent_accounts; v_no text; v_ph text;

  -- A parent types 012-345 6001; we hold +60123456001. Same phone, and
  -- comparing the digits whole says otherwise, because one carries the
  -- country code and the other a leading zero. The last nine digits are
  -- the number itself either way.
  --
  -- Nine digits alone would be a loose match. It is not alone: the
  -- account number has to agree with it as well.

begin
  v_no := upper(btrim(coalesce(p_account_no, '')));
  v_ph := phone_tail(p_phone);
  if v_no = '' or v_ph is null then
    return jsonb_build_object('ok', false,
      'error', 'Enter the account number and a phone number on the account.');
  end if;

  select * into a from parent_accounts where account_no = v_no;

  if a.id is null
     or (phone_tail(a.phone_primary)   is distinct from v_ph
     and phone_tail(a.phone_secondary) is distinct from v_ph) then
    return jsonb_build_object('ok', false,
      'error', 'That account number and phone number do not go together. '
            || 'Check both, or carry on as a new family and we will join them up.');
  end if;

  return jsonb_build_object('ok', true,
    'account_id', a.id,
    'account_no', a.account_no,
    'display_name', a.display_name,
    'children', coalesce((select jsonb_agg(s.name order by s.name)
                            from students s where s.account_id = a.id
                             and s.is_active is not false), '[]'::jsonb));
end $$;

revoke all on function assign_account_no(uuid)       from public, anon;
revoke all on function find_account(text, text)      from public, anon;
grant execute on function assign_account_no(uuid)    to authenticated;
grant execute on function find_account(text, text)   to authenticated;


-- ─── 5. Everybody who is already here ───────────────────────────────────
-- The assignment is a DO block, which returns nothing, so the single
-- result the SQL editor shows is the report below it.
--
-- It was one statement to begin with — the work in a CTE and the counts
-- beside it — and the counts came back as though nothing had happened.
-- Everything in one statement reads the same snapshot, taken before the
-- statement ran, so it was reporting the world as it was a moment
-- earlier. The numbers had been handed out perfectly well.
do $$
declare r record;
begin
  for r in select id from parent_accounts where account_no is null loop
    perform assign_account_no(r.id);
  end loop;
end $$;

select 'accounts with a number'   as thing, count(*)::text as n
  from parent_accounts where account_no is not null
union all
select 'accounts still without one', count(*)::text
  from parent_accounts where account_no is null
union all
select 'accounts with no usable name, numbered SSB-',
       count(*)::text from parent_accounts where account_no like 'SSB-%'
union all
select 'for example',
       coalesce((select account_no || '  (' || coalesce(display_name, '—') || ')'
                   from parent_accounts
                  where account_no is not null
                  order by created_at desc limit 1), '—');
