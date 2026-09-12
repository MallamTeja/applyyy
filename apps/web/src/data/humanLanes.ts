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

/* `.ts` ON THE SPECIFIER, and it is load-bearing rather than cosmetic.
 * `STATUS_TRANSITIONS` is a VALUE import, so this module is genuinely executed
 * at runtime - and `node --test` runs these sources directly, where Node's ESM
 * resolver requires the extension. Without it this file was IMPOSSIBLE TO TEST:
 * every attempt to import it from the test suite died with
 * ERR_MODULE_NOT_FOUND, which is why the coverage check below - the console's
 * own self-audit - had no tests at all while every other guard in `src/data`
 * had a dozen. `allowImportingTsExtensions` in tsconfig is what lets the same
 * specifier satisfy both tsc and Node. */
import type { ApplicationStatus, StatusTransition } from './contract.ts';
import { STATUS_TRANSITIONS } from './contract.ts';

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

/* HOW FAR A CLAIMED SCREEN ACTUALLY GETS.
 *
 * WHY THIS AXIS HAD TO BE ADDED, and it is the same defect this file's header
 * already describes once. The map below is a list of PROMISES made by whoever
 * wrote it, and the coverage check read those promises as facts - so
 * `MISSING_HUMAN_CONTROLS` came back EMPTY, and an empty list of gaps is
 * indistinguishable on screen from a console that genuinely covers the graph.
 * Verified rather than assumed: with every status claimed, the check reported
 * zero gaps while four of the claimed screens did not exist in any form and
 * not one control in the console could actually perform a transition.
 *
 * A FALSE ALL-CLEAR IS WORSE THAN NO CHECK AT ALL. A missing check prompts
 * somebody to look; a green check tells them not to. That is section 14's
 * lesson applied to the console's own self-audit rather than to the agents: the
 * dangerous state is the one that renders as fine.
 *
 * So a claim now carries how far it got, and the three levels are worth keeping
 * distinct because the operator's exposure differs at each:
 *
 *   'not_built'       No screen renders rows in this status or offers the moves
 *                     out of it. Rows can arrive here and be invisible.
 *   'affordance_only' A screen renders the moves out of this status, derived
 *                     from `nextStatuses(status, 'human')`, but the control is
 *                     disabled because no write path exists yet. The operator
 *                     can SEE what is stuck and still cannot move it.
 *   'operable'        The control performs the transition. NOTHING IS AT THIS
 *                     LEVEL TODAY, and this enum member exists precisely so
 *                     that fact is representable and countable rather than
 *                     implied by silence.
 *
 * The write path is the single dependency for all of it: no screen in this
 * console writes to `applications`, deliberately, because
 * `awaiting_approval -> approved` is human-only and is one of only two edges
 * into `approved` (constraint #15) - so the write path is the submit gate, and
 * it gets built and reviewed on purpose rather than as a side effect of
 * wiring a table. */
export type ScreenReadiness = 'not_built' | 'affordance_only' | 'operable';

/* One claim: which screen owns a status, and how far that screen actually got. */
export interface ControlScreen {
  /* Where the operator is meant to perform the moves, in the words used in the
     navigation rather than a component name - this string is rendered. */
  readonly screen: string;
  readonly readiness: ScreenReadiness;
}

/* Which screen renders rows in a given status and offers the human transitions
 * out of it.
 *
 * A status listed here is a promise: that screen builds its controls from
 * `nextStatuses(status, 'human')`, so it covers whatever the graph currently
 * permits rather than a list someone typed. A status absent from here has no
 * home, and every human-reachable edge leaving it is unreachable.
 *
 * And the promise now records how much of itself it has kept - see
 * `ScreenReadiness` above. */
