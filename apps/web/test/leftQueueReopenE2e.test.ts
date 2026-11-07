/* "Left your queue" Re-open on the Manual apply page (/manual-apply) in a real browser, 2026-11-07.
 *
 * WHY A BROWSER TEST ON TOP OF leftQueueSection.test.ts. The static test proves the section renders and that
 * the page source wires it; this proves the page: the collapsed section opens, Re-open arms the inline confirm
 * (never a browser dialog), Confirm sends exactly one advance_application_status as human from `failed` to
 * `needs_verification` with the row's stamp verbatim and source 'manual_apply_reopen', and BOTH lists re-read:
 * the row leaves the section and comes back as a needs_verification card. It serves the e2e bundle (dist/,
 * `vite build --mode e2e`) and answers every Supabase call locally, so a click here never reaches the live database.
 *
 * HOW THE STUBS TELL THE READS APART (manualApplyData.ts vs leftQueue.ts): applications read with
 * `status=not.in.(...)` is the section; `status=in.(...)` is a card lane read; `id=in.(...)` is the kit-row read.
 * application_events read with `application_id=in.(...)` is the section's events; the kit read filters
 * `event_type=eq.note` with no application_id.
 *
 * RED-ON-REVERT: removing <LeftQueueSection> from ManualApplyPage fails test 1 at the summary; passing
 * 'manual_apply' (the cards' hook) as onReopen fails it at the RPC body; reloading only the section after a
 * move fails it at the needs_verification card. */

// Strict asserts, like the other browser tests.
import assert from 'node:assert/strict';
// The server type.
import type { Server } from 'node:http';
// node:test, like every other web test (package.json "test").
import { describe, it, before, beforeEach, after } from 'node:test';
// Real Chromium; the same Playwright the e2e suite uses (apps/web/node_modules).
import { chromium, type Browser, type BrowserContext, type Dialog, type Page } from 'playwright';
// The shared harness (test/support/e2eDist.ts): dist guard, static SPA server, fake session.
import { assertDistIsTestable, seedSession, startDistServer } from './support/e2eDist.ts';

// The operator the fake session and the auth answers name.
const USER_ID = '0f4b24da-e85b-40bb-8606-c81824493b45';

// The job, as PostgREST nests it; shared by the section row and the card the row becomes.
const JOB = { title: 'E2E Backend Intern', company_name: 'Zomato', apply_url: 'https://example.com/jobs/9' };
// The label every screen builds from that job (rowLabel).
const LABEL = 'E2E Backend Intern at Zomato';
// The row's id: the RPC target and the confirm key.
const ROW_ID = 'c1b2c3d4-0000-4000-8000-000000000003';
// The stale-stamp guard's value, sent back verbatim as p_expected_updated_at (microseconds kept on purpose).
const STAMP = '2026-11-06T09:10:00.123456+00:00';

// The row as the section's applications read returns it: failed, with its inner-joined approve event.
const LEFT_ROW = { id: ROW_ID, status: 'failed', updated_at: STAMP, jobs: JOB, application_events: [{ created_at: '2026-11-05T08:00:00+00:00' }] };
// The same row after the Re-open lands: a needs_verification lane row (status_changed_at as the card read selects it).
const LANE_ROW = { id: ROW_ID, status: 'needs_verification', updated_at: '2026-11-07T10:00:00+00:00', status_changed_at: '2026-11-07T10:00:00+00:00', tailored_profile: null, jobs: JOB };

// How it left: approved -> failed by a clean-up script, plus the note written in the same transaction.
const LEFT_EVENTS = [
  // The exit itself; created_at is the pairing key with the note below.
  { application_id: ROW_ID, event_type: 'status_change', agent: 'human', from_status: 'approved', to_status: 'failed', created_at: '2026-11-06T09:10:00+00:00', detail: null },
  // The reason, read by the section's parse.
  { application_id: ROW_ID, event_type: 'note', agent: 'human', from_status: null, to_status: null, created_at: '2026-11-06T09:10:00+00:00', detail: { source: 'retro_script', stage: 'retro_liveness_2026_11_05', reason: 'posting_stale', detail: 'The posting was gone when the liveness check ran.' } },
];

