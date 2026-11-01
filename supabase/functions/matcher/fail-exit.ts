// The matcher's permanent-failure exit (wiring audit W2, 2026-11-01).
//
// WHY THIS EXISTS: the matcher used to score any passed_filters row, spend a Gemini call on
// it, and only then let the tailor refuse it. Live proof: a SmartRecruiters row with no
// description scored 49, then failed `missing_description` five seconds later. And a row whose
// failure never changes (no description, an answer that can never be read) stayed at
// passed_filters, where the oldest-first queue retried it at the head of every batch.
//
// TWO EXITS, both through the matcher's live edge passed_filters -> failed:
//   1. `withUsableJob`: BEFORE any Gemini call, a row the tailor is guaranteed to refuse is
//      failed. The verdict is the tailor's OWN planner (`planTailorBatch`), not a copy, so the
//      two stages cannot disagree about what a usable job is.
//   2. `settleModelFailures`: AFTER the batch, a row whose model answer could not be read is
//      failed, but only when another row in the same run WAS read (see that function).
//
// SAME WRITE PATH as a score: writeMatchScore (guarded on status = passed_filters, returns the
// stamp) then advanceScoredRow (stamp-guarded RPC, PT409 -> skipped_stale), so a failure has
// exactly the race protection a score has.

// The tailor's planner: the one definition of "a job the tailor can run against".
import { planTailorBatch } from "../_shared/tailor/tailor-batch.ts";
// The guarded write and the guarded move, reused rather than rebuilt.
import { advanceScoredRow, writeMatchScore, type MatchScoreAdvance, type MatchScoreClient } from "./write-score.ts";

// Why the matcher failed a row. Closed, so the failure_reason column holds only named codes.
// The first three are the tailor's own skip reasons, verbatim, so the Health page reads the
// same word whichever stage refused the row.
export type MatcherFailureReason =
  // The job has no non-blank title.
  | "missing_title"
  // The job has no non-blank company name.
  | "missing_company"
  // The job has no non-blank description: the live SmartRecruiters case.
  | "missing_description"
  // Gemini answered with no text at all (a safety block, or an empty candidate list).
  | "gemini_returned_no_text"
  // Gemini answered, and the answer could not be read as a score (bad JSON, wrong shape, NaN).
  | "unreadable_score";

// Fail one passed_filters row: the reason first (payload), then the move (status).
export async function failMatcherRow(
  // The app-user client (RLS applies), or a fake in tests.
  db: MatchScoreClient,
  // The row to fail.
  applicationId: string,
  // Named reason, stored in failure_reason and in the event.
  reason: MatcherFailureReason,
  // The underlying message for the event (e.g. the scorer's parse error); null when the
  // reason says it all.
  detail: string | null,
): Promise<MatchScoreAdvance> {
  // STEP 1, the payload. failure_reason is the column the schema pairs with `failed`. The score
  // columns are CLEARED: if an overlapping run's score landed first, a failed row must not
  // carry it. drop_reason is cleared too, because the row is failed, not dropped.
  const written = await writeMatchScore(db, applicationId, { failure_reason: reason, match_score: null, match_reasoning: null, drop_reason: null });
  // A stale row or a write error ends here; there is no stamp to move on.
  if (written.kind !== "written") return written;
  // STEP 2, the move, on the stamp of our own write.
  return await advanceScoredRow(
    db,
    // The row we just wrote.
    applicationId,
    // The matcher's live edge (application_status_transitions, re-read 2026-11-01).
    "failed",
    // The event names the reason and the stage; the detail rides along only when there is one.
    { reason, stage: "matcher", ...(detail !== null ? { detail } : {}) },
    // Only a row nobody has written since our step 1 may be moved.
    written.updatedAt,
  );
}

// --- exit 1: the usable-job gate, before any Gemini call --------------------------------

// The job columns the tailor's verdict reads. Their KEYS must be present before a blank
// value may count as "missing": postgrest omits a column the select did not name, and an
// omitted column is a query defect. Failing on it would fail every row in the queue.
const JOB_COLUMNS = ["title", "company_name", "description_raw"] as const;

// What the gate concluded about one queue row.
export type UsableJudgement =
  // The tailor would accept it: score it.
  | { readonly kind: "usable" }
  // A property of the stored job that no retry changes: fail it.
  | { readonly kind: "unusable"; readonly reason: Extract<MatcherFailureReason, "missing_title" | "missing_company" | "missing_description"> }
  // Not a verdict about the job: the select lost a column, an embed or a filter. Left at
  // passed_filters and reported, never failed.
  | { readonly kind: "defect"; readonly message: string };

