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
/* The stored-answer shapes, so the page knows which form control the Applier
   will eventually have to drive. Imported, never restated. */
import { ANSWER_TYPES } from '../../data/contract';
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
    asks: 'Notice period',
    type: 'number',
    why: 'Asked by almost every full-time form. As a student the honest answer is usually zero or immediate, and a blank here stops rows for no reason.',
  },
  {
    key: 'current_ctc_inr',
    asks: 'Current CTC',
    type: 'number',
    why: 'Freshers get asked this constantly. Zero is a real and honest answer; leaving it blank means the row stops every time.',
  },
  {
    key: 'expected_ctc_inr',
    asks: 'Expected CTC',
    type: 'number',
    why: 'Worth deciding once, deliberately, rather than under time pressure on a form. The number you type here is the number that goes out on every application.',
  },
  {
    key: 'willing_to_relocate',
    asks: 'Are you willing to relocate?',
    type: 'boolean',
    why: 'Should agree with the location allowlist on the Filters page. If they disagree, one of the two is wrong and applications will be inconsistent with your own filter.',
  },
  {
    key: 'work_authorisation_india',
    asks: 'Are you authorised to work in India?',
    type: 'boolean',
    why: 'Trivial to answer and it appears on nearly every form.',
  },
  {
    key: 'visa_sponsorship_required',
    asks: 'Do you require visa sponsorship?',
    type: 'boolean',
    why: 'Appears on any listing that is not India-only. Wrong here is worse than blank - it is a claim.',
  },
  {
    key: 'earliest_start_date',
    asks: 'Earliest start date',
    type: 'date',
    why: 'Internship forms ask this more often than full-time ones, and it changes every semester, so it is worth a look each term.',
  },
  {
    key: 'gender',
    asks: 'Gender (EEO / diversity)',
    type: 'single_select',
    why: 'Optional on most forms and usually includes a decline-to-state option. Stored so the Applier does not stop for it.',
  },
  {
    key: 'disability_status',
    asks: 'Disability status (EEO)',
    type: 'single_select',
    why: 'Same as above: optional, declinable, and a blank here blocks a row over a question you were never required to answer.',
  },
  {
    key: 'cover_letter_generic',
    asks: 'Cover letter / anything else to add',
    type: 'long_text',
    why: 'A free-text box that stops the automation dead. One honest paragraph stored here clears a whole class of blocked rows - and it goes out as written, because nothing in this system fabricates prose.',
  },
];

/* --- Per-skill years, the one that needs care ------------------------- */

/* Forms ask "how many years of X" for skills that appear in the job
 * description. This is the highest-risk question type in the bank, because a
 * wrong answer here is not a blank - it is a false claim on a real
 * application, in a field the Auditor never sees.
 *
 * So the design rule for this section: a per-skill number is only ever stored
 * for a skill that exists in the master profile. If a form asks about a skill
 * the operator has never used, that is a REFUSAL, not a zero - the honest
 * response is to decline the application, not to answer "0 years of
 * Kubernetes" and hope. This mirrors the Tailor's own guarantee, where a claim
 * that has no master node behind it is unrepresentable rather than merely
 * detected. */
function PerSkillYearsSection(): ReactElement {
  return (
    <section className="settings-group">
      <h2 className="settings-group__title">Years per skill</h2>
      <p className="settings-group__note">
        Forms ask &quot;how many years of X&quot; for whatever the job
        description mentioned. This is the riskiest section in the bank: a wrong
        number here is not a gap, it is a false claim on a live application, in
        a field the Auditor never gets to look at.
      </p>
      <p className="settings-group__note">
        So a number can only be stored against a skill that exists in your
        master profile. A form asking about something you have never touched is
        a reason to decline that application - not a reason to type a zero. Same
        rule the Tailor works under: a claim with nothing behind it should be
        impossible to express, not merely caught later.
      </p>
      <p className="not-wired">
        Reads the skills list from{' '}
        <span className="identifier">master_profiles</span> and the stored years
        from <span className="identifier">answer_bank</span>. Not wired up yet.
      </p>
    </section>
  );
}

/* --- The page --------------------------------------------------------- */

