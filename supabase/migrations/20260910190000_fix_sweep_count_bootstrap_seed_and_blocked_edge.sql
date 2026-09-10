-- ============================================================================
-- Corrective migration.
--
-- WHY THIS IS A NEW FILE RATHER THAN AN EDIT TO THE FILES IT CORRECTS:
-- Teja ran `supabase db push` at 18:45 IST on 2026-09-10, so
-- `supabase_migrations.schema_migrations` on the remote records all 7 earlier
-- migrations as APPLIED. Supabase will never re-read an applied file. Editing
-- `20260909235100_queue_and_pool_functions.sql` in place would therefore leave
-- the file saying one thing while the live database does another, and it would
-- do it SILENTLY, because nothing re-reads an applied migration. That is the
-- same shape as the CRLF bug: two artifacts disagreeing with no error anywhere.
--
-- `create or replace function` is used throughout so this file is the new
-- authority on both function bodies without dropping and recreating them —
-- a drop would take the grants and any dependent objects with it.
--
-- !! UNVERIFIED AGAINST A RUNNING POSTGRES !!
-- Docker Desktop was stopped and is not available, so unlike the 7 migrations
-- before it, THIS FILE HAS NEVER BEEN PARSED BY POSTGRES. That is precisely the
-- state this project spent 2026-09-10 escaping, and it must not be pushed until
-- it has been applied to a local `supabase db reset` at least once. The two
-- function bodies are the risk; the seed and the note updates are plain DML.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- FIX 1 — `sweep_stale_claims` counted the same rows twice.
--
-- THE BUG. The function returns two counts and the health page reads both. The
-- first statement moved a stale `applying` row to `needs_verification` but left
-- its lease in place (`claimed_by` still set, `claim_expires_at` still in the
-- past). The second statement then released anything with
-- `claimed_by is not null and claim_expires_at < now() and status <> 'applying'`
-- — and a row the first statement had just moved satisfies ALL THREE, because
-- moving it out of `status = 'applying'` is exactly what makes it match
-- `status <> 'applying'`. So every swept row was released a second time and
-- counted in `released_count` as well as in `needs_verification_count`.
--
-- The original comment claimed "the statement above already moved every stale
-- `applying` row out of this predicate". It had the logic backwards: the move
-- put them INTO the predicate, not out of it. Worth keeping as a caution — the
-- comment was confidently wrong in a way that made review harder, not easier.
--
-- Net behaviour was safe (the lease did get cleared, which is desirable), so
-- nothing was corrupted. But the two return values could not both be trusted,
-- and a health page that double-counts its own recovery actions is worse than
-- one that reports nothing, because it invites a diagnosis of the wrong problem.
--
-- THE FIX. Clear the lease in the FIRST statement, as part of the same update
-- that changes the status. That makes the two statements handle disjoint sets by
-- construction: after statement one, a swept row has `claimed_by is null` and so
-- cannot match statement two's predicate at all. The counts become disjoint
-- because the ROWS are disjoint, not because a predicate is carefully worded —
-- which is the difference between an invariant and a convention.
-- ----------------------------------------------------------------------------
create or replace function public.sweep_stale_claims()
returns table (released_count integer, needs_verification_count integer)
language plpgsql
-- Empty search_path: every reference below is schema-qualified, so no caller can
-- change what this function resolves by setting their own search_path.
set search_path = ''
as $$
declare
  -- Rows whose lease merely lapsed; status untouched, back into the queue.
  v_released integer;
  -- Rows that were mid-submit when the worker died; these need a human.
  v_needs_verification integer;
