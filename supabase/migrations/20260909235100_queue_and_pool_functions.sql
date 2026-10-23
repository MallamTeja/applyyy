-- =============================================================================
-- applyy — 06: the RPCs every agent calls.
--
--   claim_applications        take work, with a lease
--   advance_application_status move a row, legally, and release the lease
--   release_application_claim  give work back untouched (quota exhaustion)
--   sweep_stale_claims         reclaim after a crash; route `applying` to a human
--   claim_gemini_key           LRU key selection, atomically
--   report_gemini_result       close the loop after every LLM call
--   bootstrap_user_defaults    create the rows without which nothing runs
--
-- ALL OF THESE ARE `security invoker` (the default), NOT `security definer`.
-- That is deliberate: they must run with the caller's RLS in force, so an agent can
-- only ever claim and move its OWN user's rows. A definer function here would be a
-- privilege-escalation surface reachable over the REST API — every caller would act
-- as the owner and RLS would stop meaning anything. The only definer functions in
-- this schema are the two triggers, which need to read the rules table regardless of
-- the caller's role and are not reachable from the API at all.
--
-- Every one sets `search_path = ''` and qualifies every name. `pg_catalog` is always
-- implicitly searched, so `now()` and `coalesce()` resolve without qualification.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- CLAIM WORK.
--
-- The pattern is database-as-queue with `FOR UPDATE SKIP LOCKED`: two agents running
-- concurrently take DIFFERENT rows instead of blocking on each other or, worse, both
-- processing the same row. Postgres does the concurrency control that a message broker
-- would otherwise be dragged in to provide.
--
-- CLAIMING DOES NOT CHANGE `status`. It sets a lease. That single decision is why the
-- status graph needs no backward edge FOR AGENT ROLLBACK: a row being worked on has not
-- moved, so an agent that gives up has nothing to undo. (Narrowed 2026-09-10 — the
-- graph does have seven backward edges, but they are human correction paths and six of
-- the seven are human-only.)
--
-- RETURNS ZERO ROWS WHEN THE KILL SWITCH IS OFF. The check lives here, not in the
-- agents, so an agent that forgets to check it still cannot get work. Safety that
-- depends on nine callers remembering is not safety.
-- -----------------------------------------------------------------------------
create or replace function public.claim_applications(
  p_status public.application_status,
  p_claimed_by text,
  p_limit integer,
  -- NULL means "use the user's configured lease", so the common caller passes three args.
  p_lease_seconds integer default null
)
returns setof public.applications
language plpgsql
set search_path = ''
as $$
declare
  -- Resolved once; every predicate below is scoped to this user by RLS anyway, but
  -- naming it keeps the intent visible.
  v_uid uuid := (select auth.uid());
  v_enabled boolean;
  v_lease integer;
begin
  -- Read the control panel first, exactly as every agent is supposed to.
  select s.system_enabled, coalesce(p_lease_seconds, s.claim_lease_seconds)
    into v_enabled, v_lease
    from public.system_settings s
   where s.user_id = v_uid;

  -- No settings row at all means the account was never bootstrapped. FAIL CLOSED:
  -- a missing kill switch must read as "off", never as "no objection".
  if v_enabled is null or not v_enabled then
    return;
  end if;

  return query
  update public.applications a
     set claimed_at = now(),
         claimed_by = p_claimed_by,
         -- The lease, not the claim time, is what the sweeper compares against — so a
         -- slow agent can be given a longer lease without touching the sweeper.
         claim_expires_at = now() + make_interval(secs => v_lease)
   where a.id in (
     -- The inner select is what takes the locks. SKIP LOCKED makes a row another
     -- transaction already grabbed invisible to this one rather than a wait.
     select c.id
       from public.applications c
      where c.user_id = v_uid
        and c.status = p_status
        -- Unclaimed only. Matches the partial index applications_claimable_idx.
        and c.claimed_by is null
      -- FIFO. Oldest discovery first, which is also what the freshness argument wants.
      order by c.created_at
        for update skip locked
      limit p_limit
   )
  returning a.*;
end;
$$;

comment on function public.claim_applications(public.application_status, text, integer, integer) is
  'Lease-based claim with FOR UPDATE SKIP LOCKED. Returns zero rows when system_enabled is false — the kill switch is checked here so no agent can forget it. Does not change status.';

