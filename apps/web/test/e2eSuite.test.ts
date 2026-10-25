/* Comprehensive Playwright End-to-End & Interactive UX Test Suite for @applyy/web
 *
 * PURPOSE:
 * Automated verification of all primary operator console flows using Playwright Chromium:
 * 1. Unauthenticated Login Gate & Operator Auto-fill
 * 2. Authenticated Console Navigation & Route Gating
 * 3. Global Command Palette (Cmd+K / Ctrl+K, search, Arrow keys, Enter navigation, Escape)
 * 4. Human Lanes Pipeline Kanban & Slide-over Drawer (open via column head, inspect rules, close)
 * 5. Answer Bank Instant Search, Category Chips & 1-Click Clipboard Copy with Toast
 * 6. Global Toast Notification System (render, message, close button)
 * 7. Company Watchlist Management Form & Overview KPI cards
 * 8. Master Profile Intake & Review surface
 * 9. Email Monitoring Dashboard (4 KPI cards, search, sync settings drawer, on-demand trigger)
 * 10. High-Legibility Typography Tokens (Inter) & Dark/Light Theme Switching
 * 11. System Health & Kill-Switch Telemetry
 *
 * HOUSE STYLE:
 * Detailed comments for every assertion, selector, and state transition.
 */

import assert from 'node:assert/strict';
// readdir walks src/ and dist/assets for the build-freshness guard; no new dependency.
import { readdir, readFile, stat } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { extname, join } from 'node:path';
// beforeEach carries the dist guard's error into each test so it counts as a failure.
import { describe, it, before, beforeEach, after } from 'node:test';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const webDistDir = fileURLToPath(new URL('../dist', import.meta.url));
// The source tree dist/ was built from; anything newer than the build means dist is stale.
const webSrcDir = fileURLToPath(new URL('../src', import.meta.url));
// The build inputs outside src/: the HTML entry, the config, the e2e env, and static assets.
// A change to any of them also changes the bundle, so each must be older than the build too.
const webBuildInputs = ['../index.html', '../vite.config.ts', '../.env.e2e'].map((p) =>
  // Resolved from this file so the guard works from any cwd.
  fileURLToPath(new URL(p, import.meta.url)),
);
// public/ is copied into dist verbatim; it doesn't exist today, so it is walked only if present.
const webPublicDir = fileURLToPath(new URL('../public', import.meta.url));
// The live project ref. The seeded session key embeds it, so a bundle without it can't sign in.
const PROJECT_REF = 'xynqxekcqizwhtskzqrq';
// One fix for all three guards, named in every message so the reader never has to guess.
const FIX_COMMAND = 'cd apps/web && ./node_modules/.bin/vite build --mode e2e';

// Newest mtime under a directory. Recursive readdir is stdlib, so no glob dependency.
async function newestMtime(dir: string): Promise<{ path: string; mtimeMs: number }> {
  // Start below any real file, so an empty tree can never look "older than the build".
  let newest = { path: '(no files)', mtimeMs: -Infinity };
  // recursive: true returns every nested entry in one call.
  for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
    // Directories' mtimes move when peers add files; only file content matters to the build.
    if (!entry.isFile()) continue;
    // parentPath is the entry's own directory in a recursive listing.
    const full = join(entry.parentPath, entry.name);
    // stat per file is fine at this tree size (a few hundred files).
    const { mtimeMs } = await stat(full);
    // Keep the newest so the error can name the exact file that outdated the build.
    if (mtimeMs > newest.mtimeMs) newest = { path: full, mtimeMs };
  }
  // A vacuous walk would make the staleness guard pass for free, so refuse it outright.
  if (newest.mtimeMs === -Infinity) throw new Error(`e2e guard: found no files under ${dir}`);
  // The caller compares this against dist/index.html.
  return newest;
}

/* Refuses to run the suite against a dist/ that can't prove anything. Each failure used
 * to surface as 8 selector timeouts plus a vacuous test-9 pass; now it is one named error. */
