// Tests for the closed-table profile resolver: exact synonyms only, never a guess.
// vitest primitives, matching the rest of the worker suite.
import { describe, expect, test } from 'vitest';
// Type-only: the resolver reads identity, so a cast fixture is enough.
import type { MasterProfile } from '@applyy/shared-types';
import type { FormField } from '../src/extract-fields.ts';
// Subject under test.
import { resolveProfileAnswer } from '../src/profile-answers.ts';

// Minimal profile cast at the boundary; the resolver reads identity only.
const profile = {
  identity: {
    full_name: 'Asha Rao', headline: null, email: 'teja@example.com', phone: '+91 1', location: 'Hyderabad, Telangana, India',
    links: [
      { id: '1', label: 'Portfolio', url: 'https://teja.dev' },
      { id: '2', label: 'GitHub', url: 'https://github.com/teja' },
    ],
  },
} as unknown as MasterProfile;

/** A profile that differs only in location, isolating the country rule. */
// Location-only variant, so the country tests differ from the base profile in exactly one field.
const at = (location: string | null) => ({ identity: { ...profile.identity, location } }) as unknown as MasterProfile;

/** A field with just the parts the resolver reads; select-like when options are given. */
// Kind defaults to select-like when options exist, matching what extraction produces.
const f = (label: string, options?: readonly string[], kind?: FormField['kind']): FormField =>
  ({ id: 'x', label, kind: kind ?? (options ? 'native_select' : 'combobox'), required: true, ...(options ? { options } : {}) });

describe('resolveProfileAnswer', () => {
  test('resolves synonyms exactly, ignoring cosmetic punctuation', () => {
    // Normalisation bridges "Email Address *" to email_address, a listed synonym.
    // email_address is a listed synonym; the asterisk and case are normalised away.
    expect(resolveProfileAnswer(f('Email Address *'), profile)).toBe('teja@example.com');
    // mobile_number is a listed phone synonym.
    expect(resolveProfileAnswer(f('Mobile number'), profile)).toBe('+91 1');
    // Portfolio-labelled link serves the "Website" question.
    // Website resolves via the link labelled Portfolio, since the two are interchangeable.
    expect(resolveProfileAnswer(f('Website'), profile)).toBe('https://teja.dev');
    // github_url is a listed synonym and the GitHub link is matched by label.
    expect(resolveProfileAnswer(f('GitHub URL'), profile)).toBe('https://github.com/teja');
  });

  test('does not substring-match', () => {
    // "Emergency contact phone" would be someone else's number.
    expect(resolveProfileAnswer(f('Emergency contact phone'), profile)).toBeNull();
  });

  test('labels that collide with Object.prototype do not crash or resolve', () => {
    // A plain-object lookup would return a function for these and throw downstream.
    expect(resolveProfileAnswer(f('constructor'), profile)).toBeNull();
    // __proto__ is the other inherited key a plain-object table would mis-resolve.
    expect(resolveProfileAnswer(f('__proto__'), profile)).toBeNull();
  });

  test('missing links, missing profile and empty values give null', () => {
    // The fixture has no LinkedIn link, so there is nothing to copy.
    expect(resolveProfileAnswer(f('LinkedIn'), profile)).toBeNull();
    // No profile at all.
    expect(resolveProfileAnswer(f('Email'), null)).toBeNull();
    // Whitespace-only email is treated as missing.
    const blank = { identity: { ...profile.identity, email: '  ' } } as unknown as MasterProfile;
    // Blank must not become an answer.
    expect(resolveProfileAnswer(f('Email'), blank)).toBeNull();
  });

  test('country is the last location segment, checked against options for native selects', () => {
    // Combobox: validated at fill time, so the parsed value is returned.
    expect(resolveProfileAnswer(f('Country'), profile)).toBe('India');
    // Select offering the exact string passes.
    expect(resolveProfileAnswer(f('Country', ['India', 'USA']), profile)).toBe('India');
    // Select without it is refused.
    expect(resolveProfileAnswer(f('Country', ['Bharat']), profile)).toBeNull();
  });

  test('country needs two location segments and a validating control', () => {
    // A lone city must not be promoted to a country.
    expect(resolveProfileAnswer(f('Country'), at('Hyderabad'))).toBeNull();
    // Empty segments do not count toward the two.
    expect(resolveProfileAnswer(f('Country'), at('Hyderabad, '))).toBeNull();
    // Free text has no validation, so a parsed guess is never typed there.
    expect(resolveProfileAnswer(f('Country', undefined, 'text'), profile)).toBeNull();
    // Same for textarea.
    expect(resolveProfileAnswer(f('Country', undefined, 'textarea'), profile)).toBeNull();
  });
});

