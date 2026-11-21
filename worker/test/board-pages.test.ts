// Tests for the CLI scout's board transport (worker/src/scout/board-pages.ts).
//
// The CLI used to read ONE response per board. Since SmartRecruiters was registered
// (7f5b120), that silently stored page 1 only: Nagarro listed 100 of its 585 postings.
// These tests pin the two properties the transport owns: every page is read, and a
// non-ok page THROWS (so scout.ts's catch records a failed board) instead of reaching
// the parser as a body that might parse as an empty board.
import { describe, expect, it } from 'vitest';
// The typed refusal the gate throws; the same class scout-ats's transport throws.
import { RobotsDisallowedError } from '../../supabase/functions/_shared/http/errors.ts';
// The unit under test.
import { BOARD_PAGE_TIMEOUT_MS, readBoardPages, robotsGatedGet, RobotsUnavailableError } from '../src/scout/board-pages.ts';
// The pacer both scouts share (D5, 2026-11-21); the worker's own copy was deleted in its favour.
import { createRequestPacer } from '../../supabase/functions/_shared/http/request-pacer.ts';
// The edge transport's per-attempt timeout, which the worker page timeout must equal (D5 drift #3).
import { DEFAULT_TIMEOUT_MS } from '../../supabase/functions/_shared/http/transport.ts';
// Types only: the fake adapter below is shaped against the real contract.
import type { AtsAdapter, ParsedPosting } from '../../supabase/functions/_shared/ats/types.ts';

// A two-page board in the shape the fake adapter reads: each page lists posting ids and
// names the next page, the way SmartRecruiters' offset cursor does.
const PAGES: Record<string, { ids: string[]; next: string | null }> = {
  'https://fake.test/acme?page=1': { ids: ['a1', 'a2'], next: 'https://fake.test/acme?page=2' },
  'https://fake.test/acme?page=2': { ids: ['b1'], next: null },
};

// A minimal paginating adapter. A fake, not the real SR adapter, so this suite does not
// depend on the provider's payload shape (owned and tested in _shared/ats).
const FAKE_ADAPTER = {
  // Which provider this is, for any message that names it.
  provider: 'smartrecruiters',
  // Page one's URL, as every adapter builds it.
  buildRequestUrl: (token: string) => `https://fake.test/${token}?page=1`,
  // Each page parses to one posting per id; only atsJobId matters to these assertions.
  parse: (payload: unknown) => ({
    ok: true as const,
    postings: (payload as { ids: string[] }).ids.map((id) => ({ atsJobId: id }) as unknown as ParsedPosting),
    skipped: [],
  }),
  // The cursor: the page names its successor, null on the last page.
  nextPageUrl: (_token: string, payload: unknown) => (payload as { next: string | null }).next,
} as unknown as AtsAdapter;

// The board's robots.txt answer, separate from the page answer: the gate asks for it
// first, and every test below scripts it. 404 = the host publishes no robots file, which
// master-robots reads as permission, so the page-transport tests are not about robots.
// headers: extra response headers, e.g. a Retry-After for the 'wait' verdict test.
type RobotsAnswer = { status: number; body?: string; headers?: Record<string, string> };
// The no-robots-file default the pre-gate tests run under.
const NO_ROBOTS: RobotsAnswer = { status: 404 };
// Serve a robots answer as the real fetch would: text/plain, so master-robots' shape
// check treats a 200 body as a robots.txt and not as a soft-200 HTML page.
function robotsResponse(answer: RobotsAnswer): Response {
  // A real Response, like every other answer these doubles give.
  // Scripted headers are merged over the text/plain default, so a test can add a Retry-After.
  return new Response(answer.body ?? '', { status: answer.status, headers: { 'content-type': 'text/plain', ...answer.headers } });
}

// A fetch double that serves PAGES and records every URL it was asked for. It returns a
// real Response, the same type the real fetch returns, so `.ok` and `.json()` behave alike.
function fakeFetch(status = 200, robots: RobotsAnswer = NO_ROBOTS) {
  // URLs in request order, for the "page 2 was fetched" assertion.
  const requested: string[] = [];
  // The double itself.
  const impl = (url: string | URL | Request): Promise<Response> => {
    // Record what the transport asked for, robots.txt included: its count is the cache check.
    requested.push(String(url));
    // The gate's robots.txt request, answered with the scripted policy.
    if (String(url).endsWith('/robots.txt')) return Promise.resolve(robotsResponse(robots));
    // Serve the page as JSON with the chosen status.
    return Promise.resolve(new Response(JSON.stringify(PAGES[String(url)] ?? null), { status }));
  };
  // Both, so each test reads what it needs.
  return { impl: impl as typeof fetch, requested };
}

