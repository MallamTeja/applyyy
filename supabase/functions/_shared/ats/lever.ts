// Lever job board adapter.
//
// ENDPOINT: https://api.lever.co/v0/postings/{board_token}?mode=json
// Public, unauthenticated, documented. No key and no scraping (constraint #13:
// nothing here is invented).
//
// A ROBOTS.TXT DISTINCTION THAT MATTERS AND IS EASY TO GET WRONG. PROJECT_PLAN §19
// records that `jobs.lever.co/robots.txt` carries `User-agent: ClaudeBot` →
// `Disallow: /`, and that applyyy-21 respected it by hand-authoring a SYNTHETIC Lever
// fixture rather than crawling the HTML board. That restriction is on `jobs.lever.co`,
// the human-facing HTML site. THIS adapter targets `api.lever.co`, a different host
// and a JSON API Lever publishes for programmatic consumption.
//
// Recording the distinction rather than relying on it silently, because the honest
// position is narrower than "so it is fine": the two hosts are separate origins with
// separate robots policies, and this code does not touch the disallowed one. Whether
// to widen that to the HTML board is Teja's call and nobody else's — §19 is explicit
// that revisiting the exclusion is his decision. Nothing here revisits it.
//
// SHAPE NOTE: Lever returns a TOP-LEVEL ARRAY, not an object with a `jobs` key. That
// difference from Greenhouse and Ashby is exactly the kind of thing a single universal
// scraper would paper over with a "find the array anywhere" heuristic — which works
// until a response gains a second array and the heuristic picks the wrong one.

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

// The JSON API host. Deliberately NOT `jobs.lever.co` — see the robots.txt note above.
const LEVER_API_ORIGIN = "https://api.lever.co";

// Lever groups location, team and commitment under a `categories` object. Pulled out
// so the nesting is stated once rather than repeated at three call sites.
function readCategory(posting: Record<string, unknown>, field: string): string | null {
  // The container, absent on sparsely-filled postings.
  const categories = posting["categories"];
  // No categories at all is legal.
  if (!isRecord(categories)) return null;
  // The requested field inside it.
  return readString(categories, field);
}

// Read Lever's creation timestamp, which is epoch MILLISECONDS as a number.
//
// Returned as a number|null rather than coerced to a string because `posted-at.ts`
// declares the Lever variant as `{ createdAt: number | null }`. Keeping the wire type
// all the way to the extractor is what lets that module reject the epoch-0 sentinel —
// a coercion to ISO here would turn 0 into "1970-01-01", a well-formed date that is
// obviously wrong and would quietly pass the freshness filter as very stale.
function readCreatedAt(posting: Record<string, unknown>): number | null {
  // The field as Lever ships it.
  const raw = posting["createdAt"];
  // A genuine finite number is the expected case.
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  // Some responses stringify it; accept that rather than losing a real date to a
  // serialisation quirk.
  if (typeof raw === "string" && /^\d+$/.test(raw.trim())) return Number(raw.trim());
  // Absent or unusable. The extractor falls back to first_seen_at and downgrades the
  // confidence accordingly, which is the correct behaviour rather than a failure.
  return null;
}

