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

// Questions only Teja may ever answer himself, matched against the normalised label.
// Checked FIRST, before eligibility, the bank or the profile, so no stored answer, attested
// or not, can reach them. Over-matching sends more questions to the human, which is the safe
// direction. It must not catch factual questions such as "current country of residence" or
// "primary programming language" (hence no bare "age"). Judgement items (relocation,
// pronouns, onsite, motivation) are NOT disclosures: they are answerable, but only from
// Teja's ATTESTED bank row (OPINION_FRAGMENTS below, 2026-10-24).
// SUBSTRING fragments: long enough that a hit inside another word is still a disclosure.
const NEVER_FRAGMENTS: readonly string[] = [
  // (Protected-class self-identification moved to EEO_FRAGMENTS on 2026-10-09: answerable
  // from Teja's attested answers only. Everything still listed here stays never-automatic.)
  // Age and date of birth in every phrasing seen ("Birth date", "Date of birth", "Your age").
  'date_of_birth', 'birth', 'your_age', 'what_is_your_age',
  // Criminal history, clearance and consent to checks.
  'criminal', 'convicted', 'felony', 'conviction', 'security_clearance',
  'background_check', 'drug_test',
  // Pay history (illegal to ask in some jurisdictions, and a binding statement either way).
  'salary_history', 'current_salary', 'previous_salary', 'pay_history',
  // Consent and attestation ("I consent to...", "I certify that the above is true"): agreeing
  // or swearing to something is a decision only Teja can make, so a bank row must not make it.
  'consent', 'certify', 'attest',
];
// WHOLE-TOKEN fragments: too short for substring ("dob" is inside "adobe", "sex" inside
// "essex"), so they refuse only as a separate word.
const NEVER_TOKENS: readonly string[] = ['dob', 'sex'];

// Voluntary self-identification (EEO): gender, race, veteran status and their relatives.
// Until 2026-10-09 these were NEVER answered. Teja then ruled (14:19, via the orchestrator)
// that they may be answered, but ONLY from his own browser-attested answers, never guessed
// and never defaulted to "Decline". A label in this territory is answered only through
// one EEO_TEMPLATES match; anything else (another phrasing, a related question such as
// "gender identity" or "marital status") goes to Teja. These fields are optional on every
// form seen, and an optional refusal is silent, so an unanswered one is LEFT BLANK.
// SUBSTRING fragments: over-matching ("embrace" holds "race") only refuses, the safe side.
const EEO_FRAGMENTS: readonly string[] = [
  'gender', 'race', 'caste', 'ethnic', 'hispanic', 'latino', 'veteran', 'disab', 'sexual_orientation',
  'transgender', 'lgbt', 'religio', 'marital', 'pregnan',
];

// The EEO questions Teja may answer in the console, as they are labelled on the Greenhouse
// form (GitLab 8775507002, labels from the fixture, options from the public job API). Each
// whole normalised label maps to the ONE answer_bank key the console writes for it; the
// stored text is typed verbatim, so it must be one of the form's options exactly.
const EEO_TEMPLATES: ReadonlyArray<{ readonly key: string; readonly pattern: RegExp }> = [
  // "Gender": Male / Female / Decline To Self Identify.
  { key: 'eeo_gender', pattern: /^gender$/ },
  // "Are you Hispanic/Latino?": asked before race on Greenhouse forms.
  { key: 'eeo_hispanic_latino', pattern: /^are_you_hispanic_latino$/ },
  // "Race": shown when Hispanic/Latino is "No"; the other two are its known phrasings.
  { key: 'eeo_race', pattern: /^(?:race|race_ethnicity|please_identify_your_race)$/ },
  // "Veteran Status": the three VEVRAA choices.
  { key: 'eeo_veteran_status', pattern: /^veteran_status$/ },
];

