// The CLI scout's board transport: every page of a board, through plain HTTP.
//
// WHY A SEPARATE MODULE: worker/src/cli/scout.ts runs main() on import, so no test can
// load it. Reading only page one is the regression worth pinning (a SmartRecruiters
// board pages at 100: Nagarro stored 100 of 585 postings before this), so the transport
// lives here and scout.ts only calls it.
//
// The page loop itself is the shared `collectBoardPages` (scout-ats uses the same one),
// so the two scouts agree on what a complete board is: all pages, or a failure — never
// a truncated board stored as if it were whole.

// The shared page loop, and its all-or-nothing result type.
import { collectBoardPages, type BoardPagesResult } from '../../../supabase/functions/_shared/ats/registry.ts';
// Types only: the adapter contract the loop drives.
import type { AtsAdapter } from '../../../supabase/functions/_shared/ats/types.ts';
// The robots gate, by RELATIVE path like apply-one.ts imports it: a bare
// '@applyy/master-robots' specifier would need a package.json entry and a lockfile write.
import { checkRobots, tokenFromUserAgentHeader, type RobotsCache } from '../../../packages/master-robots/src/index.ts';
// The typed refusal scout-ats's transport throws for the same verdict, so both scouts
// fail a refused board with one error shape. errors.ts has no imports: Node-safe.
import { RobotsDisallowedError } from '../../../supabase/functions/_shared/http/errors.ts';

// Sent on every page, unchanged from the single-fetch code it replaces, so a board
// operator sees one consistent, contactable client.
const REQUEST_HEADERS = {
  // JSON boards (every adapter but iCIMS). A text board swaps this one header (TEXT_ACCEPT below).
  'Accept': 'application/json',
  // Identifies the scout and links the repo, as polite crawlers do.
  'User-Agent': 'applyy-scout/1.0 (+https://github.com/MallamTeja/applyyy)',
};

// What a text board (iCIMS: sitemap.xml, then HTML detail pages, 2026-11-21) is asked for in
// place of JSON. Only this header differs, so the operator still sees the same client.
const TEXT_ACCEPT = 'text/html, application/xml;q=0.9, */*;q=0.8';

// The RFC 9309 product token robots groups are matched against ("applyy-scout"), derived
// from the header we actually send so the two can never drift. Same token scout-ats uses.
const SCOUT_ROBOTS_TOKEN = tokenFromUserAgentHeader(REQUEST_HEADERS['User-Agent']);

// One verdict cache for the process. The CLI scout is one process per run, so this IS
// the per-run cache: each origin's robots.txt is fetched once, not once per board/page.
const RUN_ROBOTS_CACHE: RobotsCache = new Map();

// ROBOTS "UNKNOWN, RETRY LATER" (2026-11-18, D1; Teja's design 22:27 IST). On 11-18 07:35Z,
// 43 Workday boards were refused because robots.txt answered 429 (Cloudflare, no Retry-After).
// Each refusal went through failureMark, so 62 of 64 Workday boards reached consecutive_failures
// >= 5 while their policy was never actually read. A 429 or 5xx on robots.txt means the policy is
// UNKNOWN. The board is still never fetched (robots is honoured), but scout.ts skips it this run
// without counting a failure. It EXTENDS RobotsDisallowedError on purpose: a caller that only
// knows the parent type (workday-detail's fill, any future reader) still treats it as a refusal,
// so the new type can make a caller more lenient only where it opts in (CLAUDE.md §6).
// D5 (2026-11-21): the class and its status test now live in _shared so scout-ats's transport
// throws the SAME class; this file re-exports it, so scout.ts's `instanceof` and the tests'
// imports from here are unchanged. (isUnknownRobotsStatus: 429 = rate limited, 5xx = server
// failed; a 401/403/404 is an answer and is NOT unknown.)
import { RobotsUnavailableError, isUnknownRobotsStatus } from '../../../supabase/functions/_shared/http/robots-unavailable.ts';
// Re-exported for scout.ts and the tests, which import it from this module.
export { RobotsUnavailableError };

