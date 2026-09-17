// The decision table, end to end: what the host said -> what we do.
//
// READ THE 403 AND 404 CASES TOGETHER. They are the same HTTP status class and they
// get OPPOSITE verdicts, which looks like an inconsistency until you see the rule
// underneath: read what the host actually SAID, not what class its number falls in.
// 404 says "I publish no policy" — permission. 403 says "I am refusing you" — not
// permission. RFC 9309 lumps both under "4xx means allow all" and gets 403 exactly
// backwards, granting access at the precise moment we have been blocked.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { checkRobots, robotsUrlFor } from '../src/gate.ts';
import type { RobotsFetcher, RobotsResponse } from '../src/fetch.ts';
import {
  ASHBY_API_DISALLOWED,
  GREENHOUSE_BOARDS_EMBED_ONLY,
  GREENHOUSE_JOB_BOARDS_ALL_COMMENTED,
  LEVER_CLAUDEBOT_SYNTHETIC,
  SOFT_200_HTML_ERROR,
} from './fixtures/robots-bodies.ts';

// Build a fetcher that answers every request identically. The structural seam is
// what lets the whole decision table be exercised with no network at all.
function respondWith(
  status: number,
  // Defaults to empty, which is a VALID allow-all — so a test that forgets a body
  // gets the permissive case and must state its status expectation deliberately.
  body = '',
  // text/plain by default so body-shape tests cannot pass via the content-type layer.
  headers: Record<string, string> = { 'content-type': 'text/plain' },
): RobotsFetcher {
  return async () => {
    const response: RobotsResponse = {
      status,
      // Lowercased lookup, because HTTP header names are case-insensitive and a stub
      // that is stricter than reality hides bugs rather than catching them.
      headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
      // Fresh each call, since a real body is a one-shot stream.
      text: async () => body,
    };
    return response;
  };
}

// A fetcher that throws, standing in for DNS failure, connection reset or timeout.
// SEPARATE FROM respondWith ON PURPOSE: a thrown fetch and a failing status travel
// different code paths, and conflating them lets a test exercise the wrong one.
const throwingFetcher: RobotsFetcher = async () => {
  throw new Error('ECONNREFUSED');
};

// Every call supplies a token explicitly — the package has no default and will not
// compile without one, which is the point.
const TOKEN = 'applyy-scout';

describe('deriving the robots.txt URL', () => {
  test('robots.txt is fetched from the origin, not the path', () => {
    assert.equal(robotsUrlFor('https://boards.greenhouse.io/acme/jobs/1'), 'https://boards.greenhouse.io/robots.txt');
  });

  test('a non-default port is part of the origin and is preserved', () => {
    // Dropping the port would fetch a DIFFERENT origin's policy and apply it here.
    assert.equal(robotsUrlFor('https://x.example:8443/jobs'), 'https://x.example:8443/robots.txt');
  });

  test('an unparseable URL returns null rather than a guessed origin', () => {
    assert.equal(robotsUrlFor('not a url'), null);
  });
});

