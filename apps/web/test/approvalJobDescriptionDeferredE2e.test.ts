/* The Approval queue reads job descriptions AFTER the first paint (2026-11-09).
 *
 * WHY. The queue's one select carried jobs.description_raw for every row: 438 KB of the 1.67 MB it returned
 * for 86 live rows, on the critical path to Sydney, though no card shows it. Only the "Pay band UK/US only"
 * chip and the AI chat read it. It now comes from a second, deferred read once the cards are on screen.
 *
 * THE MOCK HONOURS `select` LIKE PostgREST DOES. The older e2e mocks always embed description_raw in the
 * queue row whatever was asked, so they passed while the deferred path never ran. Here a row only carries
 * description_raw when the request names it.
 *
 * WHAT IT PROVES, in the built bundle with every Supabase call answered by page routes:
 *   1. the queue read does not name description_raw; one later read names it, filtered like the queue (by
 *      status, never a URL-length id list), and its answer turns on the pay-band chip for the one remote
 *      row whose JD lists UK/US-only pay;
 *   2. when that later read fails, the page says so (alert) and shows no chip: a failure never reads as
 *      "no warning".
 * RED-ON-REVERT: the 2026-11-08 select (description_raw in the queue read) fails test 1 at its first assert.
 *
 * Needs the e2e bundle: cd apps/web && ./node_modules/.bin/vite build --mode e2e (CI builds it first). */

// Strict asserts.
import assert from 'node:assert/strict';
// The Server type only: the shared harness starts it, after() closes it.
import type { Server } from 'node:http';
// The runner; beforeEach turns a guard failure into a FAILED test rather than a cancelled one.
import { after, before, beforeEach, describe, it } from 'node:test';
// The browser, already a dependency of this package.
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
// A real stored row's jsonb values, anonymised, so every card builds a real diff.
import { MASTER_V2, MASTER_VERSION, STORED_TAILORED_PROFILE, TAILOR_REFS } from './fixtures/gitlab-row-anonymised.ts';
// The shared browser-test harness: dist guard, static SPA server, fake session.
import { assertDistIsTestable, seedSession, startDistServer } from './support/e2eDist.ts';

// The operator the fake session signs in as.
const USER = { id: '0f4b24da-e85b-40bb-8606-c81824493b45', aud: 'authenticated', role: 'authenticated', email: 'operator@example.test' };
// One stamp for every row.
const STAMP = '2026-11-09T00:00:00.000000+00:00';
// The chip's exact text (work-auth-gate.ts PAY_BAND_UK_US_ONLY).
const CHIP = 'Pay band UK/US only';

/* Three rows, one per chip outcome: remote with UK/US-only pay (chip), remote with no pay line (no chip),
   on-site (out of the chip's scope). Each carries its description separately, served only when asked for. */
const ROWS = [
  { id: '55555555-5555-4555-8555-000000000000', title: 'Remote UK Pay', location: 'Remote', description: '<p>Compensation: UK £80k–£125k · US $125k–$250k.</p>' },
  { id: '55555555-5555-4555-8555-000000000001', title: 'Remote No Pay', location: 'Remote', description: '<p>A backend role building APIs.</p>' },
  { id: '55555555-5555-4555-8555-000000000002', title: 'Onsite London', location: 'London, UK', description: '<p>UK £80k base.</p>' },
] as const;

/* The queue row as PostgREST would return it for `select`: description_raw is embedded ONLY when the
   select names it, exactly like the real server (the property the older mocks did not have). */
function queueRow(row: (typeof ROWS)[number], select: string): Record<string, unknown> {
  // The jobs embed this page asks for, minus the description unless named.
  const jobs: Record<string, unknown> = { title: row.title, company_name: 'Acme', employment_type: null, work_arrangement: 'remote', locations: [], salary_min: null, salary_max: null, salary_currency: null, discovered_via: null, source_refs: [], apply_url: `https://example.com/jobs/${row.id}`, location_raw: row.location };
  // Named: served, as the real server would.
  if (select.includes('description_raw')) jobs.description_raw = row.description;
  // The application columns the page reads.
  return { id: row.id, status: 'awaiting_approval', tailored_profile: STORED_TAILORED_PROFILE, tailor_refs: TAILOR_REFS, audit_findings: [], selected_jd_keywords: [], match_score: 80, cover_letter: null, updated_at: STAMP, status_changed_at: STAMP, created_at: STAMP, jobs };
}

