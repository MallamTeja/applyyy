/* Manual apply shows every approved row's TAILORED resume, kit or no kit, and says why a kit was
 * skipped instead of "Kit pending" forever (2026-11-05).
 *
 * WHY. Teja, 23:47: "the tailored resume must be there in the Manual apply section, kit or no kit".
 * The card offered a "Download resume" link only when a kit existed, so an approved row whose kit was
 * pending or skipped had no resume on the page at all. And a row whose kit the worker REFUSED
 * (robots_refused, posting_closed: worker/src/apply-kit.ts KitSkip) read "Kit pending" for ever,
 * because the page never read the apply_kit_skipped note. These tests pin the row mapping (pure), the
 * kit-state parse (pure) and the card's output (static render). */

// The .tsx loader; must be the first import so it runs before any component loads.
import './support/registerTsxHooks.ts';
// Strict asserts, so a loose equality cannot pass a wrong shape.
import assert from 'node:assert/strict';
// The runner; before() loads the modules once.
import { describe, it, before } from 'node:test';
// Read AppShell's source for the one shape assertion on its badge call.
import { readFileSync } from 'node:fs';
// Resolve that source relative to this test, so cwd does not matter.
import { fileURLToPath } from 'node:url';
// A real ResolvedResume (schema_version 1, master_version 3), the resume-template's own fixture.
import { zomatoBackendIntern } from '../../../packages/resume-template/test/fixtures/zomato-backend-intern.ts';

// The page's data module: the row parse and its select.
let data: typeof import('../src/features/manual-apply/manualApplyData.ts');
// The kit module: the newest-state parse.
let kitMod: typeof import('../src/features/manual-apply/applyKit.ts');
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
  // The kit parse.
  kitMod = await import('../src/features/manual-apply/applyKit.ts');
  // The component under test.
  page = await import('../src/features/manual-apply/ManualApplyPage.tsx');
  // The static renderer.
  render = (await import('react-dom/server')).renderToStaticMarkup as (element: unknown) => string;
  // createElement.
  h = (await import('react')).createElement;
  // The router.
  MemoryRouter = (await import('react-router-dom')).MemoryRouter;
});

// One approved application id, used throughout.
const ID = 'e1456a47-ef69-4faf-8a11-3fc5a9ed5a49';

// One raw application row as PostgREST returns it for ROW_SELECT; `over` replaces fields per case.
const raw = (over: Record<string, unknown> = {}) => ({
  id: ID,
  status: 'approved',
  updated_at: '2026-11-05T09:10:00.123456+00:00',
  status_changed_at: '2026-11-05T09:10:00.123456+00:00',
  tailored_profile: zomatoBackendIntern,
  jobs: { title: 'Backend Intern', company_name: 'Zomato', apply_url: 'https://jobs.lever.co/zomato/1' },
  ...over,
});

// The card for a parsed row and a kit state, inside a router.
function renderCard(row: unknown, kit: unknown): string {
  // No lock, no move: these cases are about what is shown.
  return render(h(MemoryRouter, null, h(page.KitCard, { row: row as never, kit: kit as never, resolve: { locked: false, frozen: false, onMove: () => undefined } })));
}

