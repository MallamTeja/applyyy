/* Manual apply: an APPROVED row with no apply kit yet is listed as "Kit pending" with its approve time,
 * and is never hidden (2026-11-05).
 *
 * WHY. At 14:44 Teja opened /manual-apply with 5 approved rows and saw an empty page: the read only
 * fetched the two manual-action lanes plus rows that already had a kit, so an approved row whose kit
 * was still being generated (dispatch-apply starts the kit workflow on approve, 5c3ce87) was dropped.
 * These tests pin the row merge (pure) and the card's wording (static render). */

// The .tsx loader; must be the first import so it runs before any component loads.
import './support/registerTsxHooks.ts';
// Strict asserts, so a loose equality cannot pass a wrong shape.
import assert from 'node:assert/strict';
// The runner; before() loads the modules once.
import { describe, it, before } from 'node:test';

// The page's data module: the pure row merge lives here.
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
  data = await import('../src/features/manual-apply/manualApplyData.ts');
  // The component under test.
  page = await import('../src/features/manual-apply/ManualApplyPage.tsx');
  // Server render: no DOM lib in apps/web.
  render = (await import('react-dom/server')).renderToStaticMarkup as (element: unknown) => string;
  // The element factory.
  h = (await import('react')).createElement;
  // The router wrapper.
  MemoryRouter = (await import('react-router-dom')).MemoryRouter;
});

// The approve time the fixture row carries, exactly as PostgREST returns a timestamptz.
const APPROVED_AT = '2026-11-05T09:10:00.123456+00:00';

// One row as the page's read returns it; `over` sets status / id / approvedAt per case.
const row = (over: Record<string, unknown> = {}) => ({
  id: 'ba1e5d1d-84a5-4cfb-b5a6-e5a2943bf154',
  status: 'approved',
  label: 'Intermediate Backend Engineer, India at GitLab',
  applyUrl: 'https://job-boards.greenhouse.io/gitlab/jobs/8775507002',
  stamp: '2026-11-05T09:10:00.123456+00:00',
  approvedAt: APPROVED_AT,
  // No tailored resume: these cases are about the kit and the resolves, not the resume block.
  resume: null,
  // The job embed's title and company, apart.
  jobTitle: 'Intermediate Backend Engineer, India',
  // Same, the company.
  company: 'GitLab',
  ...over,
});

// One card with no kit, rendered inside a router.
function renderNoKit(r: ReturnType<typeof row>): string {
  // kind 'none' is what the page passes when no kit event exists for the row.
  return render(h(MemoryRouter, null, h(page.KitCard, { row: r as never, kit: { kind: 'none' }, resolve: { locked: false, frozen: false, onMove: () => undefined } })));
}

describe('Manual apply: approved row without a kit', () => {
  it('an approved row with no kit is kept by the row merge (never hidden)', () => {
    // No lane rows, one approved row, no kit rows: exactly the 14:44 page.
    const rows = data.mergeManualApplyRows({ lanes: [], approved: [row() as never], kitRows: [] });
    // The approved row is listed.
    assert.deepEqual(rows.map((r) => r.id), ['ba1e5d1d-84a5-4cfb-b5a6-e5a2943bf154']);
  });

  it('the merge lists lanes first and each row once', () => {
    // A lane row, and an approved row that also has a kit (so it arrives twice).
    const lane = row({ id: '11111111-1111-4111-8111-111111111111', status: 'needs_verification', approvedAt: null });
    // Same approved row in both the approved read and the kit read.
    const both = row();
    // Merge.
    const rows = data.mergeManualApplyRows({ lanes: [lane as never], approved: [both as never], kitRows: [both as never] });
    // Lane first, approved once.
    assert.deepEqual(rows.map((r) => r.id), ['11111111-1111-4111-8111-111111111111', 'ba1e5d1d-84a5-4cfb-b5a6-e5a2943bf154']);
  });

  it('an approved row with no kit renders Kit pending with its approve time', () => {
    // The card.
    const html = renderNoKit(row());
    // The state is named.
    assert.match(html, /Kit pending/);
    // The approve time is a machine-readable <time> carrying the exact stamp (timezone-independent check).
    assert.match(html, new RegExp(`<time dateTime="${APPROVED_AT.replace(/[.+]/g, '\\$&')}"`, 'i'));
    // The "ask the orchestrator" line is for rows whose kit is not coming on its own; not this one.
    assert.doesNotMatch(html, /Kit not generated yet/);
    // The kit-only actions are absent: no resume download, no copy-all.
    assert.doesNotMatch(html, /Download resume|Copy all answers/);
    // And the reason they are absent is said.
    assert.match(html, /resume and pre-answered fields appear here when the kit lands/i);
  });

  it('an approved row with a malformed approve time says so instead of printing a wrong date', () => {
    // A stamp that a lenient parser would turn into a year.
    const html = renderNoKit(row({ approvedAt: '-5' }));
    // Still pending, still listed.
    assert.match(html, /Kit pending/);
    // No <time> built from garbage.
    assert.doesNotMatch(html, /<time/);
    // The gap is said.
    assert.match(html, /approve time unknown/);
  });
});
