/* parseStatusCountRows: the shape check on the application_status_counts RPC (2026-10-24).
 *
 * WHY THESE CASES. The RPC replaced a browser tally that max_rows silently cut at 1,000 rows, so
 * the thing to prove is that no malformed answer can become a count: each wrong shape must come
 * back as { ok: false } with a reason, and only the exact shape becomes rows. */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

// The module under test; it imports only contract.ts, so no client or env is needed.
import { parseStatusCountRows } from '../src/data/statusCounts.ts';

describe('parseStatusCountRows', () => {
  it('accepts the exact GROUP BY shape and keeps the server counts', () => {
    // Two real statuses with their counts, as PostgREST serialises a bigint (a JSON number).
    const parsed = parseStatusCountRows([{ status: 'dropped_filter', row_count: 17733 }, { status: 'passed_filters', row_count: 2402 }]);
    // Valid input yields the same rows, unchanged.
    assert.deepEqual(parsed, { ok: true, rows: [{ status: 'dropped_filter', row_count: 17733 }, { status: 'passed_filters', row_count: 2402 }] });
  });

  it('treats an empty list as a real "no applications"', () => {
    // GROUP BY over zero rows returns zero groups; that is an answer, not a failure.
    assert.deepEqual(parseStatusCountRows([]), { ok: true, rows: [] });
  });

  it('refuses null, which is no answer rather than an empty one', () => {
    // Null data with no error must not read as "none".
    assert.equal(parseStatusCountRows(null).ok, false);
  });

  it('refuses a row that is not an object', () => {
    // A bare string is not a {status, row_count} row.
    assert.equal(parseStatusCountRows(['passed_filters']).ok, false);
  });

  it('refuses a status the app does not know', () => {
    // A new enum value needs a contract update before the page can show it.
    assert.equal(parseStatusCountRows([{ status: 'teleported', row_count: 1 }]).ok, false);
  });

  it('refuses a count that is not a non-negative integer', () => {
    // A string, as a lenient parser would coerce.
    assert.equal(parseStatusCountRows([{ status: 'scored', row_count: '5' }]).ok, false);
    // A negative count is impossible from count(*).
    assert.equal(parseStatusCountRows([{ status: 'scored', row_count: -1 }]).ok, false);
    // A fraction is not a row count.
    assert.equal(parseStatusCountRows([{ status: 'scored', row_count: 1.5 }]).ok, false);
    // A missing count must not default to zero.
    assert.equal(parseStatusCountRows([{ status: 'scored' }]).ok, false);
  });

  it('refuses a status that appears twice', () => {
    // GROUP BY emits each status once; a repeat means this is not its output.
    assert.equal(parseStatusCountRows([{ status: 'scored', row_count: 1 }, { status: 'scored', row_count: 2 }]).ok, false);
  });
});
