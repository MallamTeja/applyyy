// THE DECISION TABLE. One function, total over RobotsSource, and it is the only
// place in this package where a verdict is produced.
//
// WHY TOTAL-OVER-A-UNION RATHER THAN A CHAIN OF IFS: the compiler refuses to build
// if a new RobotsSource arm is added without a verdict for it. A chain of ifs with a
// trailing `return allow` would compile forever and silently permit every fact
// nobody thought about yet. The exhaustiveness check at the bottom is the control;
// the comments here are only its explanation.
//
// THE 404/403 PAIR, WHICH LOOKS INCONSISTENT AND IS NOT. Both are 4xx. They get
// opposite verdicts:
//   404 -> ALLOW.  The host SUCCESSFULLY answered, and its answer was "I publish no
//                  policy". Absence of a restriction is permission.
//   403 -> REFUSE. The host answered "I am refusing you". That is the opposite fact.
// RFC 9309 says "4xx means allow all" and so would grant us access on a 403 — at
// precisely the moment we have been actively blocked, which is when a WAF returns
// one. We deviate on 403 deliberately. The principle that makes these ONE rule
// rather than two exceptions: READ WHAT THE HOST SAID, NOT WHAT CLASS ITS NUMBER
// FALLS IN. Applying that principle is also why 404 does NOT fail closed — a gate
// that refuses the majority of the web is not stricter, it is broken, and safety
// that halts the system is a different product rather than a safer one.
import { fetchRobotsSource, DEFAULT_TIMEOUT_MS, type RobotsFetcher } from './fetch.ts';
import { isPathAllowed, selectGroup } from './match.ts';
import type { RobotsSource, RobotsVerdict } from './types.ts';

// How long a good policy stays trustworthy. An hour balances politeness against
// picking up a site's policy change within a working session.
export const DEFAULT_SUCCESS_TTL_MS = 60 * 60 * 1000;
// Failures expire far sooner, so a host that was briefly down is retried rather than
// staying refused for an hour. Not zero, or the gate itself hammers a broken host.
export const DEFAULT_FAILURE_TTL_MS = 5 * 60 * 1000;
// The longest 429 wait worth honouring; beyond this, refusing beats blocking.
export const DEFAULT_MAX_WAIT_MS = 5_000;

// One cached classification plus the moment it stops being trustworthy.
export interface CacheEntry {
  readonly source: RobotsSource;
  readonly expiresAtMs: number;
}

// The cache is a plain Map the caller owns. Passing it in rather than holding a
// module-level singleton keeps the package free of global state, which is what makes
// two tests in the same process unable to contaminate each other.
export type RobotsCache = Map<string, CacheEntry>;

// WHICH READING OF A 401 ROBOTS.TXT APPLIES. A closed union, not a boolean, so a third
// purpose has to be named and decided here rather than smuggled in as `true`.
//   'strict'   — 401 and 403 both refuse (the deviation explained above). The DEFAULT,
//                so every caller that says nothing (the applier, job-link-intake) keeps
//                exactly the rule it had.
//   'scouting' — board-list reads only. A 401 counts as "no robots file", RFC 9309's own
//                reading of a 4xx. Teja ruled this 2026-11-01 after api.ashbyhq.com's
//                robots.txt was measured answering 401 while its public board API
//                answers 200: strict refused all 75 Ashby boards. 403 still refuses
//                (a WAF block is the case the deviation exists for) and a published
//                Disallow still refuses (SmartRecruiters' "User-agent: * Disallow: /").
// See docs/robots/2026-09-17-robots-gate-design.md §4.
export type RobotsPolicy = 'strict' | 'scouting';

export interface RobotsOptions {
  // Which reading of a 401 applies; absent = 'strict'. Decided per call, never cached:
  // the cache holds what the host SAID, so a strict and a scouting caller can share one.
  readonly policy?: RobotsPolicy;
  // The structural fetch seam. Injected rather than imported so the package stays
  // dependency-free and every test runs with no network.
  readonly fetcher?: RobotsFetcher;
  // Omitting it disables caching entirely, which is the right default for a one-shot
  // caller and keeps two tests in one process from contaminating each other.
  readonly cache?: RobotsCache;
  // Injected clock, so TTL expiry is testable in milliseconds rather than by waiting.
  readonly now?: () => number;
  // Per-request ceiling; a slow host must not become a slow pipeline.
  readonly timeoutMs?: number;
  // How long a good policy is trusted.
  readonly successTtlMs?: number;
  // Deliberately shorter than success, so an outage is not sticky.
  readonly failureTtlMs?: number;
  // The longest 429 wait worth honouring before refusing instead.
  readonly maxWaitMs?: number;
}

/**
 * Derive the robots.txt URL for a target URL.
 *
 * Returns null on input we cannot parse, rather than a guessed origin — guessing
 * would fetch some other host's policy and apply it here.
 */
