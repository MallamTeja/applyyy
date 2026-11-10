/* The Filters page must not render the two retired rules (Teja, 2026-11-10 11:31 IST): the
 * per-company weekly cap and job age (staleness). The enum keys stay in FILTER_RULE_TYPES because
 * Postgres cannot drop an enum value, and a type without copy still renders a fallback row, so
 * deleting the copy alone would leave a bare "staleness" toggle on the page. */

// The .tsx loader; must be the first import so it runs before any component loads.
import './support/registerTsxHooks.ts';
import assert from 'node:assert/strict';
import { describe, it, before } from 'node:test';

// The page module, loaded after the hooks are in place.
let page: typeof import('../src/features/settings/FiltersPage.tsx');

before(async () => {
  // Transpiled by the hook.
  page = await import('../src/features/settings/FiltersPage.tsx');
});

// The two rule types that must never get a row.
const RETIRED = ['staleness', 'per_company_weekly_cap'];

describe('Filters page: retired rules get no row (2026-11-10)', () => {
  it('the list the cascade maps over excludes staleness and per_company_weekly_cap', () => {
    // The exact array the <ol> renders from.
    assert.deepEqual(page.CASCADE_RULE_TYPES.filter((t) => RETIRED.includes(t)), []);
    // Still non-empty, so the exclusion check above cannot pass on an empty list.
    assert.ok(page.CASCADE_RULE_TYPES.includes('experience_ceiling'));
  });

  it('RULE_COPY no longer carries copy for either retired rule', () => {
    // No stale wording left to render if a row ever came back.
    assert.deepEqual(Object.keys(page.RULE_COPY).filter((t) => RETIRED.includes(t)), []);
  });
});
