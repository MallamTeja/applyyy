-- =============================================================================
-- 20261009130000 — sweep_stale_claims() requires the agent key, like every other
-- function that lets a caller act as a machine agent.
--
-- WHY THIS EXISTS — THE SWEEPER HOLE. 20261008160000 and 20261008170000 gated
-- advance_application_status, claim_applications and release_application_claim on
-- applyy_internal.agent_key_state(), because every client (browser, edge functions,
-- worker) signs in as the SAME app user, so the JWT cannot tell the browser from an
-- agent; only the x-applyy-agent-key header can. sweep_stale_claims() was missed:
-- it sets applyy.acting_agent = 'sweeper' itself and never asked for the key, and
-- `authenticated` holds EXECUTE on it. So even after the key is seeded, a browser
-- session could still act as the `sweeper` machine agent (moving stale `applying`
-- rows to needs_verification and releasing lapsed leases) with no proof at all.
-- Found by live recon on 2026-10-09 (pg_proc.prosrc showed no agent_key_state call).
--
-- WHY IT IS SAFE IN BOTH KEY STATES:
--   * Key EMPTY (today): agent_key_state() returns 'unconfigured', the gate only
--     raises a WARNING, and the function behaves exactly as before.
--   * Key SEEDED: the only caller, the worker gateway (worker/src/supabase-gateway.ts:143),
--     sends the header (worker/src/cli/apply.ts:79, worker/src/cli/assist.ts:101), so it
--     passes. The browser never calls this function, so nothing legitimate is refused.
-- Enforcement now turns on for all FOUR functions at once when the hash is seeded;
-- deleting the row turns it off for all four.
--
-- WHAT CHANGES: one new local (v_key_state) and the gate block at the top of the body,
-- both marked NEW-SWEEPGUARD. Everything else is BYTE-FOR-BYTE the live prosrc as of
-- 2026-10-09 (md5 9ae6fa0784679924af9bd50602f1822b, 4632 chars), which is identical
-- to the body in 20261004200000_fix_phase3_regressions.sql:91-175. Do not "tidy" it.
--
-- WHAT DOES NOT CHANGE: signature, return table, security invoker, search_path = '',
-- owner, comment and grants. CREATE OR REPLACE with an identical signature and return
-- type keeps the existing ACL, owner and comment, so no grant/revoke is issued here.
-- Expected post-state ACL (unchanged):
--   {postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}  (no anon)
--
-- PRE-CHECK (read-only; expect gate_present = false and the ACL above):
--   select position('agent_key_state' in p.prosrc) > 0 as gate_present,
--          md5(p.prosrc) = '9ae6fa0784679924af9bd50602f1822b' as body_is_expected,
--          p.proacl::text, p.prosecdef, p.proconfig
--     from pg_proc p where p.oid = 'public.sweep_stale_claims()'::regprocedure;
-- POST-CHECK (read-only; expect gate_present = true, the same ACL, prosecdef = false,
-- proconfig = {search_path=""}):
--   the same query.
--
-- Must run after 20261008160000, which creates applyy_internal.agent_key_state().
-- WRITTEN, NOT APPLIED.
-- =============================================================================

-- Replace, not drop: same signature and return table, so the grants, owner and
-- comment survive (a drop would take them with it, as 20261004200000 notes).
create or replace function public.sweep_stale_claims()
-- Unchanged return shape; the adapters unpack it as a one-row array.
returns table (released_count integer, needs_verification_count integer)
-- Unchanged: plpgsql for the two sequential statements and the locals.
language plpgsql
-- Unchanged: INVOKER, so RLS on applications scopes the sweep to the caller's rows.
security invoker
-- Unchanged: empty search_path, every reference below is schema-qualified.
set search_path = ''
as $$
declare
  -- Rows whose lease merely lapsed; status untouched, back into the queue.
  v_released integer;
  -- Rows that were mid-submit when the worker died; these need a human.
  v_needs_verification integer;
  -- NEW-SWEEPGUARD: whether this request proved it is a machine agent (see the file header).
  v_key_state text;
