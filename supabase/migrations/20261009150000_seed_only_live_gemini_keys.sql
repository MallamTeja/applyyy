-- =============================================================================
-- New users' Gemini key pool: seed keys 12-20 DISABLED, matching existing users.
--
-- WHY. applyy_internal.seed_user_defaults (20261008180000) seeds 20 gemini_key_state
-- rows, all enabled by the column default. Keys 12-20 have been 403 project-denied since
-- 2026-10-05 and were disabled for both existing users on 2026-10-06. A new signup would
-- get them back enabled, and claim_gemini_key would hand out dead keys until each
-- failed its way to a cooldown.
--
-- SCOPE: NEW users only. The seed's inserts are ON CONFLICT DO NOTHING, so existing rows
-- are never touched, and this migration writes no row. The only change is the key-pool
-- insert (tagged NEW-150000). Everything else is copied verbatim from 20261008180000,
-- whose body matched live byte for byte (md5(prosrc) 8a3127bbbee9ae421dfd1908ec54975f,
-- 4073 bytes, 2026-10-09). Same signature, owner, INVOKER, search_path and grants.
--
-- WHY A CONSTANT, NOT READ FROM THE LIVE POOL: the seed already carries its key count as
-- a constant (v_key_count), so this extends the existing pattern instead of adding a new
-- mechanism. Deriving "enabled" from other users' rows would couple tenants and needs a
-- fallback for the first user. The trade-off: the next time a key dies, this constant
-- needs a migration alongside the UPDATE that disables it for existing users.
--
-- Re-runnable: CREATE OR REPLACE; REVOKE is idempotent. WRITTEN, NOT APPLIED.
-- =============================================================================

-- The seed, with the key-pool insert changed (NEW-150000) and nothing else.
create or replace function applyy_internal.seed_user_defaults(p_user_id uuid)
returns void
language plpgsql
-- Empty search_path so no caller-controlled schema can shadow a name. Every name
-- below is schema-qualified.
set search_path = ''
as $$
declare
  -- Loop variable for the cost-ordered rule array.
  v_rule public.filter_rule_type;
  -- Starts at 10 and steps by 10, leaving gaps so a rule can be inserted between two
  -- others later without renumbering the cascade. Unchanged from 20260917124500.
  v_order smallint := 10;
  -- Twenty keys, matching the twenty Gemini API keys. Unchanged from 20260917124500.
  -- The row count is unchanged; 20261009150000 changed only which rows start enabled.
  v_key_count constant smallint := 20;
  -- NEW-150000: keys 1..v_live_key_count are seeded enabled, the rest disabled. 11
  -- because keys 12-20 have answered 403 PERMISSION_DENIED (project-denied) since
  -- 2026-10-05 and were disabled for every existing user on 2026-10-06 (live
  -- gemini_key_state, 2026-10-09: both users enabled 1-11, disabled 12-20). The env
  -- keys are shared by the whole deployment, so their health is not per user.
  v_live_key_count constant smallint := 11;
