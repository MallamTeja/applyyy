-- The auditor may drop an awaiting_approval row, for work authorisation ONLY (Teja, 2026-11-11).
--
-- WHY THIS EXISTS: gates ran once, on the way in, so a row that passed an older gate waited for Teja forever. On
-- 2026-11-11 he found 11 foreign jobs in his queue (Budapest, Frankfurt, Palo Alto, NAMER...), all queued before the
-- place-table fix c22d0d0, and asked for the system to filter them, not him. The auditor's new `?mode=regate_queue`
-- (auditor/regate-queue.ts) runs today's work-auth gate over the queue after every drain; it needs this edge.
--
-- WHY THE EXTRA TRIGGER: until now `awaiting_approval -> dropped_filter` was human-only ("a human is the last filter").
-- Opening it to an agent for everything would let any auditor bug empty the queue. The trigger below keeps the door
-- narrow in the database itself: the auditor may take this edge ONLY when the row's drop_reason is 'work_auth', the one
-- gate with no judgement in it. Every other reason still needs a human. `approved` rows are untouched (no new edge).
--
-- Undo: set allowed_agents back to '{human}' and drop the trigger + function.

-- The edge: human as before, plus the auditor.
update public.application_status_transitions
   -- Human keeps the edge; the auditor joins it.
   set allowed_agents = array['human', 'auditor']::public.agent_name[],
       -- The note says who may use it and how narrowly, for the next reader of the graph.
       note = 'Human declined (drop_reason carries why; a human is the last filter in the cascade). '
           || 'Since 2026-11-11 the auditor may also take it, ONLY with drop_reason = work_auth '
           || '(guard_auditor_queue_drop_work_auth_only): today''s work-auth gate re-run over the queue.'
 -- Exactly the one edge.
 where from_status = 'awaiting_approval' and to_status = 'dropped_filter';

-- The narrowing check. Reads the acting agent the RPC sets for this transaction (advance_application_status).
create or replace function public.guard_auditor_queue_drop_work_auth_only()
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
     and coalesce(new.drop_reason, '') <> 'work_auth' then
    -- 42501, the code the transition guard uses for a wrong agent, so callers treat it as "not allowed".
    raise exception 'the auditor may drop an awaiting_approval row only for work_auth (drop_reason %)', coalesce(new.drop_reason, 'null')
      using errcode = '42501';
  end if;
  -- Allowed.
  return new;
end;
$$;

-- Re-runnable: drop then create (bare create trigger has no if-not-exists).
drop trigger if exists guard_auditor_queue_drop_work_auth_only on public.applications;
-- BEFORE UPDATE OF status, so the check sees the drop_reason the row will hold.
create trigger guard_auditor_queue_drop_work_auth_only
  before update of status on public.applications
  -- Per row: the check reads old and new.
  for each row execute function public.guard_auditor_queue_drop_work_auth_only();
