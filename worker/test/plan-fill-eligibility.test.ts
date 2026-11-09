// Tests for the planner's ELIGIBILITY answers: the narrow set of yes/no screening questions
// ("Are you located in India?", "Will you require sponsorship?") that the planner may now
// answer, and the much larger set it must still refuse.
//
// WHY A SEPARATE FILE. plan-fill.test.ts covers the general planner. These cases share one
// risk the rest do not: each answer is a binding statement about Teja's legal status or
// history, typed into a real application. So every rule here is tested from BOTH sides:
// the one shape that may answer, and the near-miss shapes that must refuse.
//
// The contract under test (planFill's 4th argument, attested_by_human, the four categories)
// is specified by the orchestrator's 2026-10-09 brief, not inferred from the source.
import { describe, expect, test } from 'vitest';
// Imported, never redefined: a local copy is how the worker and the database drift apart.
import type { AnswerBankRow, MasterProfile } from '@applyy/shared-types';
// The worker's DOM shape; the planner consumes it.
import type { FormField } from '../src/extract-fields.ts';
// Subject under test.
import { planFill } from '../src/plan-fill.ts';

/**
 * A bank row. `attested` is unknown, not boolean, so a test can pass a non-boolean
 * (the string 'true') and prove the planner demands a STRICT boolean.
 */
function row(question_key: string, answer_value: unknown, attested: unknown = true, needs_human = false): AnswerBankRow {
  // AnswerBankRow's TS type has no attested_by_human column yet, hence the cast at this boundary.
  const base: Record<string, unknown> = { question_key, answer_value, needs_human, answer_type: 'text' };
  // The sentinel 'absent' means "column absent", the shape of a row written before attestation
  // existed. Not `undefined`: passing undefined triggers the `= true` default, so the row came
  // out attested and the "missing" case tested nothing.
  if (attested !== 'absent') base.attested_by_human = attested;
  // Single cast point, so no test body carries one.
  return base as unknown as AnswerBankRow;
}

/** A required yes/no radio, the shape most eligibility questions take. */
function yesNo(label: string, required = true, options: readonly string[] = ['Yes', 'No']): FormField {
  // The id is irrelevant to every rule here; blockers are compared by reason.
  return { id: 'q', label, kind: 'radio_group', required, options };
}

/** A profile whose only meaningful content is its employer history. */
function withCompanies(companies: readonly string[]): MasterProfile {
  // Only `company` is read by the previously-worked rule; the cast spares 9 bookkeeping fields per entry.
  return { experience: companies.map((company, i) => ({ id: `e${i}`, company })) } as unknown as MasterProfile;
}

/** Plans one field and returns the single outcome, so each test asserts one thing. */
function one(f: FormField, answers: readonly AnswerBankRow[], profile: MasterProfile | null = null, employer: string | null = null) {
  // The 4-argument call IS part of the contract: employerName is new.
  const plan = planFill([f], answers, profile, employer);
  // Value and source when filled, null otherwise, so a test can assert "not filled" directly.
  const fill = plan.fills[0] ? { value: plan.fills[0].value, source: plan.fills[0].source } : null;
  // The refusal reason, or null when none was recorded.
  const reason = plan.blockers[0]?.reason ?? null;
  // Both, together: a fill AND a blocker for one field would itself be a bug, so neither hides the other.
  return { fill, reason, plan };
}

// The canonical stored-answer rows the three bank-backed categories read.
const india = row('located_in_country', 'India');
// Strict boolean false: "I do not need sponsorship".
const noSponsor = row('visa_sponsorship_required', false);

