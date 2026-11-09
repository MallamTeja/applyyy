// Matcher score write and status move — STEP 1 and STEP 2 of the payload-before-status rule,
// extracted from index.ts so both guards can be unit-tested without Deno.serve, jsr: imports
// or a database.
//
// WHY THE STATUS GUARD (step 1): two overlapping matcher runs (or a retry) can both read a row
// at passed_filters. Filtered by id alone, the loser's write landed on a row the winner had
// already moved to `scored` (or further) and overwrote its score and drop_reason. Requiring
// the row to STILL be at passed_filters makes the loser's write match nothing.
//
// WHY THE STAMP GUARD (step 2): the status guard cannot see a loser that writes BETWEEN the
// winner's write and the winner's RPC — the row is still at passed_filters then. The winner
// would then move the row with its own score in the event while the column holds the
// loser's (and a `scored` row could carry the loser's drop_reason). So step 1 returns the
// updated_at its write produced, and step 2 sends it as p_expected_updated_at: the RPC
// refuses a stale stamp under the row lock with PT409 (migration 20261008130000), so only
// the run whose payload is actually in the row can move it.

// The closed set of matcher failure codes, required by the `failed` overload of advanceScoredRow.
// Type-only: fail-exit.ts imports values from here, and a type import is erased, so there is no cycle.
import type { MatcherFailureReason } from "./fail-exit.ts";

// The matcher's input status: index.ts reads its queue with exactly this filter, so a row
// at any other status was taken by someone else and is not ours to write.
export const MATCHER_INPUT_STATUS = "passed_filters";

// Supabase's error shape, narrowed to the one field read here.
type DbError = { message: string } | null;

// Only the calls these two steps use, so a test fake has to model nothing else.
// supabase-js satisfies it structurally; no adapter is needed at the call site.
export interface MatchScoreClient {
  from(table: string): {
    // The one write.
    update(values: Record<string, unknown>): MatchScoreFilter;
  };
  // The status move. supabase-js never throws here; a refusal comes back as `{ error }`
  // with the SQLSTATE in `code`, which is how PT409 is told apart from a real failure.
  rpc(fn: string, args: Record<string, unknown>): PromiseLike<{ error: { code?: string; message: string } | null }>;
}

// Filters chain on themselves; `.select()` ends the chain, because supabase-js returns the
// updated rows ONLY when asked — without it a zero-row update is indistinguishable from one.
interface MatchScoreFilter {
  eq(column: string, value: string): MatchScoreFilter;
  select(columns: string): PromiseLike<{ data: unknown[] | null; error: DbError }>;
}

// Three outcomes, closed: a stale row is neither a success (nothing was written) nor a
// failure (nothing went wrong — another run simply got there first). `written` carries the
// stamp step 2 must present, so a caller cannot reach the RPC without one.
export type MatchScoreWrite =
  | { kind: "written"; updatedAt: string }
  | { kind: "skipped_stale" }
  | { kind: "error"; message: string };

// Write the score payload onto one application, only while it still sits at the input status.
export async function writeMatchScore(
  // The app-user client (RLS applies), or a fake in tests.
  db: MatchScoreClient,
  // The application row to write.
  applicationId: string,
  // match_score, match_reasoning, drop_reason — shaped by the caller, passed through untouched.
  payload: Record<string, unknown>,
): Promise<MatchScoreWrite> {
  const { data, error } = await db
    // The table the queue was read from.
    .from("applications")
    // The payload written before the status RPC (index.ts invariant 2).
    .update(payload)
    // The row this run scored.
    .eq("id", applicationId)
    // THE GUARD: a row already moved by a faster run matches nothing and keeps its score.
    .eq("status", MATCHER_INPUT_STATUS)
    // The touched ids make zero rows observable; updated_at is the stamp step 2 guards with.
    .select("id, updated_at");
  // A real failure stays a failure; the caller records it against the row.
  if (error) return { kind: "error", message: error.message };
  // Zero rows (or a null body) means the guard refused: report the skip, never a write.
  // ponytail: a 0-row result also covers "row deleted or hidden by RLS" — indistinguishable here, and skipping is right for both.
  if (!data || data.length === 0) return { kind: "skipped_stale" };
  // id is a primary key, so this is the one row; read its stamp as the database returned it.
  const stamp = (data[0] as { updated_at?: unknown } | null)?.updated_at;
  // Validate the shape, never trust it: without a real stamp step 2 could only move the row
  // unguarded, which is the race this file exists to close. Fail closed; the row stays at
  // passed_filters and the next run re-scores it.
  if (typeof stamp !== "string" || stamp.length === 0) {
    return { kind: "error", message: "score written but no updated_at returned; status not advanced" };
  }
  // Passed through verbatim: the RPC compares it for exact equality at microsecond precision.
  return { kind: "written", updatedAt: stamp };
}

