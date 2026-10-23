/**
 * applyy — the legal status graph, mirrored from the database.
 *
 * THIS FILE IS A MIRROR, NOT THE RULE. The rule is the `application_status_transitions`
 * table plus its BEFORE UPDATE trigger in supabase/migrations. Postgres rejects an
 * illegal move whether or not your code consulted this file. What this file buys you
 * is a client that can grey out an impossible button instead of discovering the truth
 * from a 400 response.
 *
 * The pattern is "make the wrong answer inexpressible" (PROJECT_PLAN section 10),
 * applied to the workflow rather than to the LLM output. The single most valuable
 * consequence: `approved` is the ONLY row in this table whose `to` is `applying`.
 * Constraint 15 — never submit without human approval — therefore cannot be violated
 * by a bug in any agent, because no other edge into `applying` exists to be reached.
 */

import type { AgentName, ApplicationStatus } from './enums.ts';
// A VALUE import, not a type import: TERMINAL_STATUSES is derived by filtering this
// tuple, so the list of statuses has to exist at runtime. Kept as a separate statement
// because `verbatimModuleSyntax` requires type-only and value imports to be spelled
// distinctly rather than merged.
import { APPLICATION_STATUSES } from './enums.ts';

/** One legal move: a from-status, a to-status, and who is permitted to make it. */
export interface StatusTransition {
  /** The status the row must currently be in. */
  readonly from: ApplicationStatus;
  /** The status the row may move to. */
  readonly to: ApplicationStatus;
  /**
   * Who may perform this move. This is the second half of the safety story: several
   * edges are `['human']` only, so no automated agent can traverse them however
   * badly it misbehaves. `needs_verification -> approved` is the critical one — a
   * machine must never resurrect an application that may already have been submitted.
   */
  readonly allowedAgents: readonly AgentName[];
  /** Why this edge exists, for whoever reads the graph at 2am. */
  readonly note: string;
}

/**
 * Every legal transition in the system. Anything not listed here is refused by the
 * database. Seeded verbatim into `application_status_transitions` by the migration —
 * if you change one you must change both, and SCHEMA_CONTRACT.md carries the checklist.
 *
 * NOTE ON QUOTA-EXHAUSTION ROLLBACK: PROJECT_PLAN section 6 says an agent that finds
 * every Gemini key cooling "returns the row to its prior status". No backward edge was
 * added for that, because none is needed — claiming is done with `claimed_by` /
 * `claim_expires_at`, not by advancing the status. An agent that cannot get a key
 * simply releases its claim; the row never left the status it was in. The rollback the
 * plan describes is a no-op in this design, which is better than seeding reverse edges
 * onto the forward path.
 *
 * BUT DO NOT READ THAT AS "THE GRAPH HAS NO BACKWARD EDGES" — corrected 2026-09-10,
 * because the previous wording ended "there is no backward path for a bug to wander
 * down" and that is false. SEVEN backward edges exist, deliberately, and they are the
 * recovery lanes: `audit_flagged→tailored`, `interview→oa_pending`,
 * `blocked_needs_human→applied`, `blocked_needs_human→dropped_filter`,
 * `needs_verification→applied`, `needs_verification→approved`,
 * `failed→needs_verification`.
 *
 * The true statement is narrower and is what the prose above was reaching for: no
 * backward edge exists on the AUTOMATED FORWARD PATH, and every backward edge except
 * one is `['human']`-only. The exception is `interview → oa_pending`
 * (`['tracker','human']`) — THE ONE REVERSE EDGE A MACHINE CAN WALK, because a
 * multi-round loop legitimately sends a further assessment after an interview.
 *
 * Why the distinction is worth this many lines: a reader who trusts "zero backward
 * edges" concludes the actor check on reverse moves is redundant and skips it. It is
 * not redundant — it is the entire safety property, and it is doing real work on
 * exactly one edge.
 */
