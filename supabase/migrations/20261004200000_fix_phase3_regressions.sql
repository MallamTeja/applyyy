-- ============================================================================
-- Corrective migration for 20260918213000_phase3_tables_and_gap_fixes.sql.
--
-- WHY THIS IS A NEW FILE RATHER THAN AN EDIT: 20260918213000 is an applied
-- migration. Supabase never re-reads an applied file, so editing it would leave
-- the file saying one thing and the live database doing another, silently.
--
-- WHAT IT BROKE, AND WHY NOTHING BELOW MAY BE "SIMPLIFIED" BACK:
--
-- 1. sweep_stale_claims() — the phase-3 "G5 double-count fix" re-fixed a bug that
--    20260910190000 had ALREADY fixed, and in replacing that correct body it lost
--    three guarantees:
--      a. It no longer set `applyy.acting_agent = 'sweeper'`. The status guard
--         (20260909234900_status_transition_guard.sql:~208-220) refuses any status
--         change with no declared actor, raising 42501. So the first stale
--         `applying` row aborts the WHOLE sweep — a dead worker's lease is never
--         recovered, and the release statement after it never runs either.
--      b. It became SECURITY DEFINER with no `set search_path`. Definer runs as the
--         owner, and FORCE RLS on `applications` does not bind a superuser-owned
--         definer the way it binds an invoker, so any authenticated (or anon,
--         via default privileges) caller swept EVERY tenant's leases. And a
--         definer with a mutable search_path is the textbook hijack vector.
--      c. It stopped clearing `claimed_at`, leaving a half-released lease.
--    It also renamed the second return column to `reset_applying_count`, while
--    every reader (packages/shared-types/src/tables.ts:1306, the worker test at
--    worker/test/supabase-gateway.test.ts:33, _shared/agent/port.ts:75-88) reads
--    `needs_verification_count`. This file restores the 20260910190000 body.
--
--    AND FIXES A FLAW THAT BODY ALWAYS HAD (pre-dates phase 3): it found dead
--    submits by `claimed_by is not null`, but advance_application_status()
--    (20260909235100:134-139) clears claimed_by on EVERY transition, including
--    approved -> applying. So a row at `applying` never has a lease, and a worker
--    that dies mid-submit left the row at `applying` FOREVER — never routed to
--    needs_verification. worker/src/apply-one.ts:442 relies on that routing. The
--    sweep now finds stuck `applying` rows by `status_changed_at` age instead.
--
-- 1b. Double-submit hole in advance_application_status(). The guard trigger
--    returns early on a same-status update (status_transition_guard.sql:200), so
--    two runners that both call approved -> applying on one row BOTH succeed and
--    BOTH submit. Constraint #7. Fixed by locking the row and refusing
--    applying -> applying; every other same-status call stays a no-op.
--
-- 2. follow_up_nudges.status is free text. The web reads `.eq('status','pending')`
--    and writes 'sent' / 'dismissed'; any other value is a row the UI never shows.
-- 3. The FKs on the three phase-3 tables have no `on delete cascade`, while every
--    older user-owned table cascades. Deleting a user, job or application would
--    raise 23503 instead of cleaning up.
-- 4. The three phase-3 policies use bare `auth.uid()` (per-row evaluation) and no
--    `to authenticated`, against the house rule at 20260909235000_rls_policies.sql:12,
--    and have `using` with no explicit `with check`.
-- 5. None of the phase-3 FK columns are indexed, so each cascade from (3) would
--    seq-scan the child table.
--
-- NOT DONE, deliberately: composite (user_id, application_id) FKs. That needs a
-- unique (user_id, id) on public.applications to reference, and none exists.
-- Adding one is a schema change to the core queue table and out of scope here.
--
-- Safe to run once inside a single transaction. Idempotent forms are used where
-- Postgres offers them; `add constraint` has none, so each is preceded by a
-- `drop constraint if exists`.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- FIX 1 — restore sweep_stale_claims().
-- ----------------------------------------------------------------------------

