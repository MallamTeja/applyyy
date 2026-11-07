// Workday job board adapter (discovery only; Workday applications route to a human).
//
// ENDPOINT: POST https://{tenant}.wd{N}.myworkdayjobs.com/wday/cxs/{tenant}/{site}/jobs
// with body {"appliedFacets":{},"limit":20,"offset":0,"searchText":""}. This is the
// public, unauthenticated JSON call every Workday careers page makes for its own job
// list. No keys, no scraping (constraint #13). robots.txt on the 19 verified tenants
// does not disallow /wday/cxs/ (repo gate, 2026-11-01), and the shared transport
// re-checks it on every request.
//
// THE FOUR QUIRKS THIS FILE IS SHAPED BY, each proved live on 2026-11-01 (nvidia.wd5,
// a non-candidate tenant, 1 req/s). Each one is a way to store a truncated board as whole:
// 1. POST ONLY. A GET of the same URL answers 400, so the page window travels in a
//    body (`requestBody`), never a query string.
// 2. `total` ARRIVES ON PAGE ONE ONLY. Later pages say `total: 0`, so the end of the
//    board cannot be read from a later payload. Page one's total is carried forward
//    in the page URL's FRAGMENT: `#offset=40&total=238`.
//    WHY A FRAGMENT AND NOT A QUERY PARAMETER: fetch never sends a fragment (the URL
//    standard strips it from the request), so the cursor cannot reach or confuse
//    Workday. And the page loop's stall check (`next === url`) still compares whole
//    strings. A query parameter WOULD be sent, and Workday 400s on what it does not expect.
// 3. A PAGE IS AT MOST 20 POSTINGS (limit 50 answers 400). With the shared
//    MAX_BOARD_PAGES of 20, one board read takes at most 400 postings. A bigger board
//    FAILS at the cap rather than truncating. Narrow it with a facet (below).
// 4. `total` CAPS AT 2000, and offset 2000 wraps back to page one's first posting. A
//    board reporting 2000 cannot be read in full at any page cap, so `parse` refuses it.
//
// THE BOARD TOKEN: `{tenant}.wd{N}/{site}` with an optional `?{facetParam}={id}[,{id}...]`.
// Example: `visa.wd5/Visa?locationCountry=c4f78be1a8f14da0ab49ce1162348a5e`.
// The facet narrows a big board, usually to India. Its parameter name and ids are
// TENANT-SPECIFIC (read from page one's `facets`), and several tenants have no country
// facet at all, only per-city `locations` ids. Hence one parameter carrying a list of
// ids. The token is a CLOSED SHAPE, parsed by one anchored regex (CLAUDE.md §6). A
// lenient split would let a typo or a pasted URL become a request to the wrong host.

// Shared contract types and field readers, the same ones every adapter uses.
import {
  classifyEmploymentType,
  classifyWorkArrangement,
  isRecord,
  readString,
  // The shared HTML-to-text step every adapter's description goes through.
  stripHtml,
  type AtsAdapter,
  type AtsParseResult,
  type ParsedPosting,
} from "../../ats/types.ts";

// Workday's page size: the most `limit` the list endpoint accepts (quirk 3).
const PAGE_SIZE = 20;

// Workday's `total` ceiling (quirk 4). A board AT this number is "2000 or more".
const WORKDAY_TOTAL_CAP = 2000;

// The whole token, anchored at both ends so nothing can ride along before or after it.
// Groups: 1 tenant (lowercase, as Workday hosts are), 2 wd number (no leading zero),
// 3 site (case-sensitive on Workday, so case is kept), 4 facet parameter, 5 facet ids
// (32 lowercase hex each, comma-separated, at most 64; HPE has ~45 India city ids).
const TOKEN_SHAPE =
  /^([a-z0-9][a-z0-9_-]{0,62})\.wd([1-9][0-9]{0,2})\/([A-Za-z0-9][A-Za-z0-9_-]{0,127})(?:\?([A-Za-z][A-Za-z0-9_-]{0,127})=([0-9a-f]{32}(?:,[0-9a-f]{32}){0,63}))?$/;

// Page one's cursor: exactly `offset=0`. Page one has no total yet; it reads it.
const FIRST_CURSOR = "offset=0";