-- -----------------------------------------------------------------------------
-- MOVE A ROW.
--
-- One transaction does all four things: declare the actor, change the status (which
-- the guard trigger validates and the log trigger witnesses), release the lease, and
-- record any extra context.
--
-- USE THIS RATHER THAN A BARE UPDATE. A bare `.update({status})` passes the guard but
-- leaves claimed_by set, so the row is stranded until the sweeper notices — a bug that
-- looks like "the pipeline is slow" rather than like a bug.
-- -----------------------------------------------------------------------------
create or replace function public.advance_application_status(
  p_application_id uuid,
  p_to_status public.application_status,
  p_agent public.agent_name,
  p_detail jsonb default '{}'::jsonb
)
returns public.applications
language plpgsql
set search_path = ''
as $$
declare
  v_row public.applications;
begin
  -- Declare who is acting. The third argument `true` scopes this to the current
  -- TRANSACTION, so it cannot leak into the next statement on a pooled connection —
  -- which, with PgBouncer in front of Supabase, is not a theoretical concern.
  perform pg_catalog.set_config('applyy.acting_agent', p_agent::text, true);

  update public.applications a
     set status = p_to_status,
         -- Release the lease in the same statement that moves the row. Two statements
         -- could be interrupted between them; one cannot.
         claimed_at = null,
         claimed_by = null,
         claim_expires_at = null
   where a.id = p_application_id
  returning a.* into v_row;

  -- RLS makes another user's row invisible rather than forbidden, so "not found" is
  -- the same answer for "no such row" and "not yours". Both are equally not-your-row.
  if v_row.id is null then
    raise exception 'application % not found (or not yours)', p_application_id
      using errcode = 'P0002';
  end if;

  -- Extra context rides on its own event rather than being crammed into the
  -- status_change row the trigger writes, so the two are separable when reading back.
  if p_detail is not null and p_detail <> '{}'::jsonb then
    insert into public.application_events (user_id, application_id, event_type, agent, detail)
    values (v_row.user_id, v_row.id, 'note', p_agent, p_detail);
  end if;

  return v_row;
end;
$$;

comment on function public.advance_application_status(uuid, public.application_status, public.agent_name, jsonb) is
  'The only correct way to change status. Validates the edge, witnesses it, and releases the lease in one transaction.';

-- -----------------------------------------------------------------------------
-- GIVE WORK BACK, UNTOUCHED.
--
-- THIS IS THE QUOTA-EXHAUSTION PATH, and it is the whole reason section 6's "return
-- the row to its prior status" needs no backward edge. The row never left its status;
-- only the lease is dropped. Next run picks it up. Nothing fails, nothing is lost.
--
-- Quota exhaustion is not an error.
-- -----------------------------------------------------------------------------
create or replace function public.release_application_claim(
  p_application_id uuid,
  p_agent public.agent_name,
  -- e.g. 'all_keys_cooling'. Free text because the reasons are open-ended and none of
  -- them changes what happens next.
  p_reason text default null
)
returns void
language plpgsql
set search_path = ''
as $$
declare
  v_user_id uuid;
begin
  update public.applications a
     set claimed_at = null,
         claimed_by = null,
         claim_expires_at = null
   where a.id = p_application_id
     -- No status assignment anywhere in this statement. That is the point of the
     -- function: releasing must be incapable of moving a row.
  returning a.user_id into v_user_id;

  if v_user_id is null then
    raise exception 'application % not found (or not yours)', p_application_id
      using errcode = 'P0002';
  end if;

  -- Log it, so "why did this sit for an hour" has an answer on the health page.
  insert into public.application_events (user_id, application_id, event_type, agent, detail)
  values (v_user_id, p_application_id, 'release', p_agent, jsonb_build_object('reason', p_reason));
end;
$$;

