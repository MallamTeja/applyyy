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
 * badge; reading "Last checked" from this visit's sync alone fails test 1 at the time. */

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

// The operator.
const USER_ID = '0f4b24da-e85b-40bb-8606-c81824493b45';
// The tracker's newest successful run, as agent_runs stores it.
const TRACKER_FINISHED_AT = '2026-11-05T07:24:02.000000+00:00';

// One email row as the page's select('*') returns it; `over` replaces fields.
const email = (over: Record<string, unknown>) => ({
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
  let rows: Record<string, unknown>[] = [];
  // Writes seen: read-mark PATCHes and track RPCs, with their bodies.
  const patches: unknown[] = [];
  const rpcs: unknown[] = [];
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
      // The read mark: stamp exactly the requested unread rows and return them, as PostgREST would.
      if (url.pathname === '/rest/v1/email_events' && req.method() === 'PATCH') {
        // Kept for the assertion.
        patches.push({ query: url.search, body: req.postDataJSON() });
        // The ids in id=in.(a,b).
        const ids = (url.searchParams.get('id') ?? '').replace(/^in\.\(|\)$/g, '').split(',');
        // Stamped in the mock table.
        const stamp = (req.postDataJSON() as { read_at: string }).read_at;
        rows = rows.map((r) => (ids.includes(String(r.id)) && r.read_at === null ? { ...r, read_at: stamp } : r));
        // The changed rows.
        return json(200, rows.filter((r) => ids.includes(String(r.id))).map((r) => ({ id: r.id, read_at: r.read_at })));
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
    // The receipt unmatched again.
    rows = [RECEIPT, ALERT, TRACKED];
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
});
