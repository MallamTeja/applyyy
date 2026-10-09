// Pins how createPlaywrightPage().fill() picks an option in a phone COUNTRY DIAL-CODE picker.
// Real-world source: the GitLab Greenhouse form's "Country" control (id "country",
// role="combobox", no aria-controls/aria-owns) is the phone dial-code picker. Greenhouse's
// live bundle renders each option label from the template `${countryName} +${dialCode}`, so
// the rows read exactly "India +91", "United States +1", "Indonesia +62". After a pick the
// widget shows ONLY the "+91" suffix. The planner fills the plain value "India", so a strict
// exact-text rule finds nothing, and a readback check that wants "India +91" never passes.
// The rule under test therefore accepts `${wanted} +<1-4 digits>` and nothing else, ANCHORED
// at both ends. Anchoring is the whole point: a prefix or substring match would pick
// "Indiana +1" or "British Indian Ocean Territory +246" for "India", and submit a wrong phone
// country in Teja's name. Ambiguity (2+ candidates) and readback drift both fail closed.
// Runs on page.setContent only: nothing leaves this process, no live site is touched.
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
// Real Chromium, because the click/readback semantics are the thing under test.
import { chromium, type Browser, type Page } from 'playwright';
// The port under test.
import { createPlaywrightPage } from '../src/playwright-page.ts';

// One Chromium launch for the whole file keeps it fast (Actions minutes are budgeted).
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
// Same helper shape as option-not-found-empty.test.ts, so both files read alike.
async function rejection(p: Promise<unknown>): Promise<Error> {
  try {
    // A resolve here means fill() picked something it should have refused.
    await p;
  } catch (error) {
    // Non-Error throws would make the message assertions meaningless, so refuse them loudly.
    if (!(error instanceof Error)) throw new Error(`rejected with a non-Error: ${String(error)}`);
    // The caught error, for the caller's message checks.
    return error;
  }
  // Reached only when the promise resolved, which every caller treats as a failure.
  throw new Error('expected fill() to reject, but it resolved');
}

// A lookalike of Greenhouse's dial picker, modelled on comboboxHtml in
// option-not-found-empty.test.ts but with NO aria-controls: like the real control, the
// options live inside the widget container, so the filler must scope to the widget subtree.
// `readback` is what the widget shows after any option click; null means the real
// behaviour, the clicked option's trailing "+NN" (or its full text when it has none).
function dialPickerHtml(options: string[], readback: string | null = null): string {
  // Option rows from plain text; the test strings contain no markup characters.
  const rows = options.map((text) => `<div role="option">${text}</div>`).join('');
  // JSON-encoded so the in-page script gets a real string or null, never broken quoting.
  const forced = JSON.stringify(readback);
  // One widget per page, so the filler's ancestor climb can never swallow a sibling widget.
  return `
    <div class="x-container">
      <div class="x-placeholder">Select...</div>
      <input id="country" role="combobox" />
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
          // The real widget shows only the dial suffix; a forced value lets a test make it lie.
          const suffix = opt.textContent.match(/\\+\\d+$/);
          // Forced readback wins; otherwise the suffix, or full text for a non-dial row.
          shown.textContent = ${forced} ?? (suffix ? suffix[0] : opt.textContent);
        });
      });
    </script>`;
}

// Which option text the fake recorded as clicked; undefined proves nothing was clicked.
const clicked = () => page.evaluate(() => document.body.dataset.clicked);
// What the widget displays now; null when no single value was ever rendered.
const shown = () => page.evaluate(() => document.querySelector('[class*="single-value"]')?.textContent ?? null);