export const STATUS_TRANSITIONS: readonly StatusTransition[] = [
  // ---- Discovery and dedupe -------------------------------------------------
  { from: 'discovered', to: 'deduped', allowedAgents: ['normalizer'], note: 'Fingerprint is new to this user.' },
  { from: 'discovered', to: 'dropped_duplicate', allowedAgents: ['normalizer'], note: 'Same posting already present from another board.' },
  { from: 'discovered', to: 'failed', allowedAgents: ['normalizer', 'human'], note: 'Unparseable posting.' },

  // ---- The cheap deterministic filter cascade, before any LLM spend ---------
  { from: 'deduped', to: 'passed_filters', allowedAgents: ['screener'], note: 'Survived every enabled filter rule.' },
  { from: 'deduped', to: 'dropped_filter', allowedAgents: ['screener', 'human'], note: 'A filter rule rejected it; drop_reason names the rule.' },
  { from: 'deduped', to: 'failed', allowedAgents: ['screener', 'human'], note: 'Screener could not evaluate the row.' },

  // ---- Matching -------------------------------------------------------------
  { from: 'passed_filters', to: 'scored', allowedAgents: ['matcher'], note: 'Gemini attached a fit score.' },
  { from: 'passed_filters', to: 'dropped_filter', allowedAgents: ['matcher', 'human'], note: 'Score below the user threshold.' },
  { from: 'passed_filters', to: 'failed', allowedAgents: ['matcher', 'human'], note: 'Matcher failed repeatedly, not a quota issue.' },

  // ---- Tailoring ------------------------------------------------------------
  { from: 'scored', to: 'tailored', allowedAgents: ['tailor'], note: 'Tailored profile produced and validated against the master.' },
  { from: 'scored', to: 'dropped_filter', allowedAgents: ['human'], note: 'Human discarded it after reading the score.' },
  { from: 'scored', to: 'failed', allowedAgents: ['tailor', 'human'], note: 'Tailor validator rejected every candidate output.' },

  // ---- Audit: generator/critic separation, never the same model approving ---
  { from: 'tailored', to: 'audit_clean', allowedAgents: ['auditor'], note: 'Every tailored line traced back to a master node.' },
  { from: 'tailored', to: 'audit_flagged', allowedAgents: ['auditor'], note: 'At least one claim could not be traced to the master.' },
  { from: 'tailored', to: 'failed', allowedAgents: ['auditor', 'human'], note: 'Auditor could not run.' },

  // ---- Into the human queue -------------------------------------------------
  { from: 'audit_clean', to: 'awaiting_approval', allowedAgents: ['auditor'], note: 'Bucket A - eligible for one-click batch approval.' },
  { from: 'audit_flagged', to: 'awaiting_approval', allowedAgents: ['auditor'], note: 'Bucket B - individual review, never batch-approved.' },
  { from: 'audit_flagged', to: 'tailored', allowedAgents: ['human'], note: 'Human edited the master or the selection and wants a re-tailor. HUMAN-ONLY: a re-tailor is a decision about truth, not a retry.' },

  // ---- THE GATE. The only door to `applying` in the entire graph ------------
  { from: 'awaiting_approval', to: 'approved', allowedAgents: ['human'], note: 'CONSTRAINT 15. A human, and only a human, opens this door.' },
  { from: 'awaiting_approval', to: 'dropped_filter', allowedAgents: ['human'], note: 'Human declined. drop_reason carries why; a human is the last filter in the cascade.' },
  { from: 'approved', to: 'applying', allowedAgents: ['applier'], note: 'THE ONLY EDGE INTO applying IN THE ENTIRE GRAPH. Everything upstream is reversible; nothing downstream is.' },
  // A blocker found on an already-approved row goes straight to the human queue. This
  // is a FORWARD edge (approved precedes blocked_needs_human in declaration order), so
  // it does not affect the seven-backward-edges invariant, and constraint 15 is
  // untouched: it adds an edge OUT of approved, while approved -> applying remains the
  // only edge INTO applying.
  //
  // WHY IT EXISTS: without it, a captcha discovered after approval had to transit
  // THROUGH `applying`. A crash between those two writes leaves the row at
  // `applying`, the sweeper correctly routes it to `needs_verification`, and a human
  // then hand-verifies an application that was never submitted — a spurious instance of
  // the most expensive human task in the system, manufactured by a graph gap rather than
  // by any real ambiguity.
  { from: 'approved', to: 'blocked_needs_human', allowedAgents: ['applier'], note: 'Applier hit a blocker on an approved row. Set block_reason in the SAME update — applications_blocked_has_reason requires it. Exists so a blocked row need not travel through `applying`: a crash between an approved->applying write and an applying->blocked write leaves the row at `applying`, the sweeper routes it to needs_verification, and a human then hand-verifies an application that was never submitted.' },

  // ---- Submission: the one non-idempotent leg ------------------------------
  // 'tracker' since 20261009235000 (Teja, 2026-10-09): a DKIM/SPF-verified ATS receipt
  // received after the submit confirms it, when the worker could not see the confirmation.
  { from: 'applying', to: 'applied', allowedAgents: ['applier', 'tracker'], note: 'Submission confirmed by the worker, or by the tracker from a DKIM/SPF-verified ATS receipt received after the submit.' },
  { from: 'applying', to: 'blocked_needs_human', allowedAgents: ['applier'], note: 'Captcha, MFA, or an unanswerable question. block_reason says which. A normal daily queue item, not a failure.' },
  { from: 'applying', to: 'needs_verification', allowedAgents: ['sweeper', 'human'], note: 'SAFETY-CRITICAL. A stale applying lease means the worker died mid-submit and nobody knows if it landed. Routes here, NEVER back to the queue - a blind retry is how you submit twice and violate constraint 7. `human` is included so a person can still resolve the row when the sweeper itself is not running, which section 14 says is a thing that happens silently.' },
  { from: 'applying', to: 'failed', allowedAgents: ['applier'], note: 'Worker positively established the submit did not happen.' },

  // ---- Post-apply, driven by the email Tracker -----------------------------
  { from: 'applied', to: 'employer_screening', allowedAgents: ['tracker', 'human'], note: 'Acknowledgement or recruiter contact received.' },
  { from: 'applied', to: 'oa_pending', allowedAgents: ['tracker', 'human'], note: 'Assessment invite arrived without a screening step.' },
  { from: 'applied', to: 'interview', allowedAgents: ['tracker', 'human'], note: 'Interview invite arrived directly.' },
  { from: 'applied', to: 'rejected', allowedAgents: ['tracker', 'human'], note: 'Rejection email.' },
  { from: 'employer_screening', to: 'oa_pending', allowedAgents: ['tracker', 'human'], note: 'Assessment sent.' },
  { from: 'employer_screening', to: 'interview', allowedAgents: ['tracker', 'human'], note: 'Advanced to interview.' },
  { from: 'employer_screening', to: 'rejected', allowedAgents: ['tracker', 'human'], note: 'Rejected at screening.' },
  { from: 'oa_pending', to: 'interview', allowedAgents: ['tracker', 'human'], note: 'Passed the assessment.' },
  { from: 'oa_pending', to: 'rejected', allowedAgents: ['tracker', 'human'], note: 'Failed or timed out the assessment.' },
  { from: 'interview', to: 'oa_pending', allowedAgents: ['tracker', 'human'], note: 'Multi-round loop sent a further assessment.' },
  { from: 'interview', to: 'offer', allowedAgents: ['tracker', 'human'], note: 'Terminal, good.' },
  { from: 'interview', to: 'rejected', allowedAgents: ['tracker', 'human'], note: 'Terminal, bad.' },

  // ---- Human-only recovery lanes -------------------------------------------
  // The one exit from needs_verification a machine may take, and only the tracker, only from
  // a verified receipt (20261009235000). ->approved and ->failed stay human-only.
  { from: 'needs_verification', to: 'applied', allowedAgents: ['human', 'tracker'], note: 'Human checked the employer portal: it did go through. Or the tracker saw a DKIM/SPF-verified ATS receipt received after the submit.' },
  { from: 'needs_verification', to: 'approved', allowedAgents: ['human'], note: 'Human checked: it did NOT go through, so a resubmit is safe. HUMAN-ONLY BY DESIGN - the only way a row re-enters the submit path, and a machine must never decide that a possibly-submitted application was not submitted.' },
  { from: 'needs_verification', to: 'failed', allowedAgents: ['human'], note: 'Human gave up on this one.' },
  { from: 'blocked_needs_human', to: 'applied', allowedAgents: ['human'], note: 'Human finished the submission by hand.' },
  { from: 'blocked_needs_human', to: 'dropped_filter', allowedAgents: ['human'], note: 'Human decided it was not worth finishing.' },
  { from: 'blocked_needs_human', to: 'failed', allowedAgents: ['human'], note: 'Human could not complete it either.' },
  { from: 'failed', to: 'needs_verification', allowedAgents: ['human'], note: 'The ONLY edge out of failed, and it leads to verification rather than to the queue. A row that failed near the submit boundary must be checked by a person before it can move again.' },
] as const;

