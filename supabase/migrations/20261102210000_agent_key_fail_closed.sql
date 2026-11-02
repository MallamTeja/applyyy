-- =============================================================================
-- 20261102210000_agent_key_fail_closed.sql: W18 (wiring audit 2026-11-01)
--
-- WHY THIS EXISTS. applyy_internal.agent_key_state() returned 'unconfigured' whenever the
-- key table was empty, and every caller treats that word as "allowed, with a WARNING":
--   advance_application_status, claim_applications, release_application_claim and
--   sweep_stale_claims (`if v_key_state = 'unconfigured' then raise warning`), plus the
--   application_events policy "append own events" (`= any ('valid','unconfigured')`).
-- So emptying the table, by mistake, by a bad rotation script or by anyone who can
-- delete one row, silently switched the machine-agent gate OFF. The key has been seeded
-- since 2026-10-09, so "no key" no longer means "not set up yet"; it means something is
-- wrong, and the gate must refuse.
--
-- THE FIX, AT THE ONE POINT EVERY CALLER ROUTES THROUGH. Only agent_key_state() changes.
-- With the table empty it now returns 'unconfigured_locked', which every caller above
-- refuses (it is not 'valid' and not 'unconfigured'), unless the new emergency flag is on,
-- in which case it returns 'unconfigured' and the old allow-with-warning path runs. The
-- five callers and the policy are NOT redefined: their branches already refuse any word
-- but those two, so the smallest correct change is to stop producing the permissive word.
-- stamp_answer_attestation() is unaffected: it marks a row human only on 'missing'.
--
-- THE EMERGENCY FLAG IS NOW THE ONLY WAY TO RUN AGENTS WITHOUT THE KEY. It is read ONLY
-- when the key table is empty, so it can never weaken a seeded key: opening the hole takes
-- two deliberate statements, not one. It lives in applyy_internal with no API grants,
-- because a flag in system_settings would be writable by the very `authenticated` JWT the
-- agents hold, and an agent could then switch its own gate off.
--
-- This INVERTS the kill switch CLAUDE.md §7 documents ("delete from applyy_internal.agent_key
-- reopens that hole"): after this migration that delete LOCKS every machine agent out.
--
-- HOW TO FLIP IT (run as the owner: `supabase db query --linked` or the MCP execute_sql):
--   Emergency ON (agents may write without the key; each call still raises a WARNING):
--     delete from applyy_internal.agent_key;
--     update applyy_internal.agent_key_emergency set allow_unkeyed_agents = true, updated_at = now();
--   Back to normal (re-seed the key, then close the flag):
--     insert into applyy_internal.agent_key (key_sha256)
--       values ('173cffbd0242d72a9d5bb98b993637269d4a3ea0f4e8217686a4e8bc3850d9ce')
--       on conflict (singleton) do update set key_sha256 = excluded.key_sha256, updated_at = now();
--     update applyy_internal.agent_key_emergency set allow_unkeyed_agents = false, updated_at = now();
--
-- RE-RUNNABLE: create table if not exists, insert ... on conflict do nothing, create or
-- replace, and revoke/grant are all idempotent. Deploy order: edge functions do not read
-- this flag, so nothing has to ship before or after it; the seeded-key path is byte-for-byte
-- the live body (pre-flight read 2026-11-02 via pg_get_functiondef), so with the key seeded
-- no request changes behaviour.
--
-- WRITTEN, NOT APPLIED. Verification queries are at the bottom of this file.
-- =============================================================================

-- The emergency flag. A singleton, like applyy_internal.agent_key, so there is exactly one
-- answer to "is the gate open?" and flipping it is an UPDATE.
create table if not exists applyy_internal.agent_key_emergency (
  -- Always true; with the CHECK it caps the table at one row.
  singleton boolean primary key default true check (singleton),
  -- Off by default: the gate is closed unless someone deliberately opens it.
  allow_unkeyed_agents boolean not null default false,
  -- When it was last flipped, for whoever has to answer "since when has the gate been open".
  updated_at timestamptz not null default now()
);

-- Nobody but the owner reads or writes it; the DEFINER function below is its only reader.
-- service_role is included because the flag must be flipped by the owner on purpose, never
-- by a key that some job happens to hold.
revoke all on table applyy_internal.agent_key_emergency from public, anon, authenticated, service_role;

-- Defence in depth, as on agent_key: if a later migration grants on this table by mistake,
-- RLS with no policies still returns zero rows to every non-owner role.
alter table applyy_internal.agent_key_emergency enable row level security;

-- The row, explicitly off, so a SELECT shows the state instead of an empty table. A missing
-- row reads as off too (the coalesce below), so deleting it can never open the gate.
insert into applyy_internal.agent_key_emergency (singleton, allow_unkeyed_agents)
values (true, false)
-- Re-runnable, and never resets a flag someone has deliberately turned on.
on conflict (singleton) do nothing;

-- The live function, redefined with one change, tagged NEW-W18. Same signature, so every
-- caller and the policy pick it up without being touched.
create or replace function applyy_internal.agent_key_state()
-- A closed vocabulary; the callers branch on it. Now five words: 'unconfigured_locked' added.
returns text
-- plpgsql rather than SQL, for the early returns below.
language plpgsql
-- STABLE: same request, same answer; it reads a GUC and two singleton rows.
stable
-- DEFINER, owned by postgres: the only way an `authenticated` caller can reach the hash or
-- the flag, and it only ever learns a word.
security definer
-- Empty search_path: every reference below is schema-qualified, so a caller cannot shadow
-- sha256/convert_to with its own functions (the classic DEFINER hijack).
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
  -- No row. NEW-W18: this used to return 'unconfigured' (allowed) unconditionally.
  if v_stored is null then
    -- The emergency flag, and only it, keeps the old allow-with-warning behaviour. A missing
    -- flag row is "off" (coalesce), so the gate fails closed on every absence.
    if coalesce((select e.allow_unkeyed_agents from applyy_internal.agent_key_emergency e), false) then
      -- Every caller warns and allows on this word: the deliberate, visible emergency mode.
      return 'unconfigured';
    end if;
    -- Every caller refuses this word with 42501, the same as a missing or wrong key.
    return 'unconfigured_locked';
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

-- Restated, though create or replace keeps grants: the live ACL (2026-11-02) is postgres,
-- authenticated and service_role, and a re-run must leave exactly that.
revoke all on function applyy_internal.agent_key_state() from public, anon;
-- The browser and every machine agent sign in as `authenticated`; the callers are INVOKER.
grant execute on function applyy_internal.agent_key_state() to authenticated, service_role;

-- =============================================================================
-- VERIFICATION, for the orchestrator after `db push` (expected results on the right).
--
-- Read-only:
--   select position('unconfigured_locked' in prosrc) > 0 as fail_closed_live
--     from pg_proc where oid = 'applyy_internal.agent_key_state()'::regprocedure;      -- true
--   select allow_unkeyed_agents from applyy_internal.agent_key_emergency;               -- false (1 row)
--   select count(*) from applyy_internal.agent_key;                                     -- 1
--   select applyy_internal.agent_key_state();             -- 'missing' (seeded; SQL sends no header)
--   select has_table_privilege('authenticated', 'applyy_internal.agent_key_emergency', 'update'),
--          has_table_privilege('anon', 'applyy_internal.agent_key_emergency', 'select'),
--          has_function_privilege('anon', 'applyy_internal.agent_key_state()', 'execute'),
--          has_function_privilege('authenticated', 'applyy_internal.agent_key_state()', 'execute');
--                                                                       -- false, false, false, true
--
-- Both directions. These WRITE inside a transaction that is rolled back; other sessions keep
-- seeing the committed key row throughout (MVCC), but it is still a live write, so it is the
-- orchestrator's call. Run as one script (-f), not statement by statement:
--   begin;
--   delete from applyy_internal.agent_key;
--   select applyy_internal.agent_key_state() as empty_flag_off;   -- 'unconfigured_locked' (refused)
--   update applyy_internal.agent_key_emergency set allow_unkeyed_agents = true;
--   select applyy_internal.agent_key_state() as empty_flag_on;    -- 'unconfigured' (allowed + WARNING)
--   rollback;
--   select count(*) from applyy_internal.agent_key;               -- 1 again
--   select allow_unkeyed_agents from applyy_internal.agent_key_emergency;  -- false again
-- =============================================================================
