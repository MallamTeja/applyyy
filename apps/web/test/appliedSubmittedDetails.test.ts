/* The Applied page's "answers prepared for this form" block (2026-11-07).
 * Each applied row shows the form answers from its NEWEST apply_kit note, next to the resume the page
 * already shows. A kit is what the system PREFILLED, so the block never says "submitted". The parse is
 * pure (features/applied/submittedDetails.ts) and the block is a pure view (PreparedAnswers.tsx), so both
 * run here without a DOM. The red-on-revert guard for newest-wins is "the newest of two kits wins". */

// The .tsx loader; must run before any component is imported.
import './support/registerTsxHooks.ts';
// Strict asserts: deepEqual compares order, which the field-order check relies on.
import assert from 'node:assert/strict';
// node:test, like every web test.
import { describe, it } from 'node:test';

// The pure parse under test.
const details = await import('../src/features/applied/submittedDetails.ts');
// The pure view under test; dynamic, after the hook, because it is .tsx.
const viewMod = await import('../src/features/applied/PreparedAnswers.tsx');
// The page's row reader, for the typed-by-hand flag and the master version line.
const applied = await import('../src/features/applied/appliedView.ts');
// The page's row view, to prove the master version is drawn.
const pageMod = await import('../src/features/applied/AppliedJobsPage.tsx');
// Static render, no DOM needed.
const render = (await import('react-dom/server')).renderToStaticMarkup as (element: unknown) => string;
// Element factory, so the test needs no JSX.
const h = (await import('react')).createElement as (type: unknown, props: unknown) => unknown;

// HackerRank's application id (live, 2026-11-07), the row with two kits.
const APP = 'cac40516-0000-4000-8000-000000000001';
// A second application, so the per-application keying is exercised too.
const OTHER = 'e7924dc0-0000-4000-8000-000000000002';

// One contract-v1 kit detail; `over` replaces top-level keys.
function kitDetail(fields: unknown[], over: Record<string, unknown> = {}): Record<string, unknown> {
  // The worker's shape (manual-apply/applyKit.ts contract v1).
  return { kind: 'apply_kit', v: 1, generated_at: '2026-11-05T10:00:00Z', run_id: null, form_url: 'https://jobs.example/apply', resume: null, fields, warnings: [], ...over };
}

// One kit field in the stored snake_case shape.
function field(label: string, value: string | null, extra: Record<string, unknown> = {}): Record<string, unknown> {
  // Text, identity-sourced, optional unless overridden.
  return { label, value, source: 'identity', required: false, input_type: 'text', ...extra };
}

// One application_events row as the page's read returns it.
function event(applicationId: string, createdAt: string, detail: unknown): Record<string, unknown> {
  // The three columns the page selects.
  return { application_id: applicationId, created_at: createdAt, detail };
}

// The prepared answers for APP from these events, through the same two steps the page uses.
function answers(events: unknown) {
  // Parse, then pick the row.
  return details.answersFor(details.readKitAnswers(events), APP);
}

// The block as drawn.
function draw(a: unknown, typedByHand = false): string {
  // The pure view, with its two props.
  return render(h(viewMod.PreparedAnswers, { answers: a, typedByHand }));
}

