/* Pure list logic for DiscoveredJobsPage: the lane switch, the sort, Load more paging and the
 * honest "N loaded of M" counters.
 *
 * WHY A SEPARATE FILE: the page imports supabase.ts and renders JSX, and apps/web has no DOM
 * renderer, so logic inside the page can only be tested by grepping its source. Everything here is
 * a plain function of its arguments, which test/discoveredLanes.test.ts asserts by value. No React,
 * no supabase import, on purpose: keep it that way or the tests lose their footing. */

// Type only: the full jobs row, which DiscoveredJob narrows; erased at runtime, so node --test needs no loader.
import type { JobRow } from '../../data/contract.ts';
// Type only: the client the description search is given (the page passes its own; a test passes a fake).
import type { SupabaseClient } from '@supabase/supabase-js';
// The engine's two step lists; the lane mapping must point at THESE, never at a local copy. The id
// shape check validates the keyset cursor before it is interpolated into a filter.
import { DISCOVERED_STEPS, PASSED_FILTERS_STEPS, isApplicationId } from '../pipeline/rowPipeline.ts';
// Type only: the element type of a step list, so LaneSpec.steps matches what SendThroughPipeline takes.
import type { PipelineStep } from '../pipeline/rowPipeline.ts';
// The ONE "is this JD thin?" rule (round 4, 2026-11-21), shared with the screener by relative import, so the card's
// "No description" and the screener's blank-JD verdict can never disagree.
import { isThinDescription } from '../../../../../supabase/functions/_shared/screen/jd-substance.ts';

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

/* Whether a card's job has NO description (2026-11-18, Teja 21:46 IST: "no jd jobs also need to be in ready to
 * tailor"). The screener now passes such rows into Ready to tailor instead of holding them, so the card must say so
 * before Teja sends one through: the matcher and tailor have only the title to work from. Derived from the selected
 * description_preview (the first 600 characters of description_raw), so no new column and no migration. Shape check,
 * never truthiness (CLAUDE.md section 6).
 * Since round 4 (2026-11-21) a THIN JD counts as none: under 100 chars of role text once a closed list of boilerplate
 * lines is gone (Fractal 002b1d10 was a 513-char tenant wrapper and showed no flag). The preview is the whole JD below
 * 600 chars, which is where every thin JD measured sits. Ceiling: a long JD whose first 600 chars are all boilerplate
 * would flag here while the screener (full text) passes it; none such was measured live. */
export function hasNoDescription(job: { readonly description_preview: string | null | undefined }): boolean {
  // Null, absent, blank and thin all count as missing; the rule itself lives in jd-substance.ts.
  return isThinDescription(job.description_preview);
}

/* Moved here from DiscoveredJobsPage (S40b) so the gone-after-ready section names a job exactly as a card does.
   The job's name for the send button's accessible name and the results strip. The page already
   treats company_name as optional (getCompanyCooldownInfo, the search filter), and a template string
   would print a missing one as "undefined — Engineer". Only the parts that are real, non-blank text;
   neither part -> a stated placeholder, never an empty name. */
export function jobLabel(job: { readonly company_name?: string | null; readonly title?: string | null }): string {
  // Each part kept only when it is a string with visible characters.
  const parts = [job.company_name, job.title].filter((p): p is string => typeof p === 'string' && p.trim() !== '');
  // The joined name, or a placeholder that says the data was missing.
  return parts.length > 0 ? parts.join(' — ') : 'Untitled job';
}

// Rows per fetch. The same cap the page always had; Load more fetches the next page of this size.
export const PAGE_SIZE = 300;

