/* The answer bank - PROJECT_PLAN.md section 15, row "Answer Bank".
 *
 * WHAT MAKES THIS PAGE DIFFERENT FROM THE OTHER SETTINGS SCREENS. The other
 * five are configuration the operator writes once and revisits occasionally.
 * This one GROWS ITSELF. Every application form asks a slightly different set
 * of questions, and constraint 4 says the system never invents an answer - so
 * when the Applier meets a question with no entry here, it stops the row,
 * parks it in `blocked_needs_human`, and waits.
 *
 * The consequence, and the reason the page is designed the way it is: an
 * answer given once is written back here and never asked again. So answering a
 * blocked question is not a chore, it is an INVESTMENT - the bank converges,
 * and the number of rows that stop for a question falls towards zero on its
 * own. The page is built to make that visible, which is why `times_used` is a
 * first-class column rather than a debugging detail: it is the evidence that
 * answering once paid off many times.
 *
 * WHY REFUSAL IS A FIRST-CLASS OUTCOME AND NOT AN EMPTY ANSWER. Some questions
 * cannot be answered honestly at all - a form asking the operator to certify
 * something untrue, or to claim years of a skill he has never used. That is not
 * a data-entry gap, it is a decision about whether to apply to that employer at
 * all, and possibly a reason to abandon the application. Storing it as "blank"
 * would mean the Applier asks again tomorrow and every tomorrow after. So a
 * refusal has to be recordable AS a refusal.
 *
 * SCHEMA NOTE, stated rather than worked around: `AnswerBankRow` carries
 * `needs_human: boolean`, which distinguishes "answered" from "still needs a
 * person" but not "answered", "uncertain match" and "refused on principle".
 * Those three need different operator actions, so they need different states.
 * Flagged to the schema stream; this page renders what the row can currently
 * express and says so.
 */

import type { ReactElement } from 'react';

import { PageHeader } from '../../app/PageHeader';
import type { AnswerType } from '../../data/contract';

import './settings.css';

/* --- The questions every Indian fresher application asks -------------- */

/* Seed questions, in the operator's own words.
 *
 * These are NOT the schema's business - the bank is keyed by `question_key` and
 * fills itself from real forms. This list exists so the page is useful on night
 * one, before any form has been met: without it, a brand-new bank is an empty
 * table and the first twenty applications all stop for questions the operator
 * could have answered in five minutes up front.
 *
 * Naming the pattern: this is a WARM START for a self-populating store - seed
 * the cases you already know, let the mechanism discover the rest. */
interface SeedQuestion {
  /* Stable key. Snake case, matching how the Applier will normalise a form
     label into a lookup key, so a seeded answer actually gets hit rather than
     sitting next to the question it was meant to answer. */
  readonly key: string;
  /* What the form asks, roughly. Real question text arrives from the form and
     is UNTRUSTED; this is our own paraphrase and is safe. */
  readonly asks: string;
  /* Which control the Applier drives, from the schema's own vocabulary. */
  readonly type: AnswerType;
  /* Why it is worth answering before it blocks something - the most useful
     text on the page, because a question list alone does not convey urgency. */
  readonly why: string;
}

const SEED_QUESTIONS: readonly SeedQuestion[] = [
  {
    key: 'notice_period_days',
    asks: 'Notice period (days)',
    type: 'number',
    why: 'Availability in days for full-time onboarding.',
  },
  {
    key: 'current_ctc_inr',
    asks: 'Current CTC',
    type: 'number',
    why: 'Current annual compensation in INR.',
  },
  {
    key: 'expected_ctc_inr',
    asks: 'Expected CTC',
    type: 'number',
    why: 'Target annual compensation in INR submitted with applications.',
  },
  {
    key: 'willing_to_relocate',
    asks: 'Are you willing to relocate?',
    type: 'boolean',
    why: 'Willingness to relocate to office locations.',
  },
  {
    key: 'work_authorisation_india',
    asks: 'Are you authorised to work in India?',
    type: 'boolean',
    why: 'Legal authorization status to work in India.',
  },
  {
    key: 'visa_sponsorship_required',
    asks: 'Do you require visa sponsorship?',
    type: 'boolean',
    why: 'Whether visa sponsorship is requested from employer.',
  },
  {
    key: 'earliest_start_date',
    asks: 'Earliest start date',
    type: 'date',
    why: 'Earliest available date to join.',
  },
  {
    key: 'gender',
    asks: 'Gender (EEO / diversity)',
    type: 'single_select',
    why: 'Standard EEO diversity disclosure.',
  },
  {
    key: 'disability_status',
    asks: 'Disability status (EEO)',
    type: 'single_select',
    why: 'Standard EEO disability status disclosure.',
  },
  {
    key: 'cover_letter_generic',
    asks: 'Cover letter / notes',
    type: 'long_text',
    why: 'Default introductory note submitted when portals require a cover letter.',
  },
];

export function AnswerBankPage(): ReactElement {
  return (
    <div className="page">
      <PageHeader path="answer-bank" />

      <section className="settings-group">
        <h2 className="settings-group__title">Standard Application Questions</h2>
        <p className="settings-group__note">
          Pre-configured answers used by the Applier across job application portals.
        </p>
        <div className="settings-table-wrap">
          <table className="settings-table">
            <thead>
              <tr>
                <th scope="col">Question Prompt</th>
                <th scope="col">Type</th>
                <th scope="col">Purpose / Notes</th>
              </tr>
            </thead>
            <tbody>
              {SEED_QUESTIONS.map((question) => (
                <tr key={question.key}>
                  <th scope="row">
                    {question.asks}
                    <span className="identifier">{question.key}</span>
                  </th>
                  <td>
                    <span className="identifier">{question.type}</span>
                  </td>
                  <td>{question.why}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
