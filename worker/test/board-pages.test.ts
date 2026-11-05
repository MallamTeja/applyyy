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
import { readBoardPages, robotsGatedGet } from '../src/scout/board-pages.ts';
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
type RobotsAnswer = { status: number; body?: string };
// The no-robots-file default the pre-gate tests run under.
const NO_ROBOTS: RobotsAnswer = { status: 404 };
// Serve a robots answer as the real fetch would: text/plain, so master-robots' shape
// check treats a 200 body as a robots.txt and not as a soft-200 HTML page.
function robotsResponse(answer: RobotsAnswer): Response {
  // A real Response, like every other answer these doubles give.
  return new Response(answer.body ?? '', { status: answer.status, headers: { 'content-type': 'text/plain' } });
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
      // Exactly the init the single-fetch code has always sent.
      { headers: { Accept: 'application/json', 'User-Agent': 'applyy-scout/1.0 (+https://github.com/MallamTeja/applyyy)' } },
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
