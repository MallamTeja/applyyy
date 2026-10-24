// The embedded-form resolver (2026-10-24): a company careers page that iframes Greenhouse
// (aiven.io/careers/job/<id>?gh_jid=<id>) has no form of its own, so the kit read 0 fields and
// the applier parked it as unsupported_form. These tests pin the one rule: resolve to the
// Greenhouse embed form ONLY when the board token is known AND Greenhouse itself confirms the
// job is on that board under the same company name. Anything else returns the URL unchanged.
//
// The fixtures are the live Aiven facts measured on 2026-10-24: watchlist token 'aiven36',
// job 4901533101, and the boards-api job JSON (id + company_name "Aiven").

// vitest, as every worker test.
import { describe, expect, test } from 'vitest';
// The module under test.
import { createFormUrlResolver, type BoardLookup, type FetchJson } from '../src/form-url.ts';

// The live Aiven apply URL: the company page that iframes the form.
const AIVEN_URL = 'https://aiven.io/careers/job/4901533101?gh_jid=4901533101';
// The embed form Greenhouse serves for that job, measured 200 with no redirect.
const AIVEN_FORM = 'https://job-boards.greenhouse.io/embed/job_app?for=aiven36&token=4901533101';
// The application id the lookup is keyed by.
const ROW_ID = '0fcd296f-f23b-42ff-b513-8a861f36915b';

// A lookup that knows Aiven's board, and counts its calls.
function lookupOf(board: Awaited<ReturnType<BoardLookup>>): BoardLookup & { calls: number } {
  // The counter, so a test can prove the DB is not asked for URLs without gh_jid.
  const fn = Object.assign(async () => {
    // One more call.
    fn.calls += 1;
    // The configured answer.
    return board;
  }, { calls: 0 });
  // Typed for the resolver.
  return fn;
}

// A fetch that answers one URL with one response, and records what was asked.
function fetchOf(status: number, body: unknown): FetchJson & { urls: string[] } {
  // Every URL asked, for the "API was used" assertion.
  const urls: string[] = [];
  // The fake.
  const fn = Object.assign(async (url: string) => {
    // Recorded.
    urls.push(url);
    // The configured answer.
    return { status, body };
  }, { urls });
  // Typed for the resolver.
  return fn;
}

// Greenhouse's job JSON for the Aiven job, trimmed to the fields the check reads.
const aivenJob = { id: 4901533101, title: 'Software Engineer, Aiven Context', company_name: 'Aiven', absolute_url: AIVEN_URL };

