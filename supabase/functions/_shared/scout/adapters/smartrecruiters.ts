// SmartRecruiters job board adapter.
//
// ENDPOINT: https://api.smartrecruiters.com/v1/companies/{boardToken}/postings
// Public, unauthenticated JSON endpoint powering SmartRecruiters' public company career pages
// and posting feeds. Requires no API keys, OAuth tokens, or web scraping (constraint #13:
// nothing here is invented).
//
// RESPONSE ENVELOPE: SmartRecruiters returns a JSON object containing a `content` array of
// postings (`{ "totalFound": N, "content": [...] }`), or in some legacy variants a top-level
// array. This adapter accepts both shapes gracefully.
//
// TRAP & DESIGN DECISIONS:
// 1. Title & Identifier: SmartRecruiters uses `name` for the job title (not `title`) and
//    `id` or `uuid` or `jobAdId` for the posting identifier.
// 2. Location & Remote Flag: SmartRecruiters nests location data under `location` as an
//    object (`{ city, region, country, remote }`). The boolean `remote` field is explicit
//    when present.
// 3. Employment Type: SmartRecruiters nests employment type under `typeOfEmployment` as an
//    object (`{ id: "full_time", label: "Full-time" }`) or string label.
// 4. Direct Apply Link: SmartRecruiters postings carry a `ref` link or `applyUrl`. If no
//    direct application URL string is present in the record, a canonical posting URL shape
//    `https://jobs.smartrecruiters.com/{boardToken}/{id}` is constructed as fallback.
// 5. Date Semantics: SmartRecruiters returns `releasedDate` as an ISO 8601 UTC string.
//    This represents a genuine publication date and earns `exact` confidence when present.
// 6. Resilience against Schema Variations: Checks multiple field names for key data points
//    (`releasedDate`, `createdDate`, `publishedDate`, `updatedDate` for dates) to prevent
//    unnecessary job drops on API schema updates.

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

// The base origin for SmartRecruiters public posting endpoints.
// Kept as a constant to avoid duplicating host string in code.
const SMARTRECRUITERS_API_ORIGIN = "https://api.smartrecruiters.com";

// The base origin for public SmartRecruiters candidate career sites.
// Used for fallback URL construction when explicit apply links are missing.
const SMARTRECRUITERS_JOBS_ORIGIN = "https://jobs.smartrecruiters.com";

// The postings endpoint for one company, without a page window. A module function
// rather than a `this.buildRequestUrl` call so `nextPageUrl` cannot lose its receiver
// when the adapter is spread or destructured. The token is encoded so a value typed
// into the watchlist cannot reshape the request path.
function postingsUrl(boardToken: string): string {
  // Construct the public SmartRecruiters company postings API URL.
  return `${SMARTRECRUITERS_API_ORIGIN}/v1/companies/${encodeURIComponent(boardToken)}/postings`;
}

