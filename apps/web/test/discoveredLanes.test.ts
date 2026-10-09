/* Discovered jobs page: the pure list logic behind the lane switch, the sort, Load more and the
 * honest counters (discoveredList.ts).
 *
 * WHY A PURE MODULE: apps/web has no DOM renderer, and the page imports supabase.ts. Everything that
 * decides WHAT the page says or WHICH agents a card sends lives in discoveredList.ts so it can be
 * asserted here by value, not by grepping JSX. The page-source shape tests stay in
 * discoveryNoFastPath.test.ts. */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

// The module under test, imported directly: it has no supabase or React import.
import {
  LANES,
  PAGE_SIZE,
  appendUnique,
  hasMoreRows,
  isCurrentLane,
  keysetFilter,
  loadedOfText,
  pageLimit,
  postedDate,
  sortItems,
} from '../src/features/discovery/discoveredList.ts';
// The engine's real step lists, so the mapping is compared against the source of truth, not a copy.
import { DISCOVERED_STEPS, PASSED_FILTERS_STEPS } from '../src/features/pipeline/rowPipeline.ts';

// A minimal row: only the fields the sort and the date marker read, plus an id for appendUnique.
const row = (id: string, title: string, company: string, postedAt: string, source: 'exact' | 'derived' | 'unknown' = 'exact') => ({
  // The page's own item shape: an application id beside the joined job.
  applicationId: id,
  // Cast once here so each test case stays one line; the helpers only read these four fields.
  job: { id, title, company_name: company, posted_at: postedAt, posted_at_source: source } as never,
});

describe('lane -> status and pipeline steps', () => {
  it('discovered lane queries discovered and sends the five-agent chain', () => {
    // The lane the page always had; its status must not change.
    assert.equal(LANES.discovered.status, 'discovered');
    // A discovered row needs dedupe and screening before the matcher.
    assert.deepEqual(LANES.discovered.steps, DISCOVERED_STEPS);
  });

  it('ready lane queries passed_filters and sends PASSED_FILTERS_STEPS', () => {
    // "Ready to tailor" is the screener's output status.
    assert.equal(LANES.ready.status, 'passed_filters');
    // The screener already ran; sending these through the normalizer would no_progress at step 1.
    assert.deepEqual(LANES.ready.steps, PASSED_FILTERS_STEPS);
  });
});

describe('lane switch race', () => {
  it('a settle from lane X never writes lane Y\'s list', () => {
    // A Send clicked on the ready lane settles after the operator switched to discovered: its reload
    // was built for passed_filters, so it must be refused before it claims a load sequence.
    assert.equal(isCurrentLane('ready', 'discovered'), false);
    // The mirror case.
    assert.equal(isCurrentLane('discovered', 'ready'), false);
    // A reload for the lane on screen proceeds.
    assert.equal(isCurrentLane('ready', 'ready'), true);
  });
});

describe('honest counters', () => {
  it('counter says "N loaded of M" when the total is known', () => {
    // The exact text the page renders beside every count.
    assert.equal(loadedOfText(300, 6661), '300 loaded of 6661');
  });

  it('counter says the total is unknown when the count query failed', () => {
    // Never falls back to the loaded length as if it were the total.
    assert.equal(loadedOfText(300, null), '300 loaded (total unknown)');
  });

  it('Load more shows only while rows remain', () => {
    // Rows remain: the button shows.
    assert.equal(hasMoreRows(300, 6661), true);
    // Everything loaded: the button hides.
    assert.equal(hasMoreRows(6661, 6661), false);
    // Unknown total: no claim of more rows.
    assert.equal(hasMoreRows(300, null), false);
  });
});

