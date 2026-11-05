/* The Approve re-check in a real browser (Teja, 2026-11-05: "Check on Approve, hold for a 2nd click").
 *
 * WHAT IT PROVES. The approval page imports supabase, so no node test can import it; the hold lives
 * in its settle(). So this drives the built bundle in Chromium with every Supabase call answered by
 * page routes, and counts the one write path (advance_application_status):
 *   1. a CLEAN edited row approves on ONE click (the positive shape: "hold everything" fails here);
 *   2. a FLAGGED edited row writes nothing on the first click, lists the finding on its card, says
 *      why at the top of the card, and writes exactly once on "Approve with these";
 *   3. no native browser dialog opens at any step (repo rule since 2026-11-04).
 * Remove the hold in settle() and test 2's "first click must not write" goes red by name.
 *
 * THE ROWS are the anonymised live GitLab row (test/fixtures), so the master, the tailor refs and the
 * stored resume have the real shape; each row is that resume with one bullet edited.
 *
 * Needs the e2e bundle: cd apps/web && ./node_modules/.bin/vite build --mode e2e (CI builds it first). */

// Strict asserts.
import assert from 'node:assert/strict';
// The Server type only: the shared harness starts it, after() closes it.
import type { Server } from 'node:http';
// The runner; beforeEach turns a guard failure into a FAILED test rather than a cancelled one.
import { after, before, beforeEach, describe, it } from 'node:test';
// The browser, already a dependency of this package.
import { chromium, type Browser, type BrowserContext, type Dialog, type Page } from 'playwright';
// The live row's three jsonb values, anonymised.
import { MASTER_V2, STORED_TAILORED_PROFILE, TAILOR_REFS } from './fixtures/gitlab-row-anonymised.ts';
/* The shared browser-test harness. Its guard walks all of src/ plus the root build inputs, a superset of the
   per-file source list this test kept until 2026-11-05, and also refuses a bundle built without the project URL. */
import { assertDistIsTestable, seedSession, startDistServer } from './support/e2eDist.ts';

// The operator the fake session signs in as.
const USER = { id: '0f4b24da-e85b-40bb-8606-c81824493b45', aud: 'authenticated', role: 'authenticated', email: 'operator@example.test' };
// One stamp for both rows; confirmFresh compares the stored one to it, so "fresh" every time.
const STAMP = '2026-11-05T00:00:00.000000+00:00';

/* The stored resume with its first experience bullet rewritten by `edit`: an operator's own typing. */
function editedResume(edit: (text: string) => string): Record<string, unknown> {
  // A deep copy, so the two rows never share an object.
  const resume = structuredClone(STORED_TAILORED_PROFILE) as { experience: { bullets: { text: string }[] }[] };
  // The bullet the edit lands on; the fixture has one, or the rows prove nothing.
  const bullet = resume.experience[0]?.bullets[0];
  // Said by name rather than a TypeError deep in the browser.
  assert.ok(bullet !== undefined, 'fixture must have an experience bullet');
  // The edit itself.
  bullet.text = edit(bullet.text);
  // Back as untyped JSON, as PostgREST returns it.
  return resume as unknown as Record<string, unknown>;
}

/* One queued application as the queue's select returns it, embed included. */
function queueRow(id: string, title: string, tailored: Record<string, unknown>): Record<string, unknown> {
  // Only the columns the page reads; the rest of the table is irrelevant here.
  return {
    id,
    user_id: USER.id,
    job_id: `job-${id}`,
    status: 'awaiting_approval',
    tailored_profile: tailored,
    tailor_refs: TAILOR_REFS,
    audit_findings: [],
    selected_jd_keywords: [],
    match_score: 80,
    cover_letter: null,
    updated_at: STAMP,
    status_changed_at: STAMP,
    created_at: STAMP,
    // The embedded job, in the select's own column list.
    jobs: { title, company_name: 'Acme', employment_type: null, work_arrangement: 'remote', locations: [], salary_min: null, salary_max: null, salary_currency: null, discovered_via: null, source_refs: [], apply_url: 'https://example.com/jobs/1', description_raw: 'A backend role.', application_deadline: null },
  };
}