/* The jobs columns the /discovered page actually reads, and NOTHING else (2026-10-24).
 * The list used to embed job:job_id(*), which shipped every column, including raw_payload (the
 * board's raw JSON, ~37% of the bytes, rendered nowhere), ×300 rows: ~4.45 MB per page load.
 * DiscoveredJob is DERIVED from this tuple, so a reader that needs a column the select dropped
 * fails tsc instead of reading undefined at runtime. Add a column here, never with a cast.
 * description_raw STAYS: the filter cascade's degree rule, the search box and the card preview
 * all read it, and dropping it would silently change the Matched / Filtered Out split. */
export const DISCOVERED_JOB_COLUMNS = [
  // The card's React key and appendUnique's fallback key.
  'id',
  // Card heading, search, sort, tech constraint, title blocklist.
  'title',
  // Card, search, sort, company filter, cooldown lookup.
  'company_name',
  // Location pill and the cascade's location rule.
  'location_raw',
  // Search and the cascade's location rule.
  'locations',
  // Pill, arrangement filter, cascade.
  'work_arrangement',
  // Pill, type filter, cascade.
  'employment_type',
  // The card preview and the instant local search (first 600 characters, generated; 2026-11-08). The full
  // description_raw is NOT selected: ~6 KB per row and cold TOAST reads (peer 2: up to 6.2 s) for a 220-char
  // preview. The JD modal fetches the full text on open; search covers the rest with a server match.
  'description_preview',
  // The cascade's degree rule, computed by Postgres from the full description (the same regex, one copy).
  'description_requires_degree',
  // The card's and the modal's "open posting" link.
  'apply_url',
  // The provider filter.
  'ats_provider',
  // SourceBadge.
  'discovered_via',
  // SourceBadge.
  'source_refs',
  // The posted-date pill and the "posted" sort.
  'posted_at',
  // How much the posted-date pill may believe posted_at.
  'posted_at_source',
  // The cascade's experience rule.
  'min_experience_years',
  // The cascade's degree rule.
  'requires_advanced_degree',
  // The salary pill.
  'salary_min',
  // The salary pill.
  'salary_max',
  // The salary pill.
  'salary_currency',
  // When the board took the posting down (null while live): the card says "Posting gone" instead of Send,
  // because the tailor refuses a gone posting and the click would only fail (2026-11-07).
  'disappeared_at',
] as const;

// A jobs row as this page receives it: exactly the selected columns, so tsc guards the select.
export type DiscoveredJob = Pick<JobRow, (typeof DISCOVERED_JOB_COLUMNS)[number]>;

// One row of the list query. Named for supabase-js's select generic, because a select built at
// runtime is a plain string, which the library's type-level parser cannot read.
export interface DiscoveredListRow {
  // The application's id.
  readonly id: string;
  // The application's status (the lane's).
  readonly status: string;
  // The application's created_at: the sort key and keyset cursor.
  readonly created_at: string;
  // The embedded job, or null when the job row is missing; the page skips those.
  readonly job: DiscoveredJob | null;
}

/* A search term made literal for PostgREST's ilike: `\`, `%` and `_` are LIKE wildcards/escapes, so each is
 * escaped; `*` is PostgREST's own wildcard alias, so it is escaped too. Without this, "100%" would match everything. */
export function ilikeLiteral(term: string): string {
  // Each special character prefixed with a backslash, the escape LIKE uses by default.
  return term.replace(/[\\%_*]/g, (ch) => `\\${ch}`);
}

/* The server half of the Discovered search (2026-11-08, Teja's option B): which LOADED rows' full description
 * contains the term. The list carries only a 600-char preview, so a word further down the posting is matched
 * here, by Postgres, over exactly the loaded window: the lane, and created_at no older than the oldest loaded
 * row. That bound keeps it to the ~300 rows on screen, not the lane's 35k. Returns the matching application
 * ids, or an error to SAY (never an empty set that would read as "no match"; CLAUDE.md section 6). */
