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
  DISCOVERED_JOB_COLUMNS,
  DISCOVERED_LIST_SELECT,
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
  emptyListMessage,
  OPENING_LANE,
  laneCountsFrom,
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

describe('the narrowed list select (2026-10-24)', () => {
  it('names exactly the job columns the page reads, and no others', () => {
    // A closed list compared by value: adding raw_payload back, or dropping a column the cascade
    // reads, both turn this red. The type DiscoveredJob is derived from the same tuple, so tsc
    // separately refuses any page code that reads a column missing from it.
    assert.deepEqual([...DISCOVERED_JOB_COLUMNS], [
      'id', 'title', 'company_name', 'location_raw', 'locations', 'work_arrangement', 'employment_type',
      'description_preview', 'description_requires_degree', 'apply_url', 'ats_provider', 'discovered_via', 'source_refs', 'posted_at',
      'posted_at_source', 'min_experience_years', 'requires_advanced_degree', 'salary_min', 'salary_max',
      'salary_currency', 'disappeared_at',
    ]);
  });

  it('builds the PostgREST select from that tuple, with the application keys first', () => {
    // The exact string sent to PostgREST: id and status for the card, created_at for the keyset cursor.
    assert.equal(
      DISCOVERED_LIST_SELECT,
      'id, status, created_at, job:job_id(id, title, company_name, location_raw, locations, work_arrangement, employment_type, description_preview, description_requires_degree, apply_url, ats_provider, discovered_via, source_refs, posted_at, posted_at_source, min_experience_years, requires_advanced_degree, salary_min, salary_max, salary_currency, disappeared_at)',
    );
  });
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
  // A pinned "now" so every relative phrase is asserted at an exact instant.
  const NOW = Date.parse('2026-10-18T12:00:00+00:00');

  it('exact date reads relative, with the absolute day in the tooltip', () => {
    // A board-reported date 17 days before the pinned now.
    const d = postedDate(row('1', 't', 'c', '2026-10-01T12:00:00+00:00', 'exact').job, NOW);
    // Relative phrasing is what Teja asked to see on the card.
    assert.equal(d.text, 'Posted 17 days ago');
    // Precision is hovered, never lost: the tooltip leads with the absolute day.
    assert.match(d.title, /^2026-10-01 — Publish date reported/);
    // Flag drives nothing else, but must agree with the text.
    assert.equal(d.approximate, false);
  });

  it('derived date carries "≈" and a tooltip saying why', () => {
    // A derived date is when applyyy first saw the posting.
    const d = postedDate(row('1', 't', 'c', '2026-10-01T12:00:00+00:00', 'derived').job, NOW);
    // The "≈" survives the relative form: the age is as approximate as its source date.
    assert.equal(d.text, 'Posted ≈ 17 days ago');
    // The tooltip names what the date really is, after the absolute day.
    assert.match(d.title, /first saw/);
    assert.match(d.title, /^2026-10-01 — /);
  });

  it('REGRESSION: unit boundaries — minutes under an hour, hours under a day, days under 30, then months', () => {
    // One helper call per band, each at an exact distance from the pinned now.
    const at = (iso: string) => postedDate(row('1', 't', 'c', iso, 'exact').job, NOW).text;
    // 59 minutes stays in minutes.
    assert.equal(at('2026-10-18T11:01:00+00:00'), 'Posted 59 minutes ago');
    // 5 hours reads in hours.
    assert.equal(at('2026-10-18T07:00:00+00:00'), 'Posted 5 hours ago');
    // 29 days stays in days.
    assert.equal(at('2026-09-19T12:00:00+00:00'), 'Posted 29 days ago');
    // 65 days rolls into months (30-day months, floor'd).
    assert.equal(at('2026-08-14T12:00:00+00:00'), 'Posted 2 months ago');
    // Under a minute — including small clock skew — reads "just now", never "0 minutes ago".
    assert.equal(at('2026-10-18T11:59:40+00:00'), 'Posted just now');
  });

  it('a malformed posted_at is stated, never parsed into a date', () => {
    // Validate the shape; never let a lenient parser turn garbage into a day.
    assert.equal(postedDate(row('1', 't', 'c', '-5').job).text, 'Posted date unknown');
  });

  it('REGRESSION: a digit-shaped non-date falls back to the absolute day, never "55 years ago"', () => {
    // 2026-13-99 passes the ISO_DATE shape regex but Date.parse refuses it (NaN) —
    // the CLAUDE.md §6 trap: a lenient parse must not become a relative age.
    const d = postedDate(row('1', 't', 'c', '2026-13-99T00:00:00+00:00', 'derived').job, NOW);
    // Falls back to exactly what the pill showed before this feature.
    assert.equal(d.text, 'Posted ≈ 2026-13-99');
    // No relative phrase, so the tooltip carries no absolute-day prefix either.
    assert.match(d.title, /^Approximate:/);
  });

  it('a posted_at more than a day in the future is bad data: absolute day, no relative phrase', () => {
    // Ten days "in the future" cannot be clock skew; refuse the phrase, keep the day.
    const d = postedDate(row('1', 't', 'c', '2026-10-28T12:00:00+00:00', 'exact').job, NOW);
    assert.equal(d.text, 'Posted 2026-10-28');
  });
});

