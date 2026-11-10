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
import type { AnswerBankRow, MasterProfile } from '@applyy/shared-types';
// The worker's own DOM concern; not a database shape, so it lives here.
import type { FormField } from '../src/extract-fields.ts';

// Subject under test; absent, which is what makes this file RED.
import { planFill } from '../src/plan-fill.ts';

/** Builds an answer-bank row with only the fields the planner actually reads. */
function answer(question_key: string, answer_value: unknown, needs_human = false, attested_by_human = true): AnswerBankRow {
  // Cast at the boundary: the planner reads four fields, and spelling out all
  // eleven in every test would obscure which one each case is about.
  // attested_by_human: true because of T8 default-deny: a bank row fills a plain
  // question only when a human attested it. These tests pin OTHER rules (shape,
  // matching, option picks), so the helper hands them an attested row; the
  // unattested case is pinned in test/plan-fill-attested-only.test.ts. The denylist
  // tests pass false: an attested exact-label row answers EEO/eligibility (H1).
  return { question_key, answer_value, needs_human, answer_type: 'text', attested_by_human } as unknown as AnswerBankRow;
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
    expect(plan.fills).toEqual([{ id: 'first_name', value: 'Teja', kind: 'text', source: 'answer_bank' }]);
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
    expect(plan.fills).toMatchObject([{ id: 'fn', value: 'Teja', source: 'answer_bank' }]);
  });
});

// ---------------------------------------------------------------------------
// Profile-sourced fills, the human-only denylist, and answer-bank hardening.
// ---------------------------------------------------------------------------

/** A field of any kind, with optional options, for the cases the text-only helper cannot express. */
function fieldOf(id: string, label: string, required: boolean, kind: FormField['kind'], options?: readonly string[]): FormField {
  // Options only exist for selects/radios; the spread keeps the key absent otherwise, as extraction does.
  return { id, label, kind, required, ...(options ? { options } : {}) };
}

/** A profile whose location is varied per test, since the country rule turns on it. */
function profileAt(location: string | null): MasterProfile {
  // Same identity as the main fixture; only location changes, isolating the variable under test.
  return { identity: { ...profile.identity, location } } as unknown as MasterProfile;
}

// Identity facts the planner may copy; links use the real {id,label,url} shape.
const profile = {
  // Everything the resolver reads lives under identity, matching the live master_profiles rows.
  identity: {
    // Present only to prove the planner never derives name fields from it.
    full_name: 'Asha Rao',
    // Null, as in the live rows; nothing may read it.
    headline: null,
    // The email the profile resolver should copy.
    email: 'teja@example.com',
    // The phone the profile resolver should copy, verbatim.
    phone: '+91 99999 00000',
    // Two segments, so the country rule can resolve it.
    location: 'Hyderabad, India',
    // The real link shape: label classifies the link, url is the value.
    links: [
      // Serves the LinkedIn Profile question.
      { id: 'l1', label: 'LinkedIn', url: 'https://linkedin.com/in/teja' },
      // Present so the resolver must pick by label rather than by position.
      { id: 'l2', label: 'GitHub', url: 'https://github.com/teja' },
    ],
  },
} as unknown as MasterProfile;

