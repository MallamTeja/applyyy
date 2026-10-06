-- =============================================================================
-- Freezes applications.tailored_profile everywhere except the three statuses at
-- which someone legitimately writes it.
--
-- WHY THIS MIGRATION EXISTS. The column is documented as "the frozen
-- ResolvedResume as approved" (20260909234700_core_tables.sql:343-346), and the
-- whole promise "what you approved is byte-for-byte what gets sent" rests on that
-- word FROZEN. Until this file, nothing in the database made it true:
--
--   * RLS policy "own applications" (20260909235000_rls_policies.sql:77-80) is
--     FOR ALL TO authenticated and checks ownership only. There are no column
--     grants, so an owner may UPDATE any column of their own row.
--   * guard_status_transition() returns early when status is unchanged
--     (20260909234900_status_transition_guard.sql:200-202), so an UPDATE that
--     touches only tailored_profile is never examined by anything.
--
-- So any authenticated client could silently rewrite the resume of an APPROVED or
-- already-APPLIED application. That matters because the worker uploads the column
-- as-is: worker/src/supabase-gateway.ts:269-275 passes tailored_profile through
-- unvalidated and apply-one.ts prints and attaches it. A resume changed after the
-- human said yes would be submitted under that yes. The approval page's own
-- `.eq('status','awaiting_approval')` predicate protects only that one page; it
-- does not bind the REST API, the SQL editor, or the next module someone writes.
-- This trigger binds the table, which is the only place every writer crosses.
-- =============================================================================

-- =============================================================================
-- THE ALLOWLIST, with the writer that justifies each entry. A status is on this
-- list only because a real code path writes the column there.
--
--   'scored'             The Tailor's only write (_shared/tailor/persist.ts:82-93).
--                        It writes the profile while the row is still at scored and
--                        advances status in a SEPARATE, later RPC. If that RPC fails
--                        the row stays at scored and the Tailor re-runs, rewriting
--                        the profile at scored again. Freezing scored would break
--                        the Tailor outright.
--   'audit_flagged'      A human correcting a claim the Auditor could not trace,
--                        before sending it back through the human-only
--                        audit_flagged -> tailored re-tailor edge
--                        (status_transition_guard.sql:128), so the Auditor judges
--                        the corrected profile.
--   'awaiting_approval'  The human resume editor on the approval page (being built;
--                        its save is conditional on this status). Editing here is
--                        the human reviewing what they are about to approve.
--
-- DELIBERATELY EXCLUDED, so the omissions are decisions on the record:
--   'tailored'           No writer exists. An edit here would race the Auditor, so
--                        its verdict could describe a profile that changed under it.
--   'audit_clean'        Transient and writerless. Freezing it stops a clean verdict
--                        being undercut on the way into the human queue.
--   'approved' and every later status
--                        The resume is what was, or is about to be, submitted.
--   everything before 'scored'
--                        No resume exists yet, so nothing has reason to write one.
--
-- A deliberate consequence: a single UPDATE moving awaiting_approval -> approved
-- AND changing the profile passes, because the trigger judges OLD.status. That is
-- the human editing at the gate they alone open — the same person, the same moment.
-- =============================================================================

create or replace function applyy_internal.guard_tailored_profile_freeze()
returns trigger
language plpgsql
-- NOT `security definer`, matching guard_status_insert()
-- (20260917130000_guard_application_status_on_insert.sql:60-66): this function reads
-- no table, so definer privileges would be granted with nothing to use them on.
-- Empty search_path so no caller can shadow a name we resolve; hence every type
-- below is schema-qualified.
set search_path = ''
as $$
begin
  -- `is distinct from`, not `<>`: it treats null -> value and value -> null as a
  -- change (where `<>` would yield NULL and silently let the write through). jsonb
  -- compares by value, so rewriting the same document — e.g. a client that sends
  -- every column back unchanged — is not a change and is never refused.
  if new.tailored_profile is distinct from old.tailored_profile
     -- OLD.status, not NEW.status: the question is where the row WAS when the
     -- write arrived. Judging NEW would let one UPDATE escape the freeze by also
     -- moving status into an allowlisted value in the same statement.
     -- A literal array of the enum type, so a typo fails at the cast rather than
     -- quietly never matching.
     and not (old.status = any (array['scored', 'audit_flagged', 'awaiting_approval']::public.application_status[]))
  then
    -- 42501 (insufficient_privilege), the code the other guards on this table use,
    -- so callers can treat every "the database refused this write" case alike.
    raise exception
      'tailored_profile is frozen at status % (application %). It may change only at scored, audit_flagged or awaiting_approval.',
      old.status, old.id
      using errcode = '42501',
            -- The hint carries the reason, so whoever hits this learns why rather
            -- than looking for a way around it.
            hint = 'Once approved, this resume is what was or will be submitted; a new resume needs a new tailoring, not an edit.';
  end if;

  -- Unchanged or allowed: let the row through untouched.
  return new;
end;
$$;

-- Recorded in the catalog so the reason survives in `\df+` for whoever finds the
-- trigger without having read this file.
comment on function applyy_internal.guard_tailored_profile_freeze() is
  'Refuses any change to public.applications.tailored_profile unless the row is at scored, audit_flagged or awaiting_approval. Makes the column comment "the frozen ResolvedResume as approved" true.';

-- Dropped first so this file is re-appliable against a throwaway local Postgres:
-- `create or replace` exists for functions but NOT triggers, so a bare
-- `create trigger` raises 42710 on a second run (precedent: 20260917130000:108-121).
drop trigger if exists guard_tailored_profile_freeze on public.applications;

-- `before update OF tailored_profile`: fires only for UPDATEs whose SET list names
-- the column (including an upsert's ON CONFLICT DO UPDATE SET). An UPDATE that does
-- not name it cannot change it, so skipping those is safe and saves a function call
-- on the claim loop, status RPCs and every other hot write to this table.
-- The one way that could be unsafe is another BEFORE trigger assigning
-- tailored_profile; none does (guard_status_transition and set_updated_at don't).
--
-- FIRING ORDER: BEFORE UPDATE triggers run alphabetically — guard_status_transition,
-- guard_tailored_profile_freeze, set_updated_at. Since none of them modifies
-- tailored_profile, the order does not affect this check's correctness.
--
-- BEFORE, so a refused write never reaches the table.
create trigger guard_tailored_profile_freeze
  before update of tailored_profile on public.applications
  for each row execute function applyy_internal.guard_tailored_profile_freeze();
