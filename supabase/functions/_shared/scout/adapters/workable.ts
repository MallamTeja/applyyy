// Workable job board adapter.
//
// ENDPOINT: https://apply.workable.com/api/v1/widget/accounts/{boardToken}?details=true
// Public, unauthenticated JSON endpoint powering Workable's embeddable widgets and company
// career portals. Requires no API keys, OAuth tokens, or web scraping (constraint #13:
// nothing here is invented).
//
// RESPONSE ENVELOPE: Workable returns a JSON object containing a `jobs` array (or a
// list of job objects). Including `?details=true` in the query parameters instructs
// the endpoint to return full description fields rather than summary-only cards.
//
// TRAP & DESIGN DECISIONS:
// 1. Title & Identifier: Workable uses `shortcode` as the primary posting identifier, though
//    some versions emit `id` or `code`. The title is usually in `title`.
// 2. Direct Apply Link: Workable provides `shortlink` or `url`. If absent, the canonical
//    url shape `https://apply.workable.com/{boardToken}/j/{shortcode}/` can be constructed.
// 3. Remote & Workplace Type: Workable indicates remote roles via a boolean `telecommute`
//    field or structured `workplace_type` ("remote", "hybrid", "on_site").
// 4. Date Semantics: Workable returns `published_on` or `created_at` as ISO 8601 strings.
//    These represent genuine publication dates and earn `exact` confidence when present.
// 5. Schema Resilience: Fields are checked against multiple known candidates (`shortcode`,
//    `id`, `code` for IDs; `published_on`, `published_at`, `created_at` for dates) so that
//    minor Workable API variations do not result in missing attributes or dropped jobs.

// Import shared contract interfaces and utility functions for parsing ATS payloads.
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

// The base origin for Workable public widget endpoints.
// Kept as a constant to avoid repeating the origin URL throughout the code.
const WORKABLE_API_ORIGIN = "https://apply.workable.com";

// Extract human-readable location prose from a Workable job entry.
//
// Workable can supply location as a plain string or a nested object containing
// `city`, `region`, `countryName` or `country`. Reading both formats keeps parsing
// robust against schema variations across different account widget configurations.
function readWorkableLocation(job: Record<string, unknown>): string | null {
  // Try reading location as a direct string field first (some payloads return a string).
  const directLocation = readString(job, "location");
  // If a non-empty direct string location was found, return it directly.
  if (directLocation !== null) {
    // Return early with the parsed direct location string.
    return directLocation;
  }

  // Check if location is represented as a nested record object.
  const locationObj = job["location"];
  // Return null immediately if location field is missing or not a valid object.
  if (!isRecord(locationObj)) {
    // No structured location data present in payload.
    return null;
  }

  // Extract city name from nested location object using readString helper.
  const city = readString(locationObj, "city");
  // Extract region, state, or province name from nested location object.
  const region = readString(locationObj, "region", "state", "province");
  // Extract country name or country code from nested location object.
  const country = readString(locationObj, "countryName", "country", "countryCode");

  // Collect non-null location components into an ordered array.
  const parts = [city, region, country].filter((part): part is string => part !== null);

  // Join non-null parts with comma separation if any exist; return null if none found.
  return parts.length > 0 ? parts.join(", ") : null;
}

// Extract explicit remote/telecommute flag from Workable job data.
//
// Workable uses `telecommute` (boolean) or `workplace_type` ("remote").
// Returning `undefined` when absent preserves the critical distinction between
// "unspecified" and "explicitly not remote" (constraint #4: do not guess).
function readWorkableRemoteFlag(job: Record<string, unknown>): boolean | undefined {
  // Check primary boolean `telecommute` field used by Workable.
  const telecommute = job["telecommute"];
  // If telecommute is an explicit boolean true or false, return it.
  if (typeof telecommute === "boolean") {
    // Return explicit telecommute boolean value directly.
    return telecommute;
  }

  // Check fallback boolean `remote` field used in some widget versions.
  const remote = job["remote"];
  // If remote is an explicit boolean true or false, return it.
  if (typeof remote === "boolean") {
    // Return explicit remote boolean value directly.
    return remote;
  }

  // Check structured `workplace_type` or `workplaceType` string enum field.
  const workplaceType = readString(job, "workplace_type", "workplaceType");
  // If workplace_type is present, evaluate whether it equals "remote".
  if (workplaceType !== null) {
    // Return true if workplace_type is explicitly equal to "remote" (case-insensitive).
    return workplaceType.toLowerCase() === "remote";
  }

  // Flag is completely absent/unspecified in payload; return undefined.
  return undefined;
}

