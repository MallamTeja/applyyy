-- supabase/tests/invariants.sql — read-only schema/data invariants for the live database.
--
-- WHAT THIS IS: the checked-in, re-runnable successor to the transcript in
-- docs/audit/2026-09-10-schema-invariants-verified.md, which proposed exactly this file
-- ("worth promoting into a checked-in supabase/tests/invariants.sql"), and the closure of
-- the docs/PROGRESS.md open item "supabase/tests/invariants.sql does not exist".
--
-- HOW TO RUN: manually, by a human or the orchestrator, via psql or the Supabase MCP
-- execute_sql, against the linked project (xynqxekcqizwhtskzqrq) or a local stack.
-- Every block is SELECT-only: it reads catalogs and data and RAISES on violation,
-- writing nothing. Each block is independent; run the whole file or any one block.
--
-- THIS IS NOT A MIGRATION. Never place it in supabase/migrations/, never `db push` it.
-- It asserts the state other migrations created; applying it as a migration would
-- record an empty schema change and start asserting against half-applied state.
--
-- WHAT IT DELIBERATELY DOES NOT COVER: the write-path probes from the 2026-09-10 audit
-- (duplicate-insert refusal, illegal-edge rejection with isolation controls) require
-- INSERTs/UPDATEs and belong to a disposable local database, not to a read-only script
-- run against live. See that doc's "The three invariants" for how to run those.
--
-- DESIGN FACT, ASSERTED NOT FLAGGED (ruled deliberate, 2026-10-23): one status move
-- writes TWO events — the log_status_change AFTER UPDATE trigger writes the
-- 'status_change' row (the witness, with from/to), and advance_application_status
-- writes a separate 'note' row when p_detail is non-empty (20261008130000:194-201:
-- "Extra context rides on its own event rather than being crammed into the
-- status_change row"). A pair of events per move is the design; do NOT add an
-- invariant that treats it as duplication. Invariant 8 asserts the shape split.

-- ============================================================================
-- 1. rls_no_holes — every public table has RLS enabled.
-- Source: docs/audit/2026-09-10-schema-invariants-verified.md invariant C ("Holes:
-- RLS off entirely. Expect 0 rows."); CLAUDE.md §1 (RLS on every table).
-- Shape-based, never count-pinned: a new table is covered automatically.
-- ============================================================================
do $$
declare
  -- The offending table names, so a failure says WHICH table is the hole.
  v_bad text;
begin
  -- Collect every ordinary public table with row security off.
  select string_agg(c.relname, ', ' order by c.relname) into v_bad
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity;
  -- Any name here is a table the whole safety case assumes cannot exist.
  if v_bad is not null then
    raise exception 'INVARIANT rls_no_holes: RLS disabled on: %', v_bad;
  end if;
end $$;

-- ============================================================================
-- 2. rls_no_lockouts — every RLS-enabled public table carries at least one policy.
-- Source: same audit, invariant C ("Locked: RLS on but no policy. Expect 0 rows").
-- RLS-on with zero policies locks the table to everyone, which fails identically to
-- a hole from the outside — the audit's reason these are TWO assertions, never one.
-- ============================================================================
do $$
declare
  -- The locked table names, for the same which-table reason as block 1.
  v_bad text;
begin
  -- Tables with row security but no policy row in pg_policies.
  select string_agg(c.relname, ', ' order by c.relname) into v_bad
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity
     and not exists (select 1 from pg_policies p
                      where p.schemaname = 'public' and p.tablename = c.relname);
  -- A locked table means some caller is silently getting zero rows.
  if v_bad is not null then
    raise exception 'INVARIANT rls_no_lockouts: RLS on but zero policies on: %', v_bad;
  end if;
end $$;

-- ============================================================================
-- 3. force_rls_single_exception — FORCE RLS on every public table except
-- application_status_transitions.
-- Source: the audit's OPEN QUESTION (the transition seed is the one table with
-- relforcerowsecurity = f; "defensible but not decided"). This block pins TODAY's
-- state so any drift — a new table forgetting FORCE, or a second exception —
-- surfaces as a failure instead of silently widening the exception list.
-- ============================================================================
do $$
declare
  -- Tables missing FORCE that are not the documented exception.
  v_bad text;
begin
  -- The exception list is exactly one name; anything else without FORCE is drift.
  select string_agg(c.relname, ', ' order by c.relname) into v_bad
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind = 'r' and not c.relforcerowsecurity
     and c.relname <> 'application_status_transitions';
  -- FORCE is what makes the owner subject to policy (it works only because postgres
  -- carries BYPASSRLS — the audit's corrected reason; PROGRESS defect #3).
  if v_bad is not null then
    raise exception 'INVARIANT force_rls_single_exception: FORCE RLS missing on: %', v_bad;
  end if;
end $$;

-- ============================================================================
-- 4. applying_single_entry — exactly one edge enters 'applying':
-- approved -> applying, allowed_agents = {applier}.
-- Source: audit invariant B supporting facts ("approved -> applying is the ONLY edge
-- into applying, allowed_agents = {applier}"); 20260909234900 seed. This is what makes
-- constraint #15 (no submit without human approval) unreachable-by-construction.
-- ============================================================================
do $$
declare
  -- How many edges enter applying at all.
  v_count integer;
  -- Whether the one expected edge has exactly the expected agent set.
  v_exact integer;
begin
  -- Every edge into applying, whatever its source.
  select count(*) into v_count
    from public.application_status_transitions
   where to_status = 'applying';
  -- The expected edge with the exact one-element agent array.
  select count(*) into v_exact
    from public.application_status_transitions
   where from_status = 'approved' and to_status = 'applying'
     and allowed_agents = array['applier']::public.agent_name[];
  -- One edge total AND it is the expected one — two facts, both required.
  if v_count <> 1 or v_exact <> 1 then
    raise exception 'INVARIANT applying_single_entry: expected exactly approved->applying {applier}; found % edge(s) into applying, % exact match', v_count, v_exact;
  end if;
end $$;

-- ============================================================================
-- 5. approved_entries_human_only — EVERY edge into 'approved' is human-only.
-- Source: docs/PROGRESS.md defect #4's CORRECTED invariant ("the true statement is:
-- every edge into approved is human-only") — the original "awaiting_approval ->
-- approved is the only edge" was false (needs_verification -> approved also exists).
-- Written over ALL edges into approved so a third edge added later is still checked.
-- ============================================================================
do $$
declare
  -- Edges into approved that any non-human agent may walk.
  v_bad text;
begin
  -- An edge whose agent set is anything but exactly {human} is a machine route in.
  select string_agg(from_status::text || '->' || to_status::text, ', ') into v_bad
    from public.application_status_transitions
   where to_status = 'approved'
     and allowed_agents <> array['human']::public.agent_name[];
  -- A machine deciding "approved" is the submit gate failing open.
  if v_bad is not null then
    raise exception 'INVARIANT approved_entries_human_only: non-human edge(s) into approved: %', v_bad;
  end if;
end $$;

-- ============================================================================
-- 6. needs_verification_exits_human_only — every edge OUT of needs_verification is
-- human-only. Source: Teja's 2026-10-23 ruling (needs_verification -> * human-only);
-- 20260909234900 seed rows 156-158 ("a machine must never decide that a
-- possibly-submitted application was not submitted").
-- ============================================================================
do $$
declare
  -- Exits a machine could walk.
  v_bad text;
begin
  -- Any exit edge whose agent set is not exactly {human}.
  select string_agg(from_status::text || '->' || to_status::text, ', ') into v_bad
    from public.application_status_transitions
   where from_status = 'needs_verification'
     and allowed_agents <> array['human']::public.agent_name[];
  -- needs_verification means "unknown if submitted"; only a person may resolve it.
  if v_bad is not null then
    raise exception 'INVARIANT needs_verification_exits_human_only: machine-walkable exit(s): %', v_bad;
  end if;
end $$;

-- ============================================================================
-- 7. tracker_applied_entry — among edges INTO 'applied', exactly one allows the
-- tracker: applying -> applied, allowed_agents = {applier, tracker}.
-- Source: Teja's 2026-10-23 ruling and migration 20261009235000 (its own push-time
-- probe asserts "1 of 1 edge into applied allows the tracker"; needs_verification ->
-- applied must NOT allow it — the tracker may confirm a receipt, never resolve an
-- unknown submit). NOTE: the tracker ALSO holds the post-applied tracking lanes
-- (applied -> employer_screening / oa_pending / interview / rejected and onward, all
-- {tracker,human}, seeded 20260909234900) and that is INTENTIONAL — do not "fix" those
-- edges away. The 2026-10-23 ruling narrowed what a RECEIPT may do, and that lives in
-- code (email-tracker-intake: CONFIRMABLE_STATUSES=['applying']); recruiter outreach,
-- interview invites and rejections legitimately walk the post-applied lanes. Verified
-- against live + ruled by the orchestrator 2026-10-23. This invariant guards only the
-- entry into applied.
-- ============================================================================
do $$
declare
  -- Edges into applied that allow the tracker.
  v_tracker_edges integer;
  -- Whether applying->applied carries the exact ruled agent pair.
  v_exact integer;
begin
  -- Count every tracker-walkable edge into applied; must be exactly the one.
  select count(*) into v_tracker_edges
    from public.application_status_transitions
   where to_status = 'applied'
     and 'tracker'::public.agent_name = any (allowed_agents);
  -- The ruled edge with the exact two-element agent set.
  select count(*) into v_exact
    from public.application_status_transitions
   where from_status = 'applying' and to_status = 'applied'
     and allowed_agents = array['applier','tracker']::public.agent_name[];
  -- Both facts required: one tracker entry, and it is the ruled pair.
  if v_tracker_edges <> 1 or v_exact <> 1 then
    raise exception 'INVARIANT tracker_applied_entry: expected applying->applied {applier,tracker} as the only tracker entry into applied; found % tracker edge(s), % exact match', v_tracker_edges, v_exact;
  end if;
end $$;

-- ============================================================================
-- 8. event_shape_separation — the two-event design's shape split holds:
-- 'status_change' events always carry from_status AND to_status; 'note' events never
-- carry either. Source: the 2026-10-23 "deliberate design" ruling (header above);
-- log_status_change writes from/to (20260909234900:286-304), the RPC's note rides
-- WITHOUT them (20261008130000:194-201); the 20260917174600 retraction chose 'note'
-- precisely because 'status_change' would forge a transition.
-- ============================================================================
do $$
declare
  -- status_change rows missing an endpoint (a witness that forgot what it saw).
  v_bad_sc integer;
  -- note rows carrying endpoints (a note impersonating a transition).
  v_bad_note integer;
begin
  -- The witness must always know both endpoints.
  select count(*) into v_bad_sc
    from public.application_events
   where event_type = 'status_change'
     and (from_status is null or to_status is null);
  -- A note is context, never a transition record.
  select count(*) into v_bad_note
    from public.application_events
   where event_type = 'note'
     and (from_status is not null or to_status is not null);
  -- Either count nonzero means the two event roles are bleeding into each other.
  if v_bad_sc <> 0 or v_bad_note <> 0 then
    raise exception 'INVARIANT event_shape_separation: % status_change row(s) missing endpoints, % note row(s) carrying endpoints', v_bad_sc, v_bad_note;
  end if;
end $$;

-- ============================================================================
-- 9. events_match_graph — every 'status_change' event's (from,to) is an edge in
-- application_status_transitions. Source: the witness trigger only fires AFTER the
-- guard admitted the move (20260909234900), so an eventless edge or an edgeless event
-- means the guard was bypassed, the graph was edited after the fact, or a data fix
-- forged a transition (the 20260917174600 incident class).
-- ============================================================================
do $$
declare
  -- Logged transitions that no longer correspond to any edge.
  v_bad text;
begin
  -- Distinct, so one rogue pair reports once however many rows carry it.
  select string_agg(distinct e.from_status::text || '->' || e.to_status::text, ', ') into v_bad
    from public.application_events e
   where e.event_type = 'status_change'
     and not exists (select 1 from public.application_status_transitions t
                      where t.from_status = e.from_status
                        and t.to_status = e.to_status);
  -- The log and the graph must tell one story.
  if v_bad is not null then
    raise exception 'INVARIANT events_match_graph: logged transition(s) with no edge: %', v_bad;
  end if;
end $$;

-- ============================================================================
-- 10. guard_triggers_live — the five guard/witness triggers exist and are enabled.
-- Source: CLAUDE.md §7 (guard_status_transition BEFORE UPDATE; guard_status_insert;
-- guard_tailored_profile_freeze; application_events append-only) and 20260909234900
-- (log_status_change, the witness). tgenabled 'O' = fires on origin, the normal state;
-- a disabled trigger is a control that LOOKS present in \d output and does nothing.
-- ============================================================================
do $$
declare
  -- Each required (table, trigger) pair, checked by name.
  v_missing text := '';
  -- Loop variable over the required list.
  r record;
begin
  -- The control set: applications' three guards + witness, events' two freeze locks.
  for r in
    select * from (values
      ('applications', 'guard_status_transition'),
      ('applications', 'guard_status_insert'),
      ('applications', 'guard_tailored_profile_freeze'),
      ('applications', 'log_status_change'),
      ('application_events', 'forbid_update'),
      ('application_events', 'forbid_delete')
    ) as req(tbl, trg)
  loop
    -- Present AND enabled ('O'); a dropped or disabled trigger fails identically.
    if not exists (
      select 1 from pg_trigger g
        join pg_class c on c.oid = g.tgrelid
        join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relname = r.tbl
         and g.tgname = r.trg and not g.tgisinternal and g.tgenabled = 'O'
    ) then
      -- Accumulate every miss so one run names them all.
      v_missing := v_missing || r.tbl || '.' || r.trg || ' ';
    end if;
  end loop;
  -- Any accumulated name is a live control that is gone.
  if v_missing <> '' then
    raise exception 'INVARIANT guard_triggers_live: missing or disabled trigger(s): %', v_missing;
  end if;
end $$;

-- ============================================================================
-- 11. agent_key_guards — the four guarded functions read agent_key_state, and anon
-- cannot execute any of them. Source: CLAUDE.md §7's ready-made query (re-verified
-- there 2026-10-09): advance_application_status, claim_applications,
-- release_application_claim, sweep_stale_claims; migrations 20261008160000/170000,
-- 20261009130000.
-- ============================================================================
do $$
declare
  -- Functions failing either the anon check or the agent_key_state check.
  v_bad text;
  -- How many of the four names were found at all (a renamed function must not pass vacuously).
  v_found integer;
begin
  -- Count the guarded set; fewer than 4 means a function vanished or was renamed.
  select count(distinct proname) into v_found
    from pg_proc
   where proname in ('advance_application_status', 'claim_applications',
                     'release_application_claim', 'sweep_stale_claims');
  -- CLAUDE.md §6: a guard that can pass vacuously is not a guard.
  if v_found <> 4 then
    raise exception 'INVARIANT agent_key_guards: expected 4 guarded functions, found %', v_found;
  end if;
  -- Any overload that anon can execute, or whose body lost the key check, is a hole.
  select string_agg(oid::regprocedure::text, ', ') into v_bad
    from pg_proc
   where proname in ('advance_application_status', 'claim_applications',
                     'release_application_claim', 'sweep_stale_claims')
     and (has_function_privilege('anon', oid, 'execute')
          or position('agent_key_state' in prosrc) = 0);
  -- The key check is the ONLY discriminator between browser and agent (CLAUDE.md §7).
  if v_bad is not null then
    raise exception 'INVARIANT agent_key_guards: anon-executable or key-check-less: %', v_bad;
  end if;
end $$;

-- ============================================================================
-- 12. agent_key_seeded — exactly one row in applyy_internal.agent_key.
-- Source: CLAUDE.md §7 ("expect 1"; seeded 2026-10-09 ~13:40 IST). An EMPTY table is
-- the deliberate kill switch that reopens the no-key-means-human hole — so zero here
-- must be LOUD, and two keys would mean a rotation that forgot to delete.
-- ============================================================================
do $$
declare
  -- The live key count.
  v_count integer;
begin
  -- One seeded key is the operating state.
  select count(*) into v_count from applyy_internal.agent_key;
  -- Zero = kill switch engaged (agents indistinguishable from humans); >1 = stale rotation.
  if v_count <> 1 then
    raise exception 'INVARIANT agent_key_seeded: expected 1 key row, found %', v_count;
  end if;
end $$;
