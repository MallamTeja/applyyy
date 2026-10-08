// Matcher score write — STEP 1 of the payload-before-status rule, extracted from index.ts so
// its status guard can be unit-tested without Deno.serve, jsr: imports or a database.
//
// WHY THE GUARD: two overlapping matcher runs (or a retry) can both read a row at
// passed_filters. Filtered by id alone, the loser's write landed on a row the winner had
// already moved to `scored` (or further) and overwrote its score and drop_reason. Requiring
// the row to STILL be at passed_filters makes the loser's write match nothing.

// The matcher's input status: index.ts reads its queue with exactly this filter, so a row
// at any other status was taken by someone else and is not ours to write.
export const MATCHER_INPUT_STATUS = "passed_filters";

// Supabase's error shape, narrowed to the one field read here.
type DbError = { message: string } | null;

// Only the chain this write uses, so the test fake has to model nothing else.
// supabase-js satisfies it structurally; no adapter is needed at the call site.
export interface MatchScoreClient {
  from(table: string): {
    // The one write.
    update(values: Record<string, unknown>): MatchScoreFilter;
  };
}

// Filters chain on themselves; `.select()` ends the chain, because supabase-js returns the
// updated rows ONLY when asked — without it a zero-row update is indistinguishable from one.
interface MatchScoreFilter {
  eq(column: string, value: string): MatchScoreFilter;
  select(columns: string): PromiseLike<{ data: unknown[] | null; error: DbError }>;
}

// Three outcomes, closed: a stale row is neither a success (nothing was written) nor a
// failure (nothing went wrong — another run simply got there first).
export type MatchScoreWrite =
  | { kind: "written" }
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
    // Ask for the touched ids back so zero rows is observable.
    .select("id");
  // A real failure stays a failure; the caller records it against the row.
  if (error) return { kind: "error", message: error.message };
  // Zero rows (or a null body) means the guard refused: report the skip, never a write.
  // ponytail: a 0-row result also covers "row deleted or hidden by RLS" — indistinguishable here, and skipping is right for both.
  if (!data || data.length === 0) return { kind: "skipped_stale" };
  // At least one row took the payload; id is a primary key, so it is exactly one.
  return { kind: "written" };
}
