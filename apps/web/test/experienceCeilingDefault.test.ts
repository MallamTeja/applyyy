/* The experience ceiling's built-in value is 1 year, in BOTH places the Filters page can write it
 * (Teja, 2026-11-04 20:35 IST: "Change the Early Career SDE preset + filtersStore default max_years
 * 2 -> 1").
 *
 * WHY. Teja's ruling (2026-11-01, confirmed 11-04) drops a hard requirement above 1 year, and
 * migration 20261104193000 set the live config to 1. The page's built-in default and its "Early
 * Career SDE" preset both wrote 2, so one click on the preset would have let every "2+ years" job
 * back in. Both now read ONE constant, so they cannot drift apart again. */

// The .tsx loader; must be the first import so the page module can be read by the source check.
import './support/registerTsxHooks.ts';
// Strict assertions.
import assert from 'node:assert/strict';
// The node runner.
import { describe, it } from 'node:test';
// The page source, for the preset (a closure inside the component, unreachable without a DOM).
import { readFileSync } from 'node:fs';
// The store's defaults and the shared constant.
import { DEFAULT_FILTER_RULES, EARLY_CAREER_MAX_YEARS } from '../src/features/settings/filtersStore.ts';

describe('experience ceiling: one built-in value, 1 year (2026-11-04)', () => {
  it('the shared constant is 1', () => {
    // Teja's ruling, as a number.
    assert.equal(EARLY_CAREER_MAX_YEARS, 1);
  });

  it("filtersStore's built-in experience_ceiling default writes max_years 1", () => {
    // The default rule the page falls back to when nothing is stored.
    const rule = DEFAULT_FILTER_RULES.find((r) => r.ruleType === 'experience_ceiling');
    // Exactly the ruling.
    assert.equal(rule?.config.max_years, 1);
  });

  it('the "Early Career SDE" preset writes the shared constant, never a literal', () => {
    // The page source.
    const source = readFileSync(new URL('../src/features/settings/FiltersPage.tsx', import.meta.url), 'utf8');
    // The preset's experience branch uses the constant (positive shape, CLAUDE.md section 6).
    assert.match(source, /config: \{ max_years: EARLY_CAREER_MAX_YEARS \}/);
    // And no literal year count is written anywhere on the page.
    assert.doesNotMatch(source, /max_years: \d/);
  });
});
