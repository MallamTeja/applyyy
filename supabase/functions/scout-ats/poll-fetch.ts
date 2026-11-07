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
// The robots gate itself, for page probes (the pinned hop does not go through httpFetch).
import { checkRobots, tokenFromUserAgentHeader } from "../../../packages/master-robots/src/index.ts";
// The identity robots groups are matched on, and the typed errors a probe throws.
import { DEFAULT_USER_AGENT, HttpError, RobotsDisallowedError } from "../_shared/http/index.ts";
// The SSRF guard a pasted link already goes through: every hop shape-, DNS- and address-checked.
import { fetchPublicPage } from "../job-link-intake/fetch-page.ts";
// The DNS-rebinding-safe GET: connects to the checked IP, not a fresh lookup.
import { fetchPinnedHop } from "../job-link-intake/pinned-get.ts";

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
    // The board-read robots policy (Teja, 2026-11-01): a 401 robots.txt is no rules
    // (api.ashbyhq.com), while 403 and a published Disallow still refuse. The worker
    // scout (worker/src/scout/board-pages.ts) passes the same policy, so both agree.
    // `exactOptionalPropertyTypes`: spread the cache only when a test supplies one,
    // never pass an explicit undefined; without one the transport's isolate cache applies.
    robots: { policy: "scouting", ...(robotsCache === undefined ? {} : { cache: robotsCache }) },
  });
}

// What fetchPage needs from the outside world, injectable so node --test can prove the SSRF guard
// without a socket. Production wires the real ones below.
export interface PageProbeDeps {
  // One GET to the CHECKED address, redirects handed back; null on 404 (pinned-get.ts contract).
  hop(url: string, address: string): Promise<Response | null>;
  // Every A and AAAA address of a host; empty when it has none.
  resolve(hostname: string): Promise<string[]>;
  // Whether robots.txt lets the scout read this URL ('scouting' policy, as fetchBoard).
  robotsAllows(url: string): Promise<boolean>;
}

// The robots verdicts for page probes, kept for the isolate's life like the transport's own cache.
const pageRobotsCache: RobotsCache = new Map();

// NXDOMAIN / NODATA for one address family is normal (an IPv4-only host has no AAAA); any other
// resolver failure is rethrown, so fetchPublicPage refuses rather than checking half an answer.
function noRecords(err: unknown): string[] {
  // The one "no addresses" answer.
  if (err instanceof Deno.errors.NotFound) return [];
  // Anything else: refuse.
  throw err;
}

// The real dependencies. Deno is touched only inside the functions, so node can import this file.
const PRODUCTION_PAGE_DEPS: PageProbeDeps = {
  // DNS-rebinding safe (audit W17): TCP to the address the guard just checked, TLS verified against
  // the real name. 8 s: a slow page is "unknown" anyway, inside the scout's 100 s budget.
  hop: (url, address) => fetchPinnedHop(url, address, {
    // TCP to the checked IP; the certificate is checked against serverName.
    openTls: async (ip, serverName) => await Deno.startTls(await Deno.connect({ hostname: ip, port: 443 }), { hostname: serverName }),
  }, 8_000),
  // A and AAAA separately: a host with only one family answers NotFound for the other.
  resolve: async (host) => [
    // IPv4, or none.
    ...(await Deno.resolveDns(host, "A").catch(noRecords)),
    // IPv6, or none.
    ...(await Deno.resolveDns(host, "AAAA").catch(noRecords)),
  ],
  // The same gate httpFetch runs, called directly because the pinned hop bypasses httpFetch.
  robotsAllows: async (url) => {
    // The product token the robots groups are matched on; null fails closed, as in the transport.
    const token = tokenFromUserAgentHeader(DEFAULT_USER_AGENT);
    // No token: refuse rather than match as "*".
    if (token === null) return false;
    // Only an explicit allow; 'refuse' and 'wait' both stop the probe.
    // ponytail: the robots.txt read itself is a plain fetch to the host just checked public. Residual:
    // a rebinding answer between the check and that read gets one blind GET of /robots.txt.
    return (await checkRobots(url, token, { cache: pageRobotsCache, policy: "scouting" })).kind === "allow";
  },
};

/**
 * Fetch one posting PAGE for feed liveness (_shared/scout/feed-liveness.ts, 2026-11-07).
 *
 * SSRF GUARD (security review of 8f91837). The URL comes from a third-party feed, so it goes
 * through job-link-intake's fetchPublicPage: every hop, redirects included, is shape-checked,
 * DNS-resolved and refused if ANY address is private, loopback, link-local (169.254.169.254) or
 * otherwise non-public, and only then requested from the checked IP. A refused hop is null
 * ("unknown"), never "gone".
 *
 * Returns a 200 Response for a page that loaded, null for any refusal, and THROWS HttpError 404/410
 * for a gone page (typed, so checkPage reads a status field, never a reason string), or
 * RobotsDisallowedError when robots.txt says no.
 */
export async function fetchPage(url: string, deps: PageProbeDeps = PRODUCTION_PAGE_DEPS): Promise<Response | null> {
  // The guarded walk; it rethrows whatever a hop throws.
  const result = await fetchPublicPage(url, {
    // The real or the test resolver.
    resolve: deps.resolve,
    // One hop, robots first, then the pinned GET.
    fetchHop: async (hop, address) => {
      // Robots before the page is contacted, on EVERY hop (a redirect can cross to another host).
      if (!(await deps.robotsAllows(hop))) throw new RobotsDisallowedError(hop, "refuse", "robots.txt does not allow this page", null);
      // The page, from the checked address.
      const res = await deps.hop(hop, address);
      // pinned-get's null-on-404 becomes the typed status fetchPublicPage passes through.
      if (res === null) throw new HttpError(hop, 404, "", 1);
      // A 2xx, or a 3xx fetchPublicPage re-checks.
      return res;
    },
  });
  // Loaded: a bare 200 (the body is not needed). Refused: unknown.
  return result.ok ? new Response(null, { status: 200 }) : null;
}
