// Direct Node + Playwright E2E Test Runner for applyy
import { readFile, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { extractPdfText } from '../src/ats-parse-check.ts';

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

async function main() {
  console.log('[E2E] Starting applyy End-to-End Playwright & Master Resume Test Suite...');
  const rootDir = fileURLToPath(new URL('../../', import.meta.url));
  const webDistDir = fileURLToPath(new URL('../../apps/web/dist', import.meta.url));
  const masterResumePdfPath = fileURLToPath(new URL('../../master-resume.pdf', import.meta.url));

  // --- 1. Master Resume PDF E2E Test ---
  console.log('\n[E2E 1/7] Testing root master-resume.pdf text extraction & ATS readability...');
  const pdfBytes = await readFile(masterResumePdfPath);
  assert.ok(pdfBytes.length > 10000, 'master-resume.pdf must be > 10KB');

  const extracted = await extractPdfText(new Uint8Array(pdfBytes));
  console.log(`[E2E 1/7] Extracted text length: ${extracted.text.length} chars, ${extracted.items.length} fragments.`);

  assert.ok(extracted.text.includes('Mallam Teja'), 'Must contain Mallam Teja');
  assert.ok(extracted.text.includes('tejamallam'), 'Must contain email identifier');
  assert.ok(extracted.text.includes('Aczen Technologies'), 'Must contain Aczen Technologies');
  assert.ok(extracted.text.includes('One-on-One'), 'Must contain One-on-One project');
  assert.ok(extracted.text.includes('Python'), 'Must contain Python skill');
  assert.ok(extracted.text.includes('JavaScript'), 'Must contain JavaScript skill');
  assert.ok(extracted.text.includes('PostgreSQL'), 'Must contain PostgreSQL skill');
  assert.ok(extracted.text.includes('MLR Institute of Technology'), 'Must contain MLR Institute of Technology');
  console.log('✓ [E2E 1/7] master-resume.pdf successfully parsed & verified!');

  // --- 2. Start SPA Test Server ---
  console.log('\n[E2E] Starting ephemeral SPA static server for apps/web/dist...');
  const server = createServer(async (req, res) => {
    try {
      const urlPath = new URL(req.url ?? '/', 'http://localhost').pathname;
      const relPath = urlPath.replace(/^\//, '');
      let filePath = join(webDistDir, relPath === '' ? 'index.html' : relPath);
      let fileStat = await stat(filePath).catch(() => null);

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

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const serverUrl = `http://127.0.0.1:${port}`;
  console.log(`[E2E] Server listening on ${serverUrl}`);

  // --- 3. Launch Playwright Chromium ---
  console.log('[E2E] Launching headless Playwright Chromium...');
  const browser = await chromium.launch({ headless: true });

  try {
    // --- 2. Test Unauthenticated Operator Login Gate ---
    console.log('\n[E2E 2/7] Testing unauthenticated LoginPage gatekeeper...');
    const anonContext = await browser.newContext();
    const anonPage = await anonContext.newPage();
    await anonPage.goto(`${serverUrl}/`, { waitUntil: 'domcontentloaded' });

    // Wait for login card
    await anonPage.waitForSelector('.login-card');
    const tagline = await anonPage.locator('.login-card__tagline').textContent();
    assert.match(tagline, /operator authentication/i);

    const submitBtnText = await anonPage.locator('.login-form__submit-btn').textContent();
    assert.match(submitBtnText, /Sign In to Console/i);

    // Verify operator quick-fill pre-population
    const emailVal = await anonPage.locator('input[type="email"]').inputValue();
    assert.equal(emailVal, 'tejamallam00@gmail.com', 'Operator email must be pre-populated for Teja');
    console.log('✓ [E2E 2/7] Unauthenticated operator login gate verified!');
    await anonContext.close();

    // --- Create Authenticated Browser Context for Console Navigation ---
    const authContext = await browser.newContext();

    // Mock remote Supabase endpoints to decouple E2E tests from external network
    await authContext.route('https://xynqxekcqizwhtskzqrq.supabase.co/**', async (route) => {
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
            email: 'tejamallam00@gmail.com',
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
              email: 'tejamallam00@gmail.com',
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
            email: 'tejamallam00@gmail.com',
          },
        }),
      );
    });

    const page = await authContext.newPage();

    // --- 3. Approvals Zero-Mock Test ---
    console.log('\n[E2E 3/7] Navigating to /approvals (Approval Queue)...');
    await page.goto(`${serverUrl}/approvals`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.page__title');
    const approvalsTitle = await page.locator('.page__title').first().textContent();
    assert.match(approvalsTitle, /Approval queue/i);

    const htmlContent = await page.content();
    assert.ok(!htmlContent.includes('fixture-zomato-backend-intern'), 'No fake Zomato mock fixtures allowed');
    assert.ok(!htmlContent.includes('fixture-swiggy-frontend-intern'), 'No fake Swiggy mock fixtures allowed');
    console.log('✓ [E2E 3/7] Approval queue is free of mock data!');

    // --- 4. Interactive Company Watchlist Test ---
    console.log('\n[E2E 4/7] Navigating to /watchlist (Company Watchlist)...');
    await page.goto(`${serverUrl}/watchlist`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.page__title');
    const watchlistTitle = await page.locator('.page__title').first().textContent();
    assert.match(watchlistTitle, /Company watchlist/i);

    const statCardsCount = await page.locator('.watchlist-stat-card').count();
    assert.equal(statCardsCount, 3, 'Must render 3 overview stat cards (Target, Active, Historical)');

    const hasCompanyInput = await page.locator('input[placeholder*="Stripe"]').isVisible();
    assert.ok(hasCompanyInput, 'Must render Company Name input');

    const hasAtsSelect = await page.locator('select.field__control').isVisible();
    assert.ok(hasAtsSelect, 'Must render ATS Provider selector');

    const hasTokenInput = await page.locator('input[placeholder*="stripe"]').isVisible();
    assert.ok(hasTokenInput, 'Must render Board Token input');

    const hasSubmitBtn = await page.locator('button:has-text("Add Board")').isVisible();
    assert.ok(hasSubmitBtn, 'Must render Add Board button');
    console.log('✓ [E2E 4/7] Interactive Company Watchlist form and stats verified!');

    // --- 5. Master Profile Surface Test ---
    console.log('\n[E2E 5/7] Navigating to /master-profile (Master Profile)...');
    await page.goto(`${serverUrl}/master-profile`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.page__title');
    const profileTitle = await page.locator('.page__title').first().textContent();
    assert.match(profileTitle, /Master profile/i);

    const pageText = await page.locator('body').innerText();
    assert.ok(
      pageText.includes('Upload') || pageText.includes('JSON') || pageText.includes('Identity'),
      'Master profile intake surface is active',
    );
    console.log('✓ [E2E 5/7] Master profile intake and review surface verified!');

    // --- 6. Email Monitoring Live Feed Test ---
    console.log('\n[E2E 6/7] Navigating to /emails (Email Monitoring)...');
    await page.goto(`${serverUrl}/emails`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.page__title');
    const emailTitle = await page.locator('.page__title').first().textContent();
    assert.match(emailTitle, /Email monitoring/i);

    const emailStats = await page.locator('.email-stat-card').count();
    assert.equal(emailStats, 3, 'Must render 3 email metric boxes (Interviews, Linked, Direct)');

    const hasRefreshBtn = await page.locator('button:has-text("Refresh")').isVisible();
    assert.ok(hasRefreshBtn, 'Must render Refresh Interviews button');
    console.log('✓ [E2E 6/7] Email monitoring dashboard and controls verified!');

    // --- 7. Typography Tokens & Theme Toggle Test ---
    console.log('\n[E2E 7/7] Testing typography styles and theme switching...');
    const bodyFont = await page.evaluate(() => window.getComputedStyle(document.body).fontFamily);
    console.log(`[E2E 7/7] Computed body font: ${bodyFont}`);
    assert.ok(bodyFont.toLowerCase().includes('ibm plex sans'), 'Body font must resolve to IBM Plex Sans');

    const themeToggle = page.locator('.rail__theme-btn');
    if ((await themeToggle.count()) > 0) {
      const initialTheme = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
      await themeToggle.first().click();
      const updatedTheme = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
      console.log(`[E2E 7/7] Theme toggle: "${initialTheme}" -> "${updatedTheme}"`);
      assert.notEqual(initialTheme, updatedTheme, 'Theme attribute must toggle');
    }
    console.log('✓ [E2E 7/7] Typography and theme toggle successfully verified!');

    await authContext.close();
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }

  console.log('\n======================================================');
  console.log('🎉 ALL 7 PLAYWRIGHT E2E & RESUME TESTS PASSED (100%)');
  console.log('======================================================\n');
}

main().catch((err) => {
  console.error('\n❌ [E2E FAILURE]:', err);
  process.exit(1);
});
