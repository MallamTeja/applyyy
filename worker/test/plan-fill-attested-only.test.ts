// T8 (2026-11-10): the bot fills a plain question ONLY from an answer Teja attested.
//
// answer_bank.attested_by_human is stamped by a trigger (migration 20261009160000): true only
// for a signed-in browser save with no agent key. Rows a machine wrote (an agent, the SQL
// editor, an orchestrator's DB session) land false. Before T8 the plain lookup in planFill
// ignored the column, so an unattested row typed straight into a live application. These
// tests pin the default-deny rule: an unattested row counts as NO row.
import { describe, expect, test } from 'vitest';
// Types come from the shared schema, never a local copy that could drift from the table.
import type { AnswerBankRow, MasterProfile } from '@applyy/shared-types';
// The worker's own extracted-field shape.
import type { FormField } from '../src/extract-fields.ts';
// Subject under test.
import { planFill } from '../src/plan-fill.ts';

/** A bank row with the four columns the planner reads, plus the attestation flag under test. */
function row(question_key: string, answer_value: unknown, attested: boolean | undefined): AnswerBankRow {
  // undefined leaves the key OUT, the shape a select that skipped the column would return.
  const flag = attested === undefined ? {} : { attested_by_human: attested };
  // Cast at the boundary: spelling out every column would hide which one each case is about.
  return { question_key, answer_value, needs_human: false, answer_type: 'text', ...flag } as unknown as AnswerBankRow;
}

/** A plain text field; required decides whether a miss parks the application. */
function field(id: string, label: string, required = true): FormField {
  // Text kind keeps option matching out of these cases.
  return { id, label, kind: 'text', required };
}

// A master profile that knows the email and nothing about notice period.
const profile = {
  // The resolver reads only identity; the rest of the master is irrelevant here.
  identity: { full_name: 'Teja Mallam', email: 'profile@example.com', phone: '', location: '', links: [] },
} as unknown as MasterProfile;

describe('planFill: only a human-attested answer_bank row may fill a field (T8)', () => {
  test('an UNATTESTED-only match parks as no_answer and types nothing', () => {
    // The live shape on 2026-11-10: a row a machine wrote, attested_by_human = false.
    const plan = planFill([field('np', 'Notice Period')], [row('notice_period', 'Immediate Joiner', false)]);
    // Nothing is typed: an answer Teja never confirmed must not reach a live form.
    expect(plan.fills).toEqual([]);
    // The field goes to the human through the existing park path, as a reusable fact card.
    expect(plan.blockers.map((b) => [b.label, b.reason])).toEqual([['Notice Period', 'no_answer']]);
    // A required blocker parks the whole application.
    expect(plan.canProceed).toBe(false);
  });

  test('an ATTESTED match still fills verbatim from the answer bank', () => {
    // The positive shape: without it, "refuse everything" would pass the test above.
    const plan = planFill([field('np', 'Notice Period')], [row('notice_period', 'Immediate Joiner', true)]);
    // Teja's saved answer, word for word, tagged as a bank answer.
    expect(plan.fills).toEqual([{ id: 'np', value: 'Immediate Joiner', kind: 'text', source: 'answer_bank' }]);
    // No blocker: the application can go ahead.
    expect(plan.canProceed).toBe(true);
  });

  test('a row WITHOUT the column is unattested (strict true, never "missing means fine")', () => {
    // A lenient reader would treat an absent flag as usable; repo §6 calls that fail-open.
    const plan = planFill([field('np', 'Notice Period')], [row('notice_period', 'Immediate Joiner', undefined)]);
    // Same outcome as an explicit false.
    expect(plan.blockers.map((b) => b.reason)).toEqual(['no_answer']);
    // And nothing typed.
    expect(plan.fills).toEqual([]);
  });

  test('an unattested row does not shadow the profile: the profile fact fills instead', () => {
    // The unattested row disagrees with the master profile; only the profile is Teja's own statement.
    const plan = planFill([field('em', 'Email')], [row('email', 'machine@example.com', false)], profile);
    // The profile value wins, and the source says so.
    expect(plan.fills).toEqual([{ id: 'em', value: 'profile@example.com', kind: 'text', source: 'profile' }]);
    // A plain profile fact needs no human.
    expect(plan.canProceed).toBe(true);
  });

  test('an unattested PLACEHOLDER keeps its awaiting_human_answer reason', () => {
    // The unanswered-questions hook writes placeholders; the check order keeps their reason stable.
    const placeholder = { ...row('notice_period', '', false), needs_human: true } as unknown as AnswerBankRow;
    // Planned against the placeholder alone.
    const plan = planFill([field('np', 'Notice Period')], [placeholder]);
    // Still "waiting for Teja's answer", not re-labelled as a missing one.
    expect(plan.blockers.map((b) => b.reason)).toEqual(['awaiting_human_answer']);
  });

  test('an attested row colliding with an unattested one stays ambiguous, never "the attested one wins"', () => {
    // Two spellings that normalise to one key: which one Teja meant is still unknowable.
    const rows = [row('notice_period', 'Immediate', true), row('Notice Period?', '30 days', false)];
    // Planned against both.
    const plan = planFill([field('np', 'Notice Period')], rows);
    // The existing collision refusal holds; attestation does not pick a side.
    expect(plan.blockers.map((b) => b.reason)).toEqual(['ambiguous_answer_key']);
    // And nothing typed.
    expect(plan.fills).toEqual([]);
  });

  test('an unattested match on an OPTIONAL field leaves it blank without parking', () => {
    // Optional misses never park (plan-fill.test.ts pins that); attestation must not change it.
    const plan = planFill([field('np', 'Notice Period', false)], [row('notice_period', 'Immediate Joiner', false)]);
    // Blank, not typed.
    expect(plan.fills).toEqual([]);
    // And the application still proceeds.
    expect(plan.canProceed).toBe(true);
  });
});
