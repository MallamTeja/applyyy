-- =============================================================================
-- applyy — 04: the status transition guard.
--
-- THIS MIGRATION IS THE SAFETY CASE FOR THE WHOLE SYSTEM. Everything else stores
-- data; this decides what may happen.
--
-- A lookup table of legal (from_status, to_status, allowed_agents) edges, plus a
-- BEFORE UPDATE trigger that refuses anything absent from it. The payoff, in one
-- sentence: EVERY edge into `approved` is human-only, and `approved → applying` is
-- the only edge into `applying` in the entire graph, so CONSTRAINT 15 — never submit
-- without human approval — is UNREACHABLE BY CONSTRUCTION rather than enforced by
-- code review.
--
-- CORRECTED 2026-09-10. This previously read "`awaiting_approval → approved` is the
-- only edge into `approved`", which is FALSE: there are TWO, verified by query.
-- `needs_verification → approved` also exists, and it has to — it is the only way a
-- row re-enters the submit path after a human has checked that a possibly-submitted
-- application did not actually go through.
--
-- The correction STRENGTHENS the argument rather than weakening it, which is why the
-- false version was so easy to leave standing. Constraint 15 never needed `approved`
-- to have a single entrance; it needed every entrance to require a human. Both edges
-- are `array['human']`, so it holds:
--
--   awaiting_approval  -> approved  ['human']
--   needs_verification -> approved  ['human']
--
-- Stated as "every edge into approved is human-only" because that is the property the
-- constraint actually rests on, and unlike an edge count it stays true when a third
-- human-only entrance is added.
--
-- The alternative was an `if` statement inside the worker's Playwright job, reviewed
-- once by one person. This is one table and one trigger, and it holds against every
-- agent, every peer's code, and every future refactor none of us will be here for.
--
-- Mirrored in packages/shared-types/src/status-flow.ts. THIS IS THE RULE; that file
-- is a mirror so the UI can grey out an impossible button. Change one, change both.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- The edge list. Global configuration, not user data: the legal moves are a property
-- of the system, identical for every user, so there is no user_id here.
-- -----------------------------------------------------------------------------
create table public.application_status_transitions (
  from_status public.application_status not null,
  to_status public.application_status not null,

  -- WHO may make this move. The second half of the safety story: several edges list
  -- only 'human', so no automated agent can traverse them however badly it misbehaves.
  -- Also consumed by the frontend, which derives its human-action controls from this
  -- column — so an edge added here without a matching control shows up as a defect on
  -- the health page rather than as rows silently stalling.
  allowed_agents public.agent_name[] not null check (array_length(allowed_agents, 1) > 0),

  -- Why the edge exists, for whoever reads the graph at 2am. Not decoration: this is
  -- the only place the reasoning lives in the database.
  note text not null,

  -- One row per edge. The pair IS the identity; a surrogate id would allow two
  -- contradictory rows for the same move.
  primary key (from_status, to_status),

  -- A self-loop is not a transition. The trigger short-circuits on status = status,
  -- so a row like this could never fire and would only mislead a reader.
  constraint application_status_transitions_no_self_loop check (from_status <> to_status)
);

