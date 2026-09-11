-- ============================================================================
-- Migration: Epoch-Based Random Shuffle Key Pool with Primary Key 1 Pinning
--
-- PURPOSE:
-- 1. Adds `used_in_cycle` column to `public.gemini_key_state` to track the cycle stack.
-- 2. Upgrades `claim_gemini_key()`:
--    - Uses Key 1 first in every epoch.
--    - Uses uniform random sampling without replacement for subsequent calls.
--    - Automatically skips cooling keys (rate-limited via 429).
--    - When all active keys have been used, resets the stack and restarts from Key 1.
-- 3. Updates `bootstrap_user_defaults()` to seed 20 keys (matching 20 Gemini API keys).
-- 4. Seeds keys 1 through 20 for all registered users in `auth.users`.
-- ============================================================================

-- 1. Schema modification
alter table public.gemini_key_state
  add column if not exists used_in_cycle boolean not null default false;

create index if not exists gemini_key_state_cycle_idx
  on public.gemini_key_state (user_id, enabled, used_in_cycle, cooldown_until);

-- 2. Upgraded claim_gemini_key function
create or replace function public.claim_gemini_key()
returns smallint
language plpgsql
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_enabled boolean;
  v_budget integer;
  v_calls integer;
  v_key smallint;
  v_today date := public.pacific_today();
  v_candidate_count integer;
begin
  -- Kill switch and budget in one read.
  select s.system_enabled,
         s.gemini_daily_call_budget,
         case when s.gemini_budget_date = v_today then s.gemini_calls_today else 0 end
    into v_enabled, v_budget, v_calls
    from public.system_settings s
   where s.user_id = v_uid
     for update;

  -- Fail closed on a missing or disabled settings row
  if v_enabled is null or not v_enabled then
    return null;
  end if;

  -- Circuit breaker: budget reached
  if v_budget is not null and v_calls >= v_budget then
    return null;
  end if;

  -- 1. Count eligible keys not yet used in current cycle
  select count(*)
    into v_candidate_count
    from public.gemini_key_state k
   where k.user_id = v_uid
     and k.enabled
     and not k.used_in_cycle
     and (k.cooldown_until is null or k.cooldown_until <= now());

  -- 2. If all eligible keys have been used in this cycle, check if any non-cooling keys exist to reset
  if v_candidate_count = 0 then
    select count(*)
      into v_candidate_count
      from public.gemini_key_state k
     where k.user_id = v_uid
       and k.enabled
       and (k.cooldown_until is null or k.cooldown_until <= now());

    -- Reset the cycle stack if there are non-cooling keys available
    if v_candidate_count > 0 then
      update public.gemini_key_state
         set used_in_cycle = false
       where user_id = v_uid
         and enabled;
    else
      -- All keys are currently in cooldown / exhausted
      return null;
    end if;
  end if;

  -- 3. Atomic selection with Key 1 prioritized first, followed by random pick without replacement
  update public.gemini_key_state g
     set last_used_at = now(),
         used_in_cycle = true,
         quota_date = v_today,
         requests_today = case when g.quota_date = v_today then g.requests_today + 1 else 1 end
   where (g.user_id, g.key_index) = (
     select k.user_id, k.key_index
       from public.gemini_key_state k
      where k.user_id = v_uid
        and k.enabled
        and not k.used_in_cycle
        and (k.cooldown_until is null or k.cooldown_until <= now())
      order by
        -- Key 1 first in the cycle:
        case when k.key_index = 1 then 0 else 1 end,
        -- Otherwise uniform random distribution:
        random()
        for update skip locked
      limit 1
   )
  returning g.key_index into v_key;

  if v_key is null then
    return null;
  end if;

  -- Charge budget
  update public.system_settings s
     set gemini_calls_today = v_calls + 1,
         gemini_budget_date = v_today
   where s.user_id = v_uid;

  return v_key;
end;
$$;

comment on function public.claim_gemini_key() is
  'Epoch-based key claim. Always starts each cycle with Key 1, followed by uniform random selection without replacement. Resets cycle when all keys are used. Cooling keys skipped automatically.';

-- 3. Update bootstrap_user_defaults to seed 20 keys
create or replace function public.bootstrap_user_defaults()
returns void
language plpgsql
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_rule public.filter_rule_type;
  v_order smallint := 10;
  v_key_count constant smallint := 20;
begin
  if v_uid is null then
    raise exception 'bootstrap_user_defaults() requires an authenticated session'
      using errcode = '42501';
  end if;

  insert into public.system_settings (user_id) values (v_uid)
    on conflict (user_id) do nothing;

  insert into public.search_preferences (user_id) values (v_uid)
    on conflict (user_id) do nothing;

  -- Seed 20 keys for the user
  insert into public.gemini_key_state (user_id, key_index)
  select v_uid, i::smallint
    from pg_catalog.generate_series(1, v_key_count) as g(i)
    on conflict (user_id, key_index) do nothing;

  -- Seed filter rules
  for v_rule in select unnest(enum_range(null::public.filter_rule_type)) loop
    insert into public.filter_rules (user_id, rule_type, evaluation_order)
    values (v_uid, v_rule, v_order)
    on conflict (user_id, rule_type) do nothing;
    v_order := v_order + 10;
  end loop;
end;
$$;

-- 4. Seed 20 keys for any existing user accounts in auth.users
insert into public.gemini_key_state (user_id, key_index)
select u.id, i::smallint
  from auth.users u
 cross join pg_catalog.generate_series(1, 20) as g(i)
on conflict (user_id, key_index) do nothing;
