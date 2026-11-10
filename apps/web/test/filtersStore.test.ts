/* Tests for Filter Cascade store, Tech-only constraint, and job match evaluation.
 *
 * Protected invariants:
 * 1. Tech constraint accurately distinguishes software/data/cloud/AI engineering from
 *    sales, marketing, HR, customer success, finance, and office administration.
 * 2. Title blocklist rejects disqualified seniority ("Senior", "Staff", "Lead", "Manager").
 * 3. Location allowlist rejects non-matching cities while respecting Remote & Indian tech hubs.
 * 4. Experience ceiling rejects postings demanding more years than candidate holds.
 * 5. Degree mismatch rejects postings requiring Master's or PhD.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_FILTER_RULES,
  evaluateJobMatch,
  isTechRole,
  // Load/save under a fake client, for the retired-rules tests (2026-11-10).
  loadFilterRules,
  RETIRED_FILTER_RULE_TYPES,
  readCachedFilterRules,
  saveFilterRules,
  writeCachedFilterRules,
} from '../src/features/settings/filtersStore.ts';
// The stale in-memory state in the save test is typed as the page holds it.
import type { FilterRuleConfig } from '../src/features/settings/filtersStore.ts';
import type { JobRow } from '../src/data/contract.ts';
// Type-only: the fake client is cast to the real client type once.
import type { SupabaseClient } from '@supabase/supabase-js';

// Mock localStorage for node test runner
const mockStorage: Record<string, string> = {};
global.localStorage = {
  getItem: (key: string) => mockStorage[key] || null,
  setItem: (key: string, val: string) => {
    mockStorage[key] = val;
  },
  removeItem: (key: string) => {
    delete mockStorage[key];
  },
  clear: () => {
    for (const k of Object.keys(mockStorage)) delete mockStorage[k];
  },
  length: 0,
  key: () => null,
} as Storage;

test('isTechRole accepts engineering, dev, data, and cloud roles', () => {
  const techTitles = [
    'Software Engineer',
    'Junior SDE',
    'Frontend Developer',
    'Backend Engineer',
    'Full Stack Engineer',
    'Data Scientist',
    'Machine Learning Engineer',
    'Cloud / DevOps Engineer',
    'QA Automation Engineer',
    'Software Engineering Intern',
    'Graduate Engineer Trainee',
    'React Native Developer',
  ];

  for (const title of techTitles) {
    const check = isTechRole(title);
    assert.ok(check.isTech, `Expected "${title}" to be classified as tech, but got false (${check.reason})`);
  }
});

test('isTechRole rejects non-tech roles (Sales, Marketing, HR, Finance, Support)', () => {
  const nonTechTitles = [
    'Account Executive',
    'Sales Development Representative (SDR)',
    'Business Development Associate',
    'Marketing Manager',
    'SEO Specialist',
    'Talent Acquisition Specialist',
    'HR Generalist',
    'Technical Recruiter',
    'Customer Success Specialist',
    'Customer Support Associate',
    'Financial Analyst',
    'Staff Accountant',
    'Office Manager',
    'Legal Counsel',
  ];

  for (const title of nonTechTitles) {
    const check = isTechRole(title);
    assert.equal(check.isTech, false, `Expected "${title}" to be rejected as non-tech, but got true`);
  }
});

test('evaluateJobMatch rejects non-tech jobs when techOnly is true', () => {
  const fakeJob = {
    id: 'job-sales-1',
    title: 'Sales Account Executive',
    company_name: 'Tech Corp',
    company_slug: 'tech-corp',
    locations: ['Bangalore'],
    location_raw: 'Bangalore, India',
    employment_type: 'full_time',
    min_experience_years: '1',
    requires_advanced_degree: false,
    ats_provider: 'greenhouse',
    discovered_via: ['portal_api'],
    apply_url: 'https://example.com',
    fingerprint: 'fp-1',
    created_at: new Date().toISOString(),
  } as unknown as JobRow;

  const res = evaluateJobMatch(fakeJob, DEFAULT_FILTER_RULES, true);
  assert.equal(res.passed, false);
  assert.ok(res.dropReason?.includes('Non-tech role'));
});

test('evaluateJobMatch rejects senior / staff titles according to title_blocklist', () => {
  const fakeJob = {
    id: 'job-senior-1',
    title: 'Senior Software Engineer',
    company_name: 'Tech Corp',
    company_slug: 'tech-corp',
    locations: ['Bangalore'],
    location_raw: 'Bangalore, India',
    employment_type: 'full_time',
    min_experience_years: '1',
    requires_advanced_degree: false,
    ats_provider: 'greenhouse',
    discovered_via: ['portal_api'],
    apply_url: 'https://example.com',
    fingerprint: 'fp-2',
    created_at: new Date().toISOString(),
  } as unknown as JobRow;

  const res = evaluateJobMatch(fakeJob, DEFAULT_FILTER_RULES, true);
  assert.equal(res.passed, false);
  assert.ok(res.dropReason?.includes('Title contains blocked term "Senior"'));
});

test('evaluateJobMatch rejects postings exceeding experience ceiling', () => {
  const fakeJob = {
    id: 'job-exp-1',
    title: 'Software Engineer',
    company_name: 'Tech Corp',
    company_slug: 'tech-corp',
    locations: ['Bangalore'],
    location_raw: 'Bangalore, India',
    employment_type: 'full_time',
    min_experience_years: '6', // Demands 6 years; the built-in ceiling is 1 since 2026-11-04 (was 2)
    requires_advanced_degree: false,
    ats_provider: 'greenhouse',
    discovered_via: ['portal_api'],
    apply_url: 'https://example.com',
    fingerprint: 'fp-3',
    created_at: new Date().toISOString(),
  } as unknown as JobRow;

  const res = evaluateJobMatch(fakeJob, DEFAULT_FILTER_RULES, true);
  assert.equal(res.passed, false);
  // The reason quotes the built-in ceiling, Teja's 1 year (EARLY_CAREER_MAX_YEARS).
  assert.ok(res.dropReason?.includes('ceiling is 1 yrs'));
});

test('evaluateJobMatch rejects locations not in allowlist', () => {
  const fakeJob = {
    id: 'job-loc-1',
    title: 'Software Engineer',
    company_name: 'Tech Corp',
    company_slug: 'tech-corp',
    locations: ['London, UK'],
    location_raw: 'London, UK',
    employment_type: 'full_time',
    min_experience_years: '1',
    requires_advanced_degree: false,
    ats_provider: 'greenhouse',
    discovered_via: ['portal_api'],
    apply_url: 'https://example.com',
    fingerprint: 'fp-4',
    created_at: new Date().toISOString(),
  } as unknown as JobRow;

  const res = evaluateJobMatch(fakeJob, DEFAULT_FILTER_RULES, true);
  assert.equal(res.passed, false);
  assert.ok(res.dropReason?.includes('not in allowlist'));
});

test('evaluateJobMatch rejects postings with degree_mismatch requiring PhD or Masters', () => {
  const fakeJob = {
    id: 'job-deg-1',
    title: 'Software Engineer - AI',
    company_name: 'Tech Corp',
    company_slug: 'tech-corp',
    locations: ['Hyderabad'],
    location_raw: 'Hyderabad, India',
    employment_type: 'full_time',
    min_experience_years: '1',
    requires_advanced_degree: true, // Requires advanced degree
    ats_provider: 'greenhouse',
    discovered_via: ['portal_api'],
    apply_url: 'https://example.com',
    fingerprint: 'fp-5',
    created_at: new Date().toISOString(),
  } as unknown as JobRow;

  const res = evaluateJobMatch(fakeJob, DEFAULT_FILTER_RULES, true);
  assert.equal(res.passed, false);
  assert.ok(res.dropReason?.includes('advanced degree'));
});

test('evaluateJobMatch passes clean entry-level tech jobs', () => {
  const fakeJob = {
    id: 'job-pass-1',
    title: 'Software Engineer (Frontend / React)',
    company_name: 'Tech Corp',
    company_slug: 'tech-corp',
    locations: ['Hyderabad'],
    location_raw: 'Hyderabad, Telangana, India',
    employment_type: 'full_time',
    min_experience_years: '1',
    requires_advanced_degree: false,
    ats_provider: 'greenhouse',
    discovered_via: ['portal_api'],
    apply_url: 'https://example.com',
    fingerprint: 'fp-clean',
    created_at: new Date().toISOString(),
  } as unknown as JobRow;

  const res = evaluateJobMatch(fakeJob, DEFAULT_FILTER_RULES, true);
  assert.equal(res.passed, true);
  assert.equal(res.dropReason, undefined);
});

test('filter rules read and write cache operates correctly', () => {
  localStorage.clear();
  const rules = readCachedFilterRules();
  // 7, not 9: staleness and per_company_weekly_cap were retired from the defaults (Teja, 2026-11-10).
  assert.equal(rules.length, 7);

  writeCachedFilterRules([
    {
      ruleType: 'experience_ceiling',
      isEnabled: false,
      config: { max_years: 5 },
    },
  ]);

  const updated = readCachedFilterRules();
  assert.equal(updated.length, 1);
  assert.equal(updated[0]?.isEnabled, false);
});

/* Retired rules (Teja, 2026-11-10 11:31 IST): the per-company weekly cap ("remove it") and job age
 * ("dont ever skip even though they are 1 mon 2 mont old"). A migration deletes the 2 live rows; these
 * tests guard the web half, where load used to refill them from the defaults and the next save wrote
 * them back enabled, silently re-enabling both. */

