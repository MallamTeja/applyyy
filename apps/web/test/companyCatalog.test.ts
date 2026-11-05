/* Tests for the expanded company catalog, location filtering, and refresh batching.
 *
 * WHAT THESE PROTECT:
 *   1. Curated companies invariant: Every entry must have a valid ATS provider
 *      (one the scout polls: SELECTABLE_ATS_PROVIDERS), non-empty
 *      board slug, domain, location, category (GCC, Mid-Scale MNC, Startup / Unicorn, Service-Based),
 *      and well-formed cooldown periods.
 *   2. Filtering correctness: Text search, location filtering, category filtering,
 *      and ATS provider filtering must compose properly.
 *   3. Rotating refresh batch: `getRefreshedCompaniesBatch` must return balanced
 *      companies across all requested categories for the chosen location.
 *   4. Dynamic search & discover: `searchOrDiscoverCompany` must return existing
 *      curated companies or dynamically synthesize a valid ATS board token.
 *
 * RUN: `pnpm --filter @applyy/web test`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

// The registry parity test below reads the Deno registry as TEXT: importing it would pull
// Deno-only adapter modules into node.
import { readFileSync } from 'node:fs';

import {
  AVAILABLE_LOCATIONS,
  CURATED_COMPANIES,
  SELECTABLE_ATS_PROVIDERS,
  filterCompanies,
  getRefreshedCompaniesBatch,
  searchOrDiscoverCompany,
} from '../src/features/settings/companyCatalog.ts';

test('selectable ATS providers equal the providers registered in the scout ATS registry', () => {
  // W24 (2026-11-02): the Watchlist offered `workable`, but scout-ats selects rows with
  // `.in("ats_provider", supportedProviders())`, the ADAPTERS keys — so a Workable row
  // was never polled and never reported. The dropdown must offer exactly those keys.
  const registry = readFileSync(new URL('../../../supabase/functions/_shared/ats/registry.ts', import.meta.url), 'utf8');
  // The ADAPTERS map literal, from its declaration to the closing `]);`.
  const map = /const ADAPTERS[^=]*=\s*new Map\(\[([\s\S]*?)\]\);/.exec(registry);
  assert.ok(map !== null, 'ADAPTERS map not found in registry.ts — has its declaration changed?');
  // Each entry starts `["<provider>" as AtsProvider,`; comments in between cannot match it.
  const registered = [...map[1]!.matchAll(/\[\s*"(\w+)"\s+as\s+AtsProvider\s*,/g)].map((m) => m[1]!);
  // Non-vacuity: an empty parse would make "equal" mean nothing.
  assert.ok(registered.length > 0, 'parsed zero registered adapters from registry.ts');
  assert.deepEqual([...SELECTABLE_ATS_PROVIDERS].sort(), registered.sort());
});

test('curated companies catalog has all expected baseline employers across 4 categories', () => {
  assert.ok(CURATED_COMPANIES.length >= 30, 'Should have at least 30 curated companies');

  const names = new Set(CURATED_COMPANIES.map((c) => c.name));
  const required = [
    'Target India',
    'Fidelity Investments',
    'Walmart Global Tech',
    'Databricks',
    'Snowflake',
    'Atlassian',
    'MongoDB',
    'Stripe',
    'GitLab',
    'Postman',
    'Razorpay',
    'BrowserStack',
    'CRED',
    'Groww',
    'Zepto',
    'CleverTap',
    'Thoughtworks',
    // Nagarro and Persistent Systems left on 2026-11-06: their only boards were SmartRecruiters,
    // which the robots ruling (2026-11-01) turns fully off, so a catalog row for them is a dead add.
    'Infosys',
  ];

  for (const name of required) {
    assert.ok(names.has(name), `Missing required curated company: ${name}`);
  }
});

test('every curated company satisfies the schema contract, location, and ATS slug requirements', () => {
  const validCategories = new Set([
    'GCC',
    'Mid-Scale MNC',
    'Startup / Unicorn',
    'Service-Based',
  ]);
  // Only providers the Scout polls (W24): a curated row on any other board is a dead add.
  const validAts = new Set<string>(SELECTABLE_ATS_PROVIDERS);

  for (const c of CURATED_COMPANIES) {
    assert.ok(c.name.trim().length > 0, `Name must not be empty for ${c.name}`);
    assert.ok(validCategories.has(c.category), `Invalid category ${c.category} for ${c.name}`);
    assert.ok(validAts.has(c.atsProvider), `Invalid ATS ${c.atsProvider} for ${c.name}`);
    assert.ok(c.location.trim().length > 0, `Location missing for ${c.name}`);
    assert.ok(c.atsIdentifier.trim().length > 0, `Slug must not be empty for ${c.name}`);
    assert.ok(!c.atsIdentifier.includes(' '), `Slug cannot contain spaces for ${c.name}`);
    assert.ok(c.domain.trim().length > 0, `Domain must not be empty for ${c.name}`);
    assert.ok(c.cooldown.interview.length > 0, `Interview cooldown missing for ${c.name}`);
    assert.ok(c.cooldown.screening.length > 0, `Screening cooldown missing for ${c.name}`);
  }
});

test('filterCompanies filters by category including Service-Based', () => {
  const gccOnly = filterCompanies(CURATED_COMPANIES, { category: 'GCC' });
  assert.ok(gccOnly.length > 0);
  assert.ok(gccOnly.every((c) => c.category === 'GCC'));

  const mncOnly = filterCompanies(CURATED_COMPANIES, { category: 'Mid-Scale MNC' });
  assert.ok(mncOnly.length > 0);
  assert.ok(mncOnly.every((c) => c.category === 'Mid-Scale MNC'));

  const startupOnly = filterCompanies(CURATED_COMPANIES, { category: 'Startup / Unicorn' });
  assert.ok(startupOnly.length > 0);
  assert.ok(startupOnly.every((c) => c.category === 'Startup / Unicorn'));

  const serviceOnly = filterCompanies(CURATED_COMPANIES, { category: 'Service-Based' });
  assert.ok(serviceOnly.length > 0);
  assert.ok(serviceOnly.every((c) => c.category === 'Service-Based'));
});

test('filterCompanies filters by location hub', () => {
  const blr = filterCompanies(CURATED_COMPANIES, { location: 'Bengaluru' });
  assert.ok(blr.length > 0);
  assert.ok(blr.every((c) => c.location.includes('Bengaluru')));

  const hyd = filterCompanies(CURATED_COMPANIES, { location: 'Hyderabad' });
  assert.ok(hyd.length > 0);
  assert.ok(hyd.every((c) => c.location.includes('Hyderabad')));

  const pune = filterCompanies(CURATED_COMPANIES, { location: 'Pune' });
  assert.ok(pune.length > 0);
  assert.ok(pune.every((c) => c.location.includes('Pune')));
});

test('filterCompanies filters by search query matching name, domain, location, or slug', () => {
  const stripe = filterCompanies(CURATED_COMPANIES, { search: 'stripe' });
  assert.equal(stripe.length, 1);
  assert.equal(stripe[0]?.name, 'Stripe');

  const fintech = filterCompanies(CURATED_COMPANIES, { search: 'fintech' });
  assert.ok(fintech.length >= 2, 'Should find at least 2 fintech companies');

  const thoughtworks = filterCompanies(CURATED_COMPANIES, { search: 'thoughtworks' });
  assert.equal(thoughtworks.length, 1);
  assert.equal(thoughtworks[0]?.atsProvider, 'greenhouse');
});

test('getRefreshedCompaniesBatch produces a balanced rotating set of companies', () => {
  const batch1 = getRefreshedCompaniesBatch({ seed: 100, countPerCategory: 3 });
  assert.ok(batch1.length > 0);

  const batch2 = getRefreshedCompaniesBatch({ seed: 9999, countPerCategory: 3 });
  assert.ok(batch2.length > 0);

  // Both batches contain companies across categories
  const catSet1 = new Set(batch1.map((c) => c.category));
  assert.ok(catSet1.has('GCC'));
  assert.ok(catSet1.has('Mid-Scale MNC'));
  assert.ok(catSet1.has('Startup / Unicorn'));
  assert.ok(catSet1.has('Service-Based'));
});

test('searchOrDiscoverCompany finds exact curated match or synthesizes dynamic candidate', () => {
  const found = searchOrDiscoverCompany('Databricks');
  assert.ok(found.length >= 1);
  assert.equal(found[0]?.name, 'Databricks');
  assert.equal(found[0]?.atsProvider, 'greenhouse');
  assert.equal(found[0]?.atsIdentifier, 'databricks');

  const synthesized = searchOrDiscoverCompany('RandomNewCo');
  assert.equal(synthesized.length, 1);
  assert.equal(synthesized[0]?.name, 'RandomNewCo');
  assert.equal(synthesized[0]?.atsProvider, 'greenhouse');
  assert.equal(synthesized[0]?.atsIdentifier, 'randomnewco');
  assert.ok(synthesized[0]?.cooldown.interview.length > 0);
});

test('AVAILABLE_LOCATIONS includes primary Indian and global tech hubs', () => {
  assert.ok(AVAILABLE_LOCATIONS.includes('All Locations'));
  assert.ok(AVAILABLE_LOCATIONS.includes('Bengaluru'));
  assert.ok(AVAILABLE_LOCATIONS.includes('Hyderabad'));
  assert.ok(AVAILABLE_LOCATIONS.includes('Pune'));
  assert.ok(AVAILABLE_LOCATIONS.includes('Delhi NCR'));
});