export async function searchLoadedDescriptions(
  // The supabase client (injected so a test can record the request).
  client: SupabaseClient,
  // The lane's status: the same filter the list used.
  status: string,
  // The oldest loaded row's created_at: the window's lower bound.
  oldestCreatedAt: string,
  // The typed term, trimmed by the caller.
  term: string,
  // How many rows are loaded: no more matches can exist on screen, so no more are asked for.
  loadedCount: number,
): Promise<{ readonly ids: ReadonlySet<string> } | { readonly error: string }> {
  // Inner join so the ilike on the job's description filters the applications themselves.
  const { data, error } = await client
    .from('applications')
    // Ids only: the rows are already on screen; the server only answers "does it match".
    .select('id, job:job_id!inner(id)')
    // The lane.
    .eq('status', status)
    // The loaded window, so the scan is bounded by what is shown.
    .gte('created_at', oldestCreatedAt)
    // Case-insensitive substring on the FULL text, literal (wildcards escaped).
    .ilike('job.description_raw', `%${ilikeLiteral(term)}%`)
    // Never more than the loaded window can hold.
    .limit(Math.max(1, loadedCount));
  // supabase-js returns errors as data: said to the caller, which shows it.
  if (error) return { error: String(error.message ?? error) };
  // An answer that is not a list is not "no matches".
  if (!Array.isArray(data)) return { error: 'the description search returned no list' };
  // The matching application ids.
  return { ids: new Set(data.map((row: { id: string }) => row.id)) };
}

// The list query's PostgREST select, built from the tuple so the two cannot drift apart.
export const DISCOVERED_LIST_SELECT = `id, status, created_at, job:job_id(${DISCOVERED_JOB_COLUMNS.join(', ')})`;

/* The column that says a posting is gone (S40, 2026-11-24). One name for both reads, so the lane (is null) and the
 * gone-after-ready section (not null) always partition passed_filters by the same test. */
export const GONE_FILTER_COLUMN = 'job.disappeared_at';

/* How a lane's list is read: the select, and the embedded columns that must be null (S40, Teja 11:08 IST: "hide gone
 * jobs instead of moving them to dropped"). A READ filter, never a status write: a posting can come back
 * (scout-ats clears disappeared_at on a repost), and a hidden row then reappears by itself.
 * The ready lane's embed is an INNER join: on a plain embed, PostgREST's job.disappeared_at filter only nulls the
 * embedded job and keeps the application row (it would arrive as "job record missing"). */
export function laneRead(lane: Lane): { readonly select: string; readonly isNull: readonly string[] } {
  // The raw inventory is out of the ruling's scope: plain embed, no filter.
  if (lane === 'discovered') return { select: DISCOVERED_LIST_SELECT, isNull: [] };
  // Ready to tailor: inner join, so the null filter drops the application itself.
  return { select: DISCOVERED_LIST_SELECT.replace('job:job_id(', 'job:job_id!inner('), isNull: [GONE_FILTER_COLUMN] };
}

/* The gone-after-ready section's select (S40b): only what a row shows, inner-joined so the page's
 * `.not(GONE_FILTER_COLUMN, 'is', null)` drops the live applications rather than nulling their embed. */
export const GONE_AFTER_READY_SELECT = 'id, created_at, job:job_id!inner(id, title, company_name, apply_url, disappeared_at)';

/* One section row, exactly as GONE_AFTER_READY_SELECT returns it. */
export interface GoneRow {
  // The application id: the Reject target and the React key.
  readonly id: string;
  // The application's created_at: the server's order.
  readonly created_at: string;
  // The inner-joined job, never null (the inner join drops rows without one).
  readonly job: {
    // The job id.
    readonly id: string;
    // Shown.
    readonly title: string | null;
    // Shown.
    readonly company_name: string | null;
    // The Apply link.
    readonly apply_url: string | null;
    // Not null by the query; read through postingGoneNote anyway, which checks its shape.
    readonly disappeared_at: string | null;
  };
}

