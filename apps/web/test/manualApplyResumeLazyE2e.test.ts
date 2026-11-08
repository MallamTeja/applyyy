/* Manual apply mounts a row's resume preview only when its block is opened, in a real browser (2026-11-08).
 *
 * WHY. Teja, 16:32: "pages are slow". The tailored-resume block on every Manual apply card is a CLOSED
 * <details>, but React mounted ResumePreview inside it anyway, so every row paid one master_profiles read,
 * two renders and two iframes on page open (26 live rows → 26 reads, 52 iframes) for content nobody opened.
 * manualApplyResume.test.ts pins the closed card statically; this file proves the browser behaviour both
 * ways: nothing on load, and the same preview the moment a block is opened.
 * It serves the e2e bundle (dist/, `vite build --mode e2e`) and answers every Supabase call locally.
 *
 * RED-ON-REVERT: mounting ResumePreview unconditionally again fails test 1 at the master_profiles count. */

// Strict asserts, like the other browser tests.
import assert from 'node:assert/strict';
// The server type.
import type { Server } from 'node:http';
// node:test, like every other web test.
import { describe, it, before, beforeEach, after } from 'node:test';
// Real Chromium, the e2e suite's own Playwright.
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
// The shared harness: dist guard, static SPA server, fake session.
import { assertDistIsTestable, seedSession, startDistServer } from './support/e2eDist.ts';
// A real ResolvedResume, so the preview renders a real document once opened.
import { zomatoBackendIntern } from '../../../packages/resume-template/test/fixtures/zomato-backend-intern.ts';

// The operator the fake session names.
const USER_ID = '0f4b24da-e85b-40bb-8606-c81824493b45';

// Three approved rows with a tailored resume: enough that "one per row on load" would show as 3.
const ROWS = [1, 2, 3].map((n) => ({
  // Distinct ids, so each card is its own block.
  id: `c1c2c3d4-0000-4000-8000-00000000000${n}`,
  // Approved: the Manual apply lane's live shape.
  status: 'approved',
  // Any valid stamps.
  updated_at: '2026-11-08T06:30:00+00:00',
  status_changed_at: '2026-11-08T06:30:00+00:00',
  // The snapshot the card previews.
  tailored_profile: zomatoBackendIntern,
  // The job embed, with a distinct title per card.
  jobs: { title: `E2E Lazy Role ${n}`, company_name: 'Zomato', apply_url: `https://example.com/jobs/${n}` },
}));

describe('Manual apply resume previews mount on open (fake session, every Supabase call answered locally)', () => {
  // The static server.
  let server: Server;
  // Its address.
  let base: string;
  // Chromium.
  let browser: Browser;
  // The signed-in context.
  let context: BrowserContext;
  // The one tab.
  let page: Page;
  // Set when dist/ cannot prove anything; rethrown per test so each FAILS instead of being cancelled.
  let guardError: Error | undefined;
  // master_profiles reads: the per-row cost this change removes from page load.
  let masterReads = 0;

  // A guard failure marks each test FAILED with the named reason.
  beforeEach(() => {
    // Rethrown here, not in before(): a throwing before() cancels, which reads as "fail 0".
    if (guardError) throw guardError;
  });

  before(async () => {
    // The guard's outcome, recorded.
    guardError = await assertDistIsTestable().then(() => undefined, (e: unknown) => (e instanceof Error ? e : new Error(String(e))));
    // Nothing to start for a refused dist.
    if (guardError) return;
    // dist/ as an SPA on a free port.
    ({ server, base } = await startDistServer());
    // Headless Chromium.
    browser = await chromium.launch({ headless: true });
    // A fresh context for this file.
    context = await browser.newContext();
    // EVERY Supabase call answered here: nothing can reach the live project.
    await context.route('https://*.supabase.co/**', async (route) => {
      // The request's URL, for its path and filters.
      const url = new URL(route.request().url());
      // A JSON answer.
      const json = (status: number, body: unknown) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
      // Auth: the seeded session's user.
      if (url.pathname.startsWith('/auth/v1/')) return json(200, { id: USER_ID, aud: 'authenticated', role: 'authenticated', email: 'operator@example.test' });
      // The read under test, counted; an empty answer is enough (the master pane then says it is unavailable).
      if (url.pathname === '/rest/v1/master_profiles') { masterReads += 1; return json(200, []); }
      // The rows: the approved read (status=in.(…approved…)) and any read by id find them; the lanes read
      // (other statuses) finds none. The page lists each application once (mergeManualApplyRows).
      if (url.pathname === '/rest/v1/applications') return json(200, (url.searchParams.get('status') ?? '').includes('approved') || (url.searchParams.get('id') ?? '').startsWith('in.') ? ROWS : []);
      // No kit notes: resume-only rows, which still carry the tailored-resume block.
      return json(200, []);
    });
    // The fake session.
    await seedSession(context, USER_ID);
    // The tab.
    page = await context.newPage();
  });

  after(async () => {
    // Each closed if it started.
    if (page) await page.close().catch(() => {});
    // The context.
    if (context) await context.close().catch(() => {});
    // The browser.
    if (browser) await browser.close().catch(() => {});
    // The server.
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('1. on load: every card has its closed resume block, and no preview, iframe or master read exists', async () => {
    // Counted from this page load only.
    masterReads = 0;
    // The page.
    await page.goto(`${base}/manual-apply`, { waitUntil: 'domcontentloaded' });
    // Non-vacuous: all three closed blocks rendered, so the rows DO have resumes to show.
    await page.locator('details.kit-card__resume').nth(2).waitFor({ state: 'attached' });
    // Settled: give any eager mount time to fire its read before counting.
    await page.waitForLoadState('networkidle');
    // THE POINT: nothing of the preview was built for blocks nobody opened.
    assert.deepEqual({ blocks: await page.locator('details.kit-card__resume').count(), iframes: await page.locator('iframe').count(), masterReads }, { blocks: 3, iframes: 0, masterReads: 0 });
  });

  it('2. opening one block mounts that row\'s preview, and only that one', async () => {
    // Counted from the click only.
    masterReads = 0;
    // The first card's summary: the operator's own click.
    await page.locator('details.kit-card__resume summary').first().click();
    // Its tailored pane appears: the same preview as before this change.
    await page.locator('details.kit-card__resume').first().locator('iframe').first().waitFor();
    // The master read for that one row lands.
    await page.waitForLoadState('networkidle');
    // One block's preview (tailored + master pane frames live only in the opened block) and exactly one read.
    assert.deepEqual({ inOpened: (await page.locator('details.kit-card__resume').first().locator('iframe').count()) > 0, inOthers: await page.locator('details.kit-card__resume:not([open]) iframe').count(), masterReads }, { inOpened: true, inOthers: 0, masterReads: 1 });
  });
});
