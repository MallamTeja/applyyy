/* The Emails page (/emails) in a real browser, 2026-11-05: the stored class on every badge, the
 * "Not tracked" filter, the in-app read mark, "Last checked" after a cooldown answer, and Add to Applied.
 * Serves the e2e bundle (dist/, `vite build --mode e2e`) and answers every Supabase call locally, so no
 * click here can reach the live database. Every assertion first WAITS on the thing it reads (the
 * 2026-11-05 CI flake: a read right after navigation raced React's render).
 *
 * FIXTURES MIRROR LIVE (2026-11-05 12:41 IST): a HackerRank receipt (application_received, unmatched),
 * a LinkedIn alert (job_alert), an interview invite already tracked, and an unclassified promo.
 *
 * RED-ON-REVERT: putting the hard-coded "Interview Invite" badge back fails test 1 at the HackerRank
 * badge; reading "Last checked" from this visit's sync alone fails test 1 at the time; skipping the
 * duplicate lookup fails test 5 (it would create a second HackerRank job). */

// Strict asserts.
import assert from 'node:assert/strict';
// The server type.
import type { Server } from 'node:http';
// node:test.
import { describe, it, before, beforeEach, after } from 'node:test';
// Real Chromium; the Playwright the other browser tests use.
import { chromium, type Browser, type BrowserContext, type Dialog, type Page } from 'playwright';
// The shared harness: dist guard, static server, fake session.
import { assertDistIsTestable, seedSession, startDistServer } from './support/e2eDist.ts';
// Type-only (erased at runtime): the fixtures are typed as the real email_events row, so a renamed or
// dropped column breaks this file at compile time instead of drifting silently.
import type { EmailEventRow } from '../src/data/contract.ts';

// The operator.
const USER_ID = '0f4b24da-e85b-40bb-8606-c81824493b45';
// The tracker's newest successful run, as agent_runs stores it.
const TRACKER_FINISHED_AT = '2026-11-05T07:24:02.000000+00:00';

// One email row as the page's select('*') returns it; `over` replaces fields.
// `over` must carry the per-email columns with no sensible default (id, sender, subject, verdict, time);
// the declared return type is what lets callers read RECEIPT.id (Record<string, unknown> hid it).
type EmailOver = Partial<EmailEventRow> & Pick<EmailEventRow, 'id' | 'provider_message_id' | 'from_address' | 'subject' | 'classification' | 'received_at'>;
const email = (over: EmailOver): EmailEventRow => ({
  user_id: USER_ID, thread_id: null, recipient_to: null, label_ids: null, classification_confidence: 0.9,
  processed_at: null, created_at: '2026-11-04T19:19:00+00:00', read_at: null, matched_application_id: null, snippet: '', ...over,
});

// The four live shapes.
const RECEIPT = email({ id: 'e1000000-0000-4000-8000-000000000001', provider_message_id: 'm1', from_address: 'HackerRank Careers <careers@hackerrankcareers.com>', subject: 'We have received your Application || AI Researcher Intern', classification: 'application_received', received_at: '2026-11-04T19:19:00+00:00' });
const ALERT = email({ id: 'e1000000-0000-4000-8000-000000000002', provider_message_id: 'm2', from_address: 'LinkedIn Job Alerts <jobalerts-noreply@linkedin.com>', subject: 'Software Engineer: Google and 10 more jobs', classification: 'job_alert', received_at: '2026-11-04T18:00:00+00:00' });
const TRACKED = email({ id: 'e1000000-0000-4000-8000-000000000003', provider_message_id: 'm3', from_address: 'Acme <talent@acme.com>', subject: 'Interview invitation', classification: 'interview_invite', matched_application_id: 'a1000000-0000-4000-8000-000000000009', received_at: '2026-11-04T17:00:00+00:00', read_at: '2026-11-04T17:30:00+00:00' });
const PROMO = email({ id: 'e1000000-0000-4000-8000-000000000004', provider_message_id: 'm4', from_address: 'Simplilearn <info@simplilearnmailer.com>', subject: '', classification: 'unclassified', received_at: '2026-11-04T16:00:00+00:00' });

