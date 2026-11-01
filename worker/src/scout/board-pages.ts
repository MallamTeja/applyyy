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
  // Every adapter here parses JSON.
  'Accept': 'application/json',
  // Identifies the scout and links the repo, as polite crawlers do.
  'User-Agent': 'applyy-scout/1.0 (+https://github.com/MallamTeja/applyyy)',
};

// The RFC 9309 product token robots groups are matched against ("applyy-scout"), derived
// from the header we actually send so the two can never drift. Same token scout-ats uses.
const SCOUT_ROBOTS_TOKEN = tokenFromUserAgentHeader(REQUEST_HEADERS['User-Agent']);

// One verdict cache for the process. The CLI scout is one process per run, so this IS
// the per-run cache: each origin's robots.txt is fetched once, not once per board/page.
const RUN_ROBOTS_CACHE: RobotsCache = new Map();

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
): Promise<BoardPagesResult> {
  // The shared loop owns pagination, the cursor-stall check and the page cap.
  return collectBoardPages(adapter, boardToken, async (pageUrl, body) => {
    // THE ROBOTS GATE, before every page request (Teja, 2026-11-01: "Honor robots").
    // Per page, not per board, because robots rules match path AND query, and a later
    // page's URL can differ; the cache keeps it to one robots.txt GET per origin.
    // Method is irrelevant (Workday POSTs): robots governs the path either way.
    // A null token FAILS CLOSED (CLAUDE.md §6), mirroring transport.ts: guessing one
    // would silently select the "*" group.
    if (SCOUT_ROBOTS_TOKEN === null) {
      throw new RobotsDisallowedError(pageUrl, 'refuse', 'cannot derive a robots product token from the scout User-Agent', null);
    }
    // 'scouting' is the board-read policy scout-ats also passes: a 401 robots.txt counts as
    // no rules (Ashby), while 403 and a published Disallow (SmartRecruiters) still refuse.
    // The robots.txt GET goes through the same fetch seam, so tests script it.
    const verdict = await checkRobots(pageUrl, SCOUT_ROBOTS_TOKEN, { cache: robotsCache, fetcher: fetchImpl, policy: 'scouting' });
    // Anything but an explicit allow refuses, 'wait' included, exactly as transport.ts
    // does. A THROW, so scout.ts's catch records the board with failureMark like any
    // failed poll: a refused board must never read as "0 jobs found" (CLAUDE.md §6).
    if (verdict.kind !== 'allow') {
      throw new RobotsDisallowedError(pageUrl, verdict.kind, verdict.reason, verdict.kind === 'refuse' ? verdict.source : null);
    }
    // One request per page, same headers as page one. A body (Workday, 2026-11-01)
    // makes it a JSON POST, because Workday's list endpoint answers GET with 400; no
    // body keeps the exact GET every other board has always had. scout-ats's
    // poll-fetch.ts applies the same rule, so the two scouts request pages alike.
    const init: RequestInit =
      // No body: the exact pre-Workday GET init, byte for byte.
      body === undefined
        ? { headers: REQUEST_HEADERS }
        // A body: POST it, declared as JSON beside the usual identity headers.
        : { method: 'POST', headers: { ...REQUEST_HEADERS, 'Content-Type': 'application/json' }, body };
    // The page; a URL fragment (Workday's cursor) is never sent by fetch.
    const res = await fetchImpl(pageUrl, init);
    // A non-ok page THROWS rather than returning its body: an error page fed to the
    // parser could parse as an empty board (CLAUDE.md §6). scout.ts's catch records it.
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} on ${pageUrl}`);
    // Decoded JSON for the adapter's pure parser.
    return await res.json();
  });
}
