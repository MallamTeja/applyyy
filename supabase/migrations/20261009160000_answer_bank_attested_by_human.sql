-- =============================================================================
-- answer_bank.attested_by_human: which answers Teja himself saved.
--
-- WHY. The worker's form planner (worker/src/plan-fill.ts) refused every eligibility
-- question (located in, visa sponsorship, employment restrictions...) because nothing in
-- the schema could tell an answer Teja saved from one a machine wrote. On 2026-10-09 Teja
-- ruled that these may be answered automatically, but ONLY from his own stored answers.
-- This column is that witness. The planner fills an eligibility question only from a row
-- with attested_by_human = true AND needs_human = false. Anything else is refused.
--
-- WHO STAMPS IT: a BEFORE INSERT OR UPDATE trigger, never the client. Whatever the
-- client sends for attested_by_human is overwritten, so a caller cannot claim it.
-- attested = (agent_key_state() = 'missing' AND the request's JWT role = 'authenticated'):
--   'missing'      no x-applyy-agent-key header: a browser session (Teja in the console).
--                  Counted as human only with a signed-in user's JWT, so the SQL editor /
--                  MCP (no JWT claims) and service_role writes (role 'service_role'), which
--                  also send no key header, are NOT human.
--                  KNOWN GAP: a machine signed in as Teja that omits the key (worker assist
--                  with APPLYY_AGENT_KEY unset, assist.ts:100) still reads as human. No such
--                  path writes answer_bank today (recon 2026-10-09); making the key mandatory
--                  in assist closes it.
--   'valid'        the machine agent key: the worker or an edge function. NOT human.
--   'invalid'      a key header that doesn't match: still a machine (browsers never send
--                  this header), so NOT human. Treating it as human would let a stale or
--                  forged key attest, which is a fail-open.
--   'unconfigured' no key seeded (the kill switch: `delete from applyy_internal.agent_key`):
--                  humans and machines can't be told apart, so NOTHING is attested. Fail
--                  closed: answers saved in that window refuse until re-saved after re-seeding.
-- This is stricter than "<> 'valid'" on purpose (the 'invalid' and 'unconfigured' rows).
--
-- HOLDS SINCE: the key was seeded on 2026-10-09 (by the orchestrator, Teja approved).
--
-- RECOMPUTED ON EVERY WRITE, including an UPDATE that only touches times_used. No code
-- writes answer_bank except the console (recon 2026-10-09), so that's moot today. If a
-- machine ever updates usage counters, the row loses its attestation and the planner
-- refuses it: the failure is visible, not silent. Re-saving in the console restores it.
--
-- Existing rows get the default false. None are eligibility answers (live 2026-10-09:
-- expected_ctc_inr, cover_letter_generic, first_name, last_name), so nothing that fills
-- today stops filling. Re-runnable: IF NOT EXISTS, CREATE OR REPLACE, DROP TRIGGER IF
-- EXISTS (public.answer_bank is owned by postgres, so the drop is allowed). WRITTEN, NOT APPLIED.
-- =============================================================================

-- The witness column. NOT NULL DEFAULT false: an unknown provenance is "not attested",
-- never null, so a reader can't mistake a missing value for a yes.
alter table public.answer_bank
  add column if not exists attested_by_human boolean not null default false;

-- Says what the column means where a reader of the table will look first.
comment on column public.answer_bank.attested_by_human is
  'True only when the row was last written by a request with NO agent-key header (a human in the console), stamped by trigger answer_bank_stamp_attestation; never client-settable. The worker fills eligibility questions only from attested rows. See 20261009160000.';

-- The stamping function. INVOKER: it needs no rights of its own beyond calling
-- agent_key_state(), which is SECURITY DEFINER and granted to authenticated/service_role.
create or replace function applyy_internal.stamp_answer_attestation()
returns trigger
language plpgsql
-- Empty search_path; every name below is schema-qualified.
set search_path = ''
as $$
begin
  -- Overwrite whatever the client sent: provenance is decided here, never by the caller.
  -- Human = no key header at all ('missing'; see the file header) AND a signed-in user's
  -- JWT (role 'authenticated'). The JWT half shuts out the SQL editor / MCP (no claims) and
  -- service_role writes, which also send no key header but are not Teja in the console.
  new.attested_by_human := (
    applyy_internal.agent_key_state() = 'missing'
    -- nullif: an unset setting reads as '' (missing_ok), which must not reach the json cast.
    and coalesce(nullif(pg_catalog.current_setting('request.jwt.claims', true), '')::json ->> 'role', '') = 'authenticated'
  );
  -- BEFORE trigger: returning NEW is what makes the stamp land on the row.
  return new;
end;
$$;

-- A trigger function needs no client EXECUTE (checked at CREATE TRIGGER, not at fire
-- time). applyy_internal's default privileges don't revoke PUBLIC, so revoke explicitly.
revoke all on function applyy_internal.stamp_answer_attestation()
  from public, anon, authenticated, service_role;

-- Re-runnable: drop an earlier copy of this trigger before creating it.
drop trigger if exists answer_bank_stamp_attestation on public.answer_bank;

-- BEFORE INSERT OR UPDATE, FOR EACH ROW: every write path, including the console's
-- upsert (INSERT ... ON CONFLICT DO UPDATE fires the UPDATE trigger on a conflict).
create trigger answer_bank_stamp_attestation
  before insert or update on public.answer_bank
  for each row execute function applyy_internal.stamp_answer_attestation();