describe('fill() on a Greenhouse phone-country dial picker', () => {
  test('Country picks the India +91 option from the real option list', async () => {
    // The real label shape, with India's look-alikes around it, in Greenhouse's alphabetical spirit.
    await page.setContent(
      dialPickerHtml(['United States +1', 'Afghanistan +93', 'British Indian Ocean Territory +246', 'India +91', 'Indonesia +62']),
    );
    // The planner's value is the bare country name; this must resolve via the dial rule.
    await createPlaywrightPage(page).fill('country', 'India');
    // The exact India row was clicked, not a look-alike that merely contains "India".
    expect(await clicked()).toBe('India +91');
    // The widget shows only the suffix, which the readback must accept for a dial pick.
    expect(await shown()).toBe('+91');
  });

  test('Indiana / British Indian Ocean Territory never match India', async () => {
    // ONE impostor per menu (beside a harmless Indonesia row). Both in one menu would make a
    // loosened rule find TWO candidates and park anyway, hiding the bug behind the ambiguity rule.
    for (const impostor of ['Indiana +1', 'British Indian Ocean Territory +246']) {
      // A menu where the impostor is the ONLY row a substring or prefix rule could take.
      await page.setContent(dialPickerHtml([impostor, 'Indonesia +62']));
      // A prefix or substring rule would pick the impostor; the anchored rule must refuse.
      const error = await rejection(createPlaywrightPage(page).fill('country', 'India'));
      // The shared no-match prefix, so the row lands as a form gap for a human.
      expect(error.message).toMatch(/^no_matching_option: country: /);
      // Non-vacuity: refused before any click, so no wrong country was ever selected.
      expect(await clicked()).toBeUndefined();
    }
  });

  test('two qualifying options → no_matching_option', async () => {
    // "India" qualifies by exact text and "India +91" by the dial rule: two candidates.
    // (Two identical rows would also be 2+, but would not tell "first wins" from "refuse".)
    await page.setContent(dialPickerHtml(['India +91', 'India']));
    // Ambiguity must fail closed rather than take the first or the exact one.
    const error = await rejection(createPlaywrightPage(page).fill('country', 'India'));
    // Same prefix as every no-match.
    expect(error.message).toMatch(/^no_matching_option: country: /);
    // Non-vacuity: nothing was clicked, so this was the 2+-candidates branch, not readback.
    expect(await clicked()).toBeUndefined();
  });

  test('a dial-picked option whose readback shows a different code is rejected', async () => {
    // Clicking India +91 makes the box show "+1": a misrouted click or a stale value.
    await page.setContent(dialPickerHtml(['United States +1', 'India +91'], '+1'));
    // The pick itself is legal; only the readback is wrong.
    const error = await rejection(createPlaywrightPage(page).fill('country', 'India'));
    // Non-vacuity: the India row really was clicked, so the refusal came from readback.
    // Without this, the pre-change code (no dial rule, no click) would pass for the wrong reason.
    expect(await clicked()).toBe('India +91');
    // Readback drift is a plain no-match, so a human sees the row.
    expect(error.message).toMatch(/^no_matching_option: country: /);
  });

  test('a swallowed click over a default with the same dial code is rejected', async () => {
    // Dial codes are shared: US and Canada are both +1. The box already shows a US default.
    await page.setContent(dialPickerHtml(['United States +1', 'Canada +1']));
    // Arrange the trap in the page: a "+1" default shown, and option clicks that do nothing.
    await page.evaluate(() => {
      // cloneNode drops the listeners, so every click is swallowed like a lost re-render click.
      document.querySelectorAll('[role="option"]').forEach((opt) => opt.replaceWith(opt.cloneNode(true)));
      // A chosen value replaces the placeholder, as in react-select.
      document.querySelector('.x-placeholder')?.remove();
      // The pre-existing US default, displayed as its dial code alone.
      const value = document.createElement('span');
      // The class the filler reads the displayed value from.
      value.className = 'x-single-value';
      // "+1": identical to what a successful Canada pick would show.
      value.textContent = '+1';
      // Inside the widget, where the filler looks.
      document.querySelector('.x-container')?.prepend(value);
    });
    // Canada is wanted; the click lands on nothing and the box still says "+1".
    const error = await rejection(createPlaywrightPage(page).fill('country', 'Canada'));
    // An unchanged "+1" cannot prove Canada was chosen, so the row parks.
    expect(error.message).toMatch(/^no_matching_option: country: /);
    // Non-vacuity: the click really was swallowed, the default is untouched.
    expect(await clicked()).toBeUndefined();
    // And the box still shows the US default's code.
    expect(await shown()).toBe('+1');
  });

  test('a non-dial suffix never qualifies', async () => {
    // Trailing text, no space before "+", and 5 digits: each breaks the anchored shape. ONE per
    // menu, so a loosened rule meets a single candidate and clicks it, instead of parking on 2+.
    for (const malformed of ['India +91 (mobile)', 'India+91', 'India +12345']) {
      // The malformed row is the only India-like row in its menu.
      await page.setContent(dialPickerHtml([malformed, 'Indonesia +62']));
      // Not `India +<1-4 digits>` exactly, and not exact "India": refused.
      const error = await rejection(createPlaywrightPage(page).fill('country', 'India'));
      // Same prefix as every no-match.
      expect(error.message).toMatch(/^no_matching_option: country: /);
      // Non-vacuity: nothing was clicked, so the shape rule itself refused the row.
      expect(await clicked()).toBeUndefined();
    }
  });

  test('an exact-text option still reads back its full text', async () => {
    // A plain yes/no combobox: exact-text picks, readback shows the full text.
    await page.setContent(dialPickerHtml(['Yes', 'No'], 'Yes'));
    // Exact match plus full-text readback: the pre-existing path must still resolve.
    await createPlaywrightPage(page).fill('country', 'Yes');
    // Non-vacuity: the Yes row really was clicked.
    expect(await clicked()).toBe('Yes');

    // Same widget, but the box shows "+1" after the exact pick.
    await page.setContent(dialPickerHtml(['Yes', 'No'], '+1'));
    // The suffix allowance belongs to dial picks only; an exact pick must show its full text.
    const error = await rejection(createPlaywrightPage(page).fill('country', 'Yes'));
    // Non-vacuity: the click landed, so this was the readback branch.
    expect(await clicked()).toBe('Yes');
    // Readback drift stays a plain no-match.
    expect(error.message).toMatch(/^no_matching_option: country: /);
  });
});
