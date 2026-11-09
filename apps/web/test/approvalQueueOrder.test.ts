/* The approval queue lists the row that most recently entered review FIRST (2026-10-24).
 * Behaviour, through the pure order the page applies, plus one shape check that the page applies it. */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
// The order the page applies to the fetched rows.
import { newestInReviewFirst } from '../src/features/approval/queueOrder.ts';

// The page's source, for the one wiring check.
const page = readFileSync(new URL('../src/features/approval/ApprovalQueuePage.tsx', import.meta.url), 'utf8');
// The queue's first read, moved here on 2026-11-09 (shared with the shell-side prefetch); its order lives in it.
const queueRead = readFileSync(new URL('../src/features/approval/queuePrefetch.ts', import.meta.url), 'utf8');

describe('approval queue order', () => {
  it('given rows with three different review-entry times, the newest renders first', () => {
    // Fetched oldest-first, the way the old created_at order could hand them over.
    const rows = [
      { id: 'aiven', status_changed_at: '2026-10-24T05:22:01.105634+00:00' },
      { id: 'axiad', status_changed_at: '2026-10-24T08:10:00+00:00' },
      { id: 'bjak', status_changed_at: '2026-10-24T07:11:55.96+00:00' },
    ];
    // Newest entry into review on top.
    assert.deepEqual(newestInReviewFirst(rows).map((row) => row.id), ['axiad', 'bjak', 'aiven']);
    // The fetched array itself is left alone.
    assert.equal(rows[0]!.id, 'aiven');
  });

  it('ties break by id, and an unreadable stamp sorts last instead of claiming to be newest', () => {
    const rows = [
      // A lenient parser would read "-5" as year -5; shape-checked, it is simply unreadable.
      { id: 'c', status_changed_at: '-5' },
      { id: 'b', status_changed_at: '2026-10-24T08:00:00+00:00' },
      { id: 'a', status_changed_at: '2026-10-24T08:00:00+00:00' },
      { id: 'd', status_changed_at: null },
    ];
    assert.deepEqual(newestInReviewFirst(rows).map((row) => row.id), ['a', 'b', 'c', 'd']);
  });

  it('the page orders the query and the rows by entry into review, not by discovery date', () => {
    // The database order uses the same key (index-backed: user_id, status, status_changed_at desc).
    // The query moved to queuePrefetch.ts on 2026-11-09 (shared with the shell-side prefetch).
    assert.match(queueRead, /\.order\('status_changed_at', \{ ascending: false \}\)/);
    // The created_at order (discovery date) is gone from the query.
    assert.doesNotMatch(queueRead, /\.order\('created_at'/);
    // Nor in the page, should a second read ever be added back there.
    assert.doesNotMatch(page, /\.order\('created_at'/);
    // Every fetched row goes through the pure order before the queue is built.
    assert.match(page, /for \(const app of newestInReviewFirst\(data\)\)/);
  });
});
