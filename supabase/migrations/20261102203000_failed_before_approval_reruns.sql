-- WHY THIS MIGRATION EXISTS (2026-11-02).
--
-- The master-v9 re-run (20261101173000) sent 40 rows back through the pipeline. Nine came out
-- at `failed` because the tailor's output was refused by the validator, not because any filter
-- dropped them. 11 of Nov 2's 15 refusals were one prompt ambiguity: the model wrote a bullet
-- under a bullet-less education/certification node and gave it the node's own id (fixed in
-- _shared/tailor/prompt.ts in the same commit). `failed` had no way back: its only exit is
-- failed -> needs_verification. Teja asked for those jobs back (2026-11-02 20:20 IST, "Add
-- edge, retry"), so this adds one human-only edge, failed -> passed_filters, to re-score and
-- re-tailor them.
--
-- THE DANGER, AND THE GUARD. `failed` is ALSO reached after approval: applying -> failed
-- (the applier), needs_verification -> failed and blocked_needs_human -> failed (a human). A
-- row like that may already have been SUBMITTED. Sending it back to passed_filters would let
-- it be re-tailored, re-approved and sent a second time, which breaks constraint #7 (never
-- submit twice). An edge cannot say "only some failed rows", so a BEFORE UPDATE trigger
-- refuses the move unless the row failed BEFORE approval. That means previous_status (set to
-- old.status by guard_status_transition, status_transition_guard.sql:250) must be one of
-- discovered, deduped, passed_filters, scored or tailored. A null previous_status is refused
-- too: unknown history is not proof of safety (CLAUDE.md §6).
--
-- The edge is HELD in apps/web/src/data/humanLanes.ts, so the System health failed queue
-- shows no button for it. The re-run is sent through advance_application_status by the
-- operator with detail.reason. The trigger, not the missing button, is the control.
--
-- The edge insert is not re-runnable (plain insert, like every graph migration here). The
-- function and trigger are: `create or replace` plus `drop trigger if exists`. The insert uses
-- the multi-row form packages/shared-types/test/enum-parity.test.ts parses, so the TS mirror
-- in packages/shared-types/src/status-flow.ts is checked against it.

-- One new edge, human-only.
insert into public.application_status_transitions (from_status, to_status, allowed_agents, note) values
  -- A row that failed before approval (matcher, tailor or auditor) goes back to be re-scored and re-tailored.
  ('failed', 'passed_filters', array['human']::public.agent_name[], 'Human re-runs a row that failed before approval; guard_failed_rerun refuses one that failed at or after approval.');

-- The old note on failed -> needs_verification said it was "The ONLY edge out of failed",
-- which the insert above makes false. Reworded so the graph's own prose stays true; the
-- single-line form is the one the parity test parses.
update public.application_status_transitions set note = 'Verification, not the queue, for a row that failed near the submit boundary: a person checks it before it moves again. Pre-approval failures may instead re-run via failed -> passed_filters.' where from_status = 'failed' and to_status = 'needs_verification';

-- The guard: only pre-approval failures may take the new edge.
create or replace function applyy_internal.guard_failed_rerun()
returns trigger
language plpgsql
-- NOT `security definer`, matching guard_tailored_profile_freeze(): it reads only OLD/NEW,
-- so it needs no privilege beyond the caller's.
-- Empty search_path so no caller can shadow a name we resolve; every type below is qualified.
set search_path = ''
as $$
begin
  -- Only the new edge is judged; every other update passes untouched.
  if old.status = 'failed'
     and new.status = 'passed_filters'
     -- OLD.previous_status is where the row was when it failed. A literal array of the enum
     -- type, so a typo fails at the cast rather than quietly never matching. `is not true`
     -- also refuses a null previous_status: unknown history is not a safe history.
     and (old.previous_status = any (array['discovered', 'deduped', 'passed_filters', 'scored', 'tailored']::public.application_status[])) is not true
  then
    -- 42501, the code the other guards on this table use for "the database refused this write".
    raise exception
      'application % failed at or after approval (previous_status %); it may not re-enter the pipeline',
      old.id, old.previous_status
      using errcode = '42501',
            -- The hint carries the reason, so whoever hits this learns why rather than
            -- looking for a way around it.
            hint = 'A row that failed at or after approval may already have been submitted; re-running it risks a second submission (constraint #7). Verify it by hand instead.';
  end if;
  -- Allowed, or not this edge: let the row through.
  return new;
end;
$$;

-- `create trigger` raises 42710 on a second run (precedent: 20261006190000:107-108).
drop trigger if exists guard_failed_rerun on public.applications;

-- BEFORE UPDATE OF status: the only column whose change can take the edge. It reads OLD only,
-- so its firing order relative to guard_status_transition does not matter.
create trigger guard_failed_rerun
  before update of status on public.applications
  for each row
  execute function applyy_internal.guard_failed_rerun();