describe('Emails page in a browser (fake session, every Supabase call answered locally)', () => {
  // The static server and its address.
  let server: Server;
  let base: string;
  // Chromium, its context and the tab.
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;
  // Set when dist/ cannot prove anything; rethrown per test.
  let guardError: Error | undefined;
  // The rows the mocked table holds; writes change them as the database would.
  // Typed as the real row (was Record<string, unknown>[]), so the typed fixtures below fit and r.id is a string.
  let rows: EmailEventRow[] = [];
  // Writes seen: read-mark PATCHes and track RPCs, with their bodies.
  const patches: unknown[] = [];
  const rpcs: unknown[] = [];
  // The duplicate lookups the page sent.
  const appReads: string[] = [];
  // What the lookup finds; test 4 has none, test 5 has the HackerRank one.
  let existingApps: unknown[] = [];
  // Browser dialogs opened; must stay 0.
  let dialogs = 0;

  // A guard failure marks each test FAILED with its reason.
  beforeEach(() => {
    // Rethrown, not thrown in before(): cancelled tests read as "fail 0".
    if (guardError) throw guardError;
  });

  before(async () => {
    // The guard's outcome, recorded.
    guardError = await assertDistIsTestable().then(() => undefined, (e: unknown) => (e instanceof Error ? e : new Error(String(e))));
    // Nothing to start for a refused dist.
    if (guardError) return;
    // dist/ as an SPA.
    ({ server, base } = await startDistServer());
    // Headless Chromium and a fresh context.
    browser = await chromium.launch({ headless: true });
    context = await browser.newContext();
    // EVERY Supabase call answered here.
    await context.route('https://*.supabase.co/**', async (route) => {
      // The request, parsed.
      const req = route.request();
      const url = new URL(req.url());
      // A JSON answer.
      const json = (status: number, body: unknown) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
      // Auth: the seeded user.
      if (url.pathname.startsWith('/auth/v1/')) return json(200, { id: USER_ID, aud: 'authenticated', role: 'authenticated', email: 'operator@example.test' });
      // The sync: the server's cooldown answer ("just ran"), as gmail-sync sends it.
      if (url.pathname === '/functions/v1/gmail-sync') return json(200, { ok: true, cooldown: true });
      // The tracker's newest successful run.
      if (url.pathname === '/rest/v1/agent_runs') return json(200, [{ finished_at: TRACKER_FINISHED_AT }]);
      // A PATCH: the read mark (id=in.(...), read_at=is.null) or the link (id=eq...., matched_application_id=is.null).
      if (url.pathname === '/rest/v1/email_events' && req.method() === 'PATCH') {
        // The body, kept for the assertion.
        const body = req.postDataJSON() as Record<string, unknown>;
        patches.push({ query: url.search, body });
        // The ids, from either filter shape.
        const idParam = url.searchParams.get('id') ?? '';
        const ids = idParam.startsWith('eq.') ? [idParam.slice(3)] : idParam.replace(/^in\.\(|\)$/g, '').split(',');
        // The null guard this PATCH carries, honoured as PostgREST would.
        const guard = url.searchParams.has('read_at') ? 'read_at' : 'matched_application_id';
        // Changed rows only.
        const changed = rows.filter((r) => ids.includes(String(r.id)) && r[guard] === null).map((r) => String(r.id));
        rows = rows.map((r) => (changed.includes(String(r.id)) ? { ...r, ...body } : r));
        // The changed rows, as return=representation gives them.
        return json(200, rows.filter((r) => changed.includes(String(r.id))));
      }
      // The duplicate lookup: this user's applications at the email's company slug.
      if (url.pathname === '/rest/v1/applications') {
        // Kept, to pin the filter.
        appReads.push(url.search);
        // HackerRank may already have one (live: approved, being marked applied by hand).
        return json(200, url.searchParams.get('jobs.company_slug') === 'eq.hackerrank' ? existingApps : []);
      }
      // The list read.
      if (url.pathname === '/rest/v1/email_events') return json(200, rows);
      // Add to Applied: link the email in the mock, return the new application id.
      if (url.pathname === '/rest/v1/rpc/track_email_as_applied') {
        // Kept for the assertion.
        const body = req.postDataJSON() as { p_email_event_id: string };
        rpcs.push(body);
        // Linked, as the function does.
        rows = rows.map((r) => (r.id === body.p_email_event_id ? { ...r, matched_application_id: 'a1000000-0000-4000-8000-000000000042' } : r));
        // The application id.
        return json(200, 'a1000000-0000-4000-8000-000000000042');
      }
      // Every other read the shell makes.
      return json(200, []);
    });
    // The fake session.
    await seedSession(context, USER_ID);
    // The tab, counting and dismissing any browser dialog.
    page = await context.newPage();
    page.on('dialog', (d: Dialog) => {
      // Counted first.
      dialogs += 1;
      // Dismissed, as a Cancel would.
      void d.dismiss().catch(() => {});
    });
  });

  after(async () => {
    // Each closed if it started.
    if (page) await page.close().catch(() => {});
    if (context) await context.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  // One email's card, by its accessible name ("Unread: <subject>" / "Read: <subject>").
  const card = (subject: string) => page.locator('li.email-card', { has: page.locator('.email-card__subject', { hasText: subject }) });
  // The unread number, once it shows the expected value.
  const unreadIs = (n: number) => page.locator('[data-testid="unread-count"]', { hasText: new RegExp(`^${n}$`) }).waitFor();

  it('1. every badge is the stored class; a cooldown still shows when the inbox was last read', async () => {
    // The four live shapes.
    rows = [RECEIPT, ALERT, TRACKED, PROMO];
    // The page; the mount-time sync gets the cooldown answer.
    await page.goto(`${base}/emails`, { waitUntil: 'domcontentloaded' });
    // THE BUG: the HackerRank receipt must read as a receipt.
    const receiptBadge = card('We have received your Application').locator('.email-badge', { hasText: 'Application received' });
    await receiptBadge.waitFor();
    // And never as an interview.
    assert.equal(await card('We have received your Application').locator('.email-badge', { hasText: /Interview/i }).count(), 0);
    // The alert and the interview keep their own labels.
    await card('Software Engineer: Google').locator('.email-badge', { hasText: 'Job alert' }).waitFor();
    await card('Interview invitation').locator('.email-badge', { hasText: 'Interview invite' }).waitFor();
    // The unclassified promo is not job mail: hidden by default.
    assert.equal(await page.locator('li.email-card', { hasText: 'Simplilearn' }).count(), 0);
    // The cooldown line is the settled one.
    await page.getByText('sync skipped', { exact: false }).waitFor();
    // "Last checked" shows the tracker's run time, never "Not checked yet".
    const last = page.locator('.email-monitor__last-checked', { hasText: /\d{1,2}:\d{2}/ });
    await last.waitFor();
    assert.doesNotMatch((await last.textContent()) ?? '', /Not checked yet/);
    // No browser dialog.
    assert.equal(dialogs, 0);
  });

  it('2. "Not tracked" shows only unmatched rows, and the URL keeps the filter', async () => {
    // Same rows.
    rows = [RECEIPT, ALERT, TRACKED, PROMO];
    // The page.
    await page.goto(`${base}/emails`, { waitUntil: 'domcontentloaded' });
    // Rendered.
    await card('Interview invitation').waitFor();
    // The Tracking filter.
    await page.getByLabel('Tracking', { exact: true }).selectOption('untracked');
    // The tracked row leaves.
    await card('Interview invitation').waitFor({ state: 'detached' });
    // The two unmatched job emails stay.
    assert.equal(await page.locator('li.email-card').count(), 2);
    // In the URL, so a reload keeps it.
    assert.match(page.url(), /track=untracked/);
    // A reload with that URL shows the same list.
    await page.reload({ waitUntil: 'domcontentloaded' });
    await card('Software Engineer: Google').waitFor();
    assert.equal(await page.locator('li.email-card', { hasText: 'Interview invitation' }).count(), 0);
  });

  it('3. Mark read drops the unread count by exactly 1, through one PATCH that sets read_at only', async () => {
    // Two unread job emails shown, one read.
    rows = [RECEIPT, ALERT, TRACKED, PROMO];
    // A clean URL.
    await page.goto(`${base}/emails`, { waitUntil: 'domcontentloaded' });
    // Two unread shown.
    await unreadIs(2);
    // The write leaves on the click.
    const write = page.waitForRequest((r) => r.method() === 'PATCH' && r.url().includes('/rest/v1/email_events'), { timeout: 5_000 }).catch(() => null);
    // Mark the alert read.
    await page.getByRole('button', { name: 'Mark read: Software Engineer: Google and 10 more jobs', exact: true }).click();
    // Answered.
    await (await write)?.response();
    // One fewer.
    await unreadIs(1);
    // One PATCH, setting read_at and nothing else, guarded to unread rows.
    const last = patches.at(-1) as { query: string; body: Record<string, unknown> };
    assert.deepEqual(Object.keys(last.body), ['read_at']);
    assert.match(last.query, /read_at=is\.null/);
  });

  it('4. Add to Applied: prefilled form, inline confirm, one RPC with the slug, then the row is tracked', async () => {
    // The receipt unmatched again, and no existing HackerRank application.
    rows = [RECEIPT, ALERT, TRACKED];
    existingApps = [];
    // The page.
    await page.goto(`${base}/emails`, { waitUntil: 'domcontentloaded' });
    // The receipt's button (the alert has none: an alert is not about an application).
    const name = 'We have received your Application || AI Researcher Intern';
    await page.getByRole('button', { name: `Add to Applied: ${name}`, exact: true }).click();
    // The form, with the company from the sender (its "Careers" suffix dropped).
    const company = page.getByLabel('Company', { exact: true });
    await company.waitFor();
    assert.equal(await company.inputValue(), 'HackerRank');
    // A clean title.
    await page.getByLabel('Job title', { exact: true }).fill('AI Researcher Intern');
    // Submit arms the confirm; nothing is written yet.
    await page.locator('form.email-track').getByRole('button', { name: 'Add to Applied', exact: true }).click();
    const confirm = page.getByRole('button', { name: `Confirm: Add to Applied: ${name}`, exact: true });
    await confirm.waitFor();
    assert.equal(rpcs.length, 0, 'arming must not write');
    // Confirm sends exactly one call.
    const write = page.waitForRequest('**/rest/v1/rpc/track_email_as_applied', { timeout: 5_000 }).catch(() => null);
    await confirm.click();
    await (await write)?.response();
    // The arguments: the email, the trimmed names, and the slug from the one slug rule.
    assert.deepEqual(rpcs, [{ p_email_event_id: RECEIPT.id, p_company: 'HackerRank', p_company_slug: 'hackerrank', p_title: 'AI Researcher Intern' }]);
    // The re-read shows it tracked.
    await card('We have received your Application').locator('.email-card__tracked').waitFor();
    // No browser dialog anywhere.
    assert.equal(dialogs, 0);
  });

  it('5. an email whose company already has an application offers "Link to ..." first; linking creates nothing', async () => {
    // The receipt unmatched, and HackerRank's existing application (live: approved).
    rows = [RECEIPT, ALERT, TRACKED];
    existingApps = [{ id: 'a1000000-0000-4000-8000-000000000077', status: 'approved', jobs: { title: 'AI Researcher Intern', company_slug: 'hackerrank' } }];
    // Fresh counts for this test.
    rpcs.length = 0;
    patches.length = 0;
    // The page.
    await page.goto(`${base}/emails`, { waitUntil: 'domcontentloaded' });
    // Add to Applied on the receipt.
    const name = 'We have received your Application || AI Researcher Intern';
    await page.getByRole('button', { name: `Add to Applied: ${name}`, exact: true }).click();
    // The existing application is offered, named with its stage.
    const link = page.getByRole('button', { name: `Link to AI Researcher Intern (approved): ${name}`, exact: true });
    await link.waitFor();
    // The lookup asked for this company's slug.
    assert.ok((appReads.at(-1) ?? '').includes('jobs.company_slug=eq.hackerrank'), appReads.at(-1));
    // "Add as a new job" stays available, AFTER the link in reading order.
    await page.getByRole('button', { name: `Add as a new job: ${name}`, exact: true }).waitFor();
    const order = await page.locator('.email-link__options button').evaluateAll((els) => els.map((el) => el.getAttribute('aria-label') ?? ''));
    assert.ok(order[0]?.startsWith('Link to '), `first option: ${order[0]}`);
    // Link: the inline confirm first.
    await link.click();
    const confirm = page.getByRole('button', { name: `Confirm: Link to AI Researcher Intern (approved): ${name}`, exact: true });
    await confirm.waitFor();
    // Nothing written on arming.
    assert.equal(patches.length, 0);
    // Confirm: one PATCH.
    const write = page.waitForRequest((r) => r.method() === 'PATCH' && r.url().includes('/rest/v1/email_events'), { timeout: 5_000 }).catch(() => null);
    await confirm.click();
    await (await write)?.response();
    // It sets matched_application_id only, guarded to an unlinked email.
    const last = patches.at(-1) as { query: string; body: Record<string, unknown> };
    assert.deepEqual(last.body, { matched_application_id: 'a1000000-0000-4000-8000-000000000077' });
    assert.ok(last.query.includes('matched_application_id=is.null'), last.query);
    // ZERO new jobs or applications: the create route was never called.
    assert.equal(rpcs.length, 0);
    // The row reads as tracked after the re-read.
    await card('We have received your Application').locator('.email-card__tracked').waitFor();
    // No browser dialog.
    assert.equal(dialogs, 0);
  });

  /* P3 #3 (2026-11-06, Teja): opening the Email page syncs Gmail, at most once a minute. The cap's
     stamp used to be written only after an "ok" answer, so when the server answered "cooldown" (this
     mock's answer), failed, or the page was left mid-call, open -> leave -> open within 60 s called
     gmail-sync again. Counted on the wire, across a real leave and return. */
  it('6. open, leave and reopen the Email page within 60 s: ONE gmail-sync call', async () => {
    // A clean cap, as on a first visit; earlier tests may have stamped it.
    await page.evaluate(() => localStorage.removeItem('applyy_gmail_sync_last_ms'));
    // The sync calls seen on the wire.
    let syncCalls = 0;
    // Only the gmail-sync function call is counted.
    const count = (request: { url(): string }): void => {
      // Parsed so a query string cannot vary the match.
      if (new URL(request.url()).pathname === '/functions/v1/gmail-sync') syncCalls += 1;
    };
    // Network-level, so a call is counted whichever mount made it.
    page.on('request', count);
    // try/finally: the listener must not outlive this test.
    try {
      // First open: the mount-time sync runs.
      await page.goto(`${base}/emails`, { waitUntil: 'domcontentloaded' });
      // Every read and the sync have settled.
      await page.waitForLoadState('networkidle');
      // Non-vacuity: the first open DID sync, so "one" below is not "none".
      assert.equal(syncCalls, 1, 'the first open must sync Gmail');
      // Leave: a full navigation unmounts the page.
      await page.goto(`${base}/pipeline`, { waitUntil: 'domcontentloaded' });
      // Settled.
      await page.waitForLoadState('networkidle');
      // Return within the minute: a fresh mount.
      await page.goto(`${base}/emails`, { waitUntil: 'domcontentloaded' });
      // Settled.
      await page.waitForLoadState('networkidle');
      // Still one: the reopen inside 60 s was capped.
      assert.equal(syncCalls, 1, 'a reopen within 60 s must not call gmail-sync again');
    } finally {
      // Later tests are not counted.
      page.off('request', count);
    }
  });
});
