// Choosing which rows the Tailor may actually run against.
//
// THE RULE THIS FILE HOLDS: A JOB WITH NO DESCRIPTION IS NOT A JOB TO TAILOR AGAINST,
// it is a row to skip loudly. Handing the model an empty posting does not produce a
// worse tailoring — it produces one with nothing to be faithful TO, which is the
// cheapest possible way to manufacture a fabrication and then blame the model for it.
//
// This is §5 in its usual costume: missing data becoming an answer. The two specific
// traps live in `isUsableText` below, because the obvious check is wrong twice over.
//
// Pure: no database, no clock, no model. The entrypoint does the I/O and hands the rows
// here — the same split `screen-batch.ts` uses, and the reason this logic is testable
// while an Edge Function entrypoint is not.

// The untrusted half of a tailor call, so a planned job is directly callable.
import type { TailorJobInput } from "./tailorer.ts";
// The shared liveness reading, so every reader that adopts it (today only the Tailor)
// agrees on what an absent `disappeared_at` key means.
import { classifyJobLiveness } from "../scout/liveness.ts";

// One planned unit of work: which row to write back to, and what to send the model.
export interface TailorableJob {
  // The `applications` row this verdict will be persisted against.
  readonly applicationId: string;
  // Exactly the shape the tailorer takes, so the caller does no reshaping between
  // planning and execution — a reshape is a place to drop a field.
  readonly input: TailorJobInput;
}

// Why a row will not be tailored. Machine-readable so a caller can count reasons rather
// than grep prose, and named per field so the reason IS the finding.
export type SkipReason =
  | "no_job_joined"
  | "missing_title"
  | "missing_company"
  | "missing_description"
  // The joined job carries a non-null `disappeared_at`: scout-ats saw it drop off a
  // trusted board. Tailoring a closed posting spends a model call on an application
  // that can never be submitted. The row is LEFT at `scored`, never failed, so a
  // repost (planReappearances) can bring it back.
  | "posting_disappeared"
  // The joined job has NO `disappeared_at` key at all, so the select did not ask for it.
  // Distinct from `posting_disappeared` because the fix is in the query, not the data.
  | "liveness_unknown"
  | "malformed_row";

// A row that will not be tailored. Carried rather than silently dropped: a batch that
// processed 3 of 10 rows and said nothing is indistinguishable from one that found only
// 3 rows, and those are very different operational facts.
export interface SkippedRow {
  // Null when the row was so malformed it carried no usable id to report against.
  readonly applicationId: string | null;
  readonly reason: SkipReason;
}

// The plan. Both halves always present, so a caller cannot read one and forget the
// other — the number that matters operationally is the pair, not the successes.
export interface TailorBatchPlan {
  readonly tailorable: readonly TailorableJob[];
  readonly skipped: readonly SkippedRow[];
}

// Narrow `unknown` to a plain object without asserting anything about its fields.
function isRecord(value: unknown): value is Record<string, unknown> {
  // `typeof null` is "object" and arrays are objects too; both must be excluded before
  // any property access below can be trusted.
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Is this a string with actual content?
//
// TWO TRAPS IN ONE FUNCTION, both of which this repo has paid for elsewhere:
//   1. A truthiness check (`if (job.description_raw)`) passes any non-empty string —
//      including "   ", which renders as nothing and tailors against nothing.
//   2. A `!== null` check passes `undefined`, and postgrest returns an absent column as
//      `undefined` rather than `null`. "Is it missing" has two right answers, and
//      picking one of them is exactly how the other gets through.
// Validating the SHAPE — a string, trimmed, non-empty — has one answer.
function isUsableText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

// Plan one batch of `applications` rows joined to their `jobs`.
//
// TAKES `unknown[]` DELIBERATELY. postgrest hands back `unknown[]`, and typing this
// parameter as the happy shape would move the shape check to a cast at the call site,
// where it is invisible and unchecked. These rows are untrusted until this says so.
export function planTailorBatch(rows: readonly unknown[]): TailorBatchPlan {
  // Accumulated rather than returned early: one malformed row must not abandon the
  // other nine, and the caller needs the whole picture from a single pass.
  const tailorable: TailorableJob[] = [];
  const skipped: SkippedRow[] = [];

  for (const row of rows) {
    // A row that is not an object, or carries no id, cannot even be reported against.
    if (!isRecord(row) || typeof row.id !== "string") {
      skipped.push({ applicationId: null, reason: "malformed_row" });
      continue;
    }
    // Bound once so every branch below reports the same id.
    const applicationId = row.id;

    // The join. A left join that matched nothing arrives as null; tailoring against a
    // job we cannot read is not a degraded case, there is no posting at all.
    const job = row.jobs;
    if (!isRecord(job)) {
      skipped.push({ applicationId, reason: "no_job_joined" });
      continue;
    }

    // LIVENESS FIRST: a closed posting is not worth validating further. The query already
    // excludes disappeared jobs (jobs!inner + .is("jobs.disappeared_at", null)); this is
    // defence in depth for a select that lost the column or the filter.
    // classifyJobLiveness fails closed: an absent KEY is 'unknown', never 'live'.
    const liveness = classifyJobLiveness(job);
    // Not selected: the fix is in the query, not the data, hence its own reason.
    if (liveness === "unknown") {
      skipped.push({ applicationId, reason: "liveness_unknown" });
      continue;
    }
    // Selected and set: scout-ats marked it gone.
    if (liveness === "disappeared") {
      skipped.push({ applicationId, reason: "posting_disappeared" });
      continue;
    }

    // Checked field by field so the skip reason names the missing one. A single
    // "incomplete_job" would send whoever investigates back to the database to work out
    // which of three columns it actually was.
    if (!isUsableText(job.title)) {
      skipped.push({ applicationId, reason: "missing_title" });
      continue;
    }
    if (!isUsableText(job.company_name)) {
      skipped.push({ applicationId, reason: "missing_company" });
      continue;
    }
    // The one that matters most — see this file's header. An empty description is the
    // input that turns the Tailor into a fabricator.
    if (!isUsableText(job.description_raw)) {
      skipped.push({ applicationId, reason: "missing_description" });
      continue;
    }

    // Every field present and non-blank. Only now is this a unit of work.
    //
    // The three narrowings above are what make this construction typecheck without a
    // cast: `isUsableText` is a type predicate, so the compiler knows each field is a
    // `string` here. A cast would have compiled just as well and checked nothing — the
    // predicate is doing real work, not decorating an assertion.
    tailorable.push({
      applicationId,
      input: { jobTitle: job.title, company: job.company_name, jobDescription: job.description_raw },
    });
  }

  return { tailorable, skipped };
}
