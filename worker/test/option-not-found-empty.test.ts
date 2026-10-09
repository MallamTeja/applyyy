// Pins WHICH error class createPlaywrightPage().fill() throws when no option matches.
// Why it matters: OptionNotFoundError is the one failure the caller may degrade to "left
// blank" and then submit. A blank-skip submits whatever the control already holds, so only a
// control that was PROVABLY EMPTY (no pre-selected option, no shown react-select value, no
// checked radio) may earn the class. Every other no-match, and every combobox readback
// mismatch, must stay a plain Error so the row goes to a human instead of submitting an
// answer nobody chose. Each case below pins one branch of that emptiness rule.
// Runs on page.setContent only: nothing leaves this process, no live site is touched.
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
// Real Chromium, because selectOption/check/click semantics are the thing under test.
import { chromium, type Browser, type Page } from 'playwright';
// The port under test.
import { createPlaywrightPage } from '../src/playwright-page.ts';
// The class whose presence or absence each test asserts.
import { OptionNotFoundError } from '../src/apply-one.ts';

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

// Awaits a promise that MUST reject and hands back the error, so a test can inspect its class.
// expect().rejects only checks the message; instanceof needs the error object itself.
async function rejection(p: Promise<unknown>): Promise<Error> {
  try {
    // A resolve here means fill() silently "succeeded" on an absent option: that is the bug.
    await p;
  } catch (error) {
    // Non-Error throws would make the instanceof assertions meaningless, so refuse them loudly.
    if (!(error instanceof Error)) throw new Error(`rejected with a non-Error: ${String(error)}`);
    // The caught error, for the caller's class and message checks.
    return error;
  }
  // Reached only when the promise resolved, which every test here treats as a failure.
  throw new Error('expected fill() to reject, but it resolved');
}

// A minimal react-select lookalike: role="combobox" input, aria-controls listbox of
// role="option" rows, and a "*-single-value" element the filler reads as the shown value.
// `shown` seeds the displayed value; `options` are the menu rows; `onPick` is the JS body
// run on an option click (gets `opt` and `shown`), so a test can make the readback lie.
// `extra` is raw markup added inside the widget (a hidden input, multi-value chips) so a
// test can hide a held value where the single-value reader cannot see it.
function comboboxHtml(shown: string, options: string[], onPick: string, extra = ''): string {
  // Option rows built from plain text; the test strings contain no markup characters.
  const rows = options.map((text) => `<div role="option">${text}</div>`).join('');
  // Like react-select: a single-value span when a value is shown, else the placeholder.
  const value = shown ? `<span class="x-single-value" id="shown">${shown}</span>` : '<div class="x-placeholder">Select...</div>';
  // One widget per page, so the filler's ancestor climb can never swallow a sibling widget.
  return `
    <div class="x-container">
      ${value}
      ${extra}
      <input id="c" role="combobox" aria-controls="c-list" />
      <div id="c-list" role="listbox">${rows}</div>
    </div>
    <script>
      // Every option click records which text was clicked, so tests can prove the click landed.
      document.querySelectorAll('[role="option"]').forEach((opt) => {
        // Delegated handler body comes from the test, so each case controls the readback.
        opt.addEventListener('click', () => {
          // Witness of the click for the non-vacuity assertions.
          document.body.dataset.clicked = opt.textContent;
          // Looked up at click time so a test that seeds no value can still create one.
          let shown = document.querySelector('[class*="single-value"]');
          ${onPick}
        });
      });
    </script>`;
}

