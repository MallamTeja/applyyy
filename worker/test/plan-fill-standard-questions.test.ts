// Greenhouse's STANDARD questions answered from the master, and opinion questions held
// for Teja's attested answer (2026-10-24 addendum).
//
// THE EVIDENCE: live runs on 2026-10-24 parked Sigma (428f6cbc) on "Location (City)",
// "School", "Degree", "Personal Pronouns", "Are you open to working 4 days onsite…", and
// Perpay (634f6f48) on "What excites you about this opportunity?", "I understand this is
// an in-person role in Philadelphia, PA.", a visa question. The first three are FACTS the
// master already holds; the rest are opinions, preferences or legal facts that only Teja
// may state. The labels below are copied from those block_detail lists.
import { describe, expect, test } from 'vitest';
import type { AnswerBankRow, MasterProfile } from '@applyy/shared-types';
import type { FormField } from '../src/extract-fields.ts';
import { planFill } from '../src/plan-fill.ts';

/** A bank row; `attested` defaults to true, as the console writes it. */
function row(question_key: string, answer_value: unknown, attested: unknown = true): AnswerBankRow {
  return { question_key, answer_value, needs_human: false, answer_type: 'text', attested_by_human: attested } as unknown as AnswerBankRow;
}

/** A required control with Greenhouse's label; comboboxes carry no readable options. */
function field(label: string, kind: FormField['kind'] = 'combobox'): FormField {
  return { id: 'q', label, kind, required: true };
}

/** The master's education and location, shaped as the live v3 profile (MasterEducation keys). */
const master = {
  identity: { full_name: 'Teja Mallam', headline: null, email: 'tejamallam00@gmail.com', phone: '9392256662', location: 'Hyderabad, India', links: [] },
  education: [
    { id: 'ed1', institution: 'Vardhaman College of Engineering', degree: 'Bachelor of Technology', field: 'Computer Science' },
    // A second entry, to prove only education[0] (the first in document order) is read.
    { id: 'ed2', institution: 'Some Junior College', degree: 'Intermediate', field: 'MPC' },
  ],
  experience: [],
} as unknown as MasterProfile;

/** One field planned alone: its fill (value + source) or its refusal reason. */
function one(f: FormField, answers: readonly AnswerBankRow[] = [], profile: MasterProfile | null = master) {
  const plan = planFill([f], answers, profile, null);
  return { fill: plan.fills[0] ? { value: plan.fills[0].value, source: plan.fills[0].source } : null, reason: plan.blockers[0]?.reason ?? null };
}

describe('standard Greenhouse questions come from the master', () => {
  test('School is education[0].institution', () => {
    expect(one(field('School'))).toEqual({ fill: { value: 'Vardhaman College of Engineering', source: 'profile' }, reason: null });
  });

  test('Degree is education[0].degree', () => {
    expect(one(field('Degree'))).toEqual({ fill: { value: 'Bachelor of Technology', source: 'profile' }, reason: null });
  });

  test('Discipline is education[0].field', () => {
    expect(one(field('Discipline'))).toEqual({ fill: { value: 'Computer Science', source: 'profile' }, reason: null });
  });

  test('Location (City) is the city part of identity.location', () => {
    expect(one(field('Location (City)'))).toEqual({ fill: { value: 'Hyderabad', source: 'profile' }, reason: null });
  });

  test('a missing value is refused, never invented (§6)', () => {
    // No education at all: School has nothing to copy.
    const noEducation = { ...master, education: [] } as unknown as MasterProfile;
    expect(one(field('School'), [], noEducation)).toEqual({ fill: null, reason: 'no_answer' });
    // A null field of study: Discipline is refused, not filled with "null".
    const noField = { ...master, education: [{ id: 'e', institution: 'X', degree: 'Y', field: null }] } as unknown as MasterProfile;
    expect(one(field('Discipline'), [], noField)).toEqual({ fill: null, reason: 'no_answer' });
  });
});

describe('opinion and preference questions wait for an ATTESTED answer', () => {
  // Every one of these was in the live block_detail lists.
  const opinions = [
    'Personal Pronouns',
    'Are you open to working 4 days onsite in our New York office?',
    'What excites you about this opportunity?',
    'I understand this is an in-person role in Philadelphia, PA.',
  ];

  test.each(opinions)('"%s" stays unanswered with no bank row, even with a full profile', (label) => {
    expect(one(field(label, 'textarea'))).toEqual({ fill: null, reason: 'human_only' });
  });

  test.each(opinions)('"%s" is NOT filled from an unattested bank row', (label) => {
    // A row a machine wrote (attested_by_human false) keyed exactly to the label.
    const key = label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
    expect(one(field(label, 'textarea'), [row(key, 'some text', false)])).toEqual({ fill: null, reason: 'human_only' });
  });

  test.each(opinions)('"%s" IS filled from Teja\'s attested answer, verbatim', (label) => {
    const key = label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
    expect(one(field(label, 'textarea'), [row(key, 'Teja wrote this')])).toEqual({ fill: { value: 'Teja wrote this', source: 'answer_bank' }, reason: null });
  });

  test('an unscoped visa question stays with Teja (eligibility templates, unchanged)', () => {
    expect(one(field('Will you now or in the future require visa sponsorship?', 'radio_group'))).toEqual({ fill: null, reason: 'human_only' });
  });
});
