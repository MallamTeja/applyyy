/* Two Manual apply card bugs Teja hit live on the Enterpret row 30889f9e (2026-11-07 00:22).
 *
 * 1. "Resume preview" opened the tailored resume, and pressing it again did nothing: it was an
 *    open-only button, so there was no way to hide the preview again. It is now a real toggle: "Hide
 *    preview" while open, aria-expanded true/false, a second press closes it, and it stays in step when
 *    the <details> summary is clicked directly.
 * 2. A select field printed EVERY choice: "Choices: United States +1 | Afghanistan +93 | ... Zimbabwe
 *    +263" (about 240 options) under the answer "India". Choices only help when the answer is missing or
 *    matches nothing, so a matched answer shows just its own choice and anything else collapses. */

// The .tsx loader; must be the first import so it runs before any component loads.
import './support/registerTsxHooks.ts';
// Strict asserts, so a loose equality cannot pass a wrong shape.
import assert from 'node:assert/strict';
// The runner; before() loads the modules once.
import { describe, it, before } from 'node:test';
// A real ResolvedResume, the resume-template's own fixture, so the card renders its resume block.
import { zomatoBackendIntern } from '../../../packages/resume-template/test/fixtures/zomato-backend-intern.ts';

// The pure choice picker.
let choices: typeof import('../src/features/manual-apply/fieldChoices.ts');
// The pure toggle step.
let toggle: typeof import('../src/features/manual-apply/previewToggle.ts');
// The row parse, to build a real row.
let data: typeof import('../src/features/manual-apply/manualApplyData.ts');
// The page module: KitCard, rendered statically.
let page: typeof import('../src/features/manual-apply/ManualApplyPage.tsx');
// Static render, so the test reads exactly the HTML the card produces.
let render: (element: unknown) => string;
// createElement, to build the tree without JSX in a .ts test.
let h: typeof import('react').createElement;
// The card has Links, which need a router around them.
let MemoryRouter: typeof import('react-router-dom').MemoryRouter;

before(async () => {
  // Dynamic imports, after the tsx hook is registered.
  choices = await import('../src/features/manual-apply/fieldChoices.ts');
  // The toggle step.
  toggle = await import('../src/features/manual-apply/previewToggle.ts');
  // The row parse.
  data = await import('../src/features/manual-apply/manualApplyData.ts');
  // The component under test.
  page = await import('../src/features/manual-apply/ManualApplyPage.tsx');
  // The static renderer.
  render = (await import('react-dom/server')).renderToStaticMarkup as (element: unknown) => string;
  // createElement.
  h = (await import('react')).createElement;
  // The router.
  MemoryRouter = (await import('react-router-dom')).MemoryRouter;
});

// One application id.
const ID = 'e1456a47-ef69-4faf-8a11-3fc5a9ed5a49';

// About 240 country options like the live Greenhouse phone-country select ("India +91").
const COUNTRIES: readonly string[] = [
  // The first live entry.
  'United States +1',
  // A neighbour that must NOT match "India".
  'Indonesia +62',
  // The one the answer names.
  'India +91',
  // Filler to reach the live size; each name is unique so a matcher cannot lean on duplicates.
  ...Array.from({ length: 237 }, (_, i) => `Country${i} +${i + 300}`),
  // The last live entry.
  'Zimbabwe +263',
];

describe('pressing Resume preview twice closes the block', () => {
  // A stand-in for the <details> element: only what the step touches.
  const fakeBlock = (open: boolean) => {
    // How many times the step scrolled it into view.
    const calls = { scrolled: 0 };
    // The element's surface.
    const block = { open, scrollIntoView: () => { calls.scrolled += 1; } };
    // Both, so the test can read the side effect.
    return { block, calls };
  };

  it('a press on an open block closes it and does not scroll', () => {
    // The card's block starts open.
    const { block, calls } = fakeBlock(true);
    // One press.
    const next = toggle.pressPreview(block);
    // Closed, and the report says so.
    assert.equal(next, false);
    // The element really closed.
    assert.equal(block.open, false);
    // Hiding never scrolls.
    assert.equal(calls.scrolled, 0);
  });

  it('the second press opens it again and scrolls it into view', () => {
    // Start open, press twice.
    const { block, calls } = fakeBlock(true);
    // First press hides.
    toggle.pressPreview(block);
    // Second press shows.
    const next = toggle.pressPreview(block);
    // Open again.
    assert.equal(next, true);
    // The element is open.
    assert.equal(block.open, true);
    // Showing scrolls it to the operator.
    assert.equal(calls.scrolled, 1);
  });

  it('no block on the page answers with the block\'s default (open), so the label never lies', () => {
    // The element is gone (card re-rendered away).
    assert.equal(toggle.pressPreview(null), true);
  });
});

