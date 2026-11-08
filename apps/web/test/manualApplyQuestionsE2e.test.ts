/* The Manual apply card's "Bot can't apply" line and its open questions, in a real browser (2026-11-07).
 *
 * WHY A BROWSER TEST ON TOP OF manualApplyBotCantApply.test.ts. The static test proves what renders; this
 * proves the write: typing an answer and pressing Save sends exactly ONE upsert to answer_bank, under the
 * worker planner's key for the label, WITHOUT the x-applyy-agent-key header. That missing header is what
 * makes the answer_bank_stamp_attestation trigger mark the row as Teja's own (attested), which the worker
 * requires before it fills an eligibility or EEO question. It serves the e2e bundle (dist/, `vite build
 * --mode e2e`) and answers every Supabase call locally, so nothing here can reach the live database.
 *
 * FIXTURE MIRRORS LIVE (2026-11-07): Canonical 8e9d58ce, approved, its kit with open required questions
 * (a fact, a never-fill consent, a checkbox declaration), and a Workday row parked by the guard with
 * block_reason login_required. MANUAL_APPLY_SHOT=<dir> also saves a full-page screenshot there.
 *
 * RED-ON-REVERT: sending saves through any path that adds the agent key, or keying by anything but
 * questionKey(label), fails test 2 at the header or the question_key assertion. */

// Strict asserts, like the other browser tests.
import assert from 'node:assert/strict';
// The server type.
import type { Server } from 'node:http';
// Screenshot path join.
import { join } from 'node:path';
// node:test, like every other web test (package.json "test").
import { describe, it, before, beforeEach, after } from 'node:test';
// Real Chromium; the same Playwright the e2e suite uses (apps/web/node_modules).
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
// The shared harness (test/support/e2eDist.ts): dist guard, static SPA server, fake session.
import { assertDistIsTestable, seedSession, startDistServer } from './support/e2eDist.ts';
// The worker planner's key, the one the saved row must carry.
import { questionKey } from '../../../worker/src/plan-fill.ts';

// The operator the fake session and the auth answers name.
const USER_ID = '0f4b24da-e85b-40bb-8606-c81824493b45';

// The Canonical row: approved, Greenhouse, kit with open questions.
const CANONICAL = {
  // The kit's join key.
  id: '8e9d58ce-0000-4000-8000-000000000001',
  // Approved: read by the approved-rows query.
  status: 'approved',
  // Any stamp.
  updated_at: '2026-11-07T17:18:00+00:00',
  // Not parked.
  block_reason: null,
  // No resume: not this test's concern.
  tailored_profile: null,
  // The job embed, provider included.
  jobs: { title: 'Software Engineer', company_name: 'Canonical', apply_url: 'https://job-boards.greenhouse.io/canonical/jobs/1', ats_provider: 'greenhouse' },
};

// The Workday row, parked by apply-one's guard.
const WORKDAY = {
  // A second row.
  id: '8e9d58ce-0000-4000-8000-000000000002',
  // The lane the guard parks into.
  status: 'blocked_needs_human',
  // Any stamp.
  updated_at: '2026-11-07T17:20:00+00:00',
  // What the guard writes.
  block_reason: 'login_required',
  // No resume.
  tailored_profile: null,
  // A Workday tenant.
  jobs: { title: 'Backend Engineer', company_name: 'Acme', apply_url: 'https://acme.wd5.myworkdayjobs.com/en-US/careers/job/1', ats_provider: 'workday' },
};

// The fact question Teja answers in the test.
const FACT = 'What grading system does your degree use?';

// Canonical's kit note (applyKit.ts v1 contract).
const KIT = {
  // The join key.
  application_id: CANONICAL.id,
  // The note time.
  created_at: '2026-11-07T17:18:00+00:00',
  // The kit: one answered field, three open required questions of the three kinds.
  detail: {
    kind: 'apply_kit', v: 1, generated_at: '2026-11-07T17:18:00Z', run_id: 'run-e2e', form_url: 'https://job-boards.greenhouse.io/canonical/jobs/1', resume: null,
    fields: [
      { label: 'First Name', value: 'Teja', source: 'identity', required: true, input_type: 'text' },
      { label: FACT, value: null, source: 'unanswered', required: true, input_type: 'text' },
      { label: 'Do you consent to our privacy notice?', value: null, source: 'unanswered', required: true, input_type: 'select', options: ['Yes', 'No'] },
      { label: 'I confirm these answers are my own words, written without AI', value: null, source: 'unanswered', required: true, input_type: 'checkbox' },
    ],
    warnings: [`"${FACT}" needs your answer (no_answer)`],
  },
};

