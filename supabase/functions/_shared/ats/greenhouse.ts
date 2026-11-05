// Greenhouse job board adapter.
//
// ENDPOINT: https://boards-api.greenhouse.io/v1/boards/{board_token}/jobs?content=true
// Public, unauthenticated, documented. No key, no scraping, no robots.txt question —
// this is a JSON API Greenhouse publishes for exactly this purpose (constraint #13:
// nothing here is invented).
//
// `content=true` IS THE EXPENSIVE PART AND THE REASON SCOUT-ATS POLLS ONE BOARD PER
// INVOCATION. Without it the response is a slim index and a second request per job is
// needed; with it, every full HTML description arrives in one response — which for a
// large employer is multiple megabytes of JSON. On the Supabase free tier the binding
// limit is ~2s of CPU (not the 150s wall clock), and a multi-megabyte `JSON.parse` is
// CPU, not I/O. So the batch size is driven by parse cost, not by request count.
//
// THE TRAP THIS ADAPTER EXISTS TO CONTAIN (PROJECT_PLAN §13): Greenhouse exposes
// `updated_at` and NOT a posted date. A recruiter fixing a typo in the description
// resets it. It looks exactly like a posting timestamp and is not one, so it can never
// earn `exact` confidence no matter how well-formed it is. That downgrade is enforced
// in `posted-at.ts`, and this adapter's only job is to hand it the right union member
// so the compiler routes it to the Greenhouse branch.

// The adapter contract and the shared field readers. Shared so three adapters cannot
// drift into three different coercion behaviours.
import {
  classifyEmploymentType,
  classifyWorkArrangement,
  isRecord,
  readId,
  readHttpUrl,
  readString,
  stripHtml,
  // Greenhouse's outer escaping layer, removed once before stripHtml.
  decodeEntities,
  type AtsAdapter,
  type AtsParseResult,
  type ParsedPosting,
} from "./types.ts";

// Where the public board API lives. A constant rather than an inline template so the
// host appears exactly once in the codebase.
const GREENHOUSE_API_ORIGIN = "https://boards-api.greenhouse.io";

// Greenhouse nests the location as an object with a `name`, unlike Lever and Ashby
// which use a bare string. Pulled out so the shape difference is visible rather than
// buried in a chain of optional accesses.
function readGreenhouseLocation(job: Record<string, unknown>): string | null {
  // The nested object, when present.
  const location = job["location"];
  // A board with no location set is legal — remote-first companies routinely omit it.
  if (!isRecord(location)) return null;
  // The human-readable string inside it.
  return readString(location, "name");
}

// Greenhouse describes employment type through free-form `metadata` entries rather
// than a dedicated field, so there is nothing reliable to read. Falling back to the
// TITLE is deliberate and is the honest option: "Backend Intern" genuinely does say
// internship, and when the title says nothing the answer is `unknown` rather than a
// guess at full-time. Declining to guess is constraint #4's instinct applied to parsing.
function readGreenhouseEmploymentType(job: Record<string, unknown>): string | null {
  // The title is the only field that reliably carries this signal on Greenhouse.
  return readString(job, "title");
}

