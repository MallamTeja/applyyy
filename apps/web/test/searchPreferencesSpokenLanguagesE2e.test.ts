/* Settings → "Languages I can work in": the edit reaches the saved payload (2026-11-23, BBHT 5e108a32).
 *
 * WHY. The screener's language gate reads search_preferences.spoken_languages. The page's load and save are inline
 * in effect-driven code (apps/web has no DOM lib), so the round trip is proven here, in the built bundle, with
 * page.route answering every Supabase call and recording each upsert body.
 * WHAT IT PINS. (1) The stored list loads into the box. (2) An edited list saves as a trimmed array. (3) An EMPTY box
 * saves null (rule off), never [] (which could read as "speaks nothing" and drop every job naming a language).
 * RED-ON-REVERT: dropping `spoken_languages` from the save payload fails the first test at the payload assert;
 * saving `[]` for an empty box fails the second;
 * always sending the key (no column check) fails the third.
 *
 * Needs the e2e bundle: cd apps/web && ./node_modules/.bin/vite build --mode e2e (CI builds it first). */

// Strict asserts.
import assert from 'node:assert/strict';
// The Server type only: the shared harness starts it, after() closes it.
import type { Server } from 'node:http';
// The runner; beforeEach turns a guard failure into a FAILED test rather than a cancelled one.
import { after, before, beforeEach, describe, it } from 'node:test';
// The browser, already a dependency of this package.
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
// The shared browser-test harness: dist guard, static SPA server, fake session.
import { assertDistIsTestable, seedSession, startDistServer } from './support/e2eDist.ts';

// The operator the fake session signs in as.
const USER = { id: '0f4b24da-e85b-40bb-8606-c81824493b45', aud: 'authenticated', role: 'authenticated', email: 'operator@example.test' };

// The stored preferences row, as the migration seeds it: English only.
const PREFS_ROW = {
  // The owner.
  user_id: USER.id,
  // Non-empty lists, so the page shows real values rather than its examples.
  titles: ['Software Engineer'],
  // Same.
  keywords: ['TypeScript'],
  // Same.
  excluded_keywords: [],
  // Same.
  locations: ['Hyderabad'],
  // The countries box's own value.
  work_authorized_countries: ['India'],
  // The remote select's value.
  remote_location_policy: 'unlocked_or_authorized',
  // THE FIELD UNDER TEST: the seed.
  spoken_languages: ['English'],
};

// The same row as a database WITHOUT migration 20261123210000 returns it from select('*'): no spoken_languages key.
const { spoken_languages: _absent, ...PREFS_ROW_NO_COLUMN } = PREFS_ROW;

