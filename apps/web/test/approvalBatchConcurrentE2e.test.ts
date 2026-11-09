/* "Approve all" settles its rows concurrently, each row still on its own (2026-11-08).
 *
 * WHY. settle() moved Bucket A one row at a time: confirmFresh, then the advance RPC, two sequential round
 * trips per row (~0.3 s each to Sydney), so 10 rows took ~6 s. It now runs SETTLE_CONCURRENCY rows at once.
 *
 * WHAT IT PROVES, in the built bundle with every Supabase call answered by page routes, each confirmFresh
 * read and each RPC held DELAY_MS so the calls genuinely overlap or don't:
 *   1. more than one row's call is in flight at once, and the batch beats the serial floor (rows x 2 x DELAY);
 *   2. one row the database refuses is reported as the one failure, every other row is approved exactly once,
 *      and the summary toasts say so (the per-row outcome lists never bleed into each other).
 * RED-ON-REVERT: the one-row-at-a-time loop fails test 1 at "more than one call in flight".
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
// The live row's three jsonb values, anonymised; unedited, so every row lands in Bucket A.
import { MASTER_V2, MASTER_VERSION, STORED_TAILORED_PROFILE, TAILOR_REFS } from './fixtures/gitlab-row-anonymised.ts';
// The shared browser-test harness: dist guard, static SPA server, fake session.
import { assertDistIsTestable, seedSession, startDistServer } from './support/e2eDist.ts';

// The operator the fake session signs in as.
const USER = { id: '0f4b24da-e85b-40bb-8606-c81824493b45', aud: 'authenticated', role: 'authenticated', email: 'operator@example.test' };
// One stamp for every row; confirmFresh compares the stored one to it, so every row reads "fresh".
const STAMP = '2026-11-08T00:00:00.000000+00:00';
// How long each confirmFresh read and each RPC is held: long enough that overlap is unmistakable.
const DELAY_MS = 300;
// Six rows: more than one wave at a cap of 4, few enough to stay quick.
const ROW_COUNT = 6;
// The row ids, numbered so a failure names which one.
const IDS = Array.from({ length: ROW_COUNT }, (_, i) => `44444444-4444-4444-8444-00000000000${i}`);
// The row the database refuses in test 2: in the middle, so rows on both sides of it are checked.
const FAIL_ID = IDS[2];

/* One queued application as the queue's select returns it; the stored resume unedited, so Bucket A. */
function queueRow(id: string, index: number): Record<string, unknown> {
  // Only the columns the page reads.
  return {
    id,
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
    // The embedded job; a distinct title per row.
    jobs: { title: `Batch Row ${index}`, company_name: 'Acme', employment_type: null, work_arrangement: 'remote', locations: [], salary_min: null, salary_max: null, salary_currency: null, discovered_via: null, source_refs: [], apply_url: `https://example.com/jobs/b${index}`, description_raw: 'A backend role.', location_raw: null },
  };
}

// Every row, in the order the queue returns them.
const ROWS = IDS.map((id, index) => queueRow(id, index));

/* A PostgREST answer: a single object when the client asked for one, else an array (supabase-js has used both). */
function pgrst(accept: string | undefined, row: unknown): string {
  // The single-object media type means "one row, not a list".
  return JSON.stringify(accept?.includes('vnd.pgrst.object') === true ? row : [row]);
}