begin
  -- The sweeper is the acting agent for anything it moves. Transaction-scoped
  -- (the `true`), so it is re-established per call rather than assumed from
  -- session setup — a pool or a reconnect cannot silently drop it.
  perform pg_catalog.set_config('applyy.acting_agent', 'sweeper', true);

  -- THE DANGEROUS CASE FIRST, so that a crash part-way through this function
  -- cannot leave an `applying` row released back into the claimable queue by the
  -- statement below. A blind retry of a submit that may already have landed is
  -- how constraint #7 gets violated.
  with swept as (
    update public.applications a
       -- `applying -> needs_verification` is a real edge with `sweeper` in its
       -- allowed_agents, so the guard trigger permits this specific move.
       set status = 'needs_verification',
           -- THE FIX: release the lease in the SAME statement that moves the
           -- row. Without this the row keeps a stale lease, matches the second
           -- statement's predicate, and is counted twice. Clearing it here also
           -- means a human resolving the row is not looking at a lease held by
           -- a worker that no longer exists.
           claimed_at = null,
           claimed_by = null,
           claim_expires_at = null
     where a.status = 'applying'
       and a.claimed_by is not null
       and a.claim_expires_at < now()
    returning a.id
  )
  select count(*)::integer into v_needs_verification from swept;

  -- Everything else: the lease lapses, the status is untouched, the row becomes
  -- claimable again. No status change means the guard trigger short-circuits on
  -- its `new.status is not distinct from old.status` early return.
  with released as (
    update public.applications a
       set claimed_at = null,
           claimed_by = null,
           claim_expires_at = null
     where a.claimed_by is not null
       and a.claim_expires_at < now()
       -- Now genuinely belt-and-braces rather than load-bearing: the statement
       -- above nulls `claimed_by` on everything it touches, so those rows are
       -- already excluded by the line above this one. This clause survives
       -- someone reordering the two statements, which is the only scenario in
       -- which it still does work.
       and a.status <> 'applying'
    returning a.id
  )
  select count(*)::integer into v_released from released;

  -- Disjoint by construction now, so these two can be added, compared, or
  -- alerted on independently.
  return query select v_released, v_needs_verification;
end;
$$;

-- Records the defect in the database itself, where someone reading the function
-- will find it, rather than only in a migration nobody re-reads.
comment on function public.sweep_stale_claims() is
  'Recovers expired claim leases. Returns two DISJOINT counts: rows released back to the queue, and rows routed to needs_verification because they died mid-submit. Corrected 2026-09-10 — the original left the lease on swept rows, so they matched the release predicate and were counted twice.';


-- ----------------------------------------------------------------------------
-- FIX 2 — `bootstrap_user_defaults` never seeded the Gemini key pool.
--
-- THE BUG, and it is the silent stop §14 exists to prevent. Bootstrap inserted
-- `system_settings`, `search_preferences` and the 9 `filter_rules`, and nothing
-- else in the entire schema INSERTS into `gemini_key_state` — the only other
-- references are the two UPDATEs inside `claim_gemini_key` and
-- `report_gemini_result`, both of which need a row to already exist.
--
-- So on a freshly bootstrapped account the pool is empty, `claim_gemini_key()`
-- finds no candidate row and returns NULL, every LLM agent treats that as "no
-- key available" and releases its claim, and the pipeline looks MERELY IDLE.
-- No error, no failed run, nothing on the health page. This is the current state
-- of the remote project as of 18:45 IST.
--
-- WHY THE SIGNATURE IS UNCHANGED. It is tempting to add
-- `p_key_count smallint default 15`. Do not: in Postgres,
-- `bootstrap_user_defaults()` and `bootstrap_user_defaults(smallint default 15)`
-- are DIFFERENT functions, not a replacement — `create or replace` would leave
-- both in place and a bare `bootstrap_user_defaults()` call would then be
-- ambiguous or silently resolve to the old body. Pool size is changed through
-- the separate function below instead.
-- ----------------------------------------------------------------------------
create or replace function public.bootstrap_user_defaults()
returns void
language plpgsql
set search_path = ''
as $$
declare
  -- Refuse to run unauthenticated rather than writing rows owned by nobody.
  v_uid uuid := (select auth.uid());
  -- The cascade's evaluation order: cheapest, most-selective tests first. That
  -- ordering IS the economics — 400 discovered becomes ~40 scored, and the saving
  -- compounds across the Matcher, Tailor and Auditor.
  v_rule public.filter_rule_type;
  v_order smallint := 10;
  -- The number of API keys the worker is configured with, matching
  -- GEMINI_API_KEY_01..15 in the deployment environment. Deliberately a COUNT
  -- and never a key: constraint #11 keeps key material out of the database
  -- entirely, so this table holds only per-key STATE addressed by ordinal, and
  -- `key_index` maps to the Nth key in the environment.
  v_key_count constant smallint := 15;