export function AnswerBankPage(): ReactElement {
  return (
    <div className="page">
      <PageHeader path="answer-bank" />

      {/* The honest state, first. Same banner idiom as the other settings
          pages so the operator learns one signal for "laid out, not live". */}
      <p className="not-wired">
        This page is laid out but not yet reading or writing{' '}
        <span className="identifier">answer_bank</span>. The questions below are
        seeds, not stored answers.
      </p>

      {/* The mechanism, explained once and near the top, because it is the
          reason to bother answering anything here. */}
      <section className="settings-group">
        <h2 className="settings-group__title">Why answering here pays off</h2>
        <p className="settings-group__note">
          When the Applier meets a question with no answer in this bank it does
          not guess - it stops the application and parks it for you. Answer it
          once and the answer is written back here, so that question never stops
          another row again. The bank converges: the more you answer, the less
          often anything stops.
        </p>
        <p className="settings-group__note">
          The ten questions below cover most of what Indian fresher application
          forms ask. Answering them before your first run costs about five
          minutes and saves roughly that many blocked rows on night one.
        </p>
      </section>

      {/* The seed list as a table. A table rather than a form because these are
          not yet editable - showing input boxes that discard what you type
          would be worse than showing none. */}
      <section className="settings-group">
        <h2 className="settings-group__title">Questions worth answering up front</h2>
        <div className="settings-table-wrap">
          <table className="settings-table">
            <thead>
              <tr>
                {/* The paraphrase, not the key: this column is for reading. */}
                <th scope="col">The form asks</th>
                {/* The control type, from the schema's vocabulary, so it is
                    obvious which of these is a free-text trap. */}
                <th scope="col">Answer type</th>
                {/* Why it matters. The widest column on purpose. */}
                <th scope="col">Why answer it now</th>
              </tr>
            </thead>
            <tbody>
              {SEED_QUESTIONS.map((question) => (
                /* `key` is the natural key of the row and the same string the
                   Applier will look up, so it is also the stable React key. */
                <tr key={question.key}>
                  <th scope="row">
                    {question.asks}
                    {/* The lookup key shown quietly underneath: when a row
                        blocks on a question, the block detail names this key,
                        and being able to match the two without a database
                        query is worth the visual cost. */}
                    <span className="identifier">{question.key}</span>
                  </th>
                  <td>{question.type}</td>
                  <td>{question.why}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <PerSkillYearsSection />

      {/* The refusal case, given its own section rather than a checkbox on a
          row, because it is a different kind of thing: a decision about an
          employer, not a value. */}
      <section className="settings-group">
        <h2 className="settings-group__title">Questions you will not answer</h2>
        <p className="settings-group__note">
          Some questions cannot be answered honestly - a form asking you to
          certify something untrue, or to claim experience you do not have.
          Recording that as a refusal rather than as a blank matters: a blank
          gets asked again tomorrow, and every tomorrow after.
        </p>
        <p className="settings-group__note">
          A refusal is also information about the employer. If a form cannot be
          completed truthfully, abandoning that application is a legitimate
          outcome, and the system should let you say so once rather than
          re-presenting the same wall every run.
        </p>
        <p className="contract-gap">
          <strong>Schema gap, flagged not invented.</strong>{' '}
          <span className="identifier">answer_bank</span> has{' '}
          <span className="identifier">needs_human: boolean</span>, which
          separates answered from unanswered but cannot express the three states
          that need different actions from you: no answer stored, an answer
          whose match to the question is uncertain, and a question refused on
          principle. Until the schema stream can express those separately, this
          page cannot offer three different controls for them.
        </p>
      </section>

      {/* Kept last and deliberately dry: the full vocabulary, so nothing about
          which control types exist has to be looked up elsewhere. */}
      <section className="settings-group">
        <h2 className="settings-group__title">Answer types the Applier can drive</h2>
        <p className="settings-group__note">
          From the shared schema rather than a list kept on this page, so a type
          added upstream appears here automatically. A stored answer has to
          declare its type, because the Applier drives a select differently from
          a text box and a file upload differently again.
        </p>
        <ul className="cascade">
          {ANSWER_TYPES.map((type) => (
            <li key={type} className="cascade__row">
              <span className="identifier">{type}</span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
