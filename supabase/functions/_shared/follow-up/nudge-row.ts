// Mapping between the follow-up function's application select and its nudge insert.
//
// WHY A SEPARATE FILE: `follow-up/index.ts` imports `jsr:` and cannot run under
// `node --test`, and this mapping is exactly where the original bug lived — column names
// that did not exist on either table. Pulled out so the names are pinned by a test.

// The draft shape the generator produces.
import type { FollowUpNudgeDraft } from "./prompt.ts";

// Everything the function needs from one application row, already validated.
export interface NudgeSource {
  // The application the nudge follows up on.
  readonly applicationId: string;
  // Copied onto the nudge: `follow_up_nudges.user_id` is NOT NULL with no default.
  readonly userId: string;
  // Copied onto the nudge: `follow_up_nudges.job_id` is NOT NULL.
  readonly jobId: string;
  // From `jobs`, the only table that has it.
  readonly companyName: string;
  // From `jobs.title`; applications has no `job_title` column.
  readonly jobTitle: string;
  // When the application went out, for the prompt.
  readonly appliedAt: string;
}

// True for a non-empty string — the one shape every field below must have.
function isText(value: unknown): value is string {
  // An empty string would produce a NOT NULL-satisfying but meaningless row or prompt.
  return typeof value === "string" && value.length > 0;
}

// Read one row of `select("id, user_id, job_id, applied_at, jobs ( title, company_name )")`.
// Returns null for anything incomplete — validate the shape, never trust the cast.
export function readNudgeSource(row: unknown): NudgeSource | null {
  // Not an object at all: nothing to read.
  if (typeof row !== "object" || row === null) return null;
  // Indexed loosely, then every field is checked before use.
  const r = row as Record<string, unknown>;
  // postgrest returns a to-one embed as an object; null when the join found nothing.
  const job = r.jobs as Record<string, unknown> | null | undefined;
  // Without the posting there is nothing to write about.
  if (typeof job !== "object" || job === null) return null;
  // Every field the insert or the prompt needs, all required.
  if (!isText(r.id) || !isText(r.user_id) || !isText(r.job_id) || !isText(r.applied_at)) return null;
  // The two prompt fields from the join.
  if (!isText(job.company_name) || !isText(job.title)) return null;
  // Fully validated.
  return {
    applicationId: r.id,
    userId: r.user_id,
    jobId: r.job_id,
    companyName: job.company_name,
    jobTitle: job.title,
    appliedAt: r.applied_at,
  };
}

// The `follow_up_nudges` insert, column names exactly as the migration declares them
// (phase3_tables_and_gap_fixes.sql:87-110).
export function toNudgeInsert(source: NudgeSource, draft: FollowUpNudgeDraft): Record<string, string> {
  return {
    // Explicit, because the column has no `default auth.uid()`.
    user_id: source.userId,
    // The application this follows up on.
    application_id: source.applicationId,
    // NOT NULL; copied rather than looked up again.
    job_id: source.jobId,
    // `draft_subject`/`draft_body`, not `subject`/`body` — the original bug.
    draft_subject: draft.subject,
    draft_body: draft.body,
    // 'pending' (awaiting the user's review). Not 'draft': a CHECK on
    // ('pending','sent','dismissed') is being added, and 'pending' is the column default.
    status: "pending",
  };
}
