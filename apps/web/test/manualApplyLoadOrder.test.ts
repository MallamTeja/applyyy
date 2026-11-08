/* loadManualApply's read ORDER, against a recording fake client (2026-11-08).
 *
 * WHY. The badge (every cold load, every data move) and the Manual apply page both run loadManualApply.
 * It used to wait for the kit events before starting ANY applications read, though only the kit-row read
 * needs the kit ids: three serial round trips (~0.3 s each from India to the Sydney project) where two
 * suffice. These tests pin the two-round order, that the answer is unchanged, and that a failed read still
 * fails the whole load (a partial badge would be a made-up number).
 *
 * RED-ON-REVERT: moving the status reads back behind the kit events fails test 1 at the overlap assert. */

// The loader hook that resolves extensionless imports (manualApplyData.ts uses them); must run first.
import './support/registerTsxHooks.ts';
// Strict asserts.
import assert from 'node:assert/strict';
// The runner; before() loads the module once.
import { describe, it, before } from 'node:test';
// Type only: the client the loader takes.
import type { SupabaseClient } from '@supabase/supabase-js';

// The module under test.
let data: typeof import('../src/features/manual-apply/manualApplyData.ts');

before(async () => {
  // Imported after the hook is registered, like the sibling manual-apply tests.
  data = await import('../src/features/manual-apply/manualApplyData.ts');
});

// The row that has a kit: approved, so its kit is open.
const KIT_ID = 'c0ffee00-0000-4000-8000-000000000001';
// A lane row, parked by the guard.
const LANE_ID = 'c0ffee00-0000-4000-8000-000000000002';

// One application row as PostgREST returns the badge select.
const appRow = (id: string, status: string) => ({ id, status, updated_at: '2026-11-08T10:00:00+00:00', status_changed_at: '2026-11-08T10:00:00+00:00', jobs: { title: 'Engineer', company_name: 'Example', apply_url: 'https://example.test/jobs/1' } });

// The kit note for KIT_ID (applyKit.ts v1 contract, the shape the e2e tests use).
const KIT_EVENT = { application_id: KIT_ID, created_at: '2026-11-08T10:00:00+00:00', detail: { kind: 'apply_kit', v: 1, generated_at: '2026-11-08T10:00:00Z', run_id: 'run-order', form_url: 'https://example.test/jobs/1', resume: null, fields: [], warnings: [] } };

/* A fake supabase-js client: every query is a chainable builder whose request "starts" when awaited (as
   the real one sends on then()) and answers after 20 ms. Each start and end is logged by a name. */
function fakeClient(failName?: string) {
  // The ordered start/end log the assertions read.
  const log: string[] = [];
  // The client: only from() is used by the loader.
  const client = {
    // One builder per query.
    from(table: string) {
      // Filled by in(): which read this is.
      let name = table;
      // The chain the loader calls; each returns the builder.
      const builder = {
        // The column list; irrelevant to the order.
        select: () => builder,
        // The kit read's event_type filter.
        eq: () => builder,
        // Names the read by its filter: status lanes, approved, ids, or the kit kinds.
        in: (column: string, values: string[]) => { name = column === 'status' ? `status:${values.join('+')}` : column === 'id' ? 'ids' : table; return builder; },
        // Ordering; irrelevant here.
        order: () => builder,
        // The cap; irrelevant here.
        limit: () => builder,
        // Awaiting sends the request: log its start, answer later, log its end.
        then(resolve: (v: { data: unknown; error: { message: string } | null }) => void) {
          // The request starts now.
          log.push(`start ${name}`);
          // Answered after a round trip, so overlap is observable.
          setTimeout(() => {
            // The request ends.
            log.push(`end ${name}`);
            // A named failure returns { error }, as supabase-js does (it never throws on a 4xx).
            if (name === failName) return resolve({ data: null, error: { message: `${name} failed` } });
            // Each read's canned answer.
            const body = name === 'application_events' ? [KIT_EVENT] : name === 'status:approved' ? [appRow(KIT_ID, 'approved')] : name === 'ids' ? [appRow(KIT_ID, 'approved')] : [appRow(LANE_ID, 'blocked_needs_human')];
            // A successful read.
            resolve({ data: body, error: null });
          }, 20);
        },
      };
      // The chain starts here.
      return builder;
    },
  };
  // The cast is the seam: the loader only calls what the fake implements.
  return { client: client as unknown as SupabaseClient, log };
}

describe('loadManualApply read order', () => {
  it('the badge starts its status reads in parallel with the kit events', async () => {
    // A recording client.
    const { client, log } = fakeClient();
    // The badge's read.
    const result = await data.loadManualApply('badge', client);
    // Where the kit events read ended.
    const kitsEnd = log.indexOf('end application_events');
    // Both status reads started BEFORE the kit events answered: the round trip this change removed.
    assert.ok(log.indexOf('start status:needs_verification+blocked_needs_human') < kitsEnd, `lanes waited for the kits: ${log.join(', ')}`);
    // Same for the approved read.
    assert.ok(log.indexOf('start status:approved') < kitsEnd, `approved waited for the kits: ${log.join(', ')}`);
    // The kit-row read still needs the ids, so it starts only after the kits landed.
    assert.ok(log.indexOf('start ids') > kitsEnd, `kit rows started before the kit ids were known: ${log.join(', ')}`);
    // Not a failure.
    assert.ok(!('error' in result), 'load failed');
    // Same answer as before: lanes first, then the approved/kit row once (deduped by id).
    assert.deepEqual(result.rows.map((r) => r.id), [LANE_ID, KIT_ID]);
  });

  it('a failed status read still fails the whole load, and skips the kit-row read', async () => {
    // The approved read fails.
    const { client, log } = fakeClient('status:approved');
    // The badge's read.
    const result = await data.loadManualApply('badge', client);
    // The whole load reports it: never a partial row list.
    assert.deepEqual(result, { error: 'status:approved failed' });
    // No third round trip for a load that already failed.
    assert.equal(log.includes('start ids'), false);
  });

  it('a failed kit events read fails the whole load', async () => {
    // The kit read fails.
    const { client } = fakeClient('application_events');
    // The page's read.
    const result = await data.loadManualApply('page', client);
    // Said, not shown as "no kits".
    assert.deepEqual(result, { error: 'application_events failed' });
  });
});
