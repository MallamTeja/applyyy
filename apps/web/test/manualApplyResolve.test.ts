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
// Types only (erased at run time): the row fixture is built as the real type, so a field the page gains fails tsc here.
import type { ManualApplyRow } from '../src/features/manual-apply/manualApplyData.ts';
// Same, the closed status union the row carries.
import type { ApplicationStatus } from '../src/data/contract.ts';

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
const row = (status: ApplicationStatus): ManualApplyRow => ({
  id: 'ba1e5d1d-84a5-4cfb-b5a6-e5a2943bf154',
  status,
  label: 'Intermediate Backend Engineer, India at GitLab',
  applyUrl: 'https://job-boards.greenhouse.io/gitlab/jobs/8775507002',
  stamp: '2026-11-05T06:00:00.123456+00:00',
  // No tailored resume: these cases are about the kit and the resolves, not the resume block.
  resume: null,
  // The job embed's title and company, apart.
  jobTitle: 'Intermediate Backend Engineer, India',
  // Same, the company.
  company: 'GitLab',
  // The resolve buttons never read it; null is the "unknown approve time" the card already proves before showing.
  approvedAt: null,
  // Not parked by the bot, so no block reason.
  blockReason: null,
  // No provider: these cases are not about the Workday signal.
  atsProvider: null,
});

// A card with no kit yet (the resolve buttons do not depend on the kit) and the given lock state.
function renderCard(status: ApplicationStatus, locked = false): string {
  // The card under test; onMove is never called by a static render.
  return render(h(MemoryRouter, null, h(page.KitCard, { row: row(status), kit: { kind: 'none' }, resolve: { locked, frozen: false, onMove: () => undefined } })));
}

describe('Manual apply kit card: resolve buttons', () => {
  it('kitResolveMoves narrows to applied and failed, never the approval withdrawal', () => {
    // approved also has a human edge to passed_filters; it must not become a card button.
    assert.deepEqual([...page.kitResolveMoves('approved')].sort(), ['applied', 'failed']);
    // A manual-action lane row is resolved ON ITS CARD since 2026-11-07 (Teja could not find the queue below
    // the cards for Gushwork at needs_verification): the same two resolves as an approved row.
    assert.deepEqual([...page.kitResolveMoves('needs_verification')].sort(), ['applied', 'failed']);
    // Same for the blocked lane; its third edge (-> dropped_filter) stays on System health.
    assert.deepEqual([...page.kitResolveMoves('blocked_needs_human')].sort(), ['applied', 'failed']);
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

  it('a needs_verification card renders Mark applied and Mark failed on the card itself', () => {
    // The Gushwork 207dd30d case (2026-11-07): applied by hand, and the card offered no way to record it.
    const html = renderCard('needs_verification');
    // The applied resolve, named for the row, enabled.
    assert.match(html, /<button[^>]*aria-label="I applied \(mark applied\): Intermediate Backend Engineer, India at GitLab"[^>]*>I applied \(mark applied\)<\/button>/);
    // The give-up resolve.
    assert.match(html, /<button[^>]*>Failed \/ skip<\/button>/);
    // Never the held re-arm (needs_verification -> approved).
    assert.doesNotMatch(html, /Mark as approved/);
    // No pointer at a queue that is no longer on this page.
    assert.doesNotMatch(html, /resolve it below/);
    // Points at where the worker's cause and any receipt live, so applied is not clicked on hope.
    assert.match(html, /System health/);
  });

  it('a blocked_needs_human card also resolves on the card', () => {
    // The other manual-action lane gets the same two buttons.
    const html = renderCard('blocked_needs_human');
    // Both resolves present.
    assert.equal((html.match(/<button[^>]*>(I applied \(mark applied\)|Failed \/ skip)<\/button>/g) ?? []).length, 2);
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