describe('readBoardPages', () => {
  it('reads every page: postings from both pages arrive and page 2 is fetched', async () => {
    const { impl, requested } = fakeFetch();
    // A fresh robots cache per test, so no verdict leaks in from another test.
    const result = await readBoardPages(FAKE_ADAPTER, 'acme', impl, new Map());
    // robots.txt ONCE for the origin, then both pages in cursor order.
    expect(requested).toEqual(['https://fake.test/robots.txt', 'https://fake.test/acme?page=1', 'https://fake.test/acme?page=2']);
    // A whole board, not page one.
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.postings.map((p) => p.atsJobId)).toEqual(['a1', 'a2', 'b1']);
    // Page one's payload is kept for the identity guard.
    expect(result.firstPayload).toEqual(PAGES['https://fake.test/acme?page=1']);
  });

  it('a non-ok page throws instead of being parsed', async () => {
    const { impl } = fakeFetch(404);
    // The throw is what routes the board into scout.ts's failure bookkeeping.
    await expect(readBoardPages(FAKE_ADAPTER, 'acme', impl, new Map())).rejects.toThrow(/HTTP 404/);
  });
});

// POST boards (Workday, 2026-11-01). The rule must match scout-ats's poll-fetch.ts: a
// body means POST JSON, no body means the unchanged GET, so the two scouts agree.
describe('readBoardPages request method', () => {
  // A fetch double that records every request init and answers one empty page.
  function capturingFetch() {
    // Inits in request order.
    const inits: RequestInit[] = [];
    // The double itself; a real Response, as the real fetch returns.
    const impl = (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      // The gate's robots.txt request is not a page: answer "no file", keep it out of inits.
      if (String(url).endsWith('/robots.txt')) return Promise.resolve(robotsResponse(NO_ROBOTS));
      // Keep exactly what the transport sent.
      inits.push(init ?? {});
      // One page that parses to nothing and names no successor.
      return Promise.resolve(new Response(JSON.stringify({ ids: [], next: null }), { status: 200 }));
    };
    // Both, for the assertions.
    return { impl: impl as typeof fetch, inits };
  }

  it('a page with a body is POSTed as JSON', async () => {
    // The fake adapter plus a body builder: its presence is what makes a board POST.
    const postAdapter = { ...FAKE_ADAPTER, requestBody: () => '{"offset":0}' } as AtsAdapter;
    // A fresh recorder for this test only.
    const { impl, inits } = capturingFetch();
    // One board read through the real transport.
    await readBoardPages(postAdapter, 'acme', impl, new Map());
    // One request: POST, JSON content type beside the usual headers, the body unchanged.
    expect(inits).toEqual([
      {
        // Workday's list endpoint answers anything but POST with 400.
        method: 'POST',
        // The two identity headers every page carries, plus the JSON declaration.
        headers: {
          // Every adapter parses JSON.
          Accept: 'application/json',
          // The scout's contactable identity, unchanged.
          'User-Agent': 'applyy-scout/1.0 (+https://github.com/MallamTeja/applyyy)',
          // Only on the POST path.
          'Content-Type': 'application/json',
        },
        // Passed through untouched.
        body: '{"offset":0}',
        // The page timeout (D5 drift #3, 2026-11-21): a hung socket fails the board, not the run.
        signal: expect.any(AbortSignal),
      },
    ]);
  });

  it('a page without a body is fetched exactly as before', async () => {
    // A fresh recorder for this test only.
    const { impl, inits } = capturingFetch();
    // The plain fake adapter has no requestBody, like every pre-Workday board.
    await readBoardPages(FAKE_ADAPTER, 'acme', impl, new Map());
    // Byte-identical to the pre-Workday init: headers only, no method, no body.
    expect(inits).toEqual([
      // The init the single-fetch code has always sent, plus the page timeout (D5 drift #3, 2026-11-21).
      { headers: { Accept: 'application/json', 'User-Agent': 'applyy-scout/1.0 (+https://github.com/MallamTeja/applyyy)' }, signal: expect.any(AbortSignal) },
    ]);
  });
});