// The two rule types that must never come back through load or save.
const RETIRED = ['staleness', 'per_company_weekly_cap'];

// Same shape as storeReadErrorBlocksSave.test.ts's fake, but it keeps every upsert payload so the
// test can say WHICH rule types were written, not only how many.
function fakeClient(read: { data: unknown; error: { message: string } | null }) {
  // Every rule_type the save tried to write, in order.
  const written: string[] = [];
  // Only the calls the store makes: from().select().order() and from().upsert().
  const client = {
    from: () => ({
      // Read path resolves to the canned answer.
      select: () => ({ order: async () => read }),
      // Write path records the rule type, then succeeds.
      upsert: async (payload: { rule_type: string }) => {
        written.push(payload.rule_type);
        return { error: null };
      },
    }),
    // saveFilterRules asks who is signed in before writing.
    auth: { getUser: async () => ({ data: { user: { id: 'u1' } } }) },
  };
  // Cast once: the fake implements only what the store calls.
  return { client: client as unknown as SupabaseClient, written };
}

test('loadFilterRules over rows missing staleness and per_company_weekly_cap yields neither, and saving that state writes neither', async () => {
  // Empty cache, so the defaults are the only possible source of the retired rows.
  localStorage.clear();
  // The post-migration database: stored rows exist, none of the retired types.
  const { client, written } = fakeClient({
    data: [{ rule_type: 'experience_ceiling', enabled: true, config: { max_years: 1 } }],
    error: null,
  });
  // Load through the fake.
  const rules = await loadFilterRules(client);
  // Neither retired type was filled in from the defaults.
  assert.deepEqual(rules.filter((r) => RETIRED.includes(r.ruleType)).map((r) => r.ruleType), []);
  // Saving exactly what was loaded must not write a retired type back.
  const res = await saveFilterRules(rules, client);
  // The save itself succeeded.
  assert.equal(res.ok, true);
  // And no upsert named a retired type.
  assert.deepEqual(written.filter((t) => RETIRED.includes(t)), []);
});

