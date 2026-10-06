// Tests for choosing which rows the Tailor may run against.
//
// THE RULE UNDER TEST: A JOB WITH NO DESCRIPTION IS NOT A JOB TO TAILOR AGAINST. Handing
// the model an empty posting does not produce a worse tailoring — it produces one with
// nothing to be faithful TO, which is the cheapest way to manufacture a fabrication and
// then blame the model for it. Every skip case below is a row that would otherwise reach
// Gemini as a well-formed request about nothing.
//
// WHY THE SKIPS ARE ASSERTED AND NOT JUST THE SUCCESSES: a planner that silently dropped
// bad rows would pass a test that only counted the good ones. A batch which processed 3
// of 10 rows and said nothing is indistinguishable from one that found only 3 rows, and
// those are very different operational facts.
import { test } from "node:test";
// Strict, so a missing key never compares equal to a key holding `undefined`.
import assert from "node:assert/strict";
// Extension-suffixed specifier so this runs under Deno and `node --test` alike.
import { planTailorBatch } from "./tailor-batch.ts";
// The run-level helpers moved to the shared liveness module so every reader that adopts
// them names a lost column identically; tested here against the Tailor's own row shape.
import { allLivenessUnknown, classifyJobLiveness, LIVENESS_UNKNOWN_DETAIL } from "../scout/liveness.ts";

// A complete joined row, so each test can break exactly one field.
const COMPLETE_ROW = {
  id: "app-1",
  jobs: {
    title: "Backend Engineer Intern",
    company_name: "Acme Corp",
    description_raw: "We need someone who knows Node.js and REST APIs.",
    // Selected and null: a live posting. Present on purpose, because an ABSENT key is
    // its own skip reason (liveness_unknown) and would fail every other test here.
    disappeared_at: null,
  },
};

test("a complete row becomes one unit of work", () => {
  const plan = planTailorBatch([COMPLETE_ROW]);

  // Exactly one job planned, and nothing quietly discarded alongside it.
  assert.equal(plan.tailorable.length, 1);
  assert.equal(plan.skipped.length, 0);
  // The row id travels with the work, because the verdict is written back to it.
  assert.equal(plan.tailorable[0].applicationId, "app-1");
  // Shaped as the tailorer's input so the caller does no reshaping in between — a
  // reshape between planning and execution is a place to drop a field.
  assert.deepEqual(plan.tailorable[0].input, {
    jobTitle: "Backend Engineer Intern",
    company: "Acme Corp",
    jobDescription: "We need someone who knows Node.js and REST APIs.",
  });
});

test("a row whose job did not join is skipped, not tailored against nothing", () => {
  // A left join that matched nothing arrives as null. There is no posting at all here,
  // so this is not a degraded case to muddle through.
  const plan = planTailorBatch([{ id: "app-2", jobs: null }]);

  assert.equal(plan.tailorable.length, 0);
  // Reported with its id, so whoever investigates has a row to look at.
  assert.deepEqual(plan.skipped, [{ applicationId: "app-2", reason: "no_job_joined" }]);
});

test("a whitespace-only description is skipped, not treated as present", () => {
  // THE TRAP THIS TEST EXISTS FOR: `if (job.description_raw)` passes "   " — a non-empty
  // string is truthy. The posting renders as nothing and the model is asked to tailor
  // against blank space. Same family as `Number("")` being 0 (CLAUDE.md §5).
  const plan = planTailorBatch([{ ...COMPLETE_ROW, jobs: { ...COMPLETE_ROW.jobs, description_raw: "   \n  " } }]);

  assert.equal(plan.tailorable.length, 0);
  assert.equal(plan.skipped[0].reason, "missing_description");
});

test("an absent column is skipped the same as an explicit null", () => {
  // postgrest returns an absent column as `undefined`, not `null`. A guard written as
  // `!== null` passes `undefined` — asking "is it missing" has two right answers, and
  // picking one is how the other gets through.
  const { description_raw: _absent, ...withoutDescription } = COMPLETE_ROW.jobs;
  const plan = planTailorBatch([{ id: "app-3", jobs: withoutDescription }]);

  assert.equal(plan.tailorable.length, 0);
  assert.equal(plan.skipped[0].reason, "missing_description");
});

test("the skip reason names which field was missing", () => {
  // One "incomplete_job" reason would send an investigator back to the database to find
  // out which of three columns it was. The reason is the finding, not a category.
  const plan = planTailorBatch([
    { id: "app-4", jobs: { ...COMPLETE_ROW.jobs, title: "" } },
    { id: "app-5", jobs: { ...COMPLETE_ROW.jobs, company_name: null } },
  ]);

  assert.deepEqual(plan.skipped.map((s) => s.reason), ["missing_title", "missing_company"]);
});

