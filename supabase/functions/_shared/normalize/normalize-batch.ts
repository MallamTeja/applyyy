// Core normalization & deduplication batch processor for PROJECT_PLAN.md §9.
// Pure and testable logic that computes canonical fingerprints for discovered jobs,
// detects duplicate postings against existing database records or current batch items,
// and plans status transitions to 'deduped' or 'dropped_duplicate' — or no transition at all
// ('lookup_failed') when the duplicate check could not answer.

// Import the canonical fingerprint computation primitive.
import { jobFingerprint } from "./fingerprint.ts";

// Input contract representing a discovered application and its associated job details.
export interface DiscoveredApplicationItem {
  // Application UUID from `public.applications`.
  readonly applicationId: string;
  // User UUID owning this application.
  readonly userId: string;
  // Job UUID from `public.jobs`.
  readonly jobId: string;
  // Raw company name as posted on the job board.
  readonly companyName: string;
  // Raw job title as posted on the job board.
  readonly title: string;
  // Raw location string if present.
  readonly locationRaw?: string | null | undefined;
  // Parsed location array if present.
  readonly locations?: readonly string[] | null | undefined;
  // Current stored fingerprint in `public.jobs` (may be unnormalized or placeholder).
  readonly currentFingerprint: string;
}

// Discriminated union of normalization outcomes for each processed application.
export type NormalizationDecision =
  // The posting is unique and marked as deduped.
  | {
      // Discriminant indicating a new, non-duplicate posting.
      readonly kind: "deduped";
      // Target application UUID to update.
      readonly applicationId: string;
      // Target job UUID to update.
      readonly jobId: string;
      // Computed SHA-256 canonical fingerprint.
      readonly canonicalFingerprint: string;
      // True if stored job fingerprint differs from canonical fingerprint.
      readonly needsFingerprintPatch: boolean;
    }
  // The posting is a duplicate of an existing job for this user.
  | {
      // Discriminant indicating a duplicate posting to drop.
      readonly kind: "dropped_duplicate";
      // Target application UUID to update.
      readonly applicationId: string;
      // Target job UUID to update.
      readonly jobId: string;
      // Computed SHA-256 canonical fingerprint.
      readonly canonicalFingerprint: string;
      // UUID of the existing job that this posting duplicates.
      readonly duplicateOfJobId: string;
    }
  // The duplicate check itself failed: no verdict, so the row must not move. The handler
  // counts it as an error and leaves the application at `discovered` for the next run.
  | {
      // Discriminant indicating the lookup could not answer.
      readonly kind: "lookup_failed";
      // Application left where it is.
      readonly applicationId: string;
      // Its job, for the log line.
      readonly jobId: string;
      // The database's message, for the run's error_detail.
      readonly message: string;
    };

// What a duplicate lookup can say. Closed, so "the query failed" can never be written the
// same way as "no existing job" — the fail-open the old `string | null` allowed.
export type ExistingJobResult =
  // A successful query that matched nothing.
  | { readonly kind: "none" }
  // A successful query that matched an existing job.
  | { readonly kind: "found"; readonly jobId: string }
  // The query failed or answered in a shape that is not an answer.
  | { readonly kind: "failed"; readonly message: string };

// Abstract database lookup interface for duplicate detection dependency injection.
export type ExistingJobLookup = (
  // User UUID scope.
  userId: string,
  // Computed canonical fingerprint to query.
  fingerprint: string,
  // Exclude current job ID from collision query.
  excludeJobId: string,
) => Promise<ExistingJobResult>;

// Process a batch of discovered application items into normalization decisions.
export async function planNormalizeBatch(
  // Discovered application items to normalize.
  items: readonly DiscoveredApplicationItem[],
  // Asynchronous lookup function for DB collision checks.
  lookupExistingJob: ExistingJobLookup,
): Promise<readonly NormalizationDecision[]> {
  // Array holding the resulting normalization decision for each item in input order.
  const decisions: NormalizationDecision[] = [];
  // In-memory set/map tracking canonical fingerprints seen within this batch per user.
  const seenInBatch = new Map<string, string>();

  // Process each discovered item sequentially to preserve order and intra-batch dedupe.
  for (const item of items) {
    // Prefer location_raw, fallback to first entry in locations array if available.
    const locationStr = item.locationRaw ?? (item.locations?.[0] ?? undefined);
    // Compute the pure canonical SHA-256 fingerprint for this job identity.
    const canonicalFp = await jobFingerprint({
      // Pass normalized company field.
      company: item.companyName,
      // Pass normalized title field.
      title: item.title,
      // Pass resolved location string or undefined.
      location: locationStr ?? undefined,
    });
    // Create compound cache key combining user ID and canonical fingerprint for tenant isolation.
    const batchKey = `${item.userId}:${canonicalFp}`;

    // Check if another job with identical fingerprint was already processed earlier in this batch.
    const intraBatchDuplicateJobId = seenInBatch.get(batchKey);
    // If an intra-batch duplicate exists, mark this item as dropped duplicate immediately.
    if (intraBatchDuplicateJobId !== undefined) {
      // Record dropped duplicate decision referencing earlier job ID.
      decisions.push({
        // Set discriminant.
        kind: "dropped_duplicate",
        // Pass application ID.
        applicationId: item.applicationId,
        // Pass job ID.
        jobId: item.jobId,
        // Pass computed canonical fingerprint.
        canonicalFingerprint: canonicalFp,
        // Link to first job ID seen in batch.
        duplicateOfJobId: intraBatchDuplicateJobId,
      });
      // Skip DB query since intra-batch collision is already established.
      continue;
    }

    // Query external database for existing job sharing the canonical fingerprint.
    const existing = await lookupExistingJob(item.userId, canonicalFp, item.jobId);
    // The check could not answer: plan no move at all. Not registered in seenInBatch either,
    // so a later sibling with the same fingerprint is judged on its own lookup, not on a guess.
    if (existing.kind === "failed") {
      // Record the failure so the handler counts it and leaves the row at discovered.
      decisions.push({
        // Set discriminant.
        kind: "lookup_failed",
        // Pass application ID.
        applicationId: item.applicationId,
        // Pass job ID.
        jobId: item.jobId,
        // Carry the reason through to error_detail.
        message: existing.message,
      });
      // Continue to next item in batch.
      continue;
    }
    // If database collision is found, mark application as dropped duplicate.
    if (existing.kind === "found") {
      // Record dropped duplicate decision referencing existing database job ID.
      decisions.push({
        // Set discriminant.
        kind: "dropped_duplicate",
        // Pass application ID.
        applicationId: item.applicationId,
        // Pass job ID.
        jobId: item.jobId,
        // Pass computed canonical fingerprint.
        canonicalFingerprint: canonicalFp,
        // Link to existing DB job ID.
        duplicateOfJobId: existing.jobId,
      });
      // Continue to next item in batch.
      continue;
    }

    // No duplicate found: register fingerprint in batch map for subsequent batch items.
    seenInBatch.set(batchKey, item.jobId);
    // Check whether current stored fingerprint in DB needs updating to canonical form.
    const needsPatch = item.currentFingerprint !== canonicalFp;

    // Record successful deduplication decision.
    decisions.push({
      // Set discriminant.
      kind: "deduped",
      // Pass application ID.
      applicationId: item.applicationId,
      // Pass job ID.
      jobId: item.jobId,
      // Pass computed canonical fingerprint.
      canonicalFingerprint: canonicalFp,
      // Pass whether DB update is required.
      needsFingerprintPatch: needsPatch,
    });
  }

  // Return all planned normalization decisions.
  return decisions;
}
