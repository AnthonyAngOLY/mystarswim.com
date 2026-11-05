-- ════════════════════════════════════════════════════════════════════════
--  Why a Scheduler login is being refused
-- ════════════════════════════════════════════════════════════════════════
--  Run this whole file in the Supabase SQL editor. It reads and reports.
--  Nothing is created or changed, and no password material is printed.
--
--  CHANGE THE NAME ON THE NEXT LINE AND RUN IT AGAIN FOR SOMEBODY ELSE.
--
--  WHY THIS IS NOT "LOOK AT THE PASSWORD"
--  There is no password stored to look at. app_users holds a salt and
--  sha256(salt || password), which is one-way: the plaintext is not in
--  the database and cannot be recovered from what is. If it could be,
--  that would be the more serious problem of the two.
--
--  The hash is not what is wanted anyway. The login function answers
--  "Incorrect username or password" for FOUR quite different reasons,
--  and only one of them is the password:
--
--    1. No row matches the username EXACTLY. The lookup is
--       .eq("username", u) — case-sensitive, and the trim is applied to
--       what she types, not to what is stored. "Clara" in the table and
--       "clara" typed is a miss. So is a trailing space in the table.
--
--    2. is_active is not exactly true. The lookup also carries
--       .eq("is_active", true), and in SQL that excludes NULL as well as
--       false. An account whose is_active was never set is refused while
--       looking perfectly normal on the admin screen.
--
--    3. No password has been set. With password_hash null the comparison
--       can never succeed, however many times it is typed correctly.
--
--    4. The password really is wrong.
--
--  Only the fourth is solved by a reset, and the first three are not
--  improved by one. Hence this.
--
--  WHAT IT WILL NOT PRINT
--  Not the hash and not the salt. A salted sha256 pasted into a chat
--  window is an offline cracking target that outlives the conversation;
--  whether one is PRESENT and the right SHAPE answers the question
--  without handing anybody that.
-- ════════════════════════════════════════════════════════════════════════

with
ask as (select 'clara'::text as who),          -- ← the username to look at

-- Anything close, not just an exact match: the whole point is to catch
-- the row that is nearly right.
hits as (
  select u.*,
         (u.username = (select who from ask))                      as exact,
         (u.username <> btrim(u.username))                         as padded,
         (lower(u.username) = lower((select who from ask))
            and u.username <> (select who from ask))               as case_only
    from app_users u, ask
   where u.username ilike '%' || ask.who || '%'
      or lower(u.username) = lower(ask.who)
)

select line, detail from (

  select 0 as sort, 'looking for' as line, '"' || (select who from ask) || '"' as detail

  union all
  select 1, 'logins found', case when (select count(*) from hits) = 0
         then '** none — nothing in app_users matches that name at all **'
         else (select count(*)::text from hits) || ' matching' end

  union all
  -- Quoted so a space either side is visible. An invisible character is
  -- exactly the kind of thing that survives being read aloud twice.
  select 2, 'username as stored', '"' || h.username || '"'
         || case when h.exact then '   (types exactly as asked)'
                 when h.case_only then '   ** different case — the lookup is case-sensitive, so this will not match **'
                 when h.padded then '   ** has a space at one end — stored, not typed, so it never matches **'
                 else '   ** not the name asked for **' end
    from hits h

  union all
  select 3, 'active', case
           when h.is_active is null then '** NULL — the lookup asks for exactly true, which excludes null. Refused. **'
           when h.is_active then 'yes'
           else '** no — the account is switched off, and that reads as a wrong password **' end
    from hits h

  union all
  select 4, 'seat', coalesce(h.role, '** none set **') from hits h

  union all
  -- Shape only. 64 hex characters is sha256; anything else was written
  -- by something that is not this login function.
  select 5, 'password', case
           when h.password_hash is null then '** none set — no password can ever match **'
           when h.password_salt is null then '** hash set but no salt — this cannot verify **'
           when length(h.password_hash) <> 64 or h.password_hash !~ '^[0-9a-f]+$'
             then '** set, but not a sha256 hex digest (' || length(h.password_hash)
                  || ' chars) — written by something else **'
           else 'set, and the right shape (sha256, salted)' end
    from hits h

  union all
  select 6, 'last signed in', coalesce(
           to_char(h.last_login_at at time zone 'Asia/Kuala_Lumpur', 'Dy DD Mon YYYY, HH24:MI'),
           'never') from hits h

  union all
  select 7, 'linked to Supabase Auth', case when h.auth_user_id is null
         then 'not yet (normal; it links on the first successful sign-in)'
         else 'yes' end
    from hits h

  union all
  select 8, 'what to do', (
    select case
      when not exists (select 1 from hits)
        then 'No such login. Create one, or check the spelling with her.'
      when not exists (select 1 from hits where exact)
        then 'The stored name is not what she is typing. Have her type it exactly as shown above.'
      when exists (select 1 from hits where exact and is_active is null)
        then 'is_active is null. Set it to true: update app_users set is_active = true where username = ''' || (select who from ask) || ''';'
      when exists (select 1 from hits where exact and is_active is false)
        then 'The account is switched off. Switch it back on in Settings, or set is_active = true.'
      when exists (select 1 from hits where exact and password_hash is null)
        then 'No password has ever been set on this account. Set one.'
      when exists (select 1 from hits where exact and password_salt is null)
        then 'There is a hash but no salt, so nothing can verify against it. Reset the password to write both.'
      -- A hash of another shape was put there by something that is not
      -- this login function, and it can never verify however correct the
      -- password is. Telling her to try again would be telling her to
      -- keep failing.
      when exists (select 1 from hits where exact
                     and (length(password_hash) <> 64 or password_hash !~ '^[0-9a-f]+$'))
        then 'The stored hash is not the shape this login writes, so it can never verify. Reset the password — a correct one will still be refused until you do.'
      else 'The account is fine: right name, active, password set. So the password she is typing is wrong — reset it.'
    end)

) z order by sort;
