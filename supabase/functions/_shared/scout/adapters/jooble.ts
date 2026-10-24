// Jooble job aggregator discovery adapter.
//
// API OVERVIEW & ENDPOINT:
// Jooble exposes a search API endpoint at:
// https://jooble.org/api/{api_key} or https://jooble.org/api
//
// PURPOSE & ARCHITECTURAL ROLE:
// Jooble operates as a Tier-3 aggregator discovery source (tiers.ts). It fetches free
// aggregator job postings for tech roles across multiple geographies.
//
// SECURITY & DATA INTEGRITY GUARANTEES (PROJECT_PLAN §9, §13, §17):
// 1. UNTRUSTED DATA SURFACES: Title, locationRaw, descriptionRaw, and applyUrl are untrusted.
//    - Title and location strings are preserved verbatim for inspection and parsing audit.
//    - Description strings feed Gemini only inside fenced blocks to protect prompt context.
// 2. HTML STRIPPING: Descriptions are stripped of HTML markup and entity-encoded tags.
//    - HTML markup is stripped to optimize LLM token usage and prevent markup injection.
// 3. DEDUPE & FINGERPRINTING: `atsJobId` is retained for reference but excluded from fingerprinting.
//    - Excluded from `jobs.fingerprint` so identical roles cross-posted on multiple boards deduplicate cleanly.
// 4. DATE CONFIDENCE: Aggregated relative date text is passed as `{ source: "aggregator", relativeText }`.
//    - Normalizer processes aggregator date strings into derived dates with appropriate confidence ratings.

import {
  classifyEmploymentType,
  classifyWorkArrangement,
  isRecord,
  readId,
  readString,
  stripHtml,
  type AtsAdapter,
  type AtsParseResult,
  type ParsedPosting,
} from "../../ats/types.ts";

// Default API origin for Jooble job search API endpoints.
// Kept as a module constant so origin strings stay centralized.
const JOOBLE_API_ORIGIN = "https://jooble.org";

// Default API endpoint fallback when no API key is specified in boardToken or environment.
// Serves as the fallback URL endpoint structure for Jooble API calls.
const DEFAULT_JOOBLE_ENDPOINT = "https://jooble.org/api";

// Extracts raw location text from a Jooble result entry.
// Jooble typically returns location as a string field `location`.
// Returns null if location information is missing or empty.
function readJoobleLocation(job: Record<string, unknown>): string | null {
  // Read location string using shared string reader helper.
  // Performs whitespace trimming and non-empty check.
  return readString(job, "location");
}

// Combines Jooble's job `type` and job `title` to produce a candidate text signal for employment type classification.
// Jooble exposes employment type in `type` (e.g. "Full-time", "Part-time", "Contract").
// Combining `type` with `title` provides a complete text context for `classifyEmploymentType`.
function readJoobleEmploymentTypeSignal(job: Record<string, unknown>): string | null {
  // Extract employment type string property (e.g. "Full-time", "Part-time", "Contract").
  const typeStr = readString(job, "type");

  // Extract role title string property for fallback keyword matching.
  const title = readString(job, "title");

  // Initialize accumulator array for non-null textual signals.
  const signals: string[] = [];

  // Append typeStr if non-null string was extracted.
  if (typeStr !== null) {
    // Add type string to signals list.
    signals.push(typeStr);
  }

  // Append title if non-null string was extracted.
  if (title !== null) {
    // Add title string to signals list.
    signals.push(title);
  }

  // Return joined composite signal string, or null if no signals exist.
  // Combines all available text signals with single spaces.
  return signals.length > 0 ? signals.join(" ") : null;
}