-- -----------------------------------------------------------------------------
-- THE SWEEPER. Run at the top of every agent tick — it is cheap and it turns a
-- crashed agent into a self-healing one instead of permanently stranded work.
--
-- TWO DIFFERENT BEHAVIOURS, AND THE DIFFERENCE IS THE MOST SAFETY-CRITICAL LINE IN
-- THIS FILE:
--
--   any status except `applying` → just drop the lease. The agent died before doing
--                                  anything irreversible, so retrying is free.
--
--   `applying`                   → route to `needs_verification`. NEVER back to the
--                                  queue. The worker marks applying, submits, marks
--                                  applied; a crash in that window leaves a row whose
--                                  real-world outcome is UNKNOWN. An unknown submit is
--                                  not a retryable submit. Retrying blind is how you
--                                  send two applications and violate constraint 7.
-- -----------------------------------------------------------------------------
create or replace function public.sweep_stale_claims()
returns table (released_count integer, needs_verification_count integer)
language plpgsql
set search_path = ''
as $$
declare
  v_released integer;
  v_needs_verification integer;
begin
  -- The sweeper is the actor for anything it moves.
  perform pg_catalog.set_config('applyy.acting_agent', 'sweeper', true);

  -- The dangerous case FIRST, so a crash midway through this function cannot leave
  -- an `applying` row released back into the queue by the statement below.
  with swept as (
    update public.applications a
       set status = 'needs_verification'
     where a.status = 'applying'
       and a.claimed_by is not null
       and a.claim_expires_at < now()
    returning a.id
  )
  select count(*)::integer into v_needs_verification from swept;

  -- Everything else: the lease lapses, the status is untouched, the row becomes
  -- claimable again. No status change means the guard trigger short-circuits.
  with released as (
    update public.applications a
       set claimed_at = null,
           claimed_by = null,
           claim_expires_at = null
     where a.claimed_by is not null
       and a.claim_expires_at < now()
       -- CORRECTED 2026-10-23 (defect #1, docs/PROGRESS.md). This previously read
       -- "the statement above already moved every stale `applying` row out of this
       -- predicate" — backwards: that statement set only `status` and left the lease,
       -- so it moved those rows INTO this predicate and they were double-counted in
       -- released_count. Behaviour was fixed in 20260910190000 (and the live body is
       -- 20261009130000, which clears the lease in the first statement); the text here
       -- is corrected in place because a comment never reached Postgres — the narrow
       -- exception recorded in docs/audit/2026-09-10-schema-invariants-verified.md.
       and a.status <> 'applying'
    returning a.id
  )
  select count(*)::integer into v_released from released;

  return query select v_released, v_needs_verification;
end;
$$;

comment on function public.sweep_stale_claims() is
  'Reclaims expired leases. A stale `applying` row goes to needs_verification, NEVER back to the queue — retrying an unknown submit is how you apply twice.';

-- -----------------------------------------------------------------------------
-- CLAIM A GEMINI KEY. One atomic UPDATE ... RETURNING.
--
-- LEAST-RECENTLY-USED, NOT ROUND-ROBIN. An in-memory cursor cannot work here: Edge
-- Functions are stateless isolates, so every invocation would start at key 1, hammer
-- it, and make six keys behave like one — while looking perfectly healthy in review.
-- LRU also self-balances when calls have uneven cost, which round-robin does not.
--
-- RETURNS NULL when no key is available. THAT IS NOT AN ERROR. Release the claim on
-- your application row and let the next run pick it up.
--
-- NOTE WHAT IS NOT HERE: any hardcoded quota number. `requests_today` is incremented
-- for observability and never compared against anything. The only gate is the user's
-- own `gemini_daily_call_budget`, because Google no longer publishes free-tier limits
-- and any constant would break silently the day they change them.
-- -----------------------------------------------------------------------------
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
  -- PACIFIC, not IST, not current_date. Gemini's RPD resets at Pacific midnight; an
  -- IST-dated counter would reset 5.5 hours late and open the circuit breaker during
  -- exactly the window it exists to protect. See public.pacific_today().
  v_today date := public.pacific_today();
begin
  -- Kill switch and budget in one read. `for update` serialises concurrent claims
  -- against the counter, so two isolates cannot both see 199 and both spend the 200th.
  select s.system_enabled,
         s.gemini_daily_call_budget,
         -- Self-resetting counter: a stale date reads as zero rather than needing a cron.
         case when s.gemini_budget_date = v_today then s.gemini_calls_today else 0 end
    into v_enabled, v_budget, v_calls
    from public.system_settings s
   where s.user_id = v_uid
     for update;

  -- Fail closed on a missing settings row, same as claim_applications.
  if v_enabled is null or not v_enabled then
    return null;
  end if;

  -- THE CIRCUIT BREAKER. NULL budget means uncapped, which is why this is an explicit
  -- null check rather than a comparison against a default.
  if v_budget is not null and v_calls >= v_budget then
    return null;
  end if;

  update public.gemini_key_state g
     set last_used_at = now(),
         quota_date = v_today,
         -- Observability only. Rolls over by date rather than by a scheduled reset.
         requests_today = case when g.quota_date = v_today then g.requests_today + 1 else 1 end
   where (g.user_id, g.key_index) = (
     select k.user_id, k.key_index
       from public.gemini_key_state k
      where k.user_id = v_uid
        and k.enabled
        -- Cooling keys are ineligible. cooldown_until came from the server's own
        -- retry_after — believe it rather than inventing a backoff.
        and (k.cooldown_until is null or k.cooldown_until <= now())
      -- THE LRU ORDER. Matches gemini_key_state_lru_idx.
      order by k.last_used_at
        for update skip locked
      limit 1
   )
  returning g.key_index into v_key;

  -- Every key cooling. Not an error — the caller releases its row and moves on.
  if v_key is null then
    return null;
  end if;

  -- Only charge the budget once a key was actually handed out.
  update public.system_settings s
     set gemini_calls_today = v_calls + 1,
         gemini_budget_date = v_today
   where s.user_id = v_uid;

  return v_key;
end;
$$;

comment on function public.claim_gemini_key() is
  'Atomic LRU key claim. NULL means no key available (all cooling, or budget spent) and is NOT an error. No hardcoded quota anywhere; requests_today is observability only.';

-- -----------------------------------------------------------------------------
-- CLOSE THE LOOP after every call. The pool is REACTIVE — it learns its capacity from
-- what the API actually says rather than from a number we guessed.
-- -----------------------------------------------------------------------------
create or replace function public.report_gemini_result(
  p_key_index smallint,
  p_success boolean,
  -- Straight from the 429's retry_after. NULL for a non-quota failure.
  p_retry_after_seconds integer default null,
  p_error text default null
)
returns void
language plpgsql
set search_path = ''
as $$
begin
  update public.gemini_key_state g
     set -- A success clears the failure streak; that is what makes the streak mean
         -- "currently broken" rather than "has ever failed".
         consecutive_failures = case when p_success then 0 else g.consecutive_failures + 1 end,
         -- Believe the server's retry_after. Only set a cooldown when one was given —
         -- a non-quota failure should not idle a working key.
         cooldown_until = case
           when p_retry_after_seconds is not null then now() + make_interval(secs => p_retry_after_seconds)
           else g.cooldown_until
         end,
         last_error = case when p_success then null else p_error end
   where g.user_id = (select auth.uid())
     and g.key_index = p_key_index;
end;
$$;

-- -----------------------------------------------------------------------------
-- BOOTSTRAP. Create the rows without which every other function fails closed.
--
-- This exists because "fail closed" and "silently does nothing" look identical from
-- the outside. A fresh account with no system_settings row would have every agent
-- returning zero work with no error, which is exactly the silent stop section 14
-- warns about. Call this once per user, from the dashboard, and the state is explicit.
--
-- Note the defaults it relies on: system_enabled FALSE and dry_run TRUE come from the
-- column definitions, so a bootstrapped account still cannot submit anything until a
-- human turns it on twice.
-- -----------------------------------------------------------------------------
create or replace function public.bootstrap_user_defaults()
returns void
language plpgsql
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  -- The cascade's evaluation order: cheapest, most-selective tests first. That
  -- ordering IS the economics — 400 discovered becomes ~40 scored, and the saving
  -- compounds across the Matcher, Tailor and Auditor.
  v_rule public.filter_rule_type;
  v_order smallint := 10;
begin
  -- Refuse to run unauthenticated rather than writing rows owned by nobody.
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

  -- Seed every filter rule, enabled, in cost order. Seeding them all means the
  -- settings page renders a complete cascade rather than a partial one, and turning a
  -- rule off is a toggle rather than a creation.
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
  'Idempotent. Creates system_settings, search_preferences and the full filter cascade in cost order. Without these rows every agent fails closed and looks merely idle.';
