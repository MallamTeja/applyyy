// The three form-read gaps found by the 2026-11-05 submit-readiness sweep, each pinned on a local
// fixture in a real Chromium (nothing leaves localhost):
//   T1  goto read an Ashby-style client-rendered form before it existed (0 fields; 11 open postings
//       were then called closed by the kit).
//   T2  the extractor dropped every Lever control: no aria-label, no id, no <label for>.
//   T3  a combobox's options exist only while its menu is open, so the kit never had them.
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
// The real browser: render timing, ids and menus are what is under test.
import { chromium, type Browser, type Page } from 'playwright';
// Serves fixtures/ over localhost.
import { startFixtureServer, type FixtureServer } from '../src/fixture-server.ts';
// The page port whose goto and readMenuOptions are under test.
import { createPlaywrightPage } from '../src/playwright-page.ts';
// The extractor, for the Lever cases.
import { extractFields } from '../src/extract-fields.ts';

// One Chromium for the file: launches are the slow part.
let browser: Browser;
// The fixture server.
let server: FixtureServer;

beforeAll(async () => {
  // Headless, as on CI.
  browser = await chromium.launch();
  // The checked-in directory itself, so a missing fixture fails loudly.
  server = await startFixtureServer('fixtures');
}, 60_000);

afterAll(async () => {
  // Optional chaining: a failed beforeAll must not hide its error behind a teardown crash.
  await browser?.close();
  // Frees the port.
  await server?.close();
});

/** A fresh tab per test, so one test's DOM edits never reach the next. */
async function tab(): Promise<Page> {
  // New page from the shared browser.
  return browser.newPage();
}

describe('T1: goto waits for a client-rendered form', () => {
  test('a form that renders 1.2 s after domcontentloaded is read in full', async () => {
    // The tab under test.
    const raw = await tab();
    try {
      // The production goto, with its production wait.
      await createPlaywrightPage(raw).goto(`${server.url}/synthetic/late-render-form.html`);
      // Read immediately after goto returns, as the kit and the applier do.
      const fields = await extractFields(raw);
      // Both controls, the email among them: before T1 this read 0 fields.
      expect(fields.map((field) => field.label)).toEqual(['Full Name', 'Email']);
    } finally {
      // Closed either way.
      await raw.close();
    }
  }, 30_000);

  test('a page that never renders a control hands over after the bound, without throwing', async () => {
    // The tab under test.
    const raw = await tab();
    try {
      // A short bound so the test does not sit through the production 15 s.
      const page = createPlaywrightPage(raw, { formRenderTimeoutMs: 500 });
      // Timed, to prove the wait is bounded, not skipped and not endless.
      const started = Date.now();
      // Resolves (a timeout is not an error here).
      await page.goto(`${server.url}/synthetic/no-form.html`);
      // Waited for the form (the bound), and no longer than the bound plus slack.
      expect(Date.now() - started).toBeGreaterThanOrEqual(450);
      // Upper bound: loose enough for a slow runner, far below the 15 s default.
      expect(Date.now() - started).toBeLessThan(5_000);
      // The page as it is: nothing to read.
      expect(await page.extractFields()).toEqual([]);
    } finally {
      // Closed either way.
      await raw.close();
    }
  }, 30_000);
});

