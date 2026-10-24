-- ════════════════════════════════════════════════════════════════════════
--  Read a number that was written with its country code
-- ════════════════════════════════════════════════════════════════════════
--  Safe to re-run, and safe to run after the parent accounts migration.
--  It changes no student row. It replaces two functions and fills in
--  phone numbers on parent_accounts that were left empty.
--
--  WHAT THE REPORT SHOWED
--  284 families, 276 able to sign in, 8 not. Of those 8, three have a
--  perfectly good mobile that my rule threw away for not being
--  Malaysian:
--
--    Soo Wei Sam    +447902114072       a UK mobile
--    Wong Kar How   +65 81596649        a Singapore mobile
--    Quek Hui Chiet +60198339888 / +61430128874. (Whatsapp)
--
--  WhatsApp does not care which country a number is from. Refusing them
--  was my limitation, not a fact about them — and the last one is the
--  two-phone case written into a single field by hand, a year before
--  there was a field for it.
--
--  WHAT CHANGES
--  A number written WITH a country code is taken as given: + and eight
--  to fifteen digits. A number written WITHOUT one is still read as
--  Malaysian, because that is the only safe reading of a local format.
--  A field holding several numbers gives up all of them, Malaysian
--  first, so the second becomes the family's secondary number.
--
--  WHAT STILL CANNOT SIGN IN, AND WHY THAT IS RIGHT
--    Ms CELIA CHAI  "6194729628"  — ten digits, no country code and not
--                   a Malaysian mobile. It could be 019-4729628 with a
--                   mistyped leading digit, or an Australian number. A
--                   guess here sends somebody's OTP to a stranger.
--    Mah Soon Ling  the whole registration form pasted into the phone
--                   field. The number is in there, and so are four other
--                   numbers including a date of birth.
--    Mr Foong, Yumnesh, and one unnamed account — no number at all.
--
--  Five accounts, each a minute of typing on the Accounts screen.
-- ════════════════════════════════════════════════════════════════════════


-- ═══ 1. Every number a field holds, best first ══════════════════════════
create or replace function ss_phones(p_raw text)
returns text[]
language plpgsql immutable
as $$
declare
  m        text;
  d        text;
  out_intl text[] := '{}';
  out_my   text[] := '{}';
  seen     text[] := '{}';
  v        text;
begin
  if p_raw is null then return '{}'; end if;

  -- Written with a country code: taken as given. Spaces and dashes
  -- inside the number are ignored; the run ends at the first character
  -- that is neither.
  for m in
    select (regexp_matches(p_raw, '\+[0-9][0-9 \-\(\)]{6,20}', 'g'))[1]
  loop
    d := regexp_replace(m, '[^0-9]', '', 'g');
    if length(d) between 8 and 15 then
      v := '+' || d;
      if not (v = any(seen)) then
        seen := seen || v;
        -- A Malaysian number is the one to try first: it is the one the
        -- centre actually rings.
        if left(d, 2) = '60' then out_my := out_my || v;
        else                      out_intl := out_intl || v;
        end if;
      end if;
    end if;
  end loop;

  if array_length(out_my, 1) is not null or array_length(out_intl, 1) is not null then
    return out_my || out_intl;
  end if;

  -- No country code anywhere, so read it as local. Anything that is not
  -- a Malaysian mobile falls out here rather than being bent into shape:
  -- a wrong guess sends somebody's sign-in code to a stranger.
  d := regexp_replace(p_raw, '[^0-9]', '', 'g');
  if d = '' then return '{}'; end if;
  if left(d, 1) = '0' then d := substr(d, 2); end if;
  if d ~ '^1[0-9]{8,9}$' then return array['+60' || d]; end if;
  return '{}';
end $$;

comment on function ss_phones(text) is
  'Every usable number in a free-text phone field, Malaysian first. A '
  'number written with a country code is taken as given; one written '
  'locally is read as Malaysian or not at all.';

-- The single best number, which is what almost everything wants.
create or replace function ss_normalise_phone(p_raw text)
returns text
language sql immutable
as $$ select (ss_phones(p_raw))[1]; $$;

comment on function ss_normalise_phone(text) is
  'The number an OTP goes to: the first of ss_phones(), Malaysian first.';


-- ═══ 2. What this recovers. Changes nothing. ════════════════════════════
select coalesce(nullif(btrim(s.guardian_name), ''), '— no name —') as guardian,
       s.guardian_phone as as_typed,
       coalesce(array_to_string(ss_phones(s.guardian_phone), ' + '),
                '') as now_reads_as,
       case when ss_normalise_phone(s.guardian_phone) is null
            then '>>> still cannot sign in — fix the number on the Accounts screen'
            else 'recovered' end as state
  from students s
 where s.account_id in (select id from parent_accounts where phone_primary is null)
 order by 4, 1;


-- ═══ 3. Fill the numbers in ═════════════════════════════════════════════
-- Only where the account has none. An account somebody has already
-- corrected by hand is left exactly as it is.
with found as (
  select s.account_id,
         (array_agg(p order by rn))[1] as p1,
         (array_agg(p order by rn))[2] as p2
    from (
      select s.account_id, p, row_number() over (partition by s.account_id order by s.id) as rn
        from students s, unnest(ss_phones(s.guardian_phone)) as p
       where s.account_id is not null
    ) s
   group by s.account_id
)
update parent_accounts pa
   set phone_primary   = coalesce(pa.phone_primary, f.p1),
       phone_secondary = coalesce(pa.phone_secondary,
                                  case when f.p2 <> coalesce(pa.phone_primary, f.p1)
                                       then f.p2 end)
  from found f
 where pa.id = f.account_id
   and (pa.phone_primary is null or pa.phone_secondary is null)
   and f.p1 is not null
   and not exists (                      -- never take a number another account owns
     select 1 from parent_accounts o
      where o.id <> pa.id
        and (o.phone_primary = f.p1 or o.phone_secondary = f.p1)
   );


-- ═══ 4. Where that leaves things ════════════════════════════════════════
select count(*)                                            as accounts,
       count(*) filter (where phone_primary is not null)   as can_sign_in,
       count(*) filter (where phone_secondary is not null) as have_a_second_number,
       count(*) filter (where phone_primary is null)       as cannot_sign_in
  from parent_accounts;

-- The ones still to fix, by hand, on the Accounts screen.
select pa.display_name,
       string_agg(distinct s.guardian_phone, ' / ') as phone_as_typed,
       string_agg(distinct s.name, ', ')            as children
  from parent_accounts pa
  left join students s on s.account_id = pa.id
 where pa.phone_primary is null
 group by pa.id, pa.display_name
 order by 1;

-- And the families that now have two numbers on file.
select display_name, phone_primary, phone_secondary, active_phone
  from parent_accounts
 where phone_secondary is not null
 order by 1;