describe('200 with a real policy', () => {
  test('a permitted path is allowed', async () => {
    // The real Greenhouse shape: only /embed/ restricted, so job pages are fine.
    const fetcher = respondWith(200, GREENHOUSE_BOARDS_EMBED_ONLY);
    // A job URL, which is what the Scout actually fetches.
    const verdict = await checkRobots('https://boards.greenhouse.io/acme/jobs/1', TOKEN, { fetcher });
    // The baseline: if this ever fails, the gate blocks our main supply.
    assert.equal(verdict.kind, 'allow');
  });

  test('a disallowed path refuses and names the policy as its source', async () => {
    const fetcher = respondWith(200, GREENHOUSE_BOARDS_EMBED_ONLY);
    // The one path this host restricts.
    const verdict = await checkRobots('https://boards.greenhouse.io/embed/job_app', TOKEN, { fetcher });
    assert.equal(verdict.kind, 'refuse');
    // Asserting the SOURCE too, so a refusal caused by a broken fetch cannot pass
    // as a refusal caused by the policy. Same verdict, different fact.
    if (verdict.kind === 'refuse') assert.equal(verdict.source, 'policy');
  });

  test('the Ashby /api/ restriction is honoured', async () => {
    // capture-fixture.ts records that rendering an Ashby page requires /api/, which
    // is disallowed — so this restriction is why we have no Ashby fixture at all.
    const fetcher = respondWith(200, ASHBY_API_DISALLOWED);
    // A job page, which Ashby's policy permits.
    const allowed = await checkRobots('https://jobs.ashbyhq.com/acme/1234', TOKEN, { fetcher });
    // The exact endpoint the SPA calls, which it does not.
    const blocked = await checkRobots('https://jobs.ashbyhq.com/api/non-user-graphql', TOKEN, { fetcher });
    // Both halves asserted, so neither a blanket-allow nor a blanket-refuse passes.
    assert.equal(allowed.kind, 'allow');
    assert.equal(blocked.kind, 'refuse');
  });

  test('REGRESSION job-boards.greenhouse.io: an all-comments policy allows', async () => {
    // The host capture-fixture.ts records in HUMAN_REVIEWED_HOSTS as human-verified permitted. A revert to
    // upstream's rule-count guard turns this green test red and names the host.
    const fetcher = respondWith(200, GREENHOUSE_JOB_BOARDS_ALL_COMMENTED);
    const verdict = await checkRobots('https://job-boards.greenhouse.io/acme/jobs/1', TOKEN, { fetcher });
    assert.equal(verdict.kind, 'allow');
  });
});

describe('the Lever restriction, which is a live ruling and not a hypothetical', () => {
  test('the ClaudeBot token is refused against the documented Lever policy', async () => {
    // ASSERTS WE DO LESS, so it must be impossible to pass vacuously: the verdict,
    // the source AND the matched group are all checked. "Not allowed" alone would
    // also pass if the fetch had simply failed.
    const fetcher = respondWith(200, LEVER_CLAUDEBOT_SYNTHETIC);
    const verdict = await checkRobots('https://jobs.lever.co/acme/1234', 'claudebot', { fetcher });
    assert.equal(verdict.kind, 'refuse');
    if (verdict.kind === 'refuse') {
      assert.equal(verdict.source, 'policy');
      // Naming the group proves the ClaudeBot rule fired, not some other refusal.
      assert.match(verdict.reason, /claudebot/i);
    }
  });

  test('a different token reaches the wildcard group in the same file', async () => {
    // THE NON-VACUITY TWIN. Without it the test above would still pass if the gate
    // refused everything unconditionally. Note this asserts the MECHANISM, not a
    // policy about which token applyyy should present to Lever — that is Teja's
    // call, recorded in PROJECT_PLAN.md §19 as his and nobody else's.
    const fetcher = respondWith(200, LEVER_CLAUDEBOT_SYNTHETIC);
    const verdict = await checkRobots('https://jobs.lever.co/acme/1234', 'some-other-bot', { fetcher });
    assert.equal(verdict.kind, 'allow');
  });
});

describe('200 that is not a robots.txt — the soft-200', () => {
  test('an HTML error page served with 200 refuses rather than permitting everything', async () => {
    // The body parses to zero rules. Zero rules read as allow-all, so a broken
    // server would GRANT permission it never gave. This is the whole disease.
    const fetcher = respondWith(200, SOFT_200_HTML_ERROR, { 'content-type': 'text/html' });
    const verdict = await checkRobots('https://x.example/jobs', TOKEN, { fetcher });
    assert.equal(verdict.kind, 'refuse');
    if (verdict.kind === 'refuse') assert.equal(verdict.source, 'not-robots-txt');
  });

  test('a soft-200 refuses even when the content-type claims text/plain', async () => {
    const fetcher = respondWith(200, SOFT_200_HTML_ERROR);
    const verdict = await checkRobots('https://x.example/jobs', TOKEN, { fetcher });
    assert.equal(verdict.kind, 'refuse');
    if (verdict.kind === 'refuse') assert.equal(verdict.source, 'not-robots-txt');
  });

  test('a genuinely empty robots.txt still allows, so the defence has not over-corrected', async () => {
    const verdict = await checkRobots('https://x.example/jobs', TOKEN, { fetcher: respondWith(200, '') });
    assert.equal(verdict.kind, 'allow');
  });
});