describe('Manual apply "Left your queue" Re-open in a browser (fake session, every Supabase call answered locally)', () => {
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
  // Requests to the one write path; must stay 0 until a Confirm.
  let rpcCalls = 0;
  // The last write's JSON body, to pin actor, source, target and stamp.
  let rpcBody: unknown = null;
  // Whether the mocked database has applied the Re-open: it moves the row from the section to the lanes.
  let reopened = false;
  // Browser dialogs (confirm/alert/prompt) opened; must stay 0 everywhere.
  let dialogs = 0;

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
    context = await browser.newContext();
    // EVERY Supabase call answered here: nothing can reach the live project.
    await context.route('https://*.supabase.co/**', async (route) => {
      // The request's URL, parsed for its filters.
      const url = new URL(route.request().url());
      // A JSON answer.
      const json = (status: number, body: unknown) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
      // Auth: the seeded session's user.
      if (url.pathname.startsWith('/auth/v1/')) return json(200, { id: USER_ID, aud: 'authenticated', role: 'authenticated', email: 'operator@example.test' });
      // The one write path: counted, its body kept; the row moves, as in the database.
      if (url.pathname === '/rest/v1/rpc/advance_application_status') {
        // Counted first.
        rpcCalls += 1;
        // The arguments the page sent.
        rpcBody = route.request().postDataJSON();
        // The row is now needs_verification: out of the section, into the lanes.
        reopened = true;
        // Accepted (200 + null, like the real RPC).
        return route.fulfill({ status: 200, contentType: 'application/json', body: 'null' });
      }
      // The section's events read (by application id); the kit read has no such filter and finds no kits.
      if (url.pathname === '/rest/v1/application_events') return json(200, (url.searchParams.get('application_id') ?? '').startsWith('in.') ? LEFT_EVENTS : []);
      // The applications reads, told apart by their status / id filters (see the header).
      if (url.pathname === '/rest/v1/applications') {
        // The status filter, if any.
        const status = url.searchParams.get('status') ?? '';
        // The section: the failed row until it is re-opened.
        if (status.startsWith('not.in.')) return json(200, reopened ? [] : [LEFT_ROW]);
        // The lanes read (needs_verification, blocked_needs_human): the re-opened row lands here.
        if (status.startsWith('in.') && status.includes('needs_verification')) return json(200, reopened ? [LANE_ROW] : []);
        // The approved read and the kit-row read: nothing else is open.
        return json(200, []);
      }
      // Every other read the shell makes: an empty list.
      return json(200, []);
    });
    // The fake session (shared harness).
    await seedSession(context, USER_ID);
    // The tab.
    page = await context.newPage();
    // Counts AND dismisses, so a restored window.confirm fails by name instead of hanging the test.
    page.on('dialog', (d: Dialog) => {
      // Counted first.
      dialogs += 1;
      // Dismissed, as a Cancel would.
      void d.dismiss().catch(() => {});
    });
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

  it('1. Re-open on a failed row: inline confirm, one write as human failed -> needs_verification, both lists re-read', async () => {
    // Fresh state for this test.
    reopened = false;
    // The page.
    await page.goto(`${base}/manual-apply`, { waitUntil: 'domcontentloaded' });
    // The section's summary, with its count once the read is ready.
    const summary = page.locator('details.left-queue > summary', { hasText: 'Left your queue (1)' });
    // Rendered.
    await summary.waitFor();
    // Collapsed by default: opened the way the operator would.
    await summary.click();
    // The why line is read from the paired note.
    await page.getByText('The posting was gone when the liveness check ran.', { exact: false }).waitFor();
    // The move under test, named for its row.
    const moveName = `Re-open: ${LABEL}`;
    // Arm: the first click only asks.
    await page.getByRole('button', { name: moveName, exact: true }).click();
    // The confirm's Confirm, named for the move.
    const confirm = page.getByRole('button', { name: `Confirm: ${moveName}`, exact: true });
    // Rendered on arming.
    await confirm.waitFor();
    // Arming wrote nothing.
    assert.equal(rpcCalls, 0, 'the first click must not write');
    // The write that leaves on Confirm; a restored popup would block it (timeout -> null).
    const write = page.waitForRequest('**/rest/v1/rpc/advance_application_status', { timeout: 5_000 }).catch(() => null);
    // Confirm.
    await confirm.click();
    // Settled once the mocked answer exists.
    await (await write)?.response();
    // No browser dialog at any step.
    assert.equal(dialogs, 0, 'a browser dialog opened: every move must ask inline');
    // Exactly one write for one Confirm.
    assert.equal(rpcCalls, 1, 'Confirm must send exactly one advance_application_status');
    // As human, failed -> needs_verification, logged as the Re-open (buildRecoveryArgs in advanceRecovery.ts), stamp verbatim.
    assert.deepEqual(rpcBody, { p_application_id: ROW_ID, p_to_status: 'needs_verification', p_agent: 'human', p_detail: { source: 'manual_apply_reopen', from: 'failed' }, p_expected_updated_at: STAMP });
    // The section re-read: the row left it.
    await page.locator('details.left-queue > summary', { hasText: 'Left your queue (0)' }).waitFor();
    // The page re-read too: the row is back as a needs_verification card.
    await page.getByRole('region', { name: `Manual apply: ${LABEL}`, exact: true }).waitFor();
    // And the outcome is readable in the strip.
    await page.locator('.recovery__notes li', { hasText: LABEL }).waitFor();
  });
});
