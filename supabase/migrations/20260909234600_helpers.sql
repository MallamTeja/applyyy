-- =============================================================================
-- applyy — 01: helper schema and shared trigger functions.
--
-- Two schemas, on purpose:
--   public          — anything PostgREST must expose. RPCs agents call live here.
--   applyy_internal — trigger functions and machinery. NOT exposed over the API,
--                     so the surface area an attacker can reach stays the RPCs we
--                     deliberately published rather than every function we wrote.
--
-- Every function below sets `search_path = ''` and schema-qualifies every reference.
-- That is not style: without it, a caller who can create objects in a schema earlier
-- on the search path can shadow `now()` or a table name and make the function do
-- something else. Empty search_path plus full qualification removes the trick.
-- =============================================================================

-- The private schema. Nothing here is reachable through the REST API.
create schema if not exists applyy_internal;

-- Deny the API roles any access to the private schema. Supabase grants usage on
-- `public` to anon/authenticated by default; it must not extend to this one.
revoke all on schema applyy_internal from public;

-- -----------------------------------------------------------------------------
-- Today's date IN US/PACIFIC.
--
-- THIS IS NOT A STYLE CHOICE AND MUST NOT BE "FIXED" TO current_date.
--
-- Gemini's requests-per-day quota resets at Pacific midnight. Teja is in IST. An
-- IST-dated counter would reset five and a half hours AFTER the quota it tracks, so
-- the daily-budget circuit breaker would open during precisely the window it exists
-- to protect — once a day, at night, which is the hardest possible failure to notice.
-- It would look like flaky quota, not like a bug.
--
-- STABLE, not IMMUTABLE: the answer changes with the clock, so Postgres must not
-- cache it across statements or index on it.
-- -----------------------------------------------------------------------------
create or replace function public.pacific_today()
returns date
language sql
stable
-- Empty search_path: the function names below are all fully qualified.
set search_path = ''
as $$
  -- `now()` is transaction-stable UTC; shifting it into the zone that owns the quota
  -- reset is the whole point of this function existing.
  select (now() at time zone 'America/Los_Angeles')::date;
$$;

-- Explain the function in the catalogue, so `\df+` tells the story too.
comment on function public.pacific_today() is
  'Today in US/Pacific. Gemini RPD resets at Pacific midnight; dating quota counters in IST would reset them 5.5h late, opening the circuit breaker during the window it guards.';

-- -----------------------------------------------------------------------------
-- Maintain `updated_at` on any table that has one.
--
-- A trigger rather than a default, because a default only fires on INSERT. Doing it
-- in application code means every one of five peers has to remember, and the one who
-- forgets produces a row whose timestamp lies.
-- -----------------------------------------------------------------------------
create or replace function applyy_internal.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  -- Stamp the row being written, whatever the caller supplied.
  new.updated_at := now();
  -- BEFORE triggers must return the row they want written.
  return new;
end;
$$;

-- -----------------------------------------------------------------------------
-- Refuse UPDATE and DELETE outright.
--
-- Attached to `master_profiles`, which is versioned and immutable, and to
-- `application_events`, which is an append-only audit log.
--
-- WHY BOTH A TRIGGER AND AN RLS POLICY: RLS is bypassed by the service-role key.
-- A policy that grants no UPDATE is a real control against the dashboard and the
-- Edge Functions, and no control at all against a worker holding a service key or
-- against a human in the SQL editor. A trigger applies to everyone, including the
-- table owner. Either alone is a false sense of safety; together they are honest.
-- -----------------------------------------------------------------------------
create or replace function applyy_internal.forbid_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  -- Name the table and the operation, because this error will be read by someone
  -- who did not know the rule existed and needs to be told what to do instead.
  raise exception
    '% is append-only: % is not permitted. Insert a new row instead.',
    tg_table_name, tg_op
    -- A distinct SQLSTATE so callers can distinguish "you broke a rule" from
    -- "the database is broken". 23514 is check_violation, which is what this is.
    using errcode = '23514';
  -- Unreachable; present so the function is well-formed if the raise is ever removed.
  return null;
end;
$$;

-- -----------------------------------------------------------------------------
-- Assign the next version number for a user's master profile.
--
-- Runs BEFORE INSERT so the caller never supplies a version and therefore can never
-- supply a wrong one. Two concurrent inserts can still compute the same number —
-- that race is caught by the UNIQUE(user_id, version) constraint, which is the
-- correct division of labour: the trigger provides convenience, the constraint
-- provides the guarantee.
-- -----------------------------------------------------------------------------
create or replace function applyy_internal.assign_master_profile_version()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  -- coalesce handles the first-ever profile, where max() over zero rows is NULL.
  select coalesce(max(mp.version), 0) + 1
    into new.version
    from public.master_profiles mp
   where mp.user_id = new.user_id;
  -- Hand the completed row back to the insert.
  return new;
end;
$$;