-- -----------------------------------------------------------------------------
-- Seed the graph. Read top to bottom, this is the entire workflow.
--
-- NOTE ON WHAT IS ABSENT: there is no AGENT ROLLBACK edge. PROJECT_PLAN section 6 says
-- an agent that finds every Gemini key cooling "returns the row to its prior status" —
-- but claiming sets claimed_by/claim_expires_at and does NOT advance status, so such a
-- row never left the status it was in. The rollback is a no-op, so no reverse edge is
-- needed for it.
--
-- CORRECTED 2026-09-10. This comment previously read "there are NO backward edges",
-- which is FALSE and was worth catching, because a false invariant written down is
-- read as a guarantee. Measured against `application_status` declaration order, the
-- seed below contains EXACTLY SEVEN backward edges:
--
--   audit_flagged        -> tailored            ['human']
--   interview            -> oa_pending          ['tracker','human']   <-- see below
--   needs_verification   -> applied             ['human']
--   needs_verification   -> approved            ['human']
--   blocked_needs_human  -> applied             ['human']
--   blocked_needs_human  -> dropped_filter      ['human']
--   failed               -> needs_verification  ['human']
--
-- Six of the seven are HUMAN-ONLY, so no bug can wander down them — reaching them
-- requires a person deciding to. The claim that was true all along is the narrower
-- one: **no machine can walk backward, with exactly one deliberate exception.**
--
-- That exception is interview -> oa_pending, allowed to ['tracker','human'], and it is
-- correct: an employer genuinely can move a candidate back a stage, and the email
-- Tracker has to be able to record that it happened. It is the one reverse edge to
-- check first if a row is ever seen moving backward unexpectedly.
-- -----------------------------------------------------------------------------
insert into public.application_status_transitions (from_status, to_status, allowed_agents, note) values
  -- Discovery and dedupe.
  ('discovered', 'deduped', array['normalizer']::public.agent_name[], 'Fingerprint is new to this user.'),
  ('discovered', 'dropped_duplicate', array['normalizer']::public.agent_name[], 'Same posting already present from another board.'),
  ('discovered', 'failed', array['normalizer','human']::public.agent_name[], 'Unparseable posting.'),

  -- The cheap deterministic cascade, before any LLM spend.
  ('deduped', 'passed_filters', array['screener']::public.agent_name[], 'Survived every enabled filter rule.'),
  ('deduped', 'dropped_filter', array['screener','human']::public.agent_name[], 'A filter rule rejected it; drop_reason names the rule.'),
  ('deduped', 'failed', array['screener','human']::public.agent_name[], 'Screener could not evaluate the row.'),

  -- Matching.
  ('passed_filters', 'scored', array['matcher']::public.agent_name[], 'Gemini attached a fit score.'),
  ('passed_filters', 'dropped_filter', array['matcher','human']::public.agent_name[], 'Score below the user threshold.'),
  ('passed_filters', 'failed', array['matcher','human']::public.agent_name[], 'Matcher failed repeatedly, not a quota issue.'),

  -- Tailoring.
  ('scored', 'tailored', array['tailor']::public.agent_name[], 'Tailored profile produced and validated against the master.'),
  ('scored', 'dropped_filter', array['human']::public.agent_name[], 'Human discarded it after reading the score.'),
  ('scored', 'failed', array['tailor','human']::public.agent_name[], 'Tailor validator rejected every candidate output.'),

  -- Audit. Generator/critic separation: never the model that wrote it approving it.
  ('tailored', 'audit_clean', array['auditor']::public.agent_name[], 'Every tailored line traced back to a master node.'),
  ('tailored', 'audit_flagged', array['auditor']::public.agent_name[], 'At least one claim could not be traced to the master.'),
  ('tailored', 'failed', array['auditor','human']::public.agent_name[], 'Auditor could not run.'),

  -- Into the human queue.
  ('audit_clean', 'awaiting_approval', array['auditor']::public.agent_name[], 'Bucket A - eligible for one-click batch approval.'),
  ('audit_flagged', 'awaiting_approval', array['auditor']::public.agent_name[], 'Bucket B - individual review, never batch-approved.'),
  ('audit_flagged', 'tailored', array['human']::public.agent_name[], 'Human wants a re-tailor. HUMAN-ONLY: an automated retry loop here would burn quota rewriting the same flagged bullet.'),

  -- THE GATE.
  ('awaiting_approval', 'approved', array['human']::public.agent_name[], 'CONSTRAINT 15. A human, and only a human, opens this door.'),
  ('awaiting_approval', 'dropped_filter', array['human']::public.agent_name[], 'Human declined. A human is the last filter in the cascade.'),
  ('approved', 'applying', array['applier']::public.agent_name[], 'THE ONLY EDGE INTO applying IN THE ENTIRE GRAPH. Everything upstream is reversible; nothing downstream is.'),

  -- Submission: the one non-idempotent leg.
  ('applying', 'applied', array['applier']::public.agent_name[], 'Submission confirmed by the worker.'),
  ('applying', 'blocked_needs_human', array['applier']::public.agent_name[], 'Captcha, MFA, or an unanswerable question. block_reason says which. A normal daily queue item, not a failure.'),
  ('applying', 'needs_verification', array['sweeper','human']::public.agent_name[], 'SAFETY-CRITICAL. A stale applying lease means the worker died mid-submit and nobody knows if it landed. Routes here, NEVER back to the queue - a blind retry is how you submit twice and violate constraint 7. `human` is included so a person can still resolve the row when the sweeper itself is not running, which section 14 says is a thing that happens silently.'),
  ('applying', 'failed', array['applier']::public.agent_name[], 'Worker positively established the submit did not happen.'),

  -- Post-apply, driven by the email Tracker.
  ('applied', 'employer_screening', array['tracker','human']::public.agent_name[], 'Acknowledgement or recruiter contact received.'),
  ('applied', 'oa_pending', array['tracker','human']::public.agent_name[], 'Assessment invite arrived without a screening step.'),
  ('applied', 'interview', array['tracker','human']::public.agent_name[], 'Interview invite arrived directly.'),
  ('applied', 'rejected', array['tracker','human']::public.agent_name[], 'Rejection email.'),
  ('employer_screening', 'oa_pending', array['tracker','human']::public.agent_name[], 'Assessment sent.'),
  ('employer_screening', 'interview', array['tracker','human']::public.agent_name[], 'Advanced to interview.'),
  ('employer_screening', 'rejected', array['tracker','human']::public.agent_name[], 'Rejected at screening.'),
  ('oa_pending', 'interview', array['tracker','human']::public.agent_name[], 'Passed the assessment.'),
  ('oa_pending', 'rejected', array['tracker','human']::public.agent_name[], 'Failed or timed out the assessment.'),
  ('interview', 'oa_pending', array['tracker','human']::public.agent_name[], 'Multi-round loop sent a further assessment.'),
  ('interview', 'offer', array['tracker','human']::public.agent_name[], 'Terminal, good.'),
  ('interview', 'rejected', array['tracker','human']::public.agent_name[], 'Terminal, bad.'),

  -- Human-only recovery lanes. This is where the anti-double-submit guarantee lives.
  ('needs_verification', 'applied', array['human']::public.agent_name[], 'Human checked the employer portal: it did go through.'),
  ('needs_verification', 'approved', array['human']::public.agent_name[], 'Human checked: it did NOT go through, so a resubmit is safe. HUMAN-ONLY BY DESIGN - the only way a row re-enters the submit path, and a machine must never decide that a possibly-submitted application was not submitted.'),
  ('needs_verification', 'failed', array['human']::public.agent_name[], 'Human gave up on this one.'),
  ('blocked_needs_human', 'applied', array['human']::public.agent_name[], 'Human finished the submission by hand.'),
  ('blocked_needs_human', 'dropped_filter', array['human']::public.agent_name[], 'Human decided it was not worth finishing.'),
  ('blocked_needs_human', 'failed', array['human']::public.agent_name[], 'Human could not complete it either.'),
  ('failed', 'needs_verification', array['human']::public.agent_name[], 'The ONLY edge out of failed, and it leads to verification rather than to the queue. A row that failed near the submit boundary must be checked by a person before it can move again.');

