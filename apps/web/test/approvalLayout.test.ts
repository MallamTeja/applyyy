/* The approval queue PAGE layout (Teja, 2026-11-07 10:12/10:25 IST: "the alignment of buttons, things,
 * components is my nightmare"; approved spec: slim cards, the AI chat is the only edit path).
 *
 * Pinned here:
 *   - a queue row carries no source badge, no "master v{N}" and no queued-at chip (dropped as noise);
 *   - the "Pay band UK/US only" chip (finding N2, d5247b4) renders on the row for a remote job whose
 *     pay band names only UK/US places, and NOT for a posting whose only money is a funding round;
 *   - the approval select asks for jobs.location_raw, without which the chip could never fire;
 *   - every row's three toggles sit in ONE toolbar, in one order, in both buckets.
 * The chips are rendered for real (react-dom/server); the wiring is read off the page source, as the
 * other approval tests do, because the page itself needs a live Supabase client to mount. */

// The .tsx loader; first, so it is in place before the page module is imported.
import './support/registerTsxHooks.ts';
// Reads the page source for the wiring checks.
import { readFileSync } from 'node:fs';
// Resolves the page path relative to this test, wherever node --test is run from.
import { fileURLToPath } from 'node:url';
// The repo's runner, with a before() hook for the dynamic imports.
import { before, describe, it } from 'node:test';
// Strict mode: no loose equality can pass a wrong shape.
import assert from 'node:assert/strict';

// The page module, loaded after the hooks so its .tsx and extensionless imports resolve.
let page: typeof import('../src/features/approval/ApprovalQueuePage.tsx');
// Static server renderer: no DOM library exists in apps/web.
let render: (element: unknown) => string;
// Element factory, so this .ts file needs no JSX.
let h: typeof import('react').createElement;

before(async () => {
  // The component and the pure fact builder under test.
  page = await import('../src/features/approval/ApprovalQueuePage.tsx');
  // The renderer the other component tests use.
  render = (await import('react-dom/server')).renderToStaticMarkup as (element: unknown) => string;
  // React's createElement.
  h = (await import('react')).createElement;
});

// The page source, for the wiring checks that rendering cannot reach.
const source = readFileSync(fileURLToPath(new URL('../src/features/approval/ApprovalQueuePage.tsx', import.meta.url)), 'utf8');
// The queue's first read, moved here on 2026-11-09 (shared with the shell-side prefetch); select checks read it.
const queueRead = readFileSync(fileURLToPath(new URL('../src/features/approval/queuePrefetch.ts', import.meta.url)), 'utf8');

// The text between two anchors, failing by name if either is missing (an empty slice guards nothing).
function between(start: string, end: string): string {
  // The opening anchor.
  const from = source.indexOf(start);
  // Missing means the code moved; say which anchor.
  assert.ok(from >= 0, `anchor not found: ${start}`);
  // The closing anchor, after the opening one.
  const to = source.indexOf(end, from + start.length);
  // Same for the closing anchor.
  assert.ok(to > from, `anchor not found after start: ${end}`);
  // The slice itself.
  return source.slice(from, to);
}

/* A diff with nothing measured, so the ATS chip reads its dash. Only `coverage` is read by the chips;
   the cast is the fixture saying so, not a claim that this is a whole ResumeDiff. */
const DIFF = { coverage: { jdKeywords: [], honestlyMatched: [], matchedByFabrication: [], missing: [] } };

// One stored row as the select returns it: the matcher's fit and the two job columns the chip reads.
function row(locationRaw: string | null, descriptionRaw: string | null): Parameters<typeof page.chipFactsFor>[0] {
  // match_score as the client hands it back; jobs as the embed returns it.
  return { match_score: 72, jobs: { location_raw: locationRaw, description_raw: descriptionRaw } };
}