// THE ROBOTS GATE (Teja, 2026-11-01: "Honor robots" for job-board reads). The worker
// cron scout read boards with no robots check, which is how 124 PhonePe SmartRecruiters
// jobs were scouted while scout-ats was refused. Both scouts now use master-robots'
// 'scouting' policy: a real Disallow refuses, a 401 robots.txt counts as no rules
// (RFC 9309; api.ashbyhq.com answers 401), and a 403 still refuses.
describe('readBoardPages robots gate (scouting policy)', () => {
  it('refuses a board whose robots.txt disallows it, before any page is requested', async () => {
    // api.smartrecruiters.com's live policy, measured 2026-11-01.
    const policy = ['User-agent: LinkedInBot', 'Allow: /v1/companies/', 'User-agent: *', 'Disallow: /'].join('\n');
    // Pages would answer 200; only robots.txt says no.
    const { impl, requested } = fakeFetch(200, { status: 200, body: policy });
    // A THROW, never { ok: true, postings: [] }: scout.ts's catch turns it into failureMark,
    // so a refused board counts as a failed poll and never reads as "0 jobs today".
    await expect(readBoardPages(FAKE_ADAPTER, 'acme', impl, new Map())).rejects.toBeInstanceOf(RobotsDisallowedError);
    // Non-vacuous both ways: the policy WAS fetched, and the board was NEVER contacted.
    expect(requested).toEqual(['https://fake.test/robots.txt']);
  });

  it('a 401 robots.txt allows the board read (the api.ashbyhq.com shape)', async () => {
    // An auth wall on robots.txt and nothing else, exactly what Ashby's API host answers.
    const { impl } = fakeFetch(200, { status: 401 });
    // Read in full under the scouting policy.
    const result = await readBoardPages(FAKE_ADAPTER, 'acme', impl, new Map());
    // A whole board, both pages.
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.postings.map((p) => p.atsJobId)).toEqual(['a1', 'a2', 'b1']);
  });

  it('a 403 robots.txt refuses the board read', async () => {
    // A host that blocks us outright; the 2026-11-01 ruling kept this a refusal.
    const { impl, requested } = fakeFetch(200, { status: 403 });
    // Refused before contact, like the Disallow case.
    await expect(readBoardPages(FAKE_ADAPTER, 'acme', impl, new Map())).rejects.toBeInstanceOf(RobotsDisallowedError);
    // Only the policy was asked for.
    expect(requested).toEqual(['https://fake.test/robots.txt']);
  });

  it('asks each origin for robots.txt once per run, however many boards share it', async () => {
    // One cache for the run, as the module default is for a real scout process.
    const cache = new Map();
    // Two boards on the same host, each two pages.
    const { impl, requested } = fakeFetch();
    await readBoardPages(FAKE_ADAPTER, 'acme', impl, cache);
    await readBoardPages(FAKE_ADAPTER, 'acme', impl, cache);
    // One robots.txt GET for four page requests.
    expect(requested.filter((u) => u.endsWith('/robots.txt'))).toHaveLength(1);
  });
});

// The worker's Workday detail read (2026-11-05, P1-3) goes through this one GET, so it must keep
// the board poll's robots gate: a Disallow is a throw before the target is contacted, which the
// fill (workday-detail.ts) counts as "no description", never as a failed board.
describe('robotsGatedGet', () => {
  // A detail URL on the fake origin.
  const DETAIL = 'https://fake.test/wday/cxs/acme/Careers/job/X/SDE_R-1';

  it('returns the Response for an allowed URL, after one robots.txt read', async () => {
    // No robots file: allowed.
    const { impl, requested } = fakeFetch();
    // A fresh verdict cache.
    const res = await robotsGatedGet(DETAIL, impl, new Map());
    // A Response, not parsed JSON: the fill reads text and refuses a soft-200 itself.
    expect(res).toBeInstanceOf(Response);
    // robots.txt first, then the target, nothing else.
    expect(requested).toEqual(['https://fake.test/robots.txt', DETAIL]);
  });

  it('refuses a Disallowed URL without ever contacting it', async () => {
    // The host disallows everything for every agent.
    const { impl, requested } = fakeFetch(200, { status: 200, body: 'User-agent: *\nDisallow: /\n' });
    // The refusal is the gate's own error type.
    await expect(robotsGatedGet(DETAIL, impl, new Map())).rejects.toBeInstanceOf(RobotsDisallowedError);
    // Only robots.txt was read; the posting never was.
    expect(requested).toEqual(['https://fake.test/robots.txt']);
  });
});

