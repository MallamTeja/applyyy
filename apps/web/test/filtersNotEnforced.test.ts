/* B1 (2026-10-08): the Filters page must SAY that experience_ceiling and degree_mismatch cannot fire.
 *
 * Both rules ship enabled, and the production screener skips each whenever its job field is null
 * (supabase/functions/_shared/filter/cascade.ts:157 and :315), which is every job today. Two
 * enabled rules that never drop anything read as working; the note is the fix, not a logic change.
 *
 * Rendered, not grepped: RuleText is the component the page draws every rule row with, rendered
 * here by react-dom/server through the same transpile hook the other .tsx tests use. */

// The .tsx loader; must be the first import so it runs before any component loads.
import './support/registerTsxHooks.ts';
import assert from 'node:assert/strict';
import { describe, it, before } from 'node:test';

// The page module, loaded after the hooks are in place.
let page: typeof import('../src/features/settings/FiltersPage.tsx');
// Static markup, no DOM.
let render: (element: unknown) => string;
// Element factory, so this .ts file needs no JSX.
let h: typeof import('react').createElement;

before(async () => {
  // Transpiled by the hook.
  page = await import('../src/features/settings/FiltersPage.tsx');
  // From the installed react-dom.
  render = (await import('react-dom/server')).renderToStaticMarkup as (element: unknown) => string;
  // React's factory.
  h = (await import('react')).createElement;
});

// One rule row's text block, exactly as the page draws it.
const row = (ruleType: string) => render(h(page.RuleText as never, { ruleType, copy: page.RULE_COPY[ruleType as never] }));

describe('Filters page: rules that cannot fire say so (B1)', () => {
  it('experience_ceiling renders a "Not enforced" note', () => {
    // A note element, so assistive tech announces it as an aside about the row.
    assert.match(row('experience_ceiling'), /<p class="cascade__drops cascade__not-enforced" role="note">Not enforced: job data doesn(&#x27;|')t include this\.<\/p>/);
  });

  it('degree_mismatch renders the note, and says the Discovered view differs', () => {
    // The rendered row.
    const html = row('degree_mismatch');
    // Same note element and lead sentence.
    assert.match(html, /role="note">Not enforced: job data doesn(&#x27;|')t include this\./);
    // filtersStore's client check reads description text; the note must not hide that.
    assert.match(html, /role="note">[^<]*the screener does not\.<\/p>/);
  });

  it('only those two rules carry the note; a working rule renders none', () => {
    // Every rule whose copy sets notEnforced, so a third cannot be added unremarked.
    const flagged = Object.entries(page.RULE_COPY).filter(([, copy]) => copy?.notEnforced !== undefined).map(([type]) => type).sort();
    // Exactly the two the screener skips on null job data.
    assert.deepEqual(flagged, ['degree_mismatch', 'experience_ceiling']);
    // A rule that does fire: no note element at all.
    assert.doesNotMatch(row('title_blocklist'), /role="note"/);
  });
});