describe('T2: Lever controls are labelled and addressable (trimmed real Netomi form)', () => {
  test('every question is read with its Lever label, required mark and a stable id', async () => {
    // The tab under test.
    const raw = await tab();
    try {
      // The trimmed live markup; static, so goto returns at once.
      await raw.goto(`${server.url}/lever/netomi-apply-form.html`);
      // The read under test.
      const fields = await extractFields(raw);
      // Compact view: label, kind, required, id.
      const view = fields.map((field) => ({ label: field.label, kind: field.kind, required: field.required, id: field.id }));
      // Every visible question, in form order. Before T2 this list was EMPTY.
      expect(view).toEqual([
        // The real id is kept; required comes from the ✱ mark (no required attribute on it).
        { label: 'Resume/CV', kind: 'file', required: true, id: 'resume-upload-input' },
        // Standard questions: ids derived from the submit name.
        { label: 'Full name', kind: 'text', required: true, id: 'applyyy-name-name' },
        // type=email, so the kit's closed-posting backstop sees a real form.
        { label: 'Email', kind: 'email', required: true, id: 'applyyy-name-email' },
        // The ✱ after a space is stripped too.
        { label: 'Phone', kind: 'text', required: true, id: 'applyyy-name-phone' },
        // A card dropdown: no wrapping <label>, labelled by its .application-label.
        { label: 'What is your Current Location?', kind: 'native_select', required: true, id: 'applyyy-name-cards[c8afb62e-f85f-45cd-82f8-acaef1a6c56f][field0]' },
        // A required card text box.
        { label: 'Please share the relevant experience in Kubernetes.', kind: 'text', required: true, id: 'applyyy-name-cards[4a073f98-1fdf-49db-8024-f859d2d3cad8][field0]' },
        // An optional one: no mark, not required.
        { label: 'Please share the relevant experience in Linux.', kind: 'text', required: false, id: 'applyyy-name-cards[4a073f98-1fdf-49db-8024-f859d2d3cad8][field3]' },
      ]);
      // The card dropdown's options, placeholder excluded, exactly as the form lists them.
      expect(fields.find((field) => field.kind === 'native_select')?.options).toEqual(['Delhi NCR', 'Bangalore', 'Pune', 'Hyderabad', 'Mumbai', 'Any Other']);
    } finally {
      // Closed either way.
      await raw.close();
    }
  });

  test('a second read gives the same ids, and fill() reaches the control by them', async () => {
    // The tab under test.
    const raw = await tab();
    try {
      // Same fixture.
      await raw.goto(`${server.url}/lever/netomi-apply-form.html`);
      // First read assigns the ids.
      const first = (await extractFields(raw)).map((field) => field.id);
      // A second read (the applier re-reads) must not mint new ones.
      const second = (await extractFields(raw)).map((field) => field.id);
      // Identical, not "applyyy-name-name-2".
      expect(second).toEqual(first);
      // The production filler, addressing a Lever input by its derived id.
      await createPlaywrightPage(raw).fill('applyyy-name-name', 'Test Name');
      // The value landed in the input the form submits as `name`.
      expect(await raw.locator('input[name="name"]').inputValue()).toBe('Test Name');
    } finally {
      // Closed either way.
      await raw.close();
    }
  });
});

describe('T3: readMenuOptions opens a combobox, reads it and closes it', () => {
  test('a static list is read exactly; a search box reads as null; both menus end closed', async () => {
    // The tab under test.
    const raw = await tab();
    try {
      // The port under test.
      const page = createPlaywrightPage(raw);
      // The react-select lookalikes.
      await page.goto(`${server.url}/synthetic/combobox-menu.html`);
      // The static list: exact texts, in order.
      expect(await page.readMenuOptions!('question_1')).toEqual(['Yes', 'No']);
      // The search box renders nothing on open: no list, never an empty list.
      expect(await page.readMenuOptions!('school--0')).toBeNull();
      // Escape closed both: no option is left in the DOM to capture a later click.
      expect(await raw.locator('[role="option"]').count()).toBe(0);
      // And the widgets say so.
      expect(await raw.locator('[aria-expanded="true"]').count()).toBe(0);
    } finally {
      // Closed either way.
      await raw.close();
    }
  });

  test('handlers that attach 400 ms after load (slow hydration) still give the full list', async () => {
    // The Stripe Country flake: `load` fired, the click hit an un-hydrated input, one look saw
    // aria-expanded="false" and returned null, so the kit shipped Country with no options.
    const raw = await tab();
    try {
      // The port under test.
      const page = createPlaywrightPage(raw);
      // The same widgets, hydrated late.
      await page.goto(`${server.url}/synthetic/combobox-menu.html?hydrateMs=400`);
      // Read at once, as the kit does: the reader must retry the click, not give up on one look.
      expect(await page.readMenuOptions!('question_1')).toEqual(['Yes', 'No']);
      // Closed afterwards, as in the eager case.
      expect(await raw.locator('[role="option"]').count()).toBe(0);
    } finally {
      // Closed either way.
      await raw.close();
    }
  });
});