// ROBOTS "UNKNOWN, RETRY LATER" (2026-11-18, D1). The 11-18 07:35Z scout log: 43 Workday boards
// refused with "robots.txt returned 429 with no readable Retry-After", each one counted as a failed
// poll, so 62 of 64 Workday boards sat at consecutive_failures >= 5. Teja's design (22:27 IST): a 429
// or 5xx on robots.txt means the policy is UNKNOWN, so the board is skipped this run (still never
// fetched) and its failure count is left alone. A real Disallow must keep failing exactly as before.
describe('readBoardPages: robots.txt temporarily unavailable', () => {
  it('a robots.txt 429 throws RobotsUnavailableError, still a refusal, and the board is never contacted', async () => {
    // Pages would answer 200; robots.txt answers 429 with no Retry-After, the live shape.
    const { impl, requested } = fakeFetch(200, { status: 429 });
    // The read is refused...
    const err = await readBoardPages(FAKE_ADAPTER, 'acme', impl, new Map()).catch((e: unknown) => e);
    // ...with the "skip, don't count" type scout.ts branches on.
    expect(err).toBeInstanceOf(RobotsUnavailableError);
    // Still a RobotsDisallowedError, so any caller that only knows the parent type keeps failing closed.
    expect(err).toBeInstanceOf(RobotsDisallowedError);
    // The status that made it transient is carried, for the log line.
    expect((err as RobotsUnavailableError).status).toBe(429);
    // Never treated as "allowed": only robots.txt was requested, no page.
    expect(requested).toEqual(['https://fake.test/robots.txt']);
  });

  it('a robots.txt 429 with a short Retry-After (a wait verdict) is also skipped, never contacted', async () => {
    // Retry-After 2 s, under master-robots' 5 s ceiling: the gate answers 'wait', not 'refuse'.
    const { impl, requested } = fakeFetch(200, { status: 429, headers: { 'retry-after': '2' } });
    // The read is refused...
    const err = await readBoardPages(FAKE_ADAPTER, 'acme', impl, new Map()).catch((e: unknown) => e);
    // ...with the skip type, so a polite "come back in 2 s" is never counted as a failed poll.
    expect(err).toBeInstanceOf(RobotsUnavailableError);
    // The 'wait' path carries no status by construction (see RobotsUnavailableError.status).
    expect((err as RobotsUnavailableError).status).toBeNull();
    // Only robots.txt was requested: a wait is honoured by not touching the board.
    expect(requested).toEqual(['https://fake.test/robots.txt']);
  });

  it('a robots.txt 503 is also "unknown, retry later"', async () => {
    // A server error on robots.txt: the host did not answer the question.
    const { impl } = fakeFetch(200, { status: 503 });
    // Same skip type as the 429.
    await expect(readBoardPages(FAKE_ADAPTER, 'acme', impl, new Map())).rejects.toBeInstanceOf(RobotsUnavailableError);
  });

  it('a 200 Disallow still refuses as a plain failure, NOT as unavailable', async () => {
    // A published policy that forbids everything.
    const { impl } = fakeFetch(200, { status: 200, body: 'User-agent: *\nDisallow: /\n' });
    // The refusal...
    const err = await readBoardPages(FAKE_ADAPTER, 'acme', impl, new Map()).catch((e: unknown) => e);
    // ...is the parent type, so scout.ts counts it with failureMark...
    expect(err).toBeInstanceOf(RobotsDisallowedError);
    // ...and is never the skip type: a Disallow is an answer, not an unknown.
    expect(err).not.toBeInstanceOf(RobotsUnavailableError);
  });

  it('a robots.txt fetch that throws (timeout, DNS) stays a counted failure', async () => {
    // Every request throws, robots.txt included: there is no HTTP status to call transient.
    const impl = (async () => { throw new Error('Signal timed out'); }) as typeof fetch;
    // Refused...
    const err = await readBoardPages(FAKE_ADAPTER, 'acme', impl, new Map()).catch((e: unknown) => e);
    // ...as a plain refusal (the design names 429 and 5xx only).
    expect(err).toBeInstanceOf(RobotsDisallowedError);
    // Not skipped.
    expect(err).not.toBeInstanceOf(RobotsUnavailableError);
  });

  it('a cached 429 verdict still reads as unavailable for the next board on that origin', async () => {
    // One run cache shared by two boards on one host.
    const cache = new Map();
    // robots.txt answers 429.
    const { impl, requested } = fakeFetch(200, { status: 429 });
    // First board: fetched, 429, skipped.
    await expect(readBoardPages(FAKE_ADAPTER, 'acme', impl, cache)).rejects.toBeInstanceOf(RobotsUnavailableError);
    // Second board: served from the cache (no new robots GET), and still the skip type.
    await expect(readBoardPages(FAKE_ADAPTER, 'acme', impl, cache)).rejects.toBeInstanceOf(RobotsUnavailableError);
    // One robots.txt request in total: the cache, not a second 429, answered the second board.
    expect(requested.filter((u) => u.endsWith('/robots.txt'))).toHaveLength(1);
  });
});