// The per-request timeout for every board page and detail read: the edge transport's own constant
// (15 s), imported so the two scouts cannot drift (D5 drift #3, 2026-11-21). Without it one hung
// socket stalled the CLI run to its 12-minute budget. A timeout THROWS, so scout.ts counts it.
import { DEFAULT_TIMEOUT_MS as BOARD_PAGE_TIMEOUT_MS } from '../../../supabase/functions/_shared/http/transport.ts';
// Exported for the test that pins it to the edge's value.
export { BOARD_PAGE_TIMEOUT_MS };

// The last robots.txt HTTP status seen per origin, per verdict cache. master-robots folds a
// 429 and a timeout into the same 'indeterminate' source and keeps only a human reason string,
// so the status is recorded here, from the real response, instead of parsed back out of that
// text (CLAUDE.md §6: check the shape, never ask a message what happened). Keyed by the cache
// object so it lives exactly as long as the cache it describes: a cache hit (no new fetch)
// still finds the status of the fetch that filled the cache. WeakMap: a test's throwaway cache
// takes its statuses with it.
const ROBOTS_STATUS_BY_CACHE = new WeakMap<RobotsCache, Map<string, number>>();

// The status map for one verdict cache, created on first use.
function robotsStatusesFor(cache: RobotsCache): Map<string, number> {
  // The existing map, when this cache has been used before.
  const existing = ROBOTS_STATUS_BY_CACHE.get(cache);
  // Reused, so every board in a run shares one record.
  if (existing !== undefined) return existing;
  // A fresh map for a fresh cache.
  const created = new Map<string, number>();
  // Remembered against the cache.
  ROBOTS_STATUS_BY_CACHE.set(cache, created);
  // Handed back.
  return created;
}

// PACING (2026-11-18 D1 design point 3; iCIMS lane 2026-11-21). The worker's own lane code lived here:
// it answered "how long must this request wait so a Cloudflare zone (all *.myworkdayjobs.com, all
// *.icims.com) sees at most one request per second from us?". D5 (2026-11-21): that question is now
// answered ONCE, in _shared/http/request-pacer.ts (same zones, same 1 s gap, slot reservation so even
// concurrent callers cannot pass together), which scout-ats uses too. The two scouts can no longer drift.
import { createRequestPacer, PACED_REQUEST_GAP_MS, type RequestPacer } from '../../../supabase/functions/_shared/http/request-pacer.ts';

// The run's pacer, module-global like RUN_ROBOTS_CACHE: one scout process = one run.
const RUN_PACER: RequestPacer = createRequestPacer(PACED_REQUEST_GAP_MS);

