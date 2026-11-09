/* advanceRecovery - the one write path behind the System health recovery queues (2026-10-09).
 *
 * WHY THIS FILE EXISTS. Rows stuck at applying / needs_verification / blocked_needs_human / failed
 * could be SEEN on System health but not moved: every button was a hard-coded `disabled`, because no
 * screen wrote to `applications`. Under fully automatic submission those rows would rot. This module
 * moves ONE row along ONE human edge and says honestly what happened.
 *
 * WHAT IT REUSES, rather than re-deciding: the approval queue's definition of "no answer"
 * (isNoAnswer) and its read-back (confirmSettle, widened with a `from` for these queues). Two screens
 * that classified a lost response differently would drift into two different lies.
 *
 * THE RULES IT ENFORCES:
 *  - The browser writes no status itself. advance_application_status does, as p_agent 'human', under
 *    RLS (SECURITY INVOKER; the `own applications` policy) and the transition graph.
 *  - EVERY move carries p_expected_updated_at: a row that changed since the operator loaded it is
 *    refused with PT409 under the row lock, so a click on a stale card can never move a row whose
 *    state the operator did not see. (The approval queue sends it only for approvals; recovery moves
 *    sit on the submit boundary, where a stale click is the expensive kind.)
 *  - A lost answer is never reported as failed or as done: the row is re-read, and "still where it
 *    was" after NO answer is said as unknown, because the original call may still commit.
 */

// Shared with the approval queue so "no answer" and "what did the row do" mean one thing everywhere.
import { confirmSettle, isNoAnswer } from '../approval/saveTailoredEdit.ts';
// Same structural type the approval helpers take; the stored row a re-read hands back.
import type { StoredRow } from '../approval/saveTailoredEdit.ts';
// The graph's own status union, so a typo'd status is a compile error rather than a 400.
import type { ApplicationStatus } from '../../data/contract.ts';
// Edges deliberately kept off. Checked HERE, not only by a disabled button, because the database
// allows needs_verification -> approved for a human: the engine is the last place to refuse it.
import { heldReason } from '../../data/humanLanes.ts';

/* The minimal client this needs: the RPC, plus the chained read confirmSettle performs. Typed
   structurally so a test double can stand in without the supabase-js type surface. */
export interface RecoveryClient {
  // advance_application_status; supabase-js RETURNS {error, status}, it does not throw on a 4xx.
  rpc(fn: string, args: Record<string, unknown>): PromiseLike<{ error: { code?: unknown; message?: unknown } | null; status?: unknown }>;
  // The read confirmSettle uses (from().select().eq().maybeSingle()).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the chained builder is only ever walked, never stored.
  from(table: string): any;
}

/* The screen a move was made from, written into the append-only event log. A CLOSED union and a
   REQUIRED field (2026-11-05): the log cannot be corrected later, so a third screen must name itself
   rather than silently inherit 'health_recovery', which is how the Manual apply card nearly would have. */
// 'manual_apply_reopen' (2026-11-07): the Manual apply "Left your queue" Re-open button, so the log tells it apart from a card's own resolve.
export type RecoverySource = 'health_recovery' | 'manual_apply' | 'manual_apply_reopen';

/* One requested move, everything the RPC and the read-back need. */
export interface RecoveryMove {
  // Which screen made the move; recorded as p_detail.source.
  readonly source: RecoverySource;
  // The row.
  readonly applicationId: string;
  // Where the operator SAW it; also what "not landed" is measured against.
  readonly from: ApplicationStatus;
  // Where the operator asked it to go.
  readonly to: ApplicationStatus;
  // updated_at exactly as PostgREST returned it. Never parsed: a JS Date drops microseconds and would
  // make every stamp stale (same reason as buildSettleArgs in saveTailoredEdit.ts).
  readonly stamp: string;
}

/* Every way a move can end. A CLOSED union so the queue renders each case by name and a new case
   is a compile error in the message table, not a silent fallthrough. */
export type RecoveryOutcome =
  // The row is now at `to` because of this click.
  | { readonly kind: 'moved' }
  // Already at `to`, but not by this click (a PT409/guard refusal, then a read-back at the target).
  | { readonly kind: 'already_there' }
  // Somewhere other than `from` or `to`: another tab, the sweeper or the worker moved it first.
  | { readonly kind: 'moved_elsewhere'; readonly stored: StoredRow }
  // PT409: the row changed since it was loaded and nothing moved. The operator must look again.
  | { readonly kind: 'stale' }
  // No answer, and the read-back says it is still at `from`: the call may yet commit. Not a retry.
  | { readonly kind: 'unconfirmed' }
  // No answer AND the read-back failed: nothing is known.
  | { readonly kind: 'unknown' }
  // The database said no for a reason that is not about staleness; its own words are kept.
  | { readonly kind: 'refused'; readonly code: string; readonly message: string };

/* The RPC arguments, built in ONE pure place so a test can prove the stamp and the agent. */
export function buildRecoveryArgs(move: RecoveryMove): Record<string, unknown> {
  return {
    // The row being moved.
    p_application_id: move.applicationId,
    // The target; the transition graph decides whether from -> to is legal for a human.
    p_to_status: move.to,
    // 'human' is the only agent a browser may honestly claim.
    p_agent: 'human',
    // Recorded on the status event, so the log says which screen made the move and from where. A move to failed
    // also names its cause: migration 20261109180000 refuses failed without p_detail.reason and copies it to
    // applications.failure_reason. Only for failed, so every other move logs exactly what it did before.
    p_detail: { source: move.source, from: move.from, ...(move.to === 'failed' ? { reason: 'human_marked_failed' } : {}) },
    // ALWAYS sent (see the header): a stale stamp is refused with PT409 under the row lock.
    p_expected_updated_at: move.stamp,
  };
}

