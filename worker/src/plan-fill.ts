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
// Type-only imports: erased at compile time, so the planner stays free of runtime deps.
import type { AnswerBankRow, MasterProfile } from '@applyy/shared-types';
import type { FormField } from './extract-fields.ts';
// One shared normaliser (defined beside the profile table that also needs it).
import { normaliseKey, resolveProfileAnswer } from './profile-answers.ts';

// Re-exported so existing and future callers can reach the normaliser from the planner.
export { normaliseKey };

// Legal / self-disclosure / consent question fragments, matched as SUBSTRINGS of the
// normalised label. Substring is deliberate: over-matching sends more questions to the
// human, which is the safe direction. Checked FIRST, before the bank or the profile, so even
// a stored answer cannot auto-fill these. It must not catch factual questions such as
// "current country of residence" or "primary programming language" (hence no bare "age").
// Judgement items (relocation, pronouns, salary expectation) are NOT legal disclosures and
// stay answerable from the bank.
const HUMAN_ONLY_FRAGMENTS: readonly string[] = [
  // Work authorisation, sponsorship and immigration status.
  'sponsor', 'visa', 'work_authori', 'authorized_to_work', 'authorised_to_work',
  'right_to_work', 'eligible_to_work', 'allowed_to_work', 'work_permit', 'immigration',
  'citizen', 'nationality', 'located_in',
  // Contractual restrictions and prior-employer relationships.
  'employment_agreement', 'post_employment', 'non_compete', 'restrictive_covenant',
  'previously_worked', 'worked_at', 'worked_for', 'consulted_for', 'former_employee',
  // Protected-class self-identification (EEO); 'disab' also catches "disabled".
  // 'caste' because Indian forms ask it in place of (or beside) race.
  'gender', 'race', 'caste', 'ethnicity', 'hispanic', 'latino', 'veteran', 'disab', 'sexual_orientation',
  'transgender', 'lgbt', 'religio', 'marital', 'pregnan', 'date_of_birth', 'your_age', 'what_is_your_age',
  // Criminal history, clearance and consent to checks.
  'criminal', 'convicted', 'felony', 'conviction', 'security_clearance',
  'background_check', 'drug_test',
  // Pay history (illegal to ask in some jurisdictions, and a binding statement either way).
  'salary_history', 'current_salary', 'previous_salary', 'pay_history',
  // Consent and attestation ("I consent to...", "I certify that the above is true"): agreeing
  // or swearing to something is a decision only Teja can make, so a bank row must not make it.
  'consent', 'certify', 'attest',
];

/** One field the planner is confident it may fill, and the value to type. */
export interface PlannedFill {
  // DOM id, used to build the selector at fill time.
  readonly id: string;
  // The value copied (trimmed) from the answer bank or a profile field. Never composed or inferred.
  readonly value: string;
  // The extracted control kind, carried so planning, tests and reports can see which fill
  // method applies. The live filler re-detects the element itself, because the page
  // interface `fill(id, value)` is shared with apply-one.ts and assist/ (not this module's).
  readonly kind: FormField['kind'];
  // Where the value came from, so a report can tell a human-saved answer from a profile copy.
  readonly source: 'answer_bank' | 'profile';
}

/** One required question the system refuses to answer on its own. */
export interface FillBlocker {
  // DOM id of the offending control.
  readonly id: string;
  // The human question text, so the dashboard can show Teja what to answer.
  readonly label: string;
  // Why it blocked. Distinguishes "never seen this question" from "the answer
  // bank has a placeholder", which are different actions for the human.
  readonly reason:
    // No source has an answer for this label.
    | 'no_answer'
    // A bank row exists but is marked needs_human.
    | 'awaiting_human_answer'
    // A legal/self-disclosure question (visa, authorisation, EEO...). NEVER auto-filled, even
    // with a bank row: only Teja may assert these facts on a real application.
    | 'human_only'
    // A bank row exists but its value is not a non-empty string or finite number. Typing it
    // would turn missing data into an answer (e.g. the literal text "null").
    | 'invalid_answer'
    // Two bank keys normalise to the same string, so which one applies is ambiguous.
    | 'ambiguous_answer_key'
    // A select/radio answer that matches none of the field's option labels exactly.
    | 'no_matching_option';
}

/** The complete decision for one application form. */
export interface FillPlan {
  readonly fills: readonly PlannedFill[];
  readonly blockers: readonly FillBlocker[];
  // False means park the row at `blocked_needs_human` rather than submitting.
  readonly canProceed: boolean;
}


/** Accept only a non-empty trimmed string or a finite number; anything else is not an answer. */
function answerText(value: unknown): string | null {
  // Numbers print as themselves ("42"); NaN/Infinity are not answers, so they are refused.
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : null;
  // jsonb may hold null, booleans, arrays or objects, which must never be typed (e.g. "null").
  if (typeof value !== 'string') return null;
  // Whitespace-only is blank, so trim before testing emptiness.
  const trimmed = value.trim();
  // Empty collapses to null: one "not an answer" shape for the caller.
  return trimmed === '' ? null : trimmed;
}

