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
  readCachedFilterRules,
  writeCachedFilterRules,
} from '../src/features/settings/filtersStore.ts';
import type { JobRow } from '../src/data/contract.ts';

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
  assert.equal(rules.length, 9);

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
