// The Tailor's per-page counters, assembled in ONE pure place so a node test can pin them.
//
// WHY THIS IS NOT INLINE IN index.ts: index.ts is glue around Deno.serve and has no test
// (its header says why). The post-screen drain (.github/workflows/postscreen-drain.yml)
// reads these counters to decide whether the `scored` queue ran dry, so a dropped counter
// there is a fail-open: rows the deadline never reached would look like "nothing left".
// Keeping the assembly here lets tailor/page-counts.test.ts go red the moment one is lost.
//
// THE INVARIANT this shape exists to keep: every row the queue select returned lands in
// exactly one bucket, so tailored + refused + skipped + failures + deferred == rows read.
// (One known exception, left on purpose: a skip whose move to `failed` is refused is listed
// in BOTH `skipped` and `failures`; see the comment at that push in index.ts.)

// Type-only: the batch runner's outcome carries the count of rows the deadline left unreached.
import type { BatchOutcome } from "../_shared/agent/deadline.ts";
// Type-only: the planner's skip record, passed through to the response unchanged.
import type { SkippedRow } from "../_shared/tailor/tailor-batch.ts";

// What index.ts has counted by the time the batch finishes; each field is one bucket.
export interface TailorPageInput {
  // Rows persisted as a tailored resume.
  readonly tailored: number;
  // Rows the validator honestly refused, persisted as such.
  readonly refused: number;
  // Rows the planner refused before any model call, with the reason for each.
  readonly skipped: readonly SkippedRow[];
  // Rows that errored on the model, the transport or a write; they stay at `scored`.
  readonly failures: readonly { applicationId: string; error: string }[];
  // The deadline runner's result, read only for the rows it never started.
  readonly batch: BatchOutcome;
}

// The counter half of the Tailor's 200 response, in the shape callers already read.
export function tailorPageCounts({ batch, ...counted }: TailorPageInput) {
  // The four counted buckets pass through unchanged; `batch` is the runner's internal outcome
  // and is replaced by the one number callers need. Rows read but never started because the
  // deadline stopped the batch stay at `scored` untouched (not failures). Without `deferred`
  // the drain cannot tell a page CUT by the deadline from one short because the queue ran out.
  return { ...counted, deferred: batch.skippedForDeadline };
}
