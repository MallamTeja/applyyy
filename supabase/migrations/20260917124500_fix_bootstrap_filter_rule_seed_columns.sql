-- ============================================================================
-- Repairs `bootstrap_user_defaults()`, which has been RAISING AT CALL TIME since
-- migration 20260912001500 was applied.
--
-- THE BREAK: that migration's seed loop inserts into a column named
-- `evaluation_order`. No such column exists. The real column is `sort_order`
-- (20260909234800_supporting_tables.sql:229). A repo-wide grep for
-- `evaluation_order` returns exactly one hit — the broken line itself — so this is
-- a typo with no counterpart anywhere, not a rename half-applied.
--
-- WHY THE BLAST RADIUS IS THREE TABLES AND NOT ONE. The function raises 42703 on
-- the filter_rules insert, but system_settings, search_preferences and
-- gemini_key_state are written in the SAME TRANSACTION. Postgres rolls the whole
-- call back. So every user bootstrapped after 20260912001500 has NO filter rules,
-- NO system settings and NO search preferences — and since `system_settings` is
-- what `claim_gemini_key()` reads its kill switch from, that user's pipeline is
-- not merely unconfigured, it is inert. The symptom is an account that looks idle.
--
-- THIS MIGRATION REDEFINES THE FUNCTION. It does NOT edit 20260912001500, which is
-- already applied to the remote database; editing an applied migration rewrites
-- history the database has run and leaves the file disagreeing with reality.
--
-- ============================================================================
-- THE THIRD REGRESSION, WHICH WAS NOT IN THE BUG REPORT AND IS THE WORST OF THEM
-- ============================================================================
-- 20260912001500 replaced an explicit nine-element array with
-- `enum_range(null::public.filter_rule_type)`. That loop did not only reorder the
-- rules — IT DROPPED THE `config` COLUMN FROM THE INSERT ENTIRELY.
--
-- The version it replaced seeded one rule with a real policy value:
--     when v_rule = 'staleness'
--       then '{"treat_unknown_posted_at_as_fresh": false}'::jsonb
-- That is the cold-start rule: postings from a board whose `posted_at` we do not
-- trust must FAIL the freshness check rather than bypass it. It is documented as a
-- deliberate setting at supporting_tables.sql:221-224, and it was present in BOTH
-- earlier definitions (queue_and_pool_functions.sql:455 and
-- fix_sweep_count_bootstrap_seed.sql:230). It is absent from 20260912001500.
--
-- So once the 42703 is fixed, every staleness rule would seed with config `{}`,
-- and `treat_unknown_posted_at_as_fresh` would read as absent — which a reader
-- checking `config->>'treat_unknown_posted_at_as_fresh'` gets as NULL, not false.
-- AN UNTRUSTED POSTING WOULD BYPASS THE FRESHNESS CHECK RATHER THAN FAILING IT:
-- the exact inversion the setting exists to prevent, arriving silently, in a
-- migration whose stated purpose was seeding Gemini keys.
--
-- Restoring it here is regression repair, not a policy change — the policy was
-- ruled once, written down, and lost by accident.
--
-- THE MIGRATION THAT LOST IT PREDICTED ITS OWN LOSS. fix_sweep_count_bootstrap_seed
-- carries this warning above the very loop that was later replaced:
--     "Reproduced verbatim from the original body, NOT refactored into a helper:
--      `create or replace` replaces the WHOLE function body, so anything omitted
--      here would be silently removed from the deployed function."
-- The next migration refactored that loop and omitted the config. A comment is not
-- a control: the warning was correct, was read, and did not stop the thing it
-- described. Only re-seeding the value stops it.
-- ============================================================================