/* What the section's read gave: three states, so "loading", "failed" and "none" never look alike. */
export type GoneState =
  // The read is in flight.
  | { readonly kind: 'loading' }
  // The read failed; its words are shown.
  | { readonly kind: 'error'; readonly message: string }
  // The rows (up to PAGE_SIZE) and the exact total.
  | { readonly kind: 'rows'; readonly rows: readonly GoneRow[]; readonly total: number };

/* The gone-after-ready read (S40b): the passed_filters rows whose posting is gone, and their exact count, which the
 * ready lane's total subtracts. ONE GET: the count rides on the row read (count:'exact' adds a count to the same
 * request), so it is not the separate HEAD round trip the page dropped on 2026-11-08. Client injected so a test
 * records the filters. Never throws; a missing list or count is an error, never 0 (CLAUDE.md section 6). */
export async function readGoneAfterReady(client: SupabaseClient): Promise<Exclude<GoneState, { kind: 'loading' }>> {
  try {
    // The opposite set to the lane's filter: same inner join, same column, NOT null.
    const { data, error, count } = await client
      .from('applications')
      // Only what a section row shows, plus the exact total.
      .select(GONE_AFTER_READY_SELECT, { count: 'exact' })
      // Ready to tailor rows only.
      .eq('status', LANES.ready.status)
      // Gone: the board took the posting down.
      .not(GONE_FILTER_COLUMN, 'is', null)
      // Newest found first, like the lane.
      .order('created_at', { ascending: false })
      // Bounded like a lane page; the summary shows the exact total either way.
      .limit(PAGE_SIZE);
    // supabase-js returns errors as data.
    if (error) return { kind: 'error', message: String(error.message ?? error) };
    // Positive shape: a list AND a numeric count, or it is not an answer.
    if (!Array.isArray(data) || typeof count !== 'number') return { kind: 'error', message: 'the gone-postings read returned no list or count' };
    // The rows (typed by the select string, which supabase-js cannot parse at type level) and the total.
    return { kind: 'rows', rows: data as unknown as GoneRow[], total: count };
  } catch (e) {
    // A thrown fetch reads like a returned error.
    return { kind: 'error', message: e instanceof Error ? e.message : 'Failed to load gone postings.' };
  }
}

/* The ready lane's exact total once gone rows are hidden: the status-count RPC knows nothing of jobs, so the page
 * subtracts the section's exact count. Null when either read gave no answer (CLAUDE.md section 6: missing data never
 * becomes a number), and null when the two reads disagree (gone > total: they straddled a write), never a negative. */
export function liveLaneTotal(rpcTotal: number | null, goneCount: number | null): number | null {
  // One read missing: no number.
  if (rpcTotal === null || goneCount === null) return null;
  // The difference, unless the two reads contradict each other.
  return goneCount > rpcTotal ? null : rpcTotal - goneCount;
}

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

/* Exact per-lane counts from the status-count read (useApplicationCounts, one RPC for every
 * status). `filteredOut` is the screener's dropped_filter, not this page's local preview. */
export interface LaneCounts {
  // Rows still waiting for the normalizer and screener.
  readonly discovered: number;
  // Rows the screener passed: the "Ready to tailor" lane.
  readonly ready: number;
  // Rows the screener dropped.
  readonly filteredOut: number;
}

/* The read's per-status counts as lane counts, or null when the read gave no answer.
 * A status absent from the RPC's rows has zero rows, but ONLY a read that succeeded proves that
 * (useApplicationCounts.ts: "absent rather than zero"). Loading, failed, signed out and unconfigured
 * prove nothing, so they return null and nothing downstream may act on a number. */
export function laneCountsFrom(kind: string, counts: Readonly<Partial<Record<string, number>>>): LaneCounts | null {
  // 'rows' and 'empty' are the two states where the database actually answered.
  if (kind !== 'rows' && kind !== 'empty') return null;
  // Absent from a successful read = none at that status.
  return { discovered: counts['discovered'] ?? 0, ready: counts['passed_filters'] ?? 0, filteredOut: counts['dropped_filter'] ?? 0 };
}

