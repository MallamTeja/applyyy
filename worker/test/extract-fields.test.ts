// Tests for form field extraction, run against a REAL captured Greenhouse form.
//
// This is the payoff for PROJECT_PLAN.md §19 insisting on real fixtures. The
// capture at worker/fixtures/greenhouse/ disproved the assumption this module
// would otherwise have been built on: modern Greenhouse forms carry NO `name`
// attributes at all. The classic job_application[first_name] convention is
// gone. Fields are identified by `id`, and custom questions get opaque numeric
// ids like question_36622854002 whose human meaning exists ONLY in aria-label.
//
// Extraction is therefore accessibility-tree-driven, and these tests pin that.
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
// The real browser; a simulated DOM would defeat the purpose of a real capture.
import { chromium, type Browser, type Page } from 'playwright';
// Serves the saved fixture over localhost so the page loads exactly as a real
// one would, without any request reaching an employer (constraint #16).
import { startFixtureServer, type FixtureServer } from '../src/fixture-server.ts';

// Subject under test; absent, which is what makes this file RED.
import { extractFields } from '../src/extract-fields.ts';

// Shared across tests in this file: launching Chromium per test would triple
// the runtime, and runtime here is charged against the Actions budget (§2).
let browser: Browser;
let server: FixtureServer;
let page: Page;

beforeAll(async () => {
  // Headless because the worker runs on a GitHub Actions runner with no display.
  browser = await chromium.launch();
  // Serve the checked-in fixtures directory itself, not a temp copy, so these
  // tests fail loudly if a fixture is deleted or renamed.
  server = await startFixtureServer('fixtures');
  // One page reused by every test; extraction is read-only so there is no
  // cross-test contamination to worry about.
  page = await browser.newPage();
  // The real GitLab Greenhouse form, captured 2026-09-09 with scripts stripped.
  await page.goto(`${server.url}/greenhouse/gitlab-remix-form.html`);
}, 60_000);

afterAll(async () => {
  // Release the browser and the port; a leaked Chromium keeps CI alive forever.
  await browser?.close();
  await server?.close();
});

describe('extractFields on a real Greenhouse form', () => {
  test('reads the human label for a field that has no name attribute', async () => {
    // Extraction over the whole form.
    const fields = await extractFields(page);
    // First Name is a plain text input identified only by id + label. If this
    // fails, the extractor is still looking for name= and found nothing.
    const firstName = fields.find((field) => field.id === 'first_name');
    // The label is what the answer-bank lookup will key on, so it must be the
    // human string and must not carry the asterisk from the required marker.
    expect(firstName?.label).toBe('First Name');
    // aria-required="true" on the real element; required-ness drives whether an
    // unanswerable field blocks the application or can simply be skipped.
    expect(firstName?.required).toBe(true);
  });

  test('recovers the question text for an opaque numeric question id', async () => {
    // The case that only a real capture reveals.
    const fields = await extractFields(page);
    // This id is meaningless on its own; the JD-specific question text lives in
    // aria-label. An extractor keyed on id alone would hand the answer-bank
    // "question_36622854002" and get nothing back for every custom question on
    // every job — silently routing all of them to blocked_needs_human.
    const linkedin = fields.find((field) => field.id === 'question_36622854002');
    // The recovered human label.
    expect(linkedin?.label).toBe('LinkedIn Profile');
  });

  test('excludes the hidden sentinel inputs that back React-select widgets', async () => {
    // Extraction over the whole form.
    const fields = await extractFields(page);
    // The real form contains aria-hidden, tabindex="-1" inputs carrying the
    // native `required` attribute, used to block browser submit for custom
    // dropdowns. They have no label and no user-fillable value. Treated as real
    // fields they would look like unanswerable required questions and route
    // EVERY application to blocked_needs_human — turning the human queue from
    // an occasional captcha into the entire day's work.
    const unlabelled = fields.filter((field) => field.label === '');
    // Nothing unlabelled should survive extraction.
    expect(unlabelled).toEqual([]);
  });
});
