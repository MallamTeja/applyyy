/* The approval queue's sort, arrangement filter and search (asked for by Teja 2026-11-04).
 * Behaviour, through the pure view the page applies to the rows it already fetched. Every rule in
 * queueView.ts has a named test here; the salary and ATS tests carry the malformed-data cases,
 * because a missing number quietly becoming a rank is the bug pattern this repo keeps hitting.
 * Assertions compare the full ordered list of ids (the positive shape), never "does not contain". */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
// The coverage shape coveragePercent reads, so the helper builds a real one.
import type { KeywordCoverage } from '../src/features/approval/diffModel.ts';
// The narrow row the view reads, so test rows need no diff lines or sections.
import type { QueueViewRow } from '../src/features/approval/queueView.ts';
// The view under test, its default and the labels the page renders.
import {
  DEFAULT_QUEUE_VIEW,
  QUEUE_ARRANGEMENT_LABELS,
  QUEUE_SORT_LABELS,
  applyQueueView,
  countByArrangement,
} from '../src/features/approval/queueView.ts';

// A test row: the view's fields plus an id, so results read as a list of names.
type Row = QueueViewRow & { readonly id: string };

/* Coverage with `honest` of `total` JD keywords master-backed (and `fabricated` more supplied by
 * flagged claims). total 0 is the unmeasured case: no keywords recorded at all. */
function cov(honest: number, total: number, fabricated = 0): KeywordCoverage {
  // Distinct keyword names, so the counts are what coveragePercent divides.
  const jd = Array.from({ length: total }, (_, i) => 'kw' + i);
  // Every required field of KeywordCoverage, so coveragePercent reads a real shape.
  return {
    // The denominator.
    jdKeywords: jd,
    // The first `honest` keywords are the ones the master supports.
    honestlyMatched: jd.slice(0, honest),
    // The next `fabricated` keywords exist only because a flagged claim put them there.
    matchedByFabrication: jd.slice(honest, honest + fabricated),
    // No operator edits in these rows.
    matchedByEdit: [],
  };
}

// A row with neutral defaults; each test overrides only the fields its rule reads.
function row(id: string, over: Partial<QueueViewRow> = {}): Row {
  // Defaults that match nothing in particular, so only the overridden field decides the outcome.
  return {
    id,
    jobTitle: 'Software Engineer',
    companyName: 'Acme',
    // No locations, no arrangement, no salary: the commonest live shape.
    locations: null,
    workArrangement: 'unknown',
    salaryMin: null,
    salaryMax: null,
    // Unmeasured by default, so only the ATS tests depend on a percent.
    coverage: cov(0, 0),
    // The test's own fields win.
    ...over,
  };
}

// The ids of a result, in order: the positive shape every assertion compares against.
const ids = (rows: readonly Row[]): string[] => rows.map((r) => r.id);