-- ============================================================================
-- FIX 2 — cost ordering, which the enum_range loop also destroyed.
-- ============================================================================
-- `enum_range()` yields DECLARATION order, and filter_rule_type is declared with
-- `experience_ceiling` first (20260909234500_enums.sql). So the deployed seed puts
-- the rule that must PARSE A YEARS FIGURE at sort_order 10, ahead of the free
-- string comparison that would have rejected the job without parsing anything.
--
-- Same nine rules, same verdicts, strictly worse economics — which is why no test
-- would catch it. The cascade's cost ordering is a performance contract, not a
-- correctness one, and nothing asserts it.
--
-- THE UNDERLYING MISTAKE IS WORTH NAMING: someone replaced a hand-written list
-- with a loop, and THE LIST'S ORDER WAS THE DESIGN. `enum_range()` looks like a
-- tidier way to say "every rule" and quietly also says "in whatever order they
-- happen to be declared". The array below is therefore deliberately explicit and
-- deliberately NOT derived — if a rule is added to the enum and not to this list,
-- a missing seed is a visible absence, whereas a silently mis-ordered cascade is
-- not. Choosing the failure that is easy to see over the one that is easy to miss.
-- ============================================================================

create or replace function public.bootstrap_user_defaults()
returns void
language plpgsql
set search_path = ''
as $$
declare
  -- The caller's identity. Read once; every insert below is scoped to it.
  v_uid uuid := (select auth.uid());
  -- Loop variable for the cost-ordered rule array.
  v_rule public.filter_rule_type;
  -- Starts at 10 and steps by 10, leaving gaps so a rule can be inserted between
  -- two others later without renumbering the whole cascade.
  v_order smallint := 10;
  -- Twenty keys, matching the twenty Gemini API keys. Carried forward unchanged
  -- from 20260912001500 — this migration fixes the seed loop and touches nothing
  -- else that migration established.
  v_key_count constant smallint := 20;
begin
  -- Fail loudly on an anonymous call rather than seeding rows owned by nobody.
  -- 42501 is insufficient_privilege, which is what the client maps to a sign-in.
  if v_uid is null then
    raise exception 'bootstrap_user_defaults() requires an authenticated session'
      using errcode = '42501';
  end if;

  -- The kill switch and budget row. `claim_gemini_key()` reads its enabled flag
  -- from here and fails closed when the row is missing, so this row existing is
  -- what makes the pipeline able to run at all.
  insert into public.system_settings (user_id) values (v_uid)
    on conflict (user_id) do nothing;

  -- Search preferences, all defaulted at the column level.
  insert into public.search_preferences (user_id) values (v_uid)
    on conflict (user_id) do nothing;

  -- The key pool. Seeded rows carry `last_used_at` at its column default so an
  -- unused key sorts first under the LRU ordering `claim_gemini_key` applies —
  -- a seeded row is immediately usable rather than merely present.
  insert into public.gemini_key_state (user_id, key_index)
  select v_uid, i::smallint
    from pg_catalog.generate_series(1, v_key_count) as g(i)
    on conflict (user_id, key_index) do nothing;

  -- Every filter rule, enabled, IN COST ORDER. Seeding all nine means the settings
  -- page renders a complete cascade rather than a partial one, so turning a rule
  -- off is a toggle rather than a creation.
  --
  -- THE ORDER OF THIS ARRAY IS THE DESIGN, NOT AN ACCIDENT OF DECLARATION. Do not
  -- replace it with enum_range() — that is exactly what broke it, and the breakage
  -- is invisible to every test because the verdicts are identical and only the
  -- cost changes. Cheapest test first, so a job dies before anything expensive
  -- runs on it.
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
    -- `sort_order`, NOT `evaluation_order`. The latter has never existed on this
    -- table and is the 42703 this migration exists to repair.
    insert into public.filter_rules (user_id, rule_type, sort_order, config)
    values (
      v_uid,
      v_rule,
      v_order,
      -- RESTORED. The staleness rule carries the cold-start policy as an explicit
      -- setting rather than burying it in the Screener: a posting from a board
      -- whose posted_at we do not trust FAILS the freshness check rather than
      -- bypassing it. Seeding `{}` here is not a neutral default — it makes the
      -- flag read as NULL rather than false, which inverts the policy.
      case when v_rule = 'staleness'
        then '{"treat_unknown_posted_at_as_fresh": false}'::jsonb
        else '{}'::jsonb
      end
    )
    -- Idempotent: re-running the bootstrap must not disturb a user who has already
    -- tuned their cascade. NOTE this also means it will NOT repair an existing
    -- user's wrongly-ordered rows — see the backfill below, which does.
    on conflict (user_id, rule_type) do nothing;

    v_order := v_order + 10;
  end loop;
end;
$$;

