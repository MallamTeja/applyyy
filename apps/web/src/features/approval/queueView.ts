/* The approval queue's sort, arrangement filter and search (asked for by Teja 2026-11-04: sort by
 * newest, oldest, ATS score or salary; show only onsite, hybrid or remote jobs; search by company,
 * title or place).
 *
 * WHY A PURE MODULE AND NOT STATE IN THE PAGE. The page already fetches every queued row and orders
 * it newest-in-review first (queueOrder.ts), so the view is a function of (rows, choices) and needs
 * no new query. Kept pure so every rule has a named test, and so the page and the arrangement
 * counts read the SAME normalisation and can never disagree about what "remote" means.
 *
 * WHY THE RANKS GO THROUGH SHAPE CHECKS. Missing data quietly becoming an answer is the bug this
 * repo keeps hitting: an unmeasured coverage ranked as 0%, a null salary ranked as $0, a string
 * "300000" ranked by coercion. A row without a real value is placed LAST, never given one. */

// The badge's own figure, so "ATS score" sorts by exactly the number the row shows.
import { coveragePercent } from './diffModel.ts';
// The queue row the page renders; the view reads only a few of its fields.
import type { ResumeDiff } from './diffModel.ts';

/* The sort choices. 'newest' and 'oldest' need no timestamp: the rows arrive newest first. */
export type QueueSort = 'newest' | 'oldest' | 'ats' | 'salary';
/* The arrangement choices: the work_arrangement enum (20260909234500_enums.sql) minus 'unknown',
 * which only 'all' shows, plus 'all'. */
export type QueueArrangement = 'all' | 'onsite' | 'hybrid' | 'remote';

/* Everything the operator chose, as one value the page holds in state. */
export interface QueueView {
  // How the shown rows are ordered.
  readonly sort: QueueSort;
  // Which work arrangement is shown.
  readonly arrangement: QueueArrangement;
  // Free text matched against title, company and locations.
  readonly search: string;
}

/* The page as it looked before this feature: newest first, nothing hidden. */
export const DEFAULT_QUEUE_VIEW: QueueView = { sort: 'newest', arrangement: 'all', search: '' };

/* The sort options' visible text; a Record so a new sort without a label fails to compile. */
export const QUEUE_SORT_LABELS: Readonly<Record<QueueSort, string>> = {
  // The fetched order, unchanged.
  newest: 'Newest first',
  // The fetched order, reversed.
  oldest: 'Oldest first',
  // The honest coverage percent the "ATS Match Score" badge shows.
  ats: 'ATS score: highest first',
  // The posted salary, top of range first.
  salary: 'Salary: highest first',
};

/* The arrangement options' visible text; a Record for the same compile-time completeness. */
export const QUEUE_ARRANGEMENT_LABELS: Readonly<Record<QueueArrangement, string>> = {
  // No filter: includes rows whose arrangement is unknown.
  all: 'All',
  // Exactly the rows whose arrangement says so.
  onsite: 'Onsite only',
  hybrid: 'Hybrid only',
  remote: 'Remote only',
};

/* The fields the view reads; narrower than ResumeDiff so tests build rows without diff lines. */
export type QueueViewRow = Pick<
  ResumeDiff,
  'jobTitle' | 'companyName' | 'locations' | 'workArrangement' | 'salaryMin' | 'salaryMax' | 'coverage'
>;

/* A row's arrangement, trimmed and lowercased; anything that is not a string reads as none. */
function arrangementOf(row: QueueViewRow): string | undefined {
  // Shape first: a non-string would throw on .trim(), and it is no arrangement anyway.
  return typeof row.workArrangement === 'string' ? row.workArrangement.trim().toLowerCase() : undefined;
}

/* Title, company and every location as one lowercased string the search tokens are found in. */
function haystack(row: QueueViewRow): string {
  // A null or malformed locations field contributes nothing rather than throwing on the spread.
  const places = Array.isArray(row.locations) ? row.locations : [];
  return (
    [row.jobTitle, row.companyName, ...places]
      // Only strings are searchable; a stray null or object never becomes "null" or "[object Object]".
      .filter((part) => typeof part === 'string')
      // A space between fields, so "Data" + "Base Inc" can never match the token "database".
      .join(' ')
      // Case never matters.
      .toLowerCase()
  );
}