// Narrow `unknown` to a plain object before any property is read.
function isRecord(value: unknown): value is Record<string, unknown> {
  // null and arrays are objects too; neither is a row.
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Judge one queue row with the tailor's planner. Pure: no database, no clock.
export function judgeUsableJob(row: unknown): UsableJudgement {
  // The tailor's verdict on a batch of one; no skip means it would tailor this row.
  const skip = planTailorBatch([row]).skipped[0];
  // Usable: hand it on.
  if (skip === undefined) return { kind: "usable" };
  // Only a missing field is a property of the job. Everything else is the query or the
  // liveness signal: no_job_joined (under jobs!inner a null embed is a lost !inner, which
  // nulls a DISAPPEARED job's embed), posting_disappeared (a repost clears it), and
  // liveness_unknown / malformed_row (the select's shape). None of those may become `failed`.
  if (skip.reason !== "missing_title" && skip.reason !== "missing_company" && skip.reason !== "missing_description") {
    // Named, so the run's error_detail says which.
    return { kind: "defect", message: `usable-job: ${skip.reason}; row left at passed_filters` };
  }
  // The embed planTailorBatch just judged; re-read here only to check which keys came back.
  const job = isRecord(row) ? row["jobs"] : null;
  // The first job column the select did not return, if any.
  const absent = isRecord(job) ? JOB_COLUMNS.find((column) => !(column in job)) : "jobs";
  // An absent column reads as a blank one to planTailorBatch: a query defect, not a verdict.
  if (absent !== undefined) return { kind: "defect", message: `usable-job: the select returned no ${absent}; row left at passed_filters` };
  // Present and blank: the job itself is unusable, and will be on every retry.
  return { kind: "unusable", reason: skip.reason };
}

// What the gate did with a row it did not hand on.
export type UsableGateOutcome =
  // Moved to failed by this run.
  | { readonly kind: "failed"; readonly reason: MatcherFailureReason }
  // Another run moved or wrote the row first; nothing was done here.
  | { readonly kind: "skipped_stale" }
  // A defect, or the failure write/move failed; the row stays at passed_filters.
  | { readonly kind: "error"; readonly message: string };

// Wrap the matcher's per-row handler so an unusable job is failed BEFORE it is reached. Built
// as a wrapper, like withTechPreGate, so "no Gemini call for an unusable row" is a property of
// the call graph a spy can check, not a convention inside the scorer.
export function withUsableJob<R extends { readonly id: string }, C>(
  // The client used for the failure write.
  db: MatchScoreClient,
  // Told about every row the gate handled itself, so the caller can count it.
  onGated: (row: R, outcome: UsableGateOutcome) => void,
  // The pre-gate + scorer chain; reached only for a usable row.
  next: (row: R, call: C) => Promise<void>,
): (row: R, call: C) => Promise<void> {
  return async (row, call) => {
    // The tailor's verdict on this row.
    const verdict = judgeUsableJob(row);
    // Usable: on to the tech pre-gate and the scorer, unchanged.
    if (verdict.kind === "usable") return await next(row, call);
    // A defect is reported and the row is left exactly as it was.
    if (verdict.kind === "defect") return onGated(row, { kind: "error", message: verdict.message });
    // An unusable job: failed through the guarded write and move. Contained, because this sits
    // outside the scorer's try/catch and runBatchWithDeadline has none: an escaped throw would
    // 500 the run and leave its agent_runs row at `running` (the withTechPreGate reasoning).
    let moved: MatchScoreAdvance;
    try {
      // supabase-js reports failures as values; the catch is only for the unexpected.
      moved = await failMatcherRow(db, row.id, verdict.reason, null);
    } catch (err) {
      // Contained to this row.
      moved = { kind: "error", message: `usable-job: failing the row threw: ${err instanceof Error ? err.message : String(err)}` };
    }
    // Moved: report the reason it was failed for.
    if (moved.kind === "advanced") return onGated(row, { kind: "failed", reason: verdict.reason });
    // A lost race or a real error, passed through as is.
    onGated(row, moved);
  };
}

// --- exit 2: answers that could not be read, settled after the batch ---------------------

// A row whose model answer could not be read, held until the batch ends.
export interface ModelAnswerFailure {
  // The row the answer was for.
  readonly applicationId: string;
  // Which of the two answer failures it was.
  readonly reason: Extract<MatcherFailureReason, "gemini_returned_no_text" | "unreadable_score">;
  // The underlying message, for the event and the run's error_detail.
  readonly detail: string;
}

// Fail the held rows, but ONLY when `proven`: some row in this run was scored or dropped,
// i.e. the model and the parser demonstrably work right now.
//
// WHY THE PROOF: an answer that cannot be read is the row's own fault only if other answers
// CAN be read. A model swap (the GEMINI_MODEL secret) or a parser regression makes every answer
// unreadable; failing on that would move the whole queue into `failed`, whose only exit is a
// human. Unproven, the rows stay at passed_filters and the run still reports them, so it reads
// failed on the Health page instead of quietly destroying its queue.
// ponytail: a targeted one-row run can never prove itself, so a safety-blocked pasted job is
// failed by the next untargeted run that scores anything. Add an attempts counter if a lone
// row ever needs failing sooner.
export async function settleModelFailures(
  // The same client as the batch.
  db: MatchScoreClient,
  // The rows held during the batch.
  held: readonly ModelAnswerFailure[],
  // True when this run scored or dropped at least one row on a model answer.
  proven: boolean,
): Promise<{ failed: MatcherFailureReason[]; skippedStale: number; failures: Array<{ applicationId: string; error: string }> }> {
  // Reasons of the rows this call moved to failed, for the run's note.
  const failed: MatcherFailureReason[] = [];
  // Rows another run moved first.
  let skippedStale = 0;
  // Rows left at passed_filters, reported as this run's failures.
  const failures: Array<{ applicationId: string; error: string }> = [];
  // One at a time: at most one batch (25 rows), two round trips each.
  for (const row of held) {
    // Unproven: report and leave the row for the next run.
    if (!proven) {
      // The original message, plus why it was not failed, so Health can tell the two apart.
      failures.push({ applicationId: row.applicationId, error: `${row.detail} (left at passed_filters: no answer was readable this run)` });
      continue;
    }
    // Proven: the row's own answer is at fault, and it will be on every retry.
    const moved = await failMatcherRow(db, row.applicationId, row.reason, row.detail);
    // Moved.
    if (moved.kind === "advanced") failed.push(row.reason);
    // Another run got there first: not ours.
    else if (moved.kind === "skipped_stale") skippedStale += 1;
    // A real write or move failure stays a failure of this run.
    else failures.push({ applicationId: row.applicationId, error: moved.message });
  }
  // All three, so the caller cannot count one and forget the others.
  return { failed, skippedStale, failures };
}
