-- The auditor may also drop an awaiting_approval row that copies a posting Teja already committed to (W2, 2026-11-21).
--
-- WHY THIS EXISTS: the screener's same-ATS-posting check (fa315449) runs once, when a row is inserted. A retitled copy
-- inserted BEFORE the original was approved (Canonical 111d1ff4 vs the applied 8e9d58ce, greenhouse 5150422) sails
-- past it and waits in the approval queue. The auditor's `?mode=regate_queue` (auditor/regate-queue.ts) now finds
-- such a row: its job has the same ATS provider and id as an application that is approved or later. To move it off
-- the queue the auditor needs this edge with drop_reason 'already_applied', which 20261111220000 refuses.
--
-- WHY IT STAYS INSIDE THE 11-11 RULE: 20261111220000 says "The auditor may drop an awaiting_approval row, for work
-- authorisation ONLY (Teja, 2026-11-11)" because work_auth is "the one gate with no judgement in it. Every other
-- reason still needs a human." already_applied is the same class: it compares two rows' (ats_provider, ats_job_id),
-- it reads no prose, and Teja already said yes to the original. experience_ceiling is NOT added: it parses JD
-- prose, so it is judgement, and the 11-11 rule keeps it with Teja (orch ruling A, 2026-11-21). The sweep only
-- REPORTS those rows. Adding it later is one more value in the list below, after Teja's own ruling.
--
-- WHY THE RENAME: the old name, guard_auditor_queue_drop_work_auth_only, would now be false. The old trigger and
-- function are dropped and replaced by guard_auditor_queue_drop_reason, which states the allowed list.
--
-- DEPLOY ORDER: this migration BEFORE the auditor that writes drop_reason 'already_applied'. The other order makes
-- every W2 drop fail with 42501 (reported per row, no data harm, but nothing moves).
--
-- Re-runnable: update by key, drop ... if exists, create or replace.
-- Undo: re-apply the function and trigger from 20261111220000 and drop this one's.

-- The edge's note names the new guard and both reasons, for the next reader of the graph.
update public.application_status_transitions
   -- Same agents as 20261111220000 (human + auditor); only the note changes.
   set note = 'Human declined (drop_reason carries why; a human is the last filter in the cascade). '
           || 'Since 2026-11-11 the auditor may also take it, ONLY with drop_reason work_auth or (since 2026-11-21) '
           || 'already_applied (guard_auditor_queue_drop_reason): no-judgement re-checks of the queue.'
 -- Exactly the one edge.
 where from_status = 'awaiting_approval' and to_status = 'dropped_filter';

-- The old trigger goes first, so no window exists where both or neither guard the edge inside this transaction.
drop trigger if exists guard_auditor_queue_drop_work_auth_only on public.applications;
-- Its function, now unused.
drop function if exists public.guard_auditor_queue_drop_work_auth_only();

-- The narrowing check. Reads the acting agent the RPC sets for this transaction (advance_application_status).
create or replace function public.guard_auditor_queue_drop_reason()
  -- A trigger function.
  returns trigger
  -- Plain SQL-level checks, no privileges needed beyond the row.
  language plpgsql
  -- Fixed search_path, so no caller can shadow a name.
  set search_path = ''
as $$
begin
  -- Only the auditor's move off the approval queue is narrowed; every other move passes through untouched.
  if old.status = 'awaiting_approval'
     and new.status = 'dropped_filter'
     and pg_catalog.current_setting('applyy.acting_agent', true) = 'auditor'
     -- The closed list of no-judgement reasons; a null reason is refused too (coalesce to '').
     and coalesce(new.drop_reason, '') not in ('work_auth', 'already_applied') then
    -- 42501, the code the transition guard uses for a wrong agent, so callers treat it as "not allowed".
    raise exception 'the auditor may drop an awaiting_approval row only for work_auth or already_applied (drop_reason %)', coalesce(new.drop_reason, 'null')
      using errcode = '42501';
  end if;
  -- Allowed.
  return new;
end;
$$;

-- Re-runnable: drop then create (bare create trigger has no if-not-exists).
drop trigger if exists guard_auditor_queue_drop_reason on public.applications;
-- BEFORE UPDATE OF status, so the check sees the drop_reason the row will hold.
create trigger guard_auditor_queue_drop_reason
  before update of status on public.applications
  -- Per row: the check reads old and new.
  for each row execute function public.guard_auditor_queue_drop_reason();
