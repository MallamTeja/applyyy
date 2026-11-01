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

// Sent on every page, unchanged from the single-fetch code it replaces, so a board
// operator sees one consistent, contactable client.
const REQUEST_HEADERS = {
  // Every adapter here parses JSON.
  'Accept': 'application/json',
  // Identifies the scout and links the repo, as polite crawlers do.
  'User-Agent': 'applyy-scout/1.0 (+https://github.com/MallamTeja/applyyy)',
};

// Read every page of one board. `fetchImpl` is injected only so tests can serve pages
// without a network; production passes nothing and gets the global fetch.
export function readBoardPages(
  // The board's adapter: builds page one's URL, parses each page, names the next one.
  adapter: AtsAdapter,
  // The watchlist row's board token.
  boardToken: string,
  // The HTTP seam, defaulting to the real network.
  fetchImpl: typeof fetch = fetch,
): Promise<BoardPagesResult> {
  // The shared loop owns pagination, the cursor-stall check and the page cap.
  return collectBoardPages(adapter, boardToken, async (pageUrl, body) => {
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