// WORKDAY PACING (2026-11-18, D1 design point 3). Every *.myworkdayjobs.com tenant sits behind one
// Cloudflare zone (Server: cloudflare on every tenant, probed 11-18), so the gap is kept across the
// whole zone, not per tenant host. Other providers are never delayed.
describe('createRequestPacer', () => {
  // A fake clock and sleep: the pacer's only side effects, recorded instead of waited on.
  function fakeTime() {
    // Milliseconds since the test started.
    let nowMs = 0;
    // Every wait the pacer asked for.
    const sleeps: number[] = [];
    // Both seams plus the record.
    return {
      // The clock the pacer reads.
      now: () => nowMs,
      // A sleep that advances the clock instead of waiting.
      sleep: async (ms: number) => { sleeps.push(ms); nowMs += ms; },
      // Lets a test move time forward between requests.
      advance: (ms: number) => { nowMs += ms; },
      // The recorded waits.
      sleeps,
    };
  }

  it('spaces Workday requests by the gap, across tenants of the same zone', async () => {
    // Fresh time.
    const t = fakeTime();
    // A 1 s gap.
    const pacer = createRequestPacer(1_000, t.now, t.sleep);
    // First Workday request: nothing to wait for.
    await pacer.before('https://zendesk.wd1.myworkdayjobs.com/robots.txt');
    // 200 ms later, a page on the same tenant: waits the remaining 800 ms.
    t.advance(200);
    await pacer.before('https://zendesk.wd1.myworkdayjobs.com/wday/cxs/zendesk/zendesk/jobs');
    // Immediately after, a DIFFERENT tenant: still the same zone, so a full 1 s wait.
    await pacer.before('https://fractal.wd1.myworkdayjobs.com/robots.txt');
    // Exactly those two waits.
    expect(t.sleeps).toEqual([800, 1_000]);
  });

  it('never delays a non-Workday host', async () => {
    // Fresh time.
    const t = fakeTime();
    // A 1 s gap.
    const pacer = createRequestPacer(1_000, t.now, t.sleep);
    // Back-to-back Greenhouse and Lever requests.
    await pacer.before('https://boards-api.greenhouse.io/v1/boards/a/jobs');
    await pacer.before('https://boards-api.greenhouse.io/v1/boards/b/jobs');
    await pacer.before('https://api.lever.co/v0/postings/c');
    // No waits at all.
    expect(t.sleeps).toEqual([]);
  });

  it('readBoardPages paces the robots.txt GET and every page of a Workday board', async () => {
    // Fresh time.
    const t = fakeTime();
    // Every URL the pacer was asked about, in order.
    const paced: string[] = [];
    // A real pacer underneath, so the waits are the production arithmetic.
    const inner = createRequestPacer(1_000, t.now, t.sleep);
    // The pacer the transport gets: records, then delegates.
    const pacer = { before: async (url: string) => { paced.push(url); await inner.before(url); } };
    // The fake adapter moved onto a myworkdayjobs.com origin, same two-page shape.
    const adapter = {
      // Everything else from the fake adapter.
      ...FAKE_ADAPTER,
      // Page one on a Workday-zone host.
      buildRequestUrl: () => 'https://acme.wd1.myworkdayjobs.com/p1',
    } as unknown as AtsAdapter;
    // The two pages, keyed by URL.
    const pages: Record<string, unknown> = {
      // Page one names page two.
      'https://acme.wd1.myworkdayjobs.com/p1': { ids: ['a'], next: 'https://acme.wd1.myworkdayjobs.com/p2' },
      // Page two is the last.
      'https://acme.wd1.myworkdayjobs.com/p2': { ids: ['b'], next: null },
    };
    // 404 for robots.txt (no rules), JSON pages otherwise.
    const impl = (async (url: string | URL | Request) =>
      // The robots answer first.
      String(url).endsWith('/robots.txt') ? new Response('', { status: 404 }) : new Response(JSON.stringify(pages[String(url)]))) as typeof fetch;
    // Read the board through the recording pacer.
    await readBoardPages(adapter, 'acme', impl, new Map(), pacer);
    // robots.txt, then each page, all through the pacer.
    expect(paced).toEqual(['https://acme.wd1.myworkdayjobs.com/robots.txt', 'https://acme.wd1.myworkdayjobs.com/p1', 'https://acme.wd1.myworkdayjobs.com/p2']);
    // Two full-gap waits: the fake clock never advanced on its own.
    expect(t.sleeps).toEqual([1_000, 1_000]);
  });
});

