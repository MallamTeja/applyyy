// Unit tests for the pure normalize-batch deduplication planner.
// Validates unique job pass-through, intra-batch deduplication, and DB collision detection.

// Standard test assertions from Node.
import assert from "node:assert";
// Test runner suite and test functions from Node.
import { test } from "node:test";
// Import the planner and types under test.
import { planNormalizeBatch, type DiscoveredApplicationItem, type NormalizationDecision } from "./normalize-batch.ts";
// The real canonical digest, so a fake "existing job" holds exactly what the planner computes.
import { jobFingerprint } from "./fingerprint.ts";

// Sample test item constructor helper.
function makeItem(
  // Unique app ID.
  applicationId: string,
  // Unique job ID.
  jobId: string,
  // Company name.
  companyName: string,
  // Job title.
  title: string,
  // Fingerprint string.
  currentFingerprint = "raw-fp",
): DiscoveredApplicationItem {
  // Construct item object.
  return {
    // Assign applicationId.
    applicationId,
    // Assign default user ID.
    userId: "user-123",
    // Assign jobId.
    jobId,
    // Assign companyName.
    companyName,
    // Assign title.
    title,
    // Assign location.
    locationRaw: "Bangalore, India",
    // Assign fingerprint.
    currentFingerprint,
  };
}

// Test case 1: Single unique job plans 'deduped'.
test("planNormalizeBatch — marks unique job as deduped", async () => {
  // Define input item.
  const item = makeItem("app-1", "job-1", "Google", "Software Engineer");
  // Mock DB lookup returning no existing job.
  const lookup = async () => null;

  // Execute planner.
  const decisions = await planNormalizeBatch([item], lookup);

  // Assert single decision returned.
  assert.equal(decisions.length, 1);
  // Assert decision discriminant.
  assert.equal(decisions[0]?.kind, "deduped");
  // Assert application ID matches.
  assert.equal(decisions[0]?.applicationId, "app-1");
  // Assert needsFingerprintPatch is true because raw-fp differs from canonical digest.
  assert.equal(decisions[0]?.kind === "deduped" && decisions[0].needsFingerprintPatch, true);
});

// Test case 2: Intra-batch duplicate items.
test("planNormalizeBatch — drops intra-batch duplicate posting", async () => {
  // Define first item.
  const item1 = makeItem("app-1", "job-1", "Acme Inc", "Backend Developer");
  // Define second item with identical identity (company legal suffix stripped, title folded).
  const item2 = makeItem("app-2", "job-2", "Acme", "Backend Developer");
  // Mock DB lookup returning no existing job.
  const lookup = async () => null;

  // Execute planner with both items.
  const decisions = await planNormalizeBatch([item1, item2], lookup);

  // Assert two decisions returned.
  assert.equal(decisions.length, 2);
  // Assert first item is deduped.
  assert.equal(decisions[0]?.kind, "deduped");
  // Assert second item is dropped duplicate.
  assert.equal(decisions[1]?.kind, "dropped_duplicate");
  // Assert second item links back to job-1.
  assert.equal(decisions[1]?.kind === "dropped_duplicate" && decisions[1].duplicateOfJobId, "job-1");
});

// Test case 3: DB collision detection.
test("planNormalizeBatch — drops posting colliding with existing database job", async () => {
  // Define input item.
  const item = makeItem("app-1", "job-1", "Stripe", "Product Engineer");
  // Mock DB lookup returning existing job ID.
  const lookup = async (_userId: string, _fp: string, excludeJobId: string) => {
    // Verify excludeJobId is passed correctly.
    assert.equal(excludeJobId, "job-1");
    // Return existing DB job ID.
    return "existing-job-99";
  };

  // Execute planner.
  const decisions = await planNormalizeBatch([item], lookup);

  // Assert single decision returned.
  assert.equal(decisions.length, 1);
  // Assert dropped_duplicate discriminant.
  assert.equal(decisions[0]?.kind, "dropped_duplicate");
  // Assert duplicateOfJobId matches DB job ID.
  assert.equal(decisions[0]?.kind === "dropped_duplicate" && decisions[0].duplicateOfJobId, "existing-job-99");
});

