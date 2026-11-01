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
//      failed, but only when another row in the same run WAS read (see that function), AND
//      only on its second strike: the same row unreadable in an EARLIER run too (code-review
//      finding #5, 2026-11-01). A first strike is recorded and the row is retried.
//
// SAME WRITE PATH as a score: writeMatchScore (guarded on status = passed_filters, returns the
// stamp) then advanceScoredRow (stamp-guarded RPC, PT409 -> skipped_stale), so a failure has
// exactly the race protection a score has.

// The tailor's planner: the one definition of "a job the tailor can run against".
import { planTailorBatch } from "../_shared/tailor/tailor-batch.ts";
// The guarded write and the guarded move, reused rather than rebuilt.
import { advanceScoredRow, writeMatchScore, type MatchScoreAdvance, type MatchScoreClient } from "./write-score.ts";

// Supabase's error shape, narrowed to the one field read here.
type DbError = { message: string } | null;

// The strike read: `.eq()` filters chain on themselves and `.in()` ends the chain and is
// awaited. Only the calls settleModelFailures makes, so a fake models nothing else.
interface StrikeQuery {
  // event_type, agent and the detail->>action JSON path.
  eq(column: string, value: string): StrikeQuery;
  // The held rows' ids: one read for the whole batch, not one per row. Last, so it is awaited.
  in(column: string, values: readonly string[]): PromiseLike<{ data: unknown[] | null; error: DbError }>;
}

// The client the settle step needs: the score client (failMatcherRow) plus a read and an append on
// application_events (the strike log). A subtype, not a second parameter, so index.ts passes the
// one `db` it already has. It passes it CAST, as normalizer and cover-letter pass theirs: matching
// supabase-js's generic `select` against any structural chain fails deno check with TS2589
// ("type instantiation is excessively deep"), measured 2026-11-01 on supabase-js 2.58.0.
export interface SettleClient extends MatchScoreClient {
  from(table: string): ReturnType<MatchScoreClient["from"]> & {
    // The strike read.
    select(columns: string): StrikeQuery;
    // The strike append; supabase-js reports a refusal as `{ error }`, never a throw.
    insert(values: Record<string, unknown>): PromiseLike<{ error: DbError }>;
  };
}

// The detail.action tag every strike event carries. The read filters on it, so a later matcher
// 'error' event of another kind can never be counted as a strike.
const STRIKE_ACTION = "model_answer_strike";

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

// What the strike read concluded. Closed: an unreadable history is never "no strikes".
type StrikeHistory =
  // Earlier strikes per held row id; an id with none is absent.
  | { readonly kind: "read"; readonly counts: ReadonlyMap<string, number> }
  // The read failed or came back in a shape not asked for.
  | { readonly kind: "unreadable"; readonly message: string };

