/* Gone postings leave the Approval queue on the next load (S41b, 2026-11-24), and the card that still shows
 * one says so with a one-click Reject (dead-posting card Part 1, 2026-11-23).
 *
 * WHY. Teja approved Commvault 5daf4908 six days after its posting left the board: the liveness sweep had set
 * jobs.disappeared_at, and /approvals neither showed it nor hid the row. readQueue (queuePrefetch.ts) is the one
 * read behind both the page and the shell prefetch, so the filter lives there and these tests drive it.
 *
 * HOW. The read runs through a REAL supabase-js client whose fetch is captured, so the assertions read the exact
 * PostgREST URL the browser would send, not a source-text regex. No network: the captured fetch answers [] itself.
 * RED-ON-REVERT: drop `.is('jobs.disappeared_at', null)` and test 1 goes red; drop `!inner` and test 2 goes red. */

// The .tsx loader and extensionless-import resolver; first, so it is in place before any src module loads.
import './support/registerTsxHooks.ts';
// Strict asserts.
import assert from 'node:assert/strict';
// The runner; before() loads the modules once the hooks are registered.
import { before, describe, it } from 'node:test';
// The real client, so the URL under test is the one supabase-js actually builds.
import { createClient } from '@supabase/supabase-js';

// The read under test, loaded after the hooks (its imports are extensionless).
let prefetch: typeof import('../src/features/approval/queuePrefetch.ts');
// The page module, for the posting-gone note and notice.
let page: typeof import('../src/features/approval/ApprovalQueuePage.tsx');
// Server rendering, so the notice is checked as real markup.
let render: (element: unknown) => string;
// React's element factory, to build the notice without JSX in a .ts file.
let h: typeof import('react').createElement;

before(async () => {
  // Dynamic, so the hooks registered by the first import are active when these resolve.
  prefetch = await import('../src/features/approval/queuePrefetch.ts');
  // Same reason; the page imports .tsx siblings.
  page = await import('../src/features/approval/ApprovalQueuePage.tsx');
  // react-dom/server's static renderer: no DOM needed.
  render = (await import('react-dom/server')).renderToStaticMarkup as (element: unknown) => string;
  // The factory the notice is built with.
  h = (await import('react')).createElement;
});

/* Runs readQueue on a real client and returns the applications request's URL. The fetch answers every call with
   an empty JSON array, as PostgREST does for an empty result, so supabase-js resolves { data, error } normally. */
async function queueUrl(): Promise<URL> {
  // Every URL the client asked for.
  const seen: URL[] = [];
  // A real client on a fake project; the key's content is irrelevant to the URL built.
  const client = createClient('https://example.supabase.co', 'anon-key-for-tests', {
    // No session persistence: node has no localStorage, and the read needs none.
    auth: { persistSession: false, autoRefreshToken: false },
    // The captured fetch: records the URL and answers 200 [] (an empty result, never a throw).
    global: { fetch: async (input: RequestInfo | URL) => { seen.push(new URL(String(input instanceof Request ? input.url : input))); return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } }); } },
  });
  // Both reads, as the page and the prefetch send them.
  await prefetch.readQueue(client);
  // The applications read, told apart from the master read by its path.
  const url = seen.find((u) => u.pathname.endsWith('/rest/v1/applications'));
  // A missing read would make every assertion below vacuous.
  assert.ok(url, 'readQueue sent no applications read');
  // The one URL the tests read.
  return url;
}

describe('gone postings leave the queue (S41b)', () => {
  it('filters out rows whose job has disappeared_at set (jobs.disappeared_at=is.null)', async () => {
    // The filter PostgREST applies to the embedded jobs row.
    assert.equal((await queueUrl()).searchParams.get('jobs.disappeared_at'), 'is.null');
  });

  it('embeds jobs with !inner, so the embed filter drops the ROW and not just the embed', async () => {
    // Without !inner PostgREST nulls the embed and keeps the application row: the gone job would still show.
    // supabase-js strips the select's whitespace, hence "," with no space.
    assert.match((await queueUrl()).searchParams.get('select') ?? '', /(^|,)jobs:job_id!inner\(/);
  });

  it('still reads only awaiting_approval rows', async () => {
    // The status filter the queue has always had; guards the edit around it.
    assert.equal((await queueUrl()).searchParams.get('status'), 'eq.awaiting_approval');
  });
});

describe('a card already open says the posting is gone (Part 1)', () => {
  it('words a real disappeared_at as the day it was seen gone', () => {
    // The sweep's timestamptz shape, as the jobs embed returns it.
    assert.equal(page.postingTakenDownNote('2026-11-17T08:12:00.123456+00:00'), "This posting was taken down: it has been gone from the company's job board since 2026-11-17.");
  });

  it('claims nothing for null, junk or a non-string', () => {
    // Live posting: no notice.
    assert.equal(page.postingTakenDownNote(null), null);
    // A lenient parser would read "-5" as year -5; the drawer's shape check refuses it.
    assert.equal(page.postingTakenDownNote('-5'), null);
    // A number is not a timestamp column value.
    assert.equal(page.postingTakenDownNote(1700000000000), null);
  });

  it('chipFactsFor carries the note from the jobs embed', () => {
    // A minimal stored row: no score, a gone job.
    const facts = page.chipFactsFor({ match_score: null, jobs: { disappeared_at: '2026-11-17T08:12:00+00:00' } });
    // The same sentence the card renders.
    assert.match(facts.postingGone ?? '', /since 2026-11-17\.$/);
  });

  it('renders the note with a one-click Reject button and no confirm step', () => {
    // The notice as the card mounts it.
    const html = render(h(page.PostingGoneNotice, { note: 'Gone since 2026-11-17.', onReject: () => undefined }));
    // A note, not an alert: nothing failed.
    assert.match(html, /role="note"/);
    // The fact is shown.
    assert.match(html, /Gone since 2026-11-17\./);
    // Exactly one button, the Reject itself; an inline confirm would add a second.
    assert.equal((html.match(/<button/g) ?? []).length, 1);
    // That button is the Reject.
    assert.match(html, /<button type="button"[^>]*>Reject<\/button>/);
  });
});
