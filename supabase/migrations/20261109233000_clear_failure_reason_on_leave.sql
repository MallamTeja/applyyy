-- 20261109233000_clear_failure_reason_on_leave.sql
--
-- WHY THIS EXISTS: a row that leaves `failed` kept its old applications.failure_reason. On 2026-11-09 23:15 IST, 213
-- non-failed rows still carried one: 212 dropped_filter rows reading 'missing_description' and 05b45e3f (dropped on
-- title_seniority) reading 'tailor_validation_failed'. Every one went failed -> passed_filters (a human re-run) ->
-- dropped_filter, so the column described a failure the row no longer has. Anyone filtering on failure_reason
-- miscounts them.
--
-- WHAT CHANGES: one CASE arm in advance_application_status. `else a.failure_reason` becomes `else null`, so after
-- ANY status move failure_reason is non-null exactly when the row is failed. That is wider than "leaving failed": it
-- also cleans a reason that a writer set before a ->failed move that then never happened.
--
-- WHY NOT A CHECK (failure_reason null unless failed): three writers set failure_reason in a separate UPDATE BEFORE
-- their guarded ->failed move (tailor/persist.ts, matcher/fail-exit.ts, screen/persist-verdict.ts). A CHECK would
-- refuse that first write. The constraint applications_failed_has_reason (20261109211000) keeps the other direction.
--
-- READERS CHECKED (23:20 IST): the only consumer outside the function is RecoveryQueue.queueReason (apps/web), which
-- reads it only when status = 'failed'. There are no views. The DB functions that mention it are this function and
-- applyy_internal.log_status_change (an event snapshot). Nothing reads it on a non-failed row.
--
-- HISTORY IS NOT LOST: application_events is append-only. The ->failed move's note event keeps p_detail.reason, and
-- every status_change event snapshots the row's failure_reason at the time.
--
-- RE-CREATED FROM THE LIVE DEFINITION (pg_get_functiondef, 2026-11-09 23:20 IST), never from an older migration file,
-- so the agent-key check, the updated_at CAS and every later guard are carried over verbatim. CREATE OR REPLACE with
-- the identical signature keeps the grants and creates no second overload.
--
-- BACK-FILL: not in this file. The orchestrator runs it separately (peer 3 bridge, task 5). Re-runnable: CREATE OR
-- REPLACE.

CREATE OR REPLACE FUNCTION public.advance_application_status(p_application_id uuid, p_to_status application_status, p_agent agent_name, p_detail jsonb DEFAULT '{}'::jsonb, p_expected_updated_at timestamp with time zone DEFAULT NULL::timestamp with time zone)
 RETURNS applications
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare
  -- Unchanged: the moved row, returned to the caller.
  v_row public.applications;
  -- Unchanged (from 200000): the status as it stands once this transaction holds the row lock.
  v_current public.application_status;
  -- Unchanged (from 220000): the validated reason. Stays null for every target except blocked_needs_human.
  v_block_reason public.block_reason;
  -- NEW-1008: updated_at read under the same lock, so the comparison cannot race.
  v_updated_at timestamptz;
  -- NEW-AGENTKEY: whether this request proved it is a machine agent (see the helper).
  v_key_state text;