// --- single-row targeting (?application_id=) parity ---------------------------------
//
// WHY THESE LIVE HERE AND NOT AT THE HANDLER: normalizer/index.ts imports jsr: modules and
// has no seam, so the only testable unit is this planner. The handler's targeted mode just
// calls it with a one-item list, so "is a one-item verdict the batch verdict?" is the
// whole question. The `?application_id=bad` -> 400 path is NOT covered here; it needs a
// live smoke test against the deployed function.

// One row of an in-memory `jobs` table: what the real lookup query reads.
interface FakeJob {
  // Primary key, compared by the `.neq("id", excludeJobId)` in the real query.
  id: string;
  // Tenant scope, matched by `.eq("user_id", …)`.
  userId: string;
  // The stored fingerprint, matched by `.eq("fingerprint", …)`.
  fingerprint: string;
}

// A lookup with the same predicate as normalizer/index.ts's lookupExistingJob, over a
// mutable array, so a test can apply the fingerprint patch a real run would write.
function fakeLookup(jobs: FakeJob[]) {
  // Same three predicates and `limit(1)` as the live query, so verdicts match it.
  return async (userId: string, fingerprint: string, excludeJobId: string): Promise<string | null> =>
    // First match or null, mirroring `existingJobs[0]?.id ?? null`.
    jobs.find((j) => j.userId === userId && j.fingerprint === fingerprint && j.id !== excludeJobId)?.id ?? null;
}

// The handler's targeted run, reduced to what matters for the next run: plan one item,
// then write back the canonical fingerprint exactly as the deduped branch's patch does.
async function runSingle(item: DiscoveredApplicationItem, jobs: FakeJob[]) {
  // A one-item batch is precisely what `.match({ id })` + `.limit()` hands the planner.
  const [decision] = await planNormalizeBatch([item], fakeLookup(jobs));
  // Only a deduped verdict with a stale fingerprint patches `jobs`; mirror that.
  if (decision?.kind === "deduped" && decision.needsFingerprintPatch) {
    // Find the row the real `.update().eq("id", jobId)` would touch.
    const row = jobs.find((j) => j.id === decision.jobId);
    // Apply the patch so the following single-row run sees it, as the DB would.
    if (row) row.fingerprint = decision.canonicalFingerprint;
  }
  // Returned so the test can compare against the batch verdict.
  return decision;
}

// Three distinct identities: no intra-batch pair exists, so the only dedupe source is
// the DB lookup, which ignores batch membership. One at a time must equal all at once.
test("planNormalizeBatch — single-row verdicts equal batch verdicts when no intra-batch pair exists", async () => {
  // Three postings that share no canonical identity.
  const items = [
    // A unique role.
    makeItem("app-a", "job-a", "Google", "Software Engineer"),
    // A second, different company and title.
    makeItem("app-b", "job-b", "Stripe", "Product Engineer"),
    // A third, also unrelated.
    makeItem("app-c", "job-c", "Zomato", "Backend Intern"),
  ];
  // Their own rows sit in `jobs` with the raw fingerprint, as they do before normalizing.
  const jobs = (): FakeJob[] => items.map((i) => ({ id: i.jobId, userId: i.userId, fingerprint: i.currentFingerprint }));
  // The batch run, over a fresh table.
  const batch = await planNormalizeBatch(items, fakeLookup(jobs()));
  // Each item alone, each over its own fresh table so no run sees another's patch.
  for (const [index, item] of items.entries()) {
    // One-item batch: the targeted mode.
    const single = await planNormalizeBatch([item], fakeLookup(jobs()));
    // Whole-decision equality: kind, fingerprint and patch flag all agree.
    assert.deepEqual(single[0], batch[index]);
  }
});