describe('planFill — GitLab form against an empty bank', () => {
  // The 16 labels of the real form that exposed these gaps: [label, required, kind].
  const gitlab: Array<[string, boolean, FormField['kind']]> = [
    // First Name: never derived from full_name (family-name-first risk), so no_answer.
    ['First Name', true, 'text'],
    // Last Name: same rule as First Name.
    ['Last Name', true, 'text'],
    // Email: plain profile fact, filled with source=profile.
    ['Email', true, 'text'],
    // Phone: optional but answerable, so filled from the profile.
    ['Phone', false, 'text'],
    // Resume/CV: file input, owned by the PDF pipeline, never the planner.
    ['Resume/CV', true, 'file'],
    // Cover Letter: file input, skipped like the resume.
    ['Cover Letter', false, 'file'],
    // LinkedIn Profile: label-classified link, filled from identity.links.
    ['LinkedIn Profile', false, 'text'],
    // Preferred name: optional and not derivable, so silently skipped.
    ["What's the name you'd prefer us to use throughout the interview process?", false, 'text'],
    // Country: factual, combobox validates exactly, so the last location segment fills it.
    ['What is your current country of residence?', true, 'combobox'],
    // located in: denylisted fragment, a legal-adjacent eligibility question, human_only.
    ['Are you located in India?', true, 'combobox'],
    // Employment agreements: contractual restriction, human_only.
    ['Are you subject to any employment agreements and/or post-employment restrictions with your current employer or a past employer?', true, 'combobox'],
    // Accessibility: optional free text with no source, so skipped (and not caught by "disab").
    ['Do you need any accessibility adjustments during the interview process?', false, 'text'],
    // Visa sponsorship: legal self-disclosure, human_only.
    ['Will you now or in the future require sponsorship for a visa to remain in your current location?', true, 'combobox'],
    // Previously worked: prior-employer relationship, human_only.
    ['Have you previously worked at or consulted for GitLab?', true, 'combobox'],
    // Open-source links: free-form with no profile source, so no_answer.
    ['Please share links of any open source projects you own or have made contributions to', true, 'textarea'],
    // Primary language: free-form skill question, no_answer (and not caught by any fragment).
    ['What is your primary programming language and/or framework?', true, 'text'],
  ];
  // One plan shared by every test below: the form is fixed, so planning it once is enough.
  const plan = planFill(gitlab.map(([l, r, k], i) => fieldOf(`f${i}`, l, r, k)), [], profile);
  // Reason per blocked label, for readable assertions.
  const reasonOf = (prefix: string) => plan.blockers.find((b) => b.label.startsWith(prefix))?.reason;

  test('fills Email, Phone, LinkedIn and Country from the profile only', () => {
    // Exactly these four and nothing else: any extra fill would be a guess.
    expect(plan.fills.map((f) => [f.id, f.value, f.source])).toEqual([
      // Email, copied verbatim from identity.email.
      ['f2', 'teja@example.com', 'profile'],
      // Phone, copied verbatim from identity.phone.
      ['f3', '+91 99999 00000', 'profile'],
      // LinkedIn, the url of the link labelled LinkedIn.
      ['f6', 'https://linkedin.com/in/teja', 'profile'],
      // Country, the last segment of "Hyderabad, India".
      ['f8', 'India', 'profile'],
    ]);
  });

  test('never derives First/Last name from full_name', () => {
    // full_name may be family-name-first, so splitting it could swap the two on a real form.
    expect(reasonOf('First Name')).toBe('no_answer');
    // Same guarantee for the surname field.
    expect(reasonOf('Last Name')).toBe('no_answer');
  });

  test('skips optional gaps (preferred name, accessibility) and files', () => {
    // None of these may appear as blockers: optional gaps and files are not the planner's business.
    expect(plan.blockers.some((b) => /prefer|accessibility|Cover|Resume/.test(b.label))).toBe(false);
  });

  test('sends the four legal questions and "located in India" to the human', () => {
    // Located-in is eligibility-adjacent, so it is denylisted.
    expect(reasonOf('Are you located in')).toBe('human_only');
    // Employment agreements bind Teja legally.
    expect(reasonOf('Are you subject to')).toBe('human_only');
    // Visa sponsorship is a legal self-disclosure.
    expect(reasonOf('Will you now or in the future')).toBe('human_only');
    // Prior employment with the company is a legal self-disclosure.
    expect(reasonOf('Have you previously worked')).toBe('human_only');
  });

  test('leaves open-source links and primary language unanswered', () => {
    // Free-form questions have no profile source, so they must block, not be invented.
    expect(reasonOf('Please share links')).toBe('no_answer');
    // Same for the language question; it is also proof no denylist fragment over-matches it.
    expect(reasonOf('What is your primary')).toBe('no_answer');
  });
});