export function robotsUrlFor(targetUrl: string): string | null {
  try {
    // `origin` carries scheme, host AND port. Dropping the port would read a
    // different origin's policy, which is a cross-host fail-open.
    return `${new URL(targetUrl).origin}/robots.txt`;
  } catch {
    return null;
  }
}

// The default fetcher, used when the caller injects none. Kept tiny and at the edge
// so the rest of the package stays pure and testable with no network.
const defaultFetcher: RobotsFetcher = async (url, init) => {
  // The global fetch exists in Node 24, Deno 2 and every browser, so no import and
  // no polyfill — which is what keeps this package's dependency list empty.
  const response = await fetch(url, { signal: init.signal, headers: init.headers });
  // Narrowed to RobotsResponse on the way out rather than passed through whole: the
  // package must not start depending on the full Response type, which would drag DOM
  // lib into every consumer's typecheck.
  return {
    status: response.status,
    // Wrapped rather than handed over, so only `get` is reachable and no caller can
    // start mutating headers through a seam meant to be read-only.
    headers: { get: (name: string) => response.headers.get(name) },
    // Passed unread; fetch.ts decides whether the body is worth reading at all.
    text: () => response.text(),
  };
};

/**
 * Turn a fact about what the host said into a verdict.
 *
 * Exported because the decision table is the part most worth testing directly, and
 * because a caller holding a cached RobotsSource can re-decide without refetching.
 */
export function verdictFor(
  // What the host said, as fetch.ts classified it.
  source: RobotsSource,
  // Our product token, for group selection.
  productToken: string,
  // Path plus query, the part rules match against.
  path: string,
  // Defaults to the stricter reading, so an omitted policy can only ever refuse more.
  policy: RobotsPolicy = 'strict',
): RobotsVerdict {
  switch (source.kind) {
    case 'policy': {
      // Which group addresses us. Null means the file named neither our token nor
      // `*`, so the site placed no restriction on anyone like us.
      const selection = selectGroup(source.ruleset, productToken);
      if (selection === null) {
        return {
          // Nobody addressed us, so nobody restricted us.
          kind: 'allow',
          // Says WHY it allowed, so "allowed" and "unaddressed" stay distinguishable in a log.
          reason: 'robots.txt addresses no group matching this token',
          // No group means no published delay; null is unknown, never zero.
          crawlDelayMs: null,
        };
      }
      // The path test, against the selected group only.
      if (!isPathAllowed(selection.group, path)) {
        // The matched group is named in the reason so a refusal is auditable — a
        // verdict that cannot say WHICH rule refused cannot be reviewed, and a test
        // asserting only "not allowed" cannot tell a correct refusal from a
        // coincidental one.
        return {
          kind: 'refuse',
          reason: `robots.txt group "${selection.matchedToken}" disallows ${path}`,
          source: 'policy',
        };
      }
      return {
        kind: 'allow',
        // Naming the group on the ALLOW path too, so an over-permissive match is as
        // auditable as an over-strict one. Only logging refusals hides the worse bug.
        reason: `robots.txt group "${selection.matchedToken}" permits ${path}`,
        // The site's own politeness window, passed through untouched. This package
        // does not invent a floor — that is the caller's policy, not ours.
        crawlDelayMs: selection.group.crawlDelayMs,
      };
    }

    // THE ONE PERMITTING NON-200, and the deliberate exception to fail-closed. See
    // the 404/403 pair at the top of this file for why this is not an inconsistency.
    case 'definitively-absent':
      return {
        kind: 'allow',
        // The status is quoted so a reviewer can tell a 404 from a 410 without
        // re-running anything, and can see this was an ANSWER rather than a silence.
        reason: `host published no robots.txt (HTTP ${source.status}), which is permission`,
        // No file means no published delay. Unknown, not zero.
        crawlDelayMs: null,
      };

    // THE DELIBERATE DEVIATION FROM RFC 9309. Reasoning at the top of this file.
    case 'refused-by-host':
      // THE ONE SCOUTING EXCEPTION (RobotsPolicy above): a 401 is an auth wall on the
      // file, not a statement about bots, so a board-list read treats it as no file.
      // 403 never reaches this branch's allow, under any policy.
      if (policy === 'scouting' && source.status === 401) {
        return {
          // The same answer a 404 gets: nothing published, nothing restricted.
          kind: 'allow',
          // Names the status AND the policy, so a log can tell this allow from a 404's.
          reason: `robots.txt answered HTTP 401; the scouting policy reads that as no robots file (RFC 9309)`,
          // No file read means no published delay. Unknown, not zero.
          crawlDelayMs: null,
        };
      }
      return {
        kind: 'refuse',
        // The reason states the principle inline, because this is the verdict most
        // likely to be challenged as a bug by someone holding a copy of RFC 9309.
        reason: `host refused the robots.txt request (HTTP ${source.status}); a refusal is not permission`,
        // Machine-readable cause, so a caller can distinguish being blocked from
        // being unable to reach the host without parsing the human string.
        source: 'refused-by-host',
      };

    // We never learned the policy. Distinct from `definitively-absent` so the two
    // can never be collapsed into one NOT_FETCHED state that silently flips 404.
    case 'indeterminate':
      return { kind: 'refuse', reason: source.reason, source: 'indeterminate' };

    // The soft-200. Distinct from `indeterminate` because a broken host and a dead
    // host need different fixes, even though both refuse.
    case 'not-robots-txt':
      return {
        kind: 'refuse',
        // The shape check's own reason is nested rather than replaced, because
        // "which layer rejected it" is the first thing an operator needs.
        reason: `robots.txt was fetched but is not a robots.txt (${source.reason})`,
        source: 'not-robots-txt',
      };

    // The host will answer, just not yet. fetch.ts has already confirmed the wait is
    // readable and within the ceiling; an unreadable or over-long one arrives here
    // as `indeterminate` instead.
    case 'rate-limited':
      return {
        kind: 'wait',
        reason: `host asked us to retry robots.txt in ${source.retryAfterMs}ms`,
        // The caller does the sleeping, not this package: a gate that blocks is a
        // gate callers wrap in a timeout that swallows it and proceeds anyway.
        waitMs: source.retryAfterMs,
      };

    default: {
      // EXHAUSTIVENESS CHECK, AND IT IS THE ACTUAL CONTROL. Adding an arm to
      // RobotsSource without deciding its verdict fails to compile here, because
      // `never` accepts nothing. Without this the new arm would fall through to a
      // default verdict nobody chose — which is the whole disease this package
      // exists to prevent, reappearing in the code meant to prevent it.
      const unhandled: never = source;
      return { kind: 'refuse', reason: `unhandled robots source: ${JSON.stringify(unhandled)}`, source: 'indeterminate' };
    }
  }
}

