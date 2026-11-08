/* The shell's status counts and Manual apply badge, read once per session, in a real browser (2026-11-08).
 *
 * WHY. The Supabase project is in Sydney; each request costs 0.32-0.49 s from India. Until 2026-11-08 the
 * shell (AppShell.tsx) re-read the counts RPC and the badge's Manual apply reads on EVERY sidebar click:
 * 3-5 extra requests in two rounds, racing the page's own reads. Now the counts live in one shared store
 * (useApplicationCounts.ts) and are re-read only when data moved. This file proves both halves: a click
 * reads nothing for the shell, and a status move still re-reads the counts AND the badge, because a badge
 * that stays stale after a move is the regression the old per-click read was (expensively) preventing.
 *
 * It serves the e2e bundle (dist/, `vite build --mode e2e`) and answers every Supabase call locally, so
 * nothing here can reach the live database.
 *
 * RED-ON-REVERT: restoring the per-navigation effect fails test 1 at the counts assertion; dropping the
 * write observer fails test 2 at the wait for a re-read; keying the badge on the counts store's revision
 * again fails test 3 at the badge assertion; removing the stale-navigation re-read fails test 4 at the
 * stale click counts. */

// Strict asserts, like the other browser tests.
import assert from 'node:assert/strict';
// The server type.
import type { Server } from 'node:http';
// node:test, like every other web test (package.json "test").
import { describe, it, before, beforeEach, after } from 'node:test';
// Real Chromium; the same Playwright the e2e suite uses (apps/web/node_modules).
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
// The shared harness (test/support/e2eDist.ts): dist guard, static SPA server, fake session, project ref.
import { PROJECT_REF, assertDistIsTestable, seedSession, startDistServer } from './support/e2eDist.ts';

// The operator the fake session and the auth answers name.
const USER_ID = '5b1e7c3a-2d4f-4a6b-9c8d-0e1f2a3b4c5d';

// One approved job: the Manual apply badge counts it, so the rail shows a number the test can read.
const APPROVED_ROW = {
  // Any id; no kit joins to it.
  id: '5b1e7c3a-0000-4000-8000-000000000001',
  // The status the badge's approved read filters on.
  status: 'approved',
  // Any stamp.
  updated_at: '2026-11-08T10:00:00+00:00',
  // Not parked.
  block_reason: null,
  // The badge read carries no resume.
  tailored_profile: null,
  // The job embed the row parser expects.
  jobs: { title: 'Software Engineer', company_name: 'Example', apply_url: 'https://job-boards.greenhouse.io/example/jobs/1', ats_provider: 'greenhouse' },
};