-- DROP, not `create or replace`: the live function returns
-- (released_count, reset_applying_count) and we are changing a return column
-- name. Postgres refuses that via replace (42P13). The drop also takes the
-- phase-3 grants with it, which is wanted: they are re-issued explicitly below.
drop function if exists public.sweep_stale_claims();

-- Body restored from 20260910190000:56-123, which was correct. Column names are
-- the ones every TypeScript reader expects (`needs_verification_count`).
create function public.sweep_stale_claims()
-- The original shape: two disjoint counts. Returned as a table because the
-- adapters already unpack it as a one-row array (worker/src/supabase-gateway.ts:124).
returns table (released_count integer, needs_verification_count integer)
-- plpgsql because we need two sequential statements and locals.
language plpgsql
-- INVOKER, stated explicitly so nobody "upgrades" it to definer again. RLS on
-- `applications` ("own applications", to authenticated) is then what scopes the
-- sweep to the caller's own rows: the worker signs in as an ordinary auth user,
-- so it can only ever recover its own tenant's leases.
security invoker
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

-- The definition lives in the database too, where someone reading the function
-- will find the history without opening migrations.
comment on function public.sweep_stale_claims() is
  'Recovers expired claim leases for the CALLER''S rows (security invoker, RLS-scoped). Returns two DISJOINT counts: rows released back to the queue, and rows routed to needs_verification because they died mid-submit. Restored 2026-10-04 after 20260918213000 dropped the sweeper actor (42501 on every sweep), made it security definer without a search_path, and renamed needs_verification_count. Stuck applying rows are found by status_changed_at older than claim_lease_seconds, because advance_application_status clears claimed_by on entry to applying.';

-- Nobody but a signed-in user should call it. `public` covers the implicit
-- PUBLIC grant every new function gets; `anon` covers Supabase's default
-- privileges. service_role keeps its default-privilege grant for operator use.
revoke execute on function public.sweep_stale_claims() from public, anon;
-- The worker runs as an ordinary authenticated user (supabase-gateway.ts:12-22).
grant execute on function public.sweep_stale_claims() to authenticated;


-- ----------------------------------------------------------------------------
-- FIX 1b — refuse a second approved -> applying on the same row.
-- ----------------------------------------------------------------------------
-- Body is 20260909235100:111-155 VERBATIM except the marked block. `create or
-- replace` replaces the WHOLE body, so anything omitted here would silently
-- vanish from the deployed function. Same signature, so grants are kept.
create or replace function public.advance_application_status(
  p_application_id uuid,
  p_to_status public.application_status,
  p_agent public.agent_name,
  p_detail jsonb default '{}'::jsonb
)
-- Unchanged: callers read the updated row back.
returns public.applications
-- Unchanged.
language plpgsql
-- Unchanged: all references are schema-qualified.
set search_path = ''
as $$
declare
  -- Unchanged: the moved row, returned to the caller.
  v_row public.applications;
  -- NEW: the status as it stands once this transaction holds the row lock.
  v_current public.application_status;
begin
  -- Declare who is acting. The third argument `true` scopes this to the current
  -- TRANSACTION, so it cannot leak into the next statement on a pooled connection —
  -- which, with PgBouncer in front of Supabase, is not a theoretical concern.
  perform pg_catalog.set_config('applyy.acting_agent', p_agent::text, true);

  -- NEW — THE DOUBLE-SUBMIT GATE. The guard trigger returns early when status is
  -- unchanged (status_transition_guard.sql:200), so applying -> applying passes
  -- it. Two runners racing approved -> applying would both "succeed" and both
  -- submit, violating constraint #7. FOR UPDATE serialises them: the second waits
  -- for the first to commit, then re-reads and sees `applying`.
  -- Not found (or not ours) leaves v_current null and falls through to the
  -- existing P0002 below, so that error is unchanged.
  select a.status
    into v_current
    from public.applications a
   where a.id = p_application_id
     for update;

  -- Only `applying` is refused. Every other same-status call stays a no-op, so
  -- idempotent callers that re-assert a status they already hold do not break.
  -- `applying` is the one status where "already there" means someone else may
  -- be submitting right now.
  if v_current = 'applying' and p_to_status = 'applying' then
    -- 55000 object_not_in_prerequisite_state: a retry will fail the same way,
    -- which is correct — the caller must NOT submit.
    raise exception 'application % is already applying; refusing a second submit (constraint #7)', p_application_id
      using errcode = '55000';
  end if;

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

  -- Unchanged.
  return v_row;
