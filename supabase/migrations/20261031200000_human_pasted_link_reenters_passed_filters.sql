-- WHY THIS MIGRATION EXISTS (2026-10-31).
--
-- Teja asked for "add a job by link": paste ONE job URL (a LinkedIn/X post, a careers page,
-- an ATS posting) and the job skips every filter and goes straight to tailoring and the
-- approval queue. The edge function `job-link-intake` inserts NEW jobs at passed_filters,
-- which the insert guard already allows (20260917130000). This migration covers the other
-- case: the pasted posting is ALREADY a row, because a scout found it first, and that row
-- sits where no edge can carry it to passed_filters:
--
--   discovered      only the normalizer moves it on, and the screener may then drop it;
--   deduped         only the screener moves it on, and it may drop it;
--   dropped_filter  NO outgoing edge at all: a filter's verdict was final.
--
-- A pasted link is the human overruling the filters for that one job, so each of the three
-- gains a HUMAN-ONLY edge into passed_filters. Human-only because no agent may ever
-- un-drop a row on its own: that would re-spend Gemini quota on jobs the filters rejected.
-- job-link-intake calls advance_application_status(..., 'passed_filters', 'human', detail)
-- with detail.reason = 'pasted_link', so the event log says exactly why each row came back.
--
-- CONSEQUENCE, DELIBERATE: dropped_filter stops being a terminal status in the derived
-- graph (packages/shared-types/src/status-flow.ts TERMINAL_STATUSES). The Pipeline board
-- keeps showing it under "Closed" by an explicit rule (PipelinePage.tsx), and
-- apps/web/src/data/humanLanes.ts names the paste panel as the control for the new edge.
--
-- Not re-runnable as written (plain insert): run once, like every graph migration here.
-- The update below uses the full-array form the parity test parses
-- (packages/shared-types/test/enum-parity.test.ts), so the TS mirror is checked against it.

-- Two new edges, both human-only.
insert into public.application_status_transitions (from_status, to_status, allowed_agents, note) values
  -- A scouted row still waiting for the normalizer: the human takes it past normalizer and screener.
  ('discovered', 'passed_filters', array['human']::public.agent_name[], 'Human pasted this job''s link: it skips dedupe and every filter.'),
  -- A row a filter or the matcher dropped: the human overrules that verdict for this one job.
  ('dropped_filter', 'passed_filters', array['human']::public.agent_name[], 'Human pasted this job''s link: a human overrules the filter that dropped it.');

-- The existing deduped -> passed_filters edge belonged to the screener alone; the human joins it.
update public.application_status_transitions set allowed_agents = array['screener', 'human']::public.agent_name[] where from_status = 'deduped' and to_status = 'passed_filters';
