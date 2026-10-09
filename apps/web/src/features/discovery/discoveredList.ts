/* Pure list logic for DiscoveredJobsPage: the lane switch, the sort, Load more paging and the
 * honest "N loaded of M" counters.
 *
 * WHY A SEPARATE FILE: the page imports supabase.ts and renders JSX, and apps/web has no DOM
 * renderer, so logic inside the page can only be tested by grepping its source. Everything here is
 * a plain function of its arguments, which test/discoveredLanes.test.ts asserts by value. No React,
 * no supabase import, on purpose: keep it that way or the tests lose their footing. */

// Type only: the joined job row the cards render; erased at runtime, so node --test needs no loader.
import type { JobRow } from '../../data/contract.ts';
// The engine's two step lists; the lane mapping must point at THESE, never at a local copy. The id
// shape check validates the keyset cursor before it is interpolated into a filter.
import { DISCOVERED_STEPS, PASSED_FILTERS_STEPS, isApplicationId } from '../pipeline/rowPipeline.ts';
// Type only: the element type of a step list, so LaneSpec.steps matches what SendThroughPipeline takes.
import type { PipelineStep } from '../pipeline/rowPipeline.ts';

// The two inventories the page can show; a closed union so a typo'd lane cannot compile.
export type Lane = 'discovered' | 'ready';

// What one lane means: the status its queries filter on, the agents its Send runs, its tab name.
export interface LaneSpec {
  // The applications.status value the list and the HEAD count both filter on.
  readonly status: 'discovered' | 'passed_filters';
  // The agents a card's Send runs; must match the row's status or step 1 finds nothing to do.
  readonly steps: readonly PipelineStep[];
  // The switch's visible name.
  readonly label: string;
}

// The single lane -> {status, steps} mapping. The page reads it; nothing else decides it.
export const LANES: Readonly<Record<Lane, LaneSpec>> = {
  // The raw inventory: rows still need dedupe and screening, so all five agents run.
  discovered: { status: 'discovered', steps: DISCOVERED_STEPS, label: 'Discovered' },
  // The screener already passed these, so the run starts at the matcher (ends at awaiting_approval).
  ready: { status: 'passed_filters', steps: PASSED_FILTERS_STEPS, label: 'Ready to tailor' },
};

// Rows per fetch. The same cap the page always had; Load more fetches the next page of this size.
export const PAGE_SIZE = 300;

// How a load relates to what is on screen: replace (full), re-read the window (silent), or append (more).
export type LoadMode = 'full' | 'silent' | 'more';

// True when a load built for `callLane` may still write: the operator has not switched away. A Send's
// onSettled is the closure of the render it was clicked in, so its reload carries the OLD lane; the
// page refuses it before it claims a load sequence, or passed_filters rows would render as Discovered.
export function isCurrentLane(callLane: Lane, currentLane: Lane): boolean {
  // Only the lane on screen may load into the list.
  return callLane === currentLane;
}

// The row limit for a load, given how many rows are loaded now.
export function pageLimit(mode: LoadMode, loaded: number): number {
  // A silent reload after a send re-reads every loaded page, or Load more's pages would vanish.
  if (mode === 'silent') return Math.max(loaded, PAGE_SIZE);
  // A full load starts over with one page; Load more fetches one page past the cursor.
  return PAGE_SIZE;
}

// A PostgREST timestamptz as serialised: date, 'T', time with optional fraction, then Z or an offset.
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}(:\d{2})?)$/;

// The keyset cursor for Load more: rows strictly after the last loaded one in the list's order,
// (created_at desc, id asc). Keyset, not offset: rows that LEAVE the lane between pages (a sweep, a
// send) shift every offset and make the next page skip rows; a cursor is unaffected.
// Returns the argument for .or(), or null when the key is not the expected shape: both values are
// interpolated into the filter, so a malformed one is refused rather than sent.
export function keysetFilter(last: { readonly createdAt: string; readonly id: string }): string | null {
  // Shape first; a lenient value would be filter syntax injected into the query string.
  if (!TIMESTAMP.test(last.createdAt) || !isApplicationId(last.id)) return null;
  // Quoted: '.', ':' and '+' are reserved in PostgREST's logic-tree grammar.
  const at = `"${last.createdAt}"`;
  // Older rows, or the same instant with a larger id: the exact mirror of the two .order calls.
  return `created_at.lt.${at},and(created_at.eq.${at},id.gt.${last.id})`;
}

// The counter text every count on the page carries, so a capped number is never read as complete.
export function loadedOfText(loaded: number, total: number | null): string {
  // A failed count is said out loud; the loaded length is never passed off as the total.
  if (total === null) return `${loaded} loaded (total unknown)`;
  // The exact HEAD count beside what the browser actually holds.
  return `${loaded} loaded of ${total}`;
}

// Whether Load more should show: only when the exact total says rows remain.
export function hasMoreRows(loaded: number, total: number | null): boolean {
  // ponytail: an unknown total hides the button; add a "last page was full" fallback if counts fail often.
  return total !== null && loaded < total;
}