begin
  if v_uid is null then
    raise exception 'bootstrap_user_defaults() requires an authenticated session'
      using errcode = '42501';
  end if;

  -- ON CONFLICT DO NOTHING throughout, so this is idempotent: calling it twice is
  -- harmless, which means the dashboard can call it on every load without a guard.
  insert into public.system_settings (user_id) values (v_uid)
    on conflict (user_id) do nothing;

  insert into public.search_preferences (user_id) values (v_uid)
    on conflict (user_id) do nothing;

  -- THE FIX. Seed the Gemini key pool, which the original body never did.
  -- Every column other than the two named takes its table default, and those
  -- defaults are exactly what makes a fresh row claimable: `enabled` true,
  -- `cooldown_until` null, `requests_today` 0, `quota_date` today in Pacific,
  -- and `last_used_at` '-infinity' so an unused key sorts FIRST under the LRU
  -- ordering `claim_gemini_key` uses. A seeded row is therefore immediately
  -- usable rather than merely present.
  insert into public.gemini_key_state (user_id, key_index)
  select v_uid, i::smallint
    from pg_catalog.generate_series(1, v_key_count) as g(i)
    on conflict (user_id, key_index) do nothing;

  -- Seed every filter rule, enabled, in cost order. Seeding them all means the
  -- settings page renders a complete cascade rather than a partial one, and turning a
  -- rule off is a toggle rather than a creation.
  --
  -- Reproduced verbatim from the original body, NOT refactored into a helper:
  -- `create or replace` replaces the WHOLE function body, so anything omitted
  -- here would be silently removed from the deployed function. An earlier draft
  -- of this migration replaced this loop with a call to a
  -- `seed_default_filter_rules()` helper THAT DOES NOT EXIST, which would have
  -- failed at call time with "function does not exist" — after the file had
  -- already been recorded as applied.
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
    insert into public.filter_rules (user_id, rule_type, sort_order, config)
    values (
      v_uid,
      v_rule,
      v_order,
      -- The staleness rule carries the cold-start policy as an explicit setting rather
      -- than burying it in the Screener: postings from an untrusted board FAIL the
      -- freshness check rather than bypassing it.
      case when v_rule = 'staleness'
        then '{"treat_unknown_posted_at_as_fresh": false}'::jsonb
        else '{}'::jsonb
      end
    )
    on conflict (user_id, rule_type) do nothing;

    v_order := v_order + 10;
  end loop;
end;
$$;

comment on function public.bootstrap_user_defaults() is
  'Idempotently seeds one user''s defaults: system_settings, search_preferences, the filter cascade, and the Gemini key pool. Corrected 2026-09-10 — the original never seeded gemini_key_state, so claim_gemini_key() returned NULL forever on a fresh account and the pipeline appeared merely idle.';


-- ----------------------------------------------------------------------------
-- Pool size is operational configuration, not a schema fact, so it gets its own
-- explicit and idempotent entry point rather than a parameter on bootstrap.
--
-- It only ever ADDS rows. Removing a key is deliberately not automated: setting
-- `enabled = false` preserves that key's quota and failure history, which is
-- information you want when deciding whether to bring it back, whereas a delete
-- destroys it. Shrinking the pool is therefore a manual, considered act.
-- ----------------------------------------------------------------------------
create or replace function public.set_gemini_key_pool_size(p_count smallint)
returns integer
language plpgsql
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  -- How many rows this call actually created, so a caller can tell "already
  -- correct" from "just fixed" — the distinction the silent-stop bug destroyed.
  v_added integer;
begin
  if v_uid is null then
    raise exception 'set_gemini_key_pool_size() requires an authenticated session'
      using errcode = '42501';
  end if;

  -- A zero or negative pool is not a configuration, it is the silent stop.
  -- Refuse it loudly rather than accepting a state in which nothing can run.
  if p_count is null or p_count < 1 then
    raise exception 'gemini key pool size must be at least 1, got %', p_count
      using errcode = '22023';
  end if;

  with added as (
    insert into public.gemini_key_state (user_id, key_index)
    select v_uid, i::smallint
      from pg_catalog.generate_series(1, p_count) as g(i)
      on conflict (user_id, key_index) do nothing
    returning 1
  )
  select count(*)::integer into v_added from added;

  return v_added;
