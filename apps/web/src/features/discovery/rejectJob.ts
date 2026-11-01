/* rejectJob - the Discovered page's one-click Reject on a job card, and its Undo (2026-11-01).
 *
 * WHY THIS FILE EXISTS. Teja triages hundreds of "Ready to tailor" rows and asked for "a reject button
 * on every card job we have in the page". Reject must be ONE click, so it has no confirm dialog. That
 * is safe only because the move is reversible: passed_filters -> dropped_filter has a human edge back
 * (dropped_filter -> passed_filters, migration 20261031200000), and the page offers it as Undo.
 *
 * WHY NOT features/health/advanceRecovery.ts, which also moves a row as 'human'. Two misfits:
 *  - it hard-codes p_detail { source: 'health_recovery' }, so the event log would name the wrong screen;
 *  - it REQUIRES an updated_at stamp, which this page's list query does not read and an Undo would not
 *    have (the RPC's returned row is dropped by that helper).
 * Its client type and the shared "no answer" rule (isNoAnswer) are reused below instead.
 *
 * NO STAMP, deliberately, matching the Approval queue's own reject (it sends p_expected_updated_at for
 * approvals only). Both moves here are reversible, and the transition graph still refuses any move whose
 * source the row has already left for a status with no human edge to the target.
 *
 * A RETRY IS SAFE. advance_application_status treats a same-status call as a no-op success (only
 * applying -> applying is refused), so clicking Reject again after a lost answer cannot move a row twice.
 */

// The approval queue's definition of "the database gave no answer", so two screens never disagree on it.
import { isNoAnswer } from '../approval/saveTailoredEdit.ts';
// The graph mirror's own predicate: is this edge real, and may a human walk it.
import { canTransition } from '../../data/contract.ts';
// The status union, so a typo'd status is a compile error rather than a 400.
import type { ApplicationStatus } from '../../data/contract.ts';
// Type only: the one-method client shape (rpc) the recovery queues already use, so supabase fits as-is.
import type { RecoveryClient } from '../health/advanceRecovery.ts';

// Where a rejected job goes: the graph's existing "a human threw it away" status, not a new one.
export const REJECTED_STATUS: ApplicationStatus = 'dropped_filter';

/* Should a card in this status show Reject? Only when BOTH edges are real human moves: the reject
   itself, and the way back that Undo performs. A one-click destructive move with no way back would
   need a confirm dialog, which this button deliberately does not have. Today that is passed_filters
   only: `discovered` has no human edge to dropped_filter, and deduped / scored / awaiting_approval
   have no human edge back. */
export function canReject(status: ApplicationStatus): boolean {
  // Both directions read from the graph, never a typed list, so a new edge changes this by itself.
  return canTransition(status, REJECTED_STATUS, 'human') && canTransition(REJECTED_STATUS, status, 'human');
}

/* One requested move. A CLOSED union, so this helper can only ever reject or undo a reject: the page
   cannot reuse it to push a row anywhere else, which is the fast-path forgery this page once had. */
export interface RejectMove {
  // Reject sends the row to dropped_filter; undo sends it back to `from`.
  readonly kind: 'reject' | 'undo';
  // The row.
  readonly applicationId: string;
  // The lane status the card was rejected FROM; the place Undo returns it to.
  readonly from: ApplicationStatus;
}

/* The RPC arguments, built in ONE pure place so a test can pin the target, the agent and the detail. */
export function buildRejectArgs(move: RejectMove): Record<string, unknown> {
  return {
    // The row being moved.
    p_application_id: move.applicationId,
    // Reject drops it; undo returns it to the lane it was rejected from.
    p_to_status: move.kind === 'reject' ? REJECTED_STATUS : move.from,
    // 'human' is the only agent a browser may honestly claim, and needs no agent key.
    p_agent: 'human',
    // Written as a 'note' event (the RPC sets no drop_reason column), so the log says who and where.
    p_detail: { reason: move.kind === 'reject' ? 'human_rejected' : 'human_undo_reject', screen: 'discovered' },
  };
}

/* Every way a move can end. Closed, so the page renders each case by name. */
export type RejectOutcome =
  // The database confirmed the move: only now may the card leave the list.
  | { readonly kind: 'moved' }
  // No answer (dropped network, or an error with no SQLSTATE): the move may or may not have landed.
  | { readonly kind: 'no_answer' }
  // The database (or the local graph check) said no; its own code and words are kept.
  | { readonly kind: 'refused'; readonly code: string; readonly message: string };

/* Maps what supabase-js RESOLVED (it returns {error, status}; it does not throw) to an outcome. */
export function rejectOutcome(result: { readonly error: { code?: unknown; message?: unknown } | null; readonly status?: unknown }): RejectOutcome {
  // The positive shape only: no error AND a 2xx. Anything else is not a confirmed move.
  if (result.error === null && typeof result.status === 'number' && result.status >= 200 && result.status < 300) return { kind: 'moved' };
  // Status 0 or a code-less error is the network, not a verdict.
  if (isNoAnswer(result.status, result.error)) return { kind: 'no_answer' };
  // The SQLSTATE, or '' when the shape carried none (an odd non-2xx with no error object).
  const code = typeof result.error?.code === 'string' ? result.error.code : '';
  // The database's own words, or a stated placeholder rather than "undefined".
  const message = typeof result.error?.message === 'string' ? result.error.message : 'the database gave no usable answer.';
  // Refused: the card stays where it is.
  return { kind: 'refused', code, message };
}

/* Performs one move. Never throws: it is awaited while the card's buttons are locked, and a throw
   would leave them locked with no message. */
export async function moveRejectedJob(client: Pick<RecoveryClient, 'rpc'>, move: RejectMove): Promise<RejectOutcome> {
  // Refused locally when the lane is not reversibly rejectable, whatever called this (a forced click, a future lane).
  if (!canReject(move.from)) return { kind: 'refused', code: 'NOT_OFFERED', message: `Reject is not offered for ${move.from} rows.` };
  try {
    // The one write, mapped by the pure function above.
    return rejectOutcome(await client.rpc('advance_application_status', buildRejectArgs(move)));
  } catch {
    // A throwing client is a lost answer, the same as status 0.
    return { kind: 'no_answer' };
  }
}

/* The sentence each outcome shows. One table, so every message is reviewable in one place. */
export function describeReject(outcome: RejectOutcome, kind: RejectMove['kind'], label: string, laneLabel: string): string {
  // Exhaustive: a new outcome kind fails to compile here.
  switch (outcome.kind) {
    // Confirmed by the database, so stated as done.
    case 'moved':
      return kind === 'reject' ? `Rejected ${label}.` : `Undone: ${label} is back in ${laneLabel}.`;
    // Unknown, said as unknown; a retry is safe because a same-status call is a no-op.
    case 'no_answer':
      return `No answer from the database, so ${label} may not be ${kind === 'reject' ? 'rejected' : 'restored'}. Reload to see where it is; trying again is safe.`;
    // The database's own reason, with its code for diagnosis.
    case 'refused':
      return `Could not ${kind === 'reject' ? 'reject' : 'undo the reject of'} ${label} (${outcome.code || 'error'}): ${outcome.message}`;
  }
}
