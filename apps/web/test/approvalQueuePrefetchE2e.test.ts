/* The Approval queue read starts BEFORE the page's code chunk arrives (2026-11-09).
 *
 * WHY. Routes are React.lazy chunks, so the queue's first read used to start only after
 * ApprovalQueuePage-<hash>.js had downloaded and mounted. Measured on the built bundle (86 rows, every
 * Supabase call held 300 ms, chunk held 150 ms): the shell's first request started at ~192 ms and the queue
 * read at ~308 ms, right after the chunk. The read is now kicked from App.tsx while the chunk downloads, and
 * the page consumes that one in-flight read instead of sending its own.
 *
 * WHAT IT PROVES, in the built bundle with every Supabase call answered by page routes:
 *   1. with the page chunk HELD, the queue read is already sent; once released, the cards paint from that
 *      read and no second queue read is sent (the page consumed the prefetch, it did not double the bytes);
 *   2. with no stored session the prefetch sends nothing: a signed-out read is an RLS-empty [] with no error,
 *      which would otherwise be cached and painted as "nothing waiting" after sign-in.
 * RED-ON-REVERT: without the App.tsx kick, test 1's waitForRequest times out while the chunk is held.
 *
 * Needs the e2e bundle: cd apps/web && ./node_modules/.bin/vite build --mode e2e (CI builds it first). */

// Strict asserts.
import assert from 'node:assert/strict';
// The Server type only: the shared harness starts it, after() closes it.
import type { Server } from 'node:http';
// The runner; beforeEach turns a guard failure into a FAILED test rather than a cancelled one.
import { after, before, beforeEach, describe, it } from 'node:test';
// The browser, already a dependency of this package.
import { chromium, type Browser, type BrowserContext, type Request } from 'playwright';
// A real stored row's jsonb values, anonymised, so the card builds a real diff.
import { MASTER_V2, MASTER_VERSION, STORED_TAILORED_PROFILE, TAILOR_REFS } from './fixtures/gitlab-row-anonymised.ts';
// The shared browser-test harness: dist guard, static SPA server, fake session.
import { assertDistIsTestable, seedSession, startDistServer } from './support/e2eDist.ts';

// The operator the fake session signs in as.
const USER = { id: '0f4b24da-e85b-40bb-8606-c81824493b45', aud: 'authenticated', role: 'authenticated', email: 'operator@example.test' };
// One stamp for the row.
const STAMP = '2026-11-09T00:00:00.000000+00:00';
// The one row's title, what test 1 waits to see painted.
const TITLE = 'Prefetched Role';
// The lazy page chunk, by Vite's default [name]-[hash].js; .js.map and .css end differently, so they don't match.
const CHUNK = '**/assets/ApprovalQueuePage-*.js';

/* The queue read, told apart from the deferred description read (same table and filter) by the column only
   the queue asks for. */
function isQueueRead(url: string): boolean {
  // Parsed, so the check reads the decoded select rather than an encoding of it.
  const parsed = new URL(url);
  // Same table, same status filter, and the first-paint column.
  return parsed.pathname.endsWith('/rest/v1/applications')
    && parsed.searchParams.get('status') === 'eq.awaiting_approval'
    && (parsed.searchParams.get('select') ?? '').includes('tailored_profile');
}

