/* Mark applied / Failed on the Manual apply kit card (/manual-apply) in a real browser, 2026-11-05.
 *
 * WHY A BROWSER TEST ON TOP OF manualApplyResolve.test.ts. The static test proves the buttons render; this
 * proves the page: the click arms the inline confirm (never a browser dialog), Confirm sends exactly one
 * advance_application_status as human from `approved` with the row's stamp verbatim, and the page re-reads
 * so the resolved card leaves. It serves the e2e bundle (dist/, `vite build --mode e2e`) and answers every
 * Supabase call locally, so a click here can never reach the live database.
 *
 * FIXTURE MIRRORS LIVE (2026-11-05 12:06 IST): the open kit rows are all at `approved` (4 live), none in the
 * manual-action lanes (0 live). One approved row and one applying row are enough to pin both card shapes.
 *
 * RED-ON-REVERT: dropping the card's RecoveryMoves (or the two approved edges from status-flow.ts) fails
 * test 1 at the missing "Failed / skip" / "I applied" button; hard-coding p_detail.source back to
 * 'health_recovery' fails test 1 at the RPC body. */

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

// The approved row with an open kit: the live shape of every manual apply today.
const ROW_APPROVED = {
  // The RPC target and the confirm key.
  id: 'b1b2c3d4-0000-4000-8000-000000000001',
  // Approved: the worker never submitted it, so it is applied to by hand.
  status: 'approved',
  // The stale-stamp guard's value, sent back verbatim as p_expected_updated_at.
  updated_at: '2026-11-05T06:30:00.123456+00:00',
  // The job, as PostgREST nests it.
  jobs: { title: 'E2E Platform Engineer', company_name: 'Initech', apply_url: 'https://example.com/jobs/7' },
};

// A row the worker is submitting right now: its card must offer no resolve.
const ROW_APPLYING = {
  // A second row.
  id: 'b1b2c3d4-0000-4000-8000-000000000002',
  // In flight.
  status: 'applying',
  // The stamp.
  updated_at: '2026-11-05T06:31:00+00:00',
  // The job.
  jobs: { title: 'E2E Site Reliability Engineer', company_name: 'Hooli', apply_url: 'https://example.com/jobs/8' },
};

// One valid v1 kit note per row (applyKit.ts contract), so each row is read by id as an open kit row.
const kitEvent = (applicationId: string) => ({
  // The exact join key.
  application_id: applicationId,
  // Any valid stamp; one note per row, so "newest" is this one.
  created_at: '2026-11-05T06:00:00+00:00',
  // The smallest kit the parser accepts: one answered field, no resume, no warnings.
  detail: {
    kind: 'apply_kit', v: 1, generated_at: '2026-11-05T06:00:00Z', run_id: 'run-e2e', form_url: 'https://example.com/form',
    resume: null, fields: [{ label: 'First Name', value: 'Teja', source: 'identity', required: true, input_type: 'text' }], warnings: [],
  },
});

describe('Manual apply kit card resolves in a browser (fake session, every Supabase call answered locally)', () => {
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
  // Rows the mocked database still holds open; a landed move removes its row, as the real one would.
  let open = [ROW_APPROVED, ROW_APPLYING];
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
      // The one write path: counted, its body kept; a landed move leaves the open set, as in the database.
      if (url.pathname === '/rest/v1/rpc/advance_application_status') {
        // Counted first.
        rpcCalls += 1;
        // The arguments the page sent.
        rpcBody = route.request().postDataJSON();
        // The moved row is no longer open.
        open = open.filter((r) => r.id !== (rpcBody as { p_application_id?: unknown }).p_application_id);
        // Accepted (200 + null, like the real RPC).
        return route.fulfill({ status: 200, contentType: 'application/json', body: 'null' });
      }
      // The kit notes: one per row, so the page reads both rows by id.
      if (url.pathname === '/rest/v1/application_events') return json(200, [kitEvent(ROW_APPROVED.id), kitEvent(ROW_APPLYING.id)]);
      // The rows: the lanes read (status=in.(...)) finds none, as live; the kit read (id=in.(...)) finds the open ones.
      if (url.pathname === '/rest/v1/applications') return json(200, (url.searchParams.get('id') ?? '').startsWith('in.') ? open : []);
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

  // One job's card, by its landmark name.
  const card = (label: string) => page.getByRole('region', { name: `Manual apply: ${label}`, exact: true });

  it('1. an approved card marks applied through the inline confirm: one write, as human, stamp verbatim', async () => {
    // Fresh state for this test.
    open = [ROW_APPROVED, ROW_APPLYING];
    // The page.
    await page.goto(`${base}/manual-apply`, { waitUntil: 'domcontentloaded' });
    // The approved card, rendered.
    await card('E2E Platform Engineer at Initech').waitFor();
    // The move under test, named for its row like every recovery button.
    const moveName = 'I applied (mark applied): E2E Platform Engineer at Initech';
    // Both resolves exist on the approved card (the give-up one too).
    assert.equal(await card('E2E Platform Engineer at Initech').getByRole('button', { name: 'Failed / skip: E2E Platform Engineer at Initech', exact: true }).count(), 1);
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
    // As human, from approved to applied, logged as the Manual apply card, with the row's stamp verbatim.
    assert.deepEqual(rpcBody, { p_application_id: ROW_APPROVED.id, p_to_status: 'applied', p_agent: 'human', p_detail: { source: 'manual_apply', from: 'approved' }, p_expected_updated_at: ROW_APPROVED.updated_at });
    // The page re-read: the resolved card leaves.
    await card('E2E Platform Engineer at Initech').waitFor({ state: 'detached' });
    // And the outcome stays readable in the strip after its card is gone.
    await page.locator('.recovery__notes li', { hasText: 'E2E Platform Engineer at Initech' }).waitFor();
  });

  it('2. an applying card offers no resolve and says the worker owns it', async () => {
    // Fresh state for this test.
    open = [ROW_APPROVED, ROW_APPLYING];
    // The page.
    await page.goto(`${base}/manual-apply`, { waitUntil: 'domcontentloaded' });
    // The applying card.
    const applying = card('E2E Site Reliability Engineer at Hooli');
    // Rendered.
    await applying.waitFor();
    // Said, not hidden.
    assert.equal(await applying.getByText('In flight: the worker owns it.', { exact: false }).count(), 1);
    // No resolve button of either kind on it.
    assert.equal(await applying.getByRole('button', { name: /I applied|Failed \/ skip/ }).count(), 0);
  });
});