describe('the host publishes no policy — 404 and 410 allow', () => {
  test('404 allows, because it is a definitive answer and not an absence of one', async () => {
    // Most sites publish no robots.txt. A gate that refused here would refuse the
    // majority of the web, which is not a stricter gate but a broken one.
    const verdict = await checkRobots('https://x.example/jobs', TOKEN, { fetcher: respondWith(404) });
    assert.equal(verdict.kind, 'allow');
  });

  test('410 allows on the same reasoning', async () => {
    // "Permanently gone" is as definitive as "not found"; both are answers.
    const verdict = await checkRobots('https://x.example/jobs', TOKEN, { fetcher: respondWith(410) });
    assert.equal(verdict.kind, 'allow');
  });
});

describe('the host refuses us — 401 and 403 refuse, against RFC 9309', () => {
  test('403 refuses, inverting the RFC rule that 4xx means allow all', async () => {
    // Under the RFC, a WAF's 403 would GRANT permission at exactly the moment we
    // have been actively blocked. That inversion is the entire justification.
    const verdict = await checkRobots('https://x.example/jobs', TOKEN, { fetcher: respondWith(403) });
    assert.equal(verdict.kind, 'refuse');
    // The source must be refused-by-host, not indeterminate: being BLOCKED and being
    // UNABLE TO REACH are different facts that happen to share a verdict, and this
    // assertion is what stops a later refactor merging them.
    if (verdict.kind === 'refuse') assert.equal(verdict.source, 'refused-by-host');
  });

  test('401 refuses on the same reasoning', async () => {
    // An authenticated robots.txt is still a refusal to tell us the policy.
    const verdict = await checkRobots('https://x.example/jobs', TOKEN, { fetcher: respondWith(401) });
    assert.equal(verdict.kind, 'refuse');
    if (verdict.kind === 'refuse') assert.equal(verdict.source, 'refused-by-host');
  });
});

describe('we never learned the policy — everything indeterminate refuses', () => {
  test('500 refuses rather than being retried into an answer', async () => {
    // RFC 9309 assigns MEANING to a 5xx on robots.txt: unavailable, which a crawler
    // may treat as complete disallow. It is not a transient error to grind past.
    const verdict = await checkRobots('https://x.example/jobs', TOKEN, { fetcher: respondWith(503) });
    assert.equal(verdict.kind, 'refuse');
    // Indeterminate, not refused-by-host: the server broke, it did not refuse us.
    if (verdict.kind === 'refuse') assert.equal(verdict.source, 'indeterminate');
  });

  test('a thrown fetch refuses instead of propagating and killing the caller', async () => {
    // A gate that throws gets wrapped in a try/catch that swallows it and proceeds —
    // turning a refusal into permission by way of an error handler. So it must not.
    const verdict = await checkRobots('https://x.example/jobs', TOKEN, { fetcher: throwingFetcher });
    assert.equal(verdict.kind, 'refuse');
    if (verdict.kind === 'refuse') assert.equal(verdict.source, 'indeterminate');
  });

  test('an unfollowed redirect refuses rather than being read as an answer', async () => {
    // Following a robots.txt redirect across origins would apply another host's
    // policy here, so an unfollowed 3xx is an unknown rather than a result.
    const verdict = await checkRobots('https://x.example/jobs', TOKEN, { fetcher: respondWith(302) });
    assert.equal(verdict.kind, 'refuse');
  });

  test('a URL we cannot parse refuses rather than defaulting to permitted', async () => {
    // Malformed input must not be the permissive path — that is the whole disease.
    const verdict = await checkRobots('not a url', TOKEN, { fetcher: respondWith(200, '') });
    assert.equal(verdict.kind, 'refuse');
  });
});