/* The lane's exact total, read from the same status-count RPC instead of its own HEAD count
 * (2026-11-08: the HEAD count was a second Sydney round trip, ~300-730 ms from India, for a number
 * the RPC already returned). Same set: the RPC is count(*) grouped by status for user_id = auth.uid(),
 * and RLS "own applications" scopes the HEAD count to the same user, so counts[status] equals
 * `.eq('status', status)` with count:'exact'. Null until the read answers, exactly like laneCountsFrom. */
export function laneTotalFrom(kind: string, counts: Readonly<Partial<Record<string, number>>>, status: string): number | null {
  // Loading, failed, signed out or unconfigured: no answer, so no number (never a 0 that reads as "empty lane").
  if (kind !== 'rows' && kind !== 'empty') return null;
  // A successful read omits a status with no rows, so absent here really is zero.
  return counts[status] ?? 0;
}

/* The lane the page opens on, every time (2026-11-01, Teja: "whenever I open discovered jobs from the
 * nav bar it needs to show and stay in Ready to tailor"). Since the prescreen drain and the scout's
 * own screening path (both 2026-10-24) `discovered` sits near empty, so Ready is where the work is.
 * The 2026-10-24 version picked the lane from the status counts once, and could settle on Discovered
 * if the counts landed while a scout run had rows still waiting there. A constant cannot race. */
export const OPENING_LANE: Lane = 'ready';

/* The sentence for an empty list, chosen from the EXACT lane count (2026-10-24).
 * An empty grid has two different causes: the lane itself holds no rows, or it has rows and the
 * operator's search, selects or local cascade hid every loaded one. The page used to blame the
 * filters for both, so after the prescreen drain emptied `discovered` it told Teja to adjust filters
 * on a lane with nothing in it. Only a count of exactly 0 proves the first cause; null (the count
 * failed) proves nothing, so it falls back to the filter wording rather than claim an empty lane. */
export function emptyListMessage(
  // Which lane is on screen.
  lane: Lane,
  // Which view tab is on; only the Matched tab's sentence blames the local cascade.
  viewTab: 'matched' | 'all' | 'dropped',
  // The lane's exact count from the head query; null when that query failed.
  laneTotal: number | null,
  // Where the screened rows went, from the status-count read; null when that read gave no answer.
  counts: LaneCounts | null = null,
): string {
  // The lane is really empty, and the count query said so.
  if (laneTotal === 0) {
    // Discovered empties when the screener has judged everything; with counts, say exactly where they went.
    if (lane === 'discovered' && counts !== null) return `Every discovered job has been screened: ${counts.ready.toLocaleString('en-US')} are in "${LANES.ready.label}", ${counts.filteredOut.toLocaleString('en-US')} filtered out.`;
    // Without counts the cause is still known, only the numbers are not. Drops are stored as
    // dropped_filter, which no page lists (the "Filtered Out" tab is only this page's local preview).
    return lane === 'discovered'
      ? `Nothing is waiting to be screened: every discovered job has already been through the screener. Jobs it passed are in "${LANES.ready.label}"; jobs it dropped are stored as filtered and not listed here.`
      // The ready lane empties when nothing has passed the screener, or Teja sent or rejected every row.
      // Since 2026-11-18 nothing sends a scouted row on automatically, so an empty lane means the scout found nothing new.
      : 'Nothing is ready to tailor: no job is waiting after the screener right now. New ones arrive when the scout finds postings that pass it, and wait here until you send one through.';
  }
  // Rows exist (or the count is unknown) and the Matched tab is empty: the local cascade is the cause.
  if (viewTab === 'matched') return 'No jobs match your active Tech constraint and Filter Cascade rules. Try adjusting your search or checking "Filtered Out" to inspect dropped postings.';
  // Any other tab emptied by search or a filter select.
  return `No loaded ${LANES[lane].label} jobs match your current criteria.`;
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
  readonly job: DiscoveredJob;
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
function postedMs(job: DiscoveredJob): number | null {
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

// How long ago an ISO timestamp was, in the operator's words: "17 days ago", "5 hours ago".
// EXPORTED PURE with the clock passed in, so every unit boundary is testable at an exact instant.
// Returns null when the string does not parse to a usable instant — the caller then falls back
// to the absolute day it shows today (CLAUDE.md §6: Date.parse garbage must never render as
// "posted 55 years ago"; the ISO_DATE shape check upstream makes null rare, not impossible,
// because the regex admits digit-shaped non-dates like 2026-13-99).
export function postedAgo(iso: string, nowMs: number): string | null {
  // One lenient parse, immediately shape-checked: NaN means fall back, never a guess.
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  // Positive = in the past. A slightly-future date is clock skew, not information.
  const diff = nowMs - ms;
  // More than a day in the future is not skew, it is bad data: refuse and show the absolute day.
  if (diff < -86_400_000) return null;
  // Built-in formatter — Teja ruled no date library; RTF gives "17 days ago" for free.
  const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'always' });
  // Small skew and sub-minute ages both read "just now" — "0 minutes ago" helps nobody.
  const minutes = Math.floor(Math.max(0, diff) / 60_000);
  if (minutes < 1) return 'just now';
  // Minutes under an hour, hours under a day, days under a month, then months — each floor'd
  // so the phrase never claims more age than the data holds.
  if (minutes < 60) return rtf.format(-minutes, 'minute');
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return rtf.format(-hours, 'hour');
  const days = Math.floor(hours / 24);
  if (days < 30) return rtf.format(-days, 'day');
  // Calendar months vary; 30 days is the honest flat approximation for a job-age pill.
  const months = Math.floor(days / 30);
  return rtf.format(-months, 'month');
}