describe('Approval queue reads job descriptions after the first paint (2026-11-09)', () => {
  // The static server.
  let server: Server;
  // Where it listens.
  let baseUrl: string;
  // Chromium.
  let browser: Browser;
  // The signed-in context with the Supabase routes.
  let context: BrowserContext;
  // The page every test drives.
  let page: Page;
  // A dist that cannot prove anything, recorded so each test fails by name instead of being cancelled.
  let guardError: Error | undefined;
  // The queue read's `select`, as sent.
  let queueSelect: string | null = null;
  // The deferred description reads, as sent: their select and status filter.
  let descriptionReads: { readonly select: string; readonly status: string | null }[] = [];
  // Whether the deferred read is refused in this test.
  let failDescriptions = false;

  // Rethrown per test: a failed before() would CANCEL them (CLAUDE.md §5), which proves nothing.
  beforeEach(() => {
    // The guard's own message, as each test's failure.
    if (guardError) throw guardError;
    // Fresh observations per test.
    queueSelect = null;
    // Same.
    descriptionReads = [];
  });

  before(async () => {
    // Missing, stale or unconfigured dist: recorded, not thrown, so beforeEach fails each test by name.
    guardError = await assertDistIsTestable().then(() => undefined, (e: unknown) => (e instanceof Error ? e : new Error(String(e))));
    // Nothing worth serving.
    if (guardError) return;
    // The shared SPA server on a free loopback port.
    ({ server, base: baseUrl } = await startDistServer());
    // Headless, as CI runs it.
    browser = await chromium.launch({ headless: true });
    // A fresh context for this file.
    context = await browser.newContext();
    // Every Supabase call answered here; nothing reaches the network.
    await context.route('https://*.supabase.co/**', async (route) => {
      // The request's parts the answers depend on.
      const request = route.request();
      // Parsed once.
      const url = new URL(request.url());
      // Which representation a read asked for.
      const accept = request.headers()['accept'];
      // A JSON answer with a status.
      const json = (status: number, body: unknown) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
      // The session's user.
      if (url.pathname.endsWith('/auth/v1/user')) return json(200, USER);
      // The applications reads: the queue, and the deferred description read.
      if (url.pathname.endsWith('/rest/v1/applications') && request.method() === 'GET') {
        // What the page asked for.
        const select = url.searchParams.get('select') ?? '';
        // THE DEFERRED READ: the queue's filter, asking for the description (and nothing else of the row).
        if (select.includes('description_raw') && !select.includes('tailored_profile')) {
          // Recorded for test 1's filter check.
          descriptionReads.push({ select, status: url.searchParams.get('status') });
          // Test 2: refused with a PostgREST error body.
          if (failDescriptions) return json(500, { code: 'XX000', message: 'description read refused by test', details: null, hint: null });
          // Each row's description, embedded the way the select names it.
          return json(200, ROWS.map((row) => ({ id: row.id, jobs: { description_raw: row.description } })));
        }
        // THE QUEUE: recorded, and answered faithfully to its select.
        if (url.searchParams.get('status') === 'eq.awaiting_approval') {
          // Kept for test 1's first assert.
          queueSelect = select;
          // Each row shaped by the select.
          return json(200, ROWS.map((row) => queueRow(row, select)));
        }
      }
      // The pinned master every row was tailored from (and the newest).
      if (url.pathname.endsWith('/rest/v1/master_profiles')) return json(200, accept?.includes('vnd.pgrst.object') === true ? { profile: MASTER_V2, version: MASTER_VERSION } : [{ profile: MASTER_V2, version: MASTER_VERSION }]);
      // Every other read (lanes, counts, events): empty.
      return json(200, []);
    });
    // The stored session supabase-js reads on boot.
    await seedSession(context, USER.id);
    // The one page.
    page = await context.newPage();
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

  it('1. the queue read names no description; one later read does, filtered like the queue, and the chip follows', async () => {
    // Every read answered.
    failDescriptions = false;
    // The queue page, fresh.
    await page.goto(`${baseUrl}/approvals`, { waitUntil: 'domcontentloaded' });
    // The chip, once the deferred read has answered: the end of the path under test.
    await page.getByText(CHIP, { exact: true }).first().waitFor();
    // The queue read was sent and did NOT ask for the description (the property that cuts the bytes).
    assert.ok(queueSelect !== null, 'the queue read was never sent');
    // Positive shape: the jobs embed ends on location_raw, the column list the first paint needs.
    assert.match(queueSelect, /jobs:job_id\(title,company_name,employment_type,work_arrangement,locations,salary_min,salary_max,salary_currency,discovered_via,source_refs,apply_url,location_raw\)$/);
    // Exactly one deferred read, so the description is not fetched per card.
    assert.equal(descriptionReads.length, 1, `expected 1 deferred description read, saw ${descriptionReads.length}`);
    // Its select is the id plus the one embedded column.
    assert.equal(descriptionReads[0]!.select, 'id,jobs:job_id(description_raw)');
    // Filtered like the queue read, so its URL stays one short filter however long the queue grows.
    assert.equal(descriptionReads[0]!.status, 'eq.awaiting_approval');
    // One chip: the remote row with UK/US-only pay; not the remote row without pay, not the on-site row.
    assert.equal(await page.getByText(CHIP, { exact: true }).count(), 1);
  });

  it('2. a failed description read is said on the page, and no chip is shown', async () => {
    // The deferred read refused.
    failDescriptions = true;
    // A fresh load, so the read runs again.
    await page.goto(`${baseUrl}/approvals`, { waitUntil: 'domcontentloaded' });
    // The page-level notice, naming the cause.
    const notice = page.getByRole('alert').filter({ hasText: 'Could not load the job descriptions' });
    // Shown once the read fails.
    await notice.waitFor();
    // It carries the server's own message, so the operator can tell causes apart.
    assert.match((await notice.textContent()) ?? '', /description read refused by test/);
    // The read was tried.
    assert.equal(descriptionReads.length, 1);
    // No chip: an unread description is never a pay-band answer.
    assert.equal(await page.getByText(CHIP, { exact: true }).count(), 0);
  });
});