end;
$$;

-- Restates the original comment plus the new refusal, so it is discoverable in-db.
comment on function public.advance_application_status(uuid, public.application_status, public.agent_name, jsonb) is
  'The only correct way to change status. Validates the edge, witnesses it, and releases the lease in one transaction. Refuses applying -> applying (55000) so two runners cannot both submit; every other same-status call is a no-op.';


-- ----------------------------------------------------------------------------
-- FIX 2 — close follow_up_nudges.status to the values the UI understands.
-- ----------------------------------------------------------------------------
-- EXISTING ROWS MUST COMPLY. The table is believed empty — every insert from
-- supabase/functions/follow-up has failed (it writes `subject`/`body`, columns
-- that do not exist, and omits NOT NULL user_id/job_id) — but that cannot be
-- verified from here. Hence NOT VALID then VALIDATE: if a non-conforming row
-- does exist, the VALIDATE fails loudly and names the constraint, rather than
-- the ADD failing in a way that looks like a syntax problem.
--
-- nudge_type is deliberately left free text: no code writes it (the column
-- default 'day_7' is the only producer) and the web only displays it, so there
-- is no closed set in the code to encode. Constrain it when a second cadence
-- exists and its values are decided.

-- Drop first because `add constraint` has no `if not exists`.
alter table public.follow_up_nudges
  drop constraint if exists follow_up_nudges_status_check;
