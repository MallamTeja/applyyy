// Worker E2E runner: one Chromium session that renders a resume to a real PDF and clicks through the built web app.
//
// REPAIRED 2026-11-10 (T6). It had been red since 2026-10-04 for two reasons:
//  1. It asserted the login page pre-fills the operator's real email. 482ed57 ("no fail-open defaults") removed that
//     pre-fill ON PURPOSE, so the old assert demanded a reverted security fix. Stage 2 now asserts the opposite.
//  2. Stage 1 read the operator's real resume PDF from the repo root (gitignored), which is real personal data and absent on any clean
//     checkout. Stage 1 now renders the invented `syntheticResume` ("Ada Placeholder") through the production print
//     path, so nothing binary is committed and no real identity appears anywhere in this file.
// Every identity string below is obviously fake (example.com / example.test, an all-zero-ish UUID).
//
// What it answers that apps/web/test/e2eSuite.test.ts does not: the four page TITLES (approvals, watchlist, emails;
// e2eSuite only waits for `.page__title`) and the watchlist board-token input. Stages 2, 5 and the remaining checks
// overlap e2eSuite #1/#5–#8 and stay as a cheap smoke over the same bundle. The old stage 7 (theme toggle) was
// dropped: its `.rail__theme-btn` no longer exists, so it had passed vacuously; e2eSuite #9 covers theme and Inter.
//
// Run from worker/: `node --experimental-strip-types test/e2e-runner.mjs` (needs `apps/web` built with
// `./node_modules/.bin/vite build --mode e2e`; the dist guard below names that command if it is missing or stale).

// Strict asserts, so a loose == can never pass a wrong value.
import assert from 'node:assert/strict';
// Monotonic clock for the per-stage runtimes the report needs.
import { performance } from 'node:perf_hooks';
// The same Chromium the worker's real print path uses.
import { chromium } from 'playwright';
// PDF text extraction: the ATS-readability reader the worker itself uses.
import { extractPdfText } from '../src/ats-parse-check.ts';
// The production resume -> PDF path (template HTML, A4, zero margin, no header/footer).
import { renderResumePdf } from '../src/render-resume-pdf.ts';
// Invented resume content: the only identity this runner ever renders.
import { syntheticResume } from './resolved-resume-fixture.ts';
// Reused web harness: refuses a missing/stale/unconfigured dist, serves it locally, seeds a fake session.
// Imported by relative path (repo CLAUDE.md §5): no new dependency, and one guard instead of a drifting copy.
import { assertDistIsTestable, seedSession, startDistServer } from '../../apps/web/test/support/e2eDist.ts';

// A fake user id: every request is answered locally, so it only has to be a well-formed UUID.
const FAKE_USER_ID = '00000000-0000-4000-8000-0000000000e2';
// One timeout for every wait, so a hang fails in seconds rather than at Playwright's 30 s default.
const WAIT_MS = 15_000;

