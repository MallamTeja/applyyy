/* Which parts of the workflow a human has to perform, and whether this console
 * actually offers a control for each.
 *
 * WHY THIS FILE EXISTS. Several edges in the status graph can only be traversed
 * by a person. If the UI offers no control for one, that transition is
 * unreachable and rows pile up in a status nothing can leave. That is a silent
 * stall - and section 14's whole lesson is that the things which kill this
 * system do not error, they just stop. So the console checks its own coverage
 * of the graph and reports gaps as a visible defect.
 *
 * TWO SETS, AND THEY ARE NOT THE SAME SET. An earlier version of this file
 * conflated them and produced a false all-clear, which is worse than no check
 * at all - so the predicate is now stated in each name:
 *
 *   HUMAN_ONLY_LANES      allowedAgents === ['human']      (11 edges)
 *     No automation will ever help. These need PROMINENT controls, because a
 *     person is the only thing that can move the row, ever.
 *
 *   HUMAN_REACHABLE_LANES allowedAgents.includes('human')  (31 edges)
 *     A human is permitted, often as a fallback for an agent. These still need
 *     controls, because the agent may not be running - and section 14 says a
 *     dead scheduled job is silent. `applying -> needs_verification` is the
 *     one that matters most here: it is shared with the sweeper, so it is NOT
 *     human-only, but its own note in the graph calls it SAFETY-CRITICAL, and
 *     if the sweeper has quietly stopped a person must be able to move it.
 *
 * COVERAGE IS CHECKED PER SOURCE STATUS, not per edge. A screen that renders
 * rows in status X and builds its buttons from `nextStatuses(X, 'human')`
 * covers every human-reachable edge out of X at once, and keeps covering them
 * when the schema stream adds one. Fifteen source statuses to claim rather
 * than thirty-one edges to transcribe - and transcribing edges by hand is what
 * produced the bug this file was rewritten to fix.
 *
 * Naming the pattern: the status graph is the single source of truth for the
 * workflow; the database trigger, the agents and this UI are all readers of it.
 * A reader that keeps its own copy is not a reader.
 */

import type { ApplicationStatus, StatusTransition } from './contract';
import { STATUS_TRANSITIONS } from './contract';

/* Edges only a human may traverse. `allowedAgents` is exactly `['human']`. */
export const HUMAN_ONLY_LANES: readonly StatusTransition[] =
  STATUS_TRANSITIONS.filter(
    (transition) =>
      transition.allowedAgents.length === 1 &&
      transition.allowedAgents[0] === 'human',
  );

/* Every edge a human is permitted to traverse, whether or not an agent can
 * too. This is the set that governs UI completeness: an edge a person is
 * allowed to perform needs a way to perform it. */
export const HUMAN_REACHABLE_LANES: readonly StatusTransition[] =
  STATUS_TRANSITIONS.filter((transition) =>
    transition.allowedAgents.includes('human'),
  );

/* Edges where a human is a FALLBACK for an agent rather than the only actor.
 * Derived as the difference so the two sets cannot drift apart. Useful because
 * these deserve a quieter control than the human-only lanes: normally the
 * agent handles them, and the manual path is for when it has stopped. */
export const HUMAN_FALLBACK_LANES: readonly StatusTransition[] =
  HUMAN_REACHABLE_LANES.filter(
    (transition) => transition.allowedAgents.length > 1,
  );

/* Which screen renders rows in a given status and offers the human transitions
 * out of it.
 *
 * A status listed here is a promise: that screen builds its controls from
 * `nextStatuses(status, 'human')`, so it covers whatever the graph currently
 * permits rather than a list someone typed. A status absent from here has no
 * home, and every human-reachable edge leaving it is unreachable. */
const SCREENS_BY_SOURCE_STATUS: Readonly<
  Partial<Record<ApplicationStatus, string>>
