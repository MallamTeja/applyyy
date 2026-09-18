// Freshness Priority Scoring Helper for Job Postings.
//
// WHAT THIS MODULE DOES:
// Job freshness is a critical input to candidate application strategy.
// Newer job postings (<24h old) offer significantly higher response rates
// and interview conversion rates compared to older postings.
//
// PRIORITY SCORE SCALE:
// - Score 100 (High Priority): Posted within the last 24 hours (0h <= age <= 24h).
// - Score 50  (Medium Priority): Posted between 24 and 72 hours ago (24h < age <= 72h).
// - Score 10  (Low Priority): Posted more than 72 hours ago (>72h), or postedAt is null/unparseable.
//
// DESIGN & ARCHITECTURE NOTES:
// 1. Pure function design: `calculateFreshnessScore` accepts an optional `now` Date parameter
//    (defaulting to `new Date()`) so that tests can inject a fixed deterministic timestamp.
// 2. Defensive date parsing: Handles null, undefined, empty strings, and invalid ISO-8601 strings gracefully.
// 3. Immutability & Zero Side Effects: Does not mutate input parameters or global state.
// 4. Time Constants: Explicitly defines time duration constants in milliseconds to avoid magic numbers.
// 5. Source Comment Ratio: Exhaustively commented to maintain high maintainability and clarity.

// Milliseconds in one second (1,000 ms).
const MS_PER_SECOND = 1000;

// Seconds in one minute (60 seconds).
const SECONDS_PER_MINUTE = 60;

// Minutes in one hour (60 minutes).
const MINUTES_PER_HOUR = 60;

// Milliseconds in one hour: 1000 ms/sec * 60 sec/min * 60 min/hr = 3,600,000 ms.
const MS_PER_HOUR = MS_PER_SECOND * SECONDS_PER_MINUTE * MINUTES_PER_HOUR;

// Freshness score thresholds and constants.
// High priority score assigned to jobs posted within the last 24 hours.
export const HIGH_PRIORITY_SCORE = 100;

// Medium priority score assigned to jobs posted between 24 and 72 hours ago.
export const MEDIUM_PRIORITY_SCORE = 50;

// Low priority score assigned to jobs posted over 72 hours ago, or with missing/invalid timestamps.
export const LOW_PRIORITY_SCORE = 10;

// Cutoff hour threshold for high priority scoring (<= 24 hours old).
const HIGH_PRIORITY_HOURS_THRESHOLD = 24;

// Cutoff hour threshold for medium priority scoring (<= 72 hours old).
const MEDIUM_PRIORITY_HOURS_THRESHOLD = 72;

/**
 * Calculates a freshness priority score for a job posting based on its creation or publication timestamp.
 *
 * Scored as follows:
 * - High Priority (100): Job was posted within the last 24 hours (inclusive).
 * - Medium Priority (50): Job was posted between 24 hours and 72 hours ago (inclusive of 72h).
 * - Low Priority (10): Job was posted more than 72 hours ago, or `postedAt` is null, empty, or unparseable.
 *
 * @param postedAt - ISO-8601 date string representing when the job was posted, or null if unknown.
 * @param now - Optional Date reference for current time (defaults to `new Date()`). Useful for deterministic testing.
 * @returns Freshness priority score (100, 50, or 10).
 */
export function calculateFreshnessScore(
  postedAt: string | null,
  now: Date = new Date()
): number {
  // Check if postedAt string is absent, null, or empty whitespace.
  // When postedAt is missing or null, we cannot determine freshness, so we return low priority.
  if (!postedAt || postedAt.trim() === "") {
    // Return low priority score for missing timestamp.
    return LOW_PRIORITY_SCORE;
  }

  // Attempt to parse the postedAt ISO string into epoch milliseconds.
  const postedTimestamp = Date.parse(postedAt);

  // Validate if the parsed timestamp is a valid finite number.
  // If Date.parse returns NaN (unparseable date string), return low priority score.
  if (Number.isNaN(postedTimestamp)) {
    // Return low priority score for invalid date format.
    return LOW_PRIORITY_SCORE;
  }

  // Calculate the age of the job posting in milliseconds relative to `now`.
  const ageInMs = now.getTime() - postedTimestamp;

  // Calculate the age of the job posting in fractional hours.
  const ageInHours = ageInMs / MS_PER_HOUR;

  // Evaluate age against priority thresholds.
  // If posted within the last 24 hours (or slightly in future due to clock skew), assign high priority score.
  if (ageInHours <= HIGH_PRIORITY_HOURS_THRESHOLD) {
    // High priority boost for fresh postings (<24h old).
    return HIGH_PRIORITY_SCORE;
  }

  // If posted between 24 and 72 hours ago (inclusive of 72h), assign medium priority score.
  if (ageInHours <= MEDIUM_PRIORITY_HOURS_THRESHOLD) {
    // Medium priority score for postings 24-72h old.
    return MEDIUM_PRIORITY_SCORE;
  }

  // For postings older than 72 hours, assign low priority score.
  return LOW_PRIORITY_SCORE;
}