end;
$$;

comment on function public.set_gemini_key_pool_size(smallint) is
  'Idempotently ensures at least p_count key-state rows exist for the current user. Returns how many were newly created, so an empty pool is distinguishable from an already-correct one. Never deletes: disable a key with enabled = false to preserve its quota and failure history.';


-- ----------------------------------------------------------------------------
-- FIX 3 — add the `approved -> blocked_needs_human` edge.
--
-- THE PROBLEM. `applying -> blocked_needs_human` was the only route into the
-- human queue, and there was no edge out of `approved` other than
-- `approved -> applying`. So a row that needs a human had to travel THROUGH
-- `applying`: two writes, `approved -> applying` then
-- `applying -> blocked_needs_human`.
--
-- A crash between those two writes leaves the row sitting at `applying`. The
-- sweeper then correctly routes it to `needs_verification`, and Teja
-- hand-verifies an application THAT WAS NEVER SUBMITTED — a spurious instance
-- of the single most expensive human task in the system, arriving with no
-- indication that it is spurious.
--
-- The handler is identical either way; only the explanation differs. Making the
-- edge direct removes the intermediate state a crash can be caught in, which is
-- the same reasoning as constraint #15: fewer reachable states beats more
-- careful handling of them.
--
-- NOTE FOR THE APPLIER: `applications_blocked_has_reason` is
-- `check (status <> 'blocked_needs_human' or block_reason is not null)`, so any
-- update onto this edge MUST set `block_reason` in the same statement. A
-- transition that sets only the status will be refused by the check constraint,
-- not by the transition guard — a different error from a different mechanism.
--
-- Constraint #15 is unaffected: this adds an edge OUT of `approved`, and
-- `approved -> applying` remains the only edge INTO `applying`.
-- ----------------------------------------------------------------------------
insert into public.application_status_transitions (from_status, to_status, allowed_agents, note)
values (
  'approved',
  'blocked_needs_human',
  -- `applier` only. The applier is what discovers a blocker, and a human moving
  -- an approved row to blocked by hand has no reason to: they would simply not
  -- approve it.
  array['applier']::public.agent_name[],
  'Applier hit a blocker on an approved row. Set block_reason in the SAME update — applications_blocked_has_reason requires it. Exists so a blocked row need not travel through `applying`: a crash between an approved->applying write and an applying->blocked write leaves the row at `applying`, the sweeper routes it to needs_verification, and a human then hand-verifies an application that was never submitted.'
)
-- Idempotent: if a later reseed adds this edge, applying this file again is a
-- no-op rather than a duplicate-key failure.
on conflict do nothing;


-- ----------------------------------------------------------------------------
-- FIX 4 — two `note` strings where the TypeScript mirror carried information
-- the SQL did not.
--
-- `applyyy-98` converged `status-flow.ts` onto this table, correctly, because
-- the frontend renders `application_status_transitions.note` and so the COLUMN
-- is the authority. But on two edges the TS text was better, and converging
-- would have discarded that information. Restored here so the authority and the
-- better wording are the same string. 98's parity test across all 44 notes will
-- go red on this and prompt a re-sync — that is the guard working, not churn.
-- ----------------------------------------------------------------------------

-- The `drop_reason` pointer is the actionable half: it tells a reader where to
-- look for WHY the human declined, which the original sentence did not.
update public.application_status_transitions
   set note = 'Human declined. drop_reason carries why; a human is the last filter in the cascade.'
 where from_status = 'awaiting_approval'
   and to_status = 'dropped_filter';

-- Says what actually changed, so a reader knows why re-running the Tailor would
-- produce anything different from what it produced the first time.
update public.application_status_transitions
   set note = 'Human edited the master or the selection and wants a re-tailor. HUMAN-ONLY: a re-tailor is a decision about truth, not a retry.'
 where from_status = 'audit_flagged'
   and to_status = 'tailored';