describe('createFormUrlResolver', () => {
  test('gh_jid + known token + matching board → the Greenhouse embed form', async () => {
    // The live facts.
    const fetchJson = fetchOf(200, aivenJob);
    // Resolved.
    const url = await createFormUrlResolver(lookupOf({ token: 'aiven36', companyName: 'Aiven' }), fetchJson)({ id: ROW_ID, applyUrl: AIVEN_URL });
    // The hosted form, exactly.
    expect(url).toBe(AIVEN_FORM);
    // Verified against the board's own API for that exact job.
    expect(fetchJson.urls).toEqual(['https://boards-api.greenhouse.io/v1/boards/aiven36/jobs/4901533101']);
  });

  test('company names compare case- and space-insensitively', async () => {
    // Same company, different casing in our row.
    const url = await createFormUrlResolver(lookupOf({ token: 'aiven36', companyName: ' aiven ' }), fetchOf(200, aivenJob))({ id: ROW_ID, applyUrl: AIVEN_URL });
    // Still resolved.
    expect(url).toBe(AIVEN_FORM);
  });

  test('unknown token → unchanged, and the API is never asked', async () => {
    // No watchlist row for this company.
    const fetchJson = fetchOf(200, aivenJob);
    // Resolved against nothing.
    const url = await createFormUrlResolver(lookupOf(null), fetchJson)({ id: ROW_ID, applyUrl: AIVEN_URL });
    // Today's behaviour: the original URL.
    expect(url).toBe(AIVEN_URL);
    // No guess was verified, because none was made.
    expect(fetchJson.urls).toEqual([]);
  });

  test('board name mismatch → unchanged (a guessed token on someone else\'s board)', async () => {
    // The token points at a board whose job is another company's.
    const url = await createFormUrlResolver(lookupOf({ token: 'aiven36', companyName: 'Aiven' }), fetchOf(200, { ...aivenJob, company_name: 'Thornbury' }))({ id: ROW_ID, applyUrl: AIVEN_URL });
    // Never sent to the wrong company's form.
    expect(url).toBe(AIVEN_URL);
  });

  test('job not on that board (404) → unchanged', async () => {
    // Greenhouse says the job is not on this board.
    const url = await createFormUrlResolver(lookupOf({ token: 'aiven36', companyName: 'Aiven' }), fetchOf(404, null))({ id: ROW_ID, applyUrl: AIVEN_URL });
    // Unchanged.
    expect(url).toBe(AIVEN_URL);
  });

  test('API answers a different job id → unchanged', async () => {
    // A 200 for a different job must not pass as this one.
    const url = await createFormUrlResolver(lookupOf({ token: 'aiven36', companyName: 'Aiven' }), fetchOf(200, { ...aivenJob, id: 1 }))({ id: ROW_ID, applyUrl: AIVEN_URL });
    // Unchanged.
    expect(url).toBe(AIVEN_URL);
  });

  test('malformed API body → unchanged', async () => {
    // Each is a 200 that does not prove the job: soft-200 HTML, missing name, wrong types.
    for (const body of [null, '<html>', {}, { id: '4901533101', company_name: 'Aiven' }, { id: 4901533101 }, { id: 4901533101, company_name: '' }]) {
      // Resolved against a body that proves nothing.
      const url = await createFormUrlResolver(lookupOf({ token: 'aiven36', companyName: 'Aiven' }), fetchOf(200, body))({ id: ROW_ID, applyUrl: AIVEN_URL });
      // Unchanged every time.
      expect(url, JSON.stringify(body)).toBe(AIVEN_URL);
    }
  });

  test('malformed gh_jid → unchanged, and the DB is never asked', async () => {
    // Shapes a lenient Number() would accept or a template would paste into a URL.
    for (const jid of ['12a', '', ' 123', '1e5', '-5', '0x10', '123/../x']) {
      // Counted lookup.
      const lookup = lookupOf({ token: 'aiven36', companyName: 'Aiven' });
      // The bad id, URL-encoded as a real query would carry it.
      const url = await createFormUrlResolver(lookup, fetchOf(200, aivenJob))({ id: ROW_ID, applyUrl: `https://aiven.io/careers/job/x?gh_jid=${encodeURIComponent(jid)}` });
      // Unchanged.
      expect(url, jid).toBe(`https://aiven.io/careers/job/x?gh_jid=${encodeURIComponent(jid)}`);
      // Rejected before any read.
      expect(lookup.calls, jid).toBe(0);
    }
  });

  test('a URL without gh_jid is untouched and costs no read', async () => {
    // An ordinary hosted Greenhouse URL, and an unparseable string.
    for (const applyUrl of ['https://job-boards.greenhouse.io/gitlab/jobs/8775507002', 'not a url']) {
      // Counted lookup.
      const lookup = lookupOf({ token: 'gitlab', companyName: 'GitLab' });
      // Resolved.
      const url = await createFormUrlResolver(lookup, fetchOf(200, aivenJob))({ id: ROW_ID, applyUrl });
      // Unchanged.
      expect(url).toBe(applyUrl);
      // No DB read for the common case.
      expect(lookup.calls).toBe(0);
    }
  });

  test('a token that is not a plain slug → unchanged (never pasted into a path)', async () => {
    // A stored token with a path separator.
    const fetchJson = fetchOf(200, aivenJob);
    // Resolved.
    const url = await createFormUrlResolver(lookupOf({ token: 'aiven36/../x', companyName: 'Aiven' }), fetchJson)({ id: ROW_ID, applyUrl: AIVEN_URL });
    // Unchanged, and never fetched.
    expect(url).toBe(AIVEN_URL);
    // Nothing asked.
    expect(fetchJson.urls).toEqual([]);
  });

  test('a lookup or fetch that throws → unchanged, not a crash', async () => {
    // A failing DB read.
    const failingLookup: BoardLookup = async () => { throw new Error('read failed'); };
    // Unchanged.
    expect(await createFormUrlResolver(failingLookup, fetchOf(200, aivenJob))({ id: ROW_ID, applyUrl: AIVEN_URL })).toBe(AIVEN_URL);
    // A network drop.
    const failingFetch: FetchJson = async () => { throw new Error('ECONNRESET'); };
    // Unchanged.
    expect(await createFormUrlResolver(lookupOf({ token: 'aiven36', companyName: 'Aiven' }), failingFetch)({ id: ROW_ID, applyUrl: AIVEN_URL })).toBe(AIVEN_URL);
  });
});
