// OFFLINE PRE-FLIGHT: Canonical "Python and Kubernetes Software Engineer - Data, Workflows, AI/ML & Analytics",
// Greenhouse job 5703396, application row e80f803d (2026-11-09, peer 3 brief t2: "make the next Greenhouse rows bot-ready").
//
// WHY THIS FILE EXISTS. Planned offline against the live answer bank, this form looks 3 essays short. It is
// further away than that, in three ways a plan cannot show, and this file pins all three:
//   1. FILL-TIME: most bank answers Canonical's dropdowns receive are not option texts ("yes" vs "Yes",
//      "india" vs "India"/"Indian", "good" vs "Top 20% at school", "ist" vs "Asia Pacific Time Zones").
//      The filler picks only an EXACT option, so a live run parks at the first one.
//   2. DECLARATIONS: two REQUIRED dropdowns are declarations ("I agree to use only my own words...",
//      "confirm that you have read and agree to... Privacy Notice"). The planner's consent rule (consent/
//      certify/attest) missed "agree"/"confirm", so attested bank rows signed them; DECLARATION_TOKENS (2026-11-09)
//      now refuses both as human_only before any bank lookup, and this file pins that.
//   3. The first declaration forbids AI-generated content, so the essays cannot be agent-drafted.
// With the declarations left to Teja (needs_human) the form can never plan clean: the row is Manual-lane.
//
// Fixtures: canonical-5703396-python-k8s-data.html (the job page form, captured 2026-11-09 with
// worker/scripts/capture-fixture.ts, scripts stripped), canonical-5703396-questions.json (the job's public
// boards-api questions with option texts) and canonical-education.json (the board's full degree and
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
// The planner, and the label -> bank key normaliser it looks rows up by.
import { planFill, questionKey } from '../src/plan-fill.ts';
// The no_form_fields / no_email_field gate the applier runs on the raw extraction.
import { formShapeBlockersFor } from '../src/apply-one.ts';
// Type-only: the two inputs planFill takes besides the fields.
import type { AnswerBankRow, MasterProfile } from '@applyy/shared-types';

// THIS FORM. Everything below the config is shared, word for word, with the other two Canonical pre-flights.
const FORM = {
  // The capture under worker/fixtures/greenhouse/.
  html: 'canonical-5703396-python-k8s-data.html',
  // Its boards-api question list.
  questions: 'canonical-5703396-questions.json',
  // The application row, for the shape gate.
  rowId: 'e80f803d',
  // The extracted [id, kind, required] list, pinned.
  fields: [
    ['first_name', 'text', true], ['last_name', 'text', true], ['email', 'text', true], ['country', 'combobox', false],
    ['phone', 'tel', false], ['resume', 'file', false], ['school--0', 'combobox', false], ['degree--0', 'combobox', false],
    ['discipline--0', 'combobox', false], ['question_45893742', 'combobox', true], ['question_45893748', 'textarea', true],
    ['question_45893749', 'textarea', true], ['question_45893743', 'combobox', true], ['question_45893744', 'combobox', true],
    ['question_45893745', 'textarea', true], ['question_45893746', 'textarea', true], ['question_46909085', 'combobox', true],
    ['question_45893750', 'text', false], ['question_45893751', 'text', false], ['question_45893747', 'combobox', true],
    ['question_45893752', 'combobox', true], ['question_45893753', 'combobox', true], ['question_51726141', 'combobox', true],
    ['question_55370434', 'combobox', true], ['question_65008223[]', 'combobox', true], ['question_65008235', 'combobox', true],
    ['gender', 'combobox', false], ['hispanic_ethnicity', 'combobox', false], ['veteran_status', 'combobox', false],
    ['disability_status', 'combobox', false],
  ],
  // The essays: no bank row, and (declaration 1) never agent-written.
  essays: ['question_45893748', 'question_45893749', 'question_45893745'],
  // The two required declarations.
  declarations: { ownWords: 'question_45893742', privacy: 'question_45893753' },
  // Field id -> its answer in the LIVE bank's shape (the live text form: lowercase, free words).
  live: {
    question_45893743: 'good', question_45893744: 'very good', question_45893746: '8.0/10, final year of B.Tech',
    question_46909085: '0', question_45893747: 'yes', question_45893752: 'india', question_51726141: 'ist',
    question_55370434: 'female', 'question_65008223[]': 'india', question_65008235: 'Other',
  } as Record<string, string>,
  // Field id -> the exact option text of the SAME statement (case or wording only; no new claim).
  corrected: {
    question_45893747: 'Yes', question_45893752: 'India', question_55370434: 'Female', 'question_65008223[]': 'Indian',
  } as Record<string, string>,
  // Dropdowns whose live answer has no same-statement option: Teja must pick (high school x2, time zone).
  tejaPicks: ['question_45893743', 'question_45893744', 'question_51726141'],
};

