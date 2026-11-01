// THE TRACKER'S REPLAY SWEEP (W6, 2026-11-01): every run re-drives stored outcome emails
// whose status move never happened. The I/O half; the decisions are decide.ts's
// replayQueue (which emails are owed) and statusMoveFor (where each one moves), the SAME
// function the first try always used, so the replay can't drift from it.
//
// A separate module from index.ts because index.ts calls Deno.serve on import, so nothing
// in it can run under `node --test`. W6 itself was a glue bug (moves tried once, refusals
// only logged), so the glue is what replay.test.ts exercises, against a supabase-js double.

// Type only: erased under node --test, so the jsr specifier is never resolved there.
import type { SupabaseClient } from "jsr:@supabase/supabase-js@2.58.0";
// The pure decisions the sweep composes. Reused, never forked.
import {
  // Statuses whose non-tracker entry makes older emails stale.
  EMPLOYER_STAGES,
  // The kill-switch verdict every status-writing path consults.
  mayAdvanceStatus,
  // The verdicts worth reading back.
  REPLAYABLE_CLASSIFICATIONS,
  // Which stored emails are owed.
  replayQueue,
  // Where an owed email moves its row, if anywhere: the first-try rule.
  statusMoveFor,
  // The rows the tracker follows; the same list index.ts loads.
  TRACKED_STATUSES,
  // A fresh verdict's shape, for the evidence it carries.
  type MessageDecision,
} from "./decide.ts";
// The status enum, for the running status map.
import type { ApplicationStatus } from "../_shared/contracts/shared-types.ts";

// The newest stored outcome emails read per run. NEWEST, not oldest: rows the replay can
// never move (a low-confidence rejection, a second interview invite) stay in the candidate
// set while their row is active, and an oldest-first window would let them starve every
// newer email, the W2/W4 starvation pattern. The emails pushed out of a newest-first window
// are the oldest, which a newer settled email usually supersedes anyway.
// ponytail: one fixed page; a full page is reported as a run error, paginate if that ever fires.
export const REPLAY_WINDOW = 200;

// PostgREST's default max-rows. A history read that returns this many rows may have been
// cut short, and a missing note would make a moved email look owed: refuse instead.
export const HISTORY_LIMIT = 1000;

/** What one sweep did: moves made, and every error, each of which the run row counts. */
export interface ReplayResult {
  // Moves that committed.
  readonly moved: number;
  // One line per failure; non-empty means Health shows "succeeded with N errors".
  readonly errors: string[];
}

/**
 * Re-drives every owed move once. Never throws, and a failed read refuses ALL moves (an
 * unreadable history must never become "move anyway", CLAUDE.md §6). `liveDecisions` holds
 * the in-memory verdicts for emails stored in THIS call, so their notes keep the
 * classifier's signals and reasoning, which email_events does not store.
 */
