// OFFLINE PRE-FLIGHT: Cadence Solutions "Software Engineering Intern", Greenhouse job 4711210006 (board
// "solutions"), application row 526e7895 (2026-11-09, peer 3 brief t2: "make the next Greenhouse rows bot-ready").
//
// WHY THIS FILE EXISTS. Planned offline against the live answer bank, this 20-field form leaves six required
// controls unanswered (three education dates, two yes/no questions, one visa question that is human_only by
// rule). Two more fail only at FILL time, which a plan cannot see: the profile's degree ("B.Tech") and
// discipline ("Computer Science & Data Science (CSD)") are not Greenhouse options, and the filler picks only
// an EXACT option. This file pins the form, proves every gap, and proves which bank rows close them.
//
// Fixtures: cadence-4711210006-swe-intern.html (the job page form, captured 2026-11-09 with
// worker/scripts/capture-fixture.ts, scripts stripped), cadence-4711210006-questions.json (the job's public
// boards-api questions with option texts) and cadence-education.json (the board's full degree and
// discipline lists), same day. Profile and bank values are INVENTED with the live shape: no real PII.
import { afterAll, beforeAll, expect, test } from 'vitest';
// Real Chromium over a localhost fixture: the same extractor code path apply-one.ts drives.
import { chromium, type Browser, type Page } from 'playwright';
// Reads the saved option lists; the live API is never called from a test.
import { readFileSync } from 'node:fs';
// Serves worker/fixtures over http, so the page loads like a real board would.
import { startFixtureServer, type FixtureServer } from '../src/fixture-server.ts';
// The extractor under test; its output is what every gate and planner below consumes.
import { extractFields } from '../src/extract-fields.ts';
// The planner that decides what is typed and what is left for the human.
import { planFill } from '../src/plan-fill.ts';
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

// Greenhouse's option texts per custom-question field name; the filler picks only one of these, verbatim.
const OPTIONS: Record<string, string[]> = Object.fromEntries(
  // Every question's every field, flattened to name -> option texts.
  (JSON.parse(readFileSync('fixtures/greenhouse/cadence-4711210006-questions.json', 'utf8')) as { questions: { fields: { name: string; values: string[] }[] }[] })
    .questions.flatMap((q) => q.fields.map((f) => [f.name, f.values])),
);
// The board's whole degree and discipline lists (all pages), for the education comboboxes.
const EDU = JSON.parse(readFileSync('fixtures/greenhouse/cadence-education.json', 'utf8')) as { degrees: string[]; disciplines: string[] };

beforeAll(async () => {
  // Headless, as on the CI runner that will make the submit.
  browser = await chromium.launch();
  // Same fixtures root the other fixture tests use, so a removed file fails loudly.
  server = await startFixtureServer('fixtures');
  // One page for the whole file.
  page = await browser.newPage();
  // The job page form the bot fills.
  await page.goto(`${server.url}/greenhouse/cadence-4711210006-swe-intern.html`);
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
    // "<city>, India": the country rule resolves "India"; the city goes into Location (City).
    location: 'Hyderabad, India',
    // The {id,label,url} link shape the resolver classifies by label.
    links: [{ id: 'l1', label: 'LinkedIn', url: 'https://linkedin.com/in/asha' }, { id: 'l2', label: 'Portfolio', url: 'https://asha.example' }],
  },
  // The live first entry's shape: an Indian degree abbreviation, a long field name, ISO dates.
  education: [{ id: 'e1', institution: 'Example Institute of Technology', degree: 'B.Tech', field: 'Computer Science & Data Science (CSD)', start_date: '2024-08-01', end_date: '2027-06-01' }],
} as unknown as MasterProfile;

// One bank row in the live shape; values are the only thing a test varies.
const row = (question_key: string, answer_value: unknown) => ({ question_key, answer_value, needs_human: false, answer_type: 'text', attested_by_human: false });

// The live bank rows this form can use: names, plus the attested visa answer (which the planner still refuses).
const liveRows = [row('first_name', 'Asha'), row('last_name', 'Rao'), { ...row('visa_sponsorship_required', false), attested_by_human: true }] as unknown as AnswerBankRow[];

// The two custom yes/no question keys, as questionKey() derives them from the labels.
const Q_GRADUATING = 'are_you_graduating_in_december_2027_or_may_june_2028';
// The internship question.
const Q_INTERNSHIP = 'do_you_have_previous_software_engineering_internship_experience';
// The visa question: human_only by plan-fill's rule, whatever the bank holds.
const Q_VISA = 'will_you_now_or_in_the_future_require_sponsorship_for_employment_visa_status_e_g_h1b_visa_status';