/* The empty-list sentence (2026-10-24). After the prescreen drain, `discovered` held 0 rows and the
 * page told Teja "No jobs match your active Tech constraint and Filter Cascade rules": it blamed his
 * filters for a lane that was empty because every row had been screened. The sentence must be chosen
 * from the EXACT lane count, never from the filtered length alone. */
describe('empty list message', () => {
  // Each case names its cause; the twin proves the filter sentence still fires when it is true.
  it('an empty discovered lane with a known count of 0 says every row was screened, not that filters hid it', () => {
    // The live case: the count query answered 0 for `discovered`.
    const message = emptyListMessage('discovered', 'matched', 0);
    // Positive shape: the cause, and where the passed rows went.
    assert.match(message, /already been through the screener/);
    // Names the lane the passed rows moved to, so the operator knows where to look.
    assert.match(message, /Ready to tailor/);
    // And never the filter-blame sentence, which is the bug.
    assert.doesNotMatch(message, /Filter Cascade rules/);
  });

  it('TWIN: rows exist but every loaded one was filtered out locally, so the filters ARE the cause', () => {
    // 300 rows at `discovered`, none matching: blaming the filters is now correct.
    assert.match(emptyListMessage('discovered', 'matched', 300), /Tech constraint and Filter Cascade rules/);
  });

  it('a failed count never claims the lane is empty', () => {
    // null is "unknown": the sentence may not assert that everything was screened.
    assert.doesNotMatch(emptyListMessage('discovered', 'matched', null), /already been through the screener/);
  });

  it('an empty ready lane says nothing has passed the screener yet, in its own words', () => {
    // The ready lane at 0 rows: a different cause, a different sentence.
    assert.match(emptyListMessage('ready', 'all', 0), /Nothing is ready to tailor/);
  });

  it('a non-empty lane emptied by search keeps the plain "match your current criteria" sentence', () => {
    // Search or a filter select emptied the loaded rows of a lane that has rows.
    assert.equal(emptyListMessage('ready', 'all', 2511), 'No loaded Ready to tailor jobs match your current criteria.');
  });
});

/* Opening lane (2026-11-01, Teja: "whenever I open discovered jobs from the nav bar it needs to show
 * and stay in Ready to tailor"). Since the 2026-10-24 prescreen drain `discovered` sits near empty.
 * The 2026-10-24 rule (open on Ready only once the counts prove Discovered = 0) could settle on the
 * empty lane if the counts landed while a scout run had rows still waiting there. The opening lane
 * is now a constant that no read can change. */
describe('opening lane', () => {
  // The live shape after the prescreen drain: nothing to screen, 2,511 ready, 19,047 dropped.
  // Kept for the laneCountsFrom case below, which pins the status-to-lane mapping against it.
  const DRAINED = { discovered: 0, ready: 2511, filteredOut: 19047 };

  it('the page opens on Ready to tailor, whatever the counts say', () => {
    // A constant, so no count, race or failed read can pick another lane.
    assert.equal(OPENING_LANE, 'ready');
  });

  // The mapping is where "absent means zero" is decided, so it is pinned by value.
  it('a successful read maps absent statuses to 0 and the screener statuses to their lanes', () => {
    // `discovered` absent from a successful read means none at that status.
    assert.deepEqual(laneCountsFrom('rows', { passed_filters: 2511, dropped_filter: 19047 }), DRAINED);
  });

  it('an empty successful read is all zeroes; any other state is no answer', () => {
    // 'empty' is the one other state that proves zero.
    assert.deepEqual(laneCountsFrom('empty', {}), { discovered: 0, ready: 0, filteredOut: 0 });
    // A failed read is not evidence of zero; it must stay unknown.
    assert.equal(laneCountsFrom('failed', {}), null);
  });

  // Exact equality, not a pattern: the numbers and the lane name are the whole point of the sentence.
  it('an empty discovered lane with counts names where every row went, with the numbers', () => {
    // The sentence Teja asked for, built from the live counts.
    assert.equal(
      emptyListMessage('discovered', 'matched', 0, DRAINED),
      'Every discovered job has been screened: 2,511 are in "Ready to tailor", 19,047 filtered out.',
    );
  });
});
