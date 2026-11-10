// OFFLINE PRE-FLIGHT: HackerRank "Software Development Engineer Intern", Greenhouse job 8229735,
// application row cb64a4bf (2026-11-09, peer 3 brief t2: "make the next Greenhouse rows bot-ready").
//
// WHY THIS FILE EXISTS. The row cannot be approved for the bot until every required control on its real
// form has an answer the filler can pick EXACTLY. Planned offline against the live answer bank, this form
// leaves two required yes/no comboboxes unanswered. This file pins the form, proves those two gaps, and
// proves which bank rows close them, so Teja confirms the answers once and the plan is clean.
//
// Fixtures: hackerrank-8229735-sde-intern.html (the job page form, captured 2026-11-09 with
// worker/scripts/capture-fixture.ts, scripts stripped) and hackerrank-8229735-questions.json (the same
// job's public boards-api question list with each select's option texts, same day). Profile and bank
// values below are INVENTED with the live data's shape: a test never carries real PII.
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

// Greenhouse's own option texts per field name; the filler picks only one of these, verbatim.
const OPTIONS: Record<string, string[]> = Object.fromEntries(
  // Every question's every field, flattened to name -> option texts.
  (JSON.parse(readFileSync('fixtures/greenhouse/hackerrank-8229735-questions.json', 'utf8')) as { questions: { fields: { name: string; values: string[] }[] }[] })
    .questions.flatMap((q) => q.fields.map((f) => [f.name, f.values])),
);

beforeAll(async () => {
  // Headless, as on the CI runner that will make the submit.
  browser = await chromium.launch();
  // Same fixtures root the other fixture tests use, so a removed file fails loudly.
  server = await startFixtureServer('fixtures');
  // One page for the whole file.
  page = await browser.newPage();
  // The job page form the bot fills (apply_url is the job-boards page itself, no wrapper).
  await page.goto(`${server.url}/greenhouse/hackerrank-8229735-sde-intern.html`);
}, 60_000);

afterAll(async () => {
  // A leaked Chromium keeps a CI job alive until its timeout.
  await browser?.close();
  // And the port.
  await server?.close();
});

// The live master profile's identity shape (2026-11-09), invented values; this form has no education block.
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
    links: [{ id: 'l1', label: 'LinkedIn', url: 'https://linkedin.com/in/asha' }],
  },
} as unknown as MasterProfile;

// One bank row in the live shape; values are the only thing a test varies.
const row = (question_key: string, answer_value: unknown) => ({ question_key, answer_value, needs_human: false, answer_type: 'text', attested_by_human: false });

// The live bank's name rows; names are never derived from full_name.
const nameRows = [row('first_name', 'Asha'), row('last_name', 'Rao')] as unknown as AnswerBankRow[];

// T8: the same row shape AFTER Teja clicks Save in the web Answer bank page, the only path that attests a row.
const attested = (question_key: string, answer_value: unknown) => ({ ...row(question_key, answer_value), attested_by_human: true });

// The two question keys this form asks that the live bank (2026-11-09, 42 rows) does not hold.
const Q_AVAILABLE = 'are_you_available_to_intern_with_hackerrank_for_a_full_time_6_month_internship_starting_from_jan_5th_2027';
// The office question. The bank's older row (this_role_requires_working_from_our_bangalore_office_...)
// is worded differently, so its key does not match and it is not reused.
const Q_OFFICE = 'are_you_able_to_work_from_our_bangalore_office_full_time_for_the_entire_6_month_internship_period';
// T8 (2026-11-10): the bank now HOLDS both answers ("Yes", saved 11-09) but neither is attested, so the planner
// still treats them as absent; the live names are unattested too.
const liveBank = [...nameRows, row(Q_AVAILABLE, 'Yes'), row(Q_OFFICE, 'Yes')] as unknown as AnswerBankRow[];

test('extracts the 8-field form exactly, and it passes the form-shape gate', async () => {
  // The raw extraction the applier reads.
  const fields = await extractFields(page);
  // A stable view: id, kind, required. A Greenhouse reskin that drops or renames one fails here.
  expect(fields.map((f) => [f.id, f.kind, f.required])).toEqual([
    ['first_name', 'text', true],
    ['last_name', 'text', true],
    ['email', 'text', true],
    ['country', 'combobox', true],
    ['phone', 'tel', true],
    ['resume', 'file', false],
    ['question_69424165', 'combobox', true],
    ['question_69424166', 'combobox', true],
  ]);
  // No shape blocker: there is an email field and the form is not empty.
  expect(formShapeBlockersFor('cb64a4bf', fields)).toEqual([]);
});

test('GAP: with the live bank, the two required yes/no questions and both names (unattested, T8) are unanswered', async () => {
  // The applier's call shape (apply-one.ts), with the posting's company.
  // T8: the live bank includes the unattested 11-09 "Yes" rows; they must not count as answers.
  const plan = planFill(await extractFields(page), liveBank, profile, 'HackerRank');
  // Exactly the two, and for the reason "no answer" (not human_only: neither is a declaration).
  // T8: plus both names: unattested -> parks until Teja saves the row (names are never derived from full_name).
  expect(plan.blockers.map((b) => [b.id, b.key, b.reason])).toEqual([
    // T8: unattested first_name row.
    ['first_name', 'first_name', 'no_answer'],
    // T8: unattested last_name row.
    ['last_name', 'last_name', 'no_answer'],
    ['question_69424165', Q_AVAILABLE, 'no_answer'],
    ['question_69424166', Q_OFFICE, 'no_answer'],
  ]);
});

test('FIX: two bank rows answering "Yes" plan clean, and "Yes" is a real option for both', async () => {
  // The rows Teja confirms (his statements; the orch runs the INSERT, never an agent on its own).
  // T8: every row as it stands AFTER Teja saves it (attested), names included, so the plan can be clean.
  const bank = [attested('first_name', 'Asha'), attested('last_name', 'Rao'), attested(Q_AVAILABLE, 'Yes'), attested(Q_OFFICE, 'Yes')] as unknown as AnswerBankRow[];
  // Same call as above, now with the rows.
  const plan = planFill(await extractFields(page), bank, profile, 'HackerRank');
  // id -> [value, source].
  const byId = Object.fromEntries(plan.fills.map((f) => [f.id, [f.value, f.source]]));
  // Both answers come from the bank, verbatim.
  expect([byId['question_69424165'], byId['question_69424166']]).toEqual([['Yes', 'answer_bank'], ['Yes', 'answer_bank']]);
  // And each is an exact Greenhouse option text, so the exact-pick filler can succeed.
  expect([OPTIONS['question_69424165'], OPTIONS['question_69424166']]).toEqual([['Yes', 'No'], ['Yes', 'No']]);
  // Nothing left for a human on this form.
  expect(plan.blockers).toEqual([]);
});
