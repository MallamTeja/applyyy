// Tests for the CLI scout's board transport (worker/src/scout/board-pages.ts).
//
// The CLI used to read ONE response per board. Since SmartRecruiters was registered
// (7f5b120), that silently stored page 1 only: Nagarro listed 100 of its 585 postings.
// These tests pin the two properties the transport owns: every page is read, and a
// non-ok page THROWS (so scout.ts's catch records a failed board) instead of reaching
// the parser as a body that might parse as an empty board.
import { describe, expect, it } from 'vitest';
// The unit under test.
import { readBoardPages } from '../src/scout/board-pages.ts';
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

// A fetch double that serves PAGES and records every URL it was asked for. It returns a
// real Response, the same type the real fetch returns, so `.ok` and `.json()` behave alike.
function fakeFetch(status = 200) {
  // URLs in request order, for the "page 2 was fetched" assertion.
  const requested: string[] = [];
  // The double itself.
  const impl = (url: string | URL | Request): Promise<Response> => {
    // Record what the transport asked for.
    requested.push(String(url));
    // Serve the page as JSON with the chosen status.
    return Promise.resolve(new Response(JSON.stringify(PAGES[String(url)] ?? null), { status }));
  };
  // Both, so each test reads what it needs.
  return { impl: impl as typeof fetch, requested };
}

describe('readBoardPages', () => {
  it('reads every page: postings from both pages arrive and page 2 is fetched', async () => {
    const { impl, requested } = fakeFetch();
    const result = await readBoardPages(FAKE_ADAPTER, 'acme', impl);
    // Both URLs were requested, in cursor order.
    expect(requested).toEqual(['https://fake.test/acme?page=1', 'https://fake.test/acme?page=2']);
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
    await expect(readBoardPages(FAKE_ADAPTER, 'acme', impl)).rejects.toThrow(/HTTP 404/);
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
    const impl = (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
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
    await readBoardPages(postAdapter, 'acme', impl);
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
    await readBoardPages(FAKE_ADAPTER, 'acme', impl);
    // Byte-identical to the pre-Workday init: headers only, no method, no body.
    expect(inits).toEqual([
      // Exactly the init the single-fetch code has always sent.
      { headers: { Accept: 'application/json', 'User-Agent': 'applyy-scout/1.0 (+https://github.com/MallamTeja/applyyy)' } },
    ]);
  });
});
