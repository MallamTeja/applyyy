/* Settings → Search Preferences: "Apply automatically when I approve" and "No daily limit" (P1-6, 2026-11-05).
 *
 * Rendered like searchPreferencesRemotePolicy.test.ts: react-dom/server draws the FIRST paint, where no
 * effect has run, so both controls must start OFF and LOCKED (the real values have not loaded; a
 * placeholder must never be saved over Teja's switch). The read and the save payload are pinned by a
 * source check, since both need a live client. */

// The .tsx loader; must be the first import so it runs before any component loads.
import './support/registerTsxHooks.ts';
// Strict assertions.
import assert from 'node:assert/strict';
// The node runner.
import { before, describe, it } from 'node:test';
// The page source, for the read and the save payload.
import { readFileSync } from 'node:fs';

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

/* The <label> whose field__label is `name`, isolated so another control cannot satisfy an assertion. */
function control(html: string, name: string): string {
  // From the label's opening tag to its close.
  const found = html.match(new RegExp(`<label[^>]*>(?:(?!</label>).)*<span class="field__label">${name}</span>(?:(?!</label>).)*</label>`, 's'))?.[0];
  // Named when missing.
  assert.ok(found !== undefined, `no "${name}" control on the page`);
  // The one control.
  return found;
}

describe('Search Preferences: apply on approve (P1-6)', () => {
  it('renders "Apply automatically when I approve" unchecked and locked on first paint', () => {
    // The whole page, first paint.
    const html = render(h(page.SearchPreferencesPage as never));
    // The control.
    const box = control(html, 'Apply automatically when I approve');
    // A checkbox.
    assert.match(box, /type="checkbox"/);
    // Not checked: off until the real value says otherwise.
    assert.doesNotMatch(box, /checked=""/);
    // Locked until the settings read succeeds.
    assert.match(box, /disabled=""/);
    // The honest expectation is next to the switch (0 of 7 CI live submits landed).
    assert.match(box, /no automatic live submit has\s+landed/);
    // Fix 4 (2026-11-05 review): dispatch-apply drains the WHOLE approved queue, so the copy must say the
    // next approve sends every already-approved job, not only the one just clicked.
    assert.match(box, /next approve sends\s+EVERY job already approved/);
    // And that it goes in batches, so nobody expects 40 submits from one click.
    assert.match(box, /25 per run/);
  });

  it('renders "No daily limit" unchecked (the column default 35 applies) and locked', () => {
    // The whole page, first paint.
    const html = render(h(page.SearchPreferencesPage as never));
    // The control.
    const box = control(html, 'No daily limit');
    // A checkbox, not checked: the first paint shows the default cap.
    assert.match(box, /type="checkbox"/);
    // Unchecked.
    assert.doesNotMatch(box, /checked=""/);
    // Locked.
    assert.match(box, /disabled=""/);
  });

  it('reads and saves auto_apply_on_approve, and a null cap round-trips', () => {
    // The source of the page.
    const source = readFileSync(new URL('../src/features/settings/SearchPreferencesPage.tsx', import.meta.url), 'utf8');
    // Read with the other settings columns.
    assert.match(source, /\.select\('system_enabled, max_applications_per_day, auto_apply_on_approve'\)/);
    // Only a literal true is on.
    assert.match(source, /setAutoApply\(settings\.auto_apply_on_approve === true\)/);
    // A stored null is kept as null ("No daily limit"), not replaced by the default.
    assert.match(source, /settings\.max_applications_per_day === null\) setDailyCap\(settings\.max_applications_per_day\)/);
    // Saved with the other settings columns.
    assert.match(source, /max_applications_per_day: dailyCap, auto_apply_on_approve: autoApply \}/);
  });
});