/* Moves one row along one human edge. Never throws: it is awaited while the row's buttons are
   locked, and a throw would leave them locked with no message. */
export async function advanceRecovery(client: RecoveryClient, move: RecoveryMove): Promise<RecoveryOutcome> {
  // A held edge never reaches the database, whatever called this (a forced click, a future screen).
  const held = heldReason(move.from, move.to);
  // Refused locally with the hold's own sentence; 'HELD' is not a SQLSTATE, so it cannot be mistaken for one.
  if (held !== null) return { kind: 'refused', code: 'HELD', message: held };
  // Held as the shape supabase-js returns, so the lost-answer test below can read status and error.
  let result: { error: { code?: unknown; message?: unknown } | null; status?: unknown };
  try {
    // The one write.
    result = await client.rpc('advance_application_status', buildRecoveryArgs(move));
  } catch {
    // A throwing client is a lost answer, the same as status 0.
    result = { error: null, status: 0 };
  }
  // No error and a real response: the database accepted the move.
  if (result.error === null && result.status !== 0) return { kind: 'moved' };
  // A lost answer (status 0, or an error with no SQLSTATE) is not a verdict; re-read before saying anything.
  if (isNoAnswer(result.status, result.error)) {
    // What the row says now, measured against this move's real source.
    const check = await confirmSettle(client, move.applicationId, move.to, move.from);
    // At the target: our call (or an identical one) landed.
    if (check.kind === 'landed') return { kind: 'moved' };
    // Somewhere else entirely: name it.
    if (check.kind === 'moved_elsewhere') return { kind: 'moved_elsewhere', stored: check.stored };
    // Still at the source after NO answer proves nothing yet: the call may still commit after this read.
    if (check.kind === 'not_landed') return { kind: 'unconfirmed' };
    // The re-read failed as well.
    return { kind: 'unknown' };
  }
  // From here the database answered with a SQLSTATE; narrowed for the checks below.
  const code = typeof result.error?.code === 'string' ? result.error.code : '';
  // Its own words, kept for the 'refused' message.
  const message = typeof result.error?.message === 'string' ? result.error.message : 'the move was refused.';
  /* The refusals that can mean "someone else already moved it": the stale stamp (PT409) and the
     transition guard (42501 / 23514), which refuses a move whose source the row has left. Re-read so
     the operator is told where the row IS, never just "failed" on a row that settled elsewhere. */
  if (code === 'PT409' || code === '42501' || code === '23514') {
    // Measured against this move's real source.
    const check = await confirmSettle(client, move.applicationId, move.to, move.from);
    // At the target, but this call was refused, so another actor made the same move.
    if (check.kind === 'landed') return { kind: 'already_there' };
    // Somewhere else: say where.
    if (check.kind === 'moved_elsewhere') return { kind: 'moved_elsewhere', stored: check.stored };
    // Still at the source after a stale stamp: the row was edited, not moved. Look again.
    if (code === 'PT409') return { kind: 'stale' };
    // Still at the source after a guard refusal, or unreadable: the database's own reason stands.
    return { kind: 'refused', code, message };
  }
  // Any other SQLSTATE (P0002 not found or not yours, P0001 illegal edge, ...): no re-read changes it.
  return { kind: 'refused', code, message };
}

/* The sentence each outcome shows. ONE table, keyed by the closed union, so every message is
   reviewable in one place and each must be true for every way its outcome arises. */
export function describeRecovery(outcome: RecoveryOutcome, move: Pick<RecoveryMove, 'from' | 'to'>): string {
  // Exhaustive by construction: a new outcome kind fails to compile here.
  switch (outcome.kind) {
    /* At the target. Worded as the row's state, not "this click did it": after a lost answer the
       read-back cannot tell our call from an identical one by another tab. */
    case 'moved':
      return `Moved from ${move.from} to ${move.to}: the row now reads ${move.to}.`;
    // Refused, yet the row is at the target: someone else got there first.
    case 'already_there':
      return `Already at ${move.to}: another tab or agent made this move first. Nothing else changed.`;
    // Elsewhere: name the status it is actually in.
    case 'moved_elsewhere':
      return `Not moved: the row is now at ${outcome.stored.status}, changed elsewhere since you loaded it.`;
    // PT409: edited since loaded, still at the source.
    case 'stale':
      // No claim that the re-read succeeded: the queue says so itself if it fails.
      return `Not moved: this row changed since you loaded it. Check the re-read queue below, then try again.`;
    // No answer, still at the source: unknown, and retrying could double-apply.
    case 'unconfirmed':
      return `No answer from the database, and the row still reads ${move.from}. The move may still land, so reload before trying again.`;
    // No answer and no read.
    case 'unknown':
      return `No answer from the database, and the row could not be re-read. Reload the page to see where it is.`;
    // The database's own reason.
    case 'refused':
      return `Not moved (${outcome.code || 'error'}): ${outcome.message}`;
  }
}

/* What the confirm dialog says before any write: the row, the move, and what it means. Kept beside
   the write so the warning and the action cannot drift apart. */
export function confirmText(label: string, move: Pick<RecoveryMove, 'from' | 'to'>): string {
  // The extra sentence only for the move whose consequence is not obvious from the status names.
  const why =
    move.from === 'applying'
      ? '\n\nOnly do this if the worker is no longer running this row: it marks the submission as needing a check.'
      : move.to === 'applied'
        ? '\n\nOnly do this if you can see the application was actually submitted.'
        : '';
  // Named row, named move, then the consequence.
  return `Move "${label}" from ${move.from} to ${move.to}?${why}`;
}