test('extracts the 20-field form exactly, and it passes the form-shape gate', async () => {
  // The raw extraction the applier reads.
  const fields = await extractFields(page);
  // A stable view: id, kind, required. A Greenhouse reskin that drops or renames one fails here.
  expect(fields.map((f) => [f.id, f.kind, f.required])).toEqual([
    ['first_name', 'text', true], ['last_name', 'text', true], ['preferred_name', 'text', false],
    ['email', 'text', true], ['country', 'combobox', true], ['phone', 'tel', true],
    ['candidate-location', 'combobox', true], ['resume', 'file', false], ['cover_letter', 'file', false],
    ['school--0', 'combobox', true], ['degree--0', 'combobox', true], ['discipline--0', 'combobox', true],
    ['start-year--0', 'text', true], ['end-month--0', 'combobox', true], ['end-year--0', 'text', true],
    ['question_8674016006', 'text', false], ['question_8674017006', 'text', false],
    ['question_8674045006', 'combobox', true], ['question_8676535006', 'combobox', true], ['question_8721343006', 'combobox', true],
  ]);
  // No shape blocker: there is an email field and the form is not empty.
  expect(formShapeBlockersFor('526e7895', fields)).toEqual([]);
});

test('GAP: with the live bank, six controls are blocked and the education picks are not Greenhouse options', async () => {
  // The applier's call shape, with the posting's company.
  const plan = planFill(await extractFields(page), liveRows, profile, 'Cadence Solutions');
  // The six: three dates the planner does not take from the profile, two yes/no, and the visa question.
  expect(plan.blockers.map((b) => [b.id, b.key, b.reason])).toEqual([
    ['start-year--0', 'start_date_year', 'no_answer'],
    ['end-month--0', 'end_date_month', 'no_answer'],
    ['end-year--0', 'end_date_year', 'no_answer'],
    ['question_8674045006', Q_GRADUATING, 'no_answer'],
    ['question_8676535006', Q_INTERNSHIP, 'no_answer'],
    // human_only even with an attested bank row: the bot never answers a visa question.
    ['question_8721343006', Q_VISA, 'human_only'],
  ]);
  // id -> value.
  const byId = Object.fromEntries(plan.fills.map((f) => [f.id, f.value]));
  // FILL-TIME HAZARD the plan cannot see: the profile's words, verbatim...
  expect([byId['degree--0'], byId['discipline--0']]).toEqual(['B.Tech', 'Computer Science & Data Science (CSD)']);
  // ...and neither is an option, so the exact-pick filler would park the row at fill time.
  expect([EDU.degrees.includes('B.Tech'), EDU.disciplines.includes('Computer Science & Data Science (CSD)')]).toEqual([false, false]);
});

test('FIX: eight bank rows leave only the human_only visa question, and every known pick is a real option', async () => {
  // The rows Teja confirms (his statements; the orch runs the INSERT). degree/school are peer 4's pending rows.
  const bank = [
    ...liveRows,
    // master education[0].start_date 2024-08-01.
    row('start_date_year', '2024'),
    // master education[0].end_date 2027-06-01. Month option text is NOT readable offline (react-select).
    row('end_date_month', 'June'),
    // Same entry's end year.
    row('end_date_year', '2027'),
    // Ends June 2027: neither Dec 2027 nor May/June 2028.
    row(Q_GRADUATING, 'No'),
    // master experience exp_aczen, "Full Stack AI Engineer Intern", Jun 2026 - Present.
    row(Q_INTERNSHIP, 'Yes'),
    // Peer 4's pending row (truefoundry pre-flight): a B.Tech is a bachelor's degree.
    row('degree', "Bachelor's Degree"),
    // Peer 4's pending row: the school is not in Greenhouse's list; "Other" is.
    row('school', 'Other'),
    // NEW: the field "Computer Science & Data Science (CSD)" mapped to the list's exact "Computer Science".
    row('discipline', 'Computer Science'),
  ] as unknown as AnswerBankRow[];
  // Same call as above, now with the rows.
  const plan = planFill(await extractFields(page), bank, profile, 'Cadence Solutions');
  // id -> value.
  const byId = Object.fromEntries(plan.fills.map((f) => [f.id, f.value]));
  // Only the visa question is left, for the human.
  expect(plan.blockers.map((b) => [b.id, b.reason])).toEqual([['question_8721343006', 'human_only']]);
  // The education picks now come from the bank and are exact options on this board.
  expect([EDU.degrees.includes(String(byId['degree--0'])), EDU.disciplines.includes(String(byId['discipline--0']))]).toEqual([true, true]);
  // The two custom answers are exact options too.
  expect([OPTIONS['question_8674045006']!.includes(String(byId['question_8674045006'])), OPTIONS['question_8676535006']!.includes(String(byId['question_8676535006']))]).toEqual([true, true]);
});