// TEXT BOARDS (iCIMS, 2026-11-21). The adapter declares payloadFormat "text": its pages are a
// sitemap.xml and HTML detail pages. The orch's conditions, each pinned by a named test below:
// (1) an adapter that declares nothing still JSON-decodes, and a non-JSON body for it is an
//     error, never text; (3) every iCIMS request, sitemap and detail, passes the robots gate.
describe('readBoardPages: text boards (iCIMS)', () => {
  // Imported lazily so the suites above never depend on the adapter module.
  const loadIcims = async () => (await import('../../supabase/functions/_shared/scout/adapters/icims.ts')).icimsAdapter;
  // The Atlassian APAC tenant's origin.
  const ORIGIN = 'https://careers-apac-atlassian.icims.com';
  // Its robots.txt as recorded live on 2026-11-21, verbatim: job and sitemap paths are allowed.
  const ATLASSIAN_ROBOTS = [
    'User-agent: *', `Sitemap: ${ORIGIN}/sitemap.xml`,
    'Disallow: /jobs/*referral', 'Disallow: /jobs/referral', 'Disallow: /jobs/*login', 'Disallow: /jobs/login',
    'Disallow: /jobs/*candidate', 'Disallow: /jobs/candidate', 'Disallow: /jobs/reminder', 'Disallow: /connect',
    'Disallow: /connect/*interest', 'Disallow: /connect/interest', 'Disallow: /connect/*resume', 'Disallow: /connect/resume',
  ].join('\n');
  // A two-job sitemap in the recorded shape.
  const SITEMAP = `<?xml version='1.0' encoding='utf-8'?><urlset><url><loc>${ORIGIN}/jobs/intro</loc></url><url><loc>${ORIGIN}/jobs/27181/principal-forward-deployed-engineer/job</loc></url><url><loc>${ORIGIN}/jobs/26751/senior-software-engineer/job</loc></url></urlset>`;
  // A detail page carrying the recorded JSON-LD shape for one job.
  const detail = (id: string, title: string) =>
    `<html><head><script type="application/ld+json">${JSON.stringify({ '@type': 'JobPosting', title, url: `${ORIGIN}/jobs/${id}/x/job`, datePosted: '2026-09-24T04:00:00.000Z', jobLocation: [{ address: { addressLocality: 'Bengaluru', addressCountry: 'IN', addressRegion: 'UNAVAILABLE' } }] })}</script></head></html>`;
  // The tenant's pages, as fetch receives them (no fragment).
  const PAGES: Record<string, string> = {
    [`${ORIGIN}/sitemap.xml`]: SITEMAP,
    [`${ORIGIN}/jobs/27181/job?in_iframe=1`]: detail('27181', 'Principal Forward Deployed Engineer'),
    [`${ORIGIN}/jobs/26751/job?in_iframe=1`]: detail('26751', 'Senior Software Engineer'),
  };
  // A fetch double that serves the given robots.txt and the pages, recording each URL and its Accept header.
  function icimsFetch(robots: string) {
    // [url, Accept] in request order.
    const requests: Array<[string, string | undefined]> = [];
    // The double; real Responses, as the real fetch returns.
    const impl = (async (url: string | URL | Request, init?: RequestInit) => {
      // What fetch actually sends: no fragment.
      const sent = String(url).split('#')[0]!;
      // The header the transport chose for this request.
      requests.push([sent, (init?.headers as Record<string, string> | undefined)?.['Accept']]);
      // robots.txt as text/plain, so master-robots reads it as a robots file.
      if (sent.endsWith('/robots.txt')) return robotsResponse({ status: 200, body: robots });
      // A known page, or a 404 for anything the adapter should not have asked for.
      return PAGES[sent] === undefined ? new Response('nope', { status: 404 }) : new Response(PAGES[sent], { status: 200, headers: { 'content-type': 'text/html' } });
    }) as typeof fetch;
    // Both, so each test reads what it needs.
    return { impl, requests };
  }
  // A pacer that never waits, so these tests are about the transport, not the clock.
  const noPace = { before: async () => {} };

  it('reads an iCIMS board as text: robots once, the sitemap, then each detail page, asking for HTML/XML', async () => {
    // The real adapter and the recorded robots.
    const adapter = await loadIcims();
    const { impl, requests } = icimsFetch(ATLASSIAN_ROBOTS);
    // The whole board through the worker transport.
    const result = await readBoardPages(adapter, 'careers-apac-atlassian', impl, new Map(), noPace);
    // Both jobs, as postings with their real titles and spelled-out country.
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.postings.map((p) => [p.atsJobId, p.title, p.locationRaw])).toEqual([
      ['27181', 'Principal Forward Deployed Engineer', 'Bengaluru, India'],
      ['26751', 'Senior Software Engineer', 'Bengaluru, India'],
    ]);
    // robots.txt first and once, then every page; pages ask for text, never JSON.
    expect(requests.map(([u]) => u)).toEqual([`${ORIGIN}/robots.txt`, ...Object.keys(PAGES)]);
    expect(requests.slice(1).every(([, accept]) => accept !== undefined && accept.startsWith('text/html'))).toBe(true);
  });

  it('condition 3: a tenant whose robots.txt is Disallow: / (careers-amd) is refused before the sitemap is requested', async () => {
    // careers-amd.icims.com's recorded robots.txt, served for the Atlassian origin.
    const adapter = await loadIcims();
    const { impl, requests } = icimsFetch('User-agent: *\nDisallow: /\n');
    // The gate's typed refusal.
    await expect(readBoardPages(adapter, 'careers-apac-atlassian', impl, new Map(), noPace)).rejects.toBeInstanceOf(RobotsDisallowedError);
    // Only robots.txt was ever contacted.
    expect(requests.map(([u]) => u)).toEqual([`${ORIGIN}/robots.txt`]);
  });

  it('condition 3: detail pages pass the gate too (a robots rule on /jobs/ stops the read after the sitemap)', async () => {
    // A tenant allowing its sitemap but not its job pages.
    const adapter = await loadIcims();
    const { impl, requests } = icimsFetch('User-agent: *\nDisallow: /jobs/\n');
    // Refused at the first detail page, by the same gate.
    await expect(readBoardPages(adapter, 'careers-apac-atlassian', impl, new Map(), noPace)).rejects.toBeInstanceOf(RobotsDisallowedError);
    // The sitemap was read; no job page was ever contacted.
    expect(requests.map(([u]) => u)).toEqual([`${ORIGIN}/robots.txt`, `${ORIGIN}/sitemap.xml`]);
  });

  it('condition 1: an adapter that declares no format still sends Accept: application/json and decodes JSON', async () => {
    // The JSON fake adapter from the top of this file declares no payloadFormat.
    const { impl } = fakeFetch();
    // The Accept header of every page request, for the assertion.
    const accepts: Array<string | undefined> = [];
    // Wrap the double to read the header the transport chose.
    const spy = ((url: string | URL | Request, init?: RequestInit) => {
      // Pages only: robots.txt is fetched with its own headers.
      if (!String(url).endsWith('/robots.txt')) accepts.push((init?.headers as Record<string, string> | undefined)?.['Accept']);
      // Delegate.
      return impl(url);
    }) as typeof fetch;
    // A whole JSON board, decoded as before.
    const result = await readBoardPages(FAKE_ADAPTER, 'acme', spy, new Map());
    expect(result.ok && result.postings.map((p) => p.atsJobId)).toEqual(['a1', 'a2', 'b1']);
    // Both pages asked for JSON.
    expect(accepts).toEqual(['application/json', 'application/json']);
  });

  it('condition 1: a non-JSON body for a JSON adapter is an error, never empty text', async () => {
    // A 200 HTML page where a JSON board's page should be (a soft-200 error page).
    const impl = (async (url: string | URL | Request) =>
      // No robots file, then HTML for the page.
      String(url).endsWith('/robots.txt') ? robotsResponse(NO_ROBOTS) : new Response('<html>maintenance</html>', { status: 200 })) as typeof fetch;
    // res.json() throws; the board is failed by scout.ts's catch, never parsed as text or empty.
    await expect(readBoardPages(FAKE_ADAPTER, 'acme', impl, new Map())).rejects.toThrow(SyntaxError);
  });

  it('paces iCIMS requests in their own lane, across tenants of the zone', async () => {
    // A fake clock: waits are recorded, not slept.
    let nowMs = 0;
    // Every wait the pacer asked for.
    const sleeps: number[] = [];
    // A 1 s gap, the production value.
    const pacer = createRequestPacer(1_000, () => nowMs, async (ms) => { sleeps.push(ms); nowMs += ms; });
    // Two tenants back to back: same zone, so the second waits the full gap.
    await pacer.before(`${ORIGIN}/sitemap.xml`);
    await pacer.before('https://indiacareers-symplr.icims.com/sitemap.xml');
    // A Workday request right after is in ANOTHER lane: no wait from the iCIMS requests.
    await pacer.before('https://acme.wd1.myworkdayjobs.com/robots.txt');
    // Exactly one wait.
    expect(sleeps).toEqual([1_000]);
  });
});

