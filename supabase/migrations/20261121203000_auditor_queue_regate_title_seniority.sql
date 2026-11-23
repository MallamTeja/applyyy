-- The auditor may also drop an awaiting_approval row for a senior grade, drop_reason 'title_seniority' (2026-11-21).
--
-- WHY THIS EXISTS: Teja ruled at 20:12 IST on 2026-11-21, choosing one of three proposed screen rules: "Drop AVP/VP/Director".
-- The rule lives in _shared/screen/tech-gate.ts (seniorityGradeDrop): a grade word in the title (AVP, VP, Vice
-- President, SVP/EVP, Director, Head of, Intermediate) or an explicit grade LINE in the description ("Assistant Vice
-- President Expectations", "Corporate Title: VP"). The screener, matcher and auditor `tailored` check already drop on it
-- through screenTechRole. The approval-queue re-gate (auditor/regate-queue.ts, ?mode=regate_queue) now asks it too, so
-- rows that reached the queue before the rule existed leave it (Barclays AI Engineer afe8985b and Data Analyst 9ae9a866
-- were the evidence). 20261121110000's trigger allows only work_auth and already_applied from the auditor on this edge,
-- so without this migration every such drop fails with 42501.
--
-- WHY THIS IS TEJA'S CALL, NOT A WIDENING BY STEALTH: the 11-11 rule keeps judgement drops with a human. This value is
-- added because Teja himself ruled the drop (20:12). experience_ceiling stays OUT (orch ruling A, 2026-11-21): the sweep
-- still only reports it.
--
-- DEPLOY ORDER: this migration BEFORE the auditor that writes drop_reason 'title_seniority'. The other order makes every
-- queue seniority drop fail with 42501 (reported per row, no data harm, but nothing moves).
--
-- Re-runnable: update by key, then create or replace (the trigger from 20261121110000 calls the function by name).
-- Undo: re-apply the function from 20261121110000 (the trigger itself is unchanged).

-- The edge's note names all three reasons, for the next reader of the graph.
update public.application_status_transitions
   -- Same agents as before (human + auditor); only the note changes.
   set note = 'Human declined (drop_reason carries why; a human is the last filter in the cascade). '
           || 'Since 2026-11-11 the auditor may also take it, ONLY with drop_reason work_auth, (since 2026-11-21) '
           || 'already_applied, or (since 2026-11-21, Teja 20:12) title_seniority (guard_auditor_queue_drop_reason).'
 -- Exactly the one edge.
 where from_status = 'awaiting_approval' and to_status = 'dropped_filter';

-- The narrowing check, with one more allowed value. Same name, so the existing trigger keeps calling it.
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
     -- The closed list; a null reason is refused too (coalesce to '').
     and coalesce(new.drop_reason, '') not in ('work_auth', 'already_applied', 'title_seniority') then
    -- 42501, the code the transition guard uses for a wrong agent, so callers treat it as "not allowed".
    raise exception 'the auditor may drop an awaiting_approval row only for work_auth, already_applied or title_seniority (drop_reason %)', coalesce(new.drop_reason, 'null')
      using errcode = '42501';
  end if;
  -- Allowed.
  return new;
end;
$$;