describe('shell counts and badge in a browser (fake session, every Supabase call answered locally)', () => {
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
  // Set when dist/ cannot prove anything; rethrown per test so each FAILS (a throwing before() cancels).
  let guardError: Error | undefined;
  // Every Supabase request path seen, in order; the assertions count slices of it.
  const seen: string[] = [];
  // Requests answered-but-not-yet-finished, so "settled" means nothing is in flight.
  let inFlight = 0;
  // When the last request finished, for the quiet-period check.
  let lastDoneAt = 0;

  // How many times a path was requested since index `from` of the log.
  const countSince = (from: number, path: string) => seen.slice(from).filter((p) => p === path).length;

  // Wait until no request is in flight and none finished for 800 ms (the shell's reads come in two rounds).
  const settle = async () => {
    // The quiet window counts from here at the earliest, so a call made before any request starts still waits.
    const start = Date.now();
    // Bounded, so a request loop fails the test instead of hanging it.
    const deadline = start + 15_000;
    // Polled: the route handler is the only place that sees requests start and end.
    for (;;) {
      // A short tick; the quiet window below decides, not this.
      await page.waitForTimeout(150);
      // Quiet long enough, and nothing open: the shell and the page are done reading.
      if (inFlight === 0 && Date.now() - Math.max(lastDoneAt, start) > 800) return;
      // A page that never goes quiet is itself a failure worth naming.
      if (Date.now() > deadline) throw new Error(`network never settled; last paths: ${seen.slice(-10).join(', ')}`);
    }
  };

  // Client-side navigation, the way a sidebar NavLink does it: no reload, the shell stays mounted.
  const navigate = (path: string) => page.evaluate((p) => { history.pushState({}, '', p); dispatchEvent(new PopStateEvent('popstate')); }, path);

  // A guard failure marks each test FAILED with the named reason.
  beforeEach(() => {
    // Rethrown, not thrown in before(): cancelled tests read as "fail 0".
    if (guardError) throw guardError;
  });

  before(async () => {
    // The guard's outcome, recorded.
    guardError = await assertDistIsTestable().then(() => undefined, (e: unknown) => (e instanceof Error ? e : new Error(String(e))));
    // Nothing to start for a refused dist.
    if (guardError) return;
    // dist/ as an SPA on a free port (shared harness).
    ({ server, base } = await startDistServer());
    // Headless Chromium.
    browser = await chromium.launch({ headless: true });
    // A fresh context per file.
    context = await browser.newContext({ viewport: { width: 1100, height: 900 } });
    // EVERY Supabase call answered here: nothing can reach the live project.
    await context.route('https://*.supabase.co/**', async (route) => {
      // The request.
      const req = route.request();
      // Its path, the unit every assertion counts.
      const { pathname } = new URL(req.url());
      // Logged before answering, so a request is counted even if the page navigates away mid-flight.
      seen.push(pathname);
      // Open until fulfilled.
      inFlight += 1;
      // Answered in a finally, so a throw cannot leave the settle loop waiting forever.
      try {
        // Auth: the seeded session's user.
        if (pathname.startsWith('/auth/v1/')) return await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: USER_ID, aud: 'authenticated', role: 'authenticated', email: 'operator@example.test' }) });
        // The counts RPC: a real-shaped answer, so the shell has numbers (one approved job for the badge).
        if (pathname === '/rest/v1/rpc/application_status_counts') return await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ status: 'approved', row_count: 1 }]) });
        // The badge's approved-rows read: one approved job, so the rail shows "1" (row shape as manualApplyQuestionsE2e).
        if (pathname === '/rest/v1/applications' && (new URL(req.url()).searchParams.get('status') ?? '').includes('approved')) return await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([APPROVED_ROW]) });
        // Every other read, and the simulated move: an empty list, as PostgREST answers "nothing".
        return await route.fulfill({ status: 200, contentType: 'application/json', headers: { 'content-range': '*/0' }, body: '[]' });
      } finally {
        // Closed either way.
        inFlight -= 1;
        // The quiet period restarts from here.
        lastDoneAt = Date.now();
      }
    });
    // The fake session (shared harness).
    await seedSession(context, USER_ID);
    // The tab.
    page = await context.newPage();
  });

  after(async () => {
    // Each closed if it started; a refused dist started none of them.
    if (page) await page.close().catch(() => {});
    // The context.
    if (context) await context.close().catch(() => {});
    // The browser.
    if (browser) await browser.close().catch(() => {});
    // The server.
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('sidebar navigation does not refetch the shell counts', async () => {
    // A cold load of a page that reads neither the counts nor application_events itself.
    await page.goto(`${base}/approvals`, { waitUntil: 'domcontentloaded' });
    // The badge appears once the shell's counts and badge reads landed (the bundle can take seconds to boot).
    await page.locator('.rail__count').waitFor({ timeout: 15_000 });
    // Then everything else in flight, landed too.
    await settle();
    // The cold load read the counts exactly once (it used to read them on mount AND when the user arrived).
    assert.equal(countSince(0, '/rest/v1/rpc/application_status_counts'), 1, `cold load counts reads; paths: ${seen.join(', ')}`);
    // The badge's kit read ran with it, once.
    assert.equal(countSince(0, '/rest/v1/application_events'), 1, 'cold load badge reads');
    // Everything after this index is caused by the clicks below.
    const mark = seen.length;
    // Two sidebar clicks to pages that read neither path themselves (Pipeline and Discovered read the counts
    // through the shared store, so they would also pass; Manual apply reads application_events itself).
    await navigate('/applied');
    // The Applied page's reads, landed.
    await settle();
    // A second click.
    await navigate('/answer-bank');
    // Its reads, landed.
    await settle();
    // The point of the change: no counts read on a click.
    assert.equal(countSince(mark, '/rest/v1/rpc/application_status_counts'), 0, `counts re-read on navigation; paths: ${seen.slice(mark).join(', ')}`);
    // And no badge read either.
    assert.equal(countSince(mark, '/rest/v1/application_events'), 0, `badge re-read on navigation; paths: ${seen.slice(mark).join(', ')}`);
    // The badge still shows the count it read once (one approved job), so nothing was lost by not re-reading.
    assert.equal(await page.locator('.rail__count [aria-hidden="true"]').innerText(), '1');
  });

  it('a status move re-reads the counts and the badge', async () => {
    // Everything after this index is caused by the move below.
    const mark = seen.length;
    // A status move as every page sends it: a POST to the advance_application_status RPC, from this tab.
    await page.evaluate((url) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).then((r) => r.status), `https://${PROJECT_REF}.supabase.co/rest/v1/rpc/advance_application_status`);
    // The shell's coalesced re-read (300 ms after the move) and the badge read that follows it.
    await settle();
    // The counts were re-read once for the move: a stale count after a move is the regression to catch.
    assert.equal(countSince(mark, '/rest/v1/rpc/application_status_counts'), 1, `counts after a move; paths: ${seen.slice(mark).join(', ')}`);
    // The badge followed the counts.
    assert.equal(countSince(mark, '/rest/v1/application_events'), 1, `badge after a move; paths: ${seen.slice(mark).join(', ')}`);
  });

  it("a page's counts refresh does not re-read the badge", async () => {
    // Pipeline, by a sidebar-style click: it reads the counts through the shared store, nothing of its own.
    await navigate('/pipeline');
    // Pipeline's own Refresh, by its unique title (other pages have Refresh buttons too, and the old page can linger a beat).
    const refresh = page.getByTitle('Reload pipeline counts from database');
    // Waited for, so the click below cannot race the render.
    await refresh.waitFor();
    // Anything the navigation started, landed.
    await settle();
    // Everything after this index is caused by the click below.
    const mark = seen.length;
    // The page's refetch(): the same call PipelineRunModal makes on open. It moves no row.
    await refresh.click();
    // The re-read, landed.
    await settle();
    // The counts were re-read once, for every caller of the store.
    assert.equal(countSince(mark, '/rest/v1/rpc/application_status_counts'), 1, `counts on Refresh; paths: ${seen.slice(mark).join(', ')}`);
    // The badge was not: its 3-4 reads follow only real moves, a tab return, or a new operator.
    assert.equal(countSince(mark, '/rest/v1/application_events'), 0, `badge re-read on a counts-only refresh; paths: ${seen.slice(mark).join(', ')}`);
  });

  it('navigation after the counts go stale re-reads them once', async () => {
    // A click inside the window first: still free.
    let mark = seen.length;
    // Within seconds of the last read (test 2's move).
    await navigate('/applied');
    // Its own reads, landed.
    await settle();
    // Inside the minute: no shell read.
    assert.equal(countSince(mark, '/rest/v1/rpc/application_status_counts'), 0, `fresh click re-read the counts; paths: ${seen.slice(mark).join(', ')}`);
    // The page's clock jumps 61 s ahead (Date.now only; timers keep real time, so the app and settle() still run).
    await page.evaluate(() => { const w = window as unknown as { realNow?: () => number }; w.realNow ??= Date.now.bind(Date); Date.now = () => w.realNow!() + 61_000; });
    // Everything after this index is caused by the stale click.
    mark = seen.length;
    // A click after the window.
    await navigate('/answer-bank');
    // The shell's re-read and the page's reads, landed.
    await settle();
    // Exactly one counts read for the stale click: agents' moves are never more than a minute out of view.
    assert.equal(countSince(mark, '/rest/v1/rpc/application_status_counts'), 1, `stale click counts reads; paths: ${seen.slice(mark).join(', ')}`);
    // And one badge read with it.
    assert.equal(countSince(mark, '/rest/v1/application_events'), 1, `stale click badge reads; paths: ${seen.slice(mark).join(', ')}`);
    // The re-read restamped the window, so the very next click is free again.
    mark = seen.length;
    // Straight after.
    await navigate('/applied');
    // Its reads, landed.
    await settle();
    // No shell read: one re-read per stale window, not one per click.
    assert.equal(countSince(mark, '/rest/v1/rpc/application_status_counts'), 0, `click after the re-read re-read again; paths: ${seen.slice(mark).join(', ')}`);
  });
});
