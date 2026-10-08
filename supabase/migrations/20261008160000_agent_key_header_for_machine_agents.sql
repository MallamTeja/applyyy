-- =============================================================================
-- Agent key: only a caller that proves it is a machine may claim a machine agent.
--
-- THE HOLE (CLAUDE.md §8 "Security gaps, ruled to be fixed 2026-09-17"; decided as
-- option A by Teja 2026-10-08). advance_application_status trusts p_agent. Every
-- edge function, the worker and the browser sign in as the SAME auth user
-- (createAppUserClient; "one credential pair", PROGRESS.md:509-530), so no JWT or
-- role check can tell 'auditor' from a browser tab. A browser could forge an audit
-- verdict or claim 'applier'.
--
-- THE FIX. Machine clients send header `x-applyy-agent-key: <secret>`. PostgREST
-- (14.5 live) exposes request headers as the JSON GUC `request.headers`. This file
-- stores only the SHA-256 of the secret, in applyy_internal (not exposed through the
-- API; supabase/config.toml:27), and advance_application_status refuses any p_agent
-- other than 'human' unless the header hashes to it.
--
-- WHY ENFORCEMENT WAITS FOR A ROW. The table ships EMPTY, and an empty table means
-- "not configured": machine claims pass with a WARNING, which is exactly today's
-- behaviour. So every step of the rollout is independently safe:
--   1. db push (this file)        -> nothing changes, warnings start
--   2. deploy clients sending it  -> nothing changes (header ignored while unseeded)
--   3. set APPLYY_AGENT_KEY secrets -> clients now send the real key
--   4. seed the hash (live write)  -> enforcement ON
-- Steps 1-3 can happen in any order without breaking production (timestamp order already
-- puts this file after 20261008130000). Step 4 before step 3 WOULD lock out every machine
-- agent with 42501, which is why seeding is last. Rotation is a hard cutover (one hash,
-- no overlap): set the new secret everywhere, then update the row, expecting failures
-- in between.
--
-- WHAT THIS FILE DELIBERATELY DOES NOT CONTAIN: the hash. Seeding it is a live-data
-- write run by the session that heard Teja approve it (CLAUDE.md §2).
--
-- NOT COVERED, reported separately: release_application_claim(uuid, agent_name, text)
-- and claim_applications(..., p_claimed_by text) also accept a caller-named identity.
--
-- WRITTEN, NOT APPLIED. Must run after 20261008130000, whose 5-arg function body is
-- copied here verbatim; every change is tagged NEW-AGENTKEY.
-- =============================================================================

-- The stored hash. A singleton: one secret for all machine agents, matching the one
-- credential pair they already share. The boolean key makes a second row impossible.
create table applyy_internal.agent_key (
  -- Always true; with the CHECK it caps the table at one row, so rotation is an UPDATE.
  singleton boolean primary key default true check (singleton),
  -- Lowercase hex SHA-256 of the secret's UTF-8 bytes. The shape check refuses a pasted
  -- secret (wrong length/alphabet), which would otherwise silently lock every agent out.
  key_sha256 text not null check (key_sha256 ~ '^[0-9a-f]{64}$'),
  -- When it was seeded or rotated, for whoever has to answer "which key is live".
  updated_at timestamptz not null default now()
);

-- Nobody but the owner reads or writes it: the DEFINER helper below is the only reader,
-- and seeding runs as postgres. A new table in a non-public schema has no API grants,
-- but stating it makes the intent survive a future default-privilege change.
revoke all on table applyy_internal.agent_key from public, anon, authenticated;

-- Defence in depth: if a later migration ever grants on this table by mistake, RLS with no
-- policies still returns zero rows to every non-owner role. The owner (postgres) and the
-- DEFINER helper it owns are unaffected.
alter table applyy_internal.agent_key enable row level security;

-- How the current request stands: 'unconfigured' (no row), 'missing' (no header),
-- 'valid' or 'invalid'. Returns a word, never the hash, so it leaks nothing.
create function applyy_internal.agent_key_state()
-- A closed vocabulary of four words; the caller branches on it.
returns text
-- plpgsql rather than SQL, for the early returns below.
language plpgsql
-- STABLE: same request, same answer; it reads a GUC and one row.
stable
-- DEFINER, owned by postgres: the only way an `authenticated` caller can reach the
-- hash, and it only ever learns the comparison result.
security definer
-- Empty search_path: every reference below is schema-qualified, so a caller cannot
-- shadow sha256/convert_to with its own functions (the classic DEFINER hijack).
set search_path = ''
as $$
declare
  -- The stored hash, or null when nothing is seeded.
  v_stored text;
  -- The raw header, or null when absent.
  v_presented text;
begin
  -- At most one row by construction.
  select k.key_sha256 into v_stored from applyy_internal.agent_key k;
  -- No row: enforcement is off. Checked first so an unseeded system never inspects headers.
  if v_stored is null then
    return 'unconfigured';
  end if;
  -- PostgREST sets this per request with lowercased names. Outside PostgREST (a direct SQL
  -- session, a migration) it is unset or '', and nullif makes '' parse as null, not fail.
  v_presented := (nullif(pg_catalog.current_setting('request.headers', true), '')::json) ->> 'x-applyy-agent-key';
  -- Absent or blank is "missing": a distinct word so the refusal says what was wrong.
  if coalesce(v_presented, '') = '' then
    return 'missing';
  end if;
  -- Hash what was presented and compare hashes, so the plaintext secret never sits in
  -- the database and equal-length hex strings are compared.
  if pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(v_presented, 'UTF8')), 'hex') = v_stored then
    return 'valid';
  end if;
  -- Present but wrong: refused by the caller.
  return 'invalid';
end;
$$;

-- Callable only by the roles that call advance_application_status (it is INVOKER, so the
-- check runs as the caller). PUBLIC's default EXECUTE is removed first.
revoke all on function applyy_internal.agent_key_state() from public, anon;
-- The browser and every machine agent sign in as `authenticated`.
grant execute on function applyy_internal.agent_key_state() to authenticated, service_role;

-- An INVOKER function can only call the helper if the caller may look inside the schema.
-- Safe to grant: live recon 2026-10-08 found only TRIGGER functions in applyy_internal,
-- which Postgres refuses to call directly, plus this helper and a table with no grants.
grant usage on schema applyy_internal to authenticated, service_role;

-- So the next function anyone adds here does not silently become PUBLIC-executable now
-- that the schema is reachable: new functions default to no EXECUTE for PUBLIC.
alter default privileges in schema applyy_internal revoke execute on functions from public;

-- The status function, with the agent-key check added. CREATE OR REPLACE with the SAME
-- 5-arg signature as 20261008130000, so its grants (authenticated, service_role; no anon)
-- and comment are kept.
create or replace function public.advance_application_status(
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

-- No PostgREST cache reload needed: the signature is unchanged.