/**
 * Decide whether `targetUrl` may be fetched.
 *
 * `productToken` is REQUIRED and has NO DEFAULT. That is deliberate: a default would
 * be a fail-open with extra steps, because the caller who omitted it would still get
 * an answer and the answer would be the permissive one, with nothing raised. Making
 * it required turns the omission into a compile error instead of a silent verdict.
 * It is the PRODUCT TOKEN (`applyy-scout`), not the User-Agent header — pass a header
 * here and every named group fails to match, selection falls through to `*`, and
 * nothing throws. Use tokenFromUserAgentHeader() if you only hold a header.
 */
export async function checkRobots(
  targetUrl: string,
  productToken: string,
  options: RobotsOptions = {},
): Promise<RobotsVerdict> {
  // Resolved once so every later reference reads the same value.
  const now = options.now ?? Date.now;
  const cache = options.cache;
  const successTtlMs = options.successTtlMs ?? DEFAULT_SUCCESS_TTL_MS;
  const failureTtlMs = options.failureTtlMs ?? DEFAULT_FAILURE_TTL_MS;

  // A URL we cannot parse has no origin to ask, and no path to test. Refusing is the
  // only honest answer; defaulting to permitted would grant access on malformed input.
  const robotsUrl = robotsUrlFor(targetUrl);
  if (robotsUrl === null) {
    return { kind: 'refuse', reason: `cannot derive a robots.txt URL from ${targetUrl}`, source: 'indeterminate' };
  }

  // The path plus query, which is what RFC 9309 matches rules against.
  const parsed = new URL(targetUrl);
  const path = `${parsed.pathname}${parsed.search}`;

  // KEYED BY THE ROBOTS URL, WHICH IS THE ORIGIN. A key any broader would apply one
  // site's policy to another — a cross-host fail-open that a single-host test cannot
  // detect, which is why there is a test asserting two hosts fetch separately.
  const cached = cache?.get(robotsUrl);
  if (cached !== undefined && cached.expiresAtMs > now()) {
    // The caller's policy applies to the cached fact, so a strict entry never leaks
    // its refusal into a scouting read of the same 401 (or the reverse).
    return verdictFor(cached.source, productToken, path, options.policy);
  }

  // The one network call, behind the injected seam.
  const source = await fetchRobotsSource(
    robotsUrl,
    options.fetcher ?? defaultFetcher,
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    productToken,
    now,
    options.maxWaitMs ?? DEFAULT_MAX_WAIT_MS,
  );

  // A good policy is trusted for longer than a failure, so a transient outage does
  // not stick to a host for the full success window.
  const ttl = source.kind === 'policy' || source.kind === 'definitively-absent' ? successTtlMs : failureTtlMs;
  cache?.set(robotsUrl, { source, expiresAtMs: now() + ttl });

  // Same policy pass-through as the cached branch; undefined falls to verdictFor's 'strict'.
  return verdictFor(source, productToken, path, options.policy);
}
