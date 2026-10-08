-- =============================================================================
-- advance_application_status: optimistic-concurrency guard, no anon EXECUTE,
-- and a truthful applications.master_version.
--
-- WHY THIS FILE EXISTS (three independent fixes, one push):
--
-- G2. RACE. A caller that read a row, showed it to a human, then moved it had no way
--     to say "only if nobody changed it meanwhile". The approval page can approve a
--     resume that an edit in another tab replaced a second earlier. New optional
--     parameter p_expected_updated_at: when NON-NULL and not equal to the row's
--     updated_at (read under the row lock), the move is refused with SQLSTATE PT409,
--     which PostgREST turns into HTTP 409 Conflict. DEFAULT NULL keeps all 15
--     existing callers (named args only, recon 2026-10-08) behaving exactly as before.
--     Note: set_updated_at bumps updated_at on EVERY update, including lease claims,
--     so a value held for a long time WILL go stale. That is the point for a human
--     approving what they saw; machine callers should keep passing nothing.
--
-- G1 (partial). The function is executable by PUBLIC and anon (live proacl
--     2026-10-08: {=X, anon=X, authenticated=X, service_role=X}) and no migration ever
--     granted or revoked it. Nothing calls it signed-out (the only signed-out client,
--     rls-proof, reads company_watchlist), so anon access is pure exposure. Revoked
--     here. The larger G1 problem, that any signed-in session can CLAIM a machine
--     agent, is NOT fixed here: every machine agent signs in as the same user as the
--     browser, so no role check can tell them apart. That needs a separate decision.
--
-- G3. PIN COLUMN. applications.master_version (core_tables.sql:341, FK to
--     master_profiles(user_id, version)) was never written: null on every live row,
--     while the real pin lives in tailored_profile->>'master_version' (stamped by the
--     tailor's validator, validator.ts:776). The tailor now writes the column
--     (_shared/tailor/persist.ts) and this file backfills existing rows, so the FK
--     finally guards something and readers stop falling back to JSON.
--
-- WHY DROP + CREATE, not CREATE OR REPLACE: adding a parameter changes the signature,
-- and CREATE OR REPLACE with a new signature makes a second OVERLOAD beside the old
-- one. PostgREST would then have two candidates for a 4-named-arg call. Dropping the
-- old one in the same transaction leaves exactly one function, and the drop takes its
-- grants with it, which is why the grants below are issued explicitly.
--
-- WRITTEN, NOT APPLIED. db push is Teja's. Must run after 20261004220000, whose body
-- this file copies; every change to that body is tagged NEW-1008.
-- =============================================================================

-- The old 4-arg signature. Same transaction as the create below, so no caller can
-- observe a moment with no function at all.
drop function public.advance_application_status(uuid, public.application_status, public.agent_name, jsonb);

-- The single remaining definition: 20261004220000's body plus the NEW-1008 guard.
create function public.advance_application_status(
  p_application_id uuid,
  p_to_status public.application_status,
  p_agent public.agent_name,
  p_detail jsonb default '{}'::jsonb,
  -- NEW-1008: the updated_at the caller last saw. NULL means "do not check", which is
  -- what every existing caller gets by not naming it.
  p_expected_updated_at timestamptz default null
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
  -- Unchanged (from 220000): the validated reason. Stays null for every target except blocked_needs_human.
  v_block_reason public.block_reason;
  -- NEW-1008: updated_at read under the same lock, so the comparison cannot race.
  v_updated_at timestamptz;
begin
  -- Declare who is acting. The third argument `true` scopes this to the current
  -- TRANSACTION, so it cannot leak into the next statement on a pooled connection —
  -- which, with PgBouncer in front of Supabase, is not a theoretical concern.
  perform pg_catalog.set_config('applyy.acting_agent', p_agent::text, true);

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

-- G1 (partial): a new function is executable by PUBLIC by default, and Supabase's
-- default privileges add anon too. Strip both, then grant back exactly the two roles
-- that call it today: signed-in sessions (every agent and the browser) and service_role.
revoke all on function public.advance_application_status(uuid, public.application_status, public.agent_name, jsonb, timestamptz) from public, anon;
-- Signed-in callers: the browser and every machine agent (all sign in as the app user).
grant execute on function public.advance_application_status(uuid, public.application_status, public.agent_name, jsonb, timestamptz) to authenticated;
-- Kept for parity with the previous grants; no code uses service_role today.
grant execute on function public.advance_application_status(uuid, public.application_status, public.agent_name, jsonb, timestamptz) to service_role;

-- The comment was keyed on the dropped signature, so it went with it; restated with
-- the new contract so callers can still find it in the database.
comment on function public.advance_application_status(uuid, public.application_status, public.agent_name, jsonb, timestamptz) is
  'The only correct way to change status. Validates the edge, witnesses it, and releases the lease in one transaction. Refuses applying -> applying (55000) so two runners cannot both submit; every other same-status call is a no-op. Moving to blocked_needs_human REQUIRES p_detail.block_reason (a block_reason enum value; 22023 otherwise, never defaulted) and writes block_reason + block_detail in the same UPDATE; both are kept when the row leaves blocked_needs_human. Optional p_expected_updated_at: when non-null and not the row''s current updated_at, refuses with PT409 (HTTP 409). Not executable by anon.';

-- G3 BACKFILL. A DO block so the matched and written counts can be reported: their
-- DIFFERENCE is the information (written = matched on a first run; written = 0 with
-- matched > 0 is impossible here because the WHERE excludes already-set rows).
do $$
declare
  -- Rows whose JSON pin has the shape of a real version: a JSON number that is a
  -- positive integer. Text-cast regex alone would accept the JSON string "2". At most 9
  -- digits, so the ::integer cast below can never overflow and abort the whole push.
  v_matched integer;
  -- Rows actually updated by this run.
  v_written integer;
begin
  -- Count first, with the same predicate as the UPDATE, so the notice is comparable.
  select count(*)
    into v_matched
    from public.applications a
   where a.master_version is null
     and pg_catalog.jsonb_typeof(a.tailored_profile->'master_version') = 'number'
     and (a.tailored_profile->>'master_version') ~ '^[1-9][0-9]{0,8}$';

  -- Only the column is SET. guard_tailored_profile_freeze is BEFORE UPDATE OF
  -- tailored_profile, so it does not fire on a frozen row here; the status guard
  -- returns early when status is unchanged (status_transition_guard.sql:200). The
  -- migration role bypasses RLS (rolbypassrls). set_updated_at WILL bump updated_at,
  -- which an open approval-editor tab sees as one harmless changed_elsewhere.
  -- The composite FK checks (user_id, version) exists; measured live 2026-10-08: 0
  -- rows would violate it. If a future row did, the push fails loudly rather than
  -- writing a pin to a master that does not exist.
  update public.applications a
     set master_version = (a.tailored_profile->>'master_version')::integer
   where a.master_version is null
     and pg_catalog.jsonb_typeof(a.tailored_profile->'master_version') = 'number'
     and (a.tailored_profile->>'master_version') ~ '^[1-9][0-9]{0,8}$';

  -- How many the UPDATE touched, for the notice.
  get diagnostics v_written = row_count;

  -- NOTICE, not exception: zero matches is news (nothing to backfill), not a failure.
  raise notice 'master_version backfill: matched %, written %', v_matched, v_written;
end;
$$;

-- PostgREST caches function signatures; tell it the 4-arg one is gone and the 5-arg
-- one exists, so the first call after the push does not hit a stale cache.
notify pgrst, 'reload schema';