// Every label that touches eligibility at all. A label with any of these is handled ONLY by
// the anchored templates below: it never falls through to the plain bank lookup or the
// profile, so an unattested row keyed to the label can't fill it. A label in this territory
// that matches no template (negations, other subjects, work authorisation, citizenship,
// visa type...) goes to Teja.
const ELIGIBILITY_FRAGMENTS: readonly string[] = [
  // Location and sponsorship.
  'located_in', 'sponsor', 'visa', 'h_1b', 'immigration', 'citizen', 'nationality',
  // Work authorisation in its common phrasings; none of these has a stored-answer type yet.
  'work_authori', 'authorized_to_work', 'authorised_to_work', 'right_to_work', 'eligible_to_work',
  'allowed_to_work', 'permitted_to_work', 'work_permit',
  // Contractual restrictions.
  'employment_agreement', 'post_employment', 'non_compete', 'non_solicit', 'restrictive_covenant',
  // Prior relationships with the employer.
  'previously_worked', 'worked_at', 'worked_for', 'consulted_for', 'former_employee', 'employed_by',
];

// OPINIONS, PREFERENCES AND ACKNOWLEDGEMENTS (2026-10-24): what excites him, his pronouns,
// whether he will work onsite or relocate, "I understand this is an in-person role". None
// is a fact the profile holds, and each is a statement Teja signs, so a label here is
// answered ONLY from an attested bank row keyed to it: never from the profile, never from
// a row a machine wrote. Evidence: live parks on Sigma (428f6cbc) and Perpay (634f6f48).
// SUBSTRING fragments: over-matching only sends a question to Teja, the safe side.
const OPINION_FRAGMENTS: readonly string[] = [
  // Self-identification that is not EEO.
  'pronoun',
  // Work arrangement and location preferences.
  'onsite', 'on_site', 'in_person', 'in_office', 'hybrid', 'relocat', 'commut',
  // Motivation and interest essays.
  'excite', 'why_do_you_want', 'why_are_you_interested', 'interests_you', 'motivat',
  // Acknowledgements ("I understand…"), which are agreements like consent.
  'i_understand', 'i_acknowledge',
];
// The eligibility questions Teja ruled answerable on 2026-10-09.
type EligibilityCategory = 'located_in' | 'sponsorship' | 'employment_restrictions' | 'previously_worked';

// The restriction nouns one restrictions question may name, singular or plural.
const RESTRICTION_NOUN =
  '(?:employment_agreements?|post_employment_restrictions?|non_compete(?:_agreements?)?|restrictive_covenants?)';

// ANCHORED TEMPLATES, matched against the WHOLE normalised label (^...$). This is the
// guarantee that the wrong answer can't be expressed: a label is answered only when it IS
// one of these shapes, so polarity flips ("Are you NOT located in India?", "...WITHOUT
// sponsorship?"), other subjects ("Is your company located in...", "Has a family member
// worked at...") and compound questions ("...located in India and authorized to work in
// the US?") match nothing and go to Teja. A capture group, where present, is compared for
// EQUALITY with Teja's stored value; it is never searched for a substring.
// Add a phrasing here only after seeing it on a real form, with a test.
const ELIGIBILITY_TEMPLATES: ReadonlyArray<{ readonly category: EligibilityCategory; readonly pattern: RegExp }> = [
  // "Are you (currently) located in India?" → the country, compared to located_in_country.
  { category: 'located_in', pattern: /^are_you_(?:currently_)?located_in_([a-z0-9]+(?:_[a-z0-9]+)*)$/ },
  // "Will you now or in the future require sponsorship for a visa to remain in your current
  // location?" and its shorter forms. Answer "Yes" iff visa_sponsorship_required is true.
  {
    category: 'sponsorship',
    pattern:
      // The "...to remain in your current location" suffix is REQUIRED. Teja's "No" (he's in
      // India, needs no sponsorship there) is true only for that scope; an unscoped "Do you
      // need visa sponsorship?" on a US role is likely a "Yes", so it goes to him.
      /^(?:will|do|would)_you_(?:now_or_in_the_future_)?(?:require|need)_(?:visa_)?sponsorship(?:_for_a_visa)?_to_remain_in_your_current_location(?:_now_or_in_the_future)?$/,
  },
  // "Are you subject to any employment agreements and/or post-employment restrictions with
  // your current employer or a past employer?" "Yes" means subject, so "None" stored → "No".
  {
    category: 'employment_restrictions',
    pattern: new RegExp(
      `^are_you_subject_to_any_${RESTRICTION_NOUN}(?:_(?:and_or|or|and)_${RESTRICTION_NOUN})?` +
        '(?:_with_your_current_employer_or_a_past_employer|_with_your_current_or_former_employers?|_with_any_current_or_former_employer)?$',
    ),
  },
  // "Have you (ever) (previously) worked at / for / been employed by (or consulted for)
  // <company>?" or "Are you a former employee of <company>?" → the company, compared to the
  // job's employer.
  {
    category: 'previously_worked',
    pattern:
      /^(?:have_you_(?:ever_)?(?:previously_)?(?:worked_at|worked_for|been_employed_by)(?:_or_consulted_for)?|are_you_a_former_employee_of)_([a-z0-9]+(?:_[a-z0-9]+)*)$/,
  },
];