// The card's posted-date pill: its text, its tooltip, and whether it is an estimate.
// `nowMs` is injectable for tests; callers in the page pass nothing and get the real clock.
export function postedDate(job: DiscoveredJob, nowMs: number = Date.now()): { readonly text: string; readonly title: string; readonly approximate: boolean } {
  // The date part of the ISO string; no timezone shift, the server's UTC day is the honest one.
  const day = typeof job.posted_at === 'string' ? ISO_DATE.exec(job.posted_at)?.[1] : undefined;
  // Malformed: say so instead of rendering a parsed guess.
  if (day === undefined) return { text: 'Posted date unknown', title: 'The stored posted date is not a readable date.', approximate: true };
  // Relative phrase when the timestamp parses; null falls back to the absolute day below.
  const ago = postedAgo(job.posted_at as string, nowMs);
  // What the pill shows: "17 days ago" normally, the absolute day when parsing refused.
  const shown = ago ?? day;
  // The absolute day moves into the tooltip when the pill went relative, so precision is
  // hovered, never lost; on the fallback the title would repeat the pill, so it is omitted.
  const dayPrefix = ago !== null ? `${day} — ` : '';
  // The board gave a real publish timestamp.
  if (job.posted_at_source === 'exact') return { text: `Posted ${shown}`, title: `${dayPrefix}Publish date reported by the job board.`, approximate: false };
  // Derived: the board gave no date, so this is when applyyy first saw the posting. The "≈"
  // survives the relative form — the AGE is as approximate as the date it came from.
  if (job.posted_at_source === 'derived') {
    return { text: `Posted ≈ ${shown}`, title: `${dayPrefix}Approximate: the board gave no publish date, so this is when applyyy first saw the posting.`, approximate: true };
  }
  // unknown (or any future value): the board is not trusted yet, so the date may be the scrape time.
  return { text: `Posted ≈ ${shown}`, title: `${dayPrefix}Unreliable: this board is not trusted yet, so the date may be when the posting was first stored.`, approximate: true };
}