-- RLS on, but deliberately NOT `force`.
--
-- This table holds no user data — only the rules — so there is nothing to isolate per
-- user. What must be protected is INTEGRITY, and that is achieved by granting a SELECT
-- policy in migration 05 and no write policy at all: the API roles can read the graph
-- and cannot change it. Leaving `force` off keeps the table owner (i.e. a future
-- migration) able to add an edge, which is the only way an edge should ever be added.
alter table public.application_status_transitions enable row level security;

comment on table public.application_status_transitions is
  'The legal status graph. approved -> applying is the ONLY edge into applying, which makes constraint 15 unreachable-by-construction. allowed_agents is consumed by both the trigger and the frontend.';

-- -----------------------------------------------------------------------------
-- THE GUARD.
--
-- SECURITY DEFINER so the lookup always succeeds regardless of which role is writing —
-- the rules must be readable even by a role that has no policy on the rules table.
-- search_path is emptied and every name is qualified, so a caller cannot shadow a
-- table or function name and redirect the check.
-- -----------------------------------------------------------------------------
create or replace function applyy_internal.guard_status_transition()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  -- Who claims to be making this move.
  v_agent public.agent_name;
  -- The raw GUC, before it is validated into the enum.
  v_agent_text text;
  -- The matching edge, if any.
  v_allowed public.agent_name[];
