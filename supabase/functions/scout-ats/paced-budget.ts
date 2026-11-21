// THE SCAN'S PACED-BOARD BUDGET (drift #2, 2026-11-21).
//
// WHY IT EXISTS: the shared transport now waits 1 s between two requests in the Workday zone and in the iCIMS zone
// (_shared/http/request-pacer.ts, the worker's rule). A Scan reads up to 50 boards inside a 150 s wall clock
// (SCOUT_ATS_BUDGET_MS = 100 s of it is the handler's own deadline), and today's edge Scans already take 76-97 s. A
// Workday board can be 20 pages and an iCIMS board 60, so paced boards could push a Scan past the wall clock. This
// guard refuses to START a paced board whose paced requests cannot finish before the deadline's reserve: the board is
// reported "skipped" and left unpolled (last_polled_at untouched), so the oldest-first board order puts it first in the
// next Scan. Never a silent drop.
//
// The estimate is the worst the board can need: pages from its last posting count (the count of a never-polled board
// is unknown, so the cap), plus its robots.txt GET. Unpaced providers cost 0 and are never skipped here, so a
// Greenhouse/Lever/Ashby Scan behaves exactly as before.
//
// PURE: node --test runs it (index.ts runs Deno.serve on import).

// The gap each paced request waits, the same constant the transport uses.
import { PACED_REQUEST_GAP_MS } from "../_shared/http/request-pacer.ts";

// Postings per page for each PACED provider. Workday's list endpoint answers 20 per page (adapters/workday.ts:49,
// "limit 50 answers 400"); iCIMS reads one detail page per job after its sitemap (adapters/icims.ts:12). A provider
// absent here is unpaced.
const POSTINGS_PER_PAGE: Readonly<Record<string, number>> = { workday: 20, icims: 1 };

// What a started paced board must leave after its own requests: the feed pass and the run close (the scan's
// FEED_PROBE_MIN_REMAINING_MS, 15 s), so finishing one board can never starve the run's last writes.
export const PACED_BOARD_RESERVE_MS = 15_000;

// The most paced requests one board read can make: its pages plus one robots.txt GET; 0 for an unpaced provider.
export function pacedRequestEstimate(provider: string, lastJobCount: number | null, maxPages: number): number {
  // Postings per page, or undefined for an unpaced provider.
  const perPage = POSTINGS_PER_PAGE[provider];
  // Unpaced: no gap is ever waited.
  if (perPage === undefined) return 0;
  // Pages the last count needs. A null (never polled) or malformed count is unknown, so the worst case: the cap.
  // iCIMS adds its sitemap page (perPage 1 = one page per job, after the listing).
  const pages = lastJobCount === null || !Number.isInteger(lastJobCount) || lastJobCount < 0
    ? maxPages
    : perPage === 1 ? lastJobCount + 1 : Math.max(1, Math.ceil(lastJobCount / perPage));
  // Capped at what one read may take, plus the robots.txt GET.
  return Math.min(pages, maxPages) + 1;
}

// Skip verdict for one board: null when it may start, else what it needs and what is left (for the summary line).
export function pacedBoardSkip(provider: string, lastJobCount: number | null, maxPages: number, remainingMs: number): { readonly needMs: number; readonly remainingMs: number } | null {
  // The paced requests this board may make.
  const requests = pacedRequestEstimate(provider, lastJobCount, maxPages);
  // Unpaced: never this guard's call.
  if (requests === 0) return null;
  // Each request's gap, plus the run's reserve.
  const needMs = requests * PACED_REQUEST_GAP_MS + PACED_BOARD_RESERVE_MS;
  // Fits: start it.
  if (remainingMs >= needMs) return null;
  // Does not fit: skipped, resumes next Scan.
  return { needMs, remainingMs };
}
