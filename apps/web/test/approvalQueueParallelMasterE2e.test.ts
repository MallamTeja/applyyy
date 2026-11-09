/* The Approval queue reads its masters without a second sequential round trip (2026-11-08).
 *
 * WHY. Supabase is in Sydney; each request costs ~0.3-0.5 s from India. loadQueue read the queue's rows,
 * THEN the pinned master versions those rows named: two round trips before any card painted. It now starts a
 * read of the NEWEST master alongside the rows and only fetches pinned versions the prefetch did not answer.
 *
 * WHAT IT PROVES, in the built bundle with every Supabase call answered by page routes:
 *   1. the newest-master read STARTS while the applications read is still unanswered (the route holds the rows
 *      until a master_profiles request arrives, or 2 s), and a row pinned to that newest version needs no
 *      per-version read at all;
 *   2. a row pinned to an OLDER version is still resolved against its own version: the per-version read is
 *      made, and the newest master is served MALFORMED, so resolving the row against it would refuse the row
 *      ("Master profile version missing") instead of rendering its card (CLAUDE.md §6).
 * RED-ON-REVERT: the pre-2026-11-08 loadQueue fails test 1 at "started before the rows were answered".
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
// The live row's three jsonb values, anonymised; the stored resume is pinned to MASTER_VERSION.
import { MASTER_V2, MASTER_VERSION, STORED_TAILORED_PROFILE, TAILOR_REFS } from './fixtures/gitlab-row-anonymised.ts';
// The shared browser-test harness: dist guard, static SPA server, fake session.
import { assertDistIsTestable, seedSession, startDistServer } from './support/e2eDist.ts';

// The operator the fake session signs in as.
const USER = { id: '0f4b24da-e85b-40bb-8606-c81824493b45', aud: 'authenticated', role: 'authenticated', email: 'operator@example.test' };
// One stamp for the row; nothing here writes, so its value only needs to be a real timestamp.
const STAMP = '2026-11-08T00:00:00.000000+00:00';
// The row's id; its card is #app-card-<id>.
const ROW_ID = '33333333-3333-4333-8333-333333333333';
// The one queued row, as the queue's select returns it, pinned to MASTER_VERSION by its stored resume.
const ROW = {
  id: ROW_ID,
  status: 'awaiting_approval',
  tailored_profile: STORED_TAILORED_PROFILE,
  tailor_refs: TAILOR_REFS,
  audit_findings: [],
  selected_jd_keywords: [],
  match_score: 80,
  cover_letter: null,
  updated_at: STAMP,
  status_changed_at: STAMP,
  created_at: STAMP,
  // The embedded job, in the select's own column list.
  jobs: { title: 'Parallel Master Engineer', company_name: 'Acme', employment_type: null, work_arrangement: 'remote', locations: [], salary_min: null, salary_max: null, salary_currency: null, discovered_via: null, source_refs: [], apply_url: 'https://example.com/jobs/3', description_raw: 'A backend role.', location_raw: null },
};

/* A PostgREST answer: a single object when the client asked for one, else an array (supabase-js has used both). */
function pgrst(accept: string | undefined, row: unknown): string {
  // The single-object media type means "one row, not a list"; null stays null there.
  if (accept?.includes('vnd.pgrst.object') === true) return JSON.stringify(row);
  // A list: empty for "no row".
  return JSON.stringify(row === null ? [] : [row]);
}