describe('planFill — denylist', () => {
  test('a bank row for the visa question STILL gives human_only', () => {
    // The bank is the most trusted source, so this proves the denylist outranks it.
    const q = 'Will you now or in the future require sponsorship for a visa?';
    // A bank row exists with a plausible answer, which must be ignored.
    // Unattested (T8): an attested exact-label row would answer it under H1; this pins the plain bank row.
    const plan = planFill([field('v', q, true)], [answer(q, 'No', false, false)]);
    // Nothing typed, and the reason names the denylist rather than a missing answer.
    expect(plan.fills).toEqual([]);
    // human_only, not no_answer: the human must see this is a deliberate refusal.
    expect(plan.blockers[0]?.reason).toBe('human_only');
  });

  test('a visa-only question with a bank row STILL gives human_only', () => {
    // No other fragment (sponsor, work_authori...) appears here, so only 'visa' can catch it.
    const q = 'Do you hold a valid visa for the UK?';
    // The bank row would otherwise be typed verbatim.
    // Unattested (T8): an attested exact-label row would answer it under H1; this pins the plain bank row.
    const plan = planFill([field('v', q, true)], [answer(q, 'Yes', false, false)]);
    // Nothing typed.
    expect(plan.fills).toEqual([]);
    // Refused by the denylist alone.
    expect(plan.blockers[0]?.reason).toBe('human_only');
  });

  test('a work-permit question with a bank row gives human_only', () => {
    // 'work_permit' is one of the legal entries added in round 2; no older fragment matches it.
    const q = 'Do you need a work permit?';
    // A bank row exists, so only the denylist can stop it.
    // Unattested (T8): an attested exact-label row would answer it under H1; this pins the plain bank row.
    const plan = planFill([field('w', q, true)], [answer(q, 'No', false, false)]);
    // Nothing typed.
    expect(plan.fills).toEqual([]);
    // Refused as legal.
    expect(plan.blockers[0]?.reason).toBe('human_only');
  });

  // One case per round-3 fragment, so dropping any single entry turns its own row red.
  test.each([
    // An attestation: swearing the form is true is Teja's statement, never the bank's.
    ['I certify that the information provided is true and complete', 'Yes'],
    // Consent to data processing is a decision, not a fact about Teja.
    ['Do you consent to us storing your data for future roles?', 'Yes'],
    // Caste is a protected-class disclosure on Indian forms.
    ['What is your caste category?', 'General'],
  ])('%s, with a bank row, gives human_only', (q, value) => {
    // The bank holds an answer, so only the denylist stands between it and the form.
    // Unattested (T8): an attested exact-label row would answer it under H1; this pins the plain bank row.
    const plan = planFill([field('x', q, true)], [answer(q, value, false, false)]);
    // Nothing is typed.
    expect(plan.fills).toEqual([]);
    // It is routed to the human as a legal/consent question.
    expect(plan.blockers[0]?.reason).toBe('human_only');
  });

  test('an optional legal question is skipped silently', () => {
    // Optional plus denylisted: nothing typed and nothing blocking.
    // Unattested (T8): an attested exact-label row would answer it under H1; this pins the plain bank row.
    const plan = planFill([field('g', 'Gender', false)], [answer('gender', 'Male', false, false)]);
    // The bank row must not leak through an optional field.
    expect(plan.fills).toEqual([]);
    // Optional gaps never block the application.
    expect(plan.blockers).toEqual([]);
  });

  test('does NOT catch the factual country-of-residence question', () => {
    // Over-matching must stop short of factual questions, or the profile could never answer them.
    const plan = planFill([fieldOf('c', 'What is your current country of residence?', true, 'combobox')], [], profile);
    // Filled from the location, proving no fragment matched "residence".
    expect(plan.fills[0]?.value).toBe('India');
  });

  test.each([
    // "language" and "manage" contain "age": proves no bare "age" fragment was added.
    ['What is your primary programming language?'],
    // "manage" again, in a different position.
    ['How do you manage a team?'],
    // Expected CTC is a legitimate bank answer, not a legal disclosure.
    ['What is your expected CTC?'],
  ])('"%s" is NOT caught by any denylist fragment', (label) => {
    // Each would be a false positive of a naive "age" or salary fragment; with no bank row
    // and no profile synonym the only possible outcome is no_answer, never human_only.
    const plan = planFill([field('x', label, true)], []);
    // no_answer proves the denylist let it through to the normal lookup.
    expect(plan.blockers[0]?.reason).toBe('no_answer');
  });

  test('a checkbox is never planned: human_only when required, skipped when optional', () => {
    // The live filler throws on checkboxes late, so the planner must refuse them up front.
    const required = planFill([fieldOf('k', 'Notice Period', true, 'checkbox')], [answer('notice_period', 'Yes')]);
    // Even with a bank answer, nothing is planned for a checkbox.
    expect(required.fills).toEqual([]);
    // Required checkbox goes to the human.
    expect(required.blockers[0]?.reason).toBe('human_only');
    // Optional checkbox: no blocker, no fill.
    const optional = planFill([fieldOf('k', 'Notice Period', false, 'checkbox')], [answer('notice_period', 'Yes')]);
    // Nothing planned.
    expect(optional.fills).toEqual([]);
    // Nothing blocking either.
    expect(optional.blockers).toEqual([]);
  });
});

