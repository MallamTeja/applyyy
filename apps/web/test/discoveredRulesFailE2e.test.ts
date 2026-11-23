/* A failed filter-rules read must not hide the rows that loaded (pending-tasks P0 follow-up b, 2026-11-23).
 *
 * WHY. DiscoveredJobsPage reads the filter rules and the lane's rows in parallel. loadFilterRules never rejects: on a
 * failure it returns [] and records the reason. The page used to store that reason in loadError, the state that means
 * "the list failed", and the grid, the counter and Load more all hide on it, so rows that loaded fine vanished behind
 * an error-only banner. The fix keeps the reason in its own rulesWarning state, shown beside the rows.
 * The decision is inline JSX in an effect-driven loader (apps/web has no DOM lib), so it is proven here, in the built
 * bundle, with page.route failing ONLY the filter_rules read.
 * RED-ON-REVERT: storing the rules failure in setLoadError again fails the test at the job-card wait.
 * CPU THROTTLE: E2E_CPU_THROTTLE=6 runs the page under CDP CPU throttling, to prove the waits are event-driven.
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
// The shared browser-test harness: dist guard, static SPA server, fake session.
import { assertDistIsTestable, seedSession, startDistServer } from './support/e2eDist.ts';

// The operator the fake session signs in as.
const USER = { id: '0f4b24da-e85b-40bb-8606-c81824493b45', aud: 'authenticated', role: 'authenticated', email: 'operator@example.test' };

// The one discovered row the list read returns: every DISCOVERED_JOB_COLUMNS field, so the card renders as live.
const ROW = {
  // The application id the card addresses.
  id: '7c1f6a52-0d3e-4c8e-9b1a-2f5e8d4c3b10',
  // The lane the page opens on.
  status: 'discovered',
  // A valid PostgREST timestamptz: the keyset cursor's shape check refuses anything else.
  created_at: '2026-11-23T10:00:00.000000+00:00',
  // The joined job; a distinctive title so the card is found by text, not by count.
  job: {
    // The card's React key.
    id: '5a0d2c1e-8f4b-4b7a-a1c3-9e6d2f8b7c41',
    // Found by this exact text.
    title: 'Rules Outage Sentinel Engineer',
    // Card and filters.
    company_name: 'Example Corp',
    // Location pill.
    location_raw: 'Hyderabad, India',
    // Cascade location rule input.
    locations: ['Hyderabad, India'],
    // Arrangement pill.
    work_arrangement: 'onsite',
    // Type pill.
    employment_type: 'full_time',
    // Card preview.
    description_preview: 'TypeScript and Node.js backend work.',
    // Degree rule input.
    description_requires_degree: false,
    // Open-posting link.
    apply_url: 'https://example.test/jobs/1',
    // Provider filter.
    ats_provider: 'greenhouse',
    // SourceBadge.
    discovered_via: 'ats',
    // SourceBadge.
    source_refs: [],
    // Posted pill.
    posted_at: '2026-11-22T10:00:00.000000+00:00',
    // How far the posted pill trusts posted_at.
    posted_at_source: 'ats',
    // Experience rule input.
    min_experience_years: null,
    // Degree rule input.
    requires_advanced_degree: false,
    // Salary pill.
    salary_min: null,
    // Salary pill.
    salary_max: null,
    // Salary pill.
    salary_currency: null,
    // Still live, so the card offers Send.
    disappeared_at: null,
  },
};

describe('Discovered page keeps loaded rows when the filter-rules read fails (2026-11-23)', () => {
  // The static server.
  let server: Server;
  // Where it listens.
  let baseUrl: string;
  // Chromium.
  let browser: Browser;
  // The signed-in context with the Supabase routes.
  let context: BrowserContext;
  // The page the test drives.
  let page: Page;
  // A dist that cannot prove anything, recorded so the test fails by name instead of being cancelled.
  let guardError: Error | undefined;
  // filter_rules reads answered with an error: proves the failure was really exercised, not skipped.
  let rulesFailures = 0;
  // Native dialogs opened; must stay 0 (repo rule).
  let dialogs = 0;

  // Rethrown per test: a failed before() would CANCEL it, which proves nothing.
  beforeEach(() => {
    // The guard's own message, as the test's failure.
    if (guardError) throw guardError;
  });

  before(async () => {
    // Missing, stale or unconfigured dist: recorded, not thrown.
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
      // Parsed once.
      const url = new URL(route.request().url());
      // The session's user.
      if (url.pathname.endsWith('/auth/v1/user')) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(USER) });
      // THE OUTAGE: only the rules read fails, with PostgREST's error shape, so supabase-js returns { error }.
      if (url.pathname.endsWith('/rest/v1/filter_rules') && route.request().method() === 'GET') {
        // Counted, so the test can prove the failure path ran.
        rulesFailures += 1;
        // A real server error body.
        return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ code: 'XX000', message: 'rules outage (e2e)', details: null, hint: null }) });
      }
      // The lane's list read (it embeds the job): the one row, which must stay drawn.
      if (url.pathname.endsWith('/rest/v1/applications') && (url.searchParams.get('select') ?? '').includes('job:job_id')) {
        // One row in a window of one.
        return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'content-range': '0-0/1' }, body: JSON.stringify([ROW]) });
      }
      // Every other read (counts, settings): empty, as PostgREST answers "nothing".
      return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'content-range': '*/0' }, body: '[]' });
    });
    // The stored session supabase-js reads on boot.
    await seedSession(context, USER.id);
    // The page.
    page = await context.newPage();
    // Optional CPU throttle (E2E_CPU_THROTTLE=6).
    const rate = Number(process.env['E2E_CPU_THROTTLE'] ?? '');
    // Only a real rate above 1 turns it on.
    if (Number.isFinite(rate) && rate > 1) await (await context.newCDPSession(page)).send('Emulation.setCPUThrottlingRate', { rate });
    // Counted AND dismissed, so a native dialog fails by name instead of hanging the run.
    page.on('dialog', (dialog) => {
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

  it('shows the loaded row as a card with a rules warning beside it, not an error-only view', async () => {
    // The page under test.
    await page.goto(`${baseUrl}/discovered`, { waitUntil: 'domcontentloaded' });
    // The All tab, so the card does not depend on how an empty rule set classifies it.
    await page.getByRole('tab', { name: /^All / }).click();
    /* THE BUG, checked FIRST so a revert fails here (rows hidden), not at the warning (whose test id the revert also
       removes). Bounded, so the failure names this wait rather than a 30 s default. */
    await page.locator('article.job-card').filter({ hasText: 'Rules Outage Sentinel Engineer' }).waitFor({ timeout: 15_000 });
    // The rules failure is still said, beside the rows: the split ignores the rules.
    await page.getByTestId('discovery-rules-warning').filter({ hasText: /Filter rules failed to load/ }).waitFor({ timeout: 10_000 });
    // The counter shows too (it hid on loadError): the rows are presented as a real list.
    await page.locator('.discovery__meta-count').filter({ hasText: /Showing/ }).waitFor({ timeout: 10_000 });
    // No list-failure alert: the list did not fail.
    assert.equal(await page.locator('.discovery__error[role="alert"]').count(), 0);
    // The failure was really exercised.
    assert.ok(rulesFailures >= 1, `filter_rules was never read (${rulesFailures})`);
    // No native dialog.
    assert.equal(dialogs, 0);
  });
});
