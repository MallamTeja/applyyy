// ============================================================================
// COVER LETTER BATCH PLANNING MODULE
// ============================================================================
//
// Pure batch planner that filters database application rows and determines
// which applications are eligible for cover letter generation and which must be
// skipped due to missing prerequisite data.
//
// Key Guardrails:
//   - Requires a valid application ID.
//   - Requires a non-null `tailored_profile` (ResolvedResume) snapshot.
//   - Requires job metadata containing position title and hiring company name.
//   - Leaves skipped rows at their current status without wasting Gemini quota.
// ============================================================================

// Import shared contract interface for ResolvedResume
import type { ResolvedResume } from "../_shared/contracts/shared-types.ts";

/**
 * Raw application row shape fetched from Supabase database query.
 */
export interface RawApplicationRow {
  /** Primary key UUID of the application record. */
  readonly id: string;

  /** Current workflow status string of the application. */
  readonly status: string;

  /** Frozen JSON profile snapshot (ResolvedResume) or null. */
  readonly tailored_profile: unknown;

  /** Raw tailor references JSON or null. */
  readonly tailor_refs: unknown;

  /** Master profile version number associated with the application. */
  readonly master_version: number | null;

  /** Embedded job relation metadata or array/null. */
  readonly jobs:
    | {
        /** Position title string. */
        readonly title: string | null;

        /** Hiring company name string. */
        readonly company_name: string | null;

        /** Raw job description content. */
        readonly description_raw: string | null;
      }
    | Array<{
        /** Position title string. */
        readonly title: string | null;

        /** Hiring company name string. */
        readonly company_name: string | null;

        /** Raw job description content. */
        readonly description_raw: string | null;
      }>
    | null;
}

/**
 * Validated application input ready for cover letter generation.
 */
export interface EligibleCoverLetterJob {
  /** Primary key UUID of the application. */
  readonly applicationId: string;

  /** Validated ResolvedResume object. */
  readonly resume: ResolvedResume;

  /** Raw tailor references JSON if present. */
  readonly tailorRefs: unknown;

  /** Job metadata containing position title, company name, and description. */
  readonly job: {
    /** Target job position title. */
    readonly title: string;

    /** Target hiring company name. */
    readonly companyName: string;

    /** Raw untrusted job description prose or null. */
    readonly descriptionRaw: string | null;
  };
}

/**
 * Details of an application skipped during batch planning.
 */
export interface SkippedCoverLetterJob {
  /** Primary key UUID of the application. */
  readonly applicationId: string;

  /** Reason code explaining why the row was skipped. */
  readonly reason: string;
}

/**
 * Result structure returned by cover letter batch planning.
 */
export interface CoverLetterBatchPlan {
  /** Array of applications ready for cover letter generation. */
  readonly eligible: readonly EligibleCoverLetterJob[];

  /** Array of applications skipped during batch planning with reason codes. */
  readonly skipped: readonly SkippedCoverLetterJob[];
}

/**
 * Unpack job relation payload which may arrive as object, single-item array, or null.
 *
 * Handles Supabase PostgREST join payloads where single relations are returned either
 * as single objects or as 1-element arrays depending on query cardinality hints.
 *
 * @param jobs Job relation payload from Supabase.
 * @returns Single job object or null.
 */
function unpackJob(
  jobs: RawApplicationRow["jobs"],
): { title: string | null; company_name: string | null; description_raw: string | null } | null {
  // Return null immediately if job relation payload is null or undefined
  if (!jobs) {
    // Missing job relation
    return null;
  }

  // Check if job payload is an array structure
  if (Array.isArray(jobs)) {
    // Extract and return first element if array is non-empty, otherwise fallback to null
    const firstElement = jobs[0];

    // Return first element or null if array was empty
    return firstElement ?? null;
  }

  // Payload is already a single job object, return directly
  return jobs;
}

/**
 * Evaluate raw application rows and construct a batch plan of eligible vs skipped jobs.
 *
 * Filtering Logic:
 *   1. Ignores records with invalid or empty primary key IDs.
 *   2. Rejects rows missing `tailored_profile` with reason "missing_tailored_profile".
 *   3. Rejects rows missing embedded `jobs` data with reason "missing_job_metadata".
 *   4. Rejects rows with empty title or company with reason "missing_job_title_or_company".
 *   5. Casts valid `tailored_profile` to `ResolvedResume` and packages into eligible job object.
 *
 * @param rows Raw application database rows.
 * @returns CoverLetterBatchPlan containing eligible jobs and skipped jobs arrays.
 */
export function planCoverLetterBatch(rows: readonly RawApplicationRow[]): CoverLetterBatchPlan {
  // Initialize empty array to collect eligible applications
  const eligible: EligibleCoverLetterJob[] = [];

  // Initialize empty array to collect skipped applications
  const skipped: SkippedCoverLetterJob[] = [];

  // Iterate over each raw application database row sequentially
  for (const row of rows) {
    // Validate that application ID exists and is non-empty
    if (!row.id) {
      // Skip invalid row without primary key ID
      continue;
    }

    // Check for presence of tailored_profile JSON snapshot column
    if (!row.tailored_profile) {
      // Record skipped application due to missing tailored_profile snapshot
      skipped.push({
        // Application primary key ID
        applicationId: row.id,
        // Reason code missing tailored profile
        reason: "missing_tailored_profile",
      });

      // Skip to next row in batch loop
      continue;
    }

    // Unpack embedded job relation object from raw database row
    const jobData = unpackJob(row.jobs);

    // Check if job metadata object is present
    if (!jobData) {
      // Record skipped application due to missing job relation payload
      skipped.push({
        // Application primary key ID
        applicationId: row.id,
        // Reason code missing job metadata
        reason: "missing_job_metadata",
      });

      // Skip to next row in batch loop
      continue;
    }

    // Extract position title string and trim leading/trailing whitespace
    const title = jobData.title?.trim();

    // Extract hiring company name string and trim leading/trailing whitespace
    const companyName = jobData.company_name?.trim();

    // Check if position title or company name is missing or empty
    if (!title || !companyName) {
      // Record skipped application due to incomplete job title or company name
      skipped.push({
        // Application primary key ID
        applicationId: row.id,
        // Reason code missing job title or company
        reason: "missing_job_title_or_company",
      });

      // Skip to next row in batch loop
      continue;
    }

    // Cast validated tailored_profile to typed ResolvedResume interface
    const resume = row.tailored_profile as ResolvedResume;

    // Construct eligible job object and add to eligible list
    eligible.push({
      // Application ID
      applicationId: row.id,
      // Resolved resume object
      resume,
      // Raw tailor refs JSON
      tailorRefs: row.tailor_refs,
      // Packaged job metadata object
      job: {
        // Position title string
        title,
        // Hiring company name string
        companyName,
        // Raw description prose or null fallback
        descriptionRaw: jobData.description_raw ?? null,
      },
    });
  }

  // Return final CoverLetterBatchPlan object containing eligible and skipped lists
  return {
    // Array of eligible jobs
    eligible,
    // Array of skipped jobs
    skipped,
  };
}