// Runs one named stage and prints its runtime; a failure is rethrown with the stage name so the report says WHICH.
async function stage(name, fn) {
  // Start time for this stage.
  const t0 = performance.now();
  // Announce first, so a hang shows where it hung.
  console.log(`\n[E2E ${name}] ...`);
  try {
    // The stage body.
    await fn();
  } catch (err) {
    // Name the stage in the failure: "a test went red by NAME" is the contract of this runner.
    throw new Error(`[E2E ${name}] FAILED: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
  }
  // Green line with the measured runtime.
  console.log(`✓ [E2E ${name}] ${Math.round(performance.now() - t0)} ms`);
}

async function main() {
  // Whole-run clock for the final line.
  const t0 = performance.now();
  // Refuse a dist that cannot prove anything BEFORE launching a browser (it throws with the fix command).
  await assertDistIsTestable();
  // The local SPA server over apps/web/dist; started first so a launch failure below still reaches the finally.
  const { server, base } = await startDistServer();
  // Declared outside the try so the finally can close it; undefined if the launch itself throws.
  let browser;
  try {
    // One headless browser for every stage: a launch is the slowest single step here.
    browser = await chromium.launch({ headless: true });
    // --- Stage 1: synthetic resume -> real PDF -> extracted text ---
    await stage('1/6 synthetic resume PDF', async () => {
      // A blank page to print on; closed after so later stages start clean.
      const page = await browser.newPage();
      try {
        // The production render path, fed invented content only.
        const { bytes } = await renderResumePdf({ resume: syntheticResume, page });
        // Positive shape first: a real PDF starts with its magic bytes (§6: never trust a lenient parser).
        assert.equal(new TextDecoder().decode(bytes.subarray(0, 5)), '%PDF-', 'render must emit a PDF');
        // The text layer an ATS would read.
        const { text } = await extractPdfText(bytes);
        // Identity reached the text layer (the fake name and fake email).
        assert.ok(text.includes(syntheticResume.identity.full_name), 'PDF text must contain the synthetic name');
        // Email is the contact field an ATS parses most.
        assert.ok(text.includes(syntheticResume.identity.email), 'PDF text must contain the synthetic email');
        // The skills section printed: its category label appears nowhere else ('Node.js' also sits in an
        // experience bullet, so asserting it would stay green with the whole skills section gone).
        assert.ok(text.includes(syntheticResume.skills[0].category), 'PDF text must contain the skills category label');
        // The experience section's company.
        assert.ok(text.includes(syntheticResume.experience[0].company), 'PDF text must contain the experience company');
      } finally {
        // Free the page even on failure.
        await page.close();
      }
    });

    // --- Stage 2: login gate shows NO operator identity (482ed57) ---
    await stage('2/6 login gate (no prefill)', async () => {
      // A context with no session: the app must stop at the login card.
      const anon = await browser.newContext();
      try {
        // Answer every off-machine request locally, so an unauthenticated boot cannot reach the live project.
        await anon.route('**/*', (route) => (route.request().url().startsWith(`${base}/`) ? route.continue() : route.fulfill({ status: 200, contentType: 'application/json', body: '[]' })));
        // A page in it.
        const page = await anon.newPage();
        // The root: AppShell renders LoginPage when there is no user.
        await page.goto(`${base}/`, { waitUntil: 'domcontentloaded' });
        // The card itself.
        await page.locator('.login-card').waitFor({ timeout: WAIT_MS });
        // The tagline the card has carried since 2026-09.
        assert.match(await page.locator('.login-card__tagline').innerText(), /operator authentication/i);
        // Sign-in mode, not sign-up.
        assert.match(await page.locator('.login-form__submit-btn').innerText(), /Sign In to Console/i);
        // The email input.
        const email = page.locator('input[type="email"]');
        // THE fix this stage guards: empty, no default operator (a pre-fill leaks the identity to anyone).
        assert.equal(await email.inputValue(), '', 'email field must start EMPTY: no operator pre-fill (482ed57)');
        // A neutral placeholder, not a person.
        assert.equal(await email.getAttribute('placeholder'), 'operator@example.com');
      } finally {
        // Close the anonymous context.
        await anon.close();
      }
    });

    // One signed-in context for the console pages (stages 3-6).
    const ctx = await browser.newContext();
    try {
      // Every off-machine request (Supabase REST/RPC/functions) gets 200 [], the loaded-empty answer each page handles.
      await ctx.route('**/*', (route) => (route.request().url().startsWith(`${base}/`) ? route.continue() : route.fulfill({ status: 200, contentType: 'application/json', body: '[]' })));
      // The fake session supabase-js reads on boot (fake user, example.test email, far-future expiry).
      await seedSession(ctx, FAKE_USER_ID);
      // One page reused across stages, like an operator clicking through.
      const page = await ctx.newPage();
      // Shared helper: open a route and return its header title.
      const titleOf = async (path) => {
        // Navigate.
        await page.goto(`${base}${path}`, { waitUntil: 'domcontentloaded' });
        // PageHeader's h1; waiting on it proves the auth gate let us through.
        const title = page.locator('.page__title').first();
        // Rendered.
        await title.waitFor({ timeout: WAIT_MS });
        // Its text, for the caller's assert.
        return title.innerText();
      };

      // --- Stage 3: approval queue ---
      await stage('3/6 /approvals title', async () => {
        // The route label from app/routes.ts; e2eSuite does not assert it.
        assert.match(await titleOf('/approvals'), /Approval queue/i);
      });

      // --- Stage 4: watchlist form + stats ---
      await stage('4/6 /watchlist form', async () => {
        // Title.
        assert.match(await titleOf('/watchlist'), /Company watchlist/i);
        // Three overview cards, rendered regardless of data.
        assert.equal(await page.locator('.watchlist-stat-card').count(), 3, 'three watchlist stat cards');
        // Company name input (capitalised placeholder).
        assert.ok(await page.locator('input[placeholder*="Stripe"]').isVisible(), 'company name input');
        // ATS provider select.
        assert.ok(await page.locator('select.field__control').isVisible(), 'ATS provider select');
        // Board token input (lowercase placeholder; e2eSuite does not check it).
        assert.ok(await page.locator('input[placeholder*="stripe"]').isVisible(), 'board token input');
        // Submit.
        assert.ok(await page.locator('button:has-text("Add Board")').isVisible(), 'Add Board button');
      });

      // --- Stage 5: master profile intake ---
      await stage('5/6 /master-profile intake', async () => {
        // Title.
        assert.match(await titleOf('/master-profile'), /Master profile/i);
        // The PDF upload control is always rendered.
        assert.ok((await page.locator('body').innerText()).includes('Upload Master Resume'), 'upload control text');
      });

      // --- Stage 6: email monitoring ---
      await stage('6/6 /emails dashboard', async () => {
        // Title.
        assert.match(await titleOf('/emails'), /Email monitoring/i);
        // Four metric cards.
        assert.equal(await page.locator('.email-stat-card').count(), 4, 'four email stat cards');
        // The page auto-syncs on open ("Checking Gmail..."); WAIT for the settled label instead of a one-shot
        // isVisible(), which raced the sync and could read the in-flight text.
        await page.getByRole('button', { name: 'Refresh emails' }).waitFor({ state: 'visible', timeout: WAIT_MS });
      });
    } finally {
      // Close the signed-in context.
      await ctx.close();
    }
  } finally {
    // Always release the browser and the port, pass or fail.
    await browser?.close();
    // Server close waits for open sockets; the contexts are already closed.
    await new Promise((resolve) => server.close(resolve));
  }
  // Total runtime, the number the CI-fit decision needs.
  console.log(`\nALL 6 E2E STAGES PASSED in ${Math.round(performance.now() - t0)} ms`);
}

// Any failure: print it and exit non-zero, so a caller (or CI) cannot read a crash as green.
main().catch((err) => {
  // The stage-named message.
  console.error(`\n❌ ${err instanceof Error ? err.message : String(err)}`);
  // Non-zero exit.
  process.exit(1);
});
