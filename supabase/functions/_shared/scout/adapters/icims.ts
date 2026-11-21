// iCIMS careers-site adapter (discovery only; iCIMS applications route to a human).
//
// WHY IT EXISTS (pending item 7, Teja 2026-11-14: "we need to add that too"): Atlassian has no
// Greenhouse or Lever board (its watchlist row failed 40 polls); its postings live on the iCIMS
// tenant careers-apac-atlassian.icims.com. Each iCIMS customer is its own tenant host.
//
// HOW A BOARD IS READ, each step proved live on 2026-11-21 (GET only, 2 s apart, robots read first):
// 1. LISTING = the tenant's /sitemap.xml. The HTML listing (/jobs/search?ss=1&in_iframe=1) is
//    not usable everywhere: on Atlassian it is a 164-byte JS redirect to atlassian.com. The
//    sitemap is published in robots.txt itself (`Sitemap:` line) and lists every open job as
//    /jobs/<id>/<slug>/job. It carries no title or location, so page one yields no postings.
// 2. ONE DETAIL PAGE PER JOB, at /jobs/<id>/job?in_iframe=1 (the id-only path serves the same
//    page as the slugged one, probed live). Its JSON-LD JobPosting has the title, location,
//    description and datePosted. The outer page (no in_iframe) has NO JSON-LD.
//    WHY ID-ONLY: every tenant's robots.txt disallows /jobs/*login and /jobs/*candidate, which
//    also match any SLUG containing those words. Requesting by id keeps slugs out of the path.
// 3. THE CURSOR: the ids still to read travel in the page URL's FRAGMENT (`#rest=26751,25611`),
//    the same trick Workday uses: fetch never sends a fragment, and the shared loop's stall
//    check still compares whole URLs. So the board is an ordinary paged board to
//    collectBoardPages, and EVERY page, sitemap and detail alike, goes through each scout's
//    robots gate. There is no request this adapter makes on its own.
//
// ROBOTS IS PER TENANT. careers-amd.icims.com is `Disallow: /`; atlassian, healthedge and symplr
// allow the sitemap and detail paths. The shared gate refuses a disallowing tenant before any
// page is fetched, so a disallowing tenant fails its own board and nothing else.
//
// THE BOARD TOKEN is the tenant subdomain, e.g. `careers-apac-atlassian`. A CLOSED SHAPE, parsed
// by one anchored regex (CLAUDE.md §6): a pasted host or URL must not become a request elsewhere.

// Shared contract types and field readers, the same ones every adapter uses.
import {
  classifyEmploymentType,
  classifyWorkArrangement,
  decodeEntities,
  isRecord,
  readString,
  // The shared HTML-to-text step every adapter's description goes through.
  stripHtml,
  type AtsAdapter,
  type AtsParseResult,
  type ParsedPosting,
} from "../../ats/types.ts";

// The most pages one iCIMS board read may take: the sitemap plus 59 jobs. Each job is its own
// page, so the shared cap of 20 would fail Atlassian (1 + 34). A bigger board FAILS at the cap
// rather than truncating, as everywhere else.
// ponytail: one detail GET per job per poll (no "already stored" skip); at the 1 s iCIMS pace
// that is ~1 min for a 59-job board. Skip stored ids before the detail read if tenants grow.
export const ICIMS_MAX_PAGES = 60;

// The whole token, anchored at both ends: a DNS label, lowercase, no leading or trailing hyphen.
const TOKEN_SHAPE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

// A job's numeric id: digits only, bounded, so it cannot smuggle a path or a separator.
const ID_SHAPE = /^[0-9]{1,12}$/;

// A job path as the sitemap and the JSON-LD `url` write it: /jobs/<id>/<slug>/job. The slug is
// percent-encoded (`manager%2c-account-executives`), so it never holds a raw slash or comma.
const JOB_PATH = /^\/jobs\/([0-9]{1,12})\/[^/]+\/job$/;

// The detail path this adapter requests, by id only.
const DETAIL_PATH = /^\/jobs\/([0-9]{1,12})\/job$/;

// The cursor fragment: zero or more ids, comma-separated. Empty means "this is the last page".
const REST_FRAGMENT = /^#rest=((?:[0-9]{1,12})(?:,[0-9]{1,12})*)?$/;

// A sitemap document: an optional XML declaration, then a <urlset> root. Anchored, so an HTML
// page that merely mentions "urlset" is not mistaken for one.
const SITEMAP_START = /^\s*(?:<\?xml[^>]*\?>\s*)?<urlset[\s>]/;

