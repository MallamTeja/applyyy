/* Manual apply kits (2026-10-24): the page that lists every job to apply to by hand with its form
 * pre-answered. Pins the contract parse (all-or-nothing), the newest-kit join, the rendered card
 * (form order, copy buttons, required gaps, safe links) and the rail badge's arithmetic.
 *
 * Rendered, not grepped: KitCard is the exact component the page draws per job, rendered by
 * react-dom/server inside a MemoryRouter (its Answer-bank link needs a router). */

// The .tsx loader; must be the first import so it runs before any component loads.
import './support/registerTsxHooks.ts';
import assert from 'node:assert/strict';
import { describe, it, before } from 'node:test';

// The pure kit module.
let kitMod: typeof import('../src/features/manual-apply/applyKit.ts');
// The page module, for KitCard.
let page: typeof import('../src/features/manual-apply/ManualApplyPage.tsx');
// Static markup, no DOM.
let render: (element: unknown) => string;
// Element factory, so this .ts file needs no JSX.
let h: typeof import('react').createElement;
// A router for the card's in-app link.
let MemoryRouter: typeof import('react-router-dom').MemoryRouter;

before(async () => {
  // Plain .ts.
  kitMod = await import('../src/features/manual-apply/applyKit.ts');
  // Transpiled by the hook.
  page = await import('../src/features/manual-apply/ManualApplyPage.tsx');
  // From the installed react-dom.
  render = (await import('react-dom/server')).renderToStaticMarkup as (element: unknown) => string;
  // React's factory.
  h = (await import('react')).createElement;
  // The router the app already uses.
  MemoryRouter = (await import('react-router-dom')).MemoryRouter;
});

// A valid v1 kit for the GitLab form; `over` replaces top-level keys for the negative cases.
const kitDetail = (over: Record<string, unknown> = {}) => ({
  kind: 'apply_kit',
  v: 1,
  generated_at: '2026-10-24T08:10:00Z',
  run_id: 'run-kit-1',
  form_url: 'https://job-boards.greenhouse.io/gitlab/jobs/8775507002',
  resume: { storage_path: 'user-1/ba1e5d1d-84a5-4cfb-b5a6-e5a2943bf154/1761293400000.pdf', file_name: 'Teja_Mallam_GitLab.pdf' },
  fields: [
    // Form order: first name, email, resume upload, a required question we cannot answer, an optional select.
    { label: 'First Name', value: 'Teja', source: 'identity', required: true, input_type: 'text' },
    { label: 'Email', value: 'teja@example.com', source: 'identity', required: true, input_type: 'text' },
    { label: 'Resume/CV', value: 'Teja_Mallam_GitLab.pdf', source: 'derived', required: true, input_type: 'file' },
    { label: 'Will you require visa sponsorship?', value: null, source: 'unanswered', required: true, input_type: 'select', options: ['Yes', 'No'] },
    { label: 'How did you hear about us?', value: 'Job board', source: 'answer_bank', required: false, input_type: 'select', options: ['Job board', 'Referral'] },
  ],
  warnings: ['The board shows a reCAPTCHA; submit from your own browser.'],
  ...over,
});

// The GitLab row as the page's read returns it.
const row = (applyUrl: string | null = 'https://job-boards.greenhouse.io/gitlab/jobs/8775507002') => ({
  id: 'ba1e5d1d-84a5-4cfb-b5a6-e5a2943bf154',
  status: 'needs_verification' as const,
  label: 'Intermediate Backend Engineer, India at GitLab',
  applyUrl,
  stamp: '2026-10-24T08:10:00.000000+00:00',
});

// One card, rendered inside a router.
function renderCard(kit: unknown, applyUrl?: string | null): string {
  // The card under test with the given kit state.
  return render(h(MemoryRouter, null, h(page.KitCard, { row: row(applyUrl), kit, resolve: { locked: false, frozen: false, onMove: () => undefined } })));
}

// The state a single kit event produces, through the same join the page uses.
const stateOf = (detail: unknown) => kitMod.newestKitStates([{ application_id: 'ba1e5d1d-84a5-4cfb-b5a6-e5a2943bf154', created_at: '2026-10-24T08:10:00Z', detail }]).get('ba1e5d1d-84a5-4cfb-b5a6-e5a2943bf154');

