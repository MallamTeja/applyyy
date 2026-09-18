// Unit tests for the pure normalize-batch deduplication planner.
// Validates unique job pass-through, intra-batch deduplication, and DB collision detection.

// Standard test assertions from Node.
import assert from "node:assert";
// Test runner suite and test functions from Node.
import { test } from "node:test";
// Import the planner and types under test.
import { planNormalizeBatch, type DiscoveredApplicationItem } from "./normalize-batch.ts";

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
