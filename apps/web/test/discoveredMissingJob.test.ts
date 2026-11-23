/* DiscoveredJobsPage: a row whose job embed is null is COUNTED, never silently dropped (bug 24, 2026-11-21).
 *
 * WHY. The page kept only rows with a job (`if (app.job)`), so an application whose job record could not be read
 * vanished from the list with no trace. mapDiscoveredRows now returns the drawable cards AND the count of rows it
 * could not draw, which the page shows above the grid. Live on 2026-11-21 no row hit this (job_id NOT NULL + FK ON
 * DELETE CASCADE), so this guards an RLS or embed failure.
 *
 * RED-ON-REVERT: making mapDiscoveredRows skip without counting (the old shape) fails the "counts" test at 0 !== 2. */

// The .tsx loader; must be the first import so it runs first.
import './support/registerTsxHooks.ts';
// Strict asserts, like the other web tests.
import assert from 'node:assert/strict';
// node:test, the web suite's runner.
import { before, describe, it } from 'node:test';
// The list row type the select returns.
import type { DiscoveredListRow } from '../src/features/discovery/discoveredList.ts';

// The pure mapper under test, loaded after the hook is in place.
let mapDiscoveredRows: typeof import('../src/features/discovery/DiscoveredJobsPage.tsx').mapDiscoveredRows;
before(async () => {
  // Transpiled by the hook.
  ({ mapDiscoveredRows } = await import('../src/features/discovery/DiscoveredJobsPage.tsx'));
});

// A list row; the job is a placeholder object (the mapper only checks it is there and passes it through).
const row = (id: string, job: unknown): DiscoveredListRow => ({ id, created_at: '2026-11-21T10:00:00Z', job } as unknown as DiscoveredListRow);

describe('mapDiscoveredRows: missing job records are counted (bug 24)', () => {
  it('counts rows whose job embed is null and keeps the rest as cards, in order', () => {
    // Two drawable rows around two with no job.
    const { items, missingJob } = mapDiscoveredRows([row('a1', { title: 'A' }), row('a2', null), row('a3', { title: 'C' }), row('a4', undefined)]);
    // The drawable ones, in the order read.
    assert.deepEqual(items.map((i) => i.applicationId), ['a1', 'a3']);
    // The two missing ones are counted, not lost.
    assert.equal(missingJob, 2);
  });

  it('an empty list is a real "nothing discovered": no items, nothing missing', () => {
    // Nothing in, nothing out.
    assert.deepEqual(mapDiscoveredRows([]), { items: [], missingJob: 0 });
  });
});
