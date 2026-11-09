// The ATS-aware "is this posting still listed?" check (2026-11-09). Why it exists: Cursor's whole hosted Ashby
// board (jobs.ashbyhq.com/cursor) answers HTTP 404, yet Ashby's public posting API lists its jobs, including
// ce965450's "Forward Deployed Engineer - India" with isListed:true. The applier and the kit read that 404 as
// "posting closed". On Ashby, the hosted page's status is not evidence; the posting API is.
import { describe, expect, it } from 'vitest';
// The module under test: the URL parser and the check over an injected JSON fetch.
import { ashbyPostingRef, createListingCheck } from '../src/posting-listing.ts';
// The production fetch port's type, so the fakes below cannot drift from it.
import type { FetchJson } from '../src/form-url.ts';

// Cursor's real ids, as measured on 2026-11-09.
const BOARD = 'cursor';
// The listed job.
const JOB = '166c3951-1d2a-4e61-b79b-bedefe96073b';
// The stored apply_url shape (Ashby's own applyUrl for the job).
const APPLY_URL = `https://jobs.ashbyhq.com/${BOARD}/${JOB}/application`;

/** A fake fetch that answers one fixed response and records the URLs asked. */
function fakeFetch(status: number, body: unknown): { fetchJson: FetchJson; asked: string[] } {
  // Every URL requested, so a test can prove the API (and only the API) was asked.
  const asked: string[] = [];
  // The port: one canned answer.
  const fetchJson: FetchJson = async (url) => {
    // Recorded first.
    asked.push(url);
    // The canned response.
    return { status, body };
  };
  // Both, for the assertions.
  return { fetchJson, asked };
}

describe('ashbyPostingRef', () => {
  it('reads board and job id from the job page and from its /application form', () => {
    // The /application form, as stored.
    expect(ashbyPostingRef(APPLY_URL)).toEqual({ board: BOARD, id: JOB });
    // The job page (Ashby's jobUrl), same answer.
    expect(ashbyPostingRef(`https://jobs.ashbyhq.com/${BOARD}/${JOB}`)).toEqual({ board: BOARD, id: JOB });
  });

  it('is null for any other host, a board root, a non-uuid id, or a non-URL', () => {
    // Greenhouse: no posting API here (its status signals stay in force).
    expect(ashbyPostingRef('https://job-boards.greenhouse.io/canonical/jobs/3290946')).toBeNull();
    // A look-alike host is not Ashby.
    expect(ashbyPostingRef(`https://jobs.ashbyhq.com.evil.test/${BOARD}/${JOB}`)).toBeNull();
    // The board root names no job.
    expect(ashbyPostingRef(`https://jobs.ashbyhq.com/${BOARD}`)).toBeNull();
    // A path segment that is not a uuid is never pasted into a lookup.
    expect(ashbyPostingRef(`https://jobs.ashbyhq.com/${BOARD}/not-a-uuid/application`)).toBeNull();
    // Not a URL at all.
    expect(ashbyPostingRef('jobs.ashbyhq.com/cursor')).toBeNull();
  });
});

describe('createListingCheck', () => {
  it('listed: the board API names the job id, so a 404 hosted page is NOT closed (Cursor ce965450)', async () => {
    // Cursor's real shape: 200, a jobs array, the id present among others.
    const { fetchJson, asked } = fakeFetch(200, { jobs: [{ id: 'other' }, { id: JOB, isListed: true }] });
    // The verdict.
    expect(await createListingCheck(fetchJson)(APPLY_URL)).toEqual({ kind: 'listed' });
    // Asked the public posting API for exactly that board.
    expect(asked).toEqual([`https://api.ashbyhq.com/posting-api/job-board/${BOARD}`]);
  });

  it('absent: a well-formed listing without the id is closed, with evidence naming the board and id', async () => {
    // 200 and a real jobs array that no longer carries the job.
    const { fetchJson } = fakeFetch(200, { jobs: [{ id: 'other' }] });
    // Closed, and says how it knows.
    expect(await createListingCheck(fetchJson)(APPLY_URL)).toEqual({ kind: 'absent', evidence: expect.stringMatching(new RegExp(`no longer lists ${JOB}.*${BOARD}`)) });
  });

  it('absent also when the job is present but isListed is false (unlisted = not open for applications)', async () => {
    // Ashby keeps unlisted jobs out of the board; the flag is the board's own word.
    const { fetchJson } = fakeFetch(200, { jobs: [{ id: JOB, isListed: false }] });
    // Closed.
    expect((await createListingCheck(fetchJson)(APPLY_URL)).kind).toBe('absent');
  });

  it('unknown, never absent: a non-200, a body without a jobs array, or a network failure (CLAUDE.md §6)', async () => {
    // A 404 from the API (board renamed, or the API down) proves nothing about the job.
    expect((await createListingCheck(fakeFetch(404, null).fetchJson)(APPLY_URL)).kind).toBe('unknown');
    // A soft-200 HTML page read as JSON comes back null: no listing, so no verdict.
    expect((await createListingCheck(fakeFetch(200, null).fetchJson)(APPLY_URL)).kind).toBe('unknown');
    // An object that is not the listing shape.
    expect((await createListingCheck(fakeFetch(200, { error: 'x' }).fetchJson)(APPLY_URL)).kind).toBe('unknown');
    // A throw (timeout, DNS) is "could not ask", not "gone".
    expect((await createListingCheck(async () => { throw new Error('timeout'); })(APPLY_URL)).kind).toBe('unknown');
  });

  it('no_api: a non-Ashby URL asks nothing', async () => {
    // A fetch that records.
    const { fetchJson, asked } = fakeFetch(200, { jobs: [] });
    // Greenhouse is not judged here.
    expect(await createListingCheck(fetchJson)('https://job-boards.greenhouse.io/canonical/jobs/3290946')).toEqual({ kind: 'no_api' });
    // And no request was made.
    expect(asked).toEqual([]);
  });
});