// Two edges only: the matcher moves a row it scored to `scored` or `dropped_filter`.
// THIRD EDGE (W2, 2026-11-01): `failed`, the live passed_filters -> failed edge the matcher
// already owned and never took. Only fail-exit.ts sends it, for a row whose job is unusable or
// whose model answer can never be read, so such a row stops being retried at the queue head.
export type MatcherTargetStatus = "scored" | "dropped_filter" | "failed";

// Same closed shape as the write: a refused stale stamp is the race lost, not a failure.
export type MatchScoreAdvance =
  | { kind: "advanced" }
  | { kind: "skipped_stale" }
  | { kind: "error"; message: string };

// A move to `failed` must name its reason: the overload requires `detail.reason` from the closed
// MatcherFailureReason set (2026-11-09). Before, this helper took any detail for any edge and left
// the database's blank-reason refusal as the only control. Type-only import: fail-exit.ts imports
// this file's values, so a value import back would be a cycle; a type import is erased.
export function advanceScoredRow(
  db: MatchScoreClient,
  applicationId: string,
  toStatus: "failed",
  detail: Record<string, unknown> & { readonly reason: MatcherFailureReason },
  expectedUpdatedAt: string,
): Promise<MatchScoreAdvance>;
// The two score edges keep their free-form event detail.
export function advanceScoredRow(
  db: MatchScoreClient,
  applicationId: string,
  toStatus: Exclude<MatcherTargetStatus, "failed">,
  detail: Record<string, unknown>,
  expectedUpdatedAt: string,
): Promise<MatchScoreAdvance>;
// Move one scored row, only if nobody has written it since this run's own score write.
export async function advanceScoredRow(
  // The same client as the write, so RLS and the agent key apply identically.
  db: MatchScoreClient,
  // The row this run wrote.
  applicationId: string,
  // Chosen by the threshold; the union keeps any other edge unrepresentable.
  toStatus: MatcherTargetStatus,
  // Score, reasoning, band (and reason on a drop) for the application_events witness.
  detail: Record<string, unknown>,
  // The stamp writeMatchScore returned. Required, so an unguarded move cannot be written.
  expectedUpdatedAt: string,
): Promise<MatchScoreAdvance> {
  // The overload closes the type; this refuses what a cast sneaks past it, BEFORE the RPC, so the
  // matcher never relies on the database to name its own failure (CLAUDE.md §6). Shape, not truthiness.
  if (toStatus === "failed" && (typeof detail.reason !== "string" || detail.reason.trim() === "")) {
    // An error the caller records against the row; the row stays where it is.
    return { kind: "error", message: "refused: move to failed without a non-blank detail.reason" };
  }
  const { error } = await db.rpc("advance_application_status", {
    // Target application row identifier parameter.
    p_application_id: applicationId,
    // The threshold's verdict decides the edge.
    p_to_status: toStatus,
    // Acting agent name parameter set to 'matcher'.
    p_agent: "matcher",
    // Event detail JSONB parameter carrying score and reasoning details.
    p_detail: detail,
    // THE STAMP GUARD: refused with PT409 if any write landed after ours.
    p_expected_updated_at: expectedUpdatedAt,
  });
  // No error: the row moved, with this run's payload under it.
  if (!error) return { kind: "advanced" };
  // PT409: another run wrote the row after us, so the move belongs to that run, not this one.
  if (error.code === "PT409") return { kind: "skipped_stale" };
  // Anything else is a real failure; the caller records it against the row.
  return { kind: "error", message: error.message };
}