export async function replayStoredMoves(
  db: SupabaseClient,
  systemEnabled: boolean | null,
  liveDecisions: ReadonlyMap<string, MessageDecision>,
): Promise<ReplayResult> {
  // Off (false) is a deliberate pause: no reads, no moves, no error. Unreadable (null) is a
  // fault: still no move, but counted, so a broken settings read can't look like a quiet day.
  if (!mayAdvanceStatus(systemEnabled)) {
    // The pause/fault split is the only difference between the two refusals.
    return { moved: 0, errors: systemEnabled === null ? ["kill switch unreadable: no status moves this run"] : [] };
  }
  // Collected across the sweep; returned whole even after an exception.
  const errors: string[] = [];
  // Moves that committed.
  let moved = 0;
  // Exceptions (a client that throws despite its contract) are an error, never a crash.
  try {
    // Fresh statuses, read AFTER this call's receipt confirmations, so a row the receipt
    // just moved to applied is seen at applied.
    const { data: apps, error: appsError } = await db.from("applications").select("id, status").in("status", [...TRACKED_STATUSES]);
    // No statuses, no decisions.
    if (appsError !== null) return { moved, errors: [...errors, `replay: applications read failed: ${appsError.message}`] };
    // Shape-checked: only a string id with a tracked status becomes a candidate row.
    const statusById = new Map<string, ApplicationStatus>();
    // One entry per tracked row.
    for (const row of (apps ?? []) as { id?: unknown; status?: unknown }[]) {
      // Anything else is skipped; skipped rows can't be moved.
      if (typeof row.id === "string" && TRACKED_STATUSES.includes(row.status as ApplicationStatus)) statusById.set(row.id, row.status as ApplicationStatus);
    }
    // Nothing tracked: nothing to replay.
    if (statusById.size === 0) return { moved, errors };
    // The ids every read below is scoped to.
    const ids = [...statusById.keys()];

    // Stored, matched, move-capable emails of tracked rows, moved and pending alike (the
    // moved ones tell replayQueue what is already settled). Newest first; see REPLAY_WINDOW.
    const { data: emails, error: emailsError } = await db
      // RLS scopes it to Teja's rows.
      .from("email_events")
      // Exactly the fields replayQueue shape-checks; no untrusted subject or body text.
      .select("id, provider_message_id, matched_application_id, classification, classification_confidence, received_at")
      // Only rows matched to an application the tracker still follows.
      .in("matched_application_id", ids)
      // Only verdicts that can move a status (receipts, other, unclassified never replay).
      .in("classification", [...REPLAYABLE_CLASSIFICATIONS])
      // Newest first, so a cap never starves fresh mail.
      .order("received_at", { ascending: false })
      // The per-run bound.
      .limit(REPLAY_WINDOW);
    // Without the emails there is nothing to plan from.
    if (emailsError !== null) return { moved, errors: [...errors, `replay: email_events read failed: ${emailsError.message}`] };

    // The tracker's own notes: the done-marker. Projected to the one field the planner reads.
    const { data: notes, error: notesError } = await db
      // The append-only event log; read only, never written here.
      .from("application_events")
      // PostgREST's JSON path projection: the id alone, not the whole detail blob.
      .select("provider_message_id:detail->>provider_message_id")
      // advance_application_status writes p_detail as a 'note', beside the trigger's status_change.
      .eq("event_type", "note")
      // Only the tracker's notes carry an email's message id.
      .eq("agent", "tracker")
      // Scoped to the rows this sweep could move.
      .in("application_id", ids)
      // Bounded; a full page is treated as truncated below.
      .limit(HISTORY_LIMIT);
    // Moves by anyone into an employer stage; the planner keeps the non-tracker ones.
    const { data: stageMoves, error: stageError } = await db
      // Same log.
      .from("application_events")
      // The fields the staleness rule reads; agent is null-able, and the planner handles null.
      .select("application_id, agent, to_status, created_at")
      // Written by the log_status_change trigger, one per move, with the acting agent.
      .eq("event_type", "status_change")
      // Only employer stages supersede; submit bookkeeping moves never do.
      .in("to_status", [...EMPLOYER_STAGES])
      // Scoped to the rows this sweep could move.
      .in("application_id", ids)
      // Bounded; a full page is treated as truncated below.
      .limit(HISTORY_LIMIT);
    // Unreadable history: every email would look owed or fresh. Refuse every move.
    const historyError = notesError ?? stageError;
    if (historyError !== null) return { moved, errors: [...errors, `replay: application_events read failed: ${historyError.message}`] };
    // A page at the cap may be truncated: same refusal, same reason.
    if ((notes ?? []).length >= HISTORY_LIMIT || (stageMoves ?? []).length >= HISTORY_LIMIT) {
      // Named so the operator knows which bound to raise.
      return { moved, errors: [...errors, `replay: application_events read hit ${HISTORY_LIMIT} rows; refusing moves on possibly truncated history`] };
    }
    // A full window is not a refusal (the newest emails are all in it), but it is reported.
    if ((emails ?? []).length >= REPLAY_WINDOW) errors.push(`replay: window full (${REPLAY_WINDOW} newest stored outcome emails); older ones were not considered`);

    // The owed emails, oldest first.
    const queue = replayQueue({ emails: emails ?? [], trackerNotes: notes ?? [], stageMoves: stageMoves ?? [] });
    // One move attempt per owed email.
    for (const email of queue) {
      // Where the row is now, as far as this sweep knows.
      const current = statusById.get(email.applicationId);
      // Not tracked any more: leave it.
      if (current === undefined) continue;
      // The first-try rule, unchanged: a target exists, the graph lets the tracker walk the
      // edge, AND the confidence gate passes. A low-confidence verdict, a duplicate invite,
      // or a row still in needs_verification all return null here and simply wait.
      const target = statusMoveFor(email, current);
      // Nothing owed at this status.
      if (target === null) continue;
      // Fresh emails keep the classifier evidence the first-try note always carried.
      const live = liveDecisions.get(email.messageId);
      // The only correct way to change status.
      const { error: moveError } = await db.rpc("advance_application_status", {
        // Application UUID.
        p_application_id: email.applicationId,
        // Destination status.
        p_to_status: target,
        // Acting agent; the guard checks the edge allows it.
        p_agent: "tracker",
        // Becomes the note that marks this email done, in the move's own transaction.
        p_detail: {
          // The done-marker key: which email caused it.
          provider_message_id: email.messageId,
          // How it was read.
          classification: email.classification,
          // With what confidence.
          confidence: email.confidence,
          // The stored row, for a human audit.
          email_event_id: email.eventId,
          // When the employer sent it.
          received_at: email.receivedAt,
          // On which signals, and in words, when this call decided it.
          ...(live === undefined ? {} : { matched_signals: live.matchedSignals, reasoning: live.reasoning }),
        },
      });
      // A refusal is a run error now, not just a log line: it stays owed and is retried
      // next run, and Health stops showing green meanwhile.
      if (moveError !== null) {
        // Detail to the log.
        console.error(`[email-tracker-intake] replay move failed for app ${email.applicationId}: ${moveError.message}`);
        // And to the run row.
        errors.push(`advance ${email.applicationId} ${current}->${target} failed: ${moveError.message}`);
      } else {
        // Later emails for the same row see the new status.
        statusById.set(email.applicationId, target);
        // Counted.
        moved += 1;
        // Operational trace.
        console.info(`[email-tracker-intake] advanced app ${email.applicationId} from ${current} to ${target}`);
      }
    }
  } catch (err) {
    // Same handling as an error result.
    errors.push(`replay exception: ${String(err)}`);
  }
  // Everything that happened.
  return { moved, errors };
}
