// Pins how createPlaywrightPage().fill() picks an option in a react-select combobox when the bank answer
// differs from the option text only in case/whitespace/separator punctuation (option-match.ts).
// WHY: Greenhouse's react-select options are absent at extract time (extract-fields.ts:32-34), so the planner
// cannot map "india" to "India" for them; only the filler sees the rendered list. Before this, the filler
// demanded the exact text, so the live bank's lowercase answers ("india", "yes") parked the row at fill.
// What must NOT change: an exact match still wins, and a different word ("male" vs "Man"), a substring
// ("India" inside "Indiana") or two options that normalize alike all park as no_matching_option.
// Runs on page.setContent only: nothing leaves this process, no live site is touched.
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
// Real Chromium, because the click and the readback are the things under test.
import { chromium, type Browser, type Page } from 'playwright';
// The port under test.
import { createPlaywrightPage } from '../src/playwright-page.ts';

// One Chromium launch for the whole file keeps it fast.
let browser: Browser;
// One tab; each test replaces its content with setContent, so no state leaks between tests.
let page: Page;

beforeAll(async () => {
  // Launched once; a launch per test would dominate the runtime.
  browser = await chromium.launch();
  // Created once; every test overwrites the DOM before using it.
  page = await browser.newPage();
}, 60_000);

afterAll(async () => {
  // Optional chaining: a failed beforeAll must not hide its error behind a teardown crash.
  await browser?.close();
});

// Awaits a promise that MUST reject and hands back the error for message checks.
async function rejection(p: Promise<unknown>): Promise<Error> {
  try {
    // A resolve here means fill() picked something it should have refused.
    await p;
  } catch (error) {
    // Non-Error throws would make the message assertions meaningless.
    if (!(error instanceof Error)) throw new Error(`rejected with a non-Error: ${String(error)}`);
    // The caught error, for the caller's checks.
    return error;
  }
  // Reached only when the promise resolved, which every caller treats as a failure.
  throw new Error('expected fill() to reject, but it resolved');
}

// A react-select lookalike (same shape as country-dial-option.test.ts's picker, minus the dial suffix):
// one widget, options inside the container, and a click that shows the clicked option's full text.
function selectHtml(options: string[]): string {
  // Option rows from plain text; the test strings contain no markup characters.
  const rows = options.map((text) => `<div role="option">${text}</div>`).join('');
  // One widget per page, so the filler's ancestor climb can never swallow a sibling widget.
  return `
    <div class="x-container">
      <div class="x-placeholder">Select...</div>
      <input id="q" role="combobox" />
      <div class="x-menu" role="listbox">${rows}</div>
    </div>
    <script>
      // Every option click records its text, so tests can prove which row (if any) was clicked.
      document.querySelectorAll('[role="option"]').forEach((opt) => {
        // One handler per row, mirroring react-select's per-option onClick.
        opt.addEventListener('click', () => {
          // Witness of the click for the clicked/not-clicked assertions.
          document.body.dataset.clicked = opt.textContent;
          // The placeholder disappears once a value is chosen, as in react-select.
          document.querySelector('.x-placeholder')?.remove();
          // Reuse the single-value element on a second pick instead of stacking two.
          let shown = document.querySelector('[class*="single-value"]');
          // First pick: create it where react-select renders it, inside the container.
          if (!shown) { shown = document.createElement('span'); shown.className = 'x-single-value'; document.querySelector('.x-container').prepend(shown); }
          // react-select shows the chosen option's label.
          shown.textContent = opt.textContent;
        });
      });
    </script>`;
}

// Which option text the fake recorded as clicked; undefined proves nothing was clicked.
const clicked = () => page.evaluate(() => document.body.dataset.clicked);

