/* SmartRecruiters is not ADDABLE (robots ruling 2026-11-01: never seed SR boards), but it stays
 * SELECTABLE: the scout registry still polls existing SR rows, and companyCatalog.test.ts holds
 * SELECTABLE_ATS_PROVIDERS equal to that registry. These tests pin the split:
 *   1. ADDABLE_ATS_PROVIDERS is the exact allowed set (a positive shape, so ANY provider that
 *      creeps back in goes red, not only SR).
 *   2. No curated SR suggestion is addable, and every other selectable one still is.
 *   3. The Watchlist add-board <select> and the suggestions modal consume the addable list
 *      (source shape with asserted anchors, comments stripped; WatchlistPage cannot render
 *      statically here because it imports the live Supabase client).
 *   4. The modal's "Filter by ATS Provider" renders exactly "all" plus the addable providers.
 */

// The shared hook transpiles .tsx and blanks .css imports, so the modal can render in node.
import './support/registerTsxHooks.ts';
// Strict asserts, so a near-miss is never treated as equal.
import assert from 'node:assert/strict';
// node:test, the runner every apps/web test uses; before() loads the .tsx once.
import { before, test } from 'node:test';
// Source-shape checks read the component files as text.
import { readFileSync } from 'node:fs';

// The catalog under test: plain .ts, imported directly.
import {
  ADDABLE_ATS_PROVIDERS,
  CURATED_COMPANIES,
  SELECTABLE_ATS_PROVIDERS,
  isAddableCompany,
} from '../src/features/settings/companyCatalog.ts';

/** A settings component's source, CRLF-normalised, with // and block comments stripped. */
function codeOf(file: string): string {
  // Resolved from this test, so the cwd the runner starts from does not matter.
  const text = readFileSync(new URL(`../src/features/settings/${file}`, import.meta.url), 'utf8');
  // Comments go first, so a note that NAMES the old list can never satisfy or break a check.
  return text.replace(/\r\n/g, '\n').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

// The modal module and react-dom's static renderer, loaded once through the hook.
let modal: typeof import('../src/features/settings/CompanySuggestionsModal.tsx');
// renderToStaticMarkup, typed loosely because the element comes from createElement below.
let render: (element: unknown) => string;
// React's factory, so the test needs no JSX of its own.
let h: typeof import('react').createElement;

before(async () => {
  // Transpiled by the hook.
  modal = await import('../src/features/settings/CompanySuggestionsModal.tsx');
  // From the installed react-dom.
  render = (await import('react-dom/server')).renderToStaticMarkup as (element: unknown) => string;
  // React's factory.
  h = (await import('react')).createElement;
});

test('ADDABLE_ATS_PROVIDERS is exactly greenhouse, lever, ashby, workday (no smartrecruiters)', () => {
  // The exact set, in the order the dropdown shows it.
  assert.deepEqual([...ADDABLE_ATS_PROVIDERS], ['greenhouse', 'lever', 'ashby', 'workday']);
  // And SR is still selectable (polled), so old rows keep rendering and polling.
  assert.ok((SELECTABLE_ATS_PROVIDERS as readonly string[]).includes('smartrecruiters'));
});

test('no curated smartrecruiters suggestion is addable; every other selectable one is', () => {
  // The SR entries; asserted non-empty so the check below cannot pass over nothing.
  const sr = CURATED_COMPANIES.filter((c) => c.atsProvider === 'smartrecruiters');
  // The catalog holds SR boards (7 on 2026-11-05); zero would make this test vacuous.
  assert.ok(sr.length > 0, 'expected curated smartrecruiters entries to exist');
  // None of them may be offered for adding.
  assert.deepEqual(sr.filter(isAddableCompany), []);
  // Every non-SR entry stays addable, so the filter removed only SR.
  const rest = CURATED_COMPANIES.filter((c) => c.atsProvider !== 'smartrecruiters');
  // Same length after the filter means nothing else was cut.
  assert.equal(rest.filter(isAddableCompany).length, rest.length);
});

test('the Watchlist add-board select maps ADDABLE_ATS_PROVIDERS, never SELECTABLE', () => {
  // Comment-free source.
  const code = codeOf('WatchlistPage.tsx');
  // The anchor: the add-board dropdown maps the addable list.
  assert.match(code, /\{ADDABLE_ATS_PROVIDERS\.map\(\(p\) => \(/);
  // The polled list is not used anywhere in this page's code.
  assert.doesNotMatch(code, /SELECTABLE_ATS_PROVIDERS/);
  // The 1-click add refuses a non-addable suggestion even if one reaches it.
  assert.match(code, /if \(!isAddableCompany\(company\)\)/);
});

test('the suggestions modal shows only addable companies', () => {
  // Comment-free source.
  const code = codeOf('CompanySuggestionsModal.tsx');
  // The anchor: the DISPLAYED list (the filterCompanies call keyed on selectedAts) is filtered to
  // addable companies. Pinned to that call, because categoryCounts also filters and a bare
  // `.filter(isAddableCompany)` would stay green if only the display filter were dropped.
  assert.match(code, /atsProvider: selectedAts,\s*\}\)\.filter\(isAddableCompany\)/);
});

test('the modal ATS filter offers exactly "all" plus the addable providers', () => {
  // Open, with no rows: the filter bar renders regardless of the random batch.
  const html = render(h(modal.CompanySuggestionsModal, { isOpen: true, onClose: () => {}, existingRows: [], onAddCompany: async () => true }));
  // The filter <select>, located by its aria-label; asserted found, never assumed.
  const select = /<select[^>]*aria-label="Filter by ATS Provider"[^>]*>([\s\S]*?)<\/select>/.exec(html);
  // A missing select means the markup changed shape; fail red.
  assert.ok(select, 'no "Filter by ATS Provider" select rendered');
  // Every option value, in order.
  const values = [...select[1]!.matchAll(/<option value="([^"]+)"/g)].map((m) => m[1]);
  // The exact set: SR and workable gone, workday present.
  assert.deepEqual(values, ['all', 'greenhouse', 'lever', 'ashby', 'workday']);
});