// D5 drift #3 (2026-11-21): a board page had NO timeout, so one hung Workday/iCIMS socket stalled the
// whole CLI run until its 12-minute budget and every later board was skipped. The page now carries the
// edge transport's per-attempt timeout, and a timeout is a COUNTED page failure, never a robots skip.
describe('readBoardPages: page timeout (D5 drift #3)', () => {
  it('the board page timeout equals the edge transport timeout (one number for both scouts)', () => {
    // The worker's value is the edge's constant itself, so the two cannot drift apart.
    expect(BOARD_PAGE_TIMEOUT_MS).toBe(DEFAULT_TIMEOUT_MS);
  });

  it('every board page is sent with an abort signal', async () => {
    // The signal each page request carried.
    const signals: unknown[] = [];
    // Robots: no file; pages: one empty page, recording the init's signal.
    const impl = ((url: string | URL | Request, init?: RequestInit) => {
      // The gate's robots.txt read is not a page.
      if (String(url).endsWith('/robots.txt')) return Promise.resolve(robotsResponse(NO_ROBOTS));
      // What the page request carried.
      signals.push(init?.signal);
      // One page that parses to nothing.
      return Promise.resolve(new Response(JSON.stringify({ ids: [], next: null }), { status: 200 }));
    }) as typeof fetch;
    // One board read.
    await readBoardPages(FAKE_ADAPTER, 'acme', impl, new Map());
    // One page, with a real AbortSignal on it.
    expect(signals).toHaveLength(1);
    expect(signals[0]).toBeInstanceOf(AbortSignal);
  });

  it('a page timeout is a counted failure (a throw that is NOT a robots refusal)', async () => {
    // Robots allow; the page aborts the way AbortSignal.timeout does (a TimeoutError DOMException).
    const impl = ((url: string | URL | Request) => {
      // No robots file: the board is allowed.
      if (String(url).endsWith('/robots.txt')) return Promise.resolve(robotsResponse(NO_ROBOTS));
      // The page times out.
      return Promise.reject(new DOMException('The operation was aborted due to timeout', 'TimeoutError'));
    }) as typeof fetch;
    // Caught, so its type can be asserted.
    const err = await readBoardPages(FAKE_ADAPTER, 'acme', impl, new Map()).then(() => null, (e: unknown) => e);
    // Thrown, so scout.ts's generic catch writes failureMark...
    expect(err).not.toBeNull();
    // ...and NOT the robots skip type that catch would defer uncounted.
    expect(err).not.toBeInstanceOf(RobotsDisallowedError);
  });
});