describe('fill() no-match error class depends on provable emptiness', () => {
  test("a native select with a pre-selected 'Male' and an absent wanted value rejects with a plain Error, not OptionNotFoundError", async () => {
    // A pre-selected default: a blank-skip here would submit "Male" in Teja's name.
    await page.setContent('<select id="g"><option>Female</option><option selected>Male</option></select>');
    // The wanted answer is absent from the list.
    const error = await rejection(createPlaywrightPage(page).fill('g', 'Decline to self-identify'));
    // Same message prefix as every no-match, so message-matching callers still see a form gap.
    expect(error.message).toMatch(/^no_matching_option: g: /);
    // The point of the test: the control holds a value, so the class must NOT be claimed.
    expect(error).not.toBeInstanceOf(OptionNotFoundError);
    // Non-vacuity: the control really still holds "Male" (option value defaults to its text).
    expect(await page.locator('#g').inputValue()).toBe('Male');
  });

  test('an empty native select with an absent value rejects with OptionNotFoundError', async () => {
    // The placeholder with value "" is the empty state on real ATS forms.
    await page.setContent(
      '<select id="g"><option value="" selected>Select...</option><option>Female</option><option>Male</option></select>',
    );
    // Absent value against a provably empty control.
    const error = await rejection(createPlaywrightPage(page).fill('g', 'Decline to self-identify'));
    // Empty control, nothing chosen: the one case that may degrade to "left blank".
    expect(error).toBeInstanceOf(OptionNotFoundError);
    // The prefix is kept so older message-matching callers are unaffected.
    expect(error.message).toMatch(/^no_matching_option: g: /);
    // Non-vacuity: still on the placeholder, so the "empty" premise held to the end.
    expect(await page.locator('#g').inputValue()).toBe('');
  });

  test('a disabled selected placeholder counts as empty', async () => {
    // Disabled placeholder with a NON-empty value: only the disabled rule can call it empty.
    await page.setContent(
      '<select id="g"><option value="none" disabled selected>Choose one</option><option>Female</option></select>',
    );
    // Absent value, so the no-match branch is the one exercised.
    const error = await rejection(createPlaywrightPage(page).fill('g', 'Decline to self-identify'));
    // A disabled placeholder cannot be submitted as an answer, so the control counts as empty.
    expect(error).toBeInstanceOf(OptionNotFoundError);
    // Same message shape as every other no-match.
    expect(error.message).toMatch(/^no_matching_option: g: /);
  });

  test('a combobox readback mismatch stays a plain Error', async () => {
    // Wanted option IS in the menu; clicking it shows "Female" instead. Seeded EMPTY, so an
    // implementation that applied the empty-check to readback would wrongly claim the class.
    await page.setContent(
      comboboxHtml(
        '',
        ['Male', 'Decline to self-identify'],
        // Creates the single-value with the WRONG text, like a swallowed or misrouted click.
        `if (!shown) { shown = document.createElement('span'); shown.className = 'x-single-value'; document.querySelector('.x-container').prepend(shown); } shown.textContent = 'Female';`,
      ),
    );
    // Non-vacuity, part 1: the wanted option really is a menu row before the fill.
    expect(await page.locator('[role="option"]', { hasText: 'Decline to self-identify' }).count()).toBe(1);
    // The fill finds the exact option, clicks it, then reads back the wrong value.
    const error = await rejection(createPlaywrightPage(page).fill('c', 'Decline to self-identify'));
    // Non-vacuity, part 2: the exact wanted option really was clicked (not a no-match path).
    expect(await page.evaluate(() => document.body.dataset.clicked)).toBe('Decline to self-identify');
    // The widget now shows an answer nobody chose; this must never degrade to "left blank".
    expect(error).not.toBeInstanceOf(OptionNotFoundError);
    // Still the shared no-match prefix, so it lands as a form gap for a human.
    expect(error.message).toMatch(/^no_matching_option: c: /);
  });

  test('a combobox already showing a value, with no matching option, rejects with a plain Error', async () => {
    // An earlier value "Male" is shown; the wanted text is not in the menu.
    await page.setContent(comboboxHtml('Male', ['Male', 'Female'], ''));
    // No exact row exists, so the filler takes the no-match path.
    const error = await rejection(createPlaywrightPage(page).fill('c', 'Decline to self-identify'));
    // The widget holds "Male"; a blank-skip would submit it, so no class.
    expect(error).not.toBeInstanceOf(OptionNotFoundError);
    // Same prefix as every no-match.
    expect(error.message).toMatch(/^no_matching_option: c: /);
    // Non-vacuity: no option was clicked, so this was the no-match branch, not readback.
    expect(await page.evaluate(() => document.body.dataset.clicked)).toBeUndefined();
  });

  test('an empty combobox with no matching option rejects with OptionNotFoundError', async () => {
    // Placeholder shown, no value anywhere: the positive shape of an empty react-select.
    await page.setContent(comboboxHtml('', ['Male', 'Female'], ''));
    // Wanted text absent from the menu.
    const error = await rejection(createPlaywrightPage(page).fill('c', 'Decline to self-identify'));
    // Empty widget, nothing chosen: the class is earned.
    expect(error).toBeInstanceOf(OptionNotFoundError);
    // Prefix kept for message-matching callers.
    expect(error.message).toMatch(/^no_matching_option: c: /);
    // Non-vacuity: nothing was clicked, so the widget stayed empty throughout.
    expect(await page.evaluate(() => document.body.dataset.clicked)).toBeUndefined();
  });

  test('a radio group with one member checked and no matching label rejects with a plain Error', async () => {
    // "No" is pre-checked: the group already holds an answer a blank-skip would submit.
    await page.setContent(`
      <fieldset id="r">
        <label><input type="radio" name="r" value="y" />Yes</label>
        <label><input type="radio" name="r" value="n" checked />No</label>
      </fieldset>`);
    // "Maybe" matches no label.
    const error = await rejection(createPlaywrightPage(page).fill('r', 'Maybe'));
    // A checked member means a value is held, so no class.
    expect(error).not.toBeInstanceOf(OptionNotFoundError);
    // Same prefix as every no-match.
    expect(error.message).toMatch(/^no_matching_option: r: /);
    // Non-vacuity: "No" is still the checked answer.
    expect(await page.locator('input[value="n"]').isChecked()).toBe(true);
  });

  test('a radio group with none checked and no matching label rejects with OptionNotFoundError', async () => {
    // Nothing checked: the group provably holds no answer.
    await page.setContent(`
      <fieldset id="r">
        <label><input type="radio" name="r" value="y" />Yes</label>
        <label><input type="radio" name="r" value="n" />No</label>
      </fieldset>`);
    // "Maybe" matches no label.
    const error = await rejection(createPlaywrightPage(page).fill('r', 'Maybe'));
    // Empty group, nothing chosen: the class is earned.
    expect(error).toBeInstanceOf(OptionNotFoundError);
    // Prefix kept for message-matching callers.
    expect(error.message).toMatch(/^no_matching_option: r: /);
    // Non-vacuity: still nothing checked after the failed fill.
    expect(await page.locator('input[type="radio"]:checked').count()).toBe(0);
  });

  // REVIEW FINDINGS: each case below is a value held where a lenient "empty" read cannot
  // see it. A missing value element must never be mistaken for an empty control.

  test('a combobox whose named hidden input holds a value rejects with a plain Error', async () => {
    // react-select with `name` submits this hidden input; the placeholder alone proves nothing.
    await page.setContent(comboboxHtml('', ['Male', 'Female'], '', '<input type="hidden" name="gender" value="Male" />'));
    // Wanted text absent from the menu.
    const error = await rejection(createPlaywrightPage(page).fill('c', 'Decline to self-identify'));
    // A held submitted value means no class.
    expect(error).not.toBeInstanceOf(OptionNotFoundError);
    // Non-vacuity: the hidden value is still there to be submitted.
    expect(await page.locator('input[type="hidden"]').inputValue()).toBe('Male');
  });

  test('a multi-value combobox with a chip rejects with a plain Error', async () => {
    // isMulti renders chips as `*-multi-value`, which the single-value reader never sees.
    await page.setContent(comboboxHtml('', ['Male', 'Female'], '', '<div class="x-multi-value">Male</div>'));
    // Wanted text absent from the menu.
    const error = await rejection(createPlaywrightPage(page).fill('c', 'Decline to self-identify'));
    // A chip is a held answer, so no class.
    expect(error).not.toBeInstanceOf(OptionNotFoundError);
    // Non-vacuity: nothing was clicked, so this was the no-match branch.
    expect(await page.evaluate(() => document.body.dataset.clicked)).toBeUndefined();
  });

  test('a combobox with no recognisable placeholder rejects with a plain Error', async () => {
    // An unrecognised widget shape: no single-value AND no placeholder. Unknown is not empty.
    await page.setContent(comboboxHtml('', ['Male', 'Female'], '').replace('<div class="x-placeholder">Select...</div>', ''));
    // Wanted text absent from the menu.
    const error = await rejection(createPlaywrightPage(page).fill('c', 'Decline to self-identify'));
    // Shape not proven empty, so no class.
    expect(error).not.toBeInstanceOf(OptionNotFoundError);
    // Non-vacuity: the placeholder really is gone, so only the shape rule can refuse.
    expect(await page.locator('[class*="placeholder"]').count()).toBe(0);
  });

  test('a plain ARIA combobox whose own input holds text rejects with a plain Error', async () => {
    // A non-react-select combobox keeps its answer in the input's value, beside a placeholder div.
    await page.setContent(comboboxHtml('', ['Male', 'Female'], '').replace('<input id="c"', '<input id="c" value="Male"'));
    // Wanted text absent from the menu.
    const error = await rejection(createPlaywrightPage(page).fill('c', 'Decline to self-identify'));
    // Text held before the fill, so no class.
    expect(error).not.toBeInstanceOf(OptionNotFoundError);
    // Non-vacuity: nothing was clicked, so this was the no-match branch.
    expect(await page.evaluate(() => document.body.dataset.clicked)).toBeUndefined();
  });

  test('a lone unnamed checked radio outside any group rejects with a plain Error', async () => {
    // No name and no fieldset: group resolution finds ZERO members, which must not read as empty.
    await page.setContent('<label><input type="radio" id="solo" checked />Yes</label>');
    // "No" matches nothing.
    const error = await rejection(createPlaywrightPage(page).fill('solo', 'No'));
    // The radio is checked, so a skip would submit it: no class.
    expect(error).not.toBeInstanceOf(OptionNotFoundError);
    // Non-vacuity: it really is still checked.
    expect(await page.locator('#solo').isChecked()).toBe(true);
  });

  test('a multi-select whose first selected option is a placeholder but another is chosen rejects with a plain Error', async () => {
    // selectedOptions[0] is the empty placeholder, yet "Male" is selected too and would be submitted.
    await page.setContent('<select id="m" multiple><option value="" selected>Select...</option><option selected>Male</option></select>');
    // The wanted answer is absent.
    const error = await rejection(createPlaywrightPage(page).fill('m', 'Decline to self-identify'));
    // Something is selected, so no class.
    expect(error).not.toBeInstanceOf(OptionNotFoundError);
    // Non-vacuity: two options really are selected.
    expect(await page.evaluate(() => (document.getElementById('m') as HTMLSelectElement).selectedOptions.length)).toBe(2);
  });
});
