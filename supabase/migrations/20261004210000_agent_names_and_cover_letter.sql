-- ============================================================================
-- Agent identities for the five phase-3 side agents, and a home for the cover letter.
--
-- WHY THIS FILE EXISTS
--
-- 1. `agent_runs.agent` is NOT NULL and typed `public.agent_name`
--    (20260909234800_supporting_tables.sql:80), and the enum
--    (20260909234500_enums.sql) had no value for skill-gap, interview-prep,
--    follow-up, referral or cover-letter. So three of them wrote NO telemetry at
--    all, and two borrowed someone else's identity: referral logged as
--    'screener' and cover-letter as 'tailor'. A borrowed identity is worse than
--    a missing row — the health page's only job is detecting absence, and a
--    referral run stamped 'screener' makes a dead screener look alive. The rule
--    is the one 20260910185900 (keepalive) recorded: agent identities are
--    one-to-one with real agents.
--
-- 2. cover-letter stored its letter by OVERWRITING `applications.block_detail`,
--    the structured context the dashboard reads to explain a
--    `blocked_needs_human` row. One column cannot mean two things; the letter
--    gets its own column so writing it can never erase a block's explanation.
--
-- NOT APPLIED BY THE SESSION THAT WROTE IT — written 2026-10-04, unverified
-- against a running Postgres. Regenerate the backlog with
-- `supabase migration list --linked` before pushing; never inherit a count.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- PART 1 — five new agent identities.
--
-- snake_case, matching every existing value ('scout_ats', 'scout_aggregator'):
-- the function directory names use hyphens, the enum never has.
--
-- `add value` cannot be USED in the transaction that adds it (Postgres refuses
-- an uncommitted enum value with 55P04). That is safe here because nothing in
-- this file references them — only runtime Edge Function code does, and that
-- runs after this migration commits. Do not add an insert that uses one of
-- these values to this file; put it in a later migration.
--
-- APPENDED, no BEFORE/AFTER: Postgres sorts an enum by declaration order, and
-- packages/shared-types/test/enum-parity.test.ts asserts that order against
-- AGENT_NAMES — inserting mid-list would silently change `order by agent`.
-- `if not exists` makes a re-run a no-op instead of a duplicate-value error.
--
-- The status transition graph needs NOTHING: none of these five agents moves
-- `applications.status`, so no `application_status_transitions.allowed_agents`
-- array has to name them. Leaving them out of the graph is the control — a
-- side agent that tried to advance a row would be refused by the guard.
-- ----------------------------------------------------------------------------

-- Counts missing skills across scored/applied jobs; writes skill_gap_reports.
alter type public.agent_name add value if not exists 'skill_gap';
-- Drafts interview_prep_packs for rows at `interview`.
alter type public.agent_name add value if not exists 'interview_prep';
-- Drafts follow_up_nudges for rows quiet at `applied`.
alter type public.agent_name add value if not exists 'follow_up';
-- Drafts referral outreach as application_events notes; replaces the borrowed 'screener'.
alter type public.agent_name add value if not exists 'referral';
-- Writes applications.cover_letter; replaces the borrowed 'tailor'.
alter type public.agent_name add value if not exists 'cover_letter';

-- ----------------------------------------------------------------------------
-- PART 2 — applications.cover_letter and its timestamp.
--
-- RLS: no change needed. "own applications" (20260909235000_rls_policies.sql:77)
-- is `for all` on the whole row, and there are no column-level grants on
-- `applications` anywhere in supabase/migrations, so new columns inherit the
-- same tenant boundary as every existing one.
-- ----------------------------------------------------------------------------

-- Both nullable: NULL means "not generated yet", which is exactly the queue
-- predicate the cover-letter function selects on (`cover_letter is null`).
alter table public.applications
  -- text, not jsonb: the function stores one rendered letter, and a structured
  -- shape would be a second contract to keep in sync with the prompt schema.
  add column if not exists cover_letter text,
  -- timestamptz so "when was this letter written" survives timezone changes
  -- and can be compared against status_changed_at to spot a stale letter.
  add column if not exists cover_letter_generated_at timestamptz;

-- Dropped first so the file stays re-runnable: Postgres has no
-- `add constraint if not exists`.
alter table public.applications
  -- No-op on a first run; removes the previous copy on a re-run.
  drop constraint if exists applications_cover_letter_consistent;

-- The letter and its timestamp are written together or not at all, and a blank
-- letter is not a letter. Enforced here rather than trusted to one writer:
-- the function's own shape check is a comment-level promise to every OTHER
-- writer, and a whitespace-only value would hide the row from the
-- `cover_letter is null` queue forever while showing the user nothing.
alter table public.applications
  -- Named, so a violation's error message says which rule broke.
  add constraint applications_cover_letter_consistent check (
    -- Neither set: not generated yet.
    (cover_letter is null and cover_letter_generated_at is null)
    -- Both set, with real content in the letter.
    or (cover_letter is not null and btrim(cover_letter) <> '' and cover_letter_generated_at is not null)
  );

-- Recorded on the column so `\d+ applications` explains it without this file.
comment on column public.applications.cover_letter is
  'Generated cover letter text, written only by the cover-letter agent. Dedicated column because block_detail was being overwritten with it.';
-- Same reason: the catalog is what a future reader actually sees.
comment on column public.applications.cover_letter_generated_at is
  'When cover_letter was written. Null exactly when cover_letter is null (applications_cover_letter_consistent).';