// The adapter itself.
export const greenhouseAdapter: AtsAdapter = {
  // Which Playwright adapter will submit here.
  provider: "greenhouse",
  // Where the sighting came from, for `jobs.discovered_via`.
  discoverySource: "greenhouse",

  // Build the poll URL. `encodeURIComponent` on the token because it comes from the
  // watchlist table, which a human types into — a stray space or slash must not be
  // able to reshape the path.
  buildRequestUrl(boardToken: string): string {
    return `${GREENHOUSE_API_ORIGIN}/v1/boards/${encodeURIComponent(boardToken)}/jobs?content=true`;
  },

  // Greenhouse DOES report identity, and in the SAME response the jobs come from:
  // every entry of `.jobs[]` carries a `company_name` string (live probe 2026-10-24 —
  // the board-name endpoint `/v1/boards/{token}` agrees, but using the jobs payload
  // costs zero extra requests). This is the field that catches the 'tcs' trap: the
  // token says tcs, the payload says "Thornbury Community Services".
  readReportedIdentity(payload: unknown): string | null {
    // Same envelope shape-checks as `parse` — a non-object or jobs-less payload has
    // no identity to offer, and `parse` will record it as a failure on its own.
    if (!isRecord(payload)) return null;
    // The postings array is where the identity rides.
    const jobs = payload["jobs"];
    // No array, no signal.
    if (!Array.isArray(jobs)) return null;
    // First readable `company_name` wins: one board is one company, so entries agree,
    // and an empty board legitimately has no signal (nothing to persist = no risk).
    for (const entry of jobs) {
      // Skip serialisation noise, same tolerance as `parse`.
      if (!isRecord(entry)) continue;
      // The shared reader applies the usual whitespace-as-absence rule.
      const name = readString(entry, "company_name");
      // First hit is the answer.
      if (name !== null) return name;
    }
    // A board whose entries all lack the field: no signal, declared honestly.
    return null;
  },

  // Pure. No network, no clock, no database — which is what lets this be covered by a
  // saved fixture rather than only by a live board that changes underneath the test.
  parse(payload: unknown): AtsParseResult {
    // The envelope must be an object before `jobs` can be read from it. An HTML error
    // page decoded as JSON, or a retired board token, lands here.
    if (!isRecord(payload)) {
      return { ok: false, reason: "greenhouse: response was not a JSON object" };
    }
    // The postings array.
    const jobs = payload["jobs"];
    // A missing or misshapen `jobs` key means the response is not what we expect —
    // recorded against the watchlist's failure counter rather than thrown, so one bad
    // board does not take the whole poll down with it.
    if (!Array.isArray(jobs)) {
      return { ok: false, reason: "greenhouse: response had no `jobs` array" };
    }
    // Accumulator for postings we could read.
    const postings: ParsedPosting[] = [];
    // Postings we could not, with the reason. Reported rather than silently dropped:
    // a board where every posting is skipped should look different from an empty one.
    const skipped: string[] = [];
    // One pass over the array.
    for (const entry of jobs) {
      // A non-object entry is a serialisation problem, not a posting.
      if (!isRecord(entry)) {
        skipped.push("entry was not an object");
        continue;
      }
      // The board's id for this posting. Kept for `ats_job_id`, and DELIBERATELY NOT
      // part of the fingerprint — req ids are per-board, so including one would give
      // the same job three fingerprints and defeat cross-source dedupe.
      const atsJobId = readId(entry, "id", "internal_job_id");
      // The title. Required: without it there is nothing to fingerprint or filter on.
      const title = readString(entry, "title");
      // A posting with no title cannot be deduped or screened, so it is skipped rather
      // than stored as a row nothing can act on.
      if (title === null) {
        skipped.push(`job ${atsJobId ?? "?"} had no title`);
        continue;
      }
      // THE CANONICAL SUBMIT TARGET, decided once here. Required for the same reason:
      // a job with no apply URL is not actionable.
      // http(s) only (readHttpUrl): a `javascript:` value here is skipped like a missing one.
      const applyUrl = readHttpUrl(entry, "absolute_url");
      // Skipped rather than stored, because a row that can never be submitted would
      // sit in the queue consuming attention forever.
      if (applyUrl === null) {
        skipped.push(`job ${atsJobId ?? "?"} had no absolute_url`);
        continue;
      }
      // The board's location string, kept verbatim for debugging the parse.
      const locationRaw = readGreenhouseLocation(entry);
      // Build the posting.
      postings.push({
        atsJobId,
        title,
        locationRaw,
        // `content` is HTML-ESCAPED HTML — Greenhouse escapes the markup, so it
        // arrives as `&lt;p&gt;`, and an entity inside the markup arrives escaped twice
        // ("&amp;amp;", "&amp;mdash;"). decodeEntities removes Greenhouse's outer layer
        // (2026-11-06: one decode left 4,742 "&amp;" and 1,325 "&mdash;" in stored text);
        // stripHtml then decodes the markup's own entities and drops the tags.
        descriptionRaw: stripHtml(decodeEntities(readString(entry, "content"))),
        applyUrl,
        // Inferred from the title, the only field that carries the signal here.
        employmentType: classifyEmploymentType(readGreenhouseEmploymentType(entry)),
        // Greenhouse has no structured remote flag, so the location prose is all there
        // is. `undefined` for the flag rather than `false`, because "no flag" and
        // "flag says not remote" are different claims and only one of them is true.
        workArrangement: classifyWorkArrangement(locationRaw, undefined),
        // THE DATE. Declared as the greenhouse variant so the compiler routes it to
        // the branch that refuses to call it `exact`.
        postedAtInput: { source: "greenhouse", updatedAt: readString(entry, "updated_at") },
        // The raw entry, so a parser bug can be re-run over history without re-polling.
        rawPayload: entry,
      });
    }
    // An empty board is not an error: a company with no open roles is a quiet hiring
    // quarter, and treating it as a failure would produce a permanent error rate that
    // is really just the truth.
    return { ok: true, postings, skipped };
  },
};
