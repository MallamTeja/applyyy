// The normalizer's duplicate lookup against public.jobs, extracted from normalizer/index.ts so
// its failure handling can be unit-tested with a fake supabase-js answer.
//
// WHY THIS FILE EXISTS: the inline lookup read only `data` and dropped `error`. supabase-js
// does not throw on a failed query; it returns `{ data: null, error }`. So a failed lookup
// returned null — the same value as "no existing job" — and the planner advanced the row to
// `deduped`, letting a possible duplicate through on a database error (CLAUDE.md §6: the
// permissiveness of the reader is the fail-open). The result is now a closed union, so a
// failure cannot be spelled the same way as "none".

// The three answers, closed: "none" is only ever produced by a successful, well-shaped query.
import type { ExistingJobResult } from "./normalize-batch.ts";

// Only the chain this lookup uses, so a test fake has to model nothing else.
// supabase-js satisfies it structurally; no adapter is needed at the call site.
export interface ExistingJobClient {
  from(table: string): {
    // The one read.
    select(columns: string): ExistingJobFilter;
  };
}

// Filters chain on themselves; `.limit()` ends the chain and is awaited.
interface ExistingJobFilter {
  eq(column: string, value: string): ExistingJobFilter;
  neq(column: string, value: string): ExistingJobFilter;
  limit(n: number): PromiseLike<{ data: unknown[] | null; error: { message: string } | null }>;
}

// Builds the lookup planNormalizeBatch calls once per item that has no in-batch duplicate.
export function createExistingJobLookup(db: ExistingJobClient) {
  return async (userId: string, fingerprint: string, excludeJobId: string): Promise<ExistingJobResult> => {
    const { data, error } = await db
      // Target jobs table.
      .from("jobs")
      // Only the id is needed to link a duplicate.
      .select("id")
      // Filter by user ID for tenant isolation.
      .eq("user_id", userId)
      // Filter by canonical fingerprint digest.
      .eq("fingerprint", fingerprint)
      // Exclude the current job being evaluated.
      .neq("id", excludeJobId)
      // One match is enough to call it a duplicate.
      .limit(1);
    // A failed query is a failure, never "no rows": the row must not move on it.
    if (error) return { kind: "failed", message: error.message };
    // A null or non-array body without an error is malformed, not empty; fail closed too.
    if (!Array.isArray(data)) return { kind: "failed", message: "jobs lookup returned no rows array" };
    // A well-formed empty answer is the only way to reach "none".
    if (data.length === 0) return { kind: "none" };
    // Read the id defensively: a row without a string id is not a link we can record.
    const id = (data[0] as { id?: unknown } | null)?.id;
    // Shape-checked, so a malformed row fails closed instead of linking to garbage.
    if (typeof id !== "string" || id.length === 0) return { kind: "failed", message: "jobs lookup row has no id" };
    // A real duplicate, with the job it duplicates.
    return { kind: "found", jobId: id };
  };
}
