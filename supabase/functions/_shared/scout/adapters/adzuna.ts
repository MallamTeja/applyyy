// Adzuna job aggregator discovery adapter.
//
// API OVERVIEW & ENDPOINT:
// Adzuna exposes a RESTful job search API at:
// https://api.adzuna.com/v1/api/jobs/{country}/search/{page}
//
// PURPOSE & ARCHITECTURAL ROLE:
// Adzuna operates as a Tier-3 aggregator discovery source (tiers.ts). It fetches free
// aggregator job postings for tech roles across multiple countries.
//
// SECURITY & DATA INTEGRITY GUARANTEES (PROJECT_PLAN §9, §13, §17):
// 1. UNTRUSTED DATA SURFACES: Title, locationRaw, descriptionRaw, and applyUrl are untrusted.
//    - Title and location strings are stored verbatim for audit inspection.
//    - Description strings feed Gemini only inside fenced blocks to protect prompt context.
// 2. HTML STRIPPING: Descriptions are stripped of HTML markup and entity-encoded tags.
//    - HTML tags are stripped to minimize token cost and neutralize markup injection.
// 3. DEDUPE & FINGERPRINTING: `atsJobId` is retained for reference but excluded from fingerprinting.
//    - Excluded from `jobs.fingerprint` so identical roles cross-posted on multiple boards deduplicate cleanly.
// 4. DATE CONFIDENCE: ISO 8601 creation dates are passed as `{ source: "adzuna", created }` for exact confidence.
//    - The `posted-at` normalizer evaluates Adzuna creation dates with `exact` confidence.

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

// Default API origin for Adzuna job search API endpoints.
// Kept as a top-level module constant so host URLs remain centralized.
const ADZUNA_API_ORIGIN = "https://api.adzuna.com";

// Default country code for Adzuna API search when no specific country is specified in boardToken.
// "us" is the primary default market for technology job discovery.
const DEFAULT_ADZUNA_COUNTRY = "us";

// Default page size for Adzuna API search results.
// 50 items per page balances response payload size with single-request yield.
const DEFAULT_ADZUNA_RESULTS_PER_PAGE = 50;

// Default search query terms for tech role discovery when none are explicitly provided in boardToken.
// "software engineer" provides broad coverage of technology engineering roles.
const DEFAULT_ADZUNA_SEARCH_TERM = "software engineer";

// Extracts raw location representation from an Adzuna result entry.
// Adzuna may return location as a structured object `{ display_name: "London, UK", area: [...] }`
// or occasionally as a flat location string.
// Returns null if location information is missing or unparseable.
function readAdzunaLocation(job: Record<string, unknown>): string | null {
  // Check if location field is present as a nested record object.
  const locationObj = job["location"];

  // If location is a nested record object, attempt reading `display_name`.
  if (isRecord(locationObj)) {
    // Return display_name string if non-empty string is found.
    return readString(locationObj, "display_name");
  }

  // Fallback: Attempt reading location directly if it was serialized as a top-level string property.
  return readString(job, "location");
}

// Combines Adzuna's contract_type, contract_time, and job title to produce a candidate text
// string for employment type classification.
// Adzuna exposes `contract_type` (e.g. "permanent", "contract") and `contract_time` (e.g. "full_time", "part_time").
// Combining these with the role title ensures maximum signal for `classifyEmploymentType`.
function readAdzunaEmploymentTypeSignal(job: Record<string, unknown>): string | null {
  // Extract contract_type string value (e.g. "permanent", "contract").
  const contractType = readString(job, "contract_type");

  // Extract contract_time string value (e.g. "full_time", "part_time").
  const contractTime = readString(job, "contract_time");

  // Extract role title string value as a fallback signal for intern / contract detection.
  const title = readString(job, "title");
  
  // Initialize accumulator array for non-null textual signals.
  const signals: string[] = [];

  // Append contractType if non-null string was extracted.
  if (contractType !== null) {
    // Add contractType to signal array.
    signals.push(contractType);
  }

  // Append contractTime if non-null string was extracted.
  if (contractTime !== null) {
    // Add contractTime to signal array.
    signals.push(contractTime);
  }

  // Append title if non-null string was extracted.
  if (title !== null) {
    // Add title to signal array.
    signals.push(title);
  }

  // Join non-empty signal strings into a space-separated composite text block.
  // Returns null if no valid signals were found.
  return signals.length > 0 ? signals.join(" ") : null;
}