// The answer_bank keys the console's "Eligibility answers" section writes. Shared by name
// with apps/web (answerBankStore.ts), so renaming one side silently breaks the other.
const LOCATED_IN_KEY = 'located_in_country';
const SPONSORSHIP_KEY = 'visa_sponsorship_required';
const RESTRICTIONS_KEY = 'employment_restrictions';

// Trailing legal-form tokens dropped before comparing company names, so "GitLab Inc." and
// "GitLab" are the same employer. Deliberately short: anything more aggressive (dropping
// "technologies", "labs") would merge distinct companies, and a wrong "Yes" is a false
// statement on an application.
const COMPANY_SUFFIXES: ReadonlySet<string> = new Set([
  'inc', 'llc', 'ltd', 'limited', 'corp', 'corporation', 'co', 'pvt', 'private', 'gmbh', 'plc',
]);

/** True when a label sits in EEO (voluntary self-identification) territory. */
// Exported for apply-one.ts, which may leave an OPTIONAL EEO field blank when the live form
// offers none of Teja's saved option. One predicate, so the fill loop's "is this EEO?" can
// never drift from the planner's: the same fold, the same normaliser, the same fragments.
export function isEeoQuestion(label: string): boolean {
  // Normalised exactly as planFill normalises a label before its EEO branch.
  const key = normaliseKey(foldAccents(label));
  // Substring fragments, like the planner: over-matching only widens a "leave blank" that is
  // itself gated on the field being optional, so it can never turn into an answer.
  return EEO_FRAGMENTS.some((fragment) => key.includes(fragment));
}

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
    // A question only Teja may answer here: a consent / criminal / pay-history / age
    // question (never auto-filled, even with a bank row), or an EEO or eligibility question
    // whose answer he hasn't saved and attested in the console (or whose wording matches no
    // known template).
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

/** The text with accents removed ("é" → "e"), so normaliseKey keeps the letter. */
function foldAccents(text: string): string {
  // NFKD splits "é" into "e" plus a combining mark, and \p{M} drops the mark. One helper for
  // labels, companies and countries, so all three meet in the same shape ("Consént" →
  // "consent", "Nestlé" → "nestle") instead of each normalising accents differently.
  return text.normalize('NFKD').replace(/\p{M}/gu, '');
}

/** A company (or country) name as underscore-joined tokens, legal suffixes stripped; '' if blank. */
function normaliseCompany(name: string): string {
  // Same fold and normaliser as labels, so "Nestlé" in the experience meets "Nestle" in the
  // job row instead of normalising to "nestl" and producing a false "No".
  const tokens = normaliseKey(foldAccents(name)).split('_').filter((token) => token !== '');
  // Strip suffixes from the END only: "Co-op Ltd" keeps "co_op".
  while (tokens.length > 1 && COMPANY_SUFFIXES.has(tokens[tokens.length - 1]!)) tokens.pop();
  // Joined back in the label normaliser's shape.
  return tokens.join('_');
}

/** True when `needle` appears in `haystack` as whole underscore-separated tokens. */
function containsTokens(haystack: string, needle: string): boolean {
  // Padding with '_' makes "git" fail to match inside "gitlab": whole tokens only.
  return needle !== '' && `_${haystack}_`.includes(`_${needle}_`);
}