begin
  -- Declare who is acting. The third argument `true` scopes this to the current
  -- TRANSACTION, so it cannot leak into the next statement on a pooled connection —
  -- which, with PgBouncer in front of Supabase, is not a theoretical concern.
  perform pg_catalog.set_config('applyy.acting_agent', p_agent::text, true);

  -- NEW-AGENTKEY — WHO MAY CLAIM A MACHINE AGENT. Every caller signs in as the same user,
  -- so the JWT cannot tell the browser from the auditor. The agent key header can: machine
  -- clients send it, the browser bundle never contains it. Checked FIRST, before any row
  -- is read or locked, so a refused claim costs nothing and touches nothing.
  -- 'human' needs no key: it is the one identity the browser legitimately holds.
  if p_agent <> 'human' then
    -- One call; the helper is SECURITY DEFINER because only it may read the stored hash.
    v_key_state := applyy_internal.agent_key_state();
    -- No hash stored yet: enforcement is OFF, exactly today's behaviour. This is what
    -- makes every deploy order safe; the warning keeps the gap visible in the logs.
    if v_key_state = 'unconfigured' then
      -- WARNING, not exception: the system must keep working until the hash is seeded.
      raise warning 'agent key not configured: % claimed without proof (enforcement off until applyy_internal.agent_key is seeded)', p_agent;
    -- Configured, and this request did not carry the matching key: refuse the claim.
    elsif v_key_state <> 'valid' then
      -- 42501 insufficient_privilege, the same code the guard uses for a wrong agent, so
      -- callers already treat it as "not allowed", never as retryable.
      raise exception 'agent % requires a valid x-applyy-agent-key header (%); a browser session may only act as human', p_agent, v_key_state
        using errcode = '42501';
    end if;
  end if;

  -- Unchanged (220000) — VALIDATE THE REASON BEFORE TOUCHING THE ROW. This runs before the
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

  -- NEW-FAILREASON (2026-11-09) — A FAILED ROW MUST SAY WHY. Before this, the reason lived only in the note event
  -- written below, and applications.failure_reason was set only by writers that did a separate UPDATE first: 37 of
  -- 91 failed rows had it null on 2026-11-09 (the auditor and every human/SQL move never wrote it). Validated before
  -- the lock, like block_reason, so bad input fails fast and holds nothing. The key is `reason`: every agent and
  -- human →failed move in history sent exactly that key (matcher 397/397, tailor 45/45, auditor 1/1, human 16/19;
  -- the 3 others came from the health page, fixed in the same commit as this migration).
  if p_to_status = 'failed' and coalesce(pg_catalog.btrim(p_detail->>'reason'), '') = '' then
    -- 22023 invalid_parameter_value, the code block_reason uses: the caller's input is wrong, a retry fails the same way.
    raise exception 'p_detail.reason is required when moving to failed (it becomes applications.failure_reason)'
      using errcode = '22023';
  end if;

  -- THE DOUBLE-SUBMIT GATE (unchanged from 200000). The guard trigger returns early when status is
  -- unchanged (status_transition_guard.sql:200), so applying -> applying passes
  -- it. Two runners racing approved -> applying would both "succeed" and both
  -- submit, violating constraint #7. FOR UPDATE serialises them: the second waits
  -- for the first to commit, then re-reads and sees `applying`.
  -- Not found (or not ours) leaves v_current null and falls through to the
  -- existing P0002 below, so that error is unchanged.
  -- NEW-1008: updated_at is read in the same locked SELECT, so nothing can change the
  -- row between this read and the UPDATE below.
  select a.status, a.updated_at
    into v_current, v_updated_at
    from public.applications a
   where a.id = p_application_id
     for update;

  -- NEW-1008 — THE STALE-READ GATE. Only when the caller asked for it, and only for a
  -- row that exists: a missing row must still raise P0002 below, not a misleading
  -- conflict. It sits before the applying gate but skips applying -> applying, so a
  -- second submitter still gets the more specific 55000. Exact equality, because both sides
  -- are the same timestamptz value round-tripped through PostgREST at microsecond
  -- precision.
  if p_expected_updated_at is not null
     and v_current is not null
     and v_updated_at is distinct from p_expected_updated_at
     and not (v_current = 'applying' and p_to_status = 'applying') then
    -- PT409: PostgREST maps a PTxxx SQLSTATE to that HTTP status, so the browser sees
    -- 409 Conflict with this message, and it is distinct from every code this function
    -- already raises (22023, 55000, P0002, and the guard's 42501). A retry with the
    -- same stamp fails the same way; the caller must re-read and re-decide.
    raise exception 'application % changed since it was read (expected updated_at %, now %); re-read before moving it',
      p_application_id, p_expected_updated_at, v_updated_at
      using errcode = 'PT409';
  end if;

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
         -- Unchanged (220000): set the reason in the SAME statement as the status, which is
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
         -- Unchanged (220000): the full p_detail becomes the row's block context (screenshot
         -- path, unanswered questions, question_key), so the dashboard can read it
         -- from the row without searching application_events. Kept on exit for the
         -- same history reason as block_reason.
         block_detail = case
           when p_to_status = 'blocked_needs_human' then p_detail
           else a.block_detail
         end,
         -- NEW-FAILREASON: the cause lands on the row in the SAME statement as the status, so no reader ever sees a
         -- failed row without one.
         -- NEW-CLEARREASON (20261109233000): every move to a NON-failed status clears it, in this same statement. A
         -- re-run row used to keep its last failure (213 stale rows on 2026-11-09, e.g. a dropped_filter row reading
         -- tailor_validation_failed), and no reader uses it outside failed. The history keeps it: the ->failed move's
         -- note event below holds p_detail.reason. Writers that set failure_reason BEFORE a ->failed move (tailor
         -- persist, matcher fail-exit, screener persist-verdict) are unaffected: their move targets failed.
         failure_reason = case
           when p_to_status = 'failed' then p_detail->>'reason'
           else null
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
$function$;