begin
  -- NEW-SWEEPGUARD — only a proven machine may act as `sweeper` (see the file header).
  -- Checked first, before the acting agent is declared and before any row is touched.
  v_key_state := applyy_internal.agent_key_state();
  -- No hash seeded yet: enforcement OFF, today's behaviour, with a visible warning.
  if v_key_state = 'unconfigured' then
    -- WARNING, not exception: keeps working until applyy_internal.agent_key is seeded.
    raise warning 'agent key not configured: sweep_stale_claims called without proof (enforcement off until applyy_internal.agent_key is seeded)';
  -- Seeded, and this request did not carry the matching key: refuse.
  elsif v_key_state <> 'valid' then
    -- 42501, the same code advance_application_status and the claim functions use for the same refusal.
    raise exception 'sweep_stale_claims requires a valid x-applyy-agent-key header (%); a browser session may only act as human', v_key_state
      using errcode = '42501';
  end if;

  -- THE LINE THE PHASE-3 VERSION LOST. The status guard refuses any status change
  -- with no declared actor (42501), and `applying -> needs_verification` allows
  -- only 'sweeper' and 'human' (status_transition_guard.sql:138). Transaction-
  -- scoped (the `true`) so a pooled connection cannot carry it into another call.
  perform pg_catalog.set_config('applyy.acting_agent', 'sweeper', true);

  -- THE DANGEROUS CASE FIRST, so that a crash part-way through cannot leave an
  -- `applying` row released back into the claimable queue by the statement below.
  -- A blind retry of a submit that may already have landed violates constraint #7.
  with swept as (
    -- Updates only rows RLS lets this caller see — that is the tenant scope.
    update public.applications a
       -- A real edge with `sweeper` in allowed_agents, so the guard permits it.
       set status = 'needs_verification',
           -- Release the WHOLE lease in the same statement that moves the row, so
           -- it cannot match the release predicate below and be counted twice.
           -- `claimed_at` included: the phase-3 version forgot it.
           claimed_at = null,
           -- No worker holds this row any more; a human resolves it.
           claimed_by = null,
           -- Lease gone, so its expiry goes too.
           claim_expires_at = null
      -- The owner's lease length. Read per row so each tenant's own setting
      -- applies; RLS limits the join to the caller's own settings row anyway.
      from public.system_settings s
     -- One settings row per user (system_settings.user_id is its primary key).
     where s.user_id = a.user_id
       -- Only rows that died mid-submit.
       and a.status = 'applying'
       -- NOT `claimed_by is not null`: advance_application_status() clears the
       -- lease on approved -> applying, so an `applying` row has no claimed_by and
       -- the old predicate matched nothing, ever. `status_changed_at` is stamped by
       -- the guard trigger (status_transition_guard.sql:251) on entry to
       -- `applying`, so its age IS the age of the submit attempt.
       -- Timeout = the user's claim_lease_seconds (core_tables.sql:73, default
       -- 900s): the same budget the system already grants one unit of agent work.
       -- The applying window is one page.submit() (apply-one.ts:428-447), far
       -- shorter than that, so a row older than one lease is dead, not slow.
       -- ponytail: reuses the claim lease as the submit timeout; add a dedicated
       -- `applying_timeout_seconds` setting if a submit ever legitimately runs longer.
       and a.status_changed_at < pg_catalog.now() - pg_catalog.make_interval(secs => s.claim_lease_seconds)
       -- Respect a live lease if something did re-claim the row, so the sweep
       -- never yanks a row out from under a worker still holding it.
       and (a.claim_expires_at is null or a.claim_expires_at < pg_catalog.now())
    -- Return ids so the count below is of rows really moved.
    returning a.id
  )
  -- Count via the CTE rather than GET DIAGNOSTICS so the count and the write are
  -- one statement, as in the version this restores.
  select count(*)::integer into v_needs_verification from swept;

  -- Everything else: the lease lapses, the status is untouched, the row becomes
  -- claimable again. No status change, so the guard's early return applies and
  -- no actor is needed — but one is set anyway, above.
  with released as (
    -- Again RLS-scoped to the caller's own rows.
    update public.applications a
       -- Clear the full lease, same three columns as above.
       set claimed_at = null,
           -- The holder is gone.
           claimed_by = null,
           -- And so is its expiry.
           claim_expires_at = null
     -- Held rows only.
     where a.claimed_by is not null
       -- Lapsed leases only.
       and a.claim_expires_at < pg_catalog.now()
       -- Belt-and-braces: the statement above already nulled claimed_by on every
       -- row it moved. This clause survives someone reordering the two statements.
       and a.status <> 'applying'
    -- Ids for the count.
    returning a.id
  )
  -- Disjoint from the first count by construction (the ROWS are disjoint).
  select count(*)::integer into v_released from released;

  -- Same column order as the declared return table.
  return query select v_released, v_needs_verification;
end;
$$;
