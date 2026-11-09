// DECLARATIONS ARE NEVER BOT-SIGNED (Teja's standing ruling, 2026-11-07: "the bot never ticks declarations").
//
// WHY THIS FILE EXISTS. On 2026-11-09 the three Canonical pre-flights showed the planner would sign two REQUIRED
// declarations from attested answer_bank rows: "I agree to use only my own words ... the use of AI ... will
// disqualify my application" (its "I understand" put it in OPINION territory, which the exact-label step answers)
// and "Please confirm that you have read and agree to ... Privacy Notice" (no gated word at all, so the plain
// bank lookup answered it). Each is a statement Teja signs; a bank row must never sign it for him, attested or not.
//
// The labels below are the REAL ones, read from the captured boards-api question lists, so a test that matched
// nothing would fail on the count assertion instead of passing vacuously (CLAUDE.md §6).
import { expect, test } from 'vitest';
// Reads the captured question lists; the live API is never called from a test.
import { readFileSync } from 'node:fs';
// The planner under test, and the label -> bank key normaliser the bank rows must meet.
import { planFill, questionKey } from '../src/plan-fill.ts';
// The field shape the extractor hands the planner.
import type { FormField } from '../src/extract-fields.ts';
// Type-only: the bank row shape planFill takes.
import type { AnswerBankRow } from '@applyy/shared-types';

// The three Canonical captures committed in 65c810f.
const FORMS = ['canonical-3752633', 'canonical-4857458', 'canonical-5703396'];

// Every question of every Canonical form, as the planner would see it after extraction.
const questions = FORMS.flatMap((form) =>
  // The boards-api list: label, required, and per-field name/type/options.
  (JSON.parse(readFileSync(`fixtures/greenhouse/${form}-questions.json`, 'utf8')) as {
    questions: { label: string; required: boolean; fields: { name: string; type: string; values: string[] }[] }[];
  }).questions.map((q) => ({
    // The DOM id Greenhouse gives the control: the field name.
    id: q.fields[0]!.name,
    // The label exactly as the form shows it.
    label: q.label,
    // Required-ness drives refuse(): only a required gap blocks.
    required: q.required,
    // The option texts, used to give each declaration the answer a bot would pick.
    values: q.fields[0]!.values,
  })),
);

// The six declarations, picked by their exact wording (two per form), so a change in the capture fails here loudly.
const DECLARATIONS = questions.filter(
  // The no-AI "own words" declaration, and the privacy-notice acknowledgement.
  (q) => q.label.startsWith('During this application process I agree to use only my own words') || q.label.startsWith('Please confirm that you have read and agree to'),
);

// A Greenhouse custom dropdown as the extractor returns it: a react-select combobox with no options read.
const asCombobox = (q: { id: string; label: string; required: boolean }): FormField =>
  // options absent: react-select renders them only when opened (extract-fields.ts), exactly as on the live page.
  ({ id: q.id, label: q.label, kind: 'combobox', required: q.required }) as FormField;

// One ATTESTED bank row in the live shape: the strongest answer a row can carry.
const attested = (question_key: string, answer_value: unknown) =>
  // attested_by_human true: the row passes attestedRow(), so only the declaration rule can stop it.
  ({ question_key, answer_value, needs_human: false, answer_type: 'text', attested_by_human: true }) as unknown as AnswerBankRow;

test('the fixtures hold exactly six required declarations (non-vacuous guard)', () => {
  // Two per form; fewer means the capture changed and the tests below would prove nothing.
  expect(DECLARATIONS.length).toBe(6);
  // All required: an optional one is silently left blank by refuse(), which would hide the bug.
  expect(DECLARATIONS.every((q) => q.required)).toBe(true);
});

test('a required declaration is refused as human_only even with an attested "Yes" / "Acknowledge/Confirm" row', () => {
  // Each declaration gets the exact option a bot would pick: the first ("Yes" or "Acknowledge/Confirm").
  // ONE row per unique key: the three forms share both labels, and duplicate rows would refuse as
  // ambiguous_answer_key on revert, hiding whether the declaration gate itself is what refuses.
  const bank = [...new Map(DECLARATIONS.map((q) => [questionKey(q.label), q.values[0]])).entries()].map(([key, value]) => attested(key, value));
  // Exactly the two distinct declarations, or the isolation above is not what this test thinks.
  expect(bank.length).toBe(2);
  // Planned against all six at once; the employer is the posting's company.
  const plan = planFill(DECLARATIONS.map(asCombobox), bank, null, 'Canonical');
  // Nothing is filled: no row may sign a declaration.
  expect(plan.fills).toEqual([]);
  // Every declaration goes to Teja, as human_only (the Manual-lane reason), never another reason.
  expect(plan.blockers.map((b) => [b.id, b.reason])).toEqual(DECLARATIONS.map((q) => [q.id, 'human_only']));
  // So the row can never submit.
  expect(plan.canProceed).toBe(false);
});