test("one malformed row does not abandon the rest of the batch", () => {
  // Accumulate, never return early: nine good rows must survive the tenth bad one.
  const plan = planTailorBatch(["not-an-object", COMPLETE_ROW, { id: "app-6", jobs: null }]);

  // The good row still planned.
  assert.equal(plan.tailorable.length, 1);
  assert.equal(plan.tailorable[0].applicationId, "app-1");
  // And both bad rows accounted for rather than vanished.
  assert.equal(plan.skipped.length, 2);
  // A row with no readable id still reports, with null standing in for the id it lacks.
  assert.deepEqual(plan.skipped[0], { applicationId: null, reason: "malformed_row" });
});

test("a live row (disappeared_at selected and null) is tailorable", () => {
  // Pins the happy path of the liveness check: null means live, not unknown.
  const plan = planTailorBatch([COMPLETE_ROW]);
  assert.deepEqual(plan.skipped, []);
  assert.equal(plan.tailorable.length, 1);
});

test("a disappeared posting is skipped loudly, never silently dropped", () => {
  // scout-ats marked it gone; tailoring it spends a model call on an unsubmittable row.
  const plan = planTailorBatch([{ id: "app-7", jobs: { ...COMPLETE_ROW.jobs, disappeared_at: "2026-10-05T00:00:00Z" } }]);
  assert.equal(plan.tailorable.length, 0);
  // Reported with its id and the named reason, so the batch accounts for it.
  assert.deepEqual(plan.skipped, [{ applicationId: "app-7", reason: "posting_disappeared" }]);
});

test("a row whose select omitted disappeared_at fails closed as liveness_unknown", () => {
  // THE TRAP: postgrest omits unselected columns, and `!= null` reads a missing key as
  // live. A query that forgets the column must not let dead jobs through.
  const { disappeared_at: _omitted, ...withoutLiveness } = COMPLETE_ROW.jobs;
  const plan = planTailorBatch([{ id: "app-8", jobs: withoutLiveness }]);
  assert.equal(plan.tailorable.length, 0);
  assert.deepEqual(plan.skipped, [{ applicationId: "app-8", reason: "liveness_unknown" }]);
});

test("a batch where every row lacked disappeared_at is named as a select defect", () => {
  // Two rows, neither with the key: the shape a forgotten select column produces.
  const { disappeared_at: _omitted, ...withoutLiveness } = COMPLETE_ROW.jobs;
  // Raw rows, classified the way tailor/index.ts does: from row.jobs, not from the plan.
  const rows = [{ id: "a", jobs: withoutLiveness }, { id: "b", jobs: withoutLiveness }];
  // The boolean is the run-level verdict tailor/index.ts branches on.
  assert.equal(allLivenessUnknown(rows.map((r) => classifyJobLiveness(r.jobs))), true);
  // The exact wording pinned, because a health-page search depends on it never drifting.
  assert.equal(LIVENESS_UNKNOWN_DETAIL(rows.length), "all 2 rows lacked disappeared_at; is the select missing the column?");
});

test("an empty or mixed batch is not a select defect", () => {
  // Empty queue: idle, not broken. Guards the `every`-on-empty-is-true trap.
  assert.equal(allLivenessUnknown([]), false);
  // One live row beside one unknown: the column arrived, so the run is ordinary.
  const { disappeared_at: _omitted, ...withoutLiveness } = COMPLETE_ROW.jobs;
  // Mixed classifications built from real row shapes, not hand-written literals.
  const mixed = [COMPLETE_ROW, { id: "b", jobs: withoutLiveness }].map((r) => classifyJobLiveness(r.jobs));
  // A single 'live' among the unknowns proves the select carried the column.
  assert.equal(allLivenessUnknown(mixed), false);
});

test("live-row guarantee: a scored row whose job has disappeared_at null is tailorable", () => {
  // Mirrors the live target row ba1e5d1d (GitLab, status scored, disappeared_at null): the
  // liveness change must not starve the one real row waiting for the Tailor.
  const row = { id: "ba1e5d1d", jobs: { title: "Backend Engineer", company_name: "GitLab", description_raw: "Ruby, Go and PostgreSQL at scale.", disappeared_at: null } };
  // Run through the real planner, so the shared classifyJobLiveness is on the path.
  const plan = planTailorBatch([row]);
  // Planned, not skipped: null means "selected and live", never "unknown".
  assert.deepEqual(plan.skipped, []);
  // Exactly this row, so a planner that dropped and re-added rows could not pass.
  assert.deepEqual(plan.tailorable.map((t) => t.applicationId), ["ba1e5d1d"]);
});