begin
  -- An UPDATE that does not touch status has nothing to validate. This is the common
  -- case (an agent writing a score or a storage path), so it must be cheap.
  if new.status is not distinct from old.status then
    return new;
  end if;

  -- The acting agent travels in a transaction-local setting rather than a column,
  -- because it describes WHO IS WRITING, not the row. advance_application_status()
  -- sets it; a human in the SQL editor must set it deliberately.
  -- The `true` argument makes a missing setting return NULL instead of raising.
  v_agent_text := nullif(current_setting('applyy.acting_agent', true), '');

  -- NO ANONYMOUS STATUS CHANGES. A bare UPDATE that forgot to declare an actor is
  -- refused, which is what stops an agent from bypassing the allowed_agents check
  -- simply by not mentioning itself.
  if v_agent_text is null then
    raise exception
      'status change % -> % refused: no acting agent. Use advance_application_status(), or set applyy.acting_agent for a manual fix.',
      old.status, new.status
      using errcode = '42501';
  end if;

  -- Cast late, so an unknown agent name produces a clear invalid-input error here
  -- rather than a confusing empty lookup below.
  v_agent := v_agent_text::public.agent_name;

  -- Look the edge up. No row means the move is not part of the workflow.
  select t.allowed_agents
    into v_allowed
    from public.application_status_transitions t
   where t.from_status = old.status
     and t.to_status = new.status;

  if v_allowed is null then
    raise exception
      'illegal status transition % -> % (application %). No such edge in application_status_transitions.',
      old.status, new.status, old.id
      using errcode = '23514';
  end if;

  -- The actor check. This is what keeps the human-only recovery lanes closed to
  -- automation — most importantly needs_verification -> approved, the only route back
  -- into the submit path.
  if not (v_agent = any (v_allowed)) then
    raise exception
      'agent % may not perform % -> % (application %). Permitted: %.',
      v_agent, old.status, new.status, old.id, v_allowed
      using errcode = '42501';
  end if;

  -- The move is legal. Maintain the derived columns HERE rather than asking five
  -- peers to remember them, which is the difference between a fact and a convention.
  new.previous_status := old.status;
  new.status_changed_at := now();

  -- Stamp the two milestone timestamps at the moment they become true. Doing this in
  -- the trigger means approved_at cannot disagree with the status it describes.
  if new.status = 'approved' then
    new.approved_at := now();
  elsif new.status = 'applied' then
    new.applied_at := now();
  end if;

  return new;
end;
$$;

-- BEFORE, so an illegal move never reaches the table at all.
create trigger guard_status_transition
  before update on public.applications
  for each row execute function applyy_internal.guard_status_transition();

-- -----------------------------------------------------------------------------
-- THE WITNESS. Every status change writes an event, from a trigger, so no agent can
-- forget to log and no status change can happen unobserved.
-- -----------------------------------------------------------------------------
create or replace function applyy_internal.log_status_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- Same short-circuit as the guard: only real transitions are events.
  if new.status is not distinct from old.status then
    return null;
  end if;

  insert into public.application_events (user_id, application_id, event_type, from_status, to_status, agent, detail)
  values (
    new.user_id,
    new.id,
    'status_change',
    old.status,
    new.status,
    -- Safe to cast without checking: the guard already refused a missing or invalid
    -- agent, so by the time this AFTER trigger runs the value is known good.
    nullif(current_setting('applyy.acting_agent', true), '')::public.agent_name,
    -- Carry the fields a debugger will want without joining back to the row.
    jsonb_build_object(
      'claimed_by', old.claimed_by,
      'retry_count', new.retry_count,
      'block_reason', new.block_reason,
      'drop_reason', new.drop_reason,
      'failure_reason', new.failure_reason
    )
  );

  -- AFTER triggers ignore the return value.
  return null;
end;
$$;

-- AFTER, so the event is only written once the row change has actually committed to
-- the table — an event describing a change that was then rolled back would be a lie.
create trigger log_status_change
  after update on public.applications
  for each row execute function applyy_internal.log_status_change();