// The 2-UA finding (2026-11-21 egress probe): robots.txt went out as the bare product token
// "applyy-scout" while every page sent "applyy-scout/1.0 (+repo)". One honest, contactable identity
// for every request now; robots GROUP matching still uses the token derived from that header.
describe('robots.txt identity (one UA for every request)', () => {
  // The scout's full, contactable User-Agent, exactly as every page sends it.
  const FULL_UA = 'applyy-scout/1.0 (+https://github.com/MallamTeja/applyyy)';

  it('robots.txt is requested with the same full contact User-Agent the pages use', async () => {
    // The headers the robots.txt GET carried.
    let robotsHeaders: Record<string, string> | undefined;
    // Robots: recorded, then "no file"; pages: one empty page.
    const impl = ((url: string | URL | Request, init?: RequestInit) => {
      // The robots read: keep its headers.
      if (String(url).endsWith('/robots.txt')) {
        // master-robots passes a plain record.
        robotsHeaders = init?.headers as Record<string, string>;
        // No file.
        return Promise.resolve(robotsResponse(NO_ROBOTS));
      }
      // One page that parses to nothing.
      return Promise.resolve(new Response(JSON.stringify({ ids: [], next: null }), { status: 200 }));
    }) as typeof fetch;
    // One board read.
    await readBoardPages(FAKE_ADAPTER, 'acme', impl, new Map());
    // Exactly one user-agent entry (any casing), and it is the full contact UA.
    const uaEntries = Object.entries(robotsHeaders ?? {}).filter(([k]) => k.toLowerCase() === 'user-agent');
    expect(uaEntries).toEqual([['user-agent', FULL_UA]]);
  });

  it('a robots group named for the token "applyy-scout" still matches (and refuses) under the full UA', async () => {
    // A policy that disallows only this scout, by its product token.
    const { impl, requested } = fakeFetch(200, { status: 200, body: 'User-agent: applyy-scout\nDisallow: /\n\nUser-agent: *\nDisallow:' });
    // Refused by the named group, as a real Disallow (not the unavailable skip).
    const err = await readBoardPages(FAKE_ADAPTER, 'acme', impl, new Map()).then(() => null, (e: unknown) => e);
    // A refusal...
    expect(err).toBeInstanceOf(RobotsDisallowedError);
    // ...that is an answer, so it is counted.
    expect(err).not.toBeInstanceOf(RobotsUnavailableError);
    // And no page was requested: only robots.txt.
    expect(requested).toEqual(['https://fake.test/robots.txt']);
  });
});
