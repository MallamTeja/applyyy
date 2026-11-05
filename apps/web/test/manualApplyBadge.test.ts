/* The Manual apply rail badge counts exactly the rows the Manual apply page lists (2026-11-05).
 *
 * WHY. 6f91221 made the page list approved rows with no kit yet ("Kit pending"), but the badge still
 * counted only the two lanes plus rows that had a kit, so it read 0 over a page of 5 Kit pending jobs.
 * The badge now takes the page's own row list (mergeManualApplyRows' output); these tests pin that the
 * count is that list's length, and that a failed page read falls back to the lane counts, never to 0. */

// The loader hook that resolves extensionless imports (manualApplyData.ts uses them); must run first.
import './support/registerTsxHooks.ts';
// Strict asserts, so a loose equality cannot pass a wrong number.
import assert from 'node:assert/strict';
// The runner; before() loads the modules once.
import { describe, it, before } from 'node:test';

// The badge arithmetic lives here.
let kitMod: typeof import('../src/features/manual-apply/applyKit.ts');
// The page's row merge lives here: the badge must count its output.
let data: typeof import('../src/features/manual-apply/manualApplyData.ts');

before(async () => {
  // Imported after the hook is registered, like the sibling manual-apply tests.
  kitMod = await import('../src/features/manual-apply/applyKit.ts');
  // The data module (imports the Supabase client, which is null without config: no network here).
  data = await import('../src/features/manual-apply/manualApplyData.ts');
});

// One row shaped as the page's read returns it; `over` sets id / status / approvedAt per case.
const row = (over: Record<string, unknown> = {}) => ({
  // A real-shaped application id.
  id: 'ba1e5d1d-84a5-4cfb-b5a6-e5a2943bf154',
  // Approved, the status the old badge missed when no kit existed.
  status: 'approved',
  // The label the page shows.
  label: 'Intermediate Backend Engineer, India at GitLab',
  // The job's own apply URL.
  applyUrl: 'https://job-boards.greenhouse.io/gitlab/jobs/8775507002',
  // updated_at as returned.
  stamp: '2026-11-05T09:10:00.123456+00:00',
  // The approve time an approved row carries.
  approvedAt: '2026-11-05T09:10:00.123456+00:00',
  // Per-case overrides.
  ...over,
});

describe('Manual apply rail badge', () => {
  it('the manual-apply badge counts an approved row with no kit', () => {
    // The 14:44 page: no lane rows, one approved row, no kit rows.
    const rows = data.mergeManualApplyRows({ lanes: [], approved: [row() as never], kitRows: [] });
    // The RPC lane counts are empty too, so only the approved row can make this 1.
    assert.equal(kitMod.manualApplyCount({}, rows), 1);
  });

  it('the badge equals the page row count for the same reads', () => {
    // A lane row, an approved row with no kit, an approved row that also has a kit, and a finished kit row.
    const lane = row({ id: '11111111-1111-4111-8111-111111111111', status: 'needs_verification', approvedAt: null });
    // Approved, no kit yet.
    const pending = row({ id: '22222222-2222-4222-8222-222222222222' });
    // Approved and kitted: arrives from two reads, must count once.
    const kitted = row({ id: '33333333-3333-4333-8333-333333333333' });
    // Applied with a kit: past the submit, the page leaves it out.
    const done = row({ id: '44444444-4444-4444-8444-444444444444', status: 'applied', approvedAt: null });
    // The page's list for these reads.
    const rows = data.mergeManualApplyRows({ lanes: [lane as never], approved: [pending as never, kitted as never], kitRows: [kitted as never, done as never] });
    // Lane counts that disagree with the rows on purpose: the page's list wins when it was read.
    const badge = kitMod.manualApplyCount({ needs_verification: 9 }, rows);
    // Same number the page lists (3), and that number is what the fixture says it should be.
    assert.deepEqual([badge, rows.length], [3, 3]);
  });

  it('a failed page read falls back to the lane counts, never to 0', () => {
    // null = the page's read failed or has not landed; the RPC still says 1 + 2 lane rows.
    assert.equal(kitMod.manualApplyCount({ needs_verification: 1, blocked_needs_human: 2 }, null), 3);
  });

  it('with neither read available the badge is 0 (hidden), not a guess', () => {
    // Both reads unavailable: nothing is known, so nothing is shown.
    assert.equal(kitMod.manualApplyCount(null, null), 0);
  });
});
