// Freshness Queue Selector Module for Matcher Edge Function
//
// Identity & Bounded Domain:
// Provides priority queue ordering for candidate applications entering the Matcher stage.
// Ensures that applications associated with freshly posted job listings (<24 hours old) are
// prioritized and matched first before processing older or stale job listings.
//
// Architectural Invariants & Rules:
// 1. Freshness Threshold: A job listing is defined as "fresh" if its posted timestamp is strictly
//    less than 24 hours (86,400,000 milliseconds) prior to the reference processing time.
// 2. Queue Partitioning: Fresh applications (<24h old) MUST strictly precede non-fresh (>=24h old)
//    and dateless applications in the output array.
// 3. Secondary Tie-Breaking: Within each freshness bucket (fresh vs non-fresh), applications are
//    sorted by timestamp descending (newest job postings first) to preserve recency priority.
// 4. Immutability & Pure Functions: The sorting function returns a new array copy and does NOT
//    mutate the input array parameter in-place.
// 5. Robust Fallback: Handles varied application object shapes (nested `jobs.posted_at`, `job.posted_at`,
//    `job_snapshot.posted_at`, or top-level `posted_at`/`created_at`) and handles unparseable date values safely.

// Constant defining the number of milliseconds in 24 hours.
// 24 hours * 60 minutes/hour * 60 seconds/minute * 1000 milliseconds/second = 86,400,000 ms.
export const FRESHNESS_WINDOW_MS = 24 * 60 * 60 * 1000;

// Interface describing the optional configuration and reference time options.
// Allows callers and test suites to supply a deterministic reference timestamp.
export interface FreshnessOptions {
  // Optional reference time to compute freshness against.
  // Defaults to current epoch timestamp (Date.now()) when omitted.
  referenceTime?: Date | number | string;
}

// Helper function to extract and parse a numeric epoch timestamp in milliseconds from an application object.
// Inspects common timestamp field patterns across application and job relation schemas.
export function extractJobTimestamp(app: Record<string, unknown> | null | undefined): number | null {
  // Return null early if application object is null or not a valid dictionary object.
  if (!app || typeof app !== "object") {
    // Return null when application parameter is invalid or missing.
    return null;
  }

  // Define candidate property paths where job creation or posting timestamps may reside.
  // Checks nested relations (`jobs`, `job`, `job_snapshot`) as well as top-level fields.
  const rawCandidate =
    // Check nested `jobs` relation `posted_at` string or Date field.
    (app.jobs as Record<string, unknown> | undefined)?.posted_at ??
    // Check nested `job` relation `posted_at` string or Date field.
    (app.job as Record<string, unknown> | undefined)?.posted_at ??
    // Check nested `job_snapshot` relation `posted_at` string or Date field.
    (app.job_snapshot as Record<string, unknown> | undefined)?.posted_at ??
    // Check top-level `posted_at` string or Date field on application.
    app.posted_at ??
    // Check nested `jobs` relation `created_at` string or Date field fallback.
    (app.jobs as Record<string, unknown> | undefined)?.created_at ??
    // Check nested `job` relation `created_at` string or Date field fallback.
    (app.job as Record<string, unknown> | undefined)?.created_at ??
    // Check top-level `created_at` string or Date field fallback on application.
    app.created_at ??
    // Check nested `jobs` relation `scraped_at` string or Date field fallback.
    (app.jobs as Record<string, unknown> | undefined)?.scraped_at ??
    // Check top-level `scraped_at` string or Date field fallback on application.
    app.scraped_at;

  // Return null if no raw timestamp candidate value was found on the application object.
  if (rawCandidate === null || rawCandidate === undefined) {
    // Return null when timestamp field is unpopulated.
    return null;
  }

  // Handle case where raw timestamp candidate is already a JavaScript Date instance.
  if (rawCandidate instanceof Date) {
    // Extract numeric epoch milliseconds value from Date instance.
    const ms = rawCandidate.getTime();
    // Return numeric timestamp if value is a valid non-NaN epoch timestamp.
    return Number.isNaN(ms) ? null : ms;
  }

  // Handle case where raw timestamp candidate is provided as numeric epoch milliseconds or seconds.
  if (typeof rawCandidate === "number") {
    // Validate that numeric timestamp is finite and positive.
    if (!Number.isFinite(rawCandidate) || rawCandidate <= 0) {
      // Return null for non-finite or invalid non-positive numbers.
      return null;
    }
    // Return epoch timestamp as-is if in millisecond range (> year 2000 in ms), otherwise scale seconds to ms.
    return rawCandidate > 1_000_000_000_000 ? rawCandidate : rawCandidate * 1000;
  }

  // Handle case where raw timestamp candidate is a string representation of a date.
  if (typeof rawCandidate === "string") {
    // Parse ISO-8601 or date string into numeric epoch milliseconds.
    const parsedMs = Date.parse(rawCandidate);
    // Return parsed numeric timestamp if string was valid ISO date, otherwise return null.
    return Number.isNaN(parsedMs) ? null : parsedMs;
  }

  // Return null for any unsupported candidate property type (e.g. boolean, array, object).
  return null;
}