// The Workable ATS adapter implementation satisfying AtsAdapter interface.
export const workableAdapter: AtsAdapter = {
  // Provider identifier matching AtsProvider schema enum ('workable').
  // Used by Playwright and job assignment logic to route submission tasks.
  provider: "workable",
  // Discovery source identifier matching DiscoverySource schema enum ('workable').
  // Stored on jobs.discovered_via column for auditing job sourcing origin.
  discoverySource: "workable",

  // Build the public poll URL for a given Workable board token.
  //
  // Encodes the board token using encodeURIComponent to prevent path traversal issues.
  // Appends `?details=true` query parameter to request complete job descriptions.
  buildRequestUrl(boardToken: string): string {
    // Construct and return the fully-qualified HTTPS API URL for the board poll.
    return `${WORKABLE_API_ORIGIN}/api/v1/widget/accounts/${encodeURIComponent(boardToken)}?details=true`;
  },

  // Workable DOES report identity: the widget endpoint this adapter polls answers
  // with a top-level `name` beside `jobs` (live probe 2026-10-24: account 'printful'
  // → `.name` = "Printful"), so identity arrives free with the jobs fetch.
  readReportedIdentity(payload: unknown): string | null {
    // A non-object payload has nothing to read; parse records the failure itself.
    if (!isRecord(payload)) return null;
    // The account's display name, whitespace-as-absence like every shared read.
    return readString(payload, "name");
  },

  // Pure synchronous parser converting JSON payload into ParsedPosting array.
  //
  // Performs no network calls, database queries, or wall-clock reads.
  // Guarantees deterministic behavior and testability against saved JSON fixtures.
  parse(payload: unknown): AtsParseResult {
    // Validate top-level response envelope is a valid JSON record object.
    if (!isRecord(payload)) {
      // Return structured parse failure if payload is null, primitive, or array.
      return { ok: false, reason: "workable: response was not a JSON object" };
    }

    // Extract the `jobs` property from the top-level payload object.
    const jobs = payload["jobs"];

    // Validate that `jobs` exists and is a valid JavaScript Array.
    if (!Array.isArray(jobs)) {
      // Return structured parse failure if jobs array is missing or invalid.
      return { ok: false, reason: "workable: response had no `jobs` array" };
    }

    // Accumulator array for successfully parsed ParsedPosting objects.
    const postings: ParsedPosting[] = [];
    // Accumulator array for tracking skipped job entries and failure reasons.
    const skipped: string[] = [];

    // Iterate sequentially over each element in the retrieved jobs array.
    for (const entry of jobs) {
      // Check if entry is a valid JSON record object before inspecting properties.
      if (!isRecord(entry)) {
        // Record skipped reason for non-object array element.
        skipped.push("entry was not an object");
        // Skip current non-object entry and continue loop.
        continue;
      }

      // Read Workable's job posting identifier (`shortcode`, `id`, or `code`).
      const atsJobId = readId(entry, "shortcode", "id", "code");

      // Read job title string (`title` or `name`).
      const title = readString(entry, "title", "name");

      // Skip job if title is missing, as title is required for fingerprinting and filtering.
      if (title === null) {
        // Record skipped reason noting missing job title.
        skipped.push(`job ${atsJobId ?? "?"} had no title`);
        // Skip current job posting and continue loop.
        continue;
      }

      // Read candidate application URL from payload (`shortlink`, `url`, `apply_url`).
      let applyUrl = readString(entry, "shortlink", "url", "apply_url", "hostedUrl");

      // Fallback: If direct applyUrl is missing but shortcode exists, build canonical URL.
      if (applyUrl === null && atsJobId !== null) {
        // Construct canonical public application page URL using shortcode.
        applyUrl = `${WORKABLE_API_ORIGIN}/j/${atsJobId}`;
      }

      // Skip job if no actionable application URL target could be determined.
      if (applyUrl === null) {
        // Record skipped reason noting missing application URL.
        skipped.push(`job ${atsJobId ?? "?"} had no applyUrl/shortlink`);
        // Skip current job posting and continue loop.
        continue;
      }

      // Read raw location string or extract location from nested object structure.
      const locationRaw = readWorkableLocation(entry);

      // Read HTML description string and convert to clean plain text via stripHtml.
      const descriptionRaw = stripHtml(readString(entry, "description", "full_description", "details"));

      // Extract raw employment type string from payload, falling back to job title if absent.
      const employmentTypeRaw = readString(entry, "employment_type", "type") ?? title;

      // Classify employment type string into canonical EmploymentType enum value.
      const employmentType = classifyEmploymentType(employmentTypeRaw);

      // Extract explicit remote/telecommute boolean flag if present in payload.
      const remoteFlag = readWorkableRemoteFlag(entry);

      // Classify work arrangement (onsite/hybrid/remote) from location prose and remote flag.
      const workArrangement = classifyWorkArrangement(locationRaw, remoteFlag);

      // Read publication date string (`published_on`, `published_at`, `created_at`, `published`).
      const publishedDate = readString(entry, "published_on", "published_at", "created_at", "published");

      // Construct and append ParsedPosting object adhering strictly to system contract.
      postings.push({
        // The ATS job identifier for database reference tracking.
        atsJobId,
        // The role title string for deduplication and screening.
        title,
        // Raw location string preserved for audit and debugging.
        locationRaw,
        // Cleaned plain-text description for LLM prompts and keyword matching.
        descriptionRaw,
        // The submit target URL for application submission workers.
        applyUrl,
        // Normalized employment type (full_time, internship, contract, etc.).
        employmentType,
        // Normalized work arrangement (remote, hybrid, onsite, unknown).
        workArrangement,
        // Date input structure passed to date normalization extractor.
        postedAtInput: { source: "ashby", publishedDate },
        // Preserved raw JSON object entry for historical replay and debugging.
        rawPayload: entry,
      });
    }

    // Return successful parse result containing array of postings and skipped log.
    return { ok: true, postings, skipped };
  },
};
