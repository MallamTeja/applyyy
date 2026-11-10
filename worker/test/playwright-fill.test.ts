// Tests for createPlaywrightPage().fill(): it must dispatch on the LIVE element's kind and
// accept ONLY exact option text. Runs on a SYNTHETIC local fixture; nothing leaves localhost.
// The captured gitlab form is static HTML (`grep -c "<script" fixtures/greenhouse/gitlab-remix-form.html`
// returns 0, checked 2026-10-05), so its react-select widgets cannot open offline; the
// react-select path therefore runs against minimal synthetic lookalikes in the same fixture.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { startFixtureServer, type FixtureServer } from '../src/fixture-server.ts';
import { createPlaywrightPage } from '../src/playwright-page.ts';

// Shared across tests: one Chromium launch keeps the file fast (Actions minutes are budgeted).
let browser: Browser;
// Serves fixtures/ over localhost so nothing reaches a real ATS.
let server: FixtureServer;
// One tab, reloaded per test.
let page: Page;

beforeAll(async () => {
  // Real Chromium: selectOption/check semantics are the thing under test.
  browser = await chromium.launch();
  // Serve the checked-in directory itself so a deleted fixture fails loudly.
  server = await startFixtureServer('fixtures');
  // Created once; beforeEach resets its state.
  page = await browser.newPage();
}, 60_000);

beforeEach(async () => {
  // Reload per test so each starts from an untouched form (no cross-test selections).
  await page.goto(`${server.url}/synthetic/native-controls.html`);
});

afterAll(async () => {
  // Optional chaining: a failed beforeAll must not hide its error behind a teardown crash.
  await browser?.close();
  // Frees the port for the next test file.
  await server?.close();
});

describe('fill() on choice controls', () => {
  test('native select: exact label selects it', async () => {
    // Exact label, the only accepted form.
    await createPlaywrightPage(page).fill('country_native', 'India');
    // The option's value, not its label: proves the right <option> was chosen.
    expect(await page.locator('#country_native').inputValue()).toBe('in');
  });

  test('native select: near-miss throws no_matching_option and selects nothing', async () => {
    // The port under test, bound to the real page.
    const live = createPlaywrightPage(page);
    // Case difference and a prefix are the two realistic "close" answers.
    for (const nearMiss of ['india', 'Ind']) {
      // rejects.toThrow asserts the named error, not merely any failure.
      await expect(live.fill('country_native', nearMiss)).rejects.toThrow(/^no_matching_option: country_native/);
    }
    // Still on the placeholder (value ""): nothing was selected.
    expect(await page.locator('#country_native').inputValue()).toBe('');
  });

  test('radio group: exact option is checked; a different word is never approximated', async () => {
    // Radio group addressed by the fieldset id the extractor emits.
    const live = createPlaywrightPage(page);
    await live.fill('located_in_india', 'No');
    // The sibling must be unchecked, proving a real radio-group switch.
    expect(await page.locator('input[value="n"]').isChecked()).toBe(true);
    expect(await page.locator('input[value="y"]').isChecked()).toBe(false);
    // "Ye" is a prefix of "Yes", not the same text; the group must stay as it was.
    // A near-miss is refused, never coerced (only case/spacing/punctuation fold, via option-match.ts).
    await expect(live.fill('located_in_india', 'Ye')).rejects.toThrow(/^no_matching_option/);
    expect(await page.locator('input[value="n"]').isChecked()).toBe(true);
    // The temporary marker must not leak into the DOM, success or failure.
    // Counting (not truthiness) so zero is asserted explicitly.
    expect(await page.locator('[data-applyyy-pick]').count()).toBe(0);
  });

  test('radio group: a case-only difference picks the form\'s own option ("yes" checks "Yes")', async () => {
    // Same group; the live answer bank stores lowercase "yes".
    const live = createPlaywrightPage(page);
    await live.fill('located_in_india', 'yes');
    // The form's own "Yes" radio is checked, and its sibling is not.
    expect(await page.locator('input[value="y"]').isChecked()).toBe(true);
    expect(await page.locator('input[value="n"]').isChecked()).toBe(false);
    // No marker left behind on the success path either.
    expect(await page.locator('[data-applyyy-pick]').count()).toBe(0);
  });

  test('checkbox: refused, never ticked', async () => {
    // Even an affirmative value is refused: ticking is a human act.
    await expect(createPlaywrightPage(page).fill('agree', 'Yes')).rejects.toThrow(/^checkbox_not_autofilled/);
    // The refusal must also leave the box untouched.
    expect(await page.locator('#agree').isChecked()).toBe(false);
  });

  test('combobox: exact option wins over closer-typed ones, read back from the widget', async () => {
    // "India" also matches "British Indian Ocean Territory" and "Indonesia" while typing.
    // Real typing and clicking, driven by fill().
    await createPlaywrightPage(page).fill('city', 'India');
    // The widget's own displayed value is what the user would see; that is the truth to assert.
    expect(await page.locator('#city-shown').textContent()).toBe('India');
  });

  test('combobox: no exact match throws, clears the text, picks nothing', async () => {
    // 'Indo' matches Indonesia and Indian Ocean rows but equals none exactly.
    await expect(createPlaywrightPage(page).fill('city', 'Indo')).rejects.toThrow(/^no_matching_option: city/);
    // Typed text cleared and nothing chosen.
    // The half-typed 'Indo' must be gone.
    expect(await page.locator('#city').inputValue()).toBe('');
    expect(await page.locator('#city-shown').textContent()).toBe('');
  });

  test('two widgets: another widget open menu is never clicked (aria-controls scope)', async () => {
    // Region's stale menu already holds an "India" row. Filling City must pick City's row only.
    await createPlaywrightPage(page).fill('city', 'India');
    // City shows the choice...
    expect(await page.locator('#city-shown').textContent()).toBe('India');
    // ...and Region, whose option shares the text, stayed untouched.
    expect(await page.locator('#region-shown').textContent()).toBe('');
  });

  test('two widgets: no aria link falls back to the widget subtree, not the page', async () => {
    // City's stale menu (earlier in the DOM) also holds an "India" row a page-wide query would hit first.
    // No aria-controls on Region, so this exercises the subtree fallback.
    await createPlaywrightPage(page).fill('region', 'India');
    // Region shows it; City, whose stale row shares the text, was not involved.
    expect(await page.locator('#region-shown').textContent()).toBe('India');
    expect(await page.locator('#city-shown').textContent()).toBe('');
  });

  test('a combobox whose menu cannot be scoped fails closed instead of going page-wide', async () => {
    // Lonely has no aria link and shares its only ancestors with other comboboxes, so there
    // is no safe scope. Region's stale "India" row exists page-wide and must NOT be used.
    // The call a page-wide query would have silently satisfied.
    await expect(createPlaywrightPage(page).fill('lonely', 'India')).rejects.toThrow(/^no_matching_option: lonely/);
    expect(await page.locator('#region-shown').textContent()).toBe('');
  });
});