const SCREENS_BY_SOURCE_STATUS: Readonly<
  Partial<Record<ApplicationStatus, ControlScreen>>
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
  awaiting_approval: { screen: 'Approval queue', readiness: 'affordance_only' },

  /* Reject-and-re-tailor, human-only so no automated retry loop burns Gemini
   * quota rewriting the same flagged bullet. */
  audit_flagged: { screen: 'Approval queue, send back for re-tailoring', readiness: 'affordance_only' },

  /* --- The pipeline board --------------------------------------------- */

  /* Post-apply statuses are shared with the email Tracker. The board is
   * therefore NOT read-only: if Gmail forwarding breaks or Apps Script stops,
   * the Tracker advances nothing and every one of these needs a manual move.
   * Each card builds its controls from nextStatuses(status, 'human'). */
  applied: { screen: 'Pipeline, manual advance on the card', readiness: 'affordance_only' },
  employer_screening: { screen: 'Pipeline, manual advance on the card', readiness: 'affordance_only' },
  oa_pending: { screen: 'Pipeline, manual advance on the card', readiness: 'affordance_only' },
  interview: { screen: 'Pipeline, manual advance on the card', readiness: 'affordance_only' },

  /* Pre-approval discards: the operator read the score, or the JD, and threw
   * the row away before any tailoring was spent on it. */
  discovered: { screen: 'Pipeline, discard on the card', readiness: 'affordance_only' },
  deduped: { screen: 'Pipeline, discard on the card', readiness: 'affordance_only' },
  passed_filters: { screen: 'Pipeline, discard on the card', readiness: 'affordance_only' },
  scored: { screen: 'Pipeline, discard on the card', readiness: 'affordance_only' },
  tailored: { screen: 'Pipeline, discard on the card', readiness: 'affordance_only' },

  /* --- The recovery queues on System health --------------------------- */

  /* SAFETY-CRITICAL, and the reason this file was rewritten. A stale `applying`
   * lease means the worker died mid-submit and nobody knows whether it landed.
   * Shared with the sweeper, so it is not human-only - but if the sweeper has
   * quietly stopped, a person must be able to move the row, and submission is
   * the one non-idempotent action in the system. */
  applying: { screen: 'System health, stuck-submission queue', readiness: 'affordance_only' },

  /* The row that decides whether an application went out. Its edge back to
   * `approved` is human-only by design: a machine must never conclude that a
   * possibly-submitted application was not submitted, because concluding
   * wrongly sends a second one and violates constraint #7. Needs the
   * screenshot as evidence and a deliberate, hard-to-misclick control. */
  needs_verification: { screen: 'System health, needs-verification queue', readiness: 'affordance_only' },

  /* The captcha and anti-bot lane. Nothing here circumvents them
   * (constraint #5) - the worker screenshots the wall and parks the row, and
   * the operator finishes the application by hand. Because Actions has no
   * human present, this is a normal part of the day rather than a failure,
   * which is why it gets a real queue instead of an error log. */
  blocked_needs_human: { screen: 'System health, blocked queue', readiness: 'affordance_only' },

  /* The only edge out of `failed` leads to verification rather than back to
   * the queue: a row that failed near the submit boundary must be checked by a
   * person before anything moves it again. */
  failed: { screen: 'System health, failed rows', readiness: 'affordance_only' },
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

/* --- The three honest coverage numbers -------------------------------- */

/* Human-reachable edges whose owning screen DOES NOT EXIST.
 *
 * The gap `MISSING_HUMAN_CONTROLS` cannot see, because the status IS claimed -
 * just claimed by a screen nobody has written. From the operator's side the
 * consequence is strictly worse than an unclaimed status: rows arrive in a
 * status that no screen in the console renders at all, so they are not merely
 * unmovable, they are invisible. Three of the four such statuses today
 * (`applying`, `needs_verification`, `failed`) sit on the submit boundary,
 * which is the one place in this system where nobody knowing the state is
 * expensive - a row stuck at `applying` means nobody knows whether an
 * application was actually sent. */
export const UNBUILT_HUMAN_CONTROLS: readonly StatusTransition[] =
  HUMAN_REACHABLE_LANES.filter(
    (transition) =>
      SCREENS_BY_SOURCE_STATUS[transition.from]?.readiness === 'not_built',
  );

/* Human-reachable edges whose screen exists and shows the move, but cannot
 * perform it.
 *
 * Reported separately from `UNBUILT_HUMAN_CONTROLS` because the remedy is
 * different and shared: every one of these is waiting on the SAME single
 * dependency, the write path, rather than on a screen each. Collapsing the two
 * lists would make one write-path task look like eleven UI tasks. */
export const INOPERABLE_HUMAN_CONTROLS: readonly StatusTransition[] =
  HUMAN_REACHABLE_LANES.filter(
    (transition) =>
      SCREENS_BY_SOURCE_STATUS[transition.from]?.readiness ===
      'affordance_only',
  );

/* Human-reachable edges a person can actually traverse in this console today.
 *
 * THE NON-VACUITY COUNTERPART to the two lists above, and it is currently
 * EMPTY - which is the honest state and is why it is exported rather than
 * assumed. A coverage report that only ever counts problems cannot be
 * distinguished from one whose predicate is inverted; a report that also counts
 * successes can. When the write path lands, this number rising is the
 * measurement that says so. */
export const OPERABLE_HUMAN_CONTROLS: readonly StatusTransition[] =
  HUMAN_REACHABLE_LANES.filter(
    (transition) =>
      SCREENS_BY_SOURCE_STATUS[transition.from]?.readiness === 'operable',
  );

/* Where the operator performs the human transitions out of a status, for
 * linking to it from wherever the row is being looked at.
 *
 * Returns the screen NAME so existing call sites keep reading as prose. The
 * readiness of that claim is a separate question with a separate accessor -
 * a caller that wants to know whether the control works should have to ask. */
export function humanControlLocation(
  status: ApplicationStatus,
): string | null {
  return SCREENS_BY_SOURCE_STATUS[status]?.screen ?? null;
}

/* How far the claimed screen for a status actually got.
 *
 * Null for an unclaimed status, which is deliberately NOT folded into
 * `'not_built'`: "no screen claims this" and "the claiming screen does not
 * exist" are different defects with different owners, and merging them is how
 * one of them stops being fixed. */
export function controlReadiness(
  status: ApplicationStatus,
): ScreenReadiness | null {
  return SCREENS_BY_SOURCE_STATUS[status]?.readiness ?? null;
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