> = {
  /* --- The approval gate ---------------------------------------------- */

  /* THE gate. `awaiting_approval -> approved` is human-only and is the ONLY
   * edge into `approved`; `approved -> applying` is the only edge into
   * `applying`. So constraint #15 is unreachable-by-construction: this screen
   * is the single door to submission and nothing can route around it. The
   * graph's own note on the second edge is the sentence worth putting near the
   * approve button - everything upstream of it is reversible, nothing
   * downstream is. Rejecting is a modelled edge too
   * (`awaiting_approval -> dropped_filter`, "a human is the last filter in the
   * cascade"), not an ad-hoc state write. */
  awaiting_approval: 'Approval queue',

  /* Reject-and-re-tailor, human-only so no automated retry loop burns Gemini
   * quota rewriting the same flagged bullet. */
  audit_flagged: 'Approval queue, send back for re-tailoring',

  /* --- The pipeline board --------------------------------------------- */

  /* Post-apply statuses are shared with the email Tracker. The board is
   * therefore NOT read-only: if Gmail forwarding breaks or Apps Script stops,
   * the Tracker advances nothing and every one of these needs a manual move.
   * Each card builds its controls from nextStatuses(status, 'human'). */
  applied: 'Pipeline, manual advance on the card',
  employer_screening: 'Pipeline, manual advance on the card',
  oa_pending: 'Pipeline, manual advance on the card',
  interview: 'Pipeline, manual advance on the card',

  /* Pre-approval discards: the operator read the score, or the JD, and threw
   * the row away before any tailoring was spent on it. */
  discovered: 'Pipeline, discard on the card',
  deduped: 'Pipeline, discard on the card',
  passed_filters: 'Pipeline, discard on the card',
  scored: 'Pipeline, discard on the card',
  tailored: 'Pipeline, discard on the card',

  /* --- The recovery queues on System health --------------------------- */

  /* SAFETY-CRITICAL, and the reason this file was rewritten. A stale `applying`
   * lease means the worker died mid-submit and nobody knows whether it landed.
   * Shared with the sweeper, so it is not human-only - but if the sweeper has
   * quietly stopped, a person must be able to move the row, and submission is
   * the one non-idempotent action in the system. */
  applying: 'System health, stuck-submission queue',

  /* The row that decides whether an application went out. Its edge back to
   * `approved` is human-only by design: a machine must never conclude that a
   * possibly-submitted application was not submitted, because concluding
   * wrongly sends a second one and violates constraint #7. Needs the
   * screenshot as evidence and a deliberate, hard-to-misclick control. */
  needs_verification: 'System health, needs-verification queue',

  /* The captcha and anti-bot lane. Nothing here circumvents them
   * (constraint #5) - the worker screenshots the wall and parks the row, and
   * the operator finishes the application by hand. Because Actions has no
   * human present, this is a normal part of the day rather than a failure,
   * which is why it gets a real queue instead of an error log. */
  blocked_needs_human: 'System health, blocked queue',

  /* The only edge out of `failed` leads to verification rather than back to
   * the queue: a row that failed near the submit boundary must be checked by a
   * person before anything moves it again. */
  failed: 'System health, failed rows',
};

/* Human-reachable edges whose source status no screen claims.
 *
 * Non-empty means there is a status rows can enter and never leave by hand.
 * Surfaced in the UI rather than thrown, because a missing control is an
 * operational gap the operator should see - not a crash that hides the console
 * which would have told them about it. */
export const MISSING_HUMAN_CONTROLS: readonly StatusTransition[] =
  HUMAN_REACHABLE_LANES.filter(
    (transition) => SCREENS_BY_SOURCE_STATUS[transition.from] === undefined,
  );

/* Where the operator performs the human transitions out of a status, for
 * linking to it from wherever the row is being looked at. */
export function humanControlLocation(
  status: ApplicationStatus,
): string | null {
  return SCREENS_BY_SOURCE_STATUS[status] ?? null;
}

/* Is this an edge no automation will ever perform? Used to give the human-only
 * lanes a more prominent control than the fallback ones - on those, the
 * operator is the only actor rather than the backup. */
export function isHumanOnlyLane(
  from: ApplicationStatus,
  to: ApplicationStatus,
): boolean {
  return HUMAN_ONLY_LANES.some(
    (transition) => transition.from === from && transition.to === to,
  );
}