// Every <loc> in the sitemap.
const LOC = /<loc>\s*([^<]+?)\s*<\/loc>/g;

// Every JSON-LD script block in a detail page.
const JSON_LD = /<script[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;

// iCIMS writes this literal into JSON-LD address fields it has no value for. It is not a place.
const PLACEHOLDER = "UNAVAILABLE";

// English names for ISO 3166 alpha-2 codes, from the runtime's ICU data (Node and Deno both ship
// it). "IN" is spelled out because the work-auth gate deliberately leaves the bare code unread:
// it is also Indiana.
const REGION_NAMES = new Intl.DisplayNames(["en"], { type: "region" });

// Split a token into the tenant and its origin, or null when it is not the closed shape.
export function parseIcimsToken(token: string): { readonly tenant: string; readonly origin: string } | null {
  // Anything but a bare lowercase subdomain label is refused.
  if (!TOKEN_SHAPE.test(token)) return null;
  // Every request for this board starts with this origin.
  return { tenant: token, origin: `https://${token}.icims.com` };
}

// The detail page this adapter requests for one job id, with the rest of the ids in the fragment.
function detailUrl(origin: string, id: string, rest: readonly string[]): string {
  // in_iframe=1 is the page variant that carries the JSON-LD.
  return `${origin}/jobs/${id}/job?in_iframe=1#rest=${rest.join(",")}`;
}

// The job ids a sitemap lists on this tenant, in sitemap order, each once. Null when the payload
// is not a sitemap at all, which the caller must treat as a failure, never as an empty board.
function readSitemapJobIds(payload: string, origin: string): string[] | null {
  // Not a <urlset> document: an error page, a login wall, a soft-200 "gone" page.
  if (!SITEMAP_START.test(payload)) return null;
  // Ids seen so far, so a repeated loc is read once.
  const ids: string[] = [];
  // Each loc in turn.
  for (const match of payload.matchAll(LOC)) {
    // Entities like &amp; would otherwise make an ordinary URL unparseable.
    const raw = decodeEntities(match[1] ?? "") ?? "";
    // Parsed, so the host comparison is exact rather than a prefix test.
    let url: URL;
    // A loc that is not a URL is skipped.
    try {
      // The URL parser lower-cases the host.
      url = new URL(raw);
    } catch {
      // Not followable.
      continue;
    }
    // Another host (or http) is never followed: the scout reads only this tenant.
    if (url.origin !== origin) continue;
    // Only job pages; /jobs/intro and the like are not postings.
    const id = JOB_PATH.exec(url.pathname)?.[1];
    // Not a job path.
    if (id === undefined) continue;
    // Each id once.
    if (!ids.includes(id)) ids.push(id);
  }
  // Possibly empty: a tenant with no openings lists only its intro page.
  return ids;
}

// The first JSON-LD JobPosting in a detail page, or null when there is none or none parses.
function readJobPosting(html: string): Record<string, unknown> | null {
  // Each JSON-LD block in turn; pages usually carry exactly one.
  for (const match of html.matchAll(JSON_LD)) {
    // Parsed defensively: a malformed block is skipped, not fatal.
    let value: unknown;
    // JSON.parse throws on malformed input.
    try {
      // The script's text.
      value = JSON.parse(match[1] ?? "");
    } catch {
      // Try the next block.
      continue;
    }
    // A block may be one object or an array of them.
    const candidates = Array.isArray(value) ? value : [value];
    // The first object typed JobPosting wins.
    for (const candidate of candidates) {
      // The shape this adapter reads.
      if (isRecord(candidate) && candidate["@type"] === "JobPosting") return candidate;
    }
  }
  // No usable JobPosting on this page.
  return null;
}

// One JSON-LD address field, or null when it is absent, blank or iCIMS's placeholder.
function addressPart(address: Record<string, unknown>, key: string): string | null {
  // The shared reader trims and nulls blanks.
  const value = readString(address, key);
  // The placeholder is not a value.
  return value === null || value.toUpperCase() === PLACEHOLDER ? null : value;
}

// A country as prose: an ISO alpha-2 code spelled out, anything else kept as written.
function countryName(value: string | null): string | null {
  // No country.
  if (value === null) return null;
  // A two-letter code, the shape iCIMS writes.
  if (/^[A-Za-z]{2}$/.test(value)) {
    // ICU returns the code itself when it has no name for it; keep that as-is.
    return REGION_NAMES.of(value.toUpperCase()) ?? value;
  }
  // Already prose.
  return value;
}

// The posting's location prose from JSON-LD jobLocation: "City, Region, Country" per place,
// places joined by "; " (the work-auth gate's part separator). Null when no place has a value.
function readLocation(jobLocation: unknown): string | null {
  // One Place or an array of them.
  const places = Array.isArray(jobLocation) ? jobLocation : [jobLocation];
  // Each place's prose, each once.
  const parts: string[] = [];
  // Place by place.
  for (const place of places) {
    // A place without an address object says nothing.
    const address = isRecord(place) && isRecord(place["address"]) ? place["address"] : null;
    // Next place.
    if (address === null) continue;
    // City first, as every board writes it.
    const locality = addressPart(address, "addressLocality");
    // The region, unless it only repeats the city or is a bare numeric code (Singapore jobs carry
    // "01", seen in the live dry run 2026-11-21): a code is not location prose the gate can read.
    const rawRegion = addressPart(address, "addressRegion");
    // Digits only means a code.
    const region = rawRegion !== null && /^[0-9]+$/.test(rawRegion) ? null : rawRegion;
    // The country, spelled out.
    const country = countryName(addressPart(address, "addressCountry"));
    // The street address is deliberately left out: it is not location prose the gate reads.
    const text = [locality, region !== locality ? region : null, country].filter((p): p is string => p !== null).join(", ");
    // Kept once, in order.
    if (text !== "" && !parts.includes(text)) parts.push(text);
  }
  // Nothing usable in any place.
  return parts.length === 0 ? null : parts.join("; ");
}

// The adapter.
export const icimsAdapter: AtsAdapter = {
  // Applying through iCIMS is not automated; the provider names the board for routing.
  provider: "icims",
  // The company's own careers site, the same source Workday tenants record.
  discoverySource: "company_career_page",
  // Pages are a sitemap and HTML, not JSON: both transports hand `parse` the raw text.
  payloadFormat: "text",
  // One page per job (see ICIMS_MAX_PAGES).
  maxPages: ICIMS_MAX_PAGES,

  // Page one: the tenant's sitemap. Throws on a malformed token, as Workday does; both scouts'
  // catch blocks record that as a failed board, the right outcome for a bad watchlist row.
  buildRequestUrl(boardToken: string): string {
    // The closed token shape.
    const board = parseIcimsToken(boardToken);
    // A token this adapter cannot read never becomes a request.
    if (board === null) throw new Error(`malformed icims board token: ${JSON.stringify(boardToken)}`);
    // The sitemap URL robots.txt itself publishes.
    return `${board.origin}/sitemap.xml`;
  },

  // One page: the sitemap (no postings) or one detail page (one posting, or one counted skip).
  parse(payload: unknown, boardToken?: string): AtsParseResult {
    // Without the token no URL can be held to the tenant; the contract says fail.
    const board = boardToken === undefined ? null : parseIcimsToken(boardToken);
    // Refused before anything is read.
    if (board === null) return { ok: false, reason: "iCIMS parse needs a valid board token (tenant subdomain)" };
    // A decoded object means the transport ignored payloadFormat: fail loudly, never guess.
    if (typeof payload !== "string") return { ok: false, reason: "iCIMS page was not text (transport decoded it as JSON?)" };
    // The sitemap carries ids only; nextPageUrl reads them. Nothing to post from it.
    if (SITEMAP_START.test(payload)) return { ok: true, postings: [], skipped: [] };
    // Otherwise this is a detail page. Its JobPosting, or a counted skip (condition 2:
    // never a job with a blank title or location).
    const job = readJobPosting(payload);
    // No JSON-LD, malformed JSON-LD, or no JobPosting in it.
    if (job === null) return { ok: true, postings: [], skipped: ["detail page had no JSON-LD JobPosting"] };
    // The title, trimmed; blank is absent.
    const title = readString(job, "title");
    // The canonical page, which is both the submit target and the only source of the id.
    const canonical = readString(job, "url");
    // Parsed for the exact host and path checks below.
    let url: URL | null = null;
    // A malformed URL stays null.
    try {
      // Absent stays null.
      url = canonical === null ? null : new URL(canonical);
    } catch {
      // Unparseable.
      url = null;
    }
    // The id, only from a job path on this tenant's own origin.
    const atsJobId = url !== null && url.origin === board.origin ? (JOB_PATH.exec(url.pathname)?.[1] ?? null) : null;
    // No title: nothing to screen or fingerprint.
    if (title === null) return { ok: true, postings: [], skipped: [`posting ${atsJobId ?? "?"} had no title`] };
    // No trustworthy id or submit target on this tenant.
    if (url === null || atsJobId === null) return { ok: true, postings: [], skipped: [`posting ${JSON.stringify(title)} had no ${board.origin} job url`] };
    // TELECOMMUTE is schema.org's structured remote flag.
    const remote = job["jobLocationType"] === "TELECOMMUTE";
    // Address prose, or "Remote" when remote is the only location fact.
    const locationRaw = readLocation(job["jobLocation"]) ?? (remote ? "Remote" : null);
    // No location at all: the work-auth gate must never see a blank where a place should be.
    if (locationRaw === null) return { ok: true, postings: [], skipped: [`posting ${atsJobId} had no location`] };
    // FULL_TIME → "full time", the form the shared classifier reads; "OTHER" stays unknown.
    const typeText = readString(job, "employmentType")?.replace(/_/g, " ") ?? null;
    // The posting, in the shared contract's shape.
    const posting: ParsedPosting = {
      // The tenant's job id, stable while the posting lives.
      atsJobId,
      // The title as posted.
      title,
      // Prose built from the structured address, placeholders dropped.
      locationRaw,
      // HTML stripped to text; absent stays absent.
      descriptionRaw: stripHtml(readString(job, "description")),
      // The canonical page, validated above as this tenant's job path.
      applyUrl: url.toString(),
      // The board's own type when it names one, else whatever the title says.
      employmentType: classifyEmploymentType(typeText) === "unknown" ? classifyEmploymentType(title) : classifyEmploymentType(typeText),
      // The structured flag wins; the location prose is the fallback.
      workArrangement: classifyWorkArrangement(locationRaw, remote),
      // datePosted is a genuine ISO publish date. The remote_feed variant is reused because it
      // is exactly the strict ISO-shape reader this needs; a dedicated "icims" variant would need
      // a posted-at.ts change outside this parcel (flagged in docs/handoff/2026-11-21-peer-1-r2.md).
      postedAtInput: { source: "remote_feed", published: job["datePosted"] },
      // The JobPosting as served, for replaying a parser fix over history.
      rawPayload: job,
    };
    // One posting from this page.
    return { ok: true, postings: [posting], skipped: [] };
  },

  // The sitemap names no company and iCIMS JSON-LD sits on later pages; declared inapplicable.
  // The tenant subdomain in the token already names the company (careers-apac-atlassian).
  readReportedIdentity(_payload: unknown): string | null {
    // Declared "no identity field", the same answer lever and ashby give.
    return null;
  },

  // The next page: from the sitemap, the first job; from a detail page, the next id in the
  // fragment. An unreadable cursor returns `currentUrl` (the loop fails a stalled cursor);
  // null only when the board has genuinely been read in full.
  nextPageUrl(boardToken: string, payload: unknown, currentUrl: string): string | null {
    // The tenant; an invalid token cannot advance.
    const board = parseIcimsToken(boardToken);
    // Parsed for exact comparisons; garbage stalls.
    let url: URL;
    // The URL parser throws on garbage.
    try {
      // The page just fetched.
      url = new URL(currentUrl);
    } catch {
      // Stall.
      return currentUrl;
    }
    // Wrong tenant, or no tenant: stall rather than follow.
    if (board === null || url.origin !== board.origin) return currentUrl;
    // From the sitemap: its job ids become the cursor.
    if (url.pathname === "/sitemap.xml") {
      // A non-text or non-sitemap page here must fail the board, not read as empty (§6).
      const ids = typeof payload === "string" ? readSitemapJobIds(payload, board.origin) : null;
      // Not a sitemap: stall.
      if (ids === null) return currentUrl;
      // A real sitemap with no jobs: the board is empty, and read in full.
      if (ids.length === 0) return null;
      // The first job, the rest in the fragment.
      return detailUrl(board.origin, ids[0]!, ids.slice(1));
    }
    // From a detail page: it must be a path this adapter built.
    if (!DETAIL_PATH.test(url.pathname)) return currentUrl;
    // And its fragment must be the cursor shape.
    const rest = REST_FRAGMENT.exec(url.hash);
    // No or garbled cursor: stall.
    if (rest === null) return currentUrl;
    // The remaining ids; an empty group means this was the last job.
    const ids = (rest[1] ?? "").split(",").filter((id) => ID_SHAPE.test(id));
    // Read in full.
    if (ids.length === 0) return null;
    // The next job, the rest after it.
    return detailUrl(board.origin, ids[0]!, ids.slice(1));
  },
};
