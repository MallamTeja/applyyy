-- WHY THIS MIGRATION EXISTS (2026-11-12, Teja approved in the orchestrator window, 15:52 IST: "Add edge + move back").
--
-- On 2026-11-11 the email tracker read two Canonical "Thank you for applying" receipts as interview
-- invitations: the receipt body describes Canonical's process ("a written interview", "a panel
-- interview"), and the classifier keyed on the word. The tracker then moved two applications
-- applied -> interview (800e8d08 Python Engineer at 18:29Z, 8e9d58ce Web Frontend at 15:29Z). The
-- classifier was fixed in 98fb4a6, and the email rows were relabelled on 2026-11-12. The two
-- applications could not be put back: interview had no edge to applied, only oa_pending, offer and
-- rejected. A wrong interview could only be closed as an outcome that never happened.
--
-- This adds ONE edge, interview -> applied, HUMAN-ONLY. It is a correction: a human saying "that
-- was never an interview". No agent may take it. The tracker in particular must never walk a row
-- back on its own reading of an email; that is exactly the misreading this edge undoes. The BEFORE
-- UPDATE transition guard refuses every actor not in allowed_agents. The correction itself is
-- advance_application_status(..., 'applied', 'human', detail), so application_events records who
-- moved it and why (detail.reason). It is never a direct UPDATE.
--
-- Re-runnable: the primary key is (from_status, to_status), so a second run is a no-op.
-- Written in the tuple shape packages/shared-types/test/enum-parity.test.ts parses. The TS mirror
-- (packages/shared-types/src/status-flow.ts STATUS_TRANSITIONS) must carry the same edge, note included.

-- The one new edge, human-only.
insert into public.application_status_transitions (from_status, to_status, allowed_agents, note) values
  -- A tracker misreading (a receipt read as an invite): the human puts the row back where the employer left it.
  ('interview', 'applied', array['human']::public.agent_name[], 'Human correction: the interview was a misread email; back to applied.')
-- Already present (a re-run): leave it as it is.
on conflict (from_status, to_status) do nothing;