describe('the toggle button on the card', () => {
  // The card for a row with a valid resume and no kit.
  const renderCard = (kit: unknown): string => {
    // A parsed row with the fixture resume.
    const row = data.parseRow({
      id: ID,
      status: 'approved',
      updated_at: '2026-11-05T09:10:00.123456+00:00',
      status_changed_at: '2026-11-05T09:10:00.123456+00:00',
      tailored_profile: zomatoBackendIntern,
      jobs: { title: 'Backend Intern', company_name: 'Zomato', apply_url: 'https://jobs.lever.co/zomato/1' },
    });
    // The card inside a router.
    return render(h(MemoryRouter, null, h(page.KitCard, { row: row as never, kit: kit as never, resolve: { locked: false, frozen: false, onMove: () => undefined } })));
  };

  it('starts as "Hide preview" with aria-expanded=true, because the block starts open', () => {
    // The card, no kit.
    const html = renderCard({ kind: 'none' });
    // The label says what a press does now.
    assert.match(html, />Hide preview<\/button>/);
    // The state is exposed, not only the label.
    assert.match(html, /aria-expanded="true"/);
    // The old open-only label is gone: a button must not say "Resume preview" while the preview is showing.
    assert.doesNotMatch(html, />Resume preview<\/button>/);
  });
});

describe('a select field shows its choices only when they help', () => {
  it('a matched answer shows just its own choice (the exact option to pick)', () => {
    // "India" against the live-size list.
    const view = choices.choiceView('India', COUNTRIES);
    // One choice, and it is the right one: not "Indonesia +62".
    assert.deepEqual(view, { kind: 'matched', picks: ['India +91'] });
  });

  it('an exact option and a different case both match', () => {
    // Exact.
    assert.deepEqual(choices.choiceView('Yes', ['Yes', 'No']), { kind: 'matched', picks: ['Yes'] });
    // Case and surrounding space differ.
    assert.deepEqual(choices.choiceView('  yes ', ['Yes', 'No']), { kind: 'matched', picks: ['Yes'] });
  });

  it('an unanswered field or an answer matching nothing collapses all choices, with the count', () => {
    // No answer.
    assert.deepEqual(choices.choiceView(null, COUNTRIES), { kind: 'all', options: COUNTRIES });
    // An answer no option carries.
    assert.deepEqual(choices.choiceView('Atlantis', COUNTRIES), { kind: 'all', options: COUNTRIES });
  });

  it('no options at all shows nothing', () => {
    // Null and empty are both "nothing to choose from".
    assert.deepEqual(choices.choiceView('India', null), { kind: 'none' });
    // Empty list.
    assert.deepEqual(choices.choiceView('India', []), { kind: 'none' });
  });

  it('a word prefix is not a substring: "Niger" does not pick "Nigeria +234"', () => {
    // Two real neighbours.
    assert.deepEqual(choices.choiceView('Niger', ['Niger +227', 'Nigeria +234']), { kind: 'matched', picks: ['Niger +227'] });
    // Only the longer one exists: no match, so everything collapses rather than picking the wrong country.
    assert.deepEqual(choices.choiceView('Niger', ['Nigeria +234']), { kind: 'all', options: ['Nigeria +234'] });
  });

  it('the rendered card prints one choice for "India", never the 240-option wall', () => {
    // A kit with one select field answered "India".
    const kit = { kind: 'kit', kit: { formUrl: 'https://example.com/form', resume: null, fields: [{ label: 'Country', value: 'India', source: 'identity', required: true, inputType: 'select', options: COUNTRIES }], warnings: [] } };
    // The card.
    const html = renderCardWithKit(kit);
    // The exact option to pick.
    assert.match(html, /Choices: India \+91/);
    // Positive control for the wall: the last option of the list is NOT on the page.
    assert.doesNotMatch(html, /Zimbabwe/);
    // And no disclosure for a matched answer.
    assert.doesNotMatch(html, /Show \d+ choices/);
  });

  it('the rendered card collapses an unanswered select into a "Show 241 choices" disclosure', () => {
    // The same field with no answer.
    const kit = { kind: 'kit', kit: { formUrl: 'https://example.com/form', resume: null, fields: [{ label: 'Country', value: null, source: 'unanswered', required: false, inputType: 'select', options: COUNTRIES }], warnings: [] } };
    // The card.
    const html = renderCardWithKit(kit);
    // A native disclosure, closed (no open attribute on this one), with the count.
    assert.match(html, /<details class="kit-field__choices"><summary>Show 241 choices<\/summary>/);
    // The options live inside it, so they are still reachable.
    assert.match(html, /Zimbabwe \+263/);
  });
});

// The card for a no-resume row with the given kit; the choices tests do not need a resume block.
function renderCardWithKit(kit: unknown): string {
  // A parsed row with no tailored resume.
  const row = data.parseRow({
    id: ID,
    status: 'approved',
    updated_at: '2026-11-05T09:10:00.123456+00:00',
    status_changed_at: '2026-11-05T09:10:00.123456+00:00',
    tailored_profile: null,
    jobs: { title: 'Backend Intern', company_name: 'Zomato', apply_url: 'https://jobs.lever.co/zomato/1' },
  });
  // The card inside a router.
  return render(h(MemoryRouter, null, h(page.KitCard, { row: row as never, kit: kit as never, resolve: { locked: false, frozen: false, onMove: () => undefined } })));
}
