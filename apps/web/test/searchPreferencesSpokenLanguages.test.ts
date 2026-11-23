/* Settings → Search Preferences: "Languages I can work in" (2026-11-23, BBHT 5e108a32).
 *
 * The screener's language gate drops a job whose description requires fluency in a language not in
 * search_preferences.spoken_languages. Teja edits that list here, with the same comma-list control as the
 * work-authorized countries. Rendered, not grepped, like searchPreferencesRemotePolicy.test.ts: react-dom/server
 * draws the FIRST paint. The saved payload (empty box -> null) is proven in the built bundle by
 * searchPreferencesSpokenLanguagesE2e.test.ts.
 * RED-ON-REVERT: removing the field fails every test here by name. */

// The .tsx loader; must be the first import so it runs before any component loads.
import './support/registerTsxHooks.ts';
// Strict assertions.
import assert from 'node:assert/strict';
// The node runner.
import { describe, it, before } from 'node:test';

// The page module, loaded after the hooks are in place.
let page: typeof import('../src/features/settings/SearchPreferencesPage.tsx');
// Static markup, no DOM.
let render: (element: unknown) => string;
// Element factory, so this .ts file needs no JSX.
let h: typeof import('react').createElement;

before(async () => {
  // Transpiled by the hook.
  page = await import('../src/features/settings/SearchPreferencesPage.tsx');
  // From the installed react-dom.
  render = (await import('react-dom/server')).renderToStaticMarkup as (element: unknown) => string;
  // React's factory.
  h = (await import('react')).createElement;
});

// The one field's markup: the label element that holds the "Languages I can work in" span.
function languagesField(html: string): string {
  // From the label that opens the field to its close; the field is a <label> like its siblings.
  return html.match(/<label class="field field--wide"><span class="field__label">Languages I can work in<\/span>(?:(?!<\/label>).)*<\/label>/s)?.[0] ?? '';
}

describe('Search Preferences: Languages I can work in (2026-11-23)', () => {
  it('renders the field with the same comma-list text input as the countries', () => {
    // The whole page, first paint.
    const field = languagesField(render(h(page.SearchPreferencesPage as never)));
    // Found at all.
    assert.notEqual(field, '', 'the "Languages I can work in" field is missing');
    // A plain text input with the shared control class, not a new widget.
    assert.match(field, /<input type="text" class="field__control"/);
  });

  it('says in one line that an empty box turns the rule off, so [] is never saved thinking it drops everything', () => {
    // The field's help text.
    const field = languagesField(render(h(page.SearchPreferencesPage as never)));
    // The rule-off sentence, as written.
    assert.match(field, /Leave empty to turn this rule off: nothing is dropped\./);
    // The empty box's placeholder says "not set" first, like the countries box.
    assert.match(field, /placeholder="Not set: rule off\. e\.g\. English, Hindi, Telugu"/);
  });

  it('starts empty before the row loads (an unread row is never "speaks nothing")', () => {
    // The field on first paint.
    const field = languagesField(render(h(page.SearchPreferencesPage as never)));
    // React renders an empty controlled value as value="".
    assert.match(field, /value=""/);
  });

  it('is locked on first paint with one line saying why, until a read proves the column exists (pre-migration safe)', () => {
    // The field on first paint: no row read yet, so the column is unproven.
    const field = languagesField(render(h(page.SearchPreferencesPage as never)));
    // The input is disabled, so nothing is typed that the save would leave out.
    assert.match(field, /<input[^>]*disabled=""/);
    // The one-line reason.
    assert.match(field, /Not available yet: the database update for this setting has not run\. Your other preferences still save\./);
  });
});
