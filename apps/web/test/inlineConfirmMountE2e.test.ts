/* InlineConfirm forces no style recalc when it mounts, only when it opens or closes (2026-11-08).
 *
 * WHY. The 16:32 latency profile: every InlineConfirm ran getAnimations({ subtree: true }) in a layout effect
 * on MOUNT, and getAnimations() forces a style recalculation. A page draws one confirm per row, so Answer bank
 * spent 68 ms of self time there, Applied 37 ms, all to finish visibility transitions that a mount never
 * starts. The effect now skips the mount commit and still runs on arm, cancel and confirm (the e2e focus
 * test 16 in e2eSuite keeps pinning why it must run then). apps/web has no DOM test lib, so a browser counts.
 * Served from the e2e bundle (dist/, `vite build --mode e2e`); every Supabase call is answered locally.
 *
 * RED-ON-REVERT: removing the mount skip in InlineConfirm.tsx makes test 1 count one call per mounted confirm. */

// Strict asserts.
import assert from 'node:assert/strict';
// The server type.
import type { Server } from 'node:http';
// The runner.
import { describe, it, before, beforeEach, after } from 'node:test';
// Real Chromium.
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
// The shared harness: dist guard, static SPA server, fake session.
import { assertDistIsTestable, seedSession, startDistServer } from './support/e2eDist.ts';

// The operator the fake session names.
const USER_ID = '0f4b24da-e85b-40bb-8606-c81824493b45';

// Three approved rows, each card drawing its guarded "I applied" / "Failed / skip" confirm.
const ROWS = [1, 2, 3].map((n) => ({
  // Distinct ids: one confirm instance each.
  id: `d1d2d3d4-0000-4000-8000-00000000000${n}`,
  // Approved: the Manual apply lane's live shape, which offers both resolves.
  status: 'approved',
  // Any valid stamps.
  updated_at: '2026-11-08T06:30:00+00:00',
  status_changed_at: '2026-11-08T06:30:00+00:00',
  // No resume needed for the confirm.
  tailored_profile: null,
  // A distinct title per card.
  jobs: { title: `E2E Confirm Role ${n}`, company_name: 'Initech', apply_url: `https://example.com/jobs/${n}` },
}));

describe('InlineConfirm mounts without forcing a style recalc (fake session, every Supabase call answered locally)', () => {
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

  // A guard failure marks each test FAILED with the named reason.
  beforeEach(() => {
    // Rethrown here: a throwing before() cancels, which reads as "fail 0".
    if (guardError) throw guardError;
  });

  before(async () => {
    // The guard's outcome, recorded.
    guardError = await assertDistIsTestable().then(() => undefined, (e: unknown) => (e instanceof Error ? e : new Error(String(e))));
    // Nothing to start for a refused dist.
    if (guardError) return;
    // dist/ as an SPA.
    ({ server, base } = await startDistServer());
    // Headless Chromium.
    browser = await chromium.launch({ headless: true });
    // A fresh context.
    context = await browser.newContext();
    // Counts every getAnimations() call in the page, before any app code runs, without changing its result.
    await context.addInitScript(() => {
      // The real method, kept so the app still gets real animations.
      const real = Element.prototype.getAnimations;
      // The counter the tests read.
      (window as unknown as { __getAnimationsCalls: number }).__getAnimationsCalls = 0;
      // Counted, then delegated unchanged.
      Element.prototype.getAnimations = function (this: Element, options?: GetAnimationsOptions) {
        // One per call.
        (window as unknown as { __getAnimationsCalls: number }).__getAnimationsCalls += 1;
        // The browser's own answer.
        return real.call(this, options);
      };
    });
    // EVERY Supabase call answered here.
    await context.route('https://*.supabase.co/**', async (route) => {
      // The URL, for path and filters.
      const url = new URL(route.request().url());
      // A JSON answer.
      const json = (status: number, body: unknown) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
      // Auth: the seeded user.
      if (url.pathname.startsWith('/auth/v1/')) return json(200, { id: USER_ID, aud: 'authenticated', role: 'authenticated', email: 'operator@example.test' });
      // The approved read (status=in.(…approved…)) and reads by id find the rows; other lanes find none.
      if (url.pathname === '/rest/v1/applications') return json(200, (url.searchParams.get('status') ?? '').includes('approved') || (url.searchParams.get('id') ?? '').startsWith('in.') ? ROWS : []);
      // Everything else: empty.
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

  // The page's running count.
  const calls = () => page.evaluate(() => (window as unknown as { __getAnimationsCalls: number }).__getAnimationsCalls);

  it('1. on load: the confirms are mounted, and none of them called getAnimations()', async () => {
    // The page.
    await page.goto(`${base}/manual-apply`, { waitUntil: 'domcontentloaded' });
    // Non-vacuous: all three cards' guarded resolve buttons are drawn, so three confirms are mounted.
    await page.getByRole('button', { name: 'I applied (mark applied): E2E Confirm Role 3 at Initech', exact: true }).waitFor();
    // Settled, so any mount effect has run.
    await page.waitForLoadState('networkidle');
    // THE POINT: mounting forced no style recalc.
    assert.equal(await calls(), 0);
  });

  it('2. arming one confirm still finishes its visibility transition (getAnimations runs on open)', async () => {
    // The count before the click.
    const before = await calls();
    // Arm the first card's confirm.
    await page.getByRole('button', { name: 'I applied (mark applied): E2E Confirm Role 1 at Initech', exact: true }).click();
    // The question is open.
    await page.getByRole('button', { name: 'Cancel: I applied (mark applied): E2E Confirm Role 1 at Initech', exact: true }).waitFor();
    // The effect ran for the commit that opened it: the behaviour the skip must not lose.
    assert.ok((await calls()) > before, 'arming a confirm no longer finishes its visibility transition');
  });
});