describe('NEVER categories are refused even with an attested answer keyed to the label', () => {
  // (The EEO-wording-with-no-template case moved to "H1" at the end of this file: Teja ruled on
  // 2026-11-05 23:19 that an attested row keyed to the EXACT label answers it.)
  // One case per NEVER family, so removing any family from the denylist turns one row red.
  test.each([
    // conviction/criminal family.
    ['criminal history', 'Have you ever been convicted of a felony?'],
    // background_check family (a consent to a check, binding either way).
    ['background check consent', 'Do you agree to a background check?'],
    // Pay history: illegal to ask in some jurisdictions.
    ['salary history', 'What is your current salary?'],
    // consent/certify/attest family.
    ['attestation', 'I attest that the above is true'],
    // Age: protected, and "date of birth" is the common phrasing.
    ['date of birth', 'Date of birth'],
  ])('an attested %s answer is still refused', (_family, label) => {
    // Attested row keyed to the label's own normalised form.
    const key = label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
    // A text field, so the option check cannot be what refuses it.
    const r = one({ id: 'q', label, kind: 'text', required: true }, [row(key, 'Yes')]);
    // Refused by category, not by a missing row.
    expect(r).toMatchObject({ fill: null, reason: 'human_only' });
  });

  test('NEVER is checked before eligibility: "certify ... located in India" is refused', () => {
    // Would be a located_in "Yes" if eligibility ran first; certifying is Teja's act alone.
    const r = one(yesNo('Do you certify you are located in India?'), [india]);
    // Order of checks is the whole point of this case.
    expect(r).toMatchObject({ fill: null, reason: 'human_only' });
  });
});

describe('located_in', () => {
  test('answers Yes when the stored country appears in the label', () => {
    // The GitLab question, with an attested India row.
    const r = one(yesNo('Are you located in India?'), [india]);
    // Yes, sourced from the bank (the stored country), not the profile.
    expect(r).toMatchObject({ fill: { value: 'Yes', source: 'answer_bank' }, reason: null });
  });

  test('a different country in the label is refused, never answered No', () => {
    // The system may only assert location positively; "No" would be an inference.
    const r = one(yesNo('Are you located in the United States?'), [india]);
    // Refused, so Teja answers it.
    expect(r).toMatchObject({ fill: null, reason: 'human_only' });
  });

  test('an open "which country" question is refused', () => {
    // Not a yes/no question at all; the stored country is not a valid answer to type here.
    const r = one({ id: 'q', label: 'Which country are you located in?', kind: 'text', required: true }, [india]);
    // Refused rather than typing "Yes" into a free-text box.
    expect(r).toMatchObject({ fill: null, reason: 'human_only' });
  });

  test('the country must match as whole tokens: "Indiana" is not "India"', () => {
    // A substring check would say Yes here: "india" is inside "indiana".
    const r = one(yesNo('Are you located in Indiana?'), [india]);
    // Whole-token sequence only.
    expect(r).toMatchObject({ fill: null, reason: 'human_only' });
  });
});

describe('sponsorship', () => {
  // The GitLab wording.
  const sponsorQ = 'Will you now or in the future require sponsorship for a visa to remain in your current location?';

  test('stored false answers No', () => {
    // Strict boolean false means "no sponsorship needed".
    expect(one(yesNo(sponsorQ), [noSponsor])).toMatchObject({ fill: { value: 'No', source: 'answer_bank' }, reason: null });
  });

  test('stored true answers Yes', () => {
    // Strict boolean true means "sponsorship needed"; the planner reports the truth either way.
    expect(one(yesNo(sponsorQ), [row('visa_sponsorship_required', true)])).toMatchObject({ fill: { value: 'Yes' }, reason: null });
  });

  // Each is a "lenient reader" trap: "no" reads as false, 0 as false, null as false.
  test.each([['the string "no"', 'no'], ['null', null], ['the number 0', 0]])('a non-boolean %s is invalid_answer', (_name, value) => {
    // Attested, so attestation is not what refuses it.
    const r = one(yesNo(sponsorQ), [row('visa_sponsorship_required', value)]);
    // Shape refused, never coerced.
    expect(r).toMatchObject({ fill: null, reason: 'invalid_answer' });
  });

  // false, absent and a truthy string must all refuse: only a strict `true` attests.
  test.each([['false', false], ['missing', 'absent'], ['the string "true"', 'true']])(
    'a machine-written (unattested) sponsorship answer is refused: attested_by_human %s',
    (_name, attested) => {
      // A row a model or a migration wrote, not Teja.
      const r = one(yesNo(sponsorQ), [row('visa_sponsorship_required', false, attested)]);
      // Refused as human_only, so Teja answers it himself.
      expect(r).toMatchObject({ fill: null, reason: 'human_only' });
    },
  );

  test('a needs_human placeholder row is awaiting_human_answer', () => {
    // The row exists but awaits Teja, a different action from "no row".
    const r = one(yesNo(sponsorQ), [row('visa_sponsorship_required', null, true, true)]);
    // Tells the dashboard which action applies.
    expect(r).toMatchObject({ fill: null, reason: 'awaiting_human_answer' });
  });

  test('no stored row is refused human_only', () => {
    // No bank, no profile fallback: sponsorship is never inferred.
    expect(one(yesNo(sponsorQ), [])).toMatchObject({ fill: null, reason: 'human_only' });
  });
});

