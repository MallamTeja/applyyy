// OFFLINE PRE-FLIGHT for the planned FIRST BOT SUBMIT: TrueFoundry "Backend Interns", Greenhouse
// job 5126892008, application row d0a7d313 (2026-11-09, peer 4 brief, stage 5).
//
// WHY THIS FILE EXISTS. The row's apply_url is a careerpuck.com wrapper; form-url.ts resolves it to
// Greenhouse's embed form, and that embed form is what the bot will actually fill. The earlier
// "pre-check 8/8" never read the two required comboboxes' OPTIONS (they load from Greenhouse's API at
// fill time, after any plan exists), so it could not see this: the profile says degree "B.Tech" and a
// school Greenhouse's list does not hold, and the filler only ever picks an EXACT option. A live run
// would therefore park the row at fill time (unanswerable_question) instead of submitting.
// This file pins the form, proves that hazard offline, and proves the two answer-bank rows that fix it.
//
// Fixtures: truefoundry-5126892008-backend-interns.html (the embed form, captured 2026-11-09, scripts
// stripped) and truefoundry-education-degrees.json (Greenhouse's public degree list for this board,
// boards-api.greenhouse.io/v1/boards/truefoundry/education/degrees, same day). Profile and bank values
// below are INVENTED with the live data's shape: a test never carries real PII.
import { afterAll, beforeAll, expect, test } from 'vitest';
// Real Chromium over a localhost fixture: the same extractor code path apply-one.ts drives.
import { chromium, type Browser, type Page } from 'playwright';
// Reads the saved degree list; the live API is never called from a test.
import { readFileSync } from 'node:fs';
// Serves worker/fixtures over http, so the page loads like a real board would.
import { startFixtureServer, type FixtureServer } from '../src/fixture-server.ts';
// The extractor under test; its output is what every gate and planner below consumes.
import { extractFields } from '../src/extract-fields.ts';
// The planner that decides what is typed and what is left for the human.
import { planFill } from '../src/plan-fill.ts';
// The planner that picks the file input the resume goes into.
import { planResumeAttachment } from '../src/plan-resume-attachment.ts';
// The no_form_fields / no_email_field gate the applier runs on the raw extraction.
import { formShapeBlockersFor } from '../src/apply-one.ts';
// Type-only: the two inputs planFill takes besides the fields.
import type { AnswerBankRow, MasterProfile } from '@applyy/shared-types';

// Shared across tests: one Chromium launch costs seconds, and the page never changes.
let browser: Browser;
// The localhost server holding the capture.
let server: FixtureServer;
// The loaded form, read by every test.
let page: Page;

// Greenhouse's own option texts for the Degree combobox; the filler can pick only one of these, verbatim.
const DEGREES: string[] = (JSON.parse(readFileSync('fixtures/greenhouse/truefoundry-education-degrees.json', 'utf8')) as { items: { text: string }[] }).items.map((i) => i.text);

beforeAll(async () => {
  // Headless, as on the CI runner that will make the submit.
  browser = await chromium.launch();
  // Same fixtures root the other fixture tests use, so a removed file fails loudly.
  server = await startFixtureServer('fixtures');
  // One page for the whole file.
  page = await browser.newPage();
  // The exact form the resolver sends the bot to.
  await page.goto(`${server.url}/greenhouse/truefoundry-5126892008-backend-interns.html`);
}, 60_000);

afterAll(async () => {
  // A leaked Chromium keeps a CI job alive until its timeout.
  await browser?.close();
  // And the port.
  await server?.close();
});