-- 'pending' = awaiting review (the web's `.eq('status','pending')`), 'sent' and
-- 'dismissed' = the two terminal actions FollowUpNudgesPage.tsx writes. The
-- column default 'pending' is unchanged and already satisfies this.
alter table public.follow_up_nudges
  add constraint follow_up_nudges_status_check
  check (status in ('pending', 'sent', 'dismissed')) not valid;
-- Separate step so a failure is attributable to existing data, not the DDL.
alter table public.follow_up_nudges
  validate constraint follow_up_nudges_status_check;


-- ----------------------------------------------------------------------------
-- FIX 3 — cascade the phase-3 foreign keys like every older user-owned table.
-- ----------------------------------------------------------------------------
-- Names are Postgres's auto-generated <table>_<column>_fkey, because 20260918213000
-- declared them inline without names. `if exists` keeps this re-runnable.
-- Same names are reused so nothing that references them by name breaks.

-- follow_up_nudges.user_id: a deleted user must take their nudges with them.
alter table public.follow_up_nudges
  drop constraint if exists follow_up_nudges_user_id_fkey;
-- Recreated with cascade, matching core_tables.sql:305.
alter table public.follow_up_nudges
  add constraint follow_up_nudges_user_id_fkey
  foreign key (user_id) references auth.users (id) on delete cascade;

-- follow_up_nudges.application_id: a nudge for a deleted application is meaningless.
alter table public.follow_up_nudges
  drop constraint if exists follow_up_nudges_application_id_fkey;
-- Cascade so deleting the application does not raise 23503.
alter table public.follow_up_nudges
  add constraint follow_up_nudges_application_id_fkey
  foreign key (application_id) references public.applications (id) on delete cascade;

-- follow_up_nudges.job_id: mirrors applications.job_id (core_tables.sql:309).
alter table public.follow_up_nudges
  drop constraint if exists follow_up_nudges_job_id_fkey;
-- Cascade so job cleanup is not blocked by a nudge.
alter table public.follow_up_nudges
  add constraint follow_up_nudges_job_id_fkey
  foreign key (job_id) references public.jobs (id) on delete cascade;

-- skill_gap_reports.user_id: its only FK; a deleted user's gaps go with them.
alter table public.skill_gap_reports
  drop constraint if exists skill_gap_reports_user_id_fkey;
-- Cascade, matching every other auth.users reference.
alter table public.skill_gap_reports
  add constraint skill_gap_reports_user_id_fkey
  foreign key (user_id) references auth.users (id) on delete cascade;

-- interview_prep_packs.user_id: same rule as above.
alter table public.interview_prep_packs
  drop constraint if exists interview_prep_packs_user_id_fkey;
-- Cascade on user deletion.
alter table public.interview_prep_packs
  add constraint interview_prep_packs_user_id_fkey
  foreign key (user_id) references auth.users (id) on delete cascade;

-- interview_prep_packs.application_id: prep for a deleted application is orphaned.
alter table public.interview_prep_packs
  drop constraint if exists interview_prep_packs_application_id_fkey;
-- Cascade on application deletion.
alter table public.interview_prep_packs
  add constraint interview_prep_packs_application_id_fkey
  foreign key (application_id) references public.applications (id) on delete cascade;

-- interview_prep_packs.job_id: mirrors applications.job_id.
alter table public.interview_prep_packs
  drop constraint if exists interview_prep_packs_job_id_fkey;
-- Cascade on job deletion.
alter table public.interview_prep_packs
  add constraint interview_prep_packs_job_id_fkey
  foreign key (job_id) references public.jobs (id) on delete cascade;


-- ----------------------------------------------------------------------------
-- FIX 4 — house-style policies (rls_policies.sql:10-27).
-- ----------------------------------------------------------------------------
-- (select auth.uid()) evaluates once per statement as an InitPlan, not per row;
-- `to authenticated` skips evaluation entirely for anon; `with check` stops a
-- row being updated into another tenant. Do not "simplify" any of the three.

-- Remove the phase-3 policy.
drop policy if exists follow_up_nudges_user_policy on public.follow_up_nudges;
-- Remove our own, so a re-run does not hit 42710.
drop policy if exists "own follow-up nudges" on public.follow_up_nudges;
-- Same rule for every verb, so `for all`.
create policy "own follow-up nudges" on public.follow_up_nudges
  for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

-- Remove the phase-3 policy.
drop policy if exists skill_gap_reports_user_policy on public.skill_gap_reports;
-- Re-run safety.
drop policy if exists "own skill gap reports" on public.skill_gap_reports;
-- Tenant isolation, house style.
create policy "own skill gap reports" on public.skill_gap_reports
  for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

-- Remove the phase-3 policy.
drop policy if exists interview_prep_packs_user_policy on public.interview_prep_packs;
-- Re-run safety.
drop policy if exists "own interview prep packs" on public.interview_prep_packs;
-- Tenant isolation, house style.
create policy "own interview prep packs" on public.interview_prep_packs
  for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);


-- ----------------------------------------------------------------------------
-- FIX 5 — index the FK columns.
-- ----------------------------------------------------------------------------
-- Postgres indexes the referenced side of an FK, never the referencing side.
-- Without these, each cascade from FIX 3 and each RLS-filtered read seq-scans.
-- Not `concurrently`: that cannot run inside the migration's transaction, and
-- these tables are new and near-empty, so the brief lock is negligible.
--
-- skill_gap_reports needs none: its only FK column, user_id, is the leading
-- column of its unique (user_id, skill_name) index, which already serves it.

-- RLS predicate and user-delete cascade.
create index if not exists follow_up_nudges_user_id_idx
  on public.follow_up_nudges (user_id);
-- Application-delete cascade and per-application lookup.
create index if not exists follow_up_nudges_application_id_idx
  on public.follow_up_nudges (application_id);
-- Job-delete cascade.
create index if not exists follow_up_nudges_job_id_idx
  on public.follow_up_nudges (job_id);
-- RLS predicate and user-delete cascade.
create index if not exists interview_prep_packs_user_id_idx
  on public.interview_prep_packs (user_id);
-- Application-delete cascade and per-application lookup.
create index if not exists interview_prep_packs_application_id_idx
  on public.interview_prep_packs (application_id);
-- Job-delete cascade.
create index if not exists interview_prep_packs_job_id_idx
  on public.interview_prep_packs (job_id);