// A later page's cursor: a positive offset and page one's total, both without leading
// zeros, nothing else. The arithmetic checks (multiple of 20, below total, under the
// cap) follow in readCursor, because a regex cannot express them.
const LATER_CURSOR = /^offset=([1-9][0-9]{0,3})&total=([1-9][0-9]{0,3})$/;

// A posting's path within its site: `/job/` and then path characters only, with no
// query, fragment, backslash or whitespace. Dot segments are refused separately.
const EXTERNAL_PATH = /^\/job\/[^\s?#\\]+$/;

// Any `.` or `..` path segment, which could climb out of the site after URL resolution.
const DOT_SEGMENT = /(^|\/)\.{1,2}(\/|$)/;

// One parsed board token. `facet` is null for an unfiltered board.
export interface WorkdayBoard {
  // The Workday tenant: the host's first label and the cxs path's first segment.
  readonly tenant: string;
  // The data-centre number in `wd{N}`.
  readonly wd: number;
  // The careers site name; the cxs path's second segment and the posting link's first.
  readonly site: string;
  // The optional narrowing facet: one parameter, one or more ids.
  readonly facet: { readonly param: string; readonly ids: readonly string[] } | null;
}

// Parse a watchlist board token into its parts, or null for ANY other shape.
// Exported so the seed snippet's tokens are checked against the shape the scout polls with.
export function parseWorkdayToken(token: string): WorkdayBoard | null {
  // One anchored match; no trimming, so a stray space is a refusal, not a repair.
  const m = TOKEN_SHAPE.exec(token);
  // Anything else is not a Workday token.
  if (m === null) return null;
  // The facet groups are present together or not at all, by the regex's construction.
  const facet = m[4] !== undefined && m[5] !== undefined ? { param: m[4], ids: m[5].split(",") } : null;
  // The groups are guaranteed by the match above; the non-null assertions say so.
  return { tenant: m[1]!, wd: Number(m[2]), site: m[3]!, facet };
}

// The board's origin: the tenant's own Workday host.
function originOf(board: WorkdayBoard): string {
  // Built only from regex-validated parts, so it cannot name another host.
  return `https://${board.tenant}.wd${board.wd}.myworkdayjobs.com`;
}

// The cxs list endpoint for a board, without a cursor.
function endpointOf(board: WorkdayBoard): string {
  // The same path a real careers page POSTs to.
  return `${originOf(board)}/wday/cxs/${board.tenant}/${board.site}/jobs`;
}

// A posting's apply link exactly as parse() builds it (origin + site + externalPath), anchored
// at both ends. Groups: 1 tenant, 2 wd number, 3 site, 4 the `/job/` path. The parts follow
// TOKEN_SHAPE and EXTERNAL_PATH; dot segments are refused separately, as in parse().
const APPLY_URL =
  /^https:\/\/([a-z0-9][a-z0-9_-]{0,62})\.wd([1-9][0-9]{0,2})\.myworkdayjobs\.com\/([A-Za-z0-9][A-Za-z0-9_-]{0,127})(\/job\/[^\s?#\\]+)$/;

// The detail endpoint for one posting, built from its apply link, or null for any other shape.
//
// WHY THE DETAIL READ EXISTS (2026-11-05): the list endpoint carries no description, so 5612 of
// 5612 Workday jobs were saved without one and the screener judged them on the title alone.
// The detail endpoint returns `jobPostingInfo.jobDescription`. WHY FROM THE APPLY LINK: the
// scouts have it on every row and the back-fill has it in `jobs.apply_url`, where the board
// token is not stored. The link is untrusted on that path, so it is matched, never repaired.
export function workdayDetailUrl(applyUrl: string): string | null {
  // One anchored match; no trimming, so a stray space is a refusal.
  const m = APPLY_URL.exec(applyUrl);
  // Any other shape, or a dot segment that could climb out of the site after resolution.
  if (m === null || DOT_SEGMENT.test(m[4]!)) return null;
  // Same host, then `/wday/cxs/{tenant}` before the site and posting path, all from the match.
  return `https://${m[1]}.wd${m[2]}.myworkdayjobs.com/wday/cxs/${m[1]}/${m[3]}${m[4]}`;
}

// The posting's description as text, from a detail response, or null when there is none.
// Only an object holding `jobPostingInfo.jobDescription` as non-empty text counts (CLAUDE.md
// §6); a soft-200 page, a missing field or markup with no text is null, never "".
export function parseWorkdayDescription(payload: unknown): string | null {
  // The envelope and its one field must both be objects.
  if (!isRecord(payload) || !isRecord(payload.jobPostingInfo)) return null;
  // readString keeps only non-empty text; stripHtml returns null when no text is left.
  return stripHtml(readString(payload.jobPostingInfo, "jobDescription"));
}

// The list's text for a multi-site posting: "3 Locations", "1 Location". Exactly this shape and
// nothing looser, so a real place name is never mistaken for a count and overwritten.
export const WORKDAY_LOCATION_COUNT = /^\d+ Locations?$/;

// Every site of a posting, from a detail response, as one string the work-auth gate can split,
// or null when the response does not hold the expected shape.
//
// WHY (2026-11-07, pending-tasks P2 #16): the list says "3 Locations" for a multi-site posting.
// The gate reads that as "no place named", and an unknown location PASSES (Teja, 11-05), so a
// US-only Fiserv posting (R-10405605) reached the queue as "location unknown".
// SHAPE (read live from Fiserv's detail endpoint, 2026-11-07): `location` is the primary site
// ("Berkeley Heights, New Jersey"), `additionalLocations` the other sites as strings, and
// `country.descriptor` the PRIMARY site's country only. The country is appended to the primary
// site because the gate knows no US state names: "Berkeley Heights, New Jersey" alone resolves
// to nothing and would still pass as unknown.
// STRICT (CLAUDE.md §6): no primary site, a non-array list or one non-string entry is null, and
// the caller then keeps the list's text. A partial list could hide the one site that matters.
export function parseWorkdayLocations(payload: unknown): string | null {
  // The envelope and its one field must both be objects.
  if (!isRecord(payload) || !isRecord(payload.jobPostingInfo)) return null;
  // Shorthand for the posting object.
  const info = payload.jobPostingInfo;
  // The primary site is required: without it there is nothing to qualify or lead with.
  const primary = readString(info, "location");
  // No primary site: the response is not the shape this reads.
  if (primary === null) return null;
  // The primary site's country, when Workday sends one; its absence is allowed, not guessed.
  const country = isRecord(info.country) ? readString(info.country, "descriptor") : null;
  // Absent means "no other sites"; present must be an array.
  const extra: unknown = info.additionalLocations ?? [];
  // Anything but an array is a shape this does not know.
  if (!Array.isArray(extra)) return null;
  // Every entry must be real text; one bad entry refuses the whole list.
  if (!extra.every((site) => typeof site === "string" && site.trim().length > 0)) return null;
  // Primary first, qualified by its country unless it already names it.
  const head = country !== null && !primary.includes(country) ? `${primary}, ${country}` : primary;
  // "; " is a separator the gate splits on (work-auth-gate.ts PART_SEPARATOR); "," is not,
  // because it joins a city to its state or country inside one site.
  return [head, ...(extra as string[]).map((site) => site.trim())].join("; ");
}

// A readable page position: where this page starts, and page one's total once known.
interface Cursor {
  // The page's first posting index.
  readonly offset: number;
  // Page one's total; null on page one itself, which has not read it yet.
  readonly total: number | null;
}

// Read the cursor from a page URL, or null when the URL is not a page of THIS board
// or its cursor is anything but a shape this adapter writes. NEVER defaults to offset
// 0: a missing cursor read as page one would re-read page one and call the board done.
function readCursor(board: WorkdayBoard, pageUrl: string): Cursor | null {
  // Split once at the first `#`; the part before must be this board's endpoint exactly.
  const hash = pageUrl.indexOf("#");
  // No fragment at all: not a URL this adapter built.
  if (hash < 0) return null;
  // A page URL for some other board (or host) is refused, not re-pointed.
  if (pageUrl.slice(0, hash) !== endpointOf(board)) return null;
  // The cursor text after the `#`.
  const fragment = pageUrl.slice(hash + 1);
  // Page one's exact cursor.
  if (fragment === FIRST_CURSOR) return { offset: 0, total: null };
  // Otherwise it must be a later page's exact shape.
  const m = LATER_CURSOR.exec(fragment);
  // Anything else (garbage, extra keys, a missing total) is unreadable.
  if (m === null) return null;
  // The two numbers, already digit-only by the regex.
  const offset = Number(m[1]);
  // Page one's total.
  const total = Number(m[2]);
  // Offsets this adapter writes are whole pages, inside the board, under the cap.
  if (offset % PAGE_SIZE !== 0 || offset >= total || total >= WORKDAY_TOTAL_CAP) return null;
  // A cursor this adapter could have written.
  return { offset, total };
}

// True for a non-negative whole number, the only shape `total` may take. A typeof
// check first, because a lenient coercion would make "45" or "" (which coerces to 0)
// look like a total (CLAUDE.md §6).
function isCount(value: unknown): value is number {
  // Numbers only, whole, never negative.
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

// The Workday adapter, satisfying the same contract as every other board.
export const workdayAdapter: AtsAdapter = {
  // Where the application would go. Applying is out of scope: these rows route to a human.
  provider: "workday",
  // Where the posting was FOUND: the company's own careers site, which is what a
  // Workday board is. Reusing this existing source keeps it Tier 1 (tiers.ts) with no
  // second enum migration.
  discoverySource: "company_career_page",

  // Page one's URL, carrying the explicit first-page cursor so that no cursor-less URL
  // is ever a valid page. Throws on a malformed token; both scouts' catch blocks
  // record that as a failed board, which is the right outcome for a bad watchlist row.
  buildRequestUrl(boardToken: string): string {
    // The one place a token becomes a host.
    const board = parseWorkdayToken(boardToken);
    // A token this adapter cannot read never becomes a request.
    if (board === null) throw new Error(`malformed workday board token: ${JSON.stringify(boardToken)}`);
    // The endpoint plus page one's cursor.
    return `${endpointOf(board)}#${FIRST_CURSOR}`;
  },

  // The POST body for one page: the careers page's own body, at the cursor's offset,
  // narrowed by the token's facet. Null (fail the board, send nothing) for a bad token or cursor.
  requestBody(boardToken: string, pageUrl: string): string | null {
    // The token again: requestBody is pure, so it re-derives rather than caching.
    const board = parseWorkdayToken(boardToken);
    // A bad token has no body.
    if (board === null) return null;
    // The page position, strictly read.
    const cursor = readCursor(board, pageUrl);
    // A bad cursor has no body, so the loop fails the board instead of guessing a page.
    if (cursor === null) return null;
    // Key order matches the careers page's own request.
    return JSON.stringify({
      // The narrowing facet, or none.
      appliedFacets: board.facet === null ? {} : { [board.facet.param]: board.facet.ids },
      // Workday's maximum page size.
      limit: PAGE_SIZE,
      // Where this page starts.
      offset: cursor.offset,
      // No keyword filter: the screener decides relevance, not Workday's search.
      searchText: "",
    });
  },

  // The next page's URL, or null after the last page. Page one reads `total` from its
  // payload; later pages read it from their cursor, because their payload says 0.
  // Anything unreadable returns `currentUrl` unchanged, so the loop fails the board as
  // "cursor did not advance". Null here would store a partial board as the whole one.
  nextPageUrl(boardToken: string, payload: unknown, currentUrl: string): string | null {
    // The token; unreadable means stall.
    const board = parseWorkdayToken(boardToken);
    // Stall: the loop refuses the board.
    if (board === null) return currentUrl;
    // The current page's position; unreadable means stall.
    const cursor = readCursor(board, currentUrl);
    // Stall again.
    if (cursor === null) return currentUrl;
    // Page one's total comes from its payload; later pages carry it in the cursor.
    const total = cursor.total ?? (isRecord(payload) ? payload["total"] : undefined);
    // A total that is not a whole number below the cap gives no safe end: stall. (A
    // capped board was already refused by `parse`, which the loop runs first.)
    if (!isCount(total) || total >= WORKDAY_TOTAL_CAP) return currentUrl;
    // Where the next page would start.
    const next = cursor.offset + PAGE_SIZE;
    // At or past the end: this page was the last.
    if (next >= total) return null;
    // The next page, carrying page one's total forward.
    return `${endpointOf(board)}#offset=${next}&total=${total}`;
  },

  // The list payload names no company (no field like SmartRecruiters' company.name),
  // so the honest answer is null: "check inapplicable", never a pass. Identity was
  // instead verified once at seed time, from each posting detail's hiringOrganization.
  readReportedIdentity(_payload: unknown): string | null {
    // Declared absence, the same answer lever and ashby give.
    return null;
  },

  // Pure parse of one list page. Needs the board token, because Workday's posting
  // links are relative to the site; without it the board fails rather than storing
  // links that open nowhere.
  parse(payload: unknown, boardToken?: string): AtsParseResult {
    // The token, for the posting links.
    const board = boardToken === undefined ? null : parseWorkdayToken(boardToken);
    // No readable token: refuse rather than build relative apply links.
    if (board === null) return { ok: false, reason: "workday: parse needs a valid board token to build apply links" };
    // The envelope must be an object with a `jobPostings` array; anything else
    // (an HTML error page, an empty object) is a failed board, never an empty one.
    if (!isRecord(payload) || !Array.isArray(payload["jobPostings"])) {
      // The health page shows this reason against the board.
      return { ok: false, reason: "workday: response had no `jobPostings` array" };
    }
    // Quirk 4: a board at the cap cannot be read in full. Only page one carries a real
    // total, and later pages say 0, so this fires on page one, before any paging.
    const total = payload["total"];
    // Refused with the fix named.
    if (isCount(total) && total >= WORKDAY_TOTAL_CAP) {
      // Narrowing the token is the only way to read such a board.
      return { ok: false, reason: `workday: board reports ${total}+ postings (Workday's cap); narrow the token with a facet` };
    }
    // The board's origin, for building absolute links.
    const origin = originOf(board);
    // Accumulators, in page order.
    const postings: ParsedPosting[] = [];
    // Why each dropped entry was dropped.
    const skipped: string[] = [];
    // One entry at a time; a bad entry costs only itself.
    for (const entry of payload["jobPostings"]) {
      // Serialisation noise is skipped, not fatal.
      if (!isRecord(entry)) {
        // Recorded for the health page.
        skipped.push("entry was not an object");
        // Next entry.
        continue;
      }
      // The title is required: fingerprinting and screening need it.
      const title = readString(entry, "title");
      // The posting's path within the site, the only link the list offers.
      const externalPath = readString(entry, "externalPath");
      // No title: nothing to screen.
      if (title === null) {
        // Recorded with the path when there is one.
        skipped.push(`posting ${externalPath ?? "?"} had no title`);
        // Next entry.
        continue;
      }
      // The path must be a plain `/job/...` path with no dot segments, so the built
      // link stays on this board's own site and cannot point anywhere else.
      if (externalPath === null || !EXTERNAL_PATH.test(externalPath) || DOT_SEGMENT.test(externalPath)) {
        // Recorded with the offending value for diagnosis.
        skipped.push(`posting ${JSON.stringify(title)} had no plain /job/ externalPath`);
        // Next entry.
        continue;
      }
      // The public posting page: origin, site, path.
      const applyUrl = `${origin}/${board.site}${externalPath}`;
      // Workday's own location prose ("Pune, India", or "3 Locations" when there are several).
      const locationRaw = readString(entry, "locationsText");
      // The posting, in the shared contract's shape.
      postings.push({
        // externalPath is unique per board and stable while the posting lives.
        atsJobId: externalPath,
        // The title as posted.
        title,
        // Verbatim location prose.
        locationRaw,
        // The list endpoint carries no description. Absence is declared rather than
        // fetched: a detail read per posting would multiply requests by the board size.
        descriptionRaw: null,
        // The submit target, built above from validated parts.
        applyUrl,
        // Workday's list names no employment type; the title is the only signal.
        employmentType: classifyEmploymentType(title),
        // Location prose only; Workday's list has no explicit remote flag.
        workArrangement: classifyWorkArrangement(locationRaw),
        // "Posted 3 Days Ago" is relative prose, which the aggregator date reader handles.
        postedAtInput: { source: "aggregator", relativeText: readString(entry, "postedOn") },
        // The raw entry, for replaying a parser fix over history.
        rawPayload: entry,
      });
    }
    // The page's postings and skips.
    return { ok: true, postings, skipped };
  },
};