// The live master profile's identity + education shape (2026-11-09), invented values.
const profile = {
  identity: {
    // Present so a name field filled from here (never allowed) would show up in the fills.
    full_name: 'Asha Rao',
    // Copied verbatim into Email.
    email: 'asha@example.com',
    // 10 bare digits, the live shape.
    phone: '9999900000',
    // "<city>, India": the country rule resolves "India" for the Country combobox.
    location: 'Hyderabad, India',
    // The {id,label,url} link shape the resolver classifies by label.
    links: [{ id: 'l1', label: 'LinkedIn', url: 'https://linkedin.com/in/asha' }, { id: 'l2', label: 'Portfolio', url: 'https://asha.example' }],
  },
  // The live first entry's shape: an Indian degree abbreviation and a school Greenhouse does not list.
  education: [{ id: 'e1', institution: 'Example Institute of Technology', degree: 'B.Tech', field: 'CSE' }],
} as unknown as MasterProfile;

// The live bank's name rows; names are never derived from full_name.
const nameRows = [
  // Bank-sourced first name.
  { question_key: 'first_name', answer_value: 'Asha' },
  // Bank-sourced last name.
  { question_key: 'last_name', answer_value: 'Rao' },
].map((r) => ({ ...r, needs_human: false, answer_type: 'text', attested_by_human: false })) as unknown as AnswerBankRow[];

// T8: live first_name/last_name rows are UNATTESTED (measured 2026-11-10), so the planner ignores them and the
// names park as no_answer until Teja saves each row in the web Answer bank page. These are the same rows AFTER that
// Save: the state every FIX below describes.
const attestedNameRows = nameRows.map((r) => ({ ...r, attested_by_human: true })) as unknown as AnswerBankRow[];
// T8: the plan-time blockers the live names cause; named once so each test asserts the same exact pair.
const NAME_BLOCKERS = [['first_name', 'no_answer'], ['last_name', 'no_answer']];

test('extracts the 12-field embed form exactly, and it passes the form-shape gate', async () => {
  // The raw extraction the applier reads.
  const fields = await extractFields(page);
  // A stable view: id, kind, label, required. A Greenhouse reskin that drops or renames one fails here.
  expect(fields.map((f) => [f.id, f.kind, f.label, f.required])).toEqual([
    ['first_name', 'text', 'First Name', true],
    ['last_name', 'text', 'Last Name', true],
    ['preferred_name', 'text', 'Preferred First Name', false],
    ['email', 'text', 'Email', true],
    ['country', 'combobox', 'Country', true],
    ['phone', 'tel', 'Phone', true],
    ['resume', 'file', 'Attach', false],
    ['cover_letter', 'file', 'Attach', false],
    ['school--0', 'combobox', 'School', true],
    ['degree--0', 'combobox', 'Degree', true],
    ['question_15091012008', 'text', 'LinkedIn Profile', false],
    ['question_15091013008', 'text', 'Website', false],
  ]);
  // Email is type=text here, so the gate must pass on the LABEL; an empty array means no shape blocker.
  expect(formShapeBlockersFor('d0a7d313', fields)).toEqual([]);
});

test('HAZARD: profile-only, the plan is clean but the Degree it types is not a Greenhouse option', async () => {
  // What the bot plans today, with no school/degree rows in the bank.
  const fields = await extractFields(page);
  // The applier's call shape (apply-one.ts:608), with the posting's company.
  const plan = planFill(fields, nameRows, profile, 'TrueFoundry');
  // The planner sees no blocker: combobox options are unknown at plan time, so nothing refuses.
  // T8: the only blockers are the two unattested live name rows (park until Teja saves them). They are kept, not
  // attested away, because this test replays the LIVE bank; the hazard itself is unchanged: no Degree/School blocker.
  expect(plan.blockers.map((b) => [b.id, b.reason])).toEqual(NAME_BLOCKERS);
  // id -> [value, source], for exact comparison.
  const byId = Object.fromEntries(plan.fills.map((f) => [f.id, [f.value, f.source]]));
  // The profile's abbreviation, verbatim: the planner never rewords a statement.
  expect(byId['degree--0']).toEqual(['B.Tech', 'profile']);
  // ...and Greenhouse offers no such option, so the exact-pick filler throws and the row parks.
  expect(DEGREES).not.toContain('B.Tech');
});