describe('Approve all settles rows concurrently (2026-11-08)', () => {
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
  // Whether FAIL_ID's RPC is refused in this test.
  let refuseOne = false;
  // confirmFresh reads and RPCs in flight right now.
  let inFlight = 0;
  // The most that were ever in flight at once in this test.
  let maxInFlight = 0;
  // The RPCs the page sent, by row id, in arrival order.
  let writes: string[] = [];
  // Native dialogs opened; must stay 0 (repo rule).
  let dialogs = 0;

  /* Holds one settle-path call for DELAY_MS while counting it as in flight. */
  async function held(): Promise<void> {
    // In flight from arrival.
    inFlight += 1;
    // The high-water mark is the property test 1 reads.
    maxInFlight = Math.max(maxInFlight, inFlight);
    // The simulated round trip.
    await new Promise((resolve) => setTimeout(resolve, DELAY_MS));
    // Answered.
    inFlight -= 1;
  }

  // Rethrown per test: a failed before() would CANCEL them (CLAUDE.md §5), which proves nothing.
  beforeEach(() => {
    // The guard's own message, as each test's failure.
    if (guardError) throw guardError;
    // Fresh observations per test.
    inFlight = 0;
    // Same.
    maxInFlight = 0;
    // Same.
    writes = [];
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
      const json = (status: number, body: string) => route.fulfill({ status, contentType: 'application/json', body });
      // The session's user.
      if (url.pathname.endsWith('/auth/v1/user')) return json(200, JSON.stringify(USER));
      // THE WRITE PATH: held, counted by row, and refused for FAIL_ID when the test asks.
      if (url.pathname.endsWith('/rest/v1/rpc/advance_application_status')) {
        // The row it moves.
        const id = String((request.postDataJSON() as { p_application_id?: unknown }).p_application_id);
        // Recorded on arrival.
        writes.push(id);
        // The simulated round trip.
        await held();
        // A database refusal with its own SQLSTATE: a plain failure, no re-read (settle's item 6 rules).
        if (refuseOne && id === FAIL_ID) return json(400, JSON.stringify({ code: 'P0001', message: 'refused by test', details: null, hint: null }));
        // 200 + null: the RPC's own success shape.
        return json(200, 'null');
      }
      // The applications reads: the queue, and confirmFresh's per-row stamp check.
      if (url.pathname.endsWith('/rest/v1/applications') && request.method() === 'GET') {
        // The queue's read.
        if (url.searchParams.get('status') === 'eq.awaiting_approval') return json(200, JSON.stringify(ROWS));
        // confirmFresh: the stored row, unchanged since load.
        const row = ROWS.find((candidate) => url.searchParams.get('id') === `eq.${String(candidate.id)}`);
        // Held like the RPC, then "fresh": same stamp, still awaiting.
        if (row !== undefined) {
          // The simulated round trip.
          await held();
          // Same stamp and status as loaded.
          return json(200, pgrst(accept, { tailored_profile: row.tailored_profile, updated_at: STAMP, status: 'awaiting_approval' }));
        }
      }
      // The pinned master every row was tailored from (and the newest).
      if (url.pathname.endsWith('/rest/v1/master_profiles')) return json(200, pgrst(accept, { profile: MASTER_V2, version: MASTER_VERSION }));
      // Every other read (lanes, counts, events): empty.
      return json(200, '[]');
    });
    // The stored session supabase-js reads on boot.
    await seedSession(context, USER.id);
    // The one page.
    page = await context.newPage();
    // Counted AND dismissed, so a native dialog fails by name instead of hanging the run.
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

  /* Loads the queue and clicks "Approve all"; resolves once the summary toast for the approvals is shown. */
  async function approveAll(expectedToast: string): Promise<number> {
    // The queue page, fresh: every row is served awaiting again.
    await page.goto(`${baseUrl}/approvals`, { waitUntil: 'domcontentloaded' });
    // The batch button, with every row counted into Bucket A.
    const button = page.getByRole('button', { name: `Approve all ${ROW_COUNT} and queue for submission`, exact: true });
    // Rendered once the queue loaded.
    await button.waitFor();
    // From the click.
    const started = Date.now();
    // One click for the whole batch.
    await button.click();
    // The approvals' summary.
    await page.getByText(expectedToast, { exact: false }).waitFor();
    // How long the batch took, click to summary.
    return Date.now() - started;
  }

  it('batch approve runs rows concurrently', async () => {
    // Every row accepted.
    refuseOne = false;
    // Click and wait for the summary.
    const took = await approveAll(`Approved ${ROW_COUNT} applications and queued for submission.`);
    // The property itself: rows overlapped.
    assert.ok(maxInFlight > 1, `more than one call in flight at once (saw ${maxInFlight})`);
    // And it shows in wall time: one row at a time is at least rows x 2 calls x DELAY_MS.
    assert.ok(took < ROW_COUNT * 2 * DELAY_MS, `batch took ${took} ms, not under the serial floor ${ROW_COUNT * 2 * DELAY_MS} ms`);
    // Every row written exactly once.
    assert.deepEqual([...writes].sort(), [...IDS].sort());
  });

  it('one failed row in a batch leaves the others\' outcomes intact', async () => {
    // FAIL_ID is refused by the database; the rest are accepted.
    refuseOne = true;
    // The approvals' summary counts only the accepted rows.
    await approveAll(`Approved ${ROW_COUNT - 1} applications and queued for submission.`);
    // The one refusal is reported as exactly one failure.
    await page.getByText('1 application could not be recorded and is still waiting.', { exact: false }).waitFor();
    // Every row was sent exactly once: the failure stopped no other row and retried none.
    assert.deepEqual([...writes].sort(), [...IDS].sort());
    // The refused row is still in the queue for the operator to retry.
    await page.locator(`#app-card-${FAIL_ID}`).waitFor();
    // And every accepted row left it.
    for (const id of IDS.filter((candidate) => candidate !== FAIL_ID)) assert.equal(await page.locator(`#app-card-${id}`).count(), 0, `row ${id} was approved and must leave the queue`);
    // No native dialog at any step.
    assert.equal(dialogs, 0);
  });
});
