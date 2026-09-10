// Decides what to type into an application form — and, more importantly, when
// to refuse and ask a human instead.
//
// CONSTRAINT #4: DON'T guess when an application question cannot be answered
// from the user's profile. Constraint #3: DON'T falsely answer job-application
// questions. This module is where both are enforced, and it is the last code
// between an automated system and a false statement submitted in Teja's name on
// a real job application.
//
// The design follows PROJECT_PLAN.md §10's first defense: PREFER A DESIGN WHERE
// THE WRONG ANSWER CANNOT BE EXPRESSED. The planner has no code path that
// invents a value. It can only copy an answer that a human already supplied, or
// report a blocker. There is no third branch to get wrong.
import type { AnswerBankRow } from '@applyy/shared-types';
import type { FormField } from './extract-fields.ts';

/** One field the planner is confident it may fill, and the value to type. */
export interface PlannedFill {
  // DOM id, used to build the selector at fill time.
  readonly id: string;
  // The value copied verbatim from the answer bank. Never composed or inferred.
  readonly value: string;
}

/** One required question the system refuses to answer on its own. */
export interface FillBlocker {
  // DOM id of the offending control.
  readonly id: string;
  // The human question text, so the dashboard can show Teja what to answer.
  readonly label: string;
  // Why it blocked. Distinguishes "never seen this question" from "the answer
  // bank has a placeholder", which are different actions for the human.
  readonly reason: 'no_answer' | 'awaiting_human_answer';
}

/** The complete decision for one application form. */
export interface FillPlan {
  readonly fills: readonly PlannedFill[];
  readonly blockers: readonly FillBlocker[];
  // False means park the row at `blocked_needs_human` rather than submitting.
  readonly canProceed: boolean;
}

/**
 * Reduce a label or a stored key to a comparable form.
 *
 * ATS labels vary cosmetically ("First Name", "first name*", "First  Name:")
 * while the answer bank stores one normalised key. Without this, every form
 * would miss on punctuation and route to a human — which is the same end state
 * as having no answer bank at all, and would make the queue useless by volume.
 */
function normaliseKey(text: string): string {
  return (
    text
      .toLowerCase()
      // Any run of non-alphanumeric characters becomes a single underscore, so
      // spaces, colons, asterisks and double spaces all collapse identically.
      .replace(/[^a-z0-9]+/g, '_')
      // Trim the underscores those substitutions leave at the ends.
      .replace(/^_+|_+$/g, '')
  );
}

export function planFill(
  fields: readonly FormField[],
  answers: readonly AnswerBankRow[],
): FillPlan {
  // Index the bank once by normalised key; a linear scan per field would be
  // quadratic on forms that already carry 20+ questions.
  const byKey = new Map<string, AnswerBankRow>();
  for (const row of answers) {
    // Stored keys are normalised the same way as labels so the two can meet.
    byKey.set(normaliseKey(row.question_key), row);
  }

  // Accumulators, built in one pass over the form.
  const fills: PlannedFill[] = [];
  const blockers: FillBlocker[] = [];

  for (const formField of fields) {
    // File inputs are the resume and cover letter; they are supplied by the
    // PDF pipeline rather than the answer bank, so they are not the planner's
    // business and must not be reported as unanswerable.
    if (formField.kind === 'file') continue;

    // Look the question up by its human label, which is the only stable
    // identifier on forms whose ids are opaque (question_36622854002).
    const match = byKey.get(normaliseKey(formField.label));

    // CASE 1 — no answer exists for this question.
    if (match === undefined) {
      // An optional gap is harmless: a blank "LinkedIn Profile" costs nothing,
      // whereas blocking on it would park applications for no reason and drown
      // the human queue in noise until Teja stops reading it.
      if (!formField.required) continue;
      // A required gap stops the application. This is the constraint #4 branch,
      // and the deliberate absence of any fallback here IS the guarantee.
      blockers.push({ id: formField.id, label: formField.label, reason: 'no_answer' });
      continue;
    }

    // CASE 2 — a row exists but is a placeholder awaiting a human answer.
    // aa models this as needs_human on the answer bank. Treating the mere
    // presence of a row as "answered" would type an empty or placeholder value
    // into a real application, which is worse than not applying at all.
    if (match.needs_human) {
      // Optional questions still get skipped rather than blocking the row.
      if (!formField.required) continue;
      blockers.push({
        id: formField.id,
        label: formField.label,
        reason: 'awaiting_human_answer',
      });
      continue;
    }

    // CASE 3 — a real answer. Copied verbatim; the planner never rewords,
    // rounds or reformats, because any transformation is an opportunity to
    // change the meaning of a statement Teja is signing his name to.
    fills.push({ id: formField.id, value: String(match.answer_value) });
  }

  return {
    fills,
    blockers,
    // A single unanswerable required question is enough to stop the whole
    // application. Partial submission is not an option: an ATS form sent with a
    // required field blank is either rejected or, worse, accepted incomplete.
    canProceed: blockers.length === 0,
  };
}