// Clean: the bullet loses its last word, so every word left is the master's own.
const CLEAN = queueRow('11111111-1111-4111-8111-111111111111', 'Clean Edit Engineer', editedResume((text) => text.split(' ').slice(0, -1).join(' ')));
// Flagged: the bullet gains a word no master node has.
const FLAGGED = queueRow('22222222-2222-4222-8222-222222222222', 'Flagged Edit Engineer', editedResume((text) => `${text} using Zanzibarql`));
// Both rows, newest first is irrelevant: each is found by its own card id.
const ROWS = [CLEAN, FLAGGED];

/* A PostgREST answer: a single object when the client asked for one, else an array. supabase-js has
   used both for maybeSingle, so the route answers whichever the request names. */
function pgrst(accept: string | undefined, row: unknown): string {
  // The single-object media type means "one row, not a list".
  return JSON.stringify(accept?.includes('vnd.pgrst.object') === true ? row : [row]);
}

describe('Approve re-checks an edited row (2026-11-05)', () => {
  // The static server, the browser and the one page.
  let server: Server;
  // Where the server listens.
  let baseUrl: string;
  // Chromium.
  let browser: Browser;
  // The signed-in context with the Supabase routes.
  let context: BrowserContext;
  // The page every step drives.
  let page: Page;
  // A dist that cannot prove anything, recorded so each test fails by name instead of being cancelled.
  let guardError: Error | undefined;
  // Writes the page sent, by application id, in order.
  const writes: string[] = [];
  // Native dialogs the page opened; must stay 0.
  let dialogs = 0;

  // Rethrown per test: a failed before() would CANCEL them (CLAUDE.md §5), which proves nothing.
  beforeEach(() => {
    // The guard's own message, as each test's failure.
    if (guardError) throw guardError;
  });

  before(async () => {
    // Missing, stale or unconfigured dist: recorded, not thrown, so beforeEach fails each test by name.
    guardError = await assertDistIsTestable().then(() => undefined, (e: unknown) => (e instanceof Error ? e : new Error(String(e))));
    // Nothing worth serving.
    if (guardError) return;
    // The shared SPA server on a free loopback port: a file when it exists, else index.html, as Vercel serves it.
    ({ server, base: baseUrl } = await startDistServer());
    // Headless, as CI runs it.
    browser = await chromium.launch({ headless: true });
    // A fresh context per run.
    context = await browser.newContext();
    // Every Supabase call answered here; nothing reaches the network.
    await context.route('https://*.supabase.co/**', async (route) => {
      // The request's parts the answers depend on.
      const request = route.request();
      // Parsed once.
      const url = new URL(request.url());
      // Which representation a read asked for.
      const accept = request.headers()['accept'];
      // The session's user.
      if (url.pathname.endsWith('/auth/v1/user')) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(USER) });
      // A refreshed session, should the client ask.
      if (url.pathname.endsWith('/auth/v1/token')) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ access_token: 'e2e-test-token', token_type: 'bearer', expires_in: 7200, refresh_token: 'e2e-test-refresh', user: USER }) });
      // THE WRITE PATH: counted by row, and accepted (no error, real status), so settle reads "moved".
      if (url.pathname.endsWith('/rest/v1/rpc/advance_application_status')) {
        // The row it moves.
        writes.push(String((request.postDataJSON() as { p_application_id?: unknown }).p_application_id));
        // 200 + null: the RPC's own success shape.
        return route.fulfill({ status: 200, contentType: 'application/json', body: 'null' });
      }
      // The applications reads: the queue, and confirmFresh's per-row stamp check.
      if (url.pathname.endsWith('/rest/v1/applications') && request.method() === 'GET') {
        // The queue's read.
        if (url.searchParams.get('status') === 'eq.awaiting_approval') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(ROWS) });
        // confirmFresh: the stored row, unchanged since load.
        const row = ROWS.find((candidate) => url.searchParams.get('id') === `eq.${String(candidate.id)}`);
        // Same stamp and status as loaded, so the check says "fresh".
        if (row !== undefined) return route.fulfill({ status: 200, contentType: 'application/json', body: pgrst(accept, { tailored_profile: row.tailored_profile, updated_at: STAMP, status: 'awaiting_approval' }) });
      }
      // The pinned master both rows were tailored from.
      if (url.pathname.endsWith('/rest/v1/master_profiles')) return route.fulfill({ status: 200, contentType: 'application/json', body: pgrst(accept, { profile: MASTER_V2 }) });
      // Every other read (chats, counts, health): empty.
      return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
    });
    // The stored session supabase-js reads on boot, signed in as USER (the shared helper's user shape matches it).
    await seedSession(context, USER.id);
    // The one page.
    page = await context.newPage();
    // Counted AND dismissed, so a native confirm fails by name instead of hanging the run.
    page.on('dialog', (dialog: Dialog) => {
      // Counted first.
      dialogs += 1;
      // Dismissed.
      void dialog.dismiss().catch(() => {});
    });
  });

  after(async () => {
    // Each closed only if it was opened.
    if (page) await page.close().catch(() => {});
    // The context.
    if (context) await context.close().catch(() => {});
    // The browser.
    if (browser) await browser.close().catch(() => {});
    // The server.
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  /* One row's card, unfolded so its Approve button is reachable. Bucket B rows can start folded. */
  async function openCard(id: string) {
    // The card, by the id the page gives it.
    const card = page.locator(`#app-card-${id}`);
    // Rendered: the routes fed the queue.
    await card.waitFor();
    // The fold control reads "Review" while folded; open it then.
    const review = card.getByRole('button', { name: 'Review', exact: true });
    // Only when folded.
    if (await review.isVisible()) await review.click();
    // The card, ready.
    return card;
  }

  it('1. a clean edited row approves on ONE click', async () => {
    // The queue page.
    await page.goto(`${baseUrl}/approvals`, { waitUntil: 'domcontentloaded' });
    // The clean row's card.
    const card = await openCard(String(CLEAN.id));
    // The write this click sends.
    const write = page.waitForRequest('**/rest/v1/rpc/advance_application_status', { timeout: 10_000 }).catch(() => null);
    // One click on the ordinary Approve.
    await card.getByRole('button', { name: 'Approve and queue for submission', exact: true }).click();
    // Answered (or timed out, which the next line reports).
    await (await write)?.response();
    // Exactly one write, for this row: nothing held a clean edit.
    assert.deepEqual(writes, [String(CLEAN.id)], 'a clean edited row must approve on its first click');
  });

  it('2. a flagged edited row writes nothing on the first click, lists the finding, then writes once on "Approve with these"', async () => {
    // The flagged row's card.
    const card = await openCard(String(FLAGGED.id));
    // The first click: the ordinary Approve.
    await card.getByRole('button', { name: 'Approve and queue for submission', exact: true }).click();
    // The hold's second-click button appears in place of it.
    const again = card.getByRole('button', { name: 'Approve with these', exact: true });
    // Rendered: the check ran and held.
    await again.waitFor({ timeout: 10_000 });
    // THE HOLD: still only test 1's write.
    assert.deepEqual(writes, [String(CLEAN.id)], 'the first click on a flagged edited row must not write');
    // The finding names the invented word.
    assert.match((await card.locator('.diff__approve-hold').textContent()) ?? '', /zanzibarql/i, 'the held card must list the unsupported claim');
    // And the top of the card says why nothing was approved.
    assert.match((await page.locator(`#stale-notice-${String(FLAGGED.id)}`).textContent()) ?? '', /Not approved yet/, 'the held card must say it was not approved');
    // The write the second click sends.
    const write = page.waitForRequest('**/rest/v1/rpc/advance_application_status', { timeout: 10_000 }).catch(() => null);
    // The acknowledgement.
    await again.click();
    // Answered.
    await (await write)?.response();
    // One more write, for this row.
    assert.deepEqual(writes, [String(CLEAN.id), String(FLAGGED.id)], '"Approve with these" must send exactly one write');
    // No native dialog at any step.
    assert.equal(dialogs, 0, 'the re-check must hold inline, never with a browser dialog');
  });
});