/**
 * Statuses with no outgoing edge. Nothing in the system may move a row out of these.
 *
 * NOW GENUINELY DERIVED (2026-09-10). This comment previously claimed "derived rather
 * than hand-listed so it cannot fall out of sync with the graph above" while the value
 * was a hand-written literal — the values happened to be correct, but the guarantee was
 * fictional, and a comment asserting a property nothing enforces is a guard nobody
 * runs. Adding an outgoing edge to `offer` would have left this list silently wrong,
 * which is the exact drift the comment promised to prevent. It is computed now, so the
 * promise and the code are the same thing.
 *
 * Note what this correctly EXCLUDES: `failed` looks terminal and is not, because
 * `failed → needs_verification` exists — a row that failed near the submit boundary
 * must be checked by a person before it can move again. Deriving gets that right
 * without anyone having to remember it.
 *
 * Order follows APPLICATION_STATUSES rather than the edge list, so it stays stable
 * against a harmless reshuffle of the transitions below and matches the order Postgres
 * sorts the enum in.
 */
export const TERMINAL_STATUSES: readonly ApplicationStatus[] = APPLICATION_STATUSES.filter(
  // No edge leaves this status, so nothing in the graph can move a row out of it.
  (status) => !STATUS_TRANSITIONS.some((transition) => transition.from === status),
);

