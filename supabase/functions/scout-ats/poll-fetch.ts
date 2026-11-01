// The ATS poll's one outbound fetch, extracted so node --test can exercise the LIVE call
// shape (index.ts runs Deno.serve on import, unreachable by node — the gate.ts pattern).
// Routing through the shared transport IS the robots fix: 111791c put the robots.txt
// gate inside httpFetch, on by default, and this file retires scout-ats's last bare
// `fetch(` — the one path that stayed ungated.

// The gated transport; its robots check throws RobotsDisallowedError BEFORE the target
// origin is ever contacted.
import { httpFetch } from "../_shared/http/index.ts";
// The verdict-cache type, so a test can isolate itself from the transport's
// module-level per-isolate cache; production passes nothing and shares that default.
import type { RobotsCache } from "../../../packages/master-robots/src/index.ts";

/**
 * Fetch one board's posting list through the robots-gated shared transport.
 *
 * `body` (Workday, 2026-11-01) makes the request a JSON POST: Workday's list endpoint
 * answers GET with 400 and takes its page window only in a body. Without a body the
 * request is the exact GET every other board has always received. The same rule lives
 * in worker/src/scout/board-pages.ts, so the two scouts request pages identically.
 * Third, after the test-only `robotsCache`, so existing callers and tests are unchanged.
 */
export function fetchBoard(url: string, robotsCache?: RobotsCache, body?: string): Promise<Response | null> {
  // Options spelled once; the server and the named test share them by construction.
  return httpFetch(url, {
    // Boards serve JSON. The transport sends our User-Agent identity itself
    // (DEFAULT_USER_AGENT — the same literal this call site used to hard-code).
    // A POST also declares its JSON body; a GET keeps exactly its one header.
    headers: body === undefined ? { "Accept": "application/json" } : { "Accept": "application/json", "Content-Type": "application/json" },
    // POST only when there is a body; spread so a GET carries neither key.
    ...(body === undefined ? {} : { method: "POST", body }),
    // Single attempt, this loop's pre-transport behavior: a many-board poll cannot
    // afford the default 7-attempt backoff schedule inside one Edge function's wall
    // clock. A non-ok status THROWS (HttpError) rather than returning, so the caller's
    // failure bookkeeping lives in its catch.
    retry: { maxRetries: 0 },
    // `exactOptionalPropertyTypes`: spread the cache only when a test supplies one,
    // never pass an explicit undefined.
    ...(robotsCache === undefined ? {} : { robots: { cache: robotsCache } }),
  });
}