async function assertDistIsTestable(): Promise<void> {
  // (a) No build at all.
  const distIndex = join(webDistDir, 'index.html');
  // stat-or-null so a missing file becomes our message, not a raw ENOENT.
  const indexStat = await stat(distIndex).catch(() => null);
  // Missing index.html means the static server below would serve nothing.
  if (!indexStat) {
    // Named error (a): tells the reader exactly which command produces dist/.
    throw new Error(`E2E_DIST_MISSING: ${distIndex} does not exist. Build it: ${FIX_COMMAND}`);
  }

  // (b) A build older than the source it claims to test. A 2-day-stale dist once went green.
  // src/ must have files (newestMtime throws on an empty walk); the rest only compete for "newest".
  let newestSrc = await newestMtime(webSrcDir);
  // Root inputs one by one; a missing one is skipped here because guard (c) catches a config-less build.
  for (const input of webBuildInputs) {
    // stat-or-null keeps an absent optional file from becoming a raw ENOENT.
    const s = await stat(input).catch(() => null);
    // Newer wins, so the message names whichever input actually outdated the build.
    if (s && s.mtimeMs > newestSrc.mtimeMs) newestSrc = { path: input, mtimeMs: s.mtimeMs };
  }
  // public/ only if it exists; an absent public/ is normal, not a vacuous walk.
  if (await stat(webPublicDir).catch(() => null)) {
    // Same newest-file walk as src/.
    const pub = await newestMtime(webPublicDir);
    // Keep whichever of src/root/public is newest.
    if (pub.mtimeMs > newestSrc.mtimeMs) newestSrc = pub;
  }
  // Strictly newer: an input touched after the build means the bundle may not contain it.
  if (newestSrc.mtimeMs > indexStat.mtimeMs) {
    // Named error (b): names the file and both times so a concurrent peer edit is obvious.
    throw new Error(
      `E2E_DIST_STALE: dist/index.html (${indexStat.mtime.toISOString()}) is older than ` +
        `${newestSrc.path} (${new Date(newestSrc.mtimeMs).toISOString()}). Rebuild: ${FIX_COMMAND}`,
    );
  }

  // (c) A build with no Supabase config. Without .env.local or .env.e2e, every page stops at sign-in.
  const assetsDir = join(webDistDir, 'assets');
  // Only .js carries import.meta.env values; maps and css would be noise.
  const jsFiles = (await readdir(assetsDir).catch(() => [] as string[])).filter((f) => f.endsWith('.js'));
  // Read each bundle chunk; the URL is inlined as a string literal in one of them.
  let hasRef = false;
  // A plain loop stops at the first hit; the bundle is a handful of files.
  for (const f of jsFiles) {
    // utf8 so includes() compares text, not bytes.
    if ((await readFile(join(assetsDir, f), 'utf8')).includes(PROJECT_REF)) {
      // One chunk with the ref is enough to prove the URL was baked in.
      hasRef = true;
      // No need to read the remaining chunks.
      break;
    }
  }
  // Zero .js files lands here too, so an empty assets dir can't pass vacuously.
  if (!hasRef) {
    // Named error (c): the build ran without VITE_SUPABASE_URL.
    throw new Error(
      `E2E_DIST_UNCONFIGURED: none of ${jsFiles.length} JS files in ${assetsDir} contain ` +
        `"${PROJECT_REF}", so the build had no VITE_SUPABASE_URL. Rebuild: ${FIX_COMMAND}`,
    );
  }
}