describe('fill() on a react-select picks the same-text option via matchOption', () => {
  test('"india" picks "India" (the live bank shape vs the Canonical country option), not Indiana/Indonesia', async () => {
    // India's real look-alikes from the Canonical country list sit around it.
    await page.setContent(selectHtml(['Indiana', 'India', 'Indonesia', 'British Indian Ocean Territory']));
    // The live answer_bank stores lowercase "india".
    await createPlaywrightPage(page).fill('q', 'india');
    // The form's own option was clicked, and the readback accepted it.
    expect(await clicked()).toBe('India');
  });

  test('"yes" picks "Yes" (the in-person question every Canonical row parked on)', async () => {
    // The real two-option list.
    await page.setContent(selectHtml(['Yes', 'No']));
    // The live bank's lowercase answer.
    await createPlaywrightPage(page).fill('q', 'yes');
    // The form's own text was clicked.
    expect(await clicked()).toBe('Yes');
  });

  test('an exact option still wins over a normalized twin', async () => {
    // Two options that normalize alike; the answer is exactly one of them.
    await page.setContent(selectHtml(['India', 'india']));
    // Exact text first, as before this change.
    await createPlaywrightPage(page).fill('q', 'India');
    // The exact row, never its twin.
    expect(await clicked()).toBe('India');
  });

  test('"male" vs Man/Woman parks: a different word is not a normalization', async () => {
    // The options word the statement differently; only Teja may pick.
    await page.setContent(selectHtml(['Man', 'Woman', 'Prefer not to say']));
    // Must refuse with the shared prefix, so the row lands as a form gap for a human.
    const error = await rejection(createPlaywrightPage(page).fill('q', 'male'));
    // The shared no-match message.
    expect(error.message).toMatch(/^no_matching_option: q: /);
    // Non-vacuity: refused before any click, so no answer nobody chose was selected.
    expect(await clicked()).toBeUndefined();
  });

  test('two options normalizing to the same text park as ambiguous, and nothing is clicked', async () => {
    // Neither is exactly "US"; both normalize to "us".
    await page.setContent(selectHtml(['U.S.', 'u.s', 'Canada']));
    // Which one Teja meant is unknowable.
    const error = await rejection(createPlaywrightPage(page).fill('q', 'US'));
    // Same park as a no-match.
    expect(error.message).toMatch(/^no_matching_option: q: /);
    // Nothing selected.
    expect(await clicked()).toBeUndefined();
  });

  test('"Yes" never picks "Yes, I require sponsorship" (no prefix or contains match)', async () => {
    // The only Yes-like row is a longer statement.
    await page.setContent(selectHtml(['Yes, I require sponsorship', 'No']));
    // Must refuse.
    const error = await rejection(createPlaywrightPage(page).fill('q', 'Yes'));
    // Same park.
    expect(error.message).toMatch(/^no_matching_option: q: /);
    // Nothing clicked.
    expect(await clicked()).toBeUndefined();
  });
});

// A radio group shaped like Greenhouse's: a fieldset (the field id) with one labelled radio per option.
function radioHtml(options: string[]): string {
  // One named radio per option, each wrapped by its <label> (the extractor's second label rule).
  const rows = options.map((text, i) => `<label><input type="radio" name="g" id="g${i}" value="${i}" />${text}</label>`).join('');
  // The fieldset carries the id the planner addresses.
  return `<fieldset id="r"><legend>Q</legend>${rows}</fieldset>`;
}

// The label of the checked radio, or null when none is checked.
const checkedLabel = () =>
  // Runs in the page: the checked radio's wrapping label text.
  page.evaluate(() => document.querySelector<HTMLInputElement>('input[type="radio"]:checked')?.closest('label')?.textContent ?? null);

describe('fill() on a radio group uses the same matchOption rule', () => {
  test('"yes" checks the "Yes" radio', async () => {
    // The real two-option shape.
    await page.setContent(radioHtml(['Yes', 'No']));
    // The live bank's lowercase answer, addressed by the fieldset id.
    await createPlaywrightPage(page).fill('r', 'yes');
    // The form's own option is checked.
    expect(await checkedLabel()).toBe('Yes');
    // No position tag is left behind.
    expect(await page.locator('[data-applyyy-pick]').count()).toBe(0);
  });

  test('"male" vs Man/Woman parks and checks nothing', async () => {
    // A different word is not a normalization.
    await page.setContent(radioHtml(['Man', 'Woman']));
    // Refused with the shared prefix.
    const error = await rejection(createPlaywrightPage(page).fill('r', 'male'));
    // Same park as every choice control.
    expect(error.message).toMatch(/^no_matching_option: r: /);
    // Non-vacuity: nothing was checked.
    expect(await checkedLabel()).toBeNull();
    // And no position tag is left behind on the refusal path.
    expect(await page.locator('[data-applyyy-pick]').count()).toBe(0);
  });

  test('two labels folding alike park as ambiguous', async () => {
    // Neither is exactly "US"; both fold to "us".
    await page.setContent(radioHtml(['U.S.', 'u.s', 'Canada']));
    // Which one Teja meant is unknowable.
    const error = await rejection(createPlaywrightPage(page).fill('r', 'US'));
    // Same park.
    expect(error.message).toMatch(/^no_matching_option: r: /);
    // Nothing checked.
    expect(await checkedLabel()).toBeNull();
  });
});
