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
  // 2026-11-04: experience_ceiling FIRES now. The screener reads the JD's required years when
  // jobs.min_experience_years is null (_shared/screen/required-experience.ts), after Axiad's
  // "6-8 years" reached manual apply. The note would claim the opposite of what runs.
  it('experience_ceiling renders NO "Not enforced" note now that the screener parses JD years', () => {
    // No note element on the row at all.
    assert.doesNotMatch(row('experience_ceiling'), /role="note"/);
  });

  it('degree_mismatch renders the note, and says the Discovered view differs', () => {
    // The rendered row.
    const html = row('degree_mismatch');
    // Same note element and lead sentence.
    assert.match(html, /role="note">Not enforced: job data doesn(&#x27;|')t include this\./);
    // filtersStore's client check reads description text; the note must not hide that.
    assert.match(html, /role="note">[^<]*the screener does not\.<\/p>/);
  });

  it('only degree_mismatch carries the note; a working rule renders none', () => {
    // Every rule whose copy sets notEnforced, so another cannot be added unremarked.
    const flagged = Object.entries(page.RULE_COPY).filter(([, copy]) => copy?.notEnforced !== undefined).map(([type]) => type).sort();
    // Only the rule the screener still skips on null job data (experience_ceiling fires since 11-04).
    assert.deepEqual(flagged, ['degree_mismatch']);
    // A rule that does fire: no note element at all.
    assert.doesNotMatch(row('title_blocklist'), /role="note"/);
  });
});