export function planFill(
  fields: readonly FormField[],
  answers: readonly AnswerBankRow[],
  // Defaulted to null so every pre-profile caller keeps compiling and simply gets no profile fills.
  profile: MasterProfile | null = null,
): FillPlan {
  // Index the bank once by normalised key; a linear scan per field would be
  // quadratic on forms that already carry 20+ questions.
  const byKey = new Map<string, AnswerBankRow>();
  // Keys whose normalised form was claimed twice, so "last one wins" can never pick silently.
  const collisions = new Map<string, readonly [string, string]>();
  for (const row of answers) {
    // Stored keys are normalised the same way as labels so the two can meet.
    const key = normaliseKey(row.question_key);
    // A hit here means two rows claim one question and we cannot tell which is right.
    const earlier = byKey.get(key);
    // Record both raw keys so the blocker can name them for the human.
    if (earlier !== undefined) collisions.set(key, [earlier.question_key, row.question_key]);
    // Still indexed, so the collision check (not map order) is what decides the outcome.
    byKey.set(key, row);
  }

  // Accumulators, built in one pass over the form.
  const fills: PlannedFill[] = [];
  const blockers: FillBlocker[] = [];

  for (const formField of fields) {
    // File inputs are the resume and cover letter; they are supplied by the PDF pipeline
    // rather than the answer bank, so they are not the planner's business and must not be
    // reported as unanswerable.
    if (formField.kind === 'file') continue;

    // Shorthand for the one blocker shape every refusal below shares.
    const refuse = (reason: FillBlocker['reason'], label: string = formField.label): void => {
      // An optional gap is harmless: a blank "LinkedIn Profile" costs nothing, whereas
      // blocking on it would park applications for no reason and drown the human queue in
      // noise until Teja stops reading it.
      if (!formField.required) return;
      // A required gap stops the application. This is the constraint #4 branch, and the
      // deliberate absence of any fallback here IS the guarantee.
      blockers.push({ id: formField.id, label, reason });
    };

    // Look the question up by its human label, which is the only stable identifier on
    // forms whose ids are opaque (question_36622854002).
    const key = normaliseKey(formField.label);

    // DENYLIST FIRST: legal and self-disclosure facts are only ever asserted by Teja himself,
    // so no stored answer may reach them.
    if (HUMAN_ONLY_FRAGMENTS.some((fragment) => key.includes(fragment))) {
      refuse('human_only');
      continue;
    }

    // A checkbox has no safe text value, and the live filler throws on it late, after other
    // fields were already typed. Refusing here keeps the failure early and visible.
    if (formField.kind === 'checkbox') {
      refuse('human_only');
      continue;
    }

    // Decided below by exactly one source; `let` because the branches assign it.
    let value: string;
    let source: PlannedFill['source'];

    // Both lookups up front so the branches read as a plain priority order.
    const collision = collisions.get(key);
    const match = byKey.get(key);
    if (collision !== undefined) {
      // Which of two rows applies is unknowable; refuse and name both keys for the human.
      refuse('ambiguous_answer_key', `${formField.label} (ambiguous answer_bank keys: "${collision[0]}" and "${collision[1]}")`);
      continue;
    } else if (match !== undefined) {
      // A row exists but is a placeholder awaiting a human answer. Treating the mere
      // presence of a row as "answered" would type an empty or placeholder value into a
      // real application, which is worse than not applying at all.
      if (match.needs_human) {
        refuse('awaiting_human_answer');
        continue;
      }
      // Shape check: answer_value is jsonb, and null/boolean/array must never become the
      // literal text "null" or "true" in a real application.
      const text = answerText(match.answer_value);
      if (text === null) {
        refuse('invalid_answer');
        continue;
      }
      // The human-saved answer wins over the profile: it is the more deliberate statement.
      value = text;
      source = 'answer_bank';
    } else {
      // No bank row: try the profile's closed synonym table, which only knows plain facts.
      const fromProfile = resolveProfileAnswer(formField, profile);
      if (fromProfile === null) {
        // Nothing knows this question; refuse rather than invent (constraint #4).
        refuse('no_answer');
        continue;
      }
      // A plain profile fact, tagged so reports can tell it from a human-saved answer.
      value = fromProfile;
      source = 'profile';
    }

    // A select/radio can only take one of its own options, exactly; never approximate.
    if (formField.options !== undefined && !formField.options.includes(value)) {
      refuse('no_matching_option');
      continue;
    }

    // Copied, trimmed, never composed: the planner never rewords, rounds or reformats,
    // because any transformation could change the meaning of a statement Teja signs.
    fills.push({ id: formField.id, value, kind: formField.kind, source });
  }

  return {
    fills,
    blockers,
    // A single unanswerable required question is enough to stop the whole application.
    // Partial submission is not an option: an ATS form sent with a required field blank is
    // either rejected or, worse, accepted incomplete.
    canProceed: blockers.length === 0,
  };
}
