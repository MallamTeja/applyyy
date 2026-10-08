// OFFLINE PRE-FLIGHT for the first real assisted application: GitLab "Intermediate Backend
// Engineer, India", Greenhouse job 8775507002, application row ba1e5d1d.
//
// WHY THIS FILE EXISTS. Every other Greenhouse test runs against job 8556658002, a
// different form with different custom questions. This one runs extraction and BOTH
// planners that assist.ts uses (planFill + planResumeAttachment, assisted-submit.ts:276,300)
// against a capture of the exact form Teja will fill, so a surprise shows up here and not
// in a headed browser in front of a recruiter. The fixture was taken 2026-10-08 with
// worker/scripts/capture-fixture.ts (GET only, both gates, scripts stripped).
//
// The answer bank and profile below mirror the SHAPE of the live data measured that day
// (answer_bank: first_name + last_name only; identity.phone: 10 bare digits; location
// "<city>, India"), with invented values, because a test must never carry real PII.
import { afterAll, beforeAll, expect, test } from 'vitest';
// Real Chromium over a localhost fixture: the same extractor code path assist.ts drives.
import { chromium, type Browser, type Page } from 'playwright';
// Serves worker/fixtures over http, so the page loads like a real board would.
import { startFixtureServer, type FixtureServer } from '../src/fixture-server.ts';
// The extractor under test; its output is what both planners consume.
import { extractFields } from '../src/extract-fields.ts';
// The planner that decides what is typed and what is left for the human.
import { planFill } from '../src/plan-fill.ts';
// The planner that picks the file input the resume goes into.
import { planResumeAttachment } from '../src/plan-resume-attachment.ts';
// Type-only: the two inputs planFill takes besides the fields.
import type { AnswerBankRow, MasterProfile } from '@applyy/shared-types';

// Shared across tests: one Chromium launch costs seconds, and the page never changes.
let browser: Browser;
// The localhost server holding the capture.
let server: FixtureServer;
// The loaded form, read by every test.
let page: Page;

beforeAll(async () => {
  // Headless, as on a CI runner; assist.ts is headed only for the human's benefit.
  browser = await chromium.launch();
  // Same fixtures root the other fixture tests use, so a removed file fails loudly.
  server = await startFixtureServer('fixtures');
  // One page for the whole file.
  page = await browser.newPage();
  // The exact form: job 8775507002, captured 2026-10-08.
  await page.goto(`${server.url}/greenhouse/gitlab-8775507002-backend-india.html`);
}, 60_000);

afterAll(async () => {
  // A leaked Chromium keeps a CI job alive until its timeout.
  await browser?.close();
  // And the port.
  await server?.close();
});

// The live answer bank's shape: only the two name rows exist, both needs_human=false.
// Cast because the planner reads only these four columns; the rest are bookkeeping.
const answers = [
  // Name fields are NEVER derived from full_name (family-name-first risk), so the bank holds them.
  { question_key: 'first_name', answer_value: 'Asha', needs_human: false, answer_type: 'text' },
  // Same rule as first_name.
  { question_key: 'last_name', answer_value: 'Rao', needs_human: false, answer_type: 'text' },
] as unknown as AnswerBankRow[];

// The live master profile's identity shape (v2), with invented values.
const profile = {
  identity: {
    // Present to prove names come from the bank, not from here.
    full_name: 'Asha Rao',
    // Null, as in the live row.
    headline: null,
    // Copied verbatim into Email.
    email: 'asha@example.com',
    // 10 bare digits, NO "+91": the live shape, and the reason doubling is not a risk today.
    phone: '9999900000',
    // Two segments, so the country rule resolves "India".
    location: 'Hyderabad, India',
    // The {id,label,url} link shape the resolver classifies by label.
    links: [{ id: 'l1', label: 'LinkedIn', url: 'https://linkedin.com/in/asha' }],
  },
} as unknown as MasterProfile;

test('assist auto-fills names, email, phone + its country picker, LinkedIn and country of residence', async () => {
  // The same call sequence as assisted-submit.ts:270-276.
  const fields = await extractFields(page);
  // NON-VACUITY: a page that failed to load would extract nothing and every
  // "not filled" assertion below would pass for the wrong reason.
  expect(fields.length).toBeGreaterThan(10);
  // Plan with the live-shaped bank and profile.
  const plan = planFill(fields, answers, profile);
  // Exact id -> [value, source] map: a new or missing fill must fail this test, not slip by.
  const fills = Object.fromEntries(plan.fills.map((f) => [f.id, [f.value, f.source]]));
  expect(fills).toEqual({
    // From the bank, never split from full_name.
    first_name: ['Asha', 'answer_bank'],
    // Same.
    last_name: ['Rao', 'answer_bank'],
    // Profile fact.
    email: ['asha@example.com', 'profile'],
    // The PHONE's country-code picker (fieldset.phone-input, id="country", label "Country"),
    // not a residence question. Fills by exact option match only (playwright-page.ts:215-226),
    // so on the live form it may fail closed and land on the "NOT filled" list.
    country: ['India', 'profile'],
    // Verbatim from the profile: no dial code is ever prepended by our code.
    phone: ['9999900000', 'profile'],
    // LinkedIn Profile, classified by the link's label.
    question_38137960002: ['https://linkedin.com/in/asha', 'profile'],
    // "What is your current country of residence?" (required): ALSO filled from the
    // profile location. Not in the orchestrator's 2026-10-08 list of seven; recorded here
    // so Teja knows to check it before clicking Submit.
    question_38137962002: ['India', 'profile'],
  });
  // The phone value must not carry a dial code, since the form's picker supplies one.
  expect(String(fills.phone?.[0]).startsWith('+')).toBe(false);
});

test('assist leaves exactly the six eligibility/personal questions to the human', async () => {
  // Same extraction as above; each test stands alone.
  const fields = await extractFields(page);
  // Same plan inputs.
  const plan = planFill(fields, answers, profile);
  // Blockers by label and reason. human_only = the denylist that never auto-answers
  // eligibility questions; no_answer = nothing in the bank or profile covers it.
  expect(plan.blockers.map((b) => [b.label, b.reason])).toEqual([
    ['Are you located in India?', 'human_only'],
    ['Are you subject to any employment agreements and/or post-employment restrictions with your current employer or a past employer?', 'human_only'],
    ['Will you now or in the future require sponsorship for a visa to remain in your current location?', 'human_only'],
    ['Have you previously worked at or consulted for GitLab?', 'human_only'],
    ['Please share links of any open source projects you own or have made contributions to', 'no_answer'],
    ['What is your primary programming language and/or framework?', 'no_answer'],
  ]);
  // Required questions remain, so a scheduled (non-assisted) run must not proceed (constraint #4).
  expect(plan.canProceed).toBe(false);
});

test('assist attaches the resume to the Resume input, not the Cover Letter one', async () => {
  // Both file inputs are labelled "Attach" on this form, so only the id tells them apart.
  const fields = await extractFields(page);
  // The exact call assisted-submit.ts:300 makes.
  const attachment = planResumeAttachment(fields, { hasResumeSnapshot: true });
  // The resume input, chosen by id. Landing on cover_letter would send the CV as a cover letter.
  expect(attachment.target?.id).toBe('resume');
  // Nothing about the upload is left for the human.
  expect(attachment.blockers).toEqual([]);
});
