-- 20261109210000_agent_name_link_intake_resume_assist.sql: agent identities for the two Gemini callers that wrote no agent_runs row.
--
-- WHY THIS EXISTS. job-link-intake (the pasted-link reader) and resume-assist (the AI resume
-- editor) both spend Gemini calls, but neither wrote an agent_runs row, so their quota spend was
-- invisible to the Health page and to every calls/min or 429-vs-503 measurement (peer 3 task 8
-- audit, 2026-11-09). Each gets its OWN identity rather than borrowing one: agent identities stay
-- one-to-one with real agents (see 'scout_web', 20261109190000), so one agent's runs never mask
-- another's silence or hide its spend among another's true zeros.
--
-- ADD ONLY, NEVER USE, IN THIS FILE: Postgres allows ADD VALUE inside the migration's
-- transaction but forbids USING a value in the transaction that added it. Nothing here writes
-- either value; the job-link-intake and resume-assist deploys that write them ship AFTER this.
--
-- APPENDED LAST, IN THIS ORDER (no BEFORE/AFTER): Postgres orders an enum by declaration, and
-- AGENT_NAMES in packages/shared-types/src/enums.ts must match that sequence (enum-parity.test.ts).
-- `if not exists` makes a re-run a no-op.
alter type public.agent_name add value if not exists 'job_link_intake';
-- Second, after job_link_intake, matching AGENT_NAMES.
alter type public.agent_name add value if not exists 'resume_assist';