describe('paging', () => {
  it('full and more fetch one page, silent re-reads the loaded window', () => {
    // A full load (first visit, lane switch) is one page.
    assert.equal(pageLimit('full', 600), PAGE_SIZE);
    // Load more is one page past the cursor.
    assert.equal(pageLimit('more', 300), PAGE_SIZE);
    // A silent reload after a send re-reads what is on screen, so Load more's pages do not vanish.
    assert.equal(pageLimit('silent', 600), 600);
    // A silent reload with fewer than a page still asks for a full page.
    assert.equal(pageLimit('silent', 10), PAGE_SIZE);
  });

  it('keyset cursor continues after the last row of (created_at desc, id asc)', () => {
    // The last loaded row's sort key.
    const f = keysetFilter({ createdAt: '2026-10-01T12:00:00.123+00:00', id: '0b6f4f2e-1c2d-4e5f-8a9b-0c1d2e3f4a5b' });
    // Older rows, or the same instant with a LARGER id: the exact mirror of .order(created_at desc).order(id asc).
    // Values quoted because a timestamp holds '.', ':' and '+', which PostgREST's logic-tree grammar reserves.
    assert.equal(f, 'created_at.lt."2026-10-01T12:00:00.123+00:00",and(created_at.eq."2026-10-01T12:00:00.123+00:00",id.gt.0b6f4f2e-1c2d-4e5f-8a9b-0c1d2e3f4a5b)');
  });

  it('keyset cursor refuses a malformed key instead of building a filter from it', () => {
    // A non-timestamp would be interpolated into the query; validate the shape, return null.
    assert.equal(keysetFilter({ createdAt: '-5', id: '0b6f4f2e-1c2d-4e5f-8a9b-0c1d2e3f4a5b' }), null);
    // A non-uuid id, including one carrying filter syntax, is refused the same way.
    assert.equal(keysetFilter({ createdAt: '2026-10-01T12:00:00+00:00', id: 'x),status.eq.applied' }), null);
  });

  it('appendUnique drops a row the next page repeats', () => {
    // Offset paging shifts when new rows arrive on top, so page 2 can repeat page 1's tail.
    const merged = appendUnique([row('a', 't', 'c', '2026-10-01T00:00:00+00:00')], [row('a', 't', 'c', '2026-10-01T00:00:00+00:00'), row('b', 't', 'c', '2026-10-01T00:00:00+00:00')]);
    // One "a", then the new "b", in order.
    assert.deepEqual(merged.map((r) => r.applicationId), ['a', 'b']);
  });
});

describe('sort', () => {
  // Server order (created_at desc) is the input order for every case.
  const items = [
    row('1', 'zeta engineer', 'beta', '2026-09-01T00:00:00+00:00'),
    row('2', 'Alpha engineer', 'Alpha', '2026-10-05T00:00:00+00:00'),
    row('3', 'mid engineer', 'alpha', 'not-a-date'),
  ];

  it('newest found keeps the server order', () => {
    // created_at desc is applied by the query, so the client must not reorder.
    assert.deepEqual(sortItems(items, 'newest').map((r) => r.applicationId), ['1', '2', '3']);
  });

  it('posted date sorts newest first and puts an unreadable date last', () => {
    // A malformed date must not parse into a position; it goes last.
    assert.deepEqual(sortItems(items, 'posted').map((r) => r.applicationId), ['2', '1', '3']);
  });

  it('company and title sort A-Z ignoring case', () => {
    // alpha/Alpha tie on company, so the title breaks the tie.
    assert.deepEqual(sortItems(items, 'company').map((r) => r.applicationId), ['2', '3', '1']);
    // Case-insensitive title order.
    assert.deepEqual(sortItems(items, 'title').map((r) => r.applicationId), ['2', '3', '1']);
  });

  it('sort never mutates its input', () => {
    // The page's items state is read-only; an in-place sort would corrupt it.
    sortItems(items, 'title');
    // Still in server order.
    assert.deepEqual(items.map((r) => r.applicationId), ['1', '2', '3']);
  });
});

describe('posted date marker', () => {
  it('exact date has no marker', () => {
    // A board-reported date is shown as is.
    const d = postedDate(row('1', 't', 'c', '2026-10-01T12:00:00+00:00', 'exact').job);
    // Plain date, not approximate.
    assert.equal(d.text, 'Posted 2026-10-01');
    // Flag drives nothing else, but must agree with the text.
    assert.equal(d.approximate, false);
  });

  it('derived date carries "≈" and a tooltip saying why', () => {
    // A derived date is when applyyy first saw the posting.
    const d = postedDate(row('1', 't', 'c', '2026-10-01T12:00:00+00:00', 'derived').job);
    // The marker the operator sees.
    assert.equal(d.text, 'Posted ≈ 2026-10-01');
    // The tooltip names what the date really is.
    assert.match(d.title, /first saw/);
  });

  it('a malformed posted_at is stated, never parsed into a date', () => {
    // Validate the shape; never let a lenient parser turn garbage into a day.
    assert.equal(postedDate(row('1', 't', 'c', '-5').job).text, 'Posted date unknown');
  });
});
