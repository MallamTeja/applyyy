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
    full_name: 'Mallam Teja', headline: null, email: 'teja@example.com', phone: '+91 1', location: 'Hyderabad, Telangana, India',
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