// True for a non-negative whole number — the only shape a page cursor may take. A
// typeof check first, because `Number.isInteger("5")` is false but a lenient coercion
// elsewhere would make "5" (or "", which coerces to 0) look like a cursor.
function isCount(value: unknown): value is number {
  // Numbers only, whole, and never negative.
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

// Extract human-readable location prose from a SmartRecruiters job entry.
//
// SmartRecruiters provides `location` as an object with `city`, `region`, and `country`.
// Formats available location properties into a clean comma-separated location string.
function readSmartRecruitersLocation(posting: Record<string, unknown>): string | null {
  // Check if location field exists as a nested record object or direct string.
  const locationObj = posting["location"];
  // If location is provided as a direct non-empty string, return it immediately.
  if (typeof locationObj === "string" && locationObj.trim().length > 0) {
    // Return trimmed direct location string.
    return locationObj.trim();
  }
  // Return null immediately if location field is missing or not a valid record object.
  if (!isRecord(locationObj)) {
    // No structured location data present in payload.
    return null;
  }

  // Read city name from nested location object using readString helper.
  const city = readString(locationObj, "city");
  // Read region, state, or province name from nested location object.
  const region = readString(locationObj, "region", "state", "province");
  // Read country name or country code from nested location object.
  const country = readString(locationObj, "country", "countryCode");

  // Filter out null location components to build ordered parts array.
  const parts = [city, region, country].filter((part): part is string => part !== null);

  // Join non-null parts with comma separation; return null if array is empty.
  return parts.length > 0 ? parts.join(", ") : null;
}

// Extract explicit remote work flag from SmartRecruiters location or job metadata.
//
// Checks `location.remote` boolean property first, then top-level `remote` property.
// Preserves `undefined` state when flag is completely absent (constraint #4).
function readSmartRecruitersRemoteFlag(posting: Record<string, unknown>): boolean | undefined {
  // Check if `location` field is a nested record object.
  const locationObj = posting["location"];
  // If location is a record object, inspect inside for `remote` property.
  if (isRecord(locationObj)) {
    // Read boolean `remote` property inside nested location object.
    const isRemote = locationObj["remote"];
    // Return explicit boolean value directly if present and boolean type.
    if (typeof isRemote === "boolean") {
      // Return nested location.remote boolean value.
      return isRemote;
    }
  }

  // Check top-level `remote` boolean property if present on main posting object.
  const topRemote = posting["remote"];
  // Return top-level remote boolean value directly if present and boolean type.
  if (typeof topRemote === "boolean") {
    // Return top-level remote boolean value.
    return topRemote;
  }

  // Flag is completely absent/unspecified in payload; return undefined.
  return undefined;
}

// Extract employment type string from SmartRecruiters `typeOfEmployment` object.
//
// SmartRecruiters emits `typeOfEmployment` as `{ id: "full_time", label: "Full-time" }`
// or occasionally as a bare string label.
function readSmartRecruitersEmploymentType(posting: Record<string, unknown>): string | null {
  // Read `typeOfEmployment` property from posting record.
  const typeVal = posting["typeOfEmployment"];
  // If typeOfEmployment is a direct non-empty string, return it immediately.
  if (typeof typeVal === "string" && typeVal.trim().length > 0) {
    // Return trimmed direct employment type string.
    return typeVal.trim();
  }
  // If typeOfEmployment is a nested object record, extract label or id property.
  if (isRecord(typeVal)) {
    // Extract label or id property using readString helper.
    return readString(typeVal, "label", "id");
  }

  // Return null if employment type property is missing or unrecognized.
  return null;
}

// The SmartRecruiters ATS adapter implementation satisfying AtsAdapter interface.
export const smartrecruitersAdapter: AtsAdapter = {
  // Provider identifier matching AtsProvider schema enum ('smartrecruiters').
  // Used by submission workers to select Playwright execution modules.
  provider: "smartrecruiters",
  // Discovery source identifier matching DiscoverySource schema enum ('smartrecruiters').
  // Recorded on jobs.discovered_via column to track job discovery provenance.
  discoverySource: "smartrecruiters",

  // Build the public poll URL for a given SmartRecruiters board token (company identifier).
  //
  // Encodes boardToken using encodeURIComponent to prevent path injection vulnerabilities.
  buildRequestUrl(boardToken: string): string {
    // The first page carries no query: SR's default window is already offset 0, limit 100.
    return postingsUrl(boardToken);
  },

  // SmartRecruiters pages its listing: `{ offset, limit, totalFound, content }`, and the
  // limit is clamped to 100 server-side (live probe 2026-10-24: `?limit=500` answers
  // `limit: 100`). The next page starts where this one's window ends.
  //
  // Every cursor field must be a genuine non-negative integer, and limit must be
  // positive. Anything else returns null (this page is the last) rather than guessing:
  // `Number("")` is 0, and a zero limit would request the same page forever.
  // ponytail: a malformed cursor on a big board reads only its first page. The
  // liveness mass-disappearance guard refuses to mark jobs dead from a read that
  // short, so the damage is lost coverage, not lost data.
  nextPageUrl(boardToken: string, payload: unknown): string | null {
    // A bare array (the legacy shape parse also accepts) carries no cursor.
    if (!isRecord(payload)) return null;
    // The three cursor fields, read raw so their types can be checked.
    const offset = payload["offset"];
    const limit = payload["limit"];
    const totalFound = payload["totalFound"];
    // Integers only, so a string "100" or a fractional value is no cursor.
    if (!isCount(offset) || !isCount(limit) || !isCount(totalFound)) return null;
    // A zero limit never advances.
    if (limit === 0) return null;
    // Where the next window would start.
    const nextOffset = offset + limit;
    // At or past the reported total: this page was the last.
    if (nextOffset >= totalFound) return null;
    // Same endpoint, the next window. Keeps this page's limit so windows never overlap.
    return `${postingsUrl(boardToken)}?offset=${nextOffset}&limit=${limit}`;
  },

  // SmartRecruiters DOES report identity: each posting in `.content[]` carries a
  // `company` record whose `name` is the display name (live probe 2026-10-24: token
  // 'ubisoft2' → `.content[0].company.name` = "Ubisoft"; `.identifier` only echoes
  // the token, so it is deliberately not used). KNOWN TRAP this cannot close: a
  // nonexistent token soft-200s with `{"totalFound":0,"content":[]}` — an empty
  // board — which yields null here, and null means "check inapplicable", never pass.
  readReportedIdentity(payload: unknown): string | null {
    // The same envelope tolerance as parse: object with `content`, or a bare array.
    const entries = isRecord(payload)
      ? payload["content"] ?? payload["postings"]
      : payload;
    // No postings array means no posting to carry the company record.
    if (!Array.isArray(entries)) return null;
    // First posting with a readable company name answers for the board — one board
    // is one company, so the entries agree.
    for (const entry of entries) {
      // Serialisation noise is skipped, same as parse.
      if (!isRecord(entry)) continue;
      // The nested company record.
      const company = entry["company"];
      // A malformed company record on one entry does not forfeit the rest.
      if (!isRecord(company)) continue;
      // The display name, whitespace-as-absence like every shared read.
      const name = readString(company, "name");
      // First hit answers.
      if (name !== null) return name;
    }
    // An empty or name-less board: no signal, declared honestly.
    return null;
  },

  // Pure synchronous parser converting JSON payload into ParsedPosting array.
  //
  // Performs no network requests, database operations, or system clock reads.
  // Ensures pure deterministic behavior and test execution against saved JSON fixtures.
  parse(payload: unknown): AtsParseResult {
    // Array accumulator to hold raw job entry objects extracted from envelope.
    let entries: unknown[] = [];

    // Check if payload is a top-level record object envelope.
    if (isRecord(payload)) {
      // Read `content` array (standard SmartRecruiters postings response envelope).
      const content = payload["content"] ?? payload["postings"];
      // If content property is a valid JavaScript Array, assign to entries.
      if (Array.isArray(content)) {
        // Use extracted content array as job entries list.
        entries = content;
      } else {
        // Return structured parse failure if object payload contains no valid entries array.
        return { ok: false, reason: "smartrecruiters: response object had no `content` array" };
      }
    } else if (Array.isArray(payload)) {
      // Handle legacy or variant response shapes returning a top-level array directly.
      entries = payload;
    } else {
      // Return structured parse failure if payload is neither record object nor array.
      return { ok: false, reason: "smartrecruiters: response was neither a JSON object nor array" };
    }

    // Accumulator array for successfully parsed ParsedPosting objects.
    const postings: ParsedPosting[] = [];
    // Accumulator array for tracking skipped job entries and failure reasons.
    const skipped: string[] = [];

    // Iterate sequentially through each raw entry in extracted entries array.
    for (const entry of entries) {
      // Check if entry is a valid record object before inspecting properties.
      if (!isRecord(entry)) {
        // Record skipped reason for non-object array item.
        skipped.push("entry was not an object");
        // Skip current non-object entry and continue loop.
        continue;
      }

      // Read SmartRecruiters posting identifier (`id`, `uuid`, `jobAdId`, `refNumber`).
      const atsJobId = readId(entry, "id", "uuid", "jobAdId", "refNumber");

      // SMARTRECRUITERS CALLS THE JOB TITLE `name`, WHICH IS THE PRIMARY FIELD NAME TRAP.
      const title = readString(entry, "name", "title");

      // Skip job if title is missing, as title is required for fingerprinting and screening.
      if (title === null) {
        // Record skipped reason noting missing job title/name.
        skipped.push(`posting ${atsJobId ?? "?"} had no name/title`);
        // Skip current job entry and continue loop.
        continue;
      }

      // Read candidate application target URL (`applyUrl`, `jobUrl`, `hostedUrl`, `url`).
      let applyUrl = readString(entry, "applyUrl", "jobUrl", "hostedUrl", "url");

      // Check `ref` property: if ref is a string and does not point to internal API path, use it.
      const refUrl = readString(entry, "ref");
      if (applyUrl === null && refUrl !== null && !refUrl.includes("/v1/companies/")) {
        // Use non-API ref URL as candidate application URL.
        applyUrl = refUrl;
      }

      // Fallback: If applyUrl is still missing but atsJobId exists, build canonical jobs URL.
      if (applyUrl === null && atsJobId !== null) {
        // Read company identifier from nested company object.
        const companyObj = entry["company"];
        // Extract company identifier string from company record if present.
        const companyId = isRecord(companyObj) ? readString(companyObj, "identifier") : null;
        // If company identifier was found, construct canonical candidate jobs URL.
        if (companyId !== null) {
          // Construct canonical SmartRecruiters candidate application page URL.
          applyUrl = `${SMARTRECRUITERS_JOBS_ORIGIN}/${companyId}/${atsJobId}`;
        }
      }

      // Skip job if no actionable application target URL could be resolved.
      if (applyUrl === null) {
        // Record skipped reason noting missing application URL.
        skipped.push(`posting ${atsJobId ?? "?"} had no applyUrl/name`);
        // Skip current job entry and continue loop.
        continue;
      }

      // Extract location prose from nested location record object.
      const locationRaw = readSmartRecruitersLocation(entry);

      // Read HTML description string and convert to clean plain text via stripHtml.
      const descriptionRaw = stripHtml(readString(entry, "jobAdDescription", "description", "content", "jobAd"));

      // Extract raw employment type string from payload, falling back to job title if absent.
      const rawEmploymentType = readSmartRecruitersEmploymentType(entry) ?? title;

      // Classify employment type string into canonical EmploymentType enum value.
      const employmentType = classifyEmploymentType(rawEmploymentType);

      // Extract explicit remote/telecommute boolean flag if present.
      const remoteFlag = readSmartRecruitersRemoteFlag(entry);

      // Classify work arrangement (onsite/hybrid/remote) from location prose and remote flag.
      const workArrangement = classifyWorkArrangement(locationRaw, remoteFlag);

      // Read publication timestamp (`releasedDate`, `createdDate`, `publishedDate`, `updatedDate`).
      const publishedDate = readString(entry, "releasedDate", "createdDate", "publishedDate", "updatedDate");

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
