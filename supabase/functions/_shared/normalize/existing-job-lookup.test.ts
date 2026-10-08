// Tests for the normalizer's duplicate lookup against public.jobs, driven through the real
// planner. WHY: the lookup used to drop supabase-js's `error`, so a FAILED query read as "no
// existing job" and the row was advanced to `deduped` — a fail-open (CLAUDE.md §6). The
// fakes return `{ data, error }` exactly as supabase-js does; it never throws on a query error.
// Run with: node --test "supabase/functions/_shared/normalize/*.test.ts"
import { test } from "node:test";
// Strict, so null and undefined are not conflated.
import assert from "node:assert/strict";
// The lookup under test.
import { createExistingJobLookup, type ExistingJobClient } from "./existing-job-lookup.ts";
// The planner the normalizer hands the lookup to; the verdict is what decides the RPC.
import { planNormalizeBatch, type DiscoveredApplicationItem } from "./normalize-batch.ts";

// A fake jobs query that records its filters and answers with the given supabase-js result.
function fakeJobsClient(result: { data: Array<{ id: string }> | null; error: { message: string; code?: string } | null }) {
  // (method, column, value) per filter, so a test can check the predicate is unchanged.
  const filters: Array<[string, string, string]> = [];
  // The select list and table, for the same reason.
  const calls: { table?: string; columns?: string; limit?: number } = {};
  const db: ExistingJobClient = {
    from(table) {
      // Recorded: the lookup must read jobs, nothing else.
      calls.table = table;
      return {
        select(columns) {
          // Recorded: only the id is needed.
          calls.columns = columns;
          // One builder every filter returns, so the chain can be any length.
          const builder = {
            eq(column: string, value: string) {
              // An equality predicate (user_id, fingerprint).
              filters.push(["eq", column, value]);
              return builder;
            },
            neq(column: string, value: string) {
              // The self-exclusion predicate.
              filters.push(["neq", column, value]);
              return builder;
            },
            limit(n: number) {
              // Recorded, then the canned answer as a thenable.
              calls.limit = n;
              return Promise.resolve(result);
            },
          };
          return builder;
        },
      };
    },
  };
  return { db, filters, calls };
}

// One discovered item; its identity is irrelevant here because the lookup's answer is canned.
const ITEM: DiscoveredApplicationItem = {
  // Application under normalization.
  applicationId: "app-1",
  // Tenant scope passed to the lookup.
  userId: "user-1",
  // Excluded from its own collision query.
  jobId: "job-1",
  // Any company/title/location: they only feed the fingerprint.
  companyName: "Acme",
  title: "Engineer",
  locationRaw: "Bangalore, India",
  // Matches nothing, so a patch would be planned on a deduped verdict.
  currentFingerprint: "raw-fp",
};

test("normalizer lookup: a failed jobs query never advances the row to deduped", async () => {
  // The real supabase-js shape for a failed query: no rows, an error object, no throw.
  const { db } = fakeJobsClient({ data: null, error: { message: "connection reset by peer", code: "08006" } });
  // Through the real planner, exactly as normalizer/index.ts wires it.
  const decisions = await planNormalizeBatch([ITEM], createExistingJobLookup(db));
  // THE BUG: a failed lookup read as "no existing job" and planned `deduped`.
  assert.ok(!decisions.some((d) => d.kind === "deduped"), `planned ${JSON.stringify(decisions)}`);
  // Nor may it guess the other way: a failure is not evidence of a duplicate either.
  assert.ok(!decisions.some((d) => d.kind === "dropped_duplicate"));
  // It is reported as a failed lookup, carrying the database's message for error_detail.
  assert.deepEqual(decisions, [
    { kind: "lookup_failed", applicationId: "app-1", jobId: "job-1", message: "connection reset by peer" },
  ]);
});

test("normalizer lookup: data null with NO error is malformed, not 'no rows'", async () => {
  // A null body without an error is not an answer (CLAUDE.md §6: validate the shape).
  const { db } = fakeJobsClient({ data: null, error: null });
  const decisions = await planNormalizeBatch([ITEM], createExistingJobLookup(db));
  // Fails closed, the same as an explicit error.
  assert.equal(decisions[0]?.kind, "lookup_failed");
});

test("normalizer lookup: an empty array is a real 'no existing job' and plans deduped", async () => {
  // The happy path, or the guard would be a wall.
  const { db, filters, calls } = fakeJobsClient({ data: [], error: null });
  const decisions = await planNormalizeBatch([ITEM], createExistingJobLookup(db));
  // Unique: deduped.
  assert.equal(decisions[0]?.kind, "deduped");
  // The predicate is unchanged by the fix: same table, column, filters and limit.
  assert.equal(calls.table, "jobs");
  assert.equal(calls.columns, "id");
  assert.equal(calls.limit, 1);
  // Tenant scope, then the self-exclusion; the fingerprint value is computed, so only its column is checked.
  assert.deepEqual(filters.map(([m, c]) => [m, c]), [["eq", "user_id"], ["eq", "fingerprint"], ["neq", "id"]]);
});

test("normalizer lookup: a matching row is a duplicate and plans dropped_duplicate", async () => {
  // Another job already holds this fingerprint for this user.
  const { db } = fakeJobsClient({ data: [{ id: "job-0" }], error: null });
  const decisions = await planNormalizeBatch([ITEM], createExistingJobLookup(db));
  // Dropped, pointing at the job it duplicates.
  assert.equal(decisions[0]?.kind, "dropped_duplicate");
  // The link survives into the event detail.
  assert.equal(decisions[0]?.kind === "dropped_duplicate" ? decisions[0].duplicateOfJobId : null, "job-0");
});