describe('Approval queue master reads (2026-11-08)', () => {
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
  // What the newest-master read returns in this test: the row's own version, or a newer malformed one.
  let newest: { version: number; profile: unknown } = { version: MASTER_VERSION, profile: MASTER_V2 };
  // Set the moment any master_profiles request arrives; the rows' answer waits for it (bounded).
  let masterStarted = false;
  // Whether a master read had started when the rows were answered; the property test 1 pins.
  let masterBeforeRows: boolean | null = null;
  // The per-version reads (version=eq.N), in order; test 1 expects none, test 2 exactly the pin.
  let versionReads: string[] = [];

  // Rethrown per test: a failed before() would CANCEL them (CLAUDE.md §5), which proves nothing.
  beforeEach(() => {
    // The guard's own message, as each test's failure.
    if (guardError) throw guardError;
    // Fresh per-test observations, so test 2 never reads test 1's.
    masterStarted = false;
    // Unknown until the rows are answered.
    masterBeforeRows = null;
    // No reads yet.
    versionReads = [];
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
      // A JSON answer.
      const json = (body: string) => route.fulfill({ status: 200, contentType: 'application/json', body });
      // The session's user.
      if (url.pathname.endsWith('/auth/v1/user')) return json(JSON.stringify(USER));
      // The masters: flagged on arrival, then answered by filter.
      if (url.pathname.endsWith('/rest/v1/master_profiles')) {
        // Arrival, before any answer: this is what lets the held rows tell "parallel" from "after".
        masterStarted = true;
        // The per-version read's filter, if this is one.
        const version = url.searchParams.get('version');
        // A per-version read: recorded, and answered only for the row's own pin.
        if (version !== null) {
          // Kept in order for the asserts.
          versionReads.push(version);
          // The pinned master exists; any other version is not stored.
          return json(pgrst(accept, version === `eq.${MASTER_VERSION}` ? { profile: MASTER_V2, version: MASTER_VERSION } : null));
        }
        // The newest-master read (no version filter): whatever this test set.
        return json(pgrst(accept, newest));
      }
      // The queue's read: HELD until a master read has started (or 2 s), so test 1 can see the order.
      if (url.pathname.endsWith('/rest/v1/applications') && url.searchParams.get('status') === 'eq.awaiting_approval') {
        // Bounded wait: a page that reads masters only after the rows still gets its rows, just late.
        for (let waited = 0; !masterStarted && waited < 2_000; waited += 25) await new Promise((resolve) => setTimeout(resolve, 25));
        // The observation, taken at the moment the rows are answered.
        masterBeforeRows = masterStarted;
        // The one queued row.
        return json(JSON.stringify([ROW]));
      }
      // Every other read (lanes, counts, events): empty.
      return json('[]');
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

  it('approval queue reads the newest master in parallel with its rows', async () => {
    // The newest master IS the row's pin: the common live case.
    newest = { version: MASTER_VERSION, profile: MASTER_V2 };
    // The queue page.
    await page.goto(`${baseUrl}/approvals`, { waitUntil: 'domcontentloaded' });
    // The row rendered as a reviewable card: the prefetched master resolved it.
    await page.locator(`#app-card-${ROW_ID}`).waitFor();
    // The property itself: the master read was already in flight when the rows came back.
    assert.equal(masterBeforeRows, true, 'the master_profiles read must have started before the applications read was answered');
    // And the pinned version needed no second round: the prefetch answered it.
    assert.deepEqual(versionReads, [], 'a row pinned to the newest master must not trigger a per-version read');
  });

  it('a row pinned to an older master still resolves against its own version', async () => {
    // A newer version exists and is MALFORMED: resolving the row against it would refuse the row.
    newest = { version: MASTER_VERSION + 1, profile: {} };
    // The queue page, fresh.
    await page.goto(`${baseUrl}/approvals`, { waitUntil: 'domcontentloaded' });
    // The card renders, so the row was diffed against a well-formed master: its own.
    await page.locator(`#app-card-${ROW_ID}`).waitFor();
    // The row's own version was read, exactly once.
    assert.deepEqual(versionReads, [`eq.${MASTER_VERSION}`], 'the older pin must be read by its own version');
    // And it was not refused as if its master were missing.
    assert.equal(await page.getByText('Master profile version missing', { exact: false }).count(), 0, 'the row must not be resolved against the newest master');
  });
});