describe('429 — wait only when the wait is short and readable', () => {
  test('a Retry-After within the ceiling produces a wait, not a refusal', async () => {
    // Three seconds is inside the 5s default, so waiting beats abandoning the host.
    const fetcher = respondWith(429, '', { 'retry-after': '3' });
    const verdict = await checkRobots('https://x.example/jobs', TOKEN, { fetcher });
    assert.equal(verdict.kind, 'wait');
    // The millisecond conversion is asserted, not just the kind: a unit slip here
    // would produce a 3ms wait that looks like compliance and is not.
    if (verdict.kind === 'wait') assert.equal(verdict.waitMs, 3000);
  });

  test('a Retry-After beyond the ceiling refuses rather than blocking the pipeline', async () => {
    // Ten minutes. Honouring it would stall every downstream stage behind one host.
    const fetcher = respondWith(429, '', { 'retry-after': '600' });
    const verdict = await checkRobots('https://x.example/jobs', TOKEN, { fetcher });
    assert.equal(verdict.kind, 'refuse');
  });

  test('THE Date.parse TRAP: a garbage Retry-After does not read as retry-immediately', async () => {
    // Date.parse("-5") is NOT NaN — it is the year -5, which floors to a 0ms delay
    // and turns a malformed header into "go now". A bare Date.parse/NaN check fails
    // this test. We reuse the transport's parser, which shape-checks first.
    const fetcher = respondWith(429, '', { 'retry-after': '-5' });
    const verdict = await checkRobots('https://x.example/jobs', TOKEN, { fetcher });
    // Refuse, NOT wait-zero. A naive parser yields waitMs 0 here and the caller
    // proceeds instantly — a malformed header becoming permission to go now.
    assert.equal(verdict.kind, 'refuse');
  });

  test('a 429 with no Retry-After at all refuses rather than assuming a delay', async () => {
    // Absent means we do not know when to return, and unknown refuses. Inventing a
    // default here would be the gate guessing on the host's behalf.
    const verdict = await checkRobots('https://x.example/jobs', TOKEN, { fetcher: respondWith(429) });
    assert.equal(verdict.kind, 'refuse');
  });
});

describe('the crawl-delay the site asked for reaches the caller', () => {
  test('a published crawl-delay is reported in milliseconds on an allow', async () => {
    const fetcher = respondWith(200, 'User-agent: *\nCrawl-delay: 2\nDisallow: /x\n');
    const verdict = await checkRobots('https://x.example/jobs', TOKEN, { fetcher });
    assert.equal(verdict.kind, 'allow');
    if (verdict.kind === 'allow') assert.equal(verdict.crawlDelayMs, 2000);
  });

  test('no published crawl-delay reports null, which is unknown rather than zero', async () => {
    const fetcher = respondWith(200, 'User-agent: *\nDisallow: /x\n');
    const verdict = await checkRobots('https://x.example/jobs', TOKEN, { fetcher });
    if (verdict.kind === 'allow') assert.equal(verdict.crawlDelayMs, null);
  });
});

