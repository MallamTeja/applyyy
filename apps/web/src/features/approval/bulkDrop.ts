/* Approvals-page bulk drop (pending board parcel 8, "Teja's clicks", 2026-11-21): the pure rule.
 * Teja ticks several queue rows and drops them in one go. Moving a row out of awaiting_approval to
 * dropped_filter is a HUMAN-only edge (migration 20260909234900), so nothing here writes: the page
 * hands the ids to settle(), which sends one advance_application_status RPC per row as the human
 * and reports each outcome, so one failure never hides the others.
 * Kept out of the page so the "which rows may one click send" rule is testable without a DOM. */

/* The ids one bulk-drop click may send: the ticked rows that are ON SCREEN, in screen order.
 * Driven by the visible list, not by the tick set, because a tick can outlive its row: a search
 * hides it, or another tab settles it. Teja approves from this page, so a row he cannot see, or
 * did not tick, must never ride along with a bulk move. */
export function bulkDropTargets(selected: ReadonlySet<string>, visibleInOrder: readonly string[]): string[] {
  // Screen order kept; membership decided by the tick set.
  return visibleInOrder.filter((id) => selected.has(id));
}

/* What every bulk-dropped row records, in the key the single Reject already uses
 * (rejectReviewed sends { drop_reason }), so the audit log reads one key for both paths. */
export const BULK_DROP_DETAIL: Readonly<Record<string, unknown>> = Object.freeze({ drop_reason: 'bulk-dropped at approval gate' });

/* The inline confirm's sentence and button subject for `count` rows. The count is in both, so the
 * operator confirms a number, not just a verb. */
export function bulkDropConfirm(count: number): { message: string; action: string } {
  // "application" or "applications", once, so the sentence and the buttons agree.
  const noun = count === 1 ? 'application' : 'applications';
  // The subject InlineConfirm prefixes with "Confirm: " / "Cancel: ".
  const action = `Drop ${count} selected ${noun}`;
  // Same final-warning shape as the single Reject's sentence in DiffView.
  return { message: `${action}? ${count === 1 ? 'It leaves' : 'They leave'} the approval queue and ${count === 1 ? 'is' : 'are'} never submitted. This cannot be undone.`, action };
}