/* Every Supabase call answered locally; counts the queue reads it serves. */
async function routeSupabase(context: BrowserContext, onQueueRead: () => void): Promise<void> {
  // One handler for the whole project URL; nothing reaches the network.
  await context.route('https://*.supabase.co/**', async (route) => {
    // The request's parts the answers depend on.
    const request = route.request();
    // Parsed once.
    const url = new URL(request.url());
    // Which representation a read asked for.
    const accept = request.headers()['accept'];
    // A 200 JSON answer.
    const json = (body: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    // The session's user.
    if (url.pathname.endsWith('/auth/v1/user')) return json(USER);
    // The queue read: counted, then one row the card can render.
    if (request.method() === 'GET' && isQueueRead(request.url())) {
      // Counted here, at the server, so a second read cannot hide behind a cached answer.
      onQueueRead();
      // The columns the page reads; the jobs embed matches the queue's select.
      return json([{ id: '66666666-6666-4666-8666-000000000000', status: 'awaiting_approval', master_version: MASTER_VERSION, tailored_profile: STORED_TAILORED_PROFILE, tailor_refs: TAILOR_REFS, audit_findings: [], selected_jd_keywords: [], match_score: 80, cover_letter: null, updated_at: STAMP, status_changed_at: STAMP, created_at: STAMP, jobs: { title: TITLE, company_name: 'Acme', employment_type: null, work_arrangement: 'remote', locations: [], salary_min: null, salary_max: null, salary_currency: null, discovered_via: null, source_refs: [], apply_url: 'https://example.com/jobs/1', location_raw: 'Remote' } }]);
    }
    // The pinned master the row was tailored from (and the newest), as object or array by Accept.
    if (url.pathname.endsWith('/rest/v1/master_profiles')) return json(accept?.includes('vnd.pgrst.object') === true ? { profile: MASTER_V2, version: MASTER_VERSION } : [{ profile: MASTER_V2, version: MASTER_VERSION }]);
    // Every other read (counts, lanes, descriptions): empty.
    return json([]);
  });
}

describe('Approval queue read starts before the page chunk arrives (2026-11-09)', () => {
  // The static server.
  let server: Server;
  // Where it listens.
  let baseUrl: string;
  // Chromium.
  let browser: Browser;
  // A dist that cannot prove anything, recorded so each test fails by name instead of being cancelled.
  let guardError: Error | undefined;

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
    // The shared SPA server on a free loopback port.
    ({ server, base: baseUrl } = await startDistServer());
    // Headless, as CI runs it.
    browser = await chromium.launch({ headless: true });
  });

  after(async () => {
    // Each closed only if it was opened.
    if (browser) await browser.close().catch(() => {});
    // The server.
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('1. with the page chunk held, the queue read is already sent, and the page paints from that one read', async () => {
    // A fresh context per test, so no route or session leaks between them.
    const context = await browser.newContext();
    // Queue reads served; 1 expected.
    let queueReads = 0;
    // Release for the held chunk; assigned synchronously by the Promise constructor.
    let release!: () => void;
    // The gate the chunk waits on.
    const gate = new Promise<void>((resolve) => { release = resolve; });
    try {
      // Every Supabase call answered locally, the queue reads counted.
      await routeSupabase(context, () => { queueReads += 1; });
      // The page chunk HELD until the assert below has seen the queue read go out.
      await context.route(CHUNK, async (route) => { await gate; await route.continue(); });
      // The stored session supabase-js reads on boot.
      await seedSession(context, USER.id);
      // The one page.
      const page = await context.newPage();
      // Armed BEFORE navigation, so a read sent during boot is not missed.
      const queueRead = page.waitForRequest((request: Request) => isQueueRead(request.url()), { timeout: 5_000 });
      // The queue page, fresh. Not awaited past DOM ready: the chunk is held, so nothing would settle.
      await page.goto(`${baseUrl}/approvals`, { waitUntil: 'domcontentloaded' });
      // THE PROPERTY: the read leaves while the page's own code cannot have run yet.
      await queueRead;
      // Still held at this point, so the order is proven, not raced.
      release();
      // The card, painted from that read once the chunk arrives.
      await page.getByText(TITLE, { exact: true }).first().waitFor({ timeout: 10_000 });
      // Exactly one queue read: the page consumed the prefetch rather than sending its own (bytes not doubled).
      assert.equal(queueReads, 1, `expected the page to reuse the prefetched read, saw ${queueReads} queue reads`);
    } finally {
      // Released on any failure path too, so a held route never outlives the test.
      release();
      // The context and its routes.
      await context.close().catch(() => {});
    }
  });

  it('2. with no stored session, nothing is prefetched', async () => {
    // A fresh context with NO seeded session.
    const context = await browser.newContext();
    // Queue reads served; 0 expected.
    let queueReads = 0;
    try {
      // Every Supabase call answered locally, the queue reads counted.
      await routeSupabase(context, () => { queueReads += 1; });
      // The one page.
      const page = await context.newPage();
      // The queue page, fresh, signed out.
      await page.goto(`${baseUrl}/approvals`, { waitUntil: 'domcontentloaded' });
      // The shell's sign-in gate: proof the app booted and decided "signed out" (where a prefetch would have fired).
      await page.getByRole('button', { name: /sign in/i }).first().waitFor({ timeout: 10_000 });
      // No read went out without a session: an RLS-empty [] would read as "nothing waiting".
      assert.equal(queueReads, 0, `a signed-out boot sent ${queueReads} queue reads`);
    } finally {
      // The context and its routes.
      await context.close().catch(() => {});
    }
  });
});