describe('planFill — country rule', () => {
  // A required country question of the given kind.
  const country = (kind: FormField['kind'], options?: readonly string[]) =>
    fieldOf('c', 'What is your current country of residence?', true, kind, options);

  test('a bare city ("Hyderabad") gives null, not a country', () => {
    // One segment is ambiguous; the old `.pop()` returned "Hyderabad" as the country.
    const plan = planFill([country('combobox')], [], profileAt('Hyderabad'));
    // Nothing may be typed from a one-segment location.
    expect(plan.fills).toEqual([]);
    // The required field falls through to the normal no-answer refusal.
    expect(plan.blockers[0]?.reason).toBe('no_answer');
  });

  test('a text-kind country field is never filled from a parsed location', () => {
    // Free text has nothing to validate the guess, so it must go to the human.
    const plan = planFill([country('text')], [], profile);
    // No parsed guess typed.
    expect(plan.fills).toEqual([]);
    // Refused as unanswerable.
    expect(plan.blockers[0]?.reason).toBe('no_answer');
  });

  test('"Hyderabad, India" on a combobox gives India', () => {
    // The happy path: two segments, validating control.
    expect(planFill([country('combobox')], [], profile).fills[0]?.value).toBe('India');
  });

  test('a native_select whose options lack the country is refused', () => {
    // The resolver returns null when the exact string is not offered, so nothing is typed.
    const plan = planFill([country('native_select', ['Bharat', 'USA'])], [], profile);
    // No near-match is substituted.
    expect(plan.fills).toEqual([]);
    // Refused as unanswerable.
    expect(plan.blockers[0]?.reason).toBe('no_answer');
  });
});