// Adzuna Aggregator Discovery Adapter implementation of AtsAdapter.
// Implements `buildRequestUrl` and `parse` for the Adzuna job search API.
export const adzunaAdapter: AtsAdapter = {
  // Aggregator discovery does not bind to a single known ATS submit provider upfront.
  // The actual ATS provider (Greenhouse, Lever, Ashby, etc.) is resolved post-discovery.
  provider: "unknown",

  // Discovery source tag for tracking `jobs.discovered_via`.
  discoverySource: "adzuna",

  // Build the HTTP poll URL for Adzuna API search requests.
  // Supports tokens provided in multiple formats:
  // 1. Direct full HTTP/HTTPS URL string.
  // 2. JSON string with explicit search criteria (`country`, `what`, `app_id`, `app_key`).
  // 3. Colon-separated string format `country:app_id:app_key`.
  // 4. Bare country code string (e.g. "us", "gb", "in").
  buildRequestUrl(boardToken: string): string {
    // Trim surrounding whitespace from input boardToken.
    const token = boardToken.trim();

    // Direct URL check: If boardToken is already a full URL, return it directly without modification.
    if (token.startsWith("http://") || token.startsWith("https://")) {
      // Return unchanged URL string.
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
          // Extract country code from config object, falling back to default "us".
          const country = readString(config, "country") ?? DEFAULT_ADZUNA_COUNTRY;

          // Extract search term from config object, falling back to default "software engineer".
          const what = readString(config, "what") ?? DEFAULT_ADZUNA_SEARCH_TERM;

          // Extract app_id from config object or environment variables.
          const appId = readString(config, "app_id") ?? Deno.env.get("ADZUNA_APP_ID") ?? "";

          // Extract app_key from config object or environment variables.
          const appKey = readString(config, "app_key") ?? Deno.env.get("ADZUNA_APP_KEY") ?? "";
          
          // Instantiate URLSearchParams object for building query string.
          const params = new URLSearchParams();

          // Set results_per_page query parameter.
          params.set("results_per_page", String(DEFAULT_ADZUNA_RESULTS_PER_PAGE));

          // Set search terms query parameter.
          params.set("what", what);

          // Include app_id parameter if key is non-empty.
          if (appId.length > 0) {
            // Set app_id parameter.
            params.set("app_id", appId);
          }

          // Include app_key parameter if key is non-empty.
          if (appKey.length > 0) {
            // Set app_key parameter.
            params.set("app_key", appKey);
          }

          // Construct and return final REST API search URL.
          return `${ADZUNA_API_ORIGIN}/v1/api/jobs/${encodeURIComponent(country)}/search/1?${params.toString()}`;
        }
      } catch {
        // Ignore JSON parse errors and fall through to alternative string formats.
      }
    }

    // Colon-delimited format check: Format `country:app_id:app_key`.
    if (token.includes(":")) {
      // Split token into string segments by colon delimiter.
      const parts = token.split(":");

      // Extract country code from first segment, defaulting to "us".
      const country = parts[0]?.trim() || DEFAULT_ADZUNA_COUNTRY;

      // Extract app_id from second segment, defaulting to environment variable.
      const appId = parts[1]?.trim() || Deno.env.get("ADZUNA_APP_ID") || "";

      // Extract app_key from third segment, defaulting to environment variable.
      const appKey = parts[2]?.trim() || Deno.env.get("ADZUNA_APP_KEY") || "";

      // Instantiate URLSearchParams object for query string construction.
      const params = new URLSearchParams();

      // Set results per page parameter.
      params.set("results_per_page", String(DEFAULT_ADZUNA_RESULTS_PER_PAGE));

      // Set default search query parameter.
      params.set("what", DEFAULT_ADZUNA_SEARCH_TERM);

      // Append app_id parameter if non-empty string.
      if (appId.length > 0) {
        // Set app_id parameter.
        params.set("app_id", appId);
      }

      // Append app_key parameter if non-empty string.
      if (appKey.length > 0) {
        // Set app_key parameter.
        params.set("app_key", appKey);
      }

      // Return formatted API search URL with encoded path and query string.
      return `${ADZUNA_API_ORIGIN}/v1/api/jobs/${encodeURIComponent(country)}/search/1?${params.toString()}`;
    }

    // Bare token format fallback: Treat token as a country code (e.g. "us", "gb", "in").
    const country = token.length > 0 ? token : DEFAULT_ADZUNA_COUNTRY;

    // Retrieve app_id from environment variables.
    const appId = Deno.env.get("ADZUNA_APP_ID") ?? "";

    // Retrieve app_key from environment variables.
    const appKey = Deno.env.get("ADZUNA_APP_KEY") ?? "";

    // Instantiate URLSearchParams object.
    const params = new URLSearchParams();

    // Set results per page parameter limit.
    params.set("results_per_page", String(DEFAULT_ADZUNA_RESULTS_PER_PAGE));

    // Set search query term.
    params.set("what", DEFAULT_ADZUNA_SEARCH_TERM);

    // Include app_id if environment variable is populated.
    if (appId.length > 0) {
      // Set app_id parameter.
      params.set("app_id", appId);
    }

    // Include app_key if environment variable is populated.
    if (appKey.length > 0) {
      // Set app_key parameter.
      params.set("app_key", appKey);
    }

    // Construct and return final request URL.
    return `${ADZUNA_API_ORIGIN}/v1/api/jobs/${encodeURIComponent(country)}/search/1?${params.toString()}`;
  },

  // Parse raw JSON response payload into clean ParsedPosting objects.
  // PURE AND SYNCHRONOUS: no network, no clock, no database side-effects.
  // Returns AtsParseResult indicating success or descriptive failure reason.
  parse(payload: unknown): AtsParseResult {
    // Validate top-level payload envelope is a valid non-null JSON object.
    if (!isRecord(payload)) {
      // Return failure result if payload is null, non-object, or array.
      return { ok: false, reason: "adzuna: response was not a JSON object" };
    }

    // Extract results property from top-level response envelope object.
    const results = payload["results"];

    // Validate that results property is an array of job posting entries.
    if (!Array.isArray(results)) {
      // Return failure result if results array is missing or invalid.
      return { ok: false, reason: "adzuna: response had no `results` array" };
    }

    // Initialize array to hold successfully parsed posting items.
    const postings: ParsedPosting[] = [];

    // Initialize array to track reasons for skipped job entries.
    const skipped: string[] = [];

    // Loop over each raw job entry in the results array.
    for (const entry of results) {
      // Reject any entry that is not a valid non-null record object.
      if (!isRecord(entry)) {
        // Record skip reason for invalid non-object item.
        skipped.push("entry was not an object");

        // Continue to next entry in iteration.
        continue;
      }

      // Read unique posting ID assigned by Adzuna (e.g. `id`).
      const atsJobId = readId(entry, "id");

      // Read job title string from entry.
      const title = readString(entry, "title");

      // Skip posting if title is missing or empty string.
      if (title === null) {
        // Record skip reason citing atsJobId if available.
        skipped.push(`job ${atsJobId ?? "?"} had no title`);

        // Continue to next entry.
        continue;
      }

      // Read target apply URL from candidate properties (`redirect_url`, `url`, `canonical_url`).
      const applyUrl = readString(entry, "redirect_url", "url", "canonical_url");

      // Skip posting if no valid submit target apply URL is present.
      if (applyUrl === null) {
        // Record skip reason.
        skipped.push(`job ${atsJobId ?? "?"} had no apply URL`);

        // Continue to next entry.
        continue;
      }

      // Extract raw location string using Adzuna location helper.
      const locationRaw = readAdzunaLocation(entry);

      // Extract description HTML text and strip tags and HTML entities.
      const descriptionRaw = stripHtml(readString(entry, "description"));

      // Extract composite employment type signal text from contract properties and title.
      const employmentTypeSignal = readAdzunaEmploymentTypeSignal(entry);

      // Classify employment type using shared classification rules.
      const employmentType = classifyEmploymentType(employmentTypeSignal);

      // Classify work arrangement (remote, hybrid, onsite, unknown) based on location text.
      const workArrangement = classifyWorkArrangement(locationRaw, undefined);

      // Extract ISO 8601 creation date string from `created` property.
      const created = readString(entry, "created");

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
        // Classclassified employment type enum value.
        employmentType,
        // Classified work arrangement enum value.
        workArrangement,
        // Source date input object for exact timestamp normalization.
        postedAtInput: { source: "adzuna", created },
        // Raw entry payload preserved for audit re-runs.
        rawPayload: entry,
      });
    }

    // Return successful parse result containing parsed postings array and skipped log.
    return { ok: true, postings, skipped };
  },
};