describe('the row read carries the tailored resume', () => {
  it('selects tailored_profile with the job embed (the exact column list)', () => {
    // Positive full shape: a dropped column fails here, not silently at runtime.
    assert.equal(data.ROW_SELECT, 'id, status, updated_at, status_changed_at, tailored_profile, jobs:job_id(title, company_name, apply_url)');
  });

  it('the rail badge reads without tailored_profile (it only counts rows; every cold load pays for it)', () => {
    // Positive full shape of the badge's column list: the page's list minus the resume jsonb.
    assert.equal(data.BADGE_ROW_SELECT, 'id, status, updated_at, status_changed_at, jobs:job_id(title, company_name, apply_url)');
    // AppShell asks for the badge read by name (a code form, not prose), so it cannot silently take the page's.
    assert.match(readFileSync(fileURLToPath(new URL('../src/app/AppShell.tsx', import.meta.url)), 'utf8'), /void loadManualApply\('badge'\)\.then\(/);
  });

  it('maps a valid tailored_profile to resume, with the job title and company apart', () => {
    // The parse of a full row.
    const row = data.parseRow(raw());
    // The snapshot is the resume itself, pinned to its own master version.
    assert.equal(row?.resume?.master_version, 3);
    // Title and company for the preview heading and the PDF filename.
    assert.deepEqual([row?.jobTitle, row?.company], ['Backend Intern', 'Zomato']);
  });

  it("maps a malformed tailored_profile ('{}') to resume null, never an empty resume", () => {
    // '{}' is the malformed write a truthy test would let through.
    assert.equal(data.parseRow(raw({ tailored_profile: {} }))?.resume, null);
  });
});

describe('the card shows the tailored resume, kit or no kit', () => {
  it('an approved row with NO kit shows its tailored resume preview and Download PDF', () => {
    // The approved row, kit not landed.
    const html = renderCard(data.parseRow(raw()), { kind: 'none' });
    // The block's summary names both offers.
    assert.match(html, /<summary>Tailored resume: preview and Download PDF<\/summary>/);
    // The shared preview's own print button, for the tailored pane (ResumePreview's accessible name shape).
    assert.match(html, /aria-label="Download PDF, Tailored for Zomato"/);
  });

  it('a row with a skipped kit still shows its tailored resume', () => {
    // The robots-refused row.
    const html = renderCard(data.parseRow(raw()), { kind: 'skipped', code: 'robots_refused', reason: '' });
    // The resume block is there whatever the kit state.
    assert.match(html, /<summary>Tailored resume: preview and Download PDF<\/summary>/);
  });

  it('a row with no valid tailored resume says so', () => {
    // Never tailored.
    const html = renderCard(data.parseRow(raw({ tailored_profile: null })), { kind: 'none' });
    // Said in words.
    assert.match(html, /No tailored resume on this row, so there is nothing to download here\./);
  });
});

describe('a skipped kit says why', () => {
  // One note event for ID.
  const event = (at: string, detail: unknown) => ({ application_id: ID, created_at: at, detail });
  // A minimal valid v1 kit with no fields.
  const KIT = { kind: 'apply_kit', v: 1, generated_at: '2026-11-05T06:00:00Z', run_id: null, form_url: 'https://example.com/form', resume: null, fields: [], warnings: [] };

  it('the newest apply_kit_skipped note is a skipped state with its code and reason', () => {
    // One robots skip.
    const state = kitMod.newestKitStates([event('2026-11-05T07:00:00Z', { kind: 'apply_kit_skipped', code: 'robots_refused', reason: 'robots.txt disallows /apply' })]).get(ID);
    // Exactly the skipped shape.
    assert.deepEqual(state, { kind: 'skipped', code: 'robots_refused', reason: 'robots.txt disallows /apply' });
  });

  it('a skip code outside the closed list is unreadable, never a guessed sentence', () => {
    // A future worker code this page has no words for.
    const state = kitMod.newestKitStates([event('2026-11-05T07:00:00Z', { kind: 'apply_kit_skipped', code: 'captcha' })]).get(ID);
    // Unreadable, naming the code.
    assert.deepEqual(state, { kind: 'unreadable', reason: 'unknown skip code "captcha"' });
  });

  it('the newest note decides: a kit written after a skip wins, a skip after a kit wins', () => {
    // Skip then kit.
    assert.equal(kitMod.newestKitStates([event('2026-11-05T07:00:00Z', { kind: 'apply_kit_skipped', code: 'posting_closed' }), event('2026-11-05T08:00:00Z', KIT)]).get(ID)?.kind, 'kit');
    // Kit then skip.
    assert.equal(kitMod.newestKitStates([event('2026-11-05T07:00:00Z', KIT), event('2026-11-05T08:00:00Z', { kind: 'apply_kit_skipped', code: 'posting_closed' })]).get(ID)?.kind, 'skipped');
  });

  it('a robots-refused card says "Site refuses bots: apply by hand."', () => {
    // The approved row whose kit the worker refused.
    const html = renderCard(data.parseRow(raw()), { kind: 'skipped', code: 'robots_refused', reason: '' });
    // The skip sentence, in the announced status line.
    assert.match(html, /<p class="panel__note" role="status"><strong>Kit skipped\.<\/strong> Site refuses bots: apply by hand\.<\/p>/);
  });

  it('a posting-closed card says so and carries the worker reason', () => {
    // The closed posting, with the worker's own sentence.
    const html = renderCard(data.parseRow(raw()), { kind: 'skipped', code: 'posting_closed', reason: 'Lever says the posting is closed' });
    // Code sentence then reason.
    assert.match(html, /<strong>Kit skipped\.<\/strong> Posting closed: check the form, and mark it failed if it is gone\.<span class="kit-card__skip-reason"> \(Lever says the posting is closed\)<\/span>/);
  });
});
