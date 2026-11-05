// Pins the Tailor's per-page counters: every row read lands in exactly one bucket.
//
// WHY THIS EXISTS: the post-screen drain ends the tailor stage on a clean page that read fewer
// rows than its limit. Before `deferred`, rows the deadline never reached sat in no bucket, so a
// FULL page cut by the deadline summed short and looked like "the queue ran dry" (CLAUDE.md §6).
// This drives the REAL planner and the REAL deadline runner, the same pair index.ts wires up,
// with the per-row outcomes index.ts would record, and checks the sum against the rows read.
import { test } from "node:test";
// Strict, so a mismatch is never papered over by coercion.
import assert from "node:assert/strict";
// The real deadline runner and clock seam; a fake clock makes the cut deterministic.
import { createDeadline, runBatchWithDeadline } from "../_shared/agent/deadline.ts";
// The real planner, so the skipped half comes from the same code index.ts runs.
import { planTailorBatch } from "../_shared/tailor/tailor-batch.ts";
// The unit under test.
import { tailorPageCounts } from "./page-counts.ts";

// A queue row shaped like index.ts's select: id plus a live, complete jobs embed.
function row(id: string, description = "A real posting body.") {
  // disappeared_at present and null = live; without the key the planner skips liveness_unknown.
  return { id, jobs: { title: "Engineer", company_name: "Acme", description_raw: description, disappeared_at: null } };
}

test("a deadline-cut page reports deferred > 0 and every row read lands in exactly one bucket", async () => {
  // Seven rows read: five tailorable, one malformed (no id), one with a blank description.
  const rows: unknown[] = [row("a1"), row("a2"), row("a3"), row("a4"), row("a5"), { nope: true }, row("a6", "   ")];
  // The planner splits them as index.ts's does.
  const plan = planTailorBatch(rows);
  // Guard against a vacuous pass: the fixture must really give 5 tailorable and 2 skipped.
  assert.equal(plan.tailorable.length, 5);
  // Same guard, for the skipped half.
  assert.equal(plan.skipped.length, 2);
  // A clock that moves only when a row "runs", so the stop point is exact.
  let now = 0;
  // 120 s budget; each row below eats 50 s, so rows 1-2 run and the third check stops.
  const deadline = createDeadline({ budgetMs: 120_000, clock: () => now });
  // Counters as index.ts keeps them.
  let tailored = 0;
  // index.ts's refused counter; none refused in this fixture.
  const refused = 0;
  // index.ts's per-row error list.
  const failures: Array<{ applicationId: string; error: string }> = [];
  // Row 1 is tailored, row 2 errors (as a caught Gemini failure would), the rest are cut.
  const batch = await runBatchWithDeadline(plan.tailorable, async (job) => {
    // Time passes for every row that is actually started.
    now += 50_000;
    // First row: a persisted resume.
    if (job.applicationId === "a1") tailored += 1;
    // Any other started row: recorded as an error, still at `scored`.
    else failures.push({ applicationId: job.applicationId, error: "gemini_timeout" });
  }, { deadline, targeted: false });
  // The fixture must actually hit the deadline, or the test proves nothing about deferral.
  assert.equal(batch.stoppedEarly, true);
  // The response counters, built by the code under test.
  const counts = tailorPageCounts({ tailored, refused, skipped: plan.skipped, failures, batch });
  // Three tailorable rows were never started: they are deferred, not lost.
  assert.equal(counts.deferred, 3);
  // THE INVARIANT: the buckets sum to the rows read. Red if `deferred` is dropped or zeroed.
  assert.equal(counts.tailored + counts.refused + counts.skipped.length + counts.failures.length + counts.deferred, rows.length);
});

test("a page that runs to the end reports deferred 0", async () => {
  // Two tailorable rows and an unlimited clock: the queue, not the clock, ends the batch.
  const plan = planTailorBatch([row("b1"), row("b2")]);
  // The frozen clock never runs the budget down.
  const batch = await runBatchWithDeadline(plan.tailorable, async () => {}, { deadline: createDeadline({ budgetMs: 120_000, clock: () => 0 }), targeted: false });
  // Both rows counted as tailored, as index.ts would on success.
  const counts = tailorPageCounts({ tailored: 2, refused: 0, skipped: plan.skipped, failures: [], batch });
  // Zero, and a number: the drain's short-page stop needs exactly `deferred === 0`.
  assert.equal(counts.deferred, 0);
});