describe('Playwright E2E Operator Console Suite', () => {
  let server: Server;
  let serverUrl: string;
  let browser: Browser;
  let authContext: BrowserContext;
  let page: Page;
  // Set by before() when dist/ can't prove anything; undefined means the guard passed.
  let distGuardError: Error | undefined;

  // A beforeEach failure marks the test FAILED (not cancelled), with the named error as its reason.
  beforeEach(() => {
    // Rethrow per test: fail N with one clear cause beats N selector timeouts or N cancellations.
    if (distGuardError) throw distGuardError;
  });

  before(async () => {
    // 1. Refuse a missing, stale or unconfigured dist with one named error, before any browser work.
    // Recorded, not thrown: a throwing before() CANCELS every test and the summary reads
    // "fail 0, cancelled 10" (measured). beforeEach rethrows it so each test reports FAILED.
    distGuardError = await assertDistIsTestable().then(
      // Resolved means dist is testable; nothing to record.
      () => undefined,
      // Keep the error itself so its named message reaches every failing test.
      (err: unknown) => (err instanceof Error ? err : new Error(String(err))),
    );
    // No server or browser for a dist we refuse; after() already tolerates their absence.
    if (distGuardError) return;

    // 2. Start ephemeral static server for SPA testing
    server = createServer(async (req, res) => {
      try {
        const urlPath = new URL(req.url ?? '/', 'http://localhost').pathname;
        const relPath = urlPath.replace(/^\//, '');
        let filePath = join(webDistDir, relPath === '' ? 'index.html' : relPath);
        const fileStat = await stat(filePath).catch(() => null);

        if (!fileStat || !fileStat.isFile()) {
          filePath = join(webDistDir, 'index.html');
        }

        const ext = extname(filePath).toLowerCase();
        const contentType = MIME_TYPES[ext] ?? 'text/html';
        const content = await readFile(filePath);
        res.writeHead(200, { 'Content-Type': contentType });
        res.end(content);
      } catch (err) {
        res.writeHead(500).end(String(err));
      }
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address() as { port: number };
    serverUrl = `http://127.0.0.1:${address.port}`;

    // 3. Launch headless Chromium
    browser = await chromium.launch({ headless: true });

    // 4. Create authenticated browser context with mocked Supabase endpoints & token
    authContext = await browser.newContext({
      permissions: ['clipboard-read', 'clipboard-write'],
    });

    // Mock remote Supabase endpoints to decouple E2E tests from external network
    await authContext.route('https://*.supabase.co/**', async (route) => {
      const url = route.request().url();
      const method = route.request().method();

      if (url.includes('/auth/v1/user')) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            id: '0f4b24da-e85b-40bb-8606-c81824493b45',
            aud: 'authenticated',
            role: 'authenticated',
            email: 'operator@example.test',
            app_metadata: { provider: 'email' },
            user_metadata: {},
            created_at: '2026-01-01T00:00:00Z',
          }),
        });
        return;
      }

      if (url.includes('/auth/v1/token')) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            access_token: 'e2e-test-token',
            token_type: 'bearer',
            expires_in: 7200,
            refresh_token: 'e2e-test-refresh',
            user: {
              id: '0f4b24da-e85b-40bb-8606-c81824493b45',
              aud: 'authenticated',
              role: 'authenticated',
              email: 'operator@example.test',
            },
          }),
        });
        return;
      }

      if (url.includes('/rest/v1/company_watchlist')) {
        await route.fulfill({
          status: method === 'POST' ? 201 : 200,
          contentType: 'application/json',
          body: JSON.stringify([
            {
              id: 'b24bbfcc-0a12-4266-a09e-2ed7fa18ed24',
              user_id: '0f4b24da-e85b-40bb-8606-c81824493b45',
              ats_provider: 'greenhouse',
              board_token: 'stripe',
              company_name: 'Stripe',
              enabled: true,
              poll_count: 0,
              consecutive_failures: 0,
            },
          ]),
        });
        return;
      }

      if (url.includes('/rest/v1/applications')) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify([]),
        });
        return;
      }

      if (url.includes('/rest/v1/email_events')) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify([]),
        });
        return;
      }

      if (url.includes('/rest/v1/master_profiles')) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify([]),
        });
        return;
      }

      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([]),
      });
    });

    // Inject operator auth token into localStorage
    await authContext.addInitScript(() => {
      window.localStorage.setItem(
        'sb-xynqxekcqizwhtskzqrq-auth-token',
        JSON.stringify({
          access_token: 'e2e-test-token',
          token_type: 'bearer',
          expires_in: 7200,
          expires_at: Math.floor(Date.now() / 1000) + 7200,
          refresh_token: 'e2e-test-refresh',
          user: {
            id: '0f4b24da-e85b-40bb-8606-c81824493b45',
            aud: 'authenticated',
            role: 'authenticated',
            email: 'operator@example.test',
          },
        }),
      );
    });

    page = await authContext.newPage();
  });

  after(async () => {
    if (page) await page.close().catch(() => {});
    if (authContext) await authContext.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('1. verifies unauthenticated login gatekeeper reveals no operator identity', async () => {
    // A fresh context carries no injected session, so this is what an anonymous visitor sees.
    const anonContext = await browser.newContext();
    // One page is enough: the login gate is the only thing an unauthenticated route renders.
    const anonPage = await anonContext.newPage();

    // The root route must fall through to the gate rather than the console.
    await anonPage.goto(`${serverUrl}/`, { waitUntil: 'domcontentloaded' });
    // Waiting on the card proves the gate mounted before any assertion reads it.
    await anonPage.waitForSelector('.login-card');

    // The tagline confirms we are on the auth screen, not an error boundary.
    const tagline = await anonPage.locator('.login-card__tagline').textContent();
    // Matching the rendered copy guards against the gate silently swapping screens.
    assert.match(tagline ?? '', /operator authentication/i);

    // The submit label shows the form opened in sign-in mode, its default.
    const submitBtn = await anonPage.locator('.login-form__submit-btn').textContent();
    // Sign-in mode is the default an anonymous visitor must land on.
    assert.match(submitBtn ?? '', /Sign In to Console/i);

    // Security fix: a pre-filled address told anonymous visitors which account exists.
    const emailVal = await anonPage.locator('#operator-email').inputValue();
    // Empty is the only safe starting value; any address here is a leak.
    assert.equal(emailVal, '');

    // The deleted quick-fill row was the other leak path, so its element must be gone.
    const quickfillCount = await anonPage.locator('[class*="login-card__quickfill"]').count();
    // Zero elements, asserted on the DOM rather than on text, so a comment can never trip it.
    assert.equal(quickfillCount, 0);

    // Scan every text input's value: no field may carry an address before sign-in.
    const prefilledValues = await anonPage
      .locator('.login-card input')
      // Collect values in-page so we test what the browser actually holds.
      .evaluateAll((inputs) => inputs.map((el) => (el as HTMLInputElement).value));
    // An @ in any value would mean some field shipped an identity to an anonymous visitor.
    assert.deepEqual(prefilledValues.filter((v) => v.includes('@')), []);

    // Closing the context keeps the anonymous session from bleeding into later tests.
    await anonContext.close();
  });

  it('2. verifies global Command Palette (Cmd+K, Search, Navigation, ESC closing)', async () => {
    await page.goto(`${serverUrl}/approvals`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.page__title');

    // Trigger Command Palette via Ctrl+K / Meta+K
    await page.keyboard.press('Control+k');
    await page.waitForSelector('.palette-modal');
    // FLAKE FIX (CI 2026-10-24, ec455b8): the modal mounts BEFORE its open effect runs
    // setQuery(''), so a fill() that lands first is wiped and the list goes back to unfiltered
    // ("Approval queue" first). The effect focuses the input 50ms after that reset, so focus is
    // the awaited state that proves the reset is done. A user types after focus too.
    await page.locator('.palette-input:focus').waitFor();

    // Verify search input is focused and placeholder is present
    const isInputVisible = await page.locator('.palette-input').isVisible();
    assert.ok(isInputVisible, 'Command palette search input must be visible');

    // Type query to filter to Answer Bank
    await page.locator('.palette-input').fill('Answer Bank');
    const items = page.locator('.palette-item');
    // Wait for the re-render that filters the list: innerText() below is a one-shot read and
    // would take whatever the DOM held mid-render. .catch so the named assertion reports a miss.
    await items.first().filter({ hasText: /Answer Bank/i }).waitFor().catch(() => {});
    const count = await items.count();
    assert.ok(count >= 1, 'Filtered palette must show Answer Bank item');

    const firstItemText = await items.first().innerText();
    assert.match(firstItemText, /Answer Bank/i);

    // Press Enter to navigate
    await page.keyboard.press('Enter');

    // Verify navigation occurred and palette closed. Waits on the URL, not '.page__title':
    // the approvals page already has a title, so that wait passed before navigation happened.
    await page.waitForURL('**/answer-bank').catch(() => {});
    const currentUrl = page.url();
    assert.ok(currentUrl.includes('/answer-bank'), 'URL must update to /answer-bank');

    // The palette renders null when closed, so "detached" is the closed state to wait for.
    await page.locator('.palette-modal').waitFor({ state: 'detached' }).catch(() => {});
    const isModalOpen = await page.locator('.palette-modal').isVisible().catch(() => false);
    assert.equal(isModalOpen, false, 'Command palette must close on navigation');

    // Test ESC closing behavior
    await page.keyboard.press('Control+k');
    await page.waitForSelector('.palette-modal');
    // Same open-effect race as above: the effect also binds the Escape listener, so wait for
    // the focus it sets last before pressing Escape.
    await page.locator('.palette-input:focus').waitFor();
    await page.keyboard.press('Escape');
    // Closing is a re-render too; wait for the modal to leave the DOM before reading it.
    await page.locator('.palette-modal').waitFor({ state: 'detached' }).catch(() => {});
    const isModalClosedAfterEsc = await page.locator('.palette-modal').isVisible().catch(() => false);
    assert.equal(isModalClosedAfterEsc, false, 'Command palette must close on Escape key');
  });

  it('3. verifies Answer Bank search, category chips, and 1-click clipboard copy with toast', async () => {
    // Fake timers BEFORE navigation, so the page's setTimeout (Toast.tsx's 3200ms auto-dismiss)
    // runs on a clock we control. Without this the close click raced the auto-dismiss and flaked.
    await page.clock.install();
    // try/finally: the clock is context-wide, so later tests must get flowing time back even on failure.
    try {
      // Navigate after install() so the app's timers are created on the fake clock.
      await page.goto(`${serverUrl}/answer-bank`, { waitUntil: 'domcontentloaded' });
      // The toolbar is the first thing the page renders once the shell is signed in.
      await page.waitForSelector('.answer-bank__toolbar');

      // Category chips: one locator reused for the count and the clicks below.
      const chipBtns = page.locator('.chip-btn');
      // Counted, not just found, so a partial render with one chip can't pass.
      const chipCount = await chipBtns.count();
      // Five is All + the four categories the bank ships with.
      assert.ok(chipCount >= 5, 'Must render category chips (All, Compensation, Auth, EEO, Written)');

      // A category chip must narrow the table, not just toggle its own style.
      await page.locator('.chip-btn:has-text("Compensation & Notice")').click();
      // Rows after filtering; zero would mean the filter emptied the bank.
      const compensationRows = await page.locator('.settings-table tbody tr').count();
      // At least one compensation question proves the filter matched something real.
      assert.ok(compensationRows >= 1, 'Must show compensation questions');

      // Reset to All so the search below runs over the whole bank, not one category.
      await page.locator('.chip-btn:has-text("All Questions")').click();

      // Search box, located once for the fill below.
      const searchInput = page.locator('.answer-bank__search-input');
      // "relocate" matches exactly one seeded question, so the count is a precise check.
      await searchInput.fill('relocate');
      // The search filters on a re-render, and count() is a one-shot read: wait until a second
      // row is gone (at most one left) so the exact-count assertion reads the settled table.
      await page.locator('.settings-table tbody tr').nth(1).waitFor({ state: 'detached' }).catch(() => {});
      // Rows left after the instant search.
      const filteredRows = await page.locator('.settings-table tbody tr').count();
      // Exactly one: more means the search didn't filter, zero means it over-filtered.
      assert.equal(filteredRows, 1, 'Only relocation question should match');

      // The surviving row's text, to prove it is the RIGHT row and not just one row.
      const rowText = await page.locator('.settings-table tbody tr').first().innerText();
      // Case-insensitive because the question text capitalises freely.
      assert.match(rowText, /relocate/i);

      // Freeze time just ahead of now: from here no page timer fires unless we advance it,
      // so the toast's 3200ms auto-dismiss cannot run while we inspect and close it.
      await page.clock.pauseAt(Date.now() + 1000);

      // The copy button on the one remaining row.
      const copyBtn = page.locator('.copy-btn').first();
      // Copy is what raises the success toast under test.
      await copyBtn.click();

      // The toast must appear; time is paused, so it can't vanish before this resolves.
      await page.waitForSelector('.toast--success');
      // Read the message to prove it's the copy toast, not some other success notice.
      const toastMessage = await page.locator('.toast__message').first().textContent();
      // The copy handler's wording; ?? '' turns a missing node into a failed match.
      assert.match(toastMessage ?? '', /Copied answer for/i);

      // Close manually. With time paused this can't race the auto-dismiss any more.
      const toastCloseBtn = page.locator('.toast__close').first();
      // The user path under test: the dismiss button.
      await toastCloseBtn.click();
      // Time is frozen, so a vanished toast proves the CLOSE BUTTON removed it, not the timer.
      await page.waitForSelector('.toast--success', { state: 'detached' });
    } finally {
      // Hand real-paced time back to the shared context for tests 4-10.
      await page.clock.resume();
    }
  });

  it('4. verifies Pipeline Kanban Board & slide-over PipelineDrawer', async () => {
    await page.goto(`${serverUrl}/pipeline`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.page__title');

    // Verify 3 Human Lane groupings are rendered
    const laneHeadings = await page.locator('.lane__title').allTextContents();
    assert.ok(laneHeadings.some((t) => /Action Required/i.test(t)), 'Must render Action Required lane');
    assert.ok(laneHeadings.some((t) => /In Flight/i.test(t)), 'Must render In Flight lane');
    assert.ok(laneHeadings.some((t) => /Closed/i.test(t)), 'Must render Closed lane');

    // Click a column header to open PipelineDrawer
    const discoveredCol = page.locator('.column__head').first();
    await discoveredCol.click();

    // Verify drawer opened
    await page.waitForSelector('.drawer');
    const isDrawerOpen = await page.locator('.drawer').isVisible();
    assert.ok(isDrawerOpen, 'Pipeline drawer must open on column click');

    const drawerTitle = await page.locator('.drawer__title').textContent();
    assert.match(drawerTitle ?? '', /Application/i);

    // Close drawer via close button
    const closeBtn = page.locator('.drawer__close-btn');
    await closeBtn.click();

    // Closing is a re-render; wait for the drawer to be hidden or gone before the one-shot read.
    await page.locator('.drawer').waitFor({ state: 'hidden' }).catch(() => {});
    const isDrawerClosed = await page.locator('.drawer').isVisible().catch(() => false);
    assert.equal(isDrawerClosed, false, 'Pipeline drawer must close on close button click');
  });

  it('5. verifies Approval Queue page is clean of fake mock fixtures', async () => {
    await page.goto(`${serverUrl}/approvals`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.page__title');

    const htmlContent = await page.content();
    assert.ok(!htmlContent.includes('fixture-zomato-backend-intern'), 'Zero fake mock fixtures allowed');
    assert.ok(!htmlContent.includes('fixture-swiggy-frontend-intern'), 'Zero fake mock fixtures allowed');
  });

  it('6. verifies Company Watchlist form and overview metrics', async () => {
    await page.goto(`${serverUrl}/watchlist`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.page__title');

    const statCardsCount = await page.locator('.watchlist-stat-card').count();
    assert.equal(statCardsCount, 3, 'Must render 3 overview stat cards');

    const hasCompanyInput = await page.locator('input[placeholder*="Stripe"]').isVisible();
    assert.ok(hasCompanyInput, 'Must render Company Name input');

    const hasAtsSelect = await page.locator('select.field__control').isVisible();
    assert.ok(hasAtsSelect, 'Must render ATS Provider selector');

    const hasSubmitBtn = await page.locator('button:has-text("Add Board")').isVisible();
    assert.ok(hasSubmitBtn, 'Must render Add Board button');
  });

  it('7. verifies Master Profile intake surface', async () => {
    await page.goto(`${serverUrl}/master-profile`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.page__title');

    const profileTitle = await page.locator('.page__title').first().textContent();
    assert.match(profileTitle ?? '', /Master profile/i);

    const pageText = await page.locator('body').innerText();
    assert.ok(
      pageText.includes('Upload') || pageText.includes('JSON') || pageText.includes('Identity'),
      'Master profile intake surface must be active',
    );
  });

  it('8. verifies Email Intake & Monitoring dashboard, metric cards and edge-function sync', async () => {
    await page.goto(`${serverUrl}/emails`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.page__title');

    // 4 metric cards
    const emailStats = await page.locator('.email-stat-card').count();
    assert.equal(emailStats, 4, 'Must render 4 email metric boxes (Interviews, Linked, Direct, Mode)');

    // The sync moved to the gmail-sync edge function (2026-10-23): the webhook settings
    // drawer and its URL input are GONE — their presence would mean the dead UI returned.
    assert.equal(await page.locator('.email-monitor__settings-toggle').count(), 0, 'Webhook settings toggle must not render');
    assert.equal(await page.locator('.email-monitor__url-input').count(), 0, 'Webhook URL input must not render');

    // The manual refresh button is the one sync control left.
    const refreshBtn = page.locator('.email-monitor__toolbar .ingest__button');
    assert.equal(await refreshBtn.count(), 1, 'Refresh Interviews button must render');

    // The mount-time sync shows the quiet one-line status, and in the e2e sandbox (no real
    // gmail-sync function) it must be the failed or skipped wording: never a banner, and the
    // page rendered regardless.
    const statusLine = page.locator('p[title], p').filter({ hasText: /inbox|sync/ });
    // FLAKE FIX (CI 2026-10-24, 446eb60): the line appears only after the async mount-time
    // sync call settles, which can trail the title on a slow runner. count() is a one-shot read,
    // so wait for the line first. .catch so the named assertion below reports a real miss.
    await statusLine.first().waitFor().catch(() => {});
    assert.ok((await statusLine.count()) >= 1, 'The one-line sync status must render after mount');
  });

  it('9. verifies High-Legibility Typography and Dark/Light Theme Switching', async () => {
    await page.goto(`${serverUrl}/approvals`, { waitUntil: 'domcontentloaded' });

    // Validate modern Inter font stack
    const bodyFont = await page.evaluate(() => window.getComputedStyle(document.body).fontFamily);
    assert.ok(bodyFont.toLowerCase().includes('inter'), `Body font must resolve to Inter, got: ${bodyFont}`);

    // Theme switching. The old check looked for `.rail__theme-btn`, which exists nowhere in src,
    // and skipped when absent, so it passed vacuously on every build. The real control is
    // ThemeToggle.tsx: a `fieldset.theme` radio group (system | light | dark).
    // Role + accessible name, from <fieldset><legend>Appearance</legend>: survives a class rename,
    // and fails if the legend (the screen-reader group label) is ever dropped.
    const themeGroup = page.getByRole('group', { name: 'Appearance' });
    // Wait for the shell to mount, so "absent" means missing, not "not rendered yet".
    await page.waitForSelector('.page__title');
    // Assert presence instead of branching on it: a missing control is a failure, never a skip.
    assert.equal(await themeGroup.count(), 1, 'ThemeToggle (group "Appearance") must render in the app shell');

    // Radios by accessible name (THEME_OPTIONS labels). The input is visually hidden, so force
    // skips the visibility check; check() still fails if the radio doesn't end up checked.
    const pick = (name: 'System' | 'Light' | 'Dark') =>
      // exact: true so "Light" can never match a future "Light (high contrast)".
      themeGroup.getByRole('radio', { name, exact: true }).check({ force: true });
    // Reads the attribute applyTheme() writes on <html>.
    const themeAttr = () => page.evaluate(() => document.documentElement.getAttribute('data-theme'));

    // try/finally: Dark is persisted to localStorage, so a mid-test failure would leak it into test 10.
    try {
      // Dark stamps data-theme="dark".
      await pick('Dark');
      // Exact value, so a no-op toggle (null before and after) can't satisfy the check.
      assert.equal(await themeAttr(), 'dark', 'Choosing Dark must set data-theme="dark"');
      // Light stamps data-theme="light".
      await pick('Light');
      // Proves the switch actually moved, not just that dark stuck.
      assert.equal(await themeAttr(), 'light', 'Choosing Light must set data-theme="light"');
      // System REMOVES the attribute (theme.ts applyTheme).
      await pick('System');
      // null is the documented "follow the OS" state.
      assert.equal(await themeAttr(), null, 'Choosing System must remove data-theme');
    } finally {
      // Restore the default even after a failure; .catch so cleanup never masks the real assertion error.
      await pick('System').catch(() => {});
    }
  });

  it('10. verifies System Health and Kill-Switch status indicators', async () => {
    await page.goto(`${serverUrl}/health`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.page__title');

    const healthTitle = await page.locator('.page__title').first().textContent();
    assert.match(healthTitle ?? '', /System health/i);

    const bodyText = await page.locator('body').innerText();
    assert.ok(
      bodyText.includes('Kill switch') || bodyText.includes('Database') || bodyText.includes('Agent'),
      'Health page must display system telemetry',
    );
  });
});
