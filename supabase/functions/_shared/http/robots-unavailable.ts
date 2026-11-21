// ROBOTS "UNKNOWN, RETRY LATER", shared by both scouts (D5 drift #1, 2026-11-21).
//
// On 11-18 07:35Z Workday's Cloudflare answered robots.txt with 429 (no Retry-After) and 62 of 64
// Workday boards reached consecutive_failures >= 5 while their policy was never actually read.
// A 429 or 5xx on robots.txt means the policy is UNKNOWN: the board is still never fetched (robots
// is honoured), but the scout skips it this run WITHOUT counting a failure. The worker did this
// first (eb56d28e, worker/src/scout/board-pages.ts, Teja's design 11-18 22:27 IST); this module is
// the same semantics in _shared, so the edge scout (scout-ats, via transport.ts) uses it too.
// D5 follow-up: board-pages.ts still declares its own copy; it should import this one instead.
//
// Node- and Deno-safe: one relative import, no runtime globals.

// The parent refusal type every robots-gated caller already handles.
import { RobotsDisallowedError } from "./errors.ts";

// A robots refusal whose cause is "the host did not answer the question", not "no".
// It EXTENDS RobotsDisallowedError on purpose: a caller that only knows the parent type still
// treats it as a refusal (fails closed, CLAUDE.md §6), so the new type can make a caller more
// lenient only where that caller opts in by checking for it.
export class RobotsUnavailableError extends RobotsDisallowedError {
  // The robots.txt HTTP status (429 or 5xx), or null for a 'wait' verdict (a short readable
  // Retry-After), whose status is 429 by construction. Kept for the scout's skip line.
  readonly status: number | null;

  constructor(url: string, verdict: "refuse" | "wait", reason: string, source: string | null, status: number | null) {
    // The parent writes the "robots.txt gate refused <url>: <reason>" message logs grep for.
    super(url, verdict, reason, source);
    // Its own name, so a log line or a stack says which kind of refusal this was.
    this.name = "RobotsUnavailableError";
    // The status behind it.
    this.status = status;
  }
}

// The robots.txt statuses that mean "the host did not answer" rather than "no": 429 = rate
// limited, 5xx = the server failed. 401/403/404 are answers and are NOT here.
export function isUnknownRobotsStatus(status: number): boolean {
  // Rate limited, or any server error.
  return status === 429 || (status >= 500 && status <= 599);
}