// Read every page of one board. `fetchImpl` and `robotsCache` are injected only so tests
// can serve pages and robots.txt without a network and without sharing verdicts;
// production passes neither and gets the global fetch and the run's cache.
export function readBoardPages(
  // The board's adapter: builds page one's URL, parses each page, names the next one.
  adapter: AtsAdapter,
  // The watchlist row's board token.
  boardToken: string,
  // The HTTP seam, defaulting to the real network.
  fetchImpl: typeof fetch = fetch,
  // The robots verdict cache, defaulting to the one this run shares.
  robotsCache: RobotsCache = RUN_ROBOTS_CACHE,
  // The request pacer, defaulting to the run's (Workday zone gap; other hosts undelayed).
  pacer: RequestPacer = RUN_PACER,
): Promise<BoardPagesResult> {
  // The shared loop owns pagination, the cursor-stall check and the page cap.
  // `format` is the adapter's payloadFormat as collectBoardPages resolves it ("json" when undeclared).
  return collectBoardPages(adapter, boardToken, async (pageUrl, body, format) => {
    // The shared robots gate (gateRobots below): a throw unless robots.txt allows this page.
    await gateRobots(pageUrl, fetchImpl, robotsCache, pacer);
    // The page itself waits its turn in the pacing lane too (Broadridge's PAGE got a 429 on 11-18).
    await pacer.before(pageUrl);
    // One request per page, same headers as page one. A body (Workday, 2026-11-01)
    // makes it a JSON POST, because Workday's list endpoint answers GET with 400; no
    // body keeps the exact GET every other board has always had. scout-ats's
    // poll-fetch.ts applies the same rule, so the two scouts request pages alike.
    // A text board asks for HTML/XML; a JSON board keeps the exact headers it always sent.
    const headers = format === 'text' ? { ...REQUEST_HEADERS, 'Accept': TEXT_ACCEPT } : REQUEST_HEADERS;
    const init: RequestInit =
      // No body: the exact pre-Workday GET init, byte for byte (for a JSON board).
      body === undefined
        // Plus the page timeout, so a hung socket fails this board instead of the whole run.
        ? { headers, signal: AbortSignal.timeout(BOARD_PAGE_TIMEOUT_MS) }
        // A body: POST it, declared as JSON beside the usual identity headers, with the same timeout.
        : { method: 'POST', headers: { ...REQUEST_HEADERS, 'Content-Type': 'application/json' }, body, signal: AbortSignal.timeout(BOARD_PAGE_TIMEOUT_MS) };
    // The page; a URL fragment (Workday's cursor) is never sent by fetch.
    const res = await fetchImpl(pageUrl, init);
    // A non-ok page THROWS rather than returning its body: an error page fed to the
    // parser could parse as an empty board (CLAUDE.md §6). scout.ts's catch records it.
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} on ${pageUrl}`);
    // The raw body for a text board (iCIMS). Only an explicit "text" gets it: a JSON board whose
    // page is an HTML error still fails in res.json() below, never reaches its parser as text (§6).
    if (format === 'text') return await res.text();
    // Decoded JSON for the adapter's pure parser.
    return await res.json();
  });
}

// THE ROBOTS GATE, shared by every request this scout makes to a board's origin: the board
// pages above and the Workday detail read below. Resolves only on an explicit allow.
async function gateRobots(
  // The exact URL about to be requested.
  url: string,
  // The HTTP seam, also used for the robots.txt GET.
  fetchImpl: typeof fetch,
  // The verdict cache.
  robotsCache: RobotsCache,
  // The pacer the robots.txt GET waits on, like any other request to the origin.
  pacer: RequestPacer,
): Promise<void> {
  // THE ROBOTS GATE, before every board-page request and every detail read (Teja, 2026-11-01: "Honor robots").
  // Per page, not per board, because robots rules match path AND query, and a later
  // page's URL can differ; the cache keeps it to one robots.txt GET per origin.
  // Method is irrelevant (Workday POSTs): robots governs the path either way.
  // A null token FAILS CLOSED (CLAUDE.md §6), mirroring transport.ts: guessing one
  // would silently select the "*" group.
  if (SCOUT_ROBOTS_TOKEN === null) {
    throw new RobotsDisallowedError(url, 'refuse', 'cannot derive a robots product token from the scout User-Agent', null);
  }
  // 'scouting' is the board-read policy scout-ats also passes: a 401 robots.txt counts as
  // no rules (Ashby), while 403 and a published Disallow (SmartRecruiters) still refuse.
  // The robots.txt GET goes through the same fetch seam, so tests script it.
  // The per-origin status record for this cache (see ROBOTS_STATUS_BY_CACHE).
  const statuses = robotsStatusesFor(robotsCache);
  // The origin robots.txt lives at; the key master-robots' cache uses too.
  const origin = new URL(url).origin;
  // The robots.txt GET, paced, with its HTTP status recorded. Only robots.txt ever goes
  // through this fetcher (master-robots calls it for nothing else).
  const fetcher = async (robotsUrl: string, init: { signal: AbortSignal; headers: Record<string, string> }) => {
    // Forget the previous status first, so a fetch that THROWS leaves no stale 429 behind.
    statuses.delete(origin);
    // Wait for the lane like every other request to this origin.
    await pacer.before(robotsUrl);
    // The real request through the injected seam, with the scout's ONE identity: the full contact UA
    // every page sends, not master-robots' bare token (the 2-UA finding, 2026-11-21 egress probe).
    // Group matching is unaffected: it reads SCOUT_ROBOTS_TOKEN, derived from this same header.
    // Never a browser-like UA: that would be evasion (Teja's 11-01 "Honor robots" ruling).
    const response = await fetchImpl(robotsUrl, { ...init, headers: { ...init.headers, 'user-agent': REQUEST_HEADERS['User-Agent'] } });
    // Recorded from the response itself, not from master-robots' reason text.
    statuses.set(origin, response.status);
    // Unchanged, for master-robots to classify.
    return response;
  };
  // The verdict; served from the cache when this origin was read earlier this run.
  const verdict = await checkRobots(url, SCOUT_ROBOTS_TOKEN, { cache: robotsCache, fetcher, policy: 'scouting' });
  // A 'wait' is a 429 with a short, readable Retry-After: unknown for now, retry later. Honoured
  // by not contacting the origin again while the cache holds it (master-robots' failure TTL).
  if (verdict.kind === 'wait') {
    // The skip type: refused, not counted.
    throw new RobotsUnavailableError(url, 'wait', verdict.reason, null, null);
  }
  // The status behind an 'indeterminate' refusal, when the robots.txt GET returned one.
  const robotsStatus = statuses.get(origin);
  // A 429 (no or over-long Retry-After) or a 5xx: the policy is unknown, so skip, don't count.
  // A thrown fetch (timeout, DNS) has no status and stays a counted failure below.
  if (verdict.kind === 'refuse' && verdict.source === 'indeterminate' && robotsStatus !== undefined && isUnknownRobotsStatus(robotsStatus)) {
    // Refused all the same: robots is never treated as "allowed" on an unknown answer.
    // The skip type carries the status, so the scout's skip line names 429 vs 5xx.
    throw new RobotsUnavailableError(url, 'refuse', verdict.reason, verdict.source, robotsStatus);
  }
  // Anything else but an explicit allow refuses, exactly as transport.ts does. A THROW, so
  // scout.ts's catch records the board with failureMark like any failed poll: a refused
  // board must never read as "0 jobs found" (CLAUDE.md §6).
  if (verdict.kind !== 'allow') {
    throw new RobotsDisallowedError(url, verdict.kind, verdict.reason, verdict.kind === 'refuse' ? verdict.source : null);
  }
}

// One robots-gated GET, for the Workday detail read (2026-11-05, workday-detail.ts). Same gate,
// headers and policy as a board page, but the raw Response comes back: the fill reads the text
// itself and refuses a non-ok or non-JSON answer as "no description", where a board page throws.
// A robots refusal still THROWS (RobotsDisallowedError), which the fill also counts as no text.
export async function robotsGatedGet(
  // The detail URL.
  url: string,
  // The HTTP seam, defaulting to the real network.
  fetchImpl: typeof fetch = fetch,
  // The robots verdict cache, defaulting to the one this run shares.
  robotsCache: RobotsCache = RUN_ROBOTS_CACHE,
  // The request pacer, defaulting to the run's.
  pacer: RequestPacer = RUN_PACER,
): Promise<Response> {
  // Refused before the target origin is contacted.
  await gateRobots(url, fetchImpl, robotsCache, pacer);
  // The detail read waits its turn in the Workday lane too.
  await pacer.before(url);
  // The plain GET every board page without a body gets.
  // 15 s, the transport's per-attempt timeout scout-ats gets from httpFetch: without it a hung
  // socket could run past the scout's deadline, which WORKDAY_DETAIL_MIN_REMAINING_MS assumes cannot happen.
  return await fetchImpl(url, { headers: REQUEST_HEADERS, signal: AbortSignal.timeout(BOARD_PAGE_TIMEOUT_MS) });
}