comment on function public.bootstrap_user_defaults() is
  'Idempotently seeds one user''s defaults: system_settings, search_preferences, the filter cascade in COST order, and the Gemini key pool. Corrected 2026-09-17 — 20260912001500 inserted a non-existent `evaluation_order` column, which raised 42703 and rolled back all three seeded tables, and in the same change dropped the staleness cold-start config and replaced cost ordering with enum declaration order.';

-- ============================================================================
-- BACKFILL — the function fix alone repairs nobody who already exists.
-- ============================================================================
-- Two distinct populations were damaged, and they need different repairs:
--
--   A. Users bootstrapped AFTER 20260912001500 — the call raised, so they have NO
--      rows in any of the three tables. They need seeding from scratch.
--   B. Users bootstrapped BEFORE it — they have rows, correctly ordered. They must
--      not be disturbed.
--
-- The `on conflict do nothing` clauses make this safe for both: population B's
-- existing rows win every conflict and are left exactly as they are.
--
-- WHY THIS CANNOT REUSE THE FUNCTION ABOVE: `bootstrap_user_defaults()` reads
-- `auth.uid()`, which is NULL in a migration — there is no authenticated session
-- during a deploy. Calling it here would raise 42501 immediately. So the seeding
-- is restated against `auth.users` rather than invoked. That duplication is
-- deliberate and is the same trade-off 20260912001500 made for the key pool.
-- ============================================================================

-- Settings and preferences for anyone missing them, which after the 42703 is
-- every user created since it was applied.
insert into public.system_settings (user_id)
select u.id from auth.users u
on conflict (user_id) do nothing;

insert into public.search_preferences (user_id)
select u.id from auth.users u
on conflict (user_id) do nothing;

-- The filter cascade, in the same cost order and with the same staleness config as
-- the function. `with ordinality` is what carries the array's order into
-- sort_order — without it the ordering would again be whatever the planner chose,
-- which is the identical bug in a different shape.
insert into public.filter_rules (user_id, rule_type, sort_order, config)
select
  u.id,
  r.rule_type,
  (r.ord * 10)::smallint,
  case when r.rule_type = 'staleness'
    then '{"treat_unknown_posted_at_as_fresh": false}'::jsonb
    else '{}'::jsonb
  end
from auth.users u
cross join lateral (
  select t.rule_type, t.ord
    from unnest(array[
      'title_blocklist',
      'employment_type',
      'location_allowlist',
      'company_blocklist',
      'experience_ceiling',
      'degree_mismatch',
      'staleness',
      'already_applied',
      'per_company_weekly_cap'
    ]::public.filter_rule_type[]) with ordinality as t(rule_type, ord)
) r
on conflict (user_id, rule_type) do nothing;

-- The key pool, for the same reason and with the same guard.
insert into public.gemini_key_state (user_id, key_index)
select u.id, i::smallint
  from auth.users u
 cross join pg_catalog.generate_series(1, 20) as g(i)
on conflict (user_id, key_index) do nothing;

-- ============================================================================
-- DELIBERATELY NOT DONE HERE, so that the omission is a decision on the record
-- rather than an oversight:
--
-- 1. NO REPAIR OF EXISTING MIS-ORDERED ROWS. A user seeded by the broken function
--    between 20260912001500 and now would have rules in enum order — but that user
--    cannot exist, because the broken function raised before writing any rule.
--    Population A has no rows and is seeded correctly above; population B predates
--    the break and is already correct. An UPDATE forcing sort_order would
--    therefore repair nobody and would OVERWRITE any ordering a real user had
--    deliberately tuned on the settings page. Not worth the blast radius.
--
-- 2. NO SEEDING OF DEFAULT BLOCKED TITLES. Every rule's config other than
--    staleness seeds `{}`, while the frontend ships nine default blocked terms in
--    DEFAULT_FILTER_RULES (apps/web/src/features/settings/filtersStore.ts:19-70).
--    Whether the database should seed those nine or the UI should push them on
--    first save is a PRODUCT decision and is held for Teja. This migration fixes
--    plumbing and leaves policy alone. Note the contrast with the staleness config
--    above, which IS restored: that value was ruled once, written down, and lost by
--    accident — restoring it returns a decision already made, rather than making
--    a new one.
-- ============================================================================