test('loadFilterRules drops stored live rows of the retired types instead of passing them through', async () => {
  // Empty cache, so only the remote rows matter.
  localStorage.clear();
  // The pre-migration database: both retired rows still stored, enabled.
  const { client } = fakeClient({
    data: [
      { rule_type: 'staleness', enabled: true, config: { window_days: 7 } },
      { rule_type: 'per_company_weekly_cap', enabled: true, config: { max_per_week: 3 } },
    ],
    error: null,
  });
  // Load through the fake.
  const rules = await loadFilterRules(client);
  // The stored rows were skipped, not shown.
  assert.deepEqual(rules.filter((r) => RETIRED.includes(r.ruleType)).map((r) => r.ruleType), []);
});

test('saveFilterRules never writes a retired type, even when a stale in-memory state still holds one', async () => {
  // Cache clear; the save writes it, so start from nothing.
  localStorage.clear();
  // A successful read first, so the save is not blocked by an old read error.
  const { client, written } = fakeClient({ data: [], error: null });
  // Clears lastReadError.
  await loadFilterRules(client);
  // An open tab from before the retirement still holds both rules.
  const stale: FilterRuleConfig[] = [
    { ruleType: 'staleness', isEnabled: true, config: { window_days: 7 } },
    { ruleType: 'experience_ceiling', isEnabled: true, config: { max_years: 1 } },
    { ruleType: 'per_company_weekly_cap', isEnabled: true, config: { max_per_week: 3 } },
  ];
  // Save that state.
  const res = await saveFilterRules(stale, client);
  // The save still succeeds for the live rule.
  assert.equal(res.ok, true);
  // Only the live rule reached the database.
  assert.deepEqual(written, ['experience_ceiling']);
  // And the local cache did not keep the retired ones either.
  assert.deepEqual(readCachedFilterRules().map((r) => r.ruleType), ['experience_ceiling']);
});

test('RETIRED_FILTER_RULE_TYPES names exactly the two retired rules, and the defaults carry neither', () => {
  // The exported list is the one place the page and the store read from.
  assert.deepEqual([...RETIRED_FILTER_RULE_TYPES].sort(), [...RETIRED].sort());
  // No default refills them.
  assert.deepEqual(DEFAULT_FILTER_RULES.filter((r) => RETIRED.includes(r.ruleType)), []);
});
