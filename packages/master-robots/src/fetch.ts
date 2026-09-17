// Turning one HTTP exchange into a RobotsSource — the fact about what the host said.
//
// THIS MODULE MAKES NO DECISIONS. It classifies. The verdict lives in gate.ts, and
// keeping the two apart is what lets the decision table be read in one place instead
// of being scattered across a fetch routine's early returns.
//
// THE SEAM IS INJECTED, NOT IMPORTED. There is a perfectly good retry transport at
// supabase/functions/_shared/http/, and it even carries a test named for this
// package — but it calls the bare global `fetch` with no injection point, so its
// only seam is monkey-patching globalThis. It also types an option as
// `RequestRedirect`, which is not a global under this package's `lib: ["es2023"]`
// and would force "DOM" into our lib to import it at all. A structural parameter
// costs nothing and keeps this package dependency-free, which is what lets
// `node --test` run it today with no install.
import { classifyRobotsBody } from './shape.ts';
import { parseRobotsTxt } from './parse.ts';
import type { RobotsSource } from './types.ts';
// REUSED, NOT COPIED, and this is the one import that leaves the package. It already
// defends the `Date.parse("-5")` trap by shape-checking for an ASCII letter before
// ever reaching Date.parse, it is pure, it takes its clock as a parameter, and it has
// 14 tests behind it. A local copy would be a second place that trap can regress —
// and the copy is always the one nobody re-tests. This repo argues the same point at
// packages/master-pdf/package.json about master-ingest's text folds.
//
// UNPRECEDENTED, DELIBERATELY: no packages/* package has reached into
// supabase/functions before. worker/src/cli/scout.ts:9 and scout-remote.ts:10 set the
// cross-tree idiom; this is the first from a package, and it is confined to this one
// dependency-free module. Importing transport.ts instead would force "DOM" into our
// lib for `RequestRedirect`, which is why only this file is taken.
import { parseRetryAfterMs } from '../../../supabase/functions/_shared/http/retry-after.ts';

// The slice of a Response this package actually reads. Deliberately minimal: a
// narrow structural type is trivial for a caller to satisfy with a stub, and it
// keeps the whole web-types surface out of our lib.
export interface RobotsResponse {
  readonly status: number;
  // Widened beyond brief-4's proposed seam, which exposed only `status` and
  // `text()`. The Content-Type check in shape.ts is unreachable without this, so the
  // brief's type could not express a defence the design requires.
  readonly headers: { get(name: string): string | null };
  text(): Promise<string>;
}

// How the caller performs the request. `signal` is passed so a caller's timeout and
// cancellation reach the actual fetch rather than being simulated around it.
export type RobotsFetcher = (
  url: string,
  init: { signal: AbortSignal; headers: Record<string, string> },
) => Promise<RobotsResponse>;

// How long we are willing to wait for a robots.txt. The gate runs before every
// outbound request, so a slow host must not become a slow pipeline.
export const DEFAULT_TIMEOUT_MS = 12_000;

// Statuses meaning the host successfully told us it publishes no policy. 410 is
// included because "permanently gone" is as definitive an answer as "not found".
const DEFINITIVELY_ABSENT = new Set([404, 410]);

// Statuses meaning the host is actively refusing us rather than failing to answer.
// 403 IS THE DELIBERATE DEVIATION — see gate.ts for the full reasoning.
const REFUSED_BY_HOST = new Set([401, 403]);

/**
 * Ask a host for its robots.txt and classify what came back.
 *
 * Never throws. A thrown fetch becomes `indeterminate`, because a gate that can
 * crash its caller is a gate that gets wrapped in a try/catch which swallows it and
 * proceeds — turning a refusal into permission by way of an error handler.
 */
