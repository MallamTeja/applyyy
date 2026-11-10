-- =============================================================================
-- Retire the job-age filter (staleness) and the per-company weekly cap: rows, seed, settings.
--
-- WHY. Teja, 2026-11-10 11:31 IST: the per-company weekly cap: "remove it"; job age: "dont ever skip even though they
-- are 1 mon 2 mont old". Both lived in two places:
--   1. filter_rules rows 'staleness' (config {"treat_unknown_posted_at_as_fresh": false}) and 'per_company_weekly_cap'
--      (config {}), seeded enabled for every user by applyy_internal.seed_user_defaults. They ran in
--      supabase/functions/_shared/filter/cascade.ts, dormant only because no threshold was set: one number typed on the
--      Filters page switched them on, and a staleness window also dropped EVERY posted_at_source = 'unknown' job.
--   2. system_settings.max_applications_per_company_per_week (live 2) and freshness_window_days (live 3). Zero readers:
--      no pg_proc body, view or policy names them (pg_depend: only their defaults and their own CHECKs; recon
--      2026-11-10), and no code reads them.
--
-- WHAT THIS FILE DOES, and the order the code must ship in:
--   - CODE FIRST (same commit as this file, deployed BEFORE this runs): cascade.ts makes both rule types a no-drop,
--     no-warning `retiredRule`; the screen context stops counting applications per company; the web Filters page and
--     its store stop rendering, defaulting and saving both rule types (RETIRED_FILTER_RULE_TYPES); shared-types drops the
--     two system_settings fields (the enum-parity test replays THIS file, so they must land together).
--   - THEN this migration: (a) recreate seed_user_defaults without the two rules, so no new user gets them; (b) delete
--     the existing rows, reporting matched vs deleted counts; (c) drop the two settings columns.
--
-- WHY THE ENUM VALUES STAY: Postgres cannot drop an enum value, and cascade.ts keys RULE_IMPLEMENTATIONS by
-- filter_rule_type (a missing key is a compile error by design). So 'staleness' and 'per_company_weekly_cap' remain as
-- enum values that NOTHING seeds, the web never writes, and the cascade treats as inert. Do not "restore" the rows or
-- the columns without a new ruling from Teja: no-drop is the point.
--
-- NOT AGE: job liveness (jobs.disappeared_at, scout liveness) and the dropped-row tombstone are untouched. They are
-- about a posting being GONE, not about how old it is.
--
-- The seed body is copied VERBATIM from 20261009150000_seed_only_live_gemini_keys.sql, which matched live line for
-- line (95/95, recon 2026-11-10). Only the lines tagged NEW-120000 change. Same signature, owner, INVOKER,
-- search_path and grants.
--
-- Re-runnable: CREATE OR REPLACE; the delete matches nothing a second time (it warns, never fails); the column drops
-- use IF EXISTS. WRITTEN, NOT APPLIED: the orchestrator applies it after the code deploy.
-- =============================================================================

-- (a) The seed, minus the two retired rules (NEW-120000), everything else verbatim.
create or replace function applyy_internal.seed_user_defaults(p_user_id uuid)
  returns void
  language plpgsql
  set search_path to ''
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
  -- One row per index from 1 to the row count (v_key_count); enabled only within the live range.
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
  -- NEW-120000: enum_range() would now also bring back the two RETIRED rules ('staleness',
  -- 'per_company_weekly_cap'), a second reason never to use it here.
  foreach v_rule in array array[
    'title_blocklist',        -- string match, no parsing. Cheapest possible test.
    'employment_type',        -- enum compare.
    'location_allowlist',     -- array intersect.
    'company_blocklist',      -- one indexed lookup.
    'experience_ceiling',     -- needs the parsed years.
    'degree_mismatch',        -- needs the parsed degree requirement.
    -- NEW-120000: 'staleness' removed here (Teja 2026-11-10: job age never skips a job).
    'already_applied'         -- needs a join to history. Last since NEW-120000.
    -- NEW-120000: 'per_company_weekly_cap' removed here (Teja 2026-11-10: "remove it").
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
      -- NEW-120000: every seeded rule starts with an empty config. The staleness special case
      -- ({"treat_unknown_posted_at_as_fresh": false}) went with the staleness rule.
      '{}'::jsonb
    )
    -- Idempotent, backed by filter_rules_user_type_key UNIQUE (user_id, rule_type).
    -- A re-run never disturbs a user who has tuned their cascade.
    on conflict (user_id, rule_type) do nothing;

    -- Advance to the next cost slot.
    v_order := v_order + 10;
  end loop;
end;
$$;

-- Unchanged from 20261009150000: re-stated so this file alone proves the shape. CREATE OR
-- REPLACE keeps the ACL, so this changes nothing live; it guards a reader's assumption.
revoke all on function applyy_internal.seed_user_defaults(uuid)
  from public, anon, authenticated, service_role;

-- The comment now records the retired rules (NEW-120000), so the next reader knows their absence is deliberate.
comment on function applyy_internal.seed_user_defaults(uuid) is
  'The one copy of the per-user default seed (settings, preferences, Gemini key pool, cost-ordered filter cascade). Idempotent. Seeds all 20 key rows with only keys 1-11 enabled (12-20 project-denied since 2026-10-05; 20261009150000). Does NOT seed the retired rules staleness and per_company_weekly_cap (Teja 2026-11-10; 20261110120000). Takes an explicit id, so it is executable by its owner ONLY: callers are bootstrap_user_defaults() (passes auth.uid()) and the on-signup trigger (passes NEW.id). Never grant EXECUTE: a granted caller could seed rows for any user.';

-- (b) The existing rows. A deletion, not a disable: an enabled = false row still renders as a toggle that turns the
-- rule back on, which is the exact path this ruling closes. filter_rules has no append-only trigger (only
-- set_updated_at, BEFORE UPDATE), so a plain DELETE is the honest operation.
do $$
declare
  -- Rows of the two retired types at the moment of the delete (2 on 2026-11-10: one each, one user).
  matched bigint;
  -- Rows the DELETE actually removed.
  deleted bigint;
begin
  -- Count first, so the two numbers can be compared and reported (CLAUDE.md §7).
  select count(*) into matched from public.filter_rules where rule_type in ('staleness', 'per_company_weekly_cap');
  -- The delete itself.
  delete from public.filter_rules where rule_type in ('staleness', 'per_company_weekly_cap');
  -- How many it removed.
  get diagnostics deleted = row_count;
  -- Nothing matched: a re-run, or the rows were already gone. Warn, never fail, so the column drops still run.
  if matched = 0 then
    -- Visible in the push output.
    raise warning 'retire_job_age_and_company_cap: no staleness/per_company_weekly_cap rows matched (re-run?)';
  end if;
  -- Both numbers, always, so the operator compares what was there with what went.
  raise notice 'retire_job_age_and_company_cap: filter_rules matched %, deleted %', matched, deleted;
end
$$;

-- (c) The two dead settings columns. The drop needs an ACCESS EXCLUSIVE lock, and a queued one blocks every reader
-- behind it (precedent 20261109120000).
set lock_timeout = '5s';

-- Live 2 when dropped; zero readers. `if exists` makes a re-run harmless. Its CHECK (> 0) goes with the column.
alter table public.system_settings drop column if exists max_applications_per_company_per_week;

-- Live 3 when dropped; zero readers. Its CHECK (> 0) goes with the column.
alter table public.system_settings drop column if exists freshness_window_days;

-- Back to the role default, so nothing later in this session inherits the short lock timeout.
reset lock_timeout;