describe('Settings: Languages I can work in saves what Teja typed (2026-11-23)', () => {
  // The static server.
  let server: Server;
  // Where it listens.
  let baseUrl: string;
  // Chromium.
  let browser: Browser;
  // The signed-in context with the Supabase routes.
  let context: BrowserContext;
  // The page the test drives.
  let page: Page;
  // A dist that cannot prove anything, recorded so the test fails by name instead of being cancelled.
  let guardError: Error | undefined;
  // Every search_preferences upsert body, in order.
  const upserts: Array<Record<string, unknown>> = [];
  // Native dialogs opened; must stay 0 (repo rule).
  let dialogs = 0;
  // The row the fake PostgREST serves; the last test swaps in the pre-migration shape.
  let servedRow: Record<string, unknown> = PREFS_ROW;

  // Rethrown per test: a failed before() would CANCEL it, which proves nothing.
  beforeEach(() => {
    // The guard's own message, as the test's failure.
    if (guardError) throw guardError;
  });

  before(async () => {
    // Missing, stale or unconfigured dist: recorded, not thrown.
    guardError = await assertDistIsTestable().then(() => undefined, (e: unknown) => (e instanceof Error ? e : new Error(String(e))));
    // Nothing worth serving.
    if (guardError) return;
    // The shared SPA server on a free loopback port.
    ({ server, base: baseUrl } = await startDistServer());
    // Headless, as CI runs it.
    browser = await chromium.launch({ headless: true });
    // A fresh context for this file.
    context = await browser.newContext();
    // Every Supabase call answered here; nothing reaches the network.
    await context.route('https://*.supabase.co/**', async (route) => {
      // Parsed once.
      const url = new URL(route.request().url());
      // The request method.
      const method = route.request().method();
      // The session's user (getUser before the upsert).
      if (url.pathname.endsWith('/auth/v1/user')) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(USER) });
      // The preferences row: a write is recorded, a read returns the seeded row.
      if (url.pathname.endsWith('/rest/v1/search_preferences')) {
        // The upsert: record its body (supabase-js may send an object or a one-element array).
        if (method === 'POST') {
          // The JSON body.
          const body = route.request().postDataJSON() as unknown;
          // Normalised to one object.
          upserts.push((Array.isArray(body) ? body[0] : body) as Record<string, unknown>);
          // PostgREST's "created, no body" answer.
          return route.fulfill({ status: 201, contentType: 'application/json', body: '' });
        }
        // maybeSingle(): an object when the client asks for one, else a one-row array.
        const wantsObject = (route.request().headers()['accept'] ?? '').includes('vnd.pgrst.object');
        // The seeded row in the asked shape.
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(wantsObject ? servedRow : [servedRow]) });
      }
      // Other writes (system_settings upsert): accepted with no body.
      if (method !== 'GET') return route.fulfill({ status: 201, contentType: 'application/json', body: '' });
      // Every other read: empty, as PostgREST answers "nothing".
      return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'content-range': '*/0' }, body: '[]' });
    });
    // The stored session supabase-js reads on boot.
    await seedSession(context, USER.id);
    // The page.
    page = await context.newPage();
    // Counted AND dismissed, so a native dialog fails by name instead of hanging the run.
    page.on('dialog', (dialog) => {
      // Counted first.
      dialogs += 1;
      // Dismissed.
      void dialog.dismiss().catch(() => {});
    });
  });

  after(async () => {
    // Each closed only if it was opened.
    if (page) await page.close().catch(() => {});
    // The context.
    if (context) await context.close().catch(() => {});
    // The browser.
    if (browser) await browser.close().catch(() => {});
    // The server.
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  // The box, found by its visible label.
  const box = () => page.getByLabel('Languages I can work in');

  // Click Save and wait until one more upsert has arrived (event-driven, no sleeps).
  async function saveAndCapture(): Promise<Record<string, unknown>> {
    // How many writes there were before.
    const before = upserts.length;
    // The page's own save button.
    await page.getByRole('button', { name: 'Save Preferences' }).click();
    // The success line, which renders only after the upsert answered.
    await page.getByText('Search preferences and pipeline controls saved.').waitFor({ timeout: 15_000 });
    // Exactly one new write.
    assert.equal(upserts.length, before + 1, `expected one new search_preferences upsert, saw ${upserts.length - before}`);
    // That write's body.
    return upserts[upserts.length - 1]!;
  }

  it('loads the stored list, and saves an edited list as a trimmed array', async () => {
    // The page under test.
    await page.goto(`${baseUrl}/search-preferences`, { waitUntil: 'domcontentloaded' });
    // The stored seed reached the box (the load path read spoken_languages).
    await page.waitForFunction(() => (document.querySelector('input[placeholder^="Not set: rule off"]') as HTMLInputElement | null)?.value === 'English', undefined, { timeout: 15_000 });
    // Teja's six languages (relayed 2026-11-23), with sloppy spacing, so all six must fit and save.
    await box().fill('Telugu, Hindi ,English,  Kannada, Malayalam , Tamil');
    // Saved.
    const body = await saveAndCapture();
    // The trimmed list, all six, in order.
    assert.deepEqual(body['spoken_languages'], ['Telugu', 'Hindi', 'English', 'Kannada', 'Malayalam', 'Tamil']);
    // The countries box was not disturbed by the new field.
    assert.deepEqual(body['work_authorized_countries'], ['India']);
  });

  it('saves an emptied box as null (rule off), never an empty list', async () => {
    // Clear the box.
    await box().fill('');
    // Saved.
    const body = await saveAndCapture();
    // The key is present and null: the gate is off, it does not "speak nothing".
    assert.ok('spoken_languages' in body, 'spoken_languages missing from the payload');
    // Null, not [].
    assert.equal(body['spoken_languages'], null);
    // No native dialog anywhere in the flow.
    assert.equal(dialogs, 0);
  });

  it('before the migration (no spoken_languages column) the box is locked and the save leaves the key out', async () => {
    // The database as it is before migration 20261123210000.
    servedRow = PREFS_ROW_NO_COLUMN;
    // A fresh load reads the new shape.
    await page.goto(`${baseUrl}/search-preferences`, { waitUntil: 'domcontentloaded' });
    // The load finished: the countries box shows the stored value.
    await page.getByLabel('Countries I can work in without a visa').and(page.locator('input')).waitFor({ timeout: 15_000 });
    // Its value is the stored list, so the row (not the first paint) is on screen.
    await page.waitForFunction(() => [...document.querySelectorAll('input')].some((i) => i.value === 'India'), undefined, { timeout: 15_000 });
    // The one line saying why the box is locked.
    await page.getByText('Not available yet: the database update for this setting has not run.', { exact: false }).waitFor({ timeout: 15_000 });
    // Locked, so nothing typed there can be lost.
    assert.equal(await box().isDisabled(), true);
    // The rest of the page still saves.
    const body = await saveAndCapture();
    // No key at all: PostgREST would refuse the whole upsert (PGRST204) for an unknown column.
    assert.equal('spoken_languages' in body, false, 'spoken_languages sent to a database that lacks the column');
    // The other fields went out.
    assert.deepEqual(body['work_authorized_countries'], ['India']);
  });
});