export async function fetchRobotsSource(
  robotsUrl: string,
  fetcher: RobotsFetcher,
  timeoutMs: number,
  productToken: string,
  // Injected so the Retry-After arithmetic is testable without waiting for a clock.
  now: () => number,
  // The longest 429 wait worth honouring. Beyond it, waiting is worse than refusing.
  maxWaitMs: number,
): Promise<RobotsSource> {
  // Declared here so the catch below can report which stage failed.
  let response: RobotsResponse;
  try {
    // A fresh timeout per call; AbortSignal.timeout exists in Node 24 and Deno 2.
    response = await fetcher(robotsUrl, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        // Identify honestly. NEVER send a browser User-Agent here: PROJECT_PLAN.md
        // constraint #5 puts UA spoofing to get past a bot filter out of bounds, and
        // doing it while ASKING FOR THE ROBOTS POLICY would be circumventing the
        // very mechanism this package exists to respect.
        'user-agent': productToken,
        // Signals we want the policy, not a rendered page, which nudges some hosts
        // away from serving an HTML error shell.
        accept: 'text/plain, */*;q=0.1',
      },
    });
  } catch (cause) {
    // DNS failure, connection reset, timeout, or a fetcher that threw. We never
    // learned the policy, which is categorically different from learning there is
    // none — hence `indeterminate` and not `definitively-absent`.
    const reason = cause instanceof Error ? cause.message : String(cause);
    return { kind: 'indeterminate', reason: `robots.txt fetch failed: ${reason}` };
  }

  // The host answered definitively that it publishes nothing. THE ONE PERMITTING
  // NON-200: absence of a policy is permission under RFC 9309, and refusing here
  // would block the majority of the web, which is not a stricter gate but a broken
  // one. See gate.ts for why this does not contradict 403 refusing.
  if (DEFINITIVELY_ABSENT.has(response.status)) {
    return { kind: 'definitively-absent', status: response.status };
  }

  // The host refused us. Kept apart from `indeterminate` because "you may not" and
  // "I could not tell you" are opposite facts that happen to share a verdict.
  if (REFUSED_BY_HOST.has(response.status)) {
    return { kind: 'refused-by-host', status: response.status };
  }

  // Rate limiting is its own fact: the host will answer, just not yet.
  if (response.status === 429) {
    // THE TRAP GUARD. Parsing is delegated to the transport's audited parser rather
    // than reimplemented, because `Date.parse("-5")` is NOT NaN — it is the year -5,
    // which floors to a 0ms delay and turns a garbage header into "retry
    // immediately". That parser shape-checks for an ASCII letter before ever
    // reaching Date.parse. A second implementation here would be a second place
    // that trap can regress, and it would be the copy nobody re-tests.
    const retryAfterMs = parseRetryAfterMs(response.headers.get('retry-after'), now());
    // An absent or unreadable Retry-After means we do not know when to return. That
    // is an unknown, and unknowns refuse — we do not invent a delay.
    if (retryAfterMs === null) {
      return { kind: 'indeterminate', reason: 'robots.txt returned 429 with no readable Retry-After' };
    }
    // A wait longer than the ceiling is not worth holding the pipeline for, so it
    // degrades to a refusal rather than a very long sleep.
    if (retryAfterMs > maxWaitMs) {
      return { kind: 'indeterminate', reason: `robots.txt 429 asks for ${retryAfterMs}ms, over the ${maxWaitMs}ms ceiling` };
    }
    return { kind: 'rate-limited', retryAfterMs };
  }

  // Anything that is not a 200 leaves us without a policy. This deliberately
  // includes 3xx: a redirect we were not given the body of tells us nothing, and
  // following one across origins would apply another host's policy here.
  if (response.status !== 200) {
    return { kind: 'indeterminate', reason: `robots.txt returned HTTP ${response.status}` };
  }

  // The body, read only after the status has been accepted.
  let body: string;
  try {
    body = await response.text();
  } catch (cause) {
    // A body that fails mid-read is an unknown policy, not an empty one.
    const reason = cause instanceof Error ? cause.message : String(cause);
    return { kind: 'indeterminate', reason: `robots.txt body unreadable: ${reason}` };
  }

  // THE SOFT-200 GATE. Everything downstream of here assumes the body really is a
  // robots.txt, and this is the only place that assumption is established.
  const shape = classifyRobotsBody(body, response.headers.get('content-type'));
  if (shape.kind === 'not-robots-txt') {
    // Note what does NOT happen: the body is not parsed, and no empty ruleset is
    // constructed. A soft-200 cannot produce a Ruleset value at all, which is what
    // makes the wrong answer unrepresentable rather than merely guarded against.
    return { kind: 'not-robots-txt', reason: shape.reason };
  }

  // Only now, with the shape established, does parsing happen.
  return { kind: 'policy', ruleset: parseRobotsTxt(body) };
}