/** The attested bank row for a canonical key, or the reason it can't be used. */
function attestedRow(
  byKey: ReadonlyMap<string, AnswerBankRow>,
  collisions: ReadonlyMap<string, readonly [string, string]>,
  key: string,
): AnswerBankRow | FillBlocker['reason'] {
  // Two rows claim the key: which one Teja meant is unknowable.
  if (collisions.has(key)) return 'ambiguous_answer_key';
  // The row as the console saved it, if any.
  const row = byKey.get(key);
  // Never answered: only Teja can, so it goes to him.
  if (row === undefined) return 'human_only';
  // A placeholder row is not an answer.
  if (row.needs_human) return 'awaiting_human_answer';
  // STRICT true: the column comes from select('*') and is not in the shared TS type yet, so
  // anything but a real boolean true (missing, null, "true") is "not attested". A row a
  // machine wrote is stamped false by the trigger (20261009160000) and refused here.
  if ((row as { readonly attested_by_human?: unknown }).attested_by_human !== true) return 'human_only';
  // Attested by Teja and not a placeholder: usable.
  return row;
}

/**
 * The "Yes"/"No" for one eligibility question already matched to an anchored template, or
 * the reason to refuse. Never a third value: each branch can only copy Teja's stored answer
 * or derive from his own master profile.
 */
function answerEligibility(
  category: EligibilityCategory,
  // The template's capture (country or company), already in normalised-key form; '' if none.
  captured: string,
  byKey: ReadonlyMap<string, AnswerBankRow>,
  collisions: ReadonlyMap<string, readonly [string, string]>,
  profile: MasterProfile | null,
  employerName: string | null,
): { readonly value: 'Yes' | 'No'; readonly source: PlannedFill['source'] } | FillBlocker['reason'] {
  // Previously worked at <employer>: Teja's ruling (2026-10-09) is "use my resume experience
  // section". This is NOT a refusal by design; do not "fix" it into one. Yes iff the employer
  // is in his experience, No iff it is absent, and anything uncertain goes to him.
  if (category === 'previously_worked') {
    // Which employer this application is for comes from the caller (the job's company).
    const employer = normaliseCompany(employerName ?? '');
    // The question must name exactly that employer, compared for equality, not containment.
    if (employer === '' || normaliseCompany(captured) !== employer) return 'human_only';
    // No profile loaded: absence of evidence is not evidence of absence.
    if (profile === null) return 'human_only';
    // jsonb of unknown shape: a non-array experience is unreadable, not empty.
    const experience: unknown = (profile as { readonly experience?: unknown }).experience;
    if (!Array.isArray(experience)) return 'human_only';
    // Every entry's normalised company. A malformed entry yields '' and is refused below:
    // skipping it would let missing data become a "No" (CLAUDE.md §6).
    const companies = experience.map((entry: unknown) =>
      // Only a plain object with a string company counts as a readable entry.
      entry !== null && typeof entry === 'object' && typeof (entry as { company?: unknown }).company === 'string'
        ? normaliseCompany((entry as { company: string }).company)
        : '',
    );
    // One unreadable entry and the history is incomplete: Teja decides.
    if (companies.includes('')) return 'human_only';
    // An exact employer match: he worked there.
    if (companies.includes(employer)) return { value: 'Yes', source: 'profile' };
    // A partial overlap ("Aczen" vs "Aczen Technologies") might be the same company or not.
    // A wrong answer either way is a false statement, so Teja decides.
    // Also a spacing variant ("Git Lab" vs "GitLab"): equal once the separators go, so it
    // may well be the same company, and a "No" there would be false.
    const squash = (value: string): string => value.split('_').join('');
    if (
      companies.some(
        (company) =>
          containsTokens(company, employer) || containsTokens(employer, company) || squash(company) === squash(employer),
      )
    ) {
      return 'human_only';
    }
    // Not in his experience at all (including an empty experience list): per the ruling, No.
    return { value: 'No', source: 'profile' };
  }

  // The other three come from one attested bank row each.
  const key = category === 'located_in' ? LOCATED_IN_KEY : category === 'sponsorship' ? SPONSORSHIP_KEY : RESTRICTIONS_KEY;
  const row = attestedRow(byKey, collisions, key);
  // Not usable: pass the reason through.
  if (typeof row === 'string') return row;

  // Visa sponsorship: a STRICT boolean. "no" as text, null or a number is malformed, and
  // reading it leniently would turn bad data into an answer (CLAUDE.md §6).
  if (category === 'sponsorship') {
    if (typeof row.answer_value !== 'boolean') return 'invalid_answer';
    // true = needs sponsorship = "Yes"; false = "No".
    return { value: row.answer_value ? 'Yes' : 'No', source: 'answer_bank' };
  }

  // The other two hold text.
  const text = answerText(row.answer_value);
  // Blank or non-text is not an answer.
  if (text === null) return 'invalid_answer';

  // Located in: "Yes" only when the asked country EQUALS the stored one. The system never
  // says "No": another country, or a stored value that doesn't normalise, goes to Teja.
  if (category === 'located_in') {
    // Both sides in the label normaliser's shape; equality, so "IN" can't match "Germany".
    const country = normaliseCompany(text);
    return country !== '' && normaliseCompany(captured) === country ? { value: 'Yes', source: 'answer_bank' } : 'human_only';
  }

  // Employment restrictions: only an explicit "None"/"No" means "No". Any described
  // restriction is a "Yes" that needs details, so it goes to Teja.
  const lowered = text.toLowerCase();
  return lowered === 'none' || lowered === 'no' ? { value: 'No', source: 'answer_bank' } : 'human_only';
}

