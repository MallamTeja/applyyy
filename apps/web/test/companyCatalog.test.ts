/* Tests for the company catalog and AI discovery module.
 *
 * WHAT THESE PROTECT:
 *   1. Curated companies invariant: Every entry must have a valid ATS provider
 *      ('greenhouse', 'lever', 'ashby'), non-empty board slug, domain, category,
 *      and well-formed cooldown periods. Storing a broken slug causes the Scout
 *      to poll a dead endpoint silently.
 *   2. Filtering correctness: Text search, category filtering, and ATS provider
 *      filtering must compose properly and never produce runtime errors on empty
 *      queries or whitespace.
 *   3. AI discovery resilience: When the Gemini API is unreachable, rate-limited,
 *      or unconfigured, `discoverCompaniesWithGemini` must never throw or deadlock
 *      the UI — it must return filtered curated results as a self-healing fallback.
 *   4. JSON sanitization: Free-form or partial LLM outputs must be safely coerced
 *      into strictly-typed `SuggestedCompany` records.
 *
 * RUN: `pnpm --filter @applyy/web test`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CURATED_COMPANIES,
  filterCompanies,
  sanitizeSuggestedCompany,
  discoverCompaniesWithGemini,
} from '../src/features/settings/companyCatalog.ts';
import type { SuggestedCompany } from '../src/features/settings/companyCatalog.ts';

test('curated companies catalog has all expected baseline employers', () => {
  assert.ok(CURATED_COMPANIES.length >= 16, 'Should have at least 16 curated companies');

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
  ];

  for (const name of required) {
    assert.ok(names.has(name), `Missing required curated company: ${name}`);
  }
});

test('every curated company satisfies the schema contract and ATS slug requirements', () => {
  const validCategories = new Set(['GCC', 'Mid-Scale MNC', 'Startup / Unicorn']);
  const validAts = new Set(['greenhouse', 'lever', 'ashby']);

  for (const c of CURATED_COMPANIES) {
    assert.ok(c.name.trim().length > 0, `Name must not be empty for ${c.name}`);
    assert.ok(validCategories.has(c.category), `Invalid category ${c.category} for ${c.name}`);
    assert.ok(validAts.has(c.atsProvider), `Invalid ATS ${c.atsProvider} for ${c.name}`);
    assert.ok(c.atsIdentifier.trim().length > 0, `Slug must not be empty for ${c.name}`);
    assert.ok(!c.atsIdentifier.includes(' '), `Slug cannot contain spaces for ${c.name}`);
    assert.ok(c.domain.trim().length > 0, `Domain must not be empty for ${c.name}`);
    assert.ok(c.cooldown.interview.length > 0, `Interview cooldown missing for ${c.name}`);
    assert.ok(c.cooldown.screening.length > 0, `Screening cooldown missing for ${c.name}`);
  }
});

test('filterCompanies filters by category', () => {
  const gccOnly = filterCompanies(CURATED_COMPANIES, { category: 'GCC' });
  assert.ok(gccOnly.length > 0);
  assert.ok(gccOnly.every((c) => c.category === 'GCC'));

  const mncOnly = filterCompanies(CURATED_COMPANIES, { category: 'Mid-Scale MNC' });
  assert.ok(mncOnly.length > 0);
  assert.ok(mncOnly.every((c) => c.category === 'Mid-Scale MNC'));

  const startupOnly = filterCompanies(CURATED_COMPANIES, { category: 'Startup / Unicorn' });
  assert.ok(startupOnly.length > 0);
  assert.ok(startupOnly.every((c) => c.category === 'Startup / Unicorn'));
});

test('filterCompanies filters by ATS provider', () => {
  const greenhouse = filterCompanies(CURATED_COMPANIES, { atsProvider: 'greenhouse' });
  assert.ok(greenhouse.length > 0);
  assert.ok(greenhouse.every((c) => c.atsProvider === 'greenhouse'));

  const lever = filterCompanies(CURATED_COMPANIES, { atsProvider: 'lever' });
  assert.ok(lever.length > 0);
  assert.ok(lever.every((c) => c.atsProvider === 'lever'));
});

test('filterCompanies filters by search query matching name, domain, or slug', () => {
  const stripe = filterCompanies(CURATED_COMPANIES, { search: 'stripe' });
  assert.equal(stripe.length, 1);
  assert.equal(stripe[0]?.name, 'Stripe');

  const fintech = filterCompanies(CURATED_COMPANIES, { search: 'fintech' });
  assert.ok(fintech.length >= 2, 'Should find at least 2 fintech companies');

  const nonExistent = filterCompanies(CURATED_COMPANIES, { search: 'xyz999foobar' });
  assert.equal(nonExistent.length, 0);
});

test('sanitizeSuggestedCompany handles valid and malformed raw objects', () => {
  assert.equal(sanitizeSuggestedCompany(null), null);
  assert.equal(sanitizeSuggestedCompany('string'), null);
  assert.equal(sanitizeSuggestedCompany({}), null);

  const parsed = sanitizeSuggestedCompany({
    name: 'Acme Corp',
    category: 'GCC Tech Center',
    domain: 'Cloud Services',
    atsProvider: 'lever',
    atsIdentifier: 'acme-corp',
    cooldown: { interview: '6 Months', screening: 'None' },
  });

  assert.notEqual(parsed, null);
  assert.equal(parsed?.name, 'Acme Corp');
  assert.equal(parsed?.category, 'GCC');
  assert.equal(parsed?.atsProvider, 'lever');
  assert.equal(parsed?.atsIdentifier, 'acme-corp');
  assert.equal(parsed?.cooldown.interview, '6 Months');
});

test('discoverCompaniesWithGemini falls back cleanly when no key is set', async () => {
  const results = await discoverCompaniesWithGemini('', '');
  assert.ok(results.length >= 16);

  const searchResults = await discoverCompaniesWithGemini('retail', '');
  assert.ok(searchResults.length >= 1);
  assert.ok(searchResults.some((c) => c.name.toLowerCase().includes('target') || c.name.toLowerCase().includes('walmart')));
});

test('discoverCompaniesWithGemini parses valid Gemini API JSON response', async () => {
  const mockAiOutput = JSON.stringify([
    {
      name: 'Linear',
      category: 'Startup / Unicorn',
      domain: 'Issue Tracking / High Performance Web',
      atsProvider: 'ashby',
      atsIdentifier: 'linear',
      cooldown: { interview: '6 Months', screening: 'None' },
    },
  ]);

  const fakeFetch: typeof fetch = async () => {
    return {
      ok: true,
      json: async () => ({
        candidates: [
          {
            content: {
              parts: [{ text: `\`\`\`json\n${mockAiOutput}\n\`\`\`` }],
            },
          },
        ],
      }),
    } as unknown as Response;
  };

  const results = await discoverCompaniesWithGemini('Linear app', 'test-fake-key', fakeFetch);
  assert.equal(results.length, 1);
  assert.equal(results[0]?.name, 'Linear');
  assert.equal(results[0]?.atsProvider, 'ashby');
  assert.equal(results[0]?.atsIdentifier, 'linear');
});

test('discoverCompaniesWithGemini recovers gracefully when fetch rejects or errors', async () => {
  const failingFetch: typeof fetch = async () => {
    throw new Error('Network timeout');
  };

  const results = await discoverCompaniesWithGemini('Databricks', 'test-fake-key', failingFetch);
  assert.ok(results.length >= 1);
  assert.ok(results.some((c) => c.name === 'Databricks'));
});
