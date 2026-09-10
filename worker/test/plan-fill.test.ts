// Tests for the fill planner — where constraint #4 is enforced.
//
// Constraint #4: DON'T guess when an application question cannot be answered
// from the user's profile. This is the rule that stops an automated system
// putting a false answer on a real job application in Teja's name, and it is
// the reason the planner returns BLOCKERS rather than best guesses.
//
// The planner is deliberately a pure function over already-extracted fields and
// already-fetched answers. Keeping the decision out of the browser and out of
// the database client is what makes every one of these cases cheap to test.
import { describe, expect, test } from 'vitest';
// aa's contract. Imported, never redefined — types derive from the schema, and
// a local copy is how the worker and the database silently drift apart.
import type { AnswerBankRow } from '@applyy/shared-types';
// The worker's own DOM concern; not a database shape, so it lives here.
import type { FormField } from '../src/extract-fields.js';

// Subject under test; absent, which is what makes this file RED.
import { planFill } from '../src/plan-fill.js';

/** Builds an answer-bank row with only the fields the planner actually reads. */
function answer(question_key: string, answer_value: unknown, needs_human = false): AnswerBankRow {
  // Cast at the boundary: the planner reads four fields, and spelling out all
  // eleven in every test would obscure which one each case is about.
  return { question_key, answer_value, needs_human, answer_type: 'text' } as unknown as AnswerBankRow;
}

/** Builds an extracted form field. */
function field(id: string, label: string, required: boolean): FormField {
  // Every planner case turns on label (the lookup key) and required (whether a
  // miss blocks), so those are the only interesting parameters.
  return { id, label, kind: 'text', required };
}

describe('planFill', () => {
  test('fills a field whose question is answered in the answer bank', () => {
    // The happy path: a known question with a real answer.
    const plan = planFill([field('first_name', 'First Name', true)], [answer('first_name', 'Teja')]);
    // The value must come from the bank verbatim; the planner never composes text.
    expect(plan.fills).toEqual([{ id: 'first_name', value: 'Teja' }]);
    // Nothing unanswered means the application can go ahead.
    expect(plan.canProceed).toBe(true);
  });

  test('BLOCKS rather than guessing when a required question is unknown', () => {
    // The constraint #4 case. An ATS asks something the profile has never seen
    // — "What is your current CTC?" on a form where that was never recorded.
    const plan = planFill([field('question_99', 'Expected CTC', true)], []);
    // Critically: no fill is invented. A plausible-looking number here is
    // exactly the falsehood constraint #3 and #4 exist to prevent.
    expect(plan.fills).toEqual([]);
    // The row must stop and wait for a human.
    expect(plan.canProceed).toBe(false);
    // The blocker names the question so the dashboard can show Teja what to answer.
    expect(plan.blockers[0]?.label).toBe('Expected CTC');
  });

  test('BLOCKS when the matching answer is a placeholder awaiting a human', () => {
    // aa models this explicitly as needs_human on the answer bank: a row can
    // exist for a question and still not contain a usable answer. Treating the
    // mere presence of a row as "answered" would submit an empty or placeholder
    // value, which is worse than not applying at all.
    const plan = planFill([field('q1', 'Notice Period', true)], [answer('notice_period', '', true)]);
    // No fill from a placeholder row.
    expect(plan.fills).toEqual([]);
    // Same human-in-the-loop outcome as an entirely unknown question.
    expect(plan.canProceed).toBe(false);
  });

  test('skips an unanswered OPTIONAL field without blocking the application', () => {
    // Not every gap is a stop. A blank optional "LinkedIn Profile" costs
    // nothing, whereas blocking on it would park applications for no reason and
    // make the human queue useless through noise.
    const plan = planFill([field('question_36622854002', 'LinkedIn Profile', false)], []);
    // Nothing to fill, but nothing to escalate either.
    expect(plan.fills).toEqual([]);
    // The application proceeds.
    expect(plan.canProceed).toBe(true);
    // And the optional gap is not reported as a blocker.
    expect(plan.blockers).toEqual([]);
  });

  test('matches questions ignoring case and punctuation differences', () => {
    // ATS label text varies ("First Name", "first name*", "First name:") while
    // the answer bank stores one normalised key. Without normalisation every
    // form would miss on cosmetics and route to a human — the same end state as
    // having no answer bank at all.
    const plan = planFill([field('fn', 'First  Name:', true)], [answer('first_name', 'Teja')]);
    // The normaliser must bridge the cosmetic difference.
    expect(plan.fills).toEqual([{ id: 'fn', value: 'Teja' }]);
  });
});
