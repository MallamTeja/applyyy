// matchOption: picks the form's OWN option text for a bank answer that differs only in case,
// whitespace or a narrow set of punctuation. Every option list below is a REAL capture under
// worker/fixtures/greenhouse/, so the tests prove the near-misses that park Canonical rows today
// ("india" vs "India", "yes" vs "Yes") are fixed, and that the traps those same lists hold
// (India vs Indian vs Indiana, Guinea vs Guinea-Bissau, "10" vs "10+") still fail closed.
// Vitest is the worker's runner; these are pure-function tests, no browser needed.
import { describe, expect, test } from 'vitest';
// Read fixtures straight off disk: a JSON import would need a resolveJsonModule/assert setup.
import { readFileSync } from 'node:fs';
// The unit under test.
import { matchOption } from '../src/option-match.ts';

// Loads one captured Greenhouse questions file and returns a field's option list by field name.
function canonicalOptions(name: string): string[] {
  // The same capture the Canonical 3752633 pre-flight test reads, so both pin one real form.
  const raw = readFileSync(new URL('../fixtures/greenhouse/canonical-3752633-questions.json', import.meta.url), 'utf8');
  // Shape of the boards API ?questions=true payload; only the parts read here.
  const json = JSON.parse(raw) as { questions: { fields: { name: string; values: string[] }[] }[] };
  // Flatten every question's fields and take the named one: a missing field must throw, not pass vacuously.
  const field = json.questions.flatMap((q) => q.fields).find((f) => f.name === name);
  // A renamed fixture field would otherwise turn every assertion below into a match against [].
  if (field === undefined || field.values.length === 0) throw new Error(`fixture field ${name} missing or empty`);
  // The real option texts, exactly as captured (some carry trailing spaces).
  return field.values;
}

// Real lists from the Canonical capture, named by what they ask.
const yesNo = canonicalOptions('question_37390423'); // "meet in person 2-4 times a year": Yes | No
const country = canonicalOptions('question_41852508'); // "In which country do you currently work?" (314 options)
const nationality = canonicalOptions('question_65026532[]'); // "Please indicate your nationality:" (226 options)
const gender = canonicalOptions('question_55391540'); // Female | Male | Not listed above | Prefer not to say
const ethnicity = canonicalOptions('question_65026567'); // includes "Hispanic or Latino " with a trailing space
const years = canonicalOptions('question_55251714'); // "0".."9", "10+"
// TrueFoundry's degree list (a different capture shape: {items:[{text}]}).
const degrees = (
  JSON.parse(readFileSync(new URL('../fixtures/greenhouse/truefoundry-education-degrees.json', import.meta.url), 'utf8')) as {
    items: { text: string }[];
  }
).items.map((item) => item.text);

describe('matchOption: real near-misses from the Canonical pre-flight now resolve', () => {
  // The headline bug: the live bank stores "india", the country dropdown offers "India".
  test('"india" picks the country option "India" (normalized), returning the form\'s own text', () => {
    expect(matchOption('india', country)).toEqual({ kind: 'normalized', option: 'India' });
  });
  // "yes" vs "Yes": the in-person question that parks every Canonical row.
  test('"yes" picks "Yes"', () => {
    expect(matchOption('yes', yesNo)).toEqual({ kind: 'normalized', option: 'Yes' });
  });
  // "female" vs "Female" on the gender dropdown.
  test('"female" picks "Female"', () => {
    expect(matchOption('female', gender)).toEqual({ kind: 'normalized', option: 'Female' });
  });
  // The captured option itself carries a trailing space; an exact-only check misses the clean answer.
  test('"Hispanic or Latino" picks the captured "Hispanic or Latino " (trailing space)', () => {
    expect(matchOption('Hispanic or Latino', ethnicity)).toEqual({ kind: 'normalized', option: 'Hispanic or Latino ' });
  });
  // An exact hit stays exact: today's behaviour must not change for answers that already match.
  test('an exact answer is reported as exact', () => {
    expect(matchOption('Other', ethnicity)).toEqual({ kind: 'exact', option: 'Other' });
  });
  // Apostrophe and period variants of the same degree name.
  test('"bachelors degree" picks "Bachelor\'s Degree"; "phd" stays none (no abbreviation expansion)', () => {
    expect(matchOption('bachelors degree', degrees)).toEqual({ kind: 'normalized', option: "Bachelor's Degree" });
    // "Doctor of Philosophy (Ph.D.)" is not "phd" after normalization: wording, not punctuation.
    expect(matchOption('phd', degrees)).toEqual({ kind: 'none' });
  });
  // Hyphen as a word separator: "guinea bissau" is the same text as "Guinea-Bissau".
  test('"guinea bissau" picks "Guinea-Bissau", and "guinea" picks only "Guinea"', () => {
    expect(matchOption('guinea bissau', country)).toEqual({ kind: 'normalized', option: 'Guinea-Bissau' });
    // Whole-string equality: Guinea-Bissau, Equatorial Guinea and Papua New Guinea all CONTAIN "guinea".
    expect(matchOption('guinea', country)).toEqual({ kind: 'normalized', option: 'Guinea' });
  });
});

describe('matchOption: fails closed on everything that is not the same text', () => {
  // The nationality list has "Indian", never "India": a different word, so the row must park for Teja.
  test('"india" on the nationality list is none (never "Indian", never "Indonesian")', () => {
    expect(matchOption('india', nationality)).toEqual({ kind: 'none' });
  });
  // Prefix collision on the country list: "Indiana" and "Indonesia" both start like "ind".
  test('"indian" on the country list is none (no prefix or contains match to India/Indiana)', () => {
    expect(matchOption('indian', country)).toEqual({ kind: 'none' });
  });
  // "+" carries meaning ("10 or more"): stripping it would turn "10" into a claim of "10+".
  test('"10" does not pick "10+"', () => {
    expect(matchOption('10', years)).toEqual({ kind: 'none' });
  });
  // The brief's named trap: "Yes" must never select a longer option that starts with it.
  test('"Yes" never matches "Yes, I require sponsorship"', () => {
    expect(matchOption('Yes', ['Yes, I require sponsorship', 'No'])).toEqual({ kind: 'none' });
  });
  // Two options that normalize to one string: which one Teja meant is unknowable.
  test('two options normalizing to the same text are ambiguous', () => {
    expect(matchOption('us', ['U.S.', 'US', 'Canada'])).toEqual({ kind: 'ambiguous' });
  });
  // Empty and blank answers are no answer at all (Number("") === 0 is the §6 trap in another form).
  test('empty, blank and punctuation-only answers are none', () => {
    expect(matchOption('', yesNo)).toEqual({ kind: 'none' });
    expect(matchOption('   ', yesNo)).toEqual({ kind: 'none' });
    // Normalizes to '' and would otherwise match a blank placeholder option.
    expect(matchOption('...', ['', 'Yes'])).toEqual({ kind: 'none' });
  });
  // A blank placeholder option ("Select...") must never be picked by a blank answer.
  test('a blank option is never a match target', () => {
    expect(matchOption('', ['', 'Yes'])).toEqual({ kind: 'none' });
  });
  // No options at all: nothing to pick.
  test('an empty option list is none', () => {
    expect(matchOption('yes', [])).toEqual({ kind: 'none' });
  });
});