// Determines whether a given job timestamp falls within the 24-hour freshness window.
// Compares job epoch timestamp against current reference time.
export function isJobFresh(
  // Epoch timestamp in milliseconds of job posting.
  timestampMs: number | null,
  // Epoch reference timestamp in milliseconds (defaults to Date.now()).
  nowMs: number = Date.now(),
): boolean {
  // Return false immediately if timestamp is missing or unparseable.
  if (timestampMs === null || !Number.isFinite(timestampMs)) {
    // Unpopulated timestamps are treated as non-fresh by default.
    return false;
  }

  // Calculate age of job listing in milliseconds relative to reference time.
  const ageMs = nowMs - timestampMs;

  // Check if job posting age is positive (in past) and strictly less than 24h window (or up to 5m clock skew).
  // Fresh if age is between -300,000 ms (-5 mins clock drift margin) and FRESHNESS_WINDOW_MS (86,400,000 ms).
  return ageMs >= -300_000 && ageMs < FRESHNESS_WINDOW_MS;
}

// Main exported priority queue sorting function for Matcher application batch processing.
// Orders applications sitting at status `passed_filters` so fresh jobs (<24h old) are matched first.
//
// @param applications Array of application objects fetched from database queue.
// @param options Optional configuration object containing custom reference time for testing.
// @returns A new sorted array of application objects prioritized by job freshness.
// deno-lint-ignore no-explicit-any
export function sortApplicationsByFreshness(
  // Array of application records to be prioritized by job freshness.
  // Typed as any[] to match database query row payloads.
  // deno-lint-ignore no-explicit-any
  applications: any[],
  // Optional reference timestamp or configuration options.
  options?: FreshnessOptions | Date | number | string,
  // deno-lint-ignore no-explicit-any
): any[] {
  // Return empty array early if input applications parameter is null or undefined.
  if (!applications || !Array.isArray(applications)) {
    // Return empty array to prevent downstream iteration crashes.
    return [];
  }

  // Return shallow copy immediately if application array contains 1 or 0 elements.
  if (applications.length <= 1) {
    // No sorting necessary for single-item or empty lists.
    return [...applications];
  }

  // Resolve reference epoch timestamp in milliseconds from options parameter.
  let refMs = Date.now();
  // Check if options parameter was provided as a FreshnessOptions object.
  if (options && typeof options === "object" && !(options instanceof Date)) {
    // Extract referenceTime property if present on options object.
    const ref = (options as FreshnessOptions).referenceTime;
    // Parse reference time string, Date, or number if populated.
    if (ref !== undefined && ref !== null) {
      // Resolve reference timestamp to epoch milliseconds.
      const parsedRef = typeof ref === "number" ? ref : ref instanceof Date ? ref.getTime() : Date.parse(ref);
      // Assign parsed reference timestamp if non-NaN.
      if (!Number.isNaN(parsedRef)) {
        // Overwrite reference epoch timestamp in milliseconds.
        refMs = parsedRef;
      }
    }
  } else if (options !== undefined && options !== null) {
    // Parse options directly if passed as Date, number, or string.
    const parsedRef = typeof options === "number" ? options : options instanceof Date ? options.getTime() : Date.parse(options);
    // Assign parsed reference timestamp if non-NaN.
    if (!Number.isNaN(parsedRef)) {
      // Overwrite reference epoch timestamp in milliseconds.
      refMs = parsedRef;
    }
  }

  // Create array copy paired with extracted metadata for stable and performant sorting.
  const annotated = applications.map((app, originalIndex) => {
    // Extract job timestamp in epoch milliseconds from application row object.
    const timestampMs = extractJobTimestamp(app);
    // Evaluate whether job timestamp meets <24h freshness criterion.
    const fresh = isJobFresh(timestampMs, refMs);
    // Return annotated record containing original item, extracted timestamp, freshness flag, and index.
    return {
      // Reference to original application object in input array.
      app,
      // Extracted numeric timestamp in milliseconds, or null if unparseable.
      timestampMs,
      // Boolean flag indicating if job listing was posted within the past 24 hours.
      fresh,
      // Original index position to guarantee stable sorting on ties.
      originalIndex,
    };
  });

  // Sort annotated application records based on freshness tier and recency timestamp.
  annotated.sort((itemA, itemB) => {
    // RULE 1: Fresh jobs (<24h old) strictly precede non-fresh jobs (>=24h old or missing timestamp).
    if (itemA.fresh && !itemB.fresh) {
      // Item A is fresh, Item B is not fresh -> Item A comes first (-1).
      return -1;
    }
    // Check reverse case where Item B is fresh and Item A is not fresh.
    if (!itemA.fresh && itemB.fresh) {
      // Item B is fresh, Item A is not fresh -> Item B comes first (+1).
      return 1;
    }

    // RULE 2: Within same freshness tier (both fresh or both non-fresh), sort by timestamp descending (newest first).
    // Both items have valid timestamps.
    if (itemA.timestampMs !== null && itemB.timestampMs !== null) {
      // Compare timestamps descending: larger timestamp (newer date) comes first.
      const timeDiff = itemB.timestampMs - itemA.timestampMs;
      // If timestamps differ, return difference to establish relative recency order.
      if (timeDiff !== 0) {
        // Return negative if B is older, positive if A is older.
        return timeDiff;
      }
    }

    // RULE 3: Items with valid timestamps precede items with missing/null timestamps within same tier.
    if (itemA.timestampMs !== null && itemB.timestampMs === null) {
      // Item A has timestamp, Item B lacks timestamp -> Item A comes first (-1).
      return -1;
    }
    // Check reverse case where Item B has timestamp and Item A lacks timestamp.
    if (itemA.timestampMs === null && itemB.timestampMs !== null) {
      // Item B has timestamp, Item A lacks timestamp -> Item B comes first (+1).
      return 1;
    }

    // RULE 4: Stable fallback to original input array index order when all priority metrics are equal.
    return itemA.originalIndex - itemB.originalIndex;
  });

  // Map sorted annotated items back to raw application objects array.
  return annotated.map((item) => item.app);
}
