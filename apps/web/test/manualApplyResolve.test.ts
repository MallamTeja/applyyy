/* Manual apply resolves on the kit card (2026-11-05): "Mark applied" and "Mark failed" on each job card,
 * so a job applied to by hand is recorded where it was applied from.
 *
 * WHAT THIS PINS. The card's moves come from the status graph (human edges out of the row's status),
 * narrowed to the two resolves; `approved` has them since migration 20261105121500. A row at `applying`
 * gets no buttons and says the worker owns it. The approval withdrawal (approved -> passed_filters) is a
 * real human edge but never a card button: a card is for finishing an application, not re-tailoring it.
 *
 * Rendered, not grepped: KitCard is drawn by react-dom/server, exactly as the page draws it. The click ->
 * inline confirm -> advance_application_status path runs in a real browser in manualApplyResolveE2e. */

// The .tsx loader; must be the first import so it runs before any component loads.
import './support/registerTsxHooks.ts';
import assert from 'node:assert/strict';
import { describe, it, before } from 'node:test';

// The page module, for KitCard and the move filter.
let page: typeof import('../src/features/manual-apply/ManualApplyPage.tsx');
// Static markup, no DOM.
let render: (element: unknown) => string;
// Element factory, so this .ts file needs no JSX.
let h: typeof import('react').createElement;
// A router for the card's in-app link.
let MemoryRouter: typeof import('react-router-dom').MemoryRouter;

before(async () => {
  // Transpiled by the hook.
  page = await import('../src/features/manual-apply/ManualApplyPage.tsx');
  // From the installed react-dom.
  render = (await import('react-dom/server')).renderToStaticMarkup as (element: unknown) => string;
  // React's factory.
  h = (await import('react')).createElement;
  // The router the app already uses.
  MemoryRouter = (await import('react-router-dom')).MemoryRouter;
});

// One row at the given status, as the page's read returns it.
const row = (status: string) => ({
  id: 'ba1e5d1d-84a5-4cfb-b5a6-e5a2943bf154',
  status,
  label: 'Intermediate Backend Engineer, India at GitLab',
  applyUrl: 'https://job-boards.greenhouse.io/gitlab/jobs/8775507002',
  stamp: '2026-11-05T06:00:00.123456+00:00',
});

// A card with no kit yet (the resolve buttons do not depend on the kit) and the given lock state.
function renderCard(status: string, locked = false): string {
  // The card under test; onMove is never called by a static render.
  return render(h(MemoryRouter, null, h(page.KitCard, { row: row(status), kit: { kind: 'none' }, resolve: { locked, frozen: false, onMove: () => undefined } })));
}

describe('Manual apply kit card: resolve buttons', () => {
  it('kitResolveMoves narrows to applied and failed, never the approval withdrawal', () => {
    // approved also has a human edge to passed_filters; it must not become a card button.
    assert.deepEqual([...page.kitResolveMoves('approved')].sort(), ['applied', 'failed']);
    // A manual-action lane row is resolved in its queue below, never from the card (one lock owner per row).
    assert.deepEqual(page.kitResolveMoves('blocked_needs_human'), []);
    // applying has no human resolve edge: the worker owns it.
    assert.deepEqual(page.kitResolveMoves('applying'), []);
  });

  it('a card at approved renders Mark applied and Mark failed, named for the row', () => {
    // The approved card.
    const html = renderCard('approved');
    // The applied resolve, in the manual-action wording, with the row in its accessible name.
    assert.match(html, /<button[^>]*aria-label="I applied \(mark applied\): Intermediate Backend Engineer, India at GitLab"[^>]*>I applied \(mark applied\)<\/button>/);
    // The give-up resolve.
    assert.match(html, /<button[^>]*>Failed \/ skip<\/button>/);
    // Not the withdrawal.
    assert.doesNotMatch(html, /passed_filters<\/button>/);
    // Enabled while unlocked.
    assert.doesNotMatch(html, /<button[^>]*disabled=""[^>]*>I applied/);
  });

  it('a locked card renders both resolves disabled', () => {
    // A move in flight on this row.
    const html = renderCard('approved', true);
    // Both buttons off, so a double click cannot send two moves.
    assert.equal((html.match(/<button[^>]*disabled=""[^>]*>(I applied \(mark applied\)|Failed \/ skip)<\/button>/g) ?? []).length, 2);
  });

  it('a lane card points at the queue below instead of drawing its own buttons', () => {
    // A blocked row: its graph has both resolves, but the queue under "After you apply" owns them.
    const html = renderCard('blocked_needs_human');
    // No second set of buttons.
    assert.doesNotMatch(html, /I applied \(mark applied\)|Failed \/ skip/);
    // Pointed at, not hidden.
    assert.match(html, /resolve it below/);
  });

  it('a card at applying has no resolve buttons and says the worker owns it', () => {
    // The in-flight card.
    const html = renderCard('applying');
    // No resolve.
    assert.doesNotMatch(html, /I applied \(mark applied\)|Failed \/ skip/);
    // Said, not hidden.
    assert.match(html, /In flight: the worker owns it/);
  });
});