test('no over-blocking: plain Canonical questions with attested rows still fill', () => {
  // A yes/no commitment question that is NOT a declaration, and a text question whose label says "understand"
  // ("...to help us understand your result"), which must not be mistaken for "I understand".
  const plain = questions.filter(
    // The travel commitment dropdown, and the degree-result text answer, from the first form.
    (q) => q.id === 'question_37390423' || q.id === 'question_37328971',
  );
  // Both found, or this test would pass on an empty plan.
  expect(plain.length).toBe(2);
  // The degree result is a free-text input on the form; the travel one is a dropdown.
  const isText = (id: string): boolean => id === 'question_37328971';
  // Each field in its real kind.
  const fields = plain.map((q) => (isText(q.id) ? ({ ...asCombobox(q), kind: 'text' } as FormField) : asCombobox(q)));
  // An attested answer for each, keyed to its own label.
  const bank = plain.map((q) => attested(questionKey(q.label), isText(q.id) ? '8.0/10' : 'Yes'));
  // Same call shape as the applier.
  const plan = planFill(fields, bank, null, 'Canonical');
  // Both fill; nothing blocks.
  expect(plan.blockers).toEqual([]);
  // Sorted ids, so DOM order does not matter.
  expect(plan.fills.map((f) => f.id).sort()).toEqual(['question_37328971', 'question_37390423']);
});

test('a dropdown that offers exactly ONE option is a signature, not a choice: refused even with a neutral label', () => {
  // A declaration worded with none of the declaration verbs; its single option is the only shape that betrays it.
  const field = { id: 'q_notice', label: 'Recruitment Privacy Notice', kind: 'native_select', required: true, options: ['I have read it'] } as FormField;
  // An attested row holding that very option.
  const plan = planFill([field], [attested(questionKey(field.label), 'I have read it')], null, 'Canonical');
  // Refused for Teja, not filled.
  expect(plan.blockers.map((b) => [b.id, b.reason])).toEqual([['q_notice', 'human_only']]);
});

// Declarations a reviewer probe saw FILLED on 2026-11-09 after the first cut: none uses the agree/confirm verbs.
const PROBES = [
  'I have read and understood the Terms and Conditions',
  'Certification of Accuracy',
  'Recruitment Privacy Notice',
  'Acknowledgements',
  'Signature',
  'I hereby state that the information above is true',
];

// Every probe, as a Greenhouse react-select (no options read) and as a plain text input, from both row kinds.
for (const label of PROBES) {
  // The two field shapes a declaration arrives in when its options are unknown at plan time.
  for (const kind of ['combobox', 'text'] as const) {
    // An attested row (Teja's own) and an unattested one (machine-written): neither may sign.
    for (const attestedByHuman of [true, false]) {
      test(`declaration "${label}" as ${kind}, ${attestedByHuman ? 'attested' : 'unattested'} row -> human_only`, () => {
        // Required, so a refusal is a blocker the test can see (an optional one is silently left blank).
        const field = { id: 'q_decl', label, kind, required: true } as FormField;
        // The bank row a bot would sign with, keyed to the label itself.
        const row = { ...attested(questionKey(label), 'Yes'), attested_by_human: attestedByHuman } as unknown as AnswerBankRow;
        // One field, one row.
        const plan = planFill([field], [row], null, 'Canonical');
        // Not filled, and refused for Teja.
        expect(plan.fills).toEqual([]);
        // human_only: the Manual-lane reason.
        expect(plan.blockers.map((b) => b.reason)).toEqual(['human_only']);
      });
    }
  }
}

test('no over-blocking: "employment agreements" (plural and singular) stays answerable from the attested row', () => {
  // The restrictions question in both noun forms ELIGIBILITY_TEMPLATES accepts; "agreement" is not a declaration token.
  const labels = [
    'Are you subject to any employment agreements and/or post-employment restrictions with your current employer or a past employer?',
    'Are you subject to any employment agreement?',
  ];
  // Teja's attested "None" (the console's employment_restrictions key) answers both as "No".
  const plan = planFill(
    // Two required dropdowns offering Yes/No.
    labels.map((label, i) => ({ id: `q${i}`, label, kind: 'native_select', required: true, options: ['Yes', 'No'] }) as FormField),
    [attested('employment_restrictions', 'None')],
    null,
    'Canonical',
  );
  // Both filled "No", nothing blocked.
  expect(plan.blockers).toEqual([]);
  // In field order.
  expect(plan.fills.map((f) => [f.id, f.value])).toEqual([['q0', 'No'], ['q1', 'No']]);
});

test('a placeholder option ("Select...") does not hide a one-answer declaration', () => {
  // A native select whose placeholder has value="-1", so extraction keeps it as an option.
  const field = { id: 'q_ph', label: 'Recruitment notice', kind: 'native_select', required: true, options: ['Select...', 'I have read it'] } as FormField;
  // Attested row with the one real answer.
  const plan = planFill([field], [attested(questionKey(field.label), 'I have read it')], null, 'Canonical');
  // Still refused: one real option is a signature.
  expect(plan.blockers.map((b) => [b.id, b.reason])).toEqual([['q_ph', 'human_only']]);
});