describe('valid kit', () => {
  it('renders every field in form order, with a copy button per typed answer', () => {
    // The real card.
    const html = renderCard(stateOf(kitDetail()));
    // Every label, at increasing positions: the form's order.
    const positions = ['First Name', 'Email', 'Resume/CV', 'Will you require visa sponsorship?', 'How did you hear about us?'].map((l) => html.indexOf(l));
    // All present.
    assert.ok(positions.every((p) => p >= 0), `all labels rendered: ${positions}`);
    // Strictly increasing.
    assert.deepEqual([...positions].sort((a, b) => a - b), positions);
    // Copy buttons: First Name, Email, How did you hear (the file field and the unanswered one have none), plus "all answers".
    assert.equal((html.match(/aria-label="Copy /g) ?? []).length, 4);
    // The copy-all button is there.
    assert.match(html, /aria-label="Copy all answers"/);
    // The resume download names the file.
    assert.match(html, /Download resume \(Teja_Mallam_GitLab\.pdf\)/);
    // The warning is shown.
    assert.match(html, /reCAPTCHA/);
  });

  it('highlights a required unanswered field and links to the Answer bank', () => {
    // Same kit.
    const html = renderCard(stateOf(kitDetail()));
    // Exactly one missing-required field: the sponsorship question.
    assert.equal((html.match(/kit-field--missing/g) ?? []).length, 1);
    // That field carries the fix link.
    assert.match(html, /class="kit-field kit-field--missing"[^]*?visa sponsorship[^]*?href="\/answer-bank"/);
  });

  it('copy-all text lists typed fields as label: value, saying when an answer is missing', () => {
    // The parsed kit.
    const parsed = kitMod.parseApplyKit(kitDetail());
    // Valid.
    assert.ok(parsed.ok);
    // File field skipped; the gap is said, not left blank.
    assert.equal(kitMod.copyAllText(parsed.kit), 'First Name: Teja\nEmail: teja@example.com\nWill you require visa sponsorship?: (unanswered)\nHow did you hear about us?: Job board');
  });
});

describe('malformed kit', () => {
  it('renders "Kit unreadable" and NO fields when one field breaks the contract', () => {
    // The second field's value is a number: a broken contract, not a partial answer.
    const bad = kitDetail({ fields: [{ label: 'First Name', value: 'Teja', source: 'identity', required: true, input_type: 'text' }, { label: 'Email', value: 42, source: 'identity', required: true, input_type: 'text' }] });
    // Through the page's join.
    const html = renderCard(stateOf(bad));
    // Said.
    assert.match(html, /Kit unreadable \(field 2 has a non-string value\)/);
    // And not one field shown, not even the valid first one.
    assert.equal(/kit-field/.test(html), false, 'an unreadable kit must render no fields');
  });

  it('the NEWEST kit decides: a malformed newer kit is unreadable even if an older one was valid', () => {
    // An older valid kit and a newer broken one for the same application.
    const states = kitMod.newestKitStates([
      { application_id: 'a', created_at: '2026-10-24T07:00:00Z', detail: kitDetail() },
      { application_id: 'a', created_at: '2026-10-24T09:00:00Z', detail: kitDetail({ v: 2 }) },
    ]);
    // Unreadable, with the reason.
    assert.deepEqual(states.get('a'), { kind: 'unreadable', reason: 'unsupported version 2' });
  });

  it('keys kits by exact application id: two applications, no cross-talk', () => {
    // Two applications, each with its own kit.
    const states = kitMod.newestKitStates([
      { application_id: 'a', created_at: '2026-10-24T07:00:00Z', detail: kitDetail({ form_url: 'https://a.example/apply' }) },
      { application_id: 'b', created_at: '2026-10-24T07:00:00Z', detail: kitDetail({ form_url: 'https://b.example/apply' }) },
    ]);
    // Each gets its own form URL.
    assert.deepEqual([states.get('a'), states.get('b')].map((s) => (s?.kind === 'kit' ? s.kit.formUrl : null)), ['https://a.example/apply', 'https://b.example/apply']);
  });
});

describe('links', () => {
  it('renders NO href for a javascript: form_url, and says the link is unavailable', () => {
    // A hostile form URL in an otherwise valid kit; the job's own apply URL is ignored because the kit names one.
    const html = renderCard(stateOf(kitDetail({ form_url: 'javascript:alert(1)' })));
    // Positive shape: the only anchors are in-app (the Answer-bank link); no external href at all.
    assert.deepEqual(html.match(/href="[^"]*"/g), ['href="/answer-bank"']);
    // Said.
    assert.match(html, /Form link unavailable/);
  });

  it('opens a safe form URL in a new tab with noopener noreferrer', () => {
    // The valid kit.
    const html = renderCard(stateOf(kitDetail()));
    // The vetted anchor.
    assert.match(html, /<a class="kit-card__open" href="https:\/\/job-boards\.greenhouse\.io\/gitlab\/jobs\/8775507002" target="_blank" rel="noopener noreferrer">Open the form<\/a>/);
  });

  it('with no kit yet, says so and still offers the job\'s own apply link', () => {
    // No kit event.
    const html = renderCard({ kind: 'none' });
    // Said.
    assert.match(html, /Kit not generated yet/);
    // The job's apply URL is the fallback.
    assert.match(html, /href="https:\/\/job-boards\.greenhouse\.io\/gitlab\/jobs\/8775507002"/);
  });
});

describe('rail badge', () => {
  /* Since 2026-11-05 the badge counts the page's own row list (test/manualApplyBadge.test.ts); these
     pin the fallback when that list could not be read. */
  it('without the page rows, counts the two manual lanes only (applying is not a lane)', () => {
    // 1 unknown submit + 2 blocked; the 5 applying rows are the worker's, not the operator's.
    assert.equal(kitMod.manualApplyCount({ needs_verification: 1, blocked_needs_human: 2, applying: 5 }, null), 3);
  });

  it('is 0 with no lane rows and an empty page list', () => {
    // A read page with nothing on it is a real 0, unlike a failed read.
    assert.equal(kitMod.manualApplyCount({ applying: 1 }, []), 0);
  });
});