// The minimum item shape the helpers read: an optional application id beside the joined job.
interface ListItem {
  // The application row's id; the page's key for a card.
  readonly applicationId?: string;
  // The joined job; only title, company_name, posted_at and posted_at_source are read here.
  readonly job: JobRow;
}

// Appends a fetched page, dropping rows already loaded. Offset paging shifts when new rows land on
// top between two fetches, so the next page can repeat the previous page's tail.
export function appendUnique<T extends ListItem>(prev: readonly T[], next: readonly T[]): T[] {
  // Keys already on screen; the application id, or the job id for a row without one.
  const seen = new Set(prev.map((i) => i.applicationId ?? i.job.id));
  // Old rows first, then only the genuinely new ones, in server order.
  return [...prev, ...next.filter((i) => !seen.has(i.applicationId ?? i.job.id))];
}

// The sort choices; 'newest' is the query's own order and the default.
export type SortKey = 'newest' | 'posted' | 'company' | 'title';

// The select's options, in display order; the page maps over this so labels live in one place.
export const SORT_OPTIONS: readonly { readonly key: SortKey; readonly label: string }[] = [
  // created_at desc on the application: when applyyy found it.
  { key: 'newest', label: 'Newest found' },
  // posted_at desc on the job: when the board says it went up.
  { key: 'posted', label: 'Posted date (newest first)' },
  // company_name A-Z, title as the tie-break.
  { key: 'company', label: 'Company A–Z' },
  // title A-Z.
  { key: 'title', label: 'Title A–Z' },
];

// Strict ISO date prefix. posted_at is timestamptz serialised by PostgREST; anything else is garbage.
const ISO_DATE = /^(\d{4}-\d{2}-\d{2})T/;

// posted_at as epoch ms, or null when it is not the ISO shape. Shape first, because Date.parse("-5")
// is year -5 and would sort as a real (very old) date.
function postedMs(job: JobRow): number | null {
  // A non-string or non-ISO value is not a date.
  if (typeof job.posted_at !== 'string' || !ISO_DATE.test(job.posted_at)) return null;
  // Shape is right; parse it.
  const ms = Date.parse(job.posted_at);
  // An impossible date (month 13) still parses to NaN; that is not a date either.
  return Number.isNaN(ms) ? null : ms;
}

// Case-insensitive A-Z, so "alpha" and "Alpha" sit together. A missing name sorts as empty (first).
const byText = (a: string | null | undefined, b: string | null | undefined): number =>
  // sensitivity 'base' ignores case and accents; ?? '' keeps a null from printing as "null".
  (a ?? '').localeCompare(b ?? '', undefined, { sensitivity: 'base' });

// Sorts a copy of the loaded rows. Never in place: the page's items state is read-only.
// Array.prototype.sort is stable, so ties keep the server's newest-found order.
export function sortItems<T extends ListItem>(items: readonly T[], key: SortKey): T[] {
  // A copy, whatever the key.
  const copy = [...items];
  // The query already ordered by created_at desc; reordering would only lose that.
  if (key === 'newest') return copy;
  // Newest posting first; an unreadable date goes last rather than guessing a position.
  if (key === 'posted') {
    return copy.sort((a, b) => {
      // Each side's date, or null.
      const am = postedMs(a.job);
      // Same for the right-hand side.
      const bm = postedMs(b.job);
      // Two unknowns tie (stable sort keeps their order).
      if (am === null && bm === null) return 0;
      // An unknown sorts after any real date.
      if (am === null) return 1;
      // Same rule, mirrored.
      if (bm === null) return -1;
      // Descending: newer first.
      return bm - am;
    });
  }
  // Company A-Z; within one company, title A-Z so the group reads in order.
  if (key === 'company') return copy.sort((a, b) => byText(a.job.company_name, b.job.company_name) || byText(a.job.title, b.job.title));
  // Title A-Z.
  return copy.sort((a, b) => byText(a.job.title, b.job.title));
}

// The card's posted-date pill: its text, its tooltip, and whether it is an estimate.
export function postedDate(job: JobRow): { readonly text: string; readonly title: string; readonly approximate: boolean } {
  // The date part of the ISO string; no timezone shift, the server's UTC day is the honest one.
  const day = typeof job.posted_at === 'string' ? ISO_DATE.exec(job.posted_at)?.[1] : undefined;
  // Malformed: say so instead of rendering a parsed guess.
  if (day === undefined) return { text: 'Posted date unknown', title: 'The stored posted date is not a readable date.', approximate: true };
  // The board gave a real publish timestamp.
  if (job.posted_at_source === 'exact') return { text: `Posted ${day}`, title: 'Publish date reported by the job board.', approximate: false };
  // Derived: the board gave no date, so this is when applyyy first saw the posting.
  if (job.posted_at_source === 'derived') {
    return { text: `Posted ≈ ${day}`, title: 'Approximate: the board gave no publish date, so this is when applyyy first saw the posting.', approximate: true };
  }
  // unknown (or any future value): the board is not trusted yet, so the date may be the scrape time.
  return { text: `Posted ≈ ${day}`, title: 'Unreliable: this board is not trusted yet, so the date may be when the posting was first stored.', approximate: true };
}
