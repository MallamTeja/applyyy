-- =============================================================================
-- Gap B2: a new signup gets its default rows, seeded by a trigger on auth.users.
--
-- WHY. public.bootstrap_user_defaults() seeds system_settings, search_preferences,
-- gemini_key_state and the cost-ordered filter cascade, but NOTHING calls it (recon
-- 2026-10-08: no .rpc( caller in supabase/, apps/ or worker/, and no trigger on
-- auth.users). The two existing users were seeded by hand, so a third signup would get
-- no rows. claim_gemini_key() fails closed without a system_settings row, which means
-- the pipeline simply cannot run for that user, and nothing reports why.
--
-- WHY NOT JUST CALL THE EXISTING FUNCTION FROM THE TRIGGER. It reads auth.uid(), which
-- is NULL inside a trigger on auth.users (the inserting session is GoTrue's, not the new
-- user's), so it would raise 42501 and abort the signup. It is also SECURITY INVOKER,
-- and the trigger runs as supabase_auth_admin, which has no INSERT on any of the four
-- tables and no BYPASSRLS (live pg_roles 2026-10-08). All four tables are FORCE RLS
-- with `auth.uid() = user_id` policies for `authenticated` only.
--
-- THE SHAPE: ONE seed body, three thin callers.
--   applyy_internal.seed_user_defaults(p_user_id)  holds the body. EXECUTE is granted to
--       NO ONE (only its owner, postgres, can run it), so no client can supply an id.
--   public.bootstrap_user_defaults()  becomes a wrapper passing auth.uid(). It is now
--       SECURITY DEFINER because its caller has no EXECUTE on the private body.
--   applyy_internal.seed_defaults_on_signup()  is the trigger function, passing NEW.id.
-- The body was already restated once (the backfill in 20260917124500, deliberately,
-- because auth.uid() is NULL in a migration). A third copy here would be a third place
-- for the cost-ordered rule list to drift, and that list has been broken twice already.
--
-- RLS: the definer functions run as postgres, which has BYPASSRLS (live pg_roles
-- 2026-10-08). BYPASSRLS overrides FORCE RLS, so the inserts pass. That is safe only
-- because the id is never caller-supplied: auth.uid() in the wrapper, NEW.id in the
-- trigger.
--
-- A SIGNUP IS NEVER BLOCKED. The trigger catches every error and raises a WARNING. A
-- user with missing defaults can be repaired by calling bootstrap_user_defaults() once
-- signed in, since it is idempotent. A user who could not sign up cannot be repaired.
--
-- Re-runnable: CREATE OR REPLACE for the functions, and a create-if-absent guard for the
-- trigger. DROP TRIGGER IF EXISTS can't be used: it needs ownership of auth.users,
-- which postgres lacks (see the trigger block at the end).
-- WRITTEN, NOT APPLIED. Must run after 20260917124500, the body copied below.
-- =============================================================================

-- The single seed body, keyed by an explicit user id. In applyy_internal because that
-- schema is not exposed through PostgREST (config.toml schemas = ["public"]), so it
-- has no RPC endpoint at all. INVOKER on purpose: every caller is a postgres-owned
-- definer function, and if a grant ever leaked, RLS would still bind the leaker
-- (except service_role, which bypasses RLS; it is revoked below for that reason).
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
  -- This migration moves the body and changes no seeded value.
  v_key_count constant smallint := 20;
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
  -- key sorts first under claim_gemini_key's LRU ordering. A seeded row is usable at once.
  insert into public.gemini_key_state (user_id, key_index)
  -- One row per key index, 1..v_key_count.
  select p_user_id, i::smallint
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

-- No client may supply an id. Revoke from every role the platform grants by default;
-- only the owner (postgres) keeps EXECUTE, and both callers below are postgres-owned.
revoke all on function applyy_internal.seed_user_defaults(uuid)
  from public, anon, authenticated, service_role;

-- Tells the next reader why this function has no grants and must never get one.
comment on function applyy_internal.seed_user_defaults(uuid) is
  'The one copy of the per-user default seed (settings, preferences, Gemini key pool, cost-ordered filter cascade). Idempotent. Takes an explicit id, so it is executable by its owner ONLY: callers are bootstrap_user_defaults() (passes auth.uid()) and the on-signup trigger (passes NEW.id). Never grant EXECUTE: a granted caller could seed rows for any user.';

-- The public entry point keeps its name, signature and behaviour (seed the CALLER),
-- now delegating to the single body above. Same signature, so this replaces in place.
create or replace function public.bootstrap_user_defaults()
returns void
language plpgsql
-- DEFINER because its callers have no EXECUTE on the private body. Safe: the id is
-- read from the session, never taken as an argument, so a caller can only seed itself.
security definer
-- Empty search_path, as every definer function in this repo has.
set search_path = ''
as $$
declare
  -- The caller's identity. Read once and passed through.
  v_uid uuid := (select auth.uid());
begin
  -- Unchanged contract: an anonymous call fails loudly rather than seeding nobody.
  if v_uid is null then
    -- Same message and errcode as before, so the client's sign-in mapping still holds.
    raise exception 'bootstrap_user_defaults() requires an authenticated session'
      using errcode = '42501';
  end if;

  -- The body, for the caller only.
  perform applyy_internal.seed_user_defaults(v_uid);
end;
$$;

-- anon held EXECUTE (live proacl 2026-10-08). It could only ever hit the 42501 above,
-- but a definer function should not be reachable without a session. Drop it.
revoke all on function public.bootstrap_user_defaults() from public, anon;
-- A signed-in user may (re)seed their own defaults; that's the repair path for a
-- signup whose trigger seed failed with a warning.
grant execute on function public.bootstrap_user_defaults() to authenticated, service_role;

-- The comment now records where the body lives and that it is a definer function.
comment on function public.bootstrap_user_defaults() is
  'Idempotently seeds the CALLER''s defaults by delegating to applyy_internal.seed_user_defaults(auth.uid()). SECURITY DEFINER since 20261008180000 (the body is not executable by clients). New signups are seeded automatically by the on_auth_user_created_seed_defaults trigger; calling this is the repair path.';

-- The trigger function. The id comes from NEW.id, the row just inserted, and nowhere else.
create or replace function applyy_internal.seed_defaults_on_signup()
returns trigger
language plpgsql
-- DEFINER: the trigger fires as supabase_auth_admin, which cannot write these tables.
-- Running as postgres (BYPASSRLS) is what lets the seed land.
security definer
-- Empty search_path; every name below is schema-qualified.
set search_path = ''
as $$
begin
  -- A nested block so a failure rolls back only the seed (a savepoint), never the signup.
  -- Ceiling: `when others` does not catch QUERY_CANCELED (57014: statement_timeout or a
  -- cancel) or ASSERT_FAILURE. A 31-row seed (1+1+20 keys+9 rules) against a 2-minute timeout makes that
  -- practically unreachable.
  begin
    -- Seed exactly the user being created.
    perform applyy_internal.seed_user_defaults(new.id);
  exception when others then
    -- NEVER block a signup over defaults. Warn with the id and the cause, so the
    -- Postgres logs (Logs Explorer → postgres; GoTrue does not surface warnings) show
    -- who needs a bootstrap_user_defaults() repair.
    raise warning 'seed_defaults_on_signup: defaults not seeded for user % (% %)',
      new.id, sqlstate, sqlerrm;
  end;
  -- Ignored for an AFTER trigger. Returned anyway, as the conventional value.
  return new;
end;
$$;

-- A trigger function needs no client EXECUTE. Postgres checks EXECUTE when the trigger
-- is created (as postgres), not when it fires. Revoke so nothing else can reference it.
revoke all on function applyy_internal.seed_defaults_on_signup()
  from public, anon, authenticated, service_role;

-- CREATE-IF-ABSENT, not DROP + CREATE. auth.users is owned by supabase_auth_admin and
-- postgres is not a member (live 2026-10-08). postgres holds TRIGGER, which is enough
-- to CREATE a trigger, but DROP TRIGGER needs ownership. So `drop trigger if exists`
-- passes on the first run (nothing to drop) and fails 42501 on every re-run. A guarded
-- create is re-runnable instead. CONSEQUENCE: no later migration can drop or disable
-- this trigger. That takes the dashboard or supabase_auth_admin. Changing what it DOES
-- needs no drop, only a CREATE OR REPLACE of the functions above.
do $$
begin
  -- Look the trigger up by name on auth.users. A second run finds it and does nothing.
  if not exists (
    select 1 from pg_catalog.pg_trigger
     where tgrelid = 'auth.users'::pg_catalog.regclass
       and tgname = 'on_auth_user_created_seed_defaults'
  ) then
    -- AFTER INSERT, so the auth.users row exists when the seed's foreign keys check it
    -- (all four tables reference auth.users(id)). FOR EACH ROW, so a bulk insert seeds
    -- every new user.
    create trigger on_auth_user_created_seed_defaults
      after insert on auth.users
      for each row execute function applyy_internal.seed_defaults_on_signup();
  end if;
end;
$$;