describe('approval queue view', () => {
  it('the default view and the labels are exactly what the page renders', () => {
    // Newest first, every arrangement, no search: the page as it looked before this feature.
    assert.deepEqual(DEFAULT_QUEUE_VIEW, { sort: 'newest', arrangement: 'all', search: '' });
    // One label per sort option, verbatim: the UI renders these strings as-is.
    assert.deepEqual(QUEUE_SORT_LABELS, {
      newest: 'Newest first',
      oldest: 'Oldest first',
      ats: 'ATS score: highest first',
      salary: 'Salary: highest first',
    });
    // One label per arrangement option, verbatim.
    assert.deepEqual(QUEUE_ARRANGEMENT_LABELS, { all: 'All', onsite: 'Onsite only', hybrid: 'Hybrid only', remote: 'Remote only' });
  });

  it('rule 1: arrangement, then search, then sort, into a NEW array; the frozen input is never reordered', () => {
    // Frozen, so an in-place sort or reverse of the caller's array throws instead of passing.
    const rows: readonly Row[] = Object.freeze([
      // Passes both filters, lower score.
      row('stripe-remote-40', { companyName: 'Stripe', workArrangement: 'remote', coverage: cov(4, 10) }),
      // Highest score, but onsite: the arrangement filter removes it before the sort sees it.
      row('stripe-onsite-90', { companyName: 'Stripe', workArrangement: 'onsite', coverage: cov(9, 10) }),
      // Remote, but not Stripe: the search removes it.
      row('acme-remote-80', { companyName: 'Acme', workArrangement: 'remote', coverage: cov(8, 10) }),
      // Passes both filters, higher score: sorts first.
      row('stripe-remote-70', { companyName: 'Stripe', workArrangement: 'remote', coverage: cov(7, 10) }),
    ]);
    // Remote only, Stripe only, highest honest ATS first.
    const shown = applyQueueView(rows, { sort: 'ats', arrangement: 'remote', search: 'stripe' });
    // Exactly the two survivors, re-ordered by score.
    assert.deepEqual(ids(shown), ['stripe-remote-70', 'stripe-remote-40']);
    // Every sort runs on a copy: none throws on the frozen input, and none hands it back.
    for (const sort of ['newest', 'oldest', 'ats', 'salary'] as const) {
      // Unfiltered, so the only thing that could change is the order.
      const out = applyQueueView(rows, { sort, arrangement: 'all', search: '' });
      // A new array, even when nothing was filtered and the order is unchanged.
      assert.notEqual(out, rows);
      // Nothing lost: an unfiltered view still shows all four rows.
      assert.equal(out.length, 4);
    }
    // The fetched order is exactly what it was.
    assert.deepEqual(ids(rows), ['stripe-remote-40', 'stripe-onsite-90', 'acme-remote-80', 'stripe-remote-70']);
  });

  it('rule 2: "all" passes every row incl. unknown/null/undefined; the others match trimmed, lowercased values only', () => {
    // One row per spelling the column (or a malformed reader) could hand over.
    const rows = [
      // The canonical enum value.
      row('remote', { workArrangement: 'remote' }),
      // Padded and capitalised: still remote once trimmed and lowercased.
      row('remote-padded', { workArrangement: ' Remote ' }),
      // The other two real arrangements, one each.
      row('hybrid', { workArrangement: 'hybrid' }),
      row('onsite', { workArrangement: 'onsite' }),
      // The enum's fourth value: shown under All, never under a specific arrangement.
      row('unknown', { workArrangement: 'unknown' }),
      // Missing in both forms the optional field allows.
      row('null', { workArrangement: null }),
      row('undefined', { workArrangement: undefined }),
      // Upper case: still remote.
      row('REMOTE', { workArrangement: 'REMOTE' }),
      // Malformed (not a string): All still shows it; no arrangement claims it, and nothing throws.
      row('number', { workArrangement: 5 as unknown as string }),
    ];
    // All: every row, in order, including unknown, missing and malformed.
    assert.deepEqual(ids(applyQueueView(rows, { ...DEFAULT_QUEUE_VIEW, arrangement: 'all' })), ids(rows));
    // Remote: the three spellings of remote, nothing unknown.
    assert.deepEqual(ids(applyQueueView(rows, { ...DEFAULT_QUEUE_VIEW, arrangement: 'remote' })), ['remote', 'remote-padded', 'REMOTE']);
    // Hybrid: exactly its own row.
    assert.deepEqual(ids(applyQueueView(rows, { ...DEFAULT_QUEUE_VIEW, arrangement: 'hybrid' })), ['hybrid']);
    // Onsite: exactly its own row.
    assert.deepEqual(ids(applyQueueView(rows, { ...DEFAULT_QUEUE_VIEW, arrangement: 'onsite' })), ['onsite']);
  });

  it('rule 3: search needs EVERY token in title + company + locations; blank passes all; fields never run together', () => {
    // Two companies crossed with two cities, so a two-token search has exactly one right answer.
    const rows = [
      // The target of "stripe bangalore": both tokens present.
      row('stripe-bangalore', { companyName: 'Stripe', jobTitle: 'Backend Engineer', locations: ['Bangalore, India'] }),
      // Right company, wrong city.
      row('stripe-dublin', { companyName: 'Stripe', jobTitle: 'Frontend Engineer', locations: ['Dublin'] }),
      // Right city, wrong company.
      row('acme-bangalore', { companyName: 'Acme', jobTitle: 'Platform Engineer', locations: ['Bangalore'] }),
      // Title and company that would spell "database" if the haystack were glued without a space.
      row('data-base', { companyName: 'Base Inc', jobTitle: 'Data Analyst', locations: undefined }),
    ];
    // An empty search filters nothing.
    assert.deepEqual(ids(applyQueueView(rows, { ...DEFAULT_QUEUE_VIEW, search: '' })), ids(rows));
    // A whitespace-only search filters nothing either.
    assert.deepEqual(ids(applyQueueView(rows, { ...DEFAULT_QUEUE_VIEW, search: '   ' })), ids(rows));
    // Company AND location must both appear: the Stripe job in Bangalore only.
    assert.deepEqual(ids(applyQueueView(rows, { ...DEFAULT_QUEUE_VIEW, search: 'stripe bangalore' })), ['stripe-bangalore']);
    // Case and extra whitespace do not matter.
    assert.deepEqual(ids(applyQueueView(rows, { ...DEFAULT_QUEUE_VIEW, search: '  STRIPE   Bangalore ' })), ['stripe-bangalore']);
    // The title is searched too.
    assert.deepEqual(ids(applyQueueView(rows, { ...DEFAULT_QUEUE_VIEW, search: 'engineer' })), ['stripe-bangalore', 'stripe-dublin', 'acme-bangalore']);
    // A location alone finds its row.
    assert.deepEqual(ids(applyQueueView(rows, { ...DEFAULT_QUEUE_VIEW, search: 'dublin' })), ['stripe-dublin']);
    // "Data" + "Base Inc" is not "database": fields are separated, so no match across a boundary.
    assert.deepEqual(ids(applyQueueView(rows, { ...DEFAULT_QUEUE_VIEW, search: 'database' })), []);
  });

  it('rule 4: ATS sorts by HONEST coverage, highest first; unmeasured last, never as 0 or top; ties keep input order', () => {
    // Out of order on purpose, with ties, a real 0%, two unmeasured rows and one fabrication-inflated row.
    const rows = [
      // 40%, first of a tie.
      row('forty-a', { coverage: cov(4, 10) }),
      // No JD keywords recorded: unmeasured, so it goes below every measured row.
      row('unmeasured-a', { coverage: cov(0, 0) }),
      // The top score, placed third so the sort has to move it.
      row('ninety', { coverage: cov(9, 10) }),
      // Same score as forty-a: stays after it.
      row('forty-b', { coverage: cov(4, 10) }),
      // Second unmeasured row: stays after the first.
      row('unmeasured-b', { coverage: cov(0, 0) }),
      // A measured 0% is a real score: above unmeasured, below every higher score.
      row('zero', { coverage: cov(0, 10) }),
      // Honest 20%, but 80% once flagged claims count: ranked on the honest 20.
      row('honest-twenty', { coverage: cov(2, 10, 6) }),
      // 50%: between ninety and the forties.
      row('fifty', { coverage: cov(5, 10) }),
    ];
    // Highest honest first, ties in input order, unmeasured at the bottom in input order.
    const expected = ['ninety', 'fifty', 'forty-a', 'forty-b', 'honest-twenty', 'zero', 'unmeasured-a', 'unmeasured-b'];
    // The whole ordered list, so a misplaced row anywhere fails.
    assert.deepEqual(ids(applyQueueView(rows, { ...DEFAULT_QUEUE_VIEW, sort: 'ats' })), expected);
  });

  it('rule 5: salary sorts by max, else min, highest first; null/NaN/0/negative/Infinity/non-number are never an amount and go last', () => {
    // Every way a salary field can be present but not a real amount, mixed with real ones.
    const rows = [
      // Both ends valid: ranked by the max.
      row('max-200k', { salaryMax: 200000, salaryMin: 150000 }),
      // Only a floor: ranked by the min.
      row('min-only-150k', { salaryMin: 150000 }),
      // A NaN max falls back to the valid min.
      row('nan-max-min-120k', { salaryMax: Number.NaN, salaryMin: 120000 }),
      // Zero is "no amount", not the lowest amount.
      row('zeros', { salaryMax: 0, salaryMin: 0 }),
      // A string that looks like money is malformed: a lenient reader would rank it top at 300000.
      row('string-max', { salaryMax: '300000' as unknown as number }),
      // Infinity is not a salary; finite-only.
      row('infinite-max', { salaryMax: Number.POSITIVE_INFINITY }),
      // A negative figure is not a salary either.
      row('negative-max', { salaryMax: -5 }),
      // Same amount as max-200k: stays after it.
      row('max-200k-b', { salaryMax: 200000 }),
      // Neither field set: the commonest live shape (108 of 112 rows on 2026-11-04).
      row('no-salary', {}),
      // A zero max with a real min uses the min: the max is invalid, not the floor.
      row('zero-max-min-100k', { salaryMax: 0, salaryMin: 100000 }),
    ];
    // Real amounts high to low (ties in input order), then every no-amount row in arrival order.
    const expected = [
      'max-200k',
      'max-200k-b',
      'min-only-150k',
      'nan-max-min-120k',
      'zero-max-min-100k',
      'zeros',
      'string-max',
      'infinite-max',
      'negative-max',
      'no-salary',
    ];
    // The whole ordered list, so a malformed value ranked anywhere above last fails.
    assert.deepEqual(ids(applyQueueView(rows, { ...DEFAULT_QUEUE_VIEW, sort: 'salary' })), expected);
  });

  it('rule 6: newest keeps the fetched order; oldest reverses it, after the filter', () => {
    // The page hands rows over newest-in-review first (queueOrder.ts), so input order IS newest.
    const rows = [
      // Arrived in review most recently.
      row('newest', { workArrangement: 'remote' }),
      // Onsite, so the remote filter below drops it.
      row('middle', { workArrangement: 'onsite' }),
      // Arrived in review first.
      row('oldest', { workArrangement: 'remote' }),
    ];
    // Newest: exactly the fetched order.
    assert.deepEqual(ids(applyQueueView(rows, { ...DEFAULT_QUEUE_VIEW, sort: 'newest' })), ['newest', 'middle', 'oldest']);
    // Oldest: the fetched order reversed.
    assert.deepEqual(ids(applyQueueView(rows, { ...DEFAULT_QUEUE_VIEW, sort: 'oldest' })), ['oldest', 'middle', 'newest']);
    // Reversed within the filtered rows only.
    assert.deepEqual(ids(applyQueueView(rows, { sort: 'oldest', arrangement: 'remote', search: '' })), ['oldest', 'newest']);
  });

  it('countByArrangement: "all" is every row; unknown, null and malformed count only there', () => {
    // Two remotes (one padded), one of each other real value, and three that are no arrangement.
    const rows = [
      row('a', { workArrangement: 'remote' }),
      row('b', { workArrangement: ' Remote ' }),
      row('c', { workArrangement: 'hybrid' }),
      row('d', { workArrangement: 'onsite' }),
      row('e', { workArrangement: 'unknown' }),
      row('f', { workArrangement: null }),
      row('g', { workArrangement: 7 as unknown as string }),
    ];
    // The same normalisation as the filter, so a count always equals what its option shows.
    assert.deepEqual(countByArrangement(rows), { all: 7, onsite: 1, hybrid: 1, remote: 2 });
    // An empty queue counts zero everywhere, never undefined.
    assert.deepEqual(countByArrangement([]), { all: 0, onsite: 0, hybrid: 0, remote: 0 });
  });
});
