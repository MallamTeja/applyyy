// NAMED REGRESSION TEST for the failure that would kill this product quietly.
//
// Real Greenhouse forms contain aria-hidden, tabindex="-1" inputs that carry
// the native `required` attribute. They exist only to block native browser
// submit for custom React-select dropdowns; they are machinery, not questions.
//
// If extraction ever counts them as real fields, they become required fields
// with no recoverable label and therefore no possible answer — so planFill
// blocks, and EVERY SINGLE APPLICATION routes to blocked_needs_human. The
// human queue stops being an occasional captcha and becomes the entire day's
// work, and the symptom Teja sees is "the automation doesn't work" rather than
// anything that looks like a parsing bug. That is why this gets its own file
// and its own name: it is the kind of thing a future refactor of
// extract-fields.ts silently reintroduces.
import { afterAll, beforeAll, expect, test } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import type { AnswerBankRow } from '@applyy/shared-types';
import { startFixtureServer, type FixtureServer } from '../src/fixture-server.js';
import { extractFields } from '../src/extract-fields.js';
import { planFill } from '../src/plan-fill.js';

// Shared browser/server; launching per test would cost billable seconds (§2).
let browser: Browser;
let server: FixtureServer;
let page: Page;

beforeAll(async () => {
  // Headless, as on a GitHub Actions runner with no display.
  browser = await chromium.launch();
  // Serve the checked-in captures so the test fails loudly if one is removed.
  server = await startFixtureServer('fixtures');
  page = await browser.newPage();
  // The real GitLab Greenhouse form captured 2026-09-09, scripts stripped.
  await page.goto(`${server.url}/greenhouse/gitlab-remix-form.html`);
}, 60_000);

afterAll(async () => {
  // A leaked Chromium keeps a CI job alive until its timeout.
  await browser?.close();
  await server?.close();
});

/** Minimal answer-bank row; the planner reads only these four fields. */
function answer(question_key: string, value: string): AnswerBankRow {
  return {
    question_key,
    answer_value: value,
    needs_human: false,
    answer_type: 'text',
  } as unknown as AnswerBankRow;
}

test('the real Greenhouse form yields exactly 9 required fields, not the sentinels', async () => {
  // A PIN, not an approximation. The captured GitLab form has 22 fillable
  // controls of which exactly 9 are genuinely required, verified by reading the
  // rendered form. The raw markup ALSO contains several aria-hidden,
  // tabindex="-1" inputs carrying the native `required` attribute, used purely
  // to block native submit for React-select dropdowns.
  //
  // That is what makes these two numbers a real regression detector rather than
  // a tautology: if extraction ever stops filtering sentinels, the required
  // count jumps well above 9 while the labels stay empty, and planFill then
  // blocks every application. Pinning the count catches that on the first run.
  // The fixture is frozen, so these numbers only change when someone changes
  // extraction — which is exactly when this test should speak up.
  const fields = await extractFields(page);
  // Total fillable controls surfaced from the real DOM.
  expect(fields.length).toBe(22);
  // The genuinely-required subset a human must answer.
  expect(fields.filter((formField) => formField.required)).toHaveLength(9);
});

test('every blocker names a question a human could actually answer', async () => {
  // The sentinel failure mode expressed as a property rather than a count: a
  // leaked sentinel has no recoverable label, so it would surface as a blocker
  // that Teja cannot act on — an item permanently stuck in the queue, which is
  // worse than a visible error because it looks like normal backlog.
  const fields = await extractFields(page);
  // An empty answer bank maximises the number of blockers, so this exercises
  // every required field at once rather than only the unanswered ones.
  const plan = planFill(fields, []);
  // Every blocker must carry human-readable question text.
  expect(plan.blockers.every((blocker) => blocker.label.trim().length > 0)).toBe(true);
  // And with nothing answered, the form must NOT proceed — the constraint #4
  // guarantee, asserted end to end against real DOM rather than a stub.
  expect(plan.canProceed).toBe(false);
});

test('extraction surfaces real questions, not form machinery', async () => {
  // A second angle on the same bug: a sentinel leak inflates the field count
  // with unlabelled entries even when the planner happens not to block.
  const fields = await extractFields(page);
  // Every surfaced field must carry a human-readable question. An empty label
  // is definitionally machinery, because a human could not answer it either.
  expect(fields.every((formField) => formField.label.length > 0)).toBe(true);
  // Sanity floor: the real form has ~22 fillable controls. Zero would mean the
  // extractor silently matched nothing and the tests above passed vacuously.
  expect(fields.length).toBeGreaterThan(5);
});