// The adapter itself.
export const leverAdapter: AtsAdapter = {
  // Which Playwright adapter submits here.
  provider: "lever",
  // Where the sighting came from.
  discoverySource: "lever",

  // Build the poll URL. `mode=json` is required — without it the endpoint returns
  // HTML, which would decode as a parse failure rather than as an obvious mistake.
  buildRequestUrl(boardToken: string): string {
    return `${LEVER_API_ORIGIN}/v0/postings/${encodeURIComponent(boardToken)}?mode=json`;
  },

  // Lever reports NO identity: a live probe (2026-10-24) enumerated every posting
  // key — additionalPlain, categories, createdAt, descriptionPlain, id, text,
  // hostedUrl, applyUrl, workplaceType and friends — and none carries the company
  // name. `hostedUrl` only echoes the board token back, and the name appears solely
  // in free prose (`text`, descriptions), which a recruiter wrote and a heuristic
  // would misread. Declared null: an unreliable guard that fails healthy boards is
  // worse than no guard (CLAUDE.md §6). Lever boards stay human-verified.
  readReportedIdentity(_payload: unknown): string | null {
    return null;
  },

  // Pure and synchronous.
  parse(payload: unknown): AtsParseResult {
    // TOP-LEVEL ARRAY, unlike the other two adapters. Asserted explicitly so a change
    // in Lever's envelope surfaces as a clear parse failure rather than as zero jobs.
    if (!Array.isArray(payload)) {
      return { ok: false, reason: "lever: response was not a JSON array" };
    }
    // Postings we could read.
    const postings: ParsedPosting[] = [];
    // Postings we could not, with reasons.
    const skipped: string[] = [];
    // One pass.
    for (const entry of payload) {
      // Non-object entries are serialisation noise.
      if (!isRecord(entry)) {
        skipped.push("entry was not an object");
        continue;
      }
      // Lever's posting id is a UUID string.
      const atsJobId = readId(entry, "id");
      // LEVER CALLS THE TITLE `text`, WHICH IS THE FIELD-NAME TRAP ON THIS BOARD. A
      // generic extractor looking for `title` finds nothing and produces a board full
      // of untitled jobs — which then all fingerprint against the company alone.
      const title = readString(entry, "text", "title");
      // No title means nothing to fingerprint or screen on.
      if (title === null) {
        skipped.push(`posting ${atsJobId ?? "?"} had no text/title`);
        continue;
      }
      // THE CANONICAL SUBMIT TARGET. `applyUrl` is the form itself and is preferred;
      // `hostedUrl` is the posting page and is the fallback. Preferring the direct
      // form URL saves the worker one navigation and one chance to be redirected.
      const applyUrl = readString(entry, "applyUrl", "hostedUrl");
      // Not actionable without one.
      if (applyUrl === null) {
        skipped.push(`posting ${atsJobId ?? "?"} had no applyUrl or hostedUrl`);
        continue;
      }
      // The board's location string.
      const locationRaw = readCategory(entry, "location");
      // Lever exposes a structured workplace type, which is genuinely better evidence
      // than the location prose. Read as a string and normalised below.
      const workplaceType = readString(entry, "workplaceType");
      // Build the posting.
      postings.push({
        atsJobId,
        title,
        locationRaw,
        // Lever ships BOTH `descriptionPlain` and `description` (HTML). Preferring the
        // plain form is not merely convenient — it is the board's own de-marked text,
        // so it avoids our tag stripper guessing at structure Lever already resolved.
        // `stripHtml` still runs on the fallback path.
        descriptionRaw: stripHtml(readString(entry, "descriptionPlain", "description")),
        applyUrl,
        // `commitment` is Lever's employment-type field ("Full-time", "Intern", …).
        // Falls back to the title when a board leaves it unset.
        employmentType: classifyEmploymentType(readCategory(entry, "commitment") ?? title),
        // STRUCTURE BEATS PROSE. `workplaceType === "remote"` is a field Lever
        // maintains; the location string is prose a recruiter typed. Passing the flag
        // as `undefined` rather than `false` when it is absent keeps "no flag" and
        // "flag says not remote" from collapsing into the same claim.
        workArrangement: classifyWorkArrangement(
          locationRaw ?? workplaceType,
          workplaceType === null ? undefined : workplaceType.toLowerCase() === "remote",
        ),
        // THE DATE. Lever publishes a genuine creation instant, so this variant is the
        // one allowed to earn `exact` confidence.
        postedAtInput: { source: "lever", createdAt: readCreatedAt(entry) },
        // Raw entry retained for re-parsing history without re-polling.
        rawPayload: entry,
      });
    }
    // Empty is legal.
    return { ok: true, postings, skipped };
  },
};
