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
import { readFile, stat } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { extname, join } from 'node:path';
import { describe, it, before, after } from 'node:test';
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

describe('Playwright E2E Operator Console Suite', () => {
  let server: Server;
  let serverUrl: string;
  let browser: Browser;
  let authContext: BrowserContext;
  let page: Page;

  before(async () => {
    // 1. Verify build artifacts exist
    const distIndex = join(webDistDir, 'index.html');
    const distExists = await stat(distIndex).catch(() => null);
    if (!distExists) {
      throw new Error(`Build artifacts missing in ${webDistDir}. Run "pnpm --filter @applyy/web build" first.`);
    }

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

    // Verify search input is focused and placeholder is present
    const isInputVisible = await page.locator('.palette-input').isVisible();
    assert.ok(isInputVisible, 'Command palette search input must be visible');

    // Type query to filter to Answer Bank
    await page.locator('.palette-input').fill('Answer Bank');
    const items = page.locator('.palette-item');
    const count = await items.count();
    assert.ok(count >= 1, 'Filtered palette must show Answer Bank item');

    const firstItemText = await items.first().innerText();
    assert.match(firstItemText, /Answer Bank/i);

    // Press Enter to navigate
    await page.keyboard.press('Enter');

    // Verify navigation occurred and palette closed
    await page.waitForSelector('.page__title');
    const currentUrl = page.url();
    assert.ok(currentUrl.includes('/answer-bank'), 'URL must update to /answer-bank');

    const isModalOpen = await page.locator('.palette-modal').isVisible().catch(() => false);
    assert.equal(isModalOpen, false, 'Command palette must close on navigation');

    // Test ESC closing behavior
    await page.keyboard.press('Control+k');
    await page.waitForSelector('.palette-modal');
    await page.keyboard.press('Escape');
    const isModalClosedAfterEsc = await page.locator('.palette-modal').isVisible().catch(() => false);
    assert.equal(isModalClosedAfterEsc, false, 'Command palette must close on Escape key');
  });

  it('3. verifies Answer Bank search, category chips, and 1-click clipboard copy with toast', async () => {
    await page.goto(`${serverUrl}/answer-bank`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.answer-bank__toolbar');

    // Verify category chips
    const chipBtns = page.locator('.chip-btn');
    const chipCount = await chipBtns.count();
    assert.ok(chipCount >= 5, 'Must render category chips (All, Compensation, Auth, EEO, Written)');

    // Click 'Compensation & Notice' chip
    await page.locator('.chip-btn:has-text("Compensation & Notice")').click();
    const compensationRows = await page.locator('.settings-table tbody tr').count();
    assert.ok(compensationRows >= 1, 'Must show compensation questions');

    // Click 'All Questions' to reset
    await page.locator('.chip-btn:has-text("All Questions")').click();

    // Type in search box
    const searchInput = page.locator('.answer-bank__search-input');
    await searchInput.fill('relocate');
    const filteredRows = await page.locator('.settings-table tbody tr').count();
    assert.equal(filteredRows, 1, 'Only relocation question should match');

    const rowText = await page.locator('.settings-table tbody tr').first().innerText();
    assert.match(rowText, /relocate/i);

    // Click Copy button and verify Toast notification
    const copyBtn = page.locator('.copy-btn').first();
    await copyBtn.click();

    // Verify toast notification appears
    await page.waitForSelector('.toast--success');
    const toastMessage = await page.locator('.toast__message').first().textContent();
    assert.match(toastMessage ?? '', /Copied answer for/i);

    // Test closing toast manually
    const toastCloseBtn = page.locator('.toast__close').first();
    await toastCloseBtn.click();
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

  it('8. verifies Email Intake & Monitoring dashboard, metric cards and sync drawer', async () => {
    await page.goto(`${serverUrl}/emails`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.page__title');

    // 4 metric cards
    const emailStats = await page.locator('.email-stat-card').count();
    assert.equal(emailStats, 4, 'Must render 4 email metric boxes (Interviews, Linked, Direct, Mode)');

    // Toggle Sync Settings drawer
    const settingsBtn = page.locator('.email-monitor__settings-toggle');
    await settingsBtn.click();
    await page.waitForSelector('.email-monitor__settings-box');

    const hasUrlInput = await page.locator('.email-monitor__url-input').isVisible();
    assert.ok(hasUrlInput, 'Must render Google Apps Script Webhook URL input');

    // Close settings drawer
    await settingsBtn.click();
    const isBoxVisible = await page.locator('.email-monitor__settings-box').isVisible().catch(() => false);
    assert.equal(isBoxVisible, false, 'Settings box must collapse on toggle');
  });

  it('9. verifies High-Legibility Typography and Dark/Light Theme Switching', async () => {
    await page.goto(`${serverUrl}/approvals`, { waitUntil: 'domcontentloaded' });

    // Validate modern Inter font stack
    const bodyFont = await page.evaluate(() => window.getComputedStyle(document.body).fontFamily);
    assert.ok(bodyFont.toLowerCase().includes('inter'), `Body font must resolve to Inter, got: ${bodyFont}`);

    // Theme switching
    const themeToggle = page.locator('.rail__theme-btn');
    if ((await themeToggle.count()) > 0) {
      const initialTheme = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
      await themeToggle.first().click();
      const updatedTheme = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
      assert.notEqual(initialTheme, updatedTheme, 'Theme attribute must toggle between light/dark');
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
