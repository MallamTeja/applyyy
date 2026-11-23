/* The Scan Watchlist clock and client time limit, in a real browser (round 8, 2026-11-21; shipped in 1dd56317).
 *
 * WHY. A Scout-ATS scan takes about 2 minutes and the edge call can hang past the platform limit. Before 1dd56317 the
 * modal showed a spinner with no sense of time and waited forever. Now it shows a rising m:ss clock and, at
 * EDGE_CLIENT_TIMEOUT_MS (180 s, edgeCall.ts), gives up with the existing server_timeout message. The unit tests
 * (scanClientTimeout.test.ts) prove the race and the formatter; this file proves the modal shows them, in the built
 * bundle, with the edge call routed to NEVER answer and Playwright's fake clock, so the test does not wait 180 s.
 * RED-ON-REVERT: removing the timeout race in invokeWithin (edgeCall.ts) fails the test at the server_timeout wait;
 * removing the ticker effect fails it at the 0:05 clock.
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
import { chromium, type Browser, type BrowserContext, type Page, type Route } from 'playwright';
// The shared browser-test harness: dist guard, static SPA server, fake session.
import { assertDistIsTestable, seedSession, startDistServer } from './support/e2eDist.ts';

// The operator the fake session signs in as.
const USER = { id: '0f4b24da-e85b-40bb-8606-c81824493b45', aud: 'authenticated', role: 'authenticated', email: 'operator@example.test' };

// "m:ss" back to whole seconds; anything else is a broken clock, so it throws rather than reading as 0.
function seconds(text: string): number {
  // Exactly the formatElapsed shape.
  const match = /^(\d+):([0-5]\d)$/.exec(text.trim());
  // Not a clock: fail by name.
  if (match === null) throw new Error(`not an m:ss clock: ${JSON.stringify(text)}`);
  // Minutes and seconds.
  return Number(match[1]) * 60 + Number(match[2]);
}

// Whole seconds as the exact m:ss text the modal prints, anchored so 0:05 never matches 10:05.
function mss(total: number): RegExp {
  // formatElapsed's own layout.
  return new RegExp(`^${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}$`);
}

// Polls a Node-side condition on the real clock (the page's clock is fake), bounded so a miss fails by name.
async function waitUntil(condition: () => boolean, failure: string): Promise<void> {
  // Ten seconds of real time.
  const deadline = Date.now() + 10_000;
  // Checked every 50 ms.
  while (!condition()) {
    // Out of time: say what never happened.
    if (Date.now() > deadline) throw new Error(failure);
    // Node's timer, untouched by page.clock.
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe('Scan Watchlist clock and client limit in a browser (round 8, the edge call never answers)', () => {
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
  // Scout-ATS calls held open (never answered), aborted at teardown so nothing leaks.
  const hung: Route[] = [];
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
    // Every Supabase call answered here (or deliberately not); nothing reaches the network.
    await context.route('https://*.supabase.co/**', async (route) => {
      // Parsed once.
      const url = new URL(route.request().url());
      // The session's user.
      if (url.pathname.endsWith('/auth/v1/user')) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(USER) });
      // THE HUNG SCAN: held, never fulfilled, exactly the "edge call never answers" case.
      if (url.pathname.endsWith('/functions/v1/scout-ats')) {
        // Kept for teardown.
        hung.push(route);
        // No answer.
        return;
      }
      // Every read the page makes on load (lanes, counts, filters): empty, as PostgREST answers "nothing".
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
    // The held calls released, so Chromium closes cleanly.
    for (const route of hung) await route.abort().catch(() => {});
    // Each closed only if it was opened.
    if (page) await page.close().catch(() => {});
    // The context.
    if (context) await context.close().catch(() => {});
    // The browser.
    if (browser) await browser.close().catch(() => {});
    // The server.
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('a scan that never answers shows a rising m:ss clock, then the server_timeout message at the 3:00 client limit', async () => {
    // Fake timers BEFORE the app loads, so its Date.now, setInterval and setTimeout all run on the test's clock.
    await page.clock.install();
    // The page that opens the scan modal.
    await page.goto(`${baseUrl}/discovered`, { waitUntil: 'domcontentloaded' });
    // Open the modal.
    await page.getByRole('button', { name: /Scout Watchlist/ }).click();
    // Start the scan.
    await page.getByRole('button', { name: 'Start Watchlist Scan' }).click();
    // The edge call is out (and will never come back). Polled on the route log: a waitForRequest registered after the
    // click can miss a request the click already sent (seen live, 2026-11-21).
    await waitUntil(() => hung.length === 1, 'the scout-ats call never arrived');
    // The clock, by its class (aria-live off, no role).
    const clock = page.locator('.discovery-step__elapsed');
    // It renders while the scan runs.
    await clock.waitFor();
    // The note names the limit the browser will wait.
    await page.getByText('The browser stops waiting after 3:00.', { exact: false }).waitFor();
    // Freeze the page's time one second ahead of its own now, so every later step moves it only by runFor.
    await page.clock.pauseAt((await page.evaluate(() => Date.now())) + 1_000);
    // Where the clock stands once frozen (a second or two, depending on how fast the page started the scan).
    const start = seconds(await clock.innerText());
    // Five fake seconds: the 1 s ticker fires five times.
    await page.clock.runFor(5_000);
    // The clock rose by exactly five, in m:ss.
    await clock.filter({ hasText: mss(start + 5) }).waitFor();
    // A minute on: the minutes roll over.
    await page.clock.runFor(60_000);
    // Up by sixty more.
    await clock.filter({ hasText: mss(start + 65) }).waitFor();
    // Not given up yet: still scanning, no Scan Again.
    assert.equal(await page.getByRole('button', { name: 'Scan Again' }).count(), 0);
    // Well past 180 s from the call: the client limit's setTimeout fires.
    await page.clock.runFor(120_000);
    // The existing server_timeout message, with the cause naming the limit.
    await page.locator('.discovery-step__text').filter({ hasText: /Scout-ATS did not answer in time \(no answer after 180 s\)\..*Discovered page/ }).waitFor();
    // The scan can be retried.
    await page.getByRole('button', { name: 'Scan Again' }).waitFor();
    // Not running any more, so the clock is gone.
    await clock.waitFor({ state: 'detached' });
    // The edge call really never answered: one held request, the timeout came from the client.
    assert.equal(hung.length, 1);
    // No native dialog.
    assert.equal(dialogs, 0);
  });
});