// The DB-collision path is batch-independent by construction: the lookup compares against
// ALL of the user's jobs at any status, so a lone target still finds its duplicate.
test("planNormalizeBatch — a lone target colliding with an existing job is dropped exactly as in a batch", async () => {
  // The posting under test.
  const target = makeItem("app-d", "job-d", "Stripe", "Product Engineer");
  // A neighbour so the batch is genuinely a batch.
  const other = makeItem("app-e", "job-e", "Google", "Data Engineer");
  // An already-normalized job holding the target's canonical fingerprint.
  const canonical = await jobFingerprint({ company: "Stripe", title: "Product Engineer", location: "Bangalore, India" });
  // The table: the existing job plus both items' raw rows.
  const jobs = (): FakeJob[] => [
    // The earlier posting the target duplicates.
    { id: "job-existing", userId: "user-123", fingerprint: canonical },
    // The target's own row, not yet normalized.
    { id: "job-d", userId: "user-123", fingerprint: "raw-fp" },
    // The neighbour's own row.
    { id: "job-e", userId: "user-123", fingerprint: "raw-fp" },
  ];
  // Targeted: the target alone.
  const [single] = await planNormalizeBatch([target], fakeLookup(jobs()));
  // Batch: neighbour first, target second.
  const batch = await planNormalizeBatch([other, target], fakeLookup(jobs()));
  // The lone verdict names the existing job.
  assert.equal(single?.kind === "dropped_duplicate" && single.duplicateOfJobId, "job-existing");
  // And is identical to the batch verdict for the same row.
  assert.deepEqual(single, batch[1]);
});

// THE ONE DOCUMENTED DIVERGENCE. Two same-identity siblings: a batch keeps the FIRST and
// drops the second via `seenInBatch`; single-row runs keep whichever runs first and drop
// the other via the DB lookup (after the survivor's fingerprint patch lands). Which job
// survives can differ; that exactly one survives cannot.
test("planNormalizeBatch — same-identity siblings: batch and single-row each keep exactly one survivor", async () => {
  // First sibling: legal suffix that the canonical key strips.
  const first = makeItem("app-1", "job-1", "Acme Inc", "Backend Developer");
  // Second sibling: same canonical identity.
  const second = makeItem("app-2", "job-2", "Acme", "Backend Developer");
  // Both own rows, pre-normalization, so neither yet holds the canonical fingerprint.
  const jobs = (): FakeJob[] => [
    // First sibling's row.
    { id: "job-1", userId: "user-123", fingerprint: "raw-fp" },
    // Second sibling's row.
    { id: "job-2", userId: "user-123", fingerprint: "raw-fp" },
  ];
  // Counts deduped verdicts, which is the survivor count.
  const survivors = (ds: readonly (NormalizationDecision | undefined)[]) => ds.filter((d) => d?.kind === "deduped").length;

  // Batch: first survives, second is its intra-batch duplicate.
  const batch = await planNormalizeBatch([first, second], fakeLookup(jobs()));
  // The batch keeps the first.
  assert.equal(batch[0]?.kind, "deduped");
  // And drops the second against job-1.
  assert.equal(batch[1]?.kind === "dropped_duplicate" && batch[1].duplicateOfJobId, "job-1");
  // One survivor.
  assert.equal(survivors(batch), 1);

  // Single-row, second targeted first: one shared table, so the patch carries forward.
  const tableReverse = jobs();
  // The second runs alone and nothing holds its canonical fingerprint yet: it survives.
  const secondAlone = await runSingle(second, tableReverse);
  // Divergence from the batch: here the SECOND sibling is the survivor.
  assert.equal(secondAlone?.kind, "deduped");
  // The first then finds job-2's patched fingerprint and is dropped against it.
  const firstAfter = await runSingle(first, tableReverse);
  // Dropped against the sibling that ran first.
  assert.equal(firstAfter?.kind === "dropped_duplicate" && firstAfter.duplicateOfJobId, "job-2");
  // Still exactly one survivor.
  assert.equal(survivors([secondAlone, firstAfter]), 1);

  // Single-row in batch order reproduces the batch verdicts exactly.
  const tableForward = jobs();
  // First alone survives.
  const firstAlone = await runSingle(first, tableForward);
  // Second alone is dropped against job-1, same as the batch.
  const secondAfter = await runSingle(second, tableForward);
  // Identical to the batch on both rows.
  assert.deepEqual([firstAlone?.kind, secondAfter?.kind], [batch[0]?.kind, batch[1]?.kind]);
  // And again exactly one survivor.
  assert.equal(survivors([firstAlone, secondAfter]), 1);
});