// Count the earlier strikes of the held rows in ONE read of application_events. Every strike
// in the log is from an earlier run by construction: this run appends its own only after this read.
async function readPriorStrikes(db: SettleClient, applicationIds: readonly string[]): Promise<StrikeHistory> {
  const { data, error } = await db
    // The append-only log the strikes are written to.
    .from("application_events")
    // The id alone: a strike is counted, never re-read.
    .select("application_id")
    // A strike is an 'error' event…
    .eq("event_type", "error")
    // …that the matcher wrote…
    .eq("agent", "matcher")
    // …tagged as a strike, so no other matcher error can ever count as one.
    .eq("detail->>action", STRIKE_ACTION)
    // Only the rows held this run.
    .in("application_id", applicationIds);
  // A failed read stays a failure; the caller leaves every row (fail-safe = retry).
  if (error) return { kind: "unreadable", message: error.message };
  // A null body is not an empty log: validate the shape asked for, never trust it.
  if (!Array.isArray(data)) return { kind: "unreadable", message: "strike read returned no rows array" };
  // Strikes per row.
  const counts = new Map<string, number>();
  // Each element must be the projection the select named.
  for (const event of data) {
    // The one column asked for.
    const id = isRecord(event) ? event["application_id"] : undefined;
    // One malformed element means the read is not what was asked; trust none of it.
    if (typeof id !== "string") return { kind: "unreadable", message: "strike read returned a row with no application_id" };
    // Counted per row, so another row's strike never arms this one.
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  // ponytail: no .limit(): at most one batch (25 rows) of held ids, and a row stops striking
  // once it fails, so the read stays far under PostgREST's max-rows. A truncated read would
  // only undercount, which retries a row; it can never fail one.
  return { kind: "read", counts };
}

// Fail the held rows, but ONLY when `proven`: some row in this run was scored or dropped,
// i.e. the model and the parser demonstrably work right now. AND only on a SECOND strike.
//
// WHY THE PROOF: an answer that cannot be read is the row's own fault only if other answers
// CAN be read. A model swap (the GEMINI_MODEL secret) or a parser regression makes every answer
// unreadable; failing on that would move the whole queue into `failed`, whose only exit is a
// human. Unproven, the rows stay at passed_filters and the run still reports them, so it reads
// failed on the Health page instead of quietly destroying its queue. An unproven run records no
// strike either, so a regression lasting two runs cannot arm the whole queue for failure.
//
// WHY TWO STRIKES (code-review finding #5, 2026-11-01): LLM output is not deterministic. A
// truncated JSON (MAX_TOKENS) or a one-off glitch on row A, in a run where row B scored, used to
// fail A for good. Now the first strike is appended to application_events (event_type 'error',
// agent 'matcher', detail.action STRIKE_ACTION) and A is retried; only an answer unreadable in
// two SEPARATE runs fails it. An unreadable strike history fails nothing (fail-safe = retry).
// ponytail: a targeted one-row run can never prove itself, so a safety-blocked pasted job is
// failed by the second untargeted run that strikes it. Add an attempts counter if a lone row
// ever needs failing sooner.
export async function settleModelFailures(
  // The same client as the batch; also reads and appends the strike log.
  db: SettleClient,
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
  // Nothing held: nothing to settle, and no strike read.
  if (held.length === 0) return { failed, skippedStale, failures };
  // Unproven: report and leave every row for the next run, with no read and no strike.
  if (!proven) {
    // The original message, plus why it was not failed, so Health can tell the two apart.
    for (const row of held) failures.push({ applicationId: row.applicationId, error: `${row.detail} (left at passed_filters: no answer was readable this run)` });
    // All three, as below.
    return { failed, skippedStale, failures };
  }
  // Proven: the earlier strikes of every held row, in one read.
  const history = await readPriorStrikes(db, held.map((row) => row.applicationId));
  // One at a time: at most one batch (25 rows), two round trips each.
  for (const row of held) {
    // Unknown history: this could be the first strike, so the row is left, and nothing is appended.
    if (history.kind === "unreadable") {
      // The read's own error, so Health shows why the row was left.
      failures.push({ applicationId: row.applicationId, error: `${row.detail} (left at passed_filters: strike history unreadable: ${history.message})` });
      continue;
    }
    // First strike: recorded durably, and the row stays for the next run to ask the model again.
    if ((history.counts.get(row.applicationId) ?? 0) === 0) {
      const { error } = await db
        // Append-only (update/delete revoked and trigger-forbidden), so a strike is never edited.
        .from("application_events")
        // user_id is omitted: its default is auth.uid(), which is what the insert policy checks.
        // agent 'matcher' passes that policy only with the agent key, which createAppUserClient sends.
        .insert({ application_id: row.applicationId, event_type: "error", agent: "matcher", detail: { action: STRIKE_ACTION, reason: row.reason, detail: row.detail } });
      // Reported either way: the row did not progress this run. A failed append is named, since the
      // next run will then count this strike as a first one again (a retry, never a loss).
      failures.push({ applicationId: row.applicationId, error: error ? `${row.detail} (left at passed_filters; recording the first strike failed: ${error.message})` : `${row.detail} (left at passed_filters: first strike, retried next run)` });
      continue;
    }
    // Second strike, in a proven run: the row's own answer is at fault, twice, in two runs.
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