// Shared across tests: one Chromium launch costs seconds, and the page never changes.
let browser: Browser;
// The localhost server holding the capture.
let server: FixtureServer;
// The extraction, read by every test.
// Typed from the extractor itself: extract-fields.ts exports no field type.
let fields: Awaited<ReturnType<typeof extractFields>>;

// Greenhouse's option texts per custom-question field name; the filler picks only one of these, verbatim.
const OPTIONS: Record<string, string[]> = Object.fromEntries(
  // Every question's every field, flattened to name -> option texts.
  (JSON.parse(readFileSync(`fixtures/greenhouse/${FORM.questions}`, 'utf8')) as { questions: { fields: { name: string; values: string[] }[] }[] })
    .questions.flatMap((q) => q.fields.map((f) => [f.name, f.values])),
);
// The board's whole degree and discipline lists (all pages), for the education comboboxes.
const EDU = JSON.parse(readFileSync('fixtures/greenhouse/canonical-education.json', 'utf8')) as { degrees: string[]; disciplines: string[] };

beforeAll(async () => {
  // Headless, as on the CI runner that would make the submit.
  browser = await chromium.launch();
  // Same fixtures root the other fixture tests use, so a removed file fails loudly.
  server = await startFixtureServer('fixtures');
  // One page, read once: the form never changes.
  const page: Page = await browser.newPage();
  // The job page form the bot would fill.
  await page.goto(`${server.url}/greenhouse/${FORM.html}`);
  // Extracted once for all tests.
  fields = await extractFields(page);
}, 60_000);

afterAll(async () => {
  // A leaked Chromium keeps a CI job alive until its timeout.
  await browser?.close();
  // And the port.
  await server?.close();
});

// The live master profile's identity + education shape (2026-11-09), invented values.
const profile = {
  // Name never comes from here; email, phone, country and links do.
  identity: { full_name: 'Asha Rao', email: 'asha@example.com', phone: '9999900000', location: 'Hyderabad, India', links: [{ id: 'l1', label: 'LinkedIn', url: 'https://linkedin.com/in/asha' }, { id: 'l2', label: 'Portfolio', url: 'https://asha.example' }] },
  // The live first entry's shape: an Indian degree abbreviation and a long field name.
  education: [{ id: 'e1', institution: 'Example Institute of Technology', degree: 'B.Tech', field: 'Computer Science & Data Science (CSD)', start_date: '2024-08-01', end_date: '2027-06-01' }],
} as unknown as MasterProfile;

// One ATTESTED bank row in the live shape (Teja attested every Canonical row in the console).
const row = (question_key: string, answer_value: unknown, needs_human = false) => ({ question_key, answer_value, needs_human, answer_type: 'text', attested_by_human: true });
// The bank key the planner derives from a field's own label, so the rows meet the form exactly.
const keyOf = (id: string): string => questionKey(fields.find((f) => f.id === id)!.label);

// The live bank for this form: names, EEO template rows, both declarations "yes", and the answers above.
function liveBank(overrides: Record<string, string> = {}, declarationsNeedHuman = false): AnswerBankRow[] {
  // Every answered id, with any per-test override (a corrected option text) on top.
  const answers = { ...FORM.live, ...overrides };
  return [
    // Bank-sourced names.
    row('first_name', 'Asha'), row('last_name', 'Rao'),
    // EEO template rows (plan-fill EEO_TEMPLATES), stored as option texts.
    row('eeo_gender', 'Female'), row('eeo_hispanic_latino', 'No'), row('eeo_veteran_status', 'I am not a protected veteran'),
    // The two declarations: "yes" today; needs_human when Teja keeps them for himself.
    row(keyOf(FORM.declarations.ownWords), 'yes', declarationsNeedHuman), row(keyOf(FORM.declarations.privacy), 'yes', declarationsNeedHuman),
    // Every other answer, keyed by its field's label.
    ...Object.entries(answers).map(([id, value]) => row(keyOf(id), value)),
  ] as unknown as AnswerBankRow[];
}