/* The honest coverage percent the badge shows; unmeasured is -Infinity so it sorts after a real 0%. */
function atsScore(row: QueueViewRow): number {
  // The same call the badge makes, so the order and the number on screen agree.
  const measure = coveragePercent(row.coverage, 'honest');
  // A closed union: only the measured arm has a percent.
  return measure.kind === 'measured' ? measure.percent : Number.NEGATIVE_INFINITY;
}

/* A salary figure that can be ranked: a real, finite, positive number. 0, NaN and null are "none". */
function isAmount(value: unknown): value is number {
  // typeof rejects a numeric-looking string that coercion would otherwise rank.
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

/* The figure a salary sort ranks by: the top of the range, else the bottom, else -Infinity (last). */
function salaryAmount(row: QueueViewRow): number {
  // ponytail: amounts compare as raw numbers across currencies. Live 2026-11-04 only 4 of 112 queued
  // rows carry an amount, all USD. Add FX normalisation once INR and USD amounts coexist, because
  // INR 2,000,000 would outrank USD 200,000.
  // The top of the range is what the operator weighs first.
  if (isAmount(row.salaryMax)) return row.salaryMax;
  // A posting with only a floor still ranks by that floor.
  if (isAmount(row.salaryMin)) return row.salaryMin;
  // No real amount: last, never ranked as $0.
  return Number.NEGATIVE_INFINITY;
}

/* A highest-first comparator over a score; Array.prototype.sort is stable, so ties keep input order. */
function highestFirst(score: (row: QueueViewRow) => number): (a: QueueViewRow, b: QueueViewRow) => number {
  return (a, b) => {
    // Higher score first.
    const diff = score(b) - score(a);
    // -Infinity minus -Infinity is NaN: two rows without a value are equal, so input order holds.
    return Number.isNaN(diff) ? 0 : diff;
  };
}

/* The rows the queue shows, in the order it shows them: arrangement, then search, then sort.
 * Always a NEW array; the caller's fetched rows are never reordered. */
export function applyQueueView<T extends QueueViewRow>(rows: readonly T[], view: QueueView): T[] {
  // Whitespace-separated, lowercased tokens; a blank search yields none and so filters nothing.
  const tokens = view.search.trim().toLowerCase().split(/\s+/).filter(Boolean);
  // filter returns a copy, so the sorts below never touch the caller's array.
  const shown = rows.filter((row) => {
    // Arrangement first: 'all' passes everything, including unknown and missing.
    if (view.arrangement !== 'all' && arrangementOf(row) !== view.arrangement) return false;
    // Built once per row, not once per token.
    const text = haystack(row);
    // Every token must appear, so "stripe bangalore" means Stripe AND Bangalore.
    return tokens.every((token) => text.includes(token));
  });
  // The fetched order is newest first, so reversing it is oldest first.
  if (view.sort === 'oldest') return shown.reverse();
  // Honest coverage, unmeasured last.
  if (view.sort === 'ats') return shown.sort(highestFirst(atsScore));
  // Salary, no-amount last.
  if (view.sort === 'salary') return shown.sort(highestFirst(salaryAmount));
  // 'newest': the order the page fetched in.
  return shown;
}

/* How many rows each arrangement option would show; 'all' is every row, unknown ones included. */
export function countByArrangement(rows: readonly QueueViewRow[]): Readonly<Record<QueueArrangement, number>> {
  // Every option starts at zero, so an empty queue reads 0, never undefined.
  const counts = { all: rows.length, onsite: 0, hybrid: 0, remote: 0 };
  // One pass over the rows.
  for (const row of rows) {
    // The same normalisation as the filter, so a count equals what its option shows.
    const value = arrangementOf(row);
    // Only the three real arrangements are counted; unknown and malformed live under 'all' alone.
    if (value === 'onsite' || value === 'hybrid' || value === 'remote') counts[value] += 1;
  }
  return counts;
}
