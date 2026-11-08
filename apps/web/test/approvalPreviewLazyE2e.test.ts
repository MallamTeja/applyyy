/* Approval queue cards do not render a resume until it is opened (2026-11-08).
 *
 * WHY. Teja, 16:32: "pages are slow". The first suspect was the Approval queue rendering every card's resume
 * (renderResumeHtml + the page-fit ladder, ~4 ms each, an iframe each) at mount. Measured: it does not, because
 * ApprovalQueuePage mounts <ResumePreview> only for rows in its `previewing` set, which starts empty. This
 * pins that, so a later "show the resume inline" change cannot quietly put 18 renders and 18 iframes back on
 * every page load. Served from the e2e bundle; every Supabase call is answered locally.
 *
 * RED-ON-REVERT (measured 2026-11-08): dropping the `isPreviewing` gate at BOTH mount sites (Bucket B
 * `isPreviewing && resume`, Bucket A `isPreviewing`) makes test 1 count 12 frames for 6 cards. These fixture
 * rows land in Bucket A, so reverting the Bucket B gate alone stays green: both gates must be reverted. */

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
// A real queue row's snapshot, refs and pinned master (anonymised), so a card renders as in production.
import { MASTER_V2, MASTER_VERSION, STORED_TAILORED_PROFILE, TAILOR_REFS } from './fixtures/gitlab-row-anonymised.ts';

// The operator the fake session names.
const USER_ID = '0f4b24da-e85b-40bb-8606-c81824493b45';
// Any valid stamp.
const STAMP = '2026-11-08T06:30:00.000000+00:00';
// Six cards: enough that "one render per card" would read as 6, not as a single stray frame.
const N = 6;

// One job embed per card.
const job = (i: number) => ({ id: `job-${i}`, title: `E2E Backend Engineer ${i}`, company_name: `Acme ${i}`, employment_type: 'full_time', work_arrangement: 'remote', locations: ['Bengaluru, India'], salary_min: null, salary_max: null, salary_currency: null, discovered_via: 'scout-ats', source_refs: [], apply_url: `https://example.com/jobs/${i}`, description_raw: 'A backend role building APIs in Node and TypeScript.', location_raw: 'Bengaluru, India', posted_at: STAMP, created_at: STAMP, user_id: USER_ID });
// One queue row per card, at the status the read asked for.
const row = (i: number, status: string) => ({
  // A uuid-shaped id per card.
  id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
  // Owner, job and status.
  user_id: USER_ID, job_id: `job-${i}`, status,
  // The stored resume and its citations, exactly as the tailor wrote them.
  tailored_profile: STORED_TAILORED_PROFILE, tailor_refs: TAILOR_REFS, audit_findings: [], selected_jd_keywords: [],
  // The rest of the row the page reads.
  match_score: 60 + i, cover_letter: null, updated_at: STAMP, status_changed_at: STAMP, created_at: STAMP, master_version: MASTER_VERSION,
  // The job embed.
  jobs: job(i),
});

describe('Approval queue cards render no resume until opened (fake session, every Supabase call answered locally)', () => {
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
    // EVERY Supabase call answered here.
    await context.route('https://*.supabase.co/**', async (route) => {
      // The request, its URL and whether it asked for a single object.
      const req = route.request(); const url = new URL(req.url()); const one = (req.headers()['accept'] ?? '').includes('vnd.pgrst.object');
      // A JSON answer with a count range, as PostgREST sends.
      const send = (body: unknown) => route.fulfill({ status: 200, contentType: 'application/json', headers: { 'content-range': `0-${N - 1}/${N}` }, body: JSON.stringify(body) });
      // Auth: the seeded user.
      if (url.pathname.startsWith('/auth/v1/')) return send({ id: USER_ID, aud: 'authenticated', role: 'authenticated', email: 'operator@example.test' });
      // Count-only reads.
      if (req.method() === 'HEAD') return route.fulfill({ status: 200, headers: { 'content-range': `0-${N - 1}/${N}` }, body: '' });
      // The queue: rows at the status the read filtered on (the first of an in.(...) list), awaiting by default.
      if (url.pathname === '/rest/v1/applications') {
        // The status filter as sent.
        const f = url.searchParams.get('status') ?? '';
        // eq.x, in.(x,…) or none.
        const st = f.startsWith('eq.') ? f.slice(3) : f.startsWith('in.(') ? (f.slice(4).split(',')[0] ?? '').replace(/[")]/g, '') : 'awaiting_approval';
        // N rows.
        const rows = Array.from({ length: N }, (_, i) => row(i + 1, st));
        // One or many, as asked.
        return send(one ? rows[0] : rows);
      }
      // The pinned master the preview and the diff read.
      if (url.pathname === '/rest/v1/master_profiles') { const r = { profile: MASTER_V2, version: MASTER_VERSION, user_id: USER_ID, created_at: STAMP }; return send(one ? r : [r]); }
      // Edge functions: an empty answer.
      if (url.pathname.includes('/functions/v1/')) return send({});
      // Everything else: empty.
      return send(one ? null : []);
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

  it('1. on load: every card is drawn, and no card has rendered its resume', async () => {
    // The page.
    await page.goto(`${base}/approvals`, { waitUntil: 'domcontentloaded' });
    // Non-vacuous: every card is drawn, each with its "Preview resume" button (so each HAS a resume).
    await page.getByRole('button', { name: /Preview resume/ }).nth(N - 1).waitFor();
    // Settled, so any eager render has happened.
    await page.waitForLoadState('networkidle');
    // THE POINT: N cards, zero resume documents.
    assert.deepEqual({ buttons: await page.getByRole('button', { name: /Preview resume/ }).count(), frames: await page.locator('iframe.resume-preview__frame').count() }, { buttons: N, frames: 0 });
  });

  it('2. opening one card renders that card\'s resume, and only that one', async () => {
    // The operator's own click on the first card.
    await page.getByRole('button', { name: /Preview resume/ }).first().click();
    // Its tailored pane appears: the same preview as before.
    await page.locator('iframe.resume-preview__frame').first().waitFor();
    // Only the opened card's frames exist (tailored, plus the master pane when it loads): never one per card.
    assert.ok((await page.locator('iframe.resume-preview__frame').count()) <= 2, 'opening one card rendered resumes for others');
  });
});