export function planFill(
  fields: readonly FormField[],
  answers: readonly AnswerBankRow[],
  // Defaulted to null so every pre-profile caller keeps compiling and simply gets no profile fills.
  profile: MasterProfile | null = null,
  // The company this application is for, from the job row. Used only to answer "previously
  // worked at <company>"; null (every caller that doesn't pass it) makes that question refuse.
  employerName: string | null = null,
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
    // Accents are folded first (NFKD, then the combining marks dropped), so "Consént" still
    // hits 'consent' instead of normalising to "cons_nt". A bank key with accents then fails
    // to meet the label and refuses as no_answer: the safe direction.
    const key = normaliseKey(foldAccents(formField.label));

    // NEVER FIRST: EEO, criminal, pay-history and consent questions are only ever answered
    // by Teja himself, so nothing below (attested or not) may reach them.
    if (
      NEVER_FRAGMENTS.some((fragment) => key.includes(fragment)) ||
      // Whole tokens only for the short ones ("dob", "sex"): see NEVER_TOKENS.
      NEVER_TOKENS.some((token) => containsTokens(key, token))
    ) {
      refuse('human_only');
      continue;
    }

    // A checkbox has no safe text value, and the live filler throws on it late, after other
    // fields were already typed, which parks the whole application even for an optional
    // field. So it is refused BEFORE the EEO and eligibility answers too (a "Gender"
    // checkbox with an attested answer would otherwise get a fill that can only fail).
    if (formField.kind === 'checkbox') {
      refuse('human_only');
      continue;
    }

    // H1 (Teja, 2026-11-05 23:19): THE EXACT-LABEL ATTESTED ROW. In EEO, eligibility and opinion territory,
    // a row Teja attested under this field's EXACT normalised label is his answer to this very question,
    // so it answers it, ahead of the templates below. Checked first so the key the Unanswered list records
    // (the label's own) always fills the field once Teja answers it, even where a template owns the label
    // ("Gender" with no eeo_gender row). Never a paraphrase (exact key equality), never an unattested row
    // (attestedRow is strict), and never a NEVER question or a checkbox (both refused above).
    const gated = [EEO_FRAGMENTS, ELIGIBILITY_FRAGMENTS, OPINION_FRAGMENTS].some((list) => list.some((fragment) => key.includes(fragment)));
    // The attested row, or why there isn't a usable one (none, placeholder, unattested, ambiguous).
    const exact = gated ? attestedRow(byKey, collisions, key) : 'human_only';
    // Usable: Teja's own answer to this exact label.
    if (typeof exact !== 'string') {
      // Only non-empty text (or a number) is an answer.
      const text = answerText(exact.answer_value);
      // A blank or non-text attested row is still not an answer.
      if (text === null) {
        refuse('invalid_answer');
        continue;
      }
      // A select or radio must offer it verbatim.
      if (formField.options !== undefined && !formField.options.includes(text)) {
        // Never the nearest option: a statement must be made exactly as Teja wrote it.
        refuse('no_matching_option');
        continue;
      }
      // Copied exactly as Teja saved and attested it.
      fills.push({ id: formField.id, value: text, kind: formField.kind, source: 'answer_bank' });
      continue;
    }

    // EEO NEXT: answered only from Teja's attested eeo_* row via one whole-label template.
    if (EEO_FRAGMENTS.some((fragment) => key.includes(fragment))) {
      // The templates that match the WHOLE label.
      const eeo = EEO_TEMPLATES.filter(({ pattern }) => pattern.test(key));
      // None (another phrasing, a related question) or several: Teja answers; left blank
      // on an optional field because refuse() is silent there.
      if (eeo.length !== 1) {
        refuse('human_only');
        continue;
      }
      // The attested row for that question, or why there isn't a usable one. No row means
      // he hasn't answered it, and the field stays blank: never a guess, never "Decline".
      const row = attestedRow(byKey, collisions, eeo[0]!.key);
      if (typeof row === 'string') {
        refuse(row);
        continue;
      }
      // Only non-empty text is an answer; the console stores one of the option strings.
      const text = answerText(row.answer_value);
      if (text === null) {
        refuse('invalid_answer');
        continue;
      }
      // Verbatim, and it must be one of the form's own options when they're known here
      // (a react-select's options are checked strictly at fill time instead).
      if (formField.options !== undefined && !formField.options.includes(text)) {
        refuse('no_matching_option');
        continue;
      }
      // Copied exactly as Teja saved it.
      fills.push({ id: formField.id, value: text, kind: formField.kind, source: 'answer_bank' });
      continue;
    }

    // ELIGIBILITY NEXT: a label that touches eligibility at all is answered ONLY through an
    // anchored template, and never falls through to the plain bank or the profile, where an
    // unattested row keyed to this label would otherwise fill it.
    if (ELIGIBILITY_FRAGMENTS.some((fragment) => key.includes(fragment))) {
      // Which templates match the WHOLE label; each match carries its capture (or '').
      const matches = ELIGIBILITY_TEMPLATES.flatMap(({ category, pattern }) => {
        // exec, not test: the capture is the country or company to compare.
        const hit = pattern.exec(key);
        return hit === null ? [] : [{ category, captured: hit[1] ?? '' }];
      });
      // No template (a negation, another subject, work authorisation...) or more than one:
      // only Teja can answer it.
      if (matches.length !== 1) {
        refuse('human_only');
        continue;
      }
      // The one template's Yes/No, or why it can't be given.
      const answer = answerEligibility(matches[0]!.category, matches[0]!.captured, byKey, collisions, profile, employerName);
      if (typeof answer === 'string') {
        refuse(answer);
        continue;
      }
      // Same exact-option rule as every other fill: a select must offer "Yes"/"No" verbatim.
      if (formField.options !== undefined && !formField.options.includes(answer.value)) {
        refuse('no_matching_option');
        continue;
      }
      // Copied from Teja's own answer or his own profile; nothing composed.
      fills.push({ id: formField.id, value: answer.value, kind: formField.kind, source: answer.source });
      continue;
    }

    // OPINIONS NEXT: answered only from Teja's attested row keyed to this exact label, so
    // neither the profile nor a machine-written row can state a preference for him.
    // The usable row was already taken by the exact-label step above, so only the reason is left; it goes
    // to Teja (silently dropped on an optional field).
    if (OPINION_FRAGMENTS.some((fragment) => key.includes(fragment))) {
      refuse(exact);
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