describe('employment restrictions', () => {
  // The GitLab wording; matches both employment_agreement and post_employment, one category.
  const restrictQ =
    'Are you subject to any employment agreements and/or post-employment restrictions with your current employer or a past employer?';

  // Trimmed and case-insensitive, per the contract.
  test.each(['None', ' no ', 'NONE'])('stored %j answers No', (text) => {
    // Attested "none"-shaped text is the only text that answers.
    expect(one(yesNo(restrictQ), [row('employment_restrictions', text)])).toMatchObject({ fill: { value: 'No', source: 'answer_bank' }, reason: null });
  });

  test('any other stored text is refused', () => {
    // Describes a real restriction; the planner must not compress it into Yes/No.
    const r = one(yesNo(restrictQ), [row('employment_restrictions', 'Non-compete until 2027')]);
    // Teja answers it.
    expect(r).toMatchObject({ fill: null, reason: 'human_only' });
  });

  test('no stored row is refused', () => {
    // Same no-row rule as sponsorship.
    expect(one(yesNo(restrictQ), [])).toMatchObject({ fill: null, reason: 'human_only' });
  });
});

describe('previously worked (profile-sourced, no bank row)', () => {
  // The GitLab wording; contains the employer name.
  const workedQ = 'Have you previously worked at or consulted for GitLab?';

  test('previously worked: exact Yes', () => {
    // "GitLab Inc." strips its legal suffix to "gitlab", EQUAL to the employer.
    const r = one(yesNo(workedQ), [], withCompanies(['GitLab Inc.']), 'GitLab');
    // Sourced from the profile, since no bank row is involved.
    expect(r).toMatchObject({ fill: { value: 'Yes', source: 'profile' }, reason: null });
  });

  test('previously worked: absent No', () => {
    // Teja's real-shaped history: neither company is GitLab.
    const r = one(yesNo(workedQ), [], withCompanies(['Aczen Technologies', 'Student Tribe']), 'GitLab');
    // Absent from the history means No.
    expect(r).toMatchObject({ fill: { value: 'No', source: 'profile' }, reason: null });
  });

  test('previously worked: empty experience is No', () => {
    // Teja's ruling: an empty history is a real answer (absent -> No), unlike a null profile.
    const r = one(yesNo(workedQ), [], withCompanies([]), 'GitLab');
    // No.
    expect(r).toMatchObject({ fill: { value: 'No' }, reason: null });
  });

  test('previously worked: fuzzy refuses', () => {
    // "Aczen" vs "Aczen Technologies": overlapping tokens but not equal. Could be the same firm.
    const r = one(yesNo('Have you previously worked for Aczen?'), [], withCompanies(['Aczen Technologies']), 'Aczen');
    // Neither Yes nor No is safe.
    expect(r).toMatchObject({ fill: null, reason: 'human_only' });
  });

  // Null and whitespace are both "no employer name".
  test.each([['null', null], ['blank', '  ']])('previously worked: no employer name refuses (%s)', (_name, employer) => {
    // Without the employer, the planner cannot know who "this company" is.
    const r = one(yesNo(workedQ), [], withCompanies(['Aczen Technologies']), employer);
    // Refused.
    expect(r).toMatchObject({ fill: null, reason: 'human_only' });
  });

  test('previously worked: a label not naming the employer refuses', () => {
    // "this company" might not be the employer the caller passed (agency posting, subsidiary).
    const r = one(yesNo('Have you previously worked for this company?'), [], withCompanies(['Aczen Technologies']), 'GitLab');
    // Refused.
    expect(r).toMatchObject({ fill: null, reason: 'human_only' });
  });

  test('previously worked: a null profile refuses', () => {
    // No profile is "unknown", not "never worked anywhere".
    expect(one(yesNo(workedQ), [], null, 'GitLab')).toMatchObject({ fill: null, reason: 'human_only' });
  });
});

