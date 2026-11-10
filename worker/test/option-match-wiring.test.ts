// OPTION MATCHING IN THE PLANNER: a bank answer that is the same statement as one of the form's options,
// differing only in case, whitespace or separators ("india" / "India", "hispanic or latino" / "Hispanic or
// Latino "), is planned as the FORM's own option text instead of parking the row as no_matching_option.
//
// WHY THIS FILE EXISTS. The live bank stores answers as Teja typed them (lowercase, free words), and every
// planner site compared with options.includes(), so 9-10 answers per Canonical form parked a row on case alone.
// option-match.ts (4795874) is the matcher; this file pins that all four planner sites use it, that
// anything but one exact/normalized hit still parks, and that matching never reaches a declaration.
//
// Option lists are the REAL ones from the captured Canonical boards-api questions. They are planned here as
// native selects: a react-select's options are unknown at plan time, so its match happens at fill time.
import { expect, test } from 'vitest';
// Reads the captured question list; the live API is never called from a test.
import { readFileSync } from 'node:fs';
// The planner under test, and the label -> bank key normaliser the bank rows must meet.
import { planFill, questionKey } from '../src/plan-fill.ts';
// The field shape the extractor hands the planner.
import type { FormField } from '../src/extract-fields.ts';
// Type-only: the bank row shape planFill takes.
import type { AnswerBankRow } from '@applyy/shared-types';

// Field name -> its option texts, from the first Canonical capture.
const OPTIONS: Record<string, string[]> = Object.fromEntries(
  // Every question's every field, flattened to name -> option texts.
  (JSON.parse(readFileSync('fixtures/greenhouse/canonical-3752633-questions.json', 'utf8')) as {
    questions: { fields: { name: string; values: string[] }[] }[];
  }).questions.flatMap((q) => q.fields.map((f) => [f.name, f.values])),
);

// A required native select carrying a real option list.
const select = (id: string, label: string, options: readonly string[]): FormField =>
  // Required, so any refusal is a visible blocker.
  ({ id, label, kind: 'native_select', required: true, options }) as FormField;

// A bank row in the live shape; attested unless told otherwise.
const row = (question_key: string, answer_value: unknown, attested_by_human = true) =>
  // needs_human false: a usable row.
  ({ question_key, answer_value, needs_human: false, answer_type: 'text', attested_by_human }) as unknown as AnswerBankRow;

// One field, one row, the applier's call shape; returns [fills as id/value, blockers as id/reason].
function plan(field: FormField, rows: AnswerBankRow[]): [string[][], string[][]] {
  // Employer: the posting's company.
  const p = planFill([field], rows, null, 'Canonical');
  // Plain arrays, so toEqual reads clearly.
  return [p.fills.map((f) => [f.id, f.value]), p.blockers.map((b) => [b.id, b.reason])];
}

test('generic bank path: "india" plans as the form\'s "India" (country list, 314 options)', () => {
  // "In which country do you currently work?": no gate word, so the plain bank lookup answers it.
  const field = select('question_41852508', 'In which country do you currently work?', OPTIONS['question_41852508']!);
  // The live lowercase answer. Before T8 the row was unattested, because the plain path did not require
  // attestation then. T8 (2026-11-10): the plain path now needs an attested row too, so the row is attested (default).
  expect(plan(field, [row(questionKey(field.label), 'india')])).toEqual([[['question_41852508', 'India']], []]);
});

test('exact-label attested path: "male" plans as "Male", and "hispanic or latino" keeps the option\'s trailing space', () => {
  // "Which gender do you identify as?": EEO territory, answered from Teja's attested row keyed to this label.
  const gender = select('question_55391540', 'Which gender do you identify as?', OPTIONS['question_55391540']!);
  // The form's own text, not Teja's lowercase.
  expect(plan(gender, [row(questionKey(gender.label), 'male')])).toEqual([[['question_55391540', 'Male']], []]);
  // "Please indicate your race or ethnicity:", whose option is "Hispanic or Latino " (trailing space on the live form).
  const race = select('question_65026567', 'Please indicate your race or ethnicity:', OPTIONS['question_65026567']!);
  // The trailing space survives, because the planned value is the option itself.
  expect(plan(race, [row(questionKey(race.label), 'hispanic or latino')])).toEqual([[['question_65026567', 'Hispanic or Latino ']], []]);
});

test('EEO template path: eeo_gender "male" plans as "Male"', () => {
  // A plain "Gender" label goes through EEO_TEMPLATES to the eeo_gender key.
  const field = select('gender', 'Gender', ['Female', 'Male', 'Not listed above']);
  // Teja's attested template row, lowercase.
  expect(plan(field, [row('eeo_gender', 'male')])).toEqual([[['gender', 'Male']], []]);
});

test('eligibility path: a derived "Yes" plans as the form\'s "YES"', () => {
  // "Are you currently located in India?" on a form that capitalises its options.
  const field = select('loc', 'Are you currently located in India?', ['YES', 'NO']);
  // Teja's attested country; the template answers "Yes", which the form spells "YES".
  expect(plan(field, [row('located_in_country', 'India')])).toEqual([[['loc', 'YES']], []]);
});

test('opinion territory via the exact-label row: "yes" plans as "Yes" on the in-person travel question', () => {
  // The travel question says "meet in person", so it is OPINION territory and needs the attested row.
  const field = select('question_37390423', 'We require all colleagues to meet in person 2-4 times a year. Are you willing and able to commit to this?', OPTIONS['question_37390423']!);
  // Lowercase attested answer.
  expect(plan(field, [row(questionKey(field.label), 'yes')])).toEqual([[['question_37390423', 'Yes']], []]);
});

test('still parks: no same-text option ("indian" is not "India"), and a tie between two options', () => {
  // The country list has "India", never "Indian": a different word is a different statement.
  const country = select('question_41852508', 'In which country do you currently work?', OPTIONS['question_41852508']!);
  // Refused, exactly as before the wiring.
  expect(plan(country, [row(questionKey(country.label), 'indian')])).toEqual([[], [['question_41852508', 'no_matching_option']]]);
  // Two options normalize to the answer: which one Teja meant is unknowable.
  const tie = select('tie', 'Preferred shift', ['Day', 'day']);
  // Ambiguous parks too.
  expect(plan(tie, [row(questionKey(tie.label), 'DAY')])).toEqual([[], [['tie', 'no_matching_option']]]);
});

test('HARD CONSTRAINT: matching never reaches a declaration, even with a normalized-equal option', () => {
  // Canonical's privacy declaration with a second option, so the single-option rule is NOT what refuses it.
  const label = "Please confirm that you have read and agree to Canonical's Recruitment Privacy Notice and Privacy Policy.";
  // "acknowledge/confirm" normalizes equal to "Acknowledge/Confirm": a fill if the declaration gate ever ran second.
  const field = select('question_37452492', label, ['Acknowledge/Confirm', 'Decline']);
  // Attested, normalized-equal: still Teja's signature to give.
  expect(plan(field, [row(questionKey(label), 'acknowledge/confirm')])).toEqual([[], [['question_37452492', 'human_only']]]);
  // The near miss the brief names ("acknowledge" vs "Acknowledge/Confirm") is refused the same way.
  expect(plan(field, [row(questionKey(label), 'acknowledge')])).toEqual([[], [['question_37452492', 'human_only']]]);
});