// Jooble Aggregator Discovery Adapter implementation of AtsAdapter.
// Implements `buildRequestUrl` and `parse` for Jooble job search payload formats.
export const joobleAdapter: AtsAdapter = {
  // Aggregator discovery does not bind to a single known ATS submit provider upfront.
  // The specific ATS provider (Greenhouse, Lever, Ashby, etc.) is resolved post-discovery.
  provider: "unknown",

  // Discovery source tag for tracking `jobs.discovered_via`.
  discoverySource: "jooble",

  // Build the HTTP request URL for Jooble API requests.
  // Supports tokens provided in multiple formats:
  // 1. Direct full HTTP/HTTPS URL string.
  // 2. JSON string containing explicit configuration (`api_key`, `keywords`, `location`).
  // 3. Bare API key string.
  buildRequestUrl(boardToken: string): string {
    // Trim whitespace from input token string.
    const token = boardToken.trim();

    // Direct URL check: If boardToken is already a full URL, return it directly.
    if (token.startsWith("http://") || token.startsWith("https://")) {
      // Return unchanged URL string directly without modifications.
      return token;
    }

    // JSON configuration check: Check if token is formatted as a JSON object string.
    if (token.startsWith("{") && token.endsWith("}")) {
      // Wrap JSON parsing in try-catch to handle malformed JSON strings gracefully.
      try {
        // Parse JSON token payload into JavaScript object.
        const config = JSON.parse(token);

        // Verify parsed payload is a non-null plain record object.
        if (isRecord(config)) {
          // Extract api_key from config object or environment.
          const apiKey = readString(config, "api_key") ?? Deno.env.get("JOOBLE_API_KEY") ?? "";

          // If api_key is non-empty, construct key-based API URL.
          if (apiKey.length > 0) {
            // Return formatted key-based API endpoint URL.
            return `${JOOBLE_API_ORIGIN}/api/${encodeURIComponent(apiKey)}`;
          }
        }
      } catch {
        // Ignore JSON parse errors and proceed to plain string key handling.
        // Falls through to next token format handler.
      }
    }

    // Retrieve default Jooble API key from environment variables.
    const envApiKey = Deno.env.get("JOOBLE_API_KEY") ?? "";

    // If boardToken is non-empty and does not contain spaces, treat boardToken as an API key.
    const apiKey = token.length > 0 && !token.includes(" ") ? token : envApiKey;

    // If a valid API key was found, construct key-based API URL.
    if (apiKey.length > 0) {
      // Return formatted Jooble API URL with encoded key parameter.
      return `${JOOBLE_API_ORIGIN}/api/${encodeURIComponent(apiKey)}`;
    }

    // Fall back to default Jooble endpoint URL when no explicit API key is available.
    // Default endpoint allows baseline request dispatching.
    return DEFAULT_JOOBLE_ENDPOINT;
  },

  // Jooble is an AGGREGATOR: one response mixes many employers, so there is no single
  // board identity to compare against a watchlist row's company_name. The guard is
  // structurally inapplicable here, declared as the permanent no-signal answer.
  readReportedIdentity(_payload: unknown): string | null {
    return null;
  },

  // Parse raw JSON response payload into clean ParsedPosting objects.
  // PURE AND SYNCHRONOUS: no network, no clock, no database side-effects.
  // Returns AtsParseResult indicating success or descriptive failure reason.
  parse(payload: unknown): AtsParseResult {
    // Initialize variable to hold the array of raw job entries.
    let jobsArray: unknown[] | null = null;

    // Payload format check 1: If payload is a direct top-level JSON array.
    if (Array.isArray(payload)) {
      // Set jobsArray to top-level array directly.
      jobsArray = payload;
    } else if (isRecord(payload)) {
      // Payload format check 2: Object envelope containing `jobs`, `postings`, or `results` array.
      if (Array.isArray(payload["jobs"])) {
        // Extract `jobs` array property.
        jobsArray = payload["jobs"];
      } else if (Array.isArray(payload["postings"])) {
        // Extract `postings` array property.
        jobsArray = payload["postings"];
      } else if (Array.isArray(payload["results"])) {
        // Extract `results` array property.
        jobsArray = payload["results"];
      }
    }

    // Validation check: If no valid array structure could be identified in the payload.
    if (jobsArray === null) {
      // Return error result indicating missing or invalid array structure.
      return { ok: false, reason: "jooble: response had no `jobs` or `postings` array" };
    }

    // Initialize array to hold successfully parsed posting items.
    const postings: ParsedPosting[] = [];

    // Initialize array to track reasons for skipped job entries.
    const skipped: string[] = [];

    // Loop over each raw job entry in the jobs array.
    for (const entry of jobsArray) {
      // Reject any entry that is not a valid non-null record object.
      if (!isRecord(entry)) {
        // Record skip reason for non-object entry.
        skipped.push("entry was not an object");

        // Continue to next entry in iteration.
        continue;
      }

      // Read unique posting ID assigned by Jooble (`id`, `job_id`).
      const atsJobId = readId(entry, "id", "job_id");

      // Read job title string from entry.
      const title = readString(entry, "title");

      // Skip posting if title is missing or empty string.
      if (title === null) {
        // Record skip reason citing atsJobId if available.
        skipped.push(`job ${atsJobId ?? "?"} had no title`);

        // Continue to next entry.
        continue;
      }

      // Read target apply URL from candidate properties (`link`, `url`, `apply_url`, `redirect_url`).
      const applyUrl = readString(entry, "link", "url", "apply_url", "redirect_url");

      // Skip posting if no valid submit target apply URL is present.
      if (applyUrl === null) {
        // Record skip reason.
        skipped.push(`job ${atsJobId ?? "?"} had no apply URL`);

        // Continue to next entry.
        continue;
      }

      // Extract raw location string using Jooble location helper.
      const locationRaw = readJoobleLocation(entry);

      // Extract description or snippet HTML text and strip tags and HTML entities.
      const descriptionRaw = stripHtml(readString(entry, "snippet", "description", "content"));

      // Extract composite employment type signal text from `type` and `title`.
      const employmentTypeSignal = readJoobleEmploymentTypeSignal(entry);

      // Classify employment type using shared classification rules.
      const employmentType = classifyEmploymentType(employmentTypeSignal);

      // Classify work arrangement (remote, hybrid, onsite, unknown) based on location text.
      const workArrangement = classifyWorkArrangement(locationRaw, undefined);

      // Extract relative or ISO date text string from updated, created, or pubDate fields.
      const relativeText = readString(entry, "updated", "created", "pubDate", "date");

      // Construct and push validated ParsedPosting object to output array.
      postings.push({
        // Retention of source job ID for reference.
        atsJobId,
        // Untrusted role title string.
        title,
        // Untrusted raw location string.
        locationRaw,
        // Sanitized description text.
        descriptionRaw,
        // Canonical submission URL.
        applyUrl,
        // Classified employment type enum value.
        employmentType,
        // Classified work arrangement enum value.
        workArrangement,
        // Aggregator relative date input object for date normalization.
        postedAtInput: { source: "aggregator", relativeText },
        // Raw entry payload preserved for audit re-runs.
        rawPayload: entry,
      });
    }

    // Return successful parse result containing parsed postings array and skipped log.
    return { ok: true, postings, skipped };
  },
};
