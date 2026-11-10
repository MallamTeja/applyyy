-- WHY THIS MIGRATION EXISTS (2026-11-10). The same job reaches the pipeline twice: once from an
-- aggregator feed (Jobicy, RemoteOK, Arbeitnow) and once from the employer's own ATS board.
--
-- THE TWIN PROBLEM. The normalizer dedupes on a fingerprint of company|title|location. The feeds
-- report a FEED region ("Worldwide", "Europe", "Remote") while the ATS reports the BOARD location
-- ("Bengaluru, India", "Remote - US"), so the two copies get different fingerprints and both survive
-- dedupe. Measured live on 2026-11-10: 257 aggregator/ATS pairs, and 3 jobs sat in awaiting_approval
-- TWICE, so Teja was asked to approve the same job two times.
--
-- WHAT THIS ADDS. The only edge into dropped_duplicate was discovered -> dropped_duplicate [normalizer],
-- which cannot reach a twin that is already past dedupe. These six edges let a sweep retire the
-- AGGREGATOR copy from any agent-owned stage: passed_filters, scored, tailored, audit_clean,
-- audit_flagged, awaiting_approval. The ATS copy is ALWAYS the one kept and is never moved by this
-- sweep: it carries the real apply URL and the board location the screener judged. The edges cannot
-- enforce that by themselves (they name statuses, not sources); the sweep code must, and its tests must.
--
-- WHY scout_aggregator AND NOT normalizer. The sweep runs inside the worker's remote (aggregator) scout,
-- which signs its moves as scout_aggregator. Granting normalizer would open these edges to an agent
-- that never runs the sweep, a wider grant than the job needs.
--
-- WHY NOTHING FROM approved OR LATER. approved, applying, blocked_needs_human, applied and failed are
-- a human decision or its consequence. An agent never re-judges what a human decided; a twin found
-- there stays for Teja to handle by hand.
--
-- RE-RUNNABLE. "on conflict (from_status, to_status) do nothing" makes a second run a no-op instead of a
-- primary-key failure (repo CLAUDE.md section 7). The TS parity test parses only the tuples, so the
-- trailing clause does not disturb it. packages/shared-types/src/status-flow.ts must mirror all six edges.
--
-- DRY-RUN EXPECTATION: `supabase db push --linked --dry-run` should list exactly this file. It was renamed from
-- 140000 to 160000 (2026-11-10) so it sorts after 20261110120000, 130000 and 150000, which the orchestrator applies first.
--
-- POST-APPLY VERIFICATION (expect 6 rows, each allowed_agents = {scout_aggregator}):
--   select from_status, to_status, allowed_agents, note
--   from public.application_status_transitions
--   where to_status = 'dropped_duplicate' and 'scout_aggregator' = any(allowed_agents)
--   order by from_status;

-- The six agent edges, in the tuple shape the TS parity test parses (status-flow.ts mirrors each one).
insert into public.application_status_transitions (from_status, to_status, allowed_agents, note) values
  -- Twin caught right after screening, before any LLM spend on it.
  ('passed_filters', 'dropped_duplicate', array['scout_aggregator']::public.agent_name[], 'Aggregator (Jobicy/RemoteOK/Arbeitnow) copy whose employer-ATS twin exists; the ATS copy is always kept.'),
  -- Twin caught after the matcher scored it, before tailoring.
  ('scored', 'dropped_duplicate', array['scout_aggregator']::public.agent_name[], 'Aggregator (Jobicy/RemoteOK/Arbeitnow) copy whose employer-ATS twin exists; the ATS copy is always kept.'),
  -- Twin caught after tailoring, before the auditor reads it.
  ('tailored', 'dropped_duplicate', array['scout_aggregator']::public.agent_name[], 'Aggregator (Jobicy/RemoteOK/Arbeitnow) copy whose employer-ATS twin exists; the ATS copy is always kept.'),
  -- Twin that passed the audit, before it is queued for Teja.
  ('audit_clean', 'dropped_duplicate', array['scout_aggregator']::public.agent_name[], 'Aggregator (Jobicy/RemoteOK/Arbeitnow) copy whose employer-ATS twin exists; the ATS copy is always kept.'),
  -- Twin the auditor flagged: no point fixing a copy that will be dropped.
  ('audit_flagged', 'dropped_duplicate', array['scout_aggregator']::public.agent_name[], 'Aggregator (Jobicy/RemoteOK/Arbeitnow) copy whose employer-ATS twin exists; the ATS copy is always kept.'),
  -- Twin already in the approval queue: the measured case (3 jobs listed twice), removed before Teja approves both.
  ('awaiting_approval', 'dropped_duplicate', array['scout_aggregator']::public.agent_name[], 'Aggregator (Jobicy/RemoteOK/Arbeitnow) copy whose employer-ATS twin exists; the ATS copy is always kept.')
-- A re-run skips the rows already present instead of failing on the (from_status, to_status) primary key.
on conflict (from_status, to_status) do nothing;
