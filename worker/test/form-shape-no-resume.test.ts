// THE THIRD FORM-SHAPE STOP: no resume upload, no submit (2026-11-09, wiring-audit re-check W5 residual).
//
// WHY. formShapeBlockersFor refused a page with no fields (no_form_fields) and a page with no email box
// (no_email_field). A job-alerts or newsletter form has an email box, though, and nothing else: the attachment
// planner reads "no file input" as "nothing to attach" (canProceed), and the pre-click check sees exactly one
// submit control. So every gate passed, and a live run would POST Teja's email to a signup form. The rule is a
// POSITIVE shape (CLAUDE.md §6): an application form shows a resume upload. Every real form in worker/fixtures
// (8 Greenhouse, 3 Lever) has one; test 3 re-proves that on each, so the rule cannot quietly over-block them.
//
// RED-ON-REVERT: without the no_resume_field branch in formShapeBlockersFor, tests 1 and 2 fail ([] instead of the
// blocker); test 3 stays green (it guards over-blocking), and its file count makes it non-vacuous.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// Real Chromium over the fixture files: the same extractor path apply-one.ts drives.
import { chromium, type Browser, type Page } from 'playwright';
// Lists the real fixtures, so a newly captured form is covered without editing this file.
import { readdirSync } from 'node:fs';
// Serves worker/fixtures over http, as the other fixture tests do.
import { startFixtureServer, type FixtureServer } from '../src/fixture-server.ts';
// The extractor whose raw output the gate reads.
import { extractFields } from '../src/extract-fields.ts';
// The gate under test.
import { formShapeBlockersFor } from '../src/apply-one.ts';

// One Chromium for the file: a launch costs seconds.
let browser: Browser;
// The localhost fixture server.
let server: FixtureServer;
// One page, re-pointed per fixture.
let page: Page;

beforeAll(async () => {
  // Headless, as on the CI runner.
  browser = await chromium.launch();
  // Same root as every other fixture test.
  server = await startFixtureServer('fixtures');
  // Reused across tests.
  page = await browser.newPage();
}, 60_000);

afterAll(async () => {
  // A leaked browser keeps CI alive until its timeout.
  await browser?.close();
  // And the port.
  await server?.close();
});

// The raw extraction of one fixture, exactly what the applier hands the gate.
async function fieldsOf(path: string) {
  // Loaded like a board page.
  await page.goto(`${server.url}/${path}`);
  // The extractor's own answer.
  return extractFields(page);
}

describe('form-shape gate: a resume upload is what makes a page an application form', () => {
  it('1. an email-only job-alerts form is blocked as no_resume_field, never submitted', async () => {
    // The trap page: one email box, one submit button.
    const fields = await fieldsOf('synthetic/email-only-alerts.html');
    // Non-vacuity: the extractor really saw the email box, so the email gate alone would pass it.
    expect(fields.some((field) => field.kind === 'email')).toBe(true);
    // The new stop names it.
    expect(formShapeBlockersFor('row-alerts', fields).map((blocker) => blocker.reason)).toEqual(['no_resume_field']);
  });

  it('2. the rule itself: email but no file input is blocked; adding a file input clears it; earlier stops keep precedence', () => {
    // Email only: the newsletter shape.
    expect(formShapeBlockersFor('r', [{ kind: 'email', label: 'Email' }]).map((b) => b.reason)).toEqual(['no_resume_field']);
    // The same form with a resume upload is an application form.
    expect(formShapeBlockersFor('r', [{ kind: 'email', label: 'Email' }, { kind: 'file', label: 'Resume/CV' }])).toEqual([]);
    // No fields at all still reads as the empty page, not as a missing resume.
    expect(formShapeBlockersFor('r', []).map((b) => b.reason)).toEqual(['no_form_fields']);
    // A file input without an email box is still "not an application form" for the email reason.
    expect(formShapeBlockersFor('r', [{ kind: 'file', label: 'Upload' }]).map((b) => b.reason)).toEqual(['no_email_field']);
  });

  it('3. no over-block: every captured real application form (Greenhouse, Lever) still passes the gate', async () => {
    // Every real capture, by directory, so a new capture is covered automatically.
    const real = ['greenhouse', 'lever'].flatMap((dir) => readdirSync(`fixtures/${dir}`).filter((f) => f.endsWith('.html')).map((f) => `${dir}/${f}`));
    // Non-vacuity: 8 Greenhouse + 3 Lever on 2026-11-09; fewer means the glob silently matched less.
    expect(real.length).toBeGreaterThanOrEqual(11);
    // Each one, with the reason it was blocked if it was.
    for (const path of real) expect({ path, blockers: formShapeBlockersFor('row', await fieldsOf(path)) }).toEqual({ path, blockers: [] });
  }, 120_000);
});
