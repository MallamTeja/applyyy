// The two gates guarding worker/scripts/capture-fixture.ts, and the first
// executable proof that @applyy/master-robots has a caller at all.
//
// WHY THIS FILE EXISTS AS WELL AS THE PACKAGE'S OWN 76 TESTS. Those test the gate.
// These test that the SCRIPT CONSULTS IT — a distinction with teeth, because the
// package sat fully built and fully green with zero callers, which is the exact
// state where a green suite proves nothing about the running system. Every case
// below would still pass inside packages/master-robots and still let this script
// fetch a page it must not.
//
// No network: every case injects a fetcher, so a test run cannot reach an employer.
import { describe, expect, it } from 'vitest';
import { resolveCaptureTarget } from '../scripts/capture-fixture.ts';
import type { RobotsFetcher } from '../../packages/master-robots/src/index.ts';

// A host the script's human-review list actually contains, so gate one passes and
// each case below is attributable to gate two alone.
const REVIEWED_HOST = 'https://boards.greenhouse.io';

// Builds a fetcher that answers every robots.txt request identically. Headers are a
// record rather than a fixed pair because the 429 case needs Retry-After and the
// soft-200 case needs a markup Content-Type.
function respond(status: number, body: string, headers: Record<string, string> = {}): RobotsFetcher {
  return async () => ({
    status,
    // Lower-cased lookup, matching how a real Headers object behaves.
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
    text: async () => body,
  });
}

// The ordinary permissive answer: a real policy that restricts only /embed/, which
// is what boards.greenhouse.io actually served when a human last read it.
const PERMISSIVE = respond(200, 'User-agent: *\nDisallow: /embed/\n', { 'content-type': 'text/plain' });

describe('gate one — human review', () => {
  it('refuses a host nobody has reviewed, even when its robots.txt permits everything', async () => {
    // 404 is the gate's one PERMITTING non-200, so robots alone would say yes here.
    // The refusal therefore has exactly one possible cause: the review list.
    await expect(resolveCaptureTarget('https://jobs.lever.co/acme/1', { fetcher: respond(404, '') })).rejects.toThrow(
      /HUMAN_REVIEWED_HOSTS/,
    );
  });

  it('names the host it refused, so a failed capture does not need a debugger', async () => {
    await expect(
      resolveCaptureTarget('https://jobs.ashbyhq.com/acme/1', { fetcher: respond(404, '') }),
    ).rejects.toThrow(/jobs\.ashbyhq\.com/);
  });
});

describe('gate two — the live robots.txt policy', () => {
  it('REGRESSION: refuses a reviewed host whose policy now disallows the path', async () => {
    // THE CASE THAT FAILS WITHOUT THE WIRING. Before the gate was called, this
    // host passed on the review list alone and the script fetched a page its
    // robots.txt forbids. Reverting the checkRobots call in resolveCaptureTarget
    // turns this test red and nothing else catches it.
    const nowForbidden = respond(200, 'User-agent: *\nDisallow: /jobs/\n', { 'content-type': 'text/plain' });
    await expect(resolveCaptureTarget(`${REVIEWED_HOST}/jobs/42`, { fetcher: nowForbidden })).rejects.toThrow(
      /disallows \/jobs\/42/,
    );
  });

  it('permits a reviewed host whose policy allows the path', async () => {
    const target = await resolveCaptureTarget(`${REVIEWED_HOST}/acme/jobs/42`, { fetcher: PERMISSIVE });
    // Returning the URL rather than a boolean is what stops main() fetching
    // something the gate never saw.
    expect(target.toString()).toBe('https://boards.greenhouse.io/acme/jobs/42');
  });

  it('refuses on 403 rather than reading RFC 9309 "4xx means allow all" as permission', async () => {
    // A WAF returns 403 exactly when we have been blocked. The RFC would grant
    // access at that moment; this repo deviates deliberately, and the deviation is
    // only worth anything if it reaches the caller.
    await expect(resolveCaptureTarget(`${REVIEWED_HOST}/acme/jobs/42`, { fetcher: respond(403, '') })).rejects.toThrow(
      /refused-by-host/,
    );
  });

  it('refuses a soft-200 HTML error page instead of reading it as zero rules', async () => {
    // The upstream reference gets this wrong on Greenhouse: an error page parses to
    // no rules, and no rules reads as "allow all". Missing data becoming an answer.
    const softError = respond(200, '<!doctype html><title>Error</title>', { 'content-type': 'text/html' });
    await expect(resolveCaptureTarget(`${REVIEWED_HOST}/acme/jobs/42`, { fetcher: softError })).rejects.toThrow(
      /not-robots-txt/,
    );
  });

  it('permits when the host answers 404, because publishing no policy is an answer', async () => {
    // The counterweight to the 403 case: a gate that refused the majority of the
    // web would not be stricter, it would be broken.
    const target = await resolveCaptureTarget(`${REVIEWED_HOST}/acme/jobs/42`, { fetcher: respond(404, '') });
    expect(target.pathname).toBe('/acme/jobs/42');
  });

  it('refuses rather than proceeding when the host asks us to wait', async () => {
    // `wait` is a third state, not a soft allow. A caller that collapsed the
    // verdict union into a boolean would fetch here.
    const rateLimited = respond(429, '', { 'retry-after': '2' });
    await expect(resolveCaptureTarget(`${REVIEWED_HOST}/acme/jobs/42`, { fetcher: rateLimited })).rejects.toThrow(
      /retry in 2000ms/,
    );
  });
});

describe('what gets judged is what gets fetched', () => {
  it('strips the tracking query before the policy is matched, not after', async () => {
    // Gating `/jobs/42` and then fetching `/jobs/42?gh_src=x` would judge a URL we
    // never request. Asserting the returned URL is the whole check, because main()
    // fetches only what this function hands back.
    const target = await resolveCaptureTarget(`${REVIEWED_HOST}/acme/jobs/42?gh_src=abc&utm_source=x`, {
      fetcher: PERMISSIVE,
    });
    expect(target.search).toBe('');
    expect(target.toString()).toBe('https://boards.greenhouse.io/acme/jobs/42');
  });

  it('asks the target origin for its policy and no other', async () => {
    // A cross-host key would apply one site's policy to another — a fail-open a
    // single-host test cannot see, so the URL the fetcher received is recorded.
    const asked: string[] = [];
    const recording: RobotsFetcher = async (url) => {
      asked.push(url);
      return { status: 404, headers: { get: () => null }, text: async () => '' };
    };
    await resolveCaptureTarget(`${REVIEWED_HOST}/acme/jobs/42`, { fetcher: recording });
    expect(asked).toEqual(['https://boards.greenhouse.io/robots.txt']);
  });

  it('rejects a malformed URL before either gate runs', async () => {
    // Refusing beats guessing an origin: a guess would fetch some other host's
    // policy and apply it here.
    await expect(resolveCaptureTarget('not-a-url', { fetcher: PERMISSIVE })).rejects.toThrow();
  });
});