/**
 * Statuses that an automated sweeper must NEVER return to the work queue.
 *
 * `applying` is the one non-idempotent state in the system: the worker marks
 * `applying`, submits, marks `applied`. A crash in that window leaves a row whose
 * real-world outcome is unknown, and an unknown submit is not a retryable submit.
 */
export const NON_RETRYABLE_STATUSES: readonly ApplicationStatus[] = ['applying'];

/** Fast lookup key for the transition set. Kept private so callers use the helpers. */
const transitionKey = (from: ApplicationStatus, to: ApplicationStatus): string => `${from}>${to}`;

/** Prebuilt index so `canTransition` is a map hit rather than a scan of ~45 rows per call. */
const TRANSITION_INDEX: ReadonlyMap<string, StatusTransition> = new Map(
  STATUS_TRANSITIONS.map((t) => [transitionKey(t.from, t.to), t]),
);

/**
 * Is this move legal, and legal for this actor?
 *
 * Omitting `agent` answers only "does this edge exist" — use that to render the graph.
 * Passing `agent` answers "may THIS actor make the move" — use that to enable a button.
 * The database re-checks both regardless of what this returns.
 */
export function canTransition(from: ApplicationStatus, to: ApplicationStatus, agent?: AgentName): boolean {
  // A move to the same status is not a transition; the trigger ignores it too.
  if (from === to) return false;
  // Absent from the index means absent from the table, which means the database will refuse it.
  const transition = TRANSITION_INDEX.get(transitionKey(from, to));
  if (!transition) return false;
  // No actor supplied means the caller is only asking whether the edge exists.
  if (!agent) return true;
  // The actor check is what keeps human-only recovery lanes closed to automation.
  return transition.allowedAgents.includes(agent);
}

/** Every status reachable from here, optionally narrowed to what one actor may do. */
export function nextStatuses(from: ApplicationStatus, agent?: AgentName): ApplicationStatus[] {
  return STATUS_TRANSITIONS
    // Only edges leaving the status we were asked about.
    .filter((t) => t.from === from)
    // When an actor is supplied, hide the moves that actor is not permitted to make.
    .filter((t) => !agent || t.allowedAgents.includes(agent))
    // Callers want destinations, not edge records.
    .map((t) => t.to);
}

/** True when nothing may move this row again — used to freeze the kanban card. */
export function isTerminal(status: ApplicationStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}
