/* Settings → Search Preferences: the "Remote jobs" choice (Teja, 2026-11-04).
 *
 * Teja asked for the new remote rule to live in Settings, in its section ("Where You Would Work").
 * Rendered, not grepped: the page is drawn by react-dom/server through the same transpile hook the
 * other .tsx tests use. No effect runs in a static render, so this pins the FIRST paint: the
 * control exists, offers exactly the two column literals, and starts on the column default. The
 * save payload is pinned by a source check, since saving needs a live client. */

// The .tsx loader; must be the first import so it runs before any component loads.
import './support/registerTsxHooks.ts';
// Strict assertions.
import assert from 'node:assert/strict';
// The node runner.
import { describe, it, before } from 'node:test';
// The page source, for the one assertion a static render cannot reach (the save payload).
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

describe('Search Preferences: Remote jobs choice (2026-11-04)', () => {
  it('renders a "Remote jobs" select in the page', () => {
    // The whole page, first paint.
    const html = render(h(page.SearchPreferencesPage as never));
    // The label Teja reads.
    assert.match(html, /<span class="field__label">Remote jobs<\/span>/);
  });

  it('offers exactly the two column literals, the 11-04 default selected first', () => {
    // The whole page, first paint.
    const html = render(h(page.SearchPreferencesPage as never));
    // The select that carries the remote options, isolated so other selects (currency) do not count.
    const select = html.match(/<select[^>]*>(?:(?!<\/select>).)*unlocked_or_authorized(?:(?!<\/select>).)*<\/select>/s)?.[0] ?? '';
    // Every option value in it, in order.
    const values = [...select.matchAll(/<option value="([^"]+)"/g)].map((m) => m[1]);
    // Exactly the CHECK constraint's literals.
    assert.deepEqual(values, ['unlocked_or_authorized', 'any']);
    // The default is the one react marks selected on first paint.
    assert.match(select, /<option value="unlocked_or_authorized" selected="">/);
  });

  it('the save payload carries remote_location_policy', () => {
    // The source of the page.
    const source = readFileSync(new URL('../src/features/settings/SearchPreferencesPage.tsx', import.meta.url), 'utf8');
    // The payload key, set from the select's state.
    assert.match(source, /remote_location_policy: remotePolicy,/);
  });

  it('the work-auth help text no longer claims every remote job is kept', () => {
    // The whole page, first paint.
    const html = render(h(page.SearchPreferencesPage as never));
    // The 10-24 sentence is gone.
    assert.doesNotMatch(html, /remote jobs are kept/);
  });
});
