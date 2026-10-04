-- =============================================================================
-- advance_application_status() sets block_reason when it parks a row
-- =============================================================================
-- WHY THIS EXISTS
-- core_tables.sql:399-401 says a row at `blocked_needs_human` must have a
-- non-null `block_reason` (applications_blocked_has_reason). Every write to that
-- status goes through advance_application_status(), and that function never wrote
-- block_reason. So EVERY park was refused by the CHECK:
--   * worker/src/apply-one.ts (applying -> blocked_needs_human) passes the reason
--     in p_detail.block_reason. The function only logged it as a 'note' event and
--     never put it on the row, so the CHECK failed.
--   * worker/src/assist/ worked around it with a separate bare UPDATE of
--     block_reason before the status move. That is two statements where one is
--     needed, plus a write that does not go through the guarded RPC.
-- 20260910190000:314-318 already said the reason must be set in the SAME
-- statement as the status. This migration makes the function do that.
--
-- NO DEFAULT REASON. A missing or unknown p_detail.block_reason raises 22023 and
-- the row does not move. Making up 'other' would turn missing data into an answer
-- the dashboard shows as fact. That is the fail-open CLAUDE.md §5 forbids.
--
-- BASE BODY: 20261004200000_fix_phase3_regressions.sql, copied VERBATIM except the
-- blocks marked NEW-220000. `create or replace` replaces the whole body, so leaving
-- out that migration's FOR UPDATE lock or its 55000 raise would silently bring back
-- the double-submit hole. Signature, security mode (invoker, the default), and
-- search_path are unchanged.
--
-- GRANTS: 20261004200000 issues no revoke/grant for this function, and neither
-- does any earlier migration. A `create or replace` with the same signature keeps
-- existing privileges, so this file issues none either. Adding grants here would
-- change access, which is not what this migration is for.
--
-- WRITTEN, NOT APPLIED. 20261004200000 and 20261004210000 are also unapplied. This
-- one must run after 200000 (it redefines the body 200000 sets) and sorts after it.
-- =============================================================================

-- Same signature as 20261004200000, so this replaces the function in place and keeps its grants.
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
  -- Unchanged (from 200000): the status as it stands once this transaction holds the row lock.
  v_current public.application_status;
  -- NEW-220000: the validated reason. Stays null for every target except blocked_needs_human.
  v_block_reason public.block_reason;
begin
  -- Declare who is acting. The third argument `true` scopes this to the current
  -- TRANSACTION, so it cannot leak into the next statement on a pooled connection —
  -- which, with PgBouncer in front of Supabase, is not a theoretical concern.
  perform pg_catalog.set_config('applyy.acting_agent', p_agent::text, true);

  -- NEW-220000 — VALIDATE THE REASON BEFORE TOUCHING THE ROW. This runs before the
  -- lock on purpose, so bad input fails fast and never holds a row lock.
  -- Only the park needs a reason. Other targets ignore p_detail.block_reason.
  if p_to_status = 'blocked_needs_human' then
    -- Missing key, JSON null and empty string all mean "no reason given". Refuse
    -- them here so they never reach the cast. An empty string would also fail the
    -- cast, but this message is clearer.
    if coalesce(p_detail->>'block_reason', '') = '' then
      -- 22023 invalid_parameter_value: the caller's input is wrong, so a retry with
      -- the same input fails the same way. The message lists the allowed values so
      -- the caller can fix it without opening the enums migration.
      raise exception 'p_detail.block_reason is required when moving to blocked_needs_human; allowed: %',
        pg_catalog.array_to_string(pg_catalog.enum_range(null::public.block_reason)::text[], ', ')
        using errcode = '22023';
    end if;

    -- Check the value with the enum cast itself. That way the allowed set has one
    -- source (enums.sql), not a second copy in this function that could drift.
    begin
      -- Postgres raises 22P02 if the text is not an enum member.
      v_block_reason := (p_detail->>'block_reason')::public.block_reason;
    exception
      -- Catch only that error, so anything unexpected still surfaces as itself.
      when invalid_text_representation then
        -- Re-raise as 22023 with the bad value and the allowed list. The raw 22P02
        -- message ("invalid input value for enum") does not list the allowed values.
        raise exception 'p_detail.block_reason % is not a block_reason; allowed: %',
          pg_catalog.quote_literal(p_detail->>'block_reason'),
          pg_catalog.array_to_string(pg_catalog.enum_range(null::public.block_reason)::text[], ', ')
          using errcode = '22023';
    end;
  end if;

  -- THE DOUBLE-SUBMIT GATE (unchanged from 200000). The guard trigger returns early when status is
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
         claim_expires_at = null,
         -- NEW-220000: set the reason in the SAME statement as the status, which is
         -- what applications_blocked_has_reason requires (CHECKs run per row, per
         -- statement). If it were set in a second statement, the first one would
         -- already have failed.
         -- When LEAVING blocked_needs_human (or on any other move) the old reason is
         -- KEPT, not cleared. The CHECK is one-way on purpose (core_tables.sql:394-398):
         -- "a resolved row KEEPS its block_reason" so the health page can show what
         -- the row needed a human for. No other constraint requires null here.
         block_reason = case
           when p_to_status = 'blocked_needs_human' then v_block_reason
           else a.block_reason
         end,
         -- NEW-220000: the full p_detail becomes the row's block context (screenshot
         -- path, unanswered questions, question_key), so the dashboard can read it
         -- from the row without searching application_events. Kept on exit for the
         -- same history reason as block_reason.
         block_detail = case
           when p_to_status = 'blocked_needs_human' then p_detail
           else a.block_detail
         end
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
  -- Unchanged, so the event log still records each park even though the row now
  -- carries the same detail. The row holds only the latest block; the log keeps every one.
  if p_detail is not null and p_detail <> '{}'::jsonb then
    insert into public.application_events (user_id, application_id, event_type, agent, detail)
    values (v_row.user_id, v_row.id, 'note', p_agent, p_detail);
  end if;

  -- Unchanged.
  return v_row;
end;
$$;

-- Restates 200000's comment and adds the new contract, so callers can find it in the database.
comment on function public.advance_application_status(uuid, public.application_status, public.agent_name, jsonb) is
  'The only correct way to change status. Validates the edge, witnesses it, and releases the lease in one transaction. Refuses applying -> applying (55000) so two runners cannot both submit; every other same-status call is a no-op. Moving to blocked_needs_human REQUIRES p_detail.block_reason (a block_reason enum value; 22023 otherwise, never defaulted) and writes block_reason + block_detail in the same UPDATE; both are kept when the row leaves blocked_needs_human.';