// Round-3 mappings: full name, city, current location, current company, phone synonyms.
describe('resolveProfileAnswer - name, city, location, company, phone synonyms', () => {
  // Profile variant with a given experience list, since the company rule reads only that.
  const withExp = (experience: unknown) => ({ ...profile, experience }) as unknown as MasterProfile;

  test('full name copies identity.full_name as-is; blank gives null', () => {
    // Every listed synonym returns the whole stored name, never a split.
    for (const label of ['Full name', 'Your full name', 'Name']) expect(resolveProfileAnswer(f(label), profile)).toBe('Asha Rao');
    // "Legal name" can differ from the profile name, so it is not in the table.
    expect(resolveProfileAnswer(f('Legal name'), profile)).toBeNull();
    // A blank stored name must not become an answer.
    const blank = { identity: { ...profile.identity, full_name: '  ' } } as unknown as MasterProfile;
    // Whitespace-only is missing, so null.
    expect(resolveProfileAnswer(f('Full name'), blank)).toBeNull();
  });

  test('city is the first location segment, and only when there are two segments', () => {
    // All three listed city synonyms resolve to the first segment.
    for (const label of ['City', 'Current city', 'City of residence']) expect(resolveProfileAnswer(f(label), profile)).toBe('Hyderabad');
    // A lone "Hyderabad" is ambiguous (city or country), so city refuses (red-on-revert target)...
    expect(resolveProfileAnswer(f('City'), at('Hyderabad'))).toBeNull();
    // ...while current location copies it whole, because no parsing is involved.
    expect(resolveProfileAnswer(f('Current location'), at('Hyderabad'))).toBe('Hyderabad');
    // Empty segments do not count toward the two.
    expect(resolveProfileAnswer(f('City'), at('Hyderabad, '))).toBeNull();
    // An empty location gives null for the city rule.
    expect(resolveProfileAnswer(f('City'), at(''))).toBeNull();
    // And null for the location rule.
    expect(resolveProfileAnswer(f('Current location'), at(''))).toBeNull();
  });

  test('current location copies the full string verbatim', () => {
    // Both synonyms return the unparsed string.
    expect(resolveProfileAnswer(f('Current Location'), profile)).toBe('Hyderabad, Telangana, India');
    // The bare "Location" synonym behaves the same.
    expect(resolveProfileAnswer(f('Location'), profile)).toBe('Hyderabad, Telangana, India');
    // "Where are you located" overlaps the located_in denylist intent, so it stays unmapped.
    expect(resolveProfileAnswer(f('Where are you located?'), profile)).toBeNull();
  });

  test('current company needs exactly one experience entry marked Present', () => {
    // CASE APPLIED: DisplayDate is a plain string (profile-nodes.ts:57) but its documented
    // contract (:175) is "Use Present for current roles", so that literal IS the explicit marker.
    const old = { company: 'OldCo', end_display: 'Mar 2023', end_date: '2023-03-01' };
    // One Present entry: its employer is the answer, for both synonyms.
    const one = withExp([old, { company: 'NowCo', end_display: 'Present', end_date: null }]);
    // First synonym.
    expect(resolveProfileAnswer(f('Current company'), one)).toBe('NowCo');
    // Second synonym.
    expect(resolveProfileAnswer(f('Current employer'), one)).toBe('NowCo');
    // A null end_date alone is NOT a marker: it can mean never entered, which is missing data.
    expect(resolveProfileAnswer(f('Current company'), withExp([{ company: 'X', end_display: '', end_date: null }]))).toBeNull();
    // Two Present entries make "the" employer ambiguous, so refuse.
    const two = withExp([{ company: 'A', end_display: 'Present' }, { company: 'B', end_display: 'Present' }]);
    // Ambiguous gives null.
    expect(resolveProfileAnswer(f('Current company'), two)).toBeNull();
    // No experience key at all gives null.
    expect(resolveProfileAnswer(f('Current company'), profile)).toBeNull();
    // A non-array jsonb value gives null rather than throwing.
    expect(resolveProfileAnswer(f('Current company'), withExp('junk'))).toBeNull();
    // A blank company on the marked entry gives null.
    expect(resolveProfileAnswer(f('Current company'), withExp([{ company: ' ', end_display: 'Present' }]))).toBeNull();
    // "Company name" is ambiguous on forms, so it is not in the table.
    expect(resolveProfileAnswer(f('Company name'), one)).toBeNull();
  });

  test('new phone synonyms resolve to the stored phone', () => {
    // Each added phrasing maps to the one stored number.
    for (const label of ['Mobile phone', 'Contact number', 'Contact phone', 'Phone no', 'Telephone']) {
      // Same value for every phrasing.
      expect(resolveProfileAnswer(f(label), profile)).toBe('+91 1');
    }
  });
});

// "Github Link" stayed unanswered on Aiven's kit (run 40098564239, 2026-10-24) although master v3
// carries a GitHub link: the label normalises to github_link, which the closed table lacked.
// Rule: an exact normalised key only, so "GitHub username" (a handle, not a URL) stays unmapped.
describe('"<site> Link" labels', () => {
  // The base fixture plus a LinkedIn link, so both sites can resolve.
  const withLinkedIn = { identity: { ...profile.identity, links: [...profile.identity.links, { id: '3', label: 'LinkedIn', url: 'https://linkedin.com/in/teja' }] } } as unknown as MasterProfile;

  test('"Github Link" copies the master\'s GitHub link', () => {
    // The exact Greenhouse label from the Aiven form.
    expect(resolveProfileAnswer(f('Github Link', undefined, 'text'), profile)).toBe('https://github.com/teja');
  });

  test('"Github Link" with no GitHub link in the master stays unanswered', () => {
    // Same identity, minus the GitHub link.
    const noGithub = { identity: { ...profile.identity, links: [{ id: '1', label: 'Portfolio', url: 'https://teja.dev' }] } } as unknown as MasterProfile;
    // Nothing to copy: never the portfolio in its place.
    expect(resolveProfileAnswer(f('Github Link', undefined, 'text'), noGithub)).toBeNull();
  });

  test('"GitHub username" is not a link field and stays unanswered', () => {
    // A URL in a username box would be wrong, so the key is deliberately absent.
    expect(resolveProfileAnswer(f('GitHub username', undefined, 'text'), profile)).toBeNull();
  });

  test('"LinkedIn Link" copies the master\'s LinkedIn link', () => {
    // The same phrasing for the other link site.
    expect(resolveProfileAnswer(f('LinkedIn Link', undefined, 'text'), withLinkedIn)).toBe('https://linkedin.com/in/teja');
  });
});