describe('applied page: answers prepared for this form', () => {
  it('kit fields are shaped into label, value, source, required and options', () => {
    // One kit with a text field and a select.
    const a = answers([event(APP, '2026-11-05T10:00:00Z', kitDetail([field('Full name', 'Teja Mallam', { required: true }), field('Country', 'India', { input_type: 'select', options: ['India +91', 'Nepal +977'] })]))]);
    // A field list, not an empty or error state.
    assert.equal(a.kind, 'fields');
    // Narrowed for the field reads.
    if (a.kind !== 'fields') return;
    // Form order and the page's names.
    assert.deepEqual(a.fields.map((f) => [f.label, f.value, f.source, f.required, f.inputType]), [['Full name', 'Teja Mallam', 'identity', true, 'text'], ['Country', 'India', 'identity', false, 'select']]);
    // The kit's own time, proven by the ISO reader.
    assert.equal(a.preparedAt, Date.UTC(2026, 10, 5, 10));
  });

  it('the newest of two kits wins, whatever order the read returns them in', () => {
    // The older kit answered "Old answer"; the newer one "New answer".
    const older = event(APP, '2026-11-04T10:00:00Z', kitDetail([field('Why us', 'Old answer')]));
    // Newer by a day.
    const newer = event(APP, '2026-11-05T10:00:00Z', kitDetail([field('Why us', 'New answer')]));
    // Both read orders.
    for (const events of [[older, newer], [newer, older]]) {
      // Parsed for APP.
      const a = answers(events);
      // The newer kit's answer only.
      assert.deepEqual(a.kind === 'fields' ? a.fields.map((f) => f.value) : a.kind, ['New answer']);
    }
  });

  it('no kit gives the explicit empty state, not a blank block', () => {
    // Only another application has a kit.
    const a = answers([event(OTHER, '2026-11-05T10:00:00Z', kitDetail([field('Name', 'X')]))]);
    // The named empty state.
    assert.equal(a.kind, 'none');
    // Drawn as the sentence the brief fixed.
    assert.match(draw(a), /No form answers on record/);
  });

  it('a malformed kit gives no answers and does not throw', () => {
    // Every malformed shape the brief named, plus a non-object detail.
    const bad: unknown[] = [
      'not an object',
      kitDetail([field('Name', 'X')], { v: 2 }),
      kitDetail([field('Name', 'X')], { fields: 'not a list' }),
      kitDetail([field('Name', 'X'), { value: 'no label', source: 'identity', required: false, input_type: 'text' }]),
    ];
    // Each one alone.
    for (const detail of bad) {
      // Never throws, and never a half-list.
      const a = answers([event(APP, '2026-11-05T10:00:00Z', detail)]);
      // Unreadable, said as such.
      assert.equal(a.kind, 'unreadable');
      // Drawn without a single field row.
      assert.doesNotMatch(draw(a), /kit-field__label/);
    }
    // A read that is not a list is no kits, not a crash.
    assert.equal(answers({ nope: true }).kind, 'none');
  });

  it('a failed events read shows an error line, never "No form answers"', () => {
    // The read failed with a message.
    const a = details.answersFor({ kind: 'error', message: 'permission denied' }, APP);
    // Drawn.
    const html = draw(a);
    // The reason is shown, as an alert.
    assert.match(html, /role="alert"[^>]*>[^<]*permission denied/);
    // And the empty state is not.
    assert.doesNotMatch(html, /No form answers on record/);
  });

  it('the label reads "Answers prepared for this form", never "submitted"', () => {
    // One kit.
    const html = draw(answers([event(APP, '2026-11-05T10:00:00Z', kitDetail([field('Name', 'Teja')]))]));
    // The fixed label.
    assert.match(html, /Answers prepared for this form/);
    // A prefill is not a submission.
    assert.doesNotMatch(html, /submitted/i);
  });

  it('a long select list collapses behind a count; a matched answer shows only its option', () => {
    // 240 options, like the live country-code list on Enterpret 30889f9e.
    const options = Array.from({ length: 240 }, (_, i) => `Country ${i} +${i}`);
    // Unanswered: the whole list, collapsed.
    const open = draw(answers([event(APP, '2026-11-05T10:00:00Z', kitDetail([field('Country', null, { input_type: 'select', options })]))]));
    // Inside a <details> with the count.
    assert.match(open, /<details[^>]*kit-field__choices[^>]*><summary>Show 240 choices<\/summary>/);
    // Answered "Country 7": just that option, no disclosure.
    const picked = draw(answers([event(APP, '2026-11-05T10:00:00Z', kitDetail([field('Country', 'Country 7', { input_type: 'select', options })]))]));
    // The one pick.
    assert.match(picked, /Choices: Country 7 \+7</);
    // No collapsed list.
    assert.doesNotMatch(picked, /Show 240 choices/);
  });

  it('a row marked applied from Manual apply says you typed the final answers', () => {
    // A stored row whose move to applied came from the Manual apply page.
    const row = applied.readAppliedRow({
      id: APP, status: 'applied', updated_at: '2026-11-06T09:00:00Z', applied_at: '2026-11-06T09:00:00Z',
      resume_storage_path: null, screenshot_storage_path: null, tailored_profile: null, jobs: null, email_events: [],
      application_events: [{ event_type: 'status_change', from_status: 'blocked_needs_human', to_status: 'applied', created_at: '2026-11-06T09:00:00Z', detail: { source: 'manual_apply', from: 'blocked_needs_human' } }],
    });
    // Read, and flagged.
    assert.equal(row?.answersTypedByHand, true);
    // Drawn with the caveat.
    assert.match(draw(answers([event(APP, '2026-11-05T10:00:00Z', kitDetail([field('Name', 'Teja')]))]), true), /typed the final answers in the browser/);
    // A worker submit is not flagged.
    const worker = applied.readAppliedRow({ id: APP, status: 'applied', updated_at: '2026-11-06T09:00:00Z', application_events: [{ event_type: 'status_change', to_status: 'applied', created_at: '2026-11-06T09:00:00Z', detail: { source: 'worker' } }] });
    // Not by hand.
    assert.equal(worker?.answersTypedByHand, false);
  });

  it('the row names the master version its resume came from', () => {
    // A row with a frozen resume at master v3 and a stored file.
    const row = applied.readAppliedRow({
      id: APP, status: 'applied', updated_at: '2026-11-06T09:00:00Z', applied_at: '2026-11-06T09:00:00Z', resume_storage_path: 'u/a/1.pdf',
      tailored_profile: { schema_version: 1, master_version: 3, identity: { full_name: 'Teja Mallam' }, experience: [], skills: [], projects: [], education: [] },
      jobs: null, application_events: [], email_events: [],
    });
    // Read.
    assert.ok(row !== null);
    // Drawn with the answers block in its loading state.
    const html = render(h(pageMod.AppliedRowView, { row, edges: { kind: 'ok', edges: [] }, busy: false, error: null, now: Date.UTC(2026, 10, 7), onMove: () => {}, answers: { kind: 'loading' } }));
    // The version, beside the resume.
    assert.match(html, /master v3/);
  });
});
