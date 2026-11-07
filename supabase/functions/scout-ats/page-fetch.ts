// One posting PAGE fetch for feed liveness (_shared/scout/feed-liveness.ts, 2026-11-07), SSRF-guarded.
//
// WHY ITS OWN FILE. It touches Deno (DNS, TCP, TLS). poll-fetch.ts is imported by the worker
// (worker/scripts/workday-backfill-preview.ts), whose Node tsc has no Deno types: putting this
// there broke worker CI on 87dd4e5. Only scout-ats/index.ts imports this file.
//
// SSRF GUARD (security reviews of 8f91837 and 87dd4e5). The URL comes from a third-party feed. It
// goes through job-link-intake's fetchPublicPage: every hop, redirects included, is shape-checked,
// DNS-resolved and refused if ANY address is private, loopback, link-local (169.254.169.254) or
// otherwise non-public, and only then requested from the CHECKED IP (fetchPinnedHop, W17 rebinding
// fix). robots.txt is read the same way: from the hop's checked address, and a robots.txt redirect is
// refused, never followed. A refused hop is null ("unknown"), never "gone".

// The SSRF guard a pasted link already goes through: every hop shape-, DNS- and address-checked.
import { fetchPublicPage } from "../job-link-intake/fetch-page.ts";
// The DNS-rebinding-safe GET: connects to the checked IP, not a fresh lookup.
import { fetchPinnedHop } from "../job-link-intake/pinned-get.ts";
// The robots gate, with its fetch seam, so robots.txt goes through the pinned hop too.
import { checkRobots, tokenFromUserAgentHeader, type RobotsCache, type RobotsResponse } from "../../../packages/master-robots/src/index.ts";
// The identity robots groups are matched on (pinned-get sends this same header), and the typed errors.
import { DEFAULT_USER_AGENT, HttpError, RobotsDisallowedError } from "../_shared/http/index.ts";

// What fetchPage needs from the outside world, injectable so node --test proves the guard without a socket.
export interface PageProbeDeps {
  // One GET to the CHECKED address, a 3xx handed back; null on 404 (pinned-get.ts contract).
  hop(url: string, address: string): Promise<Response | null>;
  // Every A and AAAA address of a host; empty when it has none.
  resolve(hostname: string): Promise<string[]>;
  // The robots verdict cache: the isolate's in production, a fresh one per test.
  robotsCache: RobotsCache;
}

// NXDOMAIN / NODATA for one address family is normal (an IPv4-only host has no AAAA); any other
// resolver failure is rethrown, so fetchPublicPage refuses rather than checking half an answer.
function noRecords(err: unknown): string[] {
  // The one "no addresses" answer.
  if (err instanceof Deno.errors.NotFound) return [];
  // Anything else: refuse.
  throw err;
}

// The real dependencies.
const PRODUCTION_PAGE_DEPS: PageProbeDeps = {
  // TCP to the checked IP, TLS verified against the real name. 8 s: a slow page is "unknown" anyway,
  // inside the scout's 100 s budget.
  hop: (url, address) => fetchPinnedHop(url, address, {
    // The certificate is checked against serverName, not the IP.
    openTls: async (ip, serverName) => await Deno.startTls(await Deno.connect({ hostname: ip, port: 443 }), { hostname: serverName }),
  }, 8_000),
  // A and AAAA separately: a host with only one family answers NotFound for the other.
  resolve: async (host) => [
    // IPv4, or none.
    ...(await Deno.resolveDns(host, "A").catch(noRecords)),
    // IPv6, or none.
    ...(await Deno.resolveDns(host, "AAAA").catch(noRecords)),
  ],
  // Kept for the isolate's life, like the transport's own robots cache.
  robotsCache: new Map(),
};

// Whether robots.txt lets the scout read `url`, with robots.txt fetched from the hop's CHECKED address.
async function robotsAllows(url: string, address: string, deps: PageProbeDeps): Promise<boolean> {
  // The product token robots groups are matched on; null fails closed, as in the transport.
  const token = tokenFromUserAgentHeader(DEFAULT_USER_AGENT);
  // No token: refuse rather than match as "*".
  if (token === null) return false;
  // The gate, with its network call swapped for the pinned hop.
  const verdict = await checkRobots(url, token, {
    // The board-read reading (401 = no rules), as fetchBoard uses.
    policy: "scouting",
    // Cached per robots.txt URL; a verdict is per host, so reusing it across rows is correct.
    cache: deps.robotsCache,
    // Same host as the hop, so the same checked address.
    fetcher: async (robotsUrl): Promise<RobotsResponse> => {
      // pinned-get throws HttpError on other statuses: the gate reads a throw as indeterminate (refuse).
      const res = await deps.hop(robotsUrl, address);
      // pinned-get's null is a 404: the host publishes no policy.
      if (res === null) return { status: 404, headers: new Headers(), text: async () => "" };
      // A redirect is never followed: its target was not checked. Thrown = indeterminate = refuse.
      if (res.status >= 300 && res.status < 400) throw new Error("robots.txt redirected; not followed (SSRF guard)");
      // A 2xx: the gate shape-checks it.
      return res;
    },
  });
  // Only an explicit allow; 'refuse' and 'wait' both stop the probe.
  return verdict.kind === "allow";
}

/**
 * Fetch one posting page. Returns a 200 Response for a page that loaded, null for any refusal, and
 * THROWS HttpError 404/410 for a gone page (typed, so checkPage reads a status field, never a reason
 * string) or RobotsDisallowedError when robots.txt says no.
 */
export async function fetchPage(url: string, deps: PageProbeDeps = PRODUCTION_PAGE_DEPS): Promise<Response | null> {
  // The guarded walk; it rethrows whatever a hop throws.
  const result = await fetchPublicPage(url, {
    // The real or the test resolver.
    resolve: deps.resolve,
    // One hop: robots first, then the page, both from the address the guard just checked.
    fetchHop: async (hop, address) => {
      // On EVERY hop: a redirect can cross to another host with other rules.
      if (!(await robotsAllows(hop, address, deps))) throw new RobotsDisallowedError(hop, "refuse", "robots.txt does not allow this page", null);
      // The page.
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