describe('Manual apply open questions in a browser (fake session, every Supabase call answered locally)', () => {
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
  // Every write to answer_bank: method, headers, body.
  const bankWrites: { method: string; headers: Record<string, string>; body: unknown }[] = [];
  // Every kit-rebuild request a save sends to dispatch-apply: its body (peer 1, 2026-11-08, kit_only).
  const kitCalls: unknown[] = [];

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
      // The request, parsed for its filters.
      const req = route.request();
      // Its URL.
      const url = new URL(req.url());
      // A JSON answer.
      const json = (status: number, body: unknown) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
      // Auth: the seeded session's user.
      if (url.pathname.startsWith('/auth/v1/')) return json(200, { id: USER_ID, aud: 'authenticated', role: 'authenticated', email: 'operator@example.test' });
      // The answer bank: reads find nothing; writes are recorded and accepted.
      if (url.pathname === '/rest/v1/answer_bank') {
        // A read: empty bank, so every answerable question offers an input.
        if (req.method() === 'GET') return json(200, []);
        // A write: kept whole for the assertions.
        bankWrites.push({ method: req.method(), headers: await req.allHeaders(), body: req.postDataJSON() });
        // Accepted, as PostgREST answers an upsert with return=minimal.
        return route.fulfill({ status: 201, body: '' });
      }
      // The kit rebuild a landed save asks for: recorded, and answered as the deployed function answers kit_only.
      if (url.pathname === '/functions/v1/dispatch-apply') {
        // Kept for the assertion that the body is exactly the closed kit_only shape.
        kitCalls.push(req.postDataJSON());
        // The function's own success shape (handler.ts kit-only branch); kit_dispatched:true is what the store reads.
        return json(200, { status: 'ok', dispatched: false, reason: 'answer_saved', kit_dispatched: true });
      }
      // The kit notes.
      if (url.pathname === '/rest/v1/application_events') return json(200, [KIT]);
      // The rows: by status for the lanes and the approved read, by id for kit rows.
      if (url.pathname === '/rest/v1/applications') {
        // The filters the page sends.
        const status = url.searchParams.get('status') ?? '';
        // Ids, for the kit read.
        const id = url.searchParams.get('id') ?? '';
        // The approved read.
        if (status.includes('approved')) return json(200, [CANONICAL]);
        // The lanes read.
        if (status.includes('blocked_needs_human')) return json(200, [WORKDAY]);
        // The kit-row read.
        if (id.startsWith('in.')) return json(200, [CANONICAL]);
      }
      // Every other read the shell makes: an empty list.
      return json(200, []);
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

  // One job's card, by its landmark name.
  const card = (label: string) => page.getByRole('region', { name: `Manual apply: ${label}`, exact: true });

  it('1. each card says why the bot cannot apply, and only the fact question has an input', async () => {
    // The page.
    await page.goto(`${base}/manual-apply`, { waitUntil: 'domcontentloaded' });
    // Both cards rendered.
    await card('Software Engineer at Canonical').waitFor();
    // The Workday reason, folded from host, provider and login_required.
    assert.match(await card('Backend Engineer at Acme').locator('.kit-card__why').innerText(), /Bot can't apply: Workday needs a candidate account$/);
    // Canonical: three open questions.
    assert.match(await card('Software Engineer at Canonical').locator('.kit-card__why').innerText(), /Bot can't apply: 3 questions need you$/);
    // Only the fact has a labelled input (consent and the checkbox are the bot's never-fill).
    await card('Software Engineer at Canonical').getByLabel(FACT).waitFor();
    // Exactly one input in the questions block.
    assert.equal(await card('Software Engineer at Canonical').locator('.kit-card__questions input, .kit-card__questions select, .kit-card__questions textarea').count(), 1);
    // The ruling's line, once per never-fill question.
    assert.equal(await card('Software Engineer at Canonical').getByText('The bot never fills this one; answer it on the form.').count(), 2);
    // Optional evidence for the report.
    if (process.env['MANUAL_APPLY_SHOT']) await page.screenshot({ path: join(process.env['MANUAL_APPLY_SHOT'], 'manual-apply-questions.png'), fullPage: true });
  });

  it('2. Save writes one answer_bank upsert under the planner key, with no agent key header, then asks for a kit-only rebuild', async () => {
    // Typed as Teja would.
    await card('Software Engineer at Canonical').getByLabel(FACT).fill('  CGPA out of 10  ');
    // The save.
    await card('Software Engineer at Canonical').getByRole('button', { name: 'Save answer' }).click();
    // The outcome line: the save landed AND the kit rebuild it asked for started.
    await card('Software Engineer at Canonical').getByText('Saved to your answer bank. Kit rebuild started; press Refresh kits in about 3 minutes.').waitFor();
    // Exactly one rebuild request, with the closed body the function reads as kit-only (never the approve path).
    assert.deepEqual(kitCalls, [{ kit_only: true }]);
    // Exactly one write.
    assert.equal(bankWrites.length, 1);
    // The write, unpacked.
    const [write] = bankWrites;
    // An upsert (POST with on_conflict), never a delete or a patch.
    assert.equal(write?.method, 'POST');
    // No agent key: the trigger stamps it attested.
    assert.equal(write?.headers['x-applyy-agent-key'], undefined);
    // The row, as PostgREST receives it (one object or a one-item array).
    const row = (Array.isArray(write?.body) ? write.body[0] : write?.body) as Record<string, unknown>;
    // The planner's key, the trimmed answer, not a placeholder.
    assert.deepEqual([row['question_key'], row['answer_value'], row['needs_human']], [questionKey(FACT), 'CGPA out of 10', false]);
    // Optional evidence for the report.
    if (process.env['MANUAL_APPLY_SHOT']) await card('Software Engineer at Canonical').screenshot({ path: join(process.env['MANUAL_APPLY_SHOT'], 'manual-apply-saved.png') });
  });
});