test('FIX: bank rows degree="Bachelor\'s Degree" and school="Other" win over the profile and are real options', async () => {
  // The two rows the orch asks Teja to save (his statements, so never written by an agent).
  const bank = [
    // T8: the state AFTER Teja saves the name rows too; unattested names would park and hide whether the fix works.
    ...attestedNameRows,
    // A B.Tech in progress is a bachelor's degree; Greenhouse's own option text, verbatim.
    { question_key: 'degree', answer_value: "Bachelor's Degree", needs_human: false, answer_type: 'text', attested_by_human: true },
    // His school is not in Greenhouse's list (searched "MLR", "MLRIT", "Marri Laxman": 0 hits); "Other" is.
    { question_key: 'school', answer_value: 'Other', needs_human: false, answer_type: 'text', attested_by_human: true },
  ] as unknown as AnswerBankRow[];
  // Same call as above, now with the bank rows.
  const plan = planFill(await extractFields(page), bank, profile, 'TrueFoundry');
  // id -> [value, source].
  const byId = Object.fromEntries(plan.fills.map((f) => [f.id, [f.value, f.source]]));
  // The bank row outranks the profile (plan-fill.ts: "the human-saved answer wins").
  expect(byId['degree--0']).toEqual(["Bachelor's Degree", 'answer_bank']);
  // Same for the school.
  expect(byId['school--0']).toEqual(['Other', 'answer_bank']);
  // And the degree value is one Greenhouse actually offers, so the exact pick can succeed.
  expect(DEGREES).toContain("Bachelor's Degree");
  // Every required control is planned: names, email, country, phone, school, degree.
  expect(plan.fills.map((f) => f.id).sort()).toEqual(['country', 'degree--0', 'email', 'first_name', 'last_name', 'phone', 'question_15091012008', 'question_15091013008', 'school--0'].sort());
  // Nothing left for a human on this form.
  expect(plan.blockers).toEqual([]);
});

test('the resume goes into the Resume input, never the cover-letter one', async () => {
  // Both file inputs are labelled "Attach"; only the id tells them apart.
  const fields = await extractFields(page);
  // The applier's call shape, with a rendered resume available.
  const attachment = planResumeAttachment(fields, { hasResumeSnapshot: true });
  // A plan exists and it targets the resume input.
  expect([attachment.canProceed, attachment.target?.id]).toEqual([true, 'resume']);
});

test('LIVE BANK (T8): unattested degree/school rows are ignored, so Degree and School fall to the profile and park', async () => {
  // The live bank as measured 2026-11-10: names plus the 11-09 degree/school rows, none attested by Teja yet.
  const bank = [
    // Live names, unattested.
    ...nameRows,
    // T8: saved 11-09 but never attested, so the planner treats it as absent.
    { question_key: 'degree', answer_value: "Bachelor's Degree", needs_human: false, answer_type: 'text', attested_by_human: false },
    // T8: same for the school row.
    { question_key: 'school', answer_value: 'Other', needs_human: false, answer_type: 'text', attested_by_human: false },
  ] as unknown as AnswerBankRow[];
  // The applier's call shape, against the live bank.
  const plan = planFill(await extractFields(page), bank, profile, 'TrueFoundry');
  // Plan time: only the names park (no_answer); Degree and School are not blocked here, they are filled from the profile.
  expect(plan.blockers.map((b) => [b.id, b.reason])).toEqual(NAME_BLOCKERS);
  // id -> [value, source].
  const byId = Object.fromEntries(plan.fills.map((f) => [f.id, [f.value, f.source]]));
  // T8: the unattested bank row lost to the profile, so the profile's abbreviation is typed.
  expect(byId['degree--0']).toEqual(['B.Tech', 'profile']);
  // T8: same for the school: the profile's institution, which Greenhouse's school list does not hold.
  expect(byId['school--0']).toEqual(['Example Institute of Technology', 'profile']);
  // Fill time: B.Tech is not a Greenhouse option, so the exact-pick filler parks the row on Degree (School likewise).
  expect(DEGREES).not.toContain('B.Tech');
});