begin
  -- Fail loudly on a missing id rather than seeding rows owned by nobody. Same
  -- errcode the auth.uid() check in the wrapper has always used.
  if p_user_id is null then
    -- 42501 is insufficient_privilege, which the client maps to a sign-in.
    raise exception 'seed_user_defaults() requires a user id'
      using errcode = '42501';
  end if;

  -- The kill switch and budget row. claim_gemini_key() reads its enabled flag from
  -- here and fails closed when the row is missing, so this row existing is what makes
  -- the pipeline able to run at all.
  insert into public.system_settings (user_id) values (p_user_id)
    -- Idempotent: system_settings_pkey is (user_id).
    on conflict (user_id) do nothing;

  -- Search preferences, all defaulted at the column level.
  insert into public.search_preferences (user_id) values (p_user_id)
    -- Idempotent: search_preferences_pkey is (user_id).
    on conflict (user_id) do nothing;

  -- The key pool. Seeded rows carry last_used_at at its column default, so an unused
  -- key sorts first under claim_gemini_key's LRU ordering. An enabled seeded row is usable at once.
  --
  -- NEW-150000: still ALL v_key_count rows, with the dead ones DISABLED rather than
  -- absent. That mirrors every existing user's pool exactly, so a later re-enable is one
  -- UPDATE for everyone. And public.set_gemini_key_pool_size(p_count) inserts MISSING
  -- rows at the column default enabled = true: an 11-row pool would let one call bring
  -- 12-20 back enabled, whereas existing disabled rows win its ON CONFLICT DO NOTHING.
  insert into public.gemini_key_state (user_id, key_index, enabled)
  -- One row per key index, 1..v_key_count; enabled only within the live range.
  select p_user_id, i::smallint, i <= v_live_key_count
    -- generate_series is schema-qualified because search_path is empty.
    from pg_catalog.generate_series(1, v_key_count) as g(i)
    -- Idempotent: gemini_key_state_pkey is (user_id, key_index).
    on conflict (user_id, key_index) do nothing;

  -- Every filter rule, enabled, IN COST ORDER, so the settings page renders a complete
  -- cascade and turning a rule off is a toggle rather than a creation.
  --
  -- THE ORDER OF THIS ARRAY IS THE DESIGN (20260917124500). Do not replace it with
  -- enum_range(): that yields declaration order, which is exactly what broke it, and the
  -- breakage is invisible to tests because only the cost changes. Cheapest test first.
  foreach v_rule in array array[
    'title_blocklist',        -- string match, no parsing. Cheapest possible test.
    'employment_type',        -- enum compare.
    'location_allowlist',     -- array intersect.
    'company_blocklist',      -- one indexed lookup.
    'experience_ceiling',     -- needs the parsed years.
    'degree_mismatch',        -- needs the parsed degree requirement.
    'staleness',              -- needs posted_at AND its confidence.
    'already_applied',        -- needs a join to history.
    'per_company_weekly_cap'  -- needs an aggregate over a time window. Most expensive, last.
  ]::public.filter_rule_type[]
  loop
    -- sort_order, NOT evaluation_order: the latter never existed (the 42703 that
    -- 20260917124500 repaired).
    insert into public.filter_rules (user_id, rule_type, sort_order, config)
    values (
      -- The id passed in. Never auth.uid(), which is NULL inside a trigger.
      p_user_id,
      -- The rule being seeded on this pass.
      v_rule,
      -- Its cost position.
      v_order,
      -- The staleness rule carries the cold-start policy explicitly. Seeding '{}'
      -- would make the flag read as NULL rather than false, which inverts the policy.
      case when v_rule = 'staleness'
        then '{"treat_unknown_posted_at_as_fresh": false}'::jsonb
        else '{}'::jsonb
      end
    )
    -- Idempotent, backed by filter_rules_user_type_key UNIQUE (user_id, rule_type).
    -- A re-run never disturbs a user who has tuned their cascade.
    on conflict (user_id, rule_type) do nothing;

    -- Advance to the next cost slot.
    v_order := v_order + 10;
  end loop;
end;
$$;

-- Unchanged from 20261008180000: re-stated so this file alone proves the shape. CREATE OR
-- REPLACE keeps the ACL, so this changes nothing live; it guards a reader's assumption.
revoke all on function applyy_internal.seed_user_defaults(uuid)
  from public, anon, authenticated, service_role;

-- The comment now records the disabled range, so the next reader knows it's deliberate.
comment on function applyy_internal.seed_user_defaults(uuid) is
  'The one copy of the per-user default seed (settings, preferences, Gemini key pool, cost-ordered filter cascade). Idempotent. Seeds all 20 key rows with only keys 1-11 enabled (12-20 project-denied since 2026-10-05; 20261009150000). Takes an explicit id, so it is executable by its owner ONLY: callers are bootstrap_user_defaults() (passes auth.uid()) and the on-signup trigger (passes NEW.id). Never grant EXECUTE: a granted caller could seed rows for any user.';
