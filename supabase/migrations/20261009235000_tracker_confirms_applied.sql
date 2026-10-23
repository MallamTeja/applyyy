-- =============================================================================
-- The email tracker may mark a submitted application `applied`, from a verified receipt.
--
-- WHY. A real submit ends `applied` only when the worker sees the employer's
-- confirmation page AND an employer request after the click (worker/src/
-- playwright-page.ts). Anything less leaves the row at `applying`, and the sweep then
-- moves it to `needs_verification`, which only a human could clear. Greenhouse also
-- sends an "application received" email. On 2026-10-09 23:24 IST Teja chose "Mark
-- applied automatically" (relayed by the orchestrator): a VERIFIED receipt for that
-- exact application may confirm it with no human check.
--
-- WHAT THIS NARROWS. 20260909234900_status_transition_guard.sql made every exit from
-- `needs_verification` human-only, marked SAFETY-CRITICAL: an automated system must not
-- claim an application landed when it can't prove it. This migration keeps that rule for
-- every agent except `tracker`, and for every exit except `-> applied`. The tracker
-- (supabase/functions/email-tracker-intake) only requests this move when ALL of these
-- hold. They are enforced in its decide step and pinned by named tests:
--   * the sender is an ATS vendor domain (greenhouse.io / greenhouse-mail.io),
--   * Gmail's own (topmost, authserv-id mx.google.com) Authentication-Results header shows
--     dkim=pass (or spf=pass) for THAT vendor domain. A missing header never confirms.
--   * it arrived AFTER the row's latest entry into `applying` (from application_events),
--   * exactly one loaded row matches the company,
--   * and it is classified as an application receipt.
-- `applying -> applied` was {applier} only; the tracker is added for the case where the
-- sweep has not run yet.
--
-- SHAPE: plain UPDATE statements with the FULL agent arrays (not an append) and the note
-- override form, because packages/shared-types/test/enum-parity.test.ts parses this text
-- to prove the TS mirror (status-flow.ts) matches the database. Setting the full array
-- also makes each statement idempotent. The guard trigger reads allowed_agents from this
-- table on every status UPDATE, so these rows ARE the change. No applications row is
-- touched. WRITTEN, NOT APPLIED.
-- =============================================================================

-- The worker still confirms its own submits; the tracker may now confirm one by receipt.
update public.application_status_transitions set allowed_agents = array['applier', 'tracker']::public.agent_name[] where from_status = 'applying' and to_status = 'applied';

-- The one exit from needs_verification a machine may now take, and only the tracker.
update public.application_status_transitions set allowed_agents = array['human', 'tracker']::public.agent_name[] where from_status = 'needs_verification' and to_status = 'applied';

-- The notes the console renders, rewritten to say who may now make each move.
update public.application_status_transitions set note = 'Submission confirmed by the worker, or by the tracker from a DKIM/SPF-verified ATS receipt received after the submit.' where from_status = 'applying' and to_status = 'applied';

-- Same, for the human-review lane: a person, or a verified receipt.
update public.application_status_transitions set note = 'Human checked the employer portal: it did go through. Or the tracker saw a DKIM/SPF-verified ATS receipt received after the submit.' where from_status = 'needs_verification' and to_status = 'applied';

-- Report what landed (CLAUDE.md §7): a WARNING, not an exception, if either edge is missing
-- or lacks the tracker, so the push log says so and a human decides.
do $$
declare
  -- How many of the two edges now allow the tracker (expected 2).
  v_ok integer;
begin
  -- Count the edges that exist AND allow 'tracker'.
  select count(*) into v_ok
    from public.application_status_transitions t
   where (t.from_status::text, t.to_status::text) in (('applying', 'applied'), ('needs_verification', 'applied'))
     and 'tracker'::public.agent_name = any (t.allowed_agents);
  -- Anything but 2 means the graph is not what this migration expected.
  if v_ok <> 2 then
    raise warning 'tracker_confirms_applied: % of 2 edges into applied allow the tracker', v_ok;
  else
    -- The normal path, recorded in the push log.
    raise notice 'tracker_confirms_applied: 2 of 2 edges into applied allow the tracker';
  end if;
end;
$$;
