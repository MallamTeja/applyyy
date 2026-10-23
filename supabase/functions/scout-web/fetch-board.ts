// Scout-Web — the production board fetch, extracted from index.ts.
//
// WHY ITS OWN FILE: index.ts calls Deno.serve at import time, so it cannot be imported
// by `node --test`. This seam is where the robots gating decision lives, and that
// decision needs a named end-to-end test (fetch-board.test.ts), so it lives here.
//
// SINGLE CONTROL (CLAUDE.md §6). This function used to run its own checkRobots call
// before every fetch. Since 111791c the shared transport (_shared/http/transport.ts
// httpFetch) runs the master-robots gate itself, ON by default, and throws
// RobotsDisallowedError before the target is ever contacted. The question the deleted
// pre-check answered — "may applyy-scout fetch this board URL?" — is now answered by
// the transport, from the SAME verdict source (master-robots checkRobots), with the
// SAME product token ("applyy-scout", derived from DEFAULT_USER_AGENT by
// tokenFromUserAgentHeader) and the SAME fail-closed semantics (anything but an
// explicit 'allow' refuses, 'wait' included). The pre-check also passed NO cache,
// which master-robots documents as "disables caching entirely" — so it refetched
// robots.txt once per board per run on top of the transport's own gated check. The one
// thing it carried that the transport does not is the UI-visible `robots_<kind>`
// reason prefix, preserved below by branching on the TYPED error (instanceof, never
// message matching — errors.ts explains why).

// The adapter owns each board's API URL, so no URL is ever built from model output.
import { getAdapter } from "../_shared/ats/registry.ts";
// The robots-gated retrying transport, and the typed refusal it throws pre-contact.
import { httpJson, RobotsDisallowedError } from "../_shared/http/index.ts";
// The verdict-cache type, injected so tests stay isolated from each other.
import type { RobotsCache } from "../../../packages/master-robots/src/index.ts";
// The seam signature core.ts expects this function to satisfy.
import type { FetchBoardFn } from "./core.ts";

// Build the production FetchBoardFn.
//
// WHY A FACTORY: the robots verdict cache must be injectable (each test holds its own
// Map, or verdicts for one origin would leak between tests), and index.ts calls this
// once at module scope so one cache serves the whole isolate — each origin's robots.txt
// is asked once per TTL (1h good / 5min failure), not once per board URL.
export function makeFetchBoard(robotsCache: RobotsCache = new Map()): FetchBoardFn {
  // The returned closure is the seam core.ts drives.
  return async (provider, token) => {
    // The adapter owns the board API URL; the token was charset-validated by urls.ts.
    const adapter = getAdapter(provider);
    // A missing adapter is a build mismatch; refuse rather than guess a URL.
    if (adapter === null) return { ok: false, reason: "no_adapter" };
    // The exact URL the transport will gate and request.
    const url = adapter.buildRequestUrl(token);
    // Every failure mode below becomes a reason string; the seam never throws.
    try {
      // The transport gates this call against robots.txt BEFORE contact (on by
      // default; the explicit cache is the per-isolate one). 'null' mode turns a 404
      // (dead board token) into null instead of a throw; two retries keep a
      // rate-limited host from eating the whole function's wall-clock budget.
      const payload = await httpJson<unknown>(url, { notFound: "null", retry: { maxRetries: 2 }, robots: { cache: robotsCache } });
      // A dead board means the model's URL cannot be real.
      if (payload === null) return { ok: false, reason: "board_not_found" };
      // Hand the raw payload to the adapter's own parser (in core.ts).
      return { ok: true, payload };
    } catch (err) {
      // The transport's robots refusal, kept distinguishable from network failures so
      // the UI's reason taxonomy (`robots_refuse` / `robots_wait`) survives the move
      // of the gate into the transport. Typed branch, never message matching.
      if (err instanceof RobotsDisallowedError) return { ok: false, reason: `robots_${err.verdict}: ${err.message}` };
      // Every other typed transport error (bot protection, retries exhausted, network)
      // becomes a reason string.
      return { ok: false, reason: `fetch_failed: ${err instanceof Error ? err.message : String(err)}` };
    }
  };
}
