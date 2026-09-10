// Ashby job board adapter.
//
// ENDPOINT: https://api.ashbyhq.com/posting-api/job-board/{board_token}
// Public, unauthenticated, documented. No key (constraint #13: nothing invented).
//
// A DISTINCTION §19 MAKES THAT APPLIES HERE AND IS EASY TO MISS: Ashby's HUMAN-FACING
// job board is a client-rendered SPA — a plain GET of the HTML returns zero form
// fields, which is why the worker stream's Ashby fixture had to be a Playwright-
// RENDERED snapshot. That is a fact about the HTML board and NOT about this endpoint.
// The posting API is server-rendered JSON and needs no browser at all. Worth stating
// because "Ashby is an SPA" is true and would lead a reader to the wrong conclusion
// about discovery — the SPA problem belongs to form-filling, not to polling.
//
// FIELD-NAME UNCERTAINTY, STATED RATHER THAN GUESSED. This API is public but only
// semi-documented, and the published-date key has appeared as both `publishedAt` and
// `publishedDate` across versions. Rather than pick one and hope, the readers below
// accept several candidates in priority order. That is not sloppiness — it is the
// difference between a board whose dates all silently degrade to `derived` and one
// that works. The first real poll settles which key is live; until then, accepting
// both costs nothing and guessing wrong costs a day of stale applications.

// Shared contract and field readers.
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
} from "./types.ts";

// The posting API host.
const ASHBY_API_ORIGIN = "https://api.ashbyhq.com";

// Read Ashby's boolean remote flag.
//
// Returned as `boolean | undefined`, NEVER coerced to false when absent. "The board
// did not say" and "the board said no" are different claims, and collapsing them
// would let a missing field masquerade as a positive assertion that a role is onsite.
function readIsRemote(job: Record<string, unknown>): boolean | undefined {
  // The flag as Ashby ships it.
  const raw = job["isRemote"];
  // Only a genuine boolean counts; a string "true" is a serialisation artefact and
  // treating it as authoritative would be believing a coercion rather than a field.
  return typeof raw === "boolean" ? raw : undefined;
}

// The adapter itself.
export const ashbyAdapter: AtsAdapter = {
  // Which Playwright adapter submits here.
  provider: "ashby",
  // Where the sighting came from.
  discoverySource: "ashby",

  // Build the poll URL.
  buildRequestUrl(boardToken: string): string {
    return `${ASHBY_API_ORIGIN}/posting-api/job-board/${encodeURIComponent(boardToken)}`;
  },

  // Pure and synchronous.
  parse(payload: unknown): AtsParseResult {
    // Object envelope, like Greenhouse and unlike Lever.
    if (!isRecord(payload)) {
      return { ok: false, reason: "ashby: response was not a JSON object" };
    }
    // The postings array.
    const jobs = payload["jobs"];
    // A missing array means the envelope changed or the token is retired.
    if (!Array.isArray(jobs)) {
      return { ok: false, reason: "ashby: response had no `jobs` array" };
    }
    // Postings we could read.
    const postings: ParsedPosting[] = [];
    // Postings we could not, and postings we deliberately declined.
    const skipped: string[] = [];
    // One pass.
    for (const entry of jobs) {
      // Non-object entries are noise.
      if (!isRecord(entry)) {
        skipped.push("entry was not an object");
        continue;
      }
      // Ashby's posting id.
      const atsJobId = readId(entry, "id");
      // ASHBY EXPOSES UNLISTED POSTINGS THROUGH THE SAME ENDPOINT. `isListed: false`
      // means the company has deliberately taken it off their public board — usually
      // a filled role or an internal-only requisition. Applying to one is at best
      // noise and at worst applying to something that is not open, so it is declined
      // explicitly rather than filtered later. This check has no equivalent on the
      // other two boards, which is precisely why one universal scraper could not
      // express it (constraint #12).
      if (entry["isListed"] === false) {
        skipped.push(`job ${atsJobId ?? "?"} is not publicly listed`);
        continue;
      }
      // The title.
      const title = readString(entry, "title");
      // Nothing to fingerprint or screen on without it.
      if (title === null) {
        skipped.push(`job ${atsJobId ?? "?"} had no title`);
        continue;
      }
      // THE CANONICAL SUBMIT TARGET. `applyUrl` is the form; `jobUrl` is the posting
      // page. Preferring the form saves the worker a navigation.
      const applyUrl = readString(entry, "applyUrl", "jobUrl");
      // Not actionable without one.
      if (applyUrl === null) {
        skipped.push(`job ${atsJobId ?? "?"} had no applyUrl or jobUrl`);
        continue;
      }
      // Ashby's location is a bare string, unlike Greenhouse's nested object.
      const locationRaw = readString(entry, "location");
      // The structured remote flag, kept tri-state.
      const isRemote = readIsRemote(entry);
      // Build the posting.
      postings.push({
        atsJobId,
        title,
        locationRaw,
        // Plain text preferred over HTML for the same reason as Lever: it is the
        // board's own de-marked text, so our stripper does not have to guess at
        // structure Ashby already resolved.
        descriptionRaw: stripHtml(readString(entry, "descriptionPlain", "descriptionHtml")),
        applyUrl,
        // Ashby ships `employmentType` as a CamelCase token ("FullTime", "Intern").
        // `classifyEmploymentType` folds case and matches on substrings, so "FullTime"
        // is caught by the "fulltime" branch — which is exactly why that branch exists
        // alongside the spaced and hyphenated forms.
        employmentType: classifyEmploymentType(readString(entry, "employmentType") ?? title),
        // Structure beats prose: the boolean wins when present, the location string is
        // the fallback, and absence stays absence.
        workArrangement: classifyWorkArrangement(locationRaw, isRemote),
        // THE DATE. Ashby publishes a genuine publication timestamp, so this variant
        // is allowed to earn `exact`. Both observed key spellings are accepted — see
        // the header note; guessing one would silently degrade every date on the board.
        postedAtInput: { source: "ashby", publishedDate: readString(entry, "publishedAt", "publishedDate", "publishedOn") },
        // Raw entry retained.
        rawPayload: entry,
      });
    }
    // Empty is legal.
    return { ok: true, postings, skipped };
  },
};