describe('cross-cutting eligibility rules', () => {
  test('a label matching two eligibility categories is refused', () => {
    // Both rows attested and each alone would answer; a compound question has no single Yes/No.
    const r = one(yesNo('Are you located in India and will you require sponsorship?'), [india, noSponsor]);
    // Refused.
    expect(r).toMatchObject({ fill: null, reason: 'human_only' });
  });

  // Eligibility questions with no stored-answer type, each with an attested row keyed to the label.
  // H1 (Teja, 2026-11-05 23:19): Teja's own attested answer to that EXACT question now answers it;
  // before, these were always refused. Paraphrases and unattested rows still refuse (H1 block below).
  test.each([
    // work_authori.
    'Are you authorized to work in India?',
    // right_to_work.
    'Do you have the right to work in India?',
    // eligible_to_work.
    'Are you eligible to work in India?',
    // allowed_to_work.
    'Are you legally allowed to work here?',
    // work_permit.
    'Do you hold a work permit?',
    // immigration.
    'What is your immigration status?',
    // citizen.
    'Are you an Indian citizen?',
    // nationality.
    'What is your nationality?',
    // visa WITHOUT sponsor: no stored-answer type covers it.
    'What type of visa do you hold?',
  ])('%s is answered from the attested row keyed to that exact label (H1)', (label) => {
    // The label's own key: Teja's answer to this very question.
    const key = label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
    // Free text, so the option check is not in play.
    const r = one({ id: 'q', label, kind: 'text', required: true }, [row(key, 'Yes')]);
    // Copied verbatim from the bank.
    expect(r).toMatchObject({ fill: { value: 'Yes', source: 'answer_bank' }, reason: null });
  });

  test('an unattested row keyed exactly to an eligibility label never fills it', () => {
    // A model-written "Yes" keyed to the question itself: the plain bank lookup must not be reached.
    const r = one(yesNo('Are you located in India?'), [row('are_you_located_in_india', 'Yes', false)]);
    // Refused, not filled with the stored "Yes".
    expect(r).toMatchObject({ fill: null, reason: 'human_only' });
  });

  test('a radio that spells "Yes" in lowercase gets the form\'s own "yes" (option-match, case only)', () => {
    // Lowercase options: "yes" IS "Yes" in another case, so the planner plans the form's own text.
    const r = one(yesNo('Are you located in India?', true, ['yes', 'no']), [india]);
    // The form's spelling, from Teja's attested country.
    expect(r).toMatchObject({ fill: { value: 'yes', source: 'answer_bank' }, reason: null });
  });

  test('a radio whose options are a different word ("Y"/"N") refuses no_matching_option, never approximated', () => {
    // "Y" is not "Yes" with different case or separators: option-match has no prefix or abbreviation rule.
    const r = one(yesNo('Are you located in India?', true, ['Y', 'N']), [india]);
    // The option check still runs after an eligibility answer.
    expect(r).toMatchObject({ fill: null, reason: 'no_matching_option' });
  });

  test('an optional eligibility field refuses silently', () => {
    // Optional, and no row: a refusal, but optional refusals never block.
    const r = one(yesNo('Will you require visa sponsorship?', false), []);
    // Not filled.
    expect(r.fill).toBeNull();
    // And not reported, so the application can still proceed.
    expect(r.plan.blockers).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Round 2: anchored templates. After a security review, an eligibility label is answered only
// when the WHOLE normalised label matches one template; any extra word (a negation, a second
// subject, a second question) sends it to Teja instead of being read past.
// ---------------------------------------------------------------------------

describe('anchored templates: near-miss wordings are refused', () => {
  // Every row a template could read, all attested, so a refusal below is the template's doing.
  const bank = [india, row('visa_sponsorship_required', false), row('employment_restrictions', 'None')];
  // Teja's real-shaped history, without GitLab.
  const history = withCompanies(['Aczen Technologies', 'Student Tribe']);

  // Each would be answered by a substring rule; each says something the template does not.
  test.each([
    // Authorisation question that merely mentions sponsorship.
    'Are you authorized to work in the US without visa sponsorship?',
    // "Can you work without" inverts the meaning of "require sponsorship".
    'Can you work without sponsorship?',
    // A negation: the substring rule would answer "Yes" to the opposite question.
    'Are you NOT located in India?',
    // Asks about the company, not Teja.
    'Is your company located in India?',
    // Two questions in one; a Yes would also assert US work authorisation.
    'Are you located in India and authorized to work in the US?',
    // "Free of" inverts "subject to": "No" would mean "I have restrictions".
    'Are you free of any non-compete restrictions?',
    // About someone else's employment, not Teja's.
    'Has a family member worked at GitLab?',
    // A visa question that is not the sponsorship template.
    'Do you require a work visa?',
    // permitted_to_work: no stored-answer type covers authorisation.
    'Are you legally permitted to work in India?',
    // non_solicit is a restriction fragment, but not a template noun.
    'Do you have any non-solicitation obligations?',
  ])('%s is refused', (label) => {
    // Employer and history supplied, so a missing input is never the reason.
    const r = one(yesNo(label), bank, history, 'GitLab');
    // Refused, never answered from the bank or the profile.
    expect(r).toMatchObject({ fill: null, reason: 'human_only' });
  });

  test('located_in compares by equality: stored "IN" never answers for Germany', () => {
    // A code instead of a name: not equal to "germany", and never read as "No" either.
    const r = one(yesNo('Are you located in Germany?'), [row('located_in_country', 'IN')]);
    // Refused.
    expect(r).toMatchObject({ fill: null, reason: 'human_only' });
  });

  test('a malformed experience entry refuses instead of being skipped', () => {
    // `employer` instead of `company`: skipping it would silently answer "No" for a real GitLab job.
    const malformed = { experience: [{ id: 'e0', employer: 'GitLab' }] } as unknown as MasterProfile;
    // The template matches; only the data shape can refuse.
    const r = one(yesNo('Have you previously worked at GitLab?'), [], malformed, 'GitLab');
    // Refused.
    expect(r).toMatchObject({ fill: null, reason: 'human_only' });
  });

  test('previously worked: legal suffix stripped from the label, exact Yes', () => {
    // "GitLab Inc." in the label normalises to "gitlab", equal to the employer and the history.
    const r = one(yesNo('Have you ever worked for GitLab Inc.?'), [], withCompanies(['GitLab']), 'GitLab');
    // Yes, from the profile.
    expect(r).toMatchObject({ fill: { value: 'Yes', source: 'profile' }, reason: null });
  });

  test('previously worked: "former employee of" template answers No', () => {
    // The second template shape, with a history lacking GitLab.
    const r = one(yesNo('Are you a former employee of GitLab?'), [], history, 'GitLab');
    // No, from the profile.
    expect(r).toMatchObject({ fill: { value: 'No', source: 'profile' }, reason: null });
  });
});

describe('NEVER additions: ethnic, birth, whole-token dob/sex, accent folding', () => {
  // Each with an attested row keyed to its own label, so the plain bank lookup WOULD fill it.
  test.each([
    // Whole-token "dob".
    'DOB',
    // Substring "birth".
    'Birth date',
    // Whole-token "sex".
    'Sex',
    // ("Ethnic origin" left this list with H1, 2026-11-05: "ethnic" is an EEO fragment, not a NEVER one, so
    // Teja's attested row keyed to that exact label now answers it; see the H1 block.)
    // Accent folded first: "consént" becomes "consent".
    'Consént to background verification',
  ])('%s is refused even with an attested row', (label) => {
    // Plain normaliseKey (no accent fold): for "Consént" it does not matter, NEVER must still win.
    const key = label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
    // Free text, so the option check is not what refuses it.
    const r = one({ id: 'q', label, kind: 'text', required: true }, [row(key, 'Yes')]);
    // Refused by category.
    expect(r).toMatchObject({ fill: null, reason: 'human_only' });
  });

  test('"Adobe" is not the token "dob": an ordinary bank answer fills', () => {
    // Whole-token matching is what stops "dob" over-catching common words like Adobe.
    const r = one({ id: 'q', label: 'Do you know Adobe Photoshop?', kind: 'text', required: true }, [row('do_you_know_adobe_photoshop', 'Yes')]);
    // Filled from the bank: not NEVER, not eligibility.
    expect(r).toMatchObject({ fill: { value: 'Yes', source: 'answer_bank' }, reason: null });
  });
});

describe('review round 3: accents, spacing variants, unscoped sponsorship', () => {
  test('an accented past employer equals its plain spelling: "Nestlé" worked → Yes for "Nestle"', () => {
    // Without the shared accent fold, "Nestlé" normalised to "nestl" and this said a false "No".
    const r = one(yesNo('Have you worked at Nestle?'), [], withCompanies(['Nestlé']), 'Nestle');
    // His experience names the company, so Yes, from the profile.
    expect(r).toMatchObject({ fill: { value: 'Yes', source: 'profile' }, reason: null });
  });

  test('a spacing variant ("Git Lab" vs "GitLab") refuses rather than saying No', () => {
    // Equal once the separators go: likely the same company, so a "No" would be false.
    const r = one(yesNo('Have you previously worked at GitLab?'), [], withCompanies(['Git Lab']), 'GitLab');
    // Teja decides.
    expect(r).toMatchObject({ fill: null, reason: 'human_only' });
  });

  test('unscoped "Do you need visa sponsorship?" refuses even with an attested No', () => {
    // Teja's "No" holds for his current location only; on a US role this question is likely
    // a "Yes", so only the "...to remain in your current location" wording is answered.
    const r = one(yesNo('Do you need visa sponsorship?'), [noSponsor]);
    // Not a template match, so it goes to him.
    expect(r).toMatchObject({ fill: null, reason: 'human_only' });
  });
});

// ---------------------------------------------------------------------------
// EEO answers (Teja, 2026-10-09 14:19). EEO questions may be answered, but ONLY from a
// browser-attested eeo_* row, via ONE whole-label template per question. Never guessed, never a
// default "Decline": an unanswered EEO field is left blank.
// ---------------------------------------------------------------------------

/** A one-field EEO control; id fixed because each case plans exactly one field. */
function eeoField(label: string, required: boolean, kind: FormField['kind'], options?: readonly string[]): FormField {
  // Options key absent when undefined, as extraction leaves it for react-select.
  return { id: 'q', label, kind, required, ...(options ? { options } : {}) };
}

describe('EEO answers from attested eeo_* rows only', () => {
  // GitLab's real Greenhouse option texts, so a fill proves the stored text matches a real form.
  const genderOptions = ['Decline To Self Identify', 'Female', 'Male'];
  // Same source.
  const veteranOptions = ["I don't wish to answer", 'I identify as one or more of the classifications of a protected veteran', 'I am not a protected veteran'];
  // Same source.
  const raceOptions = ['Decline To Self Identify', 'Two or More Races', 'Native Hawaiian or Other Pacific Islander', 'White', 'Hispanic or Latino', 'Black or African American', 'Asian', 'American Indian or Alaskan Native'];

  test('unanswered EEO stays blank', () => {
    // Optional, as on real forms, and no row at all.
    const blank = one(eeoField('Gender', false, 'radio_group', genderOptions), []);
    // No fill: the system never picks "Decline To Self Identify" on Teja's behalf.
    expect(blank.fill).toBeNull();
    // No blocker either: an optional refusal is silent, so the field is simply left blank.
    expect(blank.plan.blockers).toEqual([]);
    // A machine-written eeo_gender row is the same as no row.
    const unattested = one(eeoField('Gender', false, 'radio_group', genderOptions), [row('eeo_gender', 'Male', false)]);
    // Still blank.
    expect(unattested.fill).toBeNull();
    // Still silent.
    expect(unattested.plan.blockers).toEqual([]);
  });

  test("an EEO option not in the form's list is refused", () => {
    // Required so the refusal is visible; "Man" is plausible but not an option here.
    const r = one(eeoField('Gender', true, 'radio_group', genderOptions), [row('eeo_gender', 'Man')]);
    // Never approximated to "Male".
    expect(r).toMatchObject({ fill: null, reason: 'no_matching_option' });
  });

  test('an EEO option mismatch on an optional field is silent', () => {
    // Same mismatch, optional field: left blank rather than parking the application.
    const r = one(eeoField('Gender', false, 'radio_group', genderOptions), [row('eeo_gender', 'Man')]);
    // No fill.
    expect(r.fill).toBeNull();
    // No blocker.
    expect(r.plan.blockers).toEqual([]);
  });

  test('attested eeo_gender fills Gender verbatim', () => {
    // Required radio with the real options.
    const r = one(eeoField('Gender', true, 'radio_group', genderOptions), [row('eeo_gender', 'Male')]);
    // Verbatim, from the bank.
    expect(r).toMatchObject({ fill: { value: 'Male', source: 'answer_bank' }, reason: null });
  });

  test('attested eeo_veteran_status fills Veteran Status', () => {
    // GitLab's long option text, stored exactly.
    const r = one(eeoField('Veteran Status', true, 'radio_group', veteranOptions), [row('eeo_veteran_status', 'I am not a protected veteran')]);
    // Verbatim.
    expect(r).toMatchObject({ fill: { value: 'I am not a protected veteran', source: 'answer_bank' }, reason: null });
  });

  test('attested eeo_race fills Race', () => {
    // ^race$ template.
    const r = one(eeoField('Race', true, 'radio_group', raceOptions), [row('eeo_race', 'Asian')]);
    // Verbatim.
    expect(r).toMatchObject({ fill: { value: 'Asian', source: 'answer_bank' }, reason: null });
  });

  test('attested eeo_hispanic_latino fills a react-select with no readable options', () => {
    // Combobox: options undefined, so the exact-option check happens at fill time instead.
    const r = one(eeoField('Are you Hispanic/Latino?', true, 'combobox'), [row('eeo_hispanic_latino', 'No')]);
    // Verbatim.
    expect(r).toMatchObject({ fill: { value: 'No', source: 'answer_bank' }, reason: null });
  });

  test('a needs_human eeo_* row is awaiting_human_answer', () => {
    // Placeholder row for a required field: a different action for Teja than "no row".
    const r = one(eeoField('Gender', true, 'radio_group', genderOptions), [row('eeo_gender', null, true, true)]);
    // Named accordingly.
    expect(r).toMatchObject({ fill: null, reason: 'awaiting_human_answer' });
  });

  // EEO wording with no template, with an attested row keyed to the label itself. H1 (Teja, 2026-11-05
  // 23:19): answered from that row; before, always refused.
  test.each([
    // "gender identity" is not the ^gender$ template.
    'What is your gender identity?',
    // lgbt, no template.
    'Do you identify as LGBTQ+?',
    // marital, no template.
    'Marital status',
    // "race" inside "embrace": over-refusal, the safe direction (Teja just answers it).
    'Do you embrace remote work?',
  ])('%s is answered without a template from the exact-label attested row (H1)', (label) => {
    // Teja's answer to this very label.
    const key = label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
    // Required text field, so the option check is not in play.
    const r = one(eeoField(label, true, 'text'), [row(key, 'Yes')]);
    // Copied verbatim.
    expect(r).toMatchObject({ fill: { value: 'Yes', source: 'answer_bank' }, reason: null });
  });

  test('the exact-label key "gender" answers the "Gender" field even without an eeo_gender row (H1)', () => {
    // The key H2 records for this field is the label's own; Teja answering it must fill it, or the
    // Unanswered list would ask him the same question forever.
    const r = one(eeoField('Gender', true, 'radio_group', genderOptions), [row('gender', 'Male')]);
    // Answered.
    expect(r).toMatchObject({ fill: { value: 'Male', source: 'answer_bank' }, reason: null });
  });

  test('a checkbox-kind EEO field is refused even with an attested answer', () => {
    // The live filler throws on any checkbox, which would park the whole application.
    const r = one(eeoField('Gender', true, 'checkbox'), [row('eeo_gender', 'Male')]);
    // Refused at planning instead, before any field is typed.
    expect(r).toMatchObject({ fill: null, reason: 'human_only' });
  });

  // NEVER runs before EEO: a label mixing an EEO word with a never-automatic one is refused,
  // even with every eeo_* row attested.
  test.each([
    'What is your date of birth / race?',
    'I consent to the use of my gender data',
    'Are you a veteran with a criminal record?',
    'Gender / Sex',
  ])('"%s" is refused: NEVER wins over EEO', (label) => {
    // Attested answers for every EEO key, so only the NEVER check can refuse.
    const rows = [row('eeo_gender', 'Male'), row('eeo_race', 'Asian'), row('eeo_veteran_status', 'I am not a protected veteran')];
    // Free text, so no option list is involved.
    const r = one(eeoField(label, true, 'text'), rows);
    // Refused.
    expect(r).toMatchObject({ fill: null, reason: 'human_only' });
  });
});

// H1 (Teja, 2026-11-05 23:19): an answer_bank row attested by Teja and keyed to the EXACT normalised label
// may answer an EEO, eligibility or opinion question of that label. Never a paraphrase, never an unattested
// row, and a consent checkbox is NEVER answered.
describe('H1: the exact-label attested row', () => {
  test('a consent checkbox stays blocked even with an attested row keyed to its exact label', () => {
    // The label's own key, attested: the strongest possible match.
    const label = 'I consent to the processing of my personal data';
    // Teja's "Yes" for that very label.
    const r = one({ id: 'q', label, kind: 'checkbox', required: true }, [row('i_consent_to_the_processing_of_my_personal_data', 'Yes')]);
    // Never answered.
    expect(r).toMatchObject({ fill: null, reason: 'human_only' });
  });

  test('an exact-label EEO question is answered from the attested row', () => {
    // A wording no EEO template covers, with its options.
    const r = one(yesNo('How do you identify your gender?', true, ['Man', 'Woman', 'Non-binary']), [row('how_do_you_identify_your_gender', 'Man')]);
    // Answered verbatim.
    expect(r).toMatchObject({ fill: { value: 'Man', source: 'answer_bank' }, reason: null });
  });

  test('a near-miss label ("Gender identity" against the bank row "gender") stays blocked', () => {
    // The row answers "Gender", not "Gender identity": a paraphrase never answers.
    const r = one(yesNo('Gender identity', true, ['Male', 'Female']), [row('gender', 'Male')]);
    // Teja answers it.
    expect(r).toMatchObject({ fill: null, reason: 'human_only' });
  });

  test('an eligibility paraphrase ("authorised" against a bank row for "authorized") stays blocked', () => {
    // One letter apart: a different label.
    const r = one({ id: 'q', label: 'Are you authorized to work in India?', kind: 'text', required: true }, [row('are_you_authorised_to_work_in_india', 'Yes')]);
    // Refused.
    expect(r).toMatchObject({ fill: null, reason: 'human_only' });
  });

  test('an unattested exact-label row never answers an EEO question', () => {
    // A machine-written row keyed to the exact label.
    const r = one(yesNo('How do you identify your gender?', true, ['Man', 'Woman']), [row('how_do_you_identify_your_gender', 'Man', false)]);
    // Refused.
    expect(r).toMatchObject({ fill: null, reason: 'human_only' });
  });

  test('an exact-label answer that differs from an option only in case plans the form\'s option ("man" -> "Man")', () => {
    // "man" is "Man" in lowercase: the same statement, in the form's own spelling.
    const r = one(yesNo('How do you identify your gender?', true, ['Man', 'Woman']), [row('how_do_you_identify_your_gender', 'man')]);
    // The option text, from Teja's attested row.
    expect(r).toMatchObject({ fill: { value: 'Man', source: 'answer_bank' }, reason: null });
  });

  test('an exact-label answer that is a different word from every option is refused, never approximated', () => {
    // "male" is not "Man": a synonym, not a spelling, and option-match has no synonym rule.
    const r = one(yesNo('How do you identify your gender?', true, ['Man', 'Woman']), [row('how_do_you_identify_your_gender', 'male')]);
    // Named.
    expect(r).toMatchObject({ fill: null, reason: 'no_matching_option' });
  });
});