// The ids whose planned value is NOT one of the field's Greenhouse options (only fields with a known list).
function notAnOption(plan: ReturnType<typeof planFill>): string[] {
  // Planned fills that land in a dropdown with a known option list, and miss it.
  return plan.fills.filter((f) => (OPTIONS[f.id]?.length ?? 0) > 0 && !OPTIONS[f.id]!.includes(String(f.value))).map((f) => f.id).sort();
}

test('extracts the form exactly, and it passes the form-shape gate', () => {
  // A stable view: id, kind, required. A Greenhouse reskin that drops or renames one fails here.
  expect(fields.map((f) => [f.id, f.kind, f.required])).toEqual(FORM.fields);
  // No shape blocker: there is an email field and the form is not empty.
  expect(formShapeBlockersFor(FORM.rowId, fields)).toEqual([]);
});

test('GAP: the live bank leaves the essays unanswered and the declarations for Teja, and its dropdown answers are mostly not options', () => {
  // The applier's call shape, with the posting's company.
  const plan = planFill(fields, liveBank(), profile, 'Canonical');
  // The plan's own blockers are the essays (no bank row) and both declarations, refused even with attested "yes"
  // rows (Teja's ruling: the bot never signs a declaration). Everything else LOOKS answered. Sorted: DOM order interleaves them.
  expect(plan.blockers.map((b) => [b.id, b.reason]).sort()).toEqual([
    ...FORM.essays.map((id) => [id, 'no_answer']),
    [FORM.declarations.ownWords, 'human_only'], [FORM.declarations.privacy, 'human_only'],
  ].sort());
  // FILL-TIME: every live dropdown answer that is not an exact option (each parks a live run).
  // That is: the case/wording misses and the picks only Teja can make. The declarations are no longer fills at all.
  expect(notAnOption(plan)).toEqual([...Object.keys(FORM.corrected), ...FORM.tejaPicks].sort());
  // The education picks from the profile are not options either.
  expect([EDU.degrees.includes('B.Tech'), EDU.disciplines.includes('Computer Science & Data Science (CSD)')]).toEqual([false, false]);
});

test('POLICY: the planner refuses both required declarations as human_only, even from attested bank rows', () => {
  // Same live bank.
  const plan = planFill(fields, liveBank(), profile, 'Canonical');
  // id -> source.
  const source = Object.fromEntries(plan.fills.map((f) => [f.id, f.source]));
  // Neither declaration is filled: "agree"/"confirm" are declaration tokens, refused before any bank lookup.
  expect([source[FORM.declarations.ownWords], source[FORM.declarations.privacy]]).toEqual([undefined, undefined]);
  // Both go to Teja as human_only, so the row parks for him instead of submitting.
  const reason = Object.fromEntries(plan.blockers.map((b) => [b.id, b.reason]));
  // id -> reason for each declaration.
  expect([reason[FORM.declarations.ownWords], reason[FORM.declarations.privacy]]).toEqual(['human_only', 'human_only']);
});

test('FIX (partial): same-statement option texts + declarations kept for Teja still cannot plan clean', () => {
  // Case/wording corrections, the education rows, and both declarations marked needs_human.
  const bank = [
    ...liveBank(FORM.corrected, true),
    // Peer 4's pending rows (truefoundry pre-flight) and the new discipline row.
    row('degree', "Bachelor's Degree"), row('school', 'Other'), row('discipline', 'Computer Science'),
  ] as unknown as AnswerBankRow[];
  // Same call, corrected bank.
  const plan = planFill(fields, bank, profile, 'Canonical');
  // Blocked for Teja: the essays (his own words) and the two declarations (his own signature).
  expect(plan.blockers.map((b) => [b.id, b.reason]).sort()).toEqual([
    ...FORM.essays.map((id) => [id, 'no_answer']),
    // human_only, not awaiting_human_answer: the declaration gate refuses before the bank row is read.
    [FORM.declarations.ownWords, 'human_only'], [FORM.declarations.privacy, 'human_only'],
  ].sort());
  // Left unpickable: exactly the dropdowns only Teja can choose an option for.
  expect(notAnOption(plan)).toEqual([...FORM.tejaPicks].sort());
  // The education picks now come from the bank and are exact options.
  const byId = Object.fromEntries(plan.fills.map((f) => [f.id, String(f.value)]));
  // Degree and discipline.
  expect([EDU.degrees.includes(byId['degree--0']!), EDU.disciplines.includes(byId['discipline--0']!)]).toEqual([true, true]);
  // Never bot-ready under "the bot never ticks declarations": this row belongs in the Manual lane.
  expect(plan.canProceed).toBe(false);
});