describe('planFill — answer bank hardening', () => {
  // One-field plan over a single bank row, so each case varies only the stored value.
  const run = (value: unknown, required = true) => planFill([field('q', 'Notice Period', required)], [answer('notice_period', value)]);

  test.each([
    // null: bug B, never type the literal "null" into a real form.
    [null],
    // Empty string: a blank is missing data, not an answer.
    [''],
    // Whitespace only: blank after trimming.
    ['   '],
    // Boolean: jsonb true must not become the text "true".
    [true],
    // Array: a list is not a typeable scalar.
    [['a']],
  ])('answer_value %j gives invalid_answer', (value) => {
    // None of these is a typeable answer; typing them would put "null" or "true" on a real form.
    const plan = run(value);
    // Nothing planned.
    expect(plan.fills).toEqual([]);
    // Reported distinctly so the human knows the stored row is corrupt.
    expect(plan.blockers[0]?.reason).toBe('invalid_answer');
  });

  test('an invalid value on an optional field is skipped', () => {
    // Optional fields never block, even on corrupt data.
    expect(run(null, false).blockers).toEqual([]);
  });

  test('a number is typed as its string form', () => {
    // Numeric jsonb is legitimate (e.g. years of experience), so it must survive as text.
    expect(run(42).fills[0]?.value).toBe('42');
  });

  test('two keys normalising alike give ambiguous_answer_key naming both', () => {
    // "notice_period" and "Notice Period" normalise identically, so last-one-wins would be a coin flip.
    const plan = planFill([field('q', 'Notice Period', true)], [answer('notice_period', '30'), answer('Notice Period', '60')]);
    // Neither value may be typed.
    expect(plan.fills).toEqual([]);
    // Bug E: the collision is reported, not silently resolved.
    expect(plan.blockers[0]?.reason).toBe('ambiguous_answer_key');
    // The human needs both raw keys to know which row to delete.
    expect(plan.blockers[0]?.label).toContain('notice_period');
    // The second key too.
    expect(plan.blockers[0]?.label).toContain('Notice Period');
  });

  test('the bank beats the profile', () => {
    // A deliberately saved answer is more authoritative than a derived profile copy.
    const plan = planFill([field('e', 'Email', true)], [answer('email', 'other@example.com')], profile);
    // Value and source both prove the bank won.
    expect(plan.fills[0]).toMatchObject({ value: 'other@example.com', source: 'answer_bank' });
  });

  test('a select answer not among the options gives no_matching_option', () => {
    // "30" is close to "30 days" but a fuzzy pick could choose the wrong option.
    const f = fieldOf('s', 'Notice Period', true, 'native_select', ['15 days', '30 days']);
    // Near-miss refused.
    expect(planFill([f], [answer('notice_period', '30')]).blockers[0]?.reason).toBe('no_matching_option');
    // The exact option string is accepted.
    expect(planFill([f], [answer('notice_period', '30 days')]).fills[0]?.value).toBe('30 days');
  });
});

// Round-3 table rows: full name copied whole, city derived, and the hCaptcha non-fill.
describe('planFill - full name and city rows', () => {
  // Rows are [label, expected value]; profile location is "Hyderabad, India" (two segments).
  const rows: Array<[string, string]> = [
    // Full name: copied as-is from identity.full_name, never split into first/last.
    ['Full name', 'Asha Rao'],
    // City: first location segment, allowed because the location has two segments.
    ['City', 'Hyderabad'],
  ];
  // One plan over both rows, answered purely from the profile (empty bank).
  const plan = planFill(rows.map(([l], i) => fieldOf(`r${i}`, l, true, 'text')), [], profile);

  test('fills Full name as-is and City from the first segment', () => {
    // Value and source asserted together so a bank-sourced fill cannot pass by accident.
    expect(plan.fills.map((x) => [x.value, x.source])).toEqual(rows.map(([, v]) => [v, 'profile']));
  });

  test('a one-segment location refuses City (ambiguous) but still fills Full name', () => {
    // "Hyderabad" alone could be a country, so City must block with no_answer.
    const p = planFill(rows.map(([l], i) => fieldOf(`r${i}`, l, true, 'text')), [], profileAt('Hyderabad'));
    // Only the name fills.
    expect(p.fills.map((x) => x.value)).toEqual(['Asha Rao']);
    // City is the blocker.
    expect(p.blockers.map((b) => b.reason)).toEqual(['no_answer']);
  });

  test('a bank row keyed h-captcha-response fills nothing, as no such field is extracted', () => {
    // The REAL guard is the extraction test (hcaptcha-lever-like.html): the field never exists.
    // With only real fields passed in, a stray bank row has nothing to attach to.
    const p = planFill([fieldOf('full_name', 'Full name', true, 'text')], [answer('h-captcha-response', 'token')], profile);
    // Only the real field fills; no fill carries the captcha id.
    expect(p.fills.map((x) => x.id)).toEqual(['full_name']);
  });
});