// The chip line as the operator sees it, built from a stored row the way the load pass builds it.
function chips(locationRaw: string | null, descriptionRaw: string | null): string {
  // The real component, with facts from the real builder: no hand-made facts that could drift.
  return render(h(page.QueueRowChips, { diff: DIFF as never, facts: page.chipFactsFor(row(locationRaw, descriptionRaw)) }));
}

describe('queue row chips', () => {
  it('shows "Pay band UK/US only" for a remote job whose pay band names only UK and US', () => {
    // Finding N2's own fixture: remote, with the band listed for UK and US only.
    assert.match(chips('Remote', 'UK £80k–£125k · US $125k–$250k'), /Pay band UK\/US only/);
  });

  it('shows no pay-band chip when the only money in the posting is a funding round', () => {
    // A funding round is not a pay band; a chip here would be a false warning.
    assert.doesNotMatch(chips('Remote', 'Over $1B raised'), /Pay band/);
  });

  it('keeps fit and ATS score, and drops the queued-at chip', () => {
    // The rendered line for an ordinary row.
    const html = chips('Remote', 'Over $1B raised');
    // The matcher's fit stays.
    assert.match(html, /Fit 72 · master vs JD/);
    // The tailored coverage stays, with its dash when nothing was measured.
    assert.match(html, /ATS score —/);
    // The queued-at chip is gone (Teja, 2026-11-07).
    assert.doesNotMatch(html, /Added to queue/);
  });

  it('reads a non-string location as no location, never as text', () => {
    // A junk column value must not reach the gate or the row as "[object Object]".
    assert.equal(page.chipFactsFor({ match_score: null, jobs: { location_raw: { x: 1 }, description_raw: 5 } }).payBand, null);
  });
});

describe('queue row wiring', () => {
  it('asks the database for jobs.location_raw', () => {
    // The chip reads it; without it in the select, payBandRegionWarning would always see null.
    // The select moved to queuePrefetch.ts on 2026-11-09 (shared with the shell-side prefetch).
    assert.match(queueRead, /jobs:job_id\([^)]*\blocation_raw\b[^)]*\)/);
  });

  it('draws no source badge, no master version and no queued-at chip on any row', () => {
    // Both bucket maps, from the B map to the end of the A list.
    const rows = between('{bucketB.map((diff) => {', 'Approve all {bucketA.length}');
    // The source badge was dropped from the row; DiffView keeps its own.
    assert.doesNotMatch(rows, /<SourceBadge/);
    // "master v{N}" was dropped from the row.
    assert.doesNotMatch(rows, /master v\{/);
    // And the queued-at formatter is gone from the page entirely.
    assert.doesNotMatch(source, /Added to queue/);
  });

  it('hands the pay-band warning to DiffView in both buckets', () => {
    // One prop per DiffView, from the same facts the row chip reads.
    const uses = source.match(/payBandWarning=\{chipFacts\.get\(diff\.applicationId\)\?\.payBand \?\? null\}/g) ?? [];
    // Bucket B and Bucket A.
    assert.equal(uses.length, 2);
  });

  it('puts Review, Preview resume and Chat with AI in one toolbar, in that order, in both buckets', () => {
    // Each bucket's row, from its map to the end of its card.
    for (const start of ['{bucketB.map((diff) => {', '{bucketA.map((diff) => {']) {
      // The toolbar alone, from its opening tag to the chip line under it.
      const tools = between(start, '</li>').split('className="queue__row-tools"')[1] ?? '';
      // The toolbar exists in this bucket's card.
      assert.ok(tools.length > 0, `${start} card has no queue__row-tools`);
      // Where each toggle's resting label sits inside it.
      // Destructured as a fixed triple so each position is a number, not number | undefined.
      const [review, preview, chat] = [tools.indexOf("'Review'"), tools.indexOf("'Preview resume'"), tools.indexOf("'Chat with AI'")] as const;
      // All three present, in that order.
      assert.ok(review >= 0 && review < preview && preview < chat, `${start} toolbar order is ${[review, preview, chat].join(',')}`);
    }
  });
});