describe('the per-host TTL cache', () => {
  test('a second check of the same host does not refetch', async () => {
    // The gate runs before every outbound fetch, so an uncached gate doubles our
    // request count against every host — which is itself impolite.
    // Counting calls rather than asserting on the verdict: the verdict is identical
    // either way, so only the call count can distinguish a hit from a miss.
    let calls = 0;
    const fetcher: RobotsFetcher = async () => {
      calls++;
      return {
        status: 200,
        headers: { get: () => 'text/plain' },
        text: async () => GREENHOUSE_BOARDS_EMBED_ONLY,
      };
    };
    // A fresh Map per test, so no test can inherit another's entries.
    const cache = new Map();
    // A frozen clock, so nothing here expires mid-test and makes the result timing-dependent.
    const options = { fetcher, cache, now: () => 1_000 };
    // Two DIFFERENT paths on the SAME host — the cache is keyed by origin, so the
    // second must hit. Using the same path twice would pass even if keyed by full URL.
    await checkRobots('https://boards.greenhouse.io/a', TOKEN, options);
    await checkRobots('https://boards.greenhouse.io/b', TOKEN, options);
    assert.equal(calls, 1);
  });

  test('a different host is fetched separately, so the cache is keyed correctly', async () => {
    // A cache keyed too broadly would apply one site's policy to another — a
    // catastrophic fail-open that a single-host test cannot detect.
    let calls = 0;
    const fetcher: RobotsFetcher = async () => {
      calls++;
      return { status: 200, headers: { get: () => 'text/plain' }, text: async () => '' };
    };
    const cache = new Map();
    const options = { fetcher, cache, now: () => 1_000 };
    // Same PATH, different HOSTS — the mirror image of the test above. Together they
    // pin the key to exactly the origin: too broad and this fails, too narrow and
    // the previous test fails.
    await checkRobots('https://a.example/x', TOKEN, options);
    await checkRobots('https://b.example/x', TOKEN, options);
    assert.equal(calls, 2);
  });

  test('an expired entry is refetched rather than served stale forever', async () => {
    let calls = 0;
    const fetcher: RobotsFetcher = async () => {
      calls++;
      return { status: 200, headers: { get: () => 'text/plain' }, text: async () => '' };
    };
    const cache = new Map();
    // A mutable clock, which is why `now` is injected at all — expiry is testable in
    // microseconds instead of by actually waiting a minute.
    let clock = 1_000;
    const options = { fetcher, cache, now: () => clock, successTtlMs: 60_000 };
    // Populates the cache.
    await checkRobots('https://a.example/x', TOKEN, options);
    // One millisecond PAST the TTL, so the boundary itself is what is under test.
    clock = 1_000 + 60_001;
    await checkRobots('https://a.example/x', TOKEN, options);
    // A stale policy served forever would mean a site that revoked permission still
    // reads as permitting us — the one cache bug that is a compliance failure.
    assert.equal(calls, 2);
  });

  test('a refusal is cached for a shorter window than a success', async () => {
    // A failure must not be sticky: a host that was briefly down would otherwise
    // stay refused for the full success TTL. Shorter, but not zero, or a broken
    // host gets hammered by the gate itself.
    let calls = 0;
    const fetcher: RobotsFetcher = async () => {
      calls++;
      return { status: 500, headers: { get: () => null }, text: async () => '' };
    };
    const cache = new Map();
    let clock = 1_000;
    // An hour of success TTL against a minute of failure TTL, so the two windows are
    // far enough apart that a test passing by coincidence is not plausible.
    const options = { fetcher, cache, now: () => clock, successTtlMs: 3_600_000, failureTtlMs: 60_000 };
    // Populates the cache with a FAILURE, which is the entry under test.
    await checkRobots('https://a.example/x', TOKEN, options);
    // Inside the failure window, so still served from cache.
    clock = 1_000 + 30_000;
    await checkRobots('https://a.example/x', TOKEN, options);
    // Proves failures are cached at all — without this, the next assertion would
    // pass even if caching were disabled for failures entirely.
    assert.equal(calls, 1);
    // Past the failure window but far inside the success window, which is what
    // proves the two TTLs are genuinely distinct values and not one shared constant.
    clock = 1_000 + 61_000;
    await checkRobots('https://a.example/x', TOKEN, options);
    assert.equal(calls, 2);
  });
});
